/**
 * Voice clips to text. The side panel asks the background (UI request
 * "voice.transcribe"), which holds the session and posts the clip with the
 * account API. Failures travel as data, mapped to plain messages here, since
 * UI request errors are plain strings.
 */
import { OutOfCreditError, PlanRequiredError, plansWithText, VOICE_LIMITS } from "@noa/shared";
import { ApiRequestError, NotSignedInError } from "../http-client.js";
import { base64ToBytes, bytesToBase64 } from "../base64.js";
import type { TranscribeClip } from "./dictation.js";

export type VoiceErrorKind = "plan" | "credit" | "signed-out" | "rate" | "too-long" | "server" | "network";

export interface VoiceErrorInfo {
  kind: VoiceErrorKind;
  /** What the panel shows. */
  message: string;
  /** Ends the listening session (asking again will not help). */
  fatal: boolean;
}

export class VoiceError extends Error {
  readonly kind: VoiceErrorKind;
  readonly fatal: boolean;

  constructor(info: VoiceErrorInfo) {
    super(info.message);
    this.name = "VoiceError";
    this.kind = info.kind;
    this.fatal = info.fatal;
  }

  get info(): VoiceErrorInfo {
    return { kind: this.kind, message: this.message, fatal: this.fatal };
  }
}

const SIGNED_OUT: VoiceErrorInfo = { kind: "signed-out", message: "Log in to use voice.", fatal: true };

/** The plain message for a failed transcription. */
export function toVoiceError(err: unknown): VoiceError {
  if (err instanceof VoiceError) return err;
  if (err instanceof NotSignedInError) return new VoiceError(SIGNED_OUT);
  if (err instanceof ApiRequestError) {
    const plan = PlanRequiredError.safeParse(err.body);
    if (plan.success) return new VoiceError({ kind: "plan", message: `Voice needs ${plansWithText("voice")}.`, fatal: true });
    if (OutOfCreditError.safeParse(err.body).success) {
      return new VoiceError({ kind: "credit", message: "You're out of usage credit. Top up to keep using voice.", fatal: true });
    }
    switch (err.status) {
      case 401:
        return new VoiceError(SIGNED_OUT);
      case 413:
        return new VoiceError({ kind: "too-long", message: `Voice messages can be up to ${VOICE_LIMITS.maxClipMs / 1000} seconds.`, fatal: true });
      case 429:
        return new VoiceError({ kind: "rate", message: "Too many voice requests. Try again in a minute.", fatal: true });
    }
    return new VoiceError({ kind: "server", message: "Voice isn't working right now. Try again in a moment.", fatal: false });
  }
  return new VoiceError({ kind: "network", message: "Can't reach Noa. Check your connection.", fatal: false });
}

/** One clip for the background (UI request "voice.transcribe"). */
export interface VoiceClipRequest {
  /** The WAV file, base64. */
  wav: string;
  speechMs: number;
  context?: string;
  /** The chat the dictation is for (ties the usage to it). */
  sessionId?: string;
  /** The language picked in Settings (ISO 639-1); absent: the model detects it. */
  language?: string;
}

/** The background's answer: the text, or the failure as data. */
export type VoiceTranscribeResult = { text: string } | { error: VoiceErrorInfo };

/** What the background needs of the account (AccountService.transcribe). */
export interface VoiceAccount {
  transcribe(wav: Uint8Array, opts: { speechMs?: number; context?: string; sessionId?: string; language?: string }): Promise<{ text: string }>;
}

/** Background: transcribes one clip with the signed-in account. */
export async function transcribeForPanel(account: VoiceAccount | undefined, req: VoiceClipRequest): Promise<VoiceTranscribeResult> {
  if (!account) return { error: SIGNED_OUT };
  try {
    const { text } = await account.transcribe(base64ToBytes(req.wav), {
      speechMs: req.speechMs,
      ...(req.context ? { context: req.context } : {}),
      ...(req.sessionId ? { sessionId: req.sessionId } : {}),
      ...(req.language ? { language: req.language } : {}),
    });
    return { text };
  } catch (err) {
    return { error: toVoiceError(err).info };
  }
}

/** Panel: a TranscribeClip for Dictation that asks the background. Rejects with VoiceError. `language`: the one picked in Settings. */
export function panelTranscriber(
  send: (req: VoiceClipRequest) => Promise<VoiceTranscribeResult>,
  sessionId: () => string | undefined = () => undefined,
  language: () => string | null | undefined = () => undefined,
): TranscribeClip {
  return async (wav, req) => {
    const id = sessionId();
    const lang = language();
    let res: VoiceTranscribeResult;
    try {
      res = await send({
        wav: bytesToBase64(wav),
        speechMs: req.speechMs,
        ...(req.context ? { context: req.context } : {}),
        ...(id ? { sessionId: id } : {}),
        ...(lang ? { language: lang } : {}),
      });
    } catch (err) {
      throw toVoiceError(err); // the background is restarting: like a network blip
    }
    if ("error" in res) throw new VoiceError(res.error);
    return res.text;
  };
}
