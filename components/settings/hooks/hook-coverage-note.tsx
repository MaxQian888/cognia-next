"use client"

/**
 * HookCoverageNote — the honest half of the hooks panel.
 *
 * Almost every agent surface reaches lifecycle hooks for free: chat, teammates,
 * connector auto-replies, scheduler runs, workflow agent nodes, plan steps and
 * issue-run adapters all bottom out at `runAndCaptureAssistantReply` →
 * `claude_send`, where the host injects the hook config before the sidecar
 * registers it.
 *
 * Three do not, and there was no way to find that out short of watching a hook
 * fail to fire. They build a renderer-side `LlmClient` and call the provider
 * directly, so they never pass the sidecar — covering them would mean a fourth
 * hook rail, not a fire site. This card names them.
 */

import { useTranslations } from "next-intl"
import { InfoIcon } from "lucide-react"
import { Card } from "@/components/ui/card"
import { HOOK_UNCOVERED_SURFACES } from "@/lib/claude/hooks/capabilities"

export function HookCoverageNote() {
  const t = useTranslations("settings.hooks.coverage")

  return (
    <Card className="gap-2 p-3" data-testid="hook-coverage-note">
      <div className="flex items-center gap-1.5">
        <InfoIcon className="size-3.5 text-muted-foreground" />
        <p className="text-xs font-medium">{t("title")}</p>
      </div>
      <p className="text-[11px] text-muted-foreground">{t("description")}</p>
      <ul className="space-y-1">
        {HOOK_UNCOVERED_SURFACES.map((surface) => (
          <li
            key={surface.id}
            className="text-[11px] text-muted-foreground"
            data-testid={`hook-uncovered-${surface.id}`}
          >
            <span className="text-foreground">{t(`surfaces.${surface.id}.label`)}</span>
            {" — "}
            {t(`surfaces.${surface.id}.reason`)}
          </li>
        ))}
      </ul>
    </Card>
  )
}
