"use client"

/**
 * Terminal launch-profiles manager (Windows-Terminal style).
 *
 * Lets the user define named shell presets (name + shell + cwd) that the
 * dock's profile picker can spawn directly, and pick which one the plain
 * "+ New" affordance uses by default. Persists to
 * `settings.terminal.profiles` / `defaultProfileId` via the settings store.
 *
 * Inline-editable rows (no modal) keep the surface small and testable; the
 * pure profile helpers live in `lib/terminal/profiles.ts`.
 */

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { PlusIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  formatProfileArgs,
  formatProfileEnv,
  nextProfileId,
  parseProfileArgs,
  parseProfileEnv,
  type TerminalProfile,
} from "@/lib/terminal/profiles"
import { useSettingsStore } from "@/stores/settings"
import { isTauri } from "@/lib/tauri"
import { syncTerminalHostProfiles } from "@/lib/terminal/host-profiles"

/** In-flight textarea text per profile row, keyed `<profileId>:<field>`. */
type DraftMap = Record<string, string | undefined>

type TerminalSettings = NonNullable<
  NonNullable<ReturnType<typeof useSettingsStore.getState>["settings"]>["terminal"]
>

export function TerminalProfiles() {
  const t = useTranslations()
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const terminal: TerminalSettings = settings?.terminal ?? {}
  const profiles: TerminalProfile[] = terminal.profiles ?? []
  const defaultProfileId = terminal.defaultProfileId

  // args/env textareas parse on every keystroke, but the *displayed* text is
  // the raw draft until blur — otherwise a half-typed line ("KEY=" parses to
  // nothing) would be reformatted out from under the user mid-keystroke.
  const [drafts, setDrafts] = useState<DraftMap>({})
  const profileSyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (profileSyncTimer.current) clearTimeout(profileSyncTimer.current)
    },
    []
  )

  function persist(patch: Partial<TerminalSettings>): void {
    const nextTerminal = { ...terminal, ...patch }
    void save({ terminal: nextTerminal })
    if (patch.profiles && isTauri()) {
      if (profileSyncTimer.current) clearTimeout(profileSyncTimer.current)
      profileSyncTimer.current = setTimeout(() => {
        profileSyncTimer.current = null
        void syncTerminalHostProfiles(patch.profiles, {
          enableShellIntegration: nextTerminal.enableShellIntegration,
          forceUtf8: nextTerminal.forceUtf8,
          sandboxed: nextTerminal.sandboxed,
          sshProfiles: nextTerminal.sshHosts,
        }).catch(() => toast.error(t("settings.terminal.profiles.syncError")))
      }, 200)
    }
  }

  function updateProfile(id: string, patch: Partial<TerminalProfile>): void {
    persist({ profiles: profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)) })
  }

  function addProfile(): void {
    const id = nextProfileId(profiles)
    persist({
      profiles: [...profiles, { id, name: t("settings.terminal.profiles.newName"), shell: "" }],
    })
  }

  function removeProfile(id: string): void {
    persist({
      profiles: profiles.filter((p) => p.id !== id),
      // Clear the default pointer if it referenced the removed profile.
      defaultProfileId: defaultProfileId === id ? undefined : defaultProfileId,
    })
  }

  function setDefault(id: string): void {
    // Toggle: clicking the current default clears it (back to auto-resolve).
    persist({ defaultProfileId: defaultProfileId === id ? undefined : id })
  }

  return (
    <div className="space-y-3" data-testid="terminal-profiles">
      <div className="space-y-0.5">
        <Label className="text-xs">{t("settings.terminal.profiles.title")}</Label>
        <p className="text-[11px] text-muted-foreground">
          {t("settings.terminal.profiles.helper")}
        </p>
      </div>

      {profiles.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">{t("settings.terminal.profiles.empty")}</p>
      ) : (
        <div className="space-y-2">
          {profiles.map((profile) => {
            const isDefault = defaultProfileId === profile.id
            return (
              <div
                key={profile.id}
                className="space-y-2 rounded border p-2.5"
                data-testid={`terminal-profile-${profile.id}`}
              >
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    value={profile.name}
                    placeholder={t("settings.terminal.profiles.namePlaceholder")}
                    onChange={(e) => updateProfile(profile.id, { name: e.target.value })}
                    className="h-7 text-xs"
                    aria-label={t("settings.terminal.profiles.nameLabel")}
                    data-testid={`terminal-profile-name-${profile.id}`}
                  />
                  <Input
                    value={profile.shell}
                    placeholder={
                      /* i18n-exempt: example shell binary, not translatable UI */ "pwsh.exe"
                    }
                    onChange={(e) => updateProfile(profile.id, { shell: e.target.value })}
                    className="h-7 text-xs"
                    aria-label={t("settings.terminal.profiles.shellLabel")}
                    data-testid={`terminal-profile-shell-${profile.id}`}
                  />
                </div>
                <Input
                  value={profile.cwd ?? ""}
                  placeholder={t("settings.terminal.profiles.cwdPlaceholder")}
                  onChange={(e) => updateProfile(profile.id, { cwd: e.target.value })}
                  className="h-7 text-xs"
                  aria-label={t("settings.terminal.profiles.cwdLabel")}
                  data-testid={`terminal-profile-cwd-${profile.id}`}
                />
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-[11px] text-muted-foreground">
                      {t("settings.terminal.profiles.argsLabel")}
                    </Label>
                    <Textarea
                      value={drafts[`${profile.id}:args`] ?? formatProfileArgs(profile.args)}
                      placeholder={t("settings.terminal.profiles.argsPlaceholder")}
                      rows={2}
                      onChange={(e) => {
                        setDrafts((d) => ({ ...d, [`${profile.id}:args`]: e.target.value }))
                        updateProfile(profile.id, { args: parseProfileArgs(e.target.value) })
                      }}
                      onBlur={() => setDrafts((d) => ({ ...d, [`${profile.id}:args`]: undefined }))}
                      className="min-h-0 px-2 py-1 font-mono text-xs"
                      aria-label={t("settings.terminal.profiles.argsLabel")}
                      data-testid={`terminal-profile-args-${profile.id}`}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[11px] text-muted-foreground">
                      {t("settings.terminal.profiles.envLabel")}
                    </Label>
                    <Textarea
                      value={drafts[`${profile.id}:env`] ?? formatProfileEnv(profile.env)}
                      placeholder={t("settings.terminal.profiles.envPlaceholder")}
                      rows={2}
                      onChange={(e) => {
                        setDrafts((d) => ({ ...d, [`${profile.id}:env`]: e.target.value }))
                        updateProfile(profile.id, { env: parseProfileEnv(e.target.value) })
                      }}
                      onBlur={() => setDrafts((d) => ({ ...d, [`${profile.id}:env`]: undefined }))}
                      className="min-h-0 px-2 py-1 font-mono text-xs"
                      aria-label={t("settings.terminal.profiles.envLabel")}
                      data-testid={`terminal-profile-env-${profile.id}`}
                    />
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <Button
                    type="button"
                    size="sm"
                    variant={isDefault ? "secondary" : "ghost"}
                    className="h-6 text-[11px]"
                    onClick={() => setDefault(profile.id)}
                    data-testid={`terminal-profile-default-${profile.id}`}
                  >
                    {isDefault
                      ? t("settings.terminal.profiles.isDefault")
                      : t("settings.terminal.profiles.setDefault")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-6 w-6 p-0 text-muted-foreground"
                    onClick={() => removeProfile(profile.id)}
                    aria-label={t("settings.terminal.profiles.remove")}
                    data-testid={`terminal-profile-remove-${profile.id}`}
                  >
                    <Trash2Icon className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-7 text-xs"
        onClick={addProfile}
        data-testid="terminal-profiles-add"
      >
        <PlusIcon className="mr-1 h-3 w-3" />
        {t("settings.terminal.profiles.add")}
      </Button>
    </div>
  )
}

export default TerminalProfiles
