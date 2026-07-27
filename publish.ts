import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";

interface PackageJson {
  readonly name: string;
  readonly version: string;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}

interface PublishPackage {
  readonly key: "core" | "react";
  readonly packageDir: string;
  readonly packageJson: PackageJson;
  readonly expectedFiles: readonly string[];
}

interface PublishContext {
  readonly rootPackageJson: PackageJson;
  readonly core: PublishPackage;
  readonly react: PublishPackage;
  readonly publishPackages: readonly PublishPackage[];
}

class PublishFailure {
  readonly _tag = "PublishFailure";

  constructor(
    readonly step: string,
    readonly message: string,
    readonly cause?: unknown
  ) {}
}

const repoDir = dirname(fileURLToPath(import.meta.url));
const args = new Set(Bun.argv.slice(2));
const dryRun = args.has("--dry-run");
const smokeOnly = args.has("--smoke-only");
const help = args.has("--help") || args.has("-h");

if (help) {
  console.log(`Usage: bun publish.ts [--dry-run] [--smoke-only]

Runs the release publish pipeline:
  1. workspace checks
  2. build and declaration rollup
  3. npm publish dry-run
  4. npm pack
  5. clean Bun consumer smoke against packed tarballs
  6. npm publish with interactive 2FA prompt unless --dry-run is set

Flags:
  --dry-run    Run steps 1-5 and stop before npm publish.
  --smoke-only CI-safe subset: package metadata validation, build, npm pack and
               the packed-tarball consumer smoke (steps 2, 4 and 5). Skips the
               workspace checks CI already runs as separate steps, the npm
               publish dry-run and npm publish, so it needs no registry auth.

Every mode except --smoke-only is for local manual release work only. Do not
run them in CI.
`);
  process.exit(0);
}

function fail(step: string, message: string, cause?: unknown): PublishFailure {
  return new PublishFailure(step, message, cause);
}

function section(label: string): Effect.Effect<void> {
  return Effect.sync(() => {
    console.log(`\n==> ${label}`);
  });
}

function log(message: string): Effect.Effect<void> {
  return Effect.sync(() => {
    console.log(message);
  });
}

function packageTarballName(name: string, version: string): string {
  return `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}

function fileDependency(fromDir: string, toFile: string): string {
  const path = relative(fromDir, toFile);
  return `file:${path.startsWith(".") ? path : `./${path}`}`;
}

function readPackageJson(path: string): Effect.Effect<PackageJson, PublishFailure> {
  return Effect.tryPromise({
    try: () => Bun.file(path).json() as Promise<PackageJson>,
    catch: (cause) => fail("read package.json", `Could not read ${path}.`, cause),
  });
}

function writeText(path: string, content: string): Effect.Effect<void, PublishFailure> {
  return Effect.tryPromise({
    try: () => Bun.write(path, content).then(() => undefined),
    catch: (cause) => fail("write file", `Could not write ${path}.`, cause),
  });
}

function writeJson(path: string, value: unknown): Effect.Effect<void, PublishFailure> {
  return writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function makeDirectory(path: string): Effect.Effect<void, PublishFailure> {
  return Effect.tryPromise({
    try: () => mkdir(path, { recursive: true }).then(() => undefined),
    catch: (cause) => fail("create directory", `Could not create ${path}.`, cause),
  });
}

function makeTempDirectory(prefix: string): Effect.Effect<string, PublishFailure> {
  return Effect.tryPromise({
    try: () => mkdtemp(join(tmpdir(), prefix)),
    catch: (cause) =>
      fail("create temp directory", "Could not create publish temp directory.", cause),
  });
}

function removePath(path: string): Effect.Effect<void, PublishFailure> {
  return Effect.tryPromise({
    try: () => rm(path, { force: true, recursive: true }),
    catch: (cause) => fail("remove path", `Could not remove ${path}.`, cause),
  });
}

function requireDependency(
  packageJson: PackageJson,
  field: "devDependencies" | "peerDependencies",
  name: string
): string {
  const version = packageJson[field]?.[name];
  if (version === undefined) {
    throw new Error(`${packageJson.name} is missing ${field}.${name}.`);
  }

  return version;
}

function requireTarball(
  tarballs: ReadonlyMap<PublishPackage, string>,
  input: PublishPackage
): string {
  const tarball = tarballs.get(input);
  if (tarball === undefined) {
    throw new Error(`${input.packageJson.name} tarball was not recorded.`);
  }

  return tarball;
}

function assertPublishMetadata(
  core: PublishPackage,
  react: PublishPackage
): Effect.Effect<void, PublishFailure> {
  return Effect.try({
    try: () => {
      const reactCorePeer = requireDependency(
        react.packageJson,
        "peerDependencies",
        "@frondruntime/core"
      );
      if (reactCorePeer !== core.packageJson.version) {
        throw new Error(
          `${react.packageJson.name} peer dependency on @frondruntime/core is ${reactCorePeer}, expected ${core.packageJson.version}.`
        );
      }

      for (const input of [core, react]) {
        if (input.packageJson.version.length === 0) {
          throw new Error(`${input.packageJson.name} has an empty version.`);
        }
      }
    },
    catch: (cause) =>
      fail("validate package metadata", "Package metadata is not publishable.", cause),
  });
}

function assertLocalPublishScript(): Effect.Effect<void, PublishFailure> {
  return Effect.gen(function* () {
    if (process.env.CI !== undefined || process.env.GITHUB_ACTIONS !== undefined) {
      return yield* Effect.fail(
        fail(
          "validate publish environment",
          "publish.ts is local-only. Use CI for verification and release metadata, then publish manually from a local terminal."
        )
      );
    }

    if (!dryRun && process.stdin.isTTY !== true) {
      return yield* Effect.fail(
        fail(
          "validate publish environment",
          "npm publish requires an interactive terminal so npm can prompt for 2FA. Run bun run publish:npm locally from a TTY."
        )
      );
    }
  });
}

function assertPackedFiles(
  smokeDir: string,
  packages: readonly PublishPackage[]
): Effect.Effect<void, PublishFailure> {
  return Effect.forEach(
    packages.flatMap((input) =>
      input.expectedFiles.map((expectedFile) => ({
        input,
        path: join(smokeDir, "node_modules", input.packageJson.name, expectedFile),
        expectedFile,
      }))
    ),
    ({ input, path, expectedFile }) =>
      Effect.gen(function* () {
        const exists = yield* Effect.tryPromise({
          try: () => Bun.file(path).exists(),
          catch: (cause) => fail("check packed files", `Could not inspect ${path}.`, cause),
        });

        if (!exists) {
          return yield* Effect.fail(
            fail(
              "check packed files",
              `${input.packageJson.name} tarball is missing ${expectedFile}.`
            )
          );
        }
      }),
    { discard: true }
  );
}

function command(
  label: string,
  cmd: readonly string[],
  options: { readonly cwd?: string } = {}
): Effect.Effect<void, PublishFailure> {
  return Effect.gen(function* () {
    yield* log(`\n$ ${cmd.join(" ")}`);

    const exitCode = yield* Effect.tryPromise({
      try: () =>
        Bun.spawn({
          cmd: [...cmd],
          cwd: options.cwd ?? repoDir,
          env: process.env,
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        }).exited,
      catch: (cause) => fail(label, `${label} failed to start.`, cause),
    });

    if (exitCode !== 0) {
      return yield* Effect.fail(fail(label, `${label} failed with exit code ${exitCode}.`));
    }
  });
}

function commandOutput(
  label: string,
  cmd: readonly string[],
  options: { readonly cwd?: string } = {}
): Effect.Effect<
  { readonly exitCode: number; readonly stderr: string; readonly stdout: string },
  PublishFailure
> {
  return Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: async () => {
        const subprocess = Bun.spawn({
          cmd: [...cmd],
          cwd: options.cwd ?? repoDir,
          env: process.env,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });

        const [exitCode, stdout, stderr] = await Promise.all([
          subprocess.exited,
          new Response(subprocess.stdout).text(),
          new Response(subprocess.stderr).text(),
        ]);

        return { exitCode, stderr, stdout };
      },
      catch: (cause) => fail(label, `${label} failed to start.`, cause),
    });

    return result;
  });
}

function packageVersionExists(input: PublishPackage): Effect.Effect<boolean, PublishFailure> {
  return Effect.gen(function* () {
    const specifier = `${input.packageJson.name}@${input.packageJson.version}`;
    const result = yield* commandOutput("check npm package version", [
      "npm",
      "view",
      specifier,
      "version",
    ]);
    const stdout = result.stdout.trim();
    const stderr = result.stderr.trim();

    if (result.exitCode === 0) {
      return stdout === input.packageJson.version;
    }

    if (stderr.includes("E404") || stderr.includes("404 Not Found")) {
      return false;
    }

    return yield* Effect.fail(
      fail(
        "check npm package version",
        `Could not check whether ${specifier} already exists on npm.`
      )
    );
  });
}

function loadPublishContext(): Effect.Effect<PublishContext, PublishFailure> {
  return Effect.gen(function* () {
    const rootPackageJson = yield* readPackageJson(join(repoDir, "package.json"));
    const core: PublishPackage = {
      key: "core",
      packageDir: join(repoDir, "packages/core"),
      packageJson: yield* readPackageJson(join(repoDir, "packages/core/package.json")),
      expectedFiles: [
        "dist/index.js",
        "dist/index.d.ts",
        "dist/testing/index.js",
        "dist/testing/index.d.ts",
      ],
    };
    const react: PublishPackage = {
      key: "react",
      packageDir: join(repoDir, "packages/react"),
      packageJson: yield* readPackageJson(join(repoDir, "packages/react/package.json")),
      expectedFiles: [
        "dist/index.js",
        "dist/index.d.ts",
        "dist/testing/index.js",
        "dist/testing/index.d.ts",
      ],
    };

    yield* assertPublishMetadata(core, react);

    return {
      rootPackageJson,
      core,
      react,
      publishPackages: [core, react],
    };
  });
}

function smokePackageJson(
  smokeDir: string,
  tarballs: ReadonlyMap<PublishPackage, string>,
  context: PublishContext
): Effect.Effect<unknown, PublishFailure> {
  return Effect.try({
    try: () => ({
      name: "frond-publish-smoke",
      private: true,
      type: "module",
      scripts: {
        typecheck: "tsc -p tsconfig.json --noEmit",
        smoke: "node ./src/runtime-smoke.mjs",
      },
      dependencies: {
        "@frondruntime/core": fileDependency(smokeDir, requireTarball(tarballs, context.core)),
        "@frondruntime/react": fileDependency(smokeDir, requireTarball(tarballs, context.react)),
        effect: requireDependency(context.rootPackageJson, "devDependencies", "effect"),
        mobx: requireDependency(context.core.packageJson, "devDependencies", "mobx"),
        "mobx-react-lite": requireDependency(
          context.rootPackageJson,
          "devDependencies",
          "mobx-react-lite"
        ),
        react: requireDependency(context.rootPackageJson, "devDependencies", "react"),
        "react-dom": requireDependency(context.rootPackageJson, "devDependencies", "react-dom"),
      },
      devDependencies: {
        "@types/react": requireDependency(
          context.rootPackageJson,
          "devDependencies",
          "@types/react"
        ),
        "@types/react-dom": requireDependency(
          context.rootPackageJson,
          "devDependencies",
          "@types/react-dom"
        ),
        typescript: requireDependency(context.rootPackageJson, "devDependencies", "typescript"),
      },
    }),
    catch: (cause) => fail("prepare smoke package", "Could not prepare smoke package.json.", cause),
  });
}

function writeSmokeProject(
  smokeDir: string,
  tarballs: ReadonlyMap<PublishPackage, string>,
  context: PublishContext
): Effect.Effect<void, PublishFailure> {
  return Effect.gen(function* () {
    yield* makeDirectory(join(smokeDir, "src"));
    const packageJson = yield* smokePackageJson(smokeDir, tarballs, context);

    yield* Effect.all(
      [
        writeJson(join(smokeDir, "package.json"), packageJson),
        writeJson(join(smokeDir, "tsconfig.json"), {
          compilerOptions: {
            strict: true,
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            jsx: "react-jsx",
            skipLibCheck: true,
          },
          include: ["src/**/*.ts", "src/**/*.tsx"],
        }),
        writeText(
          join(smokeDir, "src/index.tsx"),
          `import * as Frond from "@frondruntime/core";
import {
  createDeferred,
  createFrondTestHarness,
  effectBridgeRunner,
  effectHostFromRuntime,
  type FrondTestHarness,
  mockSpec,
  readySpec,
} from "@frondruntime/core/testing";
import { FrondProvider } from "@frondruntime/react";
import { TestFrondProvider } from "@frondruntime/react/testing";

interface Profile {
  readonly id: string;
  readonly name: string;
}

type TransportSpec = Frond.NodeSpec<{
  readonly mode: "async";
  readonly args: Frond.Args.None;
  readonly key: Frond.Key.Singleton;
  readonly result: { readonly token: string };
}>;

class TransportNode extends Frond.NodeBase<TransportSpec> {
  static readonly spec = Frond.serviceSpec.async<TransportSpec>({
    tag: Frond.tag("publish-smoke/transport"),
    key: () => Frond.Key.singleton(),
    acquire: Frond.Driver.Acquire(() => ({ token: "token" })),
  });

  get token(): string {
    return this.result.token;
  }
}

type ProfileSpec = Frond.NodeSpec<{
  readonly mode: "async";
  readonly args: { readonly id: string };
  readonly key: Frond.Key.Structure<{ readonly id: string }>;
  readonly deps: { readonly transport: Frond.Dep<typeof TransportNode> };
  readonly result: Profile;
}>;

class ProfileNode extends Frond.NodeBase<ProfileSpec> {
  static readonly spec = Frond.resourceSpec.async<ProfileSpec>({
    tag: Frond.tag("publish-smoke/profile"),
    key: (args) => Frond.Key.structure({ id: args.id }),
    dependencies: Frond.dependencies(() => ({
      transport: Frond.dep(TransportNode, Frond.Args.none),
    })),
    acquire: Frond.Driver.Acquire(async (ctx) => ({
      id: ctx.args.id,
      name: ctx.deps.transport.token,
    })),
  });
}

// Mode-generic helpers accept the packed spec shape through AnyModeSpec.
type AssertAnyModeSpec<TSpec extends Frond.AnyModeSpec> = TSpec;
export type ProfileSpecIsAnyModeSpec = AssertAnyModeSpec<ProfileSpec>;

const runtime = Frond.createRuntime();
const handle = runtime.client.node(ProfileNode, { id: "1" });

// 0.2 handle surface: sync ready-or-throw projection plus the awaited variant.
const readReadyFromHandle: () => ProfileNode = handle.readReady;
const ensureReadyNodeFromHandle: (
  metadata?: Frond.Runtime.RuntimeWorkMetadata | undefined
) => Promise<ProfileNode> = handle.ensureReadyNode;
void readReadyFromHandle;
void ensureReadyNodeFromHandle;

// FrondNodeNotReady is the typed error non-ready projections throw.
declare const notReady: InstanceType<typeof Frond.Runtime.FrondNodeNotReady>;
notReady satisfies Error;

// specWithDriver swaps only the driver; the override stays assignable where
// the original class is expected.
const replacementDriver = Frond.Driver.Async<TransportSpec>({
  acquire: Frond.Driver.Acquire(() => ({ token: "injected" })),
});
const OverriddenTransport = Frond.specWithDriver(TransportNode, replacementDriver);
const overriddenSlot: typeof TransportNode = OverriddenTransport;
void overriddenSlot;

// Result envelope: withInternal / internalOf / carryInternal.
const envelopedProfile = Frond.withInternal(
  { id: "1", name: "Ada" },
  { socket: "publish-smoke" }
);
Frond.internalOf(envelopedProfile).socket satisfies string;
const carriedProfile = Frond.carryInternal(envelopedProfile, { id: "1", name: "Beatrice" });
Frond.internalOf(carriedProfile).socket satisfies string;

// Ordered transitions.
const transitionRunner: () => Promise<Frond.TransitionOutcome> = Frond.createTransition(
  [{ label: "noop", run: () => Promise.resolve() }],
  { onStepFailure: "continue" }
);
void transitionRunner;
const transitionOutcome: Promise<Frond.TransitionOutcome> = Frond.runTransition(
  [],
  { onStepFailure: "abort" }
);
void transitionOutcome;

// Serialized runtime replacement.
const coordinator = Frond.createRuntimeCoordinator<Frond.Runtime.Runtime>();
const coordinatorStart: (
  createLease: () => Promise<Frond.RuntimeLease<Frond.Runtime.Runtime>>
) => Promise<Frond.Runtime.Runtime> = coordinator.start;
void coordinatorStart;

// Harness runtime must unify with the package Runtime type (the 0.1 packaging
// regression: core's testing rollup duplicated core's types instead of
// importing them, so this assignment failed against the packed tarballs).
const harness: FrondTestHarness = createFrondTestHarness();
const harnessRuntime: Frond.Runtime.Runtime = harness.runtime;
void harnessRuntime;

// Rebuild a runtime client over the harness facade: testing's host/runner
// types must be the same declarations core's createRuntimeClient consumes.
const rebuiltClient: Frond.Runtime.RuntimeClient = Frond.createRuntimeClient(
  effectHostFromRuntime(harness.runtime),
  effectBridgeRunner
);
void rebuiltClient;

// Deferred test values.
const deferredProfile = createDeferred<Profile>();
const deferredPromise: Promise<Profile> = deferredProfile.promise;
void deferredPromise;

// Item 7 - readySpec: a test-provided result envelope flows through without
// casts, and the override of a spec WITH declared deps still typechecks.
const ReadyProfile = readySpec(ProfileNode, envelopedProfile);
const readyHandle = harness.node(ReadyProfile, { id: "1" });
void readyHandle;

// Item 7 - mockSpec: overrides against a spec with declared deps; the derived
// dependency shape (rewired or severed) is usable without casts.
const RewiredProfile = mockSpec(ProfileNode, {
  dependencies: () => ({ transport: Frond.dep(OverriddenTransport, Frond.Args.none) }),
});
harness.node(RewiredProfile, { id: "2" });

const SeveredProfile = mockSpec(ProfileNode, { dependencies: () => ({}) });
harness.node(SeveredProfile, { id: "3" });

void handle;
void FrondProvider({ runtime, children: null });
void TestFrondProvider({ runtime, children: null });
void TestFrondProvider({ harness, children: null });
`
        ),
        writeText(
          join(smokeDir, "src/runtime-smoke.mjs"),
          `const core = await import("@frondruntime/core");
const coreTesting = await import("@frondruntime/core/testing");
const react = await import("@frondruntime/react");
const reactTesting = await import("@frondruntime/react/testing");

for (const name of [
  "createRuntime",
  "specWithDriver",
  "withInternal",
  "internalOf",
  "carryInternal",
  "runTransition",
  "createTransition",
  "createRuntimeCoordinator",
]) {
  if (typeof core[name] !== "function") {
    throw new Error(\`Missing @frondruntime/core \${name} export\`);
  }
}

for (const name of [
  "createFrondTestHarness",
  "effectHostFromRuntime",
  "readySpec",
  "mockSpec",
  "createDeferred",
]) {
  if (typeof coreTesting[name] !== "function") {
    throw new Error(\`Missing @frondruntime/core/testing \${name} export\`);
  }
}

if (typeof coreTesting.effectBridgeRunner?.run !== "function") {
  throw new Error("Missing @frondruntime/core/testing effectBridgeRunner export");
}

if (typeof react.FrondProvider !== "function") {
  throw new Error("Missing @frondruntime/react FrondProvider export");
}

if (typeof reactTesting.TestFrondProvider !== "function") {
  throw new Error("Missing @frondruntime/react/testing TestFrondProvider export");
}
`
        ),
      ],
      { concurrency: 4, discard: true }
    );
  });
}

function workspaceChecks(): Effect.Effect<void, PublishFailure> {
  return Effect.gen(function* () {
    yield* section("Workspace checks");
    yield* command("lockfile check", ["bun", "install", "--frozen-lockfile"]);
    yield* command("lint", ["bun", "run", "lint"]);
    yield* command("typecheck", ["bun", "run", "typecheck"]);
    yield* command("Effect diagnostics", ["bun", "run", "effect:diagnostics"]);
    yield* command("tests", ["bun", "run", "test"]);
  });
}

function buildArtifacts(): Effect.Effect<void, PublishFailure> {
  return Effect.gen(function* () {
    yield* section("Build package artifacts");
    yield* command("build", ["bun", "run", "build"]);
  });
}

function publishDryRun(context: PublishContext): Effect.Effect<void, PublishFailure> {
  return Effect.gen(function* () {
    yield* section("npm publish dry-run");
    yield* Effect.forEach(
      context.publishPackages,
      (input) =>
        Effect.gen(function* () {
          const exists = yield* packageVersionExists(input);
          if (dryRun && exists) {
            yield* log(
              `${input.packageJson.name}@${input.packageJson.version} already exists on npm; skipping npm publish dry-run for this already-published version.`
            );
            return;
          }

          yield* command(
            `${input.packageJson.name} publish dry-run`,
            ["npm", "publish", "--dry-run", "--access", "public"],
            { cwd: input.packageDir }
          );
        }),
      { concurrency: 1, discard: true }
    );
  });
}

function packPackage(
  input: PublishPackage,
  tarballsDir: string
): Effect.Effect<string, PublishFailure> {
  return Effect.gen(function* () {
    yield* command(
      `${input.packageJson.name} pack`,
      ["npm", "pack", "--pack-destination", tarballsDir],
      { cwd: input.packageDir }
    );

    return join(tarballsDir, packageTarballName(input.packageJson.name, input.packageJson.version));
  });
}

function packAndSmoke(context: PublishContext): Effect.Effect<void, PublishFailure> {
  return Effect.gen(function* () {
    yield* section("Pack and smoke test tarballs");

    const workDir = yield* makeTempDirectory("frond-publish-");
    const tarballsDir = join(workDir, "tarballs");
    const smokeDir = join(workDir, "smoke");
    const cleanup = removePath(workDir).pipe(Effect.catch(() => Effect.void));

    yield* Effect.gen(function* () {
      yield* Effect.all([makeDirectory(tarballsDir), makeDirectory(smokeDir)], {
        concurrency: 2,
        discard: true,
      });

      const tarballEntries = yield* Effect.forEach(
        context.publishPackages,
        (input) =>
          Effect.map(packPackage(input, tarballsDir), (tarball) => [input, tarball] as const),
        { concurrency: 1 }
      );
      const tarballs = new Map<PublishPackage, string>(tarballEntries);

      yield* writeSmokeProject(smokeDir, tarballs, context);
      yield* command("smoke install", ["bun", "install"], { cwd: smokeDir });
      yield* assertPackedFiles(smokeDir, context.publishPackages);
      yield* command("smoke typecheck", ["bun", "run", "typecheck"], { cwd: smokeDir });
      yield* command("smoke runtime import", ["bun", "run", "smoke"], { cwd: smokeDir });
      yield* log("\nSmoke project passed.");
    }).pipe(Effect.ensuring(cleanup));
  });
}

function publishToNpm(context: PublishContext): Effect.Effect<void, PublishFailure> {
  if (dryRun) {
    return Effect.gen(function* () {
      yield* section("Publish skipped");
      yield* log("Dry run complete. No packages were published.");
    });
  }

  return Effect.gen(function* () {
    yield* section("Publish to npm");
    yield* log("npm may prompt for a one-time password for each package.");
    yield* Effect.forEach(
      context.publishPackages,
      (input) =>
        command(`${input.packageJson.name} publish`, ["npm", "publish", "--access", "public"], {
          cwd: input.packageDir,
        }),
      { concurrency: 1, discard: true }
    );
    yield* log("\nPublish complete.");
  });
}

function smokeOnlyProgram(): Effect.Effect<void, PublishFailure> {
  return Effect.gen(function* () {
    const context = yield* loadPublishContext();

    yield* buildArtifacts();
    yield* packAndSmoke(context);
    yield* section("Publish skipped");
    yield* log("Smoke-only run complete. No packages were published.");
  });
}

const program = Effect.gen(function* () {
  if (smokeOnly) {
    return yield* smokeOnlyProgram();
  }

  yield* assertLocalPublishScript();

  const context = yield* loadPublishContext();

  yield* workspaceChecks();
  yield* buildArtifacts();
  yield* publishDryRun(context);
  yield* packAndSmoke(context);
  yield* publishToNpm(context);
});

await Effect.runPromise(
  program.pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        console.error(`${error.step} failed: ${error.message}`);
        if (error.cause !== undefined) {
          console.error(error.cause);
        }
        process.exitCode = 1;
      })
    )
  )
);
