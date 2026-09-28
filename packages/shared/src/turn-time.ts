/**
 * How long a turn may take. The user's limit (settings `maxTaskMinutes`, "Longest run") counts ACTIVE time only:
 * the time the agent spends waiting (in wait_for, or for the user to answer an approval) is left out. The limit is
 * there to stop runaway model and browser work, and waiting costs neither (the extension enforces it:
 * apps/extension/src/engine/run/deadline.ts, ActiveClock).
 *
 * Wall time still has a ceiling, TURN_WALL_MINUTES, for every brain (their own timer, RunConfig.maxTaskMinutes)
 * and the runner's safety timer: a turn holds an agent tab, keeps the service worker and a Claude Code process
 * alive, and an agent could keep waiting (each wait_for call waits at most 30 minutes, an approval 10), so
 * something must end it. 4 hours is twice the longest active limit the settings allow (120 minutes): a turn that
 * uses all of it and still spends as long waiting (e.g. four 30-minute deploys) fits, and a forgotten one is freed
 * the same afternoon.
 */
export const TURN_WALL_MINUTES = 240;

/** What Settings says under "Longest run" (maxTaskMinutes). */
export const LONGEST_RUN_HINT = `Time spent working. Waiting for a page to change or for your approval does not count; a run still ends after ${TURN_WALL_MINUTES / 60} hours.`;
