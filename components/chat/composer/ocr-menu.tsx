"use client"

/**
 * Dropdown menu rendered next to each image/PDF attachment in
 * `attachment-preview.tsx`. Two items map to the user-locked-in UX:
 *   1. "Extract text to input" — runs OCR and appends the Markdown to the
 *      composer textarea while keeping the original attachment.
 *   2. "View extracted text"   — runs OCR and opens the result bubble side
 *      sheet, leaving the textarea untouched.
 */

import { useCallback } from "react"
import { useTranslations } from "next-intl"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { LanguagesIcon } from "lucide-react"

export interface OcrMenuProps {
  attachmentId: string
  mediaType: string
  /** Caller-supplied handler. Fired when the user picks an action. */
  onSelect: (action: "extract-to-input" | "view-result", attachmentId: string) => void
  /** Disable the menu while a call is in flight. */
  disabled?: boolean
}

const SUPPORTED_PREFIX = "image/"
const SUPPORTED_PDF = "application/pdf"

export function isOcrEligible(mediaType: string | undefined | null): boolean {
  if (!mediaType) return false
  return mediaType.startsWith(SUPPORTED_PREFIX) || mediaType === SUPPORTED_PDF
}

export function OcrMenu(props: OcrMenuProps): React.ReactElement | null {
  const t = useTranslations()
  const handle = useCallback(
    (action: "extract-to-input" | "view-result") => () =>
      props.onSelect(action, props.attachmentId),
    [props]
  )
  if (!isOcrEligible(props.mediaType)) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-5 p-0"
          aria-label={t("ocr.composer.menu.extractToInput")}
          disabled={props.disabled}
          data-testid="ocr-menu-trigger"
        >
          <LanguagesIcon className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={4}>
        <DropdownMenuItem onSelect={handle("extract-to-input")}>
          {t("ocr.composer.menu.extractToInput")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={handle("view-result")}>
          {t("ocr.composer.menu.viewResult")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
