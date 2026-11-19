// What a press of Enter does in the reply box (ADR 0157, which changes one sentence of ADR 0057).
//
// An ordinary Claude or Codex message in the local reply box can send from either keyboard.
// For other replies, each press has to show that it came from a physical keyboard before
// the device's Enter sends setting applies.
//
// A GUESS NEVER CHANGES THE SETTING. With no effective choice, a press from a real keyboard earns
// the person one offer of the switch (`hint`). The key still adds a line.
//
// Pure on purpose: no React and no DOM types, so the table test can read every row.

/** The facts of one keydown the rule reads. A DOM `KeyboardEvent` has all of them. */
export interface EnterKeyFacts {
  readonly key: string;
  /** The physical key. An on-screen keyboard usually leaves it empty; a hardware one says "Enter" or "NumpadEnter". */
  readonly code: string;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  /** True while an input method (IME) composition is open. Its confirming Enter must never send. */
  readonly isComposing: boolean;
  /** 229 means "an input method handled this key". Some browsers report it without `isComposing`. */
  readonly keyCode: number;
  readonly repeat: boolean;
}

/**
 * - `send`: send the message (the caller stops the key and sends).
 * - `swallow`: do nothing and add no new line. A held Enter repeats; the first press sent, and the
 *   repeats must not type new lines into the box that the send just emptied.
 * - `hint`: the person has not chosen and this press looks like a real keyboard's. The key still adds
 *   its new line (the caller leaves it to the browser) and the caller offers the switch once.
 * - `default`: leave the key to the browser (a new line).
 */
export type EnterAnswer = "send" | "swallow" | "hint" | "default";

/** The person's stored choice: `on`, `off`, or `null` when they never chose. */
export type EnterChoice = "on" | "off" | null;

/** The key codes a hardware Enter reports. */
const HARDWARE_ENTER_CODES: ReadonlySet<string> = new Set(["Enter", "NumpadEnter"]);

/** The key code an input method uses for a key it handled (`VK_PROCESSKEY`). */
const IME_KEY_CODE = 229;

/**
 * What a keydown does. `softKeyboardUp` is the app's own height test (hooks/use-keyboard.ts) and
 * `choice` is the per-device setting (lib/enter-sends-store.ts). The terminal reply box opts
 * ordinary messages on direct profiles into Enter from either keyboard.
 */
export function enterKeyAnswer(
  facts: EnterKeyFacts,
  softKeyboardUp: boolean,
  choice: EnterChoice,
  directMessage = false,
): EnterAnswer {
  if (facts.key !== "Enter") return "default";
  const effectiveChoice = facts.ctrlKey || facts.metaKey
    ? "on"
    : bareEnterChoice(facts, softKeyboardUp, choice, directMessage);
  // A repeat cannot confirm a line that asks for a second press.
  if (effectiveChoice === "on") return facts.repeat ? "swallow" : "send";
  if (effectiveChoice === "off" || facts.repeat) return "default";
  return "hint";
}

/**
 * The setting that applies to a bare Enter. The device setting guards Safari's composition-confirming
 * Enter, which may report only keyCode 229. An on-screen key may fill in code, so the setting also
 * checks whether the on-screen keyboard is up.
 */
function bareEnterChoice(
  facts: EnterKeyFacts,
  softKeyboardUp: boolean,
  choice: EnterChoice,
  directMessage: boolean,
): EnterChoice {
  if (facts.shiftKey || facts.isComposing) return "off";
  if (directMessage) return "on";
  if (facts.altKey || facts.keyCode === IME_KEY_CODE) return "off";
  return HARDWARE_ENTER_CODES.has(facts.code) && !softKeyboardUp ? choice : "off";
}
