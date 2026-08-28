"use client"

import { Button } from "@cognia/plugin-ui"
import type { SreFinding } from "../evidence"
import { canConclude, type SreIncident } from "../incident/model"
import { usePluginT } from "../use-plugin-t"

function FindingList({ items, emptyLabel }: { items: SreFinding[]; emptyLabel: string }) {
  if (items.length === 0) {
    return <p className="text-xs text-muted-foreground">{emptyLabel}</p>
  }
  return (
    <ul className="space-y-1">
      {items.map((item, index) => (
        <li key={`${item.text}-${index}`} className="text-xs" data-testid="sre-finding">
          {item.text}
          {item.evidenceIds.length > 0 ? (
            <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">
              {item.evidenceIds.join(" ")}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

/**
 * Findings, recommendations, and the one irreversible-ish act in the panel.
 *
 * The accept button is rendered even when it cannot be pressed, with the reason
 * next to it. Hiding it would collapse three different answers — "no timeline
 * yet", "not checked yet", and "the check failed" — into the same blank space.
 */
export function ConclusionCard({
  incident,
  onConclude,
}: {
  incident: SreIncident
  onConclude: () => void
}) {
  const t = usePluginT()
  const check = canConclude(incident)

  return (
    <section className="space-y-2" data-testid="sre-conclusion">
      <h3 className="text-xs font-medium">{t("conclusion.title")}</h3>

      <div className="space-y-1">
        <h4 className="text-xs text-muted-foreground">{t("conclusion.findings")}</h4>
        <FindingList items={incident.findings} emptyLabel={t("conclusion.none")} />
      </div>

      <div className="space-y-1">
        <h4 className="text-xs text-muted-foreground">{t("conclusion.recommendations")}</h4>
        <FindingList items={incident.recommendations} emptyLabel={t("conclusion.none")} />
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button
          size="sm"
          className="h-6 px-2 text-xs"
          disabled={!check.ok}
          onClick={onConclude}
          data-testid="sre-conclude"
        >
          {incident.concludedAt ? t("conclusion.accepted") : t("conclusion.accept")}
        </Button>
        {check.blocker ? (
          <span className="text-xs text-muted-foreground" data-testid="sre-conclude-blocked">
            {t(`conclusion.blocked.${check.blocker}`)}
          </span>
        ) : null}
      </div>
    </section>
  )
}
