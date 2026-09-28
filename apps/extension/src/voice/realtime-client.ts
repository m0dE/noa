/**
 * The Realtime voice transport: one WebSocket to the account server's relay
 * (REALTIME_PATH), which passes OpenAI Realtime events through verbatim and
 * adds its own `noa.error` events and close codes (the contract is
 * in @noa/shared voice.ts). Everything that depends on the wire
 * format is in this file.
 *
 * The Realtime model is the narrator, not the browser agent: it hears the
 * user (server VAD, with barge-in), says short lines, is told what the agent
 * does (note(), see realtime-feed.ts) and hands requests to the agent through
 * its tools (send_to_agent, cancel_request, stop_task, use_this_tab,
 * end_voice), which the side panel runs. Notes also say which tab it works
 * in when the user looks at another one (it cannot see that tab).
 *
 * Input transcription is on (REALTIME_INPUT_TRANSCRIPTION_MODEL, which the
 * relay bills and the server's price includes), told the languages the user
 * speaks (voice-language.ts). The chat shows each request as the narrator
 * understood it (send_to_agent's text), with the user's words for it word for
 * word: the transcripts of every part of their speech since the last request
 * or spoken reply (server VAD may split one request into several turns). A
 * transcript in another script is either unclear (the narrator's own reading
 * counts; the words are kept as heard) or other people talking nearby (no
 * reply, no request, not kept). A send_to_agent goes out once its turn's words are in (at most
 * HOLD_FOR_WORDS_MS), and only for the user's own request: never for speech
 * not addressed to the assistant, and never for an update the narrator was
 * given (forwardRefusal). "stop" and "cancel" are the narrator's tools rather
 * than words matched here.
 *
 * OpenAI event names and shapes as documented (read 2026-09-26):
 * developers.openai.com/api/docs/guides/realtime-conversations,
 * /realtime-vad, /realtime-transcription, and the client/server event reference.
 */
import {
  PLAN_REQUIRED_MESSAGES,
  OUT_OF_CREDIT,
  REALTIME_CLOSE,
  REALTIME_ERROR_EVENT,
  REALTIME_INPUT_TRANSCRIPTION_MODEL,
  REALTIME_LIMITS,
  REALTIME_PATH,
  REALTIME_PROTOCOL,
  REALTIME_QUERY,
  REALTIME_TOKEN_PROTOCOL_PREFIX,
  RealtimeErrorEvent,
  clampSpeed,
  DEFAULT_REALTIME_VOICE,
  REALTIME_SPEED,
  type RealtimeErrorCode,
  type RealtimeVoiceId,
  type TraceDraft,
} from "@noa/shared";
import { bytesToBase64 } from "../base64.js";
import { REALTIME_UNAVAILABLE_TEXT } from "./engine-choice.js";
import { ECHO_WINDOW_MS, echoesSpoken, echoesUpdate, floor, isNoise, moreImportant, repeatsRequest, requestKind, speechTurnOf, type ForwardedRequest, type ReplyKind, type SpeechTurn, type SpokenKind } from "./narrator-policy.js";
import { transcriptFit, type TranscriptFit } from "./voice-language.js";

/** PCM16 mono at this rate, both ways ("audio/pcm" is 24 kHz). */
export const REALTIME_SAMPLE_RATE = 24_000;

/** Quiet after speech that ends the user's turn (server VAD). */
const TURN_SILENCE_MS = 700;
/**
 * Whether OpenAI cancels the reply being made the moment the user starts talking (server VAD's
 * interrupt_response). Off: its cancel also cut off a send_to_agent call being written (measured 2026-09-26 on
 * gpt-realtime-2.1: the user talking on ~400 ms after their pause ended the call's arguments mid-string, and the
 * request never reached the agent). The client cancels instead (bargeIn), after any call it is writing.
 */
const SERVER_INTERRUPTS_REPLY = false;
/** The user's turn is in and its reply is expected this long; past it (no reply came) the floor is free again. */
const AWAIT_REPLY_MS = 5_000;
/**
 * A reply to the user's speech is held (its audio and words not played or shown) until their words are in, and then
 * played (small talk), dropped (a request: only a tool answers it; noise), or made again when it answered a request by
 * itself (MAKE_AGAIN_RESPONSE). The server still starts the reply the moment their turn ends (create_response): a
 * request's send_to_agent is never waited for, and a spoken reply's first audio (550-850 ms after the turn) mostly
 * comes after the words (median 528 ms, 385-763 ms, once 1.1 s in 25 turns), so holding adds nothing to most turns,
 * where waiting for the words before making any reply (create_response off) would add ~530 ms to every turn,
 * requests included (measured on gpt-realtime-2.1 with gpt-transcribe, 2026-09-27). Words later than this (from the
 * reply's start) release what is held, as before.
 */
export const HOLD_FOR_WORDS_MS = 1_500;

export const NARRATOR_INSTRUCTIONS = [
  "You are Noa, the assistant doing the user's tasks in their Chrome browser. To the user there is only you: you do the work, so speak of it in the first person ('Checking whether it posted.', 'Not done yet: I'm still signed in as Rooftop Chat.'). Never speak of anyone else doing it, and never of handing requests over or waiting to hear back.",
  "You act in the browser through send_to_agent. When the user asks for something, call send_to_agent immediately, before saying anything, with kind 'question' when they ask you something, talk with you or correct a misunderstanding, or 'instruction' for a new task or a change to the current one. Your answer to a question comes as an update; an instruction gets a short acknowledgement made for you. Never say yourself what you will do or when.",
  "What you did, saw, found or remember in the browser comes only through send_to_agent. Anything about that, any follow-up, correction or clarification of a request (for example 'no, I mean yesterday'), and any question that needs the browser, the user's accounts or memory: call send_to_agent with the user's words. Never answer those yourself from the updates, never guess dates or times, and never say again an answer you already gave.",
  "Answer by yourself only small talk (a greeting, 'can you hear me', thanks) or what you are doing right now according to the latest update, in one short sentence in the first person.",
  "Give send_to_agent the request in the user's own words, keeping every detail (names, the text to post, times). A message for the running task (for example 'use the second draft') goes the same way.",
  "If right after that the user says 'cancel', 'never mind' or 'don't send it', call cancel_request: the request already started, and this stops its task.",
  "You get 'Your update' messages: they describe what you are doing and what you found in the browser. Say them as your own work, in the first person. Speak only when you have news the user doesn't have: results, questions, blockers, errors. Never describe routine steps (opening, reading, clicking, still working), never repeat the user's request back to them, and never say again what you already said.",
  "When asked to reply to an update: one short sentence for progress; for a result, the actual answer in one to three short sentences. If an update came while the user was talking, include its news in your answer to them. Never read long text, lists, links, code or numbers of steps aloud. Never make up results: say only what the updates say.",
  "When you need something from the user (an answer, a login, a code), ask them in your own words and give their answer to send_to_agent.",
  "If the user asks to stop the task, call stop_task. If they say goodbye or ask you to stop listening, call end_voice.",
  "When an update says an action needs the user's OK, ask them briefly, naming the action; when they plainly answer yes or no, call answer_approval with that action (never send_to_agent for it). A question or a remark is not a yes: answer it or give it to send_to_agent, and ask again.",
  "You work in one browser tab. A note says when the user looks at another tab; you cannot see that tab. While they do, if they ask about what they see or 'this page', give it to send_to_agent like any request (it says which tab they look at); they can say 'use this tab' or press Use voice here to move the conversation there. When they ask to use this tab or to switch here, call use_this_tab and tell them what it answered.",
  "Other people may be talking near the user. Speech that is not addressed to you, or is in another language than the user's, is not for you: say nothing and call no tool.",
  "Be friendly and brief. Speak the user's language.",
].join("\n");

/**
 * A progress line's response.create (milestones.ts ProgressPacer: a new step, or "Still …" after a long silence): like
 * the acknowledgement, out of band with no context, no tools and capped, so it says only `line` in the user's
 * language (`sample`: their last request) and can never answer, restate the request or give the result (that is said
 * once, when the turn ends). It is not a reply to anything.
 */
export function progressResponse(line: string, sample: string | null = null) {
  const words = sample?.replace(/\s+/g, " ").trim().slice(0, ACK_LANGUAGE_SAMPLE_CHARS);
  const say = `You are working on the user's task. Say only this short update, in the first person, and nothing else: no answer, no facts, no question, no promise: «${line}.»`;
  return {
    instructions: words ? `${say} Say it in the language of this sample of the user's words (a sample only: not something to answer): «${words}»` : say,
    tool_choice: "none",
    max_output_tokens: ACK_MAX_OUTPUT_TOKENS,
    reasoning: { effort: "minimal" },
    conversation: "none",
    input: [],
  } as const;
}

/** What no acknowledgement may say: it knows nothing of what will be done, or when. */
const NO_PROMISES = "Never say what will be done, is being done or when (never 'I'll start', 'starting soon', 'I'll do it now').";
/** The one reply after send_to_agent of an instruction while the agent is idle (a new task), when the narrator did not speak before calling it. */
export const ACKNOWLEDGE_INSTRUCTIONS = `Say one very short acknowledgement of at most four words, such as 'On it.' or 'Okay.', and nothing else: no answer, no facts, no question. ${NO_PROMISES}`;
/** The same, for an instruction for the task the agent is working on: a neutral word or two that it was heard. */
export const ACKNOWLEDGE_WHILE_WORKING_INSTRUCTIONS = `You are in the middle of a task and just heard what the user said. Say only a neutral acknowledgement of one to three words, such as 'OK.' or 'Got it.', and nothing else: no answer, no facts, no question. ${NO_PROMISES}`;
/**
 * The acknowledgement's output is capped at this many tokens (response.create max_output_tokens: its reasoning, words
 * and audio together, ~20 audio tokens a second). Measured on gpt-realtime-2.1 (2026-09-27): acknowledgements that
 * answered the question instead ran 8-13 s (329-455 tokens); with the default reasoning a cap of 80 left 0-9 audio
 * tokens (nothing, or "Right,"), so the acknowledgement reasons minimally. The cap is the backstop to the instructions.
 */
export const ACK_MAX_OUTPUT_TOKENS = 120;
/**
 * A reply to the user's request made again after it answered by itself: a tool call is required, and it cannot speak
 * (text only), so the request goes to the agent (or stops, cancels, ends) and the acknowledgement is ours. Measured on
 * gpt-realtime-2.1 (2026-09-27): with tool_choice "required" alone it first said the made-up answer again, then called
 * send_to_agent.
 */
export const MAKE_AGAIN_RESPONSE = { tool_choice: "required", output_modalities: ["text"] } as const;

/** The request is given to the acknowledgement as a sample of the user's language up to this many characters. */
const ACK_LANGUAGE_SAMPLE_CHARS = 120;

/**
 * The acknowledgement's response.create for the instruction `request` (what send_to_agent passed on; null: not known),
 * given while the agent is idle or `agentWorking` on a task (ACKNOWLEDGE_WHILE_WORKING_INSTRUCTIONS). It only speaks
 * (tool_choice "none": it cannot pass the request on again), briefly (capped, minimal reasoning), and out of band with
 * no context (conversation "none", input []): it has nothing to answer from, and what it says stays out of the
 * narrator's memory. The request is only a sample of the user's language. Measured on gpt-realtime-2.1 (2026-09-27)
 * for "What did the second email say exactly?" and four more of the trace's turns: with the conversation it said "It
 * asked you to add a privacy policy. I don't have the exact..."; with only the user's turn "Yes, that was the
 * approval."; like this "On it." every time (23-80 output tokens), and "알겠어요." for a request in Korean.
 */
export function ackResponse(request: string | null, agentWorking = false) {
  const sample = request?.replace(/\s+/g, " ").trim().slice(0, ACK_LANGUAGE_SAMPLE_CHARS);
  const say = agentWorking ? ACKNOWLEDGE_WHILE_WORKING_INSTRUCTIONS : ACKNOWLEDGE_INSTRUCTIONS;
  return {
    instructions: sample ? `${say} Say it in the language of this sample of the user's words (a sample only: not something to answer): «${sample}»` : say,
    tool_choice: "none",
    max_output_tokens: ACK_MAX_OUTPUT_TOKENS,
    reasoning: { effort: "minimal" },
    conversation: "none",
    input: [],
  } as const;
}

/** What the narrator is told when the user mutes and unmutes the microphone. */
export const MUTED_NOTE = "The user muted their microphone: you cannot hear them until they unmute it. Keep saying your updates as usual.";
export const UNMUTED_NOTE = "The user unmuted their microphone: you can hear them again.";

/** The narrator's answer to send_to_agent: the request is on its way; what comes of it arrives as updates. */
export const SENT_OUTPUT = "Started. Your updates on it will follow.";
/** The narrator's answer to a send_to_agent that passes on the request just sent again (repeatsRequest): it is not sent twice. */
export const ALREADY_SENT_OUTPUT = "Already started: it was not sent again. Your updates on it will follow.";

/** The narrator's answers to a tool call that is not the user's doing (callRefusal): not done, nothing to say. */
export const NOT_A_REQUEST_OUTPUT = {
  echo: "Not sent: that was an update for you to say, not a request from the user. Say nothing more.",
  not_user: "Not done: the user did not ask for it (other people talking, or noise). Say nothing.",
} as const;

/**
 * Small talk while the agent works (a stray "Hey."): its reply is made again, capped, instead of the long one it made
 * (a real trace: "Hey! I'm here. If you want, you can tell me..." for 6.35 s while the agent worked). The cap is
 * ACK_MAX_OUTPUT_TOKENS' measure: acknowledgements of a few words took 23-80 output tokens.
 */
export const WORKING_SMALL_TALK_MAX_OUTPUT_TOKENS = 80;
export const WORKING_SMALL_TALK_RESPONSE = {
  instructions:
    "You are working on the user's request right now. Answer what the user just said in at most five words, in their language (for example 'Still on it.' or 'I'm here.'), and nothing else: no question, no offer.",
  tool_choice: "none",
  max_output_tokens: WORKING_SMALL_TALK_MAX_OUTPUT_TOKENS,
  reasoning: { effort: "minimal" },
} as const;

/** The narrator's tools (function tools only: the relay refuses others). */
export const NARRATOR_TOOLS = [
  {
    type: "function",
    name: "send_to_agent",
    description:
      "Do what the user asks in the browser: a new task, or a message for the task you are running. It starts at once. Use the user's own words and keep every detail.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The request, in the user's words" },
        kind: {
          type: "string",
          enum: ["question", "instruction"],
          description: "question: the user asks you something, talks with you, or corrects a misunderstanding (your answer comes as an update). instruction: a new task, or a change to the current one.",
        },
      },
      required: ["text", "kind"],
    },
  },
  {
    type: "function",
    name: "cancel_request",
    description: "The user takes back the request just given to send_to_agent (cancel, never mind). It already started, so this stops its task.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "stop_task",
    description: "Stop the task you are running, when the user asks to stop it.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "answer_approval",
    description:
      "The user's answer to the action waiting for their OK: allow true only when the user plainly said yes to it (it runs once), false for no (it is not done). A question or anything else is not a yes: ask them plainly first.",
    parameters: {
      type: "object",
      properties: {
        allow: { type: "boolean", description: "true: allow it once; false: deny it" },
        action: { type: "string", description: 'The action they answered, as the update named it (e.g. Click "Post"). Required to allow.' },
      },
      required: ["allow"],
    },
  },
  {
    type: "function",
    name: "use_this_tab",
    description:
      "Move the conversation to the browser tab the user is looking at now (they said 'use this tab', 'switch here'): what they say then goes to that tab's chat. The answer says whether it moved.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "end_voice",
    description: "End the hands-free conversation (the microphone turns off), when the user says goodbye or asks you to stop listening.",
    parameters: { type: "object", properties: {}, required: [] },
  },
] as const;

export type NarratorTool = (typeof NARRATOR_TOOLS)[number]["name"];
const TOOL_NAMES = new Set<string>(NARRATOR_TOOLS.map((t) => t.name));

/** The relay's address for an account server: wss://<host>/v1/ai/realtime (ws:// for a local http one). */
export function realtimeUrl(apiBase: string, sessionId?: string): string {
  const u = new URL(REALTIME_PATH, apiBase.replace(/\/+$/, "") + "/");
  u.protocol = u.protocol === "http:" ? "ws:" : "wss:";
  if (sessionId) u.searchParams.set(REALTIME_QUERY.session, sessionId);
  return u.toString();
}

/** The relay's address asking it to end the user's open session and take its place (REALTIME_QUERY.takeover). */
export function takeoverUrl(url: string): string {
  const u = new URL(url);
  u.searchParams.set(REALTIME_QUERY.takeover, "1");
  return u.toString();
}

// ---------------------------------------------------------------- failures

export type RealtimeFailureKind = "auth" | "credit" | "plan" | "idle" | "limit" | "busy" | "replaced" | "unavailable" | "upstream" | "protocol" | "network";

export interface RealtimeFailure {
  kind: RealtimeFailureKind;
  /** One line for the panel; auth, credit and plan use the texts error-help.ts knows (its fix buttons). */
  message: string;
  /**
   * A new connection may well work (the connection dropped; or, while connecting, the user's previous session is
   * still closing on the server): the panel reconnects Realtime a few times before it gives up. Never a reason to
   * change engine.
   */
  transient: boolean;
}

const minutes = (ms: number) => Math.round(ms / 60_000);

/** When the voice connection dropped and could not be made again. */
export const DISCONNECTED_MESSAGE = "Voice disconnected.";

const FAILURES: Record<RealtimeFailureKind, RealtimeFailure> = {
  auth: { kind: "auth", message: "Not signed in: log in again to use voice.", transient: false },
  credit: { kind: "credit", message: `${OUT_OF_CREDIT}: top up to keep using voice.`, transient: false },
  plan: { kind: "plan", message: PLAN_REQUIRED_MESSAGES.voice, transient: false },
  idle: { kind: "idle", message: `Hands-free stopped after ${minutes(REALTIME_LIMITS.idleMs)} minutes without activity.`, transient: false },
  limit: { kind: "limit", message: `Hands-free stopped: a Realtime session lasts up to ${minutes(REALTIME_LIMITS.maxSessionMs)} minutes.`, transient: false },
  busy: { kind: "busy", message: "Realtime voice is on in another window or on another device.", transient: true },
  replaced: { kind: "replaced", message: "Voice was turned on in another window, so it stopped here.", transient: false },
  unavailable: { kind: "unavailable", message: REALTIME_UNAVAILABLE_TEXT, transient: false },
  upstream: { kind: "upstream", message: DISCONNECTED_MESSAGE, transient: true },
  protocol: { kind: "protocol", message: DISCONNECTED_MESSAGE, transient: true },
  network: { kind: "network", message: DISCONNECTED_MESSAGE, transient: true },
};

const KIND_OF_ERROR: Partial<Record<RealtimeErrorCode, RealtimeFailureKind>> = {
  unauthorized: "auth",
  plan_required: "plan",
  out_of_credit: "credit",
  realtime_unavailable: "unavailable",
  session_open: "busy",
  session_replaced: "replaced",
  idle_timeout: "idle",
  session_limit: "limit",
  message_too_big: "protocol",
  upstream_error: "upstream",
};

const KIND_OF_CLOSE: Record<number, RealtimeFailureKind> = {
  [REALTIME_CLOSE.auth]: "auth",
  [REALTIME_CLOSE.credit]: "credit",
  [REALTIME_CLOSE.plan]: "plan",
  [REALTIME_CLOSE.idle]: "idle",
  [REALTIME_CLOSE.concurrent]: "busy",
  [REALTIME_CLOSE.sessionLimit]: "limit",
  [REALTIME_CLOSE.upstream]: "upstream",
  [REALTIME_CLOSE.unavailable]: "unavailable",
  [REALTIME_CLOSE.tooBig]: "protocol",
};

/** Why a session ended that we did not end: the server's error code first, then the close code. */
export function realtimeFailure(input: { closeCode: number; error?: RealtimeErrorCode; opened: boolean }): RealtimeFailure {
  const kind = (input.error && KIND_OF_ERROR[input.error]) || KIND_OF_CLOSE[input.closeCode] || (input.opened ? "upstream" : "network");
  return FAILURES[kind];
}

/** A failure object (a RealtimeFailure, or anything else thrown). */
export function asRealtimeFailure(err: unknown): RealtimeFailure | null {
  const f = err as Partial<RealtimeFailure> | null;
  return f && typeof f === "object" && typeof f.kind === "string" && f.kind in FAILURES && typeof f.message === "string" ? (f as RealtimeFailure) : null;
}

// ---------------------------------------------------------------- the client

/** The WebSocket as the client uses it (a fake in tests). */
export interface RealtimeSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type OpenSocket = (url: string, protocols: string[]) => RealtimeSocketLike;

const OPEN = 1;

export interface RealtimeHandlers {
  /** The session is configured (session.updated). */
  onReady?(): void;
  /** A chunk of the narrator's speech: base64 PCM16 at REALTIME_SAMPLE_RATE, of item `itemId`. */
  onAudio?(base64: string, itemId: string): void;
  /** What the narrator is saying so far. */
  onNarratorText?(text: string): void;
  /** A reply is complete (all its audio arrived). */
  onReplyDone?(): void;
  /** The user started talking (server VAD): the narrator stops; local playback must too. */
  onUserSpeech?(): void;
  /**
   * A narrator tool call; the answer goes back to the narrator (a throw is answered as an error).
   * inputId: the user's input item the reply making the call answers (null: a reply we asked for). heard: for
   * send_to_agent, the user's words for the request, word for word (every part of their speech since the last request
   * or spoken reply, in order); for answer_approval, the user's words of the turn it answers (clear ones only); [] for
   * other tools.
   */
  onTool?(name: NarratorTool, args: Record<string, unknown>, inputId: string | null, heard: string[]): Promise<string> | string;
  /** The user's words, word for word, for speech that led to no request (the narrator answered it, or acted on it). */
  onHeard?(words: string[]): void;
  /** The reply to input item `inputId` is done (its tool calls, if any, came before). */
  onTurnDone?(inputId: string): void;
  /** The session ended: null when we closed it, else why. */
  onClose?(failure: RealtimeFailure | null): void;
  /** The narrator's audio is still playing here (a new line waits for it). */
  playing?(): boolean;
  /** The reply being heard answers noise (an empty transcript of a short sound): its audio must stop. */
  onNoise?(): void;
  /**
   * Timing for the conversation's trace: "voice.connect" (the socket opening, the session ready, the model), one
   * "voice.narrator" per reply (what started it, the time to its first audio and to its end, tokens) and one
   * "voice.user_words" per input transcription. `inputId`: the user's input item it is about (null: none). The relay
   * does not report what a reply was charged (it meters on the server).
   */
  onTrace?(e: TraceDraft, inputId: string | null): void;
  log?(message: string): void;
}

/** When the user's input item ended (server VAD's speech_stopped) and was committed; epoch ms. */
interface InputTiming {
  speechEnd: number | null;
  committed: number;
}

/** Input items whose timing is remembered (their transcription may come after their reply). */
const MAX_INPUT_TIMINGS = 16;

/** A reply being made: what it answers (the user's input, else a request of ours), and its audio. */
interface Reply {
  inputId: string | null;
  /** Its answer to the user's speech, or what we asked it to say. */
  kind: ReplyKind;
  /** Bytes of audio (PCM16) it sent: its spoken length. */
  audioBytes: number;
  /** Epoch ms of what it answers: the end of the user's speech (else its commit), or our request. */
  from: number;
  created: number;
  firstAudio?: number;
  audioDeltas: number;
}

/** A reply to the user's speech held until their words are in (see HOLD_FOR_WORDS_MS). */
interface Held {
  inputId: string;
  /** Its audio (base64 PCM16, item id) and words so far: not played or shown yet. */
  audio: [string, string][];
  text: string;
  /** It calls a tool (the request is passed on). */
  called: boolean;
  /** Its response is done: its turn is settled (onTurnDone) once the hold is. */
  done: boolean;
  timer: ReturnType<typeof setTimeout>;
}

/** Input items whose kind of turn (speechTurnOf) is remembered until their reply starts. */
const MAX_TURN_KINDS = 16;

export interface RealtimeClientOptions {
  url: string;
  token: string;
  handlers: RealtimeHandlers;
  instructions?: string;
  /** The narrator's voice and speaking speed (Settings; the voice is fixed once it spoke). */
  voice?: RealtimeVoiceId;
  speed?: number;
  /** The languages the user speaks (voice-language.ts voiceLanguages): the transcription's hint, and what counts as theirs. */
  languages?: readonly string[];
  open?: OpenSocket;
}

/** What the transcription made of a user's turn. */
type TurnWords = { fit: TranscriptFit | "noise" | "echo" | "failed"; text: string };

/** The kind of a user's turn by its words: small talk or a request (speechTurnOf), or unclear (the narrator's reading counts). */
type TurnKind = SpeechTurn | "unclear";

/** Update notes remembered, to tell a send_to_agent that only passes one on (echoesUpdate). */
const MAX_REMEMBERED_NOTES = 12;

/** The transcription's context for the recording (gpt-transcribe's prompt). */
export const TRANSCRIPTION_PROMPT = "A person talking to Noa, a voice assistant in their web browser, about tasks in the browser.";

type ServerEvent = { type?: unknown; [k: string]: unknown };

export class RealtimeClient {
  private socket: RealtimeSocketLike | null = null;
  private opened = false;
  private closing = false;
  private ended = false;
  /** A reply is being made (response.created .. response.done). */
  private responding = false;
  /** The current (or last) reply was heard (its audio played): the narrator spoke in it. */
  private spoke = false;
  /** A line waiting for the floor (the most important one asked for; see narrator-policy.ts floor()). */
  private wantReply: SpokenKind | null = null;
  /** What our last response.create asked for (the reply it makes is traced as that). */
  private askedKind: SpokenKind | null = null;
  /** The user is talking (speech_started .. speech_stopped). */
  private userSpeaking = false;
  /** When the user's latest turn was committed (its reply is expected, AWAIT_REPLY_MS at most). */
  private committedAt = -Infinity;
  /** The reply being made was talked over: its further audio is not played. */
  private replyStale = false;
  /** The reply being made is writing a tool call's arguments (its output item started, its arguments are not done). */
  private writingCall = false;
  /** The user talked over the reply while it wrote a tool call: it is cancelled once that call has run. */
  private cancelAfterCall = false;
  /** The reply being made answers noise (cancelled). */
  private noiseReply = false;
  /** News let go while the user's turn was in (their reply covers it): asked again if that turn was noise. */
  private droppedNews: SpokenKind | null = null;
  /** Input items that were noise: their reply is cancelled when it starts. */
  private readonly noise = new Set<string>();
  /** What each input item's words make its turn (speechTurnOf; unclear or failed transcription: "unclear"). */
  private readonly turnKinds = new Map<string, TurnKind>();
  /** What each input item's transcription was (for send_to_agent), and the calls waiting for it. */
  private readonly turnWords = new Map<string, TurnWords>();
  private readonly wordsWaiters = new Map<string, ((w: TurnWords | null) => void)[]>();
  /** The user said clear words since the last request passed on (a send_to_agent not answering their turn needs them). */
  private clearWordsSinceForward = false;
  /** The notes the narrator was told lately (its updates). */
  private readonly notes: string[] = [];
  /** What the narrator said aloud lately, with when (a transcript of it is the microphone hearing the speaker). */
  private readonly saidAloud: { text: string; at: number }[] = [];
  /** The agent is working on a task of the chat (small talk then gets a short reply). */
  private agentWorking = false;
  /** How the reply being made again is asked for (MAKE_AGAIN_RESPONSE, or WORKING_SMALL_TALK_RESPONSE). */
  private redoResponse: Record<string, unknown> = MAKE_AGAIN_RESPONSE;
  /** The reply to the user's speech held until their words are in. */
  private held: Held | null = null;
  /** The input whose reply answered a request by itself and is being cancelled: made again once it is done. */
  private redoInput: string | null = null;
  /** The last input whose reply was made again (once per turn). */
  private redoneInput: string | null = null;
  /** The audio item of a held reply let go while still being made: truncated to nothing once it is done. */
  private unheardItem: string | null = null;
  /** The instruction last passed on, to acknowledge (its sample of the user's language), and whether the agent was working then. */
  private acknowledging: { request: string | null; agentWorking: boolean } = { request: null, agentWorking: false };
  /** Audio items of acknowledgements (out of band: not in the conversation, never truncated). */
  private readonly outOfBandItems = new Set<string>();
  /** The progress line to say when a milestone reply is made (progressResponse). */
  private progressLine: string | null = null;
  /** Server VAD's audio_start_ms / audio_end_ms of each input item (how long the user spoke). */
  private readonly vad = new Map<string, { start?: number; end?: number }>();
  /** The user's latest input item that no reply answered yet, and the one the current reply answers. */
  private unansweredInput: string | null = null;
  private replyInput: string | null = null;
  private lastError: RealtimeErrorCode | undefined;
  private narratorText = "";
  /** The output item the reply's words so far belong to (a reply can say several items: a space goes between them). */
  private narratorItem = "";
  private ready = false;
  /** Timing (see RealtimeHandlers.onTrace). */
  private connectAt = 0;
  private openAt = 0;
  private speechEndAt: number | null = null;
  private askedAt: number | null = null;
  private reply: Reply | null = null;
  private readonly inputTimes = new Map<string, InputTiming>();
  /** The user muted the microphone: no audio goes out. */
  private muted = false;
  /** Tool calls still running, by the input item their reply answers (its turn is done once they are). */
  private readonly running = new Map<string, Promise<void>>();
  /** The user's words since the last request or spoken reply, in order: what the next request is word for word. */
  private pendingWords: { inputId: string; text: string }[] = [];
  /** Input items whose reply was heard, or ran a tool other than send_to_agent: their words led to no request. */
  private readonly answeredInputs = new Set<string>();
  /** Input items whose reply passed a request on (its words went with it). */
  private readonly requestInputs = new Set<string>();
  /** The request last passed on (send_to_agent), answered to the narrator once `answered` settles. */
  private forwarded: (ForwardedRequest & { answered: Promise<void> }) | null = null;

  constructor(private readonly opts: RealtimeClientOptions) {}

  connect(): void {
    const open = this.opts.open ?? ((url, protocols) => new WebSocket(url, protocols) as unknown as RealtimeSocketLike);
    this.connectAt = Date.now();
    const ws = open(this.opts.url, [REALTIME_PROTOCOL, `${REALTIME_TOKEN_PROTOCOL_PREFIX}${this.opts.token}`]);
    this.socket = ws;
    ws.onopen = () => {
      this.opened = true;
      this.openAt = Date.now();
      this.send({ type: "session.update", session: this.sessionConfig() });
    };
    ws.onmessage = (m) => this.onMessage(m.data);
    ws.onerror = () => this.log("realtime socket error");
    ws.onclose = (e) => this.onClosed(e.code);
  }

  /** Microphone audio (PCM16 at REALTIME_SAMPLE_RATE). */
  appendAudio(pcm: Int16Array): void {
    if (this.muted) return;
    this.send({ type: "input_audio_buffer.append", audio: bytesToBase64(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)) });
  }

  /**
   * Muted: no microphone audio goes out (none is billed), and what the server holds of an unfinished turn is cleared,
   * so half an utterance is never committed. The narrator is told, so it goes on with updates without waiting for
   * the user.
   */
  setMuted(muted: boolean): void {
    if (muted === this.muted) return;
    this.muted = muted;
    if (muted) {
      this.userSpeaking = false;
      this.send({ type: "input_audio_buffer.clear" });
    }
    this.note(muted ? MUTED_NOTE : UNMUTED_NOTE, null);
  }

  /** Tells the narrator something (a system message); `speak`: and asks it to say it, when the floor allows (floor()). */
  note(text: string, speak: SpokenKind | null, line?: string): void {
    if (!this.isOpen()) return;
    this.notes.push(text);
    if (this.notes.length > MAX_REMEMBERED_NOTES) this.notes.shift();
    this.send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text }] } });
    // Progress is said as it is (progressResponse), never in the narrator's own words.
    if (speak === "milestone" && line) this.progressLine = line;
    if (speak) this.requestReply(speak);
  }

  /** The agent started or stopped working on a task of the chat. */
  setAgentWorking(working: boolean): void {
    this.agentWorking = working;
  }

  /** The narrator's audio finished playing here: a line waiting for the floor may start. */
  playbackIdle(): void {
    this.flush();
  }

  /** Stops the reply being made (the user pressed Esc or the shortcut while it spoke). */
  cancelResponse(): void {
    this.wantReply = null;
    this.dropHeld();
    if (this.responding) this.send({ type: "response.cancel" });
  }

  /** The user heard only `audioEndMs` of item `itemId` (it was cut off): the narrator's memory is trimmed to match. */
  truncate(itemId: string, audioEndMs: number): void {
    // Out of the conversation (an acknowledgement): nothing of it to trim.
    if (this.outOfBandItems.has(itemId)) return;
    this.send({ type: "conversation.item.truncate", item_id: itemId, content_index: 0, audio_end_ms: Math.max(0, Math.round(audioEndMs)) });
  }

  close(): void {
    this.closing = true;
    if (!this.socket || this.socket.readyState > OPEN) return this.finish(null);
    this.socket.close(REALTIME_CLOSE.normal, "done");
  }

  private sessionConfig(): Record<string, unknown> {
    const format = { type: "audio/pcm", rate: REALTIME_SAMPLE_RATE };
    return {
      type: "realtime",
      instructions: this.opts.instructions ?? NARRATOR_INSTRUCTIONS,
      tools: NARRATOR_TOOLS,
      tool_choice: "auto",
      audio: {
        input: {
          format,
          transcription: {
            model: REALTIME_INPUT_TRANSCRIPTION_MODEL,
            ...(this.opts.languages?.length ? { languages: [...this.opts.languages] } : {}),
            prompt: TRANSCRIPTION_PROMPT,
          },
          turn_detection: { type: "server_vad", silence_duration_ms: TURN_SILENCE_MS, create_response: true, interrupt_response: SERVER_INTERRUPTS_REPLY },
        },
        output: { format, voice: this.opts.voice ?? DEFAULT_REALTIME_VOICE, speed: clampSpeed(this.opts.speed ?? REALTIME_SPEED.default, REALTIME_SPEED) },
      },
    };
  }

  private isOpen(): boolean {
    return !!this.socket && this.socket.readyState === OPEN && !this.closing;
  }

  private send(event: Record<string, unknown>): void {
    if (this.isOpen()) this.socket!.send(JSON.stringify(event));
  }

  /**
   * Asks for a line when the floor allows it (narrator-policy.ts floor()): now, once the reply being made and the
   * audio playing are done, or not at all. An acknowledgement is only wanted when the reply that called
   * send_to_agent said nothing: it is dropped when that reply spoke, and a reply for the notes covers it.
   */
  private requestReply(kind: SpokenKind): void {
    const awaitingReply = this.unansweredInput !== null && Date.now() - this.committedAt < AWAIT_REPLY_MS;
    // A reply held for the user's words, or one being made again, still has the floor.
    const replying = this.responding || this.held !== null || this.redoInput !== null;
    const decision = floor(kind, { userSpeaking: this.userSpeaking, awaitingReply, replying, playing: this.opts.handlers.playing?.() ?? false });
    if (decision === "drop") {
      if ((this.userSpeaking || awaitingReply) && kind !== "milestone" && kind !== "ack") this.droppedNews = moreImportant(this.droppedNews, kind);
      return;
    }
    if (decision === "later") {
      this.wantReply = moreImportant(this.wantReply, kind);
      return;
    }
    if (kind === "ack" && this.spoke) return;
    this.askedAt = Date.now();
    this.askedKind = kind;
    const progress = kind === "milestone" ? this.progressLine : null;
    this.progressLine = null;
    if (kind === "ack") this.send({ type: "response.create", response: ackResponse(this.acknowledging.request, this.acknowledging.agentWorking) });
    else if (progress) this.send({ type: "response.create", response: progressResponse(progress, this.forwarded?.text ?? null) });
    else this.send({ type: "response.create" });
  }

  /**
   * A new request went to the agent: an earlier turn's result (or a milestone) still waiting for the floor is let go.
   * The agent's next turn answers the user, with that turn in its context; the result stays in the chat. Said anyway,
   * it came right after the user's new words, and the new turn's answer after it: two replies to what the user heard
   * as one utterance (the owner's trace of 2026-09-28: turn 4's apology said after the next complaint, then turn 5's).
   * A question or a problem waiting still gets said.
   */
  private supersedeNews(inputId: string | null): void {
    const stale = (k: SpokenKind | null) => k === "result" || k === "milestone";
    if (!stale(this.wantReply) && !stale(this.droppedNews)) return;
    this.trace({ t: Date.now(), cat: "voice", name: "voice.news_superseded", data: { kind: (stale(this.wantReply) ? this.wantReply : this.droppedNews) ?? "" } }, inputId);
    if (stale(this.wantReply)) this.wantReply = null;
    if (stale(this.droppedNews)) this.droppedNews = null;
  }

  /** The line waiting for the floor, if the floor is free now. */
  private flush(): void {
    const kind = this.wantReply;
    if (!kind) return;
    this.wantReply = null;
    this.requestReply(kind);
  }

  private trace(e: TraceDraft, inputId: string | null = null): void {
    try {
      this.opts.handlers.onTrace?.(e, inputId);
    } catch {
      /* a listener must not break the session */
    }
  }

  /** A reply starts: to the user's input `inputId` (timed from the end of their speech), else to our request. */
  private newReply(inputId: string | null): Reply {
    const now = Date.now();
    const input = inputId ? this.inputTimes.get(inputId) : undefined;
    const from = input ? (input.speechEnd ?? input.committed) : (this.askedAt ?? now);
    const kind: ReplyKind = inputId ? "speech" : (this.askedKind ?? "result");
    this.askedAt = null;
    this.askedKind = null;
    return { inputId, kind, from, created: now, audioDeltas: 0, audioBytes: 0 };
  }

  /** The reply is done: what started it, the waits for it to start and for its first audio, and its usage. */
  private traceReply(ev: ServerEvent, inputId: string | null): void {
    const r = this.reply;
    this.reply = null;
    if (!r) return;
    const now = Date.now();
    const response = (ev.response ?? {}) as { status?: unknown; usage?: Record<string, unknown> };
    const u = response.usage ?? {};
    const inDetails = (u.input_token_details ?? {}) as Record<string, unknown>;
    const outDetails = (u.output_token_details ?? {}) as Record<string, unknown>;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const input = inputId ? this.inputTimes.get(inputId) : undefined;
    const firstAudioMs = r.firstAudio === undefined ? null : r.firstAudio - r.from;
    this.trace(
      {
        t: r.from,
        ms: now - r.from,
        cat: "voice",
        name: "voice.narrator",
        data: {
          trigger: inputId ? "speech" : "update",
          kind: r.kind,
          // PCM16 mono: two bytes a sample.
          spokenMs: Math.round((r.audioBytes / 2 / REALTIME_SAMPLE_RATE) * 1000),
          ...(input && input.speechEnd !== null ? { commitMs: input.committed - input.speechEnd } : {}),
          createdMs: r.created - r.from,
          firstAudioMs,
          // What the user waited for: the narrator's first audio (a silent reply: all of it).
          waitMs: firstAudioMs ?? now - r.from,
          audioDeltas: r.audioDeltas,
          status: typeof response.status === "string" ? response.status : null,
          inTokens: n(u.input_tokens),
          outTokens: n(u.output_tokens),
          inAudioTokens: n(inDetails.audio_tokens),
          cachedTokens: n(inDetails.cached_tokens),
          outAudioTokens: n(outDetails.audio_tokens),
        },
      },
      inputId,
    );
  }

  /** The user's words of input `inputId` are transcribed (or could not be): the time since the input was committed. */
  private traceWords(inputId: string, text: string, usage: unknown, failed = false, noise = false, fit: TranscriptFit | "echo" = "clear"): void {
    const input = this.inputTimes.get(inputId);
    const now = Date.now();
    const u = (usage && typeof usage === "object" ? usage : {}) as Record<string, unknown>;
    const data: NonNullable<TraceDraft["data"]> = { chars: text.length, model: REALTIME_INPUT_TRANSCRIPTION_MODEL };
    if (failed) data.failed = true;
    if (noise) data.noise = true;
    if (fit !== "clear") data.fit = fit;
    for (const [from, to] of [["input_tokens", "inTokens"], ["output_tokens", "outTokens"], ["seconds", "audioSeconds"]] as const) {
      if (typeof u[from] === "number") data[to] = u[from] as number;
    }
    const t = input ? input.committed : now;
    this.trace({ t, ms: now - t, cat: "voice", name: "voice.user_words", data }, inputId);
  }

  private onMessage(data: unknown): void {
    let ev: ServerEvent;
    try {
      ev = JSON.parse(String(data)) as ServerEvent;
    } catch {
      return this.log("realtime: an event that is not JSON");
    }
    const h = this.opts.handlers;
    const str = (k: string) => (typeof ev[k] === "string" ? (ev[k] as string) : "");
    switch (ev.type) {
      // OpenAI's first event is session.created; our session.update went before any audio, so either means ready.
      case "session.created":
      case "session.updated":
        if (!this.ready) {
          this.ready = true;
          const now = Date.now();
          const model = (ev.session as { model?: unknown } | undefined)?.model;
          this.trace({
            t: this.connectAt,
            ms: now - this.connectAt,
            cat: "voice",
            name: "voice.connect",
            data: { openMs: this.openAt ? this.openAt - this.connectAt : null, readyMs: now - (this.openAt || this.connectAt), model: typeof model === "string" ? model : null, waitMs: now - this.connectAt },
          });
          h.onReady?.();
        }
        break;
      case "response.created": {
        this.responding = true;
        this.spoke = false;
        this.replyStale = false;
        this.writingCall = false;
        this.cancelAfterCall = false;
        this.narratorText = "";
        this.narratorItem = "";
        this.replyInput = this.unansweredInput;
        this.unansweredInput = null;
        this.reply = this.newReply(this.replyInput);
        this.noiseReply = false;
        // The reply answers noise (its empty transcript came first): it is not said.
        if (this.replyInput && this.noise.has(this.replyInput)) this.dropNoiseReply();
        // A reply to the user's speech is heard once their words say it may be (HOLD_FOR_WORDS_MS).
        else if (this.replyInput) this.hold(this.replyInput);
        break;
      }
      case "response.done": {
        this.responding = false;
        this.writingCall = false;
        this.cancelAfterCall = false;
        const answered = this.replyInput;
        this.replyInput = null;
        this.traceReply(ev, answered);
        // Heard: what it said may come back through the microphone.
        if (this.spoke && this.narratorText.trim()) this.rememberSaid(this.narratorText);
        h.onReplyDone?.();
        // What was held of it and let go was never heard: the narrator's memory keeps none of it.
        if (this.unheardItem) this.truncate(this.unheardItem, 0);
        this.unheardItem = null;
        if (answered && this.redoInput === answered) {
          this.redoInput = null;
          this.makeAgain(answered);
        } else if (answered && this.held?.inputId === answered) {
          this.held.done = true;
          this.decideHeld();
        } else if (answered) this.turnDone(answered);
        // The user's turn was answered, with the news let go meanwhile in it (not when it was noise).
        if (answered && !this.noiseReply) this.droppedNews = null;
        this.flush();
        break;
      }
      case "response.output_audio.delta":
        // A reply the user talked over (or noise's): the rest of it is not heard.
        if (this.replyStale) break;
        if (this.reply) {
          this.reply.firstAudio ??= Date.now();
          this.reply.audioDeltas++;
          this.reply.audioBytes += base64Bytes(str("delta"));
        }
        if ((this.reply?.kind === "ack" || this.reply?.kind === "milestone") && str("item_id") && !this.outOfBandItems.has(str("item_id"))) {
          this.outOfBandItems.add(str("item_id"));
          if (this.outOfBandItems.size > MAX_TURN_KINDS) this.outOfBandItems.delete(this.outOfBandItems.values().next().value!);
        }
        if (this.held) {
          this.held.audio.push([str("delta"), str("item_id")]);
          this.decideHeld();
        } else {
          this.spoke = true;
          if (this.replyInput) this.remember(this.answeredInputs, this.replyInput);
          h.onAudio?.(str("delta"), str("item_id"));
        }
        break;
      case "input_audio_buffer.speech_stopped":
        this.speechEndAt = Date.now();
        this.userSpeaking = false;
        this.vadTime(str("item_id"), "end", ev.audio_end_ms);
        break;
      case "input_audio_buffer.committed":
        // The user's turn is in: the reply the server makes next answers it.
        if (str("item_id")) {
          this.unansweredInput = str("item_id");
          this.committedAt = Date.now();
          this.userSpeaking = false;
          this.inputTimes.set(str("item_id"), { speechEnd: this.speechEndAt, committed: Date.now() });
          if (this.inputTimes.size > MAX_INPUT_TIMINGS) this.inputTimes.delete(this.inputTimes.keys().next().value!);
          this.speechEndAt = null;
        }
        break;
      case "conversation.item.input_audio_transcription.completed":
        if (str("item_id")) {
          const id = str("item_id");
          const text = str("transcript").trim();
          if (isNoise(text, this.speechMs(id, ev.usage))) {
            // Noise (a cough, a door): nothing is said for it and it is no message; the trace keeps it, marked.
            this.traceWords(id, text, ev.usage, false, true);
            this.settleWords(id, { fit: "noise", text });
            this.onNoiseInput(id);
            break;
          }
          if (echoesSpoken(text, this.recentlySaid())) {
            // The microphone heard the narrator (its line, a result said aloud), not the user: like noise.
            this.traceWords(id, text, ev.usage, false, false, "echo");
            this.trace({ t: Date.now(), cat: "voice", name: "voice.echo", data: { chars: text.length } }, id);
            this.settleWords(id, { fit: "echo", text });
            this.onNoiseInput(id);
            break;
          }
          const fit = transcriptFit(text, this.opts.languages ?? []);
          this.traceWords(id, text, ev.usage, false, false, fit);
          this.settleWords(id, { fit, text });
          if (fit === "other_language") {
            // Other people talking nearby: no reply, no request, nothing shown (like noise).
            this.trace({ t: Date.now(), cat: "voice", name: "voice.not_addressed", data: { chars: text.length } }, id);
            this.onNoiseInput(id);
            break;
          }
          if (fit === "unclear") {
            // Not the user's words as said: the narrator's own reading of the audio counts, not these words.
            this.trace({ t: Date.now(), cat: "voice", name: "voice.unclear", data: { chars: text.length } }, id);
            this.heardWords(id, text);
            this.wordsIn(id, "unclear");
            break;
          }
          this.clearWordsSinceForward = true;
          this.heardWords(id, text);
          this.wordsIn(id, speechTurnOf(text));
        }
        break;
      case "conversation.item.input_audio_transcription.failed":
        this.log("realtime: the user's words could not be transcribed");
        if (str("item_id")) {
          this.traceWords(str("item_id"), "", undefined, true);
          this.settleWords(str("item_id"), { fit: "failed", text: "" });
          // Words unknown: the narrator's own reading counts (its reply is heard, as before holding).
          this.wordsIn(str("item_id"), "unclear");
        }
        break;
      case "response.output_audio_transcript.delta":
        // Words of a reply the user talked over, of noise's, or of one made again are not shown (never "said").
        if (this.replyStale) break;
        // Another item of the same reply: its words start a new sentence (they were run together: "exciting!I need").
        if (this.narratorText && str("item_id") && this.narratorItem && str("item_id") !== this.narratorItem && !/\s$/.test(this.narratorText)) this.narratorText += " ";
        if (str("item_id")) this.narratorItem = str("item_id");
        this.narratorText += str("delta");
        if (this.held) this.held.text = this.narratorText;
        else h.onNarratorText?.(this.narratorText);
        break;
      case "input_audio_buffer.speech_started":
        // The user's turn gets its own reply; ours would talk over it, and what waited for older turns is let go.
        this.wantReply = null;
        this.userSpeaking = true;
        // A reply held for their last words is talked over before it was heard.
        this.dropHeld();
        if (this.responding) this.bargeIn();
        this.vadTime(str("item_id"), "start", ev.audio_start_ms);
        h.onUserSpeech?.();
        break;
      case "response.output_item.added":
        if ((ev.item as { type?: unknown } | undefined)?.type === "function_call") {
          this.writingCall = true;
          this.calls();
        }
        break;
      case "response.function_call_arguments.done":
        this.writingCall = false;
        this.calls();
        void this.runTool(str("call_id"), str("name"), str("arguments"), this.replyInput, this.reply?.kind ?? null);
        break;
      case REALTIME_ERROR_EVENT: {
        const parsed = RealtimeErrorEvent.safeParse(ev);
        if (!parsed.success) return this.log(`realtime: unreadable ${REALTIME_ERROR_EVENT}`);
        if (parsed.data.error === "denied") return this.log(`realtime denied: ${parsed.data.message}`);
        this.lastError = parsed.data.error;
        this.log(`realtime ${parsed.data.error}: ${parsed.data.message}`);
        break;
      }
      case "error": {
        const e = (ev.error ?? {}) as { code?: unknown; message?: unknown };
        this.log(`realtime error: ${String(e.code ?? "")}: ${String(e.message ?? "")}`);
        break;
      }
    }
  }

  /** The reply to input `inputId` is done: its turn is, once the tool calls it made have run (a request goes with its words). */
  private turnDone(inputId: string): void {
    const calls = this.running.get(inputId);
    if (calls) return void calls.then(() => this.turnDone(inputId));
    // Answered without a request (spoken to, or acted on): the words so far led to none. A turn with a silent reply
    // keeps them for the request a later turn makes (one request split by server VAD).
    if (this.answeredInputs.has(inputId) && !this.requestInputs.has(inputId)) this.flushHeard(inputId);
    this.opts.handlers.onTurnDone?.(inputId);
  }

  /** A transcript of the user's words (input `inputId`): part of the next request, or of speech that leads to none. */
  private heardWords(inputId: string, text: string): void {
    if (text) this.pendingWords.push({ inputId, text });
  }

  /** The words up to input `inputId` led to no request: they are passed on as heard. */
  private flushHeard(inputId: string): void {
    const upTo = this.pendingWords.findIndex((w) => w.inputId === inputId);
    if (upTo < 0) return;
    const words = this.pendingWords.splice(0, upTo + 1).map((w) => w.text);
    this.opts.handlers.onHeard?.(words);
  }

  /** What the narrator said aloud within ECHO_WINDOW_MS. */
  private recentlySaid(): string[] {
    const since = Date.now() - ECHO_WINDOW_MS;
    while (this.saidAloud[0] && this.saidAloud[0].at < since) this.saidAloud.shift();
    return this.saidAloud.map((s) => s.text);
  }

  private rememberSaid(text: string): void {
    this.saidAloud.push({ text, at: Date.now() });
    if (this.saidAloud.length > MAX_TURN_KINDS) this.saidAloud.shift();
  }

  /** Adds `id` to a bounded set of input items. */
  private remember(set: Set<string>, id: string): void {
    set.add(id);
    if (set.size > MAX_TURN_KINDS) set.delete(set.values().next().value!);
  }

  /** Runs a tool call; the turn it answers waits for it (turnDone). */
  private runTool(callId: string, name: string, rawArgs: string, inputId: string | null, replyKind: ReplyKind | null): Promise<void> {
    const run = this.runToolNow(callId, name, rawArgs, inputId, replyKind);
    if (inputId === null) return run;
    const all = Promise.all([this.running.get(inputId), run]).then(() => {
      if (this.running.get(inputId) === all) this.running.delete(inputId);
    });
    this.running.set(inputId, all);
    return run;
  }

  /** replyKind: what the reply making the call is (null: not known). */
  private async runToolNow(callId: string, name: string, rawArgs: string, inputId: string | null, replyKind: ReplyKind | null): Promise<void> {
    let args: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(rawArgs || "{}");
      args = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      args = null;
    }
    const request = name === "send_to_agent" && typeof args?.text === "string" ? args.text.trim() : "";
    // Whether the agent is busy as the user asks (their words may start it working).
    const agentWorking = this.agentWorking;
    const earlier = this.forwarded;
    if (request && earlier && repeatsRequest(request, inputId, earlier)) {
      // The same request again (one turn, or a reply of ours): not sent twice, nothing more said; answered after the first.
      await earlier.answered;
      this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: ALREADY_SENT_OUTPUT } });
      return;
    }
    let answered = () => {};
    // Held before the first await: a repeat in the same reply arrives while this one runs.
    if (request) this.forwarded = { inputId, text: request, answered: new Promise<void>((r) => (answered = r)) };
    const refusal = TOOL_NAMES.has(name) ? await this.callRefusal(request || null, inputId) : null;
    if (refusal) {
      // Not the user's: not run (not sent, not acknowledged), and not what a repeat is compared with.
      if (request && this.forwarded?.text === request) this.forwarded = earlier;
      this.trace({ t: Date.now(), cat: "voice", name: "voice.refused_forward", data: { reason: refusal, tool: name, chars: request.length } }, inputId);
      this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: NOT_A_REQUEST_OUTPUT[refusal] } });
      answered();
      return;
    }
    let heard: string[] = [];
    if (request) {
      this.clearWordsSinceForward = false;
      // The request is what all the user's words since the last request or spoken reply came to.
      heard = this.pendingWords.splice(0).map((w) => w.text);
      if (inputId) this.remember(this.requestInputs, inputId);
    } else if (inputId && TOOL_NAMES.has(name)) {
      this.remember(this.answeredInputs, inputId);
      // An approval answer is checked against the user's own words for that turn (a yes allows only when they said one).
      if (name === "answer_approval") {
        const words = await this.wordsFor(inputId);
        if (words?.fit === "clear" && words.text) heard = [words.text];
      }
    }
    let output: string;
    if (!TOOL_NAMES.has(name)) output = `Error: unknown tool ${name}`;
    else if (!args) output = "Error: the arguments are not valid JSON";
    else {
      try {
        output = (await this.opts.handlers.onTool?.(name as NarratorTool, args, inputId, heard)) ?? "Done.";
      } catch (err) {
        output = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output } });
    answered();
    if (request) this.supersedeNews(inputId);
    // Talked over while it wrote the call: the call ran, the rest of the reply is not wanted (the user has the floor).
    if (this.cancelAfterCall && this.responding && !this.writingCall) {
      this.cancelAfterCall = false;
      this.send({ type: "response.cancel" });
    }
    // Tool first, then at most one short acknowledgement of an instruction (none for a question: the agent's answer
    // is the reply; none when the narrator already spoke in that reply; and never for a call the acknowledgement
    // itself made: that would acknowledge the acknowledgement).
    if (name !== "send_to_agent") this.requestReply("result");
    else if (replyKind !== "ack" && requestKind(args) === "instruction") {
      this.acknowledging = { request: request || null, agentWorking };
      this.requestReply("ack");
    }
  }

  /**
   * Why a tool call is not the user's doing (null: it is): it answers speech that was not the user talking to the
   * assistant (other people, noise); or, a send_to_agent of `request`, it passes on an update the narrator was given
   * (echoesUpdate); or it answers no turn of the user's and no clear words of theirs came since the last request. A
   * call answering a turn waits for that turn's words (at most HOLD_FOR_WORDS_MS; not in by then, it goes on as before).
   */
  private async callRefusal(request: string | null, inputId: string | null): Promise<keyof typeof NOT_A_REQUEST_OUTPUT | null> {
    const words = inputId ? await this.wordsFor(inputId) : null;
    if (words && (words.fit === "other_language" || words.fit === "noise" || words.fit === "echo")) return "not_user";
    if (request !== null && echoesUpdate(request, this.notes, words?.fit === "clear" ? words.text : null)) return "echo";
    if (!inputId && !this.clearWordsSinceForward) return "not_user";
    return null;
  }

  /** The transcription of input `inputId` once it is in (null: not within HOLD_FOR_WORDS_MS, or the session ended). */
  private wordsFor(inputId: string): Promise<TurnWords | null> {
    const known = this.turnWords.get(inputId);
    if (known) return Promise.resolve(known);
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(null), HOLD_FOR_WORDS_MS);
      const done = (w: TurnWords | null) => {
        clearTimeout(timer);
        const left = (this.wordsWaiters.get(inputId) ?? []).filter((f) => f !== done);
        if (left.length) this.wordsWaiters.set(inputId, left);
        else this.wordsWaiters.delete(inputId);
        resolve(w);
      };
      this.wordsWaiters.set(inputId, [...(this.wordsWaiters.get(inputId) ?? []), done]);
    });
  }

  /** The transcription of input `inputId` is in: remembered, and the calls waiting for it go on. */
  private settleWords(inputId: string, words: TurnWords): void {
    this.turnWords.set(inputId, words);
    if (this.turnWords.size > MAX_TURN_KINDS) this.turnWords.delete(this.turnWords.keys().next().value!);
    for (const wake of this.wordsWaiters.get(inputId) ?? []) wake(words);
  }

  /**
   * The user started talking while a reply is being made: its further audio is not played, and the reply is
   * cancelled, but never while it writes a tool call (a send_to_agent cut off is a request lost): then right after
   * that call has run.
   */
  private bargeIn(): void {
    this.replyStale = true;
    if (this.writingCall) this.cancelAfterCall = true;
    else this.send({ type: "response.cancel" });
  }

  // ---- a reply to the user's speech, held for their words (HOLD_FOR_WORDS_MS)

  /** The reply now starting answers input `inputId`: nothing of it is heard or shown until their words say so. */
  private hold(inputId: string): void {
    this.dropHeld();
    const held: Held = { inputId, audio: [], text: "", called: false, done: false, timer: setTimeout(() => this.held === held && this.releaseHeld(), HOLD_FOR_WORDS_MS) };
    this.held = held;
    this.decideHeld();
  }

  /** The user's words of input `inputId` are in: what they make the turn decides what its reply may do. */
  private wordsIn(inputId: string, turn: TurnKind): void {
    this.turnKinds.set(inputId, turn);
    if (this.turnKinds.size > MAX_TURN_KINDS) this.turnKinds.delete(this.turnKinds.keys().next().value!);
    if (this.held?.inputId === inputId) this.decideHeld();
  }

  /** The reply being made calls a tool. */
  private calls(): void {
    if (!this.held) return;
    this.held.called = true;
    this.decideHeld();
  }

  /**
   * Small talk: the reply is heard. A request: only a tool answers it, and nothing the reply says is heard (the
   * narrator's own notes are not the truth about what the agent did or knows; its acknowledgement is the out-of-band
   * one, ackResponse): a reply that calls a tool goes on unheard, one that speaks instead is made again (makeAgain).
   * Words not in yet: it waits, unless it only called a tool (nothing to hold: its acknowledgement is not delayed).
   */
  private decideHeld(): void {
    const h = this.held;
    if (!h) return;
    const said = h.audio.length > 0 || h.text !== "";
    const turn = this.turnKinds.get(h.inputId);
    if (!turn) {
      if (h.called && !said) this.releaseHeld();
      return;
    }
    // Unclear words: the narrator's own reading of the audio decides (its reply is heard, its tool calls stand).
    if (turn === "unclear") return this.releaseHeld();
    if (turn === "small_talk") {
      // While the agent works, a few words at most: a longer reply is made again, capped.
      if (this.agentWorking && !h.called && this.redoneInput !== h.inputId && (said || h.done)) return this.redo(h, WORKING_SMALL_TALK_RESPONSE);
      if (this.agentWorking && !h.called && this.redoneInput !== h.inputId) return;
      return this.releaseHeld();
    }
    if (h.called || this.redoneInput === h.inputId) return this.dropHeld();
    if (said) return this.redo(h, MAKE_AGAIN_RESPONSE);
    // Silent so far: it may still call a tool; done without one, there is nothing to hear.
    if (h.done) this.dropHeld();
  }

  private releaseHeld(): void {
    const h = this.held;
    if (!h) return;
    this.held = null;
    clearTimeout(h.timer);
    if (h.audio.length) {
      this.spoke = true;
      this.remember(this.answeredInputs, h.inputId);
    }
    for (const [b64, itemId] of h.audio) this.opts.handlers.onAudio?.(b64, itemId);
    if (h.text) this.opts.handlers.onNarratorText?.(h.text);
    if (h.done) this.turnDone(h.inputId);
    this.flush();
  }

  /** What is held is never heard (noise, talked over, hushed, made again); settle: its turn is over if its reply is. */
  private dropHeld(settle = true): void {
    const h = this.held;
    if (!h) return;
    this.held = null;
    clearTimeout(h.timer);
    // Nor is the rest of it, if it is still being made.
    if (this.responding && this.replyInput === h.inputId) this.replyStale = true;
    const itemId = h.audio[0]?.[1];
    if (itemId && h.done) this.truncate(itemId, 0);
    else if (itemId) this.unheardItem = itemId;
    if (h.done && settle) this.turnDone(h.inputId);
    this.flush();
  }

  /**
   * The reply is not the one wanted (it answered a request by itself; or long small talk while the agent works): it is
   * let go (cancelled if still being made) and made again as `response` asks.
   */
  private redo(h: Held, response: Record<string, unknown>): void {
    this.redoneInput = h.inputId;
    this.redoResponse = response;
    this.dropHeld(false);
    if (h.done) return this.makeAgain(h.inputId);
    this.replyStale = true;
    this.redoInput = h.inputId;
    this.send({ type: "response.cancel" });
  }

  /** The reply to input `inputId` again (redoResponse); not when the user has since spoken again (theirs answers). */
  private makeAgain(inputId: string): void {
    if (this.userSpeaking || this.unansweredInput !== null) return this.turnDone(inputId);
    this.unansweredInput = inputId;
    this.committedAt = Date.now();
    this.send({ type: "response.create", response: this.redoResponse });
  }

  private vadTime(itemId: string, at: "start" | "end", ms: unknown): void {
    if (!itemId || typeof ms !== "number") return;
    const v = this.vad.get(itemId) ?? {};
    v[at] = ms;
    this.vad.set(itemId, v);
    if (this.vad.size > MAX_INPUT_TIMINGS) this.vad.delete(this.vad.keys().next().value!);
  }

  /** How long the user spoke in input item `itemId` (server VAD, else the transcription's billed seconds; null: unknown). */
  private speechMs(itemId: string, usage: unknown): number | null {
    const v = this.vad.get(itemId);
    if (v?.start !== undefined && v.end !== undefined) return v.end - v.start;
    const seconds = (usage as { seconds?: unknown } | undefined)?.seconds;
    return typeof seconds === "number" ? seconds * 1000 : null;
  }

  /** Input `itemId` was noise: its reply (being made, or when it starts) is cancelled and not heard. */
  private onNoiseInput(itemId: string): void {
    if (this.responding && this.replyInput === itemId) this.dropNoiseReply();
    else if (this.held?.inputId === itemId) this.dropHeld();
    else if (this.unansweredInput === itemId) this.noise.add(itemId);
    // News let go for that turn is said after all (no reply of it will carry it).
    const news = this.droppedNews;
    this.droppedNews = null;
    if (news) this.requestReply(news);
  }

  private dropNoiseReply(): void {
    this.replyStale = true;
    this.noiseReply = true;
    this.dropHeld();
    this.send({ type: "response.cancel" });
    if (this.replyInput) this.noise.delete(this.replyInput);
    this.opts.handlers.onNoise?.();
  }

  private onClosed(code: number): void {
    const ours = this.closing && (code === REALTIME_CLOSE.normal || code === 1005);
    this.finish(ours ? null : realtimeFailure({ closeCode: code, error: this.lastError, opened: this.opened }));
  }

  private finish(failure: RealtimeFailure | null): void {
    if (this.ended) return;
    this.ended = true;
    this.responding = false;
    this.wantReply = null;
    if (this.held) clearTimeout(this.held.timer);
    this.held = null;
    for (const waiters of [...this.wordsWaiters.values()]) for (const wake of waiters) wake(null);
    this.opts.handlers.onClose?.(failure);
  }

  private log(message: string): void {
    this.opts.handlers.log?.(message);
  }
}

/** The bytes a base64 string decodes to. */
function base64Bytes(b64: string): number {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}
