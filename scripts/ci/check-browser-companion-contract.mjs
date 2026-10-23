import { createHash } from "node:crypto"
import { access, readFile, readdir } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex")
export const HOST_CONTRACT_INPUTS = [
  "crates/cognia-companion-security/src/device_grants.rs",
  "crates/cognia-companion-security/src/security_store.rs",
  "crates/cognia-companion/src/api.rs",
  "crates/cognia-companion/src/browser_access.rs",
  "crates/cognia-companion/src/device_lifecycle.rs",
  "crates/cognia-companion/src/server.rs",
  "crates/cognia-companion/src/ws_browser_companion.rs",
  "protocol/companion-api-routes.json",
  "protocol/companion-command-renames.json",
  "protocol/companion-commands.json",
  "protocol/companion-request-schemas.json",
  "protocol/companion-resources.json",
  "protocol/companion-response-schemas.json",
  "protocol/companion-verbs.json",
]

export async function hostContractInputs(root) {
  const inputs = new Set()
  async function walk(directory) {
    for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
      const name = `${directory}/${entry.name}`
      if (entry.isSymbolicLink()) throw new Error(`Unpinned Host source symlink: ${name}`)
      if (entry.isDirectory()) await walk(name)
      else inputs.add(name)
    }
  }
  const crates = await readdir(resolve(root, "crates"))
  for (const name of crates.filter((name) =>
    /^cognia-companion(?:-|$)|^cognia-(?:headless-contract|server)$/.test(name)
  )) {
    // Include crate-root build.rs and custom build/codegen inputs, regardless of extension.
    await walk(`crates/${name}`)
  }
  await walk("protocol")
  for (const name of [
    "Cargo.toml",
    "Cargo.lock",
    "src-tauri/Cargo.toml",
    "src-tauri/build.rs",
    "src-tauri/src/lib.rs",
    "src-tauri/src/main.rs",
    "crates/cognia-cli/assets/host-command-catalog.json",
  ]) {
    try {
      await access(resolve(root, name))
      inputs.add(name)
    } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
  }
  return [...inputs].sort()
}

async function runtimeInputs(root, directory = "") {
  const names = []
  for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
    const name = directory ? `${directory}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) throw new Error(`Unpinned client symlink: ${name}`)
    if (entry.isDirectory()) names.push(...(await runtimeInputs(root, name)))
    else if (/\.(?:ts|mts|cts|js|mjs|json)$/.test(name) && !/\.(?:test|spec)\./.test(name))
      names.push(name)
  }
  return names.sort()
}

export async function checkBrowserCompanionContract(productRoot, extensionRoot) {
  const [names, consumerNames] = await Promise.all([
    runtimeInputs(resolve(productRoot, "packages/companion-client/src")),
    runtimeInputs(resolve(extensionRoot, "vendor/companion-client/src")),
  ])
  if (!names.length || JSON.stringify(names) !== JSON.stringify(consumerNames))
    throw new Error(
      "Browser Companion client input inventory differs; additions, removals and nested inputs require a consumer refresh"
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
  // Chromium uses a deterministic Host. Freeze the actual Host wire inputs so
  // a same-profile route/auth/schema change cannot silently reuse that fixture.
  const snapshot = JSON.parse(
    await readFile(resolve(extensionRoot, "provenance/host-contract.json"), "utf8")
  )
  const hostInputs = await hostContractInputs(productRoot)
  if (!HOST_CONTRACT_INPUTS.every((name) => hostInputs.includes(name)))
    throw new Error("Required Host wire inputs are missing")
  if (
    snapshot.schemaVersion !== 1 ||
    !/^[a-f0-9]{40}$/.test(snapshot.sourceRevision ?? "") ||
    JSON.stringify(Object.keys(snapshot.files ?? {}).sort()) !== JSON.stringify(hostInputs)
  )
    throw new Error("Invalid Host wire input inventory in pinned consumer")
  for (const name of hostInputs) {
    if (digest(await readFile(resolve(productRoot, name))) !== snapshot.files[name])
      throw new Error(
        `Host wire input drift: ${name}; review Host/consumer compatibility, refresh its snapshot and update the tested pin`
      )
  }
  return pairs.length + hostInputs.length
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const extensionRoot = process.argv[process.argv.indexOf("--extension-root") + 1]
  if (!process.argv.includes("--extension-root") || !extensionRoot)
    throw new Error(
      "Pass --extension-root /path/to/cognia-browser-extension; the extension is maintained independently"
    )
  console.log(
    `Host compatibility verified against ${await checkBrowserCompanionContract(process.cwd(), extensionRoot)} pinned extension inputs`
  )
}
