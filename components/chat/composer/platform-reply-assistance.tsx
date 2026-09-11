"use client"

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import type { ChatSession, StoredMessage } from "@cognia/agent-config-types"
import { SparklesIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
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
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { buildHeadlessTurnLlmClient } from "@/lib/ai/headless-turn-llm-client"
import { listRecentMessages } from "@/lib/db/messages"
import { generateReplyDraft } from "@/lib/inbox/ai-reply-draft"
import { useSettingsStore } from "@/stores/settings"

/** Lives inside the shared input provider; applying a draft never submits it. */
export function PlatformReplyAssistance({
  session,
  disabled,
}: {
  session: ChatSession
  disabled?: boolean
}) {
  const t = useTranslations("chatPlatformComposer")
  const input = usePromptInputController()
  const [open, setOpen] = useState(false)
  const [instructions, setInstructions] = useState("")
  const [draft, setDraft] = useState("")
  const [busy, setBusy] = useState(false)
  const pending = useRef<AbortController | null>(null)
  useEffect(() => () => pending.current?.abort(), [])

  function close() {
    pending.current?.abort()
    pending.current = null
    setBusy(false)
    setOpen(false)
  }

  async function generate() {
    if (pending.current) return
    const controller = new AbortController()
    pending.current = controller
    setBusy(true)
    try {
      const settings = useSettingsStore.getState().settings
      const client =
        buildUtilityLlmClient({
          session,
          appSettings: settings,
          override: settings?.composerAssistance?.model,
          featureId: "im-reply-draft",
        }) ?? buildHeadlessTurnLlmClient({ session, label: t("aiDraft") })
      if (!client) {
        toast.error(t("noModel"))
        return
      }
      const rows = await listRecentMessages(session.id, 30)
      if (controller.signal.aborted) return
      const history = rows
        .filter((row) => row.role !== "system")
        .map((row) => {
          const metadata = row.metadata as StoredMessage["metadata"]
          return {
            role: metadata?.platformMessage?.sender.displayName ?? row.role,
            text: row.parts
              .flatMap((part) =>
                part.type === "text" && typeof part.text === "string" ? [part.text] : []
              )
              .join("\n"),
          }
        })
      const result = await generateReplyDraft({
        history,
        instructions,
        client,
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      if (result.kind === "draft") setDraft(result.text)
      else
        toast.info(
          t(
            result.reason === "pii"
              ? "pii"
              : result.reason === "empty"
                ? "emptyContext"
                : "noOutput"
          )
        )
    } catch {
      if (!controller.signal.aborted) toast.error(t("failed"))
    } finally {
      if (pending.current === controller) {
        pending.current = null
        setBusy(false)
      }
    }
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={disabled}
        onClick={() => {
          setInstructions(input.textInput.value)
          setDraft("")
          setOpen(true)
        }}
      >
        <SparklesIcon className="size-3.5" />
        {t("aiDraft")}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) close()
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("aiDraft")}</DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>
          </DialogHeader>
          <Textarea
            aria-label={t("instructions")}
            placeholder={t("instructions")}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            disabled={busy}
          />
          <Button type="button" onClick={() => void generate()} disabled={busy}>
            {t(busy ? "generating" : "generate")}
          </Button>
          {draft && (
            <Textarea
              aria-label={t("preview")}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              disabled={busy}
            />
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              {t("cancel")}
            </Button>
            <Button
              type="button"
              disabled={!draft.trim() || busy}
              onClick={() => {
                input.textInput.setInput(draft)
                close()
              }}
            >
              {t("apply")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
