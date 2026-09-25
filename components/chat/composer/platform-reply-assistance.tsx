"use client"

/**
 * IM reply copilot (ADR-0194) for platform-bound sessions: reads the latest
 * messages, judges intent / risk through the selected decision provider,
 * drafts three replies on the utility model and ranks them. "Use" fills the
 * composer; it never submits. Lives inside the shared input provider.
 */

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import type { ChatSession } from "@cognia/agent-config-types"
import { SparklesIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { usePromptInputController } from "@/components/ai-elements/prompt-input"
import { CopilotResultCard } from "@/components/reply-copilot/copilot-result-card"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { buildHeadlessTurnLlmClient } from "@/lib/ai/headless-turn-llm-client"
import type { CopilotKnowledge } from "@/lib/reply-copilot/knowledge"
import { loadCopilotContext } from "@/lib/reply-copilot/load-context"
import { runCopilot, type CopilotResult } from "@/lib/reply-copilot/run-copilot"
import { useSettingsStore } from "@/stores/settings"

type Phase =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; result: CopilotResult; knowledge: CopilotKnowledge }
  | { kind: "failed" }

export function PlatformReplyAssistance({
  session,
  disabled,
}: {
  session: ChatSession
  disabled?: boolean
}) {
  const t = useTranslations("replyCopilot")
  const input = usePromptInputController()
  const [open, setOpen] = useState(false)
  const [instructions, setInstructions] = useState("")
  const [phase, setPhase] = useState<Phase>({ kind: "idle" })
  const pending = useRef<AbortController | null>(null)
  useEffect(() => () => pending.current?.abort(), [])

  function close() {
    pending.current?.abort()
    pending.current = null
    setPhase({ kind: "idle" })
    setOpen(false)
  }

  async function run() {
    if (pending.current) return
    const controller = new AbortController()
    pending.current = controller
    setPhase({ kind: "running" })
    try {
      const settings = useSettingsStore.getState().settings
      const client =
        buildUtilityLlmClient({
          session,
          appSettings: settings,
          override: settings?.composerAssistance?.model,
          featureId: "im-reply-copilot",
        }) ?? buildHeadlessTurnLlmClient({ session, label: t("dialog.title") })
      const context = await loadCopilotContext(session, settings)
      if (controller.signal.aborted) return
      const result = await runCopilot({
        transcript: context.transcript,
        knowledge: context.knowledge,
        instructions,
        client,
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      setPhase({ kind: "done", result, knowledge: context.knowledge })
    } catch {
      if (!controller.signal.aborted) setPhase({ kind: "failed" })
    } finally {
      if (pending.current === controller) pending.current = null
    }
  }

  const running = phase.kind === "running"

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={disabled}
        onClick={() => {
          setInstructions(input.textInput.value)
          setPhase({ kind: "idle" })
          setOpen(true)
        }}
      >
        <SparklesIcon className="size-3.5" />
        {t("dialog.trigger")}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) close()
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("dialog.title")}</DialogTitle>
            <DialogDescription>{t("dialog.description")}</DialogDescription>
          </DialogHeader>
          <Textarea
            aria-label={t("dialog.instructions")}
            placeholder={t("dialog.instructions")}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            disabled={running}
          />
          <Button type="button" onClick={() => void run()} disabled={running}>
            {running ? <Spinner className="size-3.5" /> : null}
            {running
              ? t("dialog.running")
              : phase.kind === "done"
                ? t("dialog.rerun")
                : t("dialog.run")}
          </Button>
          {phase.kind === "done" ? (
            <CopilotResultCard
              result={phase.result}
              knowledge={phase.knowledge}
              onFill={(text) => {
                input.textInput.setInput(text)
                close()
              }}
            />
          ) : phase.kind === "failed" ? (
            <p className="text-sm text-destructive">{t("dialog.failed")}</p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              {t("dialog.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
