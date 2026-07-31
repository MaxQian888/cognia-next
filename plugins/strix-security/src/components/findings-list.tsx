"use client"

import { ShieldCheck } from "lucide-react"
import type { StrixFinding } from "../types"
import { usePluginT } from "../use-plugin-t"
import { FindingCard } from "./finding-card"

export function FindingsList({ findings }: { findings: StrixFinding[] }) {
  const t = usePluginT()

  if (findings.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center gap-2 py-8 text-center text-sm text-muted-foreground"
        data-testid="strix-findings-empty"
      >
        <ShieldCheck className="size-6 text-emerald-500" />
        <p>{t("findings.none")}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2" data-testid="strix-findings">
      <h3 className="text-xs font-semibold uppercase text-muted-foreground">
        {t("findings.count", { count: findings.length })}
      </h3>
      {findings.map((f) => (
        <FindingCard key={`${f.runId}:${f.vulnId}:${f.id ?? ""}`} finding={f} />
      ))}
    </div>
  )
}
