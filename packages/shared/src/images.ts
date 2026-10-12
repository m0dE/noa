/**
 * Image generation (the generate_image tool): the account server's POST IMAGES_PATH makes a picture from a text
 * description with OpenAI's image model, paid from the account's usage credit (apps/api/src/routes/ai.ts); the
 * extension saves it in the user's Noa folder (apps/extension/src/engine/image-generator.ts).
 */
import { z } from "zod";

export const IMAGES_PATH = "/v1/ai/images";

/**
 * The image models a user can pick (Settings > AI > Image generation); the server prices each (IMAGE_PRICES in
 * apps/api/src/pricing.ts). Costs are per 1024x1024 medium picture, marked up.
 */
export const ImageModelId = z.enum(["gpt-image-2", "gpt-image-1-mini"]);
export type ImageModelId = z.infer<typeof ImageModelId>;
export const IMAGE_MODELS: readonly { id: ImageModelId; label: string; description: string }[] = [
  { id: "gpt-image-2", label: "GPT Image 2", description: "Best quality, and the best at text in pictures. About 7 cents a picture." },
  { id: "gpt-image-1-mini", label: "GPT Image 1 Mini", description: "Cheaper, simpler pictures. About 2 cents a picture." },
];
export const DEFAULT_IMAGE_MODEL: ImageModelId = "gpt-image-2";

/** Sizes the image model makes (width x height). No "auto": its cost could not be bounded before the call. */
export const IMAGE_SIZES = ["1024x1024", "1536x1024", "1024x1536"] as const;
export const ImageSize = z.enum(IMAGE_SIZES);
export type ImageSize = z.infer<typeof ImageSize>;
export const DEFAULT_IMAGE_SIZE: ImageSize = "1024x1024";

/** low: a quick draft (about 1 cent); medium: good for most uses (about 7 cents); high: final art (about 30 cents, 1-2 minutes). */
export const ImageQuality = z.enum(["low", "medium", "high"]);
export type ImageQuality = z.infer<typeof ImageQuality>;
export const DEFAULT_IMAGE_QUALITY: ImageQuality = "medium";

/** Longest description accepted (the model takes more; this keeps the request's cost bound small). */
export const MAX_IMAGE_PROMPT_CHARS = 4000;

/** Body of POST IMAGES_PATH. */
export const GenerateImageRequest = z.object({
  prompt: z.string().trim().min(1).max(MAX_IMAGE_PROMPT_CHARS),
  size: ImageSize.optional(),
  quality: ImageQuality.optional(),
  /** true: a transparent background (PNG), e.g. for icons and logos. */
  transparent: z.boolean().optional(),
  /** Absent: DEFAULT_IMAGE_MODEL. */
  model: ImageModelId.optional(),
});
export type GenerateImageRequest = z.infer<typeof GenerateImageRequest>;

/** 200 of POST IMAGES_PATH. */
export const GenerateImageResponse = z.object({
  /** The picture, PNG, base64 (no data: prefix). */
  base64: z.string().min(1),
  mimeType: z.literal("image/png"),
  size: ImageSize,
  quality: ImageQuality,
  model: ImageModelId,
  /** Charged for this picture, in (fractional) cents. */
  chargedCents: z.number(),
});
export type GenerateImageResponse = z.infer<typeof GenerateImageResponse>;
