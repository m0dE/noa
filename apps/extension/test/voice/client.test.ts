import { describe, expect, it, vi } from "vitest";
import { AccountApi } from "../../src/account/account-api.js";
import { NotSignedInError } from "../../src/http-client.js";
import { voiceAllowed } from "../../src/account/types.js";
import { micPermission, watchMicPermission, type MicPermission } from "../../src/voice/mic-access.js";
import { initialState, micPageCopy, requestMic } from "../../src/voice/mic-page.js";
import { MicSource, type MicDeps } from "../../src/voice/recorder.js";
import {
  VoiceError,
  panelTranscriber,
  toVoiceError,
  transcribeForPanel,
  type VoiceClipRequest,
  type VoiceTranscribeResult,
} from "../../src/voice/transcribe.js";
import { encodeWav } from "../../src/voice/wav.js";
import { fakeApi } from "../account/fake-api.js";

const wav = encodeWav(new Int16Array(1600), 16_000);

describe("AccountApi.transcribe", () => {
  function setup(status: number, body: unknown, token: string | null = "bt_s_tok") {
    const api = fakeApi();
    api.on("POST /v1/ai/transcribe", { status, body });
    return { api, client: new AccountApi({ apiBase: api.base, token: token ?? undefined, fetch: api.fetch }) };
  }
  const failure = (status: number, body: unknown) =>
    setup(status, body)
      .client.transcribe(wav)
      .then(
        () => null,
        (e: unknown) => toVoiceError(e).info,
      );

  it("posts the WAV with the session token, the query and the session header", async () => {
    const { api, client } = setup(200, { text: "Open Gmail", seconds: 0.1, chargedCents: 0.0001 });
    expect(await client.transcribe(wav, { speechMs: 800, context: "Hello there", sessionId: "chat-3", language: "ko" })).toEqual({
      text: "Open Gmail",
      seconds: 0.1,
      chargedCents: 0.0001,
    });
    const call = api.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/v1/ai/transcribe?language=ko&speech_ms=800&context=Hello+there");
    expect(call.headers.authorization).toBe("Bearer bt_s_tok");
    expect(call.headers["content-type"]).toBe("audio/wav");
    expect(call.headers["x-noa-session"]).toBe("chat-3");
    expect((call.body as { blob: { bytes: Uint8Array } }).blob.bytes).toEqual(wav);
  });

  it.each([
    [403, { error: "plan_required", feature: "voice", message: "Voice input needs the Plus or Pro plan.", upgradeUrl: "https://dash.test/billing" }, "plan", "Voice needs the Plus or Pro plan.", true],
    [402, { error: "out_of_credit", message: "x", topupUrl: "https://dash.test/billing" }, "credit", "You're out of usage credit. Top up to keep using voice.", true],
    [401, { error: "invalid key" }, "signed-out", "Log in to use voice.", true],
    [413, { error: "audio is longer than 60 seconds" }, "too-long", "Voice messages can be up to 60 seconds.", true],
    [429, { error: "rate limit" }, "rate", "Too many voice requests. Try again in a minute.", true],
    [502, { error: "transcription failed: 3040" }, "server", "Voice isn't working right now. Try again in a moment.", false],
  ])("HTTP %i becomes a plain message (the fix is on the dashboard's Billing page, not in the error)", async (status, body, kind, message, fatal) => {
    expect(await failure(status, body)).toEqual({ kind, message, fatal });
  });

  it("signed out and unreachable", async () => {
    const { api, client } = setup(200, {}, null);
    expect(toVoiceError(await client.transcribe(wav).catch((e: unknown) => e)).info).toMatchObject({ kind: "signed-out", fatal: true });
    expect(api.calls).toHaveLength(0);
    expect(toVoiceError(new NotSignedInError()).kind).toBe("signed-out");
    expect(toVoiceError(new Error("Cannot reach https://api.test: fetch failed")).info).toMatchObject({ kind: "network", fatal: false });
  });
});

describe("the panel's transcriber (through the background)", () => {
  const req = { speechMs: 800, context: "Before", signal: new AbortController().signal };

  it("sends the clip as base64 with the chat's id, and returns the text", async () => {
    const send = vi.fn(async (_r: VoiceClipRequest): Promise<VoiceTranscribeResult> => ({ text: "Scroll down" }));
    expect(await panelTranscriber(send, () => "chat-9")(wav, req)).toBe("Scroll down");
    const sent = send.mock.calls[0]![0];
    expect(sent).toEqual({ wav: expect.any(String), speechMs: 800, context: "Before", sessionId: "chat-9" });
    expect(Uint8Array.from(atob(sent.wav), (c) => c.charCodeAt(0))).toEqual(wav);
  });

  it("rejects with the VoiceError the background reported", async () => {
    const send = async (): Promise<VoiceTranscribeResult> => ({ error: { kind: "plan", message: "Voice needs the Plus or Pro plan.", fatal: true } });
    const err = await panelTranscriber(send)(wav, req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VoiceError);
    expect(err).toMatchObject({ kind: "plan", fatal: true });
  });

  it("treats a background that does not answer as a network blip", async () => {
    const err = await panelTranscriber(async () => Promise.reject(new Error("No response from the extension background")))(wav, req).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "network", fatal: false });
  });
});

describe("transcribeForPanel (background)", () => {
  it("decodes the clip and passes the options; no account means signed out", async () => {
    const transcribe = vi.fn(async (_w: Uint8Array, _o: unknown) => ({ text: "ok" }));
    expect(await transcribeForPanel({ transcribe }, { wav: btoa("abc"), speechMs: 5 })).toEqual({ text: "ok" });
    expect(transcribe).toHaveBeenCalledWith(new TextEncoder().encode("abc"), { speechMs: 5 });
    expect(await transcribeForPanel(undefined, { wav: "", speechMs: 0 })).toEqual({ error: { kind: "signed-out", message: "Log in to use voice.", fatal: true } });
  });
});

describe("voiceAllowed", () => {
  it("follows the plan catalog's voice flag and the plan's standing", () => {
    const plan = (id: "free" | "starter" | "plus" | "pro", status: "active" | "past_due" | "canceled" | "none") => ({
      id,
      status,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
    });
    expect(voiceAllowed(plan("free", "none"))).toBe(false);
    expect(voiceAllowed(plan("starter", "active"))).toBe(false); // voice starts at Plus
    expect(voiceAllowed(plan("plus", "active"))).toBe(true);
    expect(voiceAllowed(plan("pro", "past_due"))).toBe(true);
    expect(voiceAllowed(plan("plus", "canceled"))).toBe(false);
    expect(voiceAllowed(undefined)).toBe(false);
  });
});

describe("microphone permission", () => {
  const permissions = (state: MicPermission | Error) => {
    const listeners = new Set<() => void>();
    const status = {
      state: state instanceof Error ? "prompt" : state,
      addEventListener: (_: string, l: () => void) => listeners.add(l),
      removeEventListener: (_: string, l: () => void) => listeners.delete(l),
    };
    return {
      status,
      listeners,
      query: vi.fn(async ({ name }: { name: string }) => {
        if (state instanceof Error) throw state;
        expect(name).toBe("microphone");
        return status as unknown as PermissionStatus;
      }),
    };
  };

  it("reads the state, and says prompt when the browser cannot tell", async () => {
    expect(await micPermission(permissions("granted"))).toBe("granted");
    expect(await micPermission(permissions("denied"))).toBe("denied");
    expect(await micPermission(permissions(new TypeError("microphone is not a valid permission name")))).toBe("prompt");
    expect(await micPermission(undefined)).toBe("prompt");
  });

  it("tells the panel when the permission changes", async () => {
    const p = permissions("prompt");
    const seen: string[] = [];
    const off = await watchMicPermission((s) => seen.push(s), p);
    p.status.state = "granted";
    for (const l of p.listeners) l();
    expect(seen).toEqual(["granted"]);
    off();
    expect(p.listeners.size).toBe(0);
  });

  it("asks once on the permission page and releases the microphone", async () => {
    const stop = vi.fn();
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop }] }) as unknown as MediaStream);
    expect(await requestMic(getUserMedia)).toBe("granted");
    expect(getUserMedia).toHaveBeenCalledWith({ audio: expect.objectContaining({ noiseSuppression: true, echoCancellation: true, channelCount: 1 }) });
    expect(stop).toHaveBeenCalled();
    const failing = (name: string) => async () => Promise.reject(new DOMException("x", name));
    expect(await requestMic(failing("NotAllowedError"))).toBe("denied");
    expect(await requestMic(failing("NotFoundError"))).toBe("no-mic");
    expect(await requestMic(failing("AbortError"))).toBe("failed");
  });

  it("has calm copy for every state", () => {
    expect(initialState("granted")).toBe("granted");
    expect(initialState("denied")).toBe("denied");
    expect(initialState("prompt")).toBe("asking");
    expect(micPageCopy("asking")).toMatchObject({ title: "Allow the microphone", close: false });
    expect(micPageCopy("asking").body).toContain("The audio is not stored.");
    expect(micPageCopy("granted")).toMatchObject({ retry: null, close: true });
    expect(micPageCopy("granted").body).toContain("You can close this tab");
    for (const s of ["denied", "no-mic", "failed"] as const) expect(micPageCopy(s).retry).toBe("Try again");
  });
});

describe("MicSource", () => {
  /** A fake AudioContext running at `rate` with the ScriptProcessor path. */
  function fakeMic(rate: number) {
    const trackStop = vi.fn();
    const stream = { getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream;
    let onaudioprocess: ((e: { inputBuffer: { getChannelData(i: number): Float32Array } }) => void) | null = null;
    const connections: string[] = [];
    const ctx = {
      sampleRate: rate,
      state: "running",
      destination: "destination",
      createMediaStreamSource: () => ({ connect: (n: { name: string }) => connections.push(`source->${n.name}`) }),
      createScriptProcessor: () => {
        const node = {
          name: "processor",
          connect: (n: { name: string }) => connections.push(`processor->${n.name}`),
          set onaudioprocess(f: typeof onaudioprocess) {
            onaudioprocess = f;
          },
        };
        return node;
      },
      createGain: () => ({ name: "mute", gain: { value: 1 }, connect: (n: unknown) => connections.push(`mute->${String(n)}`) }),
      close: vi.fn(async () => undefined),
    };
    const deps: MicDeps = {
      getUserMedia: vi.fn(async () => stream),
      createContext: () => ctx as unknown as AudioContext,
      workletUrl: null,
    };
    const play = (samples: Float32Array) => onaudioprocess?.({ inputBuffer: { getChannelData: () => samples } });
    return { deps, ctx, trackStop, connections, play };
  }

  it("delivers 16 kHz mono through a muted ScriptProcessor, and releases everything on stop", async () => {
    const mic = fakeMic(48_000);
    const src = new MicSource(mic.deps);
    const got: number[] = [];
    await src.start((s) => got.push(s.length));
    expect(mic.deps.getUserMedia).toHaveBeenCalledWith({ audio: expect.objectContaining({ autoGainControl: true }) });
    expect(mic.connections).toEqual(["source->processor", "processor->mute", "mute->destination"]);
    mic.play(new Float32Array(4800));
    expect(got.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1599);
    src.stop();
    expect(mic.trackStop).toHaveBeenCalled();
    expect(mic.ctx.close).toHaveBeenCalled();
    mic.play(new Float32Array(4800));
    expect(got.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1600); // nothing after stop
  });

  it("releases the microphone when stopped while it was opening", async () => {
    const mic = fakeMic(16_000);
    let open!: (s: MediaStream) => void;
    mic.deps.getUserMedia = () => new Promise((r) => (open = r));
    const src = new MicSource(mic.deps);
    const started = src.start(() => undefined);
    src.stop();
    open({ getTracks: () => [{ stop: mic.trackStop }] } as unknown as MediaStream);
    await started;
    expect(mic.trackStop).toHaveBeenCalled();
    expect(mic.connections).toEqual([]);
  });

  it("falls back to the ScriptProcessor when the worklet module does not load", async () => {
    const mic = fakeMic(16_000);
    Object.assign(mic.ctx, { audioWorklet: { addModule: vi.fn(async () => Promise.reject(new Error("404"))) } });
    mic.deps.workletUrl = "chrome-extension://id/pcm-worklet.js";
    await new MicSource(mic.deps).start(() => undefined);
    expect(mic.connections).toEqual(["source->processor", "processor->mute", "mute->destination"]);
  });

  it("uses the AudioWorklet when available", async () => {
    const mic = fakeMic(16_000);
    const addModule = vi.fn(async () => undefined);
    Object.assign(mic.ctx, { audioWorklet: { addModule } });
    mic.deps.workletUrl = "chrome-extension://id/pcm-worklet.js";
    const created: { opts: AudioWorkletNodeOptions; port: { onmessage: ((e: MessageEvent) => void) | null } }[] = [];
    vi.stubGlobal(
      "AudioWorkletNode",
      class {
        name = "worklet";
        port = { onmessage: null as ((e: MessageEvent) => void) | null };
        constructor(_ctx: unknown, name: string, opts: AudioWorkletNodeOptions) {
          expect(name).toBe("pcm-capture");
          created.push({ opts, port: this.port });
        }
      },
    );
    const got: Float32Array[] = [];
    await new MicSource(mic.deps).start((s) => got.push(s));
    expect(addModule).toHaveBeenCalledWith("chrome-extension://id/pcm-worklet.js");
    expect(created[0]!.opts).toMatchObject({ numberOfOutputs: 0 });
    expect(mic.connections).toEqual(["source->worklet"]);
    created[0]!.port.onmessage!({ data: new Float32Array(512) } as MessageEvent);
    expect(got[0]).toHaveLength(512);
    vi.unstubAllGlobals();
  });
});
