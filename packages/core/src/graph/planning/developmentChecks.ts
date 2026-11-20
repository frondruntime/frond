// Core targets browsers, Hermes, and Bun without Node typings; `process` may not
// exist at runtime.
declare const process: { readonly env: { readonly NODE_ENV?: string | undefined } } | undefined;

// Read `NODE_ENV` through a local, not as the literal `process.env.NODE_ENV`:
// the published build defines that literal as "production" (build.ts, for
// production JSX), which would fold the check off for every consumer. Through
// the local, the app's own runtime value decides; React Native sets it from
// `__DEV__`.
const environment = typeof process === "undefined" ? undefined : process.env;

/**
 * Checks that run only in development. Read once at module load: enabled
 * where `process.env.NODE_ENV` is not "production" at runtime, and off when
 * `process` is absent (a browser bundle without a `process` shim). A shim
 * whose `env` lacks `NODE_ENV` turns it on; that costs speed, not
 * correctness. Internal,
 * not exported from the package; tests toggle it to reach the production
 * path.
 */
export const developmentChecks: { replanDependencies: boolean } = {
  // Same-identity re-plan confirms `dependencies(args)` still yields the
  // recorded dependency ids before taking the fast path.
  replanDependencies: environment !== undefined && environment.NODE_ENV !== "production",
};
