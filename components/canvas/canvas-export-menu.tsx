"use client"

/**
 * Canvas Export Menu — download / copy the active document. The available file
 * formats are gated by the Artifacts export contract
 * (`getCanvasExportFormats`), so previewable documents can additionally export
 * as HTML / SVG while plain code exports its raw source. Serialization + the
 * download/clipboard side effects live in `lib/canvas/document-export.ts`.
 */

import { useTranslations } from "next-intl"
import { Copy, Download, FileCode2, FileDown } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import {
  copyCanvasDocumentToClipboard,
  exportCanvasDocument,
  getCanvasExportFormats,
} from "@/lib/canvas/document-export"
import type { ArtifactExportFormat, CanvasDocument } from "@/types/artifact/artifact"

interface CanvasExportMenuProps {
  documentId: string | null
  className?: string
}

const FORMAT_META: Record<
  ArtifactExportFormat,
  { labelKey: "formatRaw" | "formatHtml" | "formatSvg"; icon: typeof FileDown } | undefined
> = {
  raw: { labelKey: "formatRaw", icon: FileDown },
  html: { labelKey: "formatHtml", icon: FileCode2 },
  svg: { labelKey: "formatSvg", icon: FileCode2 },
  png: undefined,
  pdf: undefined,
}

export function CanvasExportMenu({ documentId, className }: CanvasExportMenuProps) {
  const t = useTranslations("canvas.exportMenu")
  const doc = useArtifactStore((s) => (documentId ? s.canvasDocuments[documentId] : undefined))

  const formats = doc ? getCanvasExportFormats(doc) : []

  const handleExport = (target: CanvasDocument, format: ArtifactExportFormat) => {
    const filename = exportCanvasDocument(target, format)
    if (filename) toast.success(t("downloaded", { filename }))
  }

  const handleCopy = async (target: CanvasDocument) => {
    const ok = await copyCanvasDocumentToClipboard(target)
    if (ok) toast.success(t("copied"))
    else toast.error(t("copyFailed"))
  }

  return (
    <DropdownMenu>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={className ?? "size-7"}
              disabled={!doc}
              aria-label={t("label")}
              data-testid="canvas-export-trigger"
            >
              <Download className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t("label")}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-48">
        {doc && (
          <>
            {formats.map((format) => {
              const meta = FORMAT_META[format]
              if (!meta) return null
              const Icon = meta.icon
              return (
                <DropdownMenuItem key={format} onClick={() => handleExport(doc, format)}>
                  <Icon className="mr-2 size-3.5" />
                  {t(meta.labelKey)}
                </DropdownMenuItem>
              )
            })}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => void handleCopy(doc)}>
              <Copy className="mr-2 size-3.5" />
              {t("copy")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
