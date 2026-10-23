import { createHash } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex")

export async function checkBrowserCompanionContract(productRoot, extensionRoot) {
  const names = (await readdir(resolve(productRoot, "packages/companion-client/src"))).filter(
    (name) => /\.(?:ts|json)$/.test(name) && !name.includes(".test.")
  )
  const pairs = names.map((name) => [
    `packages/companion-client/src/${name}`,
    `vendor/companion-client/src/${name}`,
  ])
  pairs.push(["lib/browser/overlay.injected.js", "vendor/overlay/overlay.injected.js"])
  for (const [host, browser] of pairs) {
    const [actual, pinned] = await Promise.all([
      readFile(resolve(productRoot, host)),
      readFile(resolve(extensionRoot, browser)),
    ])
    if (digest(actual) !== digest(pinned))
      throw new Error(
        `Browser Companion contract drift: ${host}; refresh and test the standalone extension before updating its revision`
      )
  }
  const contract = JSON.parse(
    await readFile(
      resolve(extensionRoot, "vendor/companion-client/src/browser-agent-protocol.json"),
      "utf8"
    )
  )
  const host = await readFile(
    resolve(productRoot, "crates/cognia-companion/src/ws_browser_companion.rs"),
    "utf8"
  )
  if (!host.includes(`const AGENT_PROFILE: &str = "${contract.agentProfile}"`))
    throw new Error("Host and extension must negotiate the same safety profile")
  return pairs.length
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const extensionRoot = process.argv[process.argv.indexOf("--extension-root") + 1]
  if (!process.argv.includes("--extension-root") || !extensionRoot)
    throw new Error(
      "Pass --extension-root /path/to/cognia-browser-extension; the extension is maintained independently"
    )
  const count = await checkBrowserCompanionContract(process.cwd(), extensionRoot)
  console.log(`Host compatibility verified against ${count} pinned extension inputs`)
}
