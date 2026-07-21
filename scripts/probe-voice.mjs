// Drives a real reply through the deployed app and records the timing of every
// speech event. Playwright can't hear the audio, but it can prove the thing
// that was actually broken: whether the speaking turn ends prematurely between
// sentences (which is what made Aide "stop and resume 20 seconds later").
import { chromium } from "@playwright/test";

const URL = process.env.TARGET || "https://aide-ng.vercel.app";
const browser = await chromium.launch();
const ctx = await browser.newContext({ permissions: ["microphone"] });
const page = await ctx.newPage();

const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5) + "s";
const events = [];

page.on("console", (m) => events.push(`${at()} [console] ${m.text()}`));
page.on("request", (r) => {
  if (r.url().includes("/api/speak")) events.push(`${at()} → TTS request`);
  if (r.url().includes("/api/agent")) events.push(`${at()} → agent request`);
});
page.on("response", (r) => {
  if (r.url().includes("/api/speak")) events.push(`${at()} ← TTS ${r.status()}`);
});

await page.goto(URL, { waitUntil: "networkidle", timeout: 60000 });

// Watch the visible status line — it mirrors the engine's speaking/listening
// state, so a mid-reply flip back to "listening" is the bug reappearing.
await page.evaluate(() => {
  window.__states = [];
  const read = () => {
    const el = [...document.querySelectorAll("p,div")].find((n) =>
      /Aide is (speaking|listening|thinking)/.test(n.textContent || ""),
    );
    const s = el?.textContent?.trim().slice(0, 45) || "(none)";
    if (window.__states.at(-1)?.s !== s) window.__states.push({ s, t: Date.now() });
  };
  setInterval(read, 120);
  read();
});

await page.waitForTimeout(1500);
// A gesture first: phones (and this browser) refuse audio until the user acts.
await page.mouse.click(200, 400);
await page.waitForTimeout(1000);

const box = page.locator("#type-to-aide");
await box.fill("what jobs do you have for me");
events.push(`${at()} >>> submitted question`);
await page.locator("button[type=submit]").click();

await page.waitForTimeout(30000);

const states = await page.evaluate(() => window.__states);
const base = states[0]?.t ?? Date.now();

console.log("=== EVENT TIMELINE ===");
console.log(events.join("\n"));
console.log("\n=== VISIBLE STATE TRANSITIONS ===");
for (const s of states) console.log(`${((s.t - base) / 1000).toFixed(1).padStart(5)}s  ${s.s}`);

await browser.close();
