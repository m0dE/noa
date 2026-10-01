/** Errors in plain words with the button that fixes them (error-help.ts), and a failed turn shown once in the chat. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { HOSTED_AI_UNAVAILABLE, OUT_OF_CREDIT, PLAN_REQUIRED_MESSAGES, SCHEDULE_PLAN_REQUIRED, SCHEDULE_SIGN_IN, type AgentEvent } from "@noa/shared";
import { CLAUDE_CODE_GONE, HOSTED_SIGN_IN } from "../../src/engine/brain-resolver.js";
import { errorHelp, FIXES } from "../../src/sidepanel/error-help.js";
import { setErrorFixes } from "../../src/sidepanel/error-view.js";
import { describeEvent, turnError } from "../../src/sidepanel/event-format.js";
import { renderEvent } from "../../src/sidepanel/event-render.js";
import { box, installMiniDom, type MiniElement } from "./mini-dom.js";

/** The words a user reads first: short, no status codes, no vendor jargon. */
function expectPlain(message: string): void {
  expect(message.split(/\s+/).length).toBeLessThanOrEqual(12);
  expect(message).not.toMatch(/HTTP|\b[45]\d\d\b|_error|anthropic|x-api-key|\{/i);
}

describe("errorHelp", () => {
  const cases: [string, string, string[], boolean][] = [
    // text, message, fix labels, retry
    [HOSTED_AI_UNAVAILABLE, "Noa AI is unavailable right now.", ["Use your own Claude"], true],
    [`${OUT_OF_CREDIT}: No usage credit left`, "You're out of usage credit.", ["Top up", "Use your own Claude"], true],
    [HOSTED_SIGN_IN, "You're not logged in.", ["Log in"], true],
    ["Noa AI rejected the sign-in (HTTP 401: invalid or expired session)", "You're not logged in.", ["Log in"], true],
    [PLAN_REQUIRED_MESSAGES.voice, PLAN_REQUIRED_MESSAGES.voice, ["Choose a plan"], false],
    // schedule_task's refusals, as the chat shows them.
    [SCHEDULE_PLAN_REQUIRED, "Scheduling needs a paid plan.", ["Choose a plan"], false],
    [SCHEDULE_SIGN_IN, "You're not logged in.", ["Log in"], false],
    ["Helper not installed", "The Claude Code helper isn't installed.", ["Set up Claude Code"], false],
    ["helper disconnected: Native host has exited.", "Local Claude Code isn't connected.", ["Set up Claude Code", "Use Noa AI"], true],
    [CLAUDE_CODE_GONE, "Local Claude Code isn't connected.", ["Set up Claude Code", "Use Noa AI"], true],
    ["No Claude API key set", "No Claude API key is set.", ["Add API key"], false],
    ["Claude API key rejected (HTTP 401: authentication_error: invalid x-api-key)", "Your Claude API key was refused.", ["Add API key"], false],
    ["No AI set up. Install the helper, add a Claude API key, or log in.", "AI model not detected.", ["Set up AI"], false],
    ["No AI set up: Claude Code self-test failed: not logged in.", "Claude Code isn't ready.", ["Set up Claude Code"], false],
    ["Cannot access contents of url \"chrome://settings/\"", "Chrome blocks extensions on this page.", ["Open a new tab"], true],
    ["Claude API rate limit (HTTP 429: rate_limit_error: slow down); gave up after 4 attempts", "Too many requests right now.", [], true],
    ["Claude API network error: Failed to fetch", "Couldn't reach the server.", [], true],
  ];
  it.each(cases)("%s", (text, message, fixes, retry) => {
    const help = errorHelp(text);
    expect(help).toMatchObject({ message, retry, known: true });
    expect(help.fixes.map((f) => f.label)).toEqual(fixes);
    expectPlain(help.message);
    if (help.hint) expect(help.hint.split(/\s+/).length).toBeLessThanOrEqual(12);
    // The technical text stays reachable behind Details.
    if (text !== help.message && `${text}.` !== help.message) expect(help.details).toBe(text);
    else expect(help.details).toBeUndefined();
  });

  it("says how long to wait when the server said so", () => {
    expect(errorHelp("Noa AI rate limit (HTTP 429: too many hosted AI requests at once); retrying in 12 s").hint).toBe("Wait 12 s, then retry.");
    expect(errorHelp("Claude Code: Claude AI usage limit reached").hint).toBe("Wait a minute, then retry.");
  });

  it("an error it does not know: a generic line, Retry, and the text behind Details", () => {
    const raw = "Claude API error (HTTP 400: invalid_request_error: prompt is too long: 250000 tokens > 200000 maximum)";
    expect(errorHelp(raw)).toEqual({ message: "Something went wrong.", fixes: [], retry: true, known: false, details: raw });
  });

  it("never passes the raw upstream workspace message on as the main line", () => {
    const raw =
      "Noa AI error (HTTP 400: invalid_request_error: This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header)";
    const help = errorHelp(raw);
    expect(help.message).not.toContain("workspace");
    expect(help.details).toBe(raw);
  });
});

describe("a failed turn shows its error once", () => {
  const failedTurn: AgentEvent[] = [
    { type: "user_message", text: "Summarize the tracker" },
    { type: "error", text: HOSTED_AI_UNAVAILABLE },
    { type: "task_end", outcome: "failed", reason: HOSTED_AI_UNAVAILABLE },
  ];

  it("the end card does not repeat the error its turn already showed; Continue reads Retry", () => {
    expect(turnError(failedTurn, 2)).toBe(HOSTED_AI_UNAVAILABLE);
    const end = describeEvent(failedTurn[2]!, { error: turnError(failedTurn, 2) });
    expect(end).toMatchObject({ kind: "end", text: "", retry: true, fixable: true });
    expect(end).not.toHaveProperty("error");
  });

  it("a failure no error card showed becomes the end card's error card (the helper's disconnect)", () => {
    const end = describeEvent({ type: "task_end", outcome: "retry", reason: "helper disconnected: Native host has exited." });
    expect(end).toMatchObject({ kind: "end", text: "", retry: true, error: { message: "Local Claude Code isn't connected." } });
  });

  it("the agent's own pause reason reads as it wrote it, even when its words sound like one of Noa's errors (Sep 30)", () => {
    // task_pause after switch_x_account: this was shown as "You're not logged in." with a Log in button.
    const reason =
      "@rooftopchat is not signed in on this browser's X account menu (it currently shows @indiedotfun, @mecharoyalecom, @arrrfun, @strafefun), so switch_x_account cannot switch to it.";
    const end = describeEvent({ type: "task_end", outcome: "paused", reason, byAgent: true });
    expect(end).toMatchObject({ kind: "end", text: reason });
    expect(end).not.toHaveProperty("error");
    expect(end).not.toHaveProperty("fixable");
    // The same words from Noa itself are still its sign-in error.
    expect(describeEvent({ type: "task_end", outcome: "failed", reason: "Not signed in: sign in to use Noa AI" })).toMatchObject({ error: { message: "You're not logged in." } });
  });

  it("the agent's own reason, or an earlier turn's error, reads as before", () => {
    expect(describeEvent({ type: "task_end", outcome: "failed", reason: "LinkedIn asked for a captcha" })).toMatchObject({ text: "LinkedIn asked for a captcha" });
    const events: AgentEvent[] = [...failedTurn, { type: "user_message", text: "again" }, { type: "task_end", outcome: "done", summary: "Summarized" }];
    expect(turnError(events, 4)).toBeUndefined();
    expect(describeEvent(events[4]!, { error: turnError(events, 4) })).toMatchObject({ text: "Summarized" });
  });

  describe("rendered", () => {
    beforeAll(installMiniDom);
    const ownClaude = vi.fn();

    function renderTurn(events: AgentEvent[]): MiniElement {
      setErrorFixes({ "own-claude": ownClaude });
      const log = box();
      events.forEach((e, i) => {
        const view = describeEvent(e, e.type === "task_end" ? { error: turnError(events, i) } : {});
        log.append(renderEvent(view, e.type === "task_end" ? () => {} : undefined) as unknown as MiniElement);
      });
      return log;
    }
    const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

    it("one error card with the plain line, Use your own Claude and Retry; the raw text nowhere", () => {
      const log = renderTurn(failedTurn);
      const text = log.textContent;
      expect(count(text, "Noa AI is unavailable right now.")).toBe(1);
      expect(log.all().filter((e) => e.className.split(" ").includes("ev-error"))).toHaveLength(1);
      const buttons = log.all("button");
      const fix = buttons.find((b) => b.getAttribute("data-fix") === "own-claude")!;
      expect(fix.textContent).toBe("Use your own Claude");
      expect(fix.className).toContain("primary");
      fix.click();
      expect(ownClaude).toHaveBeenCalledTimes(1);
      const retry = buttons.find((b) => b.className.includes("ev-continue"))!;
      expect(retry.textContent).toBe("Retry");
      // The fix is the main action.
      expect(retry.className).not.toContain("primary");
    });

    it("an unknown error: one card, its text only behind Details", () => {
      const raw = "Claude API error (HTTP 400: invalid_request_error: prompt is too long)";
      const log = renderTurn([
        { type: "error", text: raw },
        { type: "task_end", outcome: "failed", reason: raw },
      ]);
      expect(count(log.textContent, raw)).toBe(1);
      const details = log.all("details")[0]!;
      expect(details.className).toBe("err-details");
      expect(details.all("pre")[0]!.textContent).toBe(raw);
      expect(count(log.textContent, "Something went wrong.")).toBe(1);
    });

    it("a fix without an action here shows no button (Top up while signed out)", () => {
      const log = renderTurn([{ type: "error", text: `${OUT_OF_CREDIT}: No usage credit left` }]);
      expect(log.all("button").map((b) => b.textContent)).toEqual(["Use your own Claude", "Copy"]);
      expect(FIXES.topup.label).toBe("Top up");
    });
  });
});
