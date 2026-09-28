import { describe, expect, it } from "vitest";
import { clipEventText, MAX_ACT_STEPS, MAX_EVENT_TEXT, OUT_OF_CREDIT, type TaskRunResult } from "@noa/shared";
import { createToolExecutor, SecretRedactor } from "../src/index.js";
import { REDACTED } from "../src/redact.js";
import { picksEvent } from "../src/executor.js";
import { OutOfCreditError } from "../src/api-errors.js";
import { goalKey, rankCandidates } from "../src/act.js";
import { formatElementsInWords } from "../src/page-format.js";
import type { BrowserCaller, JevLike, ToolExecutorOptions } from "../src/types.js";
import { FAKE_JPEG_B64, FakeX } from "./fake-x.js";
import { collect, fakeJev, noSleep, smartJev } from "./helpers.js";

function setup(x: FakeX, over: { jev?: JevLike | null; mediaPaths?: string[]; onTaskEnd?: ((r: TaskRunResult) => void) | null; browser?: BrowserCaller } = {}) {
  const { events, onEvent } = collect();
  const ended: TaskRunResult[] = [];
  const exec = createToolExecutor({
    browser: over.browser ?? x.caller(),
    jev: over.jev === undefined ? null : over.jev,
    jevThreshold: 0.8,
    onEvent,
    ...(over.onTaskEnd === null ? {} : { onTaskEnd: over.onTaskEnd ?? ((r) => void ended.push(r)) }),
    mediaPaths: over.mediaPaths ?? [],
    sleep: noSleep,
  });
  return { exec, events, ended };
}

describe("createToolExecutor: plain tools", () => {
  it("maps plain tools to browser.* calls", async () => {
    const x = new FakeX();
    const { exec, events } = setup(x, { mediaPaths: ["C:\\media\\a.png"] });
    await exec.call("navigate", { url: "https://x.com/home" });
    await exec.call("read_page", {});
    await exec.call("click", { index: 0 });
    await exec.call("type", { index: 2, text: "hi" });
    await exec.call("paste", { text: "yo" });
    await exec.call("press_key", { key: "Control+Enter" });
    await exec.call("scroll", { direction: "down", amount: 2 });
    await exec.call("upload", { index: 3, paths: ["C:\\media\\a.png"] });
    expect(x.calls.map((c) => [c.method, c.params])).toEqual([
      ["browser.navigate", { url: "https://x.com/home" }],
      ["browser.readPage", {}],
      ["browser.click", { index: 0 }],
      ["browser.type", { index: 2, text: "hi" }],
      ["browser.paste", { text: "yo" }],
      ["browser.pressKey", { key: "Control+Enter" }],
      ["browser.scroll", { direction: "down", amount: 2 }],
      ["browser.upload", { index: 3, paths: ["C:\\media\\a.png"] }],
    ]);
    expect(events.filter((e) => e.type === "tool_call")).toHaveLength(8);
  });

  it("read_page returns compact text including element text", async () => {
    const x = new FakeX();
    const { exec } = setup(x);
    const r = await exec.call("read_page", {});
    expect(r.text).toContain("URL: https://x.com/compose/post");
    expect(r.text).toContain('[0] button "Account menu" (button, testid=SideNav_AccountSwitcher_Button, text="alice @alice")');
    expect(r.text).toContain('textbox "Post text" (div, testid=tweetTextarea_0)');
    expect(r.text).toContain("--- visible text ---");
  });

  it("screenshot returns an image, and emits tool_call/tool_result events", async () => {
    const x = new FakeX();
    const { exec, events } = setup(x);
    const r = await exec.call("screenshot", {});
    expect(r.image).toEqual({ base64: FAKE_JPEG_B64, mimeType: "image/jpeg" });
    expect(events).toEqual([
      { type: "tool_call", id: "t1", name: "screenshot", args: {} },
      { type: "tool_result", id: "t1", name: "screenshot", text: "[screenshot]" },
    ]);
  });

  it("validates args and never throws", async () => {
    const x = new FakeX();
    const { exec, events } = setup(x);
    const bad = await exec.call("click", { index: "three" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/Invalid arguments for click: index/);
    expect(x.calls).toHaveLength(0);
    const missing = await exec.call("click", { index: 99 });
    expect(missing).toEqual({ text: "click failed: element 99 not found; call read_page again", isError: true });
    const unknown = await exec.call("bogus" as never, {});
    expect(unknown.isError).toBe(true);
    expect(events.filter((e) => e.type === "tool_result" && e.isError)).toHaveLength(3);
    const throwing: BrowserCaller = {
      call: () => {
        throw new Error("sync boom");
      },
    };
    const r = await setup(x, { browser: throwing }).exec.call("read_page", {});
    expect(r).toEqual({ text: "read_page failed: sync boom", isError: true });
  });

  it("upload rejects paths that are not in mediaPaths (case and slash insensitive match)", async () => {
    const x = new FakeX();
    const { exec } = setup(x, { mediaPaths: ["C:\\Users\\me\\Downloads\\noa-media\\s1\\cat.png"] });
    const bad = await exec.call("upload", { index: 3, paths: ["C:\\Windows\\win.ini"] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/upload refused: C:\\Windows\\win.ini is not in the task's media list/);
    expect(x.calls).toHaveLength(0);
    await exec.call("read_page", {});
    const ok = await exec.call("upload", { index: 3, paths: ["c:/users/me/downloads/noa-media/s1/cat.png"] });
    expect(ok.isError).toBeFalsy();
  });

  it("get_credential refuses X hosts and redacts the password in events", async () => {
    const x = new FakeX({ credentials: { "example.com": { username: "u", password: "p4ss" } } });
    const { exec, events } = setup(x);
    for (const site of ["x.com", "https://www.x.com/login", "mobile.twitter.com", "TWITTER.com"]) {
      const r = await exec.call("get_credential", { site });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/never used for X/);
    }
    expect(x.calls).toHaveLength(0);
    const ok = await exec.call("get_credential", { site: "https://www.example.com/login" });
    expect(ok.text).toBe("username: u\npassword: p4ss");
    expect(JSON.stringify(events)).not.toContain("p4ss");
    expect((await exec.call("get_credential", { site: "other.com" })).text).toMatch(/No login is saved for other.com. First check whether the user is already signed in/);
    x.vaultLocked = true;
    expect((await exec.call("get_credential", { site: "example.com" })).text).toMatch(/saved site logins are locked/);
  });

  it("a password from get_credential never appears in events, also when the agent types it (and a shared redactor hides it too)", async () => {
    const x = new FakeX({ credentials: { "example.com": { username: "u", password: "s3cret-pw" } } });
    const secrets = new SecretRedactor();
    const { events, onEvent } = collect();
    const exec = createToolExecutor({ browser: x.caller(), jev: null, jevThreshold: 0.8, onEvent, mediaPaths: [], secrets, sleep: noSleep });
    expect((await exec.call("get_credential", { site: "example.com" })).text).toContain("s3cret-pw");
    await exec.call("type", { index: 2, text: "s3cret-pw" });
    await exec.call("act", { steps: [{ goal: "type the password", index: 2, text: "s3cret-pw" }] });
    await exec.call("paste", { text: "s3cret-pw" });
    // The browser got the real password; nothing the user or a log sees has it.
    expect(x.calls.filter((c) => c.method === "browser.type").map((c) => (c.params as { text: string }).text)).toEqual(["s3cret-pw", "s3cret-pw"]);
    expect(JSON.stringify(events)).not.toContain("s3cret-pw");
    expect(events.find((e) => e.type === "tool_call" && e.name === "type")).toMatchObject({ args: { index: 2, text: REDACTED } });
    expect(secrets.redact({ line: "password: s3cret-pw" })).toEqual({ line: `password: ${REDACTED}` });
  });

  it("clips long tool arguments in tool_call events (the tool still gets them whole)", async () => {
    const x = new FakeX();
    const { exec, events } = setup(x);
    const long = "a".repeat(MAX_EVENT_TEXT + 500);
    await exec.call("paste", { text: long });
    expect((x.calls[0]!.params as { text: string }).text).toBe(long);
    const args = events.find((e) => e.type === "tool_call")!.args as { text: string };
    expect(args.text).toBe(clipEventText(long));
  });

  it("upload sends the exact paths the task listed, whatever case or slashes the agent used", async () => {
    const x = new FakeX();
    const listed = "C:\\Users\\Me\\Downloads\\noa-media\\S1\\Cat.png";
    const { exec } = setup(x, { mediaPaths: [listed] });
    await exec.call("upload", { index: 3, paths: ["c:/users/me/downloads/noa-media/s1/cat.png"] });
    expect(x.calls.find((c) => c.method === "browser.upload")!.params).toEqual({ index: 3, paths: [listed] });
  });

  it("switch_x_account switches through the account menu", async () => {
    const x = new FakeX({ account: "alice" });
    const { exec } = setup(x);
    const r = await exec.call("switch_x_account", { handle: "@Bob" });
    expect(r.text).toMatch(/^Switched to @Bob/);
    expect(x.account).toBe("bob");
    expect((await exec.call("switch_x_account", { handle: "bob" })).text).toBe("Already on @bob.");
    const missing = await exec.call("switch_x_account", { handle: "dave" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/@dave is not signed in in this browser.*Add an existing account.*task_pause/);
  });

  it("task_* tools call onTaskEnd", async () => {
    const x = new FakeX();
    const { exec, ended } = setup(x);
    await exec.call("task_complete", { summary: "posted", url: "https://x.com/a/status/1" });
    await exec.call("task_fail", { reason: "nope" });
    await exec.call("task_pause", { reason: "2FA" });
    expect(ended).toEqual([
      { outcome: "done", summary: "posted", url: "https://x.com/a/status/1" },
      { outcome: "failed", reason: "nope" },
      { outcome: "paused", reason: "2FA" },
    ]);
  });

  it("task_* tools pass the agent's follow-up suggestion on; an over-long one is refused with the cap", async () => {
    const { exec, ended } = setup(new FakeX());
    await exec.call("task_complete", { summary: "Summarized 4 unread emails", suggestion: "Reply to Jordan and say I'll sign by Thursday" });
    await exec.call("task_fail", { reason: "signed out", suggestion: "Try again after I sign in" });
    await exec.call("task_pause", { reason: "2FA", suggestion: "I've entered the code, go on" });
    expect(ended).toEqual([
      { outcome: "done", summary: "Summarized 4 unread emails", suggestion: "Reply to Jordan and say I'll sign by Thursday" },
      { outcome: "failed", reason: "signed out", suggestion: "Try again after I sign in" },
      { outcome: "paused", reason: "2FA", suggestion: "I've entered the code, go on" },
    ]);
    const long = await exec.call("task_complete", { summary: "done", suggestion: "x".repeat(81) });
    expect(long.isError).toBe(true);
    expect(long.text).toMatch(/Invalid arguments for task_complete: suggestion: .*80/);
    expect(ended).toHaveLength(3);
  });

  it("task_* tools pass the agent's spoken line on (hands-free voice reads it aloud)", async () => {
    const { exec, ended } = setup(new FakeX());
    await exec.call("task_complete", { summary: "Summarized 4 unread emails", spoken: "You have four unread emails." });
    await exec.call("task_pause", { reason: "2FA", spoken: "What's the code X sent you?" });
    expect(ended).toEqual([
      { outcome: "done", summary: "Summarized 4 unread emails", spoken: "You have four unread emails." },
      { outcome: "paused", reason: "2FA", spoken: "What's the code X sent you?" },
    ]);
  });

  it("task_complete and task_pause pass a draft on (the chat shows it with Copy)", async () => {
    const { exec, ended } = setup(new FakeX());
    const draft = "Subject: Refund request\n\nHi, could you look at my renewal once more?";
    await exec.call("task_complete", { summary: "Drafted the refund email", draft });
    await exec.call("task_pause", { reason: "Send it?", draft });
    expect(ended).toEqual([
      { outcome: "done", summary: "Drafted the refund email", draft },
      { outcome: "paused", reason: "Send it?", draft },
    ]);
  });

  it("task_* tools without onTaskEnd answer that there is no task to end", async () => {
    const { exec } = setup(new FakeX(), { onTaskEnd: null });
    const r = await exec.call("task_complete", { summary: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/no task to end in an attached session/);
  });
});

describe("createToolExecutor: act", () => {
  it("without Jev, a step with no index stops; steps with an index run directly", async () => {
    const x = new FakeX({ url: "https://x.com/home" });
    const { exec } = setup(x);
    const r = await exec.call("act", { steps: [{ goal: "x" }] });
    expect(r.text).toMatch(/fast model is off, so every step needs an element index/);
    const page = (await exec.call("read_page", {})).text ?? "";
    const box = Number(/\[(\d+)\] textbox/.exec(page)![1]);
    const direct = await exec.call("act", { steps: [{ goal: "type the post", index: box, text: "direct gm" }] });
    expect(direct.text).toMatch(/typed 9 characters into \[\d+\] \(picked by Claude\)/);
  });

  it("runs several steps: type uses the step text, click, then returns the final page", async () => {
    const x = new FakeX({ url: "https://x.com/home" });
    const jev = smartJev();
    const { exec, events } = setup(x, { jev });
    const r = await exec.call("act", {
      steps: [{ goal: "type the post text into the composer", text: "gm world" }, { goal: "click the post button" }],
    });
    expect(x.posts).toEqual([{ account: "alice", text: "gm world", files: [], url: "https://x.com/alice/status/1000" }]);
    expect(r.text).toMatch(/step 1: typed 8 characters into \[2\] textbox "Post text"/);
    expect(r.text).toMatch(/step 2: clicked \[4\] button "Post"/);
    expect(r.text).toContain("All 2 step(s) done");
    expect(r.text).toContain("URL: https://x.com/alice/status/1000");
    const jevEvents = events.filter((e) => e.type === "jev");
    expect(jevEvents).toHaveLength(2);
    expect(jevEvents[0]).toMatchObject({ goal: "type the post text into the composer", operation: "type", index: 2, executed: true });
    expect(typeof (jevEvents[0] as { ms: number }).ms).toBe("number");
  });

  it("stops at a low-confidence step with 'not confident at step N' and the element list", async () => {
    const x = new FakeX({ url: "https://x.com/home" });
    const jev = fakeJev([
      { operation: "click", index: 1, confidence: 0.95 },
      { operation: "click", index: 1, confidence: 0.5 },
    ]);
    const { exec, events } = setup(x, { jev });
    const r = await exec.call("act", { steps: [{ goal: "go home" }, { goal: "open something" }, { goal: "never run" }] });
    expect(r.text).toMatch(/step 1: clicked \[1\] link "Home"/);
    expect(r.text).toContain("not confident at step 2");
    expect(r.text).toContain("Steps 3-3 were not run");
    expect(r.text).toContain('[1] link "Home"');
    expect(jev.goals).toEqual(["go home", "open something"]);
    expect(events.filter((e) => e.type === "jev").map((e) => (e as { executed: boolean }).executed)).toEqual([true, false]);
  });

  it("the step decides click or type: without text it clicks the element Jev picked, even when Jev said type", async () => {
    const x = new FakeX({ url: "https://x.com/home" });
    const { exec } = setup(x, { jev: smartJev() });
    const r = await exec.call("act", { steps: [{ goal: "type something in the composer" }] });
    expect(r.text).toMatch(/step 1: clicked \[2\] textbox "Post text"/);
    expect(x.calls.some((c) => c.method === "browser.type")).toBe(false);
    expect(x.calls.some((c) => c.method === "browser.click")).toBe(true);
  });

  it("does not auto-execute press_key, stops on blocked, and survives Jev errors", async () => {
    const x = new FakeX({ url: "https://x.com/home" });
    const pk = await setup(x, { jev: fakeJev([{ operation: "press_key", index: null, confidence: 0.99 }]) }).exec.call("act", {
      steps: [{ goal: "submit" }],
    });
    expect(pk.text).toMatch(/call press_key yourself/);
    expect(pk.text).toContain("not confident at step 1");
    const blocked = await setup(x, { jev: fakeJev([{ operation: "blocked", index: null, confidence: 0.99 }]) }).exec.call("act", {
      steps: [{ goal: "x" }],
    });
    expect(blocked.text).toContain("not confident at step 1");
    const broken: JevLike = { decide: async () => Promise.reject(new Error("503")) };
    const err = await setup(x, { jev: broken }).exec.call("act", { steps: [{ goal: "x" }] });
    expect(err.text).toMatch(/Jev is unavailable \(503\)/);
    expect(err.text).toContain("not confident at step 1");
    expect(x.calls.filter((c) => c.method !== "browser.readPage")).toHaveLength(0);
  });

  it("scroll and wait execute, done ends the batch", async () => {
    const x = new FakeX({ url: "https://x.com/home" });
    const jev = fakeJev([
      { operation: "scroll", index: null, confidence: 0.9 },
      { operation: "wait", index: null, confidence: 0.9 },
      { operation: "done", index: null, confidence: 0.9 },
    ]);
    const { exec } = setup(x, { jev });
    const r = await exec.call("act", { steps: [{ goal: "a" }, { goal: "b" }, { goal: "c" }, { goal: "d" }] });
    expect(r.text).toContain("step 1: scrolled down");
    expect(r.text).toContain("step 2: waited 1 s");
    expect(r.text).toContain('step 3: "c" is already done');
    expect(r.text).toContain("Jev ended the batch at step 3. Steps 4-4 were not run");
    expect(jev.goals).toEqual(["a", "b", "c"]);
    expect(r.text).not.toContain("not confident");
  });

  it(`rejects more than ${MAX_ACT_STEPS} steps`, async () => {
    const { exec } = setup(new FakeX(), { jev: smartJev() });
    const r = await exec.call("act", { steps: Array.from({ length: MAX_ACT_STEPS + 1 }, () => ({ goal: "g" })) });
    expect(r.isError).toBe(true);
  });
});

describe("createToolExecutor: Jev picks the elements", () => {
  it("read_page lists elements in words, without index numbers (file inputs keep their upload index)", async () => {
    const x = new FakeX({ url: "https://x.com/home" });
    const { exec } = setup(x, { jev: smartJev() });
    const r = (await exec.call("read_page", {})).text!;
    expect(r).toContain("URL: https://x.com/home");
    expect(r).toMatch(/no index numbers: describe the one you want in words in act/);
    expect(r).toContain('button "Account menu" (testid=SideNav_AccountSwitcher_Button, text="alice @alice")');
    expect(r).toContain('textbox "Post text" (testid=tweetTextarea_0)');
    expect(r).toContain('file input "Choose files" (upload index 3)');
    expect(r).toContain("--- visible text ---");
    expect(r).not.toMatch(/^\[\d+\]/m);
    // Without Jev: the numbered list, as before.
    const plain = (await setup(x).exec.call("read_page", {})).text!;
    expect(plain).toMatch(/^\[2\] textbox "Post text"/m);
  });

  it("merges look-alike elements and caps the list", () => {
    const els = Array.from({ length: 200 }, (_, i) => ({
      index: i,
      tag: "button",
      role: "button",
      name: i < 5 ? "Reply" : `b${i}`,
      inViewport: i < 100,
    }));
    const list = formatElementsInWords(els, false, 150);
    const lines = list.split("\n");
    expect(lines[0]).toBe('button "Reply" ×5');
    expect(lines).toHaveLength(151);
    expect(lines.at(-1)).toBe("(46 more elements not listed, out of view; scroll, or describe what you need)");
    expect(list).toContain('button "b100" (offscreen)');
  });

  it("marks elements of an open dialog and keeps them apart from look-alikes behind it", () => {
    const list = formatElementsInWords([
      { index: 0, tag: "button", role: "button", name: "Post", testId: "tweetButton", inViewport: true },
      { index: 1, tag: "button", role: "button", name: "Post", testId: "tweetButton", inViewport: true, inDialog: true },
    ]);
    expect(list.split("\n")).toEqual(['button "Post" (testid=tweetButton)', 'button "Post" (testid=tweetButton, in dialog)']);
  });

  it("read_page with tabs uses the words list per tab too", async () => {
    const tabs = new FakeTabs();
    const { exec } = setup(new FakeX(), { browser: tabs.caller(), jev: smartJev() });
    await exec.call("open_tabs", { urls: ["https://mail.test/m/1", "https://mail.test/m/2"] });
    const r = (await exec.call("read_page", { tabs: ["t2", "t3"] })).text!;
    expect(r).toContain("===== Tab t2 =====");
    expect(r).toMatch(/no index numbers/);
    expect(r).not.toMatch(/^\[\d+\]/m);
    expect(r).toContain("(20 more elements not listed, out of view; scroll, or describe what you need)");
  });

  it("refuses steps that name an index unless Jev just was not confident about them; nothing runs", async () => {
    const x = new FakeX({ url: "https://x.com/home" });
    const { exec } = setup(x, { jev: smartJev() });
    const r = await exec.call("act", { steps: [{ goal: "type the post", text: "gm", index: 2 }, { goal: "click the post button" }] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("act refused; nothing was run.");
    expect(r.text).toMatch(/step 1 \("type the post"\) names element \[2\], but Jev was not asked about this step yet/);
    expect(r.text).toMatch(/describe each element in words instead/);
    expect(x.calls.filter((c) => c.method !== "browser.readPage")).toEqual([]);
  });

  it("when Jev is unsure it returns candidates for that step only; the same goal may then name one of them, once", async () => {
    const x = new FakeX({ url: "https://x.com/home" });
    const jev = fakeJev((goal, snap) =>
      goal === "open the menu thing"
        ? { operation: "click", index: 0, confidence: 0.4, ranked: [0, 1] }
        : { operation: "click", index: snap.elements.find((e) => e.name === "Home")!.index, confidence: 0.95 },
    );
    const { exec, events } = setup(x, { jev });
    const r1 = await exec.call("act", { steps: [{ goal: "go home" }, { goal: "open the menu thing" }, { goal: "go home" }] });
    expect(r1.isError).toBeUndefined();
    expect(r1.text).toContain("not confident at step 2. Steps 3-3 were not run.");
    expect(r1.text).toContain("Candidates for step 2");
    expect(r1.text).toMatch(/^\[0\] button "Account menu"/m);
    expect(r1.text).toContain('e.g. {goal: "open the menu thing", index: <n>}');
    // Another goal may not name an index; neither may an index that was not offered.
    const other = await exec.call("act", { steps: [{ goal: "open the menu thing" }, { goal: "something else", index: 0 }] });
    expect(other.isError).toBe(true);
    const notOffered = await exec.call("act", { steps: [{ goal: "open the menu thing", index: 99 }] });
    expect(notOffered.isError).toBe(true);
    expect(notOffered.text).toMatch(/\[99\] is not one of the candidates listed for it/);
    // The offer survives refusals and read_page, then works once (goal matched case-insensitively).
    await exec.call("read_page", {});
    const r2 = await exec.call("act", { steps: [{ goal: "Open the  menu thing", index: 0 }, { goal: "go home" }] });
    expect(r2.isError).toBeUndefined();
    expect(r2.text).toContain("step 1: clicked [0] (picked by Claude)");
    expect(r2.text).toMatch(/step 2: clicked \[\d+\] link "Home" .*picked by Jev/);
    // The trailing page is in words too.
    expect(r2.text).not.toMatch(/^\[\d+\] link "Home"/m);
    const again = await exec.call("act", { steps: [{ goal: "open the menu thing", index: 0 }] });
    expect(again.isError).toBe(true);
    // Picks: Jev 2 (both "go home"), Claude 1; taking them resets the count.
    expect(exec.takePicks()).toEqual({ jev: 2, claude: 1 });
    expect(exec.takePicks()).toEqual({ jev: 0, claude: 0 });
    expect(events.filter((e) => e.type === "jev").map((e) => (e as { executed: boolean }).executed)).toEqual([true, false, true]);
  });

  it("a page-changing tool closes the offer", async () => {
    const x = new FakeX({ url: "https://x.com/home" });
    const { exec } = setup(x, { jev: fakeJev([{ operation: "click", index: 1, confidence: 0.3 }]) });
    await exec.call("act", { steps: [{ goal: "open it" }] });
    await exec.call("navigate", { url: "https://x.com/home" });
    const r = await exec.call("act", { steps: [{ goal: "open it", index: 1 }] });
    expect(r.isError).toBe(true);
  });

  it("candidates: at most 40, Jev's own ranking first, then by words shared with the goal", () => {
    const elements = Array.from({ length: 120 }, (_, i) => ({
      index: i,
      tag: "button",
      role: "button",
      name: i === 90 ? "Save draft" : i === 110 ? "Delete" : `item ${i}`,
      inViewport: i < 60,
    }));
    const snap = { url: "https://a.test/", title: "A", text: "", truncated: false, elements };
    const c = rankCandidates(snap, "click the Save draft button", [110]);
    expect(c).toHaveLength(40);
    expect(c.map((e) => e.index)).toContain(110);
    expect(c.map((e) => e.index)).toContain(90);
    // Page order.
    expect(c.map((e) => e.index)).toEqual([...c.map((e) => e.index)].sort((a, b) => a - b));
  });

  it("picksEvent: the end-of-turn status line", () => {
    expect(picksEvent({ jev: 9, claude: 2 })).toEqual({
      type: "status",
      text: "Jev chose 9 of 11 element picks (clicks and typing); Claude chose 2",
      picks: { jev: 9, claude: 2 },
    });
    expect(picksEvent({ jev: 0, claude: 0 })).toBeNull();
  });

  it("goalKey ignores case and extra spaces", () => {
    expect(goalKey("  Click  the Post\tbutton ")).toBe("click the post button");
  });
});

describe("browser notes", () => {
  it("puts a note from the browser in front of that tool's result, once", async () => {
    let first = true;
    const browser = {
      call: async (method: string) => {
        if (method === "browser.readPage") {
          const r = { url: "https://mail.example.com/", title: "Mail", text: "inbox", elements: [], truncated: false };
          if (first) {
            first = false;
            return { ...r, note: "(Using fallback mode: another extension's frame on this page blocks Chrome's debugger.)" };
          }
          return r;
        }
        return { ok: true };
      },
    };
    const events: any[] = [];
    const { createToolExecutor } = await import("../src/executor.js");
    const exec = createToolExecutor({ browser: browser as never, jev: null, jevThreshold: 0.8, onEvent: (e) => events.push(e), mediaPaths: [] });
    const r1 = await exec.call("read_page", {});
    expect(r1.text?.startsWith("(Using fallback mode")).toBe(true);
    expect(events.find((e) => e.type === "tool_result")!.text).toMatch(/^\(Using fallback mode/);
    const r2 = await exec.call("read_page", {});
    expect(r2.text).not.toMatch(/fallback/);
  });

  it("switch_x_account results carry the browser's note too", async () => {
    const x = new FakeX({ account: "alice" });
    const inner = x.caller();
    const note = "(Using fallback mode.)";
    const browser: BrowserCaller = { call: async (method, params) => ({ ...(await inner.call(method, params)), note }) as never };
    const r = await setup(x, { browser }).exec.call("switch_x_account", { handle: "bob" });
    expect(r.text).toMatch(/^\(Using fallback mode\.\)\nSwitched to @bob\./);
  });
});

describe("act: failures after Jev picked", () => {
  it("a Jev-picked element that cannot be used stops the batch and keeps the steps that ran", async () => {
    const x = new FakeX({ url: "https://x.com/home" });
    const inner = x.caller();
    let clicks = 0;
    const browser: BrowserCaller = {
      call: (method, params) => (method === "browser.click" && clicks++ === 1 ? Promise.reject(new Error("node detached")) : inner.call(method, params)),
    };
    const { exec, events } = setup(x, { browser, jev: fakeJev([{ operation: "click", index: 1, confidence: 0.95 }]) });
    const r = await exec.call("act", { steps: [{ goal: "go home" }, { goal: "go home again" }, { goal: "never run" }] });
    expect(r.isError).toBeUndefined();
    expect(r.text).toMatch(/step 1: clicked \[1\] link "Home"/);
    expect(r.text).toContain('step 2: "go home again": could not use element [1]: node detached');
    expect(r.text).toContain("not confident at step 2. Steps 3-3 were not run.");
    expect(events.filter((e) => e.type === "jev").map((e) => (e as { executed: boolean }).executed)).toEqual([true, false]);
  });

  it("Jev out of usage credit pauses the task instead of asking Jev again", async () => {
    const x = new FakeX({ url: "https://x.com/home" });
    let asked = 0;
    const jev: JevLike = {
      decide: async () => {
        if (asked++ === 0) return { operation: "click", index: 1, confidence: 0.95 };
        throw new OutOfCreditError(`${OUT_OF_CREDIT}: No usage credit left`);
      },
    };
    const { exec, ended } = setup(x, { jev });
    const r = await exec.call("act", { steps: [{ goal: "go home" }, { goal: "open the composer" }, { goal: "never run" }] });
    expect(ended).toEqual([{ outcome: "paused", reason: OUT_OF_CREDIT }]);
    expect(r.text).toMatch(/step 1: clicked \[1\] link "Home"/);
    expect(r.text).toContain(`step 2: "open the composer": ${OUT_OF_CREDIT}: No usage credit left`);
    expect(r.text).toMatch(/Task paused.*Stop now\.$/);
    expect(asked).toBe(2);
  });
});

/** A browser with several tabs: each tab has a URL, the current tab gets the single-tab calls. */
class FakeTabs {
  tabs = [{ id: "t1", url: "https://mail.test/search" }];
  current = "t1";
  next = 2;
  calls: { method: string; params: any; tab: string }[] = [];
  failRead = new Set<string>();
  caller(): BrowserCaller {
    return {
      call: async (method: string, params: any): Promise<any> => {
        this.calls.push({ method, params, tab: this.current });
        const info = (t: { id: string; url: string }) => ({ id: t.id, url: t.url, title: `Title ${t.url}`, current: t.id === this.current });
        switch (method) {
          case "browser.openTabs": {
            const made = params.urls.map((url: string) => ({ id: `t${this.next++}`, url }));
            this.tabs.push(...made);
            if (params.background === false) this.current = made[0].id;
            return { tabs: made.map(info) };
          }
          case "browser.switchTab": {
            const t = this.tabs.find((x) => x.id === params.tab);
            if (!t) throw new Error(`unknown tab "${params.tab}"; call list_tabs`);
            this.current = t.id;
            return info(t);
          }
          case "browser.listTabs":
            return { tabs: this.tabs.map(info) };
          case "browser.closeTabs": {
            this.tabs = this.tabs.filter((t) => !params.tabs.includes(t.id));
            if (!this.tabs.some((t) => t.id === this.current)) this.current = "t1";
            return { closed: params.tabs, tabs: this.tabs.map(info) };
          }
          case "browser.readPage": {
            const id = params.tab ?? this.current;
            if (this.failRead.has(id)) throw new Error(`tab ${id} was closed`);
            const t = this.tabs.find((x) => x.id === id)!;
            const elements = Array.from({ length: id === "t3" ? 100 : 1 }, (_, i) => ({ index: i, tag: "a", role: "link", name: `link ${i}`, inViewport: true }));
            return { url: t.url, title: `Title ${t.url}`, text: `body of ${t.url}`, elements, truncated: false };
          }
          default:
            return { ok: true };
        }
      },
    } as BrowserCaller;
  }
}

describe("createToolExecutor: several tabs", () => {
  const multi = () => {
    const tabs = new FakeTabs();
    const { exec, events } = setup(new FakeX(), { browser: tabs.caller() });
    return { tabs, exec, events };
  };

  it("open_tabs returns the new tab ids and how to read them together", async () => {
    const { tabs, exec, events } = multi();
    const r = await exec.call("open_tabs", { urls: ["https://mail.test/m/1", "https://mail.test/m/2"] });
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain("Opened 2 tab(s):");
    expect(r.text).toContain('t2 https://mail.test/m/1 "Title https://mail.test/m/1"');
    expect(r.text).toContain('read_page {"tabs": ["t2","t3"]}');
    expect(tabs.calls[0]).toMatchObject({ method: "browser.openTabs", params: { urls: ["https://mail.test/m/1", "https://mail.test/m/2"] } });
    expect(tabs.calls[0]!.params).not.toHaveProperty("background");
    expect(events.map((e) => e.type)).toEqual(["tool_call", "tool_result"]);
    await exec.call("open_tabs", { urls: ["https://mail.test/m/3"], background: false });
    expect(tabs.calls[1]!.params).toEqual({ urls: ["https://mail.test/m/3"], background: false });
    expect(tabs.current).toBe("t4");
  });

  it("read_page with tabs reads every tab in one result, each under its own header", async () => {
    const { tabs, exec } = multi();
    await exec.call("open_tabs", { urls: ["https://mail.test/m/1", "https://mail.test/m/2", "https://mail.test/m/3"] });
    const r = await exec.call("read_page", { tabs: ["t2", "t3", "t4", "t2"] });
    expect(r.isError).toBeUndefined();
    const reads = tabs.calls.filter((c) => c.method === "browser.readPage");
    expect(reads.map((c) => c.params)).toEqual([{ tab: "t2" }, { tab: "t3" }, { tab: "t4" }]);
    const text = r.text!;
    expect(text.indexOf("===== Tab t2 =====")).toBeLessThan(text.indexOf("===== Tab t3 ====="));
    expect(text.indexOf("===== Tab t3 =====")).toBeLessThan(text.indexOf("===== Tab t4 ====="));
    expect(text).toContain("body of https://mail.test/m/1");
    expect(text).toContain("body of https://mail.test/m/3");
    // A long element list is cut per tab, with a pointer to the full list.
    expect(text).toContain("(20 more elements; switch_tab to t3 and call read_page for the full list)");
    expect(text).not.toContain('"link 80"');
    // The default read_page is unchanged: the current tab, no header.
    const plain = await exec.call("read_page", {});
    expect(tabs.calls.at(-1)!.params).toEqual({});
    expect(plain.text).toMatch(/^URL: https:\/\/mail\.test\/search/);
  });

  it("read_page with tabs shows a failing tab's error next to the others, and errors only when all fail", async () => {
    const { tabs, exec } = multi();
    await exec.call("open_tabs", { urls: ["https://mail.test/m/1", "https://mail.test/m/2"] });
    tabs.failRead.add("t3");
    const r = await exec.call("read_page", { tabs: ["t2", "t3"] });
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain("===== Tab t3 =====\nCould not read this tab: tab t3 was closed");
    expect(r.text).toContain("body of https://mail.test/m/1");
    tabs.failRead.add("t2");
    expect((await exec.call("read_page", { tabs: ["t2", "t3"] })).isError).toBe(true);
  });

  it("switch_tab makes later tools act on that tab", async () => {
    const { tabs, exec } = multi();
    await exec.call("open_tabs", { urls: ["https://mail.test/m/1"] });
    const r = await exec.call("switch_tab", { tab: "t2" });
    expect(r.text).toBe("Current tab is now t2: https://mail.test/m/1\nTitle: Title https://mail.test/m/1");
    await exec.call("act", { steps: [{ goal: "open reply", index: 0 }] });
    await exec.call("scroll", { direction: "down" });
    const after = tabs.calls.filter((c) => c.method === "browser.click" || c.method === "browser.scroll");
    expect(after.map((c) => c.tab)).toEqual(["t2", "t2"]);
    const bad = await exec.call("switch_tab", { tab: "t9" });
    expect(bad).toMatchObject({ isError: true, text: expect.stringContaining('unknown tab "t9"') });
  });

  it("list_tabs and close_tabs", async () => {
    const { tabs, exec } = multi();
    await exec.call("open_tabs", { urls: ["https://mail.test/m/1", "https://mail.test/m/2"] });
    await exec.call("switch_tab", { tab: "t3" });
    const list = await exec.call("list_tabs", {});
    expect(list.text!.split("\n")).toEqual([
      't1 https://mail.test/search "Title https://mail.test/search"',
      't2 https://mail.test/m/1 "Title https://mail.test/m/1"',
      't3 (current) https://mail.test/m/2 "Title https://mail.test/m/2"',
    ]);
    const closed = await exec.call("close_tabs", { tabs: ["t2", "t3"] });
    expect(closed.text).toBe('Closed t2, t3. Open tabs:\nt1 (current) https://mail.test/search "Title https://mail.test/search"');
    expect(tabs.current).toBe("t1");
    expect((await exec.call("close_tabs", { tabs: [] })).isError).toBe(true);
  });

  it("the prompts tell the model to open several pages at once", async () => {
    const { buildSystemPrompt } = await import("../src/index.js");
    const { TOOL_NAMES } = await import("@noa/shared");
    const task = buildSystemPrompt({ tools: TOOL_NAMES, jev: true });
    expect(task).toContain("- open_tabs:");
    expect(task).toMatch(/open them together with open_tabs .* one read_page call using `tabs`/);
    expect(task).toMatch(/Tabs you opened stay open for this chat until it ends: .* ask them to do it in that tab/);
    expect(buildSystemPrompt({ tools: ["navigate", "read_page"], jev: false })).not.toContain("open_tabs");
  });
});

describe("scroll reports what moved", () => {
  const scrollWith = async (result: Record<string, unknown>, args: Record<string, unknown> = { direction: "down" }) => {
    const x = new FakeX();
    const browser = {
      call: async (method: string, params: unknown) => (method === "browser.scroll" ? { ok: true, ...result } : x.caller().call(method as never, params as never)),
    } as BrowserCaller;
    const { exec } = setup(x, { browser });
    return exec.call("scroll", args);
  };

  it("the page moved: pixels, position and percentage", async () => {
    const r = await scrollWith({ moved: 640, target: "page", position: 1280, size: 5400, view: 800 });
    expect(r.text).toBe("Scrolled down 640 px (now 1,280 of 5,400; 28% down).");
  });

  it("reaching the end says so", async () => {
    const r = await scrollWith({ moved: 300, target: "page", position: 4600, size: 5400, view: 800 });
    expect(r.text).toBe("Scrolled down 300 px (now 4,600 of 5,400; 100% down; at the bottom).");
  });

  it("nothing moved at the bottom, at the top, and where nothing scrolls", async () => {
    expect((await scrollWith({ moved: 0, target: "page", position: 4600, size: 5400, view: 800, reason: "end" })).text).toBe(
      "Nothing moved: the page is already at the bottom.",
    );
    expect((await scrollWith({ moved: 0, target: "page", position: 0, size: 5400, view: 800, reason: "end" }, { direction: "up" })).text).toBe(
      "Nothing moved: the page is already at the top.",
    );
    expect((await scrollWith({ moved: 0, target: "page", position: 0, size: 800, view: 800, reason: "fixed" })).text).toBe(
      "Nothing moved: this part of the page doesn't scroll; try scrolling inside an element (give its index).",
    );
    expect((await scrollWith({ moved: 0, target: "page", position: 0, size: 800, view: 800, reason: "fixed" }, { direction: "down", index: 4 })).text).toBe(
      "Nothing moved: [4] and the page around it don't scroll down.",
    );
    expect((await scrollWith({ moved: 0, target: "container", containerIndex: 7, position: 900, size: 1200, view: 300, reason: "end" }, { direction: "down", index: 9 })).text).toBe(
      "Nothing moved: [7] is already at the bottom.",
    );
    expect((await scrollWith({ moved: 0, target: "page", position: 100, size: 5400, view: 800, reason: "ignored" })).text).toMatch(
      /^Nothing moved: the page can scroll down \(now 100 of 5,400\) but did not react to the wheel; try press_key PageDown/,
    );
  });

  it("an inner container that scrolled instead of the page, and one given by index", async () => {
    expect((await scrollWith({ moved: 400, target: "container", position: 400, size: 2000, view: 500 })).text).toBe(
      "Scrolled down 400 px inside a scrollable area of the page, not the page itself (now 400 of 2,000; 27% down).",
    );
    expect((await scrollWith({ moved: 400, target: "container", containerIndex: 12, position: 400, size: 2000, view: 500 })).text).toContain(
      "inside [12] of the page, not the page itself",
    );
    expect((await scrollWith({ moved: 800, target: "container", containerIndex: 3, position: 800, size: 3000, view: 1000 }, { direction: "right", index: 3 })).text).toBe(
      "Scrolled right 800 px inside [3] (now 800 of 3,000; 40% across).",
    );
  });

  it("drivers that do not measure keep the old answer", async () => {
    expect((await scrollWith({}, { direction: "down", amount: 2 })).text).toBe("Scrolled down 2x.");
  });
});

describe("createToolExecutor: the TODO tools", () => {
  const args = { task: "Open https://shop.example.com/orders/48213 and tell me whether it shipped.", schedule: { at: "2026-09-26T22:45:00-04:00" } };
  const executor = (todo: ToolExecutorOptions["todo"]) =>
    createToolExecutor({ browser: new FakeX().caller(), jev: null, jevThreshold: 0.8, onEvent: () => {}, mediaPaths: [], sleep: noSleep, ...(todo ? { todo } : {}) });

  it("hands each tool's parsed arguments to the conversation's TODO list and relays its answer", async () => {
    const x = new FakeX();
    const got: [string, unknown][] = [];
    const exec = createToolExecutor({
      browser: x.caller(),
      jev: null,
      jevThreshold: 0.8,
      onEvent: () => {},
      mediaPaths: [],
      sleep: noSleep,
      todo: async (tool, a) => {
        got.push([tool, a]);
        return { text: `${tool} done` };
      },
    });
    const r = await exec.call("schedule_task", { ...args, task: `  ${args.task}  ` });
    expect(r).toEqual({ text: "schedule_task done" });
    expect((await exec.call("list_scheduled_tasks", {})).text).toBe("list_scheduled_tasks done");
    expect((await exec.call("update_scheduled_task", { task_id: " t9 ", schedule: { at: "2026-10-02T15:00:00-04:00" } })).text).toBe("update_scheduled_task done");
    expect((await exec.call("cancel_scheduled_task", { task_id: "t9" })).text).toBe("cancel_scheduled_task done");
    expect(got).toEqual([
      ["schedule_task", args],
      ["list_scheduled_tasks", {}],
      ["update_scheduled_task", { task_id: "t9", schedule: { at: "2026-10-02T15:00:00-04:00" } }],
      ["cancel_scheduled_task", { task_id: "t9" }],
    ]);
    // Nothing happens in the browser.
    expect(x.calls).toEqual([]);
  });

  it("a refusal reaches the model as an error with the extension's words", async () => {
    const exec = executor(async () => ({ text: "Scheduling needs a paid plan. Nothing was scheduled.", isError: true }));
    expect(await exec.call("schedule_task", args)).toEqual({ isError: true, text: "Scheduling needs a paid plan. Nothing was scheduled." });
  });

  it("bad arguments and a session without a conversation are refused", async () => {
    const { exec } = setup(new FakeX());
    expect((await exec.call("schedule_task", { task: "x", schedule: {} })).text).toMatch(/Invalid arguments for schedule_task/);
    expect((await exec.call("update_scheduled_task", { task_id: "t1" })).text).toMatch(/Invalid arguments for update_scheduled_task/);
    for (const [tool, a] of [["schedule_task", args], ["list_scheduled_tasks", {}], ["cancel_scheduled_task", { task_id: "t1" }]] as const) {
      const r = await exec.call(tool, a);
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/the TODO list belongs to a Noa chat/);
    }
  });
});
