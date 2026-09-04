"use client"

/**
 * Stage 4 — generate, and show exactly what that sends.
 *
 * The preview is not a summary or a reconstruction: it renders
 * `envelope.systemPrompt` / `envelope.userPrompt`, and `generate` sends those
 * same strings. `generation-envelope.test.ts` pins the byte-identity, which is
 * what makes the claim on this screen true rather than aspirational.
 *
 * When no model resolves, the fallback is a *complete* skill written from the
 * reviewed timeline — not a stub with TODOs. A template the user has to fill in
 * from scratch is barely better than an empty editor, and the timeline already
 * knows the steps.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { ShieldCheck, Sparkles } from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Spinner } from "@/components/ui/spinner"
import type { GenerationEnvelope } from "@/lib/skills/recording/generation-envelope"
import { intersectAllowedTools } from "@/lib/skills/recording/tool-catalog"
import { useRecorderStore } from "@/stores/skills/recorder-store"
import { useRecorderDraft, useRecorderPhase } from "@/hooks/skills/use-skill-recorder"
import { DraftDiffView } from "./draft-diff-view"

interface Props {
  buildEnvelope: () => Promise<GenerationEnvelope>
  onGenerate: () => void
  onRegenerate: () => void
  onManualTemplate: () => void
  hasModel: boolean
  /**
   * Variable suggestions still awaiting an answer. Non-zero blocks every path
   * out of this screen: the reducer refuses `GENERATE_REQUESTED`, so an enabled
   * button here would just do nothing.
   */
  unconfirmedVariables: number
  toolCatalog: readonly string[]
}

export function StageGenerate({
  buildEnvelope,
  onGenerate,
  onRegenerate,
  onManualTemplate,
  hasModel,
  unconfirmedVariables,
  toolCatalog,
}: Props) {
  const t = useTranslations("skills.recorder")
  const phase = useRecorderPhase()
  const draft = useRecorderDraft()
  const candidate = useRecorderStore((state) => state.candidateDraft)
  const draftStale = useRecorderStore((state) => state.draftStale)
  const dispatch = useRecorderStore((state) => state.dispatch)
  const toolsConfirmed = useRecorderStore((state) => state.toolsConfirmed)
  const setToolsConfirmed = useRecorderStore((state) => state.setToolsConfirmed)

  const [envelope, setEnvelope] = useState<GenerationEnvelope | null>(null)

  useEffect(() => {
    let cancelled = false
    void buildEnvelope().then((next) => {
      if (!cancelled) setEnvelope(next)
    })
    return () => {
      cancelled = true
    }
  }, [buildEnvelope])

  const generating = phase === "generating"
  const blocked = unconfirmedVariables > 0
  const tools = draft ? intersectAllowedTools(draft.allowedTools, toolCatalog) : null

  return (
    <div className="space-y-5">
      <Collapsible defaultOpen>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="px-2">
            <ShieldCheck className="size-4" aria-hidden />
            {t("generate.preview")}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-2 pt-2">
          <p className="text-xs text-muted-foreground">{t("generate.previewDescription")}</p>
          {envelope ? (
            <>
              {envelope.redacted ? (
                <Alert>
                  <AlertDescription className="text-xs">{t("generate.redacted")}</AlertDescription>
                </Alert>
              ) : null}
              {envelope.truncatedSteps > 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t("generate.truncated", { count: envelope.truncatedSteps })}
                </p>
              ) : null}
              <div className="space-y-1">
                <Label className="text-xs">{t("generate.previewSystem")}</Label>
                <pre className="max-h-40 overflow-auto rounded-md border bg-muted/40 p-2 text-[11px] leading-relaxed whitespace-pre-wrap">
                  {envelope.systemPrompt}
                </pre>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t("generate.previewUser")}</Label>
                <pre className="max-h-60 overflow-auto rounded-md border bg-muted/40 p-2 text-[11px] leading-relaxed whitespace-pre-wrap">
                  {envelope.userPrompt}
                </pre>
              </div>
            </>
          ) : (
            <Spinner className="size-4" />
          )}
        </CollapsibleContent>
      </Collapsible>

      <div className="flex flex-wrap items-center gap-2">
        {draft ? (
          <Button
            size="sm"
            variant="outline"
            onClick={onRegenerate}
            disabled={generating || blocked}
          >
            <Sparkles className="size-4" aria-hidden />
            {t("generate.regenerate")}
          </Button>
        ) : (
          <Button size="sm" onClick={onGenerate} disabled={generating || !hasModel || blocked}>
            {generating ? (
              <Spinner className="size-4" />
            ) : (
              <Sparkles className="size-4" aria-hidden />
            )}
            {generating ? t("generate.running") : t("generate.run")}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={onManualTemplate}
          disabled={generating || blocked}
        >
          {t("generate.manualFallback")}
        </Button>
      </div>

      {blocked ? (
        <Alert>
          <AlertDescription className="space-y-1 text-xs">
            <p>{t("generate.blockedByVariables", { count: unconfirmedVariables })}</p>
            <p className="text-muted-foreground">{t("generate.blockedByVariablesHint")}</p>
          </AlertDescription>
        </Alert>
      ) : null}

      {!hasModel ? (
        <p className="text-xs text-muted-foreground">
          {t("generate.noModel")} {t("generate.manualFallbackHint")}
        </p>
      ) : null}

      {draftStale ? (
        <Alert>
          <AlertDescription className="space-y-1 text-xs">
            <p>{t("generate.stale")}</p>
            <p className="text-muted-foreground">{t("generate.staleHint")}</p>
          </AlertDescription>
        </Alert>
      ) : null}

      {candidate && draft ? (
        <DraftDiffView
          current={draft.content}
          candidate={candidate.content}
          onAccept={(content) =>
            dispatch({ type: "MERGE_CANDIDATE", draft: { ...candidate, content } })
          }
          onDiscard={() => dispatch({ type: "DISCARD_CANDIDATE" })}
        />
      ) : null}

      {tools ? (
        <section className="flex flex-col gap-2 border-y py-3">
          <h3 className="text-sm font-medium">{t("generate.tools.title")}</h3>
          <p className="text-xs text-muted-foreground">{t("generate.tools.description")}</p>
          {tools.kept.length === 0 && tools.unknown.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("generate.tools.none")}</p>
          ) : null}
          {tools.kept.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {tools.kept.map((name) => (
                <Badge key={name} variant="secondary">
                  {name}
                </Badge>
              ))}
            </div>
          ) : null}
          {tools.unknown.length > 0 ? (
            <p className="text-xs text-destructive">
              {t("generate.tools.unknown", { count: tools.unknown.length })}
            </p>
          ) : null}
          {!toolsConfirmed ? (
            <Button size="sm" variant="outline" onClick={() => setToolsConfirmed(true)}>
              {t("generate.tools.confirm")}
            </Button>
          ) : null}
        </section>
      ) : null}

      {draft ? (
        <section className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="recorder-draft-name">{t("draft.name")}</Label>
            <Input
              id="recorder-draft-name"
              value={draft.name}
              onChange={(event) =>
                dispatch({ type: "DRAFT_EDITED", patch: { name: event.target.value } })
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="recorder-draft-description">{t("draft.descriptionField")}</Label>
            <Input
              id="recorder-draft-description"
              value={draft.description}
              onChange={(event) =>
                dispatch({ type: "DRAFT_EDITED", patch: { description: event.target.value } })
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="recorder-draft-content">{t("draft.content")}</Label>
            <Textarea
              id="recorder-draft-content"
              rows={12}
              className="font-mono text-xs"
              value={draft.content}
              onChange={(event) =>
                dispatch({ type: "DRAFT_EDITED", patch: { content: event.target.value } })
              }
            />
          </div>
        </section>
      ) : null}
    </div>
  )
}
