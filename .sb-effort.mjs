import { chromium } from "@playwright/test"
const b = await chromium.launch({ channel: "chrome" })
const p = await b.newPage({ viewport: { width: 700, height: 400 } })
for (const [id, label] of [
  ["auto", "Auto"],
  ["high-effort", "HighEffort"],
  ["disabled", "Disabled"],
]) {
  const errs = []
  p.removeAllListeners("pageerror")
  p.on("pageerror", (e) => errs.push(e.message.slice(0, 80)))
  await p.goto(
    `http://localhost:6006/iframe.html?id=chat-composer-effortselector--${id}&viewMode=story`,
    { waitUntil: "domcontentloaded", timeout: 120000 }
  )
  const btn = await p
    .locator("button")
    .first()
    .waitFor({ state: "visible", timeout: 120000 })
    .then(() => true)
    .catch(() => false)
  const brain = await p.locator("svg.lucide-brain").count()
  const body = (await p.evaluate(() => document.body.innerText))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40)
  console.log(`[${label}] button=${btn} brainIcon=${brain} errs=${errs.length} text="${body}"`)
}
await b.close()
