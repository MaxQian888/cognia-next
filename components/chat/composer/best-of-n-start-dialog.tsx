"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { RunEstimateHint } from "@/components/usage/run-estimate-hint"
import { bestOfNEstimateQueries } from "@/lib/best-of-n/estimate-queries"
import type { PreparedBestOfN } from "@/lib/best-of-n/entry"

export function BestOfNStartDialog({
  prepared,
  onConfirm,
  onCancel,
}: {
  prepared: PreparedBestOfN
  onConfirm(target: { targetRef: string; targetIsNew: boolean }, agents: string[]): Promise<void>
  onCancel(): void
}) {
  const t = useTranslations("bestOfNEntry")
  const [targetIsNew, setTargetIsNew] = useState(true)
  const [targetRef, setTargetRef] = useState(prepared.targetRef)
  const [agents, setAgents] = useState(prepared.agents)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onCancel()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title", { count: prepared.n })}</DialogTitle>
          <DialogDescription>{t("base", { base: prepared.baseSha })}</DialogDescription>
        </DialogHeader>
        <p className="text-sm">{prepared.dirty ? t("dirty") : t("committedOnly")}</p>
        <NativeSelect
          aria-label={t("targetMode")}
          disabled={busy}
          value={targetIsNew ? "new" : "existing"}
          onChange={(event) => {
            const isNew = event.target.value === "new"
            setTargetIsNew(isNew)
            setTargetRef(isNew ? prepared.targetRef : "")
          }}
        >
          <NativeSelectOption value="new">{t("newBranch")}</NativeSelectOption>
          <NativeSelectOption value="existing">{t("existingBranch")}</NativeSelectOption>
        </NativeSelect>
        {targetIsNew ? (
          <Input
            aria-label={t("target")}
            value={targetRef}
            disabled={busy}
            onChange={(event) => setTargetRef(event.target.value)}
          />
        ) : (
          <NativeSelect
            aria-label={t("target")}
            value={targetRef}
            disabled={busy}
            onChange={(event) => setTargetRef(event.target.value)}
          >
            <NativeSelectOption value="" disabled>
              {t("chooseBranch")}
            </NativeSelectOption>
            {prepared.branches.map((branch) => (
              <NativeSelectOption key={branch} value={branch}>
                {branch}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t("agents")}</legend>
          {agents.map((choice, index) => (
            <NativeSelect
              key={index}
              aria-label={t("candidateAgent", { index: index + 1 })}
              value={choice}
              disabled={busy}
              onChange={(event) =>
                setAgents((current) =>
                  current.map((item, at) => (at === index ? event.target.value : item))
                )
              }
            >
              {prepared.agentOptions.map((option) => (
                <NativeSelectOption key={option.value} value={option.value}>
                  {option.kind === "session"
                    ? t("sessionAgent")
                    : t("externalAgent", { name: option.label })}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          ))}
          {agents.some((choice) => choice !== "session") && (
            <p className="text-xs text-muted-foreground">{t("externalCost")}</p>
          )}
        </fieldset>
        <p className="text-xs text-muted-foreground">{t("manualOnly")}</p>
        <RunEstimateHint
          queries={bestOfNEstimateQueries(prepared.session, agents)}
          data-testid="best-of-n-estimate"
        />
        {error && <p role="alert">{t("failed", { error })}</p>}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onCancel}>
            {t("cancel")}
          </Button>
          <Button
            disabled={busy || !targetRef.trim()}
            onClick={async () => {
              setBusy(true)
              setError(null)
              try {
                await onConfirm({ targetRef: targetRef.trim(), targetIsNew }, agents)
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : String(cause))
                setBusy(false)
              }
            }}
          >
            {busy ? t("starting") : t("start")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
