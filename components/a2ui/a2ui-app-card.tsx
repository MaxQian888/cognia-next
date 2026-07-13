"use client"

/**
 * A2UI App Card Component
 * Displays an app with thumbnail, metadata, and actions
 */

import React, { useState, useCallback, useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import { resolveIcon } from "@/lib/a2ui/resolve-icon"
import { Button } from "@/components/ui/button"
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  MoreVertical,
  Play,
  Copy,
  Trash2,
  Edit2,
  RefreshCw,
  Clock,
  Eye,
  Star,
  Image as ImageIcon,
  Info,
  Share2,
  Sparkles,
} from "lucide-react"
import { loggers } from "@cognia/logging"
import { generatePlaceholderThumbnail, captureSurfaceThumbnail } from "@/lib/a2ui/thumbnail"
import { formatRelativeTime } from "@/lib/a2ui/format"
import type { AppCardProps } from "@/types/a2ui/app"

export type { AppCardProps } from "@/types/a2ui/app"

export function AppCard({
  app,
  template,
  isSelected = false,
  showThumbnail = true,
  showStats = true,
  showDescription = true,
  compact = false,
  onSelect,
  onOpen,
  onRename,
  onDuplicate,
  onDelete,
  onReset,
  onShare,
  onViewDetails,
  onThumbnailGenerated,
  className,
}: AppCardProps) {
  const t = useTranslations("a2ui")
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(app.thumbnail || null)
  const [isGeneratingThumbnail, setIsGeneratingThumbnail] = useState(false)
  const thumbnailGenerated = useRef(false)

  const IconComponent = resolveIcon(template?.icon)

  // Generate placeholder thumbnail if needed
  useEffect(() => {
    if (showThumbnail && !thumbnailUrl && !thumbnailGenerated.current) {
      thumbnailGenerated.current = true
      const placeholder = generatePlaceholderThumbnail(template?.icon || "Sparkles", app.name)
      setThumbnailUrl(placeholder)
    }
  }, [showThumbnail, thumbnailUrl, template?.icon, app.name])

  // Handle thumbnail generation
  const handleGenerateThumbnail = useCallback(async () => {
    if (isGeneratingThumbnail) return

    setIsGeneratingThumbnail(true)
    try {
      const result = await captureSurfaceThumbnail(app.id)
      if (result) {
        setThumbnailUrl(result.dataUrl)
        onThumbnailGenerated?.(app.id, result.dataUrl)
      }
    } catch (error) {
      loggers.ui.error("[AppCard] Failed to generate thumbnail:", error)
    } finally {
      setIsGeneratingThumbnail(false)
    }
  }, [app.id, isGeneratingThumbnail, onThumbnailGenerated])

  // Handle card click
  const handleCardClick = useCallback(() => {
    onSelect?.(app.id)
  }, [app.id, onSelect])

  // Render thumbnail
  const renderThumbnail = () => {
    if (!showThumbnail) return null

    return (
      <div
        className={cn(
          "relative w-full overflow-hidden bg-muted",
          compact ? "h-24" : "h-36",
          "rounded-t-lg"
        )}
      >
        {thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumbnailUrl} alt={app.name} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Sparkles className="h-8 w-8 text-muted-foreground/50" />
          </div>
        )}

        {/* Thumbnail refresh button */}
        <Button
          size="icon"
          variant="secondary"
          className="absolute bottom-2 right-2 h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={(e) => {
            e.stopPropagation()
            handleGenerateThumbnail()
          }}
          disabled={isGeneratingThumbnail}
        >
          <ImageIcon className={cn("h-3.5 w-3.5", isGeneratingThumbnail && "animate-pulse")} />
        </Button>

        {/* Version badge */}
        {app.version && (
          <Badge variant="secondary" className="absolute top-2 left-2 text-xs">
            v{app.version}
          </Badge>
        )}
      </div>
    )
  }

  // Render stats
  const renderStats = () => {
    if (!showStats || !app.stats) return null

    const { views, uses, rating, ratingCount } = app.stats

    return (
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        {views !== undefined && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex items-center gap-1">
                <Eye className="h-3 w-3" />
                {views}
              </span>
            </TooltipTrigger>
            <TooltipContent>{t("views")}</TooltipContent>
          </Tooltip>
        )}
        {uses !== undefined && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex items-center gap-1">
                <Play className="h-3 w-3" />
                {uses}
              </span>
            </TooltipTrigger>
            <TooltipContent>{t("uses")}</TooltipContent>
          </Tooltip>
        )}
        {rating !== undefined && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex items-center gap-1">
                <Star className="h-3 w-3 fill-yellow-400 text-yellow-400" />
                {rating.toFixed(1)}
                {ratingCount !== undefined && (
                  <span className="text-muted-foreground/70">({ratingCount})</span>
                )}
              </span>
            </TooltipTrigger>
            <TooltipContent>{t("rating")}</TooltipContent>
          </Tooltip>
        )}
      </div>
    )
  }

  // Render tags
  const renderTags = () => {
    const tags = app.tags || template?.tags
    if (!tags || tags.length === 0) return null

    return (
      <div className="flex flex-wrap gap-1 mt-2">
        {tags.slice(0, 3).map((tag) => (
          <Badge key={tag} variant="outline" className="text-xs py-0">
            {tag}
          </Badge>
        ))}
        {tags.length > 3 && (
          <Badge variant="outline" className="text-xs py-0">
            +{tags.length - 3}
          </Badge>
        )}
      </div>
    )
  }

  return (
    <Card
      className={cn(
        "group relative transition-all hover:shadow-md active:shadow-md cursor-pointer touch-manipulation",
        isSelected && "ring-2 ring-primary shadow-md",
        className
      )}
      onClick={handleCardClick}
    >
      {/* Thumbnail */}
      {renderThumbnail()}

      <CardHeader className={cn("p-3", compact && "p-2")}>
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {/* Icon (shown only when thumbnail is hidden) */}
            {!showThumbnail && (
              <div
                className={cn(
                  "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
                  isSelected ? "bg-primary/20" : "bg-muted"
                )}
              >
                {IconComponent ? (
                  React.createElement(IconComponent, {
                    className: cn("h-4 w-4", isSelected ? "text-primary" : "text-muted-foreground"),
                  })
                ) : (
                  <Sparkles
                    className={cn("h-4 w-4", isSelected ? "text-primary" : "text-muted-foreground")}
                  />
                )}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <CardTitle className={cn("truncate", compact ? "text-xs" : "text-sm")}>
                {app.name}
              </CardTitle>
              <CardDescription className="text-xs truncate">
                {template?.name || app.category || "Custom App"}
              </CardDescription>
            </div>
          </div>

          {/* Actions dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8 shrink-0 sm:opacity-0 sm:group-hover:opacity-100 touch-manipulation"
              >
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onOpen?.(app.id)}>
                <Play className="h-4 w-4 mr-2" />
                {t("run")}
              </DropdownMenuItem>
              {onViewDetails && (
                <DropdownMenuItem onClick={() => onViewDetails(app)}>
                  <Info className="h-4 w-4 mr-2" />
                  {t("appDetail")}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => onRename?.(app)}>
                <Edit2 className="h-4 w-4 mr-2" />
                {t("appName")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onDuplicate?.(app.id)}>
                <Copy className="h-4 w-4 mr-2" />
                {t("duplicate")}
              </DropdownMenuItem>
              {onShare && (
                <DropdownMenuItem onClick={() => onShare(app.id)}>
                  <Share2 className="h-4 w-4 mr-2" />
                  {t("share")}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => onReset?.(app.id)}>
                <RefreshCw className="h-4 w-4 mr-2" />
                {t("reset")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive" onClick={() => onDelete?.(app.id)}>
                <Trash2 className="h-4 w-4 mr-2" />
                {t("delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Description */}
        {showDescription && app.description && !compact && (
          <p className="text-xs text-muted-foreground line-clamp-2 mt-2">{app.description}</p>
        )}

        {/* Tags */}
        {!compact && renderTags()}
      </CardHeader>

      <CardFooter className={cn("pt-0 px-3", compact ? "pb-2" : "pb-3")}>
        <div className="flex items-center justify-between w-full gap-2">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock className="h-3 w-3 flex-shrink-0" />
            <span className="truncate">{formatRelativeTime(app.lastModified)}</span>
          </div>

          {/* Stats or category badge */}
          {showStats && app.stats
            ? renderStats()
            : template &&
              !compact && (
                <Badge variant="outline" className="text-xs py-0 hidden sm:inline-flex">
                  {app.category || template.category}
                </Badge>
              )}
        </div>
      </CardFooter>
    </Card>
  )
}
