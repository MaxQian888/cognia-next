"use client"

/**
 * The Settings-side stub that replaced a list.
 *
 * Settings → Companion used to carry the whole paired-devices table and
 * Settings → Remote hosts the whole host list; both now live in `/devices`.
 * What stays behind is a count and a way in — enough to answer "is anything
 * paired?" without making Settings a second, diverging fleet view.
 *
 * Pairing a device and adding a host stay in Settings, next to this card. They
 * are configuration; the console is the fleet.
 */

import Link from "next/link"
import { useTranslations } from "next-intl"
import { ArrowRightIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export interface DeviceConsoleLinkProps {
  /** Which list this card replaced. */
  surface: "paired" | "hosts"
  count: number
  /** Preselect a device in the console, when the caller has one in mind. */
  deviceRef?: string
}

export function DeviceConsoleLink({ surface, count, deviceRef }: DeviceConsoleLinkProps) {
  const t = useTranslations("devices.settingsLink")
  const href = deviceRef ? `/devices?device=${encodeURIComponent(deviceRef)}` : "/devices"

  return (
    <Card data-testid={`device-console-link-${surface}`}>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">
          {surface === "paired" ? t("pairedTitle") : t("hostsTitle")}
        </CardTitle>
        <CardDescription className="text-xs">
          {surface === "paired" ? t("pairedBody", { count }) : t("hostsBody", { count })}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button asChild size="sm" variant="outline">
          <Link href={href}>
            {t("open")}
            <ArrowRightIcon className="size-3.5" />
          </Link>
        </Button>
      </CardContent>
    </Card>
  )
}
