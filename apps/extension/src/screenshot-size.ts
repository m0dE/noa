/**
 * Screenshots as the model gets them: at most SCREENSHOT_MAX_WIDTH pixels
 * wide, JPEG. A window on a large or high-DPI screen is captured at its
 * device pixels (2560 px and more, 600 KB or more); the model scales images
 * down to about 1568 px anyway, so the rest is upload time and tokens.
 */
import type { Screenshot } from "@noa/shared";
import { base64ToBytes, bytesToBase64 } from "./base64.js";
import { SCREENSHOT_JPEG_QUALITY } from "./driver-common.js";

export const SCREENSHOT_MAX_WIDTH = 1280;

/** The size to scale an image of width x height to, or null when it is small enough. */
export function scaledSize(width: number, height: number, maxWidth = SCREENSHOT_MAX_WIDTH): { width: number; height: number } | null {
  if (width <= maxWidth || width <= 0) return null;
  return { width: maxWidth, height: Math.max(1, Math.round((height * maxWidth) / width)) };
}

/**
 * The screenshot scaled down to SCREENSHOT_MAX_WIDTH (JPEG at
 * SCREENSHOT_JPEG_QUALITY) when it is wider; as it is otherwise, or when the
 * browser cannot decode it here (no OffscreenCanvas).
 */
export async function shrinkScreenshot(shot: Screenshot, maxWidth = SCREENSHOT_MAX_WIDTH): Promise<Screenshot> {
  if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap !== "function") return shot;
  const bitmap = await createImageBitmap(new Blob([base64ToBytes(shot.base64)], { type: shot.mimeType }));
  try {
    const size = scaledSize(bitmap.width, bitmap.height, maxWidth);
    if (!size) return shot;
    const canvas = new OffscreenCanvas(size.width, size.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return shot;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, size.width, size.height);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: SCREENSHOT_JPEG_QUALITY / 100 });
    return { base64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())), mimeType: "image/jpeg" };
  } finally {
    bitmap.close();
  }
}
