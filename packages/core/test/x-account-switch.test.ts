/** switch_x_account on the account menu's harder layouts, and the X account check around publishing. */
import { describe, expect, it } from "vitest";
import { createToolExecutor } from "../src/index.js";
import { switchXAccount, TAKE_EFFECT_POLL } from "../src/x-account.js";
import { FakeX } from "./fake-x.js";
import { collect, noSleep } from "./helpers.js";

/** What switch_x_account asked of the browser, and the rule it never breaks: no element-number click on a menu cell. */
function neverClicksACell(x: FakeX): void {
  const cellClicks = x.calls.filter((c) => c.method === "browser.click" && (c.params as { index: number }).index !== 0);
  expect(cellClicks).toEqual([]); // index 0 is the switcher button (the first element FakeX renders on X)
  expect(x.delegateClicks).toEqual([]);
}

describe("switchXAccount", () => {
  // X's account menu as the owner's run logs show it (Sep 27, account @bboym0dE with delegates): opened first after
  // a page load it lists 'button "Switch to @getbnty" (testid=UserCell)'; 0.3-1.6 s later X re-renders it with
  // "Delegate accounts" expanded ('button "Act as" (testid=UserCell)') and "Personal accounts" as plain text (no
  // element), and every later opening in that page load shows the delegate view at once. FakeX flips the menu after
  // `flipAfter` browser calls since it opened (per page load: the first, the next after a navigation, ...).
  const OWNER = { account: "bboym0dE", accounts: ["bboym0dE", "arrrfun", "getbnty", "mecharoyalecom", "rooftopchat"], delegates: ["powpowfun", "moddio"] };

  it("the entry is clicked in the page right as the menu opens, before X flips it (no read in between)", async () => {
    // The flip comes on the second call after the menu opened: a read first, then a click, would find it flipped.
    const x = new FakeX({ ...OWNER, url: "https://x.com/home", flipAfter: [Infinity, 2] });
    const r = await switchXAccount(x.caller(), "@getbnty", { sleep: noSleep });
    expect(r.text).toMatch(/^Switched to @getbnty/);
    expect(x.account).toBe("getbnty");
    const methods = x.calls.map((c) => c.method);
    const opened = methods.indexOf("browser.click");
    expect(methods[opened + 1]).toBe("browser.clickXAccountEntry");
    expect(x.calls[opened + 1]!.params).toMatchObject({ handle: "@getbnty" });
    expect(x.entryClicks).toEqual([{ handle: "@getbnty", press: false }]);
    neverClicksACell(x);
  });

  it("real X, menu already opened in this page load (delegate view): reloads X and switches", async () => {
    const x = new FakeX({ ...OWNER, url: "https://x.com/home", menuOpenedBefore: true });
    const r = await switchXAccount(x.caller(), "@getbnty", { sleep: noSleep });
    expect(r.text).toMatch(/^Switched to @getbnty/);
    expect(x.account).toBe("getbnty");
    neverClicksACell(x);
  });

  it("X flips the menu before the page can click the entry: nothing is clicked, X is reloaded and the switch tried again", async () => {
    // First try: the menu flips on the very call that picks the entry; second try: it stays.
    const x = new FakeX({ ...OWNER, url: "https://x.com/getbnty", flipAfter: [Infinity, 1, Infinity] });
    const r = await switchXAccount(x.caller(), "@rooftopchat", { sleep: noSleep });
    expect(r.text).toMatch(/^Switched to @rooftopchat/);
    expect(x.entryClicks).toEqual([{ handle: "@rooftopchat", press: false }]);
    expect(x.calls.filter((c) => c.method === "browser.navigate")).toHaveLength(2);
    neverClicksACell(x);
  });

  it("only delegate cells, every time: never an \"Act as\", a clear failure after SWITCH_ATTEMPTS reloads", async () => {
    const x = new FakeX({ ...OWNER, url: "https://x.com/home", flipAfter: [0, 0, 0, 0, 0] });
    const r = await switchXAccount(x.caller(), "@getbnty", { sleep: noSleep });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/3 of 3 times X switched its account menu to the delegate accounts.*task_pause/s);
    expect(x.entryClicks).toEqual([]);
    expect(x.account).toBe("bboym0dE");
    neverClicksACell(x);
  });

  it("a delegate account (only an \"Act as\" entry names it): never clicked, the user is told", async () => {
    const x = new FakeX({ ...OWNER, url: "https://x.com/home", menuOpenedBefore: true, flipAfter: [0, 0, 0, 0] });
    const r = await switchXAccount(x.caller(), "@powpowfun", { sleep: noSleep });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/delegate.*never acts as a delegate/i);
    expect(x.account).toBe("bboym0dE");
    neverClicksACell(x);
  });

  it("an account not signed in in this browser: stops for the user, naming the accounts X lists", async () => {
    const x = new FakeX({ ...OWNER, url: "https://x.com/home" });
    const r = await switchXAccount(x.caller(), "@nobody", { sleep: noSleep });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/@nobody is not signed in.*Add an existing account.*task_pause/s);
    expect(r.text).toContain("@getbnty");
    expect(x.account).toBe("bboym0dE");
    neverClicksACell(x);
  });

  it("a page that ignores the click in the page: a real press on the same entry switches", async () => {
    const x = new FakeX({ account: "alice", url: "https://x.com/home", ignoresPageClicks: true });
    const r = await switchXAccount(x.caller(), "bob", { sleep: noSleep });
    expect(r.text).toMatch(/^Switched to @bob/);
    expect(x.entryClicks).toEqual([
      { handle: "@bob", press: false },
      { handle: "@bob", press: true },
    ]);
    neverClicksACell(x);
  });

  it("the click ignored and X flips before the press: the press finds no entry (nothing pressed), reload, and a press on the next try", async () => {
    // Calls after the menu opens: the pick (1), the reads that watch it take effect, then the press, which X's flip beats.
    const reads = 1 + Math.ceil(TAKE_EFFECT_POLL.timeoutMs / TAKE_EFFECT_POLL.intervalMs);
    const x = new FakeX({ ...OWNER, url: "https://x.com/home", ignoresPageClicks: true, flipAfter: [Infinity, 2 + reads, Infinity] });
    const r = await switchXAccount(x.caller(), "@getbnty", { sleep: noSleep });
    expect(r.text).toMatch(/^Switched to @getbnty/);
    expect(x.entryClicks).toEqual([
      { handle: "@getbnty", press: false },
      { handle: "@getbnty", press: true },
    ]);
    // The second try pressed at once: it did not click in the page again.
    expect(x.calls.filter((c) => c.method === "browser.clickXAccountEntry").map((c) => (c.params as { press?: boolean }).press ?? false)).toEqual([false, true, true]);
    neverClicksACell(x);
  });

  it("stops at a lock or login page: the user must act", async () => {
    const x = new FakeX({ url: "https://x.com/account/access", account: "alice" });
    const r = await switchXAccount(x.caller(), "bob", { sleep: noSleep });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/X locked the account.*task_pause/);
    expect(x.calls.map((c) => c.method)).toEqual(["browser.readPage"]);
  });
});

describe("the X account check around publishing", () => {
  it("a Post goes out while X shows the task's account; Ctrl+Enter is refused once X shows another one", async () => {
    const x = new FakeX({ url: "https://x.com/home", account: "bob" });
    const { onEvent } = collect();
    const exec = createToolExecutor({ browser: x.caller(), jev: null, jevThreshold: 0.8, onEvent, mediaPaths: [], sleep: noSleep, account: "@Bob" });
    await exec.call("read_page", {});
    const box = x.snapshot().elements.find((e) => e.testId === "tweetTextarea_0")!.index;
    await exec.call("act", { steps: [{ goal: "type", index: box, text: "hi from bob" }] });
    const post = x.snapshot().elements.find((e) => e.name === "Post" && e.role === "button")!.index;
    expect((await exec.call("act", { steps: [{ goal: "click Post", index: post }] })).isError).toBeFalsy();
    expect(x.posts.map((p) => p.account)).toEqual(["bob"]);

    x.account = "alice";
    await exec.call("navigate", { url: "https://x.com/home" });
    const key = await exec.call("press_key", { key: "Control+Enter" });
    expect(key).toMatchObject({ isError: true, text: expect.stringContaining("X is signed in as @alice, this job posts as @Bob") });
    expect(x.calls.filter((c) => c.method === "browser.pressKey")).toEqual([]);
  });

  it("other clicks on X are not held up, whatever account is signed in", async () => {
    const x = new FakeX({ url: "https://x.com/home", account: "alice" });
    const { onEvent } = collect();
    const exec = createToolExecutor({ browser: x.caller(), jev: null, jevThreshold: 0.8, onEvent, mediaPaths: [], sleep: noSleep, account: "@bob" });
    const home = x.snapshot().elements.find((e) => e.name === "Home")!.index;
    expect((await exec.call("click", { index: home })).isError).toBeFalsy();
  });
});
