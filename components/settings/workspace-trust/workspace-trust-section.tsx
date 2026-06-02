"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { ShieldCheckIcon, Trash2Icon } from "lucide-react"

import { SettingsCard } from "../common/settings-section"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { useSettingsStore } from "@/stores/settings"
import {
  listTrustedWorkspaces,
  revokeWorkspaceTrust,
  type TrustedWorkspace,
} from "@/lib/db/trusted-workspaces"

/**
 * Workspace Trust settings: the two trust toggles plus a manager for the
 * trusted-folders ledger (revoke per row). Mirrors VS Code's
 * "Security › Workspace Trust" pane.
 */
export function WorkspaceTrustSection() {
  const t = useTranslations("settings.workspaceTrust")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const trust = settings?.workspaceTrust
  const enabled = trust?.enabled !== false
  const promptOnSwitch = trust?.promptOnSwitch === true

  const [trusted, setTrusted] = useState<TrustedWorkspace[]>([])

  const refresh = () => {
    void listTrustedWorkspaces().then(setTrusted)
  }
  useEffect(() => {
    refresh()
  }, [])

  const saveTrust = (patch: { enabled?: boolean; promptOnSwitch?: boolean }) =>
    void save({ workspaceTrust: { enabled, promptOnSwitch, ...patch } })

  const handleRevoke = async (path: string) => {
    await revokeWorkspaceTrust(path)
    refresh()
  }

  return (
    <SettingsCard
      icon={<ShieldCheckIcon className="size-5" />}
      title={t("title")}
      description={t("description")}
    >
      <div className="space-y-8">
        <section className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="ws-trust-enabled">{t("enabledLabel")}</Label>
              <p className="text-sm text-muted-foreground">{t("enabledHint")}</p>
            </div>
            <Switch
              id="ws-trust-enabled"
              aria-label={t("enabledLabel")}
              checked={enabled}
              onCheckedChange={(v) => saveTrust({ enabled: v })}
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="ws-trust-prompt">{t("promptOnSwitchLabel")}</Label>
              <p className="text-sm text-muted-foreground">{t("promptOnSwitchHint")}</p>
            </div>
            <Switch
              id="ws-trust-prompt"
              aria-label={t("promptOnSwitchLabel")}
              checked={promptOnSwitch}
              disabled={!enabled}
              onCheckedChange={(v) => saveTrust({ promptOnSwitch: v })}
            />
          </div>
        </section>

        <section className="space-y-2">
          <Label>{t("trustedFoldersLabel")}</Label>
          {trusted.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("noTrusted")}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {trusted.map((w) => (
                <li
                  key={w.path}
                  className="flex items-center gap-2 rounded-md border bg-muted/30 px-2 py-1.5"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-xs">{w.path}</span>
                    <span className="block text-[10px] text-muted-foreground">
                      {t("trustedAt", { date: new Date(w.trustedAt).toLocaleDateString() })}
                    </span>
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="shrink-0 gap-1"
                    onClick={() => void handleRevoke(w.path)}
                  >
                    <Trash2Icon className="size-3.5" />
                    {t("revoke")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </SettingsCard>
  )
}

export default WorkspaceTrustSection
