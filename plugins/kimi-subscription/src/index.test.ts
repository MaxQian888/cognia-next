import { readFileSync } from "node:fs"
import { join } from "node:path"
import { validatePluginManifest } from "@cognia/plugin-sdk/manifest"
import type { PluginManifest } from "@cognia/plugin-sdk"

const readManifest = () =>
  JSON.parse(readFileSync(join(__dirname, "../plugin.json"), "utf8")) as PluginManifest

// Registration through the host bridge, the model pickers and host-version
// compatibility are pinned by lib/plugin/core/kimi-subscription-plugin.test.ts.

test("the shipped manifest passes the installer validator without warnings", () => {
  const result = validatePluginManifest(readManifest(), { governanceMode: "warn" })
  expect(result.errors).toEqual([])
  expect(result.warnings).toEqual([])
  expect(result.valid).toBe(true)
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

test("the module and installed JSON have identical contributions", async () => {
  const pluginModule = await import("./index")
  expect(pluginModule.manifest).toEqual(readManifest())
  expect(pluginModule.default.manifest).toEqual(readManifest())
  await expect(Promise.resolve(pluginModule.default.activate({} as never))).resolves.toBeUndefined()
})
