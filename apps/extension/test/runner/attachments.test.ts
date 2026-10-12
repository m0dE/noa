/** Runner: files attached to chat messages (new chats, next turns, a running turn, fresh sessions, cleanup). */
import { describe, expect, it, vi } from "vitest";
import type { IncomingAttachment } from "../../src/engine/attachment-store.js";
import { FILES_WHILE_RUNNING } from "@noa/shared";
import { MAX_SESSIONS } from "../../src/engine/sessions.js";
import { harness, setupRunnerTests, type Harness } from "./harness.js";

setupRunnerTests();

const photo = (name = "cat.png"): IncomingAttachment => ({ ref: { name, type: "image/png", kind: "image", width: 4, height: 3 }, blob: new Blob(["png"], { type: "image/png" }) });
const notes: IncomingAttachment = { ref: { name: "notes.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: "docx" }, blob: new Blob(["zip"]), text: "Launch Friday" };

async function settle(h: Harness) {
  await h.runner.idle();
  await h.sessions.flush();
}

describe("Runner: attachments", () => {
  it("a follow-up's files go with its message; earlier ones are listed again for upload, without their bytes", async () => {
    const h = harness();
    const { sessionId } = await h.runner.runAdhoc({ instructions: "What is this?", attachments: [photo()] });
    await settle(h);
    await h.runner.message(sessionId, "and this document", { attachments: [notes] });
    await settle(h);
    const next = h.brain.continues[0]!;
    expect(next.attachments!.map((a) => ({ id: a.ref.id, fresh: a.fresh, path: a.path, bytes: a.base64 !== undefined, text: a.text }))).toEqual([
      { id: "a1", fresh: false, path: "C:\\dl\\cat.png", bytes: false, text: undefined },
      { id: "a2", fresh: true, path: "C:\\dl\\notes.docx", bytes: false, text: "Launch Friday" },
    ]);
    // Every turn writes the conversation's files for upload, and deletes them when it ends.
    const written = h.materialized.filter((m) => m.sources.length).map((m) => m.sources.map((s) => s.name));
    expect(written).toEqual([["cat.png"], ["cat.png", "notes.docx"]]);
    // The chat shows the files on the message they came with.
    const said = (await h.sessions.eventsOf(sessionId)).find((e) => e.type === "user_message");
    expect(said).toMatchObject({ text: "and this document", attachments: [{ id: "a2", name: "notes.docx", kind: "docx", size: 3 }] });
  });

  it("a brain that keeps files itself (Claude Code) gets them without Downloads copies or base64", async () => {
    const h = harness();
    h.brain.keepsAttachments = true;
    await h.runner.runAdhoc({ instructions: "What is this?", attachments: [photo()] });
    await settle(h);
    expect(h.materialized.filter((m) => m.sources.length)).toEqual([]);
    expect(h.brain.starts[0]!.attachments).toEqual([{ ref: expect.objectContaining({ id: "a1" }), fresh: true, blob: expect.any(Blob) }]);
  });

  it("refuses files for a running turn: its agent takes them only with a new turn", async () => {
    const h = harness();
    h.brain.script = () => "hang";
    const { sessionId } = await h.runner.runAdhoc({ instructions: "Work on it" });
    await vi.waitFor(() => expect(h.brain.starts).toHaveLength(1));
    await expect(h.runner.message(sessionId, "look at this", { attachments: [photo()] })).rejects.toThrow(FILES_WHILE_RUNNING);
    h.brain.ctls[0]!.resolve({ outcome: "done" });
    await settle(h);
  });

  it("a fresh agent session (the old one is gone) sees the earlier images again", async () => {
    const h = harness();
    const { sessionId } = await h.runner.runAdhoc({ instructions: "What is this?", attachments: [photo()] });
    await settle(h);
    h.brain.open.clear();
    await h.runner.message(sessionId, "and this one", { attachments: [photo("dog.png")] });
    await settle(h);
    const fresh = h.brain.starts[1]!;
    expect(fresh.attachments!.map((a) => [a.ref.name, a.fresh, a.base64 === btoa("png")])).toEqual([
      ["cat.png", false, true],
      ["dog.png", true, true],
    ]);
  });

  it("a conversation's files are deleted with it (the oldest go past MAX_SESSIONS)", async () => {
    const h = harness();
    const { sessionId } = await h.runner.runAdhoc({ instructions: "What is this?", attachments: [photo()] });
    await settle(h);
    expect(await h.attachments.list(sessionId)).toHaveLength(1);
    const later = (i: number) => new Date(Date.parse("2030-01-01T00:00:00Z") + i * 1000).toISOString();
    for (let i = 0; i < MAX_SESSIONS; i++) {
      await h.sessions.create({ sessionId: `x${i}`, source: "adhoc", title: "t", brain: "claude-api", jev: false, startedAt: later(i) });
    }
    expect(await h.sessions.get(sessionId)).toBeNull();
    expect(await h.attachments.list(sessionId)).toEqual([]);
  });
});
