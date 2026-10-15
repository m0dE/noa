import { describe, expect, it } from "vitest";
import type { FoundPlace, FoundText } from "@noa/shared";
import { createToolExecutor } from "../src/index.js";
import { formatFound, formatSnapshot, TEXT_CUT } from "../src/page-format.js";
import { OBSERVING_TOOLS } from "../src/reasoning.js";
import type { BrowserCaller } from "../src/types.js";
import { FakeX } from "./fake-x.js";
import { collect, fakeJev, noSleep } from "./helpers.js";

const row = (over: Partial<FoundPlace> = {}): FoundPlace => ({
  number: 1,
  context: "#1401 Priya Raman Pro Edit",
  matches: 1,
  inViewport: false,
  controls: [
    { role: "checkbox", name: "Select Priya Raman", checked: false },
    { role: "link", name: "Edit" },
  ],
  ...over,
});

/** An executor whose browser's findText answers `found`: the place asked for in view when it scrolled, and numbered controls once the page was read. */
function findWith(found: FoundText, jev = false) {
  const x = new FakeX();
  const calls: [string, unknown][] = [];
  const browser = {
    call: async (method: string, params: unknown) => {
      calls.push([method, params]);
      if (method !== "browser.findText") return x.caller().call(method as never, params as never);
      const p = params as { scroll?: boolean };
      const read = calls.some(([m]) => m === "browser.readPage");
      const places = found.places.map((pl) => ({
        ...pl,
        inViewport: p.scroll || read ? pl.number === 1 : pl.inViewport,
        controls: pl.controls.map((c, i) => (read ? { ...c, index: 40 + i } : c)),
      }));
      return { ...found, places, scrolledTo: p.scroll && found.placeCount ? 1 : null };
    },
  } as BrowserCaller;
  const { onEvent } = collect();
  const exec = createToolExecutor({ browser, jev: jev ? fakeJev([]) : null, jevThreshold: 0.8, onEvent, mediaPaths: [], sleep: noSleep });
  return { exec, calls };
}

describe("find_text", () => {
  it("scrolls the first place into view, reads the page again and answers with the place's text and numbered controls", async () => {
    const { exec, calls } = findWith({ total: 1, placeCount: 1, places: [row()], scrolledTo: null });
    const r = await exec.call("find_text", { text: "Priya Raman" });
    expect(calls).toEqual([
      ["browser.findText", { text: "Priya Raman", scroll: true }],
      ["browser.readPage", {}],
      ["browser.findText", { text: "Priya Raman", scroll: false, again: true }],
    ]);
    expect(r.text).toBe(
      [
        '"Priya Raman" occurs once on the page.',
        "Place 1 is scrolled into view now.",
        '1. (in view) "#1401 Priya Raman Pro Edit"',
        '   controls: [40] checkbox "Select Priya Raman" (not checked); [41] link "Edit"',
      ].join("\n"),
    );
  });

  it("with Jev on, controls are named without numbers; many places are counted and the rest summed up", async () => {
    const places = Array.from({ length: 10 }, (_, i) => row({ number: i + 1, context: `Row ${i + 1} Pro`, controls: [{ role: "textbox", name: "Seats", value: "3" }] }));
    const { exec, calls } = findWith({ total: 25, placeCount: 24, places, scrolledTo: null }, true);
    const r = (await exec.call("find_text", { text: "pro", place: 1 })).text!;
    expect(calls[0]).toEqual(["browser.findText", { text: "pro", scroll: true, place: 1 }]);
    expect(r).toContain('"pro" occurs 25 times in 24 places on the page.\nPlace 1 is scrolled into view now (give place to go to another).');
    expect(r).toContain('   controls: textbox "Seats" value="3"');
    expect(r).not.toMatch(/\[\d+\]/);
    expect(r.split("\n").at(-1)).toBe("(14 more places not listed: search for longer text to narrow it down, or give place to go to one)");
  });

  it("nothing found: says so, and reads nothing more", async () => {
    const { exec, calls } = findWith({ total: 0, placeCount: 0, places: [], scrolledTo: null });
    const r = await exec.call("find_text", { text: "Zed" });
    expect(r.text).toBe('"Zed" is not on this page (its shown text and form fields were searched, case and spacing aside).');
    expect(calls.map(([m]) => m)).toEqual(["browser.findText"]);
  });

  it("a place number past the last one; a place with several matches", () => {
    const f: FoundText = { total: 3, placeCount: 2, places: [row({ matches: 2 }), row({ number: 2, controls: [] })], scrolledTo: null };
    const text = formatFound("pro", f, { place: 5 });
    expect(text).toContain("There is no place 5; nothing was scrolled.");
    expect(text).toContain('1. (offscreen, 2 matches) "#1401 Priya Raman Pro Edit"');
  });

  it("only looks: neutral to the stuck detector", () => {
    expect(OBSERVING_TOOLS.has("find_text")).toBe(true);
  });

  it("read_page says when the page's text goes on past what it shows", () => {
    const snap = { url: "https://a.test/", title: "A", text: "Top", elements: [], truncated: false };
    expect(formatSnapshot(snap)).not.toContain(TEXT_CUT);
    expect(formatSnapshot({ ...snap, textCut: true }).split("\n").at(-1)).toBe(TEXT_CUT);
  });
});
