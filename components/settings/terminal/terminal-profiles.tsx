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

import { useTranslations } from "next-intl"
import { PlusIcon, Trash2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { nextProfileId, type TerminalProfile } from "@/lib/terminal/profiles"
import { useSettingsStore } from "@/stores/settings"

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

  function persist(patch: Partial<TerminalSettings>): void {
    void save({ terminal: { ...terminal, ...patch } })
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
                    placeholder="pwsh.exe"
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
