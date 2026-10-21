/** The h() helper (ui/dom.ts): classes from the tag selector and the class attribute add up; falsy attrs are left off. */
import { beforeAll, describe, expect, it } from "vitest";
import { h } from "../../src/ui/dom.js";
import { installMiniDom } from "./mini-dom.js";

describe("h", () => {
  beforeAll(() => installMiniDom());

  it("classes in the tag selector and a class attribute are both kept", () => {
    expect(h("button.job-row.timed").className).toBe("job-row timed");
    expect(h("button.job-row", { class: "timed" }).className).toBe("job-row timed");
    expect(h("button", { class: "timed" }).className).toBe("timed");
    expect(h("button.job-row", { class: undefined }).className).toBe("job-row");
  });

  it("undefined, null and false attributes are left off; true is an empty attribute", () => {
    const el = h("span", { title: undefined, hidden: false, "data-key": "k", "aria-busy": true });
    expect(el.getAttribute("title")).toBeNull();
    expect(el.getAttribute("hidden")).toBeNull();
    expect(el.getAttribute("data-key")).toBe("k");
    expect(el.getAttribute("aria-busy")).toBe("");
  });
});
