// ADR-0239 WP10 spike: does an MV3 webRequest listener with ["blocking"]
// (and the webRequestBlocking permission) cancel a request when the
// extension is not installed by policy? Run: node docs/research/2026-10-25-browser-submit-signal/run-block.mjs
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { A, repoRequire, startServers } from "./fixtures.mjs"
const { chromium } = repoRequire("playwright")
const ext = path.resolve(path.dirname(new URL(import.meta.url).pathname), "ext-block")
const server = await startServers()
const context = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), "blk-")), {
  channel: "chromium",
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
})
let [sw] = context.serviceWorkers()
if (!sw) sw = await context.waitForEvent("serviceworker")
const page = await context.newPage()
await page.goto(`${A}/fixture?s=s3`)
const since = Date.now()
const fetched = await page.evaluate(() =>
  fetch("/api?s=s3", { method: "POST", body: "x" }).then(
    () => "ok",
    (e) => "rejected: " + e
  )
)
await new Promise((r) => setTimeout(r, 800))
const state = await sw.evaluate(() => ({
  added: self.added,
  errors: self.errors,
  lastError: chrome.runtime.lastError?.message ?? null,
}))
console.log(
  JSON.stringify(
    {
      state,
      fetched,
      reachedServer: server.log.filter((e) => e.at >= since && e.url.includes("s=s3")).length,
    },
    null,
    1
  )
)
await context.close()
server.close()
