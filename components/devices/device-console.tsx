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

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { RefreshCwIcon, ServerIcon, SmartphoneIcon } from "lucide-react"
import { useRouter, useSearchParams } from "next/navigation"

import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { FeaturePageShell } from "@/components/feature-shell/feature-page-shell"
import Link from "next/link"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useDeviceConsoleStore } from "@/stores/devices/device-console-store"
import { useDeviceGrantActions } from "@/hooks/devices/use-device-grant-actions"
import { useDeviceRows } from "@/hooks/devices/use-device-rows"
import { hasHostRuntime } from "@/lib/platform/capabilities"
import { isTauri } from "@/lib/platform/detect"
import { remoteHostRef } from "@/lib/devices/build-device-rows"
import type { RemoteHost } from "@/stores/remote-host/remote-host-store"

import { AddHostSheet } from "./add-host-sheet"
import { DeviceDetail } from "./device-detail"
import { ExecutionHostChip } from "./execution-host-switcher"
import { DeviceListPane } from "./device-list-pane"

export function DeviceConsole() {
  const t = useTranslations("devices")
  const router = useRouter()
  const searchParams = useSearchParams()
  const { rows, summary, hostUnreachable, refresh } = useDeviceRows()
  const actions = useDeviceGrantActions(refresh)

  const selectedRef = useDeviceConsoleStore((state) => state.selectedRef)
  const search = useDeviceConsoleStore((state) => state.search)
  const kindFilter = useDeviceConsoleStore((state) => state.kindFilter)
  const select = useDeviceConsoleStore((state) => state.select)
  const setSearch = useDeviceConsoleStore((state) => state.setSearch)
  const setKindFilter = useDeviceConsoleStore((state) => state.setKindFilter)

  const selected = rows.find((row) => row.ref === selectedRef) ?? null

  /**
   * Standalone: no host of our own and none paired.
   *
   * The same trichotomy `useFleetSnapshot` picks its source by, asked through
   * `hasHostRuntime` rather than the open-coded
   * `!isTauri() && !isCapacitor() && !hasWebCompanionTarget()`, which also
   * called the headless brain standalone. This is the surface contract's
   * `standalone: "explain"` state — the console keeps
   * working for this machine, and says which half is missing rather than
   * rendering a one-row "fleet".
   */
  const standalone = !hasHostRuntime()

  /**
   * Pairing a phone is a native flow on the desktop (Settings renders the QR)
   * but a route of its own everywhere else.
   *
   * Adding a host used to route too, to `/settings?section=remote-hosts`, and
   * that section is `profiles: ["desktop"]` in `settings-nav-config.ts`. On a
   * phone or a browser the button therefore delivered a settings empty state.
   * It is in-place now, so only pairing still navigates.
   */
  const pairHref = isTauri() ? "/settings?section=companion" : "/pair"

  /**
   * `?addHost=1&baseUrl=…` is how `/servers` and the palette hand a host over.
   *
   * Latched into state rather than read straight from the param, so closing
   * the sheet does not fight a URL that still says "open". The latch is
   * adjusted during render rather than in an effect: an effect would open the
   * sheet one paint late, and `react-hooks/set-state-in-effect` refuses it.
   */
  const addHostParam = searchParams.get("addHost")
  const seededBaseUrl = searchParams.get("baseUrl") ?? undefined
  const [addHostOpen, setAddHostOpen] = useState(() => Boolean(addHostParam))
  const [seenAddHostParam, setSeenAddHostParam] = useState(addHostParam)
  if (addHostParam !== seenAddHostParam) {
    setSeenAddHostParam(addHostParam)
    // Only a *new* param opens the sheet. Clearing it must not slam a sheet
    // the user opened from the header shut.
    if (addHostParam) setAddHostOpen(true)
  }

  const onPaired = useCallback(
    (host: RemoteHost) => {
      // `remoteHostRef` is the same identity `buildDeviceRows` assigns, so
      // this selects the row that was just created rather than a ref that
      // merely looks like one.
      select(remoteHostRef(host))
    },
    [select]
  )

  // A `?device=<ref>` deep link wins over whatever was last selected — it is
  // what ⌘K and the Settings entry points hand us, and landing on the previous
  // selection instead would silently ignore the thing the user asked for.
  const deepLinkRef = searchParams.get("device")

  useEffect(() => {
    if (!deepLinkRef || deepLinkRef === selectedRef) return
    if (rows.some((row) => row.ref === deepLinkRef)) select(deepLinkRef)
  }, [deepLinkRef, rows, select, selectedRef])

  // Fall back to this machine whenever the selection points at nothing — on
  // first open, and also after a device is revoked and disappears from the
  // list, which would otherwise leave the pane empty with no explanation.
  useEffect(() => {
    if (selected || rows.length === 0) return
    // A deep link that names a device we do not have yet must not be stomped
    // on: the rows may still be loading, and selecting the local device would
    // make the link look broken.
    if (deepLinkRef && rows.some((row) => row.ref === deepLinkRef)) return
    const local = rows.find((row) => row.isSelf)
    if (local) select(local.ref)
  }, [deepLinkRef, rows, select, selected])

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
          /* Where this window's calls land, on the page that is about
             machines. The desktop status bar carries the same control; this is
             the copy a browser or a phone can see. */
          context={<ExecutionHostChip onAddHost={() => setAddHostOpen(true)} />}
          status={
            /**
             * The one number a fleet is actually scanned for. It was computed
             * by `summarizeDeviceRows` from the start and rendered nowhere,
             * so a revoked phone or a host stuck in `versionMismatch` was
             * only findable by opening every row.
             */
            summary.needsAttention > 0 ? (
              <Badge
                variant="outline"
                className="gap-1.5 font-normal text-amber-600 dark:text-amber-400"
                data-testid="devices-attention-count"
              >
                <span
                  aria-hidden="true"
                  className="inline-block size-1.5 rounded-full bg-current"
                />
                {t("attentionCount", { count: summary.needsAttention })}
              </Badge>
            ) : null
          }
          primaryAction={{
            id: "pair",
            label: t("actions.pair"),
            icon: SmartphoneIcon,
            onSelect: () => router.push(pairHref),
          }}
          secondaryActions={[
            {
              id: "add-host",
              label: t("actions.addHost"),
              icon: ServerIcon,
              onSelect: () => setAddHostOpen(true),
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
        {standalone ? (
          <Alert className="m-3 mb-0" data-testid="devices-requires-host">
            <AlertTitle>{t("standaloneTitle")}</AlertTitle>
            <AlertDescription className="space-y-2">
              <span className="block">{t("standaloneBody")}</span>
              {/* Two ways out of standalone, both reachable from here. Adding
                  a host is the one a browser can act on without another
                  device in hand, so it leads. */}
              <span className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setAddHostOpen(true)}
                  data-testid="devices-standalone-add-host"
                >
                  {t("actions.addHost")}
                </Button>
                <Button asChild size="sm" variant="ghost">
                  <Link href={pairHref}>{t("standalonePair")}</Link>
                </Button>
              </span>
            </AlertDescription>
          </Alert>
        ) : null}
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
          <DeviceDetail row={selected} actions={actions} />
        </div>
      </div>

      <AddHostSheet
        open={addHostOpen}
        onOpenChange={setAddHostOpen}
        initialBaseUrl={seededBaseUrl}
        onPaired={onPaired}
      />
    </FeaturePageShell>
  )
}
