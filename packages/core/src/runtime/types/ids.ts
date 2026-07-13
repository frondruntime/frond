import type { KeyError } from "../../keys";
import type { FrondRuntimeClosed } from "../errors";

export type RuntimeError = FrondRuntimeClosed | KeyError;

export type RuntimeStatus = "idle" | "running" | "stopped";

export type RuntimeId = string & { readonly __brand: "Runtime.Id" };
