"use client"

/**
 * Blocking-question dialog for external agents.
 *
 * The sibling of `tool-approval-dialog.tsx`, and deliberately not the same
 * component. An approval grants a capability and answers allow / deny / always;
 * an elicitation collects a VALUE — a choice, some text, a yes/no — and has no
 * "always" to offer. Folding the two together would either give approvals a
 * form or give questions an authority they do not have.
 *
 * Both Pi and ACP feed this. Pi's `confirm` / `select` / `input` / `editor`
 * arrive as a one-property schema named for the method
 * (`piDialogSchema`); ACP's `elicitation/create` can send a richer object. The
 * renderer works off the schema rather than off either protocol, so neither is
 * special-cased here.
 *
 * Closing without answering is a `cancel`, never a `decline`: the agent reads
 * decline as a deliberate "no" and cancel as "the user walked away", and a
 * dismissed dialog is the second thing.
 */

import { useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { MessageCircleQuestion } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  ElicitationForm,
  initialElicitationValues,
  isElicitationComplete,
  type ElicitationValues,
} from "@/components/chat/decisions/elicitation-form"
import type { AcpElicitationRequest, AcpElicitationResponse } from "@/types/agent/external-agent"

export interface ExternalAgentElicitationDialogProps {
  /** The open question, or `null` when nothing is pending. */
  request: AcpElicitationRequest | null
  /** Deliver an answer. Reject to keep the question and allow an explicit retry. */
  onRespond: (response: AcpElicitationResponse) => void | Promise<void>
}

export function ExternalAgentElicitationDialog({
  request,
  onRespond,
}: ExternalAgentElicitationDialogProps) {
  if (!request) return null

  return <ExternalAgentElicitationForm key={request.id} request={request} onRespond={onRespond} />
}

function ExternalAgentElicitationForm({
  request,
  onRespond,
}: {
  request: AcpElicitationRequest
  onRespond: (response: AcpElicitationResponse) => void | Promise<void>
}) {
  const t = useTranslations("externalAgent.elicitation")
  const properties = request.requestedSchema?.properties ?? {}
  const required = request.requestedSchema?.required ?? []
  const [values, setValues] = useState<ElicitationValues>(() =>
    initialElicitationValues(properties)
  )

  const [submitting, setSubmitting] = useState(false)
  const [failed, setFailed] = useState(false)
  const responseInFlight = useRef(false)

  const respond = async (action: AcpElicitationResponse["action"]) => {
    // The ref closes the same-render double-click/Escape window. A successful
    // response remains locked until the owner removes this request.
    if (responseInFlight.current) return
    responseInFlight.current = true
    setSubmitting(true)
    setFailed(false)
    try {
      await onRespond({
        requestId: request.id,
        action,
        content: action === "accept" ? values : undefined,
      })
    } catch {
      responseInFlight.current = false
      setSubmitting(false)
      setFailed(true)
    }
  }

  const complete = isElicitationComplete(properties, required, values)
  const title = request.requestedSchema?.title || t("title")

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // Dismissal is a cancel, not a decline.
        if (!open) void respond("cancel")
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageCircleQuestion className="size-4 text-muted-foreground" aria-hidden />
            {title}
          </DialogTitle>
          <DialogDescription>{request.message}</DialogDescription>
        </DialogHeader>

        <fieldset disabled={submitting} className="min-w-0 border-0 p-0">
          <ElicitationForm request={request} values={values} onValuesChange={setValues} />
        </fieldset>
        {failed && (
          <p role="alert" className="text-sm text-destructive">
            {t("responseFailed")}
          </p>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button disabled={submitting} variant="ghost" onClick={() => void respond("decline")}>
            {t("decline")}
          </Button>
          <Button disabled={submitting || !complete} onClick={() => void respond("accept")}>
            {t("submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
