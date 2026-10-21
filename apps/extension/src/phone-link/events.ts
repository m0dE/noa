/**
 * What a paired phone sees of a conversation (docs/MOBILE.md, section 6): plain steps, the agent's words, the
 * approval cards, the end, and the latest look at the page. Never page dumps, tool results' text, or what was typed
 * into a field (a password the agent got from the vault would be in it).
 */
import { ANSWER_TOOL, USER_STOP_REASON, type AgentEvent, type SessionInfo } from "@noa/shared";
import type { PhoneEvent, PhoneJob } from "@noa/shared/phone-link/protocol";
import { clip, shortUrl, toolArgsSummary } from "../text.js";

type Plain = { [K in PhoneEvent["k"]]: Omit<Extract<PhoneEvent, { k: K }>, "ts"> }[PhoneEvent["k"]];

/** A tool call in words; null for calls that are not steps the user cares about. */
export function stepText(name: string, args: unknown): string | null {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  switch (name) {
    case "navigate":
      return `Opened ${shortUrl(String(a.url ?? ""))}`;
    case "read_page":
      return "Read the page";
    case "screenshot":
      return "Looked at the page";
    case "act": {
      const summary = toolArgsSummary(name, args);
      return summary ? clip(summary.charAt(0).toUpperCase() + summary.slice(1), 90) : "Worked on the page";
    }
    case "click":
      return "Clicked";
    case "type":
    case "paste":
      return "Typed into a field";
    case "press_key":
      return `Pressed ${String(a.key ?? "a key")}`;
    case "scroll":
      return "Scrolled";
    case "upload":
      return "Attached a file";
    case "wait_for":
      return "Waited for the page";
    case "get_credential":
      // Whether one was saved shows in what comes next (a sign-in, or Noa asking for the user).
      return `Looked for your saved login for ${String(a.site ?? "the site")}`;
    case "task_complete":
    case "task_fail":
    case "task_pause":
      // Their outcome comes as the task_end.
      return null;
    default: {
      const summary = toolArgsSummary(name, args, 60);
      const label = name.replace(/_/g, " ");
      return clip(summary ? `${label.charAt(0).toUpperCase()}${label.slice(1)}: ${summary}` : `${label.charAt(0).toUpperCase()}${label.slice(1)}`, 90);
    }
  }
}

/** The phone's line for one event; null when the phone shows nothing for it. */
export function phoneEvent(ev: AgentEvent): Plain | null {
  switch (ev.type) {
    case "user_message":
      return ev.attachments?.length ? { k: "user", text: ev.text, files: ev.attachments.length } : { k: "user", text: ev.text };
    case "assistant_text": {
      const text = ev.text.trim();
      return text ? { k: "text", text } : null;
    }
    case "tool_call": {
      if (ev.name === ANSWER_TOOL) {
        const answer = (ev.args as { text?: unknown } | undefined)?.text;
        return typeof answer === "string" && answer.trim() ? { k: "text", text: answer.trim() } : null;
      }
      const text = stepText(ev.name, ev.args);
      return text ? { k: "step", text } : null;
    }
    case "tool_result":
      return ev.thumbnail ? { k: "shot", jpeg: ev.thumbnail } : null;
    case "approval_request": {
      const r = ev.request;
      return {
        k: "approval",
        id: r.id,
        action: r.action,
        site: r.site,
        why: r.why,
        expiresAt: r.expiresAt,
        ...(r.text ? { text: r.text } : {}),
        ...(r.target ? { target: r.target } : {}),
      };
    }
    case "approval_resolved":
      return { k: "approval_done", id: ev.id, outcome: ev.outcome };
    case "task_end":
      return {
        k: "end",
        outcome: ev.outcome === "paused" && ev.reason?.trim() === USER_STOP_REASON ? "stopped" : ev.outcome,
        ...(ev.summary ? { summary: ev.summary } : {}),
        ...(ev.url ? { url: ev.url } : {}),
        ...(ev.reason ? { reason: ev.reason } : {}),
        ...(ev.suggestion ? { suggestion: ev.suggestion } : {}),
      };
    case "error":
      return { k: "error", text: ev.text };
    default:
      return null;
  }
}

export function stamped(ev: AgentEvent & { ts?: string }): PhoneEvent | null {
  const plain = phoneEvent(ev);
  return plain ? ({ ...plain, ts: ev.ts ?? new Date().toISOString() } as PhoneEvent) : null;
}

/**
 * A conversation's history for the phone: its first message (kept on the session, not as an event: the side panel's
 * openingTurn), every line, but only the latest look at the page (the phone shows one live picture, and screenshots
 * are the heavy part).
 */
export function history(s: SessionInfo, events: readonly (AgentEvent & { ts?: string })[]): PhoneEvent[] {
  const first = s.instructions?.trim() || s.title;
  const files = s.attachments?.length;
  const out: PhoneEvent[] = [{ k: "user", text: first, ...(files ? { files } : {}), ts: s.firstStartedAt ?? s.startedAt }];
  let shot: PhoneEvent | null = null;
  for (const ev of events) {
    const line = stamped(ev);
    if (!line) continue;
    if (line.k === "shot") shot = line;
    else out.push(line);
  }
  if (shot) out.push(shot);
  return out;
}

export function jobStatus(s: SessionInfo, running: boolean, needsYou: boolean): PhoneJob["status"] {
  if (needsYou) return "needs_you";
  if (running) return "running";
  if (s.outcome === "paused") return s.reason?.trim() === USER_STOP_REASON ? "stopped" : "needs_you";
  return s.outcome ?? "done";
}

export function phoneJob(s: SessionInfo, running: boolean, needsYou: boolean): PhoneJob {
  return { sessionId: s.sessionId, title: s.title, status: jobStatus(s, running, needsYou), updatedAt: s.endedAt ?? s.startedAt };
}
