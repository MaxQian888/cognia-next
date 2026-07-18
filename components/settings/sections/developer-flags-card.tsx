"use client"

// Developer / debug flags, relocated here from the former standalone "general"
// settings section. Two app-wide developer toggles that belong with the
// observability surface rather than the agent-runtime defaults:
//  - `debugMode` — verbose SDK / sub-process logs
//  - `developer.chatMiddlewareExecution` — experimental plugin chat middleware
//  - `developer.taskWorkspace` — isolated task resource ledger and review UI

import { useTranslations } from "next-intl"
import { BugIcon } from "lucide-react"

import { useSettingsStore } from "@/stores/settings"
import { SettingsCard, SettingsToggle } from "@/components/settings/common/settings-section"

export function DeveloperFlagsCard() {
  const t = useTranslations("settings.diagnostics.developer")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const debugMode = Boolean(settings?.debugMode)
  const chatMiddleware = Boolean(settings?.developer?.chatMiddlewareExecution)
  const taskWorkspace = Boolean(settings?.developer?.taskWorkspace)

  return (
    <SettingsCard
      icon={<BugIcon className="size-5" />}
      title={t("title")}
      description={t("description")}
    >
      <SettingsToggle
        id="diagnostics-debug-mode"
        label={t("debugMode")}
        description={t("debugModeHint")}
        checked={debugMode}
        onCheckedChange={(next) => void save({ debugMode: next || undefined })}
      />
      <SettingsToggle
        id="diagnostics-chat-middleware"
        label={t("chatMiddleware")}
        description={t("chatMiddlewareHint")}
        checked={chatMiddleware}
        onCheckedChange={(next) =>
          void save({ developer: { ...settings?.developer, chatMiddlewareExecution: next } })
        }
      />
      <SettingsToggle
        id="diagnostics-task-workspace"
        label={t("taskWorkspace")}
        description={t("taskWorkspaceHint")}
        checked={taskWorkspace}
        onCheckedChange={(next) =>
          void save({ developer: { ...settings?.developer, taskWorkspace: next } })
        }
      />
    </SettingsCard>
  )
}
