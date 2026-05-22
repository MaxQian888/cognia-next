"use client"

/**
 * Per-project terminal override editor — surfaces `Project.terminalConfig`
 * in the settings card. The user picks a project from the existing
 * project list and edits `shell` / `cwd`. Env vars are deliberately
 * deferred to the JSON-edit subsection (set the whole map in metadata)
 * to keep the v1 UI simple.
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

  const selected = projects.find((p) => p.id === selectedId)

  if (projects.length === 0) {
    return (
      <div className="rounded border p-3">
        <Label className="text-xs">{t("title")}</Label>
        <p className="mt-1 text-[11px] text-muted-foreground">{t("emptyProjects")}</p>
      </div>
    )
  }

  function patch(updates: Partial<{ shell: string; cwd: string }>): void {
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
      <Select value={selectedId} onValueChange={(value) => setSelectedId(value)}>
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
        </div>
      ) : null}
    </div>
  )
}

export default TerminalProjectOverride
