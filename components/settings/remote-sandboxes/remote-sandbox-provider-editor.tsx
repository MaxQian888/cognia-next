"use client"

/**
 * Add or edit one remote sandbox provider (ADR-0221).
 *
 * The form is `ProviderDraft` (`lib/sandbox/remote-sandbox-draft.ts`), which
 * owns every check this dialog shows; the Host validates again on save and a
 * refusal comes back under the form. A credential is write-only: the field
 * starts empty, and empty keeps whatever is stored.
 *
 * A Kubernetes provider on plain NetworkPolicy records an egress allowlist
 * and does not enforce it (Working Rule 7: dormant at
 * `KubernetesEgressMode`, labelled by the egress hint here, pinned by this
 * component's test and `allowlist_is_enforced_only_with_cilium`).
 */

import { useState } from "react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import type {
  RemoteSandboxesProblem,
  RemoteSandboxesWriteResult,
} from "@/hooks/sandbox/use-remote-sandboxes"
import {
  draftFromProvider,
  draftNeedsCredential,
  emptyProviderDraft,
  validateProviderDraft,
  type ProviderDraft,
  type ProviderDraftField,
  type ProviderDraftProblem,
} from "@/lib/sandbox/remote-sandbox-draft"
import type {
  KubernetesEgressMode,
  SandboxProviderConfig,
  SandboxProviderKind,
} from "@/types/sandbox/remote-sandboxes"
import { cn } from "@/lib/utils"
import { RemoteSandboxesProblemText } from "./remote-sandboxes-problem-text"

const EGRESS_MODES: readonly KubernetesEgressMode[] = ["network-policy", "cilium", "none"]
const EGRESS_LABEL_KEYS: Record<KubernetesEgressMode, string> = {
  none: "egressNone",
  "network-policy": "egressNetworkPolicy",
  cilium: "egressCilium",
}

export interface RemoteSandboxProviderEditorProps {
  open: boolean
  onOpenChange(open: boolean): void
  /** The provider being edited; absent to add one. */
  existing?: SandboxProviderConfig
  /** Every configured provider id, the edited one included. */
  existingIds: readonly string[]
  storedSecretIds: readonly string[]
  busy: boolean
  save(draft: ProviderDraft, editingId?: string): Promise<RemoteSandboxesWriteResult>
}

/**
 * Mounted only while open, so a reopen starts from the provider as it is now
 * rather than a stale form.
 */
export function RemoteSandboxProviderEditor(props: RemoteSandboxProviderEditorProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {props.open ? <EditorForm {...props} /> : null}
    </Dialog>
  )
}

function EditorForm({
  onOpenChange,
  existing,
  existingIds,
  storedSecretIds,
  busy,
  save,
}: RemoteSandboxProviderEditorProps) {
  const t = useTranslations("settings.remoteSandboxes.editor")
  const tKind = useTranslations("settings.remoteSandboxes.providers.kind")
  const [draft, setDraft] = useState<ProviderDraft>(() =>
    existing ? draftFromProvider(existing) : emptyProviderDraft()
  )
  // Problems are shown once a field has been touched or a save was tried, so
  // a fresh form does not open in red.
  const [touched, setTouched] = useState<ReadonlySet<ProviderDraftField>>(new Set())
  const [attempted, setAttempted] = useState(false)
  const [saveProblem, setSaveProblem] = useState<RemoteSandboxesProblem>()

  const context = {
    existingIds,
    ...(existing ? { editingId: existing.id } : {}),
    storedSecretIds,
  }
  const problems = validateProviderDraft(draft, context)
  const problemFor = (field: ProviderDraftField): ProviderDraftProblem | undefined =>
    attempted || touched.has(field)
      ? problems.find((problem) => problem.field === field)
      : undefined

  /** `field` is the text field typed into; a choice from a list touches none. */
  const edit = (field: ProviderDraftField | undefined, patch: Partial<ProviderDraft>) => {
    setDraft((prev) => ({ ...prev, ...patch }))
    if (field) setTouched((prev) => new Set(prev).add(field))
    setSaveProblem(undefined)
  }
  const editE2b = (field: ProviderDraftField, patch: Partial<ProviderDraft["e2b"]>) =>
    edit(field, { e2b: { ...draft.e2b, ...patch } })
  const editK8s = (
    field: ProviderDraftField | undefined,
    patch: Partial<ProviderDraft["kubernetes"]>
  ) => edit(field, { kubernetes: { ...draft.kubernetes, ...patch } })

  const onSave = async () => {
    setAttempted(true)
    if (problems.length > 0) return
    const result = await save(draft, existing?.id)
    if (result.ok) onOpenChange(false)
    else setSaveProblem(result.problem)
  }

  const kept = draft.existingCredential
  const credentialHint =
    kept === undefined
      ? undefined
      : "secretId" in kept
        ? storedSecretIds.includes(kept.secretId)
          ? t("credential.keep")
          : undefined
        : t("credential.keepSource", { source: "env" in kept ? kept.env : kept.file })
  const needsCredential = draftNeedsCredential(draft)
  const fieldId = (name: string) => `remote-sandbox-${name}`

  return (
    <DialogContent
      className="max-h-[90vh] overflow-y-auto sm:max-w-xl"
      data-testid="remote-sandbox-editor"
    >
      <DialogHeader>
        <DialogTitle>
          {existing ? t("editTitle", { label: existing.label ?? existing.id }) : t("createTitle")}
        </DialogTitle>
        <DialogDescription>{t("description")}</DialogDescription>
      </DialogHeader>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field id={fieldId("kind")} label={t("kind")}>
          <Select
            value={draft.kind}
            disabled={existing !== undefined}
            onValueChange={(value) => {
              const kind = value as SandboxProviderKind
              const fresh = emptyProviderDraft(kind)
              // Keep what both kinds share; the settings are per kind.
              edit(undefined, {
                kind,
                e2b: fresh.e2b,
                kubernetes: fresh.kubernetes,
                credential: "",
              })
            }}
          >
            <SelectTrigger id={fieldId("kind")} aria-label={t("kind")} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="e2b">{tKind("e2b")}</SelectItem>
              <SelectItem value="kubernetes">{tKind("kubernetes")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        <Field id={fieldId("id")} label={t("id")} hint={t("idHint")} problem={problemFor("id")}>
          <Input
            id={fieldId("id")}
            value={draft.id}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => edit("id", { id: event.target.value })}
          />
        </Field>

        <Field
          id={fieldId("label")}
          label={t("label")}
          problem={problemFor("label")}
          className="sm:col-span-2"
        >
          <Input
            id={fieldId("label")}
            value={draft.label}
            placeholder={t("labelPlaceholder")}
            onChange={(event) => edit("label", { label: event.target.value })}
          />
        </Field>

        {draft.kind === "kubernetes" ? (
          <Field
            id={fieldId("connection")}
            label={t("kubernetes.connection")}
            hint={
              draft.kubernetes.connection === "inCluster"
                ? t("kubernetes.connectionInClusterHint")
                : undefined
            }
            className="sm:col-span-2"
          >
            <Select
              value={draft.kubernetes.connection}
              onValueChange={(value) =>
                editK8s(undefined, {
                  connection: value === "inCluster" ? "inCluster" : "kubeconfig",
                })
              }
            >
              <SelectTrigger
                id={fieldId("connection")}
                aria-label={t("kubernetes.connection")}
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="kubeconfig">{t("kubernetes.connectionKubeconfig")}</SelectItem>
                <SelectItem value="inCluster">{t("kubernetes.connectionInCluster")}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        ) : null}

        {needsCredential ? (
          <Field
            id={fieldId("credential")}
            label={draft.kind === "e2b" ? t("credential.e2b") : t("credential.kubeconfig")}
            hint={credentialHint ?? t("credential.required")}
            problem={problemFor("credential")}
            className="sm:col-span-2"
          >
            {draft.kind === "e2b" ? (
              <Input
                id={fieldId("credential")}
                type="password"
                autoComplete="off"
                value={draft.credential}
                onChange={(event) => edit("credential", { credential: event.target.value })}
              />
            ) : (
              <Textarea
                id={fieldId("credential")}
                rows={4}
                spellCheck={false}
                className="font-mono text-xs"
                placeholder={t("credential.kubeconfigPlaceholder")}
                value={draft.credential}
                onChange={(event) => edit("credential", { credential: event.target.value })}
              />
            )}
          </Field>
        ) : null}

        {draft.kind === "e2b" ? (
          <>
            <Field
              id={fieldId("api-url")}
              label={t("e2b.apiUrl")}
              problem={problemFor("e2b.apiUrl")}
            >
              <Input
                id={fieldId("api-url")}
                value={draft.e2b.apiUrl}
                spellCheck={false}
                onChange={(event) => editE2b("e2b.apiUrl", { apiUrl: event.target.value })}
              />
            </Field>
            <Field
              id={fieldId("domain")}
              label={t("e2b.domain")}
              problem={problemFor("e2b.domain")}
            >
              <Input
                id={fieldId("domain")}
                value={draft.e2b.domain}
                spellCheck={false}
                onChange={(event) => editE2b("e2b.domain", { domain: event.target.value })}
              />
            </Field>
            <Field
              id={fieldId("template-prefix")}
              label={t("e2b.templatePrefix")}
              problem={problemFor("e2b.templatePrefix")}
            >
              <Input
                id={fieldId("template-prefix")}
                value={draft.e2b.templatePrefix}
                spellCheck={false}
                onChange={(event) =>
                  editE2b("e2b.templatePrefix", { templatePrefix: event.target.value })
                }
              />
            </Field>
            <Field
              id={fieldId("template-timeout")}
              label={t("e2b.templateBuildTimeout")}
              problem={problemFor("e2b.templateBuildTimeoutSecs")}
            >
              <Input
                id={fieldId("template-timeout")}
                inputMode="numeric"
                value={draft.e2b.templateBuildTimeoutSecs}
                onChange={(event) =>
                  editE2b("e2b.templateBuildTimeoutSecs", {
                    templateBuildTimeoutSecs: event.target.value,
                  })
                }
              />
            </Field>
            <Field
              id={fieldId("delegated")}
              label={t("e2b.delegatedRegistries")}
              hint={t("e2b.delegatedRegistriesHint")}
              problem={problemFor("e2b.delegatedRegistries")}
              className="sm:col-span-2"
            >
              <Textarea
                id={fieldId("delegated")}
                rows={2}
                spellCheck={false}
                value={draft.e2b.delegatedRegistries}
                onChange={(event) =>
                  editE2b("e2b.delegatedRegistries", { delegatedRegistries: event.target.value })
                }
              />
            </Field>
          </>
        ) : (
          <>
            {draft.kubernetes.connection === "kubeconfig" ? (
              <Field id={fieldId("context")} label={t("kubernetes.context")}>
                <Input
                  id={fieldId("context")}
                  value={draft.kubernetes.context}
                  placeholder={t("kubernetes.contextPlaceholder")}
                  onChange={(event) => editK8s(undefined, { context: event.target.value })}
                />
              </Field>
            ) : null}
            <Field
              id={fieldId("namespace")}
              label={t("kubernetes.namespace")}
              problem={problemFor("kubernetes.namespace")}
            >
              <Input
                id={fieldId("namespace")}
                value={draft.kubernetes.namespace}
                spellCheck={false}
                onChange={(event) =>
                  editK8s("kubernetes.namespace", { namespace: event.target.value })
                }
              />
            </Field>
            <Field
              id={fieldId("runtime-container")}
              label={t("kubernetes.runtimeClasses")}
              hint={t("kubernetes.runtimeClassesHint")}
              problem={problemFor("kubernetes.runtimeClasses")}
              className="sm:col-span-2"
            >
              <div className="grid gap-2 sm:grid-cols-3">
                {(
                  [
                    ["runtimeClassContainer", "container"],
                    ["runtimeClassGvisor", "gvisor"],
                    ["runtimeClassVm", "vm"],
                  ] as const
                ).map(([key, tier]) => (
                  <Input
                    key={key}
                    id={tier === "container" ? fieldId("runtime-container") : undefined}
                    aria-label={`${t("kubernetes.runtimeClasses")}: ${tier}`}
                    placeholder={tier}
                    value={draft.kubernetes[key]}
                    spellCheck={false}
                    onChange={(event) =>
                      editK8s("kubernetes.runtimeClasses", { [key]: event.target.value })
                    }
                  />
                ))}
              </div>
            </Field>
            <Field id={fieldId("egress")} label={t("kubernetes.egress")} className="sm:col-span-2">
              <Select
                value={draft.kubernetes.egress}
                onValueChange={(value) =>
                  editK8s(undefined, { egress: value as KubernetesEgressMode })
                }
              >
                <SelectTrigger
                  id={fieldId("egress")}
                  aria-label={t("kubernetes.egress")}
                  className="w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EGRESS_MODES.map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {t(`kubernetes.${EGRESS_LABEL_KEYS[mode]}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p
                className={
                  draft.kubernetes.egress === "cilium"
                    ? "text-xs text-muted-foreground"
                    : "text-xs text-amber-700 dark:text-amber-400"
                }
                data-dormant={draft.kubernetes.egress === "cilium" ? undefined : "egress-allowlist"}
                data-testid="remote-sandbox-egress-hint"
              >
                {t(`kubernetes.egressHint.${draft.kubernetes.egress}`)}
              </p>
            </Field>
            <Field
              id={fieldId("node-selector")}
              label={t("kubernetes.nodeSelector")}
              problem={problemFor("kubernetes.nodeSelector")}
            >
              <Textarea
                id={fieldId("node-selector")}
                rows={2}
                spellCheck={false}
                placeholder={t("kubernetes.nodeSelectorPlaceholder")}
                value={draft.kubernetes.nodeSelector}
                onChange={(event) =>
                  editK8s("kubernetes.nodeSelector", { nodeSelector: event.target.value })
                }
              />
            </Field>
            <Field
              id={fieldId("service-account")}
              label={t("kubernetes.serviceAccount")}
              problem={problemFor("kubernetes.serviceAccountName")}
            >
              <Input
                id={fieldId("service-account")}
                value={draft.kubernetes.serviceAccountName}
                spellCheck={false}
                onChange={(event) =>
                  editK8s("kubernetes.serviceAccountName", {
                    serviceAccountName: event.target.value,
                  })
                }
              />
            </Field>
            <Field
              id={fieldId("ready-timeout")}
              label={t("kubernetes.podReadyTimeout")}
              problem={problemFor("kubernetes.podReadyTimeoutSecs")}
            >
              <Input
                id={fieldId("ready-timeout")}
                inputMode="numeric"
                value={draft.kubernetes.podReadyTimeoutSecs}
                onChange={(event) =>
                  editK8s("kubernetes.podReadyTimeoutSecs", {
                    podReadyTimeoutSecs: event.target.value,
                  })
                }
              />
            </Field>
          </>
        )}
      </div>

      <fieldset className="grid gap-3 border-t pt-3 sm:grid-cols-3">
        <legend className="sr-only">{t("limits")}</legend>
        <p className="text-sm font-medium sm:col-span-3">{t("limits")}</p>
        <Field
          id={fieldId("max-concurrent")}
          label={t("maxConcurrent")}
          problem={problemFor("maxConcurrent")}
        >
          <Input
            id={fieldId("max-concurrent")}
            inputMode="numeric"
            value={draft.maxConcurrent}
            onChange={(event) => edit("maxConcurrent", { maxConcurrent: event.target.value })}
          />
        </Field>
        <Field
          id={fieldId("max-lifetime")}
          label={t("maxLifetime")}
          hint={t("maxLifetimeHint")}
          problem={problemFor("maxLifetimeMinutes")}
        >
          <Input
            id={fieldId("max-lifetime")}
            inputMode="numeric"
            value={draft.maxLifetimeMinutes}
            onChange={(event) =>
              edit("maxLifetimeMinutes", { maxLifetimeMinutes: event.target.value })
            }
          />
        </Field>
        <Field
          id={fieldId("idle-timeout")}
          label={t("idleTimeout")}
          hint={t("idleTimeoutHint")}
          problem={problemFor("idleTimeoutMinutes")}
        >
          <Input
            id={fieldId("idle-timeout")}
            inputMode="numeric"
            value={draft.idleTimeoutMinutes}
            onChange={(event) =>
              edit("idleTimeoutMinutes", { idleTimeoutMinutes: event.target.value })
            }
          />
        </Field>
      </fieldset>

      {saveProblem ? <RemoteSandboxesProblemText problem={saveProblem} /> : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          {t("cancel")}
        </Button>
        <Button
          type="button"
          disabled={busy || (attempted && problems.length > 0)}
          onClick={() => void onSave()}
        >
          {t("save")}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}

function Field({
  id,
  label,
  hint,
  problem,
  className,
  children,
}: {
  id: string
  label: string
  hint?: string
  problem?: ProviderDraftProblem
  className?: string
  children: React.ReactNode
}) {
  const t = useTranslations("settings.remoteSandboxes.editor.problem")
  return (
    <div className={cn("min-w-0 space-y-1", className)}>
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      {children}
      {problem ? (
        <p role="alert" className="text-xs text-destructive">
          {t(problem.code, problem.values ?? {})}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  )
}
