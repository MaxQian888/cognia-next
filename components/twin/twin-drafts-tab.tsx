"use client"

import { useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { motion, useReducedMotion } from "motion/react"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { StatusBadge } from "@/components/status-badge"
import {
  listTwinDraftsByTwin,
  markTwinDraftAccepted,
  markTwinDraftRejected,
  updateTwinDraftPayload,
} from "@/lib/db/twin-drafts"
import { createCharacter } from "@/lib/db/characters"
import { createSkill } from "@/lib/db/skills"
import { DraftEditorDialog } from "./draft-editor-dialog"
import { UnredactDialog } from "./unredact-dialog"
import { assertDraftBodyClean, DraftPiiError } from "@/lib/twin/distill/draft-pii-guard"
import {
  previewUnredact,
  applyUnredactSelection,
  type UnredactPlaceholder,
} from "@/lib/twin/distill/unredact-draft"
import type { TwinDraft, TwinDraftPayload } from "@/types/twin"

const STATUS_VARIANT: Record<
  TwinDraft["status"],
  "default" | "secondary" | "destructive" | "outline"
> = {
  pending: "outline",
  accepted: "default",
  rejected: "destructive",
  edited: "secondary",
}

type QualityKey = "qualityHigh" | "qualityMedium" | "qualityLow" | "qualityUnscored"

function qualityKey(score?: number): QualityKey {
  if (typeof score !== "number") return "qualityUnscored"
  if (score >= 0.75) return "qualityHigh"
  if (score >= 0.5) return "qualityMedium"
  return "qualityLow"
}

export function TwinDraftsTab({ twinId }: { twinId: string }) {
  const t = useTranslations("twin.drafts")
  const tKind = useTranslations("twin.kind")
  const prefersReducedMotion = useReducedMotion()
  const drafts = useLiveQuery(() => listTwinDraftsByTwin(twinId), [twinId], [])
  const sorted = [...drafts].sort((a, b) => {
    // Pending first; among pending, lowest qualityScore first.
    if (a.status !== b.status) return a.status === "pending" ? -1 : 1
    const sa = a.evaluation?.qualityScore ?? Number.POSITIVE_INFINITY
    const sb = b.evaluation?.qualityScore ?? Number.POSITIVE_INFINITY
    return sa - sb
  })

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-lg font-medium">{t("headerCount", { count: drafts.length })}</h2>
      {drafts.length === 0 ? (
        <Card className="p-6 text-center">
          <p className="text-muted-foreground text-sm">{t("emptyHint")}</p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {sorted.map((draft, index) => (
            <motion.li
              key={draft.id}
              initial={prefersReducedMotion ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                duration: 0.15,
                ease: "easeOut",
                delay: prefersReducedMotion ? 0 : Math.min(index * 0.03, 0.15),
              }}
              className="list-none"
            >
              <DraftRow draft={draft} t={t} tKind={tKind} />
            </motion.li>
          ))}
        </ul>
      )}
    </div>
  )
}

function DraftRow({
  draft,
  t,
  tKind,
}: {
  draft: TwinDraft
  t: ReturnType<typeof useTranslations>
  tKind: ReturnType<typeof useTranslations>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [unredactOpen, setUnredactOpen] = useState(false)
  const [unredactPlaceholders, setUnredactPlaceholders] = useState<UnredactPlaceholder[]>([])
  const data = draft.payload.data as Record<string, unknown>
  const name = typeof data.name === "string" ? data.name : t("untitled")
  const description = typeof data.description === "string" ? data.description : undefined
  const body =
    typeof data.systemPrompt === "string"
      ? data.systemPrompt
      : typeof data.content === "string"
        ? data.content
        : ""

  const handleEditSave = async (next: TwinDraftPayload) => {
    setError(null)
    try {
      assertDraftBodyClean(next)
    } catch (err) {
      if (err instanceof DraftPiiError) {
        const fields = err.violations.map((v) => v.field).join(", ")
        throw new Error(t("piiInDraft", { fields }))
      }
      throw err
    }
    await updateTwinDraftPayload(draft.id, next)
    setEditorOpen(false)
  }

  const qKey = qualityKey(draft.evaluation?.qualityScore)
  const qualityText = t(qKey)

  // Write the accepted payload as a real Character / Skill row. `payload` is
  // the draft payload after any PII restore — fields are re-derived from it so
  // restored originals (not placeholders) land in the created row.
  const finalizeAccept = async (payload: TwinDraftPayload) => {
    const pData = payload.data as Record<string, unknown>
    const pName = typeof pData.name === "string" ? pData.name : t("untitled")
    const pDescription = typeof pData.description === "string" ? pData.description : undefined
    const pBody =
      typeof pData.systemPrompt === "string"
        ? pData.systemPrompt
        : typeof pData.content === "string"
          ? pData.content
          : ""
    let acceptedId: string
    if (payload.kind === "character") {
      const character = await createCharacter({
        name: pName,
        description: pDescription,
        avatarColor: "oklch(0.7 0.15 240)",
        systemPrompt: pBody,
        twinId: draft.twinId,
      })
      acceptedId = character.id
    } else {
      const skill = await createSkill({
        name: pName,
        description: pDescription,
        content: pBody,
      })
      acceptedId = skill.id
    }
    await markTwinDraftAccepted(draft.id, acceptedId)
  }

  // Accept entry point. When the draft still carries restorable PII placeholders
  // (`<EMAIL_001>` etc.), open the unredact dialog first so the user decides
  // which originals to restore; otherwise write the row straight away.
  const beginAccept = async () => {
    setBusy(true)
    setError(null)
    try {
      const preview = await previewUnredact(draft, draft.twinId)
      if (preview.placeholders.length > 0) {
        setUnredactPlaceholders(preview.placeholders)
        setUnredactOpen(true)
        setBusy(false)
        return
      }
      await finalizeAccept(draft.payload)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const confirmUnredact = async (
    selection: ReadonlyArray<Pick<UnredactPlaceholder, "placeholder" | "original" | "keep">>
  ) => {
    setBusy(true)
    setError(null)
    try {
      await finalizeAccept(applyUnredactSelection(draft.payload, selection))
      setUnredactOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const reject = async () => {
    setBusy(true)
    setError(null)
    try {
      await markTwinDraftRejected(draft.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{tKind(draft.payload.kind)}</Badge>
          <StatusBadge
            value={draft.status}
            labelNamespace="twin.status"
            variantMap={STATUS_VARIANT}
            data-testid={`twin-draft-${draft.id}-status`}
          />
          <Badge variant="outline">{t("qualityLabel", { label: qualityText })}</Badge>
          <span className="font-medium">{name}</span>
        </div>
        <span className="text-muted-foreground text-xs">
          {new Date(draft.createdAt).toLocaleString()}
        </span>
      </div>
      {description ? <p className="text-muted-foreground text-sm">{description}</p> : null}
      <ScrollArea className="bg-muted max-h-48 rounded">
        <pre className="p-2 text-xs whitespace-pre-wrap">{body || t("emptyBody")}</pre>
      </ScrollArea>
      {draft.evaluation && draft.evaluation.concerns.length > 0 ? (
        <ul className="text-destructive list-disc pl-5 text-xs">
          {draft.evaluation.concerns.map((concern, i) => (
            <li key={i}>{concern}</li>
          ))}
        </ul>
      ) : null}
      {draft.evaluation && draft.evaluation.suggestions.length > 0 ? (
        <ul className="text-muted-foreground list-disc pl-5 text-xs">
          {draft.evaluation.suggestions.map((suggestion, i) => (
            <li key={i}>{suggestion}</li>
          ))}
        </ul>
      ) : null}
      <p className="text-muted-foreground text-xs italic">{draft.provenance.rationale}</p>
      {error ? (
        <p className="text-destructive text-xs" role="alert">
          {error}
        </p>
      ) : null}
      {draft.status === "pending" ? (
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setEditorOpen(true)}
            disabled={busy}
            data-testid={`twin-draft-edit-${draft.id}`}
          >
            {t("edit")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => void reject()} disabled={busy}>
            {t("reject")}
          </Button>
          <Button size="sm" onClick={() => void beginAccept()} disabled={busy}>
            {t("accept")}
          </Button>
        </div>
      ) : null}
      <DraftEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        draft={draft}
        onSave={handleEditSave}
        busy={busy}
      />
      <UnredactDialog
        open={unredactOpen}
        onOpenChange={setUnredactOpen}
        placeholders={unredactPlaceholders}
        onConfirm={confirmUnredact}
        busy={busy}
      />
    </Card>
  )
}
