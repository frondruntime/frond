export type SystemStatus = "idle" | "running" | "stopped";

export type NodeId = string & { readonly __brand: "Graph.NodeId" };

export type NodeKey = string & { readonly __brand: "Graph.NodeKey" };
