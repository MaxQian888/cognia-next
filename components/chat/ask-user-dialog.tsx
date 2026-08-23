"use client"

// Renders the active `ask_user` prompt as a modal. Mounted once at the app
// layout; it subscribes to `useAskUserStore` and resolves the pending tool
// call when the user submits or dismisses. One prompt at a time (the store
// queues concurrent calls).
//
// The fields themselves come from the shared `ElicitationForm`. `ask_user` is
// an elicitation in every way that matters — a question, some choices, maybe a
// free-text box, and a required answer — and keeping a second implementation of
// that form meant the two drifted: this one never learned about secrets or
// prefilled bodies, and the shared one never learned about multi-select. What
// stays here is the adapter between `AskUserRequest` and the schema shape, plus
// the modal.

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { MessageCircleQuestion } from "lucide-react"

import { useAskUserStore } from "@/stores/agent/ask-user-store"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import {
  ElicitationForm,
  initialElicitationValues,
  type ElicitationValues,
} from "@/components/chat/decisions/elicitation-form"
import type { AskUserRequest } from "@/lib/claude/ask-user-tool"
import type {
  AcpElicitationPropertySchema,
  AcpElicitationRequest,
} from "@/types/agent/external-agent"

/** Field key for the choices, and for the free-text box. Stable so the answer
 *  can be read back out of the form's value map. */
const CHOICE_FIELD = "choice"
const TEXT_FIELD = "text"

/**
 * Describe an `ask_user` prompt as an elicitation schema.
 *
 * `multiSelect` becomes an array field (rendered as checkboxes), a single
 * choice becomes an enum (radios), and `allowText` adds a multiline field.
 * Nothing is marked required: `ask_user` accepts either a choice or text, which
 * per-field `required` cannot express — the dialog enforces the rule below.
 */
function toElicitationRequest(
  id: string,
  request: AskUserRequest,
  textLabel: string
): AcpElicitationRequest {
  const properties: Record<string, AcpElicitationPropertySchema> = {}
  if (request.options.length > 0) {
    const oneOf = request.options.map((option) => ({ const: option.value, title: option.label }))
    properties[CHOICE_FIELD] = request.multiSelect
      ? { type: "array", items: { type: "string", oneOf } }
      : { type: "string", oneOf }
  }
  if (request.allowText) {
    // `title` is the visible label and `description` the placeholder, so the
    // free-text box stays reachable by name instead of only by placeholder.
    properties[TEXT_FIELD] = {
      type: "string",
      format: "multiline",
      title: textLabel,
      description: textLabel,
    }
  }
  return {
    id,
    mode: "form",
    message: request.question,
    requestedSchema: { type: "object", properties, required: [] },
    raw: {},
  }
}

function readAnswer(values: ElicitationValues): { selected: string[]; text: string } {
  const choice = values[CHOICE_FIELD]
  const selected = Array.isArray(choice)
    ? choice.filter((value): value is string => typeof value === "string")
    : typeof choice === "string" && choice
      ? [choice]
      : []
  const text = typeof values[TEXT_FIELD] === "string" ? (values[TEXT_FIELD] as string) : ""
  return { selected, text }
}

export function AskUserDialog() {
  const t = useTranslations("chat.askUser")
  const active = useAskUserStore((s) => s.active)
  const queuedCount = useAskUserStore((s) => s.queue.length)
  const resolveActive = useAskUserStore((s) => s.resolveActive)

  const activeId = active?.id
  const request = active?.request
  const textLabel = t("textPlaceholder")
  const elicitation = useMemo(
    () => (request && activeId ? toElicitationRequest(activeId, request, textLabel) : null),
    [activeId, request, textLabel]
  )
  const [values, setValues] = useState<ElicitationValues>({})

  // Reset the form whenever a new prompt becomes active — the render-time
  // derived-state-reset pattern (setState-in-effect is disallowed here).
  const [prevActiveId, setPrevActiveId] = useState(activeId)
  if (activeId !== prevActiveId) {
    setPrevActiveId(activeId)
    setValues(
      elicitation ? initialElicitationValues(elicitation.requestedSchema?.properties ?? {}) : {}
    )
  }

  if (!request || !elicitation) return null

  const { selected, text } = readAnswer(values)
  // `ask_user` is answered by EITHER a choice or text, so completeness is a
  // rule about the prompt as a whole rather than about any one field.
  const canSubmit = selected.length > 0 || (request.allowText && text.trim().length > 0)

  const submit = () => {
    if (!canSubmit) return
    resolveActive({ selected, text, cancelled: false })
  }

  const dismiss = () => resolveActive({ selected: [], text: "", cancelled: true })

  return (
    <Dialog open onOpenChange={(open) => !open && dismiss()}>
      <DialogContent
        className="max-w-md"
        data-testid="ask-user-dialog"
        // ⌘/Ctrl+Enter submits from anywhere in the dialog (incl. the textarea).
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault()
            submit()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageCircleQuestion className="size-5 shrink-0 text-primary" aria-hidden />
            {t("title")}
          </DialogTitle>
          <DialogDescription className="mt-1 whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-sm leading-relaxed text-foreground">
            {request.question}
          </DialogDescription>
        </DialogHeader>

        {request.multiSelect && <p className="text-xs text-muted-foreground">{t("multiHint")}</p>}
        <ElicitationForm request={elicitation} values={values} onValuesChange={setValues} />

        <DialogFooter className="sm:items-center sm:justify-between">
          <span className="text-xs text-muted-foreground">
            {queuedCount > 0 ? t("queued", { count: queuedCount }) : t("submitHint")}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={dismiss}>
              {t("dismiss")}
            </Button>
            <Button onClick={submit} disabled={!canSubmit}>
              {t("submit")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
