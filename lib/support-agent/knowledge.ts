import generatedCorpus from "./support-docs.generated.json"

export interface SupportDocEntry {
  path: string
  title: string
  text: string
}

interface GeneratedSupportCorpus {
  schemaVersion: number
  locales: Record<"en" | "zh", SupportDocEntry[]>
}

const generated = generatedCorpus as GeneratedSupportCorpus

export const SUPPORT_DOC_CORPUS = generated.locales

function terms(value: string): string[] {
  const normalized = value.toLocaleLowerCase()
  const words = normalized.match(/[a-z0-9][a-z0-9_-]+/g) ?? []
  const cjkRuns = normalized.match(/[\p{Script=Han}]+/gu) ?? []
  const cjk = cjkRuns.flatMap((run) => {
    const characters = [...run]
    if (characters.length < 2) return characters
    return characters.slice(0, -1).map((character, index) => character + characters[index + 1])
  })
  return [...new Set([...words, ...cjk])]
}

function scoreDocument(document: SupportDocEntry, queryTerms: string[]): number {
  if (queryTerms.length === 0) return /^(index|get.*started)\./i.test(document.path) ? 1 : 0
  const title = document.title.toLocaleLowerCase()
  const pathName = document.path.toLocaleLowerCase()
  const text = document.text.toLocaleLowerCase()
  return queryTerms.reduce((score, term) => {
    if (title.includes(term)) score += 10
    if (pathName.includes(term)) score += 6
    if (text.includes(term)) score += 2
    return score
  }, 0)
}

export function retrieveSupportDocumentation({
  locale,
  query = "",
  limit = 6,
  maxChars = 6_000,
}: {
  locale?: string
  query?: string
  limit?: number
  maxChars?: number
}): string {
  const language = locale?.toLocaleLowerCase().startsWith("zh") ? "zh" : "en"
  const queryTerms = terms(query)
  const ranked = SUPPORT_DOC_CORPUS[language]
    .map((document) => ({ document, score: scoreDocument(document, queryTerms) }))
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || left.document.path.localeCompare(right.document.path)
    )

  const selected =
    ranked.length > 0
      ? ranked.slice(0, Math.max(1, limit))
      : SUPPORT_DOC_CORPUS[language]
          .filter(
            (document) => document.path === "index.mdx" || document.path === "getting-started.mdx"
          )
          .map((document) => ({ document, score: 0 }))

  let result = ""
  for (const { document } of selected) {
    const source = `docs/content/docs/${language}/${document.path}`
    const block = `- [${source}] ${document.title}: ${document.text}\n`
    if (result.length + block.length > maxChars) {
      if (result.length === 0) result = block.slice(0, maxChars)
      break
    }
    result += block
  }
  return result.trimEnd()
}
