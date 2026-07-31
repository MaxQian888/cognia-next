// Downloads the models.dev catalog (https://models.dev/api.json) and emits:
//   - a small manifest,
//   - a compact search index,
//   - one full-data shard per provider,
//   - a tiny synchronous capability index for CLI/send-path guards.
//
// Normalization (models.dev -> our ModelConfig) deliberately stays in TypeScript
// (lib/ai/providers/models-dev.ts) so there is a single source of truth — this
// script only fetches the raw payload.
//
// Usage: pnpm sync:models-dev

import { createHash } from "node:crypto"
import { gzipSync } from "node:zlib"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const API_URL = "https://models.dev/api.json"
const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, "../..")
const CATALOG_DIR = resolve(ROOT, "public/catalog/models-dev")
const SHARD_DIR = resolve(CATALOG_DIR, "providers")
const MANIFEST_PATH = resolve(CATALOG_DIR, "manifest.json")
const SEARCH_INDEX_PATH = resolve(CATALOG_DIR, "search-index.json")
const CAPABILITIES_PATH = resolve(ROOT, "lib/ai/providers/models-dev-capabilities.json")
const MAX_SUMMARY_GZIP_BYTES = 300 * 1024
const MAX_SHARD_GZIP_BYTES = 200 * 1024

function serialize(value) {
  return JSON.stringify(value) + "\n"
}

function checksum(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`
}

function shardName(providerId) {
  return `${providerId.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`
}

function assertGzipBudget(label, content, maxBytes) {
  const bytes = gzipSync(content).byteLength
  if (bytes > maxBytes) {
    throw new Error(`${label} exceeds gzip budget (${bytes} > ${maxBytes} bytes)`)
  }
  return bytes
}

async function main() {
  const inputIndex = process.argv.indexOf("--input")
  const revisionIndex = process.argv.indexOf("--revision")
  const inputPath =
    inputIndex >= 0 && process.argv[inputIndex + 1]
      ? resolve(process.cwd(), process.argv[inputIndex + 1])
      : undefined
  const upstreamRevision =
    revisionIndex >= 0 && process.argv[revisionIndex + 1]
      ? process.argv[revisionIndex + 1]
      : undefined
  let json
  if (inputPath) {
    process.stdout.write(`Reading ${inputPath} ...\n`)
    json = JSON.parse(await readFile(inputPath, "utf8"))
  } else {
    process.stdout.write(`Fetching ${API_URL} ...\n`)
    const res = await fetch(API_URL, { headers: { accept: "application/json" } })
    if (!res.ok) {
      throw new Error(`models.dev returned HTTP ${res.status} ${res.statusText}`)
    }
    json = await res.json()
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("models.dev payload is not a provider map object")
  }

  const providerCount = Object.keys(json).length
  let modelCount = 0
  for (const provider of Object.values(json)) {
    if (provider && typeof provider === "object" && provider.models) {
      modelCount += Object.keys(provider.models).length
    }
  }
  if (providerCount === 0 || modelCount === 0) {
    throw new Error(
      `models.dev payload looks empty (providers=${providerCount}, models=${modelCount})`
    )
  }

  await rm(SHARD_DIR, { recursive: true, force: true })
  await mkdir(SHARD_DIR, { recursive: true })

  const manifestProviders = []
  const searchIndex = []
  const capabilities = {}
  const usedShardNames = new Set()
  for (const [providerId, provider] of Object.entries(json).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const filename = shardName(providerId)
    if (usedShardNames.has(filename)) {
      throw new Error(`provider shard filename collision for "${providerId}"`)
    }
    usedShardNames.add(filename)
    const content = serialize({ [providerId]: provider })
    const gzipBytes = assertGzipBudget(
      `provider shard "${providerId}"`,
      content,
      MAX_SHARD_GZIP_BYTES
    )
    await writeFile(resolve(SHARD_DIR, filename), content, "utf8")

    const providerCapabilities = {}
    for (const [modelId, model] of Object.entries(provider.models ?? {})) {
      searchIndex.push([
        providerId,
        modelId,
        model.name ?? "",
        model.family ?? "",
        model.status ?? "",
      ])
      providerCapabilities[modelId] = {
        ...(typeof model.reasoning === "boolean" ? { r: model.reasoning } : {}),
        ...(Array.isArray(model.modalities?.input) ? { i: model.modalities.input } : {}),
      }
    }
    capabilities[providerId] = providerCapabilities
    manifestProviders.push({
      id: providerId,
      path: `providers/${filename}`,
      models: Object.keys(provider.models ?? {}).length,
      bytes: Buffer.byteLength(content),
      gzipBytes,
      checksum: checksum(content),
    })
  }

  const searchContent = serialize(searchIndex)
  const searchGzipBytes = assertGzipBudget(
    "models.dev search index",
    searchContent,
    MAX_SUMMARY_GZIP_BYTES
  )
  await writeFile(SEARCH_INDEX_PATH, searchContent, "utf8")
  await writeFile(CAPABILITIES_PATH, serialize(capabilities), "utf8")

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: API_URL,
    ...(upstreamRevision ? { upstreamRevision } : {}),
    providers: manifestProviders,
    stats: {
      providers: providerCount,
      models: modelCount,
      searchIndexGzipBytes: searchGzipBytes,
    },
  }
  await writeFile(MANIFEST_PATH, serialize(manifest), "utf8")
  process.stdout.write(
    `Wrote ${MANIFEST_PATH}\n` +
      `  providers: ${providerCount}\n` +
      `  models: ${modelCount}\n` +
      `  search index gzip: ${searchGzipBytes} bytes\n`
  )
}

main().catch((err) => {
  process.stderr.write(`sync-models-dev failed: ${err?.message ?? err}\n`)
  process.exitCode = 1
})
