"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  buildBlindReviewPairs,
  type EvalReviewService,
  type EvalReviewSnapshot,
  type EvalReviewMutationResult,
} from "@/lib/ai/eval/review-service"
import type { EvalReportCaseEvidence } from "@cognia/eval-core"

interface BlindReviewPanelProps {
  experimentId: string
  cases: EvalReportCaseEvidence[]
  service: EvalReviewService | null
  seed: number
  onRecommendationChanged?: () => void | Promise<void>
}

/** Remount sensitive review state whenever the experiment or host scope changes. */
export function BlindReviewPanel(props: BlindReviewPanelProps) {
  return (
    <BlindReviewSession
      key={`${props.service?.scopeId ?? "locked"}:${props.experimentId}`}
      {...props}
    />
  )
}

function BlindReviewSession({
  experimentId,
  cases,
  service,
  seed,
  onRecommendationChanged,
}: BlindReviewPanelProps) {
  const t = useTranslations("eval")
  const pairs = useMemo(() => buildBlindReviewPairs(cases), [cases])
  const [snapshot, setSnapshot] = useState<EvalReviewSnapshot | null>(null)
  const batchId = snapshot?.batchId ?? ""
  const assignments = snapshot?.assignments ?? []
  const [assignmentIndex, setAssignmentIndex] = useState(0)
  const [reviewerId, setReviewerId] = useState("")
  const [password, setPassword] = useState("")
  const [bundleText, setBundleText] = useState("")
  const [adjudicatorId, setAdjudicatorId] = useState("")
  const [reasoning, setReasoning] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(Boolean(service))
  const [pendingRecommendation, setPendingRecommendation] = useState(false)
  const busyRef = useRef(Boolean(service))
  const active = useRef(true)
  const assignment = assignments[assignmentIndex]
  const agreement = snapshot?.agreement ?? { eligiblePairs: 0, agreedPairs: 0, agreementRate: 0 }

  useEffect(() => {
    let current = true
    active.current = true
    if (service) {
      void service
        .load({ experimentId })
        .then((loaded) => {
          if (current && active.current) {
            setSnapshot(loaded)
            setPendingRecommendation(loaded?.recommendationPending ?? false)
          }
        })
        .catch((cause: unknown) => {
          if (current && active.current)
            setError(cause instanceof Error ? cause.message : String(cause))
        })
        .finally(() => {
          if (current && active.current) {
            busyRef.current = false
            setBusy(false)
          }
        })
    }
    return () => {
      current = false
      active.current = false
    }
  }, [service, experimentId])

  const perform = async (operation: () => Promise<void>) => {
    if (!service || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await operation()
    } catch (cause) {
      if (active.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (active.current) {
        busyRef.current = false
        setBusy(false)
      }
    }
  }

  const applyMutation = async (result: EvalReviewMutationResult) => {
    if (!active.current) return
    setSnapshot(result.snapshot)
    setPendingRecommendation(result.recommendation.status === "pending")
    if (result.recommendation.status === "pending") setError(result.recommendation.message)
    else await onRecommendationChanged?.()
  }

  const createBatch = () =>
    perform(async () => {
      const opened = await service!.open({ experimentId, cases, seed })
      if (!active.current) return
      setSnapshot(opened)
      setAssignmentIndex(0)
    })

  const vote = (preference: "a" | "b" | "tie" | "abstain") =>
    perform(async () => {
      if (!assignment || !batchId || !reviewerId.trim()) return
      const result = await service!.vote({
        experimentId,
        batchId,
        pairId: assignment.pairId,
        reviewerId,
        preference,
      })
      if (!active.current) return
      setAssignmentIndex((current) => Math.min(result.snapshot.assignments.length - 1, current + 1))
      await applyMutation(result)
    })

  const exportBundle = () =>
    perform(async () => {
      const text = await service!.exportBundle({ experimentId, batchId, password })
      if (active.current) setBundleText(text)
    })

  const importBundle = () =>
    perform(async () => {
      await applyMutation(
        await service!.importBundle({ experimentId, batchId, text: bundleText, password })
      )
    })

  const adjudicate = (decision: "a" | "b" | "tie" | "exclude") =>
    perform(async () => {
      if (!assignment || !batchId || !adjudicatorId.trim()) return
      await applyMutation(
        await service!.adjudicate({
          experimentId,
          batchId,
          pairId: assignment.pairId,
          adjudicatorId,
          decision,
          reasoning,
        })
      )
    })

  const retryRecommendation = () =>
    perform(async () => {
      await applyMutation(await service!.refreshRecommendation({ experimentId, batchId }))
    })

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
        {pendingRecommendation ? (
          <Alert>
            <AlertTitle>{t("lab.review.blind.refreshPending")}</AlertTitle>
            <AlertDescription>
              <Button variant="outline" disabled={busy} onClick={() => void retryRecommendation()}>
                {t("lab.review.blind.retryRefresh")}
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        {!pairs.length ? (
          <p className="text-sm text-muted-foreground">{t("lab.review.blind.noPairs")}</p>
        ) : null}
        <Button disabled={busy || !service || !pairs.length} onClick={() => void createBatch()}>
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
              <Button disabled={busy || !reviewerId.trim()} onClick={() => void vote("a")}>
                {t("lab.review.blind.preferLeft")}
              </Button>
              <Button disabled={busy || !reviewerId.trim()} onClick={() => void vote("b")}>
                {t("lab.review.blind.preferRight")}
              </Button>
              <Button
                variant="outline"
                disabled={busy || !reviewerId.trim()}
                onClick={() => void vote("tie")}
              >
                {t("lab.review.blind.tie")}
              </Button>
              <Button
                variant="ghost"
                disabled={busy || !reviewerId.trim()}
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
                <Button
                  variant="outline"
                  disabled={busy || !password}
                  onClick={() => void exportBundle()}
                >
                  {t("lab.review.blind.export")}
                </Button>
                <Button
                  variant="outline"
                  disabled={busy || !password || !bundleText}
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
                    disabled={busy || !adjudicatorId.trim()}
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
