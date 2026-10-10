"use client"

/**
 * Settings → Remote sandboxes (ADR-0221 G7, G10).
 *
 * The desktop's remote sandbox providers — E2B, or a Kubernetes cluster —
 * that runs asking for a runtime environment can be placed on, and the
 * registries their images may come from. Desktop only: a server reads its
 * providers from `COGNIA_SANDBOX_PROVIDERS_FILE`, which no client edits.
 *
 * Saved settings apply at the next app start; the page says so after every
 * save and until the app restarts (`restartRequired`). Beside each provider
 * it shows what the pool running now reports for it — reachable or not, and
 * how much of its limit is in use — which is the page's connection check.
 *
 * # Labeled as not yet real (Working Rule 7)
 *
 * A build with no digest-pinned agent bundle runs nothing remotely whatever
 * is configured (`DesktopRemoteSandboxesAvailability` `bundle_unpinned`).
 * The page keeps the providers editable and says, above them, that this
 * build will not use them; pinned by this component's test and
 * `an_unpinned_build_keeps_remote_sandboxes_off` (Rust).
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { CloudIcon, PencilIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react"

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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  useRemoteSandboxes,
  type RemoteSandboxesActions,
  type RemoteSandboxesProblem,
  type RemoteSandboxesState,
  type RunningPool,
} from "@/hooks/sandbox/use-remote-sandboxes"
import type { ProviderDraft } from "@/lib/sandbox/remote-sandbox-draft"
import type {
  RemoteSandboxesView as RemoteSandboxesViewModel,
  SandboxProviderConfig,
} from "@/types/sandbox/remote-sandboxes"
import { DEFAULT_SANDBOX_PROVIDER_LIMITS } from "@/types/sandbox/remote-sandboxes"
import { RemoteSandboxProviderEditor } from "./remote-sandbox-provider-editor"
import { RemoteSandboxRegistryAllowlist } from "./remote-sandbox-registry-allowlist"
import { RemoteSandboxesProblemText } from "./remote-sandboxes-problem-text"

type Editing = { existing?: SandboxProviderConfig }

export function RemoteSandboxesSection() {
  return <RemoteSandboxesView sandboxes={useRemoteSandboxes()} />
}

/** The page for a state it is handed; split from the hook so tests drive it. */
export function RemoteSandboxesView({
  sandboxes,
}: {
  sandboxes: RemoteSandboxesState & RemoteSandboxesActions
}) {
  const t = useTranslations("settings.remoteSandboxes")
  const [editing, setEditing] = useState<Editing | null>(null)
  const [removing, setRemoving] = useState<SandboxProviderConfig | null>(null)
  const [actionProblem, setActionProblem] = useState<RemoteSandboxesProblem>()
  const { status, view, running, loadProblem, busy } = sandboxes

  const label = (provider: SandboxProviderConfig) => provider.label ?? provider.id

  const saveProvider = async (draft: ProviderDraft, editingId?: string) => {
    const result = await sandboxes.saveProvider(draft, editingId)
    if (result.ok) toast.success(t("saved"))
    return result
  }

  const onRemove = async () => {
    if (!removing) return
    const result = await sandboxes.removeProvider(removing.id)
    if (result.ok) {
      toast.success(t("removed", { label: label(removing) }))
      setRemoving(null)
      setActionProblem(undefined)
    } else {
      setRemoving(null)
      setActionProblem(result.problem)
    }
  }

  const onDefault = async (id: string | undefined) => {
    const result = await sandboxes.setDefaultProvider(id)
    setActionProblem(result.ok ? undefined : result.problem)
    if (result.ok) toast.success(t("saved"))
  }

  return (
    <div className="space-y-6" data-testid="remote-sandboxes-section">
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-64">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <CloudIcon className="size-4.5 text-muted-foreground" aria-hidden="true" />
            {t("title")}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={status === "loading" || busy}
          onClick={() => void sandboxes.reload()}
        >
          <RefreshCwIcon className="size-4" aria-hidden="true" />
          {t("reload")}
        </Button>
      </header>

      {status === "loading" ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("loading")}
        </p>
      ) : null}

      {status === "failed" ? (
        <div className="space-y-1">
          <p className="text-sm">{t("failed")}</p>
          {loadProblem ? <RemoteSandboxesProblemText problem={loadProblem} /> : null}
        </div>
      ) : null}

      {view ? (
        <>
          <Status view={view} />
          {status === "ready" && loadProblem ? (
            <RemoteSandboxesProblemText problem={loadProblem} />
          ) : null}

          <section className="space-y-3" data-testid="remote-sandbox-providers">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-medium">{t("providers.title")}</h3>
                <p className="text-xs text-muted-foreground">{t("providers.defaultHint")}</p>
              </div>
              <Button type="button" size="sm" disabled={busy} onClick={() => setEditing({})}>
                <PlusIcon className="size-4" aria-hidden="true" />
                {t("providers.add")}
              </Button>
            </div>
            {view.settings.providers.providers.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("providers.empty")}</p>
            ) : (
              <ul className="divide-y border-y">
                {view.settings.providers.providers.map((provider) => (
                  <ProviderRow
                    key={provider.id}
                    provider={provider}
                    view={view}
                    running={running}
                    busy={busy}
                    onEdit={() => setEditing({ existing: provider })}
                    onRemove={() => setRemoving(provider)}
                    onDefault={onDefault}
                  />
                ))}
              </ul>
            )}
            {running?.kind === "unreadable" ? (
              <div className="space-y-1" data-testid="remote-sandboxes-running-unreadable">
                <p className="text-xs text-muted-foreground">{t("providers.live.unreadable")}</p>
                <RemoteSandboxesProblemText problem={running.problem} />
              </div>
            ) : null}
            {actionProblem ? <RemoteSandboxesProblemText problem={actionProblem} /> : null}
          </section>

          <RemoteSandboxRegistryAllowlist
            rules={view.settings.registryAllowlist}
            busy={busy}
            save={sandboxes.saveRegistryAllowlist}
          />

          <RemoteSandboxProviderEditor
            open={editing !== null}
            onOpenChange={(open) => {
              if (!open) setEditing(null)
            }}
            {...(editing?.existing ? { existing: editing.existing } : {})}
            existingIds={view.settings.providers.providers.map((provider) => provider.id)}
            storedSecretIds={view.storedSecretIds}
            busy={busy}
            save={saveProvider}
          />

          <AlertDialog
            open={removing !== null}
            onOpenChange={(open) => {
              if (!open) setRemoving(null)
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t("removeDialog.title", { label: removing ? label(removing) : "" })}
                </AlertDialogTitle>
                <AlertDialogDescription>{t("removeDialog.body")}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("removeDialog.cancel")}</AlertDialogCancel>
                <AlertDialogAction
                  disabled={busy}
                  onClick={(event) => {
                    event.preventDefault()
                    void onRemove()
                  }}
                >
                  {t("removeDialog.confirm")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      ) : null}
    </div>
  )
}

function Status({ view }: { view: RemoteSandboxesViewModel }) {
  const t = useTranslations("settings.remoteSandboxes")
  return (
    <div className="space-y-3">
      {view.availability === "bundle_unpinned" ? (
        <Alert data-testid="remote-sandboxes-bundle-unpinned" data-dormant="bundle-unpinned">
          <AlertTitle>{t("availability.bundleUnpinnedTitle")}</AlertTitle>
          <AlertDescription>{t("availability.bundleUnpinned")}</AlertDescription>
        </Alert>
      ) : (
        <p
          className="text-sm text-muted-foreground"
          data-testid="remote-sandboxes-availability"
          data-availability={view.availability}
        >
          {view.availability === "active"
            ? t("availability.active")
            : t("availability.noProviders")}
          {view.bundle ? (
            <span className="ml-1">
              {t("availability.bundle", { tag: view.bundle.releaseTag })}
            </span>
          ) : null}
        </p>
      )}
      {view.restartRequired ? (
        <Alert data-testid="remote-sandboxes-restart">
          <AlertTitle>{t("restart.title")}</AlertTitle>
          <AlertDescription>{t("restart.body")}</AlertDescription>
        </Alert>
      ) : null}
      {view.installError ? (
        <Alert variant="destructive" data-testid="remote-sandboxes-install-error">
          <AlertTitle>{t("installError.title")}</AlertTitle>
          <AlertDescription className="break-words">
            {t("installError.body", { error: view.installError })}
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  )
}

function ProviderRow({
  provider,
  view,
  running,
  busy,
  onEdit,
  onRemove,
  onDefault,
}: {
  provider: SandboxProviderConfig
  view: RemoteSandboxesViewModel
  running: RunningPool | undefined
  busy: boolean
  onEdit(): void
  onRemove(): void
  onDefault(id: string | undefined): void
}) {
  const t = useTranslations("settings.remoteSandboxes.providers")
  const providers = view.settings.providers
  const explicitDefault = providers.defaultProviderId === provider.id
  // A single remote provider is the default without being named one.
  const implicitDefault = providers.providers.length === 1 && !providers.defaultProviderId
  const limits = { ...DEFAULT_SANDBOX_PROVIDER_LIMITS, ...provider.limits }
  const credential = provider.credential
  const credentialText =
    credential === undefined
      ? t("credential.none")
      : "secretId" in credential
        ? view.storedSecretIds.includes(credential.secretId)
          ? t("credential.stored")
          : t("credential.missing")
        : "env" in credential
          ? t("credential.env", { name: credential.env })
          : t("credential.file", { path: credential.file })
  // What the pool running now says about this provider. A provider saved
  // since startup is not in it yet.
  const live =
    running?.kind === "providers"
      ? running.providers.find((candidate) => candidate.id === provider.id)
      : undefined
  const liveText =
    running === undefined || running.kind === "unreadable"
      ? undefined
      : live === undefined
        ? t("live.notRunning")
        : live.reachable
          ? t("live.reachable", {
              instances: live.usage?.instances ?? 0,
              sessions: live.usage?.sessions ?? 0,
            })
          : t("live.unreachable", { code: live.unavailableCode ?? "" })
  const credentialMissing =
    credential !== undefined &&
    "secretId" in credential &&
    !view.storedSecretIds.includes(credential.secretId)

  return (
    <li
      className="flex flex-wrap items-start justify-between gap-3 py-3"
      data-testid={`remote-sandbox-provider-${provider.id}`}
    >
      <div className="min-w-0 flex-1 basis-64 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{provider.label ?? provider.id}</span>
          <Badge variant="outline">{t(`kind.${provider.kind}`)}</Badge>
          {explicitDefault ? <Badge variant="secondary">{t("default")}</Badge> : null}
          {implicitDefault ? <Badge variant="secondary">{t("onlyDefault")}</Badge> : null}
        </div>
        {provider.label ? (
          <p className="font-mono text-xs text-muted-foreground">{provider.id}</p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {t("limits", {
            concurrent: limits.maxConcurrent,
            lifetime: limits.maxLifetimeSecs / 60,
            idle: limits.idleTimeoutSecs / 60,
          })}
        </p>
        <p
          className={
            credentialMissing ? "text-xs text-destructive" : "text-xs text-muted-foreground"
          }
        >
          {credentialText}
        </p>
        {liveText ? (
          <p
            className={
              live && !live.reachable
                ? "text-xs text-amber-700 dark:text-amber-400"
                : "text-xs text-muted-foreground"
            }
            data-testid={`remote-sandbox-live-${provider.id}`}
          >
            {liveText}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap gap-1">
        {providers.providers.length > 1 ? (
          explicitDefault ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => onDefault(undefined)}
            >
              {t("clearDefault")}
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => onDefault(provider.id)}
            >
              {t("makeDefault")}
            </Button>
          )
        ) : null}
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onEdit}>
          <PencilIcon className="size-4" aria-hidden="true" />
          {t("edit")}
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onRemove}>
          <Trash2Icon className="size-4" aria-hidden="true" />
          {t("remove")}
        </Button>
      </div>
    </li>
  )
}
