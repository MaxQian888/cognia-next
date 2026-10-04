"use client"

import Link from "next/link"
import { useEffect, useSyncExternalStore } from "react"
import { usePathname } from "next/navigation"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon, LoaderIcon, LockKeyholeIcon, WifiOffIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
} from "@/components/ui/empty"
import { RUNTIME_BAND_ACTION, RuntimeStatusBand } from "@/components/runtime/runtime-status-band"
import { useRuntimeSnapshot } from "@/hooks/use-runtime-snapshot"
import { usePlatform } from "@/hooks/use-platform"
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"
import { pickActiveTabId, tabHref } from "@/components/mobile/shell/mobile-tab-bar"
import type { Platform } from "@/lib/platform/detect"
import type { OperationAvailability, RuntimeSnapshot } from "@/lib/runtime/operation-availability"
import { resolveRuntimeRecovery } from "@/lib/runtime/recovery-resolver"
import {
  getSurfaceContractForRoute,
  isInternalRouteExempt,
  resolveSurfaceAvailability,
  type SurfaceContract,
} from "@/lib/runtime/surface-contract"
import {
  claimConnectionNotice,
  isConnectionNoticeClaimed,
  subscribeConnectionNoticeClaim,
} from "@/lib/runtime/connection-notice-claim"
import { needsFullViewport } from "@/lib/shell/full-viewport-routes"
import { useAccountStore } from "@/stores/account/account-store"
import { SIDEBAR_NAV_META } from "@/types/shell/sidebar"

export function SurfaceAvailabilityBoundary({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const snapshot = useRuntimeSnapshot()
  const platform = usePlatform()
  const contract = getSurfaceContractForRoute(pathname)
  const compact = useCompactLayout()
  // A route whose own notice reports the Host connection (the phone chat's
  // runtime strip / card) does not also need this band saying "read-only".
  const connectionClaimed = useSyncExternalStore(
    subscribeConnectionNoticeClaim,
    isConnectionNoticeClaimed,
    () => false
  )

  if (!contract || isInternalRouteExempt(pathname) || !snapshot.target) {
    return <>{children}</>
  }

  const availability = resolveSurfaceAvailability(contract, snapshot)
  if (availability.state === "available" || availability.state === "queued") {
    return <>{children}</>
  }
  if (availability.state === "read-only") {
    // On the compact shell the `OfflineBanner` is the one connection report,
    // and it carries the cache fallback on its own line ("Reconnecting to host
    // · cached data only"). A second band here said the same thing in other
    // words, one row lower. Any other read-only reason is not a connection
    // report and stays here.
    const reportedByBanner = compact && availability.reason === "offline-cache"
    // A compact route that scrolls as a document sits in a BLOCK column, not
    // the desktop shell's flex row. Handing it a row shrank its page to its
    // content's width (the workflow list stopped at ~80% of a phone screen),
    // and `overflow-hidden` made this wrapper the scroll container that every
    // `sticky` header inside measured against.
    const documentScroll = compact && !needsFullViewport(pathname)
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Only the band goes when a route notice claims the report — never
            the wrapper. Swapping the tree shape on the claim remounted the
            route, which unmounted the claimant, which flipped the shape back:
            an update loop. */}
        {connectionClaimed || reportedByBanner ? null : (
          <ReadOnlyBand availability={availability} snapshot={snapshot} platform={platform} />
        )}
        {/* Routes inherit a flex row from the desktop shell. Keep that content
            slot separate from the notice's column so chat panes stay side by
            side. */}
        <div
          data-testid="surface-read-only-slot"
          className={
            documentScroll ? "min-w-0 flex-1" : "flex min-h-0 min-w-0 flex-1 overflow-hidden"
          }
        >
          {children}
        </div>
      </div>
    )
  }

  return (
    <SurfaceUnavailable
      contract={contract}
      availability={availability}
      snapshot={snapshot}
      pathname={pathname}
      compact={compact}
      platform={platform}
    />
  )
}

/**
 * The desktop-width read-only report, in the same band the phone's
 * `OfflineBanner` draws: state, what it means here, and the way back.
 */
function ReadOnlyBand({
  availability,
  snapshot,
  platform,
}: {
  availability: OperationAvailability
  snapshot: RuntimeSnapshot
  platform: Platform
}) {
  const t = useTranslations("runtime.surfaceBoundary")
  const cached = availability.reason === "offline-cache"
  const connecting = cached && snapshot.connectionState === "connecting"
  const recovery = cached
    ? resolveRuntimeRecovery({ state: "offline", reason: "connection-offline" }, platform)
    : null
  return (
    <div role="status" aria-live="polite" className="shrink-0">
      <RuntimeStatusBand
        tone={cached ? (connecting ? "progress" : "offline") : "info"}
        title={
          cached ? t(connecting ? "band.reconnecting" : "band.hostOffline") : t("band.readOnly")
        }
        detail={cached ? t("band.cacheOnly") : t(`reasons.${availability.reason}`)}
        actions={
          recovery?.kind === "route" ? (
            <Link
              href={recovery.href}
              className={RUNTIME_BAND_ACTION}
              data-testid="surface-read-only-recovery"
            >
              {t("connectionSettings")}
            </Link>
          ) : undefined
        }
      />
    </div>
  )
}

/**
 * The route cannot render at all here. Replaces the whole route, page chrome
 * included, so it names the page, says why, and always offers a way out.
 */
function SurfaceUnavailable({
  contract,
  availability,
  snapshot,
  pathname,
  compact,
  platform,
}: {
  contract: SurfaceContract
  availability: OperationAvailability
  snapshot: RuntimeSnapshot
  pathname: string
  compact: boolean
  platform: Platform
}) {
  const t = useTranslations("runtime.surfaceBoundary")
  const tNav = useTranslations("desktop.guildRail")
  const offline = availability.state === "offline"
  // This page IS the connection report for the route. The shell banner above
  // it said "Reconnecting…" while the page said "Host offline": two answers
  // to one question, stacked. The banner keeps the queue, which is not a
  // connection report.
  useEffect(() => (offline ? claimConnectionNotice() : undefined), [offline])
  const connecting = offline && snapshot.connectionState === "connecting"
  const recovery = recoveryFor(availability, platform)
  const exit = exitFor(pathname, compact)
  const Icon = connecting
    ? LoaderIcon
    : offline
      ? WifiOffIcon
      : availability.state === "requires-unlock"
        ? LockKeyholeIcon
        : AlertTriangleIcon
  // The states are generic ("Capability unavailable on this target"), so name
  // the page they are standing in for — picked from the nav or a link, that is
  // the one thing the reader knows.
  const nav = SIDEBAR_NAV_META.find((meta) => meta.id === contract.id)

  return (
    // `flex-1` + `w-full` because this lands in whatever slot the platform
    // shell hands the route, and that slot is a flex ROW. Without them the
    // `<main>` sized to its own `max-w-sm` content and sat against the left
    // edge of an otherwise empty page, vertically centred by the row's own
    // stretch: /performance on a browser target read as a rendering failure
    // rather than as an explanation.
    <main
      className="flex min-h-[60vh] w-full min-w-0 flex-1 items-center justify-center px-6 py-10"
      data-testid="surface-unavailable"
      data-state={connecting ? "connecting" : availability.state}
    >
      {/* No frame: the dashed full-width rules above and below read as a
          broken layout on a phone, not as a message. */}
      <Empty
        aria-labelledby="surface-unavailable-title"
        className="w-full max-w-sm flex-none gap-5 rounded-none border-0 p-0 md:p-0"
      >
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Icon aria-hidden className={connecting ? "animate-spin" : undefined} />
          </EmptyMedia>
          {nav ? (
            <p
              className="text-xs font-medium text-muted-foreground"
              data-testid="surface-unavailable-name"
            >
              {tNav(nav.i18nKey)}
            </p>
          ) : null}
          <h1 id="surface-unavailable-title" className="text-lg font-semibold tracking-tight">
            {connecting ? t("states.connecting") : t(`states.${availability.state}`)}
          </h1>
          <EmptyDescription>{t(`reasons.${availability.reason}`)}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="w-full flex-col gap-2 sm:flex-row sm:justify-center">
          {recovery?.kind === "route" ? (
            <Button asChild className="w-full sm:w-auto">
              <Link href={recovery.href}>{t(recovery.label)}</Link>
            </Button>
          ) : recovery?.kind === "unlock-account" ? (
            <Button
              type="button"
              className="w-full sm:w-auto"
              data-testid="surface-unavailable-unlock"
              onClick={() => void useAccountStore.getState().lock()}
            >
              {t(recovery.label)}
            </Button>
          ) : null}
          {/* This boundary replaces the whole route, page chrome included, so
              a blocked /me sub-page lost its back arrow and the only way out
              was a button that dropped the reader into chat. Under /me the
              exit goes back to /me. */}
          <Button asChild variant={recovery ? "ghost" : "outline"} className="w-full sm:w-auto">
            <Link href={exit.href}>{exit.label === "back" ? t("back") : t("backToChat")}</Link>
          </Button>
        </EmptyContent>
      </Empty>
    </main>
  )
}

/**
 * Where the boundary's exit leads. It replaces the whole route, page chrome
 * included, so this button is often the only way out.
 *
 *  - A `/me` sub-page goes back to `/me`.
 *  - On the phone shell, a screen a tab hub opened goes back to that hub:
 *    Source Control is reached from Me, and "Back to chat" dropped the reader
 *    into a tab they never came from while the bar lit Me.
 *  - Everything else keeps the chat exit.
 */
export function exitFor(
  pathname: string,
  compact: boolean
): { href: string; label: "back" | "backToChat" } {
  if (pathname.startsWith("/me/")) return { href: "/me", label: "back" }
  if (compact) {
    const hub = tabHref(pickActiveTabId(pathname))
    // A blocked hub (`/me`, `/discover`, `/workflows`) is its own tab's
    // href; linking it to itself would be an exit that goes nowhere.
    if (hub !== "/" && hub !== pathname) return { href: hub, label: "back" }
  }
  return { href: "/", label: "backToChat" }
}

type SurfaceRecovery =
  | {
      kind: "route"
      href: string
      label: "pairHost" | "diagnose" | "connectionSettings"
    }
  | { kind: "unlock-account"; label: "unlockVault" }

/**
 * The page that fixes the state, if any. Offline goes where the chat's own
 * notice sends it (`resolveRuntimeRecovery`): the connection screen, which
 * can retry, switch to another host or re-pair. It used to offer nothing, so
 * the only button on an offline page was the way out.
 *
 * A locked Vault is not a page at all. The browser Vault IS the local
 * account's key (`stores/account/account-store.ts`: `unlockAccount` opens it,
 * `lock` closes it), and the only screen that opens it is the account lock
 * screen `AccountGate` draws. This used to link `/me/profile`, which has no
 * unlock control and, inheriting `/me`'s `companion: "remote"` row, was
 * itself walled off by the very state it was offered for. With the app
 * mounted the account reads unlocked while its Vault is shut, so the remedy
 * is the account's own `lock()`: it settles the inconsistency into a clean
 * locked state, and `AccountGate` puts the unlock screen up in its place.
 */
function recoveryFor(
  availability: OperationAvailability,
  platform: Platform
): SurfaceRecovery | null {
  const state = availability.state
  if (state === "requires-pairing" || state === "unsupported") {
    return { kind: "route", href: "/pair", label: "pairHost" }
  }
  if (state === "requires-unlock") {
    return { kind: "unlock-account", label: "unlockVault" }
  }
  if (state === "requires-grant" || state === "incompatible") {
    return { kind: "route", href: "/me/diagnostics", label: "diagnose" }
  }
  if (state === "offline") {
    const recovery = resolveRuntimeRecovery(availability, platform)
    return recovery.kind === "route"
      ? { kind: "route", href: recovery.href, label: "connectionSettings" }
      : null
  }
  return null
}
