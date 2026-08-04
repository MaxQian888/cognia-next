"use client"

import { useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { SettingsBlock } from "@/components/settings/common/settings-block"
import { buildCapabilitySnapshot } from "@/lib/ai/agent/execution/capability-snapshot"
import {
  getAgentExecutionFlags,
  isAgentExecutionFlagEnabled,
  setAgentExecutionFlag,
  subscribeToAgentExecutionFlags,
  type AgentExecutionFlag,
} from "@/lib/ai/agent/execution/feature-flags"
import { resolveAgentExecutionSpec } from "@/lib/ai/agent/execution/resolve-agent-execution-spec"
import { isTauri } from "@/lib/tauri"

const CHILD_FLAGS = [
  ["claudeSdkSessionStore", "sessionStore"],
  ["claudeSdkCheckpoint", "checkpoint"],
  ["claudeSdkPrewarm", "prewarm"],
] as const satisfies readonly [AgentExecutionFlag, string][]

function useFlag(flag: AgentExecutionFlag): boolean {
  return useSyncExternalStore(
    subscribeToAgentExecutionFlags,
    () => isAgentExecutionFlagEnabled(flag),
    () => false
  )
}

export function SdkParityCard() {
  const t = useTranslations("settings.agentRuntimeSection.sidecar.parity")
  const enabled = useFlag("claudeSdkParityV1")
  const sessionStore = useFlag("claudeSdkSessionStore")
  const checkpoint = useFlag("claudeSdkCheckpoint")
  const prewarm = useFlag("claudeSdkPrewarm")
  const childValues = {
    claudeSdkSessionStore: sessionStore,
    claudeSdkCheckpoint: checkpoint,
    claudeSdkPrewarm: prewarm,
  }
  const spec = resolveAgentExecutionSpec({
    surface: "chat",
    environment: { isTauri: isTauri(), isHeadlessHost: false },
    flags: getAgentExecutionFlags(),
    policy: { executionKind: "agent" },
    legacy: { providerId: "anthropic", toolsEnabled: true },
  }).spec
  const snapshot = buildCapabilitySnapshot(spec)

  const setChildFlag = (flag: AgentExecutionFlag, value: boolean) => {
    if (value && flag === "claudeSdkSessionStore" && checkpoint) {
      setAgentExecutionFlag("claudeSdkCheckpoint", false)
    }
    if (value && flag === "claudeSdkCheckpoint" && sessionStore) {
      setAgentExecutionFlag("claudeSdkSessionStore", false)
    }
    setAgentExecutionFlag(flag, value)
  }

  return (
    <SettingsBlock
      title={t("title")}
      description={t("description")}
      testid="sdk-parity-card"
      contentClassName="space-y-4"
    >
      <div className="flex items-center justify-between gap-3 rounded-md border p-3">
        <div className="space-y-1">
          <p className="text-sm font-medium">{t("master.label")}</p>
          <p className="text-xs text-muted-foreground">{t("master.description")}</p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={(value) => setAgentExecutionFlag("claudeSdkParityV1", value)}
          aria-label={t("master.label")}
        />
      </div>

      <div className="flex items-center justify-between gap-3 text-sm">
        <span>{t("capabilities")}</span>
        <Badge variant="secondary">
          {snapshot.counts.native + snapshot.counts.equivalent} / {snapshot.counts.total}
        </Badge>
      </div>

      <div className="space-y-2">
        {CHILD_FLAGS.map(([flag, key]) => (
          <div key={flag} className="flex items-center justify-between gap-3 rounded-md border p-3">
            <div className="space-y-1">
              <p className="text-sm font-medium">{t(`${key}.label` as never)}</p>
              <p className="text-xs text-muted-foreground">{t(`${key}.description` as never)}</p>
            </div>
            <Switch
              checked={childValues[flag]}
              disabled={!enabled}
              onCheckedChange={(value) => setChildFlag(flag, value)}
              aria-label={t(`${key}.label` as never)}
            />
          </div>
        ))}
      </div>
      {!enabled && <p className="text-xs text-muted-foreground">{t("disabledHint")}</p>}
    </SettingsBlock>
  )
}
