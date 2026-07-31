/**
 * CJS-compatible mock for react-markdown used in Jest tests.
 *
 * Implements a minimal line-based markdown parser that covers the
 * specific patterns exercised by markdown-renderer.test.tsx:
 *   • fenced code blocks (```lang\n...\n```)
 *   • ATX headings (# / ## / ### / ####)
 *   • GFM tables (| A | B | / |---|---|)
 *   • blockquotes (> text)
 *   • horizontal rules (---)
 *   • unordered lists (- item)
 *   • ordered lists (1. item)
 *   • links ([text](url))
 *   • inline code (`code`)
 *   • plain paragraphs
 *
 * The `remarkPlugins` / `rehypePlugins` props are accepted but ignored —
 * this mock does not process remark/rehype pipelines.
 */
const React = require("react")

function callComp(components, name, props, ...children) {
  const Comp = (components && components[name]) || name
  return React.createElement(Comp, props, ...children)
}

function parseMarkdown(text, components) {
  if (!text || typeof text !== "string") return []

  const elements = []
  let key = 0
  // Split on real newlines (\n char 10) and also on the literal two-character
  // sequence \+n that the SWC JSX transform emits for attribute strings like
  // content="line1\nline2" (JSX attrs don't process JS escape sequences).
  const lines = text.split(/\n|\\n/)
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // ── fenced code block ─────────────────────────────────
    if (/^```/.test(line)) {
      const lang = line.slice(3).trim()
      const codeLines = []
      i++
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i])
        i++
      }
      // react-markdown keeps the terminal newline for block code. Preserve it
      // here so tests can distinguish a one-line fence without a language from
      // inline code through the same observable children shape.
      const codeContent = `${codeLines.join("\n")}\n`
      const codeEl = callComp(
        components,
        "code",
        {
          key: key++,
          className: lang ? `language-${lang}` : undefined,
        },
        codeContent
      )
      elements.push(callComp(components, "pre", { key: key++ }, codeEl))
      i++ // skip closing ```
      continue
    }

    // ── math ──────────────────────────────────────────────
    const displayMathMatch = line.match(/^\$\$(.+)\$\$$/)
    if (displayMathMatch) {
      const codeEl = callComp(
        components,
        "code",
        { key: key++, className: "language-math math-display" },
        `${displayMathMatch[1]}\n`
      )
      elements.push(callComp(components, "pre", { key: key++ }, codeEl))
      i++
      continue
    }

    const inlineMathMatch = line.match(/^\$([^$]+)\$$/)
    if (inlineMathMatch) {
      elements.push(
        callComp(
          components,
          "p",
          { key: key++ },
          callComp(
            components,
            "code",
            { key: key++, className: "language-math math-inline" },
            inlineMathMatch[1]
          )
        )
      )
      i++
      continue
    }

    // ── ATX headings ──────────────────────────────────────
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/)
    if (headingMatch) {
      const level = headingMatch[1].length
      elements.push(callComp(components, `h${level}`, { key: key++ }, headingMatch[2]))
      i++
      continue
    }

    // ── GFM table ─────────────────────────────────────────
    if (line.startsWith("|") && i + 1 < lines.length && /^\|[\s:|-]+\|/.test(lines[i + 1])) {
      const parseRow = (row) =>
        row
          .split("|")
          .slice(1, -1)
          .map((c) => c.trim())

      const headers = parseRow(line)
      i += 2 // skip separator
      const rows = []
      while (i < lines.length && lines[i].startsWith("|")) {
        rows.push(parseRow(lines[i]))
        i++
      }

      const thead = React.createElement(
        "thead",
        { key: "thead" },
        React.createElement(
          "tr",
          { key: "hrow" },
          headers.map((h, hi) => callComp(components, "th", { key: hi }, h))
        )
      )
      const tbody = React.createElement(
        "tbody",
        { key: "tbody" },
        rows.map((cells, ri) =>
          React.createElement(
            "tr",
            { key: ri },
            cells.map((c, ci) => callComp(components, "td", { key: ci }, c))
          )
        )
      )
      elements.push(callComp(components, "table", { key: key++ }, thead, tbody))
      continue
    }

    // ── blockquote ────────────────────────────────────────
    if (line.startsWith("> ")) {
      const content = line.slice(2)
      elements.push(
        callComp(
          components,
          "blockquote",
          { key: key++ },
          callComp(components, "p", { key: key++ }, content)
        )
      )
      i++
      continue
    }

    // ── horizontal rule ───────────────────────────────────
    if (/^---+\s*$/.test(line)) {
      elements.push(callComp(components, "hr", { key: key++ }))
      i++
      continue
    }

    // ── safe raw HTML elements ────────────────────────────
    const detailsMatch = line.match(
      /^<details><summary>(.*?)<\/summary>(.*?)<\/details>$/
    )
    if (detailsMatch) {
      const summary = callComp(components, "summary", { key: key++ }, detailsMatch[1])
      elements.push(
        callComp(components, "details", { key: key++ }, summary, detailsMatch[2])
      )
      i++
      continue
    }

    const kbdMatch = line.match(/^<kbd>(.*?)<\/kbd>$/)
    if (kbdMatch) {
      elements.push(callComp(components, "kbd", { key: key++ }, kbdMatch[1]))
      i++
      continue
    }

    // ── unordered list ────────────────────────────────────
    if (/^[-*]\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s+/, ""))
        i++
      }
      elements.push(
        callComp(
          components,
          "ul",
          { key: key++ },
          items.map((item, idx) => {
            const task = item.match(/^\[([ xX])\]\s+(.*)$/)
            if (!task) return callComp(components, "li", { key: idx }, item)
            return callComp(
              components,
              "li",
              { key: idx },
              React.createElement("input", {
                key: "checkbox",
                type: "checkbox",
                disabled: true,
                checked: task[1].toLowerCase() === "x",
                readOnly: true,
              }),
              ` ${task[2]}`
            )
          })
        )
      )
      continue
    }

    // ── ordered list ──────────────────────────────────────
    if (/^\d+\.\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ""))
        i++
      }
      elements.push(
        callComp(
          components,
          "ol",
          { key: key++ },
          items.map((item, idx) => callComp(components, "li", { key: idx }, item))
        )
      )
      continue
    }

    // ── image ![alt](url) ─────────────────────────────────
    const imageMatch = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/)
    if (imageMatch) {
      elements.push(
        callComp(components, "img", {
          key: key++,
          src: imageMatch[2],
          alt: imageMatch[1],
        })
      )
      i++
      continue
    }

    // ── link [text](url) ──────────────────────────────────
    const linkMatch = line.match(/\[([^\]]+)\]\(([^)]+)\)/)
    if (linkMatch) {
      elements.push(
        callComp(
          components,
          "p",
          { key: key++ },
          callComp(components, "a", { key: key++, href: linkMatch[2] }, linkMatch[1])
        )
      )
      i++
      continue
    }

    // ── inline code `...` ─────────────────────────────────
    const inlineCodeMatch = line.match(/`([^`]+)`/)
    if (inlineCodeMatch) {
      elements.push(
        callComp(
          components,
          "p",
          { key: key++ },
          callComp(components, "code", { key: key++ }, inlineCodeMatch[1])
        )
      )
      i++
      continue
    }

    // ── plain paragraph ───────────────────────────────────
    if (line.trim()) {
      elements.push(callComp(components, "p", { key: key++ }, line))
    }

    i++
  }

  return elements
}

function ReactMarkdown({
  children,
  components,
  // captured for integration-order assertions; this mock does not execute the
  // remark/rehype pipeline itself.
  remarkPlugins = [],
  rehypePlugins: _h,
  ..._rest
}) {
  const els = parseMarkdown(children, components)
  const remarkOrder = remarkPlugins
    .map((plugin) => {
      const value = Array.isArray(plugin) ? plugin[0] : plugin
      return typeof value === "function" ? value.name : "unknown"
    })
    .join(",")
  return React.createElement(
    React.Fragment,
    null,
    React.createElement("span", {
      hidden: true,
      "data-testid": "react-markdown-config",
      "data-remark-order": remarkOrder,
    }),
    ...els
  )
}

module.exports = ReactMarkdown
module.exports.default = ReactMarkdown
module.exports.__esModule = true
