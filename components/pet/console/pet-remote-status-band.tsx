// The remote /pet console's one line of connection chrome (ADR-0219): whether
// the desktop that owns the pet is reachable, whether it would accept care
// right now, how fresh this picture is, and a retry.
//
// A phone caring for the desktop pet paints from a mirror, so the console has
// to say when that mirror is all it has: the desktop may be asleep, still
// starting its pet, or have the pet switched off, and each of those reads
// differently. Drawn with the shell's `RuntimeStatusBand` so it looks like
// every other connection report, and it claims the connection report while
// mounted, so the shell's own offline banner does not say it a second time.

"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useFormatter, useNow, useTranslations } from "next-intl"
import {
  RUNTIME_BAND_ACTION,
  RuntimeStatusBand,
  type RuntimeStatusTone,
} from "@/components/runtime/runtime-status-band"
import { usePlatform } from "@/hooks/use-platform"
import { claimConnectionNotice } from "@/lib/runtime/connection-notice-claim"
import { resolveRuntimeRecovery } from "@/lib/runtime/recovery-resolver"
import type { PetConsoleRemote } from "./pet-console-actions-context"

export interface PetRemoteStatusBandProps {
  remote: PetConsoleRemote
  className?: string
}

interface BandState {
  tone: RuntimeStatusTone
  title: string
  /** Appended after the freshness line. */
  detail?: string
  /** Offer the connection screen as well as a retry. */
  connectionLink: boolean
}

export function PetRemoteStatusBand({ remote, className }: PetRemoteStatusBandProps) {
  const t = useTranslations("pet.console.remote.band")
  const format = useFormatter()
  const now = useNow({ updateInterval: 30_000 })
  const platform = usePlatform()
  const [retrying, setRetrying] = useState(false)

  useEffect(() => claimConnectionNotice(), [])

  const { snapshot, fetchedAt, error, connection } = remote
  const freshness =
    fetchedAt === null
      ? t("neverUpdated")
      : t("updated", { time: format.relativeTime(fetchedAt, now) })

  const state: BandState = (() => {
    if (connection === "offline") {
      return {
        tone: "offline",
        title: t("offline"),
        detail: t("showingMirror"),
        connectionLink: true,
      }
    }
    if (connection === "connecting") {
      return { tone: "progress", title: t("connecting"), connectionLink: true }
    }
    if (error === "unreachable") {
      return { tone: "attention", title: t("unreachable"), connectionLink: true }
    }
    if (error === "invalid") {
      return { tone: "attention", title: t("invalid"), connectionLink: false }
    }
    if (!snapshot) return { tone: "progress", title: t("loading"), connectionLink: false }
    if (!snapshot.availability.available) {
      switch (snapshot.availability.reason) {
        case "host-starting":
          return { tone: "progress", title: t("hostStarting"), connectionLink: false }
        case "disabled":
          return { tone: "attention", title: t("disabled"), connectionLink: false }
        case "headless-host":
          return { tone: "attention", title: t("headless"), connectionLink: false }
        default:
          return { tone: "attention", title: t("unavailable"), connectionLink: false }
      }
    }
    return { tone: "info", title: t("connected"), connectionLink: false }
  })()

  const recovery = state.connectionLink
    ? resolveRuntimeRecovery({ state: "offline", reason: "connection-offline" }, platform)
    : null

  const retry = async () => {
    setRetrying(true)
    try {
      await remote.retry()
    } finally {
      setRetrying(false)
    }
  }

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="pet-remote-status-band"
      data-state={state.tone}
      className={className}
    >
      <RuntimeStatusBand
        tone={state.tone}
        title={state.title}
        detail={state.detail ? `${freshness} · ${state.detail}` : freshness}
        actions={
          <>
            {recovery?.kind === "route" ? (
              <Link
                href={recovery.href}
                className={RUNTIME_BAND_ACTION}
                data-testid="pet-remote-connection-settings"
              >
                {t("connectionSettings")}
              </Link>
            ) : null}
            <button
              type="button"
              className={RUNTIME_BAND_ACTION}
              disabled={retrying}
              aria-busy={retrying || undefined}
              data-testid="pet-remote-retry"
              onClick={() => void retry()}
            >
              {retrying ? t("retrying") : t("retry")}
            </button>
          </>
        }
      />
    </div>
  )
}
