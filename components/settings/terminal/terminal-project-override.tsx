"use client"

/**
 * Per-workspace terminal override editor — surfaces `Project.terminalConfig`
 * in the settings card. The user picks a workspace and edits `shell`, `cwd`
 * and `env`.
 *
 * `env` had three readers (the terminal tool part, the mobile terminal, run in
 * dock) and no writer: the comment here promised a JSON-edit subsection that
 * was never built. It is the same "KEY=VALUE per line" textarea, and the same
 * parser, the terminal profiles above it use.
 *
 * Resolution priority (mirrors `lib/terminal/shell-detect.ts`):
 *   1. `Project.terminalConfig.shell`
 *   2. `settings.terminal.defaultShell`
 *   3. platform default
 */

import { useState } from "react"
import { useTranslations } from "next-intl"

import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { formatProfileEnv, parseProfileEnv } from "@/lib/terminal/profiles"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useProjectStore } from "@/stores/project/project-store"

export function TerminalProjectOverride() {
  const t = useTranslations("settings.terminal.projectOverride")
  const projects = useProjectStore((s) => s.projects)
  const updateProject = useProjectStore((s) => s.updateProject)
  const [selectedId, setSelectedId] = useState<string | "">("")
  // The raw text while it is being typed. Parsing drops a half-typed line, so
  // re-rendering from the parsed record would eat the line under the cursor.
  const [envDraft, setEnvDraft] = useState<string | null>(null)

  const selected = projects.find((p) => p.id === selectedId)

  if (projects.length === 0) {
    return (
      <div className="rounded border p-3">
        <Label className="text-xs">{t("title")}</Label>
        <p className="mt-1 text-[11px] text-muted-foreground">{t("emptyProjects")}</p>
      </div>
    )
  }

  function patch(
    updates: Partial<{ shell: string; cwd: string; env: Record<string, string> | undefined }>
  ): void {
    if (!selected) return
    const current = selected.terminalConfig ?? {}
    updateProject(selected.id, {
      terminalConfig: { ...current, ...updates },
    })
  }

  return (
    <div className="space-y-2 rounded border p-3" data-testid="terminal-project-override">
      <Label className="text-xs">{t("title")}</Label>
      <p className="text-[11px] text-muted-foreground">{t("helper")}</p>
      <Select
        value={selectedId}
        onValueChange={(value) => {
          setSelectedId(value)
          setEnvDraft(null)
        }}
      >
        <SelectTrigger className="h-8 text-xs">
          <SelectValue placeholder={t("selectProject")} />
        </SelectTrigger>
        <SelectContent>
          {projects.map((p) => (
            <SelectItem key={p.id} value={p.id} className="text-xs">
              {p.name || p.id}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {selected ? (
        <div className="space-y-2 pt-2">
          <div className="space-y-1">
            <Label className="text-[11px]">{t("shellLabel")}</Label>
            <Input
              value={selected.terminalConfig?.shell ?? ""}
              placeholder={t("shellPlaceholder")}
              onChange={(e) => patch({ shell: e.target.value })}
              className="h-7 text-xs"
              data-testid="terminal-project-override-shell"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[11px]">{t("cwdLabel")}</Label>
            <Input
              value={selected.terminalConfig?.cwd ?? ""}
              placeholder={selected.rootDir || t("cwdPlaceholder")}
              onChange={(e) => patch({ cwd: e.target.value })}
              className="h-7 text-xs"
              data-testid="terminal-project-override-cwd"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="terminal-project-override-env" className="text-[11px]">
              {t("envLabel")}
            </Label>
            <Textarea
              id="terminal-project-override-env"
              value={envDraft ?? formatProfileEnv(selected.terminalConfig?.env)}
              placeholder={t("envPlaceholder")}
              rows={3}
              onChange={(e) => {
                setEnvDraft(e.target.value)
                patch({ env: parseProfileEnv(e.target.value) })
              }}
              onBlur={() => setEnvDraft(null)}
              className="min-h-0 px-2 py-1 font-mono text-xs"
              data-testid="terminal-project-override-env"
            />
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default TerminalProjectOverride
