"use client"

/**
 * Cloud & relay → a link to the public status page of the official relay.
 *
 * The status page answers "is the official hosted relay up?", which is a
 * different question from the check above ("can this device reach the relay
 * it is configured to use?"). So this block is a link, not a status read-out:
 * it starts no polling and fetches nothing, and a status page that cannot be
 * opened never affects relay configuration. When the device is configured
 * for a different relay, the block says the public page does not describe it
 * and shows no official status next to it.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ActivityIcon, ExternalLinkIcon } from "lucide-react"

import { SettingsBlock } from "@/components/settings/common/settings-block"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { STATUS_PAGE_URL } from "@/lib/constants/external-urls"
import { OFFICIAL_SIGNALING_HOST } from "@/lib/status/config"
import { openExternal } from "@/lib/tauri/opener"
import { cn } from "@/lib/utils"

/** Host of a configured signaling URL, or null when it does not parse. */
export function signalingHost(url: string): string | null {
  try {
    return new URL(url.trim()).hostname.toLowerCase() || null
  } catch {
    return null
  }
}

/**
 * Whether a configured signaling URL is the official hosted relay. Compared
 * by host and secure scheme, not by string, so a trailing slash or path
 * spelling does not matter; an unparseable URL is not official.
 */
export function isOfficialSignalingUrl(url: string): boolean {
  try {
    const parsed = new URL(url.trim())
    return (
      (parsed.protocol === "wss:" || parsed.protocol === "https:") &&
      parsed.hostname.toLowerCase() === OFFICIAL_SIGNALING_HOST &&
      parsed.port === ""
    )
  } catch {
    return false
  }
}

export interface StatusPageLinkBlockProps {
  /** The signaling URL this device (or its Host) is configured to use. */
  signalingUrl: string
}

export function StatusPageLinkBlock({ signalingUrl }: StatusPageLinkBlockProps) {
  const t = useTranslations("settings.connectivity.statusPage")
  const [openFailed, setOpenFailed] = useState(false)
  const official = isOfficialSignalingUrl(signalingUrl)
  const host = signalingHost(signalingUrl) ?? signalingUrl

  const open = () => {
    setOpenFailed(false)
    openExternal(STATUS_PAGE_URL).catch(() => setOpenFailed(true))
  }

  return (
    <SettingsBlock
      icon={<ActivityIcon />}
      title={t("title")}
      description={t("description")}
      badge={
        <Badge
          variant="outline"
          className={cn(!official && "text-amber-700 dark:text-amber-300")}
          data-testid="status-page-scope"
          data-official={official ? "true" : "false"}
        >
          {official ? t("badgeOfficial") : t("badgeSelfHosted")}
        </Badge>
      }
      action={
        <Button size="sm" variant="outline" onClick={open} data-testid="status-page-open">
          <ExternalLinkIcon className="mr-1 size-3.5" aria-hidden="true" />
          {t("open")}
        </Button>
      }
      testid="status-page-link-block"
      settingId="connectivity-status-page"
    >
      <p
        className={cn(
          "text-xs",
          official ? "text-muted-foreground" : "text-amber-700 dark:text-amber-300"
        )}
        data-testid="status-page-scope-note"
      >
        {official ? t("official") : t("selfHosted", { host })}
      </p>
      {openFailed ? (
        <p role="alert" className="text-xs text-rose-700 dark:text-rose-300">
          {t("openFailed", { url: STATUS_PAGE_URL })}
        </p>
      ) : null}
    </SettingsBlock>
  )
}
