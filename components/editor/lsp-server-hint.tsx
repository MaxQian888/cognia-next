"use client"

/**
 * Non-intrusive editor banner shown when the language server that owns the
 * current document is not installed (with a one-click Install when the
 * entry carries npm metadata) or has been marked broken by the sidecar
 * supervisor. Dismissible per serverId for the session. Renders nothing on
 * web/mobile (the status store is inert there) and while everything is
 * healthy — clean by construction.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Download, X } from "lucide-react"
import { useLspStatusForLanguage } from "@/hooks/use-lsp-status-for-language"
import { useLspStatusStore } from "@/lib/lsp/lsp-status-store"
import { Button } from "@/components/ui/button"

export interface LspServerHintProps {
  /** Monaco language id of the open document. */
  language: string
}

export function LspServerHint({ language }: LspServerHintProps) {
  const t = useTranslations("editor.lspHint")
  const match = useLspStatusForLanguage(language)
  const install = useLspStatusStore((s) => s.install)
  const progress = useLspStatusStore((s) => s.installProgress)
  const [dismissed, setDismissed] = useState<Record<string, boolean>>({})

  const status = match?.status
  if (!match || !status) return null
  if (dismissed[match.serverId]) return null

  const missing = status.install === "missing"
  const broken = status.health === "broken"
  if (!missing && !broken) return null

  const phase = progress[match.serverId]?.phase
  const installing = phase === "resolving" || phase === "installing"

  return (
    <div
      className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs"
      role="status"
      data-testid="lsp-server-hint"
    >
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {broken
          ? t("broken", { serverId: match.serverId })
          : t("missing", { serverId: match.serverId })}
      </span>
      {missing && status.npmPackage ? (
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-2 text-xs"
          disabled={installing}
          onClick={() => void install(match.serverId)}
          data-testid="lsp-server-hint-install"
        >
          <Download className="mr-1 h-3 w-3" />
          {installing ? t("installing") : t("install")}
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        className="h-6 w-6 p-0"
        onClick={() => setDismissed((d) => ({ ...d, [match.serverId]: true }))}
        aria-label={t("dismissAriaLabel")}
      >
        <X className="h-3 w-3" />
      </Button>
    </div>
  )
}
