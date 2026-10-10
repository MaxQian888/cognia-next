"use client"

/**
 * "Start from a template" (ADR-0223): a row of cards at the top of Suggested —
 * a blank page, the built-in documents and the ones the person saved. A card
 * opens a new canvas document with that content. Saved templates have their
 * own menu (edit details, delete). The row scrolls sideways and folds away;
 * whether it is folded is remembered per device.
 *
 * Renders nothing while the unified template platform is switched off.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronDownIcon, MoreHorizontalIcon, PencilIcon, Trash2Icon } from "lucide-react"

import { DocumentTemplateGlyph } from "@/components/document-templates/document-template-glyph"
import {
  SaveDocumentTemplateDialog,
  type SaveDocumentTemplateRequest,
} from "@/components/document-templates/save-document-template-dialog"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useDocumentTemplates } from "@/hooks/document-templates/use-document-templates"
import type { FilesActions } from "@/hooks/files-library/use-files-actions"
import type { DocumentTemplateIcon } from "@/lib/document-templates/builtin"
import type { DocumentTemplateOption } from "@/lib/document-templates/service"
import { HOVER_REVEAL_CONTROL_CLASS } from "@/lib/ui/hover-reveal"
import { cn } from "@/lib/utils"
import { useFilesLibraryStore } from "@/stores/files-library"

const CARD_CLASS =
  "flex h-full w-full min-w-0 flex-col items-start gap-2 rounded-xl border bg-card p-3 text-left transition-colors outline-none hover:border-primary/40 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"

function TemplateCard({
  name,
  description,
  icon,
  onOpen,
  testId,
  menu,
}: {
  name: string
  description?: string
  icon: DocumentTemplateIcon
  onOpen: () => void
  testId: string
  menu?: React.ReactNode
}) {
  const t = useTranslations("files")
  return (
    <li className="group relative w-48 shrink-0">
      <button
        type="button"
        className={CARD_CLASS}
        onClick={onOpen}
        aria-label={t("templates.create", { name })}
        data-testid={testId}
      >
        <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <DocumentTemplateGlyph icon={icon} />
        </span>
        <span className="w-full truncate pr-6 text-sm font-medium">{name}</span>
        {description ? (
          <span className="line-clamp-2 text-xs text-muted-foreground">{description}</span>
        ) : null}
      </button>
      {menu ? <div className="absolute top-2 right-2">{menu}</div> : null}
    </li>
  )
}

export function FilesTemplateStrip({
  actions,
}: {
  actions: Pick<FilesActions, "newCanvasDocument" | "newFromTemplate" | "deleteTemplate">
}) {
  const t = useTranslations("files")
  const tTemplates = useTranslations("documentTemplates")
  const { enabled, options } = useDocumentTemplates()
  const collapsed = useFilesLibraryStore((s) => s.templatesCollapsed)
  const setCollapsed = useFilesLibraryStore((s) => s.setTemplatesCollapsed)
  const [editing, setEditing] = useState<SaveDocumentTemplateRequest | null>(null)
  if (!enabled) return null

  const userMenu = (template: DocumentTemplateOption) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn(HOVER_REVEAL_CONTROL_CLASS, "size-7 group-focus-within:opacity-100")}
          aria-label={t("templates.menu", { name: template.name })}
          data-testid={`files-template-menu-${template.id}`}
        >
          <MoreHorizontalIcon className="size-4" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onSelect={() =>
            setEditing({
              mode: "edit",
              templateId: template.id,
              name: template.name,
              ...(template.description ? { description: template.description } : {}),
            })
          }
          data-testid={`files-template-edit-${template.id}`}
        >
          <PencilIcon aria-hidden />
          {t("templates.edit")}
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => void actions.deleteTemplate(template)}
          data-testid={`files-template-delete-${template.id}`}
        >
          <Trash2Icon aria-hidden />
          {t("templates.delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )

  return (
    <section
      aria-labelledby="files-templates-heading"
      className="flex flex-col gap-2"
      data-testid="files-template-strip"
    >
      <div className="flex items-center gap-1">
        <h2 id="files-templates-heading" className="text-sm font-medium">
          {t("templates.title")}
        </h2>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-expanded={!collapsed}
          aria-controls="files-templates-list"
          aria-label={collapsed ? t("templates.expand") : t("templates.collapse")}
          onClick={() => setCollapsed(!collapsed)}
          data-testid="files-templates-toggle"
        >
          <ChevronDownIcon
            className={cn("size-4 transition-transform", collapsed && "-rotate-90")}
            aria-hidden
          />
        </Button>
      </div>
      {collapsed ? null : (
        <ul
          id="files-templates-list"
          className="flex gap-3 overflow-x-auto pb-1"
          aria-label={t("templates.title")}
        >
          <TemplateCard
            name={tTemplates("blank.name")}
            description={tTemplates("blank.description")}
            icon="blank"
            onOpen={actions.newCanvasDocument}
            testId="files-template-blank"
          />
          {(options ?? []).map((template) => (
            <TemplateCard
              key={`${template.source}:${template.id}`}
              name={template.name}
              {...(template.description ? { description: template.description } : {})}
              icon={template.icon}
              onOpen={() => actions.newFromTemplate(template)}
              testId={`files-template-${template.id}`}
              menu={template.source === "user" ? userMenu(template) : undefined}
            />
          ))}
        </ul>
      )}
      <SaveDocumentTemplateDialog request={editing} onClose={() => setEditing(null)} />
    </section>
  )
}
