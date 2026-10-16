import { isCaptureVisible, nodeToMarkdown } from "./html-to-markdown"

const POSITIVE = /(?:^|[^a-z])(article|content|entry|main|post|story|text|body)(?:$|[^a-z])/i
const NEGATIVE =
  /(?:^|[^a-z])(nav|footer|header|sidebar|aside|comment|comments|menu|share|social|related|promo|ad|ads|banner|sponsor|modal|cookie|subscribe)(?:$|[^a-z])/i
const MAIN = 'article, main, [role="main"], [itemprop="articleBody"]'

function hints(element: Element): string {
  return `${element.id} ${element.className}`.replace(/([a-z])([A-Z])/g, "$1 $2")
}

function negative(element: Element): boolean {
  return /^(NAV|FOOTER|ASIDE)$/.test(element.tagName) || NEGATIVE.test(hints(element))
}

export function extractArticle(
  doc: Document
): { markdown: string; characterCount: number; title: string } | null {
  if (!doc.body) return null
  // Filter against live layout before cloning, so ancestor selectors and
  // inherited visibility still apply without changing the page underneath us.
  const copy = (node: Node): Node | null => {
    if (!isCaptureVisible(node) || (node.nodeType === 1 && negative(node as Element))) return null
    const clone = node.cloneNode(false)
    for (const child of Array.from(node.childNodes)) {
      const kept = copy(child)
      if (kept) clone.appendChild(kept)
    }
    return clone
  }
  const body = copy(doc.body) as HTMLElement | null
  if (!body) return null
  const text = (element: Element): string => (element.textContent ?? "").replace(/\s+/g, " ").trim()
  const density = (element: Element): number => {
    const length = text(element).length
    return length
      ? Array.from(element.querySelectorAll("a")).reduce(
          (sum, link) => sum + text(link).length,
          0
        ) / length
      : 1
  }
  const candidates = Array.from(body.querySelectorAll(`div, section, ${MAIN}`))
  const scores = new Map<Element, number>()
  for (const candidate of candidates) {
    const paragraphs = Array.from(candidate.querySelectorAll("p")).filter(
      (paragraph) => text(paragraph).length >= 60 && density(paragraph) < 0.5
    )
    const prose = paragraphs.reduce((sum, paragraph) => sum + text(paragraph).length, 0)
    const length = text(candidate).length
    const semantic = candidate.matches(MAIN)
    if (density(candidate) >= 0.5 || (prose < 160 && !(semantic && length >= 240))) continue
    const score = paragraphs.reduce(
      (sum, paragraph) =>
        sum +
        Math.min(text(paragraph).length, 500) / 50 +
        (text(paragraph).match(/[,，]/g)?.length ?? 0),
      0
    )
    const hint = POSITIVE.test(hints(candidate)) ? 10 : 0
    scores.set(candidate, (score + hint + (semantic ? 25 : 0)) * (1 - density(candidate)))
  }
  const top = [...scores].sort((a, b) => b[1] - a[1] || text(a[0]).length - text(b[0]).length)[0]
  if (!top) return null
  const [best, score] = top
  const selected = doc.createElement("div")
  for (const sibling of Array.from(best.parentElement?.children ?? [best])) {
    const substantialParagraph =
      sibling.tagName === "P" && text(sibling).length >= 100 && density(sibling) < 0.25
    if (
      sibling === best ||
      (scores.get(sibling) ?? 0) >= Math.max(10, score * 0.25) ||
      substantialParagraph
    ) {
      selected.appendChild(sibling.cloneNode(true))
    }
  }
  const markdown = nodeToMarkdown(selected, doc.baseURI)
  if (!markdown) return null
  const title =
    doc.querySelector('meta[property="og:title"]')?.getAttribute("content")?.trim() ||
    selected.querySelector("h1")?.textContent?.trim() ||
    doc.title
  return { markdown, characterCount: markdown.length, title }
}
