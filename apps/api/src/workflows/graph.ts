/**
 * Pure graph checks for workflow definitions. No database, no I/O.
 *
 * A workflow is a directed graph: node A "dependsOn" node B means an edge B -> A (B must
 * finish first). It is runnable only if it is a DAG (acyclic): in a cycle every node waits
 * for another, so nothing could ever start.
 */

export interface GraphNode {
  key: string;
  dependsOn: string[];
}

export type GraphAnalysis =
  { ok: true; order: string[] } | { ok: false; problem: "cycle"; cycle: string[] };

/**
 * Kahn's algorithm. Repeatedly take nodes with no unmet dependencies; if some nodes can never
 * be taken, they are on or behind a cycle. Runs in O(nodes + edges).
 *
 * On success `order` is a valid topological order (every node appears after its dependencies).
 * On failure `cycle` is one concrete cycle, e.g. ["a","b","c","a"], found by walking
 * dependencies inside the leftover nodes until a node repeats.
 *
 * Assumes keys are unique and every dependsOn entry names an existing node
 * (see validateDefinition).
 */
export function analyzeGraph(nodes: GraphNode[]): GraphAnalysis {
  const remainingDeps = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const n of nodes) {
    remainingDeps.set(n.key, n.dependsOn.length);
    for (const dep of n.dependsOn) {
      const list = dependents.get(dep) ?? [];
      list.push(n.key);
      dependents.set(dep, list);
    }
  }

  const ready = nodes.filter((n) => n.dependsOn.length === 0).map((n) => n.key);
  const order: string[] = [];
  while (ready.length > 0) {
    const key = ready.shift()!;
    order.push(key);
    for (const child of dependents.get(key) ?? []) {
      const left = remainingDeps.get(child)! - 1;
      remainingDeps.set(child, left);
      if (left === 0) ready.push(child);
    }
  }
  if (order.length === nodes.length) return { ok: true, order };

  // Some nodes were never ready. Every leftover node still has an unmet dependency that is
  // itself a leftover, so following dependencies from any leftover must eventually repeat.
  const placed = new Set(order);
  const byKey = new Map(nodes.map((n) => [n.key, n] as const));
  const start = nodes.find((n) => !placed.has(n.key))!;
  const path: string[] = [];
  const seenAt = new Map<string, number>();
  let current = start.key;
  while (!seenAt.has(current)) {
    seenAt.set(current, path.length);
    path.push(current);
    current = byKey.get(current)!.dependsOn.find((d) => !placed.has(d))!;
  }
  // path[seenAt(current)..] is the cycle, listed along "depends on" edges.
  const cycle = [...path.slice(seenAt.get(current)!), current];
  return { ok: false, problem: "cycle", cycle };
}

export interface DefinitionIssue {
  path: (string | number)[];
  message: string;
}

/** Structural checks before the graph analysis: duplicate keys, unknown or repeated dependencies. */
export function validateDefinition(nodes: GraphNode[]): DefinitionIssue[] {
  const issues: DefinitionIssue[] = [];
  const seen = new Map<string, number>();
  nodes.forEach((n, i) => {
    const first = seen.get(n.key);
    if (first !== undefined) {
      issues.push({
        path: ["nodes", i, "key"],
        message: `duplicate key "${n.key}" (also used by nodes[${first}])`,
      });
    } else {
      seen.set(n.key, i);
    }
  });
  nodes.forEach((n, i) => {
    const deps = new Set<string>();
    n.dependsOn.forEach((dep, j) => {
      if (!seen.has(dep)) {
        issues.push({
          path: ["nodes", i, "dependsOn", j],
          message: `unknown dependency "${dep}"`,
        });
      }
      if (deps.has(dep)) {
        issues.push({
          path: ["nodes", i, "dependsOn", j],
          message: `"${dep}" is listed twice`,
        });
      }
      deps.add(dep);
    });
  });
  return issues;
}
