import { describe, expect, test } from "bun:test";
import { Context, Effect, Option, Tracer } from "effect";
import {
  type ActionContract,
  createRuntime,
  Driver,
  dependencies,
  Key,
  NodeBase,
  type NodeSpec,
  serviceSpec,
} from "../src/index";

interface RecordedSpan {
  readonly name: string;
  readonly parent: string | undefined;
  ended: boolean;
  exit: string | undefined;
}

function recordingTracer(spans: RecordedSpan[]): Tracer.Tracer {
  return Tracer.make({
    span: (options) => {
      const recorded: RecordedSpan = {
        name: options.name,
        parent: Option.match(options.parent, {
          onNone: () => undefined,
          onSome: (parent) => (parent._tag === "Span" ? parent.name : parent.spanId),
        }),
        ended: false,
        exit: undefined,
      };
      spans.push(recorded);
      const span: Tracer.Span = {
        _tag: "Span",
        name: options.name,
        spanId: String(spans.length),
        traceId: "driver-edge-spans",
        parent: options.parent,
        annotations: Context.empty(),
        status: { _tag: "Started", startTime: options.startTime },
        attributes: new Map(),
        links: [],
        sampled: options.sampled,
        kind: options.kind,
        end: (endTime, exit) => {
          recorded.ended = true;
          recorded.exit = exit._tag;
          (span as { status: Tracer.SpanStatus }).status = {
            _tag: "Ended",
            startTime: options.startTime,
            endTime,
            exit,
          };
        },
        attribute: () => {},
        event: () => {},
        addLinks: () => {},
      };
      return span;
    },
  });
}

type Spec = NodeSpec<{
  readonly mode: "async";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: number;
  readonly actions: {
    readonly later: ActionContract<void, number>;
    readonly now: ActionContract<void, number>;
  };
}>;

class Service extends NodeBase<Spec> {
  static readonly spec = serviceSpec.async<Spec>({
    tag: "edges/traced-async",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    acquire: Driver.Acquire(async () => 1),
    actions: {
      later: Driver.Action(async () => 2),
      now: Driver.Action(() => 3),
    },
  });
}

describe("driver edge spans on a non-Effect node", () => {
  test("an Effect-facade caller traces the acquire and action edges under its own span", async () => {
    const runtime = createRuntime({ development: true, eventBufferSize: 512 });
    const handle = runtime.client.node(Service, {});
    const spans: RecordedSpan[] = [];
    try {
      await Effect.runPromise(
        Effect.withSpan(
          Effect.andThen(handle.action("later"), handle.action("now")),
          "caller"
        ).pipe(Effect.withTracer(recordingTracer(spans)))
      );
    } finally {
      await runtime.submit({ _tag: "RuntimeStop" });
    }
    const edges = spans.filter(
      (span) => span.name === "frond.graph.acquire" || span.name === "frond.graph.action.driver"
    );
    expect(edges.map((span) => span.name)).toEqual([
      "frond.graph.acquire",
      "frond.graph.action.driver",
      "frond.graph.action.driver",
    ]);
    for (const edge of edges) {
      expect(edge.parent).toBeDefined();
      expect(edge.ended).toBe(true);
      expect(edge.exit).toBe("Success");
    }
  });
});
