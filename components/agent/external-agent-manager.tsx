"use client"

/**
 * Lightweight ExternalAgentManager dialog body — replaces Cognia's
 * ~1000-LOC chat-side manager that pulled in agent-trace, tool-approval
 * dialogs, and a custom hooks barrel that aren't migrated yet.
 *
 * This stub exposes just enough to satisfy the `external-agent-selector`
 * import: a panel that points the user at the External Agents settings
 * page (which already ships full CRUD). Replace with the upstream
 * manager when agent-trace + use-external-agent hooks land.
 */

import { ExternalLinkIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useTranslations } from "next-intl"

interface Props {
  onOpenSettings?: () => void
}

export function ExternalAgentManager({ onOpenSettings }: Props) {
  const t = useTranslations("externalAgent")

  return (
    <div className="space-y-3 p-1">
      <p className="text-sm text-muted-foreground">{t("settings.description")}</p>
      <div className="rounded-md border bg-muted/40 p-3 text-sm">
        {t("settings.configuredAgentsDesc")}
      </div>
      {onOpenSettings && (
        <Button variant="outline" size="sm" onClick={onOpenSettings}>
          <ExternalLinkIcon className="mr-2 h-4 w-4" />
          {t("settings.title")}
        </Button>
      )}
    </div>
  )
}

export default ExternalAgentManager
