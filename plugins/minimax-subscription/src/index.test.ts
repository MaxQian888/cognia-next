import { readFileSync } from "node:fs"
import { join } from "node:path"
import { validatePluginManifest } from "@cognia/plugin-sdk/manifest"
import type { PluginManifest } from "@cognia/plugin-sdk"

const readManifest = () =>
  JSON.parse(readFileSync(join(__dirname, "../plugin.json"), "utf8")) as PluginManifest

test("the installable manifest validates and isolates subscription accounts", () => {
  const manifest = readManifest()
  const result = validatePluginManifest(manifest, { governanceMode: "warn" })
  expect(result.errors).toEqual([])
  expect(result.warnings).toEqual([])
  expect(manifest.capabilities).toEqual(["subscription-provider"])
  expect(manifest.permissions).toEqual([])
  expect(manifest.subscriptionProviders).toHaveLength(4)
  expect(new Set(manifest.subscriptionProviders?.map((provider) => provider.id)).size).toBe(4)
  for (const provider of manifest.subscriptionProviders ?? []) {
    expect(provider.billingMode).toBe("subscription")
    expect(provider.brandId).toBe("minimax")
    expect(provider.relatedProviderIds).toEqual(["minimax"])
    expect(provider.usage?.request.method).toBe("GET")
    expect(provider.usage?.request.path).not.toMatch(/\{\{|https?:|\?/)
    expect(provider).not.toHaveProperty("apiKey")
    expect(provider).not.toHaveProperty("headers")
  }
  expect(manifest.runtimeCompatibility?.browser?.availability).toBe("blocked")
  expect(manifest.runtimeCompatibility?.mobile?.availability).toBe("blocked")
  expect(manifest.runtimeCompatibility?.tauri?.availability).toBe("supported")
})

test("the module exactly matches the install manifest and delegates lifecycle to the host", async () => {
  const plugin = await import("./index")
  expect(plugin.manifest).toEqual(readManifest())
  expect(plugin.default.manifest).toEqual(readManifest())
  await expect(Promise.resolve(plugin.default.activate({} as never))).resolves.toBeUndefined()
})

test("published endpoints and fallback models stay isolated from standard API entries", () => {
  const providers = readManifest().subscriptionProviders!
  expect(providers.map((provider) => provider.baseUrl)).toEqual([
    "https://api.minimax.cn/v1",
    "https://api.minimax.cn/anthropic",
    "https://api.minimax.io/v1",
    "https://api.minimax.io/anthropic",
  ])
  for (const provider of providers) {
    expect(provider.models.map((model) => (typeof model === "string" ? model : model.id))).toEqual([
      "MiniMax-M3.1-Flash-Preview",
    ])
    expect(provider.protocol === "openai" ? provider.apiFlavor : undefined).toBe(
      provider.protocol === "openai" ? "chat" : undefined
    )
    expect(provider.modelApi).toBeUndefined()
  }
})
