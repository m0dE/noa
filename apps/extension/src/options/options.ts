/**
 * Options page: a sidebar of sections for the account, the AI under its own tabs (source, key, model,
 * helper, Jev, hands-free voice, image generation), permission and scheduling, tasks, site logins, memory and self-hosting. Settings save by
 * themselves as they change; keys save with their own Save button.
 * What shows when comes from settingsView() (settings-view.ts).
 */
import { OPEN_CHAT_COMMAND, openShortcutSettings, readShortcut, VOICE_COMMAND, type ShortcutCommand } from "../shortcut.js";
import { errorMessage, helperInstallUrl, LONGEST_RUN_HINT, type BrainMode, type ExtensionSettings } from "@noa/shared";
import { isStale, OPTIONS_PORT_NAME, uiRequest, type UiState } from "../ui-protocol.js";
import { HELPER_CODE } from "../build-config.js";
import { connectBackground } from "../sidepanel/port.js";
import { createAccountMenu } from "../ui/account-menu.js";
import { $, busy, closeMenusOnOutsideClick, find, flash, h } from "../ui/dom.js";
import { initAccountSection } from "./account-section.js";
import { initPhoneSection } from "./phone-section.js";
import { initAutomationSection } from "./automation-section.js";
import { initImagesSection } from "./images-section.js";
import { initMemorySection } from "./memory-section.js";
import { initStorageSection } from "./storage-section.js";
import { SaveQueue } from "./autosave.js";
import { initSecretFields } from "./secret-field.js";
import { initVaultSection } from "./vault-section.js";
import { initVoiceSection } from "./voice-section.js";
import { adjustedFields, buildSettingsPatch, helperInstallCommand, helperInstallCommandWindows, helperDiagnostics, helperNeedsInstall, helperStatus, localSetupCommand } from "./settings-patch.js";
import {
  anchorFromHash,
  BOOL_FIELDS,
  CUSTOM_MODEL,
  formValues,
  modelOptions,
  reasoningOptions,
  NUMBER_FIELDS,
  NUMBER_RULES,
  parseForm,
  settingsView,
  TEXT_FIELDS,
  validateForm,
  type Draft,
  type FormValues,
  type Tone,
} from "./settings-view.js";
import { initSidebar } from "./sidebar.js";
import { initAiTabs, revealGroup } from "./ai-tabs.js";

const LABELS: Partial<Record<keyof ExtensionSettings, string>> = {
  jevThreshold: "Jev threshold",
  intervalMinutes: "check interval",
  delayMinSec: "shortest pause",
  delayMaxSec: "longest pause",
  maxToolCalls: "most tool calls",
  maxTaskMinutes: "longest run",
  maxParallelTasks: "tasks at once",
  retryAfterMinutes: "retry after",
  pauseRetryMinutes: "retry needed-you tasks after",
  maxConsecutiveFailures: "failure limit",
};
/** Typing pauses this long before a field saves. */
const TYPING_SETTLE_MS = 700;
/** How long "Saved" stays in the save note. */
const SAVED_NOTE_MS = 1800;

const form = $<HTMLFormElement>("form");
const saveMsg = $("save-msg");
const modelSelect = $<HTMLSelectElement>("model-select");
const reasoningSelect = $<HTMLSelectElement>("f-reasoning");
const input = (key: string) => $<HTMLInputElement>(`f-${key}`);
initAiTabs();
initSidebar();
$("head-version").textContent = `v${chrome.runtime.getManifest().version}`;

let state: UiState | null = null;
let saved: ExtensionSettings | null = null;
/** The local model's server was asked for its models since the page opened. */
let localModelsAsked = false;

// The number fields take the settings schema's range.
for (const k of NUMBER_FIELDS) {
  input(k).min = String(NUMBER_RULES[k].min);
  input(k).max = String(NUMBER_RULES[k].max);
}

reasoningSelect.replaceChildren(...reasoningOptions().map((r) => h("option", { value: r.id }, r.label)));

modelSelect.replaceChildren(
  ...modelOptions().map((m) => h("option", { value: m.id }, m.label)),
  h("option", { value: CUSTOM_MODEL }, "Custom…"),
);

// ------------------------------------------------------------ form <-> settings

/** The saved source is "auto" (never picked) and no radio was clicked yet: the checked radio only shows what runs now. */
const brainUnpicked = () => saved?.brain === "auto" && !form.querySelector<HTMLInputElement>("input[name=brain][data-touched]");

function readValues(): FormValues {
  const checked = brainUnpicked() ? null : form.querySelector<HTMLInputElement>("input[name=brain]:checked")?.value;
  const brain = (checked ?? saved?.brain ?? "auto") as BrainMode;
  const out: Record<string, unknown> = { brain, reasoning: reasoningSelect.value || saved?.reasoning };
  for (const k of NUMBER_FIELDS) out[k] = input(k).value;
  for (const k of TEXT_FIELDS) out[k] = input(k).value;
  for (const k of BOOL_FIELDS) out[k] = input(k).checked;
  return out as FormValues;
}

function fillForm(s: ExtensionSettings, only?: (keyof ExtensionSettings)[]): void {
  const v = formValues(s);
  const want = (k: keyof ExtensionSettings) => !only || only.includes(k);
  if (want("brain")) for (const r of form.querySelectorAll<HTMLInputElement>("input[name=brain]")) r.checked = r.value === v.brain;
  if (want("reasoning")) reasoningSelect.value = v.reasoning;
  for (const k of NUMBER_FIELDS) if (want(k)) input(k).value = v[k];
  for (const k of TEXT_FIELDS) if (want(k)) input(k).value = v[k];
  for (const k of BOOL_FIELDS) if (want(k)) input(k).checked = v[k];
  if (want("anthropicModel")) {
    const known = [...modelSelect.options].some((o) => o.value === v.anthropicModel && o.value !== CUSTOM_MODEL);
    modelSelect.value = known ? v.anthropicModel : CUSTOM_MODEL;
  }
}

/** Show (or clear) each field's problem; returns true when every field is fine. */
function showErrors(onlyTouched = true): boolean {
  const errors = validateForm(readValues());
  let ok = true;
  for (const k of [...NUMBER_FIELDS, ...TEXT_FIELDS]) {
    const el = input(k);
    const msg = errors[k] ?? "";
    if (msg) ok = false;
    if (onlyTouched && !el.dataset.touched && msg) continue;
    el.setAttribute("aria-invalid", String(!!msg));
    $(`err-${k}`).textContent = msg;
  }
  return ok;
}

// ------------------------------------------------------------ saving

let hideTimer: ReturnType<typeof setTimeout> | undefined;

function status(text: string, tone: "ok" | "bad" | "" = "ok"): void {
  saveMsg.textContent = text;
  saveMsg.dataset.tone = tone;
  saveMsg.classList.toggle("show", !!text);
  clearTimeout(hideTimer);
  if (tone === "ok" && text) hideTimer = setTimeout(() => saveMsg.classList.remove("show"), SAVED_NOTE_MS);
}

/** Saves whatever differs from the saved settings (fields with a problem are left out). */
async function saveChanged(): Promise<boolean> {
  if (!saved) return true;
  const valid = showErrors();
  const patch = buildSettingsPatch(saved, parseForm(readValues()));
  const ok = Object.keys(patch).length ? await sendPatch(patch) : true;
  // Fields with a problem keep their saved value until fixed.
  if (ok && !valid && form.querySelector("[aria-invalid=true]")) status("Not saved: fix the field marked in red", "bad");
  return ok;
}

async function sendPatch(patch: Partial<ExtensionSettings>): Promise<boolean> {
  status("Saving…", "");
  try {
    const next = await uiRequest({ type: "settings.save", settings: patch });
    const adjusted = adjustedFields(patch, next.settings);
    applyState(next);
    if (adjusted.length) {
      fillForm(next.settings, adjusted);
      status(`Saved. Changed to the allowed range: ${adjusted.map((k) => LABELS[k] ?? k).join(", ")}`, "bad");
    } else status("Saved");
    return true;
  } catch (err) {
    status(`Not saved: ${errorMessage(err)}`, "bad");
    return false;
  }
}

const saves = new SaveQueue(saveChanged);

form.addEventListener("submit", (e) => e.preventDefault());
form.addEventListener("input", (e) => {
  const t = e.target as HTMLInputElement;
  if (!t.id?.startsWith("f-")) return;
  t.dataset.touched = "1";
  if (t.type === "checkbox") return;
  render();
  saves.schedule(TYPING_SETTLE_MS);
});
form.addEventListener("change", (e) => {
  const t = e.target as HTMLInputElement;
  if (t.name === "brain" || t.id?.startsWith("f-")) {
    t.dataset.touched = "1";
    render();
    saves.schedule();
  }
});
// Not picked yet: clicking the source already shown checked fires no change, but picks it.
form.addEventListener("click", (e) => {
  const t = e.target as HTMLInputElement;
  if (t.name !== "brain" || !brainUnpicked()) return;
  t.dataset.touched = "1";
  render();
  saves.schedule();
});
modelSelect.addEventListener("change", () => {
  const custom = input("anthropicModel");
  if (modelSelect.value === CUSTOM_MODEL) {
    render();
    custom.select();
    custom.focus();
    return;
  }
  custom.value = modelSelect.value;
  render();
  saves.schedule();
});

// ------------------------------------------------------------ keys (masked fields)

const renderSecrets = initSecretFields({ saved: () => saved, save: sendPatch });
$("maxTaskMinutes-hint").textContent = LONGEST_RUN_HINT;

// ------------------------------------------------------------ rendering

function draft(): Draft {
  const v = readValues();
  return { brain: v.brain, jevEnabled: v.jevEnabled, anthropicModel: v.anthropicModel, reasoning: v.reasoning };
}

/** Opens or closes a revealed block; closed blocks are inert (not focusable). */
function reveal(el: Element, open: boolean): void {
  el.classList.toggle("open", open);
  (el as HTMLElement).inert = !open;
}

function setTone(el: HTMLElement, tone: Tone): void {
  el.dataset.tone = tone;
}

/** Opened with a link to the helper: the helper box moves under its option on the first render, then is shown. */
let revealHelperPending = anchorFromHash(location.hash) === "helper-box";

/** Everything that depends on the settings on screen and the background's state. */
function render(): void {
  if (!state || !saved) return;
  const d = draft();
  const v = settingsView({ settings: saved, draft: d, brain: state.brain, account: state.account });

  const unpicked = brainUnpicked();
  for (const o of v.options) {
    const row = find(document, `.opt[data-brain="${o.value}"]`);
    const radio = find<HTMLInputElement>(row, "input[type=radio]");
    radio.disabled = !o.enabled;
    if (unpicked) radio.checked = o.value === v.shownBrain;
    find(row, ".opt-detail").textContent = o.detail;
    const more = row.querySelector(".reveal");
    if (more) reveal(more, v.shownBrain === o.value);
  }
  // A link to the helper (options.html#helper, the side panel's "How to update"): scrolled to once it is in place.
  if (revealHelperPending) {
    revealHelperPending = false;
    requestAnimationFrame(() => revealGroup("helper-box"));
  }

  $("hosted-out").hidden = !v.showHostedSignIn;
  $("hosted-in").hidden = !v.hosted;
  if (v.hosted) {
    $("hosted-plan").textContent = v.hosted.plan;
    $("hosted-credit").textContent = v.hosted.credit;
    setTone($("hosted-credit"), v.hosted.tone);
    const action = $<HTMLButtonElement>("hosted-action");
    action.hidden = !v.hosted.action;
    action.textContent = v.hosted.action?.label ?? "";
  }
  const problem = $("brain-problem");
  problem.hidden = !v.brainProblem;
  problem.textContent = v.brainProblem ?? "";

  $("api-key-missing").hidden = !v.apiKeyMissing;
  $("local-model-missing").hidden = !v.localModelMissing;
  // Local model shown: list its server's models once, for the model field's suggestions.
  if (v.shownBrain === "local" && !localModelsAsked) {
    localModelsAsked = true;
    findLocalModels(true).catch((err) => flash(localMsg, errorMessage(err), "bad"));
  }
  $("model-group").hidden = !v.showModel;
  const custom = modelSelect.value === CUSTOM_MODEL;
  input("anthropicModel").hidden = !custom;
  $("model-hint").textContent = v.model.hint;
  $("reasoning-hint").textContent = v.reasoningHint;
  reveal($("reasoning-raise"), v.showReasoningAutoRaise);

  $("jev-use-hint").textContent = v.jevUseHint;
  reveal($("jev-fields"), v.showJevFields);
  $("jev-key-row").hidden = !v.showJevKey;
  $("jev-source").textContent = v.jevNote ?? "";
  $("jev-test-hint").textContent = v.jevTestHint;
}

function renderState(s: UiState): void {
  state = s;
  accountSection.render(s);
  voiceSection.render(s);
  imagesSection.render(s);
  automationSection.render(s);
  memorySection.render(s);
  storageSection.render(s);
  accountMenu.render(s.account);
  const b = s.brain;

  const hs = helperStatus(b.helper, b.helperError);
  $("helper-dot").dataset.tone = hs.tone;
  $("helper-headline").textContent = hs.headline;
  $("helper-details").replaceChildren(...hs.details.map((d) => h("li", null, d)));
  $("helper-no-claude").hidden = !hs.claudeMissing;
  // Not connected for a reason: what to send a developer (our words, Chrome's, versions, and a command for the PC).
  const debugText = !b.helper && b.helperError ? helperDiagnostics({
    error: b.helperError,
    chromeError: b.helperErrorDetail ?? null,
    extensionVersion: chrome.runtime.getManifest().version,
    extensionId: chrome.runtime.id,
    userAgent: navigator.userAgent,
    at: new Date(),
    // Not onWindows/onMac: they are declared further down, after the first render may have run.
    os: /Windows/.test(navigator.userAgent) ? "windows" : /Macintosh|Mac OS X/.test(navigator.userAgent) ? "mac" : "linux",
  }) : "";
  $("helper-debug").hidden = !debugText;
  $("helper-debug-text").textContent = debugText;
  // Not connected, or an installed helper that is out of date: the install command (again) updates it.
  $("helper-install").hidden = !!b.helper && !helperNeedsInstall(b.helper);
  $("helper-connect").textContent = b.helper ? "Re-check" : "Connect";
  // Updating a connected helper: Claude Code is there already, and the button says Re-check.
  $("helper-step-claude").hidden = !!b.helper;
  $("helper-connect-name").textContent = $("helper-connect").textContent;
  for (const el of document.querySelectorAll(".helper-recheck-name")) el.textContent = $("helper-connect").textContent;
  render();
}

/** A new state from the background: new saved settings, keys re-rendered. */
/** The newest state applied (an older one that arrives late is ignored; see UiState.rev). */
let latest: UiState | null = null;

function applyState(s: UiState): void {
  if (isStale(s, latest)) return;
  latest = s;
  saved = s.settings;
  renderSecrets();
  renderState(s);
}

const accountSection = initAccountSection({ onState: (s) => renderState(s) });
initPhoneSection();
// The header's account avatar and menu (the side panel's, see ui/account-menu.ts); what fails says so in the save notice.
const accountMenu = createAccountMenu({
  id: "menu-acct",
  signedOutTitle: "Log in",
  items: [
    { id: "menu-acct-login", label: "Log in with Google", show: "signed-out", run: (b) => accountSection.signIn(b, saveMsg) },
    { id: "menu-acct-billing", label: "Plan & billing", show: "signed-in", run: () => accountSection.openBilling() },
    {
      id: "menu-acct-signout",
      label: "Sign out",
      show: "signed-in",
      tone: "bad",
      run: (b) => void busy(b, async () => applyState(await uiRequest({ type: "account.signOut" })), (m) => status(`Not signed out: ${m}`, "bad")),
    },
  ],
});
$("head-acct").replaceWith(accountMenu.el);
closeMenusOnOutsideClick("details.menu");
const voiceSection = initVoiceSection({ onState: (s) => applyState(s) });
const imagesSection = initImagesSection({ onState: (s) => applyState(s) });
const automationSection = initAutomationSection({ onState: (s) => applyState(s) });
const memorySection = initMemorySection({ onState: (s) => applyState(s) });
const storageSection = initStorageSection({ onState: (s) => applyState(s), signIn: (b, note) => accountSection.signIn(b, note) });
const hostedSignIn = $<HTMLButtonElement>("hosted-signin");
hostedSignIn.addEventListener("click", () => accountSection.signIn(hostedSignIn, $("hosted-signin-msg")));
// Get a plan / Top up under Noa AI: the dashboard's Billing page.
$("hosted-action").addEventListener("click", () => accountSection.openBilling());

// ------------------------------------------------------------ tests and helper

function testButton(id: string, type: "settings.testClaude" | "settings.testJev"): void {
  const btn = $<HTMLButtonElement>(id);
  const msg = $(`${id}-msg`);
  btn.addEventListener("click", () =>
    void busy(
      btn,
      async () => {
        flash(msg, "Testing…");
        // Test what is on screen: save pending edits first.
        if (!(await saves.flush())) return flash(msg, "Save failed; fix the settings first.", "bad");
        const res = await uiRequest({ type });
        // The result stays until the next test.
        flash(msg, res.detail || (res.ok ? "Works." : "Failed."), res.ok ? "ok" : "bad", { keep: true });
      },
      msg,
    ),
  );
}
testButton("test-claude", "settings.testClaude");

const localBtn = $<HTMLButtonElement>("test-local");
const localMsg = $("test-local-msg");
/**
 * Asks the local model's server for its models (settings.testLocalModel): they become the model field's suggestions,
 * and with none picked yet the first is picked. quiet: on its own when the section opens, saying only what is wrong.
 */
async function findLocalModels(quiet = false): Promise<void> {
  if (!quiet) flash(localMsg, "Asking the server…");
  if (!(await saves.flush())) return flash(localMsg, "Save failed; fix the settings first.", "bad");
  const res = await uiRequest({ type: "settings.testLocalModel" });
  $("local-models").replaceChildren(...res.models.map((id) => h("option", { value: id })));
  const field = input("localModel");
  if (!field.value.trim() && res.models.length) {
    field.value = res.models[0]!;
    await saveChanged();
    return flash(localMsg, `Picked ${field.value}, the first of ${res.models.length}. Choose another in the Model field if you like.`, "ok", { keep: true });
  }
  if (!quiet || !res.ok) flash(localMsg, res.detail, res.ok ? "ok" : "bad", { keep: true });
}
localBtn.addEventListener("click", () => void busy(localBtn, () => findLocalModels(), localMsg));
testButton("test-jev", "settings.testJev");

const connectBtn = $<HTMLButtonElement>("helper-connect");
const helperMsg = $("helper-msg");
function connectHelper(): void {
  void busy(
    connectBtn,
    async () => {
      flash(helperMsg, "Connecting… (the self-test can take up to a minute)");
      const s = await uiRequest({ type: "helper.connect" });
      renderState(s);
      // The headline already names the error; the message only adds what it does not say.
      const error = s.brain.helper ? "" : s.brain.helperError || "Helper not found.";
      flash(helperMsg, error === $("helper-headline").textContent ? "" : error, error ? "bad" : "");
    },
    helperMsg,
  );
}
connectBtn.addEventListener("click", () => (checkInstaller(), connectHelper()));

// Installing the helper: one command that downloads it, in Terminal on macOS and Linux (install.sh) and in
// PowerShell on Windows (install.ps1); the repo's installer only while the site does not serve the installer
// yet (a 404 in a terminal leaves people stuck, so the command shows only once the site answers for it).
const onWindows = /Windows/.test(navigator.userAgent);
const onMac = /Macintosh|Mac OS X/.test(navigator.userAgent);
const SHELL = onWindows
  ? { name: "PowerShell", open: "Open PowerShell: press the Windows key, type PowerShell, press Enter.", paste: "Ctrl+V", enter: "Enter" }
  : onMac
    ? { name: "Terminal", open: "Open Terminal: press ⌘ Space, type Terminal, press Return.", paste: "⌘ V", enter: "Return" }
    : { name: "the terminal", open: "Open a terminal.", paste: "Ctrl+Shift+V", enter: "Enter" };
$("helper-open-terminal").textContent = SHELL.open;
$("helper-app-name").textContent = SHELL.name;
$("helper-paste-key").textContent = SHELL.paste;
$("helper-enter-key").textContent = SHELL.enter;
$("helper-command").textContent = (onWindows ? helperInstallCommandWindows : helperInstallCommand)(chrome.runtime.id);
for (const el of document.querySelectorAll(".local-app-name")) el.textContent = SHELL.name;
$("local-command").textContent = localSetupCommand(chrome.runtime.id);
$("local-copy").addEventListener("click", () =>
  void navigator.clipboard.writeText($("local-command").textContent ?? "").then(
    () => flash(localMsg, `Copied. Paste it into ${SHELL.name}, press ${SHELL.enter}, then click Find models when it says it is ready.`, "ok", { keep: true }),
    () => flash(localMsg, "Could not copy; select the command and copy it by hand.", "bad"),
  ),
);
/** The install command once the site serves this version's installer; else why there is none (not served, or no site). */
function showInstallSteps(installer: "online" | "missing" | "unreachable"): void {
  const online = installer === "online";
  $("helper-step-terminal").hidden = !online;
  $("helper-step-command").hidden = !online;
  $("helper-step-back").hidden = !online;
  $("helper-step-repo").hidden = online;
  $("helper-repo-why").textContent =
    installer === "unreachable"
      ? "Could not reach noa.bot for the installer. Check your internet connection."
      : "The installer for this version of Noa is not on noa.bot yet, so there is nothing to run right now.";
}
/** Checked on load and on each Connect / Re-check. */
function checkInstaller(): void {
  void fetch(helperInstallUrl(onWindows ? "ps1" : "sh", HELPER_CODE), { method: "HEAD", cache: "no-store" }).then(
    (res) => showInstallSteps(res.ok ? "online" : "missing"),
    () => showInstallSteps("unreachable"),
  );
}
showInstallSteps("missing");
checkInstaller();
$("helper-copy").addEventListener("click", () =>
  void navigator.clipboard.writeText($("helper-command").textContent ?? "").then(
    () => {
      flash(helperMsg, `Copied. Now paste it into ${SHELL.name} and press ${SHELL.enter}.`, "ok", { keep: true });
    },
    () => flash(helperMsg, "Could not copy; select the command and copy it by hand.", "bad"),
  ),
);
$("helper-debug-copy").addEventListener("click", () =>
  void navigator.clipboard.writeText($("helper-debug-text").textContent ?? "").then(
    () => flash(helperMsg, "Copied. Send it to the developer, with what the command in it prints.", "ok", { keep: true }),
    () => flash(helperMsg, "Could not copy; select the details and copy them by hand.", "bad"),
  ),
);
window.addEventListener("focus", () => {
  // Back from the terminal: the install steps are showing, so try the helper again (an out-of-date one restarts).
  const helper = state?.brain.helper ?? null;
  if (!$("helper-install").hidden && state && (!helper || helperNeedsInstall(helper)) && !connectBtn.disabled) connectHelper();
});

async function main(): Promise<void> {
  try {
    const s = await uiRequest({ type: "state.get" });
    fillForm(s.settings);
    applyState(s);
    showErrors(false);
    // Fresh plan and credit (they may have changed on the dashboard).
    renderState(await uiRequest({ type: "account.refresh", force: true }));
  } catch (err) {
    status(`Background not reachable: ${errorMessage(err)}`, "bad");
  }
}

void main();
initVaultSection();

/**
 * Plan, credit and brain as they change while the page is open: the background pushes its state (e.g. the
 * credit after each run), and coming back to this tab reads it again (the background fetches the account when
 * its copy is old; after a dashboard page was opened, refreshOnReturn forces that). The settings form keeps
 * what is on screen; only a save or a section's action replaces it.
 */
function showBackgroundState(s: UiState): void {
  if (!isStale(s, latest)) renderState(s);
}
connectBackground((m) => m.type === "state" && showBackgroundState(m.state), () => {}, OPTIONS_PORT_NAME);
function refreshAccount(): void {
  void uiRequest({ type: "account.refresh" }).then(showBackgroundState, () => {});
}
window.addEventListener("focus", refreshAccount);
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && refreshAccount());

/** The keyboard shortcuts as Chrome assigned them (id prefix of each row), and where to change them (chrome://extensions/shortcuts). */
const SHORTCUT_ROWS: readonly [ShortcutCommand, string][] = [
  [OPEN_CHAT_COMMAND, "shortcut"],
  [VOICE_COMMAND, "voice-shortcut"],
];
async function renderShortcuts(): Promise<void> {
  for (const [command, row] of SHORTCUT_ROWS) {
    const key = await readShortcut(command);
    $(`${row}-key`).textContent = key ?? "Not set";
    $(`${row}-change`).textContent = key ? "Change" : "Set shortcut";
  }
}
for (const [, row] of SHORTCUT_ROWS) $(`${row}-change`).addEventListener("click", () => void openShortcutSettings());
window.addEventListener("focus", () => void renderShortcuts());
void renderShortcuts();
