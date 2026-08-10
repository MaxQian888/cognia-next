"use client"

/**
 * OCR Capabilities tab — the single-provider capability matrix.
 *
 * Reads from `lib/ocr/capabilities.ts:OCR_PROVIDER_CAPABILITIES` and renders
 * each of the 11 capability fields as a label + cell row, using the shared
 * `ocr-capability-cell.tsx` cells. The Compare view (full-width) renders the
 * same fields across multiple columns; that's why this tab stays focused on a
 * single column — duplication is intentional and minimal.
 */

import * as React from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table"
import { Layers } from "lucide-react"
import { OCR_PROVIDER_CAPABILITIES, type OcrCapabilityFields } from "@/lib/ocr/capabilities"
import {
  OcrCapabilityCostCell,
  OcrCapabilityCountCell,
  OcrCapabilityValueCell,
} from "../ocr-capability-cell"

interface OcrCapabilitiesTabProps {
  providerId: string
  onCompareClick?: () => void
}

const VALUE_FIELDS: ReadonlyArray<keyof OcrCapabilityFields> = [
  "handwriting",
  "tables",
  "math",
  "cjk",
  "layout",
  "offline",
  "structuredOutput",
  "pdfNative",
]

export function OcrCapabilitiesTab({
  providerId,
  onCompareClick,
}: OcrCapabilitiesTabProps): React.ReactElement {
  const t = useTranslations()
  const caps = OCR_PROVIDER_CAPABILITIES[providerId]

  if (!caps) {
    return (
      <div
        className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground"
        data-testid="ocr-capabilities-empty"
      >
        {t("ocr.capabilities.empty")}
      </div>
    )
  }

  return (
    <div className="space-y-5" data-testid="ocr-capabilities-tab">
      <header className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h4 className="text-sm font-medium">{t("ocr.capabilities.title")}</h4>
          <p className="text-xs text-muted-foreground">{t("ocr.capabilities.description")}</p>
        </div>
        {onCompareClick && (
          <Button
            variant="outline"
            size="sm"
            onClick={onCompareClick}
            data-testid="ocr-capabilities-compare-cta"
          >
            <Layers className="mr-1.5 h-3.5 w-3.5" />
            {t("ocr.capabilities.compareCta")}
          </Button>
        )}
      </header>

      <div className="overflow-hidden border-y">
        <Table className="min-w-full text-sm">
          <TableBody>
            {VALUE_FIELDS.map((field) => (
              <CapabilityRow
                key={field}
                label={t(`ocr.capabilities.fields.${field}.label`)}
                description={t(`ocr.capabilities.fields.${field}.description`)}
              >
                <OcrCapabilityValueCell value={caps[field] as "yes" | "no" | "partial"} />
              </CapabilityRow>
            ))}
            <CapabilityRow
              label={t("ocr.capabilities.fields.multilang.label")}
              description={t("ocr.capabilities.fields.multilang.description")}
            >
              <OcrCapabilityCountCell value={caps.multilang} />
            </CapabilityRow>
            <CapabilityRow
              label={t("ocr.capabilities.fields.maxPagesPerCall.label")}
              description={t("ocr.capabilities.fields.maxPagesPerCall.description")}
            >
              <OcrCapabilityCountCell value={caps.maxPagesPerCall} />
            </CapabilityRow>
            <CapabilityRow
              label={t("ocr.capabilities.fields.costTier.label")}
              description={t("ocr.capabilities.fields.costTier.description")}
            >
              <OcrCapabilityCostCell tier={caps.costTier} />
            </CapabilityRow>
          </TableBody>
        </Table>
      </div>

      <Separator />

      <p className="text-xs text-muted-foreground">{t("ocr.capabilities.footnote")}</p>
    </div>
  )
}

function CapabilityRow({
  label,
  description,
  children,
}: {
  label: string
  description: string
  children: React.ReactNode
}) {
  return (
    <TableRow className="even:bg-muted/20">
      <TableCell className="w-3/4 px-3 py-2 align-top whitespace-normal">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">{description}</div>
      </TableCell>
      <TableCell className="px-3 py-2 text-center align-middle">{children}</TableCell>
    </TableRow>
  )
}
