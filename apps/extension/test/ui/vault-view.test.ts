import { describe, expect, it } from "vitest";
import { erasedMessage, eraseQuestion, vaultPanel, WRONG_TRIES_BEFORE_PROMINENT, type ForgotStep } from "../../src/options/vault-view.js";

const NONE = { exists: false, locked: true, sites: [] };
const LOCKED = { exists: true, locked: true, sites: ["a.com", "b.com", "c.com"] };
const OPEN = { ...LOCKED, locked: false };
const ui = (wrongTries = 0, forgotStep: ForgotStep = "closed") => ({ wrongTries, forgotStep });

describe("options: site logins panel", () => {
  it("no vault yet: choose a passphrase, warned up front, nothing to forget", () => {
    expect(vaultPanel(NONE, ui())).toMatchObject({
      mode: "create",
      passPlaceholder: "Choose a passphrase",
      unlockLabel: "Set passphrase",
      createNote: true,
      forgot: "none",
    });
    // A stale "forgot" state never shows once the vault is gone (e.g. after the erase).
    expect(vaultPanel(NONE, ui(5, "confirm"))).toMatchObject({ forgot: "none", forgotStep: "closed", eraseQuestion: "" });
  });

  it("locked: unlock, with a quiet Forgot passphrase? link", () => {
    expect(vaultPanel(LOCKED, ui())).toMatchObject({
      mode: "unlock",
      passPlaceholder: "Passphrase",
      unlockLabel: "Unlock",
      createNote: false,
      forgot: "quiet",
      forgotLead: "",
      forgotStep: "closed",
    });
  });

  it(`after ${WRONG_TRIES_BEFORE_PROMINENT} wrong tries in a row the link is prominent, and says why`, () => {
    expect(WRONG_TRIES_BEFORE_PROMINENT).toBe(3);
    expect(vaultPanel(LOCKED, ui(2)).forgot).toBe("quiet");
    expect(vaultPanel(LOCKED, ui(3))).toMatchObject({ forgot: "prominent", forgotLead: "Wrong passphrase 3 times in a row." });
    expect(vaultPanel(LOCKED, ui(7)).forgotLead).toBe("Wrong passphrase 7 times in a row.");
  });

  it("forgot: explain, then confirm with the count before erasing", () => {
    expect(vaultPanel(LOCKED, ui(0, "explain"))).toMatchObject({ forgotStep: "explain", eraseLabel: "Erase saved logins", eraseQuestion: "" });
    expect(vaultPanel(LOCKED, ui(0, "confirm"))).toMatchObject({
      forgotStep: "confirm",
      eraseLabel: "Yes, erase 3 logins",
      eraseQuestion: "Erase 3 saved logins? This can't be undone.",
    });
  });

  it("unlocked: the list, no passphrase field and no forgot state", () => {
    expect(vaultPanel(OPEN, ui(4, "confirm"))).toMatchObject({ mode: "open", forgot: "none", forgotStep: "closed", createNote: false });
  });

  it("the erase question names the count", () => {
    expect(eraseQuestion(1)).toBe("Erase 1 saved login? This can't be undone.");
    expect(eraseQuestion(12)).toBe("Erase 12 saved logins? This can't be undone.");
    // A vault with a passphrase but no logins: nothing is lost but the passphrase.
    expect(eraseQuestion(0)).toBe("There are no saved logins to lose. Start over with a new passphrase?");
    expect(vaultPanel({ ...LOCKED, sites: ["a.com"] }, ui(0, "confirm")).eraseLabel).toBe("Yes, erase 1 login");
    expect(vaultPanel({ ...LOCKED, sites: [] }, ui(0, "confirm")).eraseLabel).toBe("Yes, start over");
  });

  it("after the erase: what went and what next", () => {
    expect(erasedMessage(3)).toBe("Erased 3 saved logins. Choose a new passphrase to start over.");
    expect(erasedMessage(1)).toBe("Erased 1 saved login. Choose a new passphrase to start over.");
    expect(erasedMessage(0)).toBe("Choose a new passphrase to start over.");
  });
});
