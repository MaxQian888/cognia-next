#!/usr/bin/env node

import { createHash } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const CATALOG_URL = new URL("../../test-fixtures/pet/live2d-public-corpus.json", import.meta.url)

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function isAsset(value) {
  return (
    value &&
    typeof value.path === "string" &&
    !value.path.startsWith("/") &&
    !value.path.split("/").includes("..") &&
    /^[0-9a-f]{64}$/.test(value.sha256) &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes > 0
  )
}

/** Validate the committed catalog before it is trusted as a download plan. */
export function validateCorpusCatalog(catalog) {
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
    throw new Error("Invalid Live2D corpus catalog")
  }
  let files = 0
  const models = Object.entries(catalog)
  if (models.length === 0) throw new Error("Live2D corpus catalog is empty")
  for (const [id, model] of models) {
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`Invalid corpus model id: ${id}`)
    if (!model || !/^[0-9a-f]{40}$/.test(model.revision)) {
      throw new Error(`Invalid corpus revision: ${id}`)
    }
    if (typeof model.baseUrl !== "string" || !model.baseUrl.includes(model.revision)) {
      throw new Error(`Corpus URL is not revision-pinned: ${id}`)
    }
    if (!Array.isArray(model.files) || model.files.length === 0 || !model.files.every(isAsset)) {
      throw new Error(`Invalid corpus files: ${id}`)
    }
    files += model.files.length
  }
  return { models: models.length, files }
}

async function readVerified(path, asset) {
  try {
    const bytes = await readFile(path)
    return bytes.byteLength === asset.bytes && sha256(bytes) === asset.sha256 ? bytes : null
  } catch (error) {
    if (error && error.code === "ENOENT") return null
    throw error
  }
}

/** Fetch one pinned asset into a deterministic model/path cache location. */
export async function fetchCorpusFile({ modelId, baseUrl, asset, cacheDir, fetchImpl = fetch }) {
  if (!/^[a-z0-9-]+$/.test(modelId) || !isAsset(asset)) {
    throw new Error("Invalid Live2D corpus asset request")
  }
  const output = join(cacheDir, modelId, ...asset.path.split("/"))
  if (await readVerified(output, asset)) return output

  const response = await fetchImpl(new URL(asset.path, baseUrl))
  if (!response.ok) throw new Error(`Live2D corpus download failed: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.byteLength !== asset.bytes || sha256(bytes) !== asset.sha256) {
    throw new Error(`Live2D corpus integrity mismatch: ${modelId}/${asset.path}`)
  }

  await mkdir(dirname(output), { recursive: true })
  const temporary = `${output}.${process.pid}.tmp`
  try {
    await writeFile(temporary, bytes)
    await rename(temporary, output)
  } finally {
    await rm(temporary, { force: true })
  }
  return output
}

export async function fetchLive2dCorpus({
  catalogPath = CATALOG_URL,
  cacheDir = join(process.cwd(), ".cache", "pet-model-corpus"),
  fetchImpl = fetch,
} = {}) {
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"))
  validateCorpusCatalog(catalog)
  const outputs = []
  for (const [modelId, model] of Object.entries(catalog)) {
    for (const asset of model.files) {
      outputs.push(
        await fetchCorpusFile({ modelId, baseUrl: model.baseUrl, asset, cacheDir, fetchImpl })
      )
    }
  }
  return outputs
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const outputs = await fetchLive2dCorpus()
  process.stdout.write(`Verified ${outputs.length} Live2D corpus files.\n`)
}
