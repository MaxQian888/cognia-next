"use client"

import { useTranslations } from "next-intl"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import { useTerminalStore } from "@/stores/terminal/terminal-store"
import { authorizeTerminalHostCredentials } from "@/lib/terminal/host-settings"
import { classifyTerminalHostError } from "@/lib/terminal/host-state"
import { selectTerminalTransportChain } from "@/lib/terminal/pick-transport"

export function TerminalHostStateBanner({
  onRetry,
  onOpenSettings,
}: {
  onRetry: () => void
  onOpenSettings: () => void
}) {
  const t = useTranslations("terminal.hostState")
  const state = useTerminalStore((value) => value.hostState)
  const [authorizing, setAuthorizing] = useState(false)
  const [authorizationFailed, setAuthorizationFailed] = useState(false)
  if (state === "online") {
    if (authorizationFailed) setAuthorizationFailed(false)
    return null
  }
  const credentialFailure = state === "credential_unavailable"
  const canAuthorize = credentialFailure && selectTerminalTransportChain()[0] === "tauri-channel"
  // Which button helps. Everything here is fixed in settings, not by retrying;
  // `offline` and `reconnecting` are the two a retry can actually resolve.
  const settingsAction =
    state === "unpaired" ||
    state === "unauthorized" ||
    state === "remote_access_disabled" ||
    state === "resource_limited" ||
    state === "incompatible" ||
    (credentialFailure && !canAuthorize)

  const authorize = async () => {
    if (authorizing) return
    setAuthorizing(true)
    setAuthorizationFailed(false)
    try {
      await authorizeTerminalHostCredentials()
      onRetry()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      useTerminalStore.getState().setHostState(classifyTerminalHostError(error), message)
      setAuthorizationFailed(true)
    } finally {
      setAuthorizing(false)
    }
  }

  return (
    <div
      className="flex shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs"
      role="status"
      data-testid="terminal-host-state-banner"
      data-state={state}
    >
      <div className="min-w-0 flex-1">
        <p>{t(`state.${state}`)}</p>
        {authorizationFailed && <p role="alert">{t("authorizationFailed")}</p>}
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-6 px-2 text-[11px]"
        disabled={authorizing}
        onClick={canAuthorize ? () => void authorize() : settingsAction ? onOpenSettings : onRetry}
      >
        {t(
          authorizing
            ? "authorizing"
            : canAuthorize
              ? "authorize"
              : settingsAction
                ? "openSettings"
                : "retry"
        )}
      </Button>
    </div>
  )
}

export default TerminalHostStateBanner
