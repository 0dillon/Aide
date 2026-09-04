import { bmoniProvider } from "./bmoni-provider";
import { monnifyProvider } from "./monnify-provider";
import { selectedProvider, type PaymentProvider } from "./provider";

// The one place that decides who is holding the money.
//
// Monnify is the default and stays the default. Selecting BMONI is setting
// AIDE_PAYMENT_PROVIDER=bmoni; putting it back is unsetting it. Neither
// requires a deploy of different code, which is the property that makes this
// integration reversible in the way it was promised to be.

export function paymentProvider(): PaymentProvider {
  return selectedProvider() === "bmoni" ? bmoniProvider : monnifyProvider;
}

export { selectedProvider };
export type { PaymentProvider };
