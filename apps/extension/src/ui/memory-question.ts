/**
 * "Add this computer's memory to <account>?": asked in the side panel and in Settings > Memory when the user signs
 * in to another account than the one this computer's memory was synced with (memory/sync.ts). Pure.
 */

export interface MemoryQuestionText {
  question: string;
  hint: string;
  add: string;
  keep: string;
}

export function memoryQuestionText(account: string): MemoryQuestionText {
  return {
    question: `Add this computer's memory to ${account}?`,
    hint: `What the agent learned on this computer goes to that account and syncs from then on. Keep separate: it stays on this computer only while you're signed in as ${account}.`,
    add: "Add",
    keep: "Keep separate",
  };
}
