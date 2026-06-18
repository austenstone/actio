import { describe, expect, it } from "vitest";
import { cloneNode } from "../packages/core/src/ir.js";
import { KEY_ORDER, parseActio, setKeyOrder } from "../packages/core/src/parser.js";

/**
 * N5 — cloneNode must not share the KEY_ORDER array instance between source and
 * clone. structuredClone drops the non-enumerable symbol, so reapplyKeyOrder
 * re-stamps it; stamping the SAME array reference is a latent footgun where a
 * future in-place mutation on one node silently corrupts the other's order.
 */
describe("cloneNode KEY_ORDER reference isolation", () => {
  it("copies the KEY_ORDER array by value, not by reference", () => {
    const ctx = parseActio("name: x\non: [push]\njobs: {}\n", "t.actio.yml");

    const node: Record<string, unknown> = { b: 1, a: 2 };
    setKeyOrder(node, ["b", "a"]);

    const copy = cloneNode(ctx, node);

    const srcOrder = (node as Record<symbol, unknown>)[KEY_ORDER] as string[];
    const dstOrder = (copy as Record<symbol, unknown>)[KEY_ORDER] as string[];

    expect(dstOrder).toEqual(srcOrder);
    expect(dstOrder).not.toBe(srcOrder);

    dstOrder.push("c");
    expect(srcOrder).toEqual(["b", "a"]);
  });
});
