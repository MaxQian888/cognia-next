"use client"

/**
 * The one control for the conversation auto-archive policy
 * (`AppSettings.conversationArchive.autoArchiveAfterDays`), reused by
 * Settings → Conversation (`card`) and the conversation manager's Archived tab
 * header (`inline`), so the two can never offer different choices.
 *
 * The choices come from `AUTO_ARCHIVE_AFTER_DAYS_OPTIONS` plus Off. A stored
 * value outside that list reads as Off — the same answer the sweep gives — and
 * nothing is written until the user picks.
 *
 * On a paired client the Host owns the conversations and runs the sweep over
 * its own rows (`lib/chat/auto-archive-schedule.ts` skips itself here), so the
 * control is shown disabled with a note that the Host decides. The predicate is
 * the one the routed session writes use (`hostOwnsSessionState`), read through
 * the runtime snapshot so the control follows a pairing that changes while it
 * is mounted.
 */

import { useId } from "react"
import { useTranslations } from "next-intl"

import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useRuntimeSnapshot } from "@/hooks/use-runtime-snapshot"
import { useSettingsPatch } from "@/hooks/use-settings-patch"
import {
  AUTO_ARCHIVE_AFTER_DAYS_OPTIONS,
  isAutoArchiveAfterDays,
  resolveAutoArchiveAfterDays,
} from "@/lib/chat/auto-archive"
import { hostOwnsSessionState } from "@/lib/db/mobile-outbound-queue"
import { cn } from "@/lib/utils"
import { useSettingsStore } from "@/stores/settings"

const OFF = "off"

export interface AutoArchiveControlProps {
  /** `card`: full row for a settings card. `inline`: compact, for a toolbar. */
  variant?: "card" | "inline"
  className?: string
}

export function AutoArchiveControl({ variant = "card", className }: AutoArchiveControlProps) {
  const t = useTranslations("conversations.autoArchive")
  const archive = useSettingsStore((s) => s.settings?.conversationArchive)
  const patch = useSettingsPatch()
  const hostOwned = hostOwnsSessionState(useRuntimeSnapshot())
  const baseId = useId()
  const selectId = `${baseId}-select`
  const descriptionId = `${baseId}-description`
  const noteId = `${baseId}-host-note`

  const afterDays = resolveAutoArchiveAfterDays(archive)
  // The Host's value is not mirrored to a client, so a disabled client shows
  // the placeholder rather than a local value that governs nothing.
  const value = hostOwned ? "" : afterDays === null ? OFF : String(afterDays)

  const onValueChange = (next: string) => {
    if (hostOwned) return
    const days = next === OFF ? null : Number(next)
    if (days !== null && !isAutoArchiveAfterDays(days)) return
    void patch({ conversationArchive: { ...archive, autoArchiveAfterDays: days } })
  }

  const describedBy = hostOwned ? `${descriptionId} ${noteId}` : descriptionId
  const inline = variant === "inline"

  const select = (
    <Select value={value} onValueChange={onValueChange} disabled={hostOwned}>
      <SelectTrigger
        id={selectId}
        size={inline ? "sm" : "default"}
        aria-label={t("selectLabel")}
        aria-describedby={describedBy}
        className={inline ? "w-auto min-w-[9rem]" : "w-[15rem]"}
        data-testid="auto-archive-select"
      >
        <SelectValue placeholder={t("hostPlaceholder")} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={OFF}>{t("options.off")}</SelectItem>
        {AUTO_ARCHIVE_AFTER_DAYS_OPTIONS.map((days) => (
          <SelectItem key={days} value={String(days)}>
            {t("options.days", { count: days })}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )

  const hostNote = hostOwned ? (
    <p
      id={noteId}
      className={cn("text-muted-foreground", inline ? "text-xs" : "text-sm")}
      data-testid="auto-archive-host-note"
    >
      {t("hostDecides")}
    </p>
  ) : null

  if (inline) {
    return (
      <div
        className={cn("flex flex-wrap items-center gap-2", className)}
        data-testid="auto-archive-control"
        data-variant="inline"
      >
        <Label htmlFor={selectId} className="text-xs font-medium text-muted-foreground">
          {t("label")}
        </Label>
        {select}
        {/* Compact: the full explanation stays available to assistive tech
            and as the trigger's description, without taking toolbar room. */}
        <span id={descriptionId} className="sr-only">
          {t("description")}
        </span>
        {hostNote}
      </div>
    )
  }

  return (
    <div
      className={cn("space-y-2", className)}
      data-testid="auto-archive-control"
      data-variant="card"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label htmlFor={selectId}>{t("label")}</Label>
          <p id={descriptionId} className="text-sm text-muted-foreground">
            {t("description")}
          </p>
        </div>
        {select}
      </div>
      {hostNote}
    </div>
  )
}

export default AutoArchiveControl
