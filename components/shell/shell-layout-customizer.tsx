"use client"

/**
 * The one place the desktop shell's chrome is customized: the left nav rail,
 * the top bar and the bottom bar, as three tabs over the same editor.
 *
 * They were separate before — the rail had a real pin/reorder/hide customizer,
 * while the two bars had a flat list of checkboxes buried in the Views menu
 * with no ordering at all. Putting them behind one tab strip means a user
 * looking for "where do I change what's in the chrome" finds all of it, and
 * means the rail's editor is the model the bars follow rather than a
 * second dialect.
 *
 * Hosted inline by the Settings section (`/settings?section=sidebar`) and, as a
 * dialog, by `shell-layout-dialog.tsx`, which the rail and both bars open from
 * their right-click menus.
 */

import * as React from "react"
import { useTranslations } from "next-intl"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { BarCustomizer } from "./bar-customizer"
import { SidebarCustomizer } from "./sidebar-customizer"
import { WorkbenchCustomizer } from "./workbench-customizer"
import { WorkbenchPanelCustomizer } from "./workbench-panel-customizer"

/** Which surface a customizer entry point should open on. */
export type ShellSurface = "sidebar" | "workbench" | "title" | "status"

export const SHELL_SURFACES: readonly ShellSurface[] = [
  "sidebar",
  // Next to the nav rail rather than at the end: the two are icon columns that
  // now sit side by side on the same edge, and a user reordering one expects
  // the other to be adjacent.
  "workbench",
  "title",
  "status",
] as const

export function ShellLayoutCustomizer({
  defaultSurface = "sidebar",
}: {
  /**
   * Tab to open on. Uncontrolled after mount — switching tabs is local state.
   * Callers that need a later change (the dialog, re-opened from a different
   * entry point) remount with a `key`, which is cheaper and simpler than
   * syncing a controlled value back down through an effect.
   */
  defaultSurface?: ShellSurface
}): React.ReactElement {
  const t = useTranslations("desktop.shellLayout")
  const [active, setActive] = React.useState<ShellSurface>(defaultSurface)

  // Every value Radix can emit here comes from a `TabsTrigger` this component
  // renders out of `SHELL_SURFACES`, so the cast is the whole validation.
  const handleChange = (value: string) => setActive(value as ShellSurface)

  return (
    <Tabs value={active} onValueChange={handleChange} data-testid="shell-layout-customizer">
      <TabsList className="w-full">
        {SHELL_SURFACES.map((s) => (
          <TabsTrigger key={s} value={s} className="flex-1" data-testid={`shell-layout-tab-${s}`}>
            {t(`tab.${s}`)}
          </TabsTrigger>
        ))}
      </TabsList>

      <TabsContent value="sidebar" className="mt-4 space-y-3">
        <p className="text-xs text-muted-foreground">{t("description.sidebar")}</p>
        <SidebarCustomizer />
      </TabsContent>
      <TabsContent value="workbench" className="mt-4 space-y-3">
        <p className="text-xs text-muted-foreground">{t("description.workbench")}</p>
        <WorkbenchCustomizer />
        {/* The two levels of the same surface, in the order the user meets
            them: the icon column, then the tabs inside whichever icon is in
            front. A separate tab for the panels would have made the user guess
            which of two entry points owned "the workbench". */}
        <WorkbenchPanelCustomizer />
      </TabsContent>
      <TabsContent value="title" className="mt-4 space-y-3">
        <p className="text-xs text-muted-foreground">{t("description.title")}</p>
        <BarCustomizer bar="title" />
      </TabsContent>
      <TabsContent value="status" className="mt-4 space-y-3">
        <p className="text-xs text-muted-foreground">{t("description.status")}</p>
        <BarCustomizer bar="status" />
      </TabsContent>
    </Tabs>
  )
}
