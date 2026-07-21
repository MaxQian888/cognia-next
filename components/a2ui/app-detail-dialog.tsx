"use client"

/**
 * A2UI App Detail Dialog Component
 * Displays detailed app information and metadata editing
 */

import React, { useState, useCallback, useMemo } from "react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import { formatAbsoluteTime } from "@/lib/a2ui/format"
import { CATEGORY_KEYS, CATEGORY_I18N_MAP } from "@/lib/a2ui/constants"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Calendar,
  Clock,
  Eye,
  Play,
  Star,
  User,
  Tag,
  FolderOpen,
  Info,
  Edit2,
  Save,
  X,
  RefreshCw,
  CheckCircle,
  AlertCircle,
  Sparkles,
  Loader2,
  Copy,
  ExternalLink,
} from "lucide-react"
import { toast } from "sonner"
import { loggers } from "@cognia/logging"
import type { A2UIAppInstance } from "@/hooks/a2ui/use-app-builder"
import type { AppDetailDialogProps } from "@/types/a2ui/app"

export type { AppDetailDialogProps } from "@/types/a2ui/app"

export function AppDetailDialog({
  app,
  template,
  open,
  onOpenChange,
  onSave,
  onGenerateThumbnail,
  onPreparePublish,
  onPublish,
  onUnpublish,
  className,
}: AppDetailDialogProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [editedData, setEditedData] = useState<Partial<A2UIAppInstance>>({})
  const [publishCheck, setPublishCheck] = useState<{ valid: boolean; missing: string[] } | null>(
    null
  )
  const [publishing, setPublishing] = useState(false)
  const [publishedUrl, setPublishedUrl] = useState<string | null>(null)
  const t = useTranslations("a2ui")

  const categoryOptions = useMemo(
    () => CATEGORY_KEYS.map((key) => ({ value: key, label: t(CATEGORY_I18N_MAP[key]) })),
    [t]
  )

  // Reset state when dialog opens/closes
  const handleOpenChange = useCallback(
    (newOpen: boolean) => {
      if (isSaving && !newOpen) return
      if (!newOpen) {
        setIsEditing(false)
        setEditedData({})
        setPublishCheck(null)
        setPublishedUrl(null)
      }
      onOpenChange(newOpen)
    },
    [isSaving, onOpenChange]
  )

  // Start editing
  const handleStartEdit = useCallback(() => {
    if (app) {
      setEditedData({
        name: app.name,
        description: app.description || "",
        version: app.version || "1.0.0",
        category: app.category || template?.category,
        tags: app.tags || template?.tags || [],
        author: app.author || {},
      })
      setIsEditing(true)
    }
  }, [app, template])

  // Cancel editing
  const handleCancelEdit = useCallback(() => {
    if (isSaving) return
    setEditedData({})
    setIsEditing(false)
  }, [isSaving])

  // Save changes
  const handleSave = useCallback(async () => {
    if (!app || !onSave || isSaving) return
    setIsSaving(true)
    try {
      const saved = await onSave(app.id, editedData)
      if (saved === false) throw new Error(`App metadata target not found: ${app.id}`)
      setIsEditing(false)
    } catch (error) {
      loggers.ui.error("[AppDetailDialog] Failed to save app metadata:", error)
      toast.error(t("saveFailed"))
    } finally {
      setIsSaving(false)
    }
  }, [app, editedData, isSaving, onSave, t])

  // Check publish readiness
  const handleCheckPublish = useCallback(() => {
    if (app && onPreparePublish) {
      const result = onPreparePublish(app.id)
      setPublishCheck(result)
    }
  }, [app, onPreparePublish])

  // Publish → mint a durable hosted share link.
  const handlePublish = useCallback(async () => {
    if (!app || !onPublish || publishing) return
    setPublishing(true)
    try {
      const outcome = await onPublish(app.id)
      if (outcome.ok) {
        setPublishedUrl(outcome.url)
        setPublishCheck({ valid: true, missing: [] })
        toast.success(t("publishSuccess"))
      } else if (outcome.reason === "invalid") {
        setPublishCheck({ valid: false, missing: outcome.missing })
      } else if (outcome.reason === "not-configured") {
        toast.error(t("shareNotConfigured"))
      } else {
        toast.error(t("publishFailed"))
      }
    } catch (error) {
      loggers.ui.error("[AppDetailDialog] Failed to publish app:", error)
      toast.error(t("publishFailed"))
    } finally {
      setPublishing(false)
    }
  }, [app, onPublish, publishing, t])

  // Unpublish → revoke the hosted link and clear published state.
  const handleUnpublish = useCallback(async () => {
    if (!app || !onUnpublish || publishing) return
    setPublishing(true)
    try {
      await onUnpublish(app.id)
      setPublishedUrl(null)
      toast.success(t("unpublishSuccess"))
    } catch (error) {
      loggers.ui.error("[AppDetailDialog] Failed to unpublish app:", error)
      toast.error(t("publishFailed"))
    } finally {
      setPublishing(false)
    }
  }, [app, onUnpublish, publishing, t])

  const handleCopyPublishedUrl = useCallback(async () => {
    if (!publishedUrl) return
    try {
      await navigator.clipboard.writeText(publishedUrl)
      toast.success(t("copied"))
    } catch (error) {
      loggers.ui.error("[AppDetailDialog] clipboard write failed:", error)
    }
  }, [publishedUrl, t])

  const formatDate = formatAbsoluteTime

  // Update edited field
  const updateField = useCallback((field: keyof A2UIAppInstance, value: unknown) => {
    setEditedData((prev) => ({ ...prev, [field]: value }))
  }, [])

  // Update author field
  const updateAuthorField = useCallback((field: string, value: string) => {
    setEditedData((prev) => ({
      ...prev,
      author: { ...(prev.author || {}), [field]: value },
    }))
  }, [])

  // Update tags
  const handleTagsChange = useCallback(
    (tagsString: string) => {
      const tags = tagsString
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
      updateField("tags", tags)
    },
    [updateField]
  )

  if (!app) return null

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className={cn("max-w-2xl max-h-[90vh] overflow-y-auto", className)}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Info className="h-5 w-5" />
            {t("appDetailTitle")}
          </DialogTitle>
          <DialogDescription>{t("appDetailDescription")}</DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="info" className="mt-4">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="info">{t("basicInfo")}</TabsTrigger>
            <TabsTrigger value="metadata">{t("metadata")}</TabsTrigger>
            <TabsTrigger value="publish">{t("publishPrep")}</TabsTrigger>
          </TabsList>

          {/* Basic Info Tab */}
          <TabsContent value="info" className="space-y-4 mt-4">
            {/* Thumbnail */}
            <div className="flex gap-4">
              <div className="w-40 h-28 rounded-lg overflow-hidden bg-muted flex-shrink-0">
                {app.thumbnail ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={app.thumbnail} alt={app.name} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <Sparkles className="h-8 w-8 text-muted-foreground/50" />
                  </div>
                )}
              </div>
              <div className="flex-1 space-y-2">
                {isEditing ? (
                  <>
                    <div>
                      <Label>{t("appName")}</Label>
                      <Input
                        value={editedData.name || ""}
                        onChange={(e) => updateField("name", e.target.value)}
                        placeholder={t("appName")}
                      />
                    </div>
                    <div>
                      <Label>{t("versionNumber")}</Label>
                      <Input
                        value={editedData.version || ""}
                        onChange={(e) => updateField("version", e.target.value)}
                        placeholder={t("versionPlaceholder")}
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <h3 className="text-lg font-semibold">{app.name}</h3>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Badge variant="secondary">{template?.name || t("customApp")}</Badge>
                      {app.version && <Badge variant="outline">v{app.version}</Badge>}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onGenerateThumbnail?.(app.id)}
                    >
                      <RefreshCw className="h-3 w-3 mr-1" />
                      {t("refreshThumbnail")}
                    </Button>
                  </>
                )}
              </div>
            </div>

            <Separator />

            {/* Description */}
            <div>
              <Label>{t("appDescription")}</Label>
              {isEditing ? (
                <Textarea
                  value={editedData.description || ""}
                  onChange={(e) => updateField("description", e.target.value)}
                  placeholder={t("descriptionPlaceholder")}
                  rows={3}
                  className="mt-1"
                />
              ) : (
                <p className="text-sm text-muted-foreground mt-1">
                  {app.description || t("noDescription")}
                </p>
              )}
            </div>

            {/* Category */}
            <div>
              <Label>{t("category")}</Label>
              {isEditing ? (
                <Select
                  value={editedData.category || ""}
                  onValueChange={(value) => updateField("category", value)}
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder={t("selectCategory")} />
                  </SelectTrigger>
                  <SelectContent>
                    {categoryOptions.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <div className="flex items-center gap-2 mt-1">
                  <FolderOpen className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm">
                    {categoryOptions.find((c) => c.value === (app.category || template?.category))
                      ?.label || t("uncategorized")}
                  </span>
                </div>
              )}
            </div>

            {/* Tags */}
            <div>
              <Label>{t("tags")}</Label>
              {isEditing ? (
                <Input
                  value={(editedData.tags || []).join(", ")}
                  onChange={(e) => handleTagsChange(e.target.value)}
                  placeholder={t("tagsPlaceholder")}
                  className="mt-1"
                />
              ) : (
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <Tag className="h-4 w-4 text-muted-foreground" />
                  {(app.tags || template?.tags || []).length > 0 ? (
                    (app.tags || template?.tags || []).map((tag) => (
                      <Badge key={tag} variant="outline" className="text-xs">
                        {tag}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-sm text-muted-foreground">{t("noTags")}</span>
                  )}
                </div>
              )}
            </div>

            {/* Timestamps */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="flex items-center gap-1">
                  <Calendar className="h-3 w-3" />
                  {t("createdAt")}
                </Label>
                <p className="text-sm text-muted-foreground mt-1">{formatDate(app.createdAt)}</p>
              </div>
              <div>
                <Label className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {t("lastModified")}
                </Label>
                <p className="text-sm text-muted-foreground mt-1">{formatDate(app.lastModified)}</p>
              </div>
            </div>
          </TabsContent>

          {/* Metadata Tab */}
          <TabsContent value="metadata" className="space-y-4 mt-4">
            {/* Author Info */}
            <div className="space-y-3">
              <Label className="flex items-center gap-1">
                <User className="h-4 w-4" />
                {t("authorInfo")}
              </Label>
              {isEditing ? (
                <div className="space-y-2 pl-5">
                  <div>
                    <Label className="text-xs">{t("nameLabel")}</Label>
                    <Input
                      value={editedData.author?.name || ""}
                      onChange={(e) => updateAuthorField("name", e.target.value)}
                      placeholder={t("namePlaceholder")}
                      className="h-8"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">{t("emailLabel")}</Label>
                    <Input
                      value={editedData.author?.email || ""}
                      onChange={(e) => updateAuthorField("email", e.target.value)}
                      placeholder={t("emailPlaceholder")}
                      className="h-8"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">{t("urlLabel")}</Label>
                    <Input
                      value={editedData.author?.url || ""}
                      onChange={(e) => updateAuthorField("url", e.target.value)}
                      placeholder={t("urlPlaceholder")}
                      className="h-8"
                    />
                  </div>
                </div>
              ) : (
                <div className="text-sm text-muted-foreground pl-5 space-y-1">
                  {app.author?.name ? (
                    <>
                      <p>
                        {t("nameLabel")}: {app.author.name}
                      </p>
                      {app.author.email && (
                        <p>
                          {t("emailLabel")}: {app.author.email}
                        </p>
                      )}
                      {app.author.url && (
                        <p>
                          {t("urlLabel")}: {app.author.url}
                        </p>
                      )}
                    </>
                  ) : (
                    <p>{t("noAuthorInfo")}</p>
                  )}
                </div>
              )}
            </div>

            <Separator />

            {/* Statistics */}
            <div>
              <Label>{t("statistics")}</Label>
              <div className="grid grid-cols-4 gap-4 mt-2">
                <div className="text-center p-3 rounded-lg bg-muted">
                  <Eye className="h-5 w-5 mx-auto mb-1 text-muted-foreground" />
                  <p className="text-lg font-semibold">{app.stats?.views || 0}</p>
                  <p className="text-xs text-muted-foreground">{t("statsViews")}</p>
                </div>
                <div className="text-center p-3 rounded-lg bg-muted">
                  <Play className="h-5 w-5 mx-auto mb-1 text-muted-foreground" />
                  <p className="text-lg font-semibold">{app.stats?.uses || 0}</p>
                  <p className="text-xs text-muted-foreground">{t("statsUses")}</p>
                </div>
                <div className="text-center p-3 rounded-lg bg-muted">
                  <Star className="h-5 w-5 mx-auto mb-1 text-yellow-500" />
                  <p className="text-lg font-semibold">{app.stats?.rating?.toFixed(1) || "-"}</p>
                  <p className="text-xs text-muted-foreground">{t("statsRating")}</p>
                </div>
                <div className="text-center p-3 rounded-lg bg-muted">
                  <User className="h-5 w-5 mx-auto mb-1 text-muted-foreground" />
                  <p className="text-lg font-semibold">{app.stats?.ratingCount || 0}</p>
                  <p className="text-xs text-muted-foreground">{t("statsRatingCount")}</p>
                </div>
              </div>
            </div>

            <Separator />

            {/* Template Info */}
            <div>
              <Label>{t("templateInfo")}</Label>
              <div className="text-sm text-muted-foreground mt-2 space-y-1">
                <p>
                  {t("templateId")}: {app.templateId}
                </p>
                {template && (
                  <>
                    <p>
                      {t("templateName")}: {template.name}
                    </p>
                    <p>
                      {t("templateDescription")}: {template.description}
                    </p>
                  </>
                )}
              </div>
            </div>
          </TabsContent>

          {/* Publish Tab */}
          <TabsContent value="publish" className="space-y-4 mt-4">
            <div className="text-center py-4">
              <h4 className="font-medium mb-2">{t("publishReadyTitle")}</h4>
              <p className="text-sm text-muted-foreground mb-4">{t("publishReadyDescription")}</p>
              <div className="flex items-center justify-center gap-2">
                <Button variant="outline" onClick={handleCheckPublish} disabled={publishing}>
                  <CheckCircle className="h-4 w-4 mr-2" />
                  {t("checkPublish")}
                </Button>
                {app.isPublished ? (
                  <Button variant="destructive" onClick={handleUnpublish} disabled={publishing}>
                    {publishing ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <X className="h-4 w-4 mr-2" />
                    )}
                    {t("unpublish")}
                  </Button>
                ) : (
                  <Button onClick={handlePublish} disabled={publishing || !onPublish}>
                    {publishing ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Sparkles className="h-4 w-4 mr-2" />
                    )}
                    {t("publish")}
                  </Button>
                )}
              </div>
            </div>

            {publishedUrl && (
              <div className="p-4 rounded-lg bg-green-50 dark:bg-green-950 space-y-2">
                <div className="flex items-center gap-2 text-green-700 dark:text-green-300">
                  <CheckCircle className="h-5 w-5" />
                  <span className="font-medium">{t("publishSuccess")}</span>
                </div>
                <div className="flex gap-2">
                  <Input
                    readOnly
                    value={publishedUrl}
                    aria-label={t("publishedLink")}
                    className="font-mono text-xs"
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label={t("copyLink")}
                    onClick={handleCopyPublishedUrl}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                  <Button asChild variant="outline" size="icon" aria-label={t("openLink")}>
                    <a href={publishedUrl} target="_blank" rel="noreferrer">
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">{t("publishLinkOnceHint")}</p>
              </div>
            )}

            {publishCheck && !publishCheck.valid && (
              <div className="p-4 rounded-lg bg-yellow-50 dark:bg-yellow-950">
                <div className="flex items-center gap-2 text-yellow-700 dark:text-yellow-300 mb-2">
                  <AlertCircle className="h-5 w-5" />
                  <span className="font-medium">{t("publishMissing")}</span>
                </div>
                <ul className="list-disc list-inside text-sm text-yellow-600 dark:text-yellow-400 space-y-1">
                  {publishCheck.missing.map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </ul>
              </div>
            )}

            {publishCheck?.valid && !publishedUrl && !app.isPublished && (
              <div className="p-4 rounded-lg bg-green-50 dark:bg-green-950">
                <div className="flex items-center gap-2 text-green-700 dark:text-green-300">
                  <CheckCircle className="h-5 w-5" />
                  <span className="font-medium">{t("publishReady")}</span>
                </div>
              </div>
            )}

            {app.isPublished && (
              <div className="text-center p-4 bg-muted rounded-lg">
                <Badge variant="default" className="mb-2">
                  {t("published")}
                </Badge>
                <p className="text-sm text-muted-foreground">
                  {t("publishedAt")}: {app.publishedAt ? formatDate(app.publishedAt) : "-"}
                </p>
                {app.storeId && (
                  <p className="text-xs text-muted-foreground mt-1">
                    {t("storeId")}: {app.storeId}
                  </p>
                )}
              </div>
            )}
          </TabsContent>
        </Tabs>

        <DialogFooter className="mt-4">
          {isEditing ? (
            <>
              <Button variant="outline" onClick={handleCancelEdit} disabled={isSaving}>
                <X className="h-4 w-4 mr-1" />
                {t("cancel")}
              </Button>
              <Button onClick={handleSave} disabled={isSaving}>
                {isSaving ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <Save className="h-4 w-4 mr-1" />
                )}
                {isSaving ? t("saving") : t("save")}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                {t("close")}
              </Button>
              <Button onClick={handleStartEdit}>
                <Edit2 className="h-4 w-4 mr-1" />
                {t("editInfo")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
