/**
 * A real scheduled X job that paused on its own Post click (owner's production trace, 2026-09-28): the approval
 * card said `Click "Post" as @mecharoyalecom on x.com · publishes; the task does not ask for this`, and the
 * trace's approval.judge row had level full_within_task, withinRules "no", no Jev. The job's instructions ask
 * for the post plainly ("5. Post it from the home composer at https://x.com/home") and name the site and the
 * account; a content rule ("Don't post contract addresses or cashtags") is not a ban on posting.
 */
import { describe, expect, it } from "vitest";
import type { PageSnapshot } from "@noa/shared";
import type { BrowserCaller } from "@noa/core";
import { ApprovalGate } from "../../src/approval/gate.js";
import { withinInstructions } from "../../src/approval/within-task.js";
import { CASES, el } from "./cases.js";

/** The job's instructions, word for word as stored (the series "@mecharoyalecom: post on X 3x daily"). */
export const MECHA_INSTRUCTIONS = `Post one new original post on X as @mecharoyalecom (Mecha Royale). This repeats 3 times a day.

Steps:
1. Call switch_x_account with @mecharoyalecom first. If it can't switch, or X shows a login/verification page, pause and tell the user.
2. Open https://x.com/mecharoyalecom and read the latest ~10 posts so the new post doesn't repeat recent wording or angles. Also check the task's memory notes for what earlier runs posted.
3. Write one new post (under 280 characters) in Mecha Royale's voice: an indie dev building a multiplayer mecha battle royale game (mecharoyale.com), confident, build-in-public, "the cook continues" energy. Stick to product and building: what we're working on, new features, updates shipped, gameplay and cosmetics, player/community experience, the upcoming Mecha Tournament as a game event, the vision for the game, and invites to play at mecharoyale.com. No invented stats or fake facts; 0–1 hashtags.
4. CONTENT RULES (strict, must never be broken; if a draft breaks any of them, rewrite it):
   - Never talk about token price, market cap, charts, pumps, "moon", "going up", "early", buying/holding/accumulating, "don't miss out", or anything that says or hints that the token or coin will gain value or that people will make money.
   - No investment or financial advice, no promises of returns, profits, rewards or yield, and no urgency to buy.
   - Don't post contract addresses or cashtags ($MECHA etc.). Don't mention token-holder requirements or token perks.
   - No claims about partnerships, listings, user numbers or results that aren't already publicly stated on the account.
   - Keep it lighthearted and product-focused: building, features, updates, vision, fun.
5. Post it from the home composer at https://x.com/home, confirm it's posted as @mecharoyalecom, and get its /status/ URL.
6. Do nothing else: no likes, follows, replies or reposts.
Report the post text and its URL, and put the angle used in the memory note.`;

const ACCOUNT = "@mecharoyalecom";

describe("a real scheduled X job: '@mecharoyalecom: post on X 3x daily'", () => {
  const post = CASES.find((c) => c.name === "X: Post button in the home composer")!.action;
  const like = CASES.find((c) => c.name === "X: Like")?.action;

  it("the rules: its Post click is what it asks for; likes, follows and reposts are not", () => {
    expect(withinInstructions("publish", post, { instructions: MECHA_INSTRUCTIONS, account: ACCOUNT })).toBe("yes");
    if (like) expect(withinInstructions("publish", like, { instructions: MECHA_INSTRUCTIONS, account: ACCOUNT })).toBe("no");
  });

  it("a content rule restricts what is posted, not whether: 'Don't post contract addresses'", () => {
    const task = (instructions: string) => withinInstructions("publish", post, { instructions, account: ACCOUNT });
    expect(task("Post a daily update on X. Don't post contract addresses or cashtags.")).toBe("yes");
    expect(task("Post a daily update on X. Never post links.")).toBe("yes");
    // A ban on the action itself still wins.
    expect(task("Write a daily update on X but don't post it")).toBe("no");
    expect(task("Draft a post for X. Do not post.")).toBe("no");
    expect(task("Write the post on X, do not publish it")).toBe("no");
  });

  it("the gate: the unattended cloud run posts without an approval card", async () => {
    const editor = el("textbox", "Post text", { tag: "div", testId: "tweetTextarea_0", index: 7 });
    const postBtn = el("button", "Post", { testId: "tweetButtonInline", index: 8 });
    const page: PageSnapshot = { url: "https://x.com/home", title: "Home / X", text: "What is happening?!", elements: [editor, postBtn], truncated: false };
    const browser: BrowserCaller = { call: async (method) => (method === "browser.readPage" ? page : { ok: true }) as never };
    const asked: unknown[] = [];
    const paused: string[] = [];
    const gate = new ApprovalGate(browser, () => "s1", {
      context: async () => ({ level: "full_within_task", instructions: MECHA_INSTRUCTIONS, account: ACCOUNT, attended: false, pause: (r) => paused.push(r) }),
      request: async (_s, ask) => {
        asked.push(ask);
        return "paused";
      },
      jev: () => null,
    });
    await gate.browser.call("browser.readPage", {});
    await gate.browser.call("browser.type", { index: 7, text: "The cook continues: new mech skins drop this week at mecharoyale.com" });
    await gate.browser.call("browser.click", { index: 8 });
    expect(asked).toEqual([]);
    expect(paused).toEqual([]);
  });
});
