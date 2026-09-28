/** The signed-in user's picture, or their initial when there is none (or it does not load). */
import { initialOf } from "@noa/shared";

export interface AvatarUser {
  name?: string | null;
  email: string;
  pictureUrl?: string | null;
}

/** Fills an avatar made of an <img> and a letter element; null (signed out) empties both. */
export function showAvatar(img: HTMLImageElement, letter: HTMLElement, user: AvatarUser | null): void {
  const initial = user ? initialOf(user) : "";
  const showInitial = () => {
    img.hidden = true;
    letter.textContent = initial;
  };
  img.onerror = showInitial;
  const url = user?.pictureUrl;
  if (!url) return showInitial();
  if (img.getAttribute("src") !== url) img.src = url;
  // The same picture already failed to load: no new error event comes.
  else if (img.complete && !img.naturalWidth) return showInitial();
  img.hidden = false;
  letter.textContent = "";
}
