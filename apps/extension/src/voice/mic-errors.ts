/**
 * Why the microphone did not open, in plain words with what to do. getUserMedia's own messages ("Requested device not
 * found", "Could not start audio source") never say it is the microphone, nor what fixes it.
 */

export type MicFailureKind = "no-mic" | "blocked" | "system-blocked" | "busy" | "failed";

export class MicError extends Error {
  constructor(
    readonly kind: MicFailureKind,
    message: string,
    /** getUserMedia's own error name and message, for traces. */
    readonly detail: string,
  ) {
    super(message);
    this.name = "MicError";
  }
}

const TEXT: Record<MicFailureKind, string> = {
  "no-mic": "No microphone found. Plug one in, or check it is on and chosen as the input in your computer's sound settings, then try again.",
  blocked: "Chrome is blocking the microphone for Noa. Click the icon at the left of the address bar, set Microphone to Allow, then try again.",
  "system-blocked": "Your computer is not letting Chrome use the microphone. Allow Chrome in your system's microphone privacy settings, then try again.",
  busy: "The microphone could not start: another app may be using it. Close that app, then try again.",
  failed: "The microphone could not open. Try again.",
};

/** A getUserMedia rejection as a MicError (by its DOMException name). */
export function micError(err: unknown): MicError {
  if (err instanceof MicError) return err;
  const name = String((err as { name?: unknown })?.name ?? "");
  const message = String((err as { message?: unknown })?.message ?? err);
  const kind: MicFailureKind =
    name === "NotFoundError" || name === "OverconstrainedError"
      ? "no-mic"
      : name === "NotAllowedError" || name === "SecurityError"
        ? // Chrome says "Permission denied by system" when the OS, not Chrome, blocks it.
          /system/i.test(message)
          ? "system-blocked"
          : "blocked"
        : name === "NotReadableError" || name === "AbortError"
          ? "busy"
          : "failed";
  return new MicError(kind, TEXT[kind], `${name || "Error"}: ${message}`);
}
