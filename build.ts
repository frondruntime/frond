import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ConsoleMessageId,
  Extractor,
  ExtractorConfig,
  ExtractorLogLevel,
  type IConfigFile,
} from "@microsoft/api-extractor";
import { Effect } from "effect";

type PackageKey = "core" | "react";

interface ApiEntry {
  readonly label: string;
  readonly input: string;
  readonly output: string;
}

interface PackageBuildInput {
  readonly key: PackageKey;
  readonly packageName: string;
  readonly packageDir: string;
  readonly entrypoints: readonly string[];
  readonly keepNames?: boolean;
  readonly apiEntries: readonly ApiEntry[];
}

class BuildFailure {
  readonly _tag = "BuildFailure";

  constructor(
    readonly packageName: string,
    readonly step: string,
    readonly message: string,
    readonly cause?: unknown
  ) {}
}

const repoDir = dirname(fileURLToPath(import.meta.url));

const standardApiEntries: readonly ApiEntry[] = [
  {
    label: "main types",
    input: "dist-types/index.d.ts",
    output: "dist/index.d.ts",
  },
  {
    label: "testing types",
    input: "dist-types/testing/index.d.ts",
    output: "dist/testing/index.d.ts",
  },
];

const packages = {
  core: {
    key: "core",
    packageName: "@frondruntime/core",
    packageDir: resolve(repoDir, "packages/core"),
    entrypoints: ["./src/index.ts", "./src/testing/index.ts"],
    apiEntries: standardApiEntries,
  },
  react: {
    key: "react",
    packageName: "@frondruntime/react",
    packageDir: resolve(repoDir, "packages/react"),
    entrypoints: ["./src/index.ts", "./src/testing/index.ts"],
    keepNames: true,
    apiEntries: standardApiEntries,
  },
} satisfies Record<PackageKey, PackageBuildInput>;

const packageOrder: readonly PackageBuildInput[] = [packages.core, packages.react];

function log(input: PackageBuildInput, message: string): Effect.Effect<void> {
  return Effect.sync(() => {
    console.log(`[${input.packageName}] ${message}`);
  });
}

function fail(
  input: PackageBuildInput,
  step: string,
  message: string,
  cause?: unknown
): BuildFailure {
  return new BuildFailure(input.packageName, step, message, cause);
}

function removePath(input: PackageBuildInput, path: string): Effect.Effect<void, BuildFailure> {
  return Effect.tryPromise({
    try: () => rm(join(input.packageDir, path), { force: true, recursive: true }),
    catch: (cause) => fail(input, `remove ${path}`, `Could not remove ${path}.`, cause),
  });
}

function runCommand(
  input: PackageBuildInput,
  step: string,
  cmd: readonly string[]
): Effect.Effect<void, BuildFailure> {
  return Effect.gen(function* () {
    yield* log(input, `${step}...`);

    const result = yield* Effect.try({
      try: () =>
        Bun.spawnSync({
          cmd: [...cmd],
          cwd: input.packageDir,
          stderr: "pipe",
          stdout: "pipe",
        }),
      catch: (cause) => fail(input, step, `${step} failed to start.`, cause),
    });

    if (result.exitCode !== 0) {
      const stdout = result.stdout.toString().trim();
      const stderr = result.stderr.toString().trim();
      if (stdout.length > 0) console.log(stdout);
      if (stderr.length > 0) console.error(stderr);

      return yield* Effect.fail(
        fail(input, step, `${step} failed with exit code ${result.exitCode}.`)
      );
    }

    yield* log(input, `${step} ok`);
  });
}

function buildJavaScript(input: PackageBuildInput): Effect.Effect<void, BuildFailure> {
  return Effect.gen(function* () {
    yield* log(input, "javascript...");

    const result = yield* Effect.tryPromise({
      try: () =>
        Bun.build({
          // Published dist must emit production JSX (jsx, not jsxDEV), so production
          // consumers do not crash on the missing dev runtime.
          define: { "process.env.NODE_ENV": JSON.stringify("production") },
          entrypoints: input.entrypoints.map((entrypoint) => join(input.packageDir, entrypoint)),
          format: "esm",
          keepNames: input.keepNames,
          outdir: join(input.packageDir, "dist"),
          packages: "external",
          root: join(input.packageDir, "src"),
          splitting: true,
          sourcemap: "external",
          target: "browser",
          tsconfig: join(input.packageDir, "tsconfig.build.json"),
        }),
      catch: (cause) => fail(input, "javascript", "JavaScript build threw.", cause),
    });

    if (!result.success) {
      for (const message of result.logs) {
        console.error(message);
      }

      return yield* Effect.fail(fail(input, "javascript", "JavaScript build failed."));
    }

    yield* log(input, "javascript ok");
  });
}

function extractorConfig(input: PackageBuildInput, entry: ApiEntry): ExtractorConfig {
  const configObject: IConfigFile = {
    projectFolder: input.packageDir,
    mainEntryPointFilePath: `<projectFolder>/${entry.input}`,
    newlineKind: "lf",
    compiler: {
      tsconfigFilePath: "<projectFolder>/tsconfig.api-extractor.json",
      skipLibCheck: true,
    },
    apiReport: {
      enabled: false,
    },
    docModel: {
      enabled: false,
    },
    dtsRollup: {
      enabled: true,
      untrimmedFilePath: `<projectFolder>/${entry.output}`,
      alphaTrimmedFilePath: "",
      betaTrimmedFilePath: "",
      publicTrimmedFilePath: "",
    },
    tsdocMetadata: {
      enabled: false,
    },
    messages: {
      extractorMessageReporting: {
        "ae-forgotten-export": { logLevel: "none" },
        "ae-missing-release-tag": { logLevel: "none" },
      },
    },
  };

  return ExtractorConfig.prepare({
    configObject,
    configObjectFullPath: undefined,
    packageJsonFullPath: join(input.packageDir, "package.json"),
  });
}

function rollupDeclaration(
  input: PackageBuildInput,
  entry: ApiEntry
): Effect.Effect<void, BuildFailure> {
  return Effect.gen(function* () {
    yield* log(input, `${entry.label}...`);

    const result = yield* Effect.try({
      try: () =>
        Extractor.invoke(extractorConfig(input, entry), {
          localBuild: true,
          messageCallback: (message) => {
            if (
              message.messageId === ConsoleMessageId.Preamble ||
              message.messageId === ConsoleMessageId.CompilerVersionNotice
            ) {
              message.handled = true;
              return;
            }

            if (
              message.logLevel === ExtractorLogLevel.Info ||
              message.logLevel === ExtractorLogLevel.Verbose
            ) {
              message.handled = true;
            }
          },
        }),
      catch: (cause) => fail(input, entry.label, `${entry.label} rollup threw.`, cause),
    });

    if (!result.succeeded) {
      return yield* Effect.fail(
        fail(
          input,
          entry.label,
          `${entry.label} rollup failed with ${result.errorCount} errors and ${result.warningCount} warnings.`
        )
      );
    }

    yield* log(input, `${entry.label} ok`);
  });
}

function rollupDeclarations(input: PackageBuildInput): Effect.Effect<void, BuildFailure> {
  return Effect.forEach(input.apiEntries, (entry) => rollupDeclaration(input, entry), {
    discard: true,
  });
}

function buildPackage(input: PackageBuildInput): Effect.Effect<void, BuildFailure> {
  const cleanupTypes = removePath(input, "dist-types").pipe(Effect.catch(() => Effect.void));

  return Effect.gen(function* () {
    yield* Effect.all([removePath(input, "dist"), removePath(input, "dist-types")], {
      concurrency: 2,
      discard: true,
    });

    yield* Effect.all(
      [
        buildJavaScript(input),
        runCommand(input, "declarations", ["tsc", "-p", "tsconfig.build.json"]),
      ],
      {
        concurrency: 2,
        discard: true,
      }
    );

    yield* rollupDeclarations(input);
    yield* removePath(input, "dist-types");
    yield* log(input, "build ok");
  }).pipe(Effect.ensuring(cleanupTypes));
}

function buildPackages(inputs: readonly PackageBuildInput[]): Effect.Effect<void, BuildFailure> {
  return Effect.forEach(inputs, buildPackage, { concurrency: 1, discard: true });
}

function parsePackageArgs(args: readonly string[]): readonly PackageBuildInput[] {
  if (args.length === 0) {
    return packageOrder;
  }

  const invalid = args.filter((arg) => !(arg in packages));
  if (invalid.length > 0) {
    console.error(`Unknown package input: ${invalid.join(", ")}`);
    console.error("Usage: bun build.ts [core] [react]");
    process.exit(1);
  }

  return args.map((arg) => packages[arg as PackageKey]);
}

await Effect.runPromise(
  buildPackages(parsePackageArgs(Bun.argv.slice(2))).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        console.error(`[${error.packageName}] ${error.step} failed: ${error.message}`);
        if (error.cause !== undefined) {
          console.error(error.cause);
        }
        process.exitCode = 1;
      })
    )
  )
);
