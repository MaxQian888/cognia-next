"use client"

/**
 * Issue an enrollment token and walk the operator through connecting a deploy
 * agent to it.
 *
 * This is the step the Servers workspace was missing entirely. The controller
 * and the agent have spoken mTLS + signed operations to each other since
 * ADR-0059, but nothing in the app ever called
 * `POST /v1/agents/enrollment-tokens`, so a target could be registered and
 * deployed to and still have no agent — leaving every operation queued forever
 * against a host that was never listening.
 *
 * The dialog stays open and watches the target come online rather than
 * declaring success on "token issued": issuing a token proves nothing about the
 * host, and the operator's real question is whether the agent connected.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { CheckIcon, CopyIcon, LoaderCircleIcon, PlugZapIcon } from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  buildAgentEnrollmentSteps,
  defaultAgentId,
  type AgentEnrollmentStep,
} from "@/lib/server-ops/agent-enrollment"
import type { ServerDetail } from "@/lib/server-ops/client"
import { useAbsoluteTime } from "./server-visuals"

/** How often the dialog re-reads the fleet while waiting for the agent. */
const ONLINE_POLL_MS = 5000

function CopyableCommand({ step, index }: { step: AgentEnrollmentStep; index: number }) {
  const t = useTranslations("servers")
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  return (
    <li className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-xs font-medium tabular-nums">
          {index + 1}
        </span>
        <span className="text-sm font-medium">
          {t(`enroll.steps.${step.id}` as "enroll.steps.enroll")}
        </span>
      </div>
      <div className="relative">
        <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 pr-10 font-mono text-xs leading-relaxed">
          {step.command}
        </pre>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute top-1.5 right-1.5 size-7"
          aria-label={t("enroll.copyCommand")}
          onClick={() => {
            void navigator.clipboard
              .writeText(step.command)
              .then(() => setCopied(true))
              .catch(() => toast.error(t("operations.copyFailed")))
          }}
        >
          {copied ? (
            <CheckIcon
              className="size-3.5 text-emerald-600 dark:text-emerald-400"
              aria-hidden="true"
            />
          ) : (
            <CopyIcon className="size-3.5" aria-hidden="true" />
          )}
        </Button>
      </div>
    </li>
  )
}

/**
 * The dialog body, mounted only while the dialog is open.
 *
 * Keeping it unmounted while closed is what removes every reset effect: a
 * previous session's token is single-use and by now spent or expired, so a
 * fresh mount is exactly the right state — and "reset on close" written as an
 * effect is both more code and a lint error in this repo.
 */
function ConnectAgentBody({
  servers,
  controllerUrl,
  initialTargetId,
  onIssueToken,
  onRefresh,
  onClose,
}: {
  servers: readonly ServerDetail[]
  controllerUrl: string
  initialTargetId?: string
  onIssueToken: (targetId: string) => Promise<{ token: string; expiresAt: string } | null>
  onRefresh: () => Promise<void>
  onClose: () => void
}) {
  const t = useTranslations("servers")
  const absolute = useAbsoluteTime()
  const [targetId, setTargetId] = useState(initialTargetId ?? servers[0]?.id ?? "")
  const [agentId, setAgentId] = useState("")
  const [issuing, setIssuing] = useState(false)
  const [grant, setGrant] = useState<{ token: string; expiresAt: string } | null>(null)
  /** `lastSeenAt` at the moment the token was issued — the "before" reading. */
  const [baseline, setBaseline] = useState<string | null>(null)

  const target = servers.find((server) => server.id === targetId) ?? null

  // Derived, not stored: the controller stamps `lastSeenAt` when an agent
  // authenticates, so a value that moved past the baseline is the one signal
  // that the host actually dialled in.
  const connected = Boolean(grant && target?.lastSeenAt && target.lastSeenAt !== baseline)

  const issue = useCallback(async () => {
    if (!targetId) return
    setIssuing(true)
    try {
      const issued = await onIssueToken(targetId)
      if (!issued) return
      setBaseline(target?.lastSeenAt ?? null)
      setGrant(issued)
    } finally {
      setIssuing(false)
    }
  }, [onIssueToken, target?.lastSeenAt, targetId])

  // Watch for the agent's first heartbeat. Refreshing the fleet is what moves
  // `lastSeenAt`; nothing here sets state directly.
  useEffect(() => {
    if (!grant || connected) return
    const timer = setInterval(() => void onRefresh(), ONLINE_POLL_MS)
    return () => clearInterval(timer)
  }, [connected, grant, onRefresh])

  const steps = grant
    ? buildAgentEnrollmentSteps({
        controllerUrl,
        targetId,
        token: grant.token,
        agentId: agentId.trim() || undefined,
      })
    : []

  return (
    <>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-5 p-6">
          {servers.length === 0 ? (
            <Alert>
              <AlertTitle>{t("enroll.noTargetsTitle")}</AlertTitle>
              <AlertDescription>{t("enroll.noTargets")}</AlertDescription>
            </Alert>
          ) : (
            <>
              <Field>
                <FieldLabel htmlFor="enroll-target">{t("enroll.target")}</FieldLabel>
                <Select value={targetId} onValueChange={setTargetId} disabled={Boolean(grant)}>
                  <SelectTrigger id="enroll-target" className="w-full">
                    <SelectValue placeholder={t("enroll.target")} />
                  </SelectTrigger>
                  <SelectContent>
                    {servers.map((server) => (
                      <SelectItem key={server.id} value={server.id}>
                        {server.label || server.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field>
                <FieldLabel htmlFor="enroll-agent-id">{t("enroll.agentId")}</FieldLabel>
                <Input
                  id="enroll-agent-id"
                  value={agentId}
                  autoComplete="off"
                  disabled={Boolean(grant)}
                  placeholder={targetId ? defaultAgentId(targetId) : ""}
                  onChange={(event) => setAgentId(event.target.value)}
                />
                <FieldDescription>{t("enroll.agentIdHelp")}</FieldDescription>
              </Field>

              {grant && (
                <>
                  <Alert>
                    <AlertTitle>{t("enroll.tokenIssued")}</AlertTitle>
                    <AlertDescription>
                      {t("enroll.tokenExpires", { time: absolute(grant.expiresAt) })}
                    </AlertDescription>
                  </Alert>

                  <ol className="space-y-4">
                    {steps.map((step, index) => (
                      <CopyableCommand key={step.id} step={step} index={index} />
                    ))}
                  </ol>

                  <div
                    className="flex items-center gap-2 rounded-md border p-3 text-sm"
                    aria-live="polite"
                  >
                    {connected ? (
                      <>
                        <CheckIcon
                          className="size-4 text-emerald-600 dark:text-emerald-400"
                          aria-hidden="true"
                        />
                        <span>{t("enroll.connected", { label: target?.label ?? targetId })}</span>
                      </>
                    ) : (
                      <>
                        <LoaderCircleIcon
                          className="size-4 animate-spin text-muted-foreground"
                          aria-hidden="true"
                        />
                        <span className="text-muted-foreground">{t("enroll.waiting")}</span>
                      </>
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </ScrollArea>

      <DialogFooter className="border-t p-6 pt-4">
        <Button type="button" variant="outline" onClick={onClose}>
          {connected ? t("enroll.done") : t("wizard.cancel")}
        </Button>
        {servers.length > 0 && (
          <Button type="button" disabled={!targetId || issuing || Boolean(grant)} onClick={issue}>
            {issuing && <LoaderCircleIcon className="size-4 animate-spin" aria-hidden="true" />}
            {t("enroll.issue")}
          </Button>
        )}
      </DialogFooter>
    </>
  )
}

export function ConnectAgentDialog({
  open,
  onOpenChange,
  servers,
  controllerUrl,
  initialTargetId,
  onIssueToken,
  onRefresh,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  servers: readonly ServerDetail[]
  controllerUrl: string
  /** Preselected when opened from a server's own Security tab. */
  initialTargetId?: string
  onIssueToken: (targetId: string) => Promise<{ token: string; expiresAt: string } | null>
  onRefresh: () => Promise<void>
}) {
  const t = useTranslations("servers")
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="border-b p-6 pb-4">
          <DialogTitle className="flex items-center gap-2">
            <PlugZapIcon className="size-4" aria-hidden="true" />
            {t("enroll.title")}
          </DialogTitle>
          <DialogDescription>{t("enroll.description")}</DialogDescription>
        </DialogHeader>
        {open && (
          <ConnectAgentBody
            servers={servers}
            controllerUrl={controllerUrl}
            initialTargetId={initialTargetId}
            onIssueToken={onIssueToken}
            onRefresh={onRefresh}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
