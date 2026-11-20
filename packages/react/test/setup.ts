// The DOM environment only. Each test file registers its own
// `afterEach(cleanup)`: bun evaluates this module once per run, so a hook
// registered here would attach only to the first test file that loads it.
import "global-jsdom/register";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
