import { describe, expect, it } from "vitest";
import { orderSteps } from "./steps";

const n = (key: string, dependsOn: string[] = []) => ({ key, dependsOn });
const keys = (nodes: { key: string }[]) => nodes.map((x) => x.key);

describe("orderSteps", () => {
  it("puts dependencies before the steps that wait for them, whatever order the server sent", () => {
    // the server's alphabetical order: archive, audit, fetch, notify, render
    const sent = [
      n("archive", ["audit"]),
      n("audit", ["fetch"]),
      n("fetch"),
      n("notify", ["render"]),
      n("render", ["fetch"]),
    ];
    expect(keys(orderSteps(sent))).toEqual(["fetch", "audit", "render", "archive", "notify"]);
  });

  it("orders a chain from start to end", () => {
    expect(keys(orderSteps([n("c", ["b"]), n("b", ["a"]), n("a")]))).toEqual(["a", "b", "c"]);
  });

  it("lists steps of equal depth by name", () => {
    expect(keys(orderSteps([n("z"), n("m"), n("a")]))).toEqual(["a", "m", "z"]);
  });

  it("a join step comes after its LATEST dependency", () => {
    const order = keys(orderSteps([n("d", ["b", "c"]), n("c", ["b"]), n("b", ["a"]), n("a")]));
    expect(order).toEqual(["a", "b", "c", "d"]);
  });

  it("every step appears after everything it waits for (property check over a layered graph)", () => {
    const nodes = [];
    for (let layer = 0; layer < 6; layer++) {
      for (let i = 0; i < 4; i++) {
        nodes.push(
          n(
            `n${layer}_${i}`,
            layer === 0 ? [] : [`n${layer - 1}_${i}`, `n${layer - 1}_${(i + 2) % 4}`],
          ),
        );
      }
    }
    const shuffled = [...nodes].reverse();
    const order = keys(orderSteps(shuffled));
    const position = new Map(order.map((k, i) => [k, i] as const));
    for (const node of nodes) {
      for (const dep of node.dependsOn)
        expect(position.get(dep)!).toBeLessThan(position.get(node.key)!);
    }
    expect(order).toHaveLength(nodes.length);
  });

  it("ignores dependencies on steps it does not know about", () => {
    expect(keys(orderSteps([n("b", ["ghost"]), n("a")]))).toEqual(["a", "b"]);
  });

  it("does not hang or lose steps if it is ever given a cycle", () => {
    const order = keys(orderSteps([n("a", ["b"]), n("b", ["a"]), n("c")]));
    expect([...order].sort()).toEqual(["a", "b", "c"]);
  });

  it("does not modify its input", () => {
    const input = [n("b", ["a"]), n("a")];
    orderSteps(input);
    expect(keys(input)).toEqual(["b", "a"]);
  });
});
