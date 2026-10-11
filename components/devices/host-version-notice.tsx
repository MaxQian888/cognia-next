"use client"

/**
 * "Update the host" / "Update this app", under a remote host's masthead
 * (ADR-0175, ADR-0224 A10).
 *
 * Versions stay exact, so a host and this app that disagree on the command
 * contract cannot talk, and the masthead's "Upgrade required" alone left the
 * user guessing which side to upgrade. This says which, from the advice the
 * last handshake persisted on the host (`lib/remote-host/host-version.ts`),
 * and why: a host behind this app, ahead of it, or half-updated (its own
 * server refusing its own brain). When it is this app, it links to the
 * Update Center.
 */

import Link from "next/link"
import { useTranslations } from "next-intl"
import { ArrowUpCircleIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { DeviceRow } from "@/lib/devices/types"

export const APP_UPDATES_HREF = "/settings?section=updates"

export function HostVersionNotice({ row }: { row: DeviceRow }) {
  const t = useTranslations("devices.host.version")
  const version = row.kind === "remote-host" ? row.hostVersion : undefined
  if (!version || version.advice === "none" || row.connectionState === "revoked") return null

  const refusal = version.brainRefusal
  const detail = refusal
    ? t("halfUpdated", { server: refusal.server.version, brain: refusal.brain.version })
    : version.advice === "update-app"
      ? t("hostAhead", { host: version.hostContractVersion ?? 0, app: version.appContractVersion })
      : version.hostContractVersion === null
        ? t("hostUnversioned", { app: version.appContractVersion })
        : t("hostBehind", { host: version.hostContractVersion, app: version.appContractVersion })

  return (
    <div
      role="status"
      className="mt-2.5 flex flex-wrap items-start gap-x-3 gap-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs"
      data-testid="host-version-notice"
      data-advice={version.advice}
      data-half-updated={refusal ? "true" : undefined}
    >
      <ArrowUpCircleIcon aria-hidden className="mt-px size-3.5 shrink-0 text-amber-600" />
      <div className="min-w-0 flex-1 basis-60">
        <p className="font-medium text-foreground">
          {version.advice === "update-app" ? t("updateApp") : t("updateHost")}
        </p>
        <p className="mt-0.5 text-muted-foreground">{detail}</p>
      </div>
      {version.advice === "update-app" ? (
        <Button size="sm" variant="outline" asChild>
          <Link href={APP_UPDATES_HREF} data-testid="host-version-update-app">
            {t("checkAppUpdates")}
          </Link>
        </Button>
      ) : null}
    </div>
  )
}
