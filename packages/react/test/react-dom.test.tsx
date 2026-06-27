import "./setup";
import { describe, expect, spyOn, test } from "bun:test";
import {
  createRuntime,
  type Dep,
  Driver,
  dep,
  dependencies,
  Graph,
  Key,
  NodeBase,
  type NodeSpec,
  Runtime,
  resourceSpec,
  resultCommit,
} from "@frondruntime/core";
import { createFrondTestHarness, readySpec } from "@frondruntime/core/testing";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { Deferred, Effect } from "effect";
import {
  Component,
  createElement,
  type ErrorInfo,
  type ReactNode,
  StrictMode,
  Suspense,
  useState,
} from "react";
import {
  FrondProvider,
  getErrorRecovery,
  Preload,
  useNode,
  useNodeControls,
  useNodeState,
  useNodes,
  useNodesControls,
} from "../src";
import { assertStableKeySet } from "../src/nodeInputMap";
import { TestFrondProvider } from "../src/testing";

type Profile = {
  readonly timezone: string;
};

type EmptyArgs = Record<string, never>;

type StringSpec = NodeSpec<{
  readonly args: EmptyArgs;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: string;
}>;

type ProfileSpec<TArgs = EmptyArgs, TKey = Key.Singleton> = NodeSpec<{
  readonly args: TArgs;
  readonly key: TKey;
  readonly deps: Record<string, never>;
  readonly result: Profile;
}>;

describe("React DOM adapter", () => {
  test("TestFrondProvider supplies a harness runtime and respects spec overrides", async () => {
    class TestingProviderNode extends NodeBase<StringSpec> {
      static readonly spec = resourceSpec<StringSpec>({
        tag: "react-dom/resources/testing-provider",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<StringSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("base")),
        }),
      });
    }

    const harness = createFrondTestHarness({
      specOverrides: [
        { from: TestingProviderNode, to: readySpec(TestingProviderNode, "override") },
      ],
    });
    await harness.start();

    const TestingProviderView = () => {
      const node = useNode(TestingProviderNode, {});

      return createElement("output", undefined, node.result);
    };

    const view = render(
      createElement(
        TestFrondProvider,
        { harness },
        createElement(
          Suspense,
          { fallback: createElement("span", undefined, "loading") },
          createElement(TestingProviderView)
        )
      )
    );

    expect(await view.findByText("override")).toBeTruthy();
  });

  test("suspends cold nodes and renders the ready graph-owned node", async () => {
    const gate = await Effect.runPromise(Deferred.make<Profile>());

    class DomProfileNode extends NodeBase<ProfileSpec> {
      static readonly spec = resourceSpec<ProfileSpec>({
        tag: "react-dom/resources/profile",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ProfileSpec>({
          acquire: Driver.Acquire(() => Deferred.await(gate)),
        }),
      });

      get timezone(): string {
        return this.result.timezone;
      }
    }
    let renderedNode: DomProfileNode | undefined;

    const ProfileView = () => {
      const profile = useNode(DomProfileNode, {});
      renderedNode = profile;

      return createElement("output", { "data-testid": "timezone" }, profile.timezone);
    };

    const runtime = createRuntime();
    await runtime.submit({ _tag: "RuntimeStart" });

    const view = render(
      createElement(
        FrondProvider,
        { runtime },
        createElement(
          Suspense,
          { fallback: createElement("span", undefined, "loading") },
          createElement(ProfileView)
        )
      )
    );

    expect(view.getByText("loading")).toBeTruthy();

    await act(async () => {
      await Effect.runPromise(Deferred.succeed(gate, { timezone: "UTC" }));
    });

    expect(await view.findByText("UTC")).toBeTruthy();
    expect(renderedNode).toBeInstanceOf(DomProfileNode);
    expect(renderedNode?.nodeId).toBe(
      runtime.resolveNodeIdSync({ spec: DomProfileNode, args: {} })
    );
    expect(renderedNode?.result).toEqual({ timezone: "UTC" });
  });

  test("StrictMode cold Suspense boot joins one graph readiness acquire", async () => {
    const started = await Effect.runPromise(Deferred.make<void>());
    const gate = await Effect.runPromise(Deferred.make<Profile>());
    let acquireCount = 0;

    class StrictColdBootNode extends NodeBase<ProfileSpec> {
      static readonly spec = resourceSpec<ProfileSpec>({
        tag: "react-dom/resources/strict-cold-boot",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ProfileSpec>({
          acquire: Driver.Acquire(() =>
            Effect.gen(function* () {
              acquireCount += 1;
              yield* Deferred.succeed(started, undefined);
              return yield* Deferred.await(gate);
            })
          ),
        }),
      });

      get timezone(): string {
        return this.result.timezone;
      }
    }

    const ProfileView = () => {
      const profile = useNode(StrictColdBootNode, {});

      return createElement("output", { "data-testid": "timezone" }, profile.timezone);
    };

    const runtime = createRuntime();
    await runtime.submit({ _tag: "RuntimeStart" });

    const view = render(
      createElement(
        StrictMode,
        undefined,
        createElement(
          FrondProvider,
          { runtime },
          createElement(
            Suspense,
            { fallback: createElement("span", undefined, "loading") },
            createElement(ProfileView)
          )
        )
      )
    );

    expect(view.getByText("loading")).toBeTruthy();
    await Effect.runPromise(Deferred.await(started));
    expect(acquireCount).toBe(1);

    await act(async () => {
      await Effect.runPromise(Deferred.succeed(gate, { timezone: "UTC" }));
    });

    expect(await view.findByText("UTC")).toBeTruthy();
    expect(acquireCount).toBe(1);
  });

  test("expired acquire result reaches ErrorBoundary without rendering expired payload", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});

    try {
      class ExpiredProfileNode extends NodeBase<ProfileSpec> {
        static readonly spec = resourceSpec<ProfileSpec>({
          tag: "react-dom/resources/expired-profile",
          key: () => Key.singleton(),
          dependencies: dependencies(() => ({})),
          driver: Driver.Effect<ProfileSpec>({
            resultValidity: { _tag: "Manual" },
            acquire: Driver.Acquire(() =>
              Effect.succeed(
                resultCommit(
                  { timezone: "expired" },
                  {
                    validity: { _tag: "Expired", expiredAt: 10 },
                  }
                )
              )
            ),
          }),
        });

        get timezone(): string {
          return this.result.timezone;
        }
      }

      const ProfileView = () => {
        const profile = useNode(ExpiredProfileNode, {});

        return createElement("output", undefined, profile.timezone);
      };

      const runtime = createRuntime();
      await runtime.submit({ _tag: "RuntimeStart" });

      const view = render(
        createElement(
          FrondProvider,
          { runtime },
          createElement(
            TestErrorBoundary,
            {
              fallback: (_reset, error) => {
                if (!(error instanceof Runtime.FrondRuntimeReadError)) {
                  return createElement("output", undefined, "unexpected-error");
                }

                const cause = error.cause;

                if (
                  !(cause instanceof Graph.AcquireFailed) ||
                  !(cause.cause instanceof Graph.ResultExpired)
                ) {
                  return createElement("output", undefined, "unexpected-cause");
                }

                return createElement("output", undefined, "expired-result-error");
              },
            },
            createElement(
              Suspense,
              { fallback: createElement("span", undefined, "loading") },
              createElement(ProfileView)
            )
          )
        )
      );

      expect(view.queryByText("expired")).toBeNull();

      expect(await view.findByText("expired-result-error")).toBeTruthy();
      expect(view.queryByText("expired")).toBeNull();
    } finally {
      consoleError.mockRestore();
    }
  });

  test("same-identity args update keeps old data visible while refresh is busy", async () => {
    const refreshGate = await Effect.runPromise(Deferred.make<Profile>());

    type FilteredProfileSpec = ProfileSpec<{ readonly filter: string }>;

    class FilteredProfileNode extends NodeBase<FilteredProfileSpec> {
      static readonly spec = resourceSpec<FilteredProfileSpec>({
        tag: "react-dom/resources/filtered-profile",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<FilteredProfileSpec>({
          acquire: Driver.Acquire((ctx) =>
            Effect.sync(() => ({
              timezone: ctx.args.filter,
            }))
          ),
          refresh: Driver.Refresh((ctx) =>
            Effect.gen(function* () {
              yield* Deferred.await(refreshGate);
              yield* ctx.setResult({
                timezone: ctx.args.filter,
              });
            })
          ),
        }),
      });

      get label(): string {
        return `${this.result.timezone}:${this.args.filter}`;
      }
    }

    const ProfileView = ({ filter }: { readonly filter: string }) => {
      const profile = useNodeState(FilteredProfileNode, { filter });

      return createElement(
        "output",
        undefined,
        `${profile.node.label}:${profile.busy ? "busy" : "idle"}`
      );
    };

    const runtime = createRuntime();
    await runtime.submit({ _tag: "RuntimeStart" });

    const view = render(
      createElement(
        FrondProvider,
        { runtime },
        createElement(
          Suspense,
          { fallback: createElement("span", undefined, "loading") },
          createElement(ProfileView, { filter: "all" })
        )
      )
    );

    expect(await view.findByText("all:all:idle")).toBeTruthy();

    view.rerender(
      createElement(
        FrondProvider,
        { runtime },
        createElement(
          Suspense,
          { fallback: createElement("span", undefined, "loading") },
          createElement(ProfileView, { filter: "active" })
        )
      )
    );

    expect(await view.findByText("all:active:busy")).toBeTruthy();

    await act(async () => {
      await Effect.runPromise(Deferred.succeed(refreshGate, { timezone: "active" }));
    });

    expect(await view.findByText("active:active:idle")).toBeTruthy();
  });

  test("useNodeState does not re-dispatch args reconciliation on a no-op re-render", async () => {
    type FilteredSpec = ProfileSpec<{ readonly filter: string }>;

    class NoOpArgsProfileNode extends NodeBase<FilteredSpec> {
      static readonly spec = resourceSpec<FilteredSpec>({
        tag: "react-dom/resources/no-op-args-profile",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<FilteredSpec>({
          acquire: Driver.Acquire((ctx) => Effect.sync(() => ({ timezone: ctx.args.filter }))),
          refresh: Driver.Refresh((ctx) => ctx.setResult({ timezone: ctx.args.filter })),
        }),
      });

      get label(): string {
        return this.result.timezone;
      }
    }

    const ProfileView = ({ filter }: { readonly filter: string }) => {
      const profile = useNodeState(NoOpArgsProfileNode, { filter });

      return createElement("output", undefined, profile.node.label);
    };

    const runtime = createRuntime();
    await runtime.submit({ _tag: "RuntimeStart" });

    const renderTree = (filter: string) =>
      createElement(
        FrondProvider,
        { runtime },
        createElement(
          Suspense,
          { fallback: createElement("span", undefined, "loading") },
          createElement(ProfileView, { filter })
        )
      );

    const startedCount = async () =>
      (await runtime.query({ _tag: "RuntimeEvents" })).events.filter(
        (record) => record.event._tag === "GraphNodeArgsUpdateStarted"
      ).length;

    const view = render(renderTree("all"));
    expect(await view.findByText("all")).toBeTruthy();

    // A fresh object literal of equal args must not trigger any reconciliation.
    const afterMount = await startedCount();
    await act(async () => {
      view.rerender(renderTree("all"));
      await Promise.resolve();
    });
    expect(await startedCount()).toBe(afterMount);

    // A genuine same-identity args change must reconcile exactly once.
    await act(async () => {
      view.rerender(renderTree("active"));
      await Promise.resolve();
    });
    await waitFor(async () => {
      expect(await startedCount()).toBe(afterMount + 1);
    });
    expect(await view.findByText("active")).toBeTruthy();
  });

  test("useNodes does not re-dispatch args reconciliation on a no-op re-render", async () => {
    type FilteredSpec = ProfileSpec<{ readonly filter: string }>;

    class NoOpArgsNodesProfileNode extends NodeBase<FilteredSpec> {
      static readonly spec = resourceSpec<FilteredSpec>({
        tag: "react-dom/resources/no-op-args-nodes-profile",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<FilteredSpec>({
          acquire: Driver.Acquire((ctx) => Effect.sync(() => ({ timezone: ctx.args.filter }))),
          refresh: Driver.Refresh((ctx) => ctx.setResult({ timezone: ctx.args.filter })),
        }),
      });

      get label(): string {
        return this.result.timezone;
      }
    }

    const ProfilesView = ({ filter }: { readonly filter: string }) => {
      const nodes = useNodes({ filtered: [NoOpArgsNodesProfileNode, { filter }] });

      return createElement("output", undefined, nodes.filtered.label);
    };

    const runtime = createRuntime();
    await runtime.submit({ _tag: "RuntimeStart" });

    const renderTree = (filter: string) =>
      createElement(
        FrondProvider,
        { runtime },
        createElement(
          Suspense,
          { fallback: createElement("span", undefined, "loading") },
          createElement(ProfilesView, { filter })
        )
      );

    const startedCount = async () =>
      (await runtime.query({ _tag: "RuntimeEvents" })).events.filter(
        (record) => record.event._tag === "GraphNodeArgsUpdateStarted"
      ).length;

    const view = render(renderTree("all"));
    expect(await view.findByText("all")).toBeTruthy();

    const afterMount = await startedCount();
    await act(async () => {
      view.rerender(renderTree("all"));
      await Promise.resolve();
    });
    expect(await startedCount()).toBe(afterMount);

    await act(async () => {
      view.rerender(renderTree("active"));
      await Promise.resolve();
    });
    await waitFor(async () => {
      expect(await startedCount()).toBe(afterMount + 1);
    });
    expect(await view.findByText("active")).toBeTruthy();
  });

  test("readiness error reaches ErrorBoundary and fallback controls own retry", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});

    try {
      let attempts = 0;

      class RetryProfileNode extends NodeBase<ProfileSpec> {
        static readonly spec = resourceSpec<ProfileSpec>({
          tag: "react-dom/resources/retry-profile",
          key: () => Key.singleton(),
          dependencies: dependencies(() => ({})),
          driver: Driver.Effect<ProfileSpec>({
            acquire: Driver.Acquire(() => {
              attempts += 1;

              return attempts === 1
                ? Effect.fail(new Error("first acquire failed"))
                : Effect.succeed({ timezone: "UTC" });
            }),
          }),
        });

        get timezone(): string {
          return this.result.timezone;
        }
      }

      const ProfileView = () => {
        const profile = useNode(RetryProfileNode, {});

        return createElement("output", undefined, profile.timezone);
      };

      const RetryFallback = ({ reset }: { readonly reset: () => void }) => {
        const controls = useNodeControls(RetryProfileNode, {});

        return createElement(
          "button",
          {
            type: "button",
            onClick: () => {
              void controls.ensureReady().then(reset);
            },
          },
          "retry"
        );
      };

      const runtime = createRuntime();
      await runtime.submit({ _tag: "RuntimeStart" });

      const view = render(
        createElement(
          FrondProvider,
          { runtime },
          createElement(
            TestErrorBoundary,
            { fallback: (reset) => createElement(RetryFallback, { reset }) },
            createElement(
              Suspense,
              { fallback: createElement("span", undefined, "loading") },
              createElement(ProfileView)
            )
          )
        )
      );

      expect(await view.findByText("retry")).toBeTruthy();
      expect(attempts).toBe(1);

      fireEvent.click(view.getByText("retry"));

      expect(await view.findByText("UTC")).toBeTruthy();
      expect(attempts).toBe(2);
    } finally {
      consoleError.mockRestore();
    }
  });

  test("readiness error exposes explicit recovery metadata without render retry", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});

    try {
      let attempts = 0;

      class RecoverableProfileNode extends NodeBase<ProfileSpec> {
        static readonly spec = resourceSpec<ProfileSpec>({
          tag: "react-dom/resources/recoverable-profile",
          key: () => Key.singleton(),
          dependencies: dependencies(() => ({})),
          driver: Driver.Effect<ProfileSpec>({
            acquire: Driver.Acquire(() => {
              attempts += 1;

              return attempts === 1
                ? Effect.fail(new Error("first acquire failed"))
                : Effect.succeed({ timezone: "UTC" });
            }),
          }),
        });

        get timezone(): string {
          return this.result.timezone;
        }
      }

      const ProfileView = () => {
        const profile = useNode(RecoverableProfileNode, {});

        return createElement("output", undefined, profile.timezone);
      };

      const runtime = createRuntime();
      await runtime.submit({ _tag: "RuntimeStart" });

      const view = render(
        createElement(
          FrondProvider,
          { runtime },
          createElement(
            TestErrorBoundary,
            {
              fallback: (reset, error) => {
                const recovery = getErrorRecovery(error);

                if (recovery === undefined) {
                  return createElement("output", undefined, "missing-recovery");
                }

                return createElement(
                  "div",
                  undefined,
                  createElement("output", undefined, `${recovery.reason}:${recovery.retryable}`),
                  createElement(
                    "button",
                    {
                      type: "button",
                      onClick: reset,
                    },
                    "render-reset"
                  ),
                  createElement(
                    "button",
                    {
                      type: "button",
                      onClick: () => {
                        void recovery.retry().then(reset);
                      },
                    },
                    "runtime-retry"
                  )
                );
              },
            },
            createElement(
              Suspense,
              { fallback: createElement("span", undefined, "loading") },
              createElement(ProfileView)
            )
          )
        )
      );

      expect(await view.findByText("readiness:true")).toBeTruthy();
      expect(attempts).toBe(1);

      fireEvent.click(view.getByText("render-reset"));

      expect(await view.findByText("readiness:true")).toBeTruthy();
      expect(attempts).toBe(1);

      fireEvent.click(view.getByText("runtime-retry"));

      expect(await view.findByText("UTC")).toBeTruthy();
      expect(attempts).toBe(2);
    } finally {
      consoleError.mockRestore();
    }
  });

  test("captured recovery retry succeeds after the errored subtree unmounts", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});

    try {
      let attempts = 0;

      class UnmountedRetryNode extends NodeBase<ProfileSpec> {
        static readonly spec = resourceSpec<ProfileSpec>({
          tag: "react-dom/resources/unmounted-retry",
          key: () => Key.singleton(),
          dependencies: dependencies(() => ({})),
          driver: Driver.Effect<ProfileSpec>({
            acquire: Driver.Acquire(() => {
              attempts += 1;

              return attempts === 2
                ? Effect.fail(new Error("re-acquire failed"))
                : Effect.succeed({ timezone: `ready-${attempts}` });
            }),
          }),
        });

        get timezone(): string {
          return this.result.timezone;
        }
      }

      const ProfileView = () => {
        const profile = useNode(UnmountedRetryNode, {});

        return createElement("output", undefined, profile.timezone);
      };

      let evictPromise: Promise<unknown> | undefined;
      const ControlsView = () => {
        const controls = useNodeControls(UnmountedRetryNode, {});

        return createElement(
          "button",
          {
            type: "button",
            onClick: () => {
              evictPromise = controls.evict();
            },
          },
          "evict"
        );
      };

      let capturedRecovery: ReturnType<typeof getErrorRecovery>;
      let capturedReset: (() => void) | undefined;

      const runtime = createRuntime();
      await runtime.submit({ _tag: "RuntimeStart" });

      const view = render(
        createElement(
          FrondProvider,
          { runtime },
          createElement(
            TestErrorBoundary,
            {
              fallback: (reset, error) => {
                capturedRecovery = getErrorRecovery(error);
                capturedReset = reset;

                return createElement("span", undefined, "boundary-error");
              },
            },
            createElement(
              Suspense,
              { fallback: createElement("span", undefined, "loading") },
              createElement(ProfileView)
            )
          ),
          createElement(ControlsView)
        )
      );

      expect(await view.findByText("ready-1")).toBeTruthy();

      await act(async () => {
        fireEvent.click(view.getByText("evict"));
        await evictPromise;
      });

      expect(await view.findByText("boundary-error")).toBeTruthy();
      expect(capturedRecovery).toBeDefined();
      expect(attempts).toBe(2);

      // The boundary swap unmounted the errored subtree, so effect cleanup
      // disposed the store the retry binding was created on. Retry must still
      // reach the runtime instead of throwing an adapter invariant.
      let retryPromise: Promise<unknown> | undefined;
      await act(async () => {
        retryPromise = capturedRecovery?.retry();
        await retryPromise;
      });

      expect(retryPromise).toBeInstanceOf(Promise);
      expect(attempts).toBe(3);

      await act(async () => {
        capturedReset?.();
      });

      expect(await view.findByText("ready-3")).toBeTruthy();
    } finally {
      consoleError.mockRestore();
    }
  });

  test("readiness ErrorBoundary receives a decorated Frond runtime read error", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});

    try {
      class DecoratedErrorNode extends NodeBase<ProfileSpec> {
        static readonly spec = resourceSpec<ProfileSpec>({
          tag: "react-dom/resources/decorated-error",
          key: () => Key.singleton(),
          dependencies: dependencies(() => ({})),
          driver: Driver.Effect<ProfileSpec>({
            acquire: Driver.Acquire(() => Effect.fail(new Error("backend 500"))),
          }),
        });
      }

      const ProfileView = () => {
        useNode(DecoratedErrorNode, {});

        return createElement("output", undefined, "ready");
      };

      const runtime = createRuntime();
      await runtime.submit({ _tag: "RuntimeStart" });

      const view = render(
        createElement(
          FrondProvider,
          { runtime },
          createElement(
            TestErrorBoundary,
            {
              fallback: (_reset, error) => {
                if (!(error instanceof Runtime.FrondRuntimeReadError)) {
                  return createElement("output", undefined, "unexpected-error");
                }

                const cause = error.cause;

                if (!(cause instanceof Graph.AcquireFailed)) {
                  return createElement("output", undefined, "unexpected-cause");
                }

                if (getErrorRecovery(error) === undefined) {
                  return createElement("output", undefined, "missing-recovery");
                }

                return createElement(
                  "output",
                  {
                    "data-keys": JSON.stringify(Object.keys(error)),
                  },
                  `${error.name}:${error.kind}:${String(error.retryable)}:${cause._tag}`
                );
              },
            },
            createElement(
              Suspense,
              { fallback: createElement("span", undefined, "loading") },
              createElement(ProfileView)
            )
          )
        )
      );

      expect(
        await view.findByText("FrondRuntimeReadError:readiness:true:AcquireFailed")
      ).toBeTruthy();
      expect(
        JSON.parse(
          view
            .getByText("FrondRuntimeReadError:readiness:true:AcquireFailed")
            .getAttribute("data-keys") ?? "[]"
        ).includes("retry")
      ).toBe(false);
    } finally {
      consoleError.mockRestore();
    }
  });

  test("controls can ensure, refresh, and evict without reading the node", async () => {
    let acquired = 0;
    let refreshed = 0;

    class ControlsProfileNode extends NodeBase<ProfileSpec> {
      static readonly spec = resourceSpec<ProfileSpec>({
        tag: "react-dom/resources/controls-profile",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ProfileSpec>({
          acquire: Driver.Acquire(() =>
            Effect.sync(() => {
              acquired += 1;
              return { timezone: `acquire-${acquired}` };
            })
          ),
          refresh: Driver.Refresh((ctx) =>
            Effect.sync(() => {
              refreshed += 1;
              return ctx.setResult({ timezone: `refresh-${refreshed}` });
            }).pipe(Effect.flatten)
          ),
        }),
      });
    }

    const ControlsView = () => {
      const controls = useNodeControls(ControlsProfileNode, {});
      const [label, setLabel] = useState("idle");

      return createElement(
        "div",
        undefined,
        createElement("output", undefined, label),
        createElement(
          "button",
          {
            type: "button",
            onClick: () => {
              void controls.ensureReady().then(() => setLabel("ready"));
            },
          },
          "ensure"
        ),
        createElement(
          "button",
          {
            type: "button",
            onClick: () => {
              void controls.refresh().then((result) => setLabel(result._tag));
            },
          },
          "refresh"
        ),
        createElement(
          "button",
          {
            type: "button",
            onClick: () => {
              void controls.evict().then((result) => setLabel(`evicted:${result.nodeIds.length}`));
            },
          },
          "evict"
        )
      );
    };

    const runtime = createRuntime();
    await runtime.submit({ _tag: "RuntimeStart" });

    const view = render(createElement(FrondProvider, { runtime }, createElement(ControlsView)));

    expect(view.getByText("idle")).toBeTruthy();
    expect(acquired).toBe(0);

    fireEvent.click(view.getByText("ensure"));

    expect(await view.findByText("ready")).toBeTruthy();
    expect(acquired).toBe(1);

    fireEvent.click(view.getByText("refresh"));

    expect(await view.findByText("Success")).toBeTruthy();
    expect(refreshed).toBe(1);

    fireEvent.click(view.getByText("evict"));

    expect(await view.findByText("evicted:1")).toBeTruthy();
  });

  test("plural controls return a keyed map of singular node controls", async () => {
    const acquired = new Map<string, number>();
    const refreshed = new Map<string, number>();

    const increment = (store: Map<string, number>, key: string): number => {
      const next = (store.get(key) ?? 0) + 1;
      store.set(key, next);
      return next;
    };

    type ControlsProfileSpec = ProfileSpec<
      { readonly id: string },
      Key.Structure<{ readonly id: string }>
    >;

    class ControlsProfileNode extends NodeBase<ControlsProfileSpec> {
      static readonly spec = resourceSpec<ControlsProfileSpec>({
        tag: "react-dom/resources/plural-controls-profile",
        key: (args) => Key.structure({ id: args.id }),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ControlsProfileSpec>({
          acquire: Driver.Acquire((ctx) =>
            Effect.sync(() => ({
              timezone: `${ctx.args.id}:acquire-${increment(acquired, ctx.args.id)}`,
            }))
          ),
          refresh: Driver.Refresh((ctx) =>
            Effect.sync(() =>
              ctx.setResult({
                timezone: `${ctx.args.id}:refresh-${increment(refreshed, ctx.args.id)}`,
              })
            ).pipe(Effect.flatten)
          ),
        }),
      });
    }

    const ControlsView = () => {
      const controls = useNodesControls({
        left: [ControlsProfileNode, { id: "left" }],
        right: [ControlsProfileNode, { id: "right" }],
      });
      const [label, setLabel] = useState("idle");

      return createElement(
        "div",
        undefined,
        createElement("output", undefined, label),
        createElement(
          "button",
          {
            type: "button",
            onClick: () => {
              void Promise.all([controls.left.ensureReady(), controls.right.ensureReady()]).then(
                () => setLabel("ready")
              );
            },
          },
          "ensure-both"
        ),
        createElement(
          "button",
          {
            type: "button",
            onClick: () => {
              void Promise.all([controls.left.refresh(), controls.right.refresh()]).then(
                ([left, right]) => setLabel(`${left._tag}:${right._tag}`)
              );
            },
          },
          "refresh-both"
        )
      );
    };

    const runtime = createRuntime();
    await runtime.submit({ _tag: "RuntimeStart" });

    const view = render(createElement(FrondProvider, { runtime }, createElement(ControlsView)));

    expect(view.getByText("idle")).toBeTruthy();
    expect(acquired.size).toBe(0);

    fireEvent.click(view.getByText("ensure-both"));

    expect(await view.findByText("ready")).toBeTruthy();
    expect(acquired.get("left")).toBe(1);
    expect(acquired.get("right")).toBe(1);

    fireEvent.click(view.getByText("refresh-both"));

    expect(await view.findByText("Success:Success")).toBeTruthy();
    expect(refreshed.get("left")).toBe(1);
    expect(refreshed.get("right")).toBe(1);
  });

  test("active useNode recovers from self eviction without pending-attempt invariant", async () => {
    let acquired = 0;

    class EvictedVisibleNode extends NodeBase<ProfileSpec> {
      static readonly spec = resourceSpec<ProfileSpec>({
        tag: "react-dom/resources/evicted-visible",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ProfileSpec>({
          acquire: Driver.Acquire(() =>
            Effect.sync(() => {
              acquired += 1;
              return { timezone: `ready-${acquired}` };
            })
          ),
        }),
      });

      get timezone(): string {
        return this.result.timezone;
      }
    }

    const VisibleNodeView = () => {
      const profile = useNode(EvictedVisibleNode, {});
      const controls = useNodeControls(EvictedVisibleNode, {});

      return createElement(
        "div",
        undefined,
        createElement("output", undefined, profile.timezone),
        createElement(
          "button",
          {
            type: "button",
            onClick: () => {
              void controls.evict();
            },
          },
          "evict"
        )
      );
    };

    const runtime = createRuntime();
    await runtime.submit({ _tag: "RuntimeStart" });
    const view = render(
      createElement(
        FrondProvider,
        { runtime },
        createElement(
          Suspense,
          { fallback: createElement("span", undefined, "loading") },
          createElement(VisibleNodeView)
        )
      )
    );

    expect(await view.findByText("ready-1")).toBeTruthy();

    await act(async () => {
      fireEvent.click(view.getByText("evict"));
      await Promise.resolve();
    });

    expect(await view.findByText("ready-2")).toBeTruthy();
  });

  test("active useNode recovers when separate controls evict under StrictMode", async () => {
    let acquired = 0;

    class StrictEvictedVisibleNode extends NodeBase<ProfileSpec> {
      static readonly spec = resourceSpec<ProfileSpec>({
        tag: "react-dom/resources/strict-evicted-visible",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ProfileSpec>({
          acquire: Driver.Acquire(() =>
            Effect.sync(() => {
              acquired += 1;
              return { timezone: `ready-${acquired}` };
            })
          ),
        }),
      });

      get timezone(): string {
        return this.result.timezone;
      }
    }

    const VisibleNodeView = () => {
      const profile = useNode(StrictEvictedVisibleNode, {});

      return createElement("output", undefined, profile.timezone);
    };

    let evictPromise: Promise<unknown> | undefined;
    const ControlsView = () => {
      const controls = useNodeControls(StrictEvictedVisibleNode, {});

      return createElement(
        "button",
        {
          type: "button",
          onClick: () => {
            evictPromise = controls.evict();
          },
        },
        "evict"
      );
    };

    const runtime = createRuntime();
    await runtime.submit({ _tag: "RuntimeStart" });
    const view = render(
      createElement(
        StrictMode,
        undefined,
        createElement(
          FrondProvider,
          { runtime },
          createElement(
            Suspense,
            { fallback: createElement("span", undefined, "loading") },
            createElement(VisibleNodeView)
          ),
          createElement(ControlsView)
        )
      )
    );

    expect(await view.findByText("ready-1")).toBeTruthy();

    await act(async () => {
      fireEvent.click(view.getByText("evict"));
      await evictPromise;
    });

    const evictResult = await evictPromise;
    expect(evictResult).toMatchObject({ nodeIds: [expect.any(String)] });

    expect(await view.findByText("ready-2")).toBeTruthy();
  });

  test("controls reconcile same-identity args before imperative refresh", async () => {
    type FilteredControlsSpec = ProfileSpec<{ readonly filter: string }>;

    class FilteredControlsNode extends NodeBase<FilteredControlsSpec> {
      static readonly spec = resourceSpec<FilteredControlsSpec>({
        tag: "react-dom/resources/filtered-controls",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<FilteredControlsSpec>({
          acquire: Driver.Acquire((ctx) =>
            Effect.succeed({
              timezone: ctx.args.filter,
            })
          ),
          refresh: Driver.Refresh((ctx) =>
            ctx.setResult({
              timezone: ctx.args.filter,
            })
          ),
        }),
      });
    }

    const ControlsView = () => {
      const [filter, setFilter] = useState("all");
      const [label, setLabel] = useState("idle");
      const controls = useNodeControls(FilteredControlsNode, { filter });

      return createElement(
        "div",
        undefined,
        createElement("output", undefined, label),
        createElement(
          "button",
          {
            type: "button",
            onClick: () => {
              void controls.ensureReady().then(() => setLabel("ready"));
            },
          },
          "ensure"
        ),
        createElement(
          "button",
          {
            type: "button",
            onClick: () => setFilter("active"),
          },
          "filter"
        ),
        createElement(
          "button",
          {
            type: "button",
            onClick: () => {
              void controls.refresh().then(() => setLabel("refreshed"));
            },
          },
          "refresh"
        )
      );
    };

    const runtime = createRuntime();
    await runtime.submit({ _tag: "RuntimeStart" });
    const view = render(createElement(FrondProvider, { runtime }, createElement(ControlsView)));

    fireEvent.click(view.getByText("ensure"));
    expect(await view.findByText("ready")).toBeTruthy();

    fireEvent.click(view.getByText("filter"));
    fireEvent.click(view.getByText("refresh"));
    expect(await view.findByText("refreshed")).toBeTruthy();

    const snapshot = await runtime.getSnapshot();
    const node = snapshot.graph.nodes.find(
      (entry) => entry.tag === "react-dom/resources/filtered-controls"
    );

    expect(node?.result).toEqual({ timezone: "active" });
  });

  test("controls reset args reconciliation memo when graph identity changes", async () => {
    type KeyedControlsSpec = ProfileSpec<
      { readonly id: string; readonly filter: string },
      Key.Structure<{ readonly id: string }>
    >;

    class KeyedControlsNode extends NodeBase<KeyedControlsSpec> {
      static readonly spec = resourceSpec<KeyedControlsSpec>({
        tag: "react-dom/resources/keyed-controls",
        key: (args) => Key.structure({ id: args.id }),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<KeyedControlsSpec>({
          acquire: Driver.Acquire((ctx) =>
            Effect.succeed({
              timezone: ctx.args.filter,
            })
          ),
          refresh: Driver.Refresh((ctx) =>
            ctx.setResult({
              timezone: ctx.args.filter,
            })
          ),
        }),
      });
    }

    const ControlsView = () => {
      const [id, setId] = useState("one");
      const [filter, setFilter] = useState("all");
      useNodeControls(KeyedControlsNode, { id, filter });

      return createElement(
        "div",
        undefined,
        createElement(
          "button",
          {
            type: "button",
            onClick: () => {
              setId("two");
              setFilter("active");
            },
          },
          "switch"
        ),
        createElement(
          "button",
          {
            type: "button",
            onClick: () => setFilter("final"),
          },
          "filter"
        )
      );
    };

    const runtime = createRuntime();
    await runtime.submit({ _tag: "RuntimeStart" });
    const view = render(createElement(FrondProvider, { runtime }, createElement(ControlsView)));

    fireEvent.click(view.getByText("switch"));
    await act(async () => {
      await Promise.resolve();
    });

    let events = (await runtime.query({ _tag: "RuntimeEvents" })).events;
    expect(
      events.filter((record) => record.event._tag === "GraphNodeArgsUpdateStarted")
    ).toHaveLength(0);

    fireEvent.click(view.getByText("filter"));

    await waitFor(async () => {
      events = (await runtime.query({ _tag: "RuntimeEvents" })).events;
      expect(
        events.filter((record) => record.event._tag === "GraphNodeArgsUpdateFailed")
      ).toHaveLength(1);
    });
    expect(
      events.filter((record) => record.event._tag === "GraphNodeArgsUpdateStarted")
    ).toHaveLength(0);
  });

  test("controls keep the newer args fingerprint when an older overlapping update fails", async () => {
    const failStarted = await Effect.runPromise(Deferred.make<void>());
    const failGate = await Effect.runPromise(Deferred.make<void>());

    type OvertakeControlsSpec = ProfileSpec<{ readonly filter: string }>;

    class OvertakeControlsNode extends NodeBase<OvertakeControlsSpec> {
      static readonly spec = resourceSpec<OvertakeControlsSpec>({
        tag: "react-dom/resources/overtake-controls",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<OvertakeControlsSpec>({
          acquire: Driver.Acquire((ctx) => Effect.succeed({ timezone: ctx.args.filter })),
          refresh: Driver.Refresh((ctx) =>
            ctx.args.filter === "fail"
              ? Effect.gen(function* () {
                  yield* Deferred.succeed(failStarted, undefined);
                  yield* Deferred.await(failGate);
                  return yield* Effect.fail({ _tag: "RefreshRejected" });
                })
              : ctx.setResult({ timezone: ctx.args.filter })
          ),
        }),
      });
    }

    const ControlsView = () => {
      const [filter, setFilter] = useState("init");
      const [label, setLabel] = useState("idle");
      const controls = useNodeControls(OvertakeControlsNode, { filter });

      return createElement(
        "div",
        undefined,
        createElement("output", undefined, label),
        createElement(
          "button",
          {
            type: "button",
            onClick: () => {
              void controls.ensureReady().then(() => setLabel("ready"));
            },
          },
          "ensure"
        ),
        createElement(
          "button",
          {
            type: "button",
            onClick: () => setFilter("fail"),
          },
          "set-fail"
        ),
        createElement(
          "button",
          {
            type: "button",
            onClick: () => setFilter("ok"),
          },
          "set-ok"
        ),
        createElement(
          "button",
          {
            type: "button",
            onClick: () => setLabel("poked"),
          },
          "poke"
        ),
        createElement(
          "button",
          {
            type: "button",
            onClick: () => setFilter("init"),
          },
          "set-init"
        )
      );
    };

    const runtime = createRuntime();
    await runtime.submit({ _tag: "RuntimeStart" });
    const view = render(createElement(FrondProvider, { runtime }, createElement(ControlsView)));

    fireEvent.click(view.getByText("ensure"));
    expect(await view.findByText("ready")).toBeTruthy();

    // First update: "fail" starts its refresh and blocks on the gate.
    fireEvent.click(view.getByText("set-fail"));
    await Effect.runPromise(Deferred.await(failStarted));

    // Second update overtakes while the first is still in flight.
    fireEvent.click(view.getByText("set-ok"));

    // Release the gate: the older "fail" update settles as Failure after the
    // newer "ok" update has already taken the fingerprint slot.
    await act(async () => {
      await Effect.runPromise(Deferred.succeed(failGate, undefined));
    });

    await waitFor(async () => {
      const events = (await runtime.query({ _tag: "RuntimeEvents" })).events;
      expect(
        events.filter((record) => record.event._tag === "GraphNodeArgsUpdateFailed")
      ).toHaveLength(1);
    });
    await waitFor(async () => {
      const snapshot = await runtime.getSnapshot();
      const node = snapshot.graph.nodes.find(
        (entry) => entry.tag === "react-dom/resources/overtake-controls"
      );

      expect(node?.result).toEqual({ timezone: "ok" });
    });
    await act(async () => {
      await Promise.resolve();
    });

    // A re-render with the current "ok" args must not re-dispatch: the failed
    // older update must not have rolled the fingerprint back to "init".
    fireEvent.click(view.getByText("poke"));
    expect(await view.findByText("poked")).toBeTruthy();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const events = (await runtime.query({ _tag: "RuntimeEvents" })).events;
    expect(
      events.filter((record) => record.event._tag === "GraphNodeArgsUpdateStarted")
    ).toHaveLength(2);

    // A render with the original "init" args is a real change and dispatches.
    fireEvent.click(view.getByText("set-init"));
    await waitFor(async () => {
      const snapshot = await runtime.getSnapshot();
      const node = snapshot.graph.nodes.find(
        (entry) => entry.tag === "react-dom/resources/overtake-controls"
      );

      expect(node?.result).toEqual({ timezone: "init" });
    });

    const eventsAfter = (await runtime.query({ _tag: "RuntimeEvents" })).events;
    expect(
      eventsAfter.filter((record) => record.event._tag === "GraphNodeArgsUpdateStarted")
    ).toHaveLength(3);
  });

  test("useNodes starts sibling nodes in parallel before rendering the ready map", async () => {
    const startedA = await Effect.runPromise(Deferred.make<void>());
    const startedB = await Effect.runPromise(Deferred.make<void>());
    const gateA = await Effect.runPromise(Deferred.make<Profile>());
    const gateB = await Effect.runPromise(Deferred.make<Profile>());

    class ParallelNodeA extends NodeBase<ProfileSpec> {
      static readonly spec = resourceSpec<ProfileSpec>({
        tag: "react-dom/resources/parallel-a",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ProfileSpec>({
          acquire: Driver.Acquire(() =>
            Effect.gen(function* () {
              yield* Deferred.succeed(startedA, undefined);
              return yield* Deferred.await(gateA);
            })
          ),
        }),
      });

      get timezone(): string {
        return this.result.timezone;
      }
    }

    class ParallelNodeB extends NodeBase<ProfileSpec> {
      static readonly spec = resourceSpec<ProfileSpec>({
        tag: "react-dom/resources/parallel-b",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ProfileSpec>({
          acquire: Driver.Acquire(() =>
            Effect.gen(function* () {
              yield* Deferred.succeed(startedB, undefined);
              return yield* Deferred.await(gateB);
            })
          ),
        }),
      });

      get timezone(): string {
        return this.result.timezone;
      }
    }

    const ProfilesView = () => {
      const nodes = useNodes({
        b: [ParallelNodeB, {}],
        a: [ParallelNodeA, {}],
      });

      return createElement("output", undefined, `${nodes.a.timezone}/${nodes.b.timezone}`);
    };

    const runtime = createRuntime();
    await runtime.submit({ _tag: "RuntimeStart" });

    const view = render(
      createElement(
        FrondProvider,
        { runtime },
        createElement(
          Suspense,
          { fallback: createElement("span", undefined, "loading") },
          createElement(ProfilesView)
        )
      )
    );

    expect(view.getByText("loading")).toBeTruthy();

    await Effect.runPromise(Effect.all([Deferred.await(startedA), Deferred.await(startedB)]));

    await act(async () => {
      await Effect.runPromise(
        Effect.all([
          Deferred.succeed(gateA, { timezone: "A" }),
          Deferred.succeed(gateB, { timezone: "B" }),
        ])
      );
    });

    expect(await view.findByText("A/B")).toBeTruthy();
  });

  test("useNodes readiness failure reaches ErrorBoundary without retrying siblings", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});

    try {
      let goodAttempts = 0;
      let failingAttempts = 0;

      class GoodNode extends NodeBase<ProfileSpec> {
        static readonly spec = resourceSpec<ProfileSpec>({
          tag: "react-dom/resources/use-nodes-good",
          key: () => Key.singleton(),
          dependencies: dependencies(() => ({})),
          driver: Driver.Effect<ProfileSpec>({
            acquire: Driver.Acquire(() =>
              Effect.sync(() => {
                goodAttempts += 1;
                return { timezone: "good" };
              })
            ),
          }),
        });
      }

      class FailingNode extends NodeBase<ProfileSpec> {
        static readonly spec = resourceSpec<ProfileSpec>({
          tag: "react-dom/resources/use-nodes-failing",
          key: () => Key.singleton(),
          dependencies: dependencies(() => ({})),
          driver: Driver.Effect<ProfileSpec>({
            acquire: Driver.Acquire(() =>
              Effect.sync(() => {
                failingAttempts += 1;
                return Effect.fail(new Error("child failed"));
              }).pipe(Effect.flatten)
            ),
          }),
        });
      }

      const ProfilesView = () => {
        const nodes = useNodes({
          good: [GoodNode, {}],
          failing: [FailingNode, {}],
        });

        return createElement("output", undefined, Object.keys(nodes).sort().join(","));
      };

      const runtime = createRuntime();
      await runtime.submit({ _tag: "RuntimeStart" });

      const view = render(
        createElement(
          FrondProvider,
          { runtime },
          createElement(
            TestErrorBoundary,
            { fallback: () => createElement("span", undefined, "child-error") },
            createElement(
              Suspense,
              { fallback: createElement("span", undefined, "loading") },
              createElement(ProfilesView)
            )
          )
        )
      );

      expect(await view.findByText("child-error")).toBeTruthy();
      expect(goodAttempts).toBe(1);
      expect(failingAttempts).toBe(1);
    } finally {
      consoleError.mockRestore();
    }
  });

  test("useNodes same-identity args update keeps ready children visible while refresh is busy", async () => {
    const refreshGate = await Effect.runPromise(Deferred.make<Profile>());

    type FilteredNodesProfileSpec = ProfileSpec<{ readonly filter: string }>;

    class FilteredNodesProfileNode extends NodeBase<FilteredNodesProfileSpec> {
      static readonly spec = resourceSpec<FilteredNodesProfileSpec>({
        tag: "react-dom/resources/use-nodes-filtered-profile",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<FilteredNodesProfileSpec>({
          acquire: Driver.Acquire((ctx) =>
            Effect.succeed({
              timezone: ctx.args.filter,
            })
          ),
          refresh: Driver.Refresh((ctx) =>
            Effect.gen(function* () {
              yield* Deferred.await(refreshGate);
              yield* ctx.setResult({
                timezone: ctx.args.filter,
              });
            })
          ),
        }),
      });

      get label(): string {
        return `${this.result.timezone}:${this.args.filter}`;
      }
    }

    class StaticNodesProfileNode extends NodeBase<ProfileSpec> {
      static readonly spec = resourceSpec<ProfileSpec>({
        tag: "react-dom/resources/use-nodes-static-profile",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ProfileSpec>({
          acquire: Driver.Acquire(() => Effect.succeed({ timezone: "static" })),
        }),
      });

      get label(): string {
        return `${this.result.timezone}:static`;
      }
    }

    const ProfilesView = ({ filter }: { readonly filter: string }) => {
      const nodes = useNodes({
        filtered: [FilteredNodesProfileNode, { filter }],
        static: [StaticNodesProfileNode, {}],
      });

      return createElement("output", undefined, `${nodes.filtered.label}/${nodes.static.label}`);
    };

    const runtime = createRuntime();
    await runtime.submit({ _tag: "RuntimeStart" });

    const view = render(
      createElement(
        FrondProvider,
        { runtime },
        createElement(
          Suspense,
          { fallback: createElement("span", undefined, "loading") },
          createElement(ProfilesView, { filter: "all" })
        )
      )
    );

    expect(await view.findByText("all:all/static:static")).toBeTruthy();

    view.rerender(
      createElement(
        FrondProvider,
        { runtime },
        createElement(
          Suspense,
          { fallback: createElement("span", undefined, "loading") },
          createElement(ProfilesView, { filter: "active" })
        )
      )
    );

    expect(await view.findByText("all:active/static:static")).toBeTruthy();

    await act(async () => {
      await Effect.runPromise(Deferred.succeed(refreshGate, { timezone: "active" }));
    });

    expect(await view.findByText("active:active/static:static")).toBeTruthy();
  });

  test("active useNodes recovers when separate controls evict under StrictMode", async () => {
    let acquired = 0;

    class StrictNodesEvictedNode extends NodeBase<ProfileSpec> {
      static readonly spec = resourceSpec<ProfileSpec>({
        tag: "react-dom/resources/strict-nodes-evicted",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ProfileSpec>({
          acquire: Driver.Acquire(() =>
            Effect.sync(() => {
              acquired += 1;
              return { timezone: `ready-${acquired}` };
            })
          ),
        }),
      });

      get timezone(): string {
        return this.result.timezone;
      }
    }

    const NodesView = () => {
      const nodes = useNodes({ profile: [StrictNodesEvictedNode, {}] });

      return createElement("output", undefined, nodes.profile.timezone);
    };

    let evictPromise: Promise<unknown> | undefined;
    const ControlsView = () => {
      const controls = useNodeControls(StrictNodesEvictedNode, {});

      return createElement(
        "button",
        {
          type: "button",
          onClick: () => {
            evictPromise = controls.evict();
          },
        },
        "evict"
      );
    };

    const runtime = createRuntime();
    await runtime.submit({ _tag: "RuntimeStart" });
    const view = render(
      createElement(
        StrictMode,
        undefined,
        createElement(
          FrondProvider,
          { runtime },
          createElement(
            Suspense,
            { fallback: createElement("span", undefined, "loading") },
            createElement(NodesView)
          ),
          createElement(ControlsView)
        )
      )
    );

    expect(await view.findByText("ready-1")).toBeTruthy();

    // StrictMode replayed effect cleanup and setup on the same fiber without
    // re-running useMemo: the replayed subscription must land on the disposed
    // composite store and revive it, or refresh/eviction updates are lost.
    await act(async () => {
      fireEvent.click(view.getByText("evict"));
      await evictPromise;
    });

    expect(await view.findByText("ready-2")).toBeTruthy();
  });

  test("empty Preload renders children immediately", async () => {
    const runtime = createRuntime();
    await runtime.submit({ _tag: "RuntimeStart" });

    const view = render(
      createElement(
        FrondProvider,
        { runtime },
        createElement(Preload, { nodes: [] }, createElement("output", undefined, "ready"))
      )
    );

    expect(view.getByText("ready")).toBeTruthy();
  });

  test("Preload runs one layer in parallel before rendering children", async () => {
    const startedA = await Effect.runPromise(Deferred.make<void>());
    const startedB = await Effect.runPromise(Deferred.make<void>());
    const gateA = await Effect.runPromise(Deferred.make<Profile>());
    const gateB = await Effect.runPromise(Deferred.make<Profile>());

    class PreloadLayerNodeA extends NodeBase<ProfileSpec> {
      static readonly spec = resourceSpec<ProfileSpec>({
        tag: "react-dom/resources/preload-layer-a",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ProfileSpec>({
          acquire: Driver.Acquire(() =>
            Effect.gen(function* () {
              yield* Deferred.succeed(startedA, undefined);
              return yield* Deferred.await(gateA);
            })
          ),
        }),
      });
    }

    class PreloadLayerNodeB extends NodeBase<ProfileSpec> {
      static readonly spec = resourceSpec<ProfileSpec>({
        tag: "react-dom/resources/preload-layer-b",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ProfileSpec>({
          acquire: Driver.Acquire(() =>
            Effect.gen(function* () {
              yield* Deferred.succeed(startedB, undefined);
              return yield* Deferred.await(gateB);
            })
          ),
        }),
      });
    }

    const runtime = createRuntime();
    await runtime.submit({ _tag: "RuntimeStart" });

    const view = render(
      createElement(
        FrondProvider,
        { runtime },
        createElement(
          Suspense,
          { fallback: createElement("span", undefined, "loading") },
          createElement(
            Preload,
            {
              nodes: [
                {
                  a: [PreloadLayerNodeA, {}],
                  b: [PreloadLayerNodeB, {}],
                },
              ],
            },
            createElement("output", undefined, "children")
          )
        )
      )
    );

    expect(view.getByText("loading")).toBeTruthy();
    await Effect.runPromise(Effect.all([Deferred.await(startedA), Deferred.await(startedB)]));

    await act(async () => {
      await Effect.runPromise(
        Effect.all([
          Deferred.succeed(gateA, { timezone: "A" }),
          Deferred.succeed(gateB, { timezone: "B" }),
        ])
      );
    });

    expect(await view.findByText("children")).toBeTruthy();
  });

  test("Preload runs nested layers sequentially", async () => {
    const firstStarted = await Effect.runPromise(Deferred.make<void>());
    const secondStarted = await Effect.runPromise(Deferred.make<void>());
    const firstGate = await Effect.runPromise(Deferred.make<Profile>());
    const secondGate = await Effect.runPromise(Deferred.make<Profile>());
    let secondAttempts = 0;

    class FirstPreloadLayerNode extends NodeBase<ProfileSpec> {
      static readonly spec = resourceSpec<ProfileSpec>({
        tag: "react-dom/resources/preload-first-layer",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ProfileSpec>({
          acquire: Driver.Acquire(() =>
            Effect.gen(function* () {
              yield* Deferred.succeed(firstStarted, undefined);
              return yield* Deferred.await(firstGate);
            })
          ),
        }),
      });
    }

    class SecondPreloadLayerNode extends NodeBase<ProfileSpec> {
      static readonly spec = resourceSpec<ProfileSpec>({
        tag: "react-dom/resources/preload-second-layer",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ProfileSpec>({
          acquire: Driver.Acquire(() =>
            Effect.gen(function* () {
              secondAttempts += 1;
              yield* Deferred.succeed(secondStarted, undefined);
              return yield* Deferred.await(secondGate);
            })
          ),
        }),
      });
    }

    const runtime = createRuntime();
    await runtime.submit({ _tag: "RuntimeStart" });

    const view = render(
      createElement(
        FrondProvider,
        { runtime },
        createElement(
          Suspense,
          { fallback: createElement("span", undefined, "loading") },
          createElement(
            Preload,
            {
              nodes: [
                { first: [FirstPreloadLayerNode, {}] },
                { second: [SecondPreloadLayerNode, {}] },
              ],
            },
            createElement("output", undefined, "children")
          )
        )
      )
    );

    expect(view.getByText("loading")).toBeTruthy();
    await Effect.runPromise(Deferred.await(firstStarted));

    expect(secondAttempts).toBe(0);

    await act(async () => {
      await Effect.runPromise(Deferred.succeed(firstGate, { timezone: "first" }));
    });
    await Effect.runPromise(Deferred.await(secondStarted));
    await act(async () => {
      await Effect.runPromise(Deferred.succeed(secondGate, { timezone: "second" }));
    });

    expect(await view.findByText("children")).toBeTruthy();
  });

  test("Preload readiness failure reaches ErrorBoundary as retryable read error", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});

    try {
      class FailingPreloadNode extends NodeBase<ProfileSpec> {
        static readonly spec = resourceSpec<ProfileSpec>({
          tag: "react-dom/resources/preload-failing",
          key: () => Key.singleton(),
          dependencies: dependencies(() => ({})),
          driver: Driver.Effect<ProfileSpec>({
            acquire: Driver.Acquire(() => Effect.fail(new Error("preload failed"))),
          }),
        });
      }

      const runtime = createRuntime();
      await runtime.submit({ _tag: "RuntimeStart" });

      const view = render(
        createElement(
          FrondProvider,
          { runtime },
          createElement(
            TestErrorBoundary,
            {
              fallback: (_reset, error) =>
                error instanceof Runtime.FrondRuntimeReadError &&
                getErrorRecovery(error) !== undefined
                  ? createElement("output", undefined, `${error.kind}:${String(error.retryable)}`)
                  : createElement("output", undefined, "unexpected-error"),
            },
            createElement(
              Suspense,
              { fallback: createElement("span", undefined, "loading") },
              createElement(
                Preload,
                { nodes: [{ profile: [FailingPreloadNode, {}] }] },
                createElement("output", undefined, "children")
              )
            )
          )
        )
      );

      expect(await view.findByText("readiness:true")).toBeTruthy();
    } finally {
      consoleError.mockRestore();
    }
  });

  test("invalid graph read reaches ErrorBoundary as non-retryable read error", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});

    try {
      type InvalidReadSpec = NodeSpec<{
        readonly args: EmptyArgs;
        readonly key: Key.Singleton;
        readonly deps: {
          readonly self: Dep<typeof InvalidReadNode>;
        };
        readonly result: Profile;
      }>;

      class InvalidReadNode extends NodeBase<InvalidReadSpec> {
        static readonly spec = resourceSpec<InvalidReadSpec>({
          tag: "react-dom/resources/invalid-read",
          key: () => Key.singleton(),
          dependencies: dependencies(() => ({ self: dep(InvalidReadNode, {}) })),
          driver: Driver.Effect<InvalidReadSpec>({
            acquire: Driver.Acquire(() => Effect.succeed({ timezone: "never" })),
          }),
        });
      }

      const ProfileView = () => {
        useNode(InvalidReadNode, {});

        return createElement("output", undefined, "ready");
      };

      const runtime = createRuntime();
      await runtime.submit({ _tag: "RuntimeStart" });

      const view = render(
        createElement(
          FrondProvider,
          { runtime },
          createElement(
            TestErrorBoundary,
            {
              fallback: (_reset, error) =>
                error instanceof Runtime.FrondRuntimeReadError &&
                getErrorRecovery(error) === undefined
                  ? createElement("output", undefined, `${error.kind}:${String(error.retryable)}`)
                  : createElement("output", undefined, "unexpected-error"),
            },
            createElement(
              Suspense,
              { fallback: createElement("span", undefined, "loading") },
              createElement(ProfileView)
            )
          )
        )
      );

      expect(await view.findByText("invalid:false")).toBeTruthy();
    } finally {
      consoleError.mockRestore();
    }
  });

  test("stopped runtime read reaches ErrorBoundary as runtime availability error", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});

    try {
      class StoppedRuntimeNode extends NodeBase<ProfileSpec> {
        static readonly spec = resourceSpec<ProfileSpec>({
          tag: "react-dom/resources/stopped-runtime",
          key: () => Key.singleton(),
          dependencies: dependencies(() => ({})),
          driver: Driver.Effect<ProfileSpec>({
            acquire: Driver.Acquire(() => Effect.succeed({ timezone: "UTC" })),
          }),
        });
      }

      const ProfileView = () => {
        useNode(StoppedRuntimeNode, {});

        return createElement("output", undefined, "ready");
      };

      const runtime = createRuntime();
      await runtime.submit({ _tag: "RuntimeStart" });
      await runtime.submit({ _tag: "RuntimeStop", reason: "test stop" });

      const view = render(
        createElement(
          FrondProvider,
          { runtime },
          createElement(
            TestErrorBoundary,
            {
              fallback: (_reset, error) =>
                error instanceof Runtime.FrondRuntimeReadError
                  ? createElement("output", undefined, `${error.kind}:${String(error.retryable)}`)
                  : createElement("output", undefined, "unexpected-error"),
            },
            createElement(
              Suspense,
              { fallback: createElement("span", undefined, "loading") },
              createElement(ProfileView)
            )
          )
        )
      );

      expect(await view.findByText("runtime:false")).toBeTruthy();
    } finally {
      consoleError.mockRestore();
    }
  });

  test("remount attaches to existing pending work instead of starting another acquire", async () => {
    const started = await Effect.runPromise(Deferred.make<void>());
    const gate = await Effect.runPromise(Deferred.make<Profile>());
    let attempts = 0;

    class PendingProfileNode extends NodeBase<ProfileSpec> {
      static readonly spec = resourceSpec<ProfileSpec>({
        tag: "react-dom/resources/remount-pending",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ProfileSpec>({
          acquire: Driver.Acquire(() =>
            Effect.gen(function* () {
              attempts += 1;
              yield* Deferred.succeed(started, undefined);
              return yield* Deferred.await(gate);
            })
          ),
        }),
      });

      get timezone(): string {
        return this.result.timezone;
      }
    }

    const ProfileView = () => {
      const profile = useNode(PendingProfileNode, {});

      return createElement("output", undefined, profile.timezone);
    };

    const runtime = createRuntime();
    await runtime.submit({ _tag: "RuntimeStart" });

    const firstView = render(
      createElement(
        FrondProvider,
        { runtime },
        createElement(
          Suspense,
          { fallback: createElement("span", undefined, "loading") },
          createElement(ProfileView)
        )
      )
    );

    await Effect.runPromise(Deferred.await(started));
    expect(attempts).toBe(1);
    firstView.unmount();

    const secondView = render(
      createElement(
        FrondProvider,
        { runtime },
        createElement(
          Suspense,
          { fallback: createElement("span", undefined, "loading") },
          createElement(ProfileView)
        )
      )
    );

    expect(secondView.getByText("loading")).toBeTruthy();
    expect(attempts).toBe(1);

    await act(async () => {
      await Effect.runPromise(Deferred.succeed(gate, { timezone: "UTC" }));
    });

    expect(await secondView.findByText("UTC")).toBeTruthy();
    expect(attempts).toBe(1);
  });

  test("provider runtime swap creates a new store and boots against the next runtime", async () => {
    class RuntimeSwapNode extends NodeBase<ProfileSpec> {
      static readonly spec = resourceSpec<ProfileSpec>({
        tag: "react-dom/resources/runtime-swap",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ProfileSpec>({
          acquire: Driver.Acquire(() => Effect.succeed({ timezone: "base" })),
        }),
      });

      get timezone(): string {
        return this.result.timezone;
      }
    }

    class RuntimeSwapOverrideNode extends RuntimeSwapNode {
      static override readonly spec = resourceSpec<ProfileSpec>({
        tag: "react-dom/resources/runtime-swap",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ProfileSpec>({
          acquire: Driver.Acquire(() => Effect.succeed({ timezone: "override" })),
        }),
      });

      get timezone(): string {
        return this.result.timezone;
      }
    }

    const ProfileView = () => {
      const profile = useNode(RuntimeSwapNode, {});

      return createElement("output", undefined, profile.timezone);
    };

    const firstRuntime = createRuntime();
    const secondRuntime = createRuntime({
      specOverrides: [{ from: RuntimeSwapNode, to: RuntimeSwapOverrideNode }],
    });
    await firstRuntime.submit({ _tag: "RuntimeStart" });
    await secondRuntime.submit({ _tag: "RuntimeStart" });

    const view = render(
      createElement(
        FrondProvider,
        { runtime: firstRuntime },
        createElement(
          Suspense,
          { fallback: createElement("span", undefined, "loading") },
          createElement(ProfileView)
        )
      )
    );

    expect(await view.findByText("base")).toBeTruthy();

    view.rerender(
      createElement(
        FrondProvider,
        { runtime: secondRuntime },
        createElement(
          Suspense,
          { fallback: createElement("span", undefined, "loading") },
          createElement(ProfileView)
        )
      )
    );

    expect(await view.findByText("override")).toBeTruthy();
  });

  test("useNodes rejects key set changes across renders", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});

    try {
      class StableNode extends NodeBase<ProfileSpec> {
        static readonly spec = resourceSpec<ProfileSpec>({
          tag: "react-dom/resources/stable-key-set",
          key: () => Key.singleton(),
          dependencies: dependencies(() => ({})),
          driver: Driver.Effect<ProfileSpec>({
            acquire: Driver.Acquire(() => Effect.succeed({ timezone: "UTC" })),
          }),
        });
      }

      const ProfilesView = ({ includeExtra }: { readonly includeExtra: boolean }) => {
        const nodes = useNodes(
          includeExtra
            ? {
                profile: [StableNode, {}],
                extra: [StableNode, {}],
              }
            : {
                profile: [StableNode, {}],
              }
        );

        return createElement("output", undefined, Object.keys(nodes).sort().join(","));
      };

      const runtime = createRuntime();
      await runtime.submit({ _tag: "RuntimeStart" });

      const view = render(
        createElement(
          FrondProvider,
          { runtime },
          createElement(
            TestErrorBoundary,
            {
              fallback: () => createElement("span", undefined, "key-set-error"),
            },
            createElement(
              Suspense,
              { fallback: createElement("span", undefined, "loading") },
              createElement(ProfilesView, { includeExtra: false })
            )
          )
        )
      );

      expect(await view.findByText("profile")).toBeTruthy();

      view.rerender(
        createElement(
          FrondProvider,
          { runtime },
          createElement(
            TestErrorBoundary,
            { fallback: () => createElement("span", undefined, "key-set-error") },
            createElement(
              Suspense,
              { fallback: createElement("span", undefined, "loading") },
              createElement(ProfilesView, { includeExtra: true })
            )
          )
        )
      );

      await waitFor(() => expect(view.getByText("key-set-error")).toBeTruthy());
    } finally {
      consoleError.mockRestore();
    }
  });

  test("useNodes key set errors name previous and next keys", () => {
    expect(() =>
      assertStableKeySet({
        hook: "useNodes",
        initialKeys: { current: ["profile"] },
        nextKeys: ["extra", "profile"],
      })
    ).toThrow(
      "FrondReact.useNodes key set changed across renders: was [profile], now [extra, profile]."
    );
  });
});

class TestErrorBoundary extends Component<
  {
    readonly children: ReactNode;
    readonly fallback: (reset: () => void, error: unknown) => ReactNode;
  },
  { readonly error: unknown }
> {
  readonly state = { error: undefined };

  static getDerivedStateFromError(error: unknown): { readonly error: unknown } {
    return { error };
  }

  componentDidCatch(_error: unknown, _errorInfo: ErrorInfo): void {}

  render(): ReactNode {
    if (this.state.error !== undefined) {
      return this.props.fallback(() => {
        this.setState({ error: undefined });
      }, this.state.error);
    }

    return this.props.children;
  }
}
