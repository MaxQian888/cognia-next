"use client"

import Link from "next/link"
import { useTranslations } from "next-intl"
import { ExternalLinkIcon, ScrollTextIcon } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { LogSettings } from "@/components/logging/log-settings"
import { NativeLogViewer } from "@/components/logging/native-log-viewer"

interface Props {
  /** Closes the host Settings dialog/sheet when the user clicks "Open Log Panel". */
  onClose?: () => void
}

/**
 * Settings → Observability → Logs.
 *
 * Renders the multi-tab `LogSettings` configuration UI (level / transports /
 * retention / advanced / sampling) and a top-of-section "Open Log Panel" link
 * card that takes the user to the dedicated `/logs` route.
 */
export function LogsSection({ onClose }: Props) {
  const t = useTranslations("settings")

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3 pb-3">
          <div className="flex items-start gap-3 min-w-0">
            <div className="shrink-0 mt-0.5 text-muted-foreground">
              <ScrollTextIcon className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-base">{t("logs.linkCardTitle")}</CardTitle>
              <CardDescription className="text-xs mt-0.5">
                {t("logs.linkCardDescription")}
              </CardDescription>
            </div>
          </div>
          <Button asChild size="sm" variant="outline">
            <Link href="/logs" onClick={() => onClose?.()}>
              <ExternalLinkIcon className="h-3.5 w-3.5 mr-1.5" />
              {t("logs.openPanel")}
            </Link>
          </Button>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground pt-0">
          {t("logs.linkCardFooter")}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t("logs.nativeCardTitle")}</CardTitle>
          <CardDescription className="text-xs mt-0.5">
            {t("logs.nativeCardDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <NativeLogViewer />
        </CardContent>
      </Card>

      <LogSettings />
    </div>
  )
}
