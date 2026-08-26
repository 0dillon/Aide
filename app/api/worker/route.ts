import { ensureWallet, getWorker } from "@/lib/store";
import { spokenProviderError } from "@/lib/monnify";

export const runtime = "nodejs";
// ensureWallet lazily provisions the reserved account: several sequential bank
// calls, which the platform default is short enough to cut off.
export const maxDuration = 30;

// The employer screen needs the worker's real earnings account to pay into —
// that is the demo worker's own wallet (applications belong to them).
export async function GET() {
  try {
    const w = getWorker();
    const wallet = await ensureWallet(w.id);
    return Response.json({ name: w.name, accountNumber: wallet.accountNumber, bankName: wallet.bankName });
  } catch (e) {
    return Response.json({ error: spokenProviderError(e) }, { status: 500 });
  }
}
