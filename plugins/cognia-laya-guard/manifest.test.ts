/**
 * The Laya Guard manifest, checked against the validator the installer runs.
 *
 * The Python suite covers the engine and hook wiring; nothing there can see
 * the manifest, and a manifest that fails validation means the plugin never
 * loads at all — the failure mode where every unit test is green and the
 * feature does not exist.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { validatePluginManifest } from "@cognia/plugin-sdk/manifest"
import type { PluginManifest } from "@cognia/plugin-sdk"

const manifest = JSON.parse(
  readFileSync(join(__dirname, "plugin.json"), "utf8")
) as PluginManifest & {
  pythonDependencies?: string[]
  pythonVenv?: string
  configSchema?: { properties?: Record<string, unknown> }
}

describe("cognia-laya-guard manifest", () => {
  it("passes validation", () => {
    const result = validatePluginManifest(manifest, { governanceMode: "warn" })
    const errors = (result.diagnostics ?? []).filter(
      (diagnostic) => diagnostic.severity === "error"
    )
    expect(errors).toEqual([])
    expect(result.valid).toBe(true)
  })

  it("is a pure Python plugin with no JavaScript entry", () => {
    expect(manifest.type).toBe("python")
    expect(manifest.pythonMain).toBe("main.py")
    expect(manifest).not.toHaveProperty("main")
  })

  it("pins laya and asks for an isolated environment", () => {
    // laya pulls torch + transformers — heavy enough that it must never sit in
    // the shared bucket constraining other plugins' solves.
    expect(manifest.pythonVenv).toBe("isolated")
    expect(manifest.pythonDependencies).toEqual(["laya==0.3.5"])
  })

  it("declares exactly the permissions the wiring needs", () => {
    // onConnectorInbound is not a chat-interception hook, so the plugin
    // carries no high-risk permission — just python:execute for the host
    // and network:fetch for the one-time HuggingFace checkpoint download.
    expect(manifest.permissions).toEqual(["python:execute", "network:fetch"])
  })

  it("scopes network egress to the model hosts", () => {
    const access = (manifest as { networkAccess?: { allowedDomains?: string[] } }).networkAccess
    expect(access?.allowedDomains).toEqual(expect.arrayContaining(["huggingface.co"]))
  })

  it("defaults to the validated operating point", () => {
    const properties = manifest.configSchema?.properties as Record<string, { default?: unknown }>
    // Moderation scores on by default but ships in observe mode — a fresh
    // install never drops a message until the operator flips to enforce.
    expect(properties.inboundModeration?.default).toBe(true)
    expect(properties.inboundMode?.default).toBe("observe")
    expect(properties.inboundThreshold?.default).toBe(0.75)
    expect(properties.warmup?.default).toBe(true)
  })
})
