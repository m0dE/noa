/**
 * Settings > AI > Image generation: whether the agent may make pictures (generate_image) and with which model. Saves
 * by itself, like the rest of the page; images-view.ts decides what shows.
 */
import { errorMessage, type ExtensionSettings, type ImageModelId } from "@noa/shared";
import { uiRequest, type UiState } from "../ui-protocol.js";
import { $, flash, h } from "../ui/dom.js";
import { imagesView } from "./images-view.js";

export interface ImagesSection {
  render(state: UiState): void;
}

export function initImagesSection(opts: { onState(state: UiState): void }): ImagesSection {
  const on = $<HTMLInputElement>("images-on");
  const model = $<HTMLSelectElement>("images-model");
  const fields = $("images-fields");
  const note = $("images-note");
  const msg = $("images-msg");
  let filled = false;

  async function save(patch: Partial<ExtensionSettings>): Promise<void> {
    try {
      opts.onState(await uiRequest({ type: "settings.save", settings: patch }));
    } catch (err) {
      flash(msg, `Not saved: ${errorMessage(err)}`, "bad");
    }
  }

  on.addEventListener("change", () => void save({ imageGeneration: on.checked }));
  model.addEventListener("change", () => void save({ imageModel: model.value as ImageModelId }));

  return {
    render(state) {
      const v = imagesView({ settings: state.settings, account: state.account });
      if (!filled) {
        filled = true;
        model.replaceChildren(...v.options.map((o) => h("option", { value: o.value }, o.label)));
      }
      on.checked = v.on;
      model.value = v.model;
      $("images-model-hint").textContent = v.modelHint;
      fields.classList.toggle("open", v.on);
      fields.inert = !v.on;
      note.hidden = !v.note;
      note.textContent = v.note ?? "";
    },
  };
}
