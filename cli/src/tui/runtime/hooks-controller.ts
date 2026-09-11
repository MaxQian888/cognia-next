/** Hooks inventory uses the same source merge and fleet filtering as execution. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { BUILTIN_HOOKS } from "@/lib/claude/hooks/builtin-hooks"
import { loadHooks, type FileReader } from "../../hooks/load-hooks"
import { HOOK_EVENTS, HooksConfigSchema, type HookEvent, type HooksConfig } from "../../hooks/types"
import type { ResolvedConfig } from "../../config/schema"
import type { TuiAction } from "../state/types"
import { createCliTranslator, type CliLocale } from "../i18n"

export interface HookPanelRow {
  id: string
  label: string
  event: string
  source: "builtin" | "cognia" | "claude"
  detail: string
  builtinId?: string
  enabled?: boolean
  sourcePath?: string
}
export interface HooksDeps {
  dispatch: (action: TuiAction) => void
  home: string
  osHome?: string
  config?: ResolvedConfig
  readFile?: FileReader
}
const defaultReadFile: FileReader = (file) => {
  try {
    return fs.readFileSync(file, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

export function buildHooksDocument(config: HooksConfig, locale?: CliLocale): string {
  const t = createCliTranslator(locale, "cliUiHooks")
  const lines: string[] = []
  for (const event of HOOK_EVENTS) {
    for (const group of config[event] ?? []) {
      lines.push(
        `## ${event}`,
        t("data.matcher", { value: group.matcher || "*" }),
        t("data.agents", { value: group.agents || "*" })
      )
      for (const handler of group.hooks) {
        // Do not expose authentication headers in the inventory.
        const { headers: _headers, ...visible } = handler as Record<string, unknown>
        lines.push("```json", JSON.stringify(visible, null, 2), "```", "")
      }
    }
  }
  return lines.join("\n") || t("data.empty")
}

export function readHooksPanel(deps: Omit<HooksDeps, "dispatch">): {
  rows: HookPanelRow[]
  diagnostics: string[]
} {
  const t = createCliTranslator(deps.config?.locale, "cliUiHooks")
  const readFile = deps.readFile ?? defaultReadFile
  const sources = {
    cognia: path.join(deps.home, "config.json"),
    claude: path.join(deps.osHome ?? os.homedir(), ".claude", "settings.json"),
  }
  const rows: HookPanelRow[] = []
  const diagnostics = [
    t(
      deps.config?.agentBackend && deps.config.agentBackend !== "builtin"
        ? "data.external"
        : deps.config?.provider && deps.config.provider !== "anthropic"
          ? "data.otherProvider"
          : "data.configured"
    ),
  ]
  for (const source of ["cognia", "claude"] as const) {
    const file = sources[source]
    try {
      const raw = readFile(file)
      if (raw == null) continue
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error(t("data.invalidObject"))
      const block = (parsed as { hooks?: unknown }).hooks
      if (block === undefined) continue
      const result = HooksConfigSchema.safeParse(block)
      if (!result.success)
        throw new Error(
          result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
        )
      // Reuse loadHooks so inherited fleet-managed groups stay excluded.
      const effective = loadHooks({
        home: deps.home,
        claudeHome: path.dirname(sources.claude),
        readFile: (candidate) => (candidate === file ? raw : null),
      })
      for (const event of HOOK_EVENTS) {
        for (const [index, group] of (effective[event] ?? []).entries()) {
          rows.push({
            id: `${source}:${event}:${index}`,
            source,
            sourcePath: file,
            event,
            label: `${event} · ${group.matcher || "*"} · ${group.hooks.length}`,
            detail: `${t("data.source", { path: file })}\n\n${buildHooksDocument({ [event]: [group] }, deps.config?.locale)}`,
          })
        }
      }
    } catch (error) {
      diagnostics.push(
        t("data.invalid", {
          path: file,
          error: error instanceof Error ? error.message : String(error),
        })
      )
    }
  }
  const settingsText = createCliTranslator(deps.config?.locale, "cliUiSettings")
  for (const builtin of BUILTIN_HOOKS) {
    const enabled = deps.config?.builtinHookOverrides?.[builtin.id] ?? builtin.defaultEnabled
    rows.push({
      id: `builtin:${builtin.id}`,
      label: builtin.id,
      event: builtin.event,
      source: "builtin",
      builtinId: builtin.id,
      enabled,
      detail: `${settingsText(`rows.hook:${builtin.id}.description`)}\n\n${t("data.event", { event: builtin.event })}\n${t("data.matcher", { value: builtin.matcher || "*" })}\n${t("data.script", { path: builtin.script })}\n\n${t("data.toggleHelp")}`,
    })
  }
  return { rows, diagnostics }
}

export function hooksList(deps: HooksDeps): void {
  deps.dispatch({ type: "OVERLAY_OPEN", overlay: { kind: "hooks", ...readHooksPanel(deps) } })
}
export type { HookEvent }
