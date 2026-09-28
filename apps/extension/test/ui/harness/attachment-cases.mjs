// Files in the chat (sidepanel/attachments/): chips in the input box from the paperclip, paste and drop; their
// errors; and the thumbnails and file chips on the messages they were sent with. Run like PANEL_CASES at each panel
// size and scheme.
import { zipBuffer } from "../../../../../scripts/lib/zip.mjs";
import { thumbnail } from "./scenarios.mjs";

const DOC_XML = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Launch on Friday at 9.</w:t></w:r></w:p></w:body></w:document>`;
const docx = () => zipBuffer([{ name: "word/document.xml", data: Buffer.from(DOC_XML) }]);
const jpeg = () => Buffer.from(thumbnail, "base64");

/** The input box's chips: name, meta line, whether it shows a thumbnail, a warning, its remove button's name. */
const chips = (p) =>
  p.evaluate(() =>
    [...document.querySelectorAll("#now-files-list .att-chip")].map((c) => ({
      name: c.querySelector(".att-name").textContent,
      meta: c.querySelector(".att-meta").textContent,
      thumb: !!c.querySelector("img.att-thumb"),
      badge: c.querySelector(".att-badge")?.textContent ?? null,
      warn: c.classList.contains("warn"),
      remove: c.querySelector(".att-remove").getAttribute("aria-label"),
    })),
  );
const waitReady = (p, n) => p.waitForFunction((count) => document.querySelectorAll("#now-files-list .att-chip:not(.preparing)").length === count, n);

export const ATTACHMENT_CASES = [
  // The paperclip adds a picture, a PDF, a Word document and a text file with a key in it: a chip each (the picture
  // with its thumbnail, the others with a type badge, the text file warned about); the keyboard removes one and the
  // focus goes to the next chip. The attach button works in a conversation too.
  {
    names: ["panel-attach-chips", "panel-attach-chips-conversation"],
    async run({ ctx, size, scheme, label, fail, want, openPanel, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "idle");
      await p.setInputFiles("#now-files", [
        { name: "sunrise-over-the-bay.jpg", mimeType: "image/jpeg", buffer: jpeg() },
        { name: "q3-report.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 fake") },
        { name: "launch-plan.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: docx() },
        { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from(`deploy with api_key=${["sk", "ant", "abcdefghijklmnopqrstu"].join("-")}`) },
      ]);
      await waitReady(p, 4);
      const got = await chips(p);
      const names = got.map((c) => c.name).join(",");
      if (names !== "sunrise-over-the-bay.jpg,q3-report.pdf,launch-plan.docx,notes.txt") fail(`attach: chips ${names}`);
      if (!got[0]?.thumb || got[1]?.badge !== "PDF" || got[2]?.badge !== "DOCX") fail(`attach: chip looks ${JSON.stringify(got)}`);
      if (!got[3]?.warn || got.slice(0, 3).some((c) => c.warn)) fail(`attach: only the text file with a key is warned about ${JSON.stringify(got)}`);
      if (got[0]?.remove !== "Remove sunrise-over-the-bay.jpg") fail(`attach: remove button name ${got[0]?.remove}`);
      await p.click("#now-text");
      await p.keyboard.insertText("Summarize the report and post the photo with the plan's date");
      await checkLayout(p, `attach-chips ${label}`);
      await shoot(p, "panel-attach-chips", size, scheme);
      // Keyboard: remove the PDF; the focus moves to the next chip's remove button.
      await p.focus('#now-files-list [aria-label="Remove q3-report.pdf"]');
      await p.keyboard.press("Enter");
      const after = await p.evaluate(() => ({ n: document.querySelectorAll("#now-files-list .att-chip").length, focus: document.activeElement?.getAttribute("aria-label") }));
      if (after.n !== 3 || after.focus !== "Remove launch-plan.docx") fail(`attach: keyboard remove ${JSON.stringify(after)}`);
      // The paperclip is a keyboard control too.
      const clip = await p.evaluate(() => {
        const a = document.getElementById("now-attach");
        return { tab: a.tabIndex, role: a.getAttribute("role"), hidden: a.hidden };
      });
      if (clip.tab !== 0 || clip.role !== "button" || clip.hidden) fail(`attach: paperclip ${JSON.stringify(clip)}`);
      reportErrors(p, `attach-chips ${label}`);
      await p.close();

      if (want("panel-attach-chips-conversation", size, scheme)) {
        const c = await openPanel(ctx, "conversation", "#chat-log .ev-user");
        await c.waitForFunction(() => document.getElementById("now-text").placeholder === "Message Noa…");
        if (await c.evaluate(() => document.getElementById("now-attach").hidden)) fail("attach: no paperclip in a conversation");
        await c.setInputFiles("#now-files", [{ name: "receipt.jpg", mimeType: "image/jpeg", buffer: jpeg() }]);
        await waitReady(c, 1);
        await c.click("#now-text");
        await c.keyboard.insertText("Add this receipt to the expense form");
        await c.keyboard.press("Enter");
        await c.waitForFunction(() => window.__requests.some((r) => r.type === "run.message" && r.attachments?.length));
        const req = await c.evaluate(() => window.__requests.filter((r) => r.type === "run.message").at(-1));
        const a = req.attachments[0];
        if (req.sessionId !== "s-conv" || a?.name !== "receipt.jpg" || a.type !== "image/jpeg" || !a.width || !a.thumb?.startsWith("data:image/jpeg")) fail(`attach: follow-up sent ${JSON.stringify({ ...req, attachments: req.attachments.map((x) => ({ ...x, dataBase64: x.dataBase64.length, thumb: !!x.thumb })) })}`);
        if (await c.evaluate(() => document.querySelectorAll("#now-files-list .att-chip").length)) fail("attach: the chips stayed after sending");
        await checkLayout(c, `attach-conversation ${label}`);
        await shoot(c, "panel-attach-chips-conversation", size, scheme);
        reportErrors(c, `attach-conversation ${label}`);
        await c.close();
      }
    },
  },
  // Errors say what is wrong, above the box: too many files, a file that is not what it claims, one too large.
  // A pasted screenshot and a file dropped on the panel are added like picked ones.
  {
    names: ["panel-attach-errors", "panel-attach-drop"],
    async run({ ctx, size, scheme, label, fail, want, openPanel, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "idle");
      const notice = () => p.evaluate(() => document.getElementById("now-notice").hidden ? null : (document.querySelector("#now-notice .notice-text")?.textContent ?? null));
      await p.setInputFiles("#now-files", [{ name: "not-really.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.from("plain text") }]);
      await p.waitForFunction(() => /not a Word document/.test(document.getElementById("now-notice").textContent));
      if (await p.evaluate(() => document.querySelectorAll("#now-files-list .att-chip").length)) fail("attach: a broken .docx was kept");
      await p.setInputFiles("#now-files", Array.from({ length: 11 }, (_, i) => ({ name: `page-${i + 1}.txt`, mimeType: "text/plain", buffer: Buffer.from(`page ${i + 1}`) })));
      await waitReady(p, 10);
      const text = await notice();
      if (text !== "At most 10 files per message: 1 not added") fail(`attach: too many files said "${text}"`);
      await checkLayout(p, `attach-errors ${label}`);
      await shoot(p, "panel-attach-errors", size, scheme);
      // An empty box with files: a hint, nothing sent (after the error is dismissed: one notice at a time).
      await p.click("#now-notice .notice-close");
      await p.click("#now-text");
      await p.keyboard.press("Enter");
      await p.waitForFunction(() => document.querySelector("#now-notice .notice-text")?.textContent === "Say what to do with the files");
      if (await p.evaluate(() => window.__requests.some((r) => r.type === "run.adhoc"))) fail("attach: an empty message with files was sent");
      reportErrors(p, `attach-errors ${label}`);
      await p.close();

      if (want("panel-attach-drop", size, scheme)) {
        const d = await openPanel(ctx, "idle");
        const image = thumbnail;
        // Paste a screenshot (the clipboard holds only the image).
        await d.evaluate((b64) => {
          const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
          const dt = new DataTransfer();
          dt.items.add(new File([bytes], "image.png", { type: "image/jpeg" }));
          document.getElementById("now-text").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
        }, image);
        await waitReady(d, 1);
        // Drag a file over the panel: the box says where it goes; dropping adds it.
        await d.evaluate(() => {
          const dt = new DataTransfer();
          dt.items.add(new File(["a,b\n1,2\n"], "prices.csv", { type: "text/csv" }));
          window.__dropData = dt;
          document.getElementById("chat-log").dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true }));
          document.getElementById("chat-log").dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
        });
        if (!(await d.evaluate(() => document.body.classList.contains("dropping-files")))) fail("attach: dragging files over the panel shows nothing");
        await checkLayout(d, `attach-drop ${label}`);
        await shoot(d, "panel-attach-drop", size, scheme);
        await d.evaluate(() => document.getElementById("chat-log").dispatchEvent(new DragEvent("drop", { dataTransfer: window.__dropData, bubbles: true, cancelable: true })));
        await waitReady(d, 2);
        const got = (await chips(d)).map((c) => c.name).join(",");
        const dropping = await d.evaluate(() => document.body.classList.contains("dropping-files"));
        if (got !== "image.png,prices.csv" || dropping) fail(`attach: paste and drop gave ${got} (still dropping: ${dropping})`);
        reportErrors(d, `attach-drop ${label}`);
        await d.close();
      }
    },
  },
  // Sent: the first message shows the picture's thumbnail and the document's chip; a follow-up's files show on its
  // bubble; the files are references with thumbnails, never the file data.
  {
    names: ["panel-attach-sent"],
    async run({ ctx, size, scheme, label, fail, openPanel, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "idle");
      await p.setInputFiles("#now-files", [
        { name: "sunrise-over-the-bay.jpg", mimeType: "image/jpeg", buffer: jpeg() },
        { name: "launch-plan.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: docx() },
      ]);
      await waitReady(p, 2);
      await p.click("#now-text");
      await p.keyboard.insertText("Post the sunrise photo on X with the launch date from the plan");
      await p.keyboard.press("Enter");
      await p.waitForFunction(() => window.__requests.some((r) => r.type === "run.adhoc"));
      const sent = await p.evaluate(() => window.__requests.find((r) => r.type === "run.adhoc").attachments.map((a) => ({ name: a.name, text: a.text ?? null, thumb: !!a.thumb })));
      if (sent[1]?.text !== "Launch on Friday at 9." || !sent[0]?.thumb) fail(`attach: run.adhoc sent ${JSON.stringify(sent)}`);
      await p.waitForSelector("#chat-log .ev-first .ev-attachments");
      await p.evaluate((ts) => {
        const refs = window.__attachmentRefs([{ name: "table.csv", type: "text/csv", dataBase64: "YSxiCjEsMgo=" }]);
        const push = (e) => window.__push({ type: "event", event: { ...e, ts, sessionId: "s-new" } });
        push({ type: "task_end", outcome: "done", summary: "Posted the photo with 'Launch on Friday'" });
        push({ type: "user_message", text: "Now make a table from this", attachments: refs });
      }, new Date().toISOString());
      await p.waitForSelector("#chat-log > .ev-user .ev-attachments");
      const look = await p.evaluate(() => ({
        first: [...document.querySelectorAll("#chat-log .ev-first .att-sent")].map((a) => (a.querySelector("img") ? `img:${a.querySelector("img").alt}` : a.textContent)),
        next: [...document.querySelectorAll("#chat-log > .ev-user .att-sent")].map((a) => a.textContent),
        label: document.querySelector("#chat-log .ev-first .ev-attachments").getAttribute("aria-label"),
      }));
      if (JSON.stringify(look.first) !== JSON.stringify(["img:sunrise-over-the-bay.jpg", "DOCXlaunch-plan.docx"]) || JSON.stringify(look.next) !== JSON.stringify(["CSVtable.csv"])) fail(`attach: bubbles ${JSON.stringify(look)}`);
      if (look.label !== "2 files sent with this message") fail(`attach: strip label ${look.label}`);
      await checkLayout(p, `attach-sent ${label}`);
      await shoot(p, "panel-attach-sent", size, scheme);
      reportErrors(p, `attach-sent ${label}`);
      await p.close();
    },
  },
];
