// Screenshot each theme frame in preview-out/themes.html → preview-out/*.png
import { chromium } from "@playwright/test"
import { mkdirSync } from "node:fs"

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
await page.goto(`file://${process.cwd()}/preview-out/themes.html`)
await page.waitForTimeout(300)
mkdirSync("preview-out/shots", { recursive: true })
const frames = await page.$$("[data-theme]")
for (const f of frames) {
  const name = await f.getAttribute("data-theme")
  await f.screenshot({ path: `preview-out/shots/${name}.png` })
}
await browser.close()
console.log(`shot ${frames.length} frames`)
