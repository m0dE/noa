import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@noa/shared";
import {
  ackResponse,
  ALREADY_SENT_OUTPUT,
  MUTED_NOTE,
  NARRATOR_INSTRUCTIONS,
  NARRATOR_TOOLS,
  NOT_A_REQUEST_OUTPUT,
  SENT_OUTPUT,
  UNMUTED_NOTE,
  WORKING_SMALL_TALK_RESPONSE,
} from "../../src/voice/realtime-client.js";
import { NarratorFeed } from "../../src/voice/realtime-feed.js";
import { lookingElsewhereNote, lookingHomeNote, useThisTabAnswer } from "../../src/voice/hands-free-tab.js";

/**
 * To the user there is one assistant, Noa, and the voice is it: what the narrator is told to say, and every
 * note and tool answer it speaks from, calls the work its own. Wording that splits it in two ("It's checking... I'll
 * share the result as soon as the agent reports back", a real trace) must not reach it.
 */
const THIRD_PERSON = /\bthe (?:browser )?agent\b|\bagent'?s\b|reports? back|passing it on|pass(?:ed)? it on|sent to the agent|\bit'?s checking\b/i;

/** Every string in a value (tool definitions are nested objects); a tool's name is an identifier, not speech. */
function texts(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(texts);
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => (k === "name" ? [] : texts(v)));
  return [];
}

const call = (name: string, args: unknown = {}): AgentEvent => ({ type: "tool_call", id: "1", name, args });
const approval: AgentEvent = { type: "approval_request", request: { id: "ap1", action: 'Click "Post"', site: "x.com", why: "publishes", kind: "publish", expiresAt: new Date(0).toISOString() } };

/** One of each note the feed makes. */
function feedNotes(): string[] {
  const out: string[] = [];
  const feed = new NarratorFeed();
  out.push(...feed.push({ type: "user_message", text: "use the second draft" }, 0).map((n) => n.text));
  feed.request(0);
  feed.push(call("navigate", { url: "https://mail.google.com/" }), 5);
  feed.push({ type: "assistant_text", text: "Switching to the admin account." }, 10);
  out.push(...feed.push(call("navigate", { url: "https://calendar.google.com/" }), 60_000).map((n) => n.text));
  out.push(...feed.push({ type: "error", text: "Claude API rate limit (HTTP 429)" }, 60_001).map((n) => n.text));
  out.push(...feed.push(approval, 60_002).map((n) => n.text));
  out.push(...feed.push({ type: "task_end", outcome: "paused", reason: "Which account should I post from?" }, 60_003).map((n) => n.text));
  feed.question();
  out.push(...feed.push({ type: "assistant_text", text: "Not yet: I'm still signed in as Rooftop Chat." }, 60_004).map((n) => n.text));
  feed.request(70_000);
  out.push(...feed.push({ type: "task_end", outcome: "done", summary: "Posted", spoken: "Posted your thread on X." }, 70_001).map((n) => n.text));
  return out;
}

describe("the voice is Noa doing the work: no third-person agent in what the narrator speaks from", () => {
  it("the feed makes every kind of note (so the check below covers them)", () => {
    expect(feedNotes().map((n) => n.match(/^Your update(?: \(([^)]+)\))?/)?.[1] ?? "context")).toEqual([
      "context",
      "progress",
      "problem",
      "you need the user's OK",
      "you need the user",
      "answer",
      "finished",
    ]);
  });

  it.each([
    ["narrator instructions", () => [NARRATOR_INSTRUCTIONS]],
    ["acknowledgements", () => [ackResponse("post gm on X").instructions, ackResponse("use the second draft", true).instructions, ackResponse(null).instructions]],
    ["small talk while working", () => [WORKING_SMALL_TALK_RESPONSE.instructions]],
    ["tool descriptions", () => texts(NARRATOR_TOOLS)],
    ["tool outputs", () => [SENT_OUTPUT, ALREADY_SENT_OUTPUT, ...Object.values(NOT_A_REQUEST_OUTPUT)]],
    ["microphone notes", () => [MUTED_NOTE, UNMUTED_NOTE]],
    ["feed notes", feedNotes],
    [
      "tab notes and answers",
      () => [
        lookingElsewhereNote({ title: "Docs", url: "https://docs.google.com/" }, { title: "X", url: "https://x.com/" }),
        lookingHomeNote({ title: "X", url: "https://x.com/" }),
        useThisTabAnswer({ moved: { title: "New Tab", url: "chrome://newtab/" } }),
        useThisTabAnswer("unknown"),
        useThisTabAnswer("here"),
        useThisTabAnswer("gone"),
      ],
    ],
  ])("%s", (_what, strings) => {
    for (const s of strings()) expect(s).not.toMatch(THIRD_PERSON);
  });

  it("the narrator is told it is Noa doing the work, and to speak of it in the first person", () => {
    expect(NARRATOR_INSTRUCTIONS).toMatch(/^You are Noa, the assistant doing the user's tasks/);
    expect(NARRATOR_INSTRUCTIONS).toMatch(/in the first person/);
  });
});
