/** Entry of mic-permission.html: asks for the microphone and says how it went. */
import { micPermission } from "./mic-access.js";
import { initialState, micPageCopy, requestMic, type MicPageState } from "./mic-page.js";

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const title = byId<HTMLHeadingElement>("mic-title");
const body = byId<HTMLParagraphElement>("mic-body");
const retry = byId<HTMLButtonElement>("mic-retry");
const close = byId<HTMLButtonElement>("mic-close");

function show(state: MicPageState): void {
  const copy = micPageCopy(state);
  document.body.dataset.state = state;
  title.textContent = copy.title;
  body.textContent = copy.body;
  retry.hidden = !copy.retry;
  retry.textContent = copy.retry ?? "";
  close.hidden = !copy.close;
}

async function ask(): Promise<void> {
  show("asking");
  show(await requestMic((c) => navigator.mediaDevices.getUserMedia(c)));
}

retry.addEventListener("click", () => void ask());
close.addEventListener("click", () => {
  void chrome.tabs.getCurrent().then((tab) => (tab?.id !== undefined ? chrome.tabs.remove(tab.id) : window.close()));
});

const state = initialState(await micPermission());
if (state === "asking") void ask();
else show(state);
