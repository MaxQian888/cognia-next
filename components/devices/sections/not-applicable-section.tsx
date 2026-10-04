"use client"

/**
 * Everything this console asks of every machine that this one has no answer
 * to, stated once.
 *
 * This began as `ShellOnlySection`, for SSH hosts alone: a saved SSH host used
 * to render six cards whose entire content was one sentence of apology each.
 * The same was true of every other kind, just less of it. A phone rendered a
 * sandbox card and a workspace card saying a phone hosts neither, a remote
 * host and this machine rendered an Access card saying they hold no grants,
 * and a worker rendered a capability card saying its vocabulary is a
 * different one. Each was ~110px of card chrome around a line of text, and
 * they sat between the cards that had something to show.
 *
 * Nothing is lost. Each row is the exact sentence the card it replaces would
 * have rendered, keyed by `planDeviceSections`, so a reader who wants to know
 * why a host has no grants still reads the same answer in the same words. It
 * is simply said once, at the end, in the shape the pane uses for records.
 */

import { CircleSlashIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import type { DeviceNotApplicable } from "@/lib/devices/section-plan"
import { NOT_APPLICABLE_SECTION_ID } from "@/lib/devices/section-plan"
import type { DeviceKind } from "@/lib/devices/types"

import { DeviceSection } from "../device-section"
import { DeviceFactList, DeviceFactRow } from "../device-visuals"

export interface NotApplicableSectionProps {
  kind: DeviceKind
  entries: readonly DeviceNotApplicable[]
  wide: boolean
}

export function NotApplicableSection({ kind, entries, wide }: NotApplicableSectionProps) {
  const t = useTranslations("devices")
  if (entries.length === 0) return null
  return (
    <DeviceSection
      id={NOT_APPLICABLE_SECTION_ID}
      title={t("notApplicable.title")}
      icon={CircleSlashIcon}
      description={t(`notApplicable.description.${kind}`)}
      wide={wide}
    >
      <DeviceFactList>
        {entries.map((entry) => (
          <DeviceFactRow key={entry.id} label={t(entry.labelKey)}>
            <span data-testid={`not-applicable-${entry.id}`}>{t(entry.reasonKey)}</span>
          </DeviceFactRow>
        ))}
      </DeviceFactList>
    </DeviceSection>
  )
}
