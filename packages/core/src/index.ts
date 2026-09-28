/**
 * @noa/core: agent logic shared by the helper (Claude Code brain, via
 * MCP) and the extension (Claude API brain, in the service worker).
 * Browser- and Node-safe: no Node-only imports, no process.env.
 */
export * from "./types.js";

/** Tool execution shared by both brains. */
export { createToolExecutor } from "./executor.js";
/** Jev client over fetch (works in the extension and in Node). */
export { createJev, proxyJevClient, type CreateJevOptions, type JevClientLike } from "./jev.js";
/** A hosted-AI request refused for lack of usage credit (HTTP 402); error text made readable for the user. */
export { OutOfCreditError, plainErrorText, type CreditShortfall } from "./api-errors.js";
/** Keeps passwords the agent was given out of events and logs. */
export { mapStrings, REDACTED, SecretRedactor } from "./redact.js";
/** System prompt for either brain, the first user message of a task, and how later messages are framed. */
export { buildFollowUpMessage, buildSystemPrompt, buildTaskPrompt, FOLLOW_UP_PREFIX, type FollowUpMessage } from "./prompts.js";
/** Messages the user sends while a turn runs: delivered at the model's next read, and the turn cannot end before. */
export { interjectionText, Interjections, type InterjectionRoute } from "./interjections.js";
export { runWaitFor, WAIT_RETRY_BACKOFF, type WaitEnd } from "./wait.js";
/** Compact text form of a snapshot (as returned by read_page), and its parser for the helper's scripted brain. */
export { formatSnapshot, parseSnapshotText, type ParsedPage } from "./page-format.js";
/** Failure reasons the agents report, and their sorting into temporary (retry later) or permanent. */
export { agentError, classifyFailure, ENDED_WITHOUT_RESULT, EXITED_WITHOUT_RESULT } from "./failures.js";
/** A turn's tool call budget, time limit and closing events, the same for both brains. */
export { isTaskEndTool, timeLimitReached, toolBudget, toolCallLimitExceeded, toolCallLimitReached, turnEndEvents, type ToolBudget } from "./turn-rules.js";
/** Marker in act results when Jev was not sure about a step (the result then lists candidates for it). */
export { NOT_CONFIDENT } from "./act.js";
/** Checks independently that an X post exists and shows the expected text. */
export { verifyXPost } from "./verify.js";
/** One Messages request (Anthropic or the hosted AI), for one-shot calls outside the agent loop (the memory writer). */
export { postMessages, type MessagesRequest, type MessagesTransport, type PostResult } from "./anthropic.js";
/** How much the model thinks: the stuck detector that raises a Fast run's reasoning, and each model's request settings. */
export {
  MAX_RAISES_PER_TURN,
  OBSERVING_TOOLS,
  raiseNote,
  ReasoningGovernor,
  reasoningOf,
  reasoningParams,
  reasoningTrace,
  StuckDetector,
  STUCK_LIMITS,
  TASK_FAIL_RECHECK,
  THINKING_BUDGET_TOKENS,
  THINKING_MAX_TOKENS,
  type ReasoningChange,
  type ReasoningParams,
} from "./reasoning.js";
/** Claude API agent loop (Anthropic Messages API with tool use). */
export { startApiAgent } from "./api-agent.js";
/** Token counts of a Messages API usage object, as the trace records them (Claude Code reports the same shape). */
export { usageOf } from "./api-agent.js";
/** Files the user attached, as the model gets them: listed in the message, images and PDFs as blocks or for Claude Code's Read. */
export { attachmentBlocks, attachmentLines, withAttachmentLines, type ApiAttachment, type AttachmentView } from "./attachments.js";
