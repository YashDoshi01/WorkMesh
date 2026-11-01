/**
 * Orders workflow steps the way a person reads them: dependencies first.
 *
 * A step's depth is 0 if it waits for nothing, otherwise 1 + the deepest step it waits for.
 * Steps are listed by depth, then by name, so the first row is where the workflow starts and the
 * last row is where it ends. (The server returns them alphabetically.)
 *
 * The server guarantees the graph has no cycles, but this must never hang the page if it ever
 * receives one: a step already being measured is simply treated as depth 0.
 */
export function orderSteps<T extends { key: string; dependsOn: string[] }>(nodes: T[]): T[] {
  const byKey = new Map(nodes.map((n) => [n.key, n] as const));
  const depths = new Map<string, number>();
  const visiting = new Set<string>();

  const depthOf = (key: string): number => {
    const known = depths.get(key);
    if (known !== undefined) return known;
    const node = byKey.get(key);
    if (!node || visiting.has(key)) return 0;
    visiting.add(key);
    let depth = 0;
    for (const dep of node.dependsOn) {
      if (byKey.has(dep)) depth = Math.max(depth, depthOf(dep) + 1);
    }
    visiting.delete(key);
    depths.set(key, depth);
    return depth;
  };

  return [...nodes].sort((a, b) => depthOf(a.key) - depthOf(b.key) || a.key.localeCompare(b.key));
}
