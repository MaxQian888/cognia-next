/**
 * A2UI Academic Templates
 * Templates for displaying academic papers, search results, and analysis
 */

import type { A2UIComponent, A2UIServerMessage } from "@/types/a2ui/schema"
import type { Paper, LibraryPaper, PaperAnalysisType } from "@/types/academic"
import { defaultLocale, type Locale } from "@/i18n/config"
import enA2UI from "@/i18n/messages/en/a2ui.json"
import zhCNA2UI from "@/i18n/messages/zh-CN/a2ui.json"
import { generateTemplateId } from "./templates"

/**
 * Academic template categories
 */
export type AcademicTemplateType =
  | "paper-card"
  | "paper-list"
  | "search-results"
  | "analysis-panel"
  | "paper-comparison"
  | "citation-network"
  | "reading-list"

const academicTemplateMessages = {
  en: enA2UI,
  "zh-CN": zhCNA2UI,
} as const

function getAcademicTemplateMessages(locale: string | undefined) {
  return academicTemplateMessages[(locale === "zh-CN" ? "zh-CN" : defaultLocale) as Locale]
}

function formatTemplateMessage(template: string, values: Record<string, string | number> = {}) {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ""))
}

/**
 * Create a paper card A2UI surface
 */
export function createPaperCardSurface(
  paper: Paper | LibraryPaper,
  surfaceId?: string,
  locale: Locale = defaultLocale
): { surfaceId: string; messages: A2UIServerMessage[] } {
  const id = surfaceId || generateTemplateId("paper-card")
  const m = getAcademicTemplateMessages(locale)

  const components: A2UIComponent[] = [
    {
      id: "root",
      component: "Card",
      children: ["header", "meta-row", "abstract-section", "actions"],
      className: "p-4 hover:shadow-md transition-shadow",
    },
    {
      id: "header",
      component: "Column",
      children: ["title", "authors"],
      className: "gap-1",
    },
    {
      id: "title",
      component: "Text",
      text: { path: "/paper/title" },
      variant: "heading4",
      className: "line-clamp-2 cursor-pointer hover:text-primary",
    },
    {
      id: "authors",
      component: "Text",
      text: { path: "/paper/authorsText" },
      variant: "caption",
      color: "muted",
      className: "line-clamp-1",
    },
    {
      id: "meta-row",
      component: "Row",
      children: ["year-badge", "venue-badge", "citations-badge", "oa-badge"],
      className: "gap-2 mt-2 flex-wrap",
    },
    {
      id: "year-badge",
      component: "Badge",
      text: { path: "/paper/year" },
      variant: "outline",
      visible: { path: "/paper/hasYear" },
    },
    {
      id: "venue-badge",
      component: "Badge",
      text: { path: "/paper/venue" },
      variant: "secondary",
      visible: { path: "/paper/hasVenue" },
    },
    {
      id: "citations-badge",
      component: "Badge",
      text: { path: "/paper/citationsText" },
      variant: "outline",
      visible: { path: "/paper/hasCitations" },
    },
    {
      id: "oa-badge",
      component: "Badge",
      text: m.paperCardOpenAccess,
      variant: "secondary",
      className: "bg-green-500/10 text-green-600",
      visible: { path: "/paper/isOpenAccess" },
    },
    {
      id: "abstract-section",
      component: "Column",
      children: ["abstract"],
      className: "mt-3",
      visible: { path: "/paper/hasAbstract" },
    },
    {
      id: "abstract",
      component: "Text",
      text: { path: "/paper/abstractPreview" },
      variant: "body",
      color: "muted",
      className: "text-sm line-clamp-3",
    },
    {
      id: "actions",
      component: "Row",
      children: ["view-btn", "add-btn", "pdf-btn", "analyze-btn"],
      className: "gap-2 mt-4",
    },
    {
      id: "view-btn",
      component: "Button",
      text: m.paperCardDetails,
      action: "view_paper",
      variant: "outline",
      icon: "ExternalLink",
    },
    {
      id: "add-btn",
      component: "Button",
      text: m.paperCardAdd,
      action: "add_to_library",
      variant: "secondary",
      icon: "Plus",
      visible: { path: "/paper/canAdd" },
    },
    {
      id: "pdf-btn",
      component: "Button",
      text: m.paperCardPdf,
      action: "open_pdf",
      variant: "ghost",
      icon: "FileText",
      visible: { path: "/paper/hasPdf" },
    },
    {
      id: "analyze-btn",
      component: "Button",
      text: m.paperCardAnalyze,
      action: "analyze_paper",
      variant: "ghost",
      icon: "Brain",
    },
  ] as A2UIComponent[]

  const dataModel = {
    paper: {
      id: paper.id,
      title: paper.title,
      authorsText: paper.authors.map((a) => a.name).join(", "),
      year: paper.year?.toString() || "",
      hasYear: !!paper.year,
      venue: paper.venue || "",
      hasVenue: !!paper.venue,
      citationsText: paper.citationCount
        ? formatTemplateMessage(m.papersCount, { count: paper.citationCount })
        : "",
      hasCitations: !!paper.citationCount,
      isOpenAccess: paper.isOpenAccess || false,
      abstractPreview:
        paper.abstract?.slice(0, 300) +
          (paper.abstract && paper.abstract.length > 300 ? "..." : "") || "",
      hasAbstract: !!paper.abstract,
      hasPdf: !!paper.pdfUrl,
      pdfUrl: paper.pdfUrl,
      canAdd: true,
    },
  }

  const messages: A2UIServerMessage[] = [
    { type: "createSurface", surfaceId: id, surfaceType: "inline", title: m.paperCardDetails },
    { type: "updateComponents", surfaceId: id, components },
    { type: "dataModelUpdate", surfaceId: id, data: dataModel },
    { type: "surfaceReady", surfaceId: id },
  ]

  return { surfaceId: id, messages }
}

/**
 * Create search results A2UI surface
 */
export function createSearchResultsSurface(
  papers: Paper[],
  query: string,
  totalResults: number,
  surfaceId?: string,
  locale: Locale = defaultLocale
): { surfaceId: string; messages: A2UIServerMessage[] } {
  const id = surfaceId || generateTemplateId("search-results")
  const m = getAcademicTemplateMessages(locale)

  const paperListItems = papers.map((paper, idx) => ({
    id: `paper-${idx}`,
    title: paper.title,
    subtitle:
      paper.authors
        .slice(0, 3)
        .map((a) => a.name)
        .join(", ") + (paper.authors.length > 3 ? m.paperCardEtAl : ""),
    metadata: [
      paper.year?.toString(),
      paper.venue,
      paper.citationCount
        ? formatTemplateMessage(m.papersCount, { count: paper.citationCount })
        : null,
    ]
      .filter(Boolean)
      .join(" • "),
    badge: paper.isOpenAccess ? m.paperCardOpenAccess : undefined,
  }))

  const components: A2UIComponent[] = [
    {
      id: "root",
      component: "Column",
      children: ["header", "filters-row", "results-info", "paper-list", "load-more"],
      className: "gap-4",
    },
    {
      id: "header",
      component: "Row",
      children: ["search-icon", "title"],
      className: "gap-2 items-center",
    },
    {
      id: "search-icon",
      component: "Icon",
      name: "Search",
      size: 20,
    },
    {
      id: "title",
      component: "Text",
      text: { path: "/header/title" },
      variant: "heading3",
    },
    {
      id: "filters-row",
      component: "Row",
      children: ["provider-filter", "year-filter", "sort-select"],
      className: "gap-2 flex-wrap",
    },
    {
      id: "provider-filter",
      component: "Select",
      value: { path: "/filters/provider" },
      options: [
        { value: "all", label: m.allSources },
        { value: "arxiv", label: "arXiv" },
        { value: "semantic-scholar", label: "Semantic Scholar" },
        { value: "openalex", label: "OpenAlex" },
      ],
      placeholder: m.allSources,
      className: "w-40",
    },
    {
      id: "year-filter",
      component: "Select",
      value: { path: "/filters/year" },
      options: [
        { value: "all", label: m.tableSelectAll },
        { value: "2024", label: "2024" },
        { value: "2023", label: "2023" },
        { value: "2022", label: "2022" },
        { value: "2021", label: "2021" },
        { value: "older", label: "2020 & Earlier" },
      ],
      placeholder: "Year",
      className: "w-32",
    },
    {
      id: "sort-select",
      component: "Select",
      value: { path: "/filters/sortBy" },
      options: [
        { value: "relevance", label: m.sortRelevance },
        { value: "date", label: m.sortNewest },
        { value: "citations", label: m.sortCitations },
      ],
      placeholder: m.sortByLabel,
      className: "w-36",
    },
    {
      id: "results-info",
      component: "Text",
      text: { path: "/resultsText" },
      variant: "caption",
      color: "muted",
    },
    {
      id: "paper-list",
      component: "List",
      items: { path: "/papers" },
      emptyText: `${m.noPapersFound}. ${m.tryDifferentSearch}`,
      itemClickAction: "select_paper",
      dividers: true,
    },
    {
      id: "load-more",
      component: "Button",
      text: m.loadMore,
      action: "load_more",
      variant: "outline",
      className: "w-full",
      visible: { path: "/hasMore" },
    },
  ] as A2UIComponent[]

  const dataModel = {
    header: {
      title: formatTemplateMessage(m.resultsFor, { query }),
    },
    filters: {
      provider: "all",
      year: "all",
      sortBy: "relevance",
    },
    resultsText: formatTemplateMessage(m.papersCount, { count: totalResults }),
    papers: paperListItems,
    hasMore: papers.length < totalResults,
  }

  const messages: A2UIServerMessage[] = [
    {
      type: "createSurface",
      surfaceId: id,
      surfaceType: "inline",
      title: formatTemplateMessage(m.resultsFor, { query }),
    },
    { type: "updateComponents", surfaceId: id, components },
    { type: "dataModelUpdate", surfaceId: id, data: dataModel },
    { type: "surfaceReady", surfaceId: id },
  ]

  return { surfaceId: id, messages }
}

/**
 * Create analysis panel A2UI surface
 */
export function createAnalysisPanelSurface(
  paper: { title: string; abstract?: string },
  analysisType: PaperAnalysisType,
  analysisContent: string,
  surfaceId?: string,
  locale: Locale = defaultLocale
): { surfaceId: string; messages: A2UIServerMessage[] } {
  const id = surfaceId || generateTemplateId("analysis")
  const m = getAcademicTemplateMessages(locale)

  const analysisTypeLabels: Record<PaperAnalysisType, string> = {
    summary: m.analysisSummary,
    "key-insights": m.analysisKeyInsights,
    methodology: m.analysisMethodology,
    findings: m.analysisFindings,
    limitations: m.analysisLimitations,
    "future-work": m.analysisFutureWork,
    "related-work": m.analysisRelatedWork,
    "technical-details": m.analysisTechnicalDetails,
    comparison: m.sortByLabel,
    critique: m.analysisCritique,
    eli5: m.analysisEli5,
    custom: m.analysisLabel,
  }

  const components: A2UIComponent[] = [
    {
      id: "root",
      component: "Column",
      children: ["header", "paper-info", "divider", "analysis-type-row", "content-card", "actions"],
      className: "gap-4",
    },
    {
      id: "header",
      component: "Row",
      children: ["brain-icon", "title"],
      className: "gap-2 items-center",
    },
    {
      id: "brain-icon",
      component: "Icon",
      name: "Brain",
      size: 24,
      className: "text-primary",
    },
    {
      id: "title",
      component: "Text",
      text: m.aiPaperAnalysis,
      variant: "heading3",
    },
    {
      id: "paper-info",
      component: "Card",
      children: ["paper-title", "paper-abstract-preview"],
      className: "p-3 bg-muted/50",
    },
    {
      id: "paper-title",
      component: "Text",
      text: { path: "/paper/title" },
      variant: "heading5",
      className: "line-clamp-2",
    },
    {
      id: "paper-abstract-preview",
      component: "Text",
      text: { path: "/paper/abstractPreview" },
      variant: "caption",
      color: "muted",
      className: "line-clamp-2 mt-1",
      visible: { path: "/paper/hasAbstract" },
    },
    {
      id: "divider",
      component: "Divider",
    },
    {
      id: "analysis-type-row",
      component: "Row",
      children: ["type-label", "type-badge"],
      className: "gap-2 items-center",
    },
    {
      id: "type-label",
      component: "Text",
      text: m.analysisLabel,
      variant: "label",
    },
    {
      id: "type-badge",
      component: "Badge",
      text: { path: "/analysisTypeLabel" },
      variant: "secondary",
    },
    {
      id: "content-card",
      component: "Card",
      children: ["analysis-content"],
      className: "p-4",
    },
    {
      id: "analysis-content",
      component: "Text",
      text: { path: "/analysis" },
      variant: "body",
      className: "whitespace-pre-wrap",
    },
    {
      id: "actions",
      component: "Row",
      children: ["copy-btn", "new-analysis-btn", "ask-followup-btn"],
      className: "gap-2",
    },
    {
      id: "copy-btn",
      component: "Button",
      text: m.copyAnalysis,
      action: "copy_analysis",
      variant: "outline",
      icon: "Copy",
    },
    {
      id: "new-analysis-btn",
      component: "Button",
      text: m.regenerate,
      action: "new_analysis",
      variant: "secondary",
      icon: "RefreshCw",
    },
    {
      id: "ask-followup-btn",
      component: "Button",
      text: m.askFollowUp,
      action: "ask_followup",
      variant: "primary",
      icon: "MessageSquare",
    },
  ] as A2UIComponent[]

  const dataModel = {
    paper: {
      title: paper.title,
      abstractPreview: paper.abstract?.slice(0, 200) + "..." || "",
      hasAbstract: !!paper.abstract,
    },
    analysisType,
    analysisTypeLabel: analysisTypeLabels[analysisType],
    analysis: analysisContent,
  }

  const messages: A2UIServerMessage[] = [
    { type: "createSurface", surfaceId: id, surfaceType: "inline", title: m.aiPaperAnalysis },
    { type: "updateComponents", surfaceId: id, components },
    { type: "dataModelUpdate", surfaceId: id, data: dataModel },
    { type: "surfaceReady", surfaceId: id },
  ]

  return { surfaceId: id, messages }
}

/**
 * Create paper comparison A2UI surface
 */
export function createPaperComparisonSurface(
  papers: Array<{ title: string; authors?: string; year?: number; abstract?: string }>,
  comparisonContent: string,
  surfaceId?: string
): { surfaceId: string; messages: A2UIServerMessage[] } {
  const id = surfaceId || generateTemplateId("comparison")

  const paperItems = papers.map((p, idx) => ({
    id: `paper-${idx}`,
    title: p.title,
    subtitle: [p.authors, p.year?.toString()].filter(Boolean).join(" • "),
  }))

  const components: A2UIComponent[] = [
    {
      id: "root",
      component: "Column",
      children: ["header", "papers-section", "divider", "comparison-content", "actions"],
      className: "gap-4",
    },
    {
      id: "header",
      component: "Row",
      children: ["compare-icon", "title"],
      className: "gap-2 items-center",
    },
    {
      id: "compare-icon",
      component: "Icon",
      name: "ArrowLeftRight",
      size: 24,
      className: "text-primary",
    },
    {
      id: "title",
      component: "Text",
      text: { path: "/header/title" },
      variant: "heading3",
    },
    {
      id: "papers-section",
      component: "Card",
      children: ["papers-label", "papers-list"],
      className: "p-3 bg-muted/50",
    },
    {
      id: "papers-label",
      component: "Text",
      text: "Comparing Papers:",
      variant: "label",
    },
    {
      id: "papers-list",
      component: "List",
      items: { path: "/papers" },
      dividers: false,
      className: "mt-2",
    },
    {
      id: "divider",
      component: "Divider",
    },
    {
      id: "comparison-content",
      component: "Card",
      children: ["content-text"],
      className: "p-4",
    },
    {
      id: "content-text",
      component: "Text",
      text: { path: "/comparison" },
      variant: "body",
      className: "whitespace-pre-wrap",
    },
    {
      id: "actions",
      component: "Row",
      children: ["copy-btn", "add-paper-btn"],
      className: "gap-2",
    },
    {
      id: "copy-btn",
      component: "Button",
      text: "Copy",
      action: "copy_comparison",
      variant: "outline",
      icon: "Copy",
    },
    {
      id: "add-paper-btn",
      component: "Button",
      text: "Add Paper",
      action: "add_paper_to_comparison",
      variant: "secondary",
      icon: "Plus",
    },
  ] as A2UIComponent[]

  const dataModel = {
    header: {
      title: `Comparing ${papers.length} Papers`,
    },
    papers: paperItems,
    comparison: comparisonContent,
  }

  const messages: A2UIServerMessage[] = [
    { type: "createSurface", surfaceId: id, surfaceType: "inline", title: "Paper Comparison" },
    { type: "updateComponents", surfaceId: id, components },
    { type: "dataModelUpdate", surfaceId: id, data: dataModel },
    { type: "surfaceReady", surfaceId: id },
  ]

  return { surfaceId: id, messages }
}

/**
 * Create reading list A2UI surface
 */
export function createReadingListSurface(
  papers: LibraryPaper[],
  listName: string,
  surfaceId?: string
): { surfaceId: string; messages: A2UIServerMessage[] } {
  const id = surfaceId || generateTemplateId("reading-list")

  const statusCounts = {
    unread: papers.filter((p) => p.readingStatus === "unread").length,
    reading: papers.filter((p) => p.readingStatus === "reading").length,
    completed: papers.filter((p) => p.readingStatus === "completed").length,
  }

  const paperItems = papers.map((p) => ({
    id: p.id,
    title: p.title,
    subtitle: p.authors
      .slice(0, 2)
      .map((a) => a.name)
      .join(", "),
    badge: p.readingStatus,
    metadata: p.year?.toString(),
  }))

  const components: A2UIComponent[] = [
    {
      id: "root",
      component: "Column",
      children: ["header", "stats-row", "filter-row", "paper-list"],
      className: "gap-4",
    },
    {
      id: "header",
      component: "Row",
      children: ["list-icon", "title"],
      className: "gap-2 items-center",
    },
    {
      id: "list-icon",
      component: "Icon",
      name: "BookOpen",
      size: 24,
      className: "text-primary",
    },
    {
      id: "title",
      component: "Text",
      text: { path: "/listName" },
      variant: "heading3",
    },
    {
      id: "stats-row",
      component: "Row",
      children: ["unread-stat", "reading-stat", "completed-stat"],
      className: "gap-3",
    },
    {
      id: "unread-stat",
      component: "Badge",
      text: { path: "/stats/unreadText" },
      variant: "outline",
    },
    {
      id: "reading-stat",
      component: "Badge",
      text: { path: "/stats/readingText" },
      variant: "secondary",
    },
    {
      id: "completed-stat",
      component: "Badge",
      text: { path: "/stats/completedText" },
      variant: "secondary",
      className: "bg-green-500/10 text-green-600",
    },
    {
      id: "filter-row",
      component: "Row",
      children: ["status-filter", "sort-filter"],
      className: "gap-2",
    },
    {
      id: "status-filter",
      component: "Select",
      value: { path: "/filters/status" },
      options: [
        { value: "all", label: "All Status" },
        { value: "unread", label: "Unread" },
        { value: "reading", label: "Reading" },
        { value: "completed", label: "Completed" },
      ],
      className: "w-36",
    },
    {
      id: "sort-filter",
      component: "Select",
      value: { path: "/filters/sortBy" },
      options: [
        { value: "added", label: "Recently Added" },
        { value: "title", label: "Title" },
        { value: "year", label: "Year" },
      ],
      className: "w-36",
    },
    {
      id: "paper-list",
      component: "List",
      items: { path: "/papers" },
      emptyText: "No papers in this reading list.",
      itemClickAction: "open_paper",
      dividers: true,
    },
  ] as A2UIComponent[]

  const dataModel = {
    listName,
    stats: {
      unreadText: `${statusCounts.unread} unread`,
      readingText: `${statusCounts.reading} reading`,
      completedText: `${statusCounts.completed} completed`,
    },
    filters: {
      status: "all",
      sortBy: "added",
    },
    papers: paperItems,
  }

  const messages: A2UIServerMessage[] = [
    { type: "createSurface", surfaceId: id, surfaceType: "inline", title: "Reading List" },
    { type: "updateComponents", surfaceId: id, components },
    { type: "dataModelUpdate", surfaceId: id, data: dataModel },
    { type: "surfaceReady", surfaceId: id },
  ]

  return { surfaceId: id, messages }
}

/**
 * Export all academic template functions
 */
export const academicTemplates = {
  createPaperCardSurface,
  createSearchResultsSurface,
  createAnalysisPanelSurface,
  createPaperComparisonSurface,
  createReadingListSurface,
}

export default academicTemplates
