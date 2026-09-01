"use client"

/**
 * Per-host jump and tunnel configuration.
 *
 * Split out of `ssh-hosts.tsx` because the two answer different questions —
 * that one is "how do I log in", this one is "what else travels over the
 * connection" — and because the tunnel half carries a warning the login half
 * does not.
 *
 * Both bind addresses are stated in the UI and are not editable. A rule can
 * only ever listen on `127.0.0.1`, at whichever end does the listening, so the
 * text names the address instead of offering a field that has one legal value.
 */

import { useTranslations } from "next-intl"

import { isTauri } from "@/lib/platform/detect"
import { PlusIcon, Trash2Icon } from "lucide-react"

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
import { Switch } from "@/components/ui/switch"
import {
  jumpHostCandidates,
  newLocalForward,
  newRemoteForward,
  validateLocalForward,
  validateRemoteForward,
} from "@/lib/terminal/ssh-forwarding"
import type { LocalForward, RemoteForward, SshHostProfile } from "@/lib/terminal/ssh-profiles"

/** Sentinel for "no jump host" — a Radix `SelectItem` cannot have an empty value. */
export const NO_JUMP_HOST = "__direct__"

export interface SshForwardingEditorProps {
  profile: SshHostProfile
  allProfiles: readonly SshHostProfile[]
  onChange: (patch: Partial<SshHostProfile>) => void
}

function portValue(raw: string): number {
  const parsed = Number.parseInt(raw, 10)
  return Number.isNaN(parsed) ? 0 : parsed
}

export function SshForwardingEditor({ profile, allProfiles, onChange }: SshForwardingEditorProps) {
  const t = useTranslations("settings.terminal.ssh.forwarding")
  const candidates = jumpHostCandidates(profile, allProfiles)
  const localForwards = profile.localForwards ?? []
  const remoteForwards = profile.remoteForwards ?? []

  function patchLocal(id: string, patch: Partial<LocalForward>): void {
    onChange({
      localForwards: localForwards.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)),
    })
  }

  function patchRemote(id: string, patch: Partial<RemoteForward>): void {
    onChange({
      remoteForwards: remoteForwards.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)),
    })
  }

  return (
    <div className="space-y-3 rounded border border-dashed p-2.5" data-testid="ssh-forwarding">
      {/*
        `buildSynchronizedSshProfiles` emits neither a jump chain nor a
        forwarding rule (ADR-0082, forwarding amendment), so on a paired device
        every field below is recorded and none of it is ever applied. Saying so
        is not an apology for a missing feature: it is the difference between
        "this does nothing here" and "this is broken".
      */}
      {isTauri() ? null : (
        <p
          className="text-[11px] text-amber-600 dark:text-amber-500"
          data-testid="ssh-forwarding-desktop-applies"
        >
          {t("desktopApplies")}
        </p>
      )}
      <div className="space-y-1">
        <Label className="text-[11px]">{t("jumpHost.label")}</Label>
        <Select
          value={profile.jumpHostId ?? NO_JUMP_HOST}
          onValueChange={(value) => onChange({ jumpHostId: value === NO_JUMP_HOST ? null : value })}
        >
          <SelectTrigger className="h-8 text-xs" aria-label={t("jumpHost.label")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_JUMP_HOST}>{t("jumpHost.direct")}</SelectItem>
            {candidates.map((candidate) => (
              <SelectItem key={candidate.id} value={candidate.id}>
                {candidate.name || candidate.host}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[10px] text-muted-foreground">{t("jumpHost.helper")}</p>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-[11px]">{t("local.label")}</Label>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 text-[11px]"
            onClick={() =>
              onChange({ localForwards: [...localForwards, newLocalForward(localForwards)] })
            }
            data-testid="ssh-local-forward-add"
          >
            <PlusIcon className="mr-1 h-3 w-3" />
            {t("add")}
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground">{t("local.helper")}</p>
        {localForwards.map((rule) => {
          const problem = validateLocalForward(
            rule,
            localForwards.filter((other) => other.id !== rule.id).map((other) => other.localPort)
          )
          return (
            <div key={rule.id} className="space-y-1" data-testid={`ssh-local-forward-${rule.id}`}>
              <div className="grid grid-cols-[70px_1fr_70px_auto_auto] items-center gap-1.5">
                <Input
                  type="number"
                  min={1}
                  max={65_535}
                  value={rule.localPort}
                  onChange={(event) =>
                    patchLocal(rule.id, { localPort: portValue(event.target.value) })
                  }
                  aria-label={t("local.localPort")}
                  className="h-8 text-xs"
                />
                <Input
                  value={rule.remoteHost}
                  onChange={(event) => patchLocal(rule.id, { remoteHost: event.target.value })}
                  aria-label={t("local.remoteHost")}
                  placeholder={t("local.remoteHostPlaceholder")}
                  className="h-8 text-xs"
                />
                <Input
                  type="number"
                  min={1}
                  max={65_535}
                  value={rule.remotePort}
                  onChange={(event) =>
                    patchLocal(rule.id, { remotePort: portValue(event.target.value) })
                  }
                  aria-label={t("local.remotePort")}
                  className="h-8 text-xs"
                />
                <Switch
                  className="scale-75"
                  checked={rule.enabled}
                  onCheckedChange={(enabled) => patchLocal(rule.id, { enabled })}
                  aria-label={t("local.enable")}
                  data-testid={`ssh-local-forward-enable-${rule.id}`}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0 text-muted-foreground"
                  onClick={() =>
                    onChange({
                      localForwards: localForwards.filter((other) => other.id !== rule.id),
                    })
                  }
                  aria-label={t("remove")}
                  data-testid={`ssh-local-forward-remove-${rule.id}`}
                >
                  <Trash2Icon className="h-3.5 w-3.5" />
                </Button>
              </div>
              {problem ? (
                <p
                  className="text-[10px] text-red-500"
                  data-testid={`ssh-local-forward-error-${rule.id}`}
                >
                  {t(`errors.${problem}`)}
                </p>
              ) : null}
            </div>
          )
        })}
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-[11px]">{t("remote.label")}</Label>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 text-[11px]"
            onClick={() =>
              onChange({ remoteForwards: [...remoteForwards, newRemoteForward(remoteForwards)] })
            }
            data-testid="ssh-remote-forward-add"
          >
            <PlusIcon className="mr-1 h-3 w-3" />
            {t("add")}
          </Button>
        </div>
        {/* The consequence, not the mechanism: processes on the remote machine
            gain a route to a port on this one. */}
        <p className="text-[10px] text-amber-600 dark:text-amber-500">{t("remote.warning")}</p>
        {remoteForwards.map((rule) => {
          const problem = validateRemoteForward(
            rule,
            remoteForwards.filter((other) => other.id !== rule.id).map((other) => other.remotePort)
          )
          return (
            <div key={rule.id} className="space-y-1" data-testid={`ssh-remote-forward-${rule.id}`}>
              <div className="grid grid-cols-[70px_1fr_70px_auto_auto] items-center gap-1.5">
                <Input
                  type="number"
                  min={1}
                  max={65_535}
                  value={rule.remotePort}
                  onChange={(event) =>
                    patchRemote(rule.id, { remotePort: portValue(event.target.value) })
                  }
                  aria-label={t("remote.remotePort")}
                  className="h-8 text-xs"
                />
                <Input
                  value={rule.localHost}
                  onChange={(event) => patchRemote(rule.id, { localHost: event.target.value })}
                  aria-label={t("remote.localHost")}
                  placeholder={t("remote.localHostPlaceholder")}
                  className="h-8 text-xs"
                />
                <Input
                  type="number"
                  min={1}
                  max={65_535}
                  value={rule.localPort}
                  onChange={(event) =>
                    patchRemote(rule.id, { localPort: portValue(event.target.value) })
                  }
                  aria-label={t("remote.localPort")}
                  className="h-8 text-xs"
                />
                <Switch
                  className="scale-75"
                  checked={rule.enabled}
                  onCheckedChange={(enabled) => patchRemote(rule.id, { enabled })}
                  aria-label={t("remote.enable")}
                  data-testid={`ssh-remote-forward-enable-${rule.id}`}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0 text-muted-foreground"
                  onClick={() =>
                    onChange({
                      remoteForwards: remoteForwards.filter((other) => other.id !== rule.id),
                    })
                  }
                  aria-label={t("remove")}
                  data-testid={`ssh-remote-forward-remove-${rule.id}`}
                >
                  <Trash2Icon className="h-3.5 w-3.5" />
                </Button>
              </div>
              {problem ? (
                <p
                  className="text-[10px] text-red-500"
                  data-testid={`ssh-remote-forward-error-${rule.id}`}
                >
                  {t(`errors.${problem}`)}
                </p>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default SshForwardingEditor
