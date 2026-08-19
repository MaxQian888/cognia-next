"use client"

/**
 * Register a deployment target and queue its first deploy, one section at a
 * time.
 *
 * The previous version put every field on one sheet and reported failures as a
 * raw `ZodError` string under the submit button, which named paths like
 * `spec.objectStore.bucket` without ever pointing at the input. Here the model
 * (`lib/server-ops/deployment-form`) routes each issue to the step that owns
 * it, so the step rail carries the error count and every field shows its own
 * message.
 *
 * The Advanced tab keeps the raw editor: a target is a versioned document, and
 * pasting one from a repository is a legitimate — often the primary — way to
 * fill this in.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { CheckIcon, TriangleAlertIcon } from "lucide-react"

import { StructuredConfigEditor } from "@/components/common/structured-config-editor"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { ProviderCapabilities } from "@/lib/server-ops/client"
import {
  buildDeploymentTarget,
  DEPLOYMENT_STEPS,
  deploymentFormFromTarget,
  INITIAL_DEPLOYMENT_FORM,
  supportedOptions,
  validateDeploymentForm,
  type DeploymentFormState,
  type DeploymentFormTextKey,
  type DeploymentStep,
} from "@/lib/server-ops/deployment-form"
import { parseDeploymentTarget, type DeploymentTarget } from "@/lib/server-ops/deployment-target"
import { cn } from "@/lib/utils"
import { DeploymentPreview } from "./deployment-preview"

type TextFieldSpec = readonly [DeploymentFormTextKey, string, string?]

function TextField({
  fieldKey,
  labelKey,
  placeholderKey,
  state,
  issue,
  onChange,
  mono,
}: {
  fieldKey: DeploymentFormTextKey
  labelKey: string
  placeholderKey?: string
  state: DeploymentFormState
  issue?: string
  onChange: (key: DeploymentFormTextKey, value: string) => void
  mono?: boolean
}) {
  const t = useTranslations("servers")
  const id = `deployment-${fieldKey}`
  return (
    <Field data-invalid={issue ? true : undefined}>
      <FieldLabel htmlFor={id}>{t(labelKey as "wizard.targetId")}</FieldLabel>
      <Input
        id={id}
        value={state[fieldKey]}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={Boolean(issue)}
        className={cn(mono && "font-mono text-xs")}
        placeholder={placeholderKey ? t(placeholderKey as "wizard.placeholders.label") : undefined}
        onChange={(event) => onChange(fieldKey, event.target.value)}
      />
      {issue && <FieldDescription className="text-destructive">{issue}</FieldDescription>}
    </Field>
  )
}

function ChoiceField<T extends string>({
  id,
  labelKey,
  value,
  options,
  onChange,
}: {
  id: string
  labelKey: string
  value: T
  options: readonly T[]
  onChange: (value: T) => void
}) {
  const t = useTranslations("servers")
  return (
    <Field>
      <FieldLabel htmlFor={id}>{t(labelKey as "wizard.topology")}</FieldLabel>
      <Select value={value} onValueChange={(next) => onChange(next as T)}>
        <SelectTrigger id={id} className="w-full" aria-label={t(labelKey as "wizard.topology")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {t(`options.${option}` as "options.compose")}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}

export function DeploymentWizard({
  open,
  onOpenChange,
  capabilities,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  capabilities: ProviderCapabilities | null
  onSubmit: (target: DeploymentTarget) => Promise<void>
}) {
  const t = useTranslations("servers")
  const [state, setState] = useState<DeploymentFormState>(INITIAL_DEPLOYMENT_FORM)
  const [step, setStep] = useState<DeploymentStep>("target")
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  /** Issues stay hidden until the operator leaves a step or tries to submit. */
  const [visited, setVisited] = useState<ReadonlySet<DeploymentStep>>(new Set(["target"]))

  const validation = useMemo(() => validateDeploymentForm(state), [state])
  const issuesByPath = useMemo(
    () => new Map(validation.issues.map((issue) => [issue.path, issue.message])),
    [validation.issues]
  )
  const issueCountByStep = useMemo(() => {
    const counts = new Map<DeploymentStep, number>()
    for (const issue of validation.issues) {
      counts.set(issue.step, (counts.get(issue.step) ?? 0) + 1)
    }
    return counts
  }, [validation.issues])

  const update = (key: DeploymentFormTextKey, value: string) =>
    setState((current) => ({ ...current, [key]: value }))
  const set = <K extends keyof DeploymentFormState>(key: K, value: DeploymentFormState[K]) =>
    setState((current) => ({ ...current, [key]: value }))

  const goTo = (next: DeploymentStep) => {
    setVisited((current) => new Set([...current, step, next]))
    setStep(next)
  }

  const stepIndex = DEPLOYMENT_STEPS.indexOf(step)
  const issueFor = (path: string) => (visited.has(step) ? issuesByPath.get(path) : undefined)

  const submit = async () => {
    setVisited(new Set(DEPLOYMENT_STEPS))
    if (!validation.target) {
      setStep(validation.issues[0]?.step ?? "review")
      return
    }
    setSubmitting(true)
    setSubmitError(null)
    try {
      await onSubmit(validation.target)
      setState(INITIAL_DEPLOYMENT_FORM)
      setStep("target")
      setVisited(new Set(["target"]))
      onOpenChange(false)
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : t("wizard.invalid"))
    } finally {
      setSubmitting(false)
    }
  }

  const topologyOptions = supportedOptions(
    capabilities?.topologies,
    ["compose", "kubernetes"] as const,
    state.topology
  )
  const snapshotOptions = supportedOptions(
    capabilities?.snapshotProviders,
    ["kubernetes-csi", "external-command", "none"] as const,
    state.snapshotProvider
  )
  const secretOptions = supportedOptions(
    capabilities?.secretProviders,
    ["file", "kubernetes", "vault", "aws-secrets-manager"] as const,
    state.secretProvider
  )
  const tlsOptions = supportedOptions(
    capabilities?.tlsProviders,
    ["ingress", "existing", "acme-http01", "acme-dns01"] as const,
    state.tlsProvider
  )

  const targetFields: readonly TextFieldSpec[] = [
    ["id", "wizard.targetId", "wizard.placeholders.targetId"],
    ["label", "wizard.label", "wizard.placeholders.label"],
    ["publicUrl", "wizard.publicUrl", "wizard.placeholders.publicUrl"],
    ["controllerUrl", "wizard.controllerUrl", "wizard.placeholders.controllerUrl"],
    [
      "controllerCredentialRef",
      "wizard.controllerCredentialRef",
      "wizard.placeholders.controllerCredentialRef",
    ],
  ]
  const identityFields: readonly TextFieldSpec[] = [
    ["oidcIssuer", "wizard.oidcIssuer", "wizard.placeholders.oidcIssuer"],
    ["oidcAudience", "wizard.oidcAudience", "wizard.placeholders.oidcAudience"],
    ["tenantClaim", "wizard.tenantClaim", "wizard.placeholders.tenantClaim"],
    ["scopeRead", "wizard.scopeRead"],
    ["scopeOperate", "wizard.scopeOperate"],
    ["scopeAdmin", "wizard.scopeAdmin"],
  ]
  const objectStoreFields: readonly TextFieldSpec[] = [
    [
      "objectStoreEndpoint",
      "wizard.objectStoreEndpoint",
      "wizard.placeholders.objectStoreEndpoint",
    ],
    ["objectStoreRegion", "wizard.objectStoreRegion", "wizard.placeholders.objectStoreRegion"],
    ["objectStoreBucket", "wizard.objectStoreBucket", "wizard.placeholders.objectStoreBucket"],
    [
      "objectStoreCredentialRef",
      "wizard.objectStoreCredentialRef",
      "wizard.placeholders.objectStoreCredentialRef",
    ],
  ]

  const issuePathFor: Record<DeploymentFormTextKey, string> = {
    id: "metadata.id",
    label: "metadata.label",
    publicUrl: "spec.publicUrl",
    controllerUrl: "spec.controller.url",
    controllerCredentialRef: "spec.controller.credentialRef",
    oidcIssuer: "spec.identity.issuer",
    oidcAudience: "spec.identity.audience",
    tenantClaim: "spec.identity.tenantClaim",
    scopeRead: "spec.identity.scopes.read",
    scopeOperate: "spec.identity.scopes.operate",
    scopeAdmin: "spec.identity.scopes.admin",
    objectStoreEndpoint: "spec.objectStore.endpoint",
    objectStoreRegion: "spec.objectStore.region",
    objectStoreBucket: "spec.objectStore.bucket",
    objectStoreCredentialRef: "spec.objectStore.credentialRef",
    snapshotRef: "spec.snapshots",
    secretRootRef: "spec.secrets.rootRef",
    tlsRef: "spec.tls",
    serverImage: "spec.images.server",
    runnerImage: "spec.images.runner",
    workspaceRuntimeImage: "spec.images.workspaceRuntime",
    namespace: "spec.kubernetes.namespace",
    ingressClassName: "spec.kubernetes.ingressClassName",
    storageClassName: "spec.kubernetes.storageClassName",
    runtimeClassName: "spec.kubernetes.runtimeClassName",
    projectName: "spec.compose.projectName",
    deploymentRoot: "spec.compose.deploymentRoot",
  }

  const renderFields = (fields: readonly TextFieldSpec[], mono = false) =>
    fields.map(([key, labelKey, placeholderKey]) => (
      <TextField
        key={key}
        fieldKey={key}
        labelKey={labelKey}
        placeholderKey={placeholderKey}
        state={state}
        issue={issueFor(issuePathFor[key])}
        onChange={update}
        mono={mono}
      />
    ))

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-3xl">
        <SheetHeader className="border-b">
          <SheetTitle>{t("wizard.title")}</SheetTitle>
          <SheetDescription>{t("wizard.description")}</SheetDescription>
        </SheetHeader>

        <Tabs defaultValue="guided" className="flex min-h-0 flex-1 flex-col gap-0">
          <div className="border-b px-4">
            <TabsList variant="line">
              <TabsTrigger value="guided">{t("wizard.guided")}</TabsTrigger>
              <TabsTrigger value="custom">{t("wizard.custom")}</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="guided" className="flex min-h-0 flex-1 flex-col gap-0">
            <nav
              aria-label={t("wizard.stepsLabel")}
              className="flex gap-1 overflow-x-auto border-b p-2"
            >
              {DEPLOYMENT_STEPS.map((candidate, index) => {
                const count = issueCountByStep.get(candidate) ?? 0
                const showIssues = count > 0 && visited.has(candidate)
                return (
                  <Button
                    key={candidate}
                    type="button"
                    variant={candidate === step ? "secondary" : "ghost"}
                    size="sm"
                    className="shrink-0 gap-1.5"
                    onClick={() => goTo(candidate)}
                    data-testid={`wizard-step-${candidate}`}
                  >
                    <span className="text-xs tabular-nums text-muted-foreground">{index + 1}</span>
                    {t(`wizard.steps.${candidate}` as "wizard.steps.target")}
                    {showIssues ? (
                      <Badge variant="destructive" className="h-4 min-w-4 px-1 text-[10px]">
                        {count}
                      </Badge>
                    ) : (
                      visited.has(candidate) &&
                      candidate !== "review" && (
                        <CheckIcon
                          className="size-3 text-emerald-600 dark:text-emerald-400"
                          aria-hidden="true"
                        />
                      )
                    )}
                  </Button>
                )
              })}
            </nav>

            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-4 p-4">
                {step === "target" && (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <ChoiceField
                      id="deployment-topology"
                      labelKey="wizard.topology"
                      value={state.topology}
                      options={topologyOptions}
                      onChange={(value) => set("topology", value)}
                    />
                    {renderFields(targetFields)}
                  </div>
                )}

                {step === "identity" && (
                  <>
                    <p className="text-sm text-muted-foreground">{t("wizard.identityHelp")}</p>
                    <div className="grid gap-4 sm:grid-cols-2">{renderFields(identityFields)}</div>
                  </>
                )}

                {step === "storage" && (
                  <div className="space-y-6">
                    <section className="grid gap-4 sm:grid-cols-2">
                      {renderFields(objectStoreFields)}
                      <Field orientation="horizontal" className="sm:col-span-2">
                        <div className="flex-1">
                          <FieldLabel htmlFor="deployment-path-style">
                            {t("wizard.objectStorePathStyle")}
                          </FieldLabel>
                          <FieldDescription>
                            {t("wizard.objectStorePathStyleHelp")}
                          </FieldDescription>
                        </div>
                        <Switch
                          id="deployment-path-style"
                          checked={state.objectStorePathStyle}
                          onCheckedChange={(checked) => set("objectStorePathStyle", checked)}
                        />
                      </Field>
                    </section>
                    <section className="grid gap-4 border-t pt-4 sm:grid-cols-2">
                      <ChoiceField
                        id="deployment-snapshot-provider"
                        labelKey="wizard.snapshotProvider"
                        value={state.snapshotProvider}
                        options={snapshotOptions}
                        onChange={(value) => set("snapshotProvider", value)}
                      />
                      {/* `none` takes no reference at all — the schema's
                          discriminated union has no field to put one in. */}
                      {state.snapshotProvider !== "none" &&
                        renderFields([
                          ["snapshotRef", "wizard.snapshotRef", "wizard.placeholders.snapshotRef"],
                        ])}
                      <ChoiceField
                        id="deployment-secret-provider"
                        labelKey="wizard.secretProvider"
                        value={state.secretProvider}
                        options={secretOptions}
                        onChange={(value) => set("secretProvider", value)}
                      />
                      {renderFields([
                        [
                          "secretRootRef",
                          "wizard.secretRootRef",
                          "wizard.placeholders.secretRootRef",
                        ],
                      ])}
                      <ChoiceField
                        id="deployment-tls-provider"
                        labelKey="wizard.tlsProvider"
                        value={state.tlsProvider}
                        options={tlsOptions}
                        onChange={(value) => set("tlsProvider", value)}
                      />
                      {/* HTTP-01 proves the domain over the deployment's own
                          ingress, so it references nothing. */}
                      {state.tlsProvider !== "acme-http01" &&
                        renderFields([["tlsRef", "wizard.tlsRef", "wizard.placeholders.tlsRef"]])}
                    </section>
                  </div>
                )}

                {step === "platform" && (
                  <div className="grid gap-4 sm:grid-cols-2">
                    {state.topology === "kubernetes"
                      ? renderFields([
                          ["namespace", "wizard.namespace"],
                          ["ingressClassName", "wizard.ingressClass"],
                          ["storageClassName", "wizard.storageClass"],
                          ["runtimeClassName", "wizard.runtimeClass"],
                        ])
                      : renderFields([
                          ["projectName", "wizard.projectName"],
                          ["deploymentRoot", "wizard.deploymentRoot"],
                        ])}
                  </div>
                )}

                {step === "images" && (
                  <>
                    <p className="text-sm text-muted-foreground">{t("wizard.imagesHelp")}</p>
                    <div className="grid gap-4">
                      {renderFields(
                        [
                          ["serverImage", "wizard.serverImage", "wizard.placeholders.serverImage"],
                          ["runnerImage", "wizard.runnerImage", "wizard.placeholders.runnerImage"],
                          [
                            "workspaceRuntimeImage",
                            "wizard.workspaceRuntimeImage",
                            "wizard.placeholders.workspaceRuntimeImage",
                          ],
                        ],
                        true
                      )}
                    </div>
                  </>
                )}

                {step === "review" && (
                  <div className="space-y-4">
                    {validation.issues.length > 0 ? (
                      <Alert variant="destructive">
                        <TriangleAlertIcon className="size-4" aria-hidden="true" />
                        <AlertTitle>{t("wizard.invalid")}</AlertTitle>
                        <AlertDescription>
                          <ul className="space-y-1">
                            {validation.issues.map((issue) => (
                              <li key={`${issue.path}:${issue.message}`}>
                                <Button
                                  type="button"
                                  variant="link"
                                  className="h-auto p-0 text-left text-destructive underline"
                                  onClick={() => goTo(issue.step)}
                                >
                                  <span className="font-mono text-xs">{issue.path}</span>
                                </Button>
                                <span className="ml-2 text-xs">{issue.message}</span>
                              </li>
                            ))}
                          </ul>
                        </AlertDescription>
                      </Alert>
                    ) : (
                      <>
                        {validation.certificationIssues.length > 0 && (
                          <Alert>
                            <TriangleAlertIcon className="size-4" aria-hidden="true" />
                            <AlertTitle>{t("wizard.certificationTitle")}</AlertTitle>
                            <AlertDescription>
                              <p>{t("wizard.certificationHelp")}</p>
                              <ul className="mt-1 list-disc space-y-1 pl-4 text-xs">
                                {validation.certificationIssues.map((issue) => (
                                  <li key={issue}>{issue}</li>
                                ))}
                              </ul>
                            </AlertDescription>
                          </Alert>
                        )}
                        {validation.target && (
                          <section className="space-y-3">
                            <Label className="text-sm">{t("preview.title")}</Label>
                            <DeploymentPreview target={validation.target} />
                          </section>
                        )}
                      </>
                    )}

                    <p className="border-l-2 border-primary bg-muted/50 p-3 text-xs text-muted-foreground">
                      {t("wizard.credentialsNotice")}
                    </p>
                    {capabilities?.requiresProviderCredentials && (
                      <p className="border-l-2 border-amber-500 p-3 text-xs text-muted-foreground">
                        {t("wizard.providerCredentialsRequired")}
                      </p>
                    )}
                    {submitError && (
                      <Alert variant="destructive">
                        <AlertTitle>{t("errors.operation")}</AlertTitle>
                        <AlertDescription>{submitError}</AlertDescription>
                      </Alert>
                    )}
                  </div>
                )}
              </div>
            </ScrollArea>

            <div className="flex items-center justify-between gap-2 border-t p-4">
              <Button
                type="button"
                variant="outline"
                disabled={stepIndex === 0}
                onClick={() => goTo(DEPLOYMENT_STEPS[Math.max(stepIndex - 1, 0)])}
              >
                {t("wizard.back")}
              </Button>
              <div className="flex items-center gap-2">
                <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                  {t("wizard.cancel")}
                </Button>
                {step === "review" ? (
                  <Button type="button" disabled={submitting} onClick={() => void submit()}>
                    {submitting && <Spinner />}
                    {submitting ? t("wizard.validating") : t("wizard.validate")}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    onClick={() =>
                      goTo(DEPLOYMENT_STEPS[Math.min(stepIndex + 1, DEPLOYMENT_STEPS.length - 1)])
                    }
                  >
                    {t("wizard.next")}
                  </Button>
                )}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="custom" className="min-h-0 flex-1 overflow-y-auto p-4">
            <StructuredConfigEditor
              value={buildDeploymentTarget(state)}
              validate={parseDeploymentTarget}
              onApply={(target) => setState(deploymentFormFromTarget(target))}
              filename={`${state.id || "deployment-target"}.deployment-target`}
              disabled={submitting}
            />
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  )
}
