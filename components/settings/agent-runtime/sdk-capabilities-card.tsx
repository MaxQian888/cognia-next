"use client"

/**
 * Read-only diagnostics for what the LIVE Claude Agent SDK session reports it
 * supports — the account-authoritative model list (with capability flags) and
 * the agent-facing slash commands — via `supportedModels()` / `supportedCommands()`
 * (see `hooks/chat/use-sdk-session-capabilities.ts`).
 *
 * This does NOT drive cognia's own composer model picker or slash menu; it is a
 * transparency surface. Hides itself when no live Anthropic session is open.
 */

import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { SettingsBlock } from "@/components/settings/common/settings-block"
import { useChatStore } from "@/stores/chat"
import { useSdkSessionCapabilities } from "@/hooks/chat/use-sdk-session-capabilities"

export function SdkCapabilitiesCard() {
  const t = useTranslations("settings.agentRuntimeSection.sidecar.capabilities")
  const sessionId = useChatStore((s) => s.activeSessionId)
  const { models, commands } = useSdkSessionCapabilities(sessionId)

  // Hide until the live session reports something (Anthropic + open session).
  if (!models && !commands) return null

  return (
    <SettingsBlock
      title={t("title")}
      description={t("description")}
      testid="sdk-capabilities-card"
      contentClassName="space-y-3 text-xs"
    >
      {models && models.length > 0 ? (
        <div className="space-y-1.5" data-testid="sdk-capabilities-models">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {t("modelsLabel", { count: models.length })}
          </p>
          <div className="flex flex-wrap gap-1">
            {models.map((m) => (
              <Badge
                key={m.value}
                variant="secondary"
                className="text-[10px]"
                title={m.description}
              >
                {m.displayName}
                {m.supportsEffort ? (
                  <span className="ml-1 opacity-60">{t("effortFlag")}</span>
                ) : null}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}
      {commands && commands.length > 0 ? (
        <div className="space-y-1.5" data-testid="sdk-capabilities-commands">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {t("commandsLabel", { count: commands.length })}
          </p>
          <div className="flex flex-wrap gap-1">
            {commands.map((c) => (
              <Badge
                key={c.name}
                variant="outline"
                className="font-mono text-[10px]"
                title={c.description}
              >
                /{c.name}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}
    </SettingsBlock>
  )
}

export default SdkCapabilitiesCard
