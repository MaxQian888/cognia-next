"use client"

/**
 * The Host installer sheet (ADR-0235 P5) for one saved SSH profile, and the
 * two ways into it that need no parent state.
 *
 *  * {@link HostInstallSheet} is controlled: the device page opens it from a
 *    bound Host's repair slot.
 *  * {@link SshHostInstallEntry} is the action on a saved SSH host's card.
 *
 * The profile is read from settings by id, with the whole saved set, because
 * a jump host is stored as a profile id and the request must resolve it.
 * {@link HostInstallFlow} mounts only while the sheet is open, so closing it
 * closes the native session.
 *
 * Gated twice: the build flag (`hostInstallerEnabled`, dormant until the
 * real-machine smoke passes) and the desktop shell, whose keyring holds the
 * profile's credentials. Neither gate hides the entry silently; each says why
 * the action is not here.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ServerCogIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { ResponsiveDetailSheet } from "@/components/shared/responsive-detail-sheet"
import type { HostInstallDeps } from "@/hooks/host-installer/use-host-install"
import { hostInstallerEnabled } from "@/lib/host-installer/feature-flag"
import { isTauri } from "@/lib/platform/detect"
import { selectSavedSshHosts } from "@/lib/terminal/saved-ssh-hosts"
import type { SshHostProfile } from "@/lib/terminal/ssh-profiles"
import { useSettingsStore } from "@/stores/settings"

import { HostInstallFlow } from "./host-install-flow"

const NO_PROFILES: readonly SshHostProfile[] = []

/** Why installing is not offered here, or `null` when it is. */
export type HostInstallerUnavailable = "notInBuild" | "desktopOnly"

export function hostInstallerUnavailable(
  enabled: boolean = hostInstallerEnabled(),
  desktop: boolean = isTauri()
): HostInstallerUnavailable | null {
  if (!enabled) return "notInBuild"
  if (!desktop) return "desktopOnly"
  return null
}

export interface HostInstallSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  profileId: string
  /** Test seams. */
  deps?: HostInstallDeps
}

export function HostInstallSheet({ open, onOpenChange, profileId, deps }: HostInstallSheetProps) {
  const t = useTranslations("devices.hostInstall")
  const profiles = useSettingsStore(selectSavedSshHosts) ?? NO_PROFILES
  const profile = profiles.find((candidate) => candidate.id === profileId) ?? null
  return (
    <ResponsiveDetailSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("title")}
      description={profile ? t("description", { name: profile.name }) : undefined}
    >
      {profile ? (
        <HostInstallFlow
          profile={profile}
          profiles={profiles}
          onClose={() => onOpenChange(false)}
          deps={deps}
        />
      ) : (
        <Alert variant="destructive" className="mx-4" data-testid="host-install-profile-missing">
          <AlertTitle>{t("profileMissing.title")}</AlertTitle>
          <AlertDescription>{t("profileMissing.body")}</AlertDescription>
        </Alert>
      )}
    </ResponsiveDetailSheet>
  )
}

export interface SshHostInstallEntryProps {
  profileId: string
  /** Test seams. */
  unavailable?: HostInstallerUnavailable | null
  deps?: HostInstallDeps
}

/** The installer's action on a saved SSH host, or the sentence saying why it is absent. */
export function SshHostInstallEntry({
  profileId,
  unavailable = hostInstallerUnavailable(),
  deps,
}: SshHostInstallEntryProps) {
  const t = useTranslations("devices.hostInstall")
  const [open, setOpen] = useState(false)
  if (unavailable) {
    return (
      <p
        className="text-xs text-muted-foreground"
        data-testid="host-install-unavailable"
        data-reason={unavailable}
      >
        {t(`entry.${unavailable}`)}
      </p>
    )
  }
  return (
    <div className="space-y-1" data-testid="host-install-entry">
      <Button
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
        data-testid="host-install-open"
      >
        <ServerCogIcon className="size-3.5" />
        {t("entry.action")}
      </Button>
      <p className="text-[11px] text-muted-foreground">{t("entry.body")}</p>
      <HostInstallSheet open={open} onOpenChange={setOpen} profileId={profileId} deps={deps} />
    </div>
  )
}
