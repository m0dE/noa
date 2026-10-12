/** What the microphone permission page asks, and what it says. No DOM. */
import { MIC_CONSTRAINTS } from "./capture-config.js";
import type { MicPermission } from "./mic-access.js";

export type MicPageState = "asking" | "granted" | "denied" | "no-mic" | "failed";

/** Opens the microphone once (Chrome shows its prompt), releases it, and says how that went. */
export async function requestMic(getUserMedia: (c: MediaStreamConstraints) => Promise<MediaStream>): Promise<MicPageState> {
  try {
    const stream = await getUserMedia({ audio: MIC_CONSTRAINTS });
    for (const track of stream.getTracks()) track.stop();
    return "granted";
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === "NotAllowedError" || name === "SecurityError") return "denied";
    if (name === "NotFoundError" || name === "OverconstrainedError") return "no-mic";
    return "failed";
  }
}

/** The state to show on load: granted already, blocked, or about to ask. */
export function initialState(permission: MicPermission): MicPageState {
  return permission === "granted" ? "granted" : permission === "denied" ? "denied" : "asking";
}

export interface MicPageCopy {
  title: string;
  body: string;
  /** The button that asks again, when asking again can help. */
  retry: string | null;
  /** Offer to close the tab. */
  close: boolean;
}

const WHY = "Noa listens only while the voice button is on, and sends what you say to be turned into text. The audio is not stored.";

export function micPageCopy(state: MicPageState): MicPageCopy {
  switch (state) {
    case "asking":
      // Chrome's prompt is up; dismissing it lands on "denied", which offers to try again.
      return { title: "Allow the microphone", body: `Chrome will ask you now. ${WHY}`, retry: null, close: false };
    case "granted":
      return { title: "Microphone allowed", body: "You can close this tab and talk to Noa from the side panel.", retry: null, close: true };
    case "denied":
      return {
        title: "The microphone is blocked",
        body: "Chrome is blocking the microphone for Noa. Click the icon at the left of the address bar, set Microphone to Allow, then try again.",
        retry: "Try again",
        close: false,
      };
    case "no-mic":
      return { title: "No microphone found", body: "Connect a microphone, or check that another app is not using it, then try again.", retry: "Try again", close: false };
    case "failed":
      return { title: "Could not open the microphone", body: "Something went wrong opening the microphone. Try again.", retry: "Try again", close: false };
  }
}
