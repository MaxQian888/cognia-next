"use client"

/**
 * Inline card for non-blocking agent questions (Codex `delivery: "async"`
 * agent messages → `data-async-questions` parts, `event-to-parts.ts`).
 *
 * Unlike an elicitation nothing is waiting on the answer — the turn keeps
 * running. Picking an option or typing a reply sends an ordinary user message
 * (quoted question + answer) through the chat-send bridge, which inherits the
 * normal steer/queue semantics. Answers are persisted onto the part's
 * `data.answers` so a transcript reload doesn't re-offer a settled question.
 */

import { useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { MessageCircleQuestion, SendHorizontal } from "lucide-react"
import { toast } from "sonner"
import type { UIMessage } from "ai"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { MarkdownRenderer } from "@/components/chat/markdown-renderer"
import { sendChatMessage } from "@/hooks/chat/chat-send-bridge"
import { resolveExternalQuestion } from "@/lib/ai/agent/external/session/chat-decision-bridge"
import { useChatStore } from "@/stores/chat"
import { persistMessages } from "@/lib/db/messages"
import { loggers } from "@cognia/logging"

const log = loggers.chat

export interface AsyncQuestionEntry {
  /** Wire question id — keys the answers map on RPC-backed cards. */
  id?: string
  title: string
  options?: string[]
  /** Sensitive answer: masked input, never persisted in clear text. */
  secret?: boolean
}

export interface AsyncQuestionsPartData {
  /** Codex item id — also used to re-locate this part when persisting answers. */
  itemId?: string
  /** Chat session the question belongs to (stamped by the parts mapper). */
  sessionId?: string
  /**
   * Chat-side registry key (`external-agent:<agentId>:<itemId>`) when the
   * questions back a pending `requestUserInput` RPC. Its presence switches
   * the answer path from "send a user message" to `resolveExternalQuestion`.
   */
  requestId?: string
  /** Raw wire requestId — how a `permission_response` finds this part. */
  responseRequestId?: string
  /** The pending request settled (answered / resolved elsewhere / torn down). */
  closed?: boolean
  /** Question prose that never streamed as deltas. */
  text?: string
  questions: AsyncQuestionEntry[]
  /** questionIndex → answer text, for questions already answered. */
  answers?: Record<number, string>
}

/** Mask persisted (and displayed) in place of a secret answer's raw text. */
const SECRET_ANSWER_MASK = "••••••••"

/** `> question` quote + answer — the association Codex's async answers rely on. */
export function formatAsyncQuestionAnswer(title: string, answer: string): string {
  return `> ${title}\n\n${answer}`
}

export function AsyncQuestionsCard({
  part,
  sessionId,
  messageId,
}: {
  part: UIMessage["parts"][number]
  sessionId?: string
  messageId?: string
}) {
  const t = useTranslations("chat.asyncQuestions")
  const data = (part as { data?: AsyncQuestionsPartData }).data
  const questions = data?.questions ?? []
  const targetSessionId = data?.sessionId ?? sessionId
  // The prop `part` is replaced by the patched object once an answer lands;
  // keep the original reference for identity matching on the live store slice.
  const originalPart = useRef(part)
  const [drafts, setDrafts] = useState<Record<number, string>>({})
  const [sending, setSending] = useState<Record<number, boolean>>({})
  // Immediate-answer state layered over the persisted `data.answers` — the
  // store patch only works when this message lives in the chat store slice
  // (a read-only transcript surface has none), and a sent answer must still
  // show as settled either way.
  const [localAnswers, setLocalAnswers] = useState<Record<number, string>>({})
  // One RPC resolve covers the whole request: after an answer lands (or the
  // waiter settled elsewhere) every question on the card is read-only.
  const [requestSettled, setRequestSettled] = useState(false)
  const answers = { ...data?.answers, ...localAnswers }
  const settled = requestSettled || data?.closed === true

  if (!data || questions.length === 0) return null

  const persistAnswer = (index: number, answer: string) => {
    if (!targetSessionId || !messageId) return
    const messages = useChatStore.getState().sessions[targetSessionId]?.messages
    if (!messages) return
    const next = messages.map((m) =>
      m.id === messageId
        ? ({
            ...m,
            parts: m.parts.map((p) => {
              const pd = (p as { data?: AsyncQuestionsPartData }).data
              const isThisPart =
                p === originalPart.current ||
                (data.itemId !== undefined && pd?.itemId === data.itemId)
              return isThisPart && (p as { type?: string }).type === "data-async-questions"
                ? ({
                    ...p,
                    data: {
                      ...pd,
                      answers: { ...(pd?.answers ?? {}), [index]: answer },
                    },
                  } as UIMessage["parts"][number])
                : p
            }),
          } as UIMessage)
        : m
    )
    useChatStore.getState().replaceSessionMessages(targetSessionId, next)
    void persistMessages(targetSessionId, next).catch((error) =>
      log.error("async question answer persist failed", error)
    )
  }

  const answer = async (index: number, raw: string) => {
    const value = raw.trim()
    const question = questions[index]
    if (!value || !question || sending[index] || settled) return
    setSending((s) => ({ ...s, [index]: true }))
    try {
      if (data.requestId) {
        // RPC-backed (`requestUserInput` isBlocking:false): the wire reply is
        // a single {answers} map for the whole request, so fold in every draft
        // the user already typed — after this resolves nothing else can go.
        const payload: Record<string, string[]> = {}
        questions.forEach((q, i) => {
          const answerText = i === index ? value : (localAnswers[i] ?? drafts[i]?.trim())
          if (answerText) payload[q.id ?? String(i)] = [answerText]
        })
        const sent = await resolveExternalQuestion(data.requestId, payload).catch((error) => {
          log.error("async question resolve failed", error)
          toast.error(t("sendFailed"))
          return undefined
        })
        if (sent === undefined) return
        // false = the waiter was already gone (resolved elsewhere or the
        // session ended) — the card is closed either way.
        setRequestSettled(true)
        if (sent) {
          const recorded: Record<number, string> = {}
          questions.forEach((q, i) => {
            const answerText = payload[q.id ?? String(i)]?.[0]
            if (answerText) recorded[i] = q.secret ? SECRET_ANSWER_MASK : answerText
          })
          setLocalAnswers((a) => ({ ...a, ...recorded }))
          for (const [i, text] of Object.entries(recorded)) {
            persistAnswer(Number(i), text)
          }
          setDrafts({})
        }
        return
      }
      if (!targetSessionId) return
      const ok = sendChatMessage(targetSessionId, formatAsyncQuestionAnswer(question.title, value))
      if (!ok) {
        toast.error(t("sendFailed"))
        return
      }
      setLocalAnswers((a) => ({ ...a, [index]: value }))
      persistAnswer(index, value)
      setDrafts((d) => ({ ...d, [index]: "" }))
    } finally {
      setSending((s) => ({ ...s, [index]: false }))
    }
  }

  return (
    <div
      data-slot="async-questions-card"
      className="border-border/60 bg-muted/30 space-y-3 rounded-lg border p-3"
    >
      <div className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
        <MessageCircleQuestion className="size-3.5" aria-hidden />
        {t("eyebrow")}
      </div>
      {data.text ? (
        <MarkdownRenderer
          content={data.text}
          messageId={messageId}
          className="text-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
        />
      ) : null}
      {questions.map((question, index) => {
        const answered = answers[index]
        return (
          <div key={index} className="space-y-2">
            <p className="text-sm font-medium">{question.title}</p>
            {answered !== undefined ? (
              <p className="text-muted-foreground text-xs">{t("answered", { answer: answered })}</p>
            ) : settled ? (
              // The backing request is gone — nothing more can be sent.
              <p className="text-muted-foreground/70 text-xs italic">{t("unanswered")}</p>
            ) : (
              <>
                {question.options?.length ? (
                  <div className="flex flex-wrap gap-1.5">
                    {question.options.map((option) => (
                      <Button
                        key={option}
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        disabled={sending[index]}
                        onClick={() => void answer(index, option)}
                      >
                        {option}
                      </Button>
                    ))}
                  </div>
                ) : null}
                <div className="flex items-center gap-2">
                  <Input
                    type={question.secret ? "password" : "text"}
                    value={drafts[index] ?? ""}
                    placeholder={t("answerPlaceholder")}
                    className="h-8 text-xs"
                    disabled={sending[index]}
                    onChange={(event) => setDrafts((d) => ({ ...d, [index]: event.target.value }))}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                        event.preventDefault()
                        void answer(index, drafts[index] ?? "")
                      }
                    }}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 shrink-0"
                    aria-label={t("sendAnswer")}
                    disabled={sending[index] || !(drafts[index] ?? "").trim()}
                    onClick={() => void answer(index, drafts[index] ?? "")}
                  >
                    <SendHorizontal className="size-3.5" aria-hidden />
                  </Button>
                </div>
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}
