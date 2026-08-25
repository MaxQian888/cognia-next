/**
 * The RepoWiki manifest, checked against the validator the installer runs.
 *
 * The Python suite (`pnpm plugin:repowiki:test`) covers the generator; nothing
 * there can see the manifest, and a manifest that fails validation means the
 * plugin never loads at all — the failure mode where every unit test is green
 * and the feature does not exist.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { validatePluginManifest } from "@/lib/plugin/core/validation"
import type { PluginManifest } from "@/types/plugin"

const manifest = JSON.parse(
  readFileSync(join(__dirname, "plugin.json"), "utf8")
) as PluginManifest & {
  pythonDependencies?: string[]
  pythonVenv?: string
  configSchema?: { properties?: Record<string, unknown> }
}

describe("cognia-repowiki manifest", () => {
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

  it("asks for an isolated environment, because its dependency set is heavy", () => {
    // pydantic + networkx + aiosqlite in the shared bucket would constrain
    // every other Python plugin's solve. ADR-0143's rule is that a new plugin
    // never makes an installed one worse.
    expect(manifest.pythonVenv).toBe("isolated")
    expect(manifest.pythonDependencies).toEqual(
      expect.arrayContaining(["pydantic>=2.0", "aiosqlite>=0.20.0", "networkx>=3.0"])
    )
  })

  it("declares every permission the three swapped layers actually use", () => {
    // Each one is load-bearing: agent:control for the analysis passes,
    // filesystem for the two SQLite files and the exports, git:read for the
    // incremental `since` path. A missing one fails at first use, inside a
    // subprocess, where it reads as a plugin bug.
    expect(manifest.permissions).toEqual(
      expect.arrayContaining([
        "python:execute",
        "agent:control",
        "filesystem:read",
        "filesystem:write",
        "git:read",
      ])
    )
  })

  it("requests no credential permission, because it never sees a provider key", () => {
    expect(manifest.permissions).not.toContain("secrets:read")
    expect(manifest.permissions).not.toContain("network:fetch")
  })

  it("exposes the tuning knobs the config layer reads", () => {
    const properties = Object.keys(manifest.configSchema?.properties ?? {})
    expect(properties).toEqual(
      expect.arrayContaining([
        "model",
        "language",
        "concurrency",
        "max_files",
        "max_context_tokens",
        "rag_top_k",
        "rag_index_wiki",
      ])
    )
  })
})
