import { afterEach } from "bun:test";
import "global-jsdom/register";
import { cleanup } from "@testing-library/react";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
});
