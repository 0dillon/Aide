import { ensureWallet, getWorker } from "@/lib/store";

export const runtime = "nodejs";

// The employer screen needs the worker's real earnings account to pay into —
// that is the demo worker's own wallet (applications belong to them).
export async function GET() {
  try {
    const w = getWorker();
    const wallet = await ensureWallet(w.id);
    return Response.json({ name: w.name, accountNumber: wallet.accountNumber, bankName: wallet.bankName });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
