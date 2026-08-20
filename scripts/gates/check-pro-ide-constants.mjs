#!/usr/bin/env node
/**
 * Keep the Pro IDE's cross-language constants in lockstep.
 *
 * Three values are duplicated across TypeScript, Rust and the extension's
 * JavaScript because none of those runtimes can import from the others. Each
 * duplicate fails *silently* when it drifts, which is exactly why they need a
 * gate rather than a convention:
 *
 *   - **Catalog hash.** The broker refuses a handshake whose `catalogHash` does
 *     not match, so a stale copy disables every managed plugin proxy with a log
 *     line nobody reads.
 *   - **Extension version.** The host skips the side-load when its install
 *     marker already records the declared version, so an extension bumped
 *     without the Rust constant never reaches a machine that has the old one.
 *   - **Broker extension id.** The proxy generator stamps it into every
 *     generated VSIX's `extensionDependencies`; a mismatch means the proxy
 *     activates before the broker it depends on.
 *
 * Usage: pnpm audit:pro-ide-constants
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

const FILES = {
  catalogJson: "packages/plugin-sdk/contract/code-1.128-ide.json",
  brokerProtocol: "src-tauri/src/codeserver/broker_protocol.rs",
  extension: "sidecar/codeserver-agent-ext/src/extension.mjs",
  process: "src-tauri/src/codeserver/process.rs",
  extManifest: "sidecar/codeserver-agent-ext/package.json",
  proxy: "src-tauri/src/codeserver/proxy.rs",
}

const read = (key) => readFileSync(join(REPO_ROOT, FILES[key]), "utf8")

/** Pull one capture group out of `source`, or record why it could not. */
function extract(problems, label, source, pattern) {
  const match = pattern.exec(source)
  if (!match) {
    problems.push(`${label}: could not find ${pattern} — did the declaration move?`)
    return null
  }
  return match[1]
}

export function auditProIdeConstants(sources) {
  const problems = []

  // ── Catalog hash: contract JSON ⇄ Rust ⇄ extension ───────────────────────
  const contract = JSON.parse(sources.catalogJson)
  const canonical = contract.catalogHash
  if (typeof canonical !== "string" || !canonical.startsWith("sha256:")) {
    problems.push(`${FILES.catalogJson}: catalogHash is missing or malformed`)
  }
  const rustHash = extract(
    problems,
    FILES.brokerProtocol,
    sources.brokerProtocol,
    /DEFAULT_CATALOG_HASH: &str =\s*"([^"]+)"/
  )
  const extHash = extract(
    problems,
    FILES.extension,
    sources.extension,
    /const IDE_CATALOG_HASH = "([^"]+)"/
  )
  if (rustHash && rustHash !== canonical) {
    problems.push(
      `${FILES.brokerProtocol}: DEFAULT_CATALOG_HASH is ${rustHash}, contract says ${canonical}`
    )
  }
  if (extHash && extHash !== canonical) {
    problems.push(`${FILES.extension}: IDE_CATALOG_HASH is ${extHash}, contract says ${canonical}`)
  }

  // ── Code API version: contract ⇄ Rust ────────────────────────────────────
  const rustApi = extract(
    problems,
    FILES.brokerProtocol,
    sources.brokerProtocol,
    /CODE_API_VERSION: &str = "([^"]+)"/
  )
  if (rustApi && rustApi !== contract.codeApiVersion) {
    problems.push(
      `${FILES.brokerProtocol}: CODE_API_VERSION is ${rustApi}, contract says ${contract.codeApiVersion}`
    )
  }

  // ── Extension version: manifest ⇄ Rust install marker ────────────────────
  const manifest = JSON.parse(sources.extManifest)
  const rustVersion = extract(
    problems,
    FILES.process,
    sources.process,
    /BROKER_EXT_VERSION: &str = "([^"]+)"/
  )
  if (rustVersion && rustVersion !== manifest.version) {
    problems.push(
      `${FILES.process}: BROKER_EXT_VERSION is ${rustVersion}, ` +
        `${FILES.extManifest} declares ${manifest.version} — bump both or the new build never installs`
    )
  }

  // ── Broker extension id: manifest ⇄ proxy generator ──────────────────────
  const expectedId = `${manifest.publisher}.${manifest.name}`
  const proxyId = extract(
    problems,
    FILES.proxy,
    sources.proxy,
    /BROKER_EXTENSION_ID: &str = "([^"]+)"/
  )
  if (proxyId && proxyId !== expectedId) {
    problems.push(
      `${FILES.proxy}: BROKER_EXTENSION_ID is ${proxyId}, the manifest declares ${expectedId}`
    )
  }

  return problems
}

function main() {
  const sources = Object.fromEntries(Object.keys(FILES).map((key) => [key, read(key)]))
  const problems = auditProIdeConstants(sources)
  if (problems.length === 0) {
    process.stdout.write("[audit:pro-ide-constants] OK — catalog, versions and ids agree\n")
    return
  }
  process.stderr.write("[audit:pro-ide-constants] FAIL\n")
  for (const problem of problems) process.stderr.write(`  ${problem}\n`)
  process.exit(1)
}

if (process.argv[1]?.endsWith("check-pro-ide-constants.mjs")) main()
