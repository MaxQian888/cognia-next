"use client"

/**
 * Push → send a test notification.
 *
 * The fan-out existed (`companion_push_notification`) and nothing in the UI
 * called it, so a user who had just pasted APNs credentials had no way to
 * learn whether they worked short of walking away from the desk. The Host
 * only pushes to devices whose socket is CLOSED, so the count that comes back
 * is "devices that were offline and had a token", and the copy says so.
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { SendIcon } from "lucide-react"
import { toast } from "sonner"

import { SettingsBlock } from "@/components/settings/common/settings-block"
import { Button } from "@/components/ui/button"
import { useHostAdminReachForCommand } from "@/hooks/connectivity/use-host-admin-reach"
import { transport } from "@/lib/tauri"

import { HostReachNotice } from "./host-reach-notice"

/** Mirror of the Rust `PushBroadcastResult` (`companion_api/commands.rs`). */
export interface PushBroadcastResult {
  sent: number
}

export interface PushTestBlockProps {
  /** Whether any provider is configured. Disables the button with a reason. */
  configured: boolean
  /** Test seam. Defaults to the routed `companion_push_notification`. */
  send?: (args: {
    notificationId: string
    source: string
    level: string
    href: string
  }) => Promise<PushBroadcastResult>
}

const defaultSend = (args: {
  notificationId: string
  source: string
  level: string
  href: string
}) => transport.call<PushBroadcastResult>("companion_push_notification", args)

/** Where a tap on the test notification lands: this very panel. */
export const PUSH_TEST_HREF = "/settings?section=connectivity&connectivityPanel=push"

export function PushTestBlock({ configured, send = defaultSend }: PushTestBlockProps) {
  const t = useTranslations("settings.connectivity.push")
  const reach = useHostAdminReachForCommand("companion_push_notification")
  const [busy, setBusy] = useState(false)
  const [lastSent, setLastSent] = useState<number | null>(null)

  const onSend = useCallback(async () => {
    setBusy(true)
    try {
      const result = await send({
        notificationId: `push-test-${Date.now()}`,
        source: "system",
        level: "info",
        href: PUSH_TEST_HREF,
      })
      setLastSent(result.sent)
      toast.success(t("testSent", { count: result.sent }))
    } catch (err) {
      toast.error(t("testFailed", { message: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusy(false)
    }
  }, [send, t])

  return (
    <SettingsBlock
      icon={<SendIcon />}
      title={t("testTitle")}
      description={t("testDescription")}
      action={
        <Button
          size="sm"
          variant="outline"
          onClick={() => void onSend()}
          disabled={!reach.available || !configured || busy}
          data-testid="push-test-send"
        >
          <SendIcon className="mr-1 size-3.5" aria-hidden="true" />
          {busy ? t("testSending") : t("testSend")}
        </Button>
      }
      testid="push-test-block"
      settingId="companion-push-test"
    >
      {reach.block ? <HostReachNotice block={reach.block} testid="push-test-reach" /> : null}
      {!configured && reach.available ? (
        <p className="text-xs text-muted-foreground" data-testid="push-test-unconfigured">
          {t("testNeedsCredentials")}
        </p>
      ) : null}
      {lastSent !== null ? (
        <p className="text-xs text-muted-foreground" role="status" data-testid="push-test-result">
          {t("testResult", { count: lastSent })}
        </p>
      ) : null}
    </SettingsBlock>
  )
}
