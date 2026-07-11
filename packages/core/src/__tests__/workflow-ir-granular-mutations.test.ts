/**
 * FNXC:WorkflowIr 2026-07-11-15:00:
 * FUSI-046 — pure IR-mutation helper coverage: addNodeToIr/removeNodeFromIr/
 * addEdgeToIr/removeEdgeFromIr in packages/core/src/workflow-ir.ts. These are
 * the granular building blocks behind the MCP/pi-extension
 * fn_workflow_add_node/remove_node/add_edge/remove_edge tools
 * (packages/engine/src/agent-tools.ts) — every mutation here routes through
 * parseWorkflowIr (the sole validator), so this suite proves the pure
 * functions themselves stay whole-IR-safe independent of any tool wrapper.
 */
import { describe, it, expect } from "vitest";
import { addNodeToIr, removeNodeFromIr, addEdgeToIr, removeEdgeFromIr, WorkflowIrError } from "../workflow-ir.js";
import type { WorkflowIr } from "../workflow-ir-types.js";

function baseIr(): WorkflowIr {
  return {
    version: "v2",
    name: "Granular Core",
    columns: [{ id: "todo", name: "Todo", traits: [] }],
    nodes: [
      { id: "start", kind: "start", column: "todo" },
      { id: "end", kind: "end", column: "todo" },
    ],
    edges: [{ from: "start", to: "end", condition: "success" }],
  } as WorkflowIr;
}

describe("addNodeToIr", () => {
  it("adds a node with connecting edges atomically, in one valid graph", () => {
    const ir = baseIr();
    const next = addNodeToIr(ir, { id: "gate1", kind: "gate", column: "todo" }, [
      { from: "start", to: "gate1", condition: "success" },
      { from: "gate1", to: "end", condition: "success" },
    ]);
    expect(next.nodes.map((n) => n.id)).toEqual(["start", "end", "gate1"]);
    expect(next.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "start", to: "gate1" }),
        expect.objectContaining({ from: "gate1", to: "end" }),
      ]),
    );
    // Pure: the input IR is untouched.
    expect(ir.nodes).toHaveLength(2);
  });

  it("rejects a duplicate node id", () => {
    const ir = baseIr();
    expect(() => addNodeToIr(ir, { id: "start", kind: "gate" })).toThrow(WorkflowIrError);
  });

  it("rejects a node with no connecting edges (start-reachability) for an ordinary node kind", () => {
    const ir = baseIr();
    expect(() => addNodeToIr(ir, { id: "gate1", kind: "gate", column: "todo" })).toThrow(/not reachable/);
  });

  it("allows an interpreter-entry-exempt node kind with no connecting edges", () => {
    const ir = baseIr();
    const next = addNodeToIr(ir, { id: "router1", kind: "recovery-router" });
    expect(next.nodes.map((n) => n.id)).toContain("router1");
  });

  it("rejects an edge referencing a nonexistent node", () => {
    const ir = baseIr();
    expect(() =>
      addNodeToIr(ir, { id: "gate1", kind: "gate", column: "todo" }, [{ from: "start", to: "missing" }]),
    ).toThrow(WorkflowIrError);
  });
});

describe("removeNodeFromIr", () => {
  it("cascades to remove a mid-graph node's own incident edges atomically, touching no other edge", () => {
    const ir: WorkflowIr = {
      ...baseIr(),
      nodes: [...baseIr().nodes, { id: "gate1", kind: "gate", column: "todo" }],
      edges: [
        { from: "start", to: "gate1", condition: "success" },
        { from: "gate1", to: "end", condition: "success" },
        { from: "start", to: "end", condition: "success" },
      ],
    } as WorkflowIr;
    const next = removeNodeFromIr(ir, "gate1");
    expect(next.nodes.map((n) => n.id)).not.toContain("gate1");
    expect(next.edges).toEqual([expect.objectContaining({ from: "start", to: "end" })]);
  });

  it("rejects a nonexistent node id", () => {
    const ir = baseIr();
    expect(() => removeNodeFromIr(ir, "missing")).toThrow(WorkflowIrError);
  });

  it("still fails whole-IR validation if removal would leave another node unreachable", () => {
    // gate2 is only reachable via gate1; removing gate1 (cascading only gate1's
    // own edges) leaves gate2 stranded, which parseWorkflowIr must still reject.
    const ir: WorkflowIr = {
      ...baseIr(),
      nodes: [
        ...baseIr().nodes,
        { id: "gate1", kind: "gate", column: "todo" },
        { id: "gate2", kind: "gate", column: "todo" },
      ],
      edges: [
        { from: "start", to: "gate1", condition: "success" },
        { from: "gate1", to: "gate2", condition: "success" },
        { from: "gate2", to: "end", condition: "success" },
      ],
    } as WorkflowIr;
    expect(() => removeNodeFromIr(ir, "gate1")).toThrow(/not reachable/);
  });
});

describe("addEdgeToIr", () => {
  it("adds an edge between two existing nodes", () => {
    const ir: WorkflowIr = {
      ...baseIr(),
      nodes: [...baseIr().nodes, { id: "gate1", kind: "gate", column: "todo" }],
      edges: [
        { from: "start", to: "gate1", condition: "success" },
        { from: "gate1", to: "end", condition: "success" },
      ],
    } as WorkflowIr;
    const next = addEdgeToIr(ir, { from: "start", to: "end", condition: "success" });
    expect(next.edges).toEqual(
      expect.arrayContaining([expect.objectContaining({ from: "start", to: "end" })]),
    );
  });

  it("rejects an edge referencing a nonexistent from/to node", () => {
    const ir = baseIr();
    expect(() => addEdgeToIr(ir, { from: "start", to: "missing" })).toThrow(WorkflowIrError);
    expect(() => addEdgeToIr(ir, { from: "missing", to: "end" })).toThrow(WorkflowIrError);
  });
});

describe("removeEdgeFromIr", () => {
  it("removes the first matching edge by from/to/condition", () => {
    const ir: WorkflowIr = {
      ...baseIr(),
      nodes: [...baseIr().nodes, { id: "gate1", kind: "gate", column: "todo" }],
      edges: [
        { from: "start", to: "gate1", condition: "success" },
        { from: "gate1", to: "end", condition: "success" },
        { from: "start", to: "end", condition: "success" },
      ],
    } as WorkflowIr;
    const next = removeEdgeFromIr(ir, { from: "start", to: "end", condition: "success" });
    expect(next.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "start", to: "gate1" }),
        expect.objectContaining({ from: "gate1", to: "end" }),
      ]),
    );
    expect(next.edges).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ from: "start", to: "end" })]),
    );
  });

  it("rejects removal of a nonexistent edge", () => {
    const ir = baseIr();
    expect(() => removeEdgeFromIr(ir, { from: "start", to: "nowhere" })).toThrow(WorkflowIrError);
  });

  it("still fails whole-IR validation if removal would strand a node unreachable", () => {
    const ir: WorkflowIr = {
      ...baseIr(),
      nodes: [...baseIr().nodes, { id: "gate1", kind: "gate", column: "todo" }],
      edges: [
        { from: "start", to: "gate1", condition: "success" },
        { from: "gate1", to: "end", condition: "success" },
      ],
    } as WorkflowIr;
    // Removing start->gate1 leaves gate1 (and transitively end, if end had no
    // other path) unreachable from start.
    expect(() => removeEdgeFromIr(ir, { from: "start", to: "gate1", condition: "success" })).toThrow(
      /not reachable/,
    );
  });
});
