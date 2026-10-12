/**
 * Settings > AI > Image generation, what shows (images-section.ts draws it): the switch, the model picker (only while
 * on), and a note when pictures cannot be made yet (signed out: they are paid from the Noa account).
 */
import { IMAGE_MODELS, type ExtensionSettings, type ImageModelId } from "@noa/shared";
import type { AccountView } from "../ui-protocol.js";

export interface ImagesView {
  on: boolean;
  model: ImageModelId;
  options: { value: ImageModelId; label: string }[];
  /** What the picked model is good for, and about what a picture costs. */
  modelHint: string;
  /** Why the agent cannot make pictures now although it is on, or null. */
  note: string | null;
}

export function imagesView(input: { settings: Pick<ExtensionSettings, "imageGeneration" | "imageModel">; account: AccountView | undefined }): ImagesView {
  const { imageGeneration: on, imageModel: model } = input.settings;
  const picked = IMAGE_MODELS.find((m) => m.id === model) ?? IMAGE_MODELS[0]!;
  return {
    on,
    model: picked.id,
    options: IMAGE_MODELS.map((m) => ({ value: m.id, label: m.label })),
    modelHint: picked.description,
    note: on && !input.account?.signedIn ? "Sign in to your Noa account to make images: they are paid from its usage credit." : null,
  };
}
