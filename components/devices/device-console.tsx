"use client"

/**
 * `/devices` — one console for every machine this account can reach.
 *
 * It replaces the reading half of two surfaces that could not see each other:
 * the paired-devices table in Settings → Companion and the host list in
 * Settings → Remote hosts. Pairing a phone and adding a host stay in Settings,
 * because those are configuration; this is the fleet view.
 *
 * Selection defaults to this machine. It is the one row that is always present
 * and always safe to show, and a console that reopens pinned to a phone that
 * has since been revoked is worse than one that reopens on the local device.
 */

import { useEffect } from "react"
import { useTranslations } from "next-intl"
import { RefreshCwIcon, ServerIcon, SmartphoneIcon } from "lucide-react"
import { useRouter } from "next/navigation"

import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { FeaturePageShell } from "@/components/feature-shell/feature-page-shell"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { useDeviceConsoleStore } from "@/stores/devices/device-console-store"
import { useDeviceGrantActions } from "@/hooks/devices/use-device-grant-actions"
import { useDeviceRows } from "@/hooks/devices/use-device-rows"

import { DeviceDetail } from "./device-detail"
import { DeviceListPane } from "./device-list-pane"

export function DeviceConsole() {
  const t = useTranslations("devices")
  const router = useRouter()
  const { rows, summary, hostUnreachable, refresh } = useDeviceRows()
  const actions = useDeviceGrantActions(refresh)

  const selectedRef = useDeviceConsoleStore((state) => state.selectedRef)
  const activeTab = useDeviceConsoleStore((state) => state.activeTab)
  const search = useDeviceConsoleStore((state) => state.search)
  const kindFilter = useDeviceConsoleStore((state) => state.kindFilter)
  const select = useDeviceConsoleStore((state) => state.select)
  const setActiveTab = useDeviceConsoleStore((state) => state.setActiveTab)
  const setSearch = useDeviceConsoleStore((state) => state.setSearch)
  const setKindFilter = useDeviceConsoleStore((state) => state.setKindFilter)

  const selected = rows.find((row) => row.ref === selectedRef) ?? null

  // Fall back to this machine whenever the selection points at nothing — on
  // first open, and also after a device is revoked and disappears from the
  // list, which would otherwise leave the pane empty with no explanation.
  useEffect(() => {
    if (selected || rows.length === 0) return
    const local = rows.find((row) => row.isSelf)
    if (local) select(local.ref)
  }, [rows, select, selected])

  return (
    <FeaturePageShell
      storageId="devices"
      header={
        <FeaturePageHeader
          variant="management"
          icon={<ServerIcon className="size-5" />}
          title={t("title")}
          description={t("description")}
          summary={t("summary", { online: summary.online, total: summary.total })}
          primaryAction={{
            id: "pair",
            label: t("actions.pair"),
            icon: SmartphoneIcon,
            onSelect: () => router.push("/settings?section=companion"),
          }}
          secondaryActions={[
            {
              id: "add-host",
              label: t("actions.addHost"),
              icon: ServerIcon,
              onSelect: () => router.push("/settings?section=remote-hosts"),
            },
            {
              id: "refresh",
              label: t("actions.refresh"),
              icon: RefreshCwIcon,
              onSelect: () => void refresh(),
            },
          ]}
          testId="devices-header"
        />
      }
      leftPane={{
        content: (
          <DeviceListPane
            rows={rows}
            selectedRef={selectedRef}
            search={search}
            kindFilter={kindFilter}
            onSearchChange={setSearch}
            onKindFilterChange={setKindFilter}
            onSelect={select}
          />
        ),
        label: t("listPane.label"),
        defaultSize: 26,
        minSize: 18,
        maxSize: 40,
      }}
      centerClassName="min-h-0"
    >
      <div className="flex h-full min-h-0 flex-col">
        {hostUnreachable ? (
          /**
           * Stated rather than swallowed: without the host, lifecycle state and
           * the raw capability sets come from the local mirror, so `partial`
           * grants and CLI-side suspensions cannot be detected.
           */
          <Alert className="m-3 mb-0" data-testid="device-host-unreachable">
            <AlertTitle>{t("hostUnreachableTitle")}</AlertTitle>
            <AlertDescription>{t("hostUnreachableBody")}</AlertDescription>
          </Alert>
        ) : null}
        <div className="min-h-0 flex-1">
          <DeviceDetail
            row={selected}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            actions={actions}
          />
        </div>
      </div>
    </FeaturePageShell>
  )
}
