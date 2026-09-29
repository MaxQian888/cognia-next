"use client"

/**
 * Steer an issue's active run from its detail panel (plan 2026-09-29,
 * Phase 4).
 *
 * There is one steer path, `steerIssueRun` in `lib/issues/run/registry.ts`:
 * it finds the run's newest live session through its adapter and hands the
 * text to `steerSession`, which runs the PII gate. Wakeups that join an
 * active run ride the same call, so this box is a person doing by hand what
 * a wakeup does on its own.
 *
 * Only some engines take input mid-run. When the run's adapter reports no
 * live session the box is replaced by a line saying so, rather than offering
 * a send that could only be refused. A refusal after sending (the turn closed
 * its input, the gate held the text back) is reported and the draft is kept.
 */

import { SendHorizontalIcon } from "lucide-react"
import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { issueRunSessionIds, steerIssueRun } from "@/lib/issues/run/registry"
import type { IssueRun } from "@/types/issues"

export interface IssueRunSteerProps {
  run: IssueRun
}

export function IssueRunSteer({ run }: IssueRunSteerProps) {
  const t = useTranslations("issues")
  const [draft, setDraft] = useState("")
  const [busy, setBusy] = useState(false)
  // Which run the answer is for, so a stale answer never shows on a newer run.
  const [steerable, setSteerable] = useState<{ runId: string; ok: boolean } | null>(null)

  useEffect(() => {
    let cancelled = false
    void issueRunSessionIds(run)
      .then((sessions) => {
        if (!cancelled) setSteerable({ runId: run.id, ok: sessions.length > 0 })
      })
      .catch(() => {
        if (!cancelled) setSteerable({ runId: run.id, ok: false })
      })
    return () => {
      cancelled = true
    }
  }, [run])

  const known = steerable?.runId === run.id ? steerable.ok : null
  if (known === null) return null
  if (!known) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="issue-run-steer-unavailable">
        {t("run.steerUnavailable")}
      </p>
    )
  }

  async function send() {
    const text = draft.trim()
    if (!text) return
    setBusy(true)
    try {
      if (await steerIssueRun(run, text)) {
        setDraft("")
        toast.success(t("run.steerSent"))
      } else {
        toast.error(t("run.steerRefused"))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="flex flex-col gap-1.5"
      data-testid="issue-run-steer"
      onSubmit={(event) => {
        event.preventDefault()
        void send()
      }}
    >
      <Label htmlFor={`issue-run-steer-${run.id}`} className="text-xs">
        {t("run.steerLabel")}
      </Label>
      <Textarea
        id={`issue-run-steer-${run.id}`}
        rows={2}
        value={draft}
        placeholder={t("run.steerPlaceholder")}
        disabled={busy}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            void send()
          }
        }}
        data-testid="issue-run-steer-input"
      />
      <Button
        type="submit"
        size="sm"
        variant="outline"
        className="self-end"
        disabled={busy || !draft.trim()}
        data-testid="issue-run-steer-send"
      >
        <SendHorizontalIcon className="size-3.5" />
        {t("run.steerSend")}
      </Button>
    </form>
  )
}
