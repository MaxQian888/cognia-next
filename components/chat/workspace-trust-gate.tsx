"use client"

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { useWorkspaceTrust } from "@/hooks/workspace/use-workspace-trust"
import { WorkspaceRestrictedBanner } from "./workspace-restricted-banner"
import { WorkspaceTrustDialog } from "./workspace-trust-dialog"

interface Props {
  /** Active session id — the lazy trust prompt fires at most once per session. */
  sessionId: string | null
  /**
   * Bumped by the parent on every send. When it increases while the workspace
   * is restricted (and this session hasn't been prompted yet), the trust dialog
   * opens. This is the "lazy" trigger — prompt on first side-effecting send, not
   * on workspace switch.
   */
  promptNonce: number
}

/**
 * Workspace Trust surface for the conversation: a persistent Restricted-Mode
 * banner plus a lazily-triggered trust dialog. Enforcement itself lives in the
 * build-options pipeline; this is the convenience UI to trust quickly.
 */
export function WorkspaceTrustGate({ sessionId, promptNonce }: Props) {
  const t = useTranslations("chat.workspaceTrust")
  const { restricted, untrustedRoots, trustAll } = useWorkspaceTrust()
  const [dialogPath, setDialogPath] = useState<string | null>(null)
  const promptedSessionRef = useRef<string | null>(null)
  const lastNonceRef = useRef(promptNonce)

  // Lazy trigger: when the parent bumps promptNonce (a send) and we're
  // restricted, open the dialog once per session.
  useEffect(() => {
    if (promptNonce === lastNonceRef.current) return
    lastNonceRef.current = promptNonce
    if (!restricted) return
    if (promptedSessionRef.current === sessionId) return
    promptedSessionRef.current = sessionId

    setDialogPath(untrustedRoots[0]?.path ?? null)
  }, [promptNonce, restricted, sessionId, untrustedRoots])

  return (
    <>
      {restricted && (
        <WorkspaceRestrictedBanner
          untrustedRoots={untrustedRoots}
          onTrust={() => void trustAll()}
        />
      )}
      <WorkspaceTrustDialog
        workspacePath={dialogPath}
        pendingActions={[t("actions.tools"), t("actions.hooks")]}
        onResolved={(trusted) => {
          if (trusted) void trustAll()
          setDialogPath(null)
        }}
      />
    </>
  )
}

export default WorkspaceTrustGate
