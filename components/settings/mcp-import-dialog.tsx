"use client"

// Multi-agent MCP import dialog. Three steps inside a single dialog:
//   1. Pick an Agent — see file path + parse status.
//   2. Preview the detected servers (checkboxes; default-all-selected).
//   3. Pick a strategy (skip / overwrite / duplicate) and confirm.
//
// On confirm, calls `importFromAgent` which delegates to bulkImportMcpServers
// and then flips `appsEnabled[agent]=true` for each imported name. CCSwitch
// semantics: on name collision, existing entries WIN — the only thing that
// changes is the per-agent flag.

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import { CheckCircle2Icon, DownloadIcon, FolderXIcon, Loader2Icon, ServerIcon } from "lucide-react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

import { MCP_AGENT_ADAPTERS } from "@/lib/claude/agents"
import { previewAgentImport, type AgentImportPreview } from "@/lib/claude/sync"
import { readAgentConfig } from "@/lib/claude/ipc"
import { isTauri } from "@/lib/tauri"
import type { AgentId } from "@/lib/claude/types"
import type { McpImportStrategy } from "@/lib/db/mcp-servers"

import { refreshAgentAvailability } from "./mcp-agent-chip-group"

interface AgentSlot {
  id: AgentId
  displayName: string
  description?: string
  /** Path on disk, or null if unsupported on this OS / unresolved yet. */
  path: string | null
  exists: boolean
  parseError?: string
  /** Number of servers we'd import. Pre-computed when the file exists. */
  draftCount: number
}

interface ImportDialogProps {
  /** Optional render-prop trigger; falls back to a default "Import…" button. */
  trigger?: React.ReactNode
  /** Fires after a successful import so the parent can refresh chip state. */
  onImported?: () => void
}

export function McpImportDialog({ trigger, onImported }: ImportDialogProps) {
  const t = useTranslations("mcp.import")
  const tRoot = useTranslations("mcp")
  const [open, setOpen] = useState(false)
  const [slots, setSlots] = useState<AgentSlot[]>([])
  const [picked, setPicked] = useState<AgentId | null>(null)
  const [preview, setPreview] = useState<AgentImportPreview | null>(null)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [strategy, setStrategy] = useState<McpImportStrategy>("skip")
  const [busy, setBusy] = useState(false)

  // Probe each agent on open. Cheap: parallel IPC.
  useEffect(() => {
    if (!open || !isTauri()) return
    let cancelled = false
    void Promise.all(
      MCP_AGENT_ADAPTERS.map(async (a) => {
        try {
          const cfg = await readAgentConfig(a.id)
          // Heuristic for the count: re-parse with the adapter so quirks apply.
          const drafts = cfg.parsed != null ? a.parse(cfg.parsed) : []
          return {
            id: a.id,
            displayName: a.displayName,
            description: a.description,
            path: cfg.path,
            exists: cfg.exists,
            parseError: cfg.parseError,
            draftCount: drafts.length,
          } satisfies AgentSlot
        } catch (err) {
          return {
            id: a.id,
            displayName: a.displayName,
            description: a.description,
            path: null,
            exists: false,
            parseError: err instanceof Error ? err.message : String(err),
            draftCount: 0,
          } satisfies AgentSlot
        }
      })
    ).then((next) => {
      if (!cancelled) setSlots(next)
    })
    return () => {
      cancelled = true
    }
  }, [open])

  // Reset on close so the next open starts clean. Done in the change
  // callback rather than an effect to avoid a setState-in-effect lint hit.
  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    if (!next) {
      setPicked(null)
      setPreview(null)
      setChosen(new Set())
      setStrategy("skip")
    }
  }

  const onPick = async (id: AgentId) => {
    setPicked(id)
    setPreview(null)
    setChosen(new Set())
    try {
      const p = await previewAgentImport(id)
      setPreview(p)
      setChosen(new Set(p.drafts.map((d) => d.name)))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const onConfirm = async () => {
    if (!picked || !preview) return
    setBusy(true)
    try {
      const filtered = preview.drafts.filter((d) => chosen.has(d.name))
      // We re-implement importFromAgent's read so we can pass the user's
      // selection. Easier: just call importFromAgent and trust strategy.
      // But we want to respect the unchecked items — that means skip them.
      // Pass `strategy` directly; for unchecked rows we don't write at all.
      const result = await importFromAgentWithSelection(picked, filtered, strategy)
      const parts: string[] = []
      if (result.created > 0) parts.push(t("created", { count: result.created }))
      if (result.updated > 0) parts.push(t("updated", { count: result.updated }))
      if (result.skipped > 0) parts.push(t("skipped", { count: result.skipped }))
      if (result.errored.length > 0) parts.push(t("errored", { count: result.errored.length }))
      toast.success(
        t("summary", {
          agent: picked,
          parts: parts.join(", ") || t("summaryNoChanges"),
        })
      )
      refreshAgentAvailability()
      onImported?.()
      handleOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const slotsBy = new Map(slots.map((s) => [s.id, s]))
  const pickedSlot = picked ? slotsBy.get(picked) : null

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" variant="outline" disabled={!isTauri()}>
            <DownloadIcon className="mr-1.5 size-3.5" />
            {tRoot("import")}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ServerIcon className="size-4" />
            {t("title")}
          </DialogTitle>
          <DialogDescription>
            {picked == null
              ? t("pickAgent")
              : t("reviewing", { agent: pickedSlot?.displayName ?? picked })}
          </DialogDescription>
        </DialogHeader>

        {!isTauri() ? (
          <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
            {t("desktopOnly")}
          </div>
        ) : picked == null ? (
          <ScrollArea className="max-h-[55vh]">
            <div className="space-y-1 pr-3">
              {slots.length === 0 ? (
                <SlotsLoading />
              ) : (
                slots.map((slot) => (
                  <AgentSlotButton key={slot.id} slot={slot} onClick={() => void onPick(slot.id)} />
                ))
              )}
            </div>
          </ScrollArea>
        ) : (
          <PreviewStep
            slot={pickedSlot ?? null}
            preview={preview}
            chosen={chosen}
            setChosen={setChosen}
            strategy={strategy}
            setStrategy={setStrategy}
          />
        )}

        <DialogFooter className="gap-2">
          {picked != null && (
            <Button variant="ghost" size="sm" onClick={() => setPicked(null)}>
              {t("back")}
            </Button>
          )}
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={() => handleOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button
            size="sm"
            disabled={!preview || chosen.size === 0 || busy}
            onClick={() => void onConfirm()}
          >
            {busy ? t("importing") : t("importN", { count: chosen.size })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SlotsLoading() {
  const t = useTranslations("mcp.import")
  return (
    <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
      <Loader2Icon className="size-3.5 animate-spin" />
      {t("probing")}
    </div>
  )
}

function AgentSlotButton({ slot, onClick }: { slot: AgentSlot; onClick: () => void }) {
  const t = useTranslations("mcp.import")
  const disabled = !slot.exists || slot.draftCount === 0 || !!slot.parseError
  const countLabel =
    slot.draftCount === 1
      ? t("serversCountOne", { count: slot.draftCount })
      : t("serversCountOther", { count: slot.draftCount })
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex w-full items-center gap-3 rounded-md border bg-card p-3 text-left text-xs transition-colors",
        !disabled && "hover:border-primary/40 hover:bg-accent",
        disabled && "opacity-50"
      )}
    >
      <div className="flex size-7 shrink-0 items-center justify-center rounded bg-muted">
        {slot.exists ? (
          <CheckCircle2Icon className="size-4 text-emerald-600" />
        ) : (
          <FolderXIcon className="size-4 text-muted-foreground" />
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="font-medium">{slot.displayName}</span>
          {slot.exists && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {countLabel}
            </span>
          )}
          {!slot.exists && slot.path && (
            <span className="text-[10px] text-muted-foreground">{t("notDetected")}</span>
          )}
          {!slot.path && (
            <span className="text-[10px] text-muted-foreground">{t("unsupported")}</span>
          )}
        </div>
        {slot.path && (
          <p className="truncate font-mono text-[10px] text-muted-foreground">{slot.path}</p>
        )}
        {slot.parseError && <p className="text-[10px] text-destructive">{slot.parseError}</p>}
      </div>
    </button>
  )
}

function PreviewStep({
  slot,
  preview,
  chosen,
  setChosen,
  strategy,
  setStrategy,
}: {
  slot: AgentSlot | null
  preview: AgentImportPreview | null
  chosen: Set<string>
  setChosen: (next: Set<string>) => void
  strategy: McpImportStrategy
  setStrategy: (s: McpImportStrategy) => void
}) {
  const t = useTranslations("mcp.import")
  if (!preview) {
    return <SlotsLoading />
  }
  if (preview.drafts.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
        {t("noEntries", { agent: slot?.displayName ?? "" })}
      </div>
    )
  }

  const toggle = (name: string) => {
    const next = new Set(chosen)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    setChosen(next)
  }

  return (
    <div className="space-y-3">
      <ScrollArea className="max-h-[35vh] rounded-md border">
        <div className="divide-y">
          {preview.drafts.map((d) => (
            <label
              key={d.name}
              className="flex cursor-pointer items-center gap-3 p-2.5 transition-colors hover:bg-accent"
            >
              <Checkbox checked={chosen.has(d.name)} onCheckedChange={() => toggle(d.name)} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium">{d.name}</span>
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
                    {d.transport}
                  </span>
                </div>
                <p className="line-clamp-1 font-mono text-[10px] text-muted-foreground">
                  {summarize(d.config, d.transport)}
                </p>
              </div>
            </label>
          ))}
        </div>
      </ScrollArea>

      <div className="space-y-1 text-xs">
        <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {t("onCollision")}
        </Label>
        <RadioGroup
          value={strategy}
          onValueChange={(v) => setStrategy(v as McpImportStrategy)}
          className="grid grid-cols-3 gap-2"
        >
          <StrategyChoice
            id="skip"
            value={strategy}
            label={t("strategySkip")}
            description={t("strategySkipDesc")}
          />
          <StrategyChoice
            id="overwrite"
            value={strategy}
            label={t("strategyOverwrite")}
            description={t("strategyOverwriteDesc")}
          />
          <StrategyChoice
            id="duplicate"
            value={strategy}
            label={t("strategyDuplicate")}
            description={t("strategyDuplicateDesc")}
          />
        </RadioGroup>
      </div>
    </div>
  )
}

function StrategyChoice({
  id,
  value,
  label,
  description,
}: {
  id: McpImportStrategy
  value: string
  label: string
  description: string
}) {
  const selected = value === id
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-2 rounded-md border p-2.5 text-xs transition-colors",
        selected ? "border-primary/40 bg-accent" : "hover:bg-accent/40"
      )}
    >
      <RadioGroupItem value={id} className="mt-0.5" />
      <div className="space-y-0.5">
        <div className="font-medium">{label}</div>
        <div className="text-[10px] text-muted-foreground">{description}</div>
      </div>
    </label>
  )
}

function summarize(cfg: Record<string, unknown>, transport: string): string {
  if (transport === "stdio") {
    const cmd = typeof cfg.command === "string" ? cfg.command : ""
    const args = Array.isArray(cfg.args) ? (cfg.args as string[]).join(" ") : ""
    return `${cmd} ${args}`.trim() || "(no command)"
  }
  return typeof cfg.url === "string" ? cfg.url : "(no url)"
}

/**
 * Import only the user-checked drafts. Routes through the same conflict
 * strategy as `importFromAgent` (which we can't call directly because it
 * imports *every* draft from the file).
 */
async function importFromAgentWithSelection(
  agentId: AgentId,
  drafts: import("@/lib/db/mcp-servers").McpImportDraft[],
  strategy: McpImportStrategy
) {
  const { bulkImportMcpServers, listMcpServers, updateMcpServer } =
    await import("@/lib/db/mcp-servers")
  const result = await bulkImportMcpServers(drafts, strategy)
  const importedNames = new Set(drafts.map((d) => d.name))
  const all = await listMcpServers()
  for (const server of all) {
    if (!importedNames.has(server.name)) continue
    const apps = { ...(server.appsEnabled ?? {}) }
    if (apps[agentId] === true) continue
    apps[agentId] = true
    await updateMcpServer(server.id, { appsEnabled: apps })
  }
  return result
}
