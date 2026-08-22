"use client"

/**
 * The Windows-only consent to run one external Agent outside Cognia's sandbox.
 *
 * macOS and Linux never reach this: their sandbox is mandatory and there is no
 * consent that relaxes it. Windows has neither Seatbelt nor bubblewrap, so the
 * choice is between refusing local Agents entirely and letting a user opt one
 * specific Agent out — per Agent, never globally, and only for a runtime the
 * catalog marks eligible.
 *
 * Three things this dialog is deliberately strict about:
 *
 *  - the disclosure is unavoidable. There is no "don't show again", and the
 *    confirm button stays disabled until the acknowledgement is ticked;
 *  - it shows exactly what would run — resolved executable path, version, and
 *    the full command line — because consent to "run Codex unsandboxed" is
 *    meaningless if the user cannot see which binary that is;
 *  - it says out loud that the consent breaks the moment any of those change.
 *    The lifecycle service enforces that; saying so here is what makes the
 *    enforcement predictable rather than surprising.
 *
 * @see lib/ai/agent/external/lifecycle/service.ts
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ShieldAlert } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"

/** Exactly what the user is being asked to approve. */
export interface UnsandboxedLaunchSubject {
  agentName: string
  runtimeId: string
  /** Absolute path of the executable that would run. */
  executablePath: string
  /** Detected version, or undefined when the probe could not read one. */
  runtimeVersion?: string
  /** Full command line, already canonicalized. */
  commandLine: string
}

export interface UnsandboxedConsentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  subject: UnsandboxedLaunchSubject
  /**
   * Called once the user confirms.
   *
   * A rejection keeps the dialog open rather than propagating: the caller
   * surfaces the message, and an unhandled rejection out of a click handler
   * would take the settings pane with it.
   */
  onConfirm: () => void | Promise<void>
}

export function UnsandboxedConsentDialog({
  open,
  onOpenChange,
  subject,
  onConfirm,
}: UnsandboxedConsentDialogProps) {
  const t = useTranslations("externalAgent.unsandboxed")
  const [acknowledged, setAcknowledged] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const handleOpenChange = (next: boolean) => {
    // Reset on close so reopening never inherits a previous acknowledgement —
    // consent is per decision, not per session.
    if (!next) {
      setAcknowledged(false)
      setSubmitting(false)
    }
    onOpenChange(next)
  }

  const handleConfirm = async () => {
    setSubmitting(true)
    try {
      await onConfirm()
      handleOpenChange(false)
    } catch {
      // Granting can legitimately fail — the policy revision moved, the
      // executable changed between opening this dialog and confirming. The
      // dialog stays open so the caller's message lands against the decision
      // it belongs to, and the acknowledgement stays ticked so the user is not
      // made to read the disclosure twice for one attempt.
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="size-4 text-destructive" aria-hidden="true" />
            {t("title")}
          </DialogTitle>
          <DialogDescription>{t("description", { agent: subject.agentName })}</DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-56 rounded-md border p-3">
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">{t("risk")}</p>

            <dl className="space-y-2">
              <div>
                <dt className="text-xs text-muted-foreground">{t("executableLabel")}</dt>
                <dd
                  className="break-all font-mono text-xs"
                  data-testid="unsandboxed-executable-path"
                >
                  {subject.executablePath}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("versionLabel")}</dt>
                <dd className="font-mono text-xs" data-testid="unsandboxed-version">
                  {subject.runtimeVersion ?? t("versionUnknown")}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("commandLabel")}</dt>
                <dd className="break-all font-mono text-xs" data-testid="unsandboxed-command">
                  {subject.commandLine}
                </dd>
              </div>
            </dl>

            <p className="text-muted-foreground">{t("invalidation")}</p>
          </div>
        </ScrollArea>

        <div className="flex items-start gap-2">
          <Checkbox
            id="unsandboxed-acknowledge"
            checked={acknowledged}
            onCheckedChange={(value) => setAcknowledged(value === true)}
          />
          <Label
            htmlFor="unsandboxed-acknowledge"
            className="text-sm leading-snug font-normal text-muted-foreground"
          >
            {t("acknowledge")}
          </Label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button
            variant="destructive"
            disabled={!acknowledged || submitting}
            onClick={() => {
              void handleConfirm()
            }}
          >
            {t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
