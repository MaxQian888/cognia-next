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
 * and both read the same `useDeviceRows` projection, so a row can never say
 * one thing here and another on the desktop.
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { useRouter, useSearchParams } from "next/navigation"
import { PlusIcon, RefreshCwIcon } from "lucide-react"

import { AddHostSheet } from "@/components/devices/add-host-sheet"
import { DeviceDetail } from "@/components/devices/device-detail"
import { DeviceListPane } from "@/components/devices/device-list-pane"
import { ExecutionHostChip } from "@/components/devices/execution-host-switcher"
import { PullToRefresh } from "@/components/interactions/pull-to-refresh"
import { ResponsiveDetailSheet } from "@/components/shared/responsive-detail-sheet"
import { Button } from "@/components/ui/button"
import { useDeviceGrantActions } from "@/hooks/devices/use-device-grant-actions"
import { useDeviceRows } from "@/hooks/devices/use-device-rows"
import { remoteHostRef } from "@/lib/devices/build-device-rows"
import { isTauri } from "@/lib/platform/detect"
import { useDeviceConsoleStore } from "@/stores/devices/device-console-store"
import type { RemoteHost } from "@/stores/remote-host/remote-host-store"

export function DevicesMobileBody() {
  const t = useTranslations("devices")
  const router = useRouter()
  const searchParams = useSearchParams()
  const { rows, summary, refresh } = useDeviceRows()
  const actions = useDeviceGrantActions(refresh)

  const selectedRef = useDeviceConsoleStore((state) => state.selectedRef)
  const search = useDeviceConsoleStore((state) => state.search)
  const kindFilter = useDeviceConsoleStore((state) => state.kindFilter)
  const select = useDeviceConsoleStore((state) => state.select)
  const setSearch = useDeviceConsoleStore((state) => state.setSearch)
  const setKindFilter = useDeviceConsoleStore((state) => state.setKindFilter)

  /**
   * The detail sheet is opened by a tap, not by the store's selection.
   *
   * Selection survives navigation (it is what the desktop reopens on), so
   * deriving "open" from it would pop the sheet every time the user comes back
   * to this page.
   */
  const [detailOpen, setDetailOpen] = useState(false)
  const selected = rows.find((row) => row.ref === selectedRef) ?? null

  const addHostParam = searchParams.get("addHost")
  const seededBaseUrl = searchParams.get("baseUrl") ?? undefined
  const [addHostOpen, setAddHostOpen] = useState(() => Boolean(addHostParam))
  const [seenAddHostParam, setSeenAddHostParam] = useState(addHostParam)
  if (addHostParam !== seenAddHostParam) {
    setSeenAddHostParam(addHostParam)
    if (addHostParam) setAddHostOpen(true)
  }

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
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold">{t("title")}</h1>
          <p className="truncate text-xs text-muted-foreground">
            {t("summary", { online: summary.online, total: summary.total })}
          </p>
        </div>
        {/* Which machine this phone's calls land on, stated on the one screen
            that is about machines. */}
        <ExecutionHostChip />
        <Button
          size="icon"
          variant="ghost"
          className="size-8"
          aria-label={t("actions.refresh")}
          onClick={() => void refresh()}
        >
          <RefreshCwIcon className="size-4" />
        </Button>
        <Button
          size="icon"
          variant="outline"
          className="size-8"
          aria-label={t("actions.addHost")}
          onClick={() => setAddHostOpen(true)}
          data-testid="mobile-devices-add-host"
        >
          <PlusIcon className="size-4" />
        </Button>
      </header>

      {/*
        Pairing a phone is the other half of the fleet and it is a route, not a
        sheet: `/pair` owns the camera and the one-shot invitation flow.
      */}
      {rows.length <= 1 ? (
        <div className="shrink-0 border-b px-3 py-2">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            onClick={() => router.push(isTauri() ? "/settings?section=companion" : "/pair")}
            data-testid="mobile-devices-pair"
          >
            {t("actions.pair")}
          </Button>
        </div>
      ) : null}

      <PullToRefresh onRefresh={refresh} className="min-h-0 flex-1">
        <DeviceListPane
          rows={rows}
          selectedRef={selectedRef}
          search={search}
          kindFilter={kindFilter}
          onSearchChange={setSearch}
          onKindFilterChange={setKindFilter}
          onSelect={onSelect}
        />
      </PullToRefresh>

      <ResponsiveDetailSheet
        open={detailOpen && Boolean(selected)}
        onOpenChange={setDetailOpen}
        title={selected?.label ?? t("title")}
      >
        {/*
          The drawer caps itself at 85vh, and `DeviceDetail` is `h-full` with
          its own scroller. A bounded box between the two gives the scroller
          something definite to resolve against.
        */}
        <div className="h-[68vh] min-h-0">
          <DeviceDetail
            row={selected}
            actions={actions}
            onRepairHost={() => {
              setDetailOpen(false)
              setAddHostOpen(true)
            }}
          />
        </div>
      </ResponsiveDetailSheet>

      <AddHostSheet
        open={addHostOpen}
        onOpenChange={setAddHostOpen}
        initialBaseUrl={seededBaseUrl}
        onPaired={onPaired}
      />
    </div>
  )
}
