import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  analyzeGraph,
  validateDefinition,
  type GraphNode,
} from "../../apps/api/src/workflows/graph.js";

const g = (spec: Record<string, string[]>): GraphNode[] =>
  Object.entries(spec).map(([key, dependsOn]) => ({ key, dependsOn }));

/** Every node must appear after all of its dependencies. */
function assertTopological(nodes: GraphNode[], order: string[]): void {
  assert.equal(order.length, nodes.length);
  assert.equal(new Set(order).size, nodes.length);
  const pos = new Map(order.map((k, i) => [k, i] as const));
  for (const n of nodes) {
    for (const dep of n.dependsOn) {
      assert.ok(pos.get(dep)! < pos.get(n.key)!, `${dep} must come before ${n.key}`);
    }
  }
}

/** A reported cycle must be real: each element depends on the next, and it closes. */
function assertRealCycle(nodes: GraphNode[], cycle: string[]): void {
  assert.ok(cycle.length >= 2);
  assert.equal(cycle[0], cycle[cycle.length - 1], "the cycle closes on itself");
  const deps = new Map(nodes.map((n) => [n.key, n.dependsOn] as const));
  for (let i = 0; i < cycle.length - 1; i++) {
    assert.ok(
      deps.get(cycle[i]!)!.includes(cycle[i + 1]!),
      `${cycle[i]} depends on ${cycle[i + 1]}`,
    );
  }
}

describe("analyzeGraph: valid workflows", () => {
  it("a single node", () => {
    const r = analyzeGraph(g({ a: [] }));
    assert.deepEqual(r, { ok: true, order: ["a"] });
  });

  it("a chain", () => {
    const nodes = g({ c: ["b"], b: ["a"], a: [] }); // declared out of order on purpose
    const r = analyzeGraph(nodes);
    assert.ok(r.ok);
    assert.deepEqual(r.order, ["a", "b", "c"]);
  });

  it("a diamond (fan-out then fan-in)", () => {
    const nodes = g({ a: [], b: ["a"], c: ["a"], d: ["b", "c"] });
    const r = analyzeGraph(nodes);
    assert.ok(r.ok);
    assertTopological(nodes, r.order);
  });

  it("disconnected components and several roots", () => {
    const nodes = g({ a: [], b: ["a"], x: [], y: ["x"], z: [] });
    const r = analyzeGraph(nodes);
    assert.ok(r.ok);
    assertTopological(nodes, r.order);
  });

  it("a wide fan-in", () => {
    const spec: Record<string, string[]> = { sink: [] };
    const parents: string[] = [];
    for (let i = 0; i < 50; i++) {
      spec[`p${i}`] = [];
      parents.push(`p${i}`);
    }
    spec.sink = parents;
    const nodes = g(spec);
    const r = analyzeGraph(nodes);
    assert.ok(r.ok);
    assertTopological(nodes, r.order);
    assert.equal(r.order[r.order.length - 1], "sink");
  });

  it("a 100-node layered graph", () => {
    const spec: Record<string, string[]> = {};
    for (let layer = 0; layer < 10; layer++) {
      for (let i = 0; i < 10; i++) {
        spec[`n${layer}_${i}`] =
          layer === 0 ? [] : [`n${layer - 1}_${i}`, `n${layer - 1}_${(i + 1) % 10}`];
      }
    }
    const nodes = g(spec);
    const r = analyzeGraph(nodes);
    assert.ok(r.ok);
    assertTopological(nodes, r.order);
  });
});

describe("analyzeGraph: cycles are detected and reported concretely", () => {
  it("a node that depends on itself", () => {
    const nodes = g({ a: ["a"] });
    const r = analyzeGraph(nodes);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.deepEqual(r.cycle, ["a", "a"]);
      assertRealCycle(nodes, r.cycle);
    }
  });

  it("two nodes that depend on each other", () => {
    const nodes = g({ a: ["b"], b: ["a"] });
    const r = analyzeGraph(nodes);
    assert.equal(r.ok, false);
    if (!r.ok) assertRealCycle(nodes, r.cycle);
  });

  it("a longer cycle", () => {
    const nodes = g({ a: ["c"], b: ["a"], c: ["b"] });
    const r = analyzeGraph(nodes);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assertRealCycle(nodes, r.cycle);
      assert.equal(r.cycle.length, 4); // three nodes plus the closing repeat
    }
  });

  it("a cycle hidden inside an otherwise valid graph", () => {
    const nodes = g({
      root: [],
      ok1: ["root"],
      ok2: ["ok1"],
      x: ["y", "root"],
      y: ["z"],
      z: ["x"],
    });
    const r = analyzeGraph(nodes);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assertRealCycle(nodes, r.cycle);
      assert.ok(
        r.cycle.every((k) => ["x", "y", "z"].includes(k)),
        "only the cyclic nodes are named",
      );
    }
  });

  it("a valid-looking node that merely sits BEHIND a cycle is not blamed for it", () => {
    const nodes = g({ a: ["b"], b: ["a"], downstream: ["a"] });
    const r = analyzeGraph(nodes);
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(!r.cycle.includes("downstream"));
  });
});

describe("validateDefinition", () => {
  it("accepts a well-formed definition", () => {
    assert.deepEqual(validateDefinition(g({ a: [], b: ["a"] })), []);
  });

  it("reports duplicate keys with the position of the first use", () => {
    const issues = validateDefinition([
      { key: "a", dependsOn: [] },
      { key: "a", dependsOn: [] },
    ]);
    assert.equal(issues.length, 1);
    assert.deepEqual(issues[0]?.path, ["nodes", 1, "key"]);
    assert.match(issues[0]!.message, /duplicate key "a"/);
  });

  it("reports unknown dependencies with a precise path", () => {
    const issues = validateDefinition(g({ a: [], b: ["a", "ghost"] }));
    assert.equal(issues.length, 1);
    assert.deepEqual(issues[0]?.path, ["nodes", 1, "dependsOn", 1]);
    assert.match(issues[0]!.message, /unknown dependency "ghost"/);
  });

  it("reports a dependency listed twice", () => {
    const issues = validateDefinition(g({ a: [], b: ["a", "a"] }));
    assert.equal(issues.length, 1);
    assert.match(issues[0]!.message, /listed twice/);
  });
});
