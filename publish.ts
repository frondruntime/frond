import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";

const internalScope = "@frondruntime/";

/** Dependency fields whose ranges a published consumer actually has to resolve. */
const publishedDependencyFields = ["dependencies", "peerDependencies"] as const;

type PublishedDependencyField = (typeof publishedDependencyFields)[number];

type PublishKey = "core" | "react" | "devtools" | "hub";

interface PackageJson {
  readonly name: string;
  readonly version: string;
  readonly bin?: Record<string, string>;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}

/**
 * A published command exercised against the installed tarball. `args` must
 * terminate on its own: the pack smoke is non-interactive.
 */
interface CliSmoke {
  readonly bin: string;
  readonly args: readonly string[];
}

interface PublishPackageInput {
  readonly key: PublishKey;
  readonly directory: string;
  /**
   * Paths that must exist inside the installed package. Directories are
   * allowed. Source-only packages list no `dist` entries at all.
   */
  readonly expectedFiles: readonly string[];
  readonly cliSmoke?: CliSmoke;
}

interface PublishPackage extends PublishPackageInput {
  readonly packageDir: string;
  readonly packageJson: PackageJson;
}

interface PublishContext {
  readonly rootPackageJson: PackageJson;
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

/**
 * Publish order, not just a package list. Every package must appear after the
 * internal packages it depends on, so a consumer installing while a release is
 * mid-flight never resolves a dependency range that is not on the registry yet.
 * `assertPublishOrder` enforces that this list actually holds that property.
 */
const publishPackageOrder: readonly PublishPackageInput[] = [
  {
    key: "core",
    directory: "packages/core",
    expectedFiles: [
      "package.json",
      "README.md",
      "src",
      "dist/index.js",
      "dist/index.d.ts",
      "dist/testing/index.js",
      "dist/testing/index.d.ts",
    ],
  },
  {
    key: "react",
    directory: "packages/react",
    expectedFiles: [
      "package.json",
      "README.md",
      "src",
      "dist/index.js",
      "dist/index.d.ts",
      "dist/testing/index.js",
      "dist/testing/index.d.ts",
    ],
  },
  {
    key: "devtools",
    directory: "packages/devtools",
    expectedFiles: [
      "package.json",
      "README.md",
      "LICENSE",
      "src",
      "dist/index.js",
      "dist/index.d.ts",
      "dist/node.js",
      "dist/node.d.ts",
    ],
  },
  {
    // Ships as source: the entry point is `src/cli.tsx` behind a `bun` shebang,
    // there is no hub target in build.ts, and there is deliberately no `dist`
    // to assert on. `bunx @frondruntime/hub` works; `npx` does not.
    key: "hub",
    directory: "apps/hub",
    expectedFiles: ["package.json", "README.md", "LICENSE", "src", "src/cli.tsx"],
    cliSmoke: { bin: "frond-hub", args: ["--version"] },
  },
];

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
  5. clean Bun consumer smoke against packed tarballs, including published CLIs
  6. npm publish with interactive 2FA prompt unless --dry-run is set

Packages publish in dependency order: core, react, devtools, hub.

Flags:
  --dry-run    Run steps 1-5 and stop before npm publish.
  --smoke-only Just the packed-tarball consumer smoke: package metadata
               validation, build, npm pack and the smoke (steps 2, 4 and 5).
               Skips the workspace checks CI runs as separate steps, the npm
               publish dry-run and npm publish, so it needs no registry auth.
               For iterating on the smoke itself; the release flow above always
               runs it anyway.

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

/**
 * Existence check that accepts directories. `Bun.file(...).exists()` reports
 * `false` for a directory, and packed file lists name directories.
 */
function pathExists(step: string, path: string): Effect.Effect<boolean, PublishFailure> {
  return Effect.tryPromise({
    try: async () => {
      try {
        await stat(path);
        return true;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
          return false;
        }

        throw cause;
      }
    },
    catch: (cause) => fail(step, `Could not inspect ${path}.`, cause),
  });
}

function requirePackage(context: PublishContext, key: PublishKey): PublishPackage {
  const found = context.publishPackages.find((input) => input.key === key);
  if (found === undefined) {
    throw new Error(`No publish package is registered under the key ${key}.`);
  }

  return found;
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

interface InternalEdge {
  readonly from: PublishPackage;
  readonly field: PublishedDependencyField;
  readonly name: string;
  readonly range: string;
}

/**
 * Every `@frondruntime/*` range a published package asks a consumer to resolve,
 * across both `dependencies` and `peerDependencies`. `devDependencies` are
 * excluded: they hold `workspace:*` and never reach a consumer.
 */
function internalEdges(packages: readonly PublishPackage[]): readonly InternalEdge[] {
  return packages.flatMap((from) =>
    publishedDependencyFields.flatMap((field) =>
      Object.entries(from.packageJson[field] ?? {})
        .filter(([name]) => name.startsWith(internalScope))
        .map(([name, range]) => ({ from, field, name, range }))
    )
  );
}

function assertPublishMetadata(
  packages: readonly PublishPackage[]
): Effect.Effect<void, PublishFailure> {
  return Effect.try({
    try: () => {
      // Collected rather than thrown one at a time: a version bump usually
      // breaks several edges at once, and reporting them together is the
      // difference between one pass over the manifests and four.
      const problems: string[] = [];

      for (const input of packages) {
        if (input.packageJson.version.length === 0) {
          problems.push(`${input.packageJson.name} has an empty version.`);
        }
      }

      const byName = new Map(packages.map((input) => [input.packageJson.name, input]));

      for (const edge of internalEdges(packages)) {
        const label = `${edge.from.packageJson.name} ${edge.field} on ${edge.name}`;
        const target = byName.get(edge.name);
        if (target === undefined) {
          problems.push(`${label} points at a package this pipeline does not publish.`);
          continue;
        }

        // Called out separately because it is not version skew and reads like
        // a working local setup: `npm pack` copies the workspace protocol into
        // the tarball verbatim, and every consumer install then fails to
        // resolve it. Bun's own workspaces are what make it look fine here.
        if (edge.range.startsWith("workspace:")) {
          problems.push(
            `${label} is ${edge.range}. npm pack does not rewrite the workspace protocol, so a consumer cannot resolve it. Pin it to ${target.packageJson.version}.`
          );
          continue;
        }

        if (edge.range !== target.packageJson.version) {
          problems.push(`${label} is ${edge.range}, expected ${target.packageJson.version}.`);
        }
      }

      if (problems.length > 0) {
        throw new Error(problems.map((problem) => `- ${problem}`).join("\n"));
      }
    },
    catch: (cause) =>
      fail("validate package metadata", "Package metadata is not publishable.", cause),
  });
}

/**
 * A package must publish after everything it depends on. Otherwise a consumer
 * installing mid-run resolves a range whose target is not on the registry yet.
 */
function assertPublishOrder(
  packages: readonly PublishPackage[]
): Effect.Effect<void, PublishFailure> {
  return Effect.try({
    try: () => {
      const position = new Map(
        packages.map((input, index) => [input.packageJson.name, index] as const)
      );

      for (const edge of internalEdges(packages)) {
        const fromIndex = position.get(edge.from.packageJson.name) ?? -1;
        const targetIndex = position.get(edge.name) ?? -1;
        if (targetIndex >= fromIndex) {
          throw new Error(
            `${edge.from.packageJson.name} depends on ${edge.name}, so ${edge.name} must publish first.`
          );
        }
      }
    },
    catch: (cause) =>
      fail("validate publish order", "Publish order is not dependency-safe.", cause),
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
        const exists = yield* pathExists("check packed files", path);

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

// The smoke is only evidence about the tarballs if the tarballs are the only
// copies installed. `overrides` in the smoke package.json pins every request,
// but a resolver that ignores or mis-applies them would quietly reintroduce a
// registry copy nested under a dependent — and then the typecheck reports
// cross-package type-identity errors that look like artifact defects. Fail
// loudly on the layout instead of letting the diagnosis start from tsc output.
function assertSingleCopies(
  smokeDir: string,
  packages: readonly PublishPackage[]
): Effect.Effect<void, PublishFailure> {
  return Effect.forEach(
    packages,
    (input) =>
      Effect.gen(function* () {
        const nested = join(smokeDir, "node_modules", input.packageJson.name, "node_modules");
        const entries = yield* Effect.tryPromise({
          try: () => readdir(nested).catch(() => [] as string[]),
          catch: (cause) => fail("check installed copies", `Could not inspect ${nested}.`, cause),
        });

        if (entries.includes("@frondruntime")) {
          return yield* Effect.fail(
            fail(
              "check installed copies",
              `${input.packageJson.name} has a nested @frondruntime copy at ${nested}. ` +
                "The smoke must resolve a single copy of each workspace package, from the packed " +
                "tarball. Check the smoke package.json overrides."
            )
          );
        }
      }),
    { discard: true }
  );
}

/**
 * Every `bin` a package declares must be linked by the consumer's install, and
 * the link must point at a file that survived packing.
 */
function assertPackedBinaries(
  smokeDir: string,
  packages: readonly PublishPackage[]
): Effect.Effect<void, PublishFailure> {
  return Effect.forEach(
    packages.flatMap((input) =>
      Object.entries(input.packageJson.bin ?? {}).map(([binName, target]) => ({
        input,
        binName,
        target,
      }))
    ),
    ({ input, binName, target }) =>
      Effect.gen(function* () {
        const linkPath = join(smokeDir, "node_modules/.bin", binName);
        const targetPath = join(smokeDir, "node_modules", input.packageJson.name, target);

        const linked = yield* pathExists("check packed binaries", linkPath);
        if (!linked) {
          return yield* Effect.fail(
            fail(
              "check packed binaries",
              `${input.packageJson.name} bin ${binName} was not linked into node_modules/.bin.`
            )
          );
        }

        const resolved = yield* pathExists("check packed binaries", targetPath);
        if (!resolved) {
          return yield* Effect.fail(
            fail(
              "check packed binaries",
              `${input.packageJson.name} bin ${binName} points at ${target}, which is not in the tarball.`
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
    const publishPackages = yield* Effect.forEach(publishPackageOrder, (input) =>
      Effect.map(
        readPackageJson(join(repoDir, input.directory, "package.json")),
        (packageJson): PublishPackage => ({
          ...input,
          packageDir: join(repoDir, input.directory),
          packageJson,
        })
      )
    );

    yield* assertPublishMetadata(publishPackages);
    yield* assertPublishOrder(publishPackages);
    yield* log(
      `Publishing in order: ${publishPackages
        .map((input) => `${input.packageJson.name}@${input.packageJson.version}`)
        .join(", ")}`
    );

    return { rootPackageJson, publishPackages };
  });
}

function smokePackageJson(
  smokeDir: string,
  tarballs: ReadonlyMap<PublishPackage, string>,
  context: PublishContext
): Effect.Effect<unknown, PublishFailure> {
  return Effect.try({
    try: () => {
      const tarballDependencies = Object.fromEntries(
        context.publishPackages.map((input) => [
          input.packageJson.name,
          fileDependency(smokeDir, requireTarball(tarballs, input)),
        ])
      );

      return {
        name: "frond-publish-smoke",
        private: true,
        type: "module",
        scripts: {
          typecheck: "tsc -p tsconfig.json --noEmit",
          smoke: "node ./src/runtime-smoke.mjs",
        },
        dependencies: {
          ...tarballDependencies,
          effect: requireDependency(context.rootPackageJson, "devDependencies", "effect"),
          mobx: requireDependency(
            requirePackage(context, "core").packageJson,
            "devDependencies",
            "mobx"
          ),
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
        // Two reasons, and either one alone would be enough. The internal
        // packages depend on each other by exact version, and a release
        // candidate's versions are by definition not on the registry yet, so a
        // nested range would 404. And where a range *is* satisfiable from the
        // registry — react's exact `@frondruntime/core` peer, say — the
        // installer is free to nest a published copy under the dependent, so
        // react's declarations get checked against a *released* core while the
        // consumer sources use the packed one. That yields "two different types
        // with this name exist" errors that indict the artifacts for a
        // resolution accident, and worse, it can silently pass by testing a
        // version we did not just build. Overrides pin every internal
        // resolution — direct and transitive — to the tarball under test.
        overrides: tarballDependencies,
      };
    },
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
import { attachDevtools, HUB_DEFAULT_ATTACH_URL } from "@frondruntime/devtools";
import { type HubLock, readHubLock } from "@frondruntime/devtools/node";
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

// The devtools entry point, and the node-only lock reader behind its own
// export condition: both have to resolve from the packed tarball, and the
// attach call has to typecheck against the packed core's Runtime.
const detachDevtools: () => void = attachDevtools({
  runtime,
  name: "publish-smoke",
  url: HUB_DEFAULT_ATTACH_URL,
});
const hubLock: HubLock | undefined = readHubLock();
void detachDevtools;
void hubLock;

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
const devtools = await import("@frondruntime/devtools");
const devtoolsNode = await import("@frondruntime/devtools/node");

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

if (typeof devtools.attachDevtools !== "function") {
  throw new Error("Missing @frondruntime/devtools attachDevtools export");
}

if (typeof devtoolsNode.readHubLock !== "function") {
  throw new Error("Missing @frondruntime/devtools/node readHubLock export");
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

/**
 * Launches each published CLI from the consumer's `node_modules/.bin`, through
 * the shebang rather than an interpreter this script picks, because the shebang
 * is what an installing user actually gets. Terminating invocations only: the
 * hub's default command is a long-lived Ink session, so `--version` stands in
 * for "the bin resolves and the program starts".
 */
function smokeCommandLines(
  smokeDir: string,
  packages: readonly PublishPackage[]
): Effect.Effect<void, PublishFailure> {
  return Effect.forEach(
    packages.flatMap((input) =>
      input.cliSmoke === undefined ? [] : [{ input, cli: input.cliSmoke }]
    ),
    ({ input, cli }) =>
      command(
        `${input.packageJson.name} cli smoke`,
        [join(smokeDir, "node_modules/.bin", cli.bin), ...cli.args],
        { cwd: smokeDir }
      ),
    { concurrency: 1, discard: true }
  );
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
      yield* assertSingleCopies(smokeDir, context.publishPackages);
      yield* assertPackedBinaries(smokeDir, context.publishPackages);
      yield* command("smoke typecheck", ["bun", "run", "typecheck"], { cwd: smokeDir });
      yield* command("smoke runtime import", ["bun", "run", "smoke"], { cwd: smokeDir });
      yield* smokeCommandLines(smokeDir, context.publishPackages);
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
