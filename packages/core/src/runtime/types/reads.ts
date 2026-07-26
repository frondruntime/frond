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

type RuntimeNodeReadOperationFields = {
  readonly operation: NodeOperation;
  readonly busy: boolean;
  readonly operationFailure?: NodeOperationFailure | undefined;
};

export type DisplayableResultValidity = Exclude<ResultValidity, { readonly _tag: "Expired" }>;

export type RuntimeNodeRead<TResult, TNode extends object = object> =
  | {
      readonly _tag: "Unwired";
      readonly nodeId: NodeRead["nodeId"];
    }
  | ({
      readonly _tag: "Idle";
      readonly nodeId: NodeRead["nodeId"];
    } & RuntimeNodeReadOperationFields)
  | ({
      readonly _tag: "Pending";
      readonly nodeId: NodeRead["nodeId"];
      readonly attempt: Promise<NodeRead>;
    } & RuntimeNodeReadOperationFields)
  | ({
      readonly _tag: "Ready";
      readonly nodeId: NodeRead["nodeId"];
      readonly node: TNode;
      // Always the committed result; `undefined` only when `undefined` is a
      // valid member of TResult. See the module doc comment above.
      readonly result: TResult;
      readonly resultValidity: DisplayableResultValidity;
    } & RuntimeNodeReadOperationFields)
  | ({
      readonly _tag: "Error";
      readonly nodeId: NodeRead["nodeId"];
      readonly kind: "readiness" | "invalid" | "runtime";
      readonly error: unknown;
    } & RuntimeNodeReadOperationFields);

export type RawRuntimeNodeRead<TResult, TNode extends object = object> =
  | RuntimeNodeRead<TResult, TNode>
  | {
      readonly _tag: "Booting";
      readonly nodeId: NodeRead["nodeId"];
      readonly attempt: Promise<NodeRead>;
      readonly operation: NodeOperation;
      readonly busy: boolean;
      readonly operationFailure?: NodeOperationFailure | undefined;
    }
  | ({
      readonly _tag: "Ready";
      readonly nodeId: NodeRead["nodeId"];
      readonly node: TNode;
      readonly result: TResult;
      readonly resultValidity: ResultValidity;
    } & RuntimeNodeReadOperationFields)
  | ({
      readonly _tag: "Expired";
      readonly nodeId: NodeRead["nodeId"];
      readonly resultValidity: Extract<ResultValidity, { readonly _tag: "Expired" }>;
    } & RuntimeNodeReadOperationFields)
  | ({
      readonly _tag: "Error";
      readonly nodeId: NodeRead["nodeId"];
      readonly error: unknown;
    } & RuntimeNodeReadOperationFields)
  | ({
      readonly _tag: "Unavailable";
      readonly nodeId: NodeRead["nodeId"];
      readonly error: unknown;
    } & RuntimeNodeReadOperationFields)
  | ({
      readonly _tag: "Invalid";
      readonly nodeId: NodeRead["nodeId"];
      readonly error: unknown;
    } & RuntimeNodeReadOperationFields);
