import { ensureAccount } from "@/lib/store";

export const runtime = "nodejs";

// The employer screen needs the worker's real earnings account to pay into.
export async function GET() {
  try {
    const w = await ensureAccount();
    return Response.json({ name: w.name, accountNumber: w.accountNumber, bankName: w.bankName });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
