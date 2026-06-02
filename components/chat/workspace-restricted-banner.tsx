"use client"

import { useTranslations } from "next-intl"
import { ShieldAlertIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { WorkspaceRoot } from "@/types/workspace"

interface Props {
  untrustedRoots: WorkspaceRoot[]
  onTrust: () => void | Promise<void>
}

/**
 * Persistent banner shown above the conversation while the active workspace is
 * in Restricted Mode (any root untrusted). One-click trust. Renders nothing
 * when every root is trusted.
 */
export function WorkspaceRestrictedBanner({ untrustedRoots, onTrust }: Props) {
  const t = useTranslations("chat.workspaceRestricted")
  if (untrustedRoots.length === 0) return null
  return (
    <div
      role="status"
      className="flex flex-col gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm"
    >
      <div className="flex items-center gap-2">
        <ShieldAlertIcon className="size-4 shrink-0 text-amber-500" />
        <span className="font-medium">{t("title")}</span>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto shrink-0"
          onClick={() => void onTrust()}
        >
          {t("trust")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t("body")}</p>
      <ul aria-label={t("rootsLabel")} className="flex flex-col gap-0.5">
        {untrustedRoots.map((r) => (
          <li key={r.id} className="truncate font-mono text-[11px] text-muted-foreground">
            {r.path}
          </li>
        ))}
      </ul>
    </div>
  )
}

export default WorkspaceRestrictedBanner
