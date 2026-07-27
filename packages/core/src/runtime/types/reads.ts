import type { NodeOperation, NodeOperationFailure } from "../../graph/types/operations";
import type { NodeRead, NodeSnapshot } from "../../graph/types/reads";
import type { ResultValidity } from "../../graph/types/resultValidity";

/**
 * `Ready.result` is definitively `TResult`, never a separate "missing" state.
 *
 * Every path that commits the Ready phase carries a committed result state:
 * acquire success commits the driver hook's returned `TResult` (or
 * `ResultCommit<TResult>.result`, or a value staged through the typed
 * `setResult`/`patchResult` helpers) before the Ready phase exists, and
 * refresh/action/args operations seed their staged state from the previous
 * ready result. A driver hook may only return `undefined` when `undefined` is
 * a member of its `TResult` (the async/effect acquire signatures are
 * result-typed), so `result === undefined` occurs exactly when `undefined` is
 * a valid result value for the node (`TResult = undefined` or
 * `TResult = T | undefined`) — it is never a runtime-fabricated placeholder.
 * Consumers must not treat `undefined` on a node whose `TResult` excludes it
 * as a reachable state; there is no "Ready without result".
 *
 * The one escape hatch is `client.__unsafe.updateNode`, which can write an
 * arbitrary result. That surface is typed `unknown` (`UnsafeNodeRead`) and,
 * like any cast, can violate the typed contract — typed reads stay sound as
 * long as unsafe writes respect the node's declared result type.
 *
 * `TNode` is the ready author-node instance type. Typed handles created via
 * `client.node(Spec, args)` thread `NodeSpecInstance<Spec>` through here; the
 * default stays `object` for genuinely spec-less paths (unsafe/diagnostic
 * reads).
 */
export type RuntimeNodeSnapshot<
  TResult,
  TNode extends object = object,
> = NodeSnapshot extends infer TSnapshot
  ? TSnapshot extends { readonly _tag: "Ready" }
    ? Omit<TSnapshot, "result" | "node"> & {
        readonly node: TNode;
        readonly result: TResult;
      }
    : TSnapshot
  : never;

export type RuntimeNodeSnapshotLookup<TResult = unknown, TNode extends object = object> =
  | {
      readonly _tag: "Found";
      readonly snapshot: RuntimeNodeSnapshot<TResult, TNode>;
    }
  | {
      readonly _tag: "Missing";
      readonly nodeId: NodeRead["nodeId"];
    };

type RuntimeNodeReadBase = {
  readonly nodeId: NodeRead["nodeId"];
  // Node tag carried by the snapshot this read projected. Sentinel reads with
  // no reachable snapshot — an unwired node that was never materialized, or a
  // stopped runtime — report `undefined`.
  readonly tag?: string | undefined;
};

type RuntimeNodeReadOperationFields = {
  readonly operation: NodeOperation;
  readonly busy: boolean;
  readonly operationFailure?: NodeOperationFailure | undefined;
};

export type DisplayableResultValidity = Exclude<ResultValidity, { readonly _tag: "Expired" }>;

export type RuntimeNodeRead<TResult, TNode extends object = object> =
  | ({
      readonly _tag: "Unwired";
    } & RuntimeNodeReadBase)
  | ({
      readonly _tag: "Idle";
    } & RuntimeNodeReadBase &
      RuntimeNodeReadOperationFields)
  | ({
      readonly _tag: "Pending";
      readonly attempt: Promise<NodeRead>;
    } & RuntimeNodeReadBase &
      RuntimeNodeReadOperationFields)
  | ({
      readonly _tag: "Ready";
      readonly node: TNode;
      // Always the committed result; `undefined` only when `undefined` is a
      // valid member of TResult. See the module doc comment above.
      readonly result: TResult;
      readonly resultValidity: DisplayableResultValidity;
    } & RuntimeNodeReadBase &
      RuntimeNodeReadOperationFields)
  | ({
      readonly _tag: "Error";
      readonly kind: "readiness" | "invalid" | "runtime";
      readonly error: unknown;
    } & RuntimeNodeReadBase &
      RuntimeNodeReadOperationFields);

export type RawRuntimeNodeRead<TResult, TNode extends object = object> =
  | RuntimeNodeRead<TResult, TNode>
  | ({
      readonly _tag: "Booting";
      readonly attempt: Promise<NodeRead>;
      readonly operation: NodeOperation;
      readonly busy: boolean;
      readonly operationFailure?: NodeOperationFailure | undefined;
    } & RuntimeNodeReadBase)
  | ({
      readonly _tag: "Ready";
      readonly node: TNode;
      readonly result: TResult;
      readonly resultValidity: ResultValidity;
    } & RuntimeNodeReadBase &
      RuntimeNodeReadOperationFields)
  | ({
      readonly _tag: "Expired";
      readonly resultValidity: Extract<ResultValidity, { readonly _tag: "Expired" }>;
    } & RuntimeNodeReadBase &
      RuntimeNodeReadOperationFields)
  | ({
      readonly _tag: "Error";
      readonly error: unknown;
    } & RuntimeNodeReadBase &
      RuntimeNodeReadOperationFields)
  | ({
      readonly _tag: "Unavailable";
      readonly error: unknown;
    } & RuntimeNodeReadBase &
      RuntimeNodeReadOperationFields)
  | ({
      readonly _tag: "Invalid";
      readonly error: unknown;
    } & RuntimeNodeReadBase &
      RuntimeNodeReadOperationFields);
