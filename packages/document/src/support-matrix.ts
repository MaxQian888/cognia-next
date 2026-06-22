import type { DocumentType, KnowledgeFileType } from "./types"

export type DocumentSupportSurface = "vector" | "knowledge-base" | "ppt-material"

const DOCUMENT_TYPE_EXTENSIONS: Record<Exclude<DocumentType, "unknown">, string[]> = {
  markdown: ["md", "markdown", "mdx"],
  code: [
    "js",
    "jsx",
    "ts",
    "tsx",
    "py",
    "rb",
    "java",
    "kt",
    "go",
    "rs",
    "cpp",
    "c",
    "h",
    "hpp",
    "cs",
    "php",
    "swift",
    "scala",
    "r",
    "sh",
    "bash",
    "zsh",
    "ps1",
    "vue",
    "svelte",
    "sql",
    "yaml",
    "yml",
    "css",
    "scss",
    "less",
    "xml",
  ],
  text: ["txt"],
  json: ["json"],
  pdf: ["pdf"],
  word: ["docx", "doc", "docm", "odt"],
  excel: ["xlsx", "xls", "xlsm", "ods"],
  csv: ["csv", "tsv"],
  html: ["html", "htm", "xhtml"],
  rtf: ["rtf"],
  epub: ["epub"],
  presentation: ["pptx", "ppt", "pptm", "odp"],
}

const BINARY_EXTENSIONS = new Set([
  "pdf",
  "docx",
  "doc",
  "docm",
  "odt",
  "xlsx",
  "xls",
  "xlsm",
  "ods",
  "pptx",
  "ppt",
  "pptm",
  "odp",
  "epub",
])

const SURFACE_EXTENSIONS: Record<DocumentSupportSurface, string[]> = {
  vector: [
    "txt",
    "md",
    "json",
    "csv",
    "xml",
    "html",
    "htm",
    "pdf",
    "docx",
    "doc",
    "docm",
    "odt",
    "xlsx",
    "xls",
    "xlsm",
    "ods",
    "pptx",
    "ppt",
    "pptm",
    "odp",
    "rtf",
    "epub",
  ],
  "knowledge-base": [
    "txt",
    "md",
    "json",
    "js",
    "ts",
    "tsx",
    "jsx",
    "py",
    "rs",
    "go",
    "java",
    "cpp",
    "c",
    "h",
    "pdf",
    "docx",
    "doc",
    "docm",
    "odt",
    "xlsx",
    "xls",
    "xlsm",
    "ods",
    "csv",
    "tsv",
    "html",
    "htm",
    "xml",
    "yaml",
    "yml",
    "css",
    "scss",
    "pptx",
    "ppt",
    "pptm",
    "odp",
    "rtf",
    "epub",
  ],
  "ppt-material": ["txt", "md", "pdf", "docx", "docm", "odt", "rtf", "epub", "pptx", "pptm", "odp"],
}

const DOCUMENT_TYPE_TO_KNOWLEDGE_TYPE: Record<DocumentType, KnowledgeFileType | "text"> = {
  markdown: "markdown",
  code: "code",
  text: "text",
  json: "json",
  pdf: "pdf",
  word: "word",
  excel: "excel",
  csv: "csv",
  html: "html",
  rtf: "rtf",
  epub: "epub",
  presentation: "presentation",
  unknown: "text",
}

export function getFilenameExtension(filename: string): string {
  if (filename.startsWith(".") && filename.indexOf(".", 1) === -1) {
    return ""
  }

  const parts = filename.split(".")
  return parts.length > 1 ? parts.pop()!.toLowerCase() : ""
}

export function detectDocumentTypeFromFilename(filename: string): DocumentType {
  const extension = getFilenameExtension(filename)

  for (const [type, extensions] of Object.entries(DOCUMENT_TYPE_EXTENSIONS) as Array<
    [DocumentType, string[]]
  >) {
    if (extensions.includes(extension)) {
      return type
    }
  }

  return "unknown"
}

export function isBinaryFilename(filename: string): boolean {
  return BINARY_EXTENSIONS.has(getFilenameExtension(filename))
}

export function isBinaryDocumentType(type: DocumentType): boolean {
  return ["pdf", "word", "excel", "presentation", "epub"].includes(type)
}

export function getDocumentAcceptExtensions(surface: DocumentSupportSurface): string[] {
  return SURFACE_EXTENSIONS[surface].map((extension) => `.${extension}`)
}

export function getDocumentAcceptString(surface: DocumentSupportSurface): string {
  return getDocumentAcceptExtensions(surface).join(",")
}

export function getDocumentFormatSummary(surface: DocumentSupportSurface): string {
  return getDocumentAcceptExtensions(surface).join(", ")
}

export function mapDocumentTypeToKnowledgeFileType(type: DocumentType): KnowledgeFileType | "text" {
  return DOCUMENT_TYPE_TO_KNOWLEDGE_TYPE[type] || "text"
}

export function inferKnowledgeFileTypeFromFilename(filename: string): KnowledgeFileType | "text" {
  return mapDocumentTypeToKnowledgeFileType(detectDocumentTypeFromFilename(filename))
}
