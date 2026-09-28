import { describe, expect, it } from "vitest";
import {
  buildChatTitlePrompt,
  CHAT_TITLE_SYSTEM_PROMPT,
  cleanUserTitle,
  fallbackChatTitle,
  MAX_CHAT_TITLE_CHARS,
  MAX_CHAT_TITLE_WORDS,
  parseChatTitle,
} from "../src/index.js";

describe("fallbackChatTitle (no model)", () => {
  it.each([
    ["yo can you check my chrome web store emails", "Check my chrome web store emails"],
    ["Hey, could you please schedule 3 posts a day on X?", "Schedule 3 posts a day on X"],
    ["so I want you to find cheap flights to Lisbon for me please", "Find cheap flights to Lisbon"],
    ["Yo sup how you doin. Can you read my newest email?", "Read my newest email"],
    ["hi there! what's up? Summarize this page", "Summarize this page"],
    ["Post the weekly recap on X from @alpha", "Post the weekly recap on X from @alpha"],
    ["Sort my inbox by sender", "Sort my inbox by sender"],
  ])("%s -> %s", (request, title) => {
    expect(fallbackChatTitle(request)).toBe(title);
  });

  it("keeps small talk that is all there is", () => {
    expect(fallbackChatTitle("Yo sup how you doin")).toBe("Yo sup how you doin");
  });

  it("is the first line", () => {
    expect(fallbackChatTitle("Post the recap on X\nUse the second draft")).toBe("Post the recap on X");
  });

  it("is cut at a word with a mark", () => {
    const t = fallbackChatTitle("Reply to every unread email from the landlord about the lease renewal and the parking spot\nthen archive them");
    expect(t.length).toBeLessThanOrEqual(MAX_CHAT_TITLE_CHARS);
    expect(t).toMatch(/…$/);
    expect(t).not.toMatch(/\s…$/);
    expect(t).toMatch(/^Reply to every unread email from the landlord about the/);
  });

  it("never keeps a secret", () => {
    const login = fallbackChatTitle("Log in to example.com, the password is hunter22");
    expect(login).toMatch(/^Log in to example.com/);
    expect(login).not.toContain("hunter22");
    expect(fallbackChatTitle("use key sk-ant-abcdefghijklmnop to call the API")).not.toContain("sk-ant-");
  });

  it("is empty for an empty request (the page's own look)", () => {
    expect(fallbackChatTitle("   ")).toBe("");
  });
});

describe("parseChatTitle (the model's answer)", () => {
  it("takes the first line without quotes, prefix or trailing punctuation", () => {
    expect(parseChatTitle('Title: "Schedule 3x daily X posts."\n')).toBe("Schedule 3x daily X posts");
    expect(parseChatTitle("**check Chrome Web Store emails**")).toBe("Check Chrome Web Store emails");
  });

  it("keeps at most the word limit", () => {
    const t = parseChatTitle("Find and compare the cheapest weekend flights to Lisbon from Berlin")!;
    expect(t.split(" ")).toHaveLength(MAX_CHAT_TITLE_WORDS);
  });

  it("refuses an empty answer or one with a secret", () => {
    expect(parseChatTitle("  \n ")).toBeNull();
    expect(parseChatTitle("Log in with password is hunter22")).toBeNull();
    expect(parseChatTitle("Use sk-ant-abcdefghijklmnop")).toBeNull();
    expect(parseChatTitle('{"episode": {"subject": "Checked email"}}')).toBeNull();
  });

  it("refuses a reply that is not a task title: a refusal, an apology, an error, a question to the user", () => {
    for (const answer of [
      "I cannot do this without my tools.",
      "I can't help with that",
      "I'm unable to access your email",
      "I am not able to browse",
      "I don't have access to your inbox",
      "As an AI, I can't open Gmail",
      "Sorry, I couldn't read the conversation",
      "Apologies, but that is not possible",
      "Unfortunately the page did not load",
      "Error: tools missing",
      "Could you tell me which account?",
      "What would you like me to title this?",
      "Which email do you mean?",
    ]) {
      expect(parseChatTitle(answer), answer).toBeNull();
    }
  });

  it("keeps task titles that merely contain such words", () => {
    expect(parseChatTitle("Fix the cannot-connect error on checkout")).toBe("Fix the cannot-connect error on checkout");
    expect(parseChatTitle("Reply to Sarah's apology email")).toBe("Reply to Sarah's apology email");
    expect(parseChatTitle("Find out why Wi-Fi drops?")).toBe("Find out why Wi-Fi drops");
  });

  it("skips a preface line before the title", () => {
    expect(parseChatTitle("Here's a title:\nCheck Chrome Web Store emails")).toBe("Check Chrome Web Store emails");
  });
});

describe("the title prompt", () => {
  it("asks for a short job name and leaves small talk out", () => {
    expect(CHAT_TITLE_SYSTEM_PROMPT).toMatch(/at most 6 words/);
    expect(CHAT_TITLE_SYSTEM_PROMPT).toMatch(/small talk/);
  });

  it("gives the conversation with secrets redacted", () => {
    const p = buildChatTitlePrompt([
      { who: "user", text: "yo sup" },
      { who: "user", text: "check my email, token=abc123secret" },
      { who: "agent", text: "Opening Gmail." },
    ]);
    expect(p).toContain("User: yo sup");
    expect(p).toContain("token=[redacted]");
    expect(p).toMatch(/The title:$/);
  });

  it("tells the model to name the task, not answer or do it", () => {
    const p = buildChatTitlePrompt([{ who: "user", text: "open gmail" }]);
    expect(p).toMatch(/Do not answer/);
    expect(CHAT_TITLE_SYSTEM_PROMPT).toMatch(/never answer/i);
  });
});

describe("cleanUserTitle (a rename)", () => {
  it("is one line, clipped; empty is no title", () => {
    expect(cleanUserTitle("  My   job \n here ")).toBe("My job here");
    expect(cleanUserTitle(" ")).toBeNull();
    expect(cleanUserTitle("x ".repeat(100))!.length).toBeLessThanOrEqual(MAX_CHAT_TITLE_CHARS);
  });
});
