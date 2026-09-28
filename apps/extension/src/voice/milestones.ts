/**
 * Milestones: what the agent is doing, in a few spoken words, from its tool
 * calls ("Opening linkedin.com", "Opening 3 tabs"). Hands-free voice says
 * them now and then while a task runs (ProgressPacer, both engines); the
 * realtime narrator gets them in place of the raw steps. Never the text the
 * agent types or reads. Pure.
 */
import type { AgentEvent, ToolArgsOf } from "@noa/shared";

/** "https://www.example.com/a" -> "example.com"; null for anything that is not a web address. */
export function siteName(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

type Steps = ToolArgsOf<"act">["steps"];

function actMilestone(steps: Steps | undefined): string {
  const typed = (steps ?? []).filter((s) => s.text !== undefined || s.checked !== undefined).length;
  if (typed >= 2) return "Filling in the form";
  if (typed === 1) return "Typing";
  return "Clicking through the page";
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);

/** The spoken milestone of an event, or null when it is not worth saying. */
export function milestoneOf(ev: AgentEvent): string | null {
  if (ev.type !== "tool_call") return null;
  const args = (ev.args ?? {}) as Record<string, unknown>;
  switch (ev.name) {
    case "navigate": {
      const site = siteName(args.url);
      return site ? `Opening ${site}` : "Opening a page";
    }
    case "open_tabs": {
      const urls = Array.isArray(args.urls) ? args.urls : [];
      const site = urls.length === 1 ? siteName(urls[0]) : null;
      return site ? `Opening ${site}` : `Opening ${plural(urls.length, "a tab", "tabs")}`;
    }
    case "read_page": {
      const tabs = Array.isArray(args.tabs) ? args.tabs.length : 1;
      return tabs > 1 ? `Reading ${tabs} pages` : "Reading the page";
    }
    case "screenshot":
      return "Looking at the page";
    case "act":
      return actMilestone(args.steps as Steps | undefined);
    case "click":
      return "Clicking through the page";
    case "type":
    case "paste":
      return "Typing";
    case "scroll":
      return "Scrolling";
    case "upload":
      return "Attaching files";
    case "switch_tab":
      return "Switching tabs";
    case "switch_x_account":
      return typeof args.handle === "string" ? `Switching to @${args.handle.replace(/^@/, "")}` : "Switching accounts";
    case "get_credential":
      return typeof args.site === "string" ? `Signing in to ${args.site}` : "Signing in";
    default:
      return null;
  }
}

/**
 * How hands-free voice keeps the user informed while the agent works, on both engines (ProgressPacer): a short line
 * when the agent starts something new, and one "Still …" line after a long silence. Neither is a reply: the result is
 * said once, when the turn ends.
 */
export const PROGRESS = {
  /** A new step is said at most this often, and never this soon after anything else was said. */
  stepGapMs: 8_000,
  /** Nothing said for this long while the agent works: one short "Still …" line about what it does now. */
  stillWorkingMs: 18_000,
  /** New-step lines said at most per request (the "Still …" lines apart). */
  maxSteps: 5,
} as const;

/**
 * What kind of step a milestone is: opening a site (each site its own), reading, writing, an account change or
 * sign-in, attaching files; null: routine (clicking, scrolling, switching tabs), never said as a step but still what
 * the agent does now.
 */
function stepKey(line: string): string | null {
  if (line.startsWith("Opening ")) return line;
  if (line.startsWith("Reading ") || line === "Looking at the page") return "read";
  if (line === "Typing" || line === "Filling in the form") return "write";
  if (/^Switching to |^Switching accounts|^Signing in/.test(line)) return line;
  if (line === "Attaching files") return "attach";
  return null;
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * When a progress line is said (pure; the engines pass the time): a step when the agent starts a new kind of step
 * (another site, reading, writing, an account), PROGRESS.stepGapMs after anything else was said, at most
 * PROGRESS.maxSteps a request; and while the agent works with nothing said for PROGRESS.stillWorkingMs, "Still <what it
 * does now>" (once for each thing it does, so a long step is not repeated).
 */
export class ProgressPacer {
  /** When something was last said (not the user: their request does not hold a first step back). */
  private lastSaidAt = -Infinity;
  /** Since when nothing was said or asked (the "Still …" line's clock). */
  private quietSince = -Infinity;
  private lastStep: string | null = null;
  private steps = 0;
  /** What the agent does now (its latest milestone; null: nothing yet, thinking). */
  private current: string | null = null;
  /** What the last "Still …" line was about (undefined: none yet). */
  private stillAbout: string | null | undefined = undefined;

  constructor(private readonly p: { stepGapMs: number; stillWorkingMs: number; maxSteps: number } = PROGRESS) {}

  /** A new request or turn: its steps start over; `now`: when it began (the silence is counted from then). */
  reset(now = -Infinity): void {
    this.quietSince = now;
    this.lastStep = null;
    this.steps = 0;
    this.current = null;
    this.stillAbout = undefined;
  }

  /** Something was said (a line, the narrator's reply, an acknowledgement). */
  said(now: number): void {
    this.lastSaidAt = Math.max(this.lastSaidAt, now);
    this.quietSince = Math.max(this.quietSince, now);
  }

  /** A tool call: the step line to say now, or null. */
  step(ev: AgentEvent, now: number): string | null {
    const line = milestoneOf(ev);
    if (!line) return null;
    this.current = line;
    const key = stepKey(line);
    if (!key || key === this.lastStep) return null;
    if (this.steps >= this.p.maxSteps || now - this.lastSaidAt < this.p.stepGapMs) return null;
    this.lastStep = key;
    this.steps++;
    this.said(now);
    return line;
  }

  /** While the agent works: the "Still …" line to say now, or null. */
  stillWorking(now: number): string | null {
    // Nothing known yet (voice started while the agent works): the silence counts from now.
    if (this.quietSince === -Infinity) this.quietSince = now;
    if (now - this.quietSince < this.p.stillWorkingMs || this.stillAbout === this.current) return null;
    this.stillAbout = this.current;
    // Only the silence starts over: a new step right after it is still news.
    this.quietSince = now;
    return this.current ? `Still ${lowerFirst(this.current)}` : "Still working on it";
  }
}
