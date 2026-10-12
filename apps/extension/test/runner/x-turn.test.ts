import { describe, expect, it } from "vitest";
import { XTurn } from "../../src/engine/run/scheduling.js";

describe("XTurn", () => {
  it("is handed to one waiter at a time, in the order they asked", async () => {
    const turn = new XTurn();
    turn.tryTake("a");
    const got: string[] = [];
    const b = turn.acquire("b", () => false).then((held) => held && got.push("b"));
    const c = turn.acquire("c", () => false).then((held) => held && got.push("c"));
    turn.release("a");
    await b;
    expect(got).toEqual(["b"]);
    expect(turn.heldByOther("c")).toBe(true);
    turn.release("b");
    await c;
    expect(got).toEqual(["b", "c"]);
  });

  it("a stopped waiter stops waiting and is never given the turn", async () => {
    const turn = new XTurn();
    turn.tryTake("a");
    let stopped = false;
    const b = turn.acquire("b", () => stopped);
    const c = turn.acquire("c", () => false);
    stopped = true;
    turn.wake();
    expect(await b).toBe(false);
    turn.release("a");
    expect(await c).toBe(true);
    expect(turn.heldByOther("b")).toBe(true);
  });
});
