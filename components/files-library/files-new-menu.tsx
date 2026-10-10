"use client"

/**
 * "New" (ADR-0223): upload files, start a canvas document (blank or from a
 * template, while the template platform is on), or add a folder.
 * While a folder is in view, uploads are filed in it and a new folder goes
 * inside it; anywhere else they land at the top level.
 *
 * Where the library holds document creation back (a paired device, ADR-0223
 * §9), both document entries stay listed, disabled, saying to use the desktop.
 */

import { useRef } from "react"
import { useTranslations } from "next-intl"
import {
  ChevronDownIcon,
  FolderPlusIcon,
  LayoutTemplateIcon,
  PenLineIcon,
  PlusIcon,
  UploadIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { DocumentTemplateGlyph } from "@/components/document-templates/document-template-glyph"
import { useDocumentTemplates } from "@/hooks/document-templates/use-document-templates"
import { useFilesOps } from "@/hooks/files-library/files-backend"
import type { FilesActions } from "@/hooks/files-library/use-files-actions"
import { ROOT_LIBRARY_FOLDER_ID } from "@/lib/db/files-library-types"
import { useFilesLibraryStore } from "@/stores/files-library"

export function FilesNewMenu({
  actions,
  compact = false,
}: {
  actions: Pick<FilesActions, "upload" | "newCanvasDocument" | "newFromTemplate">
  /** The phone layout: a 40px "+" instead of the labelled button. */
  compact?: boolean
}) {
  const templates = useDocumentTemplates()
  const t = useTranslations("files")
  const inputRef = useRef<HTMLInputElement>(null)
  const section = useFilesLibraryStore((s) => s.section)
  const openFolderDialog = useFilesLibraryStore((s) => s.openFolderDialog)
  const folderId = section.kind === "folder" ? section.folderId : ROOT_LIBRARY_FOLDER_ID
  const createHeldBack = useFilesOps().capabilities.createDocuments !== true

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        aria-label={t("new.uploadInputAria")}
        data-testid="files-upload-input"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          event.target.value = ""
          void actions.upload(files, folderId === ROOT_LIBRARY_FOLDER_ID ? undefined : folderId)
        }}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {compact ? (
            <Button
              size="icon"
              className="size-10"
              aria-label={t("new.label")}
              data-testid="files-new"
            >
              <PlusIcon aria-hidden />
            </Button>
          ) : (
            <Button size="sm" data-testid="files-new">
              <PlusIcon aria-hidden />
              {t("new.label")}
              <ChevronDownIcon aria-hidden />
            </Button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={() => inputRef.current?.click()}
            data-testid="files-new-upload"
          >
            <UploadIcon aria-hidden />
            {t("new.upload")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => actions.newCanvasDocument()}
            disabled={createHeldBack}
            title={createHeldBack ? t("remote.createOnDesktopHint") : undefined}
            data-testid="files-new-canvas"
          >
            <PenLineIcon aria-hidden />
            {t("new.canvas")}
            {createHeldBack ? (
              <DropdownMenuShortcut className="tracking-normal">
                {t("remote.onDesktop")}
              </DropdownMenuShortcut>
            ) : null}
          </DropdownMenuItem>
          {createHeldBack ? (
            templates.enabled ? (
              <DropdownMenuItem
                disabled
                title={t("remote.createOnDesktopHint")}
                data-testid="files-new-from-template"
              >
                <LayoutTemplateIcon aria-hidden />
                {t("new.fromTemplate")}
                <DropdownMenuShortcut className="tracking-normal">
                  {t("remote.onDesktop")}
                </DropdownMenuShortcut>
              </DropdownMenuItem>
            ) : null
          ) : templates.enabled && templates.options && templates.options.length > 0 ? (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger data-testid="files-new-from-template">
                <LayoutTemplateIcon aria-hidden />
                {t("new.fromTemplate")}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-80 overflow-y-auto">
                {templates.options.map((template) => (
                  <DropdownMenuItem
                    key={`${template.source}:${template.id}`}
                    onSelect={() => actions.newFromTemplate(template)}
                    data-testid={`files-new-template-${template.id}`}
                  >
                    <DocumentTemplateGlyph icon={template.icon} className="size-4" />
                    <span className="truncate">{template.name}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : null}
          <DropdownMenuItem
            onSelect={() => openFolderDialog({ mode: "create", parentId: folderId })}
            data-testid="files-new-folder"
          >
            <FolderPlusIcon aria-hidden />
            {t("new.folder")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
