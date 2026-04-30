"use client"

/**
 * CanvasDocumentTabs - Tab bar for switching between multiple Canvas documents
 */

import { memo, useState } from "react"
import { useTranslations } from "next-intl"
import { X, Plus, FileCode, FileText, MoreHorizontal, Copy, Trash2, Edit2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { CanvasDocument } from "@/types"
import { RenameDialog } from "./rename-dialog"

interface CanvasDocumentTabsProps {
  documents: CanvasDocument[]
  activeDocumentId: string | null
  onSelectDocument: (id: string) => void
  onCloseDocument: (id: string) => void
  onCreateDocument: () => void
  onRenameDocument: (id: string, title: string) => void
  onDuplicateDocument: (id: string) => void
  onDeleteDocument: (id: string) => void
  className?: string
}

export const CanvasDocumentTabs = memo(function CanvasDocumentTabs({
  documents,
  activeDocumentId,
  onSelectDocument,
  onCloseDocument,
  onCreateDocument,
  onRenameDocument,
  onDuplicateDocument,
  onDeleteDocument,
  className,
}: CanvasDocumentTabsProps) {
  const t = useTranslations("canvas")
  const [renameDialogOpen, setRenameDialogOpen] = useState(false)
  const [renameDocId, setRenameDocId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState("")

  const handleStartRename = (doc: CanvasDocument) => {
    setRenameDocId(doc.id)
    setRenameValue(doc.title)
    setRenameDialogOpen(true)
  }

  const handleConfirmRename = (newTitle: string) => {
    if (renameDocId) {
      onRenameDocument(renameDocId, newTitle)
    }
    setRenameDialogOpen(false)
    setRenameDocId(null)
    setRenameValue("")
  }

  if (documents.length === 0) {
    return null
  }

  // Show tabs only if there are multiple documents
  if (documents.length === 1) {
    return null
  }

  return (
    <>
      <div className={cn("border-b bg-muted/30", className)}>
        <Tabs value={activeDocumentId || ""} onValueChange={onSelectDocument}>
          <ScrollArea className="w-full">
            <div className="flex items-center gap-2 px-2 py-1">
              <TabsList className="bg-transparent border-b-0 rounded-none gap-0.5 p-0 h-auto">
                {documents.map((doc) => (
                  <TabsTrigger
                    key={doc.id}
                    value={doc.id}
                    className={cn(
                      "group flex items-center gap-1.5 px-3 py-1.5 rounded-t-md border-b-2 transition-colors data-[state=active]:bg-background data-[state=active]:border-primary border-transparent hover:bg-muted/50",
                      "bg-transparent border-b-2 rounded-t-md h-auto data-[state=active]:shadow-sm"
                    )}
                    asChild
                  >
                    <div className="flex items-center gap-1.5">
                      {doc.type === "code" ? (
                        <FileCode className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      ) : (
                        <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      )}
                      <span className="text-xs font-medium truncate max-w-[80px] sm:max-w-[120px]">
                        {doc.title}
                      </span>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-9 w-9 opacity-0 group-hover:opacity-100 transition-opacity"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <MoreHorizontal className="h-3 w-3" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="w-40">
                          <DropdownMenuItem onClick={() => handleStartRename(doc)}>
                            <Edit2 className="h-3.5 w-3.5 mr-2" />
                            {t("rename")}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => onDuplicateDocument(doc.id)}>
                            <Copy className="h-3.5 w-3.5 mr-2" />
                            {t("duplicate")}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => onDeleteDocument(doc.id)}
                            className="text-destructive focus:text-destructive"
                          >
                            <Trash2 className="h-3.5 w-3.5 mr-2" />
                            {t("delete")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={(e) => {
                          e.stopPropagation()
                          onCloseDocument(doc.id)
                        }}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  </TabsTrigger>
                ))}
              </TabsList>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 shrink-0"
                    onClick={onCreateDocument}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("newDocument")}</TooltipContent>
              </Tooltip>
            </div>
            <ScrollBar orientation="horizontal" />
          </ScrollArea>
        </Tabs>
      </div>

      {/* Rename Dialog */}
      <RenameDialog
        open={renameDialogOpen}
        onOpenChange={setRenameDialogOpen}
        currentTitle={renameValue}
        onRename={handleConfirmRename}
      />
    </>
  )
})
