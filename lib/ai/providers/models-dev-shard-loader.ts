import type { ModelsDevApi } from "@cognia/provider-core/providers/models-dev"

const DEFAULT_BASE_PATH = "/catalog/models-dev"
const MAX_MANIFEST_PROVIDERS = 10_000

interface ModelsDevShardManifestEntry {
  id: string
  path: string
  models: number
  bytes: number
  gzipBytes: number
  checksum: string
}

interface ModelsDevShardManifest {
  schemaVersion: number
  providers: ModelsDevShardManifestEntry[]
}

export interface ModelsDevShardLoaderOptions {
  basePath?: string
  concurrency?: number
  signal?: AbortSignal
  fetcher?: typeof fetch
}

function parseManifest(value: unknown): ModelsDevShardManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("models.dev shard manifest must be an object")
  }
  const manifest = value as Partial<ModelsDevShardManifest>
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.providers)) {
    throw new Error("models.dev shard manifest has an unsupported schema")
  }
  if (manifest.providers.length === 0 || manifest.providers.length > MAX_MANIFEST_PROVIDERS) {
    throw new Error("models.dev shard manifest has an invalid provider count")
  }
  const ids = new Set<string>()
  for (const entry of manifest.providers) {
    if (
      !entry ||
      typeof entry.id !== "string" ||
      !entry.id ||
      typeof entry.path !== "string" ||
      !/^providers\/[a-zA-Z0-9._-]+\.json$/.test(entry.path) ||
      typeof entry.checksum !== "string" ||
      !entry.checksum.startsWith("sha256:")
    ) {
      throw new Error("models.dev shard manifest contains an invalid provider entry")
    }
    if (ids.has(entry.id)) {
      throw new Error(`models.dev shard manifest contains duplicate provider "${entry.id}"`)
    }
    ids.add(entry.id)
  }
  return manifest as ModelsDevShardManifest
}

async function sha256(content: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto is unavailable; models.dev shards cannot be verified")
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(content))
  return `sha256:${[...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`
}

async function fetchJsonText(
  fetcher: typeof fetch,
  url: string,
  signal: AbortSignal | undefined
): Promise<string> {
  const response = await fetcher(url, { cache: "force-cache", signal })
  if (!response.ok) throw new Error(`models.dev bundled catalog returned HTTP ${response.status}`)
  return response.text()
}

/**
 * Load the bundled fallback in bounded batches. Shards are independently
 * checksummed before their provider map is merged, so a partial/corrupt static
 * export can never enter catalog staging.
 */
export async function loadBundledModelsDevShards(
  options: ModelsDevShardLoaderOptions = {}
): Promise<ModelsDevApi> {
  const fetcher = options.fetcher ?? fetch
  const basePath = (options.basePath ?? DEFAULT_BASE_PATH).replace(/\/+$/, "")
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 8, 32))
  const manifestResponse = await fetcher(`${basePath}/manifest.json`, {
    cache: "no-cache",
    signal: options.signal,
  })
  if (!manifestResponse.ok) {
    throw new Error(`models.dev bundled manifest returned HTTP ${manifestResponse.status}`)
  }
  const manifest = parseManifest(await manifestResponse.json())
  const result: ModelsDevApi = {}

  for (let offset = 0; offset < manifest.providers.length; offset += concurrency) {
    options.signal?.throwIfAborted()
    const batch = manifest.providers.slice(offset, offset + concurrency)
    const loaded = await Promise.all(
      batch.map(async (entry) => {
        const shardUrl = `${basePath}/${entry.path}?v=${encodeURIComponent(entry.checksum)}`
        const content = await fetchJsonText(fetcher, shardUrl, options.signal)
        if ((await sha256(content)) !== entry.checksum) {
          throw new Error(`models.dev bundled shard checksum mismatch for "${entry.id}"`)
        }
        const parsed = JSON.parse(content) as ModelsDevApi
        if (
          !parsed ||
          typeof parsed !== "object" ||
          Array.isArray(parsed) ||
          Object.keys(parsed).length !== 1 ||
          !parsed[entry.id]
        ) {
          throw new Error(`models.dev bundled shard does not match provider "${entry.id}"`)
        }
        return [entry.id, parsed[entry.id]] as const
      })
    )
    for (const [providerId, provider] of loaded) result[providerId] = provider
  }

  return result
}
