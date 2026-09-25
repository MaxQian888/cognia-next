/**
 * The Python runtime-contributions reference plugin's manifest, checked
 * against the same validator the installer runs.
 *
 * Every contribution here is python-backed: it declares no JS `entry`, which
 * is what routes its methods through `plugin_python_call` instead of a module
 * import. A manifest that fails validation — or that grows an `entry` by
 * accident — means the reference stops demonstrating the one thing it exists
 * to demonstrate, while `main.py` still looks fine.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { validatePluginManifest } from "@cognia/plugin-sdk/manifest"
import type { PluginManifest } from "@cognia/plugin-sdk"

interface PythonBackedEntry {
  id?: string
  type?: string
  entry?: string
  factory?: string
}

const manifest = JSON.parse(
  readFileSync(join(__dirname, "plugin.json"), "utf8")
) as PluginManifest & {
  ocrProviders?: PythonBackedEntry[]
  aiProviders?: PythonBackedEntry[]
  decisionProviders?: PythonBackedEntry[]
  workspaceBackends?: PythonBackedEntry[]
  connectors?: PythonBackedEntry[]
}

const source = readFileSync(join(__dirname, "main.py"), "utf8")

describe("cognia-python-runtime-demo manifest", () => {
  it("passes validation, warning only about the flag-gated connector", () => {
    const result = validatePluginManifest(manifest, { governanceMode: "warn" })
    const diagnostics = result.diagnostics ?? []
    expect(diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([])
    expect(result.valid).toBe(true)
    // `connectors` is `pythonExecution: "experimental"`, so the validator
    // warns by design; anything else warning here is a new manifest smell.
    const warningCodes = diagnostics
      .filter((diagnostic) => diagnostic.severity === "warning")
      .map((diagnostic) => diagnostic.code)
    expect(warningCodes.every((code) => code.includes("experimental"))).toBe(true)
  })

  it("is a pure Python plugin with no JavaScript entry anywhere", () => {
    expect(manifest.type).toBe("python")
    expect(manifest.pythonMain).toBe("main.py")
    expect(manifest).not.toHaveProperty("main")
    expect(manifest.capabilities).toContain("python")
    const entries = [
      ...(manifest.ocrProviders ?? []),
      ...(manifest.aiProviders ?? []),
      ...(manifest.decisionProviders ?? []),
      ...(manifest.workspaceBackends ?? []),
      ...(manifest.connectors ?? []),
    ]
    expect(entries.length).toBe(5)
    for (const entry of entries) expect(entry.entry).toBeUndefined()
  })

  it("backs every declared contribution with a python class", () => {
    // The host resolves `@cognia.contribution("<id>")` by id (the connector by
    // its factory class); a declaration with no matching class fails only at
    // first call, inside the subprocess.
    const ids = [
      ...(manifest.ocrProviders ?? []),
      ...(manifest.aiProviders ?? []),
      ...(manifest.decisionProviders ?? []),
      ...(manifest.workspaceBackends ?? []),
    ].map((entry) => entry.id)
    for (const id of ids) expect(source).toContain(`@cognia.contribution("${id}")`)
    for (const connector of manifest.connectors ?? []) {
      expect(source).toContain(`@cognia.contribution("${connector.type}")`)
      expect(source).toContain(`class ${connector.factory}`)
    }
  })

  it("declares only the permissions its contributions need", () => {
    expect(manifest.permissions).toEqual(["python:execute", "decisions:provide"])
  })

  it("is desktop-only, truthfully", () => {
    const compatibility = manifest.runtimeCompatibility as Record<
      string,
      { availability: string; reason?: string }
    >
    expect(compatibility.tauri.availability).toBe("supported")
    for (const shell of ["browser", "mobile"]) {
      expect(compatibility[shell].availability).toBe("blocked")
      expect(compatibility[shell].reason).toBeTruthy()
    }
  })

  it("derives the workspace commit id deterministically", () => {
    // `hash()` on a str is salted per process, so the demo's "sha" changed on
    // every host restart; the id must come from hashlib.
    expect(source).toContain("hashlib.sha1(")
    expect(source).not.toMatch(/\bhash\(message\)/)
  })
})
