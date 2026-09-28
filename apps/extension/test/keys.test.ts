import { describe, expect, it } from "vitest";
import { keyEvents, parseKeyCombo } from "../src/keys.js";

describe("parseKeyCombo", () => {
  it("maps named keys", () => {
    expect(parseKeyCombo("Enter")).toEqual({
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      modifiers: 0,
      text: "\r",
    });
    expect(parseKeyCombo("Escape")).toMatchObject({ key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, text: undefined });
    expect(parseKeyCombo("ArrowDown")).toMatchObject({ key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 });
    expect(parseKeyCombo("Tab")).toMatchObject({ code: "Tab", windowsVirtualKeyCode: 9 });
    expect(parseKeyCombo("Backspace").windowsVirtualKeyCode).toBe(8);
    expect(parseKeyCombo("Delete").windowsVirtualKeyCode).toBe(46);
    expect(parseKeyCombo("PageDown").windowsVirtualKeyCode).toBe(34);
    expect(parseKeyCombo("Home").windowsVirtualKeyCode).toBe(36);
  });

  it("maps Space and single characters", () => {
    expect(parseKeyCombo("Space")).toMatchObject({ key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " });
    expect(parseKeyCombo("a")).toMatchObject({ key: "a", code: "KeyA", windowsVirtualKeyCode: 65, text: "a" });
    expect(parseKeyCombo("7")).toMatchObject({ key: "7", code: "Digit7", windowsVirtualKeyCode: 55, text: "7" });
    expect(parseKeyCombo("/")).toMatchObject({ key: "/", code: "Slash", windowsVirtualKeyCode: 191 });
  });

  it("parses modifier combos into the CDP bitmask", () => {
    expect(parseKeyCombo("Control+Enter")).toMatchObject({ key: "Enter", modifiers: 2 });
    expect(parseKeyCombo("Control+Shift+Enter").modifiers).toBe(2 | 8);
    expect(parseKeyCombo("Alt+Meta+x").modifiers).toBe(1 | 4);
    expect(parseKeyCombo("ctrl+a")).toMatchObject({ key: "a", code: "KeyA", modifiers: 2 });
    expect(parseKeyCombo("Cmd+k").modifiers).toBe(4);
  });

  it("drops text for shortcuts and uppercases shifted letters", () => {
    expect(parseKeyCombo("Control+a").text).toBeUndefined();
    expect(parseKeyCombo("Shift+a")).toMatchObject({ key: "A", text: "A", modifiers: 8 });
  });

  it("handles the plus key itself", () => {
    expect(parseKeyCombo("+")).toMatchObject({ key: "+", modifiers: 0 });
    expect(parseKeyCombo("Control++")).toMatchObject({ key: "+", modifiers: 2 });
  });

  it("rejects empty and unknown named keys", () => {
    expect(() => parseKeyCombo("")).toThrow(/key/i);
    expect(() => parseKeyCombo("Control+")).toThrow(/key/i);
    expect(() => parseKeyCombo("Hyper+Enter")).toThrow(/Hyper/);
    expect(() => parseKeyCombo("NotAKey")).toThrow(/NotAKey/);
  });
});

describe("keyEvents", () => {
  it("builds keyDown with text and keyUp", () => {
    const [down, up] = keyEvents("Enter");
    expect(down).toEqual({
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      modifiers: 0,
      text: "\r",
      unmodifiedText: "\r",
    });
    expect(up).toMatchObject({ type: "keyUp", key: "Enter", code: "Enter" });
    expect(up).not.toHaveProperty("text");
  });

  it("uses rawKeyDown when there is no text", () => {
    const [down] = keyEvents("Control+a");
    expect(down).toMatchObject({ type: "rawKeyDown", modifiers: 2 });
    expect(down).not.toHaveProperty("text");
  });
});
