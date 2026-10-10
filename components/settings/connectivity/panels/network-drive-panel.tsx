"use client"

/**
 * Connectivity → Network drive (ADR-0222 §7): how the Host serves shared
 * conversation files as network drives. Its own listener, SFTPGo as the
 * alternative provider, and every live share on the Host.
 *
 * It configures the Host this client drives (the routed transport), like the
 * other host-admin panels: on the desktop that is this machine, from a paired
 * device or a browser on a headless server it is that Host. The listener and
 * SFTPGo commands are `host-admin`; a client that cannot reach that plane gets
 * the reason instead of the controls.
 */

import { useTranslations } from "next-intl"

import { SettingsStack } from "@/components/settings/common/settings-block"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useHostAdminReachForCommand } from "@/hooks/connectivity/use-host-admin-reach"
import { useLiveFileShare } from "@/hooks/filespace/use-live-file-share"
import { transport } from "@/lib/tauri"

import { HostReachNotice } from "../blocks/host-reach-notice"
import { LiveAccessBlock } from "../blocks/live-access-block"
import { NetworkDriveBlock } from "../blocks/network-drive-block"
import { SftpgoBlock } from "../blocks/sftpgo-block"

export function NetworkDrivePanel() {
  const t = useTranslations("liveShare")
  const reach = useHostAdminReachForCommand("file_share_listener_set")
  // Read per render: the live binding follows a swapped transport, and the
  // hook re-renders this panel when one happens.
  const target = { transport }
  const live = useLiveFileShare({ transport, enabled: reach.available })

  if (!reach.available) {
    return (
      <SettingsStack>
        <HostReachNotice block={reach.block ?? "no-host"} testid="network-drive-reach" />
      </SettingsStack>
    )
  }
  if (live.error) {
    return (
      <SettingsStack>
        <div className="flex items-center gap-2" data-testid="network-drive-error">
          <p role="alert" className="text-sm text-muted-foreground">
            {t(`errors.${live.error}`, { message: live.errorMessage ?? "" })}
          </p>
          {live.error !== "file_share_unavailable" && live.error !== "unknown_command" ? (
            <Button type="button" variant="outline" size="sm" onClick={live.reload}>
              {t("audit.retry")}
            </Button>
          ) : null}
        </div>
      </SettingsStack>
    )
  }
  const status = live.status
  if (!status) {
    return (
      <SettingsStack>
        <Skeleton className="h-40 w-full" data-testid="network-drive-loading" />
      </SettingsStack>
    )
  }
  if (!status.active) {
    return (
      <SettingsStack>
        <p role="status" className="text-sm text-muted-foreground">
          {t("settings.locked")}
        </p>
      </SettingsStack>
    )
  }
  return (
    <SettingsStack>
      <NetworkDriveBlock
        // A new config from the host restarts the draft from it.
        key={JSON.stringify(status.listener.config)}
        listener={status.listener}
        target={target}
        onSaved={live.reload}
      />
      <SftpgoBlock
        key={JSON.stringify(status.sftpgo.config)}
        sftpgo={status.sftpgo}
        pendingProviderOps={status.pendingProviderOps}
        target={target}
        onSaved={live.reload}
      />
      <LiveAccessBlock live={live} status={status} transport={transport} />
    </SettingsStack>
  )
}
