"use client"

/**
 * The Glance drawer: the phone's tray panel (ADR-0225 §9).
 *
 * A bottom drawer over whatever the phone shows, opened from the app bar. It
 * renders every visible module of the phone's layout in one container, the
 * same kit and visual language as the desktop panel, at touch size. Header:
 * where the data comes from (this phone, or the paired desktop and how it is
 * connected), the workspace scope, refresh. Footer: Edit, the preset switch,
 * and how fresh the reading is. Edit swaps the stack for the layout editor in
 * place; the drawer stays open. A click that opens an owner surface closes
 * the drawer behind it.
 */

import { useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import {
  CheckIcon,
  ChevronDownIcon,
  CloudOffIcon,
  MonitorIcon,
  RefreshCwIcon,
  SmartphoneIcon,
} from "lucide-react"
import { toast } from "sonner"

import { GlanceProvider } from "@/components/glance/glance-context"
import { GlancePresetMenu } from "@/components/glance/glance-preset-menu"
import { GlanceStack } from "@/components/glance/glance-stack"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useBackDismiss } from "@/hooks/ui/use-back-dismiss"
import { withMobilePreset } from "@/lib/glance/layout-edit"
import type { GlancePhoneStatus } from "@/lib/glance/remote/phone-store"
import { cn } from "@/lib/utils"
import { useProjectStore } from "@/stores/project/project-store"
import type { GlanceScope } from "@/types/glance/layout"

import { MobileGlanceEditor } from "./mobile-glance-editor"
import { useMobileGlanceContext } from "./mobile-glance-provider"
import { MobileGlanceQuickModule } from "./mobile-glance-quick-module"

const RENDERERS = { quick: MobileGlanceQuickModule }

/** The `glance.mobile.source.*` key for the header's source line. */
export function glanceSourceKey(
  paired: boolean,
  supported: boolean | null,
  status: GlancePhoneStatus
): string {
  if (!paired) return "source.device"
  if (supported === false || status === "unsupported") return "source.unsupported"
  if (supported === null) return "source.pending"
  switch (status) {
    case "live":
      return "source.live"
    case "offline":
      return "source.offline"
    case "unavailable":
      return "source.unavailable"
    case "connecting":
    case "idle":
      return "source.connecting"
  }
}

export function MobileGlanceDrawer() {
  const t = useTranslations("glance.mobile")
  const tGlance = useTranslations("glance")
  const format = useFormatter()
  const {
    drawerOpen,
    setDrawerOpen,
    settings,
    glance,
    remote,
    paired,
    supported,
    save,
  } = useMobileGlanceContext()
  const [editing, setEditing] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const workspace = useProjectStore((s) => s.projects.find((p) => p.id === s.activeProjectId))

  const onOpenChange = (open: boolean) => {
    setDrawerOpen(open)
    if (!open) setEditing(false)
  }

  // Android back closes the drawer (and leaves edit mode with it).
  useBackDismiss(drawerOpen, () => onOpenChange(false))

  const report = (errorKey: string | null) => {
    if (errorKey) toast.error(tGlance(errorKey))
  }

  const refresh = async () => {
    setRefreshing(true)
    try {
      report(await glance.send({ kind: "refresh" }))
    } finally {
      setRefreshing(false)
    }
  }

  const setScope = (scope: GlanceScope) => {
    if (scope !== settings.scope) void save({ ...settings, scope }).then(report)
  }

  const sourceKey = glanceSourceKey(paired, supported, remote.status)
  const host = remote.hostLabel ?? t("source.desktop")
  const live = !paired || remote.status === "live"
  const updatedAt = paired ? remote.receivedAt : glance.snapshot.generatedAt
  const visible = settings.entries.filter((entry) => !entry.hidden)

  return (
    <Drawer open={drawerOpen} onOpenChange={onOpenChange}>
      <DrawerContent
        className="flex max-h-[92vh] flex-col"
        data-testid="mobile-glance-drawer"
      >
        <DrawerHeader className="flex-row items-center gap-2 px-4 pb-2 pt-1 text-left">
          <div className="min-w-0 flex-1">
            <DrawerTitle className="text-base">{t("title")}</DrawerTitle>
            <DrawerDescription
              className={cn(
                "flex min-w-0 items-center gap-1 truncate text-xs",
                !live && paired && "text-warning"
              )}
              data-testid="mobile-glance-source"
            >
              {!paired ? (
                <SmartphoneIcon aria-hidden className="size-3 shrink-0" />
              ) : live ? (
                <MonitorIcon aria-hidden className="size-3 shrink-0" />
              ) : (
                <CloudOffIcon aria-hidden className="size-3 shrink-0" />
              )}
              <span className="truncate">{t(sourceKey, { host })}</span>
            </DrawerDescription>
          </div>
          {editing ? null : (
            <>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-10 max-w-[45%] gap-1 px-2 text-sm"
                    aria-label={t("scope.label")}
                    data-testid="mobile-glance-scope"
                  >
                    <span className="truncate">
                      {settings.scope === "workspace" && workspace
                        ? workspace.name
                        : t("scope.all")}
                    </span>
                    <ChevronDownIcon aria-hidden className="size-3.5 shrink-0" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-60">
                  <DropdownMenuLabel className="text-xs">{t("scope.label")}</DropdownMenuLabel>
                  <DropdownMenuItem onSelect={() => setScope("all")} className="min-h-11">
                    <CheckIcon className={cn("size-4", settings.scope !== "all" && "invisible")} />
                    {t("scope.all")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!workspace}
                    onSelect={() => setScope("workspace")}
                    className="min-h-11"
                  >
                    <CheckIcon
                      className={cn("size-4", settings.scope !== "workspace" && "invisible")}
                    />
                    {workspace
                      ? t("scope.workspace", { name: workspace.name })
                      : t("scope.noWorkspace")}
                  </DropdownMenuItem>
                  <p className="px-2 py-1 text-[11px] text-muted-foreground">{t("scope.hint")}</p>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-10 shrink-0"
                aria-label={t("refresh")}
                disabled={refreshing}
                onClick={() => void refresh()}
                data-testid="mobile-glance-refresh"
              >
                {refreshing ? (
                  <Spinner />
                ) : (
                  <RefreshCwIcon aria-hidden className="size-4" />
                )}
              </Button>
            </>
          )}
        </DrawerHeader>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3">
          {editing ? (
            <div className="px-1 pb-4 pt-1">
              <MobileGlanceEditor />
            </div>
          ) : visible.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
              <p className="text-sm text-muted-foreground">{t("empty")}</p>
              <Button type="button" variant="outline" onClick={() => setEditing(true)}>
                {t("addModules")}
              </Button>
            </div>
          ) : (
            <GlanceProvider value={glance}>
              <div className="overflow-hidden rounded-2xl border bg-background">
                <GlanceStack entries={settings.entries} renderers={RENDERERS} />
              </div>
            </GlanceProvider>
          )}
        </div>

        <DrawerFooter className="flex-row items-center gap-2 border-t px-4 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-2">
          <Button
            type="button"
            variant={editing ? "default" : "ghost"}
            size="sm"
            className="h-10 px-3"
            onClick={() => setEditing((on) => !on)}
            data-testid="mobile-glance-edit"
          >
            {editing ? t("done") : t("edit")}
          </Button>
          {editing ? null : (
            <GlancePresetMenu
              preset={settings.preset}
              onApply={(preset) => void save(withMobilePreset(settings, preset)).then(report)}
              side="top"
              className="h-10 text-sm text-muted-foreground"
            />
          )}
          <span
            className="ms-auto min-w-0 truncate text-xs tabular-nums text-muted-foreground"
            data-testid="mobile-glance-updated"
          >
            {updatedAt
              ? t("updated", {
                  when: format.relativeTime(new Date(updatedAt), Math.max(glance.now, updatedAt)),
                })
              : paired
                ? t("connecting")
                : null}
          </span>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  )
}
