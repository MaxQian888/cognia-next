/** Magpie's public gateway API; no provider keys or private database access. */
import type { ProviderModelCandidate } from "@cognia/provider-types"
import { parseProviderModelWire } from "./model-discovery"
import { proxyFetch } from "./runtime-adapters"

export const MAGPIE_APP_KEY = "magpie-cognia"
export const MAGPIE_DEFAULT_BASE_URL = "http://127.0.0.1:3425/v1"

export interface MagpieCatalog {
  baseURL: string
  version: string
  models: ProviderModelCandidate[]
}

export async function discoverMagpieModels(input: {
  baseURL?: string
  apiKey?: string
  signal?: AbortSignal
}): Promise<MagpieCatalog> {
  const url = new URL(input.baseURL?.trim() || MAGPIE_DEFAULT_BASE_URL)
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Invalid Magpie gateway URL")
  }
  const root = url.href.replace(/\/+$/, "").replace(/\/v1$/, "")
  const signal = AbortSignal.any([
    AbortSignal.timeout(8000),
    ...(input.signal ? [input.signal] : []),
  ])
  const headers = { Authorization: `Bearer ${input.apiKey?.trim() || MAGPIE_APP_KEY}` }
  const hello = await proxyFetch(`${root}/api/hello`, { headers, signal })
  if (!hello.ok) throw new Error(`Magpie gateway unavailable (${hello.status})`)
  const identity: unknown = await hello.json()
  if (
    !record(identity) ||
    identity.name !== "magpie" ||
    typeof identity.version !== "string" ||
    !identity.version
  ) {
    throw new Error("This endpoint is not a Magpie gateway")
  }
  const response = await proxyFetch(`${root}/v1/models`, { headers, signal })
  if (!response.ok) throw new Error(`Could not read Magpie models (${response.status})`)
  const catalog: unknown = await response.json()
  if (!record(catalog) || !Array.isArray(catalog.data))
    throw new Error("Invalid Magpie models list")
  const models = new Map<string, ProviderModelCandidate>()
  for (const item of catalog.data) {
    if (!record(item)) throw new Error("Invalid Magpie model")
    if (["image", "video", "embedding"].includes(String(item.kind))) continue
    const modalities = record(item.modalities) ? item.modalities : undefined
    const inputs = modalities?.input
    const outputs = modalities?.output
    if (
      outputs !== undefined &&
      (!Array.isArray(outputs) || !outputs.every((v) => typeof v === "string"))
    )
      throw new Error("Invalid Magpie output modalities")
    if (Array.isArray(outputs) && outputs.length && !outputs.includes("text")) continue
    if (
      inputs !== undefined &&
      (!Array.isArray(inputs) || !inputs.every((v) => typeof v === "string"))
    )
      throw new Error("Invalid Magpie input modalities")
    const model = parseProviderModelWire({
      ...item,
      context_length: item.context_length ?? item.context_window,
      supports_reasoning: item.reasoning,
      ...(Array.isArray(inputs)
        ? {
            supports_vision: inputs.includes("image"),
            supports_audio: inputs.includes("audio"),
            supports_video: inputs.includes("video"),
          }
        : {}),
    })
    models.set(model.id, model)
  }
  return { baseURL: `${root}/v1`, version: identity.version, models: [...models.values()] }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
