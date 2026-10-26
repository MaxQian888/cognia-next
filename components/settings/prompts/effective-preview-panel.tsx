"use client"

/**
 * The effective chat preview (ADR-0236 §4 "Effective preview", R5): which
 * text a new chat starts from for a chosen agent, mode and workspace, in the
 * order the send path joins it, with where each part comes from and its size.
 * Sections only a live turn can produce are listed as assembled at send time,
 * never guessed at.
 */

import { useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { ChevronRightIcon, RefreshCwIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useEffectiveChatPreview } from "@/hooks/prompts/use-effective-chat-preview"
import { useAgentMode } from "@/hooks/agent/use-agent-mode"
import { listResolvedCharacters } from "@/lib/db/characters"
import type { EffectiveSegment } from "@/lib/prompts/effective-preview"
import { cn } from "@/lib/utils"
import { usePromptLabels } from "./use-prompt-labels"

/** Select value standing for "no agent" / "no mode". */
const NONE = "__none__"

export interface EffectivePreviewPanelProps {
  workspaceId: string | null
}

export function EffectivePreviewPanel({ workspaceId }: EffectivePreviewPanelProps) {
  const { t } = usePromptLabels()
  const [agentId, setAgentId] = useState<string | null>(null)
  const [modeId, setModeId] = useState<string | null>(null)
  const characters = useLiveQuery(() => listResolvedCharacters(), [])
  // Every mode a chat can be in: built-in, the user's and enabled plugins'.
  // A built-in mode without a prompt adds no section, so it is not offered.
  const { builtInModes, customModes, pluginModes } = useAgentMode()
  const modes = [
    ...builtInModes.filter((mode) => mode.systemPrompt),
    ...customModes,
    ...pluginModes,
  ]
  const { state, reload } = useEffectiveChatPreview({ agentId, modeId, workspaceId })

  return (
    <div className="space-y-4" data-testid="effective-preview-panel">
      <header className="space-y-1">
        <h3 className="text-sm font-semibold">{t("preview.title")}</h3>
        <p className="text-xs text-muted-foreground">{t("preview.description")}</p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={agentId ?? NONE}
          onValueChange={(next) => setAgentId(next === NONE ? null : next)}
        >
          <SelectTrigger className="h-8 min-w-[180px] text-xs" aria-label={t("preview.agent")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE} className="text-xs">
              {t("preview.noAgent")}
            </SelectItem>
            {(characters ?? []).map((character) => (
              <SelectItem key={character.id} value={character.id} className="text-xs">
                {character.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={modeId ?? NONE}
          onValueChange={(next) => setModeId(next === NONE ? null : next)}
        >
          <SelectTrigger className="h-8 min-w-[160px] text-xs" aria-label={t("preview.mode")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE} className="text-xs">
              {t("preview.noMode")}
            </SelectItem>
            {modes.map((mode) => (
              <SelectItem key={mode.id} value={mode.id} className="text-xs">
                {mode.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" variant="ghost" className="h-8 gap-1 text-xs" onClick={reload}>
          <RefreshCwIcon className="size-3.5" />
          {t("preview.refresh")}
        </Button>
      </div>

      {state.status === "loading" ? (
        <p className="text-xs text-muted-foreground">{t("preview.loading")}</p>
      ) : state.status === "error" ? (
        <p className="text-xs text-destructive">{t("preview.failed", { message: state.error })}</p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground" data-testid="effective-preview-total">
            {t("preview.total", { chars: state.preview.chars, tokens: state.preview.tokens })}
          </p>
          <ol className="space-y-2" aria-label={t("preview.segments")}>
            {state.preview.segments.map((segment, index) => (
              <SegmentRow key={`${segment.kind}-${index}`} segment={segment} position={index + 1} />
            ))}
          </ol>
          {state.preview.omitted.length > 0 ? (
            <section className="space-y-1">
              <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {t("preview.omittedTitle")}
              </h4>
              <ul className="space-y-0.5 text-xs text-muted-foreground">
                {state.preview.omitted.map((omission) => (
                  <li key={omission.kind}>
                    {t(`segment.${omission.kind}`)} — {t(`omission.${omission.reason}`)}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <section className="space-y-1">
            <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {t("preview.sendTimeTitle")}
            </h4>
            <p className="text-xs text-muted-foreground">{t("preview.sendTimeBody")}</p>
            <div className="flex flex-wrap gap-1">
              {state.preview.sendTime.map((section) => (
                <Badge key={section} variant="outline" className="text-[10px]">
                  {t(`sendTime.${section}`)}
                </Badge>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  )
}

function SegmentRow({ segment, position }: { segment: EffectiveSegment; position: number }) {
  const { t } = usePromptLabels()
  const [open, setOpen] = useState(false)
  return (
    <li className="rounded-md border">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            className="flex h-auto w-full items-center justify-between gap-2 whitespace-normal px-3 py-2 text-left"
          >
            <span className="flex min-w-0 items-center gap-2">
              <ChevronRightIcon
                className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
              />
              <span className="text-[10px] tabular-nums text-muted-foreground">{position}</span>
              <span className="text-xs font-medium">{t(`segment.${segment.kind}`)}</span>
              <span className="truncate text-[11px] text-muted-foreground">
                {segment.baseSource ? t(`baseSource.${segment.baseSource}`) : null}
                {segment.label ? ` · ${segment.label}` : null}
              </span>
            </span>
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
              {segment.kind === "skills"
                ? t("preview.skillsCount", { count: segment.items?.length ?? 0 })
                : t("preview.size", { chars: segment.chars, tokens: segment.tokens })}
            </span>
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="border-t px-3 py-2">
          {segment.kind === "skills" ? (
            <div className="space-y-1">
              <p className="text-[11px] text-muted-foreground">{t("preview.skillsNote")}</p>
              <ul className="flex flex-wrap gap-1">
                {segment.items?.map((name) => (
                  <li key={name}>
                    <Badge variant="secondary" className="text-[10px]">
                      {name}
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed">
              {segment.text}
            </pre>
          )}
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}
