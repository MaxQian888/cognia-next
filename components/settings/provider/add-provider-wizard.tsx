"use client"

/**
 * AddProviderWizard - 4-step guided dialog for adding a provider with full configuration.
 *
 * Step 1: Select Provider (grid + search)
 * Step 2: Configure Credentials (API key + base URL)
 * Step 3: Select Models (checklist + default selection)
 * Step 4: Test Connection (simulated test result)
 */

import { useState, useEffect, useCallback } from "react"
import { useTranslations } from "next-intl"
import { Check, CheckCircle, XCircle, Loader2, Search, ExternalLink } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { getBuiltInProviderSettingsBaseURL } from "@cognia/provider-types/built-in-provider-catalog"

// ── Provider catalogue ─────────────────────────────────────────────────────────

const WIZARD_PROVIDERS = [
  {
    id: "openai",
    name: "OpenAI",
    icon: "🤖",
    desc: "GPT-4o, GPT-4 Turbo",
    docsUrl: "https://platform.openai.com/docs",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    icon: "🧠",
    desc: "Claude 3.5, Claude 3",
    docsUrl: "https://docs.anthropic.com",
  },
  {
    id: "google",
    name: "Google",
    icon: "🔍",
    desc: "Gemini Pro, Gemini Ultra",
    docsUrl: "https://ai.google.dev/docs",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    icon: "🌊",
    desc: "DeepSeek V3, Coder",
    docsUrl: "https://platform.deepseek.com/docs",
  },
  {
    id: "groq",
    name: "Groq",
    icon: "⚡",
    desc: "Fast inference engine",
    docsUrl: "https://console.groq.com/docs",
  },
  {
    id: "mistral",
    name: "Mistral",
    icon: "🌀",
    desc: "Mistral Large, Medium",
    docsUrl: "https://docs.mistral.ai",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    icon: "🔀",
    desc: "Multi-provider gateway",
    docsUrl: "https://openrouter.ai/docs",
  },
  {
    id: "ollama",
    name: "Ollama",
    icon: "🦙",
    desc: "Local model runner",
    docsUrl: "https://ollama.ai/docs",
  },
  { id: "custom", name: "Custom", icon: "⚙️", desc: "OpenAI-compatible endpoint", docsUrl: "" },
]

// ── Mock model lists per provider ─────────────────────────────────────────────

const PROVIDER_MODELS: Record<string, { id: string; name: string }[]> = {
  openai: [
    { id: "gpt-4o", name: "GPT-4o" },
    { id: "gpt-4o-mini", name: "GPT-4o Mini" },
    { id: "gpt-4-turbo", name: "GPT-4 Turbo" },
    { id: "gpt-3.5-turbo", name: "GPT-3.5 Turbo" },
  ],
  anthropic: [
    { id: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet" },
    { id: "claude-3-5-haiku-20241022", name: "Claude 3.5 Haiku" },
    { id: "claude-3-opus-20240229", name: "Claude 3 Opus" },
  ],
  google: [
    { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash" },
    { id: "gemini-1.5-pro", name: "Gemini 1.5 Pro" },
    { id: "gemini-1.5-flash", name: "Gemini 1.5 Flash" },
  ],
  deepseek: [
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    { id: "deepseek-chat", name: "DeepSeek Chat (Legacy)" },
    { id: "deepseek-reasoner", name: "DeepSeek Reasoner (Legacy)" },
  ],
  groq: [
    { id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B" },
    { id: "llama-3.1-8b-instant", name: "Llama 3.1 8B Instant" },
    { id: "mixtral-8x7b-32768", name: "Mixtral 8x7B" },
  ],
  mistral: [
    { id: "mistral-large-latest", name: "Mistral Large" },
    { id: "mistral-medium-latest", name: "Mistral Medium" },
    { id: "mistral-small-latest", name: "Mistral Small" },
  ],
  openrouter: [
    { id: "openai/gpt-4o", name: "OpenAI: GPT-4o" },
    { id: "anthropic/claude-3.5-sonnet", name: "Anthropic: Claude 3.5 Sonnet" },
    { id: "google/gemini-2.0-flash", name: "Google: Gemini 2.0 Flash" },
  ],
  ollama: [
    { id: "llama3.2", name: "Llama 3.2" },
    { id: "mistral", name: "Mistral" },
    { id: "qwen2.5-coder", name: "Qwen 2.5 Coder" },
  ],
  custom: [{ id: "custom-model", name: "Custom Model" }],
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AddProviderWizardProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onComplete: (config: {
    providerId: string
    apiKey: string
    baseURL?: string
    enabledModels: string[]
    defaultModel: string
  }) => void
  initialProviderId?: string
}

type TestResult = { success: boolean; latency?: number; error?: string } | null

// ── Step Indicator ────────────────────────────────────────────────────────────

interface StepIndicatorProps {
  currentStep: number
  labels: string[]
}

function StepIndicator({ currentStep, labels }: StepIndicatorProps) {
  return (
    <div className="flex items-center gap-0" data-testid="step-indicator">
      {labels.map((label, i) => {
        const stepNum = i + 1
        const isCompleted = stepNum < currentStep
        const isActive = stepNum === currentStep
        return (
          <div key={stepNum} className="flex items-center">
            <div className="flex flex-col items-center gap-1">
              <div
                className={cn(
                  "flex h-7 w-7 items-center justify-center rounded-full border-2 text-xs font-semibold transition-colors",
                  isCompleted && "border-primary bg-primary text-primary-foreground",
                  isActive && "border-primary bg-background text-primary",
                  !isCompleted &&
                    !isActive &&
                    "border-muted-foreground/30 bg-background text-muted-foreground"
                )}
              >
                {isCompleted ? <Check className="h-3 w-3" /> : stepNum}
              </div>
              <span
                className={cn(
                  "text-[10px] leading-tight text-center w-14",
                  isActive ? "text-primary font-medium" : "text-muted-foreground"
                )}
              >
                {label}
              </span>
            </div>
            {i < labels.length - 1 && (
              <div
                className={cn(
                  "mb-4 h-px w-8 flex-shrink-0",
                  stepNum < currentStep ? "bg-primary" : "bg-muted-foreground/30"
                )}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Main Component ─────────────────────────────────────────────────────────────

export function AddProviderWizard({
  open,
  onOpenChange,
  onComplete,
  initialProviderId,
}: AddProviderWizardProps) {
  const t = useTranslations("providers")

  // ── Wizard state ────────────────────────────────────────────────────────────
  const [currentStep, setCurrentStep] = useState<number>(() => (initialProviderId ? 2 : 1))
  const [selectedProviderId, setSelectedProviderId] = useState<string>(initialProviderId ?? "")
  const [searchQuery, setSearchQuery] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [baseURL, setBaseURL] = useState("")
  const [models, setModels] = useState<{ id: string; name: string }[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [enabledModels, setEnabledModels] = useState<string[]>([])
  const [defaultModel, setDefaultModel] = useState("")
  const [testResult, setTestResult] = useState<TestResult>(null)
  const [isTesting, setIsTesting] = useState(false)

  // Reset when dialog closes / opens
  useEffect(() => {
    if (!open) {
      const timer = setTimeout(() => {
        const effectiveProviderId = initialProviderId ?? ""
        setCurrentStep(initialProviderId ? 2 : 1)
        setSelectedProviderId(effectiveProviderId)
        setSearchQuery("")
        setApiKey("")
        setBaseURL(getBuiltInProviderSettingsBaseURL(effectiveProviderId) ?? "")
        setModels([])
        setEnabledModels([])
        setDefaultModel("")
        setTestResult(null)
        setIsTesting(false)
      }, 0)
      return () => clearTimeout(timer)
    }
  }, [open, initialProviderId])

  // Load models when entering step 3
  useEffect(() => {
    if (currentStep !== 3 || !selectedProviderId) return

    // Simulate async fetch — all state updates happen inside the async callback
    const timer = setTimeout(() => {
      const providerModels = PROVIDER_MODELS[selectedProviderId] ?? []
      setModelsLoading(true)
      setModels(providerModels)
      const allIds = providerModels.map((m) => m.id)
      setEnabledModels(allIds)
      setDefaultModel(allIds[0] ?? "")
      setModelsLoading(false)
    }, 600)

    return () => clearTimeout(timer)
  }, [currentStep, selectedProviderId])

  // Run simulated test when entering step 4
  useEffect(() => {
    if (currentStep !== 4) return

    // All state updates happen inside the async callbacks to avoid
    // synchronous setState-in-effect lint violations.
    const initTimer = setTimeout(() => {
      setTestResult(null)
      setIsTesting(true)
    }, 0)

    const timer = setTimeout(() => {
      // Simulate success — real testing wired in Task 13
      setTestResult({ success: true, latency: Math.floor(Math.random() * 300) + 50 })
      setIsTesting(false)
    }, 1200)

    return () => {
      clearTimeout(initTimer)
      clearTimeout(timer)
    }
  }, [currentStep])

  // ── Handlers ────────────────────────────────────────────────────────────────

  const handleSelectProvider = useCallback((providerId: string) => {
    setSelectedProviderId(providerId)
    const defaultBaseURL = getBuiltInProviderSettingsBaseURL(providerId)
    if (defaultBaseURL) {
      setBaseURL(defaultBaseURL)
    }
    setCurrentStep(2)
  }, [])

  const handleBack = useCallback(() => {
    setCurrentStep((s) => Math.max(1, s - 1))
  }, [])

  const handleNext = useCallback(() => {
    setCurrentStep((s) => Math.min(4, s + 1))
  }, [])

  const handleFinish = useCallback(() => {
    onComplete({
      providerId: selectedProviderId,
      apiKey,
      baseURL: baseURL || undefined,
      enabledModels,
      defaultModel,
    })
    onOpenChange(false)
  }, [onComplete, onOpenChange, selectedProviderId, apiKey, baseURL, enabledModels, defaultModel])

  const handleToggleModel = useCallback((modelId: string, checked: boolean) => {
    setEnabledModels((prev) => (checked ? [...prev, modelId] : prev.filter((id) => id !== modelId)))
  }, [])

  // ── Filtered providers for step 1 ──────────────────────────────────────────

  const filteredProviders = WIZARD_PROVIDERS.filter(
    (p) =>
      p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.desc.toLowerCase().includes(searchQuery.toLowerCase())
  )

  // ── Step labels ─────────────────────────────────────────────────────────────

  const stepLabels = [
    t("wizard.selectProvider"),
    t("wizard.credentials"),
    t("wizard.models"),
    t("wizard.test"),
  ]

  const selectedProvider = WIZARD_PROVIDERS.find((p) => p.id === selectedProviderId)

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[600px] p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-4 border-b">
          <DialogTitle>{t("wizard.title")}</DialogTitle>
          <div className="mt-4">
            <StepIndicator currentStep={currentStep} labels={stepLabels} />
          </div>
        </DialogHeader>

        {/* ── Step Content ─────────────────────────────────────────────────── */}
        <div className="min-h-[340px] px-6 py-5 overflow-y-auto">
          {/* Step 1: Select Provider */}
          {currentStep === 1 && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">{t("wizard.selectProviderHint")}</p>

              {/* Search */}
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder={t("wizard.searchProviders")}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9"
                />
              </div>

              {/* Provider Grid */}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {filteredProviders.map((provider) => (
                  <Button
                    key={provider.id}
                    type="button"
                    variant="outline"
                    onClick={() => handleSelectProvider(provider.id)}
                    className={cn(
                      "h-auto justify-start gap-2 whitespace-normal rounded-lg p-3 text-left font-normal",
                      "hover:border-primary/50 hover:bg-accent"
                    )}
                  >
                    <span className="text-xl shrink-0">{provider.icon}</span>
                    <div className="min-w-0">
                      <p className="text-sm font-medium leading-none truncate">{provider.name}</p>
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">
                        {provider.desc}
                      </p>
                    </div>
                  </Button>
                ))}
              </div>

              {filteredProviders.length === 0 && (
                <p className="text-center text-sm text-muted-foreground py-6">
                  {t("wizard.noProviders")}
                </p>
              )}
            </div>
          )}

          {/* Step 2: Configure Credentials */}
          {currentStep === 2 && (
            <div className="space-y-5">
              <div className="flex items-center gap-3">
                {selectedProvider && <span className="text-2xl">{selectedProvider.icon}</span>}
                <div>
                  <h3 className="font-semibold">{t("wizard.configureCredentials")}</h3>
                  <p className="text-sm text-muted-foreground">
                    {selectedProvider?.name ?? selectedProviderId}
                  </p>
                </div>
                {selectedProvider?.docsUrl && (
                  <a
                    href={selectedProvider.docsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-auto flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  >
                    <ExternalLink className="h-3 w-3" />
                    {t("wizard.docs")}
                  </a>
                )}
              </div>

              <div className="space-y-3">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium" htmlFor="wizard-api-key">
                    {t("wizard.apiKey")}
                  </label>
                  <Input
                    id="wizard-api-key"
                    data-testid="api-key-input"
                    type="password"
                    placeholder={t("wizard.apiKeyPlaceholder")}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">{t("wizard.apiKeyHint")}</p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-sm font-medium" htmlFor="wizard-base-url">
                    {t("wizard.baseURL")}
                  </label>
                  <Input
                    id="wizard-base-url"
                    data-testid="base-url-input"
                    type="url"
                    placeholder={t("wizard.baseURLPlaceholder")}
                    value={baseURL}
                    onChange={(e) => setBaseURL(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">{t("wizard.baseURLHint")}</p>
                </div>
              </div>
            </div>
          )}

          {/* Step 3: Select Models */}
          {currentStep === 3 && (
            <div className="space-y-4">
              <div>
                <h3 className="font-semibold">{t("wizard.selectModels")}</h3>
                <p className="text-sm text-muted-foreground">{t("wizard.selectModelsHint")}</p>
              </div>

              {modelsLoading ? (
                <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  <span className="text-sm">{t("wizard.loadingModels")}</span>
                </div>
              ) : (
                <div className="space-y-2">
                  {models.map((model) => {
                    const isEnabled = enabledModels.includes(model.id)
                    const isDefault = defaultModel === model.id
                    return (
                      <div
                        key={model.id}
                        className={cn(
                          "flex items-center justify-between rounded-lg border px-3 py-2.5 transition-colors",
                          isEnabled ? "border-primary/30 bg-primary/5" : "border-border"
                        )}
                      >
                        <div className="flex items-center gap-3">
                          <Checkbox
                            id={`model-${model.id}`}
                            checked={isEnabled}
                            onCheckedChange={(checked) => handleToggleModel(model.id, !!checked)}
                          />
                          <label
                            htmlFor={`model-${model.id}`}
                            className="text-sm cursor-pointer select-none"
                          >
                            {model.name}
                          </label>
                        </div>
                        {isEnabled && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setDefaultModel(model.id)}
                            className={cn(
                              "h-auto rounded-full px-2 py-0.5 text-xs font-normal",
                              isDefault
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-muted-foreground/30 text-muted-foreground hover:border-primary hover:text-primary"
                            )}
                          >
                            {isDefault ? t("wizard.default") : t("wizard.setDefault")}
                          </Button>
                        )}
                      </div>
                    )
                  })}

                  {models.length === 0 && (
                    <p className="text-center text-sm text-muted-foreground py-6">
                      {t("wizard.noModels")}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Step 4: Test Connection */}
          {currentStep === 4 && (
            <div className="space-y-4">
              <div>
                <h3 className="font-semibold">{t("wizard.testConnection")}</h3>
                <p className="text-sm text-muted-foreground">{t("wizard.testConnectionHint")}</p>
              </div>

              {isTesting && (
                <div className="flex items-center justify-center gap-3 rounded-lg border border-dashed p-8">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                  <span className="text-sm text-muted-foreground">{t("wizard.testing")}</span>
                </div>
              )}

              {!isTesting && testResult?.success && (
                <div className="flex items-center gap-4 rounded-lg border border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/30 p-4">
                  <CheckCircle className="h-8 w-8 text-green-500 shrink-0" />
                  <div>
                    <p className="font-medium text-green-700 dark:text-green-400">
                      {t("wizard.testSuccess")}
                    </p>
                    {testResult.latency !== undefined && (
                      <p className="text-sm text-green-600 dark:text-green-500">
                        {t("wizard.latency")}: {testResult.latency}ms
                      </p>
                    )}
                  </div>
                </div>
              )}

              {!isTesting && testResult && !testResult.success && (
                <div className="flex items-start gap-4 rounded-lg border border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30 p-4">
                  <XCircle className="h-8 w-8 text-red-500 shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    <p className="font-medium text-red-700 dark:text-red-400">
                      {t("wizard.testFailed")}
                    </p>
                    {testResult.error && (
                      <p className="text-sm text-red-600 dark:text-red-500">{testResult.error}</p>
                    )}
                    <ul className="mt-2 space-y-0.5 text-xs text-red-600 dark:text-red-500 list-disc list-inside">
                      <li>{t("wizard.troubleshoot1")}</li>
                      <li>{t("wizard.troubleshoot2")}</li>
                      <li>{t("wizard.troubleshoot3")}</li>
                    </ul>
                  </div>
                </div>
              )}

              {!isTesting && !testResult && (
                <div className="flex items-center justify-center gap-2 rounded-lg border border-dashed p-8 text-muted-foreground">
                  <span className="text-sm">{t("wizard.waitingForTest")}</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Footer / Navigation ──────────────────────────────────────────── */}
        <div className="flex items-center justify-between border-t px-6 py-4">
          <div>
            {currentStep > 1 && (
              <Button variant="outline" onClick={handleBack}>
                {t("wizard.back")}
              </Button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t("wizard.cancel")}
            </Button>

            {currentStep < 4 && currentStep > 1 && (
              <Button onClick={handleNext} disabled={currentStep === 3 && modelsLoading}>
                {t("wizard.next")}
              </Button>
            )}

            {currentStep === 4 && (
              <Button onClick={handleFinish} disabled={isTesting}>
                {t("wizard.finish")}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default AddProviderWizard
