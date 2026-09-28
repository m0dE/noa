/**
 * Microphone capture settings shared by the recorder, the capture worklet and
 * the permission page. Imports nothing, so each bundle inlines only what it uses.
 */

/** The browser's own clean-up: noise suppression, echo cancellation, gain control; mono. */
export const MIC_CONSTRAINTS: MediaTrackConstraints = {
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
  channelCount: 1,
};

/** The worklet module in dist/ (built from pcm-worklet.ts). */
export const PCM_WORKLET_FILE = "pcm-worklet.js";
/** The processor name the worklet registers. */
export const PCM_PROCESSOR = "pcm-capture";
