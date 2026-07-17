import express from "express";
import { env } from "./env.js";
import { isValidWebhook, verifyTransaction } from "./monnify.js";

// Local webhook receiver for inbound payments.
// Expose it publicly (ngrok/localtunnel) and register the URL in
// Monnify dashboard → Developer → Webhook URLs. Then pay a reserved
// account via https://websim.sdk.monnify.com/?#/bankingapp and watch it land.
const app = express();

// Capture the RAW body — signature is computed over the exact bytes Monnify sent.
app.use(express.raw({ type: "*/*" }));

app.post("/webhook/monnify", async (req, res) => {
  const raw = req.body.toString("utf8");
  const signature = req.header("monnify-signature");

  if (!isValidWebhook(raw, signature)) {
    console.log("✗ REJECTED webhook — bad signature. Ignoring.");
    return res.status(401).send("invalid signature");
  }

  const event = JSON.parse(raw) as { eventType: string; eventData?: { transactionReference?: string } };
  console.log(`\n✓ verified webhook: ${event.eventType}`);

  // Never trust the payload's status — re-fetch server-side before acting.
  const txRef = event.eventData?.transactionReference;
  if (event.eventType === "SUCCESSFUL_TRANSACTION" && txRef) {
    const tx = await verifyTransaction(txRef);
    console.log(`   re-verified: ${tx.paymentStatus}, ₦${tx.amountPaid}`);
    if (tx.paymentStatus === "PAID") {
      console.log(`   → Aide would now say: "You've been paid ₦${tx.amountPaid}."`);
    }
  }

  res.status(200).send("ok"); // ack fast; Monnify retries on non-200
});

app.listen(env.webhookPort, () => {
  console.log(`webhook receiver on http://localhost:${env.webhookPort}/webhook/monnify`);
  console.log("expose it: npx localtunnel --port " + env.webhookPort + "  (or ngrok)");
  console.log("then register the public URL in dashboard → Developer → Webhook URLs");
});
