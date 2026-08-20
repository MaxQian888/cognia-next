"use client"

import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { useTerminalStore } from "@/stores/terminal/terminal-store"

export function TerminalHostStateBanner({
  onRetry,
  onOpenSettings,
}: {
  onRetry: () => void
  onOpenSettings: () => void
}) {
  const t = useTranslations("terminal.hostState")
  const state = useTerminalStore((value) => value.hostState)
  if (state === "online") return null
  // Which button helps. Everything here is fixed in settings, not by retrying;
  // `offline` and `reconnecting` are the two a retry can actually resolve.
  const settingsAction =
    state === "unpaired" ||
    state === "unauthorized" ||
    state === "remote_access_disabled" ||
    state === "resource_limited" ||
    state === "incompatible"

  return (
    <div
      className="flex shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs"
      role="status"
      data-testid="terminal-host-state-banner"
      data-state={state}
    >
      <span className="min-w-0 flex-1 truncate">{t(`state.${state}`)}</span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-6 px-2 text-[11px]"
        onClick={settingsAction ? onOpenSettings : onRetry}
      >
        {t(settingsAction ? "openSettings" : "retry")}
      </Button>
    </div>
  )
}

export default TerminalHostStateBanner
