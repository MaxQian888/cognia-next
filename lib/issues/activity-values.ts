/**
 * ICU values for one line of an issue's activity trail.
 *
 * Statuses, priorities and actors are localized at render time rather than
 * stored localized, so switching language relabels history too.
 *
 * Extracted from `components/issues/issue-detail-panel.tsx` when the mobile
 * detail sheet grew the same trail. Two copies of this would drift the moment
 * a payload gained a field, and the drift would show up as a raw enum name in
 * one shell and a localized one in the other.
 */

export interface IssueActivityPayload {
  kind: string
  from?: unknown
  to?: unknown
}

/** Translate function shape both shells already have from `useTranslations`. */
export type ActivityTranslate = (key: string) => string

/**
 * `{ from, to }` for `t("activity.<kind>", ...)`.
 *
 * A payload half that is absent, or is of a shape this trail does not
 * describe, resolves to the empty string rather than `undefined`: ICU renders
 * a missing argument as the literal placeholder text, which is how a timeline
 * ends up displaying `{to}` to a user.
 */
export function activityValues(
  payload: IssueActivityPayload | null | undefined,
  t: ActivityTranslate
): Record<string, string> {
  // Tolerates a missing payload rather than throwing. This is called on rows
  // that now cross the companion wire, so an event written by a host running
  // an older shape reaches a phone that expects this one, and a timeline is
  // not worth taking the whole detail sheet down for.
  const kind = payload?.kind ?? ""
  const localize = (value: unknown): string => {
    if (typeof value === "string") {
      if (kind === "status_changed") return t(`status.${value}`)
      if (kind === "priority_changed") return t(`priority.${value}`)
      return value
    }
    if (value && typeof value === "object" && "kind" in value) {
      const actor = value as { kind: string; label?: string }
      return actor.label ?? t(`actor.${actor.kind}`)
    }
    return ""
  }
  return { from: localize(payload?.from), to: localize(payload?.to) }
}
