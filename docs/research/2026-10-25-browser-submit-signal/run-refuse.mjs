// ADR-0239 WP10 spike: how a held submission can be refused without leaving
// the agent on an error page: abort versus an empty 204, for a form POST, a
// select that submits, and a fetch. Run: node docs/research/2026-10-25-browser-submit-signal/run-refuse.mjs
import { A, repoRequire, startServers } from "./fixtures.mjs"
const pw = repoRequire("playwright")
const server = await startServers()
const out = {}
for (const engine of ["chromium", "webkit"]) {
  const browser = await pw[engine].launch()
  for (const [id, how] of [
    ["s1", "fulfill204"],
    ["s1", "abort"],
    ["s3", "abort"],
    ["s20", "fulfill204"],
  ]) {
    const context = await browser.newContext()
    await context.route("**/*", (route) => {
      const r = route.request()
      if (r.method() === "GET") return route.continue()
      return how === "abort"
        ? route.abort("blockedbyclient")
        : route.fulfill({ status: 204, body: "" })
    })
    const page = await context.newPage()
    const errors = []
    page.on("pageerror", (e) => errors.push(String(e)))
    await page.goto(`${A}/fixture?s=${id}`)
    const fetchResult =
      id === "s3"
        ? page.evaluate(
            () =>
              new Promise((r) => {
                const of = fetch
                window.fetch = (...a) =>
                  of(...a).then(
                    () => r("resolved"),
                    (e) => r("rejected " + e.name)
                  )
              })
          )
        : null
    if (id === "s20") await page.selectOption("#t", "b")
    else await page.click("#t")
    await new Promise((r) => setTimeout(r, 800))
    out[`${engine} ${id} ${how}`] = {
      url: page.url().replace(/^https?:\/\/[^/]+/, ""),
      stillHasTarget: await page
        .$("#t")
        .then(Boolean)
        .catch(() => false),
      ...(fetchResult
        ? {
            fetch: await Promise.race([
              fetchResult,
              new Promise((r) => setTimeout(() => r("pending"), 200)),
            ]),
          }
        : {}),
    }
    await context.close()
  }
  await browser.close()
}
server.close()
console.log(JSON.stringify(out, null, 1))
