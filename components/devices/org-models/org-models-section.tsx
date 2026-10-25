"use client"

/**
 * Organization models (plan §9b, P6a/P6g): the chapter of a multi-tenant
 * Host's device page where an org owner or admin keeps the org's model keys
 * and picks the bundled agents members may run.
 *
 *  * **Keys go one way.** A key is sent to the Host and never comes back:
 *    the list shows the provider, a short fingerprint that tells two keys
 *    apart, and who set it when.
 *  * **Agents follow the keys.** Every agent the Host ships is offered. The
 *    gateway translates any org key for a brokered agent, so an agent is
 *    marked when the org has no key yet, or when no key can ever serve it
 *    here because it has no brokered launch.
 *  * **Live standing, no lease.** The Host binds the org to the signed-in
 *    person and re-checks owner or admin standing on every call. A member
 *    sees why there is nothing to manage here instead of a form that fails.
 */

import { BuildingIcon, Trash2Icon } from "lucide-react"
import { useFormatter, useTranslations } from "next-intl"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import { Alert, AlertDescription } from "@/components/ui/alert"
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { findRuntimeById } from "@/lib/ai/agent/external/config/install-catalog"
import { managementRefOf } from "@/lib/devices/section-plan"
import type { DeviceRow } from "@/lib/devices/types"
import {
  deleteOrgCredential,
  getOrgAgentPolicy,
  listOrgCredentials,
  orgModelsRefusal,
  setOrgAgentPolicy,
  setOrgCredential,
  type OrgAgentAvailability,
  type OrgAgentPolicy,
  type OrgCredentialEntry,
  type OrgModelsRefusal,
} from "@/lib/remote-host/org-models"

import { DeviceSection } from "../device-section"
import { OrgUsagePanel, type OrgUsagePanelDeps } from "./org-usage-panel"
import { useProviderOptions } from "../host-secrets/host-secrets-section"

export interface OrgModelsSectionDeps {
  listCredentials?: (hostRef: string) => Promise<OrgCredentialEntry[]>
  getPolicy?: (hostRef: string) => Promise<OrgAgentPolicy>
  setCredential?: (
    hostRef: string,
    write: { provider: string; apiKey: string }
  ) => Promise<OrgCredentialEntry>
  deleteCredential?: (hostRef: string, provider: string) => Promise<void>
  setPolicy?: (
    hostRef: string,
    policy: { allowedAgents: string[]; defaultAgent: string | null }
  ) => Promise<OrgAgentPolicy>
  usage?: OrgUsagePanelDeps
}

interface Loaded {
  credentials: OrgCredentialEntry[]
  policy: OrgAgentPolicy
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function agentName(runtimeId: string): string {
  return findRuntimeById(runtimeId)?.displayName ?? runtimeId
}

/** Every agent the Host offers; an older Host lists only the allowed ones. */
function offeredAgents(policy: OrgAgentPolicy): OrgAgentAvailability[] {
  return policy.bundledAgents?.length ? policy.bundledAgents : policy.allowedAgents
}

export function OrgModelsSection({
  row,
  deps = {},
}: {
  row: DeviceRow
  deps?: OrgModelsSectionDeps
}) {
  const t = useTranslations("devices.orgModels")
  const format = useFormatter()
  const hostRef = managementRefOf(row)
  const host = row.label
  const listCredentials = deps.listCredentials ?? listOrgCredentials
  const getPolicy = deps.getPolicy ?? getOrgAgentPolicy
  const writeCredential = deps.setCredential ?? setOrgCredential
  const removeCredential = deps.deleteCredential ?? deleteOrgCredential
  const writePolicy = deps.setPolicy ?? setOrgAgentPolicy

  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [refusal, setRefusal] = useState<OrgModelsRefusal | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Only the newest read may land: a slow read for the previous host must not
  // overwrite the current one.
  const generation = useRef(0)

  const reload = useCallback(async () => {
    const ticket = ++generation.current
    if (!hostRef) return
    try {
      const [credentials, policy] = await Promise.all([
        listCredentials(hostRef),
        getPolicy(hostRef),
      ])
      if (ticket !== generation.current) return
      setLoaded({ credentials, policy })
      setRefusal(null)
      setError(null)
    } catch (cause) {
      if (ticket !== generation.current) return
      const refused = orgModelsRefusal(cause)
      setRefusal(refused)
      setError(refused ? null : message(cause))
    }
  }, [getPolicy, hostRef, listCredentials])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the read on mount; its results land after the await
    void reload()
  }, [reload])

  const [provider, setProvider] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<OrgCredentialEntry | null>(null)
  /** The admin's unsaved agent choice; null while it matches the Host. */
  const [draft, setDraft] = useState<{ allowed: string[]; defaultAgent: string | null } | null>(
    null
  )

  const agents = useMemo(() => (loaded ? offeredAgents(loaded.policy) : []), [loaded])
  const providers = useProviderOptions()
  const providerLabel = (id: string) => providers.find((option) => option.id === id)?.label ?? id

  const saved = loaded
    ? {
        allowed: loaded.policy.allowedAgents.map((agent) => agent.runtimeId),
        defaultAgent: loaded.policy.defaultAgent,
      }
    : { allowed: [], defaultAgent: null }
  const choice = draft ?? saved

  const act = async (key: string, run: () => Promise<void>) => {
    setBusy(key)
    try {
      await run()
    } catch (cause) {
      const refused = orgModelsRefusal(cause)
      if (refused) setRefusal(refused)
      toast.error(refused === "not-admin" ? t("notAdmin") : message(cause))
    } finally {
      setBusy(null)
      await reload()
    }
  }

  const saveKey = () => {
    if (!hostRef) return
    const write = { provider, apiKey }
    return act("key", async () => {
      const entry = await writeCredential(hostRef, write)
      toast.success(t("saved", { provider: providerLabel(entry.provider), host }))
      setApiKey("")
      setProvider("")
    })
  }

  const removeKey = (entry: OrgCredentialEntry) => {
    setConfirming(null)
    if (!hostRef) return
    return act(`remove:${entry.provider}`, async () => {
      await removeCredential(hostRef, entry.provider)
      toast.success(t("removed", { provider: providerLabel(entry.provider), host }))
    })
  }

  const saveAgents = () => {
    if (!hostRef || !draft) return
    const next = { allowedAgents: draft.allowed, defaultAgent: draft.defaultAgent }
    return act("agents", async () => {
      await writePolicy(hostRef, next)
      setDraft(null)
      toast.success(t("agents.saved", { host }))
    })
  }

  const toggle = (runtimeId: string, on: boolean) => {
    const allowed = on
      ? agents
          .map((agent) => agent.runtimeId)
          .filter((id) => id === runtimeId || choice.allowed.includes(id))
      : choice.allowed.filter((id) => id !== runtimeId)
    const defaultAgent =
      choice.defaultAgent && allowed.includes(choice.defaultAgent)
        ? choice.defaultAgent
        : (allowed[0] ?? null)
    setDraft({ allowed, defaultAgent })
  }

  if (!hostRef) return null

  const provenance = (entry: OrgCredentialEntry): string => {
    const when = format.relativeTime(entry.setAt)
    return entry.setBy === "operator"
      ? t("keys.setByOperator", { when })
      : t("keys.setBy", { when })
  }
  const canSaveKey = provider.length > 0 && apiKey.trim().length > 0 && busy === null
  const dirty =
    draft !== null &&
    (draft.defaultAgent !== saved.defaultAgent ||
      draft.allowed.length !== saved.allowed.length ||
      draft.allowed.some((id, index) => id !== saved.allowed[index]))

  return (
    <DeviceSection
      id="org-models"
      title={t("title")}
      icon={BuildingIcon}
      meta={loaded ? t("meta", { count: loaded.credentials.length }) : undefined}
      description={t("description", { host })}
      wide
    >
      <div className="space-y-4" data-testid="org-models-section">
        {refusal ? (
          <Alert data-testid={`org-models-${refusal}`}>
            <AlertDescription>
              {refusal === "not-admin" ? t("notAdmin") : t("notOrgHost", { host })}
            </AlertDescription>
          </Alert>
        ) : null}

        {error ? (
          <Alert variant="destructive">
            <AlertDescription className="break-words">{error}</AlertDescription>
          </Alert>
        ) : null}

        {!loaded && !refusal && !error ? (
          <p className="text-sm text-muted-foreground">{t("loading", { host })}</p>
        ) : null}

        {loaded && !refusal ? (
          <>
            <div className="space-y-2">
              <h3 className="text-xs font-medium text-muted-foreground uppercase">
                {t("keys.title")}
              </h3>
              {loaded.credentials.length > 0 ? (
                <ul className="space-y-1.5" data-testid="org-models-keys">
                  {loaded.credentials.map((entry) => (
                    <li
                      key={entry.provider}
                      className="flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-2 text-sm"
                      data-testid={`org-key-${entry.provider}`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="font-medium break-all">
                          {providerLabel(entry.provider)}
                        </span>
                        <code className="ml-2 font-mono text-xs text-muted-foreground">
                          {t("keys.fingerprint", { fingerprint: entry.fingerprint })}
                        </code>
                        <span className="block text-xs text-muted-foreground">
                          {provenance(entry)}
                        </span>
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy !== null}
                        onClick={() => setConfirming(entry)}
                        aria-label={t("keys.removeAria", {
                          provider: providerLabel(entry.provider),
                        })}
                        data-testid={`org-key-remove-${entry.provider}`}
                      >
                        <Trash2Icon className="size-3.5" />
                        {busy === `remove:${entry.provider}`
                          ? t("keys.removing")
                          : t("keys.remove")}
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground" data-testid="org-models-no-keys">
                  {t("keys.empty")}
                </p>
              )}
            </div>

            <div className="space-y-3 rounded-md border p-3" data-testid="org-models-add">
              <h3 className="text-sm font-medium">{t("add.title")}</h3>
              <div className="space-y-1.5">
                <Label htmlFor="org-key-provider" className="text-xs">
                  {t("add.provider")}
                </Label>
                <Select value={provider} onValueChange={setProvider}>
                  <SelectTrigger id="org-key-provider" data-testid="org-key-provider">
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
              <div className="space-y-1.5">
                <Label htmlFor="org-key-value" className="text-xs">
                  {t("add.apiKey")}
                </Label>
                <Input
                  id="org-key-value"
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  autoComplete="new-password"
                  spellCheck={false}
                  data-testid="org-key-value"
                />
                <p className="text-xs text-muted-foreground">{t("add.hint", { host })}</p>
              </div>
              <Button
                size="sm"
                disabled={!canSaveKey}
                onClick={() => void saveKey()}
                data-testid="org-key-save"
              >
                {busy === "key" ? t("add.saving") : t("add.save", { host })}
              </Button>
            </div>

            <div className="space-y-3 rounded-md border p-3" data-testid="org-models-agents">
              <div>
                <h3 className="text-sm font-medium">{t("agents.title")}</h3>
                <p className="text-xs text-muted-foreground">{t("agents.hint")}</p>
              </div>
              <ul className="grid gap-2 sm:grid-cols-2">
                {agents.map((agent) => {
                  const id = `org-agent-${agent.runtimeId}`
                  return (
                    <li key={agent.runtimeId} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        id={id}
                        checked={choice.allowed.includes(agent.runtimeId)}
                        onCheckedChange={(on) => toggle(agent.runtimeId, on === true)}
                        disabled={busy !== null}
                        data-testid={id}
                      />
                      <Label htmlFor={id} className="font-normal">
                        {agentName(agent.runtimeId)}
                      </Label>
                      {agent.available ? null : loaded.credentials.length > 0 ? (
                        <Badge
                          variant="outline"
                          className="text-xs"
                          data-testid={`${id}-unsupported`}
                        >
                          {t("agents.unsupported")}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-xs" data-testid={`${id}-no-key`}>
                          {t("agents.noKey")}
                        </Badge>
                      )}
                    </li>
                  )
                })}
              </ul>
              <div className="space-y-1.5">
                <Label htmlFor="org-agent-default" className="text-xs">
                  {t("agents.default")}
                </Label>
                <Select
                  value={choice.defaultAgent ?? ""}
                  onValueChange={(next) =>
                    setDraft({ allowed: choice.allowed, defaultAgent: next })
                  }
                  disabled={choice.allowed.length === 0}
                >
                  <SelectTrigger id="org-agent-default" data-testid="org-agent-default">
                    <SelectValue placeholder={t("agents.defaultPlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {choice.allowed.map((runtimeId) => (
                      <SelectItem key={runtimeId} value={runtimeId}>
                        {agentName(runtimeId)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  size="sm"
                  disabled={!dirty || busy !== null}
                  onClick={() => void saveAgents()}
                  data-testid="org-agents-save"
                >
                  {busy === "agents" ? t("agents.saving") : t("agents.save")}
                </Button>
                {loaded.policy.updatedAt ? (
                  <span className="text-xs text-muted-foreground">
                    {t("agents.updated", { when: format.relativeTime(loaded.policy.updatedAt) })}
                  </span>
                ) : null}
              </div>
            </div>

            <OrgUsagePanel hostRef={hostRef} host={host} deps={deps.usage} />
          </>
        ) : null}
      </div>

      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("confirm.title", {
                provider: confirming ? providerLabel(confirming.provider) : "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t("confirm.body", { host })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("confirm.keep")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirming && void removeKey(confirming)}
              data-testid="org-key-remove-confirm"
            >
              {t("confirm.remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DeviceSection>
  )
}
