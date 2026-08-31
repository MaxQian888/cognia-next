"use client"

/**
 * The one card that answers, for a saved SSH host, everything this console
 * asks that an SSH server cannot be asked.
 *
 * A saved SSH host used to render the full dashboard: a capability matrix, an
 * access matrix, a sandbox card, a workspace card, a dispatch queue and a
 * placement card. Every one of them already knew it had nothing to say and
 * said so honestly, which produced six cards whose entire content was a single
 * sentence of apology, stacked below the two cards that actually describe the
 * machine. That is not a fleet console, it is a list of excuses, and it is
 * what made the pane read as ragged: six card frames, each about 110px of
 * chrome around one line of text, half of them spanning the full pane width.
 *
 * The information is unchanged. Every sentence below is the same string the
 * section it replaces would have rendered, so nothing is lost and nothing is
 * newly written, and a reader who wants to know why an SSH host has no grants
 * still gets the same answer in the same words. It is stated once, as a record
 * of what does not apply, in the shape the rest of the pane uses for records.
 *
 * The sections themselves are unchanged too. They are simply not rendered for
 * this kind, which is decided in `device-detail.tsx` where the rest of the
 * layout is decided, rather than by six separate early returns nobody could
 * read together.
 */

import { CircleSlashIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { DeviceSection } from "../device-section"
import { DeviceFactList, DeviceFactRow } from "../device-visuals"

export function ShellOnlySection() {
  const t = useTranslations("devices")
  return (
    <DeviceSection
      id="shell-only"
      title={t("shellOnly.title")}
      icon={CircleSlashIcon}
      description={t("shellOnly.description")}
      wide
    >
      <DeviceFactList>
        <DeviceFactRow label={t("capabilities.title")}>
          {t("capabilities.noVocabulary.ssh-host")}
        </DeviceFactRow>
        <DeviceFactRow label={t("access.title")}>
          {t("access.notApplicable.ssh-host")}
        </DeviceFactRow>
        {/*
          One row for both, because the sentence answers both. `sshShellOnly`
          is the reason key the sandbox card and the workspace card each
          resolve to, and it names a shell as the whole of what SSH offers.
        */}
        <DeviceFactRow label={t("shellOnly.runtime")}>
          {t("runtime.reason.sshShellOnly")}
        </DeviceFactRow>
        <DeviceFactRow label={t("activity.dispatch")}>
          {t("activity.dispatchNotAddressable")}
        </DeviceFactRow>
        <DeviceFactRow label={t("activity.placement")}>
          {t("activity.providesNothing")}
        </DeviceFactRow>
      </DeviceFactList>
    </DeviceSection>
  )
}
