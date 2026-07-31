/**
 * Scaffold healthcheck — static-but-real validation of a freshly generated
 * plugin file map BEFORE it is written anywhere or declared a success.
 *
 * Scope honesty: the emitted entry file is TS/Python source targeting the
 * external plugin SDK, so the app can NOT compile-and-boot it at scaffold
 * time. What CAN be proven deterministically is proven here:
 *   - `plugin.json` exists, parses, and passes `validatePluginManifest`
 *     (the same validator the installer runs);
 *   - `manifest.main` names a file that actually exists in the map;
 *   - no `{{placeholder}}` template residue survived `processTemplate`;
 *   - declared capabilities have a matching registration call in the entry
 *     (warning-level heuristic — templates evolve).
 *
 * The canonical Rust CLI owns scaffold generation. This validator remains a
 * reusable pure check for callers that already hold an in-memory file map.
 */

import { validatePluginManifest } from "@/lib/plugin/core/validation"
import type { PluginManifest } from "@/types/plugin/plugin"

export interface ScaffoldHealthIssue {
  severity: "error" | "warning"
  code:
    | "manifest_missing"
    | "manifest_unparsable"
    | "manifest_invalid"
    | "main_missing"
    | "template_residue"
    | "capability_unwired"
  message: string
  file?: string
}

export interface ScaffoldHealthReport {
  ok: boolean
  issues: ScaffoldHealthIssue[]
}

/** Entry-file markers expected per declared capability (heuristic, warns only). */
const CAPABILITY_MARKERS: ReadonlyArray<{ capability: string; markers: string[] }> = [
  { capability: "tools", markers: ["registerPluginTools", "tools", "register_tool"] },
  { capability: "views", markers: ["registerView", "views"] },
  { capability: "workflow-nodes", markers: ["registerWorkflowNode", "workflowNodes"] },
]

export function healthcheckScaffold(files: ReadonlyMap<string, string>): ScaffoldHealthReport {
  const issues: ScaffoldHealthIssue[] = []

  const manifestRaw = files.get("plugin.json")
  let manifest: PluginManifest | null = null
  if (manifestRaw === undefined) {
    issues.push({
      severity: "error",
      code: "manifest_missing",
      message: "scaffold emitted no plugin.json",
    })
  } else {
    let parsed: unknown
    try {
      parsed = JSON.parse(manifestRaw)
    } catch (err) {
      issues.push({
        severity: "error",
        code: "manifest_unparsable",
        message: `plugin.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        file: "plugin.json",
      })
    }
    if (parsed !== undefined) {
      const validation = validatePluginManifest(parsed)
      if (!validation.valid) {
        for (const error of validation.errors) {
          issues.push({
            severity: "error",
            code: "manifest_invalid",
            message: error,
            file: "plugin.json",
          })
        }
      } else {
        manifest = parsed as PluginManifest
      }
    }
  }

  if (manifest) {
    const main = manifest.main
    if (typeof main === "string" && main !== "" && !files.has(main)) {
      issues.push({
        severity: "error",
        code: "main_missing",
        message: `manifest.main "${main}" is not among the scaffolded files`,
        file: main,
      })
    }
  }

  for (const [path, content] of files) {
    const residue = content.match(/\{\{[A-Za-z0-9_.]+\}\}/)
    if (residue) {
      issues.push({
        severity: "error",
        code: "template_residue",
        message: `unexpanded template placeholder ${residue[0]} in ${path}`,
        file: path,
      })
    }
  }

  if (manifest && typeof manifest.main === "string" && files.has(manifest.main)) {
    const entry = files.get(manifest.main) as string
    const capabilities = Array.isArray(manifest.capabilities) ? manifest.capabilities : []
    for (const { capability, markers } of CAPABILITY_MARKERS) {
      if (!capabilities.includes(capability as never)) continue
      if (!markers.some((m) => entry.includes(m))) {
        issues.push({
          severity: "warning",
          code: "capability_unwired",
          message: `manifest declares "${capability}" but the entry file has no matching registration`,
          file: manifest.main,
        })
      }
    }
  }

  return { ok: !issues.some((i) => i.severity === "error"), issues }
}
