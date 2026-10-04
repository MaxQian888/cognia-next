"use client"

/**
 * `/devices` on a phone.
 *
 * `FeaturePageShell` does have a mobile branch, but it collapses the left pane
 * into a Sheet trigger. For a fleet console that is backwards: the list is not
 * a sidebar here, it is the page, and the detail is what should arrive on
 * demand. So this inverts the two and reuses both halves verbatim.
 *
 * Nothing about a device is re-modelled. `DeviceListPane` is the same
 * component the desktop rail renders, `DeviceDetail` is the same dashboard,
 * `useDeviceSelection` is the same selection, and both read the same
 * `useDeviceRows` projection, so a row can never say one thing here and
 * another on the desktop.
 *
 * Gaps this used to have against the desktop, each now closed by sharing the
 * desktop's piece rather than writing a second one:
 *
 *  * `?device=` was never read, so a ⌘K hit or a Settings link opened a list.
 *    A link now selects the device and opens its drawer.
 *  * The standalone explanation, the "local record" notice and the attention
 *    count were desktop-only. They are rail content now, so they are here.
 *  * "Pair a device" disappeared once there was a second device. Growing the
 *    fleet is one menu now, always in the header.
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { PlusIcon, QrCodeIcon, RefreshCwIcon, ServerIcon } from "lucide-react"

import { AddHostSheet } from "@/components/devices/add-host-sheet"
import { DeviceDetail } from "@/components/devices/device-detail"
import { DeviceListPane } from "@/components/devices/device-list-pane"
import { ExecutionHostChip } from "@/components/devices/execution-host-switcher"
import {
  HostUnreachableNotice,
  MissingDeviceLinkNotice,
  StandaloneFleetCard,
} from "@/components/devices/fleet-notices"
import { PullToRefresh } from "@/components/interactions/pull-to-refresh"
import { ResponsiveDetailSheet } from "@/components/shared/responsive-detail-sheet"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { MobileBackButton } from "@/components/mobile/shell/mobile-back-button"
import { useDeviceGrantActions } from "@/hooks/devices/use-device-grant-actions"
import { useDeviceRows } from "@/hooks/devices/use-device-rows"
import { useAddHostSheetState } from "@/hooks/devices/use-add-host-sheet-state"
import { useDeviceSelection } from "@/hooks/devices/use-device-selection"
import { useRefreshing } from "@/hooks/ui/use-refreshing"
import { remoteHostRef } from "@/lib/devices/build-device-rows"
import { devicePairHref } from "@/lib/devices/pair-entry"
import { hasHostRuntime } from "@/lib/platform/capabilities"
import { cn } from "@/lib/utils"
import { useDeviceConsoleStore } from "@/stores/devices/device-console-store"
import type { RemoteHost } from "@/stores/remote-host/remote-host-store"

export function DevicesMobileBody() {
  const t = useTranslations("devices")
  const router = useRouter()
  const { rows, summary, loading, hostUnreachable, refresh } = useDeviceRows()
  const actions = useDeviceGrantActions(refresh)
  const { refreshing, run: runRefresh } = useRefreshing(refresh)

  /**
   * The detail drawer is opened by a tap or a deep link, not by the store's
   * selection. Selection survives navigation (it is what the console reopens
   * on), so deriving "open" from it would pop the drawer every time the user
   * came back to this page.
   */
  const [detailOpen, setDetailOpen] = useState(false)
  const openDrawer = useCallback(() => setDetailOpen(true), [])
  const { selectedRef, selected, select, missingDeepLink, dismissMissingDeepLink } =
    useDeviceSelection({ rows, loading, onDeepLink: openDrawer })

  const search = useDeviceConsoleStore((state) => state.search)
  const kindFilter = useDeviceConsoleStore((state) => state.kindFilter)
  const attentionOnly = useDeviceConsoleStore((state) => state.attentionOnly)
  const setSearch = useDeviceConsoleStore((state) => state.setSearch)
  const setKindFilter = useDeviceConsoleStore((state) => state.setKindFilter)
  const setAttentionOnly = useDeviceConsoleStore((state) => state.setAttentionOnly)
  const clearFilters = useDeviceConsoleStore((state) => state.clearFilters)

  const addHost = useAddHostSheetState()
  const pairHref = devicePairHref()
  const standalone = !hasHostRuntime()

  const onSelect = useCallback(
    (ref: string) => {
      select(ref)
      setDetailOpen(true)
    },
    [select]
  )

  const onPaired = useCallback(
    (host: RemoteHost) => {
      select(remoteHostRef(host))
      setDetailOpen(true)
    },
    [select]
  )

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="devices-mobile-body">
      <header className="safe-area-pt flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <MobileBackButton />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold">{t("title")}</h1>
          <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="truncate">
              {t("summary", { online: summary.online, total: summary.total })}
            </span>
            {summary.needsAttention > 0 ? (
              // The count is a way to the rows it counted, as on the desktop.
              <button
                type="button"
                className={cn(
                  "shrink-0 rounded-sm text-amber-600 underline-offset-2 hover:underline dark:text-amber-400",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                )}
                aria-pressed={attentionOnly}
                onClick={() => {
                  setKindFilter("all")
                  setAttentionOnly(true)
                }}
                data-testid="mobile-devices-attention-count"
              >
                {t("attentionCount", { count: summary.needsAttention })}
              </button>
            ) : null}
          </p>
        </div>
        {/* Which machine this phone's calls land on, stated on the one screen
            that is about machines. */}
        <ExecutionHostChip />
        <Button
          size="icon"
          variant="ghost"
          className="size-8"
          aria-label={refreshing ? t("actions.refreshing") : t("actions.refresh")}
          disabled={refreshing}
          onClick={() =>
            void runRefresh().catch((error: unknown) =>
              toast.error(t("actions.refreshFailed"), {
                description: error instanceof Error ? error.message : String(error),
              })
            )
          }
          data-testid="mobile-devices-refresh"
        >
          <RefreshCwIcon className={cn("size-4", refreshing && "motion-safe:animate-spin")} />
        </Button>
        {/*
          Both ways to grow the fleet behind one control. Pairing is a route
          (`/pair` owns the camera and the one-shot invitation), adding a host
          is the sheet below.
        */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              variant="outline"
              className="size-8"
              aria-label={t("actions.grow")}
              data-testid="mobile-devices-add"
            >
              <PlusIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={() => router.push(pairHref)}
              data-testid="mobile-devices-pair"
            >
              <QrCodeIcon className="size-4" />
              {t("actions.pair")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => addHost.setOpen(true)}
              data-testid="mobile-devices-add-host"
            >
              <ServerIcon className="size-4" />
              {t("actions.addHost")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <PullToRefresh onRefresh={refresh} className="min-h-0 flex-1">
        <DeviceListPane
          rows={rows}
          selectedRef={selectedRef}
          search={search}
          kindFilter={kindFilter}
          attentionOnly={attentionOnly}
          onSearchChange={setSearch}
          onKindFilterChange={setKindFilter}
          onAttentionOnlyChange={setAttentionOnly}
          onClearFilters={clearFilters}
          onSelect={onSelect}
          notices={
            hostUnreachable || missingDeepLink ? (
              <>
                {missingDeepLink ? (
                  <MissingDeviceLinkNotice
                    deviceRef={missingDeepLink}
                    onDismiss={dismissMissingDeepLink}
                  />
                ) : null}
                {hostUnreachable ? <HostUnreachableNotice /> : null}
              </>
            ) : null
          }
          footer={
            standalone ? (
              <StandaloneFleetCard onAddHost={() => addHost.setOpen(true)} pairHref={pairHref} />
            ) : null
          }
        />
      </PullToRefresh>

      <ResponsiveDetailSheet
        open={detailOpen && Boolean(selected)}
        onOpenChange={setDetailOpen}
        // Not the device's name: the masthead directly under it already says
        // that, and the same label twice was the first thing the drawer read.
        title={t("detail.drawerTitle")}
      >
        {/*
          The drawer caps itself at 85vh, and `DeviceDetail` is `h-full` with
          its own scroller. A bounded box between the two gives the scroller
          something definite to resolve against.
        */}
        <div className="h-[72vh] min-h-0">
          <DeviceDetail
            row={selected}
            actions={actions}
            onRepairHost={() => {
              setDetailOpen(false)
              addHost.setOpen(true)
            }}
          />
        </div>
      </ResponsiveDetailSheet>

      <AddHostSheet
        open={addHost.open}
        onOpenChange={addHost.setOpen}
        initialBaseUrl={addHost.seededBaseUrl}
        onPaired={onPaired}
      />
    </div>
  )
}
