"use client"

/**
 * Context Workbench panel quick-switch command palette.
 *
 * A globally-mounted `CommandDialog` (cmdk) that lets the user jump to any
 * panel registered in the currently-active workbench. Invoked via a keyboard
 * shortcut (`workbench.quickSwitch` — default `ctrl+shift+e`), it lists all
 * available panels grouped by activity, fuzzy-filtered by the search input.
 *
 * Mounted once in the desktop app shell alongside the activity shortcuts. The
 * underlying `revealActiveWorkbenchPanel` resolves against whichever workbench
 * is in front, so a single instance serves the chat dock, Canvas, the workflow
 * editor, and the project editor.
 */

import { useCallback, useState, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command"
import { useAppShortcut } from "@/hooks/shortcuts/use-app-shortcut"
import {
  getActiveContextRevision,
  getActiveWorkbenchPanels,
  revealActiveWorkbenchPanel,
  subscribeActiveContext,
} from "@/lib/context-workbench/active-context"
import type { ActiveContextPanel } from "@/lib/context-workbench/active-context"
import type { ContextActivity } from "@/types/context-workbench"
import { CONTEXT_ACTIVITY_RAIL_ORDER } from "@/types/context-workbench"

/** Activity order used for grouping panels in the palette. */
function activitySortIndex(activity: ContextActivity): number {
  const index = CONTEXT_ACTIVITY_RAIL_ORDER.indexOf(activity)
  return index === -1 ? CONTEXT_ACTIVITY_RAIL_ORDER.length : index
}

/** Groups panels by activity, ordered by the canonical rail order. */
function groupByActivity(
  panels: ActiveContextPanel[]
): Array<{ activity: ContextActivity; panels: ActiveContextPanel[] }> {
  const map = new Map<ContextActivity, ActiveContextPanel[]>()
  for (const panel of panels) {
    const group = map.get(panel.activity) ?? []
    group.push(panel)
    map.set(panel.activity, group)
  }
  return [...map.entries()]
    .sort(([a], [b]) => activitySortIndex(a) - activitySortIndex(b))
    .map(([activity, grouped]) => ({ activity, panels: grouped }))
}

export function PanelQuickSwitch() {
  const t = useTranslations()
  const tContextWorkbench = useTranslations("contextWorkbench")
  const tQuickSwitch = useTranslations("contextWorkbench.quickSwitch")
  const [open, setOpen] = useState(false)

  // Subscribe to the active-context bus so the panel list updates when the
  // user switches workbenches or a plugin registers new panels.
  useSyncExternalStore(subscribeActiveContext, getActiveContextRevision, getActiveContextRevision)

  const groups = groupByActivity(getActiveWorkbenchPanels())

  // Register the global shortcut to toggle the palette.
  useAppShortcut(
    "workbench.quickSwitch",
    useCallback(() => setOpen((prev) => !prev), []),
    { preventDefault: true, editorSelectors: [".monaco-editor"] }
  )

  const handleSelect = useCallback((panelId: string) => {
    setOpen(false)
    revealActiveWorkbenchPanel(panelId)
  }, [])

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title={tQuickSwitch("title")}
      description={tQuickSwitch("description")}
    >
      <CommandInput
        placeholder={tQuickSwitch("placeholder")}
        data-testid="panel-quick-switch-input"
      />
      <CommandList>
        <CommandEmpty>{tQuickSwitch("empty")}</CommandEmpty>
        {groups.map(({ activity, panels: groupPanels }) => (
          <CommandGroup key={activity} heading={tContextWorkbench(`activities.${activity}`)}>
            {groupPanels.map((panel) => (
              <CommandItem
                key={panel.id}
                value={`${panel.label ?? panel.labelKey} ${activity} ${panel.id}`}
                onSelect={() => handleSelect(panel.id)}
                data-testid={`panel-quick-switch-item-${panel.id}`}
              >
                <span className="truncate">{panel.label ?? t(panel.labelKey as never)}</span>
                {panel.pluginId && (
                  <span className="ml-auto truncate text-xs text-muted-foreground">
                    {panel.pluginId}
                  </span>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  )
}
