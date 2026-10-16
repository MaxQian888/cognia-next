import { isCaptureVisible, nodeToMarkdown } from "./html-to-markdown"

function selectionFragments(selection: Selection): DocumentFragment[] {
  const parts: DocumentFragment[] = []
  for (let i = 0; i < selection.rangeCount; i++) {
    const range = selection.getRangeAt(i)
    if (!isCaptureVisible(range.commonAncestorContainer)) continue
    const fragment = range.cloneContents()
    // cloneContents keeps markup, but loses inherited CSS. Pair the cloned
    // range with the original nodes before deciding what may contribute.
    const prune = (source: Node, clone: Node): void => {
      const sources = Array.from(source.childNodes).filter((node) => range.intersectsNode(node))
      Array.from(clone.childNodes).forEach((child, index) => {
        const original = sources[index]
        if (!original || !isCaptureVisible(original)) child.parentNode?.removeChild(child)
        else prune(original, child)
      })
    }
    if (range.commonAncestorContainer.nodeType !== 3) prune(range.commonAncestorContainer, fragment)
    parts.push(fragment)
  }
  return parts
}

export function selectionToMarkdown(selection: Selection, baseUrl: string): string {
  return selectionFragments(selection)
    .map((fragment) => nodeToMarkdown(fragment, baseUrl))
    .filter(Boolean)
    .join("\n\n")
}

export function selectionToText(selection: Selection): string {
  return selectionFragments(selection)
    .map((fragment) => (fragment.textContent ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n")
}
