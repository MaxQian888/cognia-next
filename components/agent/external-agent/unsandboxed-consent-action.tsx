"use client"

/**
 * The path from "this Agent needs your permission" to a recorded approval.
 *
 * The dialog and the badge were both built and tested with nothing rendering
 * them, so on Windows an Agent could be reported as needing consent with no way
 * to give it. This is the glue: the button, the runtime re-check that
 * establishes what would actually run, the dialog, and the grant.
 *
 * The re-check is not cosmetic. An approval is compared against the runtime
 * binding on every later launch, and the binding only carries an executable
 * digest and a version once a probe has written them — approving beforehand
 * records an approval with nothing to invalidate it, and the first later probe
 * would then ask again.
 *
 * The identity itself is never assembled here. The service derives it from the
 * saved config, so what the user approves and what the check later re-reads
 * cannot drift apart.
 *
 * @see ./unsandboxed-consent-dialog.tsx
 * @see lib/ai/agent/external/lifecycle/service.ts `launchIdentity`
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ShieldQuestion } from "lucide-react"

import { Button } from "@/components/ui/button"
import { toast } from "@/components/ui/sonner"
import { lifecycleErrorMessage } from "@/lib/ai/agent/external/lifecycle/error-messages"
import {
  canonicalLaunchCommandString,
  findRuntimeById,
} from "@/lib/ai/agent/external/runtime-catalog"
import type { LifecycleExternalAgentConfig } from "@/stores/agent/external-agent-store"

import {
  UnsandboxedConsentDialog,
  type UnsandboxedLaunchSubject,
} from "./unsandboxed-consent-dialog"

export interface UnsandboxedConsentActionProps {
  agent: LifecycleExternalAgentConfig
  /** Re-checks the runtime so the binding carries a current identity. */
  refreshRuntime?: (runtimeId: string) => Promise<unknown>
  /** Records the approval. Derives the identity itself. */
  grantConsent?: (agentId: string) => Promise<unknown>
}

async function lifecycleService() {
  const { getExternalAgentLifecycleService } =
    await import("@/lib/ai/agent/external/lifecycle/service")
  return getExternalAgentLifecycleService()
}

export function UnsandboxedConsentAction({
  agent,
  refreshRuntime = async (runtimeId) => (await lifecycleService()).inspectRuntime(runtimeId),
  grantConsent = async (agentId) =>
    (await lifecycleService()).grantUnsandboxedWindowsConsent(agentId),
}: UnsandboxedConsentActionProps) {
  const t = useTranslations("externalAgent.unsandboxed")
  const tErrors = useTranslations("externalAgent.lifecycleErrors")
  const [open, setOpen] = useState(false)
  const [preparing, setPreparing] = useState(false)

  const runtimeId = agent.runtimeBinding?.runtimeId
  // Consent is per runtime. An Agent bound to none has nothing to describe, and
  // the readiness check never asks for consent in that case either.
  if (!runtimeId) return null

  const entry = findRuntimeById(runtimeId)
  const binding = agent.runtimeBinding
  const command = agent.process?.command ?? entry?.systemCommand ?? ""
  const args = agent.process?.args ?? entry?.launchArgs ?? []

  const subject: UnsandboxedLaunchSubject = {
    agentName: agent.name,
    runtimeId,
    executablePath: binding?.resolvedExecutablePath ?? command,
    runtimeVersion: binding?.pinnedVersion,
    commandLine: canonicalLaunchCommandString({ command, args }),
  }

  const openDialog = async () => {
    setPreparing(true)
    try {
      // Best effort: a host that cannot probe still lets the user approve what
      // the configuration says would run, which is what the check compares
      // against anyway.
      await refreshRuntime(runtimeId).catch(() => undefined)
      setOpen(true)
    } finally {
      setPreparing(false)
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => void openDialog()}
        disabled={preparing}
        data-testid="unsandboxed-consent-open"
      >
        <ShieldQuestion className="mr-1 size-4" aria-hidden="true" />
        {t("reviewAction")}
      </Button>

      <UnsandboxedConsentDialog
        open={open}
        onOpenChange={setOpen}
        subject={subject}
        onConfirm={async () => {
          try {
            await grantConsent(agent.id)
            setOpen(false)
          } catch (error) {
            // The dialog keeps itself open and re-enables its confirm on a
            // rejection; surfacing the reason is this caller's job.
            toast.error(lifecycleErrorMessage(error, (key) => tErrors(key)))
            throw error
          }
        }}
      />
    </>
  )
}
