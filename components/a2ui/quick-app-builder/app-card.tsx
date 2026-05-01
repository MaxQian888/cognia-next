"use client"

import React, { memo, useState, useCallback } from "react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Sparkles,
  Play,
  Copy,
  Download,
  Trash2,
  Share2,
  Link,
  FileJson,
  Check,
  Send,
  Users,
  Mail,
  MessageCircle,
} from "lucide-react"
import { resolveIcon } from "@/lib/a2ui/resolve-icon"
import type { QuickAppCardProps as AppCardProps } from "@/types/a2ui/app"

export const QuickAppCard = memo(function QuickAppCard({
  app,
  template,
  isActive,
  viewMode,
  onSelect,
  onDuplicate,
  onDownload,
  onDelete,
  onCopyToClipboard,
  onNativeShare,
  onSocialShare,
}: AppCardProps) {
  const t = useTranslations("a2ui")
  const [shareMenuOpen, setShareMenuOpen] = useState(false)
  const [copiedFormat, setCopiedFormat] = useState<string | null>(null)

  const IconComponent = resolveIcon(template?.icon)

  const handleCopy = useCallback(
    async (format: "json" | "code" | "url") => {
      const success = await onCopyToClipboard(app.id, format)
      if (success) {
        setCopiedFormat(format)
        setTimeout(() => setCopiedFormat(null), 2000)
      }
    },
    [app.id, onCopyToClipboard]
  )

  return (
    <Card
      className={cn(
        "group relative transition-all hover:shadow-md",
        isActive && "ring-2 ring-primary",
        viewMode === "list" && "flex flex-row items-center"
      )}
    >
      <CardHeader
        className={cn("cursor-pointer", viewMode === "list" && "flex-1 py-3")}
        onClick={() => onSelect(app.id)}
      >
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
            {IconComponent ? (
              React.createElement(IconComponent, { className: "h-5 w-5 text-muted-foreground" })
            ) : (
              <Sparkles className="h-5 w-5 text-muted-foreground" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <CardTitle className="text-sm">{app.name}</CardTitle>
            <CardDescription className="text-xs">
              {template?.name || "Custom App"} • {new Date(app.lastModified).toLocaleDateString()}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardFooter className={cn("gap-1", viewMode === "grid" ? "pt-0" : "py-3 pr-4")}>
        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => onSelect(app.id)}>
          <Play className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8"
          onClick={() => onDuplicate(app.id)}
          title={t("duplicate")}
        >
          <Copy className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8"
          onClick={() => onDownload(app.id)}
          title={t("export")}
        >
          <Download className="h-4 w-4" />
        </Button>
        <DropdownMenu open={shareMenuOpen} onOpenChange={setShareMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button size="icon" variant="ghost" className="h-8 w-8" title={t("share")}>
              <Share2 className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={() => handleCopy("url")}>
              <Link className="h-4 w-4 mr-2" />
              {copiedFormat === "url" ? t("copied") : t("copyLink")}
              {copiedFormat === "url" && <Check className="h-4 w-4 ml-auto text-green-500" />}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleCopy("code")}>
              <FileJson className="h-4 w-4 mr-2" />
              {copiedFormat === "code" ? t("copied") : t("copyShareCode")}
              {copiedFormat === "code" && <Check className="h-4 w-4 ml-auto text-green-500" />}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                onNativeShare(app.id)
              }}
            >
              <Share2 className="h-4 w-4 mr-2" />
              {t("systemShare")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                onSocialShare(app.id, "twitter")
                setShareMenuOpen(false)
              }}
            >
              <Send className="h-4 w-4 mr-2" />
              {t("shareToTwitter")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                onSocialShare(app.id, "facebook")
                setShareMenuOpen(false)
              }}
            >
              <Users className="h-4 w-4 mr-2" />
              {t("shareToFacebook")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                onSocialShare(app.id, "telegram")
                setShareMenuOpen(false)
              }}
            >
              <MessageCircle className="h-4 w-4 mr-2" />
              {t("shareToTelegram")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                onSocialShare(app.id, "email")
                setShareMenuOpen(false)
              }}
            >
              <Mail className="h-4 w-4 mr-2" />
              {t("shareByEmail")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8 text-destructive hover:text-destructive"
          onClick={() => onDelete(app.id)}
          title={t("delete")}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </CardFooter>
    </Card>
  )
})
