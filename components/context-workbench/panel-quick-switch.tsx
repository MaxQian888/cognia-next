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
import { resolveWorkbenchPanelLabel } from "@/lib/context-workbench/panel-label"
import type { ContextActivity } from "@/types/context-workbench"
import { CANONICAL_CONTEXT_ACTIVITIES, contextActivityRailIndex } from "@/types/context-workbench"

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
    .sort(([a], [b]) => contextActivityRailIndex(a) - contextActivityRailIndex(b))
    .map(([activity, grouped]) => ({ activity, panels: grouped }))
}

/** Whether the host owns this activity's name, or a plugin invented it. */
function isCanonicalActivity(activity: ContextActivity): boolean {
  return (CANONICAL_CONTEXT_ACTIVITIES as readonly string[]).includes(activity)
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

  const panelLabel = useCallback(
    (panel: ActiveContextPanel) => resolveWorkbenchPanelLabel(t, panel, panel.id),
    [t]
  )

  /**
   * Heading for one group.
   *
   * A plugin-contributed activity has no `contextWorkbench.activities.*` key —
   * the host cannot know a plugin's activity ids at build time — so the group
   * is named after the panel that created it, which is also what the rail
   * button beside it reads.
   */
  const groupHeading = (activity: ContextActivity, groupPanels: ActiveContextPanel[]): string =>
    isCanonicalActivity(activity)
      ? tContextWorkbench(`activities.${activity}` as never)
      : groupPanels[0]
        ? panelLabel(groupPanels[0])
        : activity

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
          <CommandGroup key={activity} heading={groupHeading(activity, groupPanels)}>
            {groupPanels.map((panel) => (
              <CommandItem
                key={panel.id}
                value={`${panelLabel(panel)} ${activity} ${panel.id}`}
                onSelect={() => handleSelect(panel.id)}
                data-testid={`panel-quick-switch-item-${panel.id}`}
              >
                <span className="truncate">{panelLabel(panel)}</span>
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
