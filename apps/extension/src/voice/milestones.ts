/**
 * Milestones: what the agent is doing, in a few spoken words, from its tool
 * calls ("Opening linkedin.com", "Opening 3 tabs"). Hands-free voice says
 * them now and then while a task runs; the realtime narrator gets them in
 * place of the raw steps. Never the text the agent types or reads. Pure.
 */
import type { AgentEvent, ToolArgsOf } from "@noa/shared";

/** A milestone is said at most this often. */
export const MILESTONE_GAP_MS = 6_000;

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

/** At most one milestone every `gapMs`, and never the one just said again. */
export class MilestoneThrottle {
  private lastAt = -Infinity;
  private last: string | null = null;

  constructor(private readonly gapMs = MILESTONE_GAP_MS) {}

  /** The milestone to say now, or null to skip it. */
  offer(line: string, now: number): string | null {
    if (line === this.last || now - this.lastAt < this.gapMs) return null;
    this.last = line;
    this.lastAt = now;
    return line;
  }

  /** A new turn: its first milestone may be said at once. */
  reset(): void {
    this.lastAt = -Infinity;
    this.last = null;
  }
}
