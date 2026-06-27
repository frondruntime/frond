import type { NodeOperation, NodeOperationFailure } from "../../graph/types/operations";
import type { NodeRead, NodeSnapshot } from "../../graph/types/reads";
import type { ResultValidity } from "../../graph/types/resultValidity";

export type RuntimeNodeSnapshot<TResult> = NodeSnapshot extends infer TSnapshot
  ? TSnapshot extends { readonly _tag: "Ready" }
    ? Omit<TSnapshot, "result"> & {
        readonly result: TResult | undefined;
      }
    : TSnapshot
  : never;

export type RuntimeNodeSnapshotLookup<TResult = unknown> =
  | {
      readonly _tag: "Found";
      readonly snapshot: RuntimeNodeSnapshot<TResult>;
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

export type RuntimeNodeRead<TResult> =
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
      readonly node: object;
      readonly result: TResult | undefined;
      readonly resultValidity: DisplayableResultValidity;
    } & RuntimeNodeReadOperationFields)
  | ({
      readonly _tag: "Error";
      readonly nodeId: NodeRead["nodeId"];
      readonly kind: "readiness" | "invalid" | "runtime";
      readonly error: unknown;
    } & RuntimeNodeReadOperationFields);

export type RawRuntimeNodeRead<TResult> =
  | RuntimeNodeRead<TResult>
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
      readonly node: object;
      readonly result: TResult | undefined;
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
