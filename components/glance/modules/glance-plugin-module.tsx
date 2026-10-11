"use client"

/**
 * A plugin's glance module (ADR-0225 §6), rendered from the data the plugin
 * published, with the host's own primitives: a plugin never ships React into
 * a glance surface, so its module looks and behaves like every other.
 *
 * - compact: one line, the summary (or the first stat);
 * - standard: the stats strip, the first rows, the actions;
 * - expanded: every row.
 *
 * Actions and row clicks run the plugin's own commands through the main
 * window (`plugin-action`). On a paired phone the module is the desktop's:
 * actions are shown but disabled, with the reason, because a phone does not
 * run a desktop plugin's commands.
 */

import { createElement, useState } from "react"
import { useTranslations } from "next-intl"
import { PuzzleIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { resolveIcon } from "@/lib/a2ui/resolve-icon"
import { cn } from "@/lib/utils"
import type { GlancePluginAction, GlancePluginTone } from "@/lib/glance/plugin-data"
import type { GlanceModuleSize, GlancePluginEntryId } from "@/types/glance/layout"

import { useGlance } from "../glance-context"
import {
  GlanceCompactSection,
  GlanceRow,
  GlanceSection,
  GlanceStats,
  type GlanceTone,
} from "../glance-primitives"

/** Rows a standard-size module shows before "N more". */
export const GLANCE_PLUGIN_STANDARD_ROWS = 3

const TONE: Record<GlancePluginTone, GlanceTone> = {
  default: "default",
  ok: "ok",
  warn: "warn",
  crit: "crit",
  muted: "muted",
}

const TONE_TEXT: Record<GlancePluginTone, string> = {
  default: "",
  ok: "text-success",
  warn: "text-warning",
  crit: "text-destructive",
  muted: "text-muted-foreground",
}

function ActionIcon({ name }: { name?: string }) {
  const icon = name ? resolveIcon(name) : null
  return icon ? createElement(icon, { "aria-hidden": true, className: "size-3.5" }) : null
}

export function GlancePluginModule({
  entryId,
  size,
}: {
  entryId: GlancePluginEntryId
  size: GlanceModuleSize
}) {
  const t = useTranslations("glance.plugin")
  const tErrors = useTranslations("glance")
  const { snapshot, send, originOf, platform } = useGlance()
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const def = snapshot.plugins?.catalog.find((entry) => entry.id === entryId) ?? null
  if (!def) return null
  const published = snapshot.plugins?.modules[entryId] ?? null
  const data = published?.data ?? null
  const fromDesktop = originOf?.(entryId)?.kind === "host"
  const actions = data?.actions ?? []
  const actionById = new Map(actions.map((action) => [action.id, action]))

  const run = async (action: GlancePluginAction) => {
    if (fromDesktop) return
    setPending(action.id)
    setError(null)
    const errorKey = await send({ kind: "plugin-action", entryId, actionId: action.id })
    setPending(null)
    if (errorKey) setError(errorKey)
  }

  const title = def.title
  const icon = def.icon ? resolveIcon(def.icon) : null
  const glyph = createElement(icon ?? PuzzleIcon, {
    "aria-hidden": true,
    className: "size-3.5 shrink-0 text-muted-foreground",
  })

  if (size === "compact") {
    const first = data?.stats?.[0]
    const summary =
      data?.summary ?? (first ? `${first.label} ${first.value}` : (data?.empty ?? null))
    const primary = actions[0]
    return (
      <GlanceCompactSection
        moduleId={entryId}
        title={title}
        label={primary && !fromDesktop ? primary.label : undefined}
        onClick={primary && !fromDesktop ? () => void run(primary) : undefined}
      >
        {glyph}
        <span
          className={cn(
            "truncate",
            !data && "text-muted-foreground",
            first && !data?.summary && first.tone ? TONE_TEXT[first.tone] : ""
          )}
          data-testid={`glance-plugin-summary-${entryId}`}
        >
          {summary ?? t(data ? "empty" : "waiting")}
        </span>
      </GlanceCompactSection>
    )
  }

  const rows = data?.rows ?? []
  const shownRows = size === "expanded" ? rows : rows.slice(0, GLANCE_PLUGIN_STANDARD_ROWS)
  const hiddenRows = rows.length - shownRows.length
  const stats = data?.stats ?? []

  return (
    <GlanceSection moduleId={entryId} title={title} meta={glyph}>
      {!data ? (
        <p className="py-1 text-[12px] text-muted-foreground">{t("waiting")}</p>
      ) : stats.length === 0 && rows.length === 0 ? (
        <p className="py-1 text-[12px] text-muted-foreground">{data.empty ?? t("empty")}</p>
      ) : null}
      {stats.length > 0 ? (
        <GlanceStats
          stats={stats.map((stat, index) => ({
            key: `${index}`,
            label: stat.label,
            value: stat.value,
            tone: stat.tone ? TONE[stat.tone] : undefined,
          }))}
        />
      ) : null}
      {shownRows.map((row) => {
        const action = row.action ? actionById.get(row.action) : undefined
        return (
          <GlanceRow
            key={row.id}
            testId={`glance-plugin-row-${entryId}-${row.id}`}
            sub={row.hint}
            trailing={
              row.value ? (
                <span
                  className={cn(
                    "shrink-0 tabular-nums",
                    row.tone ? TONE_TEXT[row.tone] : "text-muted-foreground"
                  )}
                >
                  {row.value}
                </span>
              ) : null
            }
            onClick={action && !fromDesktop ? () => void run(action) : undefined}
            label={action && !fromDesktop ? `${row.label} · ${action.label}` : undefined}
          >
            <span className={row.tone && !row.value ? TONE_TEXT[row.tone] : undefined}>
              {row.label}
            </span>
          </GlanceRow>
        )
      })}
      {hiddenRows > 0 ? (
        <p className="pt-0.5 text-[11.5px] text-muted-foreground">
          {t("moreRows", { count: hiddenRows })}
        </p>
      ) : null}
      {actions.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {actions.map((action) => (
            <Button
              key={action.id}
              size="sm"
              variant="secondary"
              className={platform === "mobile" ? "h-9 px-3 text-[13px]" : "h-6 px-2 text-[11.5px]"}
              disabled={fromDesktop || pending !== null}
              title={fromDesktop ? t("desktopOnly") : undefined}
              onClick={() => void run(action)}
              data-testid={`glance-plugin-action-${entryId}-${action.id}`}
            >
              <ActionIcon name={action.icon} />
              {action.label}
            </Button>
          ))}
          {fromDesktop ? (
            <span className="text-[11.5px] text-muted-foreground">{t("desktopOnly")}</span>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p className="mt-1 text-[11.5px] text-destructive" role="status">
          {tErrors(error)}
        </p>
      ) : null}
    </GlanceSection>
  )
}
