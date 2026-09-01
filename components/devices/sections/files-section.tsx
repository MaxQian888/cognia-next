"use client"

/**
 * Files on a saved SSH host, on the page that already describes that host
 * (ADR-0162).
 *
 * The device console is where a machine's identity, its forwarding rules and
 * its grants already live, so a file browser somewhere else would be a second
 * place to answer "which machine am I talking to". `/devices` is also the one
 * surface that is already laid out for all three shells, which is how a single
 * mount reaches the desktop, a browser and a phone.
 *
 * The section renders whether or not it can run. Hiding it would collapse three
 * different answers into one silence: this shell has no host at all, the host it
 * is paired to cannot open a shell, or the grant is missing. Each of those has a
 * different remedy, and only the first is fixed by pairing.
 */

import { useTranslations } from "next-intl"
import { FolderIcon } from "lucide-react"

import { SurfaceUnavailableNotice } from "@/components/platform/surface-unavailable-notice"
import { useSurfaceReach } from "@/hooks/platform/use-surface-reach"
import { RemoteFileBrowser } from "@/components/sftp/remote-file-browser"
import { TransferQueuePanel } from "@/components/sftp/transfer-queue-panel"
import type { DeviceRow } from "@/lib/devices/types"

import { DeviceSection } from "../device-section"

/** `ssh:<profileId>` is how a saved host is addressed on this page. */
export function sshProfileIdFrom(ref: string): string | null {
  return ref.startsWith("ssh:") ? ref.slice(4) : null
}

export function FilesSection({ row }: { row: DeviceRow }) {
  const t = useTranslations("devices.files")
  /*
   * `capability`, not `desktop-shell`. File transfer genuinely works from a
   * paired phone: the commands are `execution` scoped over http, websocket and
   * webrtc, and the host dials with credentials that never leave it. What it
   * needs is a host that can open a shell at all, which is what `pty` names.
   */
  const reach = useSurfaceReach({ capability: "pty" })
  const profileId = sshProfileIdFrom(row.ref)

  return (
    <DeviceSection id="files" title={t("title")} icon={FolderIcon} wide>
      {!profileId ? (
        <p className="text-sm text-muted-foreground" data-testid="files-unknown-profile">
          {t("unknownProfile")}
        </p>
      ) : !reach.available ? (
        <SurfaceUnavailableNotice reach={reach} data-testid="files-unavailable" />
      ) : (
        <div className="space-y-4">
          <RemoteFileBrowser profileId={profileId} profileLabel={row.label} />
          <div className="space-y-2 border-t pt-3">
            <p className="text-xs font-medium">{t("transfers")}</p>
            <TransferQueuePanel profileId={profileId} />
          </div>
        </div>
      )}
    </DeviceSection>
  )
}
