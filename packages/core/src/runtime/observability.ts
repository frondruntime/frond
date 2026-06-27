import { Effect } from "effect";
import type { NodeId } from "../graph";
import type { RuntimeSignal, RuntimeSignalRecord } from "../signals";
import type { RuntimeCommand, RuntimeId } from "./types";
import { type RuntimeWorkContext, runtimeWorkAttributes } from "./work";

let nextRuntime = 0;

export function makeRuntimeId(): RuntimeId {
  nextRuntime += 1;
  return `runtime-${nextRuntime}` as RuntimeId;
}

export function withRuntimeSpan<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  name: string,
  attributes: Record<string, unknown>
): Effect.Effect<A, E, R> {
  return effect.pipe(Effect.withSpan(name, { attributes }));
}

export function runtimeCommandSpanName(command: RuntimeCommand): string {
  return `frond.runtime.command.${command._tag}`;
}

export function runtimeCommandAttributes(
  runtimeId: RuntimeId,
  command: RuntimeCommand,
  work?: RuntimeWorkContext | undefined
): Record<string, unknown> {
  return {
    "frond.runtime.id": runtimeId,
    "frond.runtime.command": command._tag,
    ...workAttributes(work),
  };
}

export function nodeSpanAttributes(input: {
  readonly runtimeId: RuntimeId;
  readonly nodeId?: NodeId | undefined;
  readonly tag?: string | undefined;
  readonly attemptId?: number | undefined;
  readonly operationId?: number | undefined;
  readonly action?: string | undefined;
  readonly source?: string | undefined;
  readonly reason?: string | undefined;
  readonly work?: RuntimeWorkContext | undefined;
}): Record<string, unknown> {
  const attributes: Record<string, unknown> = workAttributes(input.work);

  setAttribute(attributes, "frond.runtime.id", input.runtimeId);
  setAttribute(attributes, "frond.node.id", input.nodeId);
  setAttribute(attributes, "frond.node.tag", input.tag);
  setAttribute(attributes, "frond.node.attempt_id", input.attemptId);
  setAttribute(attributes, "frond.node.operation_id", input.operationId);
  setAttribute(attributes, "frond.action", input.action);
  setAttribute(attributes, "frond.source", input.source);
  setAttribute(attributes, "frond.reason", input.reason);

  return attributes;
}

export function signalSpanAttributes(input: {
  readonly runtimeId: RuntimeId;
  readonly signal?: RuntimeSignal | undefined;
  readonly record?: RuntimeSignalRecord | undefined;
  readonly subscriber?: string | undefined;
  readonly work?: RuntimeWorkContext | undefined;
}): Record<string, unknown> {
  const signal = input.record?.signal ?? input.signal;
  const attributes: Record<string, unknown> = workAttributes(input.work);

  setAttribute(attributes, "frond.runtime.id", input.runtimeId);
  setAttribute(attributes, "frond.signal.channel", signal?.channel);
  setAttribute(attributes, "frond.signal.name", signal?.name);
  setAttribute(attributes, "frond.signal.sequence", input.record?.sequence);
  setAttribute(attributes, "frond.signal.subscriber", input.subscriber);

  return attributes;
}

function workAttributes(work: RuntimeWorkContext | undefined): Record<string, unknown> {
  return work === undefined ? {} : runtimeWorkAttributes(work);
}

function setAttribute(
  attributes: Record<string, unknown>,
  key: string,
  value: unknown | undefined
): void {
  if (value !== undefined) {
    attributes[key] = value;
  }
}
