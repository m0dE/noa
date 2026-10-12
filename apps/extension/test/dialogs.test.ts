/** JavaScript dialogs (alert, confirm, prompt, "Leave site?") in the agent's tabs: cdp.ts, dialogs.ts and the driver. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DIALOG_AUTO_DISMISS_MS, type JsDialog } from "@noa/shared";
import { Cdp, DialogOpenError } from "../src/cdp.js";
import { closeTabsAsking, DialogWatch, type DialogEvent } from "../src/dialogs.js";
import { Driver } from "../src/driver.js";
import { DRAWN, driverHarness, runInUserTab, type DriverHarness } from "./driver-harness.js";

const CONFIRM: JsDialog = { type: "confirm", message: "Delete this item?", url: "https://site.test/list" };
const LEAVE: JsDialog = { type: "beforeunload", message: "", url: "https://site.test/editor" };
const ALERT: JsDialog = { type: "alert", message: "Saved!", url: "https://site.test/" };

/** Chrome tells the debugger a dialog opened in the tab. */
const opens = (cdp: Cdp, tabId: number, d: JsDialog) =>
  cdp.handleEvent({ tabId }, "Page.javascriptDialogOpening", { type: d.type, message: d.message, url: d.url, hasBrowserHandler: true, defaultPrompt: d.defaultPrompt ?? "" });
/** Chrome tells the debugger the tab's dialog closed. */
const closes = (cdp: Cdp, tabId: number, accepted: boolean, userInput = "") => cdp.handleEvent({ tabId }, "Page.javascriptDialogClosed", { result: accepted, userInput });

/** A command Chrome answers only once the page's dialog is answered (the page is frozen). */
const never = () => new Promise<never>(() => {});

let h: DriverHarness;
let tabId: number;

beforeEach(async () => {
  h = driverHarness();
  ({ tabId } = await runInUserTab(h, "https://site.test/"));
  h.chrome.debugger.respond = (method) => (method === "Runtime.evaluate" ? { result: { value: { url: "https://site.test/", title: "Site", text: "A page of the site with enough text.", elements: DRAWN, truncated: false } } } : {});
});

describe("Cdp: the dialogs of attached tabs", () => {
  it("turns the Page domain on as it attaches, so dialogs are reported", async () => {
    await h.cdp.attach(tabId);
    expect(h.chrome.debugger.commands.map((c) => c.method)).toContain("Page.enable");
  });

  it("while a dialog is open, a command on that tab fails at once with its text; other tabs and answering it still work", async () => {
    const other = (await h.chrome.tabs.create({ url: "https://other.test/" })).id;
    await h.cdp.attach(tabId);
    opens(h.cdp, tabId, CONFIRM);
    expect(h.cdp.dialogOf(tabId)).toEqual(CONFIRM);
    const sent = h.chrome.debugger.commands.length;
    await expect(h.cdp.send("Runtime.evaluate", { expression: "1" })).rejects.toThrow('A browser dialog is open: confirm “Delete this item?”. The page is frozen until it is answered: call handle_dialog');
    expect(h.chrome.debugger.commands.length).toBe(sent);
    await expect(h.cdp.sendTo(other, "Runtime.evaluate", { expression: "1" })).resolves.toBeDefined();
    await h.cdp.handleDialog(tabId, false);
    expect(h.chrome.debugger.commands.at(-1)).toEqual({ tabId, method: "Page.handleJavaScriptDialog", params: { accept: false } });
  });

  it("a command in flight when a dialog opens (the click that opened it) fails at once instead of waiting for the answer", async () => {
    await h.cdp.attach(tabId);
    // The page opens the dialog while it handles the press: Chrome answers the press only once the dialog is answered.
    h.chrome.debugger.respond = (method) => (method === "Input.dispatchMouseEvent" ? (queueMicrotask(() => opens(h.cdp, tabId, CONFIRM)), never()) : {});
    const err = await h.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DialogOpenError);
    expect((err as DialogOpenError).dialog).toEqual(CONFIRM);
  });

  it("tells its listeners when a dialog opens and how it closed; a detach ends it with no answer", async () => {
    await h.cdp.attach(tabId);
    const seen: string[] = [];
    h.cdp.onDialog((c) => seen.push(c.state === "open" ? `open ${c.dialog.type}` : `closed ${c.dialog.type} ${JSON.stringify(c.answer)}`));
    opens(h.cdp, tabId, { type: "prompt", message: "Your name?", url: "https://site.test/", defaultPrompt: "Ann" });
    expect(h.cdp.dialogOf(tabId)).toMatchObject({ type: "prompt", defaultPrompt: "Ann" });
    closes(h.cdp, tabId, true, "Bo");
    opens(h.cdp, tabId, LEAVE);
    h.cdp.handleDetach({ tabId }, "target_closed");
    expect(seen).toEqual(['open prompt', 'closed prompt {"accepted":true,"text":"Bo"}', "open beforeunload", "closed beforeunload null"]);
    expect(h.cdp.dialogOf(tabId)).toBeNull();
  });
});

describe("DialogWatch: a run's dialogs", () => {
  let events: { sessionId: string; event: DialogEvent }[];
  let session: string | null;
  let watch: DialogWatch;
  const tabOf = (id: number) => Promise.resolve(id === tabId ? "t1" : null);
  /** Lets the watch look up the tab's short id. */
  const settle = () => vi.advanceTimersByTimeAsync(0);

  beforeEach(async () => {
    vi.useFakeTimers();
    events = [];
    session = "s1";
    await h.cdp.attach(tabId);
    watch = new DialogWatch({ cdp: h.cdp, session: () => session, shortId: tabOf, emit: (sessionId, event) => events.push({ sessionId, event }) });
  });
  afterEach(() => vi.useRealTimers());

  const answers = () => h.chrome.debugger.commands.filter((c) => c.method === "Page.handleJavaScriptDialog").map((c) => c.params);

  it("nobody answers in time: a confirm is cancelled, the run gets its line, and the agent is told", async () => {
    opens(h.cdp, tabId, CONFIRM);
    await settle();
    await vi.advanceTimersByTimeAsync(DIALOG_AUTO_DISMISS_MS - 1);
    expect(answers()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(answers()).toEqual([{ accept: false }]);
    closes(h.cdp, tabId, false);
    expect(events).toEqual([{ sessionId: "s1", event: { type: "dialog", dialog: CONFIRM, outcome: "dismissed", by: "auto", tab: "t1" } }]);
    expect(watch.takeNotes()).toEqual(["The browser dialog confirm “Delete this item?” in t1 was cancelled automatically: nobody answered it within 10 s. The page did not get an OK."]);
    expect(watch.takeNotes()).toEqual([]);
    expect(watch.lastAutoAnswered(tabId)).toEqual(CONFIRM);
  });

  it('an alert is just closed (OK); "Leave site?" is answered Stay, never Leave', async () => {
    opens(h.cdp, tabId, ALERT);
    await settle();
    await vi.advanceTimersByTimeAsync(DIALOG_AUTO_DISMISS_MS);
    closes(h.cdp, tabId, true);
    opens(h.cdp, tabId, LEAVE);
    await settle();
    await vi.advanceTimersByTimeAsync(DIALOG_AUTO_DISMISS_MS);
    closes(h.cdp, tabId, false);
    expect(answers()).toEqual([{ accept: true }, { accept: false }]);
    expect(events.map((e) => `${e.event.dialog.type} ${e.event.outcome} ${e.event.by}`)).toEqual(["alert accepted auto", "beforeunload dismissed auto"]);
  });

  it("the agent's answer is the agent's: nothing is answered for it", async () => {
    opens(h.cdp, tabId, CONFIRM);
    await settle();
    watch.answering(tabId, true);
    await vi.advanceTimersByTimeAsync(DIALOG_AUTO_DISMISS_MS * 2);
    closes(h.cdp, tabId, true);
    expect(answers()).toEqual([]);
    expect(events.map((e) => e.event)).toEqual([{ type: "dialog", dialog: CONFIRM, outcome: "accepted", by: "agent", tab: "t1" }]);
    expect(watch.takeNotes()).toEqual([]);
  });

  it("while an approval waits for the user nothing is answered; after it, the full wait starts again", async () => {
    opens(h.cdp, tabId, CONFIRM);
    await settle();
    await vi.advanceTimersByTimeAsync(DIALOG_AUTO_DISMISS_MS - 1000);
    const release = watch.hold();
    await vi.advanceTimersByTimeAsync(DIALOG_AUTO_DISMISS_MS * 5);
    expect(answers()).toEqual([]);
    release();
    release();
    await vi.advanceTimersByTimeAsync(DIALOG_AUTO_DISMISS_MS - 1);
    expect(answers()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(answers()).toEqual([{ accept: false }]);
  });

  it("an answer given in the browser (Chrome's own dialog) is the user's, with a prompt's text", async () => {
    opens(h.cdp, tabId, { type: "prompt", message: "Your name?", url: "https://site.test/" });
    await settle();
    closes(h.cdp, tabId, true, "Bo");
    expect(events.map((e) => e.event)).toEqual([{ type: "dialog", dialog: { type: "prompt", message: "Your name?", url: "https://site.test/" }, outcome: "accepted", by: "user", tab: "t1", text: "Bo" }]);
  });

  it("a dialog with no run (between runs), or in a tab that is not the run's, is left alone", async () => {
    session = null;
    opens(h.cdp, tabId, CONFIRM);
    await settle();
    await vi.advanceTimersByTimeAsync(DIALOG_AUTO_DISMISS_MS * 2);
    closes(h.cdp, tabId, false);
    const other = (await h.chrome.tabs.create({ url: "https://other.test/" })).id;
    await h.cdp.ensure(other);
    session = "s1";
    opens(h.cdp, other, CONFIRM);
    await settle();
    await vi.advanceTimersByTimeAsync(DIALOG_AUTO_DISMISS_MS * 2);
    expect(answers()).toEqual([]);
    expect(events).toEqual([]);
  });
});

describe("Driver: the agent's calls on a frozen page", () => {
  it("read_page on a page with an open dialog fails at once, sending nothing to it; another tab's read names that tab", async () => {
    await h.driver.ready();
    opens(h.cdp, tabId, CONFIRM);
    const sent = h.chrome.debugger.commands.length;
    await expect(h.driver.readPage()).rejects.toThrow("A browser dialog is open: confirm “Delete this item?”.");
    expect(h.chrome.debugger.commands.length).toBe(sent);
    closes(h.cdp, tabId, false);
    const [t2] = (await h.driver.openTabs({ urls: ["https://site.test/editor"] })).tabs;
    const t2Id = await h.agent.resolve(t2!.id);
    await h.cdp.ensure(t2Id);
    opens(h.cdp, t2Id, LEAVE);
    await expect(h.driver.readPage({ tab: "t2" })).rejects.toThrow("A browser dialog is open: beforeunload “Leave site? Changes you made may not be saved.” in t2. The page is frozen until it is answered: call handle_dialog with tab t2");
  });

  it("a click whose press opens a confirm answers at once with the dialog, not when someone answers it", async () => {
    await h.driver.ready();
    h.chrome.debugger.respond = (method, params) => {
      if (method === "Runtime.evaluate") return { result: { value: { ok: true, value: { x: 5, y: 5, checkable: false, checked: false, radio: false } } } };
      if (method === "Input.dispatchMouseEvent" && (params as { type: string }).type === "mouseReleased") {
        queueMicrotask(() => opens(h.cdp, tabId, CONFIRM));
        return never();
      }
      return {};
    };
    await expect(h.driver.click({ index: 3 })).rejects.toThrow("A browser dialog is open: confirm “Delete this item?”");
  });

  it("handleDialog answers the tab's dialog (a prompt with its text, or its prefilled answer) and says which it was", async () => {
    await h.driver.ready();
    opens(h.cdp, tabId, { type: "prompt", message: "Your name?", url: "https://site.test/", defaultPrompt: "Ann" });
    expect(await h.driver.handleDialog({ accept: true, text: "Bo" })).toEqual({ tab: "t1", dialog: { type: "prompt", message: "Your name?", url: "https://site.test/", defaultPrompt: "Ann" }, accepted: true });
    expect(h.chrome.debugger.commands.at(-1)).toMatchObject({ method: "Page.handleJavaScriptDialog", params: { accept: true, promptText: "Bo" } });
    closes(h.cdp, tabId, true, "Bo");
    opens(h.cdp, tabId, { type: "prompt", message: "Your name?", url: "https://site.test/", defaultPrompt: "Ann" });
    await h.driver.handleDialog({ accept: true });
    expect(h.chrome.debugger.commands.at(-1)).toMatchObject({ params: { accept: true, promptText: "Ann" } });
    closes(h.cdp, tabId, true, "Ann");
    await expect(h.driver.handleDialog({ accept: false })).rejects.toThrow("No browser dialog is open in t1.");
  });

  it("close_tabs on a tab whose page asks \"Leave site?\" answers at once: the tab stays open with its dialog, and the result says so", async () => {
    await h.driver.ready();
    const [t2] = (await h.driver.openTabs({ urls: ["https://site.test/editor"] })).tabs;
    const t2Id = await h.agent.resolve(t2!.id);
    const remove = h.chrome.tabs.remove.bind(h.chrome.tabs);
    // Chrome asks the page first: its "Leave site?" holds the close up until someone answers.
    h.chrome.tabs.remove = (id: number) => (id === t2Id ? (queueMicrotask(() => opens(h.cdp, t2Id, LEAVE)), never()) : remove(id));
    const r = await h.driver.closeTabs({ tabs: ["t2"] });
    expect(r.closed).toEqual([]);
    expect(r.tabs.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(r.note).toBe("Not closed: A browser dialog is open: beforeunload “Leave site? Changes you made may not be saved.” in t2. The page is frozen until it is answered: call handle_dialog with tab t2 (accept false: Cancel / Stay on the page; true: OK / Leave).");
    expect(h.chrome.debugger.commands.filter((c) => c.method === "Page.handleJavaScriptDialog")).toEqual([]);
  });

  it("a run's cleanup never leaves a page silently: its \"Leave site?\" is answered Stay and the tab stays", async () => {
    const other = (await h.chrome.tabs.create({ url: "https://site.test/editor" })).id;
    const plain = (await h.chrome.tabs.create({ url: "https://site.test/" })).id;
    const remove = h.chrome.tabs.remove.bind(h.chrome.tabs);
    h.chrome.tabs.remove = (id: number) => (id === other ? (queueMicrotask(() => opens(h.cdp, other, LEAVE)), never()) : remove(id));
    const r = await closeTabsAsking(h.cdp, [other, plain], { cancel: true });
    expect(r).toEqual({ closed: [plain], asked: [{ tabId: other, dialog: LEAVE }] });
    expect(h.chrome.debugger.commands.filter((c) => c.method === "Page.handleJavaScriptDialog")).toEqual([{ tabId: other, method: "Page.handleJavaScriptDialog", params: { accept: false } }]);
  });

  it("a dialog answered automatically is told with the agent's next result", async () => {
    const notes: string[] = [];
    const watch = { takeNotes: () => notes.splice(0), lastAutoAnswered: () => CONFIRM, answering: () => {}, notAnswered: () => {} } as unknown as DialogWatch;
    const driver = new Driver(h.cdp, h.agent, { sleep: async () => {}, dialogs: watch });
    notes.push("The browser dialog confirm “Delete this item?” in t1 was cancelled automatically: nobody answered it within 10 s.");
    expect((await driver.readPage()).note).toBe("The browser dialog confirm “Delete this item?” in t1 was cancelled automatically: nobody answered it within 10 s.");
    expect((await driver.readPage()).note).toBeUndefined();
    await expect(driver.handleDialog({ accept: true })).rejects.toThrow(
      "No browser dialog is open in t1. Its last one, confirm “Delete this item?”, was answered automatically (Cancel) because nobody answered it in time.",
    );
  });
});
