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

import { useState } from "react"
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
  /** Answer the question. Always called exactly once per request. */
  onRespond: (response: AcpElicitationResponse) => void
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
  onRespond: (response: AcpElicitationResponse) => void
}) {
  const t = useTranslations("externalAgent.elicitation")
  const properties = request.requestedSchema?.properties ?? {}
  const required = request.requestedSchema?.required ?? []
  const [values, setValues] = useState<ElicitationValues>(() =>
    initialElicitationValues(properties)
  )

  const respond = (action: AcpElicitationResponse["action"]) =>
    onRespond({
      requestId: request.id,
      action,
      content: action === "accept" ? values : undefined,
    })

  const complete = isElicitationComplete(properties, required, values)
  const title = request.requestedSchema?.title || t("title")

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // Dismissal is a cancel, not a decline.
        if (!open) respond("cancel")
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

        <ElicitationForm request={request} values={values} onValuesChange={setValues} />

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" onClick={() => respond("decline")}>
            {t("decline")}
          </Button>
          <Button disabled={!complete} onClick={() => respond("accept")}>
            {t("submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
