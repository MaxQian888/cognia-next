"use client"

/**
 * Secrets on this host (ADR-0224 A6): the chapter of a remote host's device
 * page that lists what the host keeps for work nobody is watching, and seals
 * more.
 *
 *  * **Listed by name only.** Provider keys, git tokens and connection
 *    credentials, each with when it was set and by which device. A value
 *    never comes back to this device.
 *  * **Sealed from here.** A provider key fills a provider the host has no
 *    key for; a git token is used when the host clones from that git host.
 *    Both go over this device's own channel to the host, under one admin
 *    lease, and are removed the same way.
 *  * **Connection credentials** belong to their connection and are set and
 *    removed with it, so they are listed without a remove button.
 *
 * When the host waits for a person to approve this device, the code they
 * need is shown in place and the action continues once they have.
 */

import { getAllProviders } from "@cognia/provider-types/provider"
import { KeyRoundIcon, ShieldAlertIcon, Trash2Icon } from "lucide-react"
import { useFormatter, useTranslations } from "next-intl"
import { useMemo, useState } from "react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useHostSecrets } from "@/hooks/remote-host/use-host-secrets"
import { useMigrationLease } from "@/hooks/remote-host/use-migration-lease"
import type { DeviceRow } from "@/lib/devices/types"
import { supportsHostFeatureOperation } from "@/lib/platform/host-feature-manifest"
import {
  deleteHostSecret,
  isManagedHere,
  listHostSecrets,
  requestHostSecretsLease,
  setHostSecret,
  type HostSecretEntry,
  type HostSecretKind,
} from "@/lib/remote-host/host-secrets"
import type { HostAdminLease } from "@/lib/tauri/admin-lease"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"
import { useSettingsStore } from "@/stores/settings"

import { DeviceSection } from "../device-section"

export interface HostSecretsSectionDeps {
  load?: (hostId: string) => Promise<HostSecretEntry[]>
  requestLease?: (hostId: string) => Promise<HostAdminLease>
  set?: typeof setHostSecret
  remove?: typeof deleteHostSecret
}

const KIND_ORDER: readonly HostSecretKind[] = ["provider", "git", "connector"]

type WritableKind = "provider" | "git"

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Providers a key can be sealed for: built-ins that take one, and this account's own. */
function useProviderOptions(): Array<{ id: string; label: string }> {
  const customProviders = useSettingsStore((state) => state.customProviders)
  return useMemo(() => {
    const builtIn = Object.values(getAllProviders())
      .filter((provider) => provider.apiKeyRequired)
      .map((provider) => ({ id: provider.id, label: provider.name }))
    const custom = (customProviders ?? []).map((provider) => ({
      id: provider.id,
      label: provider.customName || provider.name || provider.id,
    }))
    const seen = new Set<string>()
    return [...builtIn, ...custom]
      .filter((option) => !seen.has(option.id) && seen.add(option.id))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [customProviders])
}

export function HostSecretsSection({
  row,
  deps = {},
}: {
  row: DeviceRow
  deps?: HostSecretsSectionDeps
}) {
  const t = useTranslations("devices.hostSecrets")
  const tc = useTranslations("devices.alwaysOn.consent")
  const format = useFormatter()
  const hostId = row.hostId ?? null
  const host = row.label
  const remoteHost = useRemoteHostStore((state) =>
    hostId ? state.hosts.find((candidate) => candidate.id === hostId) : undefined
  )
  const manifest = remoteHost?.featureManifest
  // An unknown manifest is asked anyway; only a host that answered without
  // the feature is known to be too old.
  const supported =
    !manifest || supportsHostFeatureOperation(manifest, "always-on.secrets", "host_secret_list")
  const ownDeviceId = remoteHost?.config.deviceId
  const { entries, error, reload } = useHostSecrets(hostId, {
    enabled: supported,
    load: deps.load ?? listHostSecrets,
  })
  const lease = useMigrationLease(hostId, { request: deps.requestLease ?? requestHostSecretsLease })
  const set = deps.set ?? setHostSecret
  const remove = deps.remove ?? deleteHostSecret
  const providers = useProviderOptions()

  const [kind, setKind] = useState<WritableKind>("provider")
  const [name, setName] = useState("")
  const [value, setValue] = useState("")
  const [busyKey, setBusyKey] = useState<string | null>(null)
  /** The action waiting on a person at the host. */
  const [awaiting, setAwaiting] = useState<{ run: () => Promise<void> } | null>(null)
  const [confirming, setConfirming] = useState<HostSecretEntry | null>(null)

  const labelOf = (entry: Pick<HostSecretEntry, "kind" | "name">) =>
    entry.kind === "provider"
      ? (providers.find((option) => option.id === entry.name)?.label ?? entry.name)
      : entry.name

  const provenance = (entry: HostSecretEntry): string => {
    const when = entry.setAt ? format.relativeTime(entry.setAt) : null
    if (entry.setBy) {
      const device =
        entry.setBy.deviceId === ownDeviceId
          ? t("thisDevice")
          : (entry.setBy.label ?? entry.setBy.deviceId)
      return when ? t("setBy", { when, device }) : t("setByUndated", { device })
    }
    return when ? t("setByHost", { when, host }) : t("setByHostUndated", { host })
  }

  const withLease = async (key: string, act: (adminLease: string) => Promise<void>) => {
    setBusyKey(key)
    try {
      const token = await lease.acquire()
      if (!token) {
        setAwaiting({ run: () => withLease(key, act) })
        return
      }
      setAwaiting(null)
      await act(token)
    } catch (cause) {
      toast.error(message(cause))
    } finally {
      setBusyKey(null)
      await reload()
    }
  }

  const seal = () => {
    if (!hostId) return
    const write = { kind, name, value }
    return withLease("seal", async (adminLease) => {
      const saved = await set(hostId, write, adminLease)
      toast.success(t("saved", { name: labelOf(saved), host }))
      setValue("")
      setName("")
    })
  }

  const removeNow = (entry: HostSecretEntry) => {
    setConfirming(null)
    if (!hostId) return
    return withLease(`${entry.kind}:${entry.name}`, async (adminLease) => {
      await remove(hostId, entry, adminLease)
      toast.success(t("removed", { name: labelOf(entry), host }))
    })
  }

  if (!hostId) return null

  const grouped = KIND_ORDER.map((group) => ({
    kind: group,
    entries: (entries ?? []).filter((entry) => entry.kind === group),
  })).filter((group) => group.entries.length > 0)
  const canSeal = name.trim().length > 0 && value.trim().length > 0 && busyKey === null

  return (
    <DeviceSection
      id="host-secrets"
      title={t("title")}
      icon={KeyRoundIcon}
      meta={entries ? t("meta", { count: entries.length }) : undefined}
      description={t("description", { host })}
      wide
    >
      <div className="space-y-4" data-testid="host-secrets-section">
        {!supported ? (
          <Alert data-testid="host-secrets-too-old">
            <AlertDescription>{t("tooOld", { host })}</AlertDescription>
          </Alert>
        ) : null}

        {error ? (
          <Alert variant="destructive">
            <AlertDescription className="break-words">{error}</AlertDescription>
          </Alert>
        ) : null}

        {awaiting ? (
          <Alert data-testid="host-secrets-consent">
            <ShieldAlertIcon className="size-4" />
            <AlertTitle>{tc("title", { host })}</AlertTitle>
            <AlertDescription className="space-y-2">
              <p>
                {lease.awaitingConsent?.code ? tc("body", { host }) : tc("bodyNoCode", { host })}
              </p>
              {lease.awaitingConsent?.code ? (
                <code className="block w-fit rounded bg-muted px-2 py-1 font-mono text-base tracking-widest">
                  {lease.awaitingConsent.code}
                </code>
              ) : null}
              <Button
                size="sm"
                disabled={lease.requesting}
                onClick={() => void awaiting.run()}
                data-testid="host-secrets-consent-continue"
              >
                {tc("continue")}
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        {supported ? (
          entries && grouped.length > 0 ? (
            <div className="space-y-3" data-testid="host-secrets-list">
              {grouped.map((group) => (
                <div key={group.kind}>
                  <h3 className="mb-1.5 text-xs font-medium text-muted-foreground uppercase">
                    {t(`kind.${group.kind}`)}
                  </h3>
                  {group.kind === "connector" ? (
                    <p className="mb-1.5 text-xs text-muted-foreground">{t("connectorNote")}</p>
                  ) : null}
                  <ul className="space-y-1.5">
                    {group.entries.map((entry) => {
                      const key = `${entry.kind}:${entry.name}`
                      return (
                        <li
                          key={key}
                          className="flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-2 text-sm"
                          data-testid={`host-secret-${key}`}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="font-medium break-all">{labelOf(entry)}</span>
                            <span className="block text-xs text-muted-foreground">
                              {provenance(entry)}
                            </span>
                          </span>
                          {isManagedHere(entry.kind) ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busyKey !== null}
                              onClick={() => setConfirming(entry)}
                              aria-label={t("removeAria", { name: labelOf(entry) })}
                              data-testid={`host-secret-remove-${key}`}
                            >
                              <Trash2Icon className="size-3.5" />
                              {busyKey === key ? t("removing") : t("remove")}
                            </Button>
                          ) : null}
                        </li>
                      )
                    })}
                  </ul>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {entries ? t("empty", { host }) : t("loading", { host })}
            </p>
          )
        ) : null}

        {supported ? (
          <div className="space-y-3 rounded-md border p-3" data-testid="host-secrets-add">
            <h3 className="text-sm font-medium">{t("add.title")}</h3>
            <RadioGroup
              value={kind}
              onValueChange={(next) => {
                setKind(next as WritableKind)
                setName("")
              }}
              className="flex flex-wrap gap-4"
            >
              {(["provider", "git"] as const).map((option) => (
                <div key={option} className="flex items-center gap-2">
                  <RadioGroupItem
                    value={option}
                    id={`host-secret-kind-${option}`}
                    data-testid={`host-secret-kind-${option}`}
                  />
                  <Label htmlFor={`host-secret-kind-${option}`} className="text-sm font-normal">
                    {t(`add.kind.${option}`)}
                  </Label>
                </div>
              ))}
            </RadioGroup>

            {kind === "provider" ? (
              <div className="space-y-1.5">
                <Label htmlFor="host-secret-provider" className="text-xs">
                  {t("add.provider")}
                </Label>
                <Select value={name} onValueChange={setName}>
                  <SelectTrigger id="host-secret-provider" data-testid="host-secret-provider">
                    <SelectValue placeholder={t("add.providerPlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {providers.map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="host-secret-git-host" className="text-xs">
                  {t("add.gitHost")}
                </Label>
                <Input
                  id="host-secret-git-host"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={t("add.gitHostPlaceholder")}
                  autoComplete="off"
                  data-testid="host-secret-git-host"
                />
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="host-secret-value" className="text-xs">
                {kind === "provider" ? t("add.apiKey") : t("add.token")}
              </Label>
              <Input
                id="host-secret-value"
                type="password"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                autoComplete="new-password"
                spellCheck={false}
                data-testid="host-secret-value"
              />
              <p className="text-xs text-muted-foreground">
                {t(kind === "provider" ? "add.providerHint" : "add.gitHint", { host })}
              </p>
            </div>

            <Button
              size="sm"
              disabled={!canSeal}
              onClick={() => void seal()}
              data-testid="host-secret-save"
            >
              {busyKey === "seal" ? t("add.saving") : t("add.save", { host })}
            </Button>
          </div>
        ) : null}

        <p className="text-xs text-muted-foreground">{t("revokeNote", { host })}</p>
      </div>

      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("confirm.title", { name: confirming ? labelOf(confirming) : "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(confirming?.kind === "git" ? "confirm.gitBody" : "confirm.providerBody", {
                host,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("confirm.keep")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirming && void removeNow(confirming)}
              data-testid="host-secret-remove-confirm"
            >
              {t("confirm.remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DeviceSection>
  )
}
