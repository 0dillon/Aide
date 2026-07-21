import { chromium, devices } from "@playwright/test";

const URL = process.env.TARGET || "https://aide-ng.vercel.app";
const OUT = process.env.OUT || "C:\\Users\\HomePC\\AppData\\Local\\Temp\\claude\\C--Users-HomePC-Downloads-monify\\45261fe3-0089-4e57-826e-92650d4942f7\\scratchpad";

const browser = await chromium.launch();
const ctx = await browser.newContext({
  ...devices["Pixel 7"],
  permissions: ["microphone"],
});
const page = await ctx.newPage();

const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[PAGEERROR] ${e.message}`));

await page.goto(URL, { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(6000);

// Does the page scroll sideways? (the classic phone layout failure)
const overflow = await page.evaluate(() => {
  const de = document.documentElement;
  const offenders = [];
  for (const el of document.querySelectorAll("*")) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && (r.right > de.clientWidth + 1 || r.left < -1)) {
      offenders.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className || "").toString().slice(0, 70),
        right: Math.round(r.right),
        text: (el.textContent || "").trim().slice(0, 40),
      });
    }
  }
  return {
    viewport: de.clientWidth,
    scrollWidth: de.scrollWidth,
    horizontalScroll: de.scrollWidth > de.clientWidth,
    offenders: offenders.slice(0, 8),
  };
});

// Touch-target audit — anything interactive under 44px fails on a phone
const smallTargets = await page.evaluate(() =>
  [...document.querySelectorAll("a,button,select,input,textarea")]
    .map((el) => {
      const r = el.getBoundingClientRect();
      return { tag: el.tagName.toLowerCase(), w: Math.round(r.width), h: Math.round(r.height), text: (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 30) };
    })
    .filter((t) => t.h > 0 && (t.h < 44 || t.w < 44)),
);

console.log("=== VIEWPORT / OVERFLOW ===");
console.log(JSON.stringify(overflow, null, 1));
console.log("\n=== TOUCH TARGETS UNDER 44px ===");
console.log(smallTargets.length ? JSON.stringify(smallTargets, null, 1) : "none");
console.log("\n=== CONSOLE ===");
console.log(logs.slice(0, 30).join("\n") || "(empty)");

await page.screenshot({ path: `${OUT}\\mobile-top.png` });
await page.evaluate(() => window.scrollTo(0, 99999));
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}\\mobile-bottom.png` });
console.log(`\nscreenshots -> ${OUT}`);

await browser.close();
