import { describe, expect, it } from "vitest";
import type { TraceEvent } from "@noa/shared";
import { MAX_WAITING, PanelTrace } from "../../src/trace/panel-trace.js";

function panel() {
  const sent: { sessionId: string; names: string[] }[] = [];
  let n = 0;
  const trace = new PanelTrace(
    async (sessionId, events: TraceEvent[]) => {
      sent.push({ sessionId, names: events.map((e) => `${e.name}${e.cid ? `@${e.cid}` : ""}`) });
    },
    { flushMs: 60_000, newId: () => `c${++n}` },
  );
  return { trace, sent };
}

describe("PanelTrace", () => {
  it("an utterance's events wait for its message, then go to the conversation it went to", () => {
    const { trace, sent } = panel();
    const cid = trace.utterance();
    trace.record({ t: 1, cat: "voice", name: "voice.speech", cid });
    trace.record({ t: 2, cat: "voice", name: "voice.transcript", cid, data: { waitMs: 700 } });
    trace.flush();
    expect(sent).toEqual([]);
    trace.bind(cid, "s-new");
    trace.endUtterance();
    trace.flush();
    expect(sent).toEqual([{ sessionId: "s-new", names: ["voice.speech@c1", "voice.transcript@c1"] }]);
    // The next speech is a new utterance.
    expect(trace.utterance()).toBe("c2");
  });

  it("an utterance that sent nothing, and events without one, go to the chat the panel talks to", () => {
    const { trace, sent } = panel();
    trace.target = () => "s-chat";
    const cid = trace.utterance();
    trace.record({ t: 1, cat: "voice", name: "voice.speech", cid });
    trace.record({ t: 2, cat: "voice", name: "voice.tts" });
    trace.endUtterance();
    // Late events of an utterance that is over follow it.
    trace.record({ t: 3, cat: "voice", name: "voice.narrator", cid });
    trace.flush();
    expect(sent).toEqual([{ sessionId: "s-chat", names: ["voice.speech@c1", "voice.tts", "voice.narrator@c1"] }]);
  });

  it("with no chat yet, events without one join the next message's conversation", () => {
    const { trace, sent } = panel();
    trace.record({ t: 1, cat: "voice", name: "voice.ticket" });
    trace.record({ t: 2, cat: "voice", name: "voice.connect" });
    trace.bind("typed-1", "s-1");
    trace.flush();
    expect(sent).toEqual([{ sessionId: "s-1", names: ["voice.ticket", "voice.connect"] }]);
  });

  it("Realtime: a turn's request keeps its events together while it goes out; a turn done early does not scatter them", () => {
    const { trace, sent } = panel();
    trace.target = () => "s-chat";
    trace.useUtterance("rt-item1");
    trace.record({ t: 1, cat: "voice", name: "voice.tool.send_to_agent", cid: "rt-item1" });
    // The narrator's reply is done before the message went out.
    trace.endUtterance("rt-item1");
    trace.record({ t: 2, cat: "voice", name: "voice.narrator", cid: "rt-item1" });
    trace.flush();
    expect(sent).toEqual([]);
    trace.bind("rt-item1", "s-new");
    trace.endUtterance();
    trace.flush();
    expect(sent).toEqual([{ sessionId: "s-new", names: ["voice.tool.send_to_agent@rt-item1", "voice.narrator@rt-item1"] }]);
  });

  it("keeps at most MAX_WAITING events waiting", () => {
    const { trace, sent } = panel();
    const cid = trace.utterance();
    for (let i = 0; i < MAX_WAITING + 40; i++) trace.record({ t: i, cat: "voice", name: `e${i}`, cid });
    trace.bind(cid, "s");
    trace.flush();
    expect(sent[0]!.names).toHaveLength(MAX_WAITING);
    expect(sent[0]!.names[0]).toBe(`e40@${cid}`);
  });
});
