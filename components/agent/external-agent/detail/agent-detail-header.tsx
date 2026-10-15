"use client"

import type { ReactNode } from "react"
import { useTranslations } from "next-intl"

import { BrandIcon } from "@/components/icons/brand-icon"
import { DuplicatedFromHint } from "@/components/agent/external-agent/instance-traits"

export interface AgentDetailHeaderProps {
  name: string
  protocol: string
  transport: string
  stateIsolation?: "isolated" | "shared"
  presetId?: string | null
  sourceName?: string | null
  onOpenSource?: () => void
  menu?: ReactNode
  headingId?: string
}

export function AgentDetailHeader({
  name,
  protocol,
  transport,
  stateIsolation,
  presetId,
  sourceName,
  onOpenSource,
  menu,
  headingId,
}: AgentDetailHeaderProps) {
  const t = useTranslations("externalAgent.settings")
  const tInstances = useTranslations("externalAgent.instances")
  const transportLabel =
    transport === "stdio"
      ? t("transportStdioLabel")
      : transport === "http"
        ? t("transportHttpLabel")
        : transport
  const meta = [protocol.toUpperCase(), transportLabel]
  if (transport === "stdio") {
    meta.push(tInstances(stateIsolation === "isolated" ? "traits.isolated" : "traits.shared"))
  }

  return (
    <div className="flex min-w-0 items-start gap-3" data-testid="agent-detail-header">
      <BrandIcon id={presetId ?? name} label={name} size={32} />
      <div className="min-w-0 flex-1 space-y-1">
        <h3
          id={headingId}
          data-detail-heading={headingId}
          tabIndex={-1}
          className="break-words text-lg font-semibold outline-none"
        >
          {name}
        </h3>
        <p className="text-sm text-muted-foreground">{meta.join(" · ")}</p>
        <DuplicatedFromHint sourceName={sourceName ?? null} onOpenSource={onOpenSource} />
      </div>
      {menu ? <div className="shrink-0">{menu}</div> : null}
    </div>
  )
}
