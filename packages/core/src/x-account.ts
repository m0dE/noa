/**
 * X accounts: switch_x_account, which changes X to another signed-in account
 * through X's own account switcher, and the check that nothing is published
 * on X as another account than the task's.
 *
 * switch_x_account only ever clicks the switcher button and, inside the menu
 * it opens, the "Switch to @handle" entry of the target: never a Follow button,
 * a link on the page that happens to name the handle, or a delegate's "Act as".
 *
 * X's account menu, as the owner's run logs show it (Sep 2026, an account with
 * delegates): opened first after a page load it lists the other signed-in
 * accounts ('button "Switch to @h" (testid=UserCell)'); within about a second X
 * re-renders it with "Delegate accounts" expanded ('button "Act as"
 * (testid=UserCell)', a "View delegate accounts" item) and "Personal accounts"
 * folded into a header that is plain text, no element anything can click. The
 * re-render (0.3-1.6 s after the menu opens) replaces the menu's nodes, and
 * every later opening in that page load shows the delegate view at once. So
 * the switch opens the menu fresh (on the X page the tab shows, else on X home
 * reloaded), and picks the entry with
 * browser.clickXAccountEntry: found and clicked in one synchronous step in the
 * page, the moment the menu shows its accounts. (A debugger mouse press waits
 * about a second for a frame, and so once landed on the "Act as" cell that had
 * taken the entry's place.) When the entry is not there at that instant (X
 * flipped the menu first), it reloads and tries again. A page that ignores
 * that click gets a real mouse press on the same node instead, refused when X
 * replaced the node. The testIds must be re-checked against the live site.
 */
import {
  activeXAccount,
  isXUrl,
  normalizeHandle,
  pauseReasonForUrl,
  pollUntil,
  sameHandle,
  X_HOME_URL,
  X_SWITCHER_TEST_ID,
  type ElementInfo,
  type PageSnapshot,
  type Sleep,
  type ToolResult,
} from "@noa/shared";
import type { BrowserCaller } from "./types.js";

/** How long the page may wait for the freshly opened account menu to show its accounts. */
export const MENU_WAIT_MS = 3000;
/** How long X may take to close the menu after the entry's click (it starts the switch) before the click counts as ignored. */
export const TAKE_EFFECT_POLL = { intervalMs: 500, timeoutMs: 2000 };
/** How long X home may take after a reload to show its switcher. */
export const LOAD_POLL = { intervalMs: 500, timeoutMs: 15_000 };
/** How long X may take to show the new account in its switcher (a real switch took 10.7 s). */
export const SWITCH_POLL = { intervalMs: 1000, timeoutMs: 30_000 };
/** Fresh page loads to open the menu on before giving up (X flips it to delegate accounts within about a second). */
export const SWITCH_ATTEMPTS = 3;

/** X's account cells: in the menu a button ("Switch to @name", "Act as"); "Who to follow" cells on pages are list items. */
const ENTRY_TEST_ID = "UserCell";
const ENTRY_ROLES = new Set(["button", "menuitem"]);
/** A delegate account's cell ("Act as"): it acts on someone else's account; never clicked. */
const DELEGATE_NAME = /^act as\b/i;
/** X's confirm page for acting as a delegate (x.com/i/delegate/switch, seen in the owner's run logs). */
const DELEGATE_SWITCH_URL = /^https:\/\/(x|twitter)\.com\/i\/delegate\/switch\b/i;
/** A tab with nothing on it to lose: X is loaded in it rather than in a new tab. */
const BLANK_TAB = /^(about:blank|chrome:\/\/new-?tab(-page)?\/?)$|^$/i;
const HANDLE_IN =/@([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/g;

/** Buttons that publish on X as the signed-in account: Post (compose box, inline; Reply in a reply box) and Repost's confirm. */
const PUBLISH_TEST_IDS = new Set(["tweetButton", "tweetButtonInline", "retweetConfirm"]);
const PUBLISH_LABEL = /^(post|post all|reply|repost|quote)$/i;
/** X's keyboard shortcut for Post in a composer. */
const POST_SHORTCUT = /^(control|ctrl|meta|cmd|command)\+enter$/i;

/** True when `text` mentions exactly this handle (so @bob does not match @bobby). */
export function mentionsHandle(text: string, handle: string): boolean {
  const name = normalizeHandle(handle).slice(1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`@${name}(?![A-Za-z0-9_])`, "i").test(text);
}

/** Accessible name plus visible text; X's switcher button has aria-label "Account menu". */
function labelOf(e: ElementInfo): string {
  return e.text ? `${e.name} ${e.text}` : e.name;
}

const findSwitcher = (s: PageSnapshot) => s.elements.find((e) => e.testId === X_SWITCHER_TEST_ID);
const isCell = (e: ElementInfo) => e.testId === ENTRY_TEST_ID && ENTRY_ROLES.has(e.role) && !/\bfollow/i.test(labelOf(e));
const isDelegate = (e: ElementInfo) => isCell(e) && DELEGATE_NAME.test(e.name.trim());
/** The menu's personal accounts (signed in in this browser): its cells that are not a delegate's "Act as". */
const personalEntries = (s: PageSnapshot) => s.elements.filter((e) => isCell(e) && !isDelegate(e));
const entryFor = (s: PageSnapshot, handle: string) => personalEntries(s).find((e) => mentionsHandle(labelOf(e), handle));
const delegateView = (s: PageSnapshot) => s.elements.some(isDelegate);
const handlesIn = (els: ElementInfo[]) => [...new Set(els.flatMap((e) => [...labelOf(e).matchAll(HANDLE_IN)].map((m) => `@${m[1]}`)))];
const shows = (s: PageSnapshot, handle: string) => {
  const active = activeXAccount(s);
  return !!active && sameHandle(active, handle);
};

/** pollUntil from a value already read: checked as it is, then read again every interval (no read right after it). */
async function pollFrom<T>(first: T, read: () => Promise<T>, done: (value: T) => boolean, opts: { intervalMs: number; timeoutMs: number; sleep: Sleep }): Promise<{ value: T; ok: boolean }> {
  const polls = opts.intervalMs > 0 ? Math.ceil(opts.timeoutMs / opts.intervalMs) : 0;
  let value = first;
  for (let i = 0; i < polls && !done(value); i++) {
    await opts.sleep(opts.intervalMs);
    value = await read();
  }
  return { value, ok: done(value) };
}

export interface SwitchDeps {
  sleep: Sleep;
}

export async function switchXAccount(browser: BrowserCaller, rawHandle: string, deps: SwitchDeps): Promise<ToolResult> {
  const handle = normalizeHandle(rawHandle);
  if (handle === "@") return { text: "switch_x_account needs a handle like @name.", isError: true };
  /** Set when the switch opened its own tab: where the tab the agent was on is, for every answer. */
  let leftTab = "";
  // What happened, as facts for the agent to decide on; what it may not do on X is enforced where it acts (wrongXAccountRefusal).
  const fail = (step: string): ToolResult => ({
    text: `switch_x_account did not switch to ${handle}: ${step}. X is not on ${handle}, so nothing on X can be done as ${handle} yet.${leftTab}`,
    isError: true,
  });
  const needsUser = (s: PageSnapshot, reason: string): ToolResult => ({
    text: `switch_x_account cannot switch to ${handle}: ${reason} (${s.url}). X is not on ${handle}. Only the user can sign in to X accounts or get past this.${leftTab}`,
    isError: true,
  });
  const readPage = () => browser.call("browser.readPage", {});
  const sleep = deps.sleep;
  /**
   * Why the menu, read after the page found no entry to click there, has none: the answer, or reload and try again:
   * "flipped" (X re-rendered it to the delegate view) or "unopened" (the switcher's click did not open it).
   */
  const withoutEntry = (menu: PageSnapshot): ToolResult | "flipped" | "unopened" => {
    // The page saw no entry, this read shows one: X re-rendered the menu in between.
    if (entryFor(menu, handle)) return "flipped";
    const personal = personalEntries(menu);
    if (personal.length) {
      return needsUser(
        menu,
        `${handle} is not signed in in this browser: X's account menu lists ${handlesIn(personal).join(", ")}. Add it in X (Account menu, "Add an existing account"), then run the job again`,
      );
    }
    if (menu.elements.some((e) => isDelegate(e) && mentionsHandle(labelOf(e), handle))) {
      return needsUser(
        menu,
        `${handle} is a delegate account in X's menu ("Act as"), not an account signed in in this browser, and switch_x_account never acts as a delegate. Sign in to ${handle} in this browser, or switch to it by hand`,
      );
    }
    return delegateView(menu) ? "flipped" : "unopened";
  };

  let page = await readPage();
  const blockedNow = pauseReasonForUrl(page.url);
  if (blockedNow) return needsUser(page, blockedNow);
  if (shows(page, handle)) return { text: `Already on ${handle}.` };

  // The current tab is on another site (e.g. a form the user is half way through): leave it as it is and switch in a
  // new tab, which becomes the current one. Reloading X home in it would throw that page away.
  if (!isXUrl(page.url) && !BLANK_TAB.test(page.url)) {
    await browser.call("browser.openTabs", { urls: [X_HOME_URL], background: false });
    leftTab = ` X was opened in a new tab (now the current tab); the tab you were on is still on ${page.url}: switch_tab back to it (list_tabs) to carry on there.`;
  }

  let flipped = 0;
  let unopened = 0;
  /** The page ignored its own click on the entry once: a real mouse press from then on. */
  let press = false;
  // A tab already on X with its switcher showing (read above) is tried as it is first: X's own switch reloads the
  // page anyway, and the menu's first opening in this page load still lists the personal accounts. Should the menu
  // not offer the entry (opened before in this page load and flipped, or not opening), the reloads below follow as
  // they would have; this try counts as none of them. Every click and check is the same as on a reloaded page.
  const asIs = isXUrl(page.url) && !!findSwitcher(page);
  for (let attempt = asIs ? 0 : 1; attempt <= SWITCH_ATTEMPTS; attempt++) {
    const reloaded = attempt > 0;
    if (reloaded) {
      // A fresh page load: the menu X opens first lists the personal accounts (see the top of this file). A tab just
      // opened on X home is one already.
      if (attempt > 1 || !leftTab) await browser.call("browser.navigate", { url: X_HOME_URL });
      page = (await pollUntil(readPage, (s) => !!findSwitcher(s) || !!pauseReasonForUrl(s.url), { ...LOAD_POLL, sleep })).value;
      const blocked = pauseReasonForUrl(page.url);
      if (blocked) return needsUser(page, blocked);
      if (!findSwitcher(page)) return fail(`the account switcher button (testid=${X_SWITCHER_TEST_ID}) was not found on ${page.url}`);
      if (shows(page, handle)) return { text: `Already on ${handle}.${leftTab}` };
    }
    const switcher = findSwitcher(page)!;

    try {
      await browser.call("browser.click", { index: switcher.index });
    } catch (err) {
      // The page as it is would not take the click (e.g. something covers the switcher): a reload clears it.
      if (reloaded) throw err;
      continue;
    }
    let pick = await browser.call("browser.clickXAccountEntry", { handle, waitMs: MENU_WAIT_MS, ...(press ? { press } : {}) });
    if (!pick.clicked) {
      const why = withoutEntry(await readPage());
      if (typeof why !== "string") return why;
      if (reloaded && why === "unopened") unopened++;
      else if (reloaded) flipped++;
      continue;
    }
    // Nothing but the entry is ever clicked or pressed, but should X show its delegate-switch confirm or the flipped
    // menu, still open, no switch is coming: reload and try again.
    const missed = (s: PageSnapshot) => DELEGATE_SWITCH_URL.test(s.url) || delegateView(s);
    const finished = (s: PageSnapshot) => shows(s, handle) || !!pauseReasonForUrl(s.url) || missed(s);
    /** The read that saw the entry's click take effect (taken after it): the switch poll's first. */
    let after: PageSnapshot | null = null;
    if (!press) {
      // X closes the menu when it starts the switch: the entry still showing means the page ignored the click.
      const effect = await pollUntil(readPage, (s) => !entryFor(s, handle) || shows(s, handle) || !!pauseReasonForUrl(s.url), { ...TAKE_EFFECT_POLL, sleep });
      if (!effect.ok) {
        press = true;
        pick = await browser.call("browser.clickXAccountEntry", { handle, waitMs: 0, press });
        if (!pick.clicked) {
          if (reloaded) flipped++; // X replaced the entry before the press: reload and try again.
          continue;
        }
      } else {
        after = effect.value;
      }
    }

    // That read is checked as it is and the page read again only after the poll's interval: a read right after it,
    // with nothing done in between, shows nothing new. After a press, the poll reads first.
    const switched = after ? await pollFrom(after, readPage, finished, { ...SWITCH_POLL, sleep }) : await pollUntil(readPage, finished, { ...SWITCH_POLL, sleep });
    if (!shows(switched.value, handle) && missed(switched.value)) {
      if (reloaded) flipped++;
      continue;
    }
    const stop = pauseReasonForUrl(switched.value.url);
    if (stop) return needsUser(switched.value, stop);
    if (shows(switched.value, handle)) return { text: `Switched to ${handle}. Current URL: ${switched.value.url}${leftTab}` };
    const now = activeXAccount(switched.value);
    return fail(`chose ${handle} in X's account menu, but after ${SWITCH_POLL.timeoutMs / 1000} s the switcher still shows ${now ?? "no account"}`);
  }
  if (unopened === SWITCH_ATTEMPTS) return fail(`X's account menu did not open on ${page.url} (${unopened} of ${SWITCH_ATTEMPTS} reloads)`);
  return fail(
    `${flipped} of ${SWITCH_ATTEMPTS} times X switched its account menu to the delegate accounts before ${handle} could be chosen (its "Personal accounts" section is then folded with nothing to click)`,
  );
}

/** Whether an element is one of X's buttons that publish (Post, Reply, Repost). */
function publishes(el: ElementInfo | undefined): boolean {
  if (!el) return false;
  if (el.testId && PUBLISH_TEST_IDS.has(el.testId)) return true;
  return el.role === "button" && PUBLISH_LABEL.test(el.name.trim());
}

/**
 * The refusal of an action that would publish on X while X is signed in as another account than `account` (the
 * task's), read from the page the action happens on; null when the action does not publish on X or X is on the
 * task's account.
 */
export function wrongXAccountRefusal(
  page: PageSnapshot,
  action: { method: "browser.click"; index: number } | { method: "browser.pressKey"; key: string },
  account: string,
): string | null {
  if (!isXUrl(page.url)) return null;
  const publishing = action.method === "browser.click" ? publishes(page.elements.find((e) => e.index === action.index)) : POST_SHORTCUT.test(action.key.trim());
  if (!publishing) return null;
  const want = normalizeHandle(account);
  const active = activeXAccount(page);
  if (active && sameHandle(active, want)) return null;
  if (!active) {
    return `Not done: this page shows no X account switcher, so it can't be checked that X is signed in as ${want}. Open ${X_HOME_URL}, make sure the switcher shows ${want} (switch_x_account), then post from there.`;
  }
  return `Not done: X is signed in as ${active}, this job posts as ${want}. Switch accounts first (switch_x_account ${want}); nothing is ever published from another account.`;
}

/** Whether a key press may publish on X (the only keys whose page the X account check needs). */
export function mayPublishKey(key: string): boolean {
  return POST_SHORTCUT.test(key.trim());
}
