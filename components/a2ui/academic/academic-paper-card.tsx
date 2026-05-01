"use client"

/**
 * AcademicPaperCard - A2UI component for displaying paper cards
 * Renders a compact paper card with metadata and actions
 */

import React, { useCallback } from "react"
import { ExternalLink, Plus, FileText, Brain, Users, Calendar, Quote, BookOpen } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import type { Paper, LibraryPaper } from "@/types/academic"

export interface AcademicPaperCardProps {
  paper: Paper | LibraryPaper
  onViewDetails?: (paper: Paper | LibraryPaper) => void
  onAddToLibrary?: (paper: Paper) => void
  onOpenPdf?: (pdfUrl: string) => void
  onAnalyze?: (paper: Paper | LibraryPaper) => void
  isInLibrary?: boolean
  compact?: boolean
  className?: string
}

export function AcademicPaperCard({
  paper,
  onViewDetails,
  onAddToLibrary,
  onOpenPdf,
  onAnalyze,
  isInLibrary = false,
  compact = false,
  className,
}: AcademicPaperCardProps) {
  const handleViewDetails = useCallback(() => {
    onViewDetails?.(paper)
  }, [paper, onViewDetails])

  const handleAddToLibrary = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onAddToLibrary?.(paper)
    },
    [paper, onAddToLibrary]
  )

  const handleOpenPdf = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      if (paper.pdfUrl) {
        onOpenPdf?.(paper.pdfUrl)
      }
    },
    [paper.pdfUrl, onOpenPdf]
  )

  const handleAnalyze = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onAnalyze?.(paper)
    },
    [paper, onAnalyze]
  )

  const authorsText =
    paper.authors
      .slice(0, 3)
      .map((a) => a.name)
      .join(", ") + (paper.authors.length > 3 ? " et al." : "")

  return (
    <Card
      className={cn(
        "cursor-pointer transition-all hover:shadow-md",
        compact ? "p-3" : "",
        className
      )}
      onClick={handleViewDetails}
    >
      <CardHeader className={cn("pb-2", compact && "p-0")}>
        <h4
          className={cn(
            "font-semibold leading-tight",
            compact ? "text-sm line-clamp-2" : "text-base line-clamp-3"
          )}
        >
          {paper.title}
        </h4>
        <div className="flex items-center gap-1 text-muted-foreground">
          <Users className="h-3 w-3" />
          <span className={cn("text-xs line-clamp-1", compact && "text-[11px]")}>
            {authorsText}
          </span>
        </div>
      </CardHeader>

      <CardContent className={cn("pt-0", compact && "p-0 pt-2")}>
        <div className="flex flex-wrap gap-1.5 mb-2">
          {paper.year && (
            <Badge variant="outline" className="text-xs gap-1">
              <Calendar className="h-3 w-3" />
              {paper.year}
            </Badge>
          )}
          {paper.venue && !compact && (
            <Badge variant="secondary" className="text-xs max-w-[150px] truncate">
              {paper.venue}
            </Badge>
          )}
          {paper.citationCount !== undefined && paper.citationCount > 0 && (
            <Badge variant="outline" className="text-xs gap-1">
              <Quote className="h-3 w-3" />
              {paper.citationCount}
            </Badge>
          )}
          {paper.isOpenAccess && (
            <Badge variant="secondary" className="text-xs bg-green-500/10 text-green-600">
              Open Access
            </Badge>
          )}
        </div>

        {!compact && paper.abstract && (
          <p className="text-sm text-muted-foreground line-clamp-2 mb-3">{paper.abstract}</p>
        )}

        <div className="flex gap-1.5 flex-wrap">
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={handleViewDetails}>
            <ExternalLink className="h-3 w-3 mr-1" />
            Details
          </Button>

          {!isInLibrary && onAddToLibrary && (
            <Button
              size="sm"
              variant="secondary"
              className="h-7 text-xs"
              onClick={handleAddToLibrary}
            >
              <Plus className="h-3 w-3 mr-1" />
              Add
            </Button>
          )}

          {paper.pdfUrl && (
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={handleOpenPdf}>
              <FileText className="h-3 w-3 mr-1" />
              PDF
            </Button>
          )}

          {onAnalyze && (
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={handleAnalyze}>
              <Brain className="h-3 w-3 mr-1" />
              Analyze
            </Button>
          )}

          {isInLibrary && "readingStatus" in paper && (
            <Badge
              variant={paper.readingStatus === "completed" ? "default" : "outline"}
              className={cn(
                "text-xs ml-auto",
                paper.readingStatus === "reading" && "bg-blue-500/10 text-blue-600",
                paper.readingStatus === "completed" && "bg-green-500/10 text-green-600"
              )}
            >
              <BookOpen className="h-3 w-3 mr-1" />
              {paper.readingStatus}
            </Badge>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
