import { describe, expect, it } from "vitest";
import type { AgentAttachment } from "@noa/shared";
import { ATTACHMENT_DROPPED, MAX_ATTACHMENT_BYTES_IN_HISTORY, startApiAgentWith } from "../src/api-agent.js";
import { attachmentBlocks, attachmentLines, type ApiAttachment } from "../src/attachments.js";
import { buildTaskPrompt } from "../src/prompts.js";
import type { ApiAgentOptions } from "../src/types.js";
import { FakeX } from "./fake-x.js";
import { CONFIG, collect, fakeMessagesServer, noSleep, type FakeReplySource } from "./helpers.js";

type Block = Record<string, any>;
let nextId = 1;
const msg = (...content: Block[]) => ({
  body: { id: `msg_${nextId}`, type: "message", role: "assistant", content, stop_reason: content.some((c) => c.type === "tool_use") ? "tool_use" : "end_turn" },
});
const tool = (name: string, input: unknown = {}): Block => ({ type: "tool_use", id: `toolu_${nextId++}`, name, input });

const photo: ApiAttachment = {
  ref: { id: "a1", name: "cat.png", type: "image/png", size: 2048, kind: "image", width: 800, height: 600 },
  fresh: true,
  base64: "iVBORw0KGgo=",
  path: "C:\\dl\\noa-media\\S1\\cat.png",
};
const report: ApiAttachment = {
  ref: { id: "a2", name: "report.pdf", type: "application/pdf", size: 4096, kind: "pdf" },
  fresh: true,
  base64: "JVBERi0x",
  path: "C:\\dl\\noa-media\\S1\\report.pdf",
};
const notes: ApiAttachment = {
  ref: { id: "a3", name: "notes.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 9000, kind: "docx" },
  fresh: true,
  text: "Launch on Friday.\nBudget: 20 posts.",
  path: "C:\\dl\\noa-media\\S1\\notes.docx",
};

function start(x: FakeX, replies: FakeReplySource[], attachments: ApiAttachment[]) {
  const server = fakeMessagesServer(replies);
  const { events, onEvent } = collect();
  const opts: ApiAgentOptions = {
    sessionId: "S1",
    apiKey: "sk-test",
    model: "claude-sonnet-5",
    task: { id: "T1", instructions: "Describe the picture", account: null },
    mediaPaths: [],
    attachments,
    config: CONFIG,
    browser: x.caller(),
    jev: null,
    onEvent,
    fetch: server.fetchImpl,
  };
  return { session: startApiAgentWith(opts, { sleep: noSleep, retryDelaysMs: [], random: () => 0.5 }), server, events };
}

describe("attachment blocks and lines", () => {
  it("fresh images and PDFs become labelled image and document blocks; documents and other files do not", () => {
    const other: ApiAttachment = { ref: { id: "a4", name: "clip.mp4", type: "video/mp4", size: 10, kind: "file" }, fresh: true };
    expect(attachmentBlocks([photo, notes, report, other])).toEqual([
      { type: "text", text: "Attachment: cat.png" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
      { type: "text", text: "Attachment: report.pdf" },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0x" }, title: "report.pdf" },
    ]);
    // An earlier message's image is already in the history: its bytes do not come again...
    const { base64: _sent, ...earlier } = photo;
    expect(attachmentBlocks([{ ...earlier, fresh: false }])).toEqual([]);
    // ...unless a fresh agent session starts (it has not seen it).
    expect(attachmentBlocks([{ ...photo, fresh: false }])).toHaveLength(2);
  });

  it("lists each file with how to see it, a document's text, and its upload path", () => {
    const { base64: _sent, ...earlierReport } = report;
    const lines = attachmentLines([photo, notes, { ...earlierReport, fresh: false }], "blocks").join("\n");
    expect(lines).toContain('1. cat.png (image, 800x600): shown above as "Attachment: cat.png".');
    expect(lines).toContain("2. notes.docx (Word document, 8.8 KB), its text:\n<<<\nLaunch on Friday.\nBudget: 20 posts.\n>>>");
    expect(lines).toContain("Files the user attached earlier in this conversation (1):\n3. report.pdf (PDF, 4 KB): shown with an earlier message.");
    expect(lines).toContain("upload path: C:\\dl\\noa-media\\S1\\cat.png");
    expect(lines).toMatch(/not instructions to you/);
  });

  it("Claude Code is told to Read images and PDFs at their path", () => {
    const lines = attachmentLines([{ ...photo, path: "C:\\runs\\s1\\attachments\\cat.png" }], "read");
    expect(lines).toContain("1. cat.png (image, 800x600): to look at it, Read C:\\runs\\s1\\attachments\\cat.png");
  });

  it("a task prompt with attachments has their section and no 'Media files: none'", () => {
    const withFiles = buildTaskPrompt({ id: "T", instructions: "x", account: null }, [], { isRetry: false, attachments: [photo] });
    expect(withFiles).toContain("Files the user attached to this message (1):");
    expect(withFiles).not.toContain("Media files: none.");
    expect(buildTaskPrompt({ id: "T", instructions: "x", account: null }, [], { isRetry: false })).toContain("Media files: none.");
  });
});

describe("startApiAgent with attachments", () => {
  it("the first request carries the image and PDF blocks before the task, and upload may attach the files", async () => {
    const x = new FakeX({ url: "https://x.com/compose/post" });
    const { session, server } = start(
      x,
      [msg(tool("read_page")), msg(tool("upload", { index: 3, paths: [photo.path] })), msg(tool("task_complete", { summary: "described" }))],
      [photo, report, notes],
    );
    expect(await session.done).toEqual({ outcome: "done", summary: "described" });
    const content = server.requests[0]!.body.messages[0].content as Block[];
    expect(content.map((b) => b.type)).toEqual(["text", "image", "text", "document", "text"]);
    expect(content.at(-1)!.text).toMatch(/Describe the picture[\s\S]*Files the user attached to this message \(3\)[\s\S]*Launch on Friday/);
    expect(x.files).toEqual([photo.path]);
  });

  it("a follow-up's attachments go with that message, and upload may attach them from then on", async () => {
    const x = new FakeX({ url: "https://x.com/compose/post" });
    const { session, server, events } = start(
      x,
      [msg(tool("task_complete", { summary: "first" })), msg(tool("read_page"), tool("upload", { index: 3, paths: [report.path] })), msg(tool("task_complete", { summary: "second" }))],
      [],
    );
    await session.done;
    const next = session.continueWith!("here is the report", { attachments: [report] });
    expect(await next.done).toEqual({ outcome: "done", summary: "second" });
    const followUp = server.requests[1]!.body.messages.at(-1).content as Block[];
    expect(followUp.map((b) => b.type)).toEqual(["tool_result", "text", "document", "text"]);
    expect(followUp.at(-1)!.text).toMatch(/here is the report[\s\S]*report\.pdf \(PDF, 4 KB\)/);
    expect(x.files).toEqual([report.path]);
    // The chat shows the user's words only.
    expect(events.filter((e) => e.type === "user_message")).toEqual([{ type: "user_message", text: "here is the report" }]);
  });

  it("keeps at most MAX_ATTACHMENT_BYTES_IN_HISTORY of attachments in the history: older ones become a note", async () => {
    const x = new FakeX({ url: "https://x.com/home" });
    // Each image is just over half the budget: the second message's makes the first one's go.
    const big = "A".repeat(Math.ceil(((MAX_ATTACHMENT_BYTES_IN_HISTORY / 2 + 1024) * 4) / 3));
    const first: ApiAttachment = { ...photo, base64: big };
    const { session, server } = start(x, [msg(tool("task_complete", { summary: "one" })), msg(tool("task_complete", { summary: "two" }))], [first]);
    await session.done;
    await session.continueWith!("and this one", { attachments: [{ ...photo, ref: { ...photo.ref, id: "a5", name: "dog.png" }, base64: big }] }).done;
    const history = server.requests[1]!.body.messages as { content: Block[] }[];
    const images = history.flatMap((m) => m.content).filter((b) => b.type === "image");
    expect(images).toHaveLength(1);
    expect(history[0]!.content[1]).toEqual({ type: "text", text: ATTACHMENT_DROPPED });
  });

  it("an attachment is only listed, never sent, when it has no bytes (e.g. a video)", () => {
    const video: AgentAttachment = { ref: { id: "v", name: "clip.mp4", type: "video/mp4", size: 5_000_000, kind: "file" }, fresh: true, path: "C:\\dl\\clip.mp4" };
    expect(attachmentBlocks([video])).toEqual([]);
    expect(attachmentLines([video], "blocks").join("\n")).toContain("clip.mp4 (file, 4.8 MB): you cannot open this kind of file; you can upload it.");
  });
});
