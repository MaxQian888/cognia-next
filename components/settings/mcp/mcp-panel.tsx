"use client"

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { useLiveQuery } from "dexie-react-hooks"
import { SearchIcon, ServerIcon } from "lucide-react"
import { toast } from "sonner"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { cn } from "@/lib/utils"
import { loggers } from "@/lib/logging"
import { MOBILE_DURATION, MOBILE_EASE } from "@/lib/ui/motion"
import {
  createMcpServer,
  deleteMcpServer,
  getMcpServer,
  listMcpServers,
  updateMcpServer,
} from "@/lib/db/mcp-servers"
import { applyPresetFields, type McpPreset } from "@/lib/claude/mcp-presets"
import { useMcpPanelStore, type McpPanelTab } from "@/stores/mcp/mcp-panel-store"
import { blankServerSeed } from "./server-seed"
import {
  CLAUDE_CODE_RELATED,
  RelatedSectionsStrip,
} from "@/components/settings/common/related-sections-strip"
import { McpAgentStatusBar } from "../mcp-agent-status-bar"
import { McpDriftBanner } from "../mcp-drift-banner"
import { McpMyServersTab } from "./mcp-my-servers-tab"
import { McpPresetGrid } from "./mcp-preset-grid"
import { McpHealthTab } from "./mcp-health-tab"
import { McpServerEditor } from "./mcp-server-editor"
import type { McpEditorInitial } from "./mcp-server-utils"

const TAB_ORDER: McpPanelTab[] = ["my-servers", "presets", "agents", "health"]

const TAB_LABEL_KEY: Record<McpPanelTab, string> = {
  "my-servers": "myServers",
  presets: "presets",
  agents: "agents",
  health: "health",
}

const BLANK_CONFIG = { command: "", args: [] as string[] }

/**
 * The MCP servers management panel — a four-tab surface (My Servers, Preset
 * Market, Agent Sync, Health & Logs) that replaces the legacy single-file
 * section. Tab state lives in `useMcpPanelStore`; the editor + delete dialogs
 * are hosted here so any tab can drive them.
 */
export function McpPanel({ className }: { className?: string }) {
  const t = useTranslations("mcp")
  const tTabs = useTranslations("mcp.tabs")
  const tPanel = useTranslations("mcp.panel")
  const tGallery = useTranslations("mcp.gallery")
  const activeTab = useMcpPanelStore((s) => s.activeTab)
  const setActiveTab = useMcpPanelStore((s) => s.setActiveTab)
  const search = useMcpPanelStore((s) => s.search)
  const setSearch = useMcpPanelStore((s) => s.setSearch)
  const openCreate = useMcpPanelStore((s) => s.openCreate)
  const reduce = useReducedMotion()

  // Lowercased names of the servers already configured, so the Preset Market can
  // flag / disable presets that are already added and warn on duplicates. The
  // preset id becomes the server name on add (see `onPresetSelected`), so a
  // case-insensitive name match is the right membership test.
  const liveServers = useLiveQuery(() => listMcpServers(), [])
  const existingNames = useMemo(
    () => (liveServers ?? []).map((s) => s.name.toLowerCase()),
    [liveServers]
  )

  const fade = reduce ? { duration: 0 } : { duration: MOBILE_DURATION.fast, ease: MOBILE_EASE }

  const onPresetSelected = async (preset: McpPreset, values: Record<string, string>) => {
    if (preset.id === "custom") {
      openCreate(await blankServerSeed())
      setActiveTab("my-servers")
      return
    }
    try {
      const seed = await blankServerSeed()
      await createMcpServer({
        name: preset.id,
        transport: preset.transport,
        config: applyPresetFields(preset, values),
        enabled: true,
        appsEnabled: seed.appsEnabled,
      })
      loggers.mcp.info("settings.serverCreatedFromPreset", { presetId: preset.id })
      toast.success(tGallery("addedToast", { name: preset.name }))
      setActiveTab("my-servers")
    } catch (err) {
      loggers.mcp.error("settings.serverCreateFromPresetFailed", err, { presetId: preset.id })
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div
      className={cn("relative flex h-full min-h-0 flex-col overflow-hidden", className)}
      data-testid="mcp-panel"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2 sm:gap-3 sm:px-4 sm:py-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <ServerIcon className="size-4 shrink-0" />
          <div className="min-w-0">
            <Label className="block truncate text-sm font-medium">{t("title")}</Label>
          </div>
        </div>
        {activeTab === "my-servers" && (
          <div className="relative order-last w-full sm:order-none sm:w-56 md:w-64">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={tPanel("searchPlaceholder")}
              className="h-9 pl-8 text-xs"
            />
          </div>
        )}
        <div className="min-w-0 max-w-full overflow-x-auto">
          <div
            role="tablist"
            aria-label={t("title")}
            className="inline-flex items-center gap-0.5 rounded-lg bg-muted p-[3px]"
          >
            {TAB_ORDER.map((tab) => {
              const active = activeTab === tab
              return (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setActiveTab(tab)}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors",
                    active
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {tTabs(TAB_LABEL_KEY[tab])}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-3 sm:p-4">
          <AnimatePresence initial={false}>
            <motion.div
              key={activeTab}
              initial={reduce ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? undefined : { opacity: 0, y: -4 }}
              transition={fade}
            >
              {activeTab === "my-servers" && <McpMyServersTab />}
              {activeTab === "presets" && (
                <McpPresetGrid existingNames={existingNames} onPresetSelected={onPresetSelected} />
              )}
              {activeTab === "agents" && (
                <div className="space-y-4">
                  <McpAgentStatusBar />
                  <McpDriftBanner />
                  <RelatedSectionsStrip current="mcp" targets={CLAUDE_CODE_RELATED} />
                </div>
              )}
              {activeTab === "health" && <McpHealthTab />}
            </motion.div>
          </AnimatePresence>
        </div>
      </ScrollArea>

      <McpEditorHost />
      <McpDeleteHost />
    </div>
  )
}

/** Hosts the create/edit editor inside a right-side Sheet. */
function McpEditorHost() {
  const t = useTranslations("mcp.editor")
  const tToasts = useTranslations("mcp.toasts")
  const editorTarget = useMcpPanelStore((s) => s.editorTarget)
  const closeEditor = useMcpPanelStore((s) => s.closeEditor)
  const open = editorTarget !== null

  // The row loads async (undefined on first render, and useLiveQuery retains
  // the *previous* row while re-querying after a target switch). Tag the result
  // with the id it was loaded for so loading/stale states are distinguishable —
  // the editor seeds its form state once at mount, so it must never mount with
  // a blank or stale `initial`.
  const existingQuery = useLiveQuery(
    () =>
      editorTarget?.mode === "edit"
        ? getMcpServer(editorTarget.serverId).then((row) => ({
            forId: editorTarget.serverId,
            row,
          }))
        : Promise.resolve(undefined),
    [editorTarget]
  )
  const existing =
    editorTarget?.mode === "edit" && existingQuery?.forId === editorTarget.serverId
      ? existingQuery.row
      : undefined
  const editorReady =
    editorTarget?.mode !== "edit" || existingQuery?.forId === editorTarget.serverId

  const initial: McpEditorInitial =
    editorTarget?.mode === "edit"
      ? {
          name: existing?.name ?? "",
          transport: existing?.transport ?? "stdio",
          config: existing?.config ?? {},
          enabled: existing?.enabled ?? true,
          appsEnabled: existing?.appsEnabled ?? {},
        }
      : (editorTarget?.seed ?? {
          name: "",
          transport: "stdio",
          config: { ...BLANK_CONFIG },
          enabled: true,
          appsEnabled: {},
        })

  const onSave = async (data: McpEditorInitial) => {
    try {
      if (editorTarget?.mode === "edit" && existing) {
        await updateMcpServer(existing.id, {
          name: data.name,
          transport: data.transport,
          config: data.config,
          enabled: data.enabled,
        })
        toast.success(tToasts("updated"))
      } else {
        // Merge the seed's appsEnabled (the editor doesn't round-trip it) so
        // hand-made / cloned servers still land in the target agent files.
        await createMcpServer({ ...data, appsEnabled: initial.appsEnabled })
        toast.success(tToasts("added"))
      }
      closeEditor()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      loggers.mcp.error("editor save failed", err)
    }
  }

  return (
    <Sheet open={open} onOpenChange={(o) => !o && closeEditor()}>
      <SheetContent side="right" className="w-full overflow-y-auto p-0 sm:max-w-xl">
        <SheetHeader className="border-b px-5 py-3">
          <SheetTitle>
            {editorTarget?.mode === "edit" ? t("editTitle") : t("createTitle")}
          </SheetTitle>
          <SheetDescription>{t("config")}</SheetDescription>
        </SheetHeader>
        <div className="px-5 py-4">
          {/* Key by target so the form re-seeds when switching rows; hold off
              mounting until the edited row has loaded so the one-shot seed
              never captures a blank/stale `initial`. */}
          {editorReady && (
            <McpServerEditor
              key={editorTarget?.mode === "edit" ? editorTarget.serverId : "create"}
              initial={initial}
              onCancel={closeEditor}
              onSave={onSave}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

/** Hosts the delete confirmation dialog. */
function McpDeleteHost() {
  const t = useTranslations("mcp.delete")
  const tToasts = useTranslations("mcp.toasts")
  const target = useMcpPanelStore((s) => s.deleteTarget)
  const setTarget = useMcpPanelStore((s) => s.setDeleteTarget)

  return (
    <AlertDialog open={target !== null} onOpenChange={(o) => !o && setTarget(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("body", { name: target?.name ?? "" })}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              if (!target) return
              void deleteMcpServer(target.serverId)
                .then(() => {
                  toast.success(tToasts("removed", { name: target.name }))
                  loggers.mcp.info("settings.serverDeleted", { id: target.serverId })
                })
                .catch((err) => {
                  toast.error(err instanceof Error ? err.message : String(err))
                  loggers.mcp.error("settings.serverDeleteFailed", err, { id: target.serverId })
                })
                .finally(() => setTarget(null))
            }}
          >
            {t("confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
