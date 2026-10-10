"use client"

/**
 * "New" (ADR-0223): upload files, start a canvas document (blank or from a
 * template, while the template platform is on), or add a folder.
 * While a folder is in view, uploads are filed in it and a new folder goes
 * inside it; anywhere else they land at the top level.
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
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { DocumentTemplateGlyph } from "@/components/document-templates/document-template-glyph"
import { useDocumentTemplates } from "@/hooks/document-templates/use-document-templates"
import type { FilesActions } from "@/hooks/files-library/use-files-actions"
import { ROOT_LIBRARY_FOLDER_ID } from "@/lib/db/files-library-types"
import { useFilesLibraryStore } from "@/stores/files-library"

export function FilesNewMenu({
  actions,
}: {
  actions: Pick<FilesActions, "upload" | "newCanvasDocument" | "newFromTemplate">
}) {
  const templates = useDocumentTemplates()
  const t = useTranslations("files")
  const inputRef = useRef<HTMLInputElement>(null)
  const section = useFilesLibraryStore((s) => s.section)
  const openFolderDialog = useFilesLibraryStore((s) => s.openFolderDialog)
  const folderId = section.kind === "folder" ? section.folderId : ROOT_LIBRARY_FOLDER_ID

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
          <Button size="sm" data-testid="files-new">
            <PlusIcon aria-hidden />
            {t("new.label")}
            <ChevronDownIcon aria-hidden />
          </Button>
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
            data-testid="files-new-canvas"
          >
            <PenLineIcon aria-hidden />
            {t("new.canvas")}
          </DropdownMenuItem>
          {templates.enabled && templates.options && templates.options.length > 0 ? (
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
