const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "IFRAME",
  "FRAME",
  "OBJECT",
  "EMBED",
  "CANVAS",
  "SVG",
  "AUDIO",
  "VIDEO",
  "INPUT",
  "TEXTAREA",
  "SELECT",
  "OPTION",
  "BUTTON",
  "DATALIST",
  "OUTPUT",
])

/** Check the live ancestors too: a detached clone has already lost their CSS. */
export function isCaptureVisible(node: Node): boolean {
  let element = node.nodeType === 1 ? (node as Element) : node.parentElement
  while (element) {
    const editable = element.getAttribute("contenteditable")
    if (
      // Upper-cased: an SVG or MathML element keeps its lower-case tag name in
      // an HTML document, so a set of upper-case names alone misses `svg`.
      SKIP_TAGS.has(element.tagName.toUpperCase()) ||
      element.hasAttribute("hidden") ||
      element.getAttribute("aria-hidden") === "true" ||
      (editable !== null && editable.toLowerCase() !== "false") ||
      (element as HTMLElement).isContentEditable
    )
      return false
    const view = element.ownerDocument.defaultView
    if (typeof view?.getComputedStyle === "function") {
      const style = view.getComputedStyle(element)
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
        return false
      }
    }
    element = element.parentElement
  }
  return true
}

export function escapeMarkdown(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/([*_`\[\]~|!=])/g, "\\$1")
    .replace(/</g, "&lt;")
    .replace(/([#>+\-])/g, "\\$1")
    .replace(/(\d)\./g, "$1\\.")
    .replace(/^\./, "\\.")
}

export function nodeToMarkdown(root: Node, baseUrl: string): string {
  const verbatim: string[] = []
  let marker = "\uE000"
  const markup = (node: Node): string =>
    node.nodeType === 1
      ? (node as Element).outerHTML
      : node.nodeType === 3
        ? (node.textContent ?? "")
        : Array.from(node.childNodes).map(markup).join("")
  const source = markup(root) + baseUrl
  while (source.includes(marker)) marker += "\uE000"
  const preserve = (value: string): string => {
    const index = verbatim.push(value) - 1
    return `${marker}${index}${marker}`
  }
  const children = (node: Node): string => Array.from(node.childNodes).map(render).join("")
  const plain = (node: Node): string => {
    if (!isCaptureVisible(node)) return ""
    if (node.nodeType === 3) return node.textContent ?? ""
    return Array.from(node.childNodes).map(plain).join("")
  }
  const absolute = (value: string | null): string | null => {
    if (!value?.trim()) return null
    try {
      const url = new URL(value, baseUrl)
      if (["javascript:", "data:", "vbscript:"].includes(url.protocol)) return null
      return url.href.replace(/[()<>|\s]/g, (char) =>
        encodeURIComponent(char).replace(/\(/g, "%28").replace(/\)/g, "%29")
      )
    } catch {
      return null
    }
  }
  const block = (value: string): string => (value.trim() ? `\n\n${value.trim()}\n\n` : "")

  function render(node: Node): string {
    if (!isCaptureVisible(node)) return ""
    if (node.nodeType === 3) return escapeMarkdown((node.textContent ?? "").replace(/\s+/g, " "))
    if (node.nodeType !== 1) return children(node)
    const element = node as Element
    const tag = element.tagName
    if (tag === "PRE") {
      const code = element.querySelector("code")
      const language =
        `${code?.className ?? ""} ${element.className}`.match(
          /(?:^|\s)(?:language|lang)-([\w+-]+)/
        )?.[1] ?? ""
      const text = plain(element).replace(/\r\n?/g, "\n")
      const longest = (text.match(/`+/g) ?? []).reduce(
        (length, run) => Math.max(length, run.length),
        2
      )
      const fence = "`".repeat(longest + 1)
      return block(
        preserve(`${fence}${language}\n${text}${text.endsWith("\n") ? "" : "\n"}${fence}`)
      )
    }
    if (tag === "CODE") {
      const text = plain(element).replace(/\s+/g, " ")
      const ticks = "`".repeat(
        (text.match(/`+/g) ?? []).reduce((length, run) => Math.max(length, run.length), 0) + 1
      )
      const pad = /^[` ]|[` ]$/.test(text) ? " " : ""
      return preserve(`${ticks}${pad}${text}${pad}${ticks}`)
    }
    if (tag === "UL" || tag === "OL") {
      let index = Number.parseInt(element.getAttribute("start") ?? "1", 10)
      if (!Number.isFinite(index)) index = 1
      const items = Array.from(element.children).filter(
        (child) => child.tagName === "LI" && isCaptureVisible(child)
      )
      return block(
        items
          .map((item) => {
            const prefix = tag === "OL" ? `${index++}. ` : "- "
            const lines = children(item).trim().split("\n")
            return (
              prefix +
              lines
                .map((line, i) => (i === 0 ? line : line ? " ".repeat(prefix.length) + line : ""))
                .join("\n")
            )
          })
          .join("\n")
      )
    }
    if (tag === "TABLE") {
      const rows = Array.from(element.querySelectorAll("tr")).filter(
        (row) => row.closest("table") === element && isCaptureVisible(row)
      )
      const header = rows.find((row) => row.parentElement?.tagName === "THEAD") ?? rows[0]
      if (!header) return ""
      const ordered = [header, ...rows.filter((row) => row !== header)]
      const cells = ordered.map((row) =>
        Array.from(row.children)
          .filter((cell) => /^(TH|TD)$/.test(cell.tagName) && isCaptureVisible(cell))
          .flatMap((cell) => {
            const start = verbatim.length
            const value = children(cell).replace(/\s+/g, " ").trim()
            for (let i = start; i < verbatim.length; i++) {
              verbatim[i] = verbatim[i]!.replace(/\s+/g, " ").replace(/\|/g, "\\|")
            }
            return [
              value,
              ...Array.from(
                { length: Math.max(1, (cell as HTMLTableCellElement).colSpan) - 1 },
                () => ""
              ),
            ]
          })
      )
      const width = Math.max(...cells.map((row) => row.length))
      if (!width) return ""
      const line = (row: string[]) =>
        `| ${Array.from({ length: width }, (_, i) => row[i] ?? "").join(" | ")} |`
      return block(
        [
          line(cells[0]!),
          line(Array.from({ length: width }, () => "---")),
          ...cells.slice(1).map(line),
        ].join("\n")
      )
    }
    if (tag === "IMG") {
      const src = absolute(element.getAttribute("src"))
      const image = element as HTMLImageElement
      const style = element.ownerDocument.defaultView?.getComputedStyle?.(element)
      const width = image.width || Number.parseFloat(style?.width ?? "")
      const height = image.height || Number.parseFloat(style?.height ?? "")
      if (
        !src ||
        (width === 1 && height === 1) ||
        (image.naturalWidth === 1 && image.naturalHeight === 1)
      )
        return ""
      return `![${escapeMarkdown((element.getAttribute("alt") ?? "").replace(/\s+/g, " "))}](${src})`
    }
    const value = children(element)
    if (/^H[1-6]$/.test(tag)) return block(`${"#".repeat(Number(tag[1]))} ${value.trim()}`)
    if (tag === "BR") return "\n"
    if (tag === "HR") return block("---")
    const wrap = (mark: string): string =>
      value.trim()
        ? `${/^\s/.test(value) ? " " : ""}${mark}${value.trim()}${mark}${/\s$/.test(value) ? " " : ""}`
        : value
    if (tag === "STRONG" || tag === "B") return wrap("**")
    if (tag === "EM" || tag === "I") return wrap("*")
    if (tag === "DEL" || tag === "S") return wrap("~~")
    if (tag === "A") {
      const href = absolute(element.getAttribute("href"))
      if (!href) return value
      if (plain(element).trim() === href) return `<${href}>`
      return `[${value.trim()}](${href})`
    }
    if (tag === "BLOCKQUOTE")
      return block(
        value
          .trim()
          .replace(/\n{3,}/g, "\n\n")
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n")
      )
    if (tag === "DT") return block(`**${value.trim()}**`)
    if (tag === "DD") return block(value)
    if (/^(P|DIV|SECTION|ARTICLE|MAIN|HEADER|FOOTER|NAV|ASIDE|FIGURE|FIGCAPTION|DL)$/.test(tag))
      return block(value)
    return value
  }

  // Keep leading indentation: it belongs to nested lists, not HTML whitespace.
  const result = render(root)
    .split("\n")
    .map((line) => (/^\s*(?:>\s*)*\|/.test(line) ? line : line.replace(/(\S)[ \t]+/g, "$1 ")))
    .join("\n")
    .replace(/[^\S\n]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return result.replace(
    new RegExp(`${marker}(\\d+)${marker}`, "g"),
    (_, index: string, offset: number) => {
      const prefix = result
        .slice(result.lastIndexOf("\n", offset - 1) + 1, offset)
        .replace(/(?:- |\d+\. )$/, (list) => " ".repeat(list.length))
      const indentation = /^[\s>]*$/.test(prefix) ? prefix : ""
      return verbatim[Number(index)]!.replace(/\n/g, `\n${indentation}`)
    }
  )
}
