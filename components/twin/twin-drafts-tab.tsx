"use client"

import { useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  listTwinDraftsByTwin,
  markTwinDraftAccepted,
  markTwinDraftRejected,
} from "@/lib/db/twin-drafts"
import { createCharacter } from "@/lib/db/characters"
import { createSkill } from "@/lib/db/skills"
import type { TwinDraft } from "@/types/twin"

const STATUS_VARIANT: Record<
  TwinDraft["status"],
  "default" | "secondary" | "destructive" | "outline"
> = {
  pending: "outline",
  accepted: "default",
  rejected: "destructive",
  edited: "secondary",
}

function qualityBadge(score?: number): string {
  if (typeof score !== "number") return "unscored"
  if (score >= 0.75) return "high"
  if (score >= 0.5) return "medium"
  return "low"
}

export function TwinDraftsTab({ twinId }: { twinId: string }) {
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
      <h2 className="text-lg font-medium">Drafts ({drafts.length})</h2>
      {drafts.length === 0 ? (
        <Card className="p-6 text-center">
          <p className="text-muted-foreground text-sm">
            No drafts yet. Queue a distill run from the Jobs tab once at least one source has been
            parsed into chunks.
          </p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {sorted.map((draft) => (
            <DraftRow key={draft.id} draft={draft} />
          ))}
        </ul>
      )}
    </div>
  )
}

function DraftRow({ draft }: { draft: TwinDraft }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const data = draft.payload.data as Record<string, unknown>
  const name = typeof data.name === "string" ? data.name : "(untitled)"
  const description = typeof data.description === "string" ? data.description : undefined
  const body =
    typeof data.systemPrompt === "string"
      ? data.systemPrompt
      : typeof data.content === "string"
        ? data.content
        : ""

  const accept = async () => {
    setBusy(true)
    setError(null)
    try {
      let acceptedId: string
      if (draft.payload.kind === "character") {
        const character = await createCharacter({
          name,
          description,
          avatarColor: "oklch(0.7 0.15 240)",
          systemPrompt: body,
          twinId: draft.twinId,
        })
        acceptedId = character.id
      } else {
        const skill = await createSkill({
          name,
          description,
          content: body,
        })
        acceptedId = skill.id
      }
      await markTwinDraftAccepted(draft.id, acceptedId)
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
          <Badge variant="outline" className="capitalize">
            {draft.payload.kind}
          </Badge>
          <Badge variant={STATUS_VARIANT[draft.status]} className="capitalize">
            {draft.status}
          </Badge>
          <Badge variant="outline">quality: {qualityBadge(draft.evaluation?.qualityScore)}</Badge>
          <span className="font-medium">{name}</span>
        </div>
        <span className="text-muted-foreground text-xs">
          {new Date(draft.createdAt).toLocaleString()}
        </span>
      </div>
      {description ? <p className="text-muted-foreground text-sm">{description}</p> : null}
      <pre className="bg-muted max-h-48 overflow-auto rounded p-2 text-xs whitespace-pre-wrap">
        {body || "(empty body)"}
      </pre>
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
          <Button size="sm" variant="outline" onClick={() => void reject()} disabled={busy}>
            Reject
          </Button>
          <Button size="sm" onClick={() => void accept()} disabled={busy}>
            Accept
          </Button>
        </div>
      ) : null}
    </Card>
  )
}
