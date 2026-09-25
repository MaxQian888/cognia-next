/**
 * The Laya Guard manifest, checked against the validator the installer runs.
 *
 * The Python suite covers the engine and hook wiring; nothing there can see
 * the manifest, and a manifest that fails validation means the plugin never
 * loads at all — the failure mode where every unit test is green and the
 * feature does not exist.
 */

import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { validatePluginManifest } from "@cognia/plugin-sdk/manifest"
import type { PluginManifest } from "@cognia/plugin-sdk"

const manifest = JSON.parse(
  readFileSync(join(__dirname, "plugin.json"), "utf8")
) as PluginManifest & {
  pythonDependencies?: string[]
  pythonVenv?: string
  bundle_include?: string[]
  permissionJustifications?: Record<string, string>
  configSchema?: { properties?: Record<string, unknown> }
}

/** The installer's copy list for this plugin (plugins/distribution.json). */
const distributionInclude = (
  JSON.parse(readFileSync(join(__dirname, "..", "distribution.json"), "utf8")) as {
    bundled: Record<string, { id: string; include: string[] }>
  }
).bundled["cognia-laya-guard"]?.include

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
    // carries no high-risk permission — python:execute for the host,
    // network:fetch for the one-time HuggingFace checkpoint download,
    // decisions:provide for the laya-local decision provider (ADR-0194), and
    // connectors:read because the inbound hook reads the text of every IM
    // message that arrives. Reading inbound traffic is what the grant is for,
    // so it is declared rather than left implicit in a hook registration.
    expect(manifest.permissions).toEqual([
      "python:execute",
      "network:fetch",
      "decisions:provide",
      "connectors:read",
    ])
    for (const permission of manifest.permissions ?? []) {
      expect(manifest.permissionJustifications?.[permission]).toBeTruthy()
    }
  })

  it("packs the same files the installer ships", () => {
    // Two copy lists exist — `cognia plugin build` reads plugin.json
    // (`pythonMain` + `bundle_include`), the installer stager reads
    // plugins/distribution.json. A file in one and not the other is a plugin
    // that works installed from the desktop app and breaks installed from a
    // built zip (or the reverse).
    expect(distributionInclude).toBeDefined()
    const expand = (pattern: string): string[] => {
      const recursive = /^(.*)\/\*\*\/\*(\.[A-Za-z0-9]+)?$/.exec(pattern)
      if (!recursive) return [pattern]
      const [, dir, extension] = recursive
      return readdirSync(join(__dirname, dir))
        .filter((name) => !extension || name.endsWith(extension))
        .map((name) => `${dir}/${name}`)
    }
    const installer = [...new Set(distributionInclude!.flatMap(expand))].sort()
    const built = [
      ...new Set([
        "plugin.json",
        manifest.pythonMain as string,
        ...(manifest.bundle_include ?? []),
      ]),
    ].sort()
    expect(built).toEqual(installer)
  })

  it("contributes the python-backed laya-local decision provider", () => {
    const withProviders = manifest as typeof manifest & {
      decisionProviders?: Array<{ id: string; labelKey?: string; entry?: string }>
      i18n?: { locales?: Record<string, Record<string, string>> }
    }
    expect(manifest.capabilities).toContain("decision-provider")
    expect(withProviders.decisionProviders).toEqual([
      expect.objectContaining({ id: "laya-local", labelKey: "decisionProvider.label" }),
    ])
    // Python-backed: no JS module; the host asks @cognia.contribution("laya-local").
    expect(withProviders.decisionProviders?.[0].entry).toBeUndefined()
    for (const locale of ["en", "zh-CN"]) {
      expect(withProviders.i18n?.locales?.[locale]?.["decisionProvider.label"]).toBeTruthy()
    }
  })

  it("ships every runtime string in both locales", () => {
    // main.py translates the inbound note and the provider status through
    // ctx.i18n.t; a key missing from zh-CN falls back to English at runtime,
    // which is exactly the regression this pins.
    const locales = (manifest as { i18n?: { locales?: Record<string, Record<string, string>> } })
      .i18n?.locales
    const en = Object.keys(locales?.en ?? {}).sort()
    expect(en).toEqual(
      expect.arrayContaining([
        "inbound.observeNote",
        "inbound.truncatedNote",
        "status.loading",
        "status.notLoaded",
        "status.retrying",
      ])
    )
    expect(Object.keys(locales?.["zh-CN"] ?? {}).sort()).toEqual(en)
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
