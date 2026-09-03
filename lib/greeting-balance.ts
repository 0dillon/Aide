import { formatNaira, toKobo } from "./money";

// The money line in Aide's opening breath, as a pure function so what it says
// can be asserted without standing up a route.
//
// A balance of zero used to be skipped, which made it sound exactly like a
// balance that had not come back yet. For someone who cannot glance at the
// screen those are the same event, and only one of them means "stop waiting,
// nothing arrived". Zero is now stated.
//
// null still says nothing, and that is deliberate rather than an oversight:
// the greeting only waits 2.5s for the figure so Aide can start speaking
// promptly, so null usually means "slow", not "broken". Announcing a failure
// every slow morning would worry people about something routine, and asking
// again costs one sentence.
export function balanceLine(balance: number | null): string | null {
  if (balance === null) return null;
  const kobo = toKobo(balance);
  if (kobo === 0) return `Your balance is ${formatNaira(0)} right now.`;
  return `You have ${formatNaira(kobo)} in your account, ready to withdraw.`;
}
