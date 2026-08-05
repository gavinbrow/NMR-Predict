import { chromium } from "playwright";
import { readFile } from "node:fs/promises";

const EX = "C:\\Projects\\Websites\\NMR Predict\\GCMS Example\\DATA.MS";
const SHOTS = "C:\\Projects\\Websites\\NMR Predict\\_work\\shots";
const URL = "http://localhost:8080/gcms";

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
const page = await ctx.newPage();

const consoleLogs = [];
const pageErrors = [];
page.on("console", (msg) => {
  const text = msg.text();
  consoleLogs.push({ type: msg.type(), text });
  if (msg.type() === "error") console.error("PAGE CONSOLE ERROR:", text);
});
page.on("pageerror", (err) => {
  pageErrors.push(err.message);
  console.error("PAGE ERROR:", err.message);
});

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(2000);

async function importFile(page) {
  const buf = await readFile(EX);
  const dt = await page.evaluateHandle((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], "DATA.MS", { type: "application/octet-stream" });
    const dt = new DataTransfer();
    dt.items.add(file);
    return dt;
  }, buf.toString("base64"));
  await page.dispatchEvent("body", "dragenter", { dataTransfer: dt });
  await page.dispatchEvent("body", "dragover", { dataTransfer: dt });
  await page.dispatchEvent("body", "drop", { dataTransfer: dt });
  await page.waitForTimeout(8000);
}

await importFile(page);

// Shift-drag a region on the chromatogram to create a second spectrum slot.
const c = page.locator(".uplot canvas").first();
const box = await c.boundingBox();
const sx = box.x + box.width * 0.45;
const ex = box.x + box.width * 0.58;
const y = box.y + box.height * 0.55;
await page.mouse.move(sx, y);
await page.mouse.down();
await page.keyboard.down("Shift");
for (let x = sx; x <= ex; x += 6) {
  await page.mouse.move(x, y);
  await page.waitForTimeout(6);
}
await page.mouse.up();
await page.keyboard.up("Shift");
await page.waitForTimeout(2500);

// Click Figure tab.
await page.getByRole("tab", { name: "Figure" }).click();
await page.waitForTimeout(500);

// Switch to Spectrum radio.
await page.locator('input[name="gcms-figure-subject"][value="spectrum"]').click();
await page.waitForTimeout(500);

// Screenshot before stacking.
const figPanel = page.locator("div").filter({ hasText: /^Spectrum slots$/ }).locator("..").first();
await page.screenshot({ path: `${SHOTS}\\gcms-spectrum-nostack.png`, fullPage: false });

// Toggle Stack spectra.
const stackSwitch = page.getByLabel("Stack spectra");
await stackSwitch.waitFor({ state: "visible" });
await stackSwitch.click();
await page.waitForTimeout(800);

await page.screenshot({ path: `${SHOTS}\\gcms-spectrum-stack.png`, fullPage: false });

console.log(JSON.stringify({ consoleLogs, pageErrors }, null, 2));
await browser.close();
