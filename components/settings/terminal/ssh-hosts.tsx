"use client"

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { KeyRoundIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { connectSshFromDock } from "@/lib/terminal/ssh-connect"
import { syncTerminalHostProfiles } from "@/lib/terminal/host-profiles"
import { clearSshCredential, saveSshCredential } from "@/lib/terminal/ssh-credentials"
import { nextSshHostId, type SshAuthMethod, type SshHostProfile } from "@/lib/terminal/ssh-profiles"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings"
import { useTerminalStore } from "@/stores/terminal/terminal-store"
import { isTauri } from "@/lib/tauri"

type TerminalSettings = NonNullable<
  NonNullable<ReturnType<typeof useSettingsStore.getState>["settings"]>["terminal"]
>

export function SshHosts() {
  const t = useTranslations("settings.terminal.ssh")
  const settings = useSettingsStore((state) => state.settings)
  const save = useSettingsStore((state) => state.save)
  const activeProjectId = useProjectStore((state) => state.activeProjectId)
  const setPanelOpen = useTerminalStore((state) => state.setPanelOpen)
  const terminal: TerminalSettings = settings?.terminal ?? {}
  const hosts = (terminal.sshHosts ?? []) as SshHostProfile[]
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const hostSyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (hostSyncTimer.current) clearTimeout(hostSyncTimer.current)
    },
    []
  )

  async function persistHosts(next: SshHostProfile[]): Promise<void> {
    const nextTerminal = { ...terminal, sshHosts: next }
    await save({ terminal: nextTerminal })
    if (!isTauri()) return
    if (hostSyncTimer.current) clearTimeout(hostSyncTimer.current)
    hostSyncTimer.current = setTimeout(() => {
      hostSyncTimer.current = null
      void syncTerminalHostProfiles(nextTerminal.profiles, {
        enableShellIntegration: nextTerminal.enableShellIntegration,
        forceUtf8: nextTerminal.forceUtf8,
        sandboxed: nextTerminal.sandboxed,
        sshProfiles: next,
      }).catch((error) =>
        toast.error(t("toasts.syncFailed"), {
          description: error instanceof Error ? error.message : String(error),
        })
      )
    }, 200)
  }

  function updateHost(id: string, patch: Partial<SshHostProfile>): void {
    void persistHosts(hosts.map((host) => (host.id === id ? { ...host, ...patch } : host)))
  }

  function addHost(): void {
    const id = nextSshHostId(hosts)
    void persistHosts([
      ...hosts,
      {
        id,
        name: t("newName"),
        host: "",
        port: 22,
        username: "",
        authMethod: "password",
      },
    ])
  }

  async function removeHost(profile: SshHostProfile): Promise<void> {
    setBusyId(profile.id)
    try {
      if (profile.credentialRef) await clearSshCredential(profile.credentialRef)
      await persistHosts(hosts.filter((host) => host.id !== profile.id))
      setSecrets((current) => {
        const next = { ...current }
        delete next[profile.id]
        return next
      })
    } catch (error) {
      toast.error(t("toasts.removeFailed"), {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusyId(null)
    }
  }

  async function connect(profile: SshHostProfile): Promise<void> {
    setBusyId(profile.id)
    try {
      let effective = profile
      const secret = secrets[profile.id]
      if (secret) {
        await saveSshCredential(
          profile.id,
          profile.authMethod === "password" ? { password: secret } : { passphrase: secret }
        )
        effective = { ...profile, credentialRef: profile.id }
        await persistHosts(hosts.map((host) => (host.id === profile.id ? effective : host)))
        setSecrets((current) => ({ ...current, [profile.id]: "" }))
      }
      if (effective.authMethod === "password" && !effective.credentialRef) {
        toast.error(t("toasts.credentialRequired"))
        return
      }
      const result = await connectSshFromDock({
        profile: effective,
        projectId: activeProjectId ?? undefined,
        rows: 24,
        cols: 80,
        store: useTerminalStore.getState(),
      })
      if (result.kind === "error") {
        toast.error(t("toasts.connectFailed"), { description: result.message })
        return
      }
      setPanelOpen(true)
      toast.success(t(`toasts.${result.hostKeyStatus}`), {
        description: result.hostKeyFingerprint,
      })
    } catch (error) {
      toast.error(t("toasts.connectFailed"), {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section className="space-y-3" data-testid="ssh-hosts">
      <div className="space-y-0.5">
        <Label className="text-xs">{t("title")}</Label>
        <p className="text-[11px] text-muted-foreground">{t("helper")}</p>
      </div>

      {hosts.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">{t("empty")}</p>
      ) : (
        <div className="space-y-2">
          {hosts.map((profile) => {
            const busy = busyId === profile.id
            return (
              <div key={profile.id} className="space-y-2 rounded border p-2.5">
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    value={profile.name}
                    onChange={(event) => updateHost(profile.id, { name: event.target.value })}
                    aria-label={t("fields.name")}
                    placeholder={t("fields.name")}
                    className="h-8 text-xs"
                  />
                  <Input
                    value={profile.host}
                    onChange={(event) => updateHost(profile.id, { host: event.target.value })}
                    aria-label={t("fields.host")}
                    placeholder={t("fields.hostPlaceholder")}
                    className="h-8 text-xs"
                  />
                </div>
                <div className="grid grid-cols-[1fr_90px] gap-2">
                  <Input
                    value={profile.username}
                    onChange={(event) => updateHost(profile.id, { username: event.target.value })}
                    aria-label={t("fields.username")}
                    placeholder={t("fields.username")}
                    className="h-8 text-xs"
                  />
                  <Input
                    type="number"
                    min={1}
                    max={65_535}
                    value={profile.port}
                    onChange={(event) =>
                      updateHost(profile.id, { port: Number(event.target.value) })
                    }
                    aria-label={t("fields.port")}
                    className="h-8 text-xs"
                  />
                </div>
                <Select
                  value={profile.authMethod}
                  onValueChange={(value) =>
                    updateHost(profile.id, {
                      authMethod: value as SshAuthMethod,
                      credentialRef: undefined,
                    })
                  }
                >
                  <SelectTrigger className="h-8 text-xs" aria-label={t("fields.authMethod")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="password">{t("auth.password")}</SelectItem>
                    <SelectItem value="privateKey">{t("auth.privateKey")}</SelectItem>
                  </SelectContent>
                </Select>
                {profile.authMethod === "privateKey" ? (
                  <Input
                    value={profile.privateKeyPath ?? ""}
                    onChange={(event) =>
                      updateHost(profile.id, { privateKeyPath: event.target.value })
                    }
                    aria-label={t("fields.privateKeyPath")}
                    placeholder={t("fields.privateKeyPathPlaceholder")}
                    className="h-8 font-mono text-xs"
                  />
                ) : null}
                <Input
                  type="password"
                  value={secrets[profile.id] ?? ""}
                  onChange={(event) =>
                    setSecrets((current) => ({
                      ...current,
                      [profile.id]: event.target.value,
                    }))
                  }
                  aria-label={
                    profile.authMethod === "password"
                      ? t("fields.password")
                      : t("fields.passphrase")
                  }
                  placeholder={
                    profile.credentialRef
                      ? t("fields.credentialSaved")
                      : profile.authMethod === "password"
                        ? t("fields.password")
                        : t("fields.passphraseOptional")
                  }
                  className="h-8 text-xs"
                  data-testid={`ssh-host-secret-${profile.id}`}
                />
                <div className="flex items-center justify-between">
                  <Button
                    type="button"
                    size="sm"
                    className="h-7 text-xs"
                    disabled={busy}
                    onClick={() => void connect(profile)}
                    data-testid={`ssh-host-connect-${profile.id}`}
                  >
                    <KeyRoundIcon className="mr-1 h-3.5 w-3.5" />
                    {busy ? t("connecting") : t("connect")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 p-0 text-muted-foreground"
                    disabled={busy}
                    onClick={() => void removeHost(profile)}
                    aria-label={t("remove")}
                    data-testid={`ssh-host-remove-${profile.id}`}
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
        onClick={addHost}
        data-testid="ssh-hosts-add"
      >
        <PlusIcon className="mr-1 h-3.5 w-3.5" />
        {t("add")}
      </Button>
    </section>
  )
}

export default SshHosts
