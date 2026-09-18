import { readFileSync } from "node:fs"
import { join } from "node:path"
import { validatePluginManifest } from "@cognia/plugin-sdk/manifest"
import type { PluginManifest } from "@cognia/plugin-sdk"
import { OVERLAY_REGISTRY_CAPABILITIES } from "@/lib/plugin/contracts/capability-bridge-map"
import { getSubscriptionProvider } from "@/lib/subscription/core/provider-registry"
import { getProviderConfig, getAllProviders } from "@cognia/provider-types/provider"
import { collectModelOptions } from "@/lib/ai/model-options"
import { evaluatePluginCompatibility } from "@/lib/plugin/core/compatibility"
import { version as hostVersion } from "../../../package.json"

const readManifest = () =>
  JSON.parse(readFileSync(join(__dirname, "../plugin.json"), "utf8")) as PluginManifest
const bridge = OVERLAY_REGISTRY_CAPABILITIES["subscription-provider"]
const pluginId = "cognia-kimi-subscription"
const providerId = `${pluginId}:kimi-code`

afterEach(() => bridge.unregisterAllByPlugin(pluginId))

test("the shipped manifest passes the installer validator without warnings", () => {
  const result = validatePluginManifest(readManifest(), { governanceMode: "warn" })
  expect(result.errors).toEqual([])
  expect(result.warnings).toEqual([])
  expect(result.valid).toBe(true)
})

test("the shipped manifest is compatible with the actual host version", () => {
  expect(evaluatePluginCompatibility(readManifest(), { cogniaVersion: hostVersion })).toEqual({
    compatible: true,
    diagnostics: [],
  })
})

test("the example uses the subscription endpoint, stable default, and no secret permissions", () => {
  const manifest = readManifest()
  expect(manifest.capabilities).toEqual(["subscription-provider"])
  expect(manifest.permissions).toEqual([])
  expect(manifest.subscriptionProviders).toHaveLength(2)
  expect(manifest.subscriptionProviders?.[0]).toMatchObject({
    id: "kimi-code",
    protocol: "openai",
    apiFlavor: "chat",
    modelApi: { list: true, retrieve: false },
    baseUrl: "https://api.kimi.com/coding/v1",
    apiKeyUrl: "https://www.kimi.com/code/console",
    usageUrl: "https://www.kimi.com/code/console",
  })
  expect(
    manifest.subscriptionProviders?.[0].models.map((model) =>
      typeof model === "string" ? model : model.id
    )
  ).toEqual(["kimi-for-coding", "k3-256k", "k3", "kimi-for-coding-highspeed"])
  expect(manifest.subscriptionProviders?.[0]).not.toHaveProperty("headers")
  expect(manifest.subscriptionProviders?.[0]).not.toHaveProperty("apiKey")
  expect(manifest.subscriptionProviders?.[1]).toMatchObject({
    id: "kimi-code-anthropic",
    protocol: "anthropic",
    baseUrl: "https://api.kimi.com/coding/",
    modelApi: { list: true, retrieve: false },
    models: manifest.subscriptionProviders?.[0].models,
  })
})

test("enable and disable use the host bridge and update account setup and model pickers", () => {
  const manifest = readManifest()
  const settings = { [providerId]: { providerId, enabled: true, defaultModel: "kimi-for-coding" } }
  expect(getSubscriptionProvider(providerId)).toBeUndefined()
  // Same widening the dispatch loop applies: it can only prove `id` is present.
  const entries: ReadonlyArray<{ id: string }> = manifest.subscriptionProviders ?? []
  for (const entry of entries) bridge.registerEntry(entry, { pluginId })
  expect(getSubscriptionProvider(providerId)).toMatchObject({
    name: "Kimi Code",
    source: "plugin",
    authMode: "api-key",
  })
  expect(getAllProviders()[providerId]).toMatchObject({
    defaultModel: "kimi-for-coding",
    defaultBaseURL: "https://api.kimi.com/coding/v1",
  })
  expect(collectModelOptions(settings, []).some((option) => option.providerId === providerId)).toBe(
    true
  )
  expect(getAllProviders()[providerId].models[0]).toMatchObject({
    contextLength: 1048576,
    supportsVision: true,
    supportsReasoning: true,
  })
  expect(getAllProviders()[`${pluginId}:kimi-code-anthropic`].protocol).toBe("anthropic")
  expect(bridge.unregisterAllByPlugin(pluginId)).toBe(2)
  expect(getSubscriptionProvider(providerId)).toBeUndefined()
  expect(getAllProviders()[providerId]).toBeUndefined()
  expect(collectModelOptions(settings, []).some((option) => option.providerId === providerId)).toBe(
    false
  )
  expect(bridge.unregisterAllByPlugin(pluginId)).toBe(0)
  // Existing Moonshot pay-as-you-go configuration remains a separate provider.
  expect(getProviderConfig("moonshot")).toBeDefined()
})

test("the module and installed JSON have identical contributions", async () => {
  const pluginModule = await import("./index")
  expect(pluginModule.manifest).toEqual(readManifest())
  expect(pluginModule.default.manifest).toEqual(readManifest())
  await expect(Promise.resolve(pluginModule.default.activate({} as never))).resolves.toBeUndefined()
})
