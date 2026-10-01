/**
 * The offscreen document (offscreen.html) that plays notifications for the background
 * (notice-voice.ts): a Realtime voice, a Deepgram voice, or the chime. One at a time, in the
 * order asked. A line that could not be said answers the error, and the background says it with
 * Chrome's speech instead.
 */
import { errorMessage } from "@noa/shared";
import { uiRequest } from "../ui-protocol.js";
import { DeepgramSpeaker } from "./deepgram-speaker.js";
import { Earcons } from "./earcons.js";
import { isNoticeSay, NOTICE_INSTRUCTIONS, type NoticeSayResult, type NoticeSound } from "./notice-voice.js";
import { sayRealtimeSample } from "./realtime-sample.js";
import { VoiceError } from "./transcribe.js";

/** How long the chime lasts (three notes, NOTICE_SHAPE), before the next sound. */
const CHIME_MS = 700;

let queue: Promise<unknown> = Promise.resolve();
const earcons = new Earcons(undefined, (m) => console.warn(`[noa] ${m}`));

async function play(sound: NoticeSound): Promise<void> {
  if (sound.kind === "chime") {
    earcons.play("notice");
    await new Promise((resolve) => setTimeout(resolve, CHIME_MS));
    return;
  }
  if (sound.kind === "realtime") {
    await sayRealtimeSample({
      ticket: async () => {
        const r = await uiRequest({ type: "voice.realtime", ...(sound.mini ? { tier: "mini" as const } : {}) });
        if ("error" in r) throw new VoiceError(r.error);
        return r;
      },
      voice: sound.voice,
      speed: sound.speed,
      text: sound.line,
      instructions: NOTICE_INSTRUCTIONS,
    });
    return;
  }
  let failed: unknown = null;
  let started = false;
  await new DeepgramSpeaker({
    settings: () => ({ voice: sound.voice, speed: sound.speed }),
    fetch: (text, voice) =>
      uiRequest({ type: "voice.speak", text, voice }).catch((err: unknown) => {
        failed = err;
        throw err;
      }),
    onError: (err) => (failed = err),
  }).speak(sound.line, { onStart: () => (started = true) });
  if (!started) throw failed ?? new Error("The Deepgram voice could not play");
}

async function answer(sound: NoticeSound): Promise<NoticeSayResult> {
  try {
    await play(sound);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !isNoticeSay(msg)) return false;
  const next = queue.then(() => answer(msg.sound));
  queue = next;
  void next.then(sendResponse);
  return true;
});
