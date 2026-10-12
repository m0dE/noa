// Speech-like test audio for voice input, as 16 kHz mono 16-bit WAV (Chrome's fake microphone
// plays it in a loop with --use-file-for-fake-audio-capture). Not speech: a 180 Hz voice with a
// harmonic, shaped into syllables (4 per second), talking until a short pause, then again, then a
// faint hiss. The extension's speech detector hears it as speech; a real model would not transcribe it.
import { writeFileSync } from "node:fs";

const RATE = 16_000;

/** The WAV bytes: `seconds` long, talking during `talk` ([from, to] seconds). */
export function speechLikeWav({ seconds = 8, talk = [[0, 2.8], [3.4, 6.5]] } = {}) {
  const n = Math.round(RATE * seconds);
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const talking = talk.some(([a, b]) => t >= a && t < b) ? Math.abs(Math.sin(Math.PI * 4 * t)) ** 0.6 : 0;
    const voice = Math.sin(2 * Math.PI * 180 * t) + 0.5 * Math.sin(4 * Math.PI * 180 * t);
    const v = 0.15 * talking * voice + 0.001 * Math.sin(i * 12.9898);
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** Writes speechLikeWav() to `file` and returns the path. */
export function writeSpeechLikeWav(file, opts) {
  writeFileSync(file, speechLikeWav(opts));
  return file;
}

/**
 * Chrome profile preferences with the microphone allowed for an extension, stored as
 * Chrome stores the user's click on Allow (write to <profile>/Default/Preferences before launch).
 */
export function micAllowedPreferences(extensionId) {
  const exceptions = { media_stream_mic: { [`chrome-extension://${extensionId}/,*`]: { last_modified: "0", setting: 1 } } };
  return { profile: { content_settings: { exceptions } } };
}
