"use client"

import { useEffect, useId, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Loader2Icon } from "lucide-react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { saveOpencodeZenKey } from "@/lib/subscription/opencode/discovery"
import {
  saveCustomSubscriptionProvider,
  type SubscriptionProviderDefinition,
} from "@/lib/subscription/core/provider-registry"

import type { ProviderModelDiscoveryEntry } from "@cognia/provider-types/provider"
import {
  discoverSubscriptionModels,
  getSubscriptionModel,
  SubscriptionModelDiscoveryError,
} from "@/lib/subscription/core/model-discovery"

import { uuidv7 } from "@/lib/subscription/core/uuidv7"
import { persistProviderAccount } from "@/lib/subscription/core/account-lifecycle"
import { NewAccountPresetSelector } from "../account-preset-selector"
import { renameAccount, replaceAccountCredential } from "@/lib/subscription/core/transport"
import type { Account, AccountDetail, AccountSummary } from "@/types/subscription"

export interface ManagedKeyAccountDialogProps {
  definition?: SubscriptionProviderDefinition
  open: boolean
  onOpenChange: (next: boolean) => void
  onAdded?: (account: Account) => void
  onUpdated?: (account: AccountDetail) => void
  existingAccount?: AccountSummary
}

export function ManagedKeyAccountDialog({
  definition,
  open,
  onOpenChange,
  onAdded,
  onUpdated,
  existingAccount,
}: ManagedKeyAccountDialogProps) {
  const t = useTranslations("subscription.managedKey")
  const tCommandcode = useTranslations("subscription.commandcode")
  const formId = useId()
  const [name, setName] = useState("")
  const [protocol, setProtocol] = useState<"openai" | "anthropic">("openai")
  const [models, setModels] = useState("")
  const [createdDefinition, setCreatedDefinition] = useState<SubscriptionProviderDefinition | null>(
    null
  )
  const [plan, setPlan] = useState(existingAccount?.plan ?? definition?.plans?.[0]?.id ?? "")
  const provider = definition ?? createdDefinition
  const selectedPlan = definition?.plans?.find((entry) => entry.id === plan)
  const tAccountList = useTranslations("subscription.common.accountList")
  const [presetId, setPresetId] = useState<string | null>(null)

  const [accessToken, setAccessToken] = useState("")
  const [baseUrl, setBaseUrl] = useState("")
  const [label, setLabel] = useState(existingAccount?.label ?? "")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [discoveredModels, setDiscoveredModels] = useState<Array<
    ProviderModelDiscoveryEntry & { knownFields?: string[] }
  > | null>(null)
  const [selectedModel, setSelectedModel] = useState("")
  const [modelStatus, setModelStatus] = useState<"declared" | "live">("declared")
  const [modelBusy, setModelBusy] = useState(false)
  const [modelError, setModelError] = useState<string | null>(null)
  const modelRequest = useRef<AbortController | null>(null)
  const modelInputs = JSON.stringify([
    open,
    accessToken,
    baseUrl,
    presetId,
    plan,
    existingAccount?.id,
  ])
  const [previousModelInputs, setPreviousModelInputs] = useState(modelInputs)
  const [previousModelProvider, setPreviousModelProvider] = useState(provider)
  if (previousModelInputs !== modelInputs || previousModelProvider !== provider) {
    setPreviousModelInputs(modelInputs)
    setPreviousModelProvider(provider)
    setDiscoveredModels(null)
    setSelectedModel("")
    setModelStatus("declared")
    setModelError(null)
    setModelBusy(false)
  }
  useEffect(
    () => () => {
      modelRequest.current?.abort()
    },
    [modelInputs, provider]
  )
  const modelOptions: Array<ProviderModelDiscoveryEntry & { knownFields?: string[] }> =
    discoveredModels ?? provider?.modelMetadata ?? provider?.models?.map((id) => ({ id })) ?? []
  const modelInfo = modelOptions.find((model) => model.id === selectedModel) ?? modelOptions[0]
  const modelFieldKnown = (field: string) =>
    !modelInfo?.knownFields || modelInfo.knownFields.includes(field)
  const loadModels = async (model?: string) => {
    if (!provider || !accessToken.trim()) return
    modelRequest.current?.abort()
    const controller = new AbortController()
    modelRequest.current = controller
    setModelBusy(true)
    setModelError(null)
    const input = {
      definition: provider,
      accountId: existingAccount?.id,
      preview: { apiKey: accessToken, baseUrl: baseUrl.trim() || selectedPlan?.baseUrl, presetId },
      signal: controller.signal,
    }
    try {
      if (model) {
        const result = await getSubscriptionModel({ ...input, model })
        if (controller.signal.aborted) return
        if (!result.model) {
          setModelError(t("modelNotFound"))
          return
        }
        const detail = result.model
        setDiscoveredModels((current) =>
          (current ?? modelOptions).map((entry) => (entry.id === model ? detail : entry))
        )
      } else {
        const result = await discoverSubscriptionModels(input)
        if (controller.signal.aborted) return
        setDiscoveredModels(result.models)
        setModelStatus(result.freshness === "fresh" ? "live" : "declared")
      }
    } catch (error) {
      if (controller.signal.aborted) return
      setModelError(
        t(
          error instanceof SubscriptionModelDiscoveryError
            ? error.code === "invalidBaseUrl"
              ? "invalidBaseUrl"
              : error.code === "unavailable"
                ? "unavailable"
                : "modelCredentialsRequired"
            : "modelLoadFailed"
        )
      )
    } finally {
      if (!controller.signal.aborted) setModelBusy(false)
    }
  }

  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) {
      setName("")
      setProtocol("openai")
      setModels("")
      setCreatedDefinition(null)
      setPlan(existingAccount?.plan ?? definition?.plans?.[0]?.id ?? "")
      setPresetId(null)
      setAccessToken("")
      setBaseUrl("")
      setLabel(existingAccount?.label ?? "")
      setError(null)
      setBusy(false)
    }
  }

  /**
   * `replaceAccountCredential` carries the credential and nothing else, so the
   * Label field this dialog still renders has to be written through the rename
   * command. Without it an edit here looked accepted (the toast said so) and
   * was silently dropped.
   */
  const replaceCredentialAndLabel = async (
    account: AccountSummary,
    credential: Parameters<typeof replaceAccountCredential>[2]
  ) => {
    const detail = await replaceAccountCredential(account.provider, account.id, credential)
    const nextLabel = label.trim() || null
    if (nextLabel !== (account.label ?? null)) {
      await renameAccount(account.provider, account.id, nextLabel)
      return { ...detail, label: nextLabel ?? undefined }
    }
    return detail
  }

  const onSubmit = async () => {
    if (!accessToken.trim() || busy || provider?.available === false) return
    if (!provider && (!name.trim() || !baseUrl.trim() || !models.trim())) {
      setError(t("customRequired"))
      return
    }
    if (/\s/.test(accessToken.trim())) {
      setError(t("invalidKey"))
      return
    }
    if (baseUrl.trim()) {
      try {
        const url = new URL(baseUrl.trim())
        if (
          !["https:", "http:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.hash ||
          url.search
        ) {
          throw new Error("invalid endpoint")
        }
      } catch {
        setError(t("invalidBaseUrl"))
        return
      }
    }
    setBusy(true)
    setError(null)
    try {
      const target =
        provider ??
        (await saveCustomSubscriptionProvider({
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          protocol,
          models: [
            ...new Set(
              models
                .split(/[,\n]/)
                .map((model) => model.trim())
                .filter(Boolean)
            ),
          ],
        }))
      if (!provider) setCreatedDefinition(target)
      const now = Date.now()
      const fields = {
        accessToken: accessToken.trim(),
        baseUrl: baseUrl.trim() || undefined,
        storedAtMs: now,
      }
      const credential =
        target.legacyCredentialKind === "opencode"
          ? {
              provider: "opencode-zen" as const,
              ...fields,
              plan: plan === "go" ? ("go" as const) : ("zen" as const),
            }
          : target.legacyCredentialKind === "commandcode"
            ? { provider: "commandcode" as const, ...fields }
            : { provider: "api-key" as const, providerId: target.id, ...fields }
      if (existingAccount) {
        const account = await replaceCredentialAndLabel(existingAccount, credential)
        onUpdated?.(account)
      } else {
        const draft =
          target.legacyCredentialKind === "opencode"
            ? await saveOpencodeZenKey({
                ...fields,
                plan: plan === "go" ? "go" : "zen",
                label: label.trim() || undefined,
              })
            : {
                id: uuidv7(now),
                label: label.trim() || undefined,
                credential,
                createdAtMs: now,
                lastUsedAtMs: now,
              }
        const account = await persistProviderAccount(target.id, {
          ...draft,
          ...(presetId ? { presetId } : {}),
        })
        onAdded?.(account)
      }
      toast.success(tAccountList(existingAccount ? "credentialsUpdated" : "accountAdded"))
      onOpenChange(false)
    } catch (e) {
      setError(t("saveFailed", { error: e instanceof Error ? e.message : String(e) }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) {
          modelRequest.current?.abort()
          onOpenChange(next)
        }
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t(existingAccount ? "updateTitle" : "title", {
              provider: provider?.name ?? t("customTitle"),
            })}
          </DialogTitle>
          <DialogDescription>{provider?.description ?? t("description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {provider?.legacyCredentialKind === "commandcode" && (
            <p className="text-xs text-muted-foreground">{tCommandcode("goUnsupported")}</p>
          )}
          {provider?.apiKeyUrl && (
            <a
              href={provider.apiKeyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-primary underline"
            >
              {t("getKey")}
            </a>
          )}
          {!definition && !createdDefinition && (
            <>
              <div className="space-y-1">
                <Label htmlFor={`${formId}-name`}>{t("name")}</Label>
                <Input
                  id={`${formId}-name`}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={busy}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${formId}-protocol`}>{t("protocol")}</Label>
                <NativeSelect
                  id={`${formId}-protocol`}
                  value={protocol}
                  onChange={(event) => setProtocol(event.target.value as "openai" | "anthropic")}
                  disabled={busy}
                >
                  <NativeSelectOption value="openai">{t("openaiProtocol")}</NativeSelectOption>
                  <NativeSelectOption value="anthropic">
                    {t("anthropicProtocol")}
                  </NativeSelectOption>
                </NativeSelect>
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${formId}-models`}>{t("models")}</Label>
                <Input
                  id={`${formId}-models`}
                  value={models}
                  onChange={(event) => setModels(event.target.value)}
                  disabled={busy}
                />
              </div>
            </>
          )}
          {!!definition?.plans?.length && (
            <div className="space-y-1">
              <Label>{t("plan")}</Label>
              <RadioGroup value={plan} onValueChange={setPlan} disabled={busy}>
                {definition.plans.map((entry) => (
                  <div key={entry.id} className="flex items-center gap-2">
                    <RadioGroupItem id={`${formId}-${entry.id}`} value={entry.id} />
                    <Label htmlFor={`${formId}-${entry.id}`}>{entry.name}</Label>
                  </div>
                ))}
              </RadioGroup>
            </div>
          )}
          {!existingAccount && provider && (
            <NewAccountPresetSelector
              provider={provider.id}
              value={presetId}
              onChange={setPresetId}
              disabled={busy}
            />
          )}
          <div className="space-y-1">
            <Label htmlFor={`${formId}-token`}>{t("accessTokenField")}</Label>
            <Input
              id={`${formId}-token`}
              type="password"
              disabled={busy}
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              placeholder={t("accessTokenPlaceholder")}
              autoFocus
              spellCheck={false}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${formId}-base-url`}>
              {t(provider ? "baseUrlField" : "customBaseUrlField")}
            </Label>
            <Input
              id={`${formId}-base-url`}
              type="url"
              disabled={busy}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={selectedPlan?.baseUrl ?? provider?.baseUrl}
              spellCheck={false}
            />
            {/* An `AccountSummary` carries no credential, so the stored URL
                cannot be prefilled here. Say that the save overwrites it rather
                than letting a blank field quietly clear a custom endpoint. */}
            {existingAccount && (
              <p className="text-xs text-muted-foreground">{t("baseUrlReplaceHint")}</p>
            )}
          </div>
          {provider && modelOptions.length > 0 && (
            <div className="space-y-2 rounded-md border p-3">
              <Label htmlFor={`${formId}-model-info`}>{t("availableModels")}</Label>
              <NativeSelect
                id={`${formId}-model-info`}
                value={modelInfo?.id ?? ""}
                onChange={(event) => setSelectedModel(event.target.value)}
                disabled={modelBusy}
              >
                {modelOptions.map((model) => (
                  <NativeSelectOption key={model.id} value={model.id}>
                    {model.name ?? model.id}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <p className="text-xs text-muted-foreground">
                {t(modelStatus === "live" ? "modelsLive" : "modelsDeclared")}
              </p>
              {modelInfo && (
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                  <dt>{t("modelId")}</dt>
                  <dd className="break-all">{modelInfo.id}</dd>
                  {modelInfo.contextLength !== undefined &&
                    modelInfo.contextLength > 0 &&
                    modelFieldKnown("contextLength") && (
                      <>
                        <dt>{t("modelContext")}</dt>
                        <dd>{modelInfo.contextLength.toLocaleString()}</dd>
                      </>
                    )}
                  {modelInfo.maxInputTokens !== undefined &&
                    modelInfo.maxInputTokens > 0 &&
                    modelFieldKnown("maxInputTokens") && (
                      <>
                        <dt>{t("modelInput")}</dt>
                        <dd>{modelInfo.maxInputTokens.toLocaleString()}</dd>
                      </>
                    )}
                  {modelInfo.maxOutputTokens !== undefined &&
                    modelInfo.maxOutputTokens > 0 &&
                    modelFieldKnown("maxOutputTokens") && (
                      <>
                        <dt>{t("modelOutput")}</dt>
                        <dd>{modelInfo.maxOutputTokens.toLocaleString()}</dd>
                      </>
                    )}
                  {modelInfo.pricing?.promptPer1M !== undefined && modelFieldKnown("pricing") && (
                    <>
                      <dt>
                        {t("modelInputPrice", { currency: modelInfo.pricing.currency ?? "USD" })}
                      </dt>
                      <dd>{modelInfo.pricing.promptPer1M.toLocaleString()}</dd>
                    </>
                  )}
                  {modelInfo.pricing?.completionPer1M !== undefined &&
                    modelFieldKnown("pricing") && (
                      <>
                        <dt>
                          {t("modelOutputPrice", { currency: modelInfo.pricing.currency ?? "USD" })}
                        </dt>
                        <dd>{modelInfo.pricing.completionPer1M.toLocaleString()}</dd>
                      </>
                    )}
                  {(
                    [
                      "supportsTools",
                      "supportsVision",
                      "supportsAudio",
                      "supportsVideo",
                      "supportsStreaming",
                      "supportsReasoning",
                      "supportsImageGeneration",
                      "supportsEmbedding",
                      "supportsStructuredOutput",
                    ] as const
                  ).map(
                    (capability) =>
                      modelInfo[capability] !== undefined &&
                      modelFieldKnown(capability) && (
                        <div className="contents" key={capability}>
                          <dt>{t(capability)}</dt>
                          <dd>{t(modelInfo[capability] ? "supported" : "unsupported")}</dd>
                        </div>
                      )
                  )}
                </dl>
              )}
              <div className="flex flex-wrap gap-2">
                {provider.modelApi?.list && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={
                      !accessToken.trim() || busy || modelBusy || provider.available === false
                    }
                    onClick={() => void loadModels()}
                  >
                    {modelBusy && <Loader2Icon className="mr-1 size-3 animate-spin" />}
                    {t("fetchModels")}
                  </Button>
                )}
                {provider.modelApi?.retrieve && modelInfo && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={
                      !accessToken.trim() || busy || modelBusy || provider.available === false
                    }
                    onClick={() => void loadModels(modelInfo.id)}
                  >
                    {t("fetchModelInfo")}
                  </Button>
                )}
              </div>
              {modelError && (
                <p role="alert" className="text-xs text-destructive">
                  {modelError}
                </p>
              )}
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor={`${formId}-label`}>{t("labelField")}</Label>
            <Input
              id={`${formId}-label`}
              disabled={busy}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={selectedPlan ? `${provider?.name} ${selectedPlan.name}` : provider?.name}
            />
          </div>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              modelRequest.current?.abort()
              onOpenChange(false)
            }}
            disabled={busy}
          >
            {t("cancel")}
          </Button>
          <Button
            onClick={() => void onSubmit()}
            disabled={!accessToken.trim() || busy || provider?.available === false}
          >
            {busy && <Loader2Icon className="mr-2 size-4 animate-spin" />}
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
