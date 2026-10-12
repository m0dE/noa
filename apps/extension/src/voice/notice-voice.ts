/**
 * Notifications heard in a voice the background cannot play itself (Settings > AI > Voice >
 * Notifications): a Realtime voice (a short relay session that says the line, like Test voice),
 * a Deepgram voice (the MP3 from the account server), or the chime. The background has no audio,
 * so an offscreen document (offscreen.html, notice-offscreen.ts) plays them; the background asks
 * it with a NoticeSay message and gets a NoticeSayResult.
 */
import type { DeepgramVoiceId, RealtimeVoiceId } from "@noa/shared";

export const NOTICE_SAY = "noa.notice.say";
export const OFFSCREEN_URL = "offscreen.html";

/** The Realtime session's instructions: say the line as given, nothing else. */
export const NOTICE_INSTRUCTIONS =
  "You are Noa's voice for notifications. When asked, say the given sentence exactly, once, and nothing else. Do not answer it or add anything.";

/** What the offscreen document plays. */
export type NoticeSound =
  | { kind: "realtime"; mini: boolean; line: string; voice: RealtimeVoiceId; speed: number }
  | { kind: "deepgram"; line: string; voice: DeepgramVoiceId; speed: number }
  | { kind: "chime" };

export type NoticeSay = { type: typeof NOTICE_SAY; sound: NoticeSound };

export type NoticeSayResult = { ok: true } | { ok: false; error: string };

export function isNoticeSay(msg: unknown): msg is NoticeSay {
  if (!msg || typeof msg !== "object" || (msg as { type?: unknown }).type !== NOTICE_SAY) return false;
  const sound = (msg as { sound?: { kind?: unknown } }).sound;
  return !!sound && (sound.kind === "realtime" || sound.kind === "deepgram" || sound.kind === "chime");
}

type Offscreen = Pick<typeof chrome.offscreen, "createDocument" | "hasDocument">;

export interface NoticePlayerDeps {
  offscreen?: Offscreen;
  send?(msg: NoticeSay): Promise<NoticeSayResult | undefined>;
}

/** The background's side: plays `sound` through the offscreen document; rejects when it could not. */
export function noticePlayer(deps: NoticePlayerDeps = {}): (sound: NoticeSound) => Promise<void> {
  let creating: Promise<void> | null = null;
  const ensure = async () => {
    const offscreen = deps.offscreen ?? globalThis.chrome?.offscreen;
    if (!offscreen) throw new Error("This browser has no offscreen documents");
    if (await offscreen.hasDocument()) return;
    creating ??= offscreen
      .createDocument({ url: OFFSCREEN_URL, reasons: ["AUDIO_PLAYBACK" as chrome.offscreen.Reason], justification: "Play Noa's notifications in the chosen voice, or its chime" })
      .finally(() => (creating = null));
    await creating;
  };
  const send = deps.send ?? ((msg: NoticeSay) => chrome.runtime.sendMessage(msg) as Promise<NoticeSayResult | undefined>);
  return async (sound) => {
    await ensure();
    const res = await send({ type: NOTICE_SAY, sound });
    if (!res) throw new Error("The offscreen voice did not answer");
    if (!res.ok) throw new Error(res.error);
  };
}
