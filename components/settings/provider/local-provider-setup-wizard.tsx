"use client"

/**
 * LocalProviderSetupWizard - Step-by-step setup guide for local AI providers
 *
 * Provides installation instructions, download links, and verification
 * for setting up local inference engines.
 */

import { useState, useCallback } from "react"
import { useTranslations } from "next-intl"
import {
  Download,
  Check,
  AlertCircle,
  Loader2,
  ExternalLink,
  ChevronRight,
  RefreshCw,
  Terminal,
  Copy,
  CheckCircle2,
} from "lucide-react"
import { loggers } from "@cognia/logging"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { cn } from "@/lib/utils"
import type { LocalProviderName } from "@cognia/provider-types/local-provider"
import { LOCAL_PROVIDER_CONFIGS } from "@cognia/provider-core/providers/local-providers"
import {
  getInstallInstructions,
  createLocalProviderService,
} from "@cognia/provider-core/providers/local-provider-service"

export interface LocalProviderSetupWizardProps {
  providerId: LocalProviderName
  onComplete?: () => void
}

type SetupStep = "download" | "install" | "configure" | "verify" | "complete"

const log = loggers.native.child("local-provider-setup-wizard")

export function LocalProviderSetupWizard({
  providerId,
  onComplete,
}: LocalProviderSetupWizardProps) {
  const t = useTranslations("providers")
  const [currentStep, setCurrentStep] = useState<SetupStep>("download")
  const [isVerifying, setIsVerifying] = useState(false)
  const [verificationResult, setVerificationResult] = useState<{
    success: boolean
    message: string
  } | null>(null)
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null)

  const config = LOCAL_PROVIDER_CONFIGS[providerId]
  const instructions = getInstallInstructions(providerId)

  const steps: { id: SetupStep; title: string }[] = [
    { id: "download", title: t("setupWizard.download") },
    { id: "install", title: t("setupWizard.install") },
    { id: "configure", title: t("setupWizard.configure") },
    { id: "verify", title: t("setupWizard.verifyStep") },
    { id: "complete", title: t("setupWizard.complete") },
  ]

  const currentStepIndex = steps.findIndex((s) => s.id === currentStep)
  const progress = ((currentStepIndex + 1) / steps.length) * 100

  // Copy command to clipboard
  const copyCommand = useCallback(async (command: string) => {
    try {
      await navigator.clipboard.writeText(command)
      setCopiedCommand(command)
      setTimeout(() => setCopiedCommand(null), 2000)
    } catch {
      log.error("Failed to copy command")
    }
  }, [])

  // Verify connection
  const verifyConnection = useCallback(async () => {
    setIsVerifying(true)
    setVerificationResult(null)

    try {
      const service = createLocalProviderService(providerId)
      const status = await service.getStatus()

      if (status.connected) {
        setVerificationResult({
          success: true,
          message: `Connected${status.version ? ` v${status.version}` : ""}${status.models_count ? ` (${status.models_count} models)` : ""}`,
        })
        setCurrentStep("complete")
      } else {
        setVerificationResult({
          success: false,
          message: status.error || "Connection failed. Make sure the server is running.",
        })
      }
    } catch (error) {
      setVerificationResult({
        success: false,
        message: error instanceof Error ? error.message : "Connection failed",
      })
    } finally {
      setIsVerifying(false)
    }
  }, [providerId])

  // Render step indicator
  const renderStepIndicator = () => (
    <div className="mb-6">
      <Progress value={progress} className="h-1 mb-4" />
      <div className="flex justify-between">
        {steps.map((step, index) => {
          const isActive = index === currentStepIndex
          const isCompleted = index < currentStepIndex

          return (
            <div
              key={step.id}
              className={cn(
                "flex items-center gap-1.5 text-xs",
                isActive ? "text-primary font-medium" : "text-muted-foreground",
                isCompleted && "text-green-600"
              )}
            >
              {isCompleted ? (
                <CheckCircle2 className="h-3.5 w-3.5" />
              ) : (
                <span
                  className={cn(
                    "h-4 w-4 rounded-full flex items-center justify-center text-[10px] border",
                    isActive
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-muted-foreground"
                  )}
                >
                  {index + 1}
                </span>
              )}
              <span className="hidden sm:inline">{step.title}</span>
            </div>
          )
        })}
      </div>
    </div>
  )

  // Render command with copy button
  const renderCommand = (command: string) => (
    <div className="flex items-center gap-2 bg-muted rounded-lg p-2 font-mono text-sm">
      <Terminal className="h-4 w-4 text-muted-foreground flex-shrink-0" />
      <code className="flex-1 overflow-x-auto">{command}</code>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 flex-shrink-0"
        onClick={() => copyCommand(command)}
      >
        {copiedCommand === command ? (
          <Check className="h-3 w-3 text-green-500" />
        ) : (
          <Copy className="h-3 w-3" />
        )}
      </Button>
    </div>
  )

  // Render step content
  const renderStepContent = () => {
    switch (currentStep) {
      case "download":
        return (
          <div className="space-y-4">
            <div className="text-center">
              <Download className="h-12 w-12 mx-auto text-primary mb-2" />
              <h3 className="font-semibold text-lg">{instructions.title}</h3>
              <p className="text-sm text-muted-foreground mt-1">
                {t("setupWizard.downloadInstructions")}
              </p>
            </div>

            <Button className="w-full" asChild>
              <a href={instructions.downloadUrl} target="_blank" rel="noopener noreferrer">
                <Download className="h-4 w-4 mr-2" />
                {t("setupWizard.downloadProvider", { provider: config.name })}
                <ExternalLink className="h-3 w-3 ml-2" />
              </a>
            </Button>

            <div className="flex justify-end">
              <Button onClick={() => setCurrentStep("install")}>
                {t("next")}
                <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            </div>
          </div>
        )

      case "install":
        return (
          <div className="space-y-4">
            <h3 className="font-semibold">{t("setupWizard.installationSteps")}</h3>
            <ol className="space-y-3">
              {instructions.steps.map((step, index) => (
                <li key={index} className="flex gap-3 text-sm">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-primary text-xs font-medium flex-shrink-0">
                    {index + 1}
                  </span>
                  <span className="text-muted-foreground">{step}</span>
                </li>
              ))}
            </ol>

            {/* Provider-specific commands */}
            {providerId === "ollama" && (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  {t("setupWizard.afterInstallation")}
                </p>
                {renderCommand("ollama serve")}
              </div>
            )}

            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setCurrentStep("download")}>
                {t("back")}
              </Button>
              <Button onClick={() => setCurrentStep("configure")}>
                {t("next")}
                <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            </div>
          </div>
        )

      case "configure":
        return (
          <div className="space-y-4">
            <h3 className="font-semibold">{t("setupWizard.configurationTitle")}</h3>

            <div className="space-y-3">
              <div className="rounded-lg border p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{t("serverUrl")}</span>
                  <Badge variant="secondary" className="font-mono text-xs">
                    {config.defaultBaseURL}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("setupWizard.defaultPort", { port: config.defaultPort })}
                </p>
              </div>

              {providerId === "ollama" && (
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">{t("setupWizard.pullFirstModel")}</p>
                  {renderCommand("ollama pull llama3.2")}
                  <p className="text-xs text-muted-foreground">{t("setupWizard.pullModelSize")}</p>
                </div>
              )}
            </div>

            <Button variant="outline" size="sm" className="w-full" asChild>
              <a href={instructions.docsUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-3 w-3 mr-1" />
                {t("viewDocumentation")}
              </a>
            </Button>

            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setCurrentStep("install")}>
                {t("back")}
              </Button>
              <Button onClick={() => setCurrentStep("verify")}>
                {t("next")}
                <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            </div>
          </div>
        )

      case "verify":
        return (
          <div className="space-y-4">
            <h3 className="font-semibold">{t("setupWizard.verifyConnection")}</h3>
            <p className="text-sm text-muted-foreground">
              {t("setupWizard.verifyConnectionDesc", { provider: config.name })}
            </p>

            <Button className="w-full" onClick={verifyConnection} disabled={isVerifying}>
              {isVerifying ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  {t("verifying")}
                </>
              ) : (
                <>
                  <RefreshCw className="h-4 w-4 mr-2" />
                  {t("setupWizard.verifyConnection")}
                </>
              )}
            </Button>

            {verificationResult && (
              <div
                className={cn(
                  "flex items-center gap-2 rounded-lg p-3 text-sm",
                  verificationResult.success
                    ? "bg-green-500/10 text-green-600"
                    : "bg-destructive/10 text-destructive"
                )}
              >
                {verificationResult.success ? (
                  <CheckCircle2 className="h-4 w-4" />
                ) : (
                  <AlertCircle className="h-4 w-4" />
                )}
                {verificationResult.message}
              </div>
            )}

            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setCurrentStep("configure")}>
                {t("back")}
              </Button>
              <Button
                onClick={() => setCurrentStep("complete")}
                variant={verificationResult?.success ? "default" : "outline"}
              >
                {verificationResult?.success ? t("setupWizard.completeSetup") : t("skipForNow")}
              </Button>
            </div>
          </div>
        )

      case "complete":
        return (
          <div className="space-y-4 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-500/10 mx-auto">
              <CheckCircle2 className="h-8 w-8 text-green-600" />
            </div>
            <div>
              <h3 className="font-semibold text-lg">{t("setupWizard.setupComplete")}</h3>
              <p className="text-sm text-muted-foreground mt-1">
                {t("setupWizard.providerReady", { provider: config.name })}
              </p>
            </div>

            {verificationResult?.success && (
              <Badge variant="success">
                <Check className="h-3 w-3 mr-1" />
                {t("connected")}
              </Badge>
            )}

            <Button className="w-full" onClick={onComplete}>
              {t("getStarted")}
            </Button>
          </div>
        )
    }
  }

  return (
    <div className="space-y-4">
      {renderStepIndicator()}
      {renderStepContent()}
    </div>
  )
}

export default LocalProviderSetupWizard
