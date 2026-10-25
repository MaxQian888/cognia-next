// ADR-0239 WP10 spike, extension engine: what an MV3 extension can see and
// hold. Run: node docs/research/2026-10-25-browser-submit-signal/run-extension.mjs
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { A, SCENARIOS, repoRequire, startServers } from "./fixtures.mjs"

const { chromium } = repoRequire("playwright")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ext = path.resolve(path.dirname(new URL(import.meta.url).pathname), "ext")

const server = await startServers()
const context = await chromium.launchPersistentContext(
  mkdtempSync(path.join(tmpdir(), "ext-spike-")),
  {
    channel: "chromium",
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  }
)
let [sw] = context.serviceWorkers()
if (!sw) sw = await context.waitForEvent("serviceworker")
const blocking = await sw.evaluate(() => self.blocking)

async function act(page, action) {
  switch (action.kind) {
    case "click":
      return page.click(action.target)
    case "press":
      await page.focus(action.target)
      return page.keyboard.press(action.key)
    case "synthetic-key":
      return page.$eval(
        action.target,
        (el, a) => {
          el.focus()
          for (const t of ["keydown", "keypress", "keyup"])
            el.dispatchEvent(
              new KeyboardEvent(t, {
                key: a.key,
                keyCode: 13,
                bubbles: true,
                cancelable: true,
                metaKey: !!a.meta,
                ctrlKey: !!a.meta,
              })
            )
        },
        action
      )
    case "synthetic-click":
      return page.$eval(action.target, (el) =>
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }))
      )
    case "click-frame":
      return page.frameLocator(action.frame).locator(action.target).click()
    case "select":
      return page.selectOption(action.target, action.value)
    case "fill":
      return page.fill(action.target, action.value)
  }
}

const results = []
for (const autoAttach of [false, true]) {
  for (const [id, scenario] of Object.entries(SCENARIOS)) {
    const page = await context.newPage()
    await page.goto(`${A}/fixture?s=${id}`)
    await sleep(200)
    const tabId = await sw.evaluate(
      async (url) => (await chrome.tabs.query({ url }))[0]?.id,
      page.url()
    )
    const attached = await sw.evaluate(
      async ([t, a]) => {
        self.log = []
        try {
          return await self.holdTab(t, a)
        } catch (e) {
          return "attach failed: " + e
        }
      },
      [tabId, autoAttach]
    )
    const since = Date.now()
    let actError
    await act(page, scenario.action).catch((e) => (actError = String(e).split("\n")[0]))
    await sleep(2600)
    const log = await sw.evaluate(() => self.log)
    const truth = server.log
      .filter((e) => e.at >= since && new URL(e.url, "http://x").searchParams.get("s") === id)
      .map(
        (e) => `${e.origin} ${e.method} ${new URL(e.url, "http://x").pathname} +${e.at - since}ms`
      )
    results.push({
      id,
      autoAttach,
      attached,
      truth,
      log: log.filter(
        (l) => l.includes(`s=${id}`) && !/s=\w+\d+[a-z]*\d/.test(l.replace(`s=${id}`, ""))
      ),
      ...(actError ? { actError } : {}),
    })
    await sw.evaluate((t) => self.release(t), tabId)
    await page.close()
  }
}
await context.close()
server.close()
console.log(JSON.stringify({ blocking, results }, null, 1))
