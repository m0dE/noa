/**
 * Page functions run serialized (Function.prototype.toString), so two of them cannot share code: what both need is
 * written in each. These must stay the same, word for word: the modal dialog test of coverInPage (clicks and typing)
 * and snapshotPage (read_page's covered marks), which had drifted apart; the check state coverInPage reads before
 * a click and checkStateInPage after it; and the click's input check coverInPage arms, and the debugger's own.
 */
import { describe, expect, it } from "vitest";
import { armInputProbe, checkStateInPage, coverInPage } from "../src/page-cover.js";
import { snapshotPage } from "../src/page-snapshot.js";

/** The source of the inner function `name` inside `outer`'s source (from "function name(" to its closing brace). */
function inner(outer: string, name: string): string {
  const start = outer.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`no function ${name}`);
  let depth = 0;
  for (let i = outer.indexOf("{", start); i < outer.length; i++) {
    if (outer[i] === "{") depth++;
    else if (outer[i] === "}" && --depth === 0) return outer.slice(start, i + 1).replace(/^\s+/gm, "");
  }
  throw new Error(`function ${name} does not end`);
}

describe("what page functions repeat is the same in each", () => {
  it.each(["within", "topAt", "openModals", "topmostModal", "overBackdrop", "coveringModal"])("the modal test's %s: coverInPage and snapshotPage", (name) => {
    const cover = inner(coverInPage.toString(), name);
    expect(cover).toBe(inner(snapshotPage.toString(), name));
    expect(cover.length).toBeGreaterThan(40);
  });

  it("the check state: coverInPage and checkStateInPage", () => {
    expect(inner(coverInPage.toString(), "checkState")).toBe(inner(checkStateInPage.toString(), "checkState"));
  });

  it("the click's input check: armed in coverInPage, and by the debugger's own expression (armInputProbe)", () => {
    expect(inner(coverInPage.toString(), "armInputProbe")).toBe(inner(armInputProbe.toString(), "armInputProbe"));
  });
});
