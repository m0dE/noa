import { describe, expect, it, vi } from "vitest";
import type { RealtimeSocketLike } from "../../src/voice/realtime-client.js";
import { sampleCostText, sayRealtimeSample } from "../../src/voice/realtime-sample.js";

/** The relay's side of one socket. */
class Relay implements RealtimeSocketLike {
  readyState = 0;
  sent: Record<string, any>[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
    setTimeout(() => this.onclose?.({ code: 1000, reason: "" }), 0);
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  event(e: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(e) });
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(ticket = async () => ({ url: "wss://api.test/v1/ai/realtime", token: "tok" })) {
  let relay!: Relay;
  const played: string[] = [];
  let idle = () => {};
  let playing = false;
  const done = sayRealtimeSample({
    ticket,
    voice: "cedar",
    speed: 1.2,
    text: "Opening Gmail.",
    openSocket: () => (relay = new Relay()),
    createPlayer: (onIdle) => {
      idle = onIdle;
      return {
        play: (b64: string) => {
          playing = true;
          played.push(b64);
        },
        close: () => {},
        get playing() {
          return playing;
        },
      };
    },
  });
  const finishPlaying = () => {
    playing = false;
    idle();
  };
  return { done, relay: () => relay, played, finishPlaying };
}

describe("Test voice for Realtime", () => {
  it("opens a session in the chosen voice and speed, asks for the line, plays it and closes", async () => {
    const t = setup();
    await flush();
    t.relay().open();
    expect(t.relay().sent[0]!.session.audio.output).toMatchObject({ voice: "cedar", speed: 1.2 });
    t.relay().event({ type: "session.created", session: {} });
    const asked = t.relay().sent.slice(1);
    // The line itself, word for word (lineResponse), with nothing in the conversation.
    expect(asked.map((e) => e.type)).toEqual(["response.create"]);
    expect(asked[0]!.response.instructions).toContain("«Opening Gmail.»");
    t.relay().event({ type: "response.created", response: { id: "r1" } });
    t.relay().event({ type: "response.output_audio.delta", item_id: "a1", delta: "AAAA" });
    t.relay().event({ type: "response.done", response: { id: "r1" } });
    // All of it arrived, but it is still playing: not done yet.
    await flush();
    expect(t.relay().closed).toBe(false);
    t.finishPlaying();
    await expect(t.done).resolves.toBeUndefined();
    expect(t.played).toEqual(["AAAA"]);
    expect(t.relay().closed).toBe(true);
  });

  it("says why when the server cannot run Realtime", async () => {
    const t = setup();
    await flush();
    t.relay().open();
    t.relay().event({ type: "noa.error", error: "realtime_unavailable", message: "Realtime voice is not set up on this server yet" });
    t.relay().onclose?.({ code: 4503, reason: "realtime_unavailable" });
    await expect(t.done).rejects.toMatchObject({ kind: "unavailable", message: "Realtime voice is unavailable on the server right now." });
  });

  it("fails with the ticket's reason when there is no session (signed out, no plan)", async () => {
    const t = setup(() => Promise.reject(new Error("Log in to use voice.")));
    await expect(t.done).rejects.toThrow("Log in to use voice.");
  });

  it("gives up after a while without an answer", async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      await vi.advanceTimersByTimeAsync(0);
      t.relay().open();
      const failed = expect(t.done).rejects.toMatchObject({ kind: "network", transient: true });
      await vi.advanceTimersByTimeAsync(20_000);
      await failed;
    } finally {
      vi.useRealTimers();
    }
  });

  it("names about what it costs: at least 1¢", () => {
    expect(sampleCostText(5.4912)).toBe("uses about 1¢ of usage credit");
    expect(sampleCostText(0.2)).toBe("uses about 1¢ of usage credit");
    expect(sampleCostText(30)).toBe("uses about 5¢ of usage credit");
  });
});
