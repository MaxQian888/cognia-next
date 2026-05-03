"use client"

/**
 * OpenRouter API Key Management Component
 * Uses the Provisioning API to list, create, update, and delete API keys
 * https://openrouter.ai/docs/guides/overview/auth/provisioning-api-keys
 */

import { useState, useEffect, useCallback, useMemo } from "react"
import { useTranslations } from "next-intl"
import {
  Key,
  Plus,
  Trash2,
  RefreshCw,
  ExternalLink,
  AlertCircle,
  Loader2,
  MoreHorizontal,
  Copy,
  Check,
  Power,
  PowerOff,
} from "lucide-react"
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { useSettingsStore } from "@/stores"
import type { OpenRouterExtendedSettings } from "@/types/provider"
import type { OpenRouterApiKey, LimitResetPeriod } from "@/types/provider/openrouter"
import {
  listApiKeys,
  createApiKey,
  updateApiKey,
  deleteApiKey,
  formatCredits,
  OpenRouterError,
} from "@/lib/ai/providers/openrouter"

interface OpenRouterKeyManagementProps {
  className?: string
}

export function OpenRouterKeyManagement({ className }: OpenRouterKeyManagementProps) {
  const t = useTranslations("providers")
  const providerSettings = useSettingsStore((state) => state.providerSettings)
  const updateProviderSettings = useSettingsStore((state) => state.updateProviderSettings)

  const settings = providerSettings.openrouter
  const openRouterSettings = useMemo(
    () => settings?.openRouterSettings || {},
    [settings?.openRouterSettings]
  )
  const provisioningKey = openRouterSettings.provisioningApiKey

  const [keys, setKeys] = useState<OpenRouterApiKey[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false)
  const [newKeyName, setNewKeyName] = useState("")
  const [newKeyLimit, setNewKeyLimit] = useState<string>("")
  const [newKeyLimitReset, setNewKeyLimitReset] = useState<LimitResetPeriod>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [createdKey, setCreatedKey] = useState<string | null>(null)
  const [copiedKeyId, setCopiedKeyId] = useState<string | null>(null)

  const updateOpenRouterSettings = useCallback(
    (updates: Partial<OpenRouterExtendedSettings>) => {
      updateProviderSettings("openrouter", {
        openRouterSettings: {
          ...openRouterSettings,
          ...updates,
        },
      })
    },
    [openRouterSettings, updateProviderSettings]
  )

  const fetchKeys = useCallback(async () => {
    if (!provisioningKey) return

    setIsLoading(true)
    setError(null)

    try {
      const fetchedKeys = await listApiKeys(provisioningKey)
      setKeys(fetchedKeys)
    } catch (err) {
      if (err instanceof OpenRouterError) {
        setError(err.message)
      } else {
        setError("Failed to fetch API keys")
      }
    } finally {
      setIsLoading(false)
    }
  }, [provisioningKey])

  useEffect(() => {
    if (!provisioningKey) return
    const timer = setTimeout(() => {
      fetchKeys()
    }, 0)
    return () => clearTimeout(timer)
  }, [provisioningKey, fetchKeys])

  const handleCreateKey = async () => {
    if (!provisioningKey || !newKeyName) return

    setIsCreating(true)
    setError(null)

    try {
      const result = await createApiKey(provisioningKey, {
        name: newKeyName,
        limit: newKeyLimit ? parseFloat(newKeyLimit) : undefined,
        limit_reset: newKeyLimitReset,
      })

      setCreatedKey(result.key)
      setKeys((prev) => [result, ...prev])
      setNewKeyName("")
      setNewKeyLimit("")
      setNewKeyLimitReset(null)
    } catch (err) {
      if (err instanceof OpenRouterError) {
        setError(err.message)
      } else {
        setError("Failed to create API key")
      }
    } finally {
      setIsCreating(false)
    }
  }

  const handleToggleKey = async (key: OpenRouterApiKey) => {
    if (!provisioningKey) return

    try {
      const updated = await updateApiKey(provisioningKey, key.hash, {
        disabled: !key.disabled,
      })
      setKeys((prev) => prev.map((k) => (k.hash === key.hash ? updated : k)))
    } catch (err) {
      if (err instanceof OpenRouterError) {
        setError(err.message)
      } else {
        setError("Failed to update API key")
      }
    }
  }

  const handleDeleteKey = async (keyHash: string) => {
    if (!provisioningKey) return

    try {
      await deleteApiKey(provisioningKey, keyHash)
      setKeys((prev) => prev.filter((k) => k.hash !== keyHash))
    } catch (err) {
      if (err instanceof OpenRouterError) {
        setError(err.message)
      } else {
        setError("Failed to delete API key")
      }
    }
  }

  const copyToClipboard = async (text: string, id: string) => {
    await navigator.clipboard.writeText(text)
    setCopiedKeyId(id)
    setTimeout(() => setCopiedKeyId(null), 2000)
  }

  const closeCreateDialog = () => {
    setIsCreateDialogOpen(false)
    setCreatedKey(null)
    setNewKeyName("")
    setNewKeyLimit("")
    setNewKeyLimitReset(null)
  }

  return (
    <Card className={className}>
      <CardHeader className="py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Key className="h-4 w-4" />
            <CardTitle className="text-sm">{t("keyManagement.title")}</CardTitle>
          </div>
          <div className="flex items-center gap-2">
            {provisioningKey && (
              <Button variant="ghost" size="sm" onClick={fetchKeys} disabled={isLoading}>
                {isLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
              </Button>
            )}
            <a
              href="https://openrouter.ai/settings/provisioning"
              target="_blank"
              rel="noopener noreferrer"
            >
              <Button variant="ghost" size="sm">
                <ExternalLink className="h-4 w-4" />
              </Button>
            </a>
          </div>
        </div>
        <CardDescription className="text-xs">{t("keyManagement.description")}</CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        {/* Provisioning Key Input */}
        <div className="space-y-3 mb-4">
          <div>
            <Label htmlFor="provisioning-key" className="text-xs">
              {t("keyManagement.provisioningApiKey")}
            </Label>
            <Input
              id="provisioning-key"
              type="password"
              placeholder="sk-or-v1-..."
              value={provisioningKey || ""}
              onChange={(e) => updateOpenRouterSettings({ provisioningApiKey: e.target.value })}
              className="mt-1"
              autoComplete="new-password"
              data-lpignore="true"
              data-form-type="other"
            />
            <p className="text-xs text-muted-foreground mt-1">
              {t("keyManagement.provisioningKeyHint")}{" "}
              <a
                href="https://openrouter.ai/settings/provisioning"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                openrouter.ai/settings/provisioning
              </a>
            </p>
          </div>
        </div>

        {error && (
          <div className="flex items-center gap-2 text-sm text-destructive mb-4 p-2 bg-destructive/10 rounded">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
        )}

        {provisioningKey && (
          <>
            {/* Create Key Dialog */}
            <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
              <DialogTrigger asChild>
                <Button size="sm" className="w-full mb-4">
                  <Plus className="h-4 w-4 mr-2" />
                  {t("keyManagement.createNewKey")}
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>{t("keyManagement.createKey")}</DialogTitle>
                  <DialogDescription>{t("keyManagement.createKeyDesc")}</DialogDescription>
                </DialogHeader>

                {createdKey ? (
                  <div className="space-y-4">
                    <div className="p-4 bg-green-50 dark:bg-green-900/20 rounded-lg border border-green-200 dark:border-green-800">
                      <p className="text-sm font-medium text-green-800 dark:text-green-200 mb-2">
                        {t("keyManagement.keyCreatedSuccess")}
                      </p>
                      <p className="text-xs text-green-600 dark:text-green-400 mb-3">
                        {t("keyManagement.keyCreatedHint")}
                      </p>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 text-xs bg-white dark:bg-gray-900 p-2 rounded border break-all">
                          {createdKey}
                        </code>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => copyToClipboard(createdKey, "new")}
                        >
                          {copiedKeyId === "new" ? (
                            <Check className="h-4 w-4" />
                          ) : (
                            <Copy className="h-4 w-4" />
                          )}
                        </Button>
                      </div>
                    </div>
                    <DialogFooter>
                      <Button onClick={closeCreateDialog}>{t("done")}</Button>
                    </DialogFooter>
                  </div>
                ) : (
                  <>
                    <div className="space-y-4">
                      <div>
                        <Label htmlFor="key-name">{t("name")}</Label>
                        <Input
                          id="key-name"
                          placeholder="My API Key"
                          value={newKeyName}
                          onChange={(e) => setNewKeyName(e.target.value)}
                        />
                      </div>
                      <div>
                        <Label htmlFor="key-limit">{t("keyManagement.creditLimit")}</Label>
                        <Input
                          id="key-limit"
                          type="number"
                          step="0.01"
                          placeholder="e.g., 10.00"
                          value={newKeyLimit}
                          onChange={(e) => setNewKeyLimit(e.target.value)}
                        />
                        <p className="text-xs text-muted-foreground mt-1">
                          {t("keyManagement.creditLimitHint")}
                        </p>
                      </div>
                      <div>
                        <Label htmlFor="limit-reset">{t("keyManagement.limitResetPeriod")}</Label>
                        <Select
                          value={newKeyLimitReset || "none"}
                          onValueChange={(v) =>
                            setNewKeyLimitReset(v === "none" ? null : (v as LimitResetPeriod))
                          }
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="No reset" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">{t("keyManagement.noReset")}</SelectItem>
                            <SelectItem value="daily">{t("keyManagement.daily")}</SelectItem>
                            <SelectItem value="weekly">{t("keyManagement.weekly")}</SelectItem>
                            <SelectItem value="monthly">{t("keyManagement.monthly")}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={closeCreateDialog}>
                        {t("cancel")}
                      </Button>
                      <Button onClick={handleCreateKey} disabled={!newKeyName || isCreating}>
                        {isCreating && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                        {t("keyManagement.createKey")}
                      </Button>
                    </DialogFooter>
                  </>
                )}
              </DialogContent>
            </Dialog>

            {/* Keys Table */}
            {keys.length > 0 ? (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs">{t("name")}</TableHead>
                      <TableHead className="text-xs">{t("usage")}</TableHead>
                      <TableHead className="text-xs">{t("limit")}</TableHead>
                      <TableHead className="text-xs">{t("status.unknown")}</TableHead>
                      <TableHead className="text-xs w-[50px]"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {keys.map((key) => (
                      <TableRow key={key.hash}>
                        <TableCell className="text-xs">
                          <div>
                            <p className="font-medium">{key.name}</p>
                            <p className="text-muted-foreground">{key.label}</p>
                          </div>
                        </TableCell>
                        <TableCell className="text-xs">{formatCredits(key.usage)}</TableCell>
                        <TableCell className="text-xs">
                          {key.limit !== null ? (
                            <div>
                              <p>{formatCredits(key.limit)}</p>
                              {key.limit_reset && (
                                <p className="text-muted-foreground capitalize">
                                  {key.limit_reset} reset
                                </p>
                              )}
                            </div>
                          ) : (
                            <span className="text-muted-foreground">{t("unlimited")}</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant={key.disabled ? "secondary" : "default"}>
                            {key.disabled ? t("disabled") : t("active")}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-8 w-8">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => handleToggleKey(key)}>
                                {key.disabled ? (
                                  <>
                                    <Power className="h-4 w-4 mr-2" />
                                    {t("enable")}
                                  </>
                                ) : (
                                  <>
                                    <PowerOff className="h-4 w-4 mr-2" />
                                    {t("disable")}
                                  </>
                                )}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                className="text-destructive"
                                onClick={() => handleDeleteKey(key.hash)}
                              >
                                <Trash2 className="h-4 w-4 mr-2" />
                                {t("delete")}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="text-center py-8 text-sm text-muted-foreground">
                {isLoading ? (
                  <Loader2 className="h-6 w-6 animate-spin mx-auto" />
                ) : (
                  <p>{t("keyManagement.noKeysFound")}</p>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
