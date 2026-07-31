import {
  evaluateEngineCompat,
  isUnimplementedNamespace,
  IMPLEMENTED_VSCODE_NAMESPACES,
  UNIMPLEMENTED_VSCODE_NAMESPACES,
  SHIM_VSCODE_VERSION,
} from "./engine-compat"
import { inferPermissions } from "./permission-inference"
import type { VsixInstallResult } from "./vsix-installer"
import type { VsCodePermissionInference } from "@/types/plugin/plugin-vscode"

const encoder = new TextEncoder()

/** A `VsixInstallResult` with one main bundle, enough for the inference walk. */
function vsixWithBundle(source: string): VsixInstallResult {
  return {
    pkgJson: {
      name: "demo",
      publisher: "acme",
      version: "1.0.0",
      main: "./out/extension.js",
      engines: { vscode: "^1.93.0" },
    },
    files: new Map([["out/extension.js", encoder.encode(source)]]),
    lspBinaryCandidates: [],
    themes: [],
    sha256: "a".repeat(64),
    bundleFormat: "cjs",
  } as unknown as VsixInstallResult
}

function inference(overrides: Partial<VsCodePermissionInference> = {}): VsCodePermissionInference {
  return {
    permissions: [],
    reasons: [],
    confidence: "high",
    unparsedBundle: false,
    unsupportedApis: [],
    ...overrides,
  }
}

describe("engine-compat", () => {
  it("flags_unsupported_debug_namespace", () => {
    // The evidence comes from the real AST walk, not a hand-made list — the
    // whole design claim is that inference (not the version range) is the
    // signal, so the test exercises that path end to end.
    const result = inferPermissions({
      vsix: vsixWithBundle(`
        const vscode = require("vscode")
        function activate() {
          vscode.debug.registerDebugConfigurationProvider("node", {})
        }
        exports.activate = activate
      `),
    })
    expect(result.unsupportedApis).toContain("vscode.debug")

    const report = evaluateEngineCompat({ engineVscode: "^1.93.0", inference: result })
    expect(report.unsupportedApis).toContain("vscode.debug")
    expect(report.warnings).toContainEqual({
      kind: "unsupported-api",
      namespaces: ["vscode.debug"],
    })
    // The point of the whole module.
    expect(report.blocked).toBe(false)
  })

  it("does not flag namespaces the shim actually implements", () => {
    const result = inferPermissions({
      vsix: vsixWithBundle(`
        const vscode = require("vscode")
        vscode.commands.registerCommand("demo.run", () => vscode.window.showInformationMessage("hi"))
        vscode.workspace.getConfiguration("demo")
      `),
    })
    expect(result.unsupportedApis).toEqual([])
    expect(evaluateEngineCompat({ inference: result }).warnings).toEqual([])
  })

  it("does not fabricate a hit from a namespace that merely shares a prefix", () => {
    // `vscode.debugging` is not `vscode.debug`; a prefix match would invent a
    // warning about an API the extension never touched.
    const result = inferPermissions({
      vsix: vsixWithBundle(`const vscode = require("vscode"); vscode.debugging.enable()`),
    })
    expect(result.unsupportedApis).toEqual([])
  })

  it("engine_mismatch_warns_but_does_not_block", () => {
    // ^1.93.0 against a shim reporting 1.74.0 — the exact case that a naive
    // gate would reject, even though nothing here uses an unsupported API.
    const report = evaluateEngineCompat({
      engineVscode: "^1.93.0",
      inference: inference(),
    })

    expect(report.blocked).toBe(false)
    expect(report.unsupportedApis).toEqual([])
    expect(report.warnings).toEqual([
      { kind: "engine-mismatch", required: "^1.93.0", shimVersion: SHIM_VSCODE_VERSION },
    ])
  })

  it("does not warn when the shim satisfies the declared engine range", () => {
    expect(
      evaluateEngineCompat({ engineVscode: "^1.60.0", inference: inference() }).warnings
    ).toEqual([])
    // A missing range is normalised to "*", which everything satisfies.
    expect(evaluateEngineCompat({ inference: inference() }).engineVscode).toBe("*")
    expect(evaluateEngineCompat({ inference: inference() }).warnings).toEqual([])
  })

  it("minified_bundle_degrades_to_warning_not_block", () => {
    // Inference gave up on the bundle. The honest reading of an empty
    // `unsupportedApis` here is "unknown", not "clean" — so the report says
    // it is unreliable and still refuses to block.
    const report = evaluateEngineCompat({
      engineVscode: "^1.60.0",
      inference: inference({ confidence: "low", unparsedBundle: true }),
    })

    expect(report.blocked).toBe(false)
    expect(report.reliable).toBe(false)
    expect(report.warnings).toContainEqual({ kind: "inference-degraded", confidence: "low" })
  })

  it("an unparseable bundle still yields a report rather than throwing", () => {
    // Deliberately broken syntax: the AST parser fails, the string scan takes
    // over, and the result must be a warning — never an exception that a
    // caller could mistake for a rejection.
    const result = inferPermissions({
      vsix: vsixWithBundle(`function ((( { vscode.debug.startDebugging() `),
    })
    expect(result.unparsedBundle).toBe(true)
    // Property access survives minification/mangling, which is why the string
    // scan is worth running at all.
    expect(result.unsupportedApis).toContain("vscode.debug")

    const report = evaluateEngineCompat({ inference: result })
    expect(report.blocked).toBe(false)
    expect(report.reliable).toBe(false)
  })

  it("reports every unimplemented namespace it finds, deduped and sorted", () => {
    const report = evaluateEngineCompat({
      inference: inference({
        unsupportedApis: ["vscode.scm", "vscode.debug", "vscode.scm", "vscode.notebooks"],
      }),
    })
    expect(report.unsupportedApis).toEqual(["vscode.debug", "vscode.notebooks", "vscode.scm"])
  })

  it("treats a theme-only extension as reliable", () => {
    // No main bundle → nothing to walk → the empty list genuinely means "none".
    const result = inferPermissions({
      vsix: {
        pkgJson: { name: "t", publisher: "p", version: "1.0.0", contributes: { themes: [] } },
        files: new Map(),
        lspBinaryCandidates: [],
        themes: [],
        sha256: "b".repeat(64),
      } as unknown as VsixInstallResult,
    })
    expect(result.unsupportedApis).toEqual([])
    expect(evaluateEngineCompat({ inference: result }).reliable).toBe(true)
  })

  it("keeps the implemented and unimplemented namespace sets disjoint", () => {
    // A namespace in both lists would mean the module contradicts itself about
    // what the shim does.
    const overlap = IMPLEMENTED_VSCODE_NAMESPACES.filter((n) =>
      (UNIMPLEMENTED_VSCODE_NAMESPACES as readonly string[]).includes(n)
    )
    expect(overlap).toEqual([])
    expect(isUnimplementedNamespace("debug")).toBe(true)
    expect(isUnimplementedNamespace("commands")).toBe(false)
  })
})
