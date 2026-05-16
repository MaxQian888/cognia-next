"use client"

/**
 * CanvasDocumentList - Full document management panel for Canvas
 */

import { memo, useState, useMemo, useDeferredValue } from "react"
import { useTranslations } from "next-intl"
import { AnimatePresence, motion } from "motion/react"
import {
  FileCode,
  FileText,
  Search,
  Plus,
  MoreVertical,
  Trash2,
  Copy,
  Edit2,
  Clock,
  FolderOpen,
  SortAsc,
  SortDesc,
  Filter,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { DocumentSortField, DocumentSortOrder } from "@/types/canvas/panel"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import {
  MOBILE_DURATION,
  MOBILE_EASE,
  STAGGER_CHILD,
  STAGGER_CONTAINER,
  useReducedMotionTransition,
} from "@/lib/ui/motion"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { RenameDialog } from "./rename-dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Label } from "@/components/ui/label"
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { cn } from "@/lib/utils"
import { formatRelativeDate, countLines } from "@/lib/canvas/utils"
import { LANGUAGE_OPTIONS } from "@/lib/canvas/constants"
import type { CanvasDocument, ArtifactLanguage } from "@/types"

interface CanvasDocumentListProps {
  documents: CanvasDocument[]
  activeDocumentId: string | null
  onSelectDocument: (id: string) => void
  onCreateDocument: (options: {
    title: string
    content: string
    language: ArtifactLanguage
    type: "code" | "text"
  }) => void
  onRenameDocument: (id: string, title: string) => void
  onDuplicateDocument: (id: string) => void
  onDeleteDocument: (id: string) => void
  className?: string
}

export const CanvasDocumentList = memo(function CanvasDocumentList({
  documents,
  activeDocumentId,
  onSelectDocument,
  onCreateDocument,
  onRenameDocument,
  onDuplicateDocument,
  onDeleteDocument,
  className,
}: CanvasDocumentListProps) {
  const t = useTranslations("canvas")
  const [searchQuery, setSearchQuery] = useState("")
  const deferredSearchQuery = useDeferredValue(searchQuery)
  const [sortField, setSortField] = useState<DocumentSortField>("updatedAt")
  const [sortOrder, setSortOrder] = useState<DocumentSortOrder>("desc")
  const [filterLanguage, setFilterLanguage] = useState<string>("all")
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [renameDialogOpen, setRenameDialogOpen] = useState(false)
  const [renameDocId, setRenameDocId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState("")

  // New document form state
  const [newDocTitle, setNewDocTitle] = useState("")
  const [newDocLanguage, setNewDocLanguage] = useState<ArtifactLanguage>("javascript")
  const [newDocType, setNewDocType] = useState<"code" | "text">("code")

  // Filter and sort documents
  const filteredDocuments = useMemo(() => {
    let result = [...documents]

    // Apply search filter
    if (deferredSearchQuery) {
      const query = deferredSearchQuery.toLowerCase()
      result = result.filter(
        (doc) =>
          doc.title.toLowerCase().includes(query) ||
          doc.content.slice(0, 1000).toLowerCase().includes(query)
      )
    }

    // Apply language filter
    if (filterLanguage !== "all") {
      result = result.filter((doc) => doc.language === filterLanguage)
    }

    // Apply sorting
    result.sort((a, b) => {
      let comparison = 0
      switch (sortField) {
        case "title":
          comparison = a.title.localeCompare(b.title)
          break
        case "updatedAt":
          comparison = new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime()
          break
        case "language":
          comparison = a.language.localeCompare(b.language)
          break
      }
      return sortOrder === "asc" ? comparison : -comparison
    })

    return result
  }, [documents, deferredSearchQuery, sortField, sortOrder, filterLanguage])

  const handleStartRename = (doc: CanvasDocument) => {
    setRenameDocId(doc.id)
    setRenameValue(doc.title)
    setRenameDialogOpen(true)
  }

  const handleCreateDocument = () => {
    if (newDocTitle.trim()) {
      onCreateDocument({
        title: newDocTitle.trim(),
        content: "",
        language: newDocLanguage,
        type: newDocType,
      })
      setNewDocTitle("")
      setNewDocLanguage("javascript")
      setNewDocType("code")
      setCreateDialogOpen(false)
    }
  }

  // Use shared date formatting utility
  const formatDate = (date: Date) => formatRelativeDate(date, t)

  const toggleSortOrder = () => {
    setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"))
  }

  // Single transition reused for every card so reduced-motion only collapses
  // it once per render; MOBILE_EASE keeps card hover/tap in sync with the
  // rest of the canvas motion vocabulary.
  const cardTransition = useReducedMotionTransition({
    duration: MOBILE_DURATION.fast,
    ease: MOBILE_EASE,
  })

  return (
    <>
      <div className={cn("flex flex-col h-full", className)}>
        {/* Header with search and actions */}
        <div className="p-3 border-b space-y-2">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t("search")}
                className="pl-9 h-8"
              />
            </div>
            <Button
              size="sm"
              data-testid="canvas-doc-new-button"
              onClick={() => setCreateDialogOpen(true)}
            >
              <Plus className="h-4 w-4 mr-1" />
              {t("new")}
            </Button>
          </div>

          {/* Filters and sort */}
          <div className="flex items-center gap-2 text-xs flex-wrap">
            <Select value={filterLanguage} onValueChange={setFilterLanguage}>
              <SelectTrigger className="h-7 w-full sm:w-25 min-w-20">
                <Filter className="h-3 w-3 mr-1" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("allLanguages")}</SelectItem>
                {LANGUAGE_OPTIONS.map((lang) => (
                  <SelectItem key={lang.value} value={lang.value}>
                    {lang.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={sortField} onValueChange={(v) => setSortField(v as DocumentSortField)}>
              <SelectTrigger className="h-7 w-full sm:w-25 min-w-20">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="updatedAt">{t("sortByDate")}</SelectItem>
                <SelectItem value="title">{t("sortByName")}</SelectItem>
                <SelectItem value="language">{t("sortByLanguage")}</SelectItem>
              </SelectContent>
            </Select>

            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={toggleSortOrder}>
              {sortOrder === "asc" ? (
                <SortAsc className="h-3.5 w-3.5" />
              ) : (
                <SortDesc className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
        </div>

        {/* Document list */}
        <ScrollArea className="flex-1">
          {filteredDocuments.length === 0 ? (
            <Empty className="border-0">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FolderOpen />
                </EmptyMedia>
                <EmptyTitle>{searchQuery ? t("noDocumentsFound") : t("noDocuments")}</EmptyTitle>
              </EmptyHeader>
              {!searchQuery && (
                <EmptyContent>
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid="canvas-doc-create-first-button"
                    onClick={() => setCreateDialogOpen(true)}
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    {t("createFirst")}
                  </Button>
                </EmptyContent>
              )}
            </Empty>
          ) : (
            <motion.div
              className="p-2 space-y-1"
              variants={STAGGER_CONTAINER}
              initial="initial"
              animate="animate"
            >
              <AnimatePresence initial={false}>
                {filteredDocuments.map((doc) => (
                  <motion.div
                    key={doc.id}
                    layout
                    variants={STAGGER_CHILD}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                    whileHover={{ y: -1 }}
                    whileTap={{ scale: 0.99 }}
                    transition={cardTransition}
                    data-testid={`canvas-doc-card-motion-${doc.id}`}
                  >
                    <Card
                      className={cn(
                        "group cursor-pointer transition-colors py-3",
                        doc.id === activeDocumentId
                          ? "bg-primary/10 border-primary/30"
                          : "hover:bg-muted/50"
                      )}
                      onClick={() => onSelectDocument(doc.id)}
                    >
                      <CardContent className="p-2">
                        <div className="flex items-center gap-2">
                          {doc.type === "code" ? (
                            <FileCode className="h-4 w-4 text-muted-foreground shrink-0" />
                          ) : (
                            <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-sm truncate">{doc.title}</span>
                              <Badge variant="secondary" className="text-[10px] shrink-0">
                                {doc.language}
                              </Badge>
                            </div>
                            <div className="flex items-center gap-1 text-xs text-muted-foreground">
                              <Clock className="h-3 w-3" />
                              <span>{formatDate(doc.updatedAt)}</span>
                              <span className="mx-1">•</span>
                              <span>{t("linesCount", { count: countLines(doc.content) })}</span>
                            </div>
                          </div>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <MoreVertical className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => handleStartRename(doc)}>
                                <Edit2 className="h-4 w-4 mr-2" />
                                {t("rename")}
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => onDuplicateDocument(doc.id)}>
                                <Copy className="h-4 w-4 mr-2" />
                                {t("duplicate")}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() => onDeleteDocument(doc.id)}
                                className="text-destructive focus:text-destructive"
                              >
                                <Trash2 className="h-4 w-4 mr-2" />
                                {t("delete")}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </CardContent>
                    </Card>
                  </motion.div>
                ))}
              </AnimatePresence>
            </motion.div>
          )}
        </ScrollArea>

        {/* Footer stats */}
        <div className="p-2 border-t text-xs text-muted-foreground text-center">
          {t("documentsCount", { count: filteredDocuments.length })}
          {searchQuery && ` ${t("filteredSuffix")}`}
        </div>
      </div>

      {/* Create Document Dialog */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="w-[95vw] sm:max-w-100">
          <DialogHeader>
            <DialogTitle>{t("createDocument")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>{t("documentTitle")}</Label>
              <Input
                value={newDocTitle}
                onChange={(e) => setNewDocTitle(e.target.value)}
                placeholder={t("enterTitle")}
                data-testid="canvas-doc-title-input"
                autoFocus
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{t("language")}</Label>
                <Select
                  value={newDocLanguage}
                  onValueChange={(v) => setNewDocLanguage(v as ArtifactLanguage)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LANGUAGE_OPTIONS.map((lang) => (
                      <SelectItem key={lang.value} value={lang.value}>
                        {lang.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>{t("type")}</Label>
                <Select
                  value={newDocType}
                  onValueChange={(v) => setNewDocType(v as "code" | "text")}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="code">{t("codeType")}</SelectItem>
                    <SelectItem value="text">{t("textType")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
              {t("cancel")}
            </Button>
            <Button
              data-testid="canvas-doc-create-button"
              onClick={handleCreateDocument}
              disabled={!newDocTitle.trim()}
            >
              {t("create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename Dialog */}
      <RenameDialog
        open={renameDialogOpen}
        onOpenChange={setRenameDialogOpen}
        currentTitle={renameValue}
        onRename={(newTitle) => {
          if (renameDocId) {
            onRenameDocument(renameDocId, newTitle)
          }
          setRenameDialogOpen(false)
          setRenameDocId(null)
          setRenameValue("")
        }}
      />
    </>
  )
})
