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
 *   - **Extension version.** The host's install marker records the declared
 *     version (plus the build's digest), so a manifest and Rust constant that
 *     disagree describe two different builds of one extension.
 *   - **Broker digest wiring.** The host refuses to install a broker `.vsix`
 *     without the `.sha256` the build writes beside it. If the build stops
 *     writing it, or a bundle (Tauri resources, the server image) stops
 *     shipping it, the broker silently never installs.
 *   - **Lifecycle error codes.** The host leads every failure with a code the
 *     renderer maps to a translated message. A code only one side knows shows
 *     the generic "something went wrong" instead of the actual next step.
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
  brokerProtocol: "crates/cognia-codeserver/src/broker_protocol.rs",
  extension: "sidecar/codeserver-agent-ext/src/extension.mjs",
  process: "crates/cognia-codeserver/src/process.rs",
  extManifest: "sidecar/codeserver-agent-ext/package.json",
  proxy: "crates/cognia-codeserver/src/proxy.rs",
  extBuild: "sidecar/codeserver-agent-ext/build.mjs",
  tauriConf: "src-tauri/tauri.conf.json",
  serverImage: "Dockerfile.cognia-server",
  errorCodeRs: "crates/cognia-codeserver/src/error_code.rs",
  errorCodeTs: "lib/codeserver/error-messages.ts",
}

const BROKER_VSIX = "cognia-managed-broker.vsix"

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

  // ── Broker digest: written by the build, shipped by every bundle ─────────
  if (!/\$\{vsixPath\}\.sha256/.test(sources.extBuild)) {
    problems.push(
      `${FILES.extBuild}: no longer writes ${BROKER_VSIX}.sha256 — the host refuses a broker without it`
    )
  }
  const resources = JSON.parse(sources.tauriConf)?.bundle?.resources ?? []
  const resourceList = Array.isArray(resources) ? resources : Object.keys(resources)
  for (const suffix of [BROKER_VSIX, `${BROKER_VSIX}.sha256`]) {
    if (!resourceList.some((entry) => entry.endsWith(`codeserver-agent-ext/${suffix}`))) {
      problems.push(`${FILES.tauriConf}: bundle.resources does not ship ${suffix}`)
    }
  }
  if (!sources.serverImage.includes(`codeserver-agent-ext/${BROKER_VSIX}.sha256`)) {
    problems.push(`${FILES.serverImage}: the server image does not copy ${BROKER_VSIX}.sha256`)
  }

  // ── Lifecycle error codes: Rust enum ⇄ renderer map ──────────────────────
  const rustCodes = [...sources.errorCodeRs.matchAll(/=> "(CODESERVER_[A-Z_]+)"/g)].map((m) => m[1])
  const tsBlock = /export const HOST_ERROR_CODES = \[([\s\S]*?)\] as const/.exec(
    sources.errorCodeTs
  )
  if (rustCodes.length === 0) {
    problems.push(`${FILES.errorCodeRs}: found no CODESERVER_* codes — did as_str() move?`)
  } else if (!tsBlock) {
    problems.push(`${FILES.errorCodeTs}: HOST_ERROR_CODES is missing — did the declaration move?`)
  } else {
    const tsCodes = [...tsBlock[1].matchAll(/"(CODESERVER_[A-Z_]+)"/g)].map((m) => m[1])
    for (const code of rustCodes.filter((code) => !tsCodes.includes(code))) {
      problems.push(`${FILES.errorCodeTs}: HOST_ERROR_CODES lacks ${code}, which the host reports`)
    }
    for (const code of tsCodes.filter((code) => !rustCodes.includes(code))) {
      problems.push(
        `${FILES.errorCodeTs}: HOST_ERROR_CODES lists ${code}, which the host never reports`
      )
    }
  }

  return problems
}

function main() {
  const sources = Object.fromEntries(Object.keys(FILES).map((key) => [key, read(key)]))
  const problems = auditProIdeConstants(sources)
  if (problems.length === 0) {
    process.stdout.write(
      "[audit:pro-ide-constants] OK — catalog, versions, ids and error codes agree\n"
    )
    return
  }
  process.stderr.write("[audit:pro-ide-constants] FAIL\n")
  for (const problem of problems) process.stderr.write(`  ${problem}\n`)
  process.exit(1)
}

if (process.argv[1]?.endsWith("check-pro-ide-constants.mjs")) main()
