import { z } from "zod";
import { MAX_TABS_PER_CALL } from "./browser.js";
import { DIALOG_AUTO_DISMISS_MS } from "./dialog.js";
import { ImageQuality, ImageSize, MAX_IMAGE_PROMPT_CHARS } from "./images.js";
import {
  CANCEL_SCHEDULED_TASK_DESCRIPTION,
  CancelScheduledTaskArgs,
  LIST_SCHEDULED_TASKS_DESCRIPTION,
  ListScheduledTasksArgs,
  SCHEDULE_TASK_DESCRIPTION,
  ScheduleTaskArgs,
  UPDATE_SCHEDULED_TASK_DESCRIPTION,
  UpdateScheduledTaskArgs,
} from "./schedule-task.js";
import {
  CHECK_SIMILAR_DESCRIPTION,
  CheckSimilarArgs,
  FORGET_DESCRIPTION,
  ForgetArgs,
  MAX_MEMORY_NOTE_CHARS,
  MAX_RUN_OUTPUT_CHARS,
  RECALL_DESCRIPTION,
  RecallArgs,
  REMEMBER_DESCRIPTION,
  RememberArgs,
} from "./memory.js";
import { WAIT_FOR_DESCRIPTION, WaitForArgs } from "./wait.js";
import { SEARCH_HISTORY_DESCRIPTION, SearchHistoryArgs } from "./history-search.js";

/**
 * MCP tools exposed to Claude Code. The MCP server registers these, the helper
 * executes them. Claude sees them as `mcp__noa__<name>`.
 */
export const MCP_SERVER_NAME = "noa";

/** Most steps in one act call: enough for a whole signup form (its fields, the terms box and submit). */
export const MAX_ACT_STEPS = 12;

/** act's arguments; the field descriptions differ with Jev on (see ToolArgsJev). */
function actArgs(d: { goal: string; index: string; steps: string }) {
  return z.object({
    steps: z
      .array(
        z.object({
          goal: z.string().describe(d.goal),
          text: z
            .string()
            .optional()
            .describe("Text for a step that fills a field: it replaces the field's current value (in a rich editor it is added at the end). For a dropdown (<select>), the option to choose: its label or value"),
          checked: z
            .boolean()
            .optional()
            .describe("For a checkbox, radio button or switch: true to check (select) it, false to uncheck it. The state is set, not toggled: nothing happens when it already is"),
          index: z.number().int().optional().describe(d.index),
        }),
      )
      .min(1)
      .max(MAX_ACT_STEPS)
      .describe(d.steps),
  });
}

/** Longest follow-up suggestion (task_* `suggestion`): one short line the chat's input box can show faded. */
export const MAX_SUGGESTION_CHARS = 80;

/** What a follow-up suggestion must never propose (the system prompt and the task_* field say the same). */
export const SUGGESTION_NEVER =
  "Never suggest paying, buying or sending money, deleting anything, or posting or messaging anyone beyond what the user asked about";

/** task_complete / task_fail / task_pause: the user's likely next request, which they accept (Tab) and send themselves. */
const suggestionArg = z
  .string()
  .trim()
  .min(1)
  .max(MAX_SUGGESTION_CHARS)
  .optional()
  .describe(
    `Only when the user very likely wants one specific next step: that request as a short imperative in their words, at most ${MAX_SUGGESTION_CHARS} characters (e.g. "Reply to Jordan and say I'll sign by Thursday"). Shown faded in their input box; it runs only if they accept and send it. Omit otherwise. ${SUGGESTION_NEVER}.`,
  );

/** Longest spoken line (task_* `spoken`): what hands-free voice reads aloud when the turn ends. */
export const MAX_SPOKEN_CHARS = 200;

/** task_complete / task_fail / task_pause: the turn's outcome as one or two sentences to say aloud. */
const spokenArg = z
  .string()
  .trim()
  .min(1)
  .max(MAX_SPOKEN_CHARS)
  .optional()
  .describe(
    `One or two short sentences, read aloud to a user who talks to Noa hands-free, at most ${MAX_SPOKEN_CHARS} characters: the result, or the question they must answer, never again what you already told them with answer_user in this turn. Natural speech, as you would say it to them, in the first person as Noa ("I…"), never "the agent": no Markdown, lists, URLs or IDs (e.g. "Done. You have four unread emails, and Jordan needs your signature by Friday.").`,
  );

/** Longest draft (task_complete / task_pause `draft`): an email or post the user reviews before it goes anywhere. */
export const MAX_DRAFT_CHARS = 8000;

/** task_complete / task_pause: text the agent wrote for the user to review, not sent; the chat shows it with Copy. */
const draftArg = z
  .string()
  .trim()
  .min(1)
  .max(MAX_DRAFT_CHARS)
  .optional()
  .describe(
    `When you wrote something for the user that was not sent or published (an email, message, reply or post to review, a draft they asked for): its full text exactly as it would go out, an email's "Subject: ..." line first, at most ${MAX_DRAFT_CHARS} characters. The chat shows it as a draft with a Copy button. Omit when nothing was drafted, or when it was sent.`,
  );

export const ToolArgs = {
  navigate: z.object({ url: z.string().describe("Absolute URL to open") }),
  read_page: z.object({
    tabs: z
      .array(z.string())
      .min(1)
      .max(MAX_TABS_PER_CALL)
      .optional()
      .describe("Tab ids (from open_tabs or list_tabs) to read together in one call. Default: the current tab"),
  }),
  screenshot: z.object({}),
  act: actArgs({
    goal: "What this step does, in plain words, e.g. 'open the post composer'",
    index: "Element index from read_page (every step needs one). The step types its text into that element, or clicks it when there is no text",
    steps: "Steps done in order; stops at the first step that fails",
  }),
  click: z.object({ index: z.number().int().describe("Element index from read_page") }),
  type: z.object({
    index: z.number().int().describe("Element index from read_page"),
    text: z.string(),
  }),
  paste: z.object({ text: z.string().describe("Text inserted at the current focus") }),
  press_key: z.object({
    key: z.string().describe("Key name like Enter, Escape, Tab, ArrowDown, or a combo like Control+Enter"),
  }),
  scroll: z.object({
    direction: z.enum(["up", "down", "left", "right"]),
    amount: z.number().int().min(1).max(20).optional().describe("Screens to scroll, default 1"),
    index: z.number().int().optional().describe("Scroll inside this element instead of the page"),
  }),
  upload: z.object({
    index: z.number().int().describe("Index from read_page of an <input type=file>, a drop zone, or an editor that takes dropped or pasted images"),
    paths: z.array(z.string()).min(1).describe("Absolute local file paths: from the task's media list, the attached files, generate_image or list_files"),
  }),
  open_tabs: z.object({
    urls: z.array(z.string().describe("Absolute URL")).min(1).max(MAX_TABS_PER_CALL).describe("URLs to open, each in its own new tab"),
    background: z
      .boolean()
      .optional()
      .describe("Default true: open without showing them and keep the current tab. false: show the first new tab and make it the current tab"),
  }),
  switch_tab: z.object({ tab: z.string().describe("Tab id from open_tabs or list_tabs, e.g. t2") }),
  list_tabs: z.object({}),
  close_tabs: z.object({ tabs: z.array(z.string()).min(1).describe("Tab ids to close") }),
  handle_dialog: z.object({
    accept: z.boolean().describe(`true: OK (on "Leave site?": Leave, which discards the page's unsaved changes). false: Cancel (stay on the page)`),
    text: z.string().optional().describe("For a prompt dialog: the answer to type in before OK"),
    tab: z.string().optional().describe("Tab id whose dialog to answer. Default: the current tab"),
  }),
  wait_for: WaitForArgs,
  switch_x_account: z.object({ handle: z.string().describe("Account handle, e.g. @myhandle") }),
  get_credential: z.object({ site: z.string().describe("Hostname, e.g. example.com") }),
  list_files: z.object({
    search: z.string().trim().min(1).max(100).optional().describe("Only files whose name or subfolder contains this text (any case). Default: all files"),
  }),
  save_file: z.object({
    url: z.string().optional().describe("Save the file at this address (a link's href from read_page); the browser's sign-ins apply"),
    text: z.string().optional().describe("Save this text you wrote; give name with its extension"),
    screenshot: z.boolean().optional().describe("true: save a picture of the current tab"),
    path: z.string().optional().describe("Save this file from this computer: a path list_files, the task's media, an attachment or generate_image gave"),
    download: z.boolean().optional().describe("true: save the file the browser downloaded last: for a file the page makes itself when you click its download or export button, which has no link to save by url"),
    name: z.string().trim().min(1).max(120).optional().describe("File name with its extension. Default: from the source"),
    folder: z.string().trim().max(60).optional().describe("One folder, named for the kind of file. Default: the top"),
  }),
  generate_image: z.object({
    prompt: z
      .string()
      .trim()
      .min(1)
      .max(MAX_IMAGE_PROMPT_CHARS)
      .describe("What the picture shows, in detail: subject, style, colors, composition, and any text it must contain (quoted, spelled exactly)"),
    name: z.string().trim().min(1).max(80).optional().describe("Short file name without extension, e.g. 'store-icon'. Default: taken from the description"),
    size: ImageSize.optional().describe("Width x height in pixels. Default 1024x1024 (square); 1536x1024 is landscape, 1024x1536 portrait"),
    quality: ImageQuality.optional().describe("low: a quick draft (about 1 cent). medium (default): good for most uses (about 7 cents, ~30 s). high: final art (about 30 cents, 1-2 minutes)"),
    transparent: z.boolean().optional().describe("true: a transparent background, for icons, logos and stickers"),
  }),
  schedule_task: ScheduleTaskArgs,
  list_scheduled_tasks: ListScheduledTasksArgs,
  update_scheduled_task: UpdateScheduledTaskArgs,
  cancel_scheduled_task: CancelScheduledTaskArgs,
  remember: RememberArgs,
  recall: RecallArgs,
  forget: ForgetArgs,
  search_history: SearchHistoryArgs,
  check_similar: CheckSimilarArgs,
  answer_user: z.object({
    text: z
      .string()
      .trim()
      .min(1)
      .max(MAX_SPOKEN_CHARS)
      .describe(
        `Your answer, in one or two short sentences, at most ${MAX_SPOKEN_CHARS} characters, in the first person as Noa ("I…"), never "the agent": natural speech, no Markdown, lists, URLs or IDs (e.g. "Yes, I'm including the Stripe email too.").`,
      ),
  }),
  task_complete: z.object({
    summary: z
      .string()
      .describe("One short line for the task list: what was done (e.g. 'Answered the question', 'Posted the reply'). Not the answer itself: write answers as message text before this call"),
    url: z.string().optional().describe("URL of the created post or result, if any"),
    suggestion: suggestionArg,
    spoken: spokenArg,
    draft: draftArg,
    memory_note: z
      .string()
      .trim()
      .min(1)
      .max(MAX_MEMORY_NOTE_CHARS)
      .optional()
      .describe(
        "Repeating TODO tasks only: a short note for this task's next run: what this run did (the topic posted, who was answered) and what is still pending, so the next run goes on instead of repeating. Never page content, passwords or codes.",
      ),
    output: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        `Repeating TODO tasks that produce content only: exactly what this run published or sent (the text of the post, message or reply as it went out; several, one after another), at most ${MAX_RUN_OUTPUT_CHARS} characters (longer is cut). Kept in the task's history, so later runs do not repeat it. Never passwords or codes.`,
      ),
  }),
  task_fail: z.object({ reason: z.string(), suggestion: suggestionArg, spoken: spokenArg }),
  task_pause: z.object({ reason: z.string().describe("Why a human is needed"), suggestion: suggestionArg, spoken: spokenArg, draft: draftArg }),
} as const;

export type ToolName = keyof typeof ToolArgs;
export const TOOL_NAMES = Object.keys(ToolArgs) as ToolName[];
export type ToolArgsOf<N extends ToolName> = z.infer<(typeof ToolArgs)[N]>;

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  navigate: "Open a URL in the current tab and wait for it to load.",
  read_page:
    "Get the page URL, title, visible text and an indexed list of interactive elements. Give `tabs` to read several tabs in one call (each under its own header) without switching to them.",
  screenshot: "Capture the visible part of the current tab as an image.",
  act: `Do up to ${MAX_ACT_STEPS} small steps in order, in one call. Each step names the element index from read_page: a step with text fills that element (a dropdown gets the option named by text), a step with checked sets a checkbox or radio button, any other step clicks it. Stops at the first step that fails and returns the page's element list, so you can send the rest again.`,
  click: "Click an element by index from read_page.",
  type: "Focus an element by index and insert text into it.",
  paste: "Insert text at the current keyboard focus.",
  press_key: "Press a key or key combination.",
  scroll: "Scroll the page or an element.",
  upload: "Attach local files by index: set on a file input, else dropped on the element (drop zones, editors), else pasted into it.",
  open_tabs:
    "Open up to 8 URLs at once, each in a new tab, loading in parallel. Waits until all are loaded and returns their tab ids and titles. The current tab stays the same unless background is false.",
  switch_tab: "Make another tab the current tab: read_page, act, navigate, scroll, screenshot and the other tools then act on it.",
  list_tabs: "List this task's tabs with id, URL, title, and which one is current.",
  close_tabs: "Close tabs you opened and no longer need. The tab the task started on is never closed.",
  handle_dialog: `Answer the browser dialog (alert, confirm, prompt, or "Leave site?") open in a tab. While one is open its page is frozen: other tools on that tab say so until it is answered. One nobody answers is cancelled after ${DIALOG_AUTO_DISMISS_MS / 1000} s.`,
  wait_for: WAIT_FOR_DESCRIPTION,
  switch_x_account: "Switch X (Twitter) to another signed-in account using X's account switcher. It checks that the switcher shows the new account before it answers.",
  get_credential: "Get the stored username and password for a site. Never use this for X.",
  list_files:
    "List the files the user keeps for Noa: their Noa folder (Downloads/Noa on their computer) and, when they are signed in, their Noa cloud files; newest first, with each one's absolute path, size and date. Any listed path can be given to upload (a cloud file is downloaded to it first).",
  save_file:
    "Keep a file for the user: it is saved in their Noa folder (Downloads/Noa/<folder>) and, when they are signed in on a plan with cloud files, in their Noa cloud files (cloud storage), where list_files and their other computers find it later. Give exactly one source: url, text, screenshot, path or download. A file with a link is saved by its url; a file the page makes itself when a button is clicked (an export or download button with no link to the file) is saved in two steps: click that button, then call save_file with download: true. The result gives its path, which upload takes.",
  generate_image:
    "Create a new picture (an icon, illustration, banner, photo-like image) from a text description, with Noa AI's image model, paid from the user's Noa usage credit. It is saved as a PNG in the user's Noa folder (Downloads/Noa/images); the result gives its path, which upload takes, and shows you the picture. Use it only when the user wants an image made, not to find existing ones.",
  schedule_task: SCHEDULE_TASK_DESCRIPTION,
  list_scheduled_tasks: LIST_SCHEDULED_TASKS_DESCRIPTION,
  update_scheduled_task: UPDATE_SCHEDULED_TASK_DESCRIPTION,
  cancel_scheduled_task: CANCEL_SCHEDULED_TASK_DESCRIPTION,
  remember: REMEMBER_DESCRIPTION,
  recall: RECALL_DESCRIPTION,
  forget: FORGET_DESCRIPTION,
  search_history: SEARCH_HISTORY_DESCRIPTION,
  check_similar: CHECK_SIMILAR_DESCRIPTION,
  answer_user:
    'Answer a message the user sent while you work (it starts with "The user just said:"): a question or a remark. Call it as soon as you know the answer: at once when you already do, else right after the step that finds it out. It is shown in the chat and said aloud to a user who talks hands-free; then go on with the task. Only for those messages, never for progress or the task\'s result.',
  task_complete:
    "Finish the task successfully. Call exactly once when the task is fully done. For questions and information tasks, write the full answer to the user as normal message text first (Markdown is rendered), then call this with a one-line summary; never put the answer or long text in the summary. Add a suggestion only when a next step is clearly likely.",
  task_fail: "Finish the task as failed when it cannot be done. Add a suggestion only when a next request would clearly help (e.g. 'Try again after I sign in').",
  task_pause: "Stop and ask the human for help: login page, 2FA, CAPTCHA, warning, or anything uncertain. Add a suggestion only when the user's likely reply is clear.",
};

/**
 * With Jev on, the fast model picks the element of every act step: read_page
 * lists elements without index numbers, and act takes an index only for a
 * step Jev just reported "not confident" about (from the candidates it
 * returned). These replace TOOL_DESCRIPTIONS / ToolArgs entries in that mode.
 */
const JEV_DESCRIPTIONS: Partial<Record<ToolName, string>> = {
  read_page:
    "Get the page URL, title, visible text and a compact list of the interactive elements (role and visible label, no index numbers). Describe the element you want in words in act; the fast picker finds it. Give `tabs` to read several tabs in one call (each under its own header) without switching to them.",
  act: `Do up to ${MAX_ACT_STEPS} small steps in order, in one call. Describe each step's element in words: its visible label and role, and its position when several look alike (e.g. 'click the Reply button under the first post', 'type into the Post text box'); a fast model picks the element. Give text for steps that fill a field (a dropdown gets the option named by text), and checked for checkboxes and radio buttons. If the fast model is not confident about a step, act stops there and returns a short numbered candidate list for that step only: send that step again with the same goal and the index of the right candidate, then continue. Do not send an index otherwise.`,
};

/** The description of a tool, for the given Jev mode. */
export function toolDescription(name: ToolName, jev: boolean): string {
  return (jev && JEV_DESCRIPTIONS[name]) || TOOL_DESCRIPTIONS[name];
}

/** ToolArgs with Jev-mode field descriptions (same shapes, so validation is the same). */
export const ToolArgsJev: typeof ToolArgs = {
  ...ToolArgs,
  act: actArgs({
    goal: "The step and its element in words, precisely: visible label, role, and position if several look alike, e.g. 'click the Reply button under the first post'",
    index: "Only for a step the fast model just reported not confident about: the index of the right element from the candidate list act returned for it (same goal). Never otherwise",
    steps: "Steps done in order; the fast model picks each step's element. Stops at the first step it is not confident about and returns candidates for that step",
  }),
};

/** The input schema of a tool, for the given Jev mode. */
export function toolArgsSchema(name: ToolName, jev: boolean) {
  return (jev ? ToolArgsJev : ToolArgs)[name];
}

export function mcpToolName(name: ToolName): string {
  return `mcp__${MCP_SERVER_NAME}__${name}`;
}

/** A tool name without the MCP prefix Claude Code adds (mcpToolName); other names are returned as they are. */
export function bareToolName(name: string): string {
  const prefix = `mcp__${MCP_SERVER_NAME}__`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/** Result of a tool call as returned to Claude. */
export interface ToolResult {
  text?: string;
  image?: { base64: string; mimeType: string };
  isError?: boolean;
}

/**
 * RPC method the MCP server calls on the helper over the named pipe. Every call carries the helper's pipe token
 * (random per helper start, kept where only the user can read it): the pipe answers no other process.
 */
export type PipeMethods = {
  "tool.call": { params: { token: string; taskId: string; name: ToolName; args: unknown }; result: ToolResult };
  /** jev: the session's act steps are picked by Jev (tool descriptions differ, see toolDescription). */
  "tool.list": { params: { token: string; taskId: string }; result: { names: ToolName[]; jev?: boolean } };
}

/** The tool that answers a message the user sent while the agent works (said aloud in hands-free voice). */
export const ANSWER_TOOL = "answer_user" satisfies ToolName;

/** Tools that end a task. Not offered to the user's own Claude Code (mcp-server --attach). */
export const TASK_END_TOOLS: readonly ToolName[] = ["task_complete", "task_fail", "task_pause"];

/** The TODO tools (schedule-task.ts): answered by the extension's TODO list for the conversation. */
export const TODO_TOOLS = ["schedule_task", "list_scheduled_tasks", "update_scheduled_task", "cancel_scheduled_task"] as const satisfies readonly ToolName[];
export type TodoToolName = (typeof TODO_TOOLS)[number];

/** Tools that need a Noa conversation: the TODO tools work on its user's TODO list; memory and history are the user's, kept by the extension. */
export const CONVERSATION_TOOLS: readonly ToolName[] = [...TODO_TOOLS, "remember", "recall", "forget", "search_history", "check_similar"];

/** The memory tools (memory.ts, history-search.ts): answered by the extension's memory for the conversation. */
export const MEMORY_TOOLS = ["remember", "recall", "forget", "search_history", "check_similar"] as const satisfies readonly ToolName[];
export type MemoryToolName = (typeof MEMORY_TOOLS)[number];

/**
 * Tools offered to the user's own Claude Code through mcp-server --attach (no task to end, no conversation), and
 * never get_credential: saved passwords go only to Noa's own task sessions, not to whatever an attached
 * session was told to do. No answer_user either: no Noa user sends it messages.
 */
export const INTERACTIVE_TOOL_NAMES: ToolName[] = TOOL_NAMES.filter((n) => !TASK_END_TOOLS.includes(n) && !CONVERSATION_TOOLS.includes(n) && n !== "get_credential" && n !== ANSWER_TOOL);

/**
 * Tools offered to the model. act (batched steps) always replaces click and
 * type: steps that name an element index run directly; with Jev, steps may
 * instead describe the element in words. interactive: the user's own Claude
 * Code (INTERACTIVE_TOOL_NAMES, no task to end). images false: no generate_image (the user turned image generation
 * off in Settings).
 */
export function toolsFor(opts: { interactive?: boolean; images?: boolean } = {}): ToolName[] {
  return (opts.interactive ? INTERACTIVE_TOOL_NAMES : TOOL_NAMES).filter((n) => n !== "click" && n !== "type" && (opts.images !== false || n !== "generate_image"));
}
