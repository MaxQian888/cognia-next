"use client"

/**
 * Cmd-K command palette for the workflow editor. Three command groups:
 *
 *   1. Add nodes — every catalog entry (filtered by query). Selecting one
 *      drops the node at the canvas viewport center.
 *   2. Editor actions — Save / Run / Undo / Redo / Auto-layout / Export /
 *      Import / Open library.
 *   3. Recent workflows — links to the 5 most-recently-updated workflows
 *      so users can switch contexts without leaving the keyboard.
 */

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command"
import {
  Save as SaveIcon,
  Play as PlayIcon,
  Sparkles as SparklesIcon,
  Wand2 as WandIcon,
  Undo2 as UndoIcon,
  Redo2 as RedoIcon,
  LayoutGrid as LayoutIcon,
  Download as ExportIcon,
  Upload as ImportIcon,
  Library as LibraryIcon,
  PlusCircle as AddIcon,
  Workflow as WorkflowIcon,
} from "lucide-react"
import { listWorkflows } from "@/lib/db/workflows"
import { groupedCatalog, type NodeCatalogEntry } from "@/lib/workflow/nodes/catalog"
import { tNode } from "@/lib/workflow/i18n/node-translate"
import { CapabilityBadge, useMissingNodeCapabilities } from "./capability-badge"
import type { WorkflowNodeKind } from "@/types/workflow/visual"

export interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  currentWorkflowId: string
  onAddNode: (kind: WorkflowNodeKind) => void
  onSave: () => void
  onRun?: () => void
  onUndo?: () => void
  onRedo?: () => void
  onAutoLayout?: () => void
  /** Open the AI panel, either empty ("create") or scoped to the graph ("refine"). */
  onAskCopilot?: (mode: "create" | "refine") => void
  onExportJson?: () => void
  onImportJsonRequest?: () => void
}

export function CommandPalette({
  open,
  onOpenChange,
  currentWorkflowId,
  onAddNode,
  onSave,
  onRun,
  onUndo,
  onRedo,
  onAutoLayout,
  onAskCopilot,
  onExportJson,
  onImportJsonRequest,
}: CommandPaletteProps) {
  const router = useRouter()
  const t = useTranslations("workflows.commandPalette")
  const tNodes = useTranslations("workflows.nodes")
  const workflows = useLiveQuery(() => listWorkflows(), [])
  const [query, setQuery] = useState("")

  // Catalog grouped per category for the "Add node" section.
  const groups = useMemo(() => groupedCatalog({ includeDesktopOnly: true }), [])

  useEffect(() => {
    if (!open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setQuery("")
    }
  }, [open])

  const recentWorkflows = useMemo(
    () =>
      (workflows ?? [])
        .filter((w) => w.id !== currentWorkflowId)
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
        .slice(0, 5),
    [workflows, currentWorkflowId]
  )

  function close() {
    onOpenChange(false)
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput
        data-testid="workflow-command-palette-input"
        value={query}
        onValueChange={setQuery}
        placeholder={t("searchPlaceholder")}
      />
      <CommandList>
        <CommandEmpty>{t("empty")}</CommandEmpty>

        <CommandGroup heading={t("headings.editorActions")}>
          {/* Dify puts natural-language authoring behind `⌘K → /create`. The
              proposal flow already existed here; the only entry point was the
              AI panel's own composer, which an author had to find first. */}
          {onAskCopilot ? (
            <>
              <CommandItem
                value="create generate ai copilot"
                onSelect={() => {
                  onAskCopilot("create")
                  close()
                }}
                data-testid="wf-palette-create"
              >
                <SparklesIcon className="size-4 mr-2" />
                {t("commands.aiCreate")}
              </CommandItem>
              <CommandItem
                value="refine change ai copilot"
                onSelect={() => {
                  onAskCopilot("refine")
                  close()
                }}
                data-testid="wf-palette-refine"
              >
                <WandIcon className="size-4 mr-2" />
                {t("commands.aiRefine")}
              </CommandItem>
            </>
          ) : null}
          <CommandItem
            onSelect={() => {
              onSave()
              close()
            }}
          >
            <SaveIcon className="size-4 mr-2" />
            {t("commands.save")}
            <CommandShortcut>
              {/* i18n-exempt: physical keyboard shortcut */}
              Ctrl+S
            </CommandShortcut>
          </CommandItem>
          {onRun ? (
            <CommandItem
              onSelect={() => {
                onRun()
                close()
              }}
            >
              <PlayIcon className="size-4 mr-2" />
              {t("commands.run")}
            </CommandItem>
          ) : null}
          {onUndo ? (
            <CommandItem
              onSelect={() => {
                onUndo()
                close()
              }}
            >
              <UndoIcon className="size-4 mr-2" />
              {t("commands.undo")}
              <CommandShortcut>
                {/* i18n-exempt: physical keyboard shortcut */}
                Ctrl+Z
              </CommandShortcut>
            </CommandItem>
          ) : null}
          {onRedo ? (
            <CommandItem
              onSelect={() => {
                onRedo()
                close()
              }}
            >
              <RedoIcon className="size-4 mr-2" />
              {t("commands.redo")}
              <CommandShortcut>
                {/* i18n-exempt: physical keyboard shortcut */}
                Ctrl+Shift+Z
              </CommandShortcut>
            </CommandItem>
          ) : null}
          {onAutoLayout ? (
            <CommandItem
              onSelect={() => {
                onAutoLayout()
                close()
              }}
            >
              <LayoutIcon className="size-4 mr-2" />
              {t("commands.autoLayout")}
            </CommandItem>
          ) : null}
          {onExportJson ? (
            <CommandItem
              onSelect={() => {
                onExportJson()
                close()
              }}
            >
              <ExportIcon className="size-4 mr-2" />
              {t("commands.exportJson")}
            </CommandItem>
          ) : null}
          {onImportJsonRequest ? (
            <CommandItem
              onSelect={() => {
                onImportJsonRequest()
                close()
              }}
            >
              <ImportIcon className="size-4 mr-2" />
              {t("commands.importJson")}
            </CommandItem>
          ) : null}
          <CommandItem
            onSelect={() => {
              router.push("/workflows")
              close()
            }}
          >
            <LibraryIcon className="size-4 mr-2" />
            {t("commands.backToLibrary")}
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        {groups.map((g) => (
          <CommandGroup
            key={g.category}
            heading={t("headings.addCategory", { category: t(`categories.${g.category}`) })}
          >
            {g.entries.map((e) => {
              const label = tNode(tNodes, `${e.kind}.label`, e.label)
              return (
                <AddNodeItem
                  key={e.kind}
                  entry={e}
                  label={label}
                  onSelect={() => {
                    onAddNode(e.kind)
                    close()
                  }}
                />
              )
            })}
          </CommandGroup>
        ))}

        {recentWorkflows.length > 0 ? (
          <>
            <CommandSeparator />
            <CommandGroup heading={t("headings.recent")}>
              {recentWorkflows.map((wf) => (
                <CommandItem
                  key={wf.id}
                  value={`switch-${wf.id}-${wf.name}`}
                  onSelect={() => {
                    router.push(`/workflows/editor?id=${encodeURIComponent(wf.id)}`)
                    close()
                  }}
                >
                  <WorkflowIcon className="size-4 mr-2 shrink-0" />
                  <span className="flex-1">{wf.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}
      </CommandList>
    </CommandDialog>
  )
}

/**
 * One "Add node" row. Split out of the map so the per-entry capability check
 * (a hook — `useTranslations` inside) has a legal call site.
 */
function AddNodeItem({
  entry,
  label,
  onSelect,
}: {
  entry: NodeCatalogEntry
  label: string
  onSelect: () => void
}) {
  const capabilityInfo = useMissingNodeCapabilities(entry)
  return (
    <CommandItem
      value={`add-${entry.kind}-${label}-${entry.keywords.join(" ")}`}
      onSelect={onSelect}
    >
      <AddIcon className="size-4 mr-2 shrink-0" />
      <span className="flex-1">{label}</span>
      {capabilityInfo ? <CapabilityBadge info={capabilityInfo} className="mr-2" /> : null}
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {entry.kind}
      </span>
    </CommandItem>
  )
}
