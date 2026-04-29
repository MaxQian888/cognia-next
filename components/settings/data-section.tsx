"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { buildExportEnvelope, defaultExportFileName } from "@/lib/data/export"
import { importEnvelope, validateEnvelope } from "@/lib/data/import"
import { clearAll, clearTables, type ClearableTable } from "@/lib/data/clear"
import type { ExportEnvelope, ImportMergeStrategy, ImportSummary } from "@/lib/data/export-schema"
import { useSettingsStore } from "@/stores/settings-store"
import { isTauri } from "@/lib/tauri"
import { toast } from "sonner"
import {
  DatabaseIcon,
  DownloadIcon,
  ShieldAlertIcon,
  ShieldIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react"

const CLEAR_TARGETS: { value: ClearableTable | "all"; label: string }[] = [
  { value: "sessions", label: "Conversations + messages" },
  { value: "characters", label: "Characters (built-ins re-seed)" },
  { value: "skills", label: "Skills (built-ins re-seed)" },
  { value: "teams", label: "Teams (built-ins re-seed)" },
  { value: "promptPresets", label: "System prompt presets" },
  { value: "mcpServers", label: "MCP servers" },
  { value: "settings", label: "App settings (resets to defaults)" },
  { value: "all", label: "Everything (entire database)" },
]

export function DataSection() {
  const t = useTranslations("settings.data")
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Label className="flex items-center gap-2">
          <DatabaseIcon className="size-4" />
          {t("title")}
        </Label>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      <ExportBlock />
      <Separator />
      <ImportBlock />
      <Separator />
      <ClearBlock />
      <Separator />
      <PrivacyBlock />
    </div>
  )
}

// ---- Export --------------------------------------------------------------

function ExportBlock() {
  const t = useTranslations("settings.data")
  const [includeSessions, setIncludeSessions] = useState(false)
  const [includeApiKey, setIncludeApiKey] = useState(false)
  const [busy, setBusy] = useState(false)

  const onExport = async () => {
    setBusy(true)
    try {
      const env = await buildExportEnvelope({
        includeSessions,
        includeApiKey,
      })
      const json = JSON.stringify(env, null, 2)
      const fileName = defaultExportFileName()
      if (isTauri()) {
        const { save } = await import("@tauri-apps/plugin-dialog")
        const { writeTextFile } = await import("@tauri-apps/plugin-fs")
        const path = await save({
          defaultPath: fileName,
          filters: [{ name: "JSON", extensions: ["json"] }],
        })
        if (!path) return
        await writeTextFile(path, json)
        toast.success(t("exportSuccess"))
      } else {
        const blob = new Blob([json], { type: "application/json" })
        const url = URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = fileName
        a.click()
        URL.revokeObjectURL(url)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center gap-2">
        <DownloadIcon className="size-4" />
        <Label className="text-sm">{t("exportTitle")}</Label>
      </div>
      <p className="text-xs text-muted-foreground">{t("exportHint")}</p>

      <div className="space-y-2 pt-1">
        <label className="flex items-start gap-2 text-sm">
          <Switch checked={includeSessions} onCheckedChange={setIncludeSessions} />
          <span>
            <span className="font-medium">{t("includeSessions")}</span>
            <span className="block text-[11px] text-muted-foreground">
              {t("includeSessionsHint")}
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <Switch checked={includeApiKey} onCheckedChange={setIncludeApiKey} />
          <span>
            <span className="font-medium">{t("includeApiKey")}</span>
            <span className="block text-[11px] text-muted-foreground">
              {t("includeApiKeyHint")}
            </span>
          </span>
        </label>
      </div>

      <div className="flex justify-end">
        <Button size="sm" onClick={() => void onExport()} disabled={busy}>
          {busy ? t("exporting") : t("exportButton")}
        </Button>
      </div>
    </Card>
  )
}

// ---- Import --------------------------------------------------------------

function ImportBlock() {
  const t = useTranslations("settings.data")
  const [strategy, setStrategy] = useState<ImportMergeStrategy>("skip")
  const [includeSessions, setIncludeSessions] = useState(true)
  const [includeApiKey, setIncludeApiKey] = useState(false)
  const [pending, setPending] = useState<ExportEnvelope | null>(null)
  const [summary, setSummary] = useState<ImportSummary | null>(null)
  const [busy, setBusy] = useState(false)

  const pickAndLoad = async () => {
    setBusy(true)
    setSummary(null)
    try {
      let raw: string | null = null
      if (isTauri()) {
        const { open } = await import("@tauri-apps/plugin-dialog")
        const { readTextFile } = await import("@tauri-apps/plugin-fs")
        const picked = await open({
          multiple: false,
          filters: [{ name: "JSON", extensions: ["json"] }],
        })
        if (!picked || Array.isArray(picked)) return
        raw = await readTextFile(picked as string)
      } else {
        raw = await pickFileWeb()
        if (!raw) return
      }
      const parsed = JSON.parse(raw)
      validateEnvelope(parsed)
      setPending(parsed)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const commit = async () => {
    if (!pending) return
    setBusy(true)
    try {
      const result = await importEnvelope(pending, {
        mergeStrategy: strategy,
        includeSessions,
        includeApiKey,
      })
      setSummary(result)
      toast.success(t("importSuccess"))
      setPending(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center gap-2">
        <UploadIcon className="size-4" />
        <Label className="text-sm">{t("importTitle")}</Label>
      </div>
      <p className="text-xs text-muted-foreground">{t("importHint")}</p>

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-[11px]">{t("mergeStrategyLabel")}</Label>
          <Select value={strategy} onValueChange={(v) => setStrategy(v as ImportMergeStrategy)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="skip">{t("strategySkip")}</SelectItem>
              <SelectItem value="overwrite">{t("strategyOverwrite")}</SelectItem>
              <SelectItem value="duplicate">{t("strategyDuplicate")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2 pt-5">
          <label className="flex items-center gap-2 text-xs">
            <Switch checked={includeSessions} onCheckedChange={setIncludeSessions} />
            {t("includeSessions")}
          </label>
          <label className="flex items-center gap-2 text-xs">
            <Switch checked={includeApiKey} onCheckedChange={setIncludeApiKey} />
            {t("includeApiKey")}
          </label>
        </div>
      </div>

      <div className="flex justify-end">
        <Button size="sm" onClick={() => void pickAndLoad()} disabled={busy}>
          {busy ? t("loading") : t("importButton")}
        </Button>
      </div>

      {pending && (
        <div className="rounded-md border bg-muted/30 p-3 text-xs">
          <p className="mb-1 font-medium">{t("preview")}</p>
          <ul className="space-y-0.5 text-muted-foreground">
            <PreviewRow label="characters" value={pending.characters?.length ?? 0} />
            <PreviewRow label="skills" value={pending.skills?.length ?? 0} />
            <PreviewRow label="teams" value={pending.teams?.length ?? 0} />
            <PreviewRow label="presets" value={pending.promptPresets?.length ?? 0} />
            <PreviewRow label="mcpServers" value={pending.mcpServers?.length ?? 0} />
            <PreviewRow label="sessions" value={pending.sessions?.length ?? 0} />
            <PreviewRow label="messages" value={pending.messages?.length ?? 0} />
          </ul>
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setPending(null)}>
              {t("cancel")}
            </Button>
            <Button size="sm" onClick={() => void commit()} disabled={busy}>
              {busy ? t("applying") : t("apply")}
            </Button>
          </div>
        </div>
      )}

      {summary && (
        <div className="rounded-md border bg-muted/30 p-3 text-xs">
          <p className="mb-1 font-medium">{t("summary")}</p>
          <SummaryGroup label="Added" map={summary.added} />
          <SummaryGroup label="Overwritten" map={summary.overwritten} />
          <SummaryGroup label="Skipped" map={summary.skipped} />
          <SummaryGroup label="Built-ins preserved" map={summary.builtInsSkipped} />
        </div>
      )}
    </Card>
  )
}

function PreviewRow({ label, value }: { label: string; value: number }) {
  return (
    <li>
      <span className="font-mono">{label}:</span>{" "}
      <span className={value > 0 ? "" : "italic"}>{value}</span>
    </li>
  )
}

function SummaryGroup({ label, map }: { label: string; map: Record<string, number> }) {
  const entries = Object.entries(map)
  if (entries.length === 0) return null
  return (
    <p className="text-muted-foreground">
      <span className="font-medium">{label}:</span>{" "}
      {entries.map(([k, v]) => `${k}=${v}`).join(", ")}
    </p>
  )
}

async function pickFileWeb(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input")
    input.type = "file"
    input.accept = "application/json,.json"
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) return resolve(null)
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result ?? ""))
      reader.onerror = () => resolve(null)
      reader.readAsText(file)
    }
    input.click()
  })
}

// ---- Clear data ----------------------------------------------------------

function ClearBlock() {
  const t = useTranslations("settings.data")
  const [target, setTarget] = useState<ClearableTable | "all">("sessions")
  const [confirm, setConfirm] = useState("")
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const run = async () => {
    setBusy(true)
    try {
      if (target === "all") {
        await clearAll()
        toast.success(t("clearAllSuccess"))
        setTimeout(() => window.location.reload(), 250)
      } else {
        await clearTables([target])
        toast.success(t("clearSuccess"))
      }
      setOpen(false)
      setConfirm("")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="space-y-3 border-destructive/50 p-4">
      <div className="flex items-center gap-2 text-destructive">
        <Trash2Icon className="size-4" />
        <Label className="text-sm">{t("clearTitle")}</Label>
      </div>
      <p className="text-xs text-muted-foreground">{t("clearHint")}</p>

      <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
        <div className="space-y-1">
          <Label className="text-[11px]">{t("clearTargetLabel")}</Label>
          <Select value={target} onValueChange={(v) => setTarget(v as ClearableTable | "all")}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CLEAR_TARGETS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <AlertDialog open={open} onOpenChange={setOpen}>
          <AlertDialogTrigger asChild>
            <Button variant="destructive" size="sm">
              {t("clearButton")}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <ShieldAlertIcon className="size-4 text-destructive" />
                {t("clearConfirmTitle")}
              </AlertDialogTitle>
              <AlertDialogDescription>{t("clearConfirmBody")}</AlertDialogDescription>
            </AlertDialogHeader>
            <div className="space-y-1">
              <Label className="text-xs">{t("typeToConfirm")}</Label>
              <Input
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="DELETE"
                autoFocus
              />
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
              <AlertDialogAction
                disabled={confirm !== "DELETE" || busy}
                onClick={(e) => {
                  e.preventDefault()
                  void run()
                }}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {busy ? t("clearing") : t("clearConfirmAction")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </Card>
  )
}

// ---- Privacy -------------------------------------------------------------

function PrivacyBlock() {
  const t = useTranslations("settings.data")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const telemetryEnabled = Boolean(settings?.telemetryEnabled)

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center gap-2">
        <ShieldIcon className="size-4" />
        <Label className="text-sm">{t("privacyTitle")}</Label>
      </div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium">{t("telemetryLabel")}</p>
          <p className="text-xs text-muted-foreground">{t("telemetryHint")}</p>
        </div>
        <Switch
          checked={telemetryEnabled}
          onCheckedChange={(v) => void save({ telemetryEnabled: v })}
        />
      </div>
      <p className="text-[11px] text-muted-foreground">{t("keyringFollowup")}</p>
    </Card>
  )
}
