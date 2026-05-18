"use client"

/**
 * ProviderImportExport - Import/Export provider configurations
 * Enhanced UI with drag-drop, provider selection, and format options
 */

import { useState, useRef, useCallback, useMemo } from "react"
import { Download, Upload, AlertCircle, Check, FileJson, File, X, ShieldAlert } from "lucide-react"
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
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { useSettingsStore } from "@/stores"
import type { CustomProviderSettings } from "@/types/provider/provider"
import { PROVIDERS } from "@/types/provider"

interface ProviderImportExportProps {
  onClose?: () => void
}

interface ExportData {
  version: number
  exportedAt: string
  providerSettings?: Record<string, unknown>
  customProviders?: Record<string, unknown>
}

interface ImportValidationResult {
  valid: boolean
  error?: string
  errorKey?: string
  errorValues?: Record<string, string | number>
  data?: ExportData
}

type ExportFormat = "json" | "env"

// Import conflict types
interface ImportConflict {
  id: string
  name: string
  type: "builtin" | "custom"
  conflictType: "exists" | "different_settings"
  currentValue?: string
  importValue?: string
}

type ImportResolution = "skip" | "overwrite" | "merge"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validateImportData(raw: unknown): ImportValidationResult {
  if (!isRecord(raw)) {
    return { valid: false, errorKey: "importErrors.invalidPayloadObject" }
  }

  const version = raw.version
  if (typeof version !== "number" || !Number.isFinite(version)) {
    return { valid: false, errorKey: "importErrors.missingVersion" }
  }

  const exportedAt = raw.exportedAt
  if (typeof exportedAt !== "string" || exportedAt.trim().length === 0) {
    return { valid: false, errorKey: "importErrors.missingExportedAt" }
  }

  const providerSettingsRaw = raw.providerSettings
  const customProvidersRaw = raw.customProviders

  if (!isRecord(providerSettingsRaw) && !isRecord(customProvidersRaw)) {
    return {
      valid: false,
      errorKey: "importErrors.missingProviders",
    }
  }

  const providerSettings: Record<string, unknown> = {}
  const customProviders: Record<string, unknown> = {}

  if (isRecord(providerSettingsRaw)) {
    for (const [providerId, value] of Object.entries(providerSettingsRaw)) {
      if (!isRecord(value)) {
        return {
          valid: false,
          errorKey: "importErrors.invalidProviderSettings",
          errorValues: { providerId },
        }
      }
      if (typeof value.baseURL === "string" && value.baseURL.trim().length > 0) {
        try {
          const parsed = new URL(value.baseURL)
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return {
              valid: false,
              errorKey: "importErrors.invalidProviderBaseUrlProtocol",
              errorValues: { providerId },
            }
          }
        } catch {
          return {
            valid: false,
            errorKey: "importErrors.invalidProviderBaseUrl",
            errorValues: { providerId },
          }
        }
      }
      providerSettings[providerId] = value
    }
  }

  if (isRecord(customProvidersRaw)) {
    for (const [providerId, value] of Object.entries(customProvidersRaw)) {
      if (!isRecord(value)) {
        return {
          valid: false,
          errorKey: "importErrors.invalidCustomProviderPayload",
          errorValues: { providerId },
        }
      }
      if (typeof value.customName !== "string" || value.customName.trim().length === 0) {
        return {
          valid: false,
          errorKey: "importErrors.customProviderMissingName",
          errorValues: { providerId },
        }
      }
      if (typeof value.baseURL !== "string" || value.baseURL.trim().length === 0) {
        return {
          valid: false,
          errorKey: "importErrors.customProviderMissingBaseUrl",
          errorValues: { providerId },
        }
      }
      try {
        const parsed = new URL(value.baseURL)
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return {
            valid: false,
            errorKey: "importErrors.invalidCustomProviderBaseUrlProtocol",
            errorValues: { providerId },
          }
        }
      } catch {
        return {
          valid: false,
          errorKey: "importErrors.invalidCustomProviderBaseUrl",
          errorValues: { providerId },
        }
      }
      customProviders[providerId] = value
    }
  }

  return {
    valid: true,
    data: {
      version,
      exportedAt,
      providerSettings,
      customProviders,
    },
  }
}

export function ProviderImportExport({ onClose }: ProviderImportExportProps) {
  const t = useTranslations("providers")
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dropZoneRef = useRef<HTMLDivElement>(null)

  const providerSettings = useSettingsStore((state) => state.providerSettings)
  const customProvidersList = useSettingsStore((state) => state.customProviders)
  // cognia-next stores customs as an array; re-key for the export logic.
  const customProviders = useMemo<Record<string, CustomProviderSettings>>(() => {
    const out: Record<string, CustomProviderSettings> = {}
    for (const cp of customProvidersList) {
      out[cp.id] = cp
    }
    return out
  }, [customProvidersList])
  const setProviderSettings = useSettingsStore((state) => state.setProviderSettings)
  const addCustomProvider = useSettingsStore((state) => state.addCustomProvider)
  const updateCustomProvider = useSettingsStore((state) => state.updateCustomProvider)

  const [exportDialogOpen, setExportDialogOpen] = useState(false)
  const [importDialogOpen, setImportDialogOpen] = useState(false)
  const [includeApiKeys, setIncludeApiKeys] = useState(false)
  const [exportFormat, setExportFormat] = useState<ExportFormat>("json")
  const [selectedProviders, setSelectedProviders] = useState<string[]>([])
  const [importData, setImportData] = useState<ExportData | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [importSuccess, setImportSuccess] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [importFileName, setImportFileName] = useState<string | null>(null)
  const [importConflicts, setImportConflicts] = useState<ImportConflict[]>([])
  const [importResolution, setImportResolution] = useState<ImportResolution>("overwrite")
  const [showConflictWarning, setShowConflictWarning] = useState(false)

  const translateImportError = useCallback(
    (errorKey?: string, errorValues?: Record<string, string | number>) => {
      if (!errorKey) {
        return t("importErrors.invalidFileFormat")
      }

      return t(errorKey as never, errorValues as never)
    },
    [t]
  )

  // Get list of providers with settings
  const availableProviders = useMemo(() => {
    const providers: { id: string; name: string; modelsCount: number }[] = []

    Object.entries(providerSettings).forEach(([id, settings]) => {
      if (settings?.apiKey || id === "ollama") {
        const providerData = PROVIDERS[id]
        providers.push({
          id,
          name: providerData?.name || id,
          modelsCount: providerData?.models?.length || 0,
        })
      }
    })

    Object.entries(customProviders).forEach(([id, provider]) => {
      providers.push({
        id,
        name: provider.customName || id,
        modelsCount: provider.customModels?.length || 0,
      })
    })

    return providers
  }, [providerSettings, customProviders])

  // Initialize selected providers when dialog opens
  const handleExportDialogOpen = useCallback(
    (open: boolean) => {
      if (open) {
        setSelectedProviders(availableProviders.map((p) => p.id))
        setIncludeApiKeys(false)
        setExportFormat("json")
      }
      setExportDialogOpen(open)
    },
    [availableProviders]
  )

  const handleExport = () => {
    if (exportFormat === "env") {
      // Export as .env format
      let envContent = `# Cognia Provider Settings\n# Exported: ${new Date().toISOString()}\n\n`

      selectedProviders.forEach((id) => {
        const settings = providerSettings[id]
        const custom = customProviders[id]

        if (settings?.apiKey && includeApiKeys) {
          const key = `${id.toUpperCase()}_API_KEY`
          envContent += `${key}=${settings.apiKey}\n`
        }
        if (custom?.apiKey && includeApiKeys) {
          const key = `${id.toUpperCase()}_API_KEY`
          envContent += `${key}=${custom.apiKey}\n`
        }
        if (settings?.baseURL) {
          const key = `${id.toUpperCase()}_BASE_URL`
          envContent += `${key}=${settings.baseURL}\n`
        }
      })

      const blob = new Blob([envContent], { type: "text/plain" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `cognia-providers-${new Date().toISOString().split("T")[0]}.env`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } else {
      // Export as JSON
      const exportData: ExportData = {
        version: 1,
        exportedAt: new Date().toISOString(),
        providerSettings: {},
        customProviders: {},
      }

      // Export only selected providers
      selectedProviders.forEach((id) => {
        const settings = providerSettings[id]
        const custom = customProviders[id]

        if (settings) {
          const settingsCopy = { ...settings }
          if (!includeApiKeys) {
            delete settingsCopy.apiKey
            delete settingsCopy.apiKeys
          }
          exportData.providerSettings![id] = settingsCopy
        }
        if (custom) {
          const customCopy = { ...custom }
          if (!includeApiKeys) {
            delete (customCopy as Record<string, unknown>).apiKey
          }
          exportData.customProviders![id] = customCopy
        }
      })

      const blob = new Blob([JSON.stringify(exportData, null, 2)], {
        type: "application/json",
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `cognia-providers-${new Date().toISOString().split("T")[0]}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    }

    setExportDialogOpen(false)
    onClose?.()
  }

  // Detect conflicts between import data and existing settings
  const detectImportConflicts = useCallback(
    (data: ExportData): ImportConflict[] => {
      const conflicts: ImportConflict[] = []

      // Check built-in provider conflicts
      if (data.providerSettings) {
        Object.entries(data.providerSettings).forEach(([id, importSettings]) => {
          const currentSettings = providerSettings[id]
          if (currentSettings?.apiKey || currentSettings?.enabled) {
            const importApiKey = (importSettings as Record<string, unknown>)?.apiKey as string
            const currentApiKey = currentSettings.apiKey || ""

            if (currentApiKey && importApiKey && currentApiKey !== importApiKey) {
              conflicts.push({
                id,
                name: PROVIDERS[id]?.name || id,
                type: "builtin",
                conflictType: "different_settings",
                currentValue: `API Key: ***${currentApiKey.slice(-4)}`,
                importValue: `API Key: ***${importApiKey.slice(-4)}`,
              })
            } else if (currentSettings.enabled && !importApiKey) {
              conflicts.push({
                id,
                name: PROVIDERS[id]?.name || id,
                type: "builtin",
                conflictType: "exists",
              })
            }
          }
        })
      }

      // Check custom provider conflicts
      if (data.customProviders) {
        Object.entries(data.customProviders).forEach(([id, importProvider]) => {
          const currentProvider = customProviders[id]
          if (currentProvider) {
            const importName = (importProvider as Record<string, unknown>)?.customName as string
            conflicts.push({
              id,
              name: currentProvider.customName || importName || id,
              type: "custom",
              conflictType: "exists",
              currentValue: currentProvider.baseURL,
              importValue: (importProvider as Record<string, unknown>)?.baseURL as string,
            })
          }
        })
      }

      return conflicts
    },
    [providerSettings, customProviders]
  )

  const processImportFile = useCallback(
    (file: File) => {
      setImportError(null)
      setImportSuccess(false)
      setImportFileName(file.name)
      setImportConflicts([])
      setShowConflictWarning(false)

      const reader = new FileReader()
      reader.onload = (e) => {
        try {
          const parsed = JSON.parse(e.target?.result as string) as unknown
          const validation = validateImportData(parsed)
          if (!validation.valid || !validation.data) {
            throw new Error(translateImportError(validation.errorKey, validation.errorValues))
          }
          const data = validation.data

          // Detect conflicts
          const conflicts = detectImportConflicts(data)
          setImportConflicts(conflicts)
          if (conflicts.length > 0) {
            setShowConflictWarning(true)
          }

          setImportData(data)
          setImportDialogOpen(true)
        } catch (error) {
          setImportError(
            error instanceof Error ? error.message : t("importErrors.invalidFileFormat")
          )
          setImportDialogOpen(true)
        }
      }
      reader.readAsText(file)
    },
    [detectImportConflicts, t, translateImportError]
  )

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    processImportFile(file)
    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = ""
    }
  }

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragging(false)
      const file = e.dataTransfer.files[0]
      if (file && file.name.endsWith(".json")) {
        processImportFile(file)
      } else {
        setImportError(t("importErrors.dropValidJson"))
        setImportDialogOpen(true)
      }
    },
    [processImportFile, t]
  )

  const toggleProviderSelection = (id: string) => {
    setSelectedProviders((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
    )
  }

  const toggleSelectAll = () => {
    if (selectedProviders.length === availableProviders.length) {
      setSelectedProviders([])
    } else {
      setSelectedProviders(availableProviders.map((p) => p.id))
    }
  }

  const handleImport = () => {
    if (!importData) return

    // Build set of conflicting IDs to check resolution strategy
    const conflictIds = new Set(importConflicts.map((c) => c.id))

    try {
      const validation = validateImportData(importData)
      if (!validation.valid || !validation.data) {
        setImportError(translateImportError(validation.errorKey, validation.errorValues))
        return
      }

      const safeData = validation.data

      // Import provider settings based on resolution strategy
      if (safeData.providerSettings) {
        Object.entries(safeData.providerSettings).forEach(([id, settings]) => {
          const hasConflict = conflictIds.has(id)

          // Skip if conflict and resolution is 'skip'
          if (hasConflict && importResolution === "skip") {
            return
          }

          // Merge: only update non-API-key settings if conflict
          if (hasConflict && importResolution === "merge") {
            const currentSettings = providerSettings[id]
            const importSettings = settings as Record<
              string,
              string | string[] | boolean | undefined
            >
            // Keep current API key, merge other settings
            setProviderSettings(id, {
              ...importSettings,
              apiKey: currentSettings?.apiKey || (importSettings.apiKey as string),
              apiKeys: currentSettings?.apiKeys || (importSettings.apiKeys as string[]),
            })
          } else {
            // Overwrite or no conflict
            setProviderSettings(id, settings as Record<string, unknown>)
          }
        })
      }

      // Import custom providers based on resolution strategy
      if (safeData.customProviders) {
        Object.entries(safeData.customProviders).forEach(([id, provider]) => {
          const hasConflict = conflictIds.has(id)

          // Skip if conflict and resolution is 'skip'
          if (hasConflict && importResolution === "skip") {
            return
          }

          const providerData = provider as Record<string, unknown>
          const normalized = {
            customName: String(providerData.customName || id),
            baseURL: String(providerData.baseURL || ""),
            apiKey: String(providerData.apiKey || ""),
            customModels: Array.isArray(providerData.customModels)
              ? providerData.customModels.filter((m): m is string => typeof m === "string")
              : [],
            defaultModel: String(providerData.defaultModel || ""),
            apiProtocol:
              (providerData.apiProtocol as "openai" | "anthropic" | "gemini") || "openai",
            enabled: providerData.enabled !== false,
          }

          // For existing providers, use update to avoid accidental duplication.
          if (hasConflict && importResolution === "merge") {
            const currentProvider = customProviders[id]
            updateCustomProvider(id, {
              customName: normalized.customName,
              baseURL: normalized.baseURL,
              apiKey: currentProvider?.apiKey || normalized.apiKey,
              customModels: normalized.customModels,
              defaultModel: normalized.defaultModel,
              apiProtocol: normalized.apiProtocol,
              enabled: normalized.enabled,
            })
          } else if (hasConflict) {
            updateCustomProvider(id, {
              customName: normalized.customName,
              baseURL: normalized.baseURL,
              apiKey: normalized.apiKey,
              customModels: normalized.customModels,
              defaultModel: normalized.defaultModel,
              apiProtocol: normalized.apiProtocol,
              enabled: normalized.enabled,
            })
          } else {
            // New custom provider path
            addCustomProvider({
              id,
              customName: normalized.customName,
              baseURL: normalized.baseURL,
              apiKey: normalized.apiKey,
              customModels: normalized.customModels,
              defaultModel: normalized.defaultModel,
              apiProtocol: normalized.apiProtocol,
              enabled: normalized.enabled,
            })
          }
        })
      }

      setImportSuccess(true)
      setTimeout(() => {
        setImportDialogOpen(false)
        setImportData(null)
        setImportConflicts([])
        setShowConflictWarning(false)
        onClose?.()
      }, 1500)
    } catch {
      setImportError(t("importErrors.importFailedRetry"))
    }
  }

  const selectedModelsCount = useMemo(() => {
    return selectedProviders.reduce((acc, id) => {
      const provider = availableProviders.find((p) => p.id === id)
      return acc + (provider?.modelsCount || 0)
    }, 0)
  }, [selectedProviders, availableProviders])

  return (
    <div className="flex items-center gap-2">
      {/* Export Button */}
      <Button variant="outline" size="sm" onClick={() => handleExportDialogOpen(true)}>
        <Download className="h-4 w-4 mr-2" />
        {t("export")}
      </Button>

      {/* Import Button with drag-drop zone */}
      <div
        ref={dropZoneRef}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <Button
          variant="outline"
          size="sm"
          onClick={() => fileInputRef.current?.click()}
          className={cn(isDragging && "ring-2 ring-primary")}
        >
          <Upload className="h-4 w-4 mr-2" />
          {t("import")}
        </Button>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        className="hidden"
        onChange={handleFileSelect}
      />

      {/* Export Dialog - Enhanced */}
      <Dialog open={exportDialogOpen} onOpenChange={handleExportDialogOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <div className="flex items-center justify-between">
              <DialogTitle className="text-lg font-semibold">
                {t("exportTitle") || "Export Settings"}
              </DialogTitle>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => setExportDialogOpen(false)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <DialogDescription>
              {t("exportDescription") ||
                "Select which providers to export. API keys can be optionally included."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Provider Selection */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">
                  {t("selectProviders") || "Select Providers"}
                </Label>
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-xs"
                  onClick={toggleSelectAll}
                >
                  {selectedProviders.length === availableProviders.length
                    ? t("deselectAll") || "Deselect All"
                    : t("selectAll") || "Select All"}
                </Button>
              </div>

              <ScrollArea className="h-[160px] rounded-md border p-2">
                <div className="space-y-2">
                  {availableProviders.map((provider) => (
                    <div
                      key={provider.id}
                      className={cn(
                        "flex items-center justify-between p-2 rounded-md transition-colors cursor-pointer",
                        selectedProviders.includes(provider.id)
                          ? "bg-primary/10"
                          : "hover:bg-muted/50"
                      )}
                      onClick={() => toggleProviderSelection(provider.id)}
                    >
                      <div className="flex items-center gap-2">
                        <Checkbox
                          checked={selectedProviders.includes(provider.id)}
                          onCheckedChange={() => toggleProviderSelection(provider.id)}
                        />
                        <span className="text-sm font-medium">{provider.name}</span>
                      </div>
                      <Badge variant="secondary" className="text-[10px]">
                        {provider.modelsCount} models
                      </Badge>
                    </div>
                  ))}
                </div>
              </ScrollArea>

              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {selectedProviders.length} of {availableProviders.length}{" "}
                  {t("providersSelected") || "providers selected"}
                </span>
                <span>
                  {selectedModelsCount} {t("modelsTotal") || "models total"}
                </span>
              </div>
            </div>

            {/* Export Format */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">{t("exportFormat") || "Export Format"}</Label>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setExportFormat("json")}
                  className={cn(
                    "flex items-center gap-2 px-3 py-2 rounded-md border text-sm transition-colors",
                    exportFormat === "json"
                      ? "bg-primary text-primary-foreground border-primary"
                      : "hover:bg-muted"
                  )}
                >
                  <FileJson className="h-4 w-4" />
                  JSON
                </button>
                <button
                  onClick={() => setExportFormat("env")}
                  className={cn(
                    "flex items-center gap-2 px-3 py-2 rounded-md border text-sm transition-colors",
                    exportFormat === "env"
                      ? "bg-primary text-primary-foreground border-primary"
                      : "hover:bg-muted"
                  )}
                >
                  <File className="h-4 w-4" />
                  .env
                </button>
              </div>
            </div>

            {/* Include API Keys */}
            <div
              className={cn(
                "flex items-start gap-3 p-3 rounded-lg border transition-colors",
                includeApiKeys ? "border-amber-500/50 bg-amber-500/10" : "border-border"
              )}
            >
              <Checkbox
                id="include-keys"
                checked={includeApiKeys}
                onCheckedChange={(checked) => setIncludeApiKeys(checked === true)}
                className="mt-0.5"
              />
              <div className="space-y-1">
                <Label htmlFor="include-keys" className="text-sm font-medium cursor-pointer">
                  {t("includeApiKeys") || "Include API Keys"}
                </Label>
                <p className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
                  <ShieldAlert className="h-3 w-3" />
                  {t("apiKeyWarning") || "Warning: Only enable if you trust the destination"}
                </p>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setExportDialogOpen(false)}>
              {t("cancel") || "Cancel"}
            </Button>
            <Button onClick={handleExport} disabled={selectedProviders.length === 0}>
              <Download className="h-4 w-4 mr-2" />
              {t("exportNow") || "Export"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Import Dialog - Enhanced */}
      <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <div className="flex items-center justify-between">
              <DialogTitle className="text-lg font-semibold">
                {t("importTitle") || "Import Settings"}
              </DialogTitle>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => setImportDialogOpen(false)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Drag & Drop Zone */}
            {!importData && !importError && (
              <div
                className={cn(
                  "flex flex-col items-center justify-center p-8 rounded-lg border-2 border-dashed transition-colors cursor-pointer",
                  isDragging
                    ? "border-primary bg-primary/5"
                    : "border-muted-foreground/30 hover:border-muted-foreground/50"
                )}
                onClick={() => fileInputRef.current?.click()}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                <Upload className="h-8 w-8 text-muted-foreground mb-3" />
                <p className="text-sm font-medium">
                  {t("dropFileHere") || "Drop JSON file here or click to browse"}
                </p>
                <p className="text-xs text-muted-foreground mt-1">cognia-providers-*.json</p>
              </div>
            )}

            {/* Error State */}
            {importError && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{importError}</AlertDescription>
              </Alert>
            )}

            {/* Success State */}
            {importSuccess && (
              <Alert className="border-green-500 bg-green-50 dark:bg-green-950">
                <Check className="h-4 w-4 text-green-600" />
                <AlertDescription className="text-green-600">
                  {t("importSuccess") || "Settings imported successfully!"}
                </AlertDescription>
              </Alert>
            )}

            {/* File Preview */}
            {importData && !importSuccess && (
              <div className="space-y-3">
                <div className="flex items-center justify-between p-3 rounded-lg bg-muted/50 border">
                  <div className="flex items-center gap-2">
                    <FileJson className="h-5 w-5 text-primary" />
                    <span className="text-sm font-medium truncate max-w-[200px]">
                      {importFileName || "settings.json"}
                    </span>
                  </div>
                  <Badge variant="success">
                    <Check className="h-3 w-3 mr-1" />
                    {t("valid") || "Valid"}
                  </Badge>
                </div>

                <div className="text-sm text-muted-foreground space-y-1">
                  <p>
                    {t("importProviderCount", {
                      count: Object.keys(importData.providerSettings || {}).length,
                    }) || `${Object.keys(importData.providerSettings || {}).length} providers`}
                  </p>
                  <p>
                    {t("importCustomCount", {
                      count: Object.keys(importData.customProviders || {}).length,
                    }) || `${Object.keys(importData.customProviders || {}).length} custom provider`}
                  </p>
                </div>

                {/* Conflict Warning */}
                {showConflictWarning && importConflicts.length > 0 && (
                  <div className="space-y-3">
                    <Alert className="border-amber-500/50 bg-amber-500/10">
                      <ShieldAlert className="h-4 w-4 text-amber-600" />
                      <AlertDescription className="text-amber-600 dark:text-amber-400">
                        {t("importConflictWarning") ||
                          `${importConflicts.length} conflict(s) detected with existing settings`}
                      </AlertDescription>
                    </Alert>

                    {/* Conflict List */}
                    <ScrollArea className="h-[100px] rounded-md border p-2">
                      <div className="space-y-2">
                        {importConflicts.map((conflict) => (
                          <div
                            key={conflict.id}
                            className="flex items-center justify-between text-xs p-1.5 rounded bg-muted/50"
                          >
                            <div>
                              <span className="font-medium">{conflict.name}</span>
                              <span className="text-muted-foreground ml-1">
                                (
                                {conflict.type === "custom"
                                  ? t("custom") || "Custom"
                                  : t("builtin") || "Built-in"}
                                )
                              </span>
                            </div>
                            <Badge variant="outline" className="text-[10px]">
                              {conflict.conflictType === "different_settings"
                                ? t("differentSettings") || "Different"
                                : t("exists") || "Exists"}
                            </Badge>
                          </div>
                        ))}
                      </div>
                    </ScrollArea>

                    {/* Resolution Options */}
                    <div className="space-y-2">
                      <Label className="text-xs font-medium">
                        {t("conflictResolution") || "Conflict Resolution"}
                      </Label>
                      <div className="grid grid-cols-3 gap-2">
                        <button
                          type="button"
                          onClick={() => setImportResolution("overwrite")}
                          className={cn(
                            "p-2 text-xs rounded-md border transition-colors",
                            importResolution === "overwrite"
                              ? "border-primary bg-primary/10 text-primary"
                              : "border-border hover:border-muted-foreground/50"
                          )}
                        >
                          {t("overwrite") || "Overwrite"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setImportResolution("skip")}
                          className={cn(
                            "p-2 text-xs rounded-md border transition-colors",
                            importResolution === "skip"
                              ? "border-primary bg-primary/10 text-primary"
                              : "border-border hover:border-muted-foreground/50"
                          )}
                        >
                          {t("skip") || "Skip"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setImportResolution("merge")}
                          className={cn(
                            "p-2 text-xs rounded-md border transition-colors",
                            importResolution === "merge"
                              ? "border-primary bg-primary/10 text-primary"
                              : "border-border hover:border-muted-foreground/50"
                          )}
                        >
                          {t("merge") || "Merge"}
                        </button>
                      </div>
                      <p className="text-[10px] text-muted-foreground">
                        {importResolution === "overwrite" &&
                          (t("overwriteDesc") || "Replace existing settings with imported values")}
                        {importResolution === "skip" &&
                          (t("skipDesc") || "Keep existing settings, skip conflicting imports")}
                        {importResolution === "merge" &&
                          (t("mergeDesc") || "Merge settings but keep existing API keys")}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setImportDialogOpen(false)
                setImportData(null)
                setImportError(null)
                setImportFileName(null)
              }}
            >
              {t("cancel") || "Cancel"}
            </Button>
            <Button onClick={handleImport} disabled={!importData || importSuccess}>
              <Upload className="h-4 w-4 mr-2" />
              {t("importNow") || "Import"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
