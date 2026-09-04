import { assertKobo } from "../money";

// The boundary where Aide's integer kobo meets BMONI's decimal strings.
//
// BMONI mixes three amount formats — decimal strings ("100.00" for NGN
// offramps), minor-unit strings ("100000000"), and plain numbers on card
// transactions. None are type-checked: every one arrives as a `string` or a
// `number`, so nothing catches a unit mistake except this file.
//
// Parsing is where the danger is. `parseFloat` is far more permissive than an
// amount of money should ever be — it takes the leading digits of "100abc",
// expands "1e3" to a thousand, and rounds "100.005" up to a kobo that does not
// exist. Each produces a plausible number Aide would then state out loud.
//
// So this fails closed. A thrown error reaches the user as "I could not check
// that just now", which is true. A silently wrong figure is Aide asserting a
// financial fact that is not so, to someone who cannot check the screen.

// Optional sign is deliberately absent: a leading "-" must not parse.
const DECIMAL = /^\d+(?:\.\d{1,2})?$/;

export function koboToDecimalString(kobo: number): string {
  assertKobo(kobo);
  if (kobo < 0) throw new Error(`Refusing to send a negative amount to BMONI: ${kobo} kobo`);
  return (kobo / 100).toFixed(2);
}

export function decimalStringToKobo(amount: string): number {
  if (typeof amount !== "string") {
    throw new Error(`Expected a decimal amount string from BMONI, got ${typeof amount}`);
  }
  // Whitespace either side is unambiguous, so it is tolerated. Nothing else is.
  const trimmed = amount.trim();
  if (!DECIMAL.test(trimmed)) {
    // Covers trailing garbage, scientific notation, empty, NaN/Infinity,
    // negatives, and — importantly — precision finer than a kobo. We cannot
    // pay a fraction of a kobo, and rounding one into existence is Aide
    // inventing money.
    throw new Error(
      `Not a usable BMONI amount: ${JSON.stringify(amount)}. ` +
        `Expected digits with at most two decimal places, e.g. "100.00".`,
    );
  }
  const [whole, fraction = ""] = trimmed.split(".");
  // Built from the digits rather than multiplied out of a float, so there is
  // no rounding step to be wrong.
  const kobo = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  assertKobo(kobo);
  return kobo;
}
