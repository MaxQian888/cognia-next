/**
 * Does the Kimi subscription example actually reach account setup and the
 * model pickers?
 *
 * Lives here, not under `plugins/kimi-subscription/`, because it is a test of
 * the HOST: it drives the subscription-provider overlay bridge, the provider
 * registry, the model-option collector and the compatibility policy. A
 * plugin's own suite must run against the published SDK surface alone
 * (ADR-0156 §5); the plugin keeps its manifest-shape assertions.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { OVERLAY_REGISTRY_CAPABILITIES } from "@/lib/plugin/contracts/capability-bridge-map"
import { evaluatePluginCompatibility } from "@/lib/plugin/core/compatibility"
import { getSubscriptionProvider } from "@/lib/subscription/core/provider-registry"
import { collectModelOptions } from "@/lib/ai/model-options"
import { getAllProviders, getProviderConfig } from "@cognia/provider-types/provider"
import type { PluginManifest } from "@/types/plugin"
import { version as hostVersion } from "../../../package.json"

const readManifest = () =>
  JSON.parse(
    readFileSync(join(__dirname, "../../../plugins/kimi-subscription/plugin.json"), "utf8")
  ) as PluginManifest
const bridge = OVERLAY_REGISTRY_CAPABILITIES["subscription-provider"]
const pluginId = "cognia-kimi-subscription"
const providerId = `${pluginId}:kimi-code`

afterEach(() => bridge.unregisterAllByPlugin(pluginId))

test("the shipped manifest is compatible with the actual host version", () => {
  expect(evaluatePluginCompatibility(readManifest(), { cogniaVersion: hostVersion })).toEqual({
    compatible: true,
    diagnostics: [],
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
