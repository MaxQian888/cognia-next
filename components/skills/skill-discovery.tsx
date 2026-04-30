"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { FolderOpenIcon, HomeIcon, ImportIcon, Loader2Icon, SearchIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import { skillsScanDir, skillsScanNative, type NativeSkill } from "@/lib/claude/ipc"
import { pickDirectory } from "@/lib/files/file-bridge"
import { isTauri } from "@/lib/tauri"
import { parseSkillMarkdown } from "@/lib/claude/skills-io"
import { useSkillsStore, type ImportStaging } from "@/stores/skills"
import { loggers } from "@/lib/logger"

type ScanState =
  | { status: "idle" }
  | { status: "loading"; label: string }
  | { status: "loaded"; label: string; results: NativeSkill[] }
  | { status: "error"; message: string }

export function SkillDiscovery() {
  const t = useTranslations("skills.discovery")
  const tCommon = useTranslations("skills")
  const [scan, setScan] = useState<ScanState>({ status: "idle" })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [customPath, setCustomPath] = useState("")
  const setImportStaging = useSkillsStore((s) => s.setImportStaging)
  const desktop = isTauri()

  const runScan = async (label: string, fn: () => Promise<NativeSkill[]>) => {
    setScan({ status: "loading", label })
    setSelected(new Set())
    try {
      const results = await fn()
      setScan({ status: "loaded", label, results })
      loggers.skills.info("discovery scan ok", { label, count: results.length })
      if (results.length > 0) {
        // Pre-select everything so the user can hit Import without poking
        // each row individually. Easy to deselect via the header checkbox.
        setSelected(new Set(results.map((r) => r.dirName)))
      }
    } catch (err) {
      setScan({
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      })
      loggers.skills.error("discovery scan failed", err, { label })
    }
  }

  const handlePickAndScan = async () => {
    if (!desktop) {
      toast.error(t("errorDesktopOnly"))
      return
    }
    const dir = await pickDirectory()
    if (typeof dir !== "string" || !dir) return
    setCustomPath(dir)
    await runScan(dir, () => skillsScanDir(dir))
  }

  const handleScanCustom = async () => {
    if (!customPath.trim()) return
    await runScan(customPath, () => skillsScanDir(customPath.trim()))
  }

  const stageImport = () => {
    if (scan.status !== "loaded") return
    const drafts: ImportStaging["drafts"] = []
    const errors: ImportStaging["parseErrors"] = []
    for (const native of scan.results) {
      if (!selected.has(native.dirName)) continue
      try {
        const { draft } = parseSkillMarkdown(native.content, {
          fallbackName: native.dirName,
        })
        drafts.push(draft)
      } catch (err) {
        errors.push({
          name: native.dirName,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    if (drafts.length === 0) {
      toast.error(t("noFilesParsed"))
      loggers.skills.warn("discovery import none parsed", {
        label: scan.label,
        attempted: scan.results.length,
        errors: errors.length,
      })
      return
    }
    setImportStaging({
      drafts,
      sourceLabel: scan.label,
      parseErrors: errors,
    })
    loggers.skills.info("discovery staged for import", {
      label: scan.label,
      drafts: drafts.length,
      errors: errors.length,
    })
  }

  const allSelected =
    scan.status === "loaded" && scan.results.length > 0 && selected.size === scan.results.length

  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center gap-1.5">
        <SearchIcon className="size-3.5" />
        <h2 className="text-xs font-semibold">{t("title")}</h2>
      </div>

      <div className="grid gap-2 md:grid-cols-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => void runScan("~/.claude/skills/", skillsScanNative)}
          disabled={!desktop || scan.status === "loading"}
        >
          <HomeIcon className="mr-1.5 size-3.5" />
          {t("scanHome")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void handlePickAndScan()}
          disabled={!desktop || scan.status === "loading"}
        >
          <FolderOpenIcon className="mr-1.5 size-3.5" />
          {t("scanCustom")}
        </Button>
      </div>

      <div className="flex items-end gap-2">
        <div className="flex-1 space-y-1">
          <Label className="text-xs">
            {tCommon("toolbar.import")} — {t("pathLabel")}
          </Label>
          <Input
            value={customPath}
            onChange={(e) => setCustomPath(e.target.value)}
            placeholder="/path/to/skills"
            className="h-8 font-mono text-xs"
            disabled={!desktop}
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void handleScanCustom()}
          disabled={!desktop || !customPath.trim() || scan.status === "loading"}
        >
          {scan.status === "loading" ? (
            <Loader2Icon className="mr-1.5 size-3.5 animate-spin" />
          ) : (
            <SearchIcon className="mr-1.5 size-3.5" />
          )}
          {t("scan")}
        </Button>
      </div>

      {scan.status === "loading" && (
        <Card className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
          <Spinner className="size-3" />
          {t("scanning", { label: scan.label })}
        </Card>
      )}
      {scan.status === "error" && (
        <Card className="border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
          {scan.message}
        </Card>
      )}
      {scan.status === "loaded" && (
        <Card className="p-0">
          <div className="flex items-center justify-between border-b px-3 py-2 text-xs">
            <Label className="flex cursor-pointer items-center gap-2">
              <Checkbox
                checked={allSelected}
                onCheckedChange={(v) => {
                  if (v) {
                    setSelected(new Set(scan.results.map((r) => r.dirName)))
                  } else {
                    setSelected(new Set())
                  }
                }}
              />
              <span>{t("found", { count: scan.results.length })}</span>
            </Label>
            <Button size="sm" onClick={stageImport} disabled={selected.size === 0}>
              <ImportIcon className="mr-1.5 size-3.5" />
              {t("import")}
            </Button>
          </div>
          {scan.results.length === 0 ? (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">
              {t("found", { count: 0 })}
            </p>
          ) : (
            <ScrollArea className="max-h-72">
              <ul>
                {scan.results.map((row) => (
                  <li
                    key={row.dirName}
                    className="flex items-center gap-2 border-b px-3 py-2 text-xs last:border-b-0"
                  >
                    <Checkbox
                      checked={selected.has(row.dirName)}
                      onCheckedChange={(v) => {
                        const next = new Set(selected)
                        if (v) next.add(row.dirName)
                        else next.delete(row.dirName)
                        setSelected(next)
                      }}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{row.dirName}</p>
                      <p className="truncate text-[10px] text-muted-foreground">
                        {row.filePath} · {t("resourcesCount", { count: row.resources.length })}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </ScrollArea>
          )}
        </Card>
      )}
    </div>
  )
}
