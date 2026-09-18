"use client"

import { useTranslations } from "next-intl"
import { BotIcon, BrainCircuitIcon, PuzzleIcon, SparklesIcon, UsersIcon } from "lucide-react"
import type { ToolUIPart } from "ai"
import { PreviewClampNote, TOOL_LIST_MAX_ROWS, useClampedRows, useParsedOutput } from "./common"

type EntityKind = "skill" | "character" | "twin" | "plugin" | "agent-team" | string

interface RuntimeEntity {
  id?: string
  name?: string
  description?: string
  kind?: EntityKind
}

interface RuntimeQueryOutput {
  kind?: EntityKind
  entityType?: EntityKind
  entities?: RuntimeEntity[]
}

const ICON_BY_KIND: Record<string, typeof BotIcon> = {
  skill: SparklesIcon,
  character: BotIcon,
  twin: BrainCircuitIcon,
  plugin: PuzzleIcon,
  "agent-team": UsersIcon,
}

export function RuntimeQueryCard({ part }: { part: ToolUIPart }) {
  const t = useTranslations("chat.mcp.runtimeQuery")
  const parsed = useParsedOutput<RuntimeQueryOutput>(part.output)
  const entities = parsed && Array.isArray(parsed.entities) ? parsed.entities : []
  // Hooks precede the null guard — the clamp budget is stable either way.
  const clamped = useClampedRows(entities, TOOL_LIST_MAX_ROWS)
  if (!parsed || !Array.isArray(parsed.entities)) return null

  const kind = parsed.kind || parsed.entityType
  const Icon = (kind && ICON_BY_KIND[kind as string]) || BotIcon

  return (
    <div data-testid="mcp-runtime-query-card" className="my-1 text-xs">
      {clamped.total === 0 ? (
        <p className="text-muted-foreground">{t("noneFound")}</p>
      ) : (
        <>
          <ul className="space-y-1">
            {clamped.visible.map((e, i) => (
              <li
                key={e.id || i}
                className="flex items-start gap-2"
                data-testid="mcp-runtime-query-row"
                data-id={e.id}
                data-kind={kind}
              >
                <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">{e.name ?? e.id}</span>
                  {e.description && (
                    <span className="line-clamp-2 text-muted-foreground">{e.description}</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {clamped.hidden > 0 && (
            <PreviewClampNote
              shown={clamped.shown}
              total={clamped.total}
              onExpand={clamped.reveal}
              testId="mcp-runtime-query-clamped"
            />
          )}
        </>
      )}
    </div>
  )
}
