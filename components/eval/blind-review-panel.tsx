"use client"

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import type { BlindPairInput, BlindPublicAssignment } from "@cognia/eval-core"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  adjudicateEvalReview,
  createBlindReviewBatch,
  createEvalReviewBundle,
  importEvalReviewBundle,
  openBlindReviewBatch,
  reviewAgreement,
  type EvalReviewBundle,
} from "@/lib/ai/eval/review-service"
import type { EvalReportCaseEvidence } from "@/lib/ai/eval/report-view"
import { refreshEvalRecommendationAfterReview } from "@/lib/ai/eval/finalization"
import { mergeEvalReviewVotes, type EvalReviewVoteRow } from "@/lib/db/eval-lab"
import { getDb } from "@/lib/db/schema"

export function buildBlindReviewPairs(cases: EvalReportCaseEvidence[]): BlindPairInput[] {
  const groups = new Map<string, EvalReportCaseEvidence[]>()
  for (const item of cases) {
    const key = `${item.case.id}:${item.repetition}`
    const rows = groups.get(key) ?? []
    rows.push(item)
    groups.set(key, rows)
  }
  const pairs: BlindPairInput[] = []
  for (const [key, rows] of groups) {
    const sorted = [...rows].sort((left, right) => left.variantId.localeCompare(right.variantId))
    for (let leftIndex = 0; leftIndex < sorted.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < sorted.length; rightIndex += 1) {
        const left = sorted[leftIndex]
        const right = sorted[rightIndex]
        pairs.push({
          pairId: `${key}:${left.variantId}:${right.variantId}`,
          first: {
            variantId: left.variantId,
            sampleId: left.sampleId,
            output: left.sample.output,
          },
          second: {
            variantId: right.variantId,
            sampleId: right.sampleId,
            output: right.sample.output,
          },
        })
      }
    }
  }
  return pairs
}

export function BlindReviewPanel({
  experimentId,
  cases,
  artifactKey,
  seed,
  onRecommendationChanged,
}: {
  experimentId: string
  cases: EvalReportCaseEvidence[]
  artifactKey: Uint8Array | null
  seed: number
  onRecommendationChanged?: () => void | Promise<void>
}) {
  const t = useTranslations("eval")
  const pairs = useMemo(() => buildBlindReviewPairs(cases), [cases])
  const [batchId, setBatchId] = useState("")
  const [assignments, setAssignments] = useState<BlindPublicAssignment[]>([])
  const [assignmentIndex, setAssignmentIndex] = useState(0)
  const [reviewerId, setReviewerId] = useState("")
  const [votes, setVotes] = useState<EvalReviewVoteRow[]>([])
  const [password, setPassword] = useState("")
  const [bundleText, setBundleText] = useState("")
  const [adjudicatorId, setAdjudicatorId] = useState("")
  const [reasoning, setReasoning] = useState("")
  const [error, setError] = useState<string | null>(null)
  const assignment = assignments[assignmentIndex]
  const agreement = reviewAgreement(votes)

  const refreshVotes = async (id: string) => {
    setVotes(await getDb().evalReviewVotes.where("batchId").equals(id).toArray())
  }

  const createBatch = async () => {
    if (!artifactKey || !pairs.length) return
    setError(null)
    try {
      const batch = await createBlindReviewBatch({ experimentId, pairs, seed, artifactKey })
      const opened = await openBlindReviewBatch(batch.id, artifactKey)
      setBatchId(batch.id)
      setAssignments(opened.assignments)
      setAssignmentIndex(0)
      await refreshVotes(batch.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const vote = async (preference: EvalReviewVoteRow["preference"]) => {
    if (!assignment || !batchId || !reviewerId.trim()) return
    const row: EvalReviewVoteRow = {
      id: crypto.randomUUID(),
      batchId,
      experimentId,
      pairId: assignment.pairId,
      reviewerId: reviewerId.trim(),
      preference,
      rubric: {},
      createdAt: Date.now(),
    }
    await mergeEvalReviewVotes([row])
    await refreshVotes(batchId)
    if (artifactKey) {
      await refreshEvalRecommendationAfterReview(experimentId, artifactKey)
      await onRecommendationChanged?.()
    }
    setAssignmentIndex((current) => Math.min(assignments.length - 1, current + 1))
  }

  const exportBundle = async () => {
    if (!artifactKey || !batchId || !password) return
    setBundleText(
      JSON.stringify(await createEvalReviewBundle(batchId, artifactKey, votes, password), null, 2)
    )
  }

  const importBundle = async () => {
    if (!password || !bundleText) return
    setError(null)
    try {
      await importEvalReviewBundle(JSON.parse(bundleText) as EvalReviewBundle, password)
      if (batchId) await refreshVotes(batchId)
      if (artifactKey) {
        await refreshEvalRecommendationAfterReview(experimentId, artifactKey)
        await onRecommendationChanged?.()
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const adjudicate = async (decision: "a" | "b" | "tie" | "exclude") => {
    if (!artifactKey || !batchId || !assignment || !adjudicatorId.trim()) return
    await adjudicateEvalReview({
      batchId,
      pairId: assignment.pairId,
      adjudicatorId: adjudicatorId.trim(),
      decision,
      reasoning: reasoning.trim() || undefined,
      artifactKey,
    })
    await refreshEvalRecommendationAfterReview(experimentId, artifactKey)
    await onRecommendationChanged?.()
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>{t("lab.review.blind.title")}</CardTitle>
            <CardDescription>{t("lab.review.blind.description")}</CardDescription>
          </div>
          <Badge variant="secondary">
            {t("lab.review.blind.pairCount", { count: pairs.length })}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>{t("lab.review.blind.error")}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {!pairs.length ? (
          <p className="text-sm text-muted-foreground">{t("lab.review.blind.noPairs")}</p>
        ) : null}
        <Button disabled={!artifactKey || !pairs.length} onClick={() => void createBatch()}>
          {t("lab.review.blind.create")}
        </Button>
        {assignment ? (
          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="min-h-32 rounded-lg border p-4">
                <Badge>{t("lab.review.blind.left")}</Badge>
                <p className="mt-3 whitespace-pre-wrap text-sm">{assignment.left.output}</p>
              </div>
              <div className="min-h-32 rounded-lg border p-4">
                <Badge>{t("lab.review.blind.right")}</Badge>
                <p className="mt-3 whitespace-pre-wrap text-sm">{assignment.right.output}</p>
              </div>
            </div>
            <div className="grid gap-2 sm:max-w-sm">
              <Label htmlFor="eval-reviewer-id">{t("lab.review.blind.reviewer")}</Label>
              <Input
                id="eval-reviewer-id"
                value={reviewerId}
                onChange={(event) => setReviewerId(event.target.value)}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button disabled={!reviewerId.trim()} onClick={() => void vote("a")}>
                {t("lab.review.blind.preferLeft")}
              </Button>
              <Button disabled={!reviewerId.trim()} onClick={() => void vote("b")}>
                {t("lab.review.blind.preferRight")}
              </Button>
              <Button
                variant="outline"
                disabled={!reviewerId.trim()}
                onClick={() => void vote("tie")}
              >
                {t("lab.review.blind.tie")}
              </Button>
              <Button
                variant="ghost"
                disabled={!reviewerId.trim()}
                onClick={() => void vote("abstain")}
              >
                {t("lab.review.blind.abstain")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("lab.review.blind.progress", {
                current: assignmentIndex + 1,
                total: assignments.length,
              })}
            </p>
            <Alert>
              <AlertTitle>{t("lab.review.blind.agreement")}</AlertTitle>
              <AlertDescription>
                {t("lab.review.blind.agreementValue", {
                  eligible: agreement.eligiblePairs,
                  agreed: agreement.agreedPairs,
                  rate: agreement.agreementRate,
                })}
              </AlertDescription>
            </Alert>
            <div className="grid gap-3 rounded-lg border p-4">
              <div className="grid gap-2 sm:max-w-sm">
                <Label htmlFor="eval-review-password">{t("lab.review.blind.password")}</Label>
                <Input
                  id="eval-review-password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>
              <Label htmlFor="eval-review-bundle">{t("lab.review.blind.bundle")}</Label>
              <Textarea
                id="eval-review-bundle"
                value={bundleText}
                onChange={(event) => setBundleText(event.target.value)}
                className="min-h-28 font-mono text-xs"
              />
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" disabled={!password} onClick={() => void exportBundle()}>
                  {t("lab.review.blind.export")}
                </Button>
                <Button
                  variant="outline"
                  disabled={!password || !bundleText}
                  onClick={() => void importBundle()}
                >
                  {t("lab.review.blind.import")}
                </Button>
              </div>
            </div>
            <div className="grid gap-3 rounded-lg border p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="eval-adjudicator-id">{t("lab.review.blind.adjudicator")}</Label>
                  <Input
                    id="eval-adjudicator-id"
                    value={adjudicatorId}
                    onChange={(event) => setAdjudicatorId(event.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="eval-adjudication-reasoning">
                    {t("lab.review.blind.reasoning")}
                  </Label>
                  <Input
                    id="eval-adjudication-reasoning"
                    value={reasoning}
                    onChange={(event) => setReasoning(event.target.value)}
                  />
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {(["a", "b", "tie", "exclude"] as const).map((decision) => (
                  <Button
                    key={decision}
                    variant="outline"
                    disabled={!adjudicatorId.trim()}
                    onClick={() => void adjudicate(decision)}
                  >
                    {t(`lab.review.blind.decisions.${decision}`)}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
