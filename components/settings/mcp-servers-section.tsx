"use client"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  MCP_TRANSPORTS,
  createMcpServer,
  deleteMcpServer,
  listMcpServers,
  updateMcpServer,
} from "@/lib/db/mcp-servers"
import type { McpServer, McpTransport } from "@/lib/claude/types"
import { applyPresetFields, MCP_PRESETS, type McpPreset } from "@/lib/claude/mcp-presets"
import { testMcpServer, type McpTestRequest, type McpTestResult } from "@/lib/claude/ipc"
import { isTauri } from "@/lib/tauri"
import { useLiveQuery } from "dexie-react-hooks"
import {
  CheckCircle2Icon,
  ExternalLinkIcon,
  Loader2Icon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  ServerIcon,
  Trash2Icon,
  XCircleIcon,
} from "lucide-react"
import { useMemo, useState } from "react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"

import { McpAgentChipGroup, refreshAgentAvailability } from "./mcp-agent-chip-group"
import { McpImportDialog } from "./mcp-import-dialog"
import { McpAgentStatusBar } from "./mcp-agent-status-bar"
import { McpDriftBanner } from "./mcp-drift-banner"
import { getDetectedWritableAgents } from "@/hooks/agent"
import { cn } from "@/lib/utils"
import { loggers } from "@/lib/logger"

type TransportFilter = "all" | McpTransport
type StatusFilter = "all" | "enabled" | "disabled"

export function McpServersSection() {
  const t = useTranslations("mcp")
  const tList = useTranslations("mcp.list")
  const tGallery = useTranslations("mcp.gallery")
  const liveServers = useLiveQuery(() => listMcpServers(), [])
  const servers = useMemo(() => liveServers ?? [], [liveServers])
  const [editing, setEditing] = useState<McpServer | null>(null)
  const [creating, setCreating] = useState<EditorInitial | null>(null)
  const [galleryOpen, setGalleryOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [transportFilter, setTransportFilter] = useState<TransportFilter>("all")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")

  const visibleServers = useMemo(() => {
    const q = search.trim().toLowerCase()
    return servers.filter((s) => {
      if (transportFilter !== "all" && s.transport !== transportFilter) return false
      if (statusFilter === "enabled" && !s.enabled) return false
      if (statusFilter === "disabled" && s.enabled) return false
      if (!q) return true
      const cfg = s.config as { command?: string; url?: string; args?: string[] }
      const haystack = [
        s.name,
        s.transport,
        cfg.command ?? "",
        cfg.url ?? "",
        (cfg.args ?? []).join(" "),
      ]
        .join(" ")
        .toLowerCase()
      return haystack.includes(q)
    })
  }, [servers, search, transportFilter, statusFilter])

  const filtersActive =
    search.trim().length > 0 || transportFilter !== "all" || statusFilter !== "all"

  const onPresetSelected = async (preset: McpPreset, values: Record<string, string>) => {
    setGalleryOpen(false)
    if (preset.id === "custom") {
      setEditing(null)
      // Pre-fill appsEnabled with every detected writable agent so the new
      // server shows up in their files automatically. The user can toggle
      // chips off afterwards if they want a Cognia-only entry.
      const defaults = await getDetectedWritableAgents()
      const appsEnabled: Record<string, boolean> = {}
      for (const id of defaults) appsEnabled[id] = true
      setCreating({
        name: "",
        transport: "stdio",
        config: { command: "", args: [] },
        enabled: true,
        appsEnabled,
      })
      return
    }
    const config = applyPresetFields(preset, values)
    try {
      const defaults = await getDetectedWritableAgents()
      const appsEnabled: Record<string, boolean> = {}
      for (const id of defaults) appsEnabled[id] = true
      await createMcpServer({
        name: preset.id,
        transport: preset.transport,
        config,
        enabled: true,
        appsEnabled,
      })
      loggers.mcp.info("settings.serverCreatedFromPreset", {
        presetId: preset.id,
        transport: preset.transport,
      })
      toast.success(tGallery("addedToast", { name: preset.name }))
    } catch (err) {
      loggers.mcp.error("settings.serverCreateFromPresetFailed", err, { presetId: preset.id })
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <Label className="flex items-center gap-2">
            <ServerIcon className="size-4" />
            {t("title")}
          </Label>
          <p className="text-xs text-muted-foreground">{t("description")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <McpImportDialog onImported={refreshAgentAvailability} />
          <Button size="sm" variant="outline" onClick={() => setGalleryOpen(true)}>
            <PlusIcon className="mr-1.5 size-3.5" />
            {t("addServer")}
          </Button>
        </div>
      </div>

      <McpPresetGalleryDialog
        open={galleryOpen}
        onOpenChange={setGalleryOpen}
        existingNames={servers.map((s) => s.name.toLowerCase())}
        onPresetSelected={onPresetSelected}
      />

      <McpAgentStatusBar />

      <McpDriftBanner />

      {servers.length === 0 && !creating ? (
        <p className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
          {tList("empty")}
        </p>
      ) : (
        <div className="space-y-2">
          {servers.length >= 4 && (
            <ServerListFilters
              search={search}
              onSearchChange={setSearch}
              transport={transportFilter}
              onTransportChange={setTransportFilter}
              status={statusFilter}
              onStatusChange={setStatusFilter}
              total={servers.length}
              shown={visibleServers.length}
            />
          )}
          {visibleServers.length === 0 && filtersActive ? (
            <p className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
              {tList("noMatch")}{" "}
              <button
                type="button"
                className="underline hover:text-foreground"
                onClick={() => {
                  setSearch("")
                  setTransportFilter("all")
                  setStatusFilter("all")
                }}
              >
                {tList("clearFilters")}
              </button>
            </p>
          ) : (
            visibleServers.map((s) => (
              <ServerRow
                key={s.id}
                server={s}
                editing={editing?.id === s.id}
                onEditStart={() => setEditing(s)}
                onEditCancel={() => setEditing(null)}
                onSave={async (patch) => {
                  try {
                    await updateMcpServer(s.id, patch)
                    loggers.mcp.info("settings.serverUpdated", { id: s.id })
                    setEditing(null)
                    toast.success(t("toasts.updated"))
                  } catch (err) {
                    loggers.mcp.error("settings.serverUpdateFailed", err, { id: s.id })
                    throw err
                  }
                }}
                onToggle={async (enabled) => {
                  try {
                    await updateMcpServer(s.id, { enabled })
                    loggers.mcp.info("settings.serverToggled", { id: s.id, enabled })
                  } catch (err) {
                    loggers.mcp.error("settings.serverToggleFailed", err, { id: s.id })
                    throw err
                  }
                }}
                onDelete={async () => {
                  try {
                    await deleteMcpServer(s.id)
                    loggers.mcp.info("settings.serverDeleted", { id: s.id })
                    toast.success(t("toasts.removed", { name: s.name }))
                  } catch (err) {
                    loggers.mcp.error("settings.serverDeleteFailed", err, { id: s.id })
                    throw err
                  }
                }}
              />
            ))
          )}
        </div>
      )}

      {creating && (
        <ServerEditor
          initial={creating}
          onCancel={() => setCreating(null)}
          onSave={async (data) => {
            // Merge the smart-default appsEnabled set by the gallery (the
            // editor doesn't round-trip it). Without this, hand-crafted
            // servers would land in Cognia only — never in any agent file.
            try {
              await createMcpServer({
                ...data,
                appsEnabled: creating.appsEnabled,
              })
              loggers.mcp.info("settings.serverCreated", {
                name: data.name,
                transport: data.transport,
              })
              setCreating(null)
              toast.success(t("toasts.added"))
            } catch (err) {
              loggers.mcp.error("settings.serverCreateFailed", err, { name: data.name })
              throw err
            }
          }}
        />
      )}
    </div>
  )
}

// ---- Preset gallery -------------------------------------------------------

interface GalleryProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  existingNames: string[]
  onPresetSelected: (preset: McpPreset, values: Record<string, string>) => void
}

function McpPresetGalleryDialog({
  open,
  onOpenChange,
  existingNames,
  onPresetSelected,
}: GalleryProps) {
  const t = useTranslations("mcp.gallery")
  const [selected, setSelected] = useState<McpPreset | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [query, setQuery] = useState("")
  const [activeTag, setActiveTag] = useState<string | null>(null)

  // Reset internal state when the dialog closes.
  const handleOpenChange = (next: boolean) => {
    onOpenChange(next)
    if (!next) {
      setSelected(null)
      setValues({})
      setQuery("")
      setActiveTag(null)
    }
  }

  // Tag chips: union of all preset tags, sorted, plus "Custom" as a sentinel.
  const allTags = useMemo(() => {
    const set = new Set<string>()
    for (const p of MCP_PRESETS) {
      for (const t of p.tags ?? []) set.add(t)
    }
    return Array.from(set).sort()
  }, [])

  const presets = useMemo(() => {
    const q = query.trim().toLowerCase()
    return MCP_PRESETS.filter((p) => {
      if (activeTag && !(p.tags ?? []).includes(activeTag)) return false
      if (!q) return true
      const haystack = [p.name, p.description, p.id, ...(p.tags ?? [])].join(" ").toLowerCase()
      return haystack.includes(q)
    })
  }, [query, activeTag])
  const nameTaken = selected ? existingNames.includes(selected.id.toLowerCase()) : false

  const handlePick = (preset: McpPreset) => {
    if (preset.fields.length === 0) {
      // No required fields → submit immediately.
      onPresetSelected(preset, {})
      handleOpenChange(false)
      return
    }
    setSelected(preset)
    const initial: Record<string, string> = {}
    for (const f of preset.fields) {
      const env = (preset.config.env as Record<string, string> | undefined) ?? {}
      initial[f.key] = env[f.key] ?? ""
    }
    setValues(initial)
  }

  const handleSubmit = () => {
    if (!selected) return
    onPresetSelected(selected, values)
    handleOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ServerIcon className="size-4" />
            {selected ? t("configureTitle", { name: selected.name }) : t("title")}
          </DialogTitle>
          <DialogDescription>{selected ? selected.description : t("subtitle")}</DialogDescription>
        </DialogHeader>

        {!selected ? (
          <div className="space-y-2">
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("search")}
                className="h-8 pl-8 text-xs"
              />
            </div>
            {allTags.length > 0 && (
              <div className="flex flex-wrap items-center gap-1">
                <button
                  type="button"
                  onClick={() => setActiveTag(null)}
                  className={cn(
                    "inline-flex h-5 items-center rounded-full border px-2 text-[10px] uppercase tracking-wider transition-colors",
                    activeTag == null
                      ? "border-primary/40 bg-primary text-primary-foreground"
                      : "border-border text-muted-foreground hover:border-primary/40 hover:bg-accent"
                  )}
                >
                  {t("tagAll")}
                </button>
                {allTags.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setActiveTag((prev) => (prev === t ? null : t))}
                    className={cn(
                      "inline-flex h-5 items-center rounded-full border px-2 text-[10px] uppercase tracking-wider transition-colors",
                      activeTag === t
                        ? "border-primary/40 bg-primary text-primary-foreground"
                        : "border-border text-muted-foreground hover:border-primary/40 hover:bg-accent"
                    )}
                  >
                    {t}
                  </button>
                ))}
              </div>
            )}
            {presets.length === 0 ? (
              <p className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
                {t("noMatch")}
              </p>
            ) : (
              <div className="grid max-h-[55vh] grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
                {presets.map((p) => {
                  const taken = existingNames.includes(p.id.toLowerCase())
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className="group flex flex-col items-start gap-1 rounded-md border bg-card p-3 text-left text-sm transition-colors hover:border-primary/40 hover:bg-accent disabled:opacity-50"
                      onClick={() => handlePick(p)}
                      disabled={taken && p.id !== "custom"}
                    >
                      <div className="flex w-full items-center gap-2">
                        <span className="text-xl leading-none">{p.icon}</span>
                        <span className="flex-1 truncate font-medium">{p.name}</span>
                        {taken && p.id !== "custom" && (
                          <span className="text-[10px] text-muted-foreground">
                            {t("addedBadge")}
                          </span>
                        )}
                      </div>
                      <p className="line-clamp-2 text-[11px] text-muted-foreground">
                        {p.description}
                      </p>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {nameTaken && (
              <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-200">
                {t("duplicateName", { name: selected.id })}
              </p>
            )}
            {selected.fields.map((field) => (
              <div key={field.key} className="space-y-1">
                <Label className="text-xs">{field.label}</Label>
                <Input
                  type={field.secret ? "password" : "text"}
                  placeholder={field.placeholder}
                  value={values[field.key] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                  className="text-xs"
                />
                {field.description && (
                  <p className="text-[10px] text-muted-foreground">{field.description}</p>
                )}
              </div>
            ))}
            {selected.docsUrl && (
              <a
                href={selected.docsUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground hover:underline"
              >
                <ExternalLinkIcon className="size-3" />
                {t("docs")}
              </a>
            )}
            <div className="flex justify-between gap-2 pt-2">
              <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
                {t("back")}
              </Button>
              <Button
                size="sm"
                onClick={handleSubmit}
                disabled={nameTaken || selected.fields.some((f) => !values[f.key]?.trim())}
              >
                {t("addServer")}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ---- Server list filters --------------------------------------------------

interface ServerListFiltersProps {
  search: string
  onSearchChange: (next: string) => void
  transport: TransportFilter
  onTransportChange: (next: TransportFilter) => void
  status: StatusFilter
  onStatusChange: (next: StatusFilter) => void
  total: number
  shown: number
}

function ServerListFilters({
  search,
  onSearchChange,
  transport,
  onTransportChange,
  status,
  onStatusChange,
  total,
  shown,
}: ServerListFiltersProps) {
  const tFilter = useTranslations("mcp.filter")
  const tList = useTranslations("mcp.list")
  const transports: Array<{ id: TransportFilter; label: string }> = [
    { id: "all", label: tFilter("all") },
    { id: "stdio", label: "stdio" },
    { id: "sse", label: "sse" },
    { id: "http", label: "http" },
  ]
  const statuses: Array<{ id: StatusFilter; label: string }> = [
    { id: "all", label: tFilter("all") },
    { id: "enabled", label: tFilter("enabled") },
    { id: "disabled", label: tFilter("disabled") },
  ]
  return (
    <div className="space-y-2 rounded-md border bg-muted/20 p-2">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={tList("searchPlaceholder")}
            className="h-7 pl-8 text-xs"
          />
        </div>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {shown === total ? `${total}` : `${shown}/${total}`}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wider">
        <span className="text-muted-foreground">{tFilter("transport")}</span>
        <div className="flex gap-1">
          {transports.map((t) => (
            <FilterChip
              key={t.id}
              active={transport === t.id}
              onClick={() => onTransportChange(t.id)}
              label={t.label}
            />
          ))}
        </div>
        <span className="ml-2 text-muted-foreground">{tFilter("status")}</span>
        <div className="flex gap-1">
          {statuses.map((s) => (
            <FilterChip
              key={s.id}
              active={status === s.id}
              onClick={() => onStatusChange(s.id)}
              label={s.label}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function FilterChip({
  active,
  onClick,
  label,
}: {
  active: boolean
  onClick: () => void
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex h-5 items-center rounded-full border px-2 text-[10px] uppercase tracking-wider transition-colors",
        active
          ? "border-primary/40 bg-primary text-primary-foreground"
          : "border-border text-muted-foreground hover:border-primary/40 hover:bg-accent"
      )}
    >
      {label}
    </button>
  )
}

interface RowProps {
  server: McpServer
  editing: boolean
  onEditStart: () => void
  onEditCancel: () => void
  onSave: (patch: Pick<McpServer, "name" | "transport" | "config" | "enabled">) => Promise<void>
  onToggle: (enabled: boolean) => Promise<void>
  onDelete: () => Promise<void>
}

function ServerRow({
  server,
  editing,
  onEditStart,
  onEditCancel,
  onSave,
  onToggle,
  onDelete,
}: RowProps) {
  const tRow = useTranslations("mcp.row")
  const tDelete = useTranslations("mcp.delete")
  const tTest = useTranslations("mcp.test")
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<McpTestResult | null>(null)

  const runTest = async () => {
    if (testing) return
    if (!isTauri()) {
      toast.error(tTest("desktopOnly"))
      return
    }
    setTesting(true)
    try {
      loggers.mcp.info("settings.serverTestStarted", { id: server.id, transport: server.transport })
      const result = await testMcpServer(serverToTestRequest(server))
      setTestResult(result)
      loggers.mcp.info("settings.serverTestResult", {
        id: server.id,
        ok: result.ok,
        error: result.ok ? undefined : result.error,
      })
      if (result.ok) {
        toast.success(tTest("success", { name: server.name, count: result.toolCount }))
      } else {
        toast.error(
          tTest("error", { name: server.name, error: result.error ?? tTest("unknownError") })
        )
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      loggers.mcp.error("settings.serverTestThrew", err)
      setTestResult({
        ok: false,
        toolCount: 0,
        tools: [],
        error: message,
        durationMs: 0,
      })
      toast.error(tTest("error", { name: server.name, error: message }))
    } finally {
      setTesting(false)
    }
  }

  if (editing) {
    return <ServerEditor initial={server} onCancel={onEditCancel} onSave={onSave} />
  }
  return (
    <Card className={cn("space-y-2 p-3", !server.enabled && "opacity-70")}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <p className="truncate text-sm font-medium">{server.name}</p>
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
            {server.transport}
          </span>
          {testResult && (
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]",
                testResult.ok
                  ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  : "bg-destructive/10 text-destructive"
              )}
              title={
                testResult.ok ? testResult.tools.map((t) => t.name).join(", ") : testResult.error
              }
            >
              {testResult.ok ? (
                <>
                  <CheckCircle2Icon className="size-3" />
                  {testResult.toolCount === 1
                    ? tRow("toolsOne", { count: testResult.toolCount })
                    : tRow("toolsOther", { count: testResult.toolCount })}
                </>
              ) : (
                <>
                  <XCircleIcon className="size-3" />
                  {tRow("failed")}
                </>
              )}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Switch
            checked={server.enabled}
            onCheckedChange={(v) => void onToggle(v)}
            aria-label={
              server.enabled
                ? tRow("disableSwitch", { name: server.name })
                : tRow("enableSwitch", { name: server.name })
            }
          />
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => void runTest()}
            disabled={testing || !isTauri()}
            aria-label={tRow("test", { name: server.name })}
            title={isTauri() ? tRow("testTooltip") : tRow("testDesktopOnly")}
          >
            {testing ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <PlayIcon className="size-3.5" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={onEditStart}
            aria-label={tRow("edit", { name: server.name })}
          >
            <PencilIcon className="size-3.5" />
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground hover:text-destructive"
                aria-label={tRow("delete", { name: server.name })}
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{tDelete("title")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {tDelete("body", { name: server.name })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{tDelete("cancel")}</AlertDialogCancel>
                <AlertDialogAction onClick={() => void onDelete()}>
                  {tDelete("confirm")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
      <p className="line-clamp-1 break-all font-mono text-[11px] text-muted-foreground">
        {summarize(server)}
      </p>
      <McpAgentChipGroup server={server} />
    </Card>
  )
}

type EditorInitial = Pick<McpServer, "name" | "transport" | "config" | "enabled" | "appsEnabled">

interface EditorProps {
  initial: EditorInitial
  onCancel: () => void
  onSave: (data: EditorInitial) => Promise<void>
}

interface KvRow {
  key: string
  value: string
}

function objectToKvRows(obj: unknown): KvRow[] {
  if (!obj || typeof obj !== "object") return []
  return Object.entries(obj as Record<string, unknown>).map(([k, v]) => ({
    key: k,
    value: String(v ?? ""),
  }))
}

function kvRowsToObject(rows: KvRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const row of rows) {
    const k = row.key.trim()
    if (k) out[k] = row.value
  }
  return out
}

function ServerEditor({ initial, onCancel, onSave }: EditorProps) {
  const tErrors = useTranslations("mcp.editor.errors")
  const [name, setName] = useState(initial.name)
  const [transport, setTransport] = useState<McpTransport>(initial.transport)
  const [enabled, setEnabled] = useState(initial.enabled)
  const [saving, setSaving] = useState(false)

  // Structured state — primary source of truth for stdio.
  const [command, setCommand] = useState(
    typeof initial.config?.command === "string" ? (initial.config.command as string) : ""
  )
  const [argsText, setArgsText] = useState(
    Array.isArray(initial.config?.args)
      ? ((initial.config.args as unknown[]).filter((x) => typeof x === "string") as string[]).join(
          "\n"
        )
      : ""
  )
  const [envRows, setEnvRows] = useState<KvRow[]>(
    objectToKvRows((initial.config as Record<string, unknown>)?.env)
  )
  const [url, setUrl] = useState(
    typeof initial.config?.url === "string" ? (initial.config.url as string) : ""
  )
  const [headerRows, setHeaderRows] = useState<KvRow[]>(
    objectToKvRows((initial.config as Record<string, unknown>)?.headers)
  )

  // Raw-JSON fallback view, hydrated from the structured state on toggle.
  const [showJson, setShowJson] = useState(false)
  const [configText, setConfigText] = useState("")

  const buildConfig = (): Record<string, unknown> => {
    if (transport === "stdio") {
      const args = argsText
        .split("\n")
        .map((a) => a.trim())
        .filter(Boolean)
      const env = kvRowsToObject(envRows)
      const config: Record<string, unknown> = { command }
      if (args.length > 0) config.args = args
      if (Object.keys(env).length > 0) config.env = env
      return config
    }
    const headers = kvRowsToObject(headerRows)
    const config: Record<string, unknown> = { url }
    if (Object.keys(headers).length > 0) config.headers = headers
    return config
  }

  const switchToJson = () => {
    setConfigText(JSON.stringify(buildConfig(), null, 2))
    setShowJson(true)
  }

  const switchToForm = () => {
    try {
      const parsed = JSON.parse(configText) as Record<string, unknown>
      if (transport === "stdio") {
        setCommand(typeof parsed.command === "string" ? parsed.command : "")
        setArgsText(
          Array.isArray(parsed.args)
            ? (parsed.args as unknown[])
                .filter((x): x is string => typeof x === "string")
                .join("\n")
            : ""
        )
        setEnvRows(objectToKvRows(parsed.env))
      } else {
        setUrl(typeof parsed.url === "string" ? parsed.url : "")
        setHeaderRows(objectToKvRows(parsed.headers))
      }
      setShowJson(false)
    } catch (err) {
      toast.error(
        tErrors("jsonRevertFailed", { error: err instanceof Error ? err.message : String(err) })
      )
    }
  }

  const submit = async () => {
    if (!name.trim()) {
      toast.error(tErrors("nameRequired"))
      return
    }
    let config: Record<string, unknown>
    if (showJson) {
      try {
        config = JSON.parse(configText) as Record<string, unknown>
      } catch (err) {
        toast.error(
          tErrors("invalidJson", { error: err instanceof Error ? err.message : String(err) })
        )
        return
      }
    } else {
      config = buildConfig()
      if (transport === "stdio" && !command.trim()) {
        toast.error(tErrors("commandRequired"))
        return
      }
      if (transport !== "stdio" && !url.trim()) {
        toast.error(tErrors("urlRequired"))
        return
      }
    }
    setSaving(true)
    try {
      // Note: appsEnabled is intentionally NOT in the save payload — the
      // per-agent chip group is the only thing that writes it, so emitting
      // it here would race with chip clicks made while the editor is open.
      // Callers that need a default for *new* servers wrap createMcpServer
      // and merge appsEnabled themselves.
      await onSave({ name: name.trim(), transport, config, enabled })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="space-y-3 p-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-xs">Name</Label>
          <Input placeholder="filesystem" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Transport</Label>
          <Select value={transport} onValueChange={(v) => setTransport(v as McpTransport)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MCP_TRANSPORTS.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <Label className="text-xs">Config</Label>
        <button
          type="button"
          className="text-[10px] text-muted-foreground hover:text-foreground hover:underline"
          onClick={() => (showJson ? switchToForm() : switchToJson())}
        >
          {showJson ? "Show form" : "Show JSON"}
        </button>
      </div>

      {showJson ? (
        <Textarea
          rows={8}
          value={configText}
          onChange={(e) => setConfigText(e.target.value)}
          className="font-mono text-xs"
          spellCheck={false}
        />
      ) : transport === "stdio" ? (
        <div className="space-y-3 rounded-md border bg-muted/30 p-3">
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Command
            </Label>
            <Input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="npx"
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Arguments (one per line)
            </Label>
            <Textarea
              rows={4}
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/Users/me/work"}
              className="font-mono text-xs"
              spellCheck={false}
            />
          </div>
          <KvEditor
            label="Environment variables"
            rows={envRows}
            onChange={setEnvRows}
            keyPlaceholder="MY_TOKEN"
            valuePlaceholder="value"
          />
        </div>
      ) : (
        <div className="space-y-3 rounded-md border bg-muted/30 p-3">
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
              URL
            </Label>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/mcp"
              className="font-mono text-xs"
            />
          </div>
          <KvEditor
            label="Headers"
            rows={headerRows}
            onChange={setHeaderRows}
            keyPlaceholder="Authorization"
            valuePlaceholder="Bearer …"
          />
        </div>
      )}

      <p className="text-[10px] text-muted-foreground">
        Forwarded verbatim to <code className="font-mono">options.mcpServers[name]</code>. Values
        can reference env vars like <code className="font-mono">${"${HOME}"}</code> — the SDK
        substitutes them at run time.
      </p>

      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-xs">
          <Switch checked={enabled} onCheckedChange={setEnabled} />
          Enabled
        </label>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </Card>
  )
}

interface KvEditorProps {
  label: string
  rows: KvRow[]
  onChange: (rows: KvRow[]) => void
  keyPlaceholder?: string
  valuePlaceholder?: string
}

function KvEditor({ label, rows, onChange, keyPlaceholder, valuePlaceholder }: KvEditorProps) {
  const updateRow = (index: number, patch: Partial<KvRow>) => {
    onChange(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  }
  const removeRow = (index: number) => {
    onChange(rows.filter((_, i) => i !== index))
  }
  const addRow = () => {
    onChange([...rows, { key: "", value: "" }])
  }
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {label}
        </Label>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[10px]"
          onClick={addRow}
        >
          <PlusIcon className="mr-1 size-3" />
          Add
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="text-[10px] italic text-muted-foreground">No entries.</p>
      ) : (
        <div className="space-y-1">
          {rows.map((row, i) => (
            <div key={i} className="flex items-center gap-1">
              <Input
                value={row.key}
                onChange={(e) => updateRow(i, { key: e.target.value })}
                placeholder={keyPlaceholder}
                className="h-7 flex-1 font-mono text-xs"
              />
              <Input
                value={row.value}
                onChange={(e) => updateRow(i, { value: e.target.value })}
                placeholder={valuePlaceholder}
                className="h-7 flex-[2] font-mono text-xs"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground hover:text-destructive"
                onClick={() => removeRow(i)}
                aria-label="Remove row"
              >
                <Trash2Icon className="size-3" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function summarize(s: McpServer): string {
  const c = s.config as { command?: string; url?: string; args?: string[] }
  if (s.transport === "stdio") {
    return [c.command, ...(c.args ?? [])].filter(Boolean).join(" ")
  }
  return c.url ?? "(no url)"
}

function serverToTestRequest(s: McpServer): McpTestRequest {
  const c = s.config as Record<string, unknown>
  if (s.transport === "stdio") {
    return {
      transport: "stdio",
      command: typeof c.command === "string" ? c.command : "",
      args: Array.isArray(c.args) ? c.args.filter((x): x is string => typeof x === "string") : [],
      env:
        c.env && typeof c.env === "object"
          ? Object.fromEntries(
              Object.entries(c.env as Record<string, unknown>).map(([k, v]) => [k, String(v ?? "")])
            )
          : undefined,
    }
  }
  return {
    transport: s.transport,
    url: typeof c.url === "string" ? c.url : "",
    headers:
      c.headers && typeof c.headers === "object"
        ? Object.fromEntries(
            Object.entries(c.headers as Record<string, unknown>).map(([k, v]) => [
              k,
              String(v ?? ""),
            ])
          )
        : undefined,
  }
}
