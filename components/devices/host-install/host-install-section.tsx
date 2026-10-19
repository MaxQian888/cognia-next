"use client"

/**
 * "This machine" on the page of a Host this desktop installed (ADR-0235 P5):
 * which saved SSH profile it was installed over, when, and the way back into
 * the installer for repair, re-pair and uninstall.
 *
 * The installer decides what it may offer from a fresh inspection, so this
 * section never guesses: one action opens the sheet and the machine answers.
 * Forgetting the Host stays the masthead's remove flow, which never touches
 * the machine.
 */

import { useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import Link from "next/link"
import { ServerCogIcon, SettingsIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import type { HostInstallDeps } from "@/hooks/host-installer/use-host-install"
import type { DeviceRow } from "@/lib/devices/types"
import { selectSavedSshHosts } from "@/lib/terminal/saved-ssh-hosts"
import { sshHostSettingsHref } from "@/lib/terminal/terminal-settings-link"
import { useSettingsStore } from "@/stores/settings"

import { DeviceFactList, DeviceFactRow } from "../device-visuals"
import { DeviceSection } from "../device-section"
import {
  HostInstallSheet,
  hostInstallerUnavailable,
  type HostInstallerUnavailable,
} from "./host-install-sheet"

export interface HostInstallSectionProps {
  row: DeviceRow
  /** Test seams. */
  unavailable?: HostInstallerUnavailable | null
  deps?: HostInstallDeps
}

export function HostInstallSection({
  row,
  unavailable = hostInstallerUnavailable(),
  deps,
}: HostInstallSectionProps) {
  const t = useTranslations("devices.hostInstall")
  const format = useFormatter()
  const [open, setOpen] = useState(false)
  const binding = row.installBinding
  const profile = useSettingsStore((state) =>
    binding
      ? (selectSavedSshHosts(state)?.find((host) => host.id === binding.profileId) ?? null)
      : null
  )
  if (!binding) return null

  return (
    <DeviceSection id="host-install" title={t("section.title")} icon={ServerCogIcon}>
      <div className="space-y-3" data-testid="host-install-section">
        <DeviceFactList>
          <DeviceFactRow label={t("section.via")}>
            {profile ? profile.name : t("section.profileGone")}
          </DeviceFactRow>
          <DeviceFactRow label={t("section.installedAt")}>
            {format.dateTime(binding.installedAt, { dateStyle: "medium", timeStyle: "short" })}
          </DeviceFactRow>
        </DeviceFactList>

        {!profile ? (
          <Alert data-testid="host-install-section-profile-missing">
            <AlertTitle>{t("profileMissing.title")}</AlertTitle>
            <AlertDescription className="space-y-2">
              <p>{t("profileMissing.body")}</p>
              <Button asChild size="sm" variant="outline">
                <Link href={sshHostSettingsHref(null)}>
                  <SettingsIcon className="size-3.5" />
                  {t("section.openSshSettings")}
                </Link>
              </Button>
            </AlertDescription>
          </Alert>
        ) : unavailable ? (
          <p
            className="text-xs text-muted-foreground"
            data-testid="host-install-unavailable"
            data-reason={unavailable}
          >
            {t(`entry.${unavailable}`)}
          </p>
        ) : (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setOpen(true)}
              data-testid="host-install-manage"
            >
              <ServerCogIcon className="size-3.5" />
              {t("section.manage")}
            </Button>
            <p className="text-[11px] text-muted-foreground">{t("section.manageBody")}</p>
            <HostInstallSheet
              open={open}
              onOpenChange={setOpen}
              profileId={binding.profileId}
              deps={deps}
            />
          </>
        )}
      </div>
    </DeviceSection>
  )
}
