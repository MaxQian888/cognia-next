"use client"

/**
 * The one "this host does not run the automation engine" notice.
 *
 * Screen, keyboard and mouse control is a physical capability of the machine
 * being driven, so it only runs inside the desktop shell. Three tabs each
 * carried their own version of that sentence: the Overview tab told the user
 * to run `pnpm tauri dev`, the Whitelist tab said the form would not persist,
 * and only the Inspector tab was translated at all. The Overview copy reached
 * users on `app/me/computer-use`, where a build command is not an action
 * anyone can take.
 *
 * One notice, one key pair, phrased for the person holding the phone.
 */

import { useTranslations } from "next-intl"
import { MonitorOffIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"

export function AutomationUnavailableNotice({ className }: { className?: string }) {
  const t = useTranslations("automation.unavailable")

  return (
    <Alert className={className} data-testid="automation-unavailable">
      <MonitorOffIcon className="size-4" aria-hidden="true" />
      <AlertTitle>{t("title")}</AlertTitle>
      <AlertDescription>{t("description")}</AlertDescription>
    </Alert>
  )
}
