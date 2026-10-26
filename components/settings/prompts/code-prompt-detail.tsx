"use client"

/**
 * Detail of one code-owned prompt slot (ADR-0236 §4, §5.2, §7).
 *
 * The published configuration and the evidence of use are separate facts on
 * this page: the slot's binding says what is published at the chosen scope,
 * the resolution log says what the last call in this window actually used,
 * and the activation label says when a publish reaches its consumer. The
 * editor never loses typing to a concurrent write: it remembers the binding
 * revision it was seeded from, every write names that revision, and a slot
 * that moved underneath an unsaved edit is reported rather than reloaded over
 * it.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react"
import { useFormatter } from "next-intl"
import { toast } from "sonner"
import { AlertTriangleIcon, InfoIcon } from "lucide-react"
import { LineDiffView } from "@/components/diff/line-diff-view"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useLastPromptResolution } from "@/hooks/prompts/use-last-prompt-resolution"
import { usePromptSlot, usePromptSlots } from "@/hooks/prompts/use-prompt-slots"
import { computeDiff } from "@/lib/artifacts/diff"
import { isPromptOverrideConflict, type PromptOverrideRevisionRow } from "@/lib/db/prompt-overrides"
import {
  discardPromptDraft,
  PromptScopeError,
  PromptValidationError,
  publishPromptBody,
  resetPromptToInherited,
  restorePromptRevision,
  savePromptDraft,
  shippedBodyDigest,
} from "@/lib/prompts/service"
import { validatePromptBody } from "@/lib/prompts/template"
import type { PromptDefinitionV1, PromptTargetRef } from "@/lib/prompts/types"
import { issueMessage, PromptBodyEditor } from "./prompt-body-editor"
import { PromptHistory } from "./prompt-history"
import { PromptTargetPicker } from "./prompt-target-picker"
import { usePromptLabels } from "./use-prompt-labels"

const ACCOUNT: PromptTargetRef = { scope: "account", targetId: "" }

type CompareBase = "shipped" | "published"

export function CodePromptDetail({ def }: { def: PromptDefinitionV1 }) {
  const labels = usePromptLabels()
  const { t } = labels
  const format = useFormatter()
  const inspectOnly = def.operation === "inspect-only"
  const [target, setTarget] = useState<PromptTargetRef>({
    scope: def.scopes[0] ?? "account",
    targetId: "",
  })
  const targetChosen = target.scope === "account" || target.targetId !== ""
  const data = usePromptSlot(def.id, targetChosen ? target : ACCOUNT)
  const slot = targetChosen ? data?.slot : undefined
  const revisions = targetChosen ? (data?.revisions ?? []) : []
  const slots = usePromptSlots(def.id)
  const lastResolution = useLastPromptResolution(def.id)

  // The editor's text and the binding revision it was seeded from.
  const savedText = slot?.draft?.body ?? slot?.active?.body ?? def.defaultBody
  const slotRev = slot?.binding?.rev ?? 0
  const seedKey = `${target.scope}:${target.targetId}`
  const [text, setText] = useState(savedText)
  const [seed, setSeed] = useState<{ key: string; rev: number; text: string } | null>(null)
  const loaded = !targetChosen || data !== undefined
  if (loaded && (seed === null || seed.key !== seedKey)) {
    setSeed({ key: seedKey, rev: slotRev, text: savedText })
    setText(savedText)
  }
  const dirty = seed !== null && text !== seed.text
  // A write elsewhere moved the slot: follow it unless the user has edits.
  if (seed && seed.key === seedKey && slotRev !== seed.rev && !dirty) {
    setSeed({ key: seedKey, rev: slotRev, text: savedText })
    setText(savedText)
  }
  const stale = seed !== null && seed.key === seedKey && slotRev !== seed.rev && dirty

  const [busy, setBusy] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [view, setView] = useState("edit")
  const [compareBase, setCompareBase] = useState<CompareBase>("shipped")
  const issues = useMemo(
    () => (inspectOnly ? [] : validatePromptBody(def, text)),
    [def, inspectOnly, text]
  )

  const [shippedDigest, setShippedDigest] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void shippedBodyDigest(def).then((digest) => {
      if (!cancelled) setShippedDigest(digest)
    })
    return () => {
      cancelled = true
    }
  }, [def])
  const active = slot?.active
  const upstreamChanged = Boolean(active && shippedDigest && active.baseDigest !== shippedDigest)
  const contractMismatch = Boolean(active && active.contractVersion !== def.contractVersion)

  // What the slot falls back to without its own override: the account
  // override for a narrower scope, else the shipped body. A conversation may
  // still meet a narrower workspace or agent override; the dialog says so.
  const accountSlot = slots?.find((candidate) => candidate.binding?.scope === "account")
  const inheritedText =
    target.scope !== "account" && accountSlot?.active ? accountSlot.active.body : def.defaultBody

  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true)
    try {
      await action()
      toast.success(success)
      // The slot moved because of this editor: the text just written is the
      // clean baseline, so the live update that follows reseeds the editor
      // instead of being held back as someone else's change.
      const written = text
      setSeed((previous) => (previous ? { ...previous, text: written } : previous))
    } catch (error) {
      if (isPromptOverrideConflict(error)) toast.error(t("toast.conflict"))
      else if (error instanceof PromptValidationError) {
        toast.error(error.issues.map((issue) => issueMessage(t, issue)).join(" "))
      } else if (error instanceof PromptScopeError) toast.error(t("toast.scope"))
      else
        toast.error(
          t("toast.failed", { message: error instanceof Error ? error.message : String(error) })
        )
    } finally {
      setBusy(false)
    }
  }

  const expectedRev = seed?.rev ?? slotRev
  const publish = () =>
    run(() => publishPromptBody({ def, target, body: text, expectedRev }), t("toast.published"))
  const saveDraft = () =>
    run(() => savePromptDraft({ def, target, body: text, expectedRev }), t("toast.draftSaved"))
  const discard = () =>
    run(() => discardPromptDraft({ def, target, expectedRev }), t("toast.draftDiscarded"))
  const reset = () =>
    run(() => resetPromptToInherited({ def, target, expectedRev }), t("toast.reset"))
  const restore = (revision: PromptOverrideRevisionRow) =>
    run(
      () => restorePromptRevision({ def, target, revisionId: revision.id, expectedRev }),
      t("toast.restored")
    )

  const compareFrom = compareBase === "published" && active ? active.body : def.defaultBody
  const diff = useMemo(() => computeDiff(compareFrom, text), [compareFrom, text])

  return (
    <div className="space-y-4" data-testid="code-prompt-detail">
      <header className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">{labels.entryTitle(def.id)}</h3>
          <Badge variant="outline" className="text-[10px]">
            {t(`kind.${def.kind}`)}
          </Badge>
          <Badge variant="outline" className="text-[10px]">
            {t(`operation.${def.operation}`)}
          </Badge>
          {def.risk !== "ordinary" ? (
            <Badge
              variant="outline"
              className="border-amber-500/40 text-[10px] text-amber-700 dark:text-amber-400"
            >
              {t(`risk.${def.risk}`)}
            </Badge>
          ) : null}
        </div>
        <p className="font-mono text-[11px] text-muted-foreground">{def.id}</p>
        {labels.entryDescription(def.id) ? (
          <p className="text-xs text-muted-foreground">{labels.entryDescription(def.id)}</p>
        ) : null}
      </header>

      <dl className="grid gap-x-4 gap-y-2 rounded-md border bg-muted/30 p-3 text-xs @[620px]/settings-pane:grid-cols-2">
        <Fact label={t("facts.activation")}>{t(`activation.${def.activation}`)}</Fact>
        <Fact label={t("facts.hosts")}>
          {def.hosts.map((host) => t(`host.${host}`)).join(" · ")}
        </Fact>
        <Fact label={t("facts.risk")}>{t(`riskNote.${def.risk}`)}</Fact>
        <Fact label={t("facts.lastUsed")}>
          {lastResolution
            ? lastResolution.source.kind === "override"
              ? t("lastUsed.override", {
                  scope: t(`scope.${lastResolution.source.scope}`),
                  time: format.dateTime(lastResolution.at, { timeStyle: "medium" }),
                })
              : lastResolution.source.fallback
                ? t("lastUsed.fallback", {
                    reason: t(`fallback.${lastResolution.source.fallback}`),
                    time: format.dateTime(lastResolution.at, { timeStyle: "medium" }),
                  })
                : t("lastUsed.default", {
                    time: format.dateTime(lastResolution.at, { timeStyle: "medium" }),
                  })
            : t("lastUsed.never")}
        </Fact>
        {def.outputContract ? (
          <Fact label={t("facts.outputContract")} wide>
            {def.outputContract}
          </Fact>
        ) : null}
        {def.requiredFragments.length > 0 ? (
          <Fact label={t("facts.requiredFragments")} wide>
            <span className="flex flex-wrap gap-1">
              {def.requiredFragments.map((fragment) => (
                <code key={fragment} className="rounded bg-background px-1 font-mono text-[11px]">
                  {fragment}
                </code>
              ))}
            </span>
          </Fact>
        ) : null}
        <Fact label={t("facts.consumers")} wide>
          <span className="flex flex-col gap-0.5">
            {def.consumers.map((consumer) => (
              <code key={consumer} className="font-mono text-[11px]">
                {consumer}
              </code>
            ))}
          </span>
        </Fact>
        {slots && slots.some((candidate) => candidate.active) ? (
          <Fact label={t("facts.overrides")} wide>
            <span className="flex flex-wrap gap-1">
              {slots
                .filter((candidate) => candidate.active && candidate.binding)
                .map((candidate) => (
                  <Badge key={candidate.binding!.id} variant="secondary" className="text-[10px]">
                    {candidate.binding!.scope === "account"
                      ? t("scope.account")
                      : `${t(`scope.${candidate.binding!.scope}`)} · ${candidate.binding!.targetId}`}
                  </Badge>
                ))}
            </span>
          </Fact>
        ) : null}
      </dl>

      {inspectOnly ? (
        <div className="space-y-2">
          <Alert>
            <InfoIcon className="size-4" />
            <AlertTitle>{t("inspectOnly.title")}</AlertTitle>
            <AlertDescription>{t("inspectOnly.body")}</AlertDescription>
          </Alert>
          <PromptBodyEditor
            value={def.defaultBody}
            onChange={() => undefined}
            readOnly
            label={t("editor.shippedLabel")}
          />
        </div>
      ) : (
        <>
          <PromptTargetPicker
            scopes={def.scopes}
            scope={target.scope}
            targetId={target.targetId}
            onChange={setTarget}
          />

          {!targetChosen ? (
            <p className="text-xs text-muted-foreground">{t(`target.choose.${target.scope}`)}</p>
          ) : seed === null || seed.key !== seedKey ? (
            // The editor appears once the slot is read, so nothing typed can
            // be replaced by the text the slot loads with.
            <p className="text-xs text-muted-foreground">{t("owner.loading")}</p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground" data-testid="prompt-slot-status">
                {active
                  ? t("status.published", {
                      time: format.dateTime(active.createdAt, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      }),
                    })
                  : t("status.inherits")}
                {slot?.draft ? ` ${t("status.hasDraft")}` : ""}
              </p>
              {contractMismatch ? (
                <Alert variant="destructive">
                  <AlertTriangleIcon className="size-4" />
                  <AlertTitle>{t("warnings.contractTitle")}</AlertTitle>
                  <AlertDescription>{t("warnings.contractBody")}</AlertDescription>
                </Alert>
              ) : null}
              {upstreamChanged && !contractMismatch ? (
                <Alert>
                  <InfoIcon className="size-4" />
                  <AlertTitle>{t("warnings.upstreamTitle")}</AlertTitle>
                  <AlertDescription>{t("warnings.upstreamBody")}</AlertDescription>
                </Alert>
              ) : null}
              {stale ? (
                <Alert variant="destructive">
                  <AlertTriangleIcon className="size-4" />
                  <AlertTitle>{t("warnings.staleTitle")}</AlertTitle>
                  <AlertDescription className="flex flex-wrap items-center gap-2">
                    {t("warnings.staleBody")}
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() => setSeed(null)}
                    >
                      {t("actions.loadLatest")}
                    </Button>
                  </AlertDescription>
                </Alert>
              ) : null}

              <Tabs value={view} onValueChange={setView}>
                <TabsList>
                  <TabsTrigger value="edit">{t("tabs.edit")}</TabsTrigger>
                  <TabsTrigger value="compare">{t("tabs.compare")}</TabsTrigger>
                  <TabsTrigger value="history">
                    {t("tabs.history", { count: revisions.length })}
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="edit" className="space-y-3">
                  <PromptBodyEditor
                    value={text}
                    onChange={setText}
                    variables={def.variables}
                    issues={issues}
                    maxChars={def.maxChars}
                    label={labels.entryTitle(def.id)}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      disabled={busy || issues.length > 0 || stale}
                      onClick={() => void publish()}
                    >
                      {t("actions.publish")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || !dirty || stale || text.length > def.maxChars}
                      onClick={() => void saveDraft()}
                    >
                      {t("actions.saveDraft")}
                    </Button>
                    {slot?.draft ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy || stale}
                        onClick={() => void discard()}
                      >
                        {t("actions.discardDraft")}
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy || text === def.defaultBody}
                      onClick={() => setText(def.defaultBody)}
                    >
                      {t("actions.useShipped")}
                    </Button>
                    {dirty ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setText(seed?.text ?? savedText)}
                      >
                        {t("actions.revertEdits")}
                      </Button>
                    ) : null}
                    {active ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        disabled={busy || stale}
                        onClick={() => setConfirmReset(true)}
                      >
                        {t("actions.reset")}
                      </Button>
                    ) : null}
                  </div>
                </TabsContent>
                <TabsContent value="compare" className="space-y-2">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-muted-foreground">{t("compare.against")}</span>
                    <Select
                      value={compareBase}
                      onValueChange={(next) => setCompareBase(next as CompareBase)}
                    >
                      <SelectTrigger
                        className="h-7 w-[180px] text-xs"
                        aria-label={t("compare.against")}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="shipped" className="text-xs">
                          {t("compare.shipped")}
                        </SelectItem>
                        {active ? (
                          <SelectItem value="published" className="text-xs">
                            {t("compare.published")}
                          </SelectItem>
                        ) : null}
                      </SelectContent>
                    </Select>
                  </div>
                  {diff.some((line) => line.type !== "unchanged") ? (
                    <LineDiffView
                      lines={diff}
                      wrap
                      maxHeight={480}
                      aria-label={t("compare.diffLabel")}
                    />
                  ) : (
                    <p className="text-xs text-muted-foreground">{t("compare.identical")}</p>
                  )}
                </TabsContent>
                <TabsContent value="history">
                  <PromptHistory
                    revisions={revisions}
                    activeRevisionId={slot?.binding?.activeRevisionId ?? null}
                    draftRevisionId={slot?.binding?.draftRevisionId ?? null}
                    currentText={text}
                    inheritedText={inheritedText}
                    busy={busy || stale}
                    onRestore={(revision) => void restore(revision)}
                    onLoadDraft={(revision) => {
                      setText(revision.body)
                      setView("edit")
                    }}
                  />
                </TabsContent>
              </Tabs>
            </>
          )}
        </>
      )}

      <AlertDialog open={confirmReset} onOpenChange={setConfirmReset}>
        <AlertDialogContent className="max-w-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("resetDialog.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {target.scope === "account"
                ? t("resetDialog.bodyAccount")
                : t("resetDialog.bodyScoped")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-2 font-mono text-[11px]">
            {inheritedText}
          </pre>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmReset(false)
                void reset()
              }}
            >
              {t("actions.reset")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function Fact({
  label,
  wide = false,
  children,
}: {
  label: string
  wide?: boolean
  children: ReactNode
}) {
  return (
    <div className={wide ? "@[620px]/settings-pane:col-span-2" : undefined}>
      <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  )
}
