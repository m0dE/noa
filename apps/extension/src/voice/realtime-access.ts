/**
 * What the side panel asks the background for hands-free voice: the voice
 * engines with their prices (GET VOICE_ENGINES_PATH, public), and the relay
 * address with the session token to open Realtime voice (the background
 * holds the session). Failures travel as data, like voice.transcribe.
 */
import type { VoiceEnginesResponse } from "@noa/shared";
import { errorMessage } from "@noa/shared";
import { realtimeUrl } from "./realtime-client.js";
import { toVoiceError, type VoiceErrorInfo } from "./transcribe.js";

/** Where the panel connects Realtime voice (WebSocket), and the token it offers there. */
export interface RealtimeTicket {
  url: string;
  token: string;
}

export type RealtimeTicketResult = RealtimeTicket | { error: VoiceErrorInfo };
export type VoiceEnginesResult = VoiceEnginesResponse | { error: string };

/** What the background needs of the account (AccountService). */
export interface RealtimeAccount {
  voiceEngines(): Promise<VoiceEnginesResponse>;
  /** The signed-in session's server and token. Throws NotSignedInError. */
  realtimeSession(): Promise<{ apiBase: string; token: string }>;
}

const SIGNED_OUT: VoiceErrorInfo = { kind: "signed-out", message: "Log in to use voice.", fatal: true };

export async function voiceEnginesForPanel(account: RealtimeAccount | undefined): Promise<VoiceEnginesResult> {
  if (!account) return { error: "Accounts are not available" };
  try {
    return await account.voiceEngines();
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export async function realtimeTicketForPanel(account: RealtimeAccount | undefined, sessionId?: string): Promise<RealtimeTicketResult> {
  if (!account) return { error: SIGNED_OUT };
  try {
    const s = await account.realtimeSession();
    return { url: realtimeUrl(s.apiBase, sessionId), token: s.token };
  } catch (err) {
    return { error: toVoiceError(err).info };
  }
}
