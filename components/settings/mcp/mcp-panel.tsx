"use client"

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { useLiveQuery } from "dexie-react-hooks"
import { ClipboardPasteIcon, PlusIcon, ServerIcon, ShareIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
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
import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { cn } from "@/lib/utils"
import { loggers } from "@cognia/logging"
import { MOBILE_DURATION, MOBILE_EASE } from "@/lib/ui/motion"
import {
  createMcpServer,
  deleteMcpServer,
  getMcpServer,
  listMcpServers,
  updateMcpServer,
} from "@/lib/db/mcp-servers"
import { applyPresetFields, type McpPreset } from "@/lib/claude/mcp-presets"
import { useMcpPanelStore } from "@/stores/mcp/mcp-panel-store"
import { blankServerSeed } from "./server-seed"
import {
  CLAUDE_CODE_RELATED,
  RelatedSectionsStrip,
} from "@/components/settings/common/related-sections-strip"
import { McpAgentStatusBar } from "../mcp-agent-status-bar"
import { McpDriftBanner } from "../mcp-drift-banner"
import { McpImportDialog } from "../mcp-import-dialog"
import { refreshAgentAvailability } from "../mcp-agent-chip-group"
import { McpExportDialog } from "./mcp-export-dialog"
import { McpMyServersTab } from "./mcp-my-servers-tab"
import { McpPanelTabs } from "./mcp-panel-tabs"
import { McpPresetGrid } from "./mcp-preset-grid"
import { McpHealthTab } from "./mcp-health-tab"
import { McpServerEditor } from "./mcp-server-editor"
import { McpTransferDialog } from "./mcp-transfer-dialog"
import type { McpEditorInitial } from "./mcp-server-utils"

const BLANK_CONFIG = { command: "", args: [] as string[] }

/**
 * The MCP servers management panel — four tabs over one fixed-height frame.
 *
 * Two layout rules earn their keep here, because breaking either is what made
 * the previous version jump on every tab switch:
 *
 * 1. `AnimatePresence mode="wait"` with an opacity-only transition. In the
 *    default `"sync"` mode both the outgoing and incoming panel are in normal
 *    flow at once, so the container's height briefly doubles; a `y` offset on
 *    top of that made it visibly lurch.
 * 2. Every tab body fills `min-h-0 flex-1` and owns its own scroll container.
 *    Nothing here wraps the tabs in a shared ScrollArea, so a tall tab cannot
 *    change the height of the frame the tab bar sits in.
 */
export function McpPanel({ className }: { className?: string }) {
  const t = useTranslations("mcp")
  const tGallery = useTranslations("mcp.gallery")
  const activeTab = useMcpPanelStore((s) => s.activeTab)
  const setActiveTab = useMcpPanelStore((s) => s.setActiveTab)
  const openCreate = useMcpPanelStore((s) => s.openCreate)
  const setTransferOpen = useMcpPanelStore((s) => s.setTransferOpen)
  const openExport = useMcpPanelStore((s) => s.openExport)
  const reduce = useReducedMotion()

  // Lowercased names of the servers already configured, so the Preset Market can
  // flag / disable presets that are already added and warn on duplicates. The
  // preset id becomes the server name on add (see `onPresetSelected`), so a
  // case-insensitive name match is the right membership test.
  const liveServers = useLiveQuery(() => listMcpServers(), [])
  const servers = useMemo(() => liveServers ?? [], [liveServers])
  const existingNames = useMemo(() => servers.map((s) => s.name.toLowerCase()), [servers])
  const enabledCount = useMemo(() => servers.filter((s) => s.enabled).length, [servers])

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
        displayName: preset.name,
        origin: "preset",
        transport: preset.transport,
        config: applyPresetFields(preset, values),
        disallowedTools: preset.defaultDisallowedTools,
        enabled: false,
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
      <FeaturePageHeader
        icon={<ServerIcon />}
        title={t("title")}
        description={t("description")}
        summary={
          <span className="tabular-nums" data-testid="mcp-panel-counts">
            {t("panel.counts", { enabled: enabledCount, total: servers.length })}
          </span>
        }
        navigation={<McpPanelTabs />}
        actions={
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setTransferOpen(true)}
              data-testid="mcp-open-transfer"
            >
              <ClipboardPasteIcon className="size-3.5 sm:mr-1.5" />
              <span className="hidden sm:inline">{t("panel.paste")}</span>
            </Button>
            <McpImportDialog onImported={refreshAgentAvailability} />
            <Button
              size="sm"
              variant="outline"
              onClick={() => openExport([])}
              disabled={servers.length === 0}
              data-testid="mcp-open-export"
            >
              <ShareIcon className="size-3.5 sm:mr-1.5" />
              <span className="hidden sm:inline">{t("panel.exportAll")}</span>
            </Button>
            <Button size="sm" onClick={() => void blankServerSeed().then(openCreate)}>
              <PlusIcon className="size-3.5 sm:mr-1.5" />
              <span className="hidden sm:inline">{t("addServer")}</span>
            </Button>
          </>
        }
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={activeTab}
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reduce ? undefined : { opacity: 0 }}
            transition={fade}
            className="flex min-h-0 w-full flex-1 overflow-hidden"
          >
            {activeTab === "my-servers" && <McpMyServersTab />}
            {activeTab === "presets" && (
              <div className="min-h-0 w-full flex-1 overflow-y-auto p-3 sm:p-4">
                <McpPresetGrid existingNames={existingNames} onPresetSelected={onPresetSelected} />
              </div>
            )}
            {activeTab === "agents" && (
              <div className="min-h-0 w-full flex-1 space-y-4 overflow-y-auto p-3 sm:p-4">
                <McpAgentStatusBar />
                <McpDriftBanner />
                <RelatedSectionsStrip current="mcp" targets={CLAUDE_CODE_RELATED} />
              </div>
            )}
            {activeTab === "health" && (
              <div className="min-h-0 w-full flex-1 overflow-y-auto p-3 sm:p-4">
                <McpHealthTab />
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      <McpEditorHost />
      <McpDeleteHost />
      <McpTransferDialog onImported={refreshAgentAvailability} />
      <McpExportDialog />
    </div>
  )
}

/** Hosts the create/edit editor inside a right-side Sheet. */
function McpEditorHost() {
  const t = useTranslations("mcp.editor")
  const tToasts = useTranslations("mcp.toasts")
  const editorTarget = useMcpPanelStore((s) => s.editorTarget)
  const closeEditor = useMcpPanelStore((s) => s.closeEditor)
  const openDetail = useMcpPanelStore((s) => s.openDetail)
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
          disallowedTools: existing?.disallowedTools ?? [],
        }
      : (editorTarget?.seed ?? {
          name: "",
          transport: "stdio",
          config: { ...BLANK_CONFIG },
          enabled: false,
          appsEnabled: {},
          disallowedTools: [],
        })

  const onSave = async (data: McpEditorInitial) => {
    try {
      if (editorTarget?.mode === "edit" && existing) {
        await updateMcpServer(existing.id, {
          name: data.name,
          transport: data.transport,
          config: data.config,
          enabled: data.enabled,
          disallowedTools: data.disallowedTools,
        })
        toast.success(tToasts("updated"))
      } else {
        // Merge the seed's appsEnabled (the editor doesn't round-trip it) so
        // hand-made / cloned servers still land in the target agent files.
        const created = await createMcpServer({ ...data, appsEnabled: initial.appsEnabled })
        // Land the user on what they just created, so the tool switches and
        // agent projection for it are one glance away instead of a hunt.
        openDetail(created.id)
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
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-xl"
        data-testid="mcp-editor-sheet"
      >
        <SheetHeader className="shrink-0 border-b px-5 py-3">
          <SheetTitle>
            {editorTarget?.mode === "edit" ? t("editTitle") : t("createTitle")}
          </SheetTitle>
          <SheetDescription>{t("sheetSubtitle")}</SheetDescription>
        </SheetHeader>
        {/* The form scrolls; the header and the editor's own action row stay
            put, so a long env list can never push Save off-screen. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
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
