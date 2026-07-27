import { canonicalArgs } from "../../keys";
import type { Dependency } from "../../node";
import type { GraphNodeCell, GraphPlanState } from "../cell/cellModel";
import {
  DependencyDefinitionFailed,
  DependencyDefinitionFailures,
  GraphInvariantViolation,
  type NodeId,
  type NodeRequest,
} from "../types";
import { isFrondNodeSpec, type NodeDescriptor } from "./descriptor";
import { resolveEffectiveNodeId } from "./identity";
import { type GraphOutcome, graphFailure, graphSuccess } from "./outcome";

export type ReplanDependencyCheck =
  | { readonly _tag: "Proceed" }
  | { readonly _tag: "Mismatch"; readonly failure: GraphInvariantViolation };

export type StaticDependencyIdsResult =
  | { readonly _tag: "Malformed"; readonly cause: unknown }
  | { readonly _tag: "Same" }
  | {
      readonly _tag: "Changed";
      readonly currentIds: Readonly<Record<string, NodeId>>;
      readonly nextIds: Readonly<Record<string, NodeId>>;
    };

export function planDependencyRequests(input: {
  readonly descriptor: NodeDescriptor;
  readonly request: NodeRequest;
  readonly nodeId: NodeId;
}): GraphOutcome<
  ReadonlyArray<{
    readonly name: string;
    readonly request: NodeRequest;
  }>,
  DependencyDefinitionFailed | DependencyDefinitionFailures
> {
  const dependencies = dependenciesResult(input.descriptor, input.request, input.nodeId);

  if (dependencies._tag === "Failure") {
    return graphFailure(dependencies.failure);
  }

  return dependencyRequestsFor(input.nodeId, input.descriptor.tag, dependencies.value);
}

export function checkReplannedDependencies(
  state: GraphPlanState,
  cell: GraphNodeCell,
  request: NodeRequest
): ReplanDependencyCheck {
  const dependencyIds = resolveStaticDependencyIds(state, cell, request.args);

  if (dependencyIds._tag !== "Changed") {
    return { _tag: "Proceed" };
  }

  return {
    _tag: "Mismatch",
    failure: new GraphInvariantViolation({
      nodeId: cell.nodeId,
      tag: cell.tag,
      invariant: "same-identity re-plan cannot change static dependencies",
      cause: {
        currentDependencies: dependencyIds.currentIds,
        nextDependencies: dependencyIds.nextIds,
      },
    }),
  };
}

export function resolveStaticDependencyIds(
  state: GraphPlanState,
  cell: GraphNodeCell,
  args: unknown,
  invalidEntry: (dependencyName: string) => unknown = (dependencyName) =>
    new GraphInvariantViolation({
      nodeId: cell.nodeId,
      tag: cell.tag,
      invariant: "same-identity dependency record entry must be a dependency",
      cause: { dependency: dependencyName },
    })
): StaticDependencyIdsResult {
  try {
    const dependencies = cell.descriptor.dependencies(args);

    if (!isDependencyRecord(dependencies)) {
      return {
        _tag: "Malformed",
        cause: new GraphInvariantViolation({
          nodeId: cell.nodeId,
          tag: cell.tag,
          invariant: "same-identity dependencies must return an object record",
          cause: { dependencies },
        }),
      };
    }

    const dependencyIds: Record<string, NodeId> = {};

    for (const [dependencyName, dependency] of Object.entries(dependencies)) {
      if (dependency.type !== "dependency") {
        return { _tag: "Malformed", cause: invalidEntry(dependencyName) };
      }

      dependencyIds[dependencyName] = resolveEffectiveNodeId(state, {
        spec: dependency.spec,
        args: dependency.args,
      });
    }

    return sameDependencyIds(cell.dependencies, dependencyIds)
      ? { _tag: "Same" }
      : {
          _tag: "Changed",
          currentIds: cell.dependencies,
          nextIds: dependencyIds,
        };
  } catch (cause) {
    return { _tag: "Malformed", cause };
  }
}

export function sameDependencyIds(
  left: Readonly<Record<string, NodeId>>,
  right: Readonly<Record<string, NodeId>>
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);

  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  for (const key of leftKeys) {
    // Object.prototype.hasOwnProperty.call instead of Object.hasOwn: consumer
    // Hermes/React Native targets do not ship Object.hasOwn.
    if (!Object.prototype.hasOwnProperty.call(right, key) || left[key] !== right[key]) {
      return false;
    }
  }

  return true;
}

function dependencyRequestsFor(
  nodeId: NodeId,
  tag: string,
  dependencies: Record<string, Dependency<unknown>>
): GraphOutcome<
  ReadonlyArray<{
    readonly name: string;
    readonly request: NodeRequest;
  }>,
  DependencyDefinitionFailed | DependencyDefinitionFailures
> {
  const results = Object.entries(dependencies).map(([dependencyName, dependency]) => ({
    dependencyName,
    result: dependencyRequestResult(dependency, {
      nodeId,
      tag,
      dependency: dependencyName,
    }),
  }));
  const failures = results.flatMap(({ result }) =>
    result._tag === "Failure" ? [result.failure] : []
  );
  const failure = dependencyDefinitionFailuresFor(nodeId, tag, failures);

  if (failure !== undefined) {
    return graphFailure(failure);
  }

  return graphSuccess(
    results.flatMap(({ dependencyName, result }) =>
      result._tag === "Success" ? [{ name: dependencyName, request: result.value }] : []
    )
  );
}

function dependenciesResult(
  descriptor: NodeDescriptor,
  request: NodeRequest,
  nodeId: NodeId
): GraphOutcome<Record<string, Dependency<unknown>>, DependencyDefinitionFailed> {
  try {
    const dependencies = descriptor.dependencies(request.args);

    if (!isDependencyRecord(dependencies)) {
      return graphFailure(
        new DependencyDefinitionFailed({
          nodeId,
          tag: descriptor.tag,
          cause: new GraphInvariantViolation({
            nodeId,
            tag: descriptor.tag,
            invariant: "dependencies must return an object record",
            cause: { dependencies },
          }),
        })
      );
    }

    return graphSuccess(dependencies);
  } catch (cause) {
    return graphFailure(
      new DependencyDefinitionFailed({
        nodeId,
        tag: descriptor.tag,
        cause,
      })
    );
  }
}

function dependencyRequestResult(
  dependency: Dependency<unknown>,
  context: {
    readonly nodeId: NodeId;
    readonly tag: string;
    readonly dependency: string;
  }
): GraphOutcome<NodeRequest, DependencyDefinitionFailed> {
  try {
    if (dependency.type !== "dependency") {
      return graphFailure(
        new DependencyDefinitionFailed({
          nodeId: context.nodeId,
          tag: context.tag,
          dependency: context.dependency,
          cause: new GraphInvariantViolation({
            nodeId: context.nodeId,
            tag: context.tag,
            invariant: "dependency record entry must be a dependency",
            cause: { dependency: context.dependency },
          }),
        })
      );
    }

    const request = {
      spec: dependency.spec,
      args: dependency.args,
    };

    if (!isFrondNodeSpec(request.spec)) {
      return graphFailure(
        new DependencyDefinitionFailed({
          nodeId: context.nodeId,
          tag: context.tag,
          dependency: context.dependency,
          cause: new GraphInvariantViolation({
            nodeId: context.nodeId,
            tag: context.tag,
            invariant: "dependency node spec must be a Frond node spec",
            cause: { dependency: context.dependency },
          }),
        })
      );
    }

    canonicalArgs(request.args);

    return graphSuccess(request);
  } catch (cause) {
    return graphFailure(
      new DependencyDefinitionFailed({
        nodeId: context.nodeId,
        tag: context.tag,
        dependency: context.dependency,
        cause,
      })
    );
  }
}

function dependencyDefinitionFailuresFor(
  nodeId: NodeId,
  tag: string,
  failures: ReadonlyArray<DependencyDefinitionFailed>
): DependencyDefinitionFailed | DependencyDefinitionFailures | undefined {
  if (failures.length === 0) {
    return undefined;
  }

  if (failures.length === 1) {
    return failures[0];
  }

  return new DependencyDefinitionFailures({
    nodeId,
    tag,
    failures: failures as readonly [DependencyDefinitionFailed, ...DependencyDefinitionFailed[]],
  });
}

function isDependencyRecord(value: unknown): value is Record<string, Dependency<unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
