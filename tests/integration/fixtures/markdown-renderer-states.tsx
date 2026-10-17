// Run outside Jest's simplified react-markdown mock. Only expensive leaf
// renderers are replaced; parsing, routing, placeholders and boundaries are real.
import React, { act } from "react"
import { createRoot, hydrateRoot, type Root } from "react-dom/client"
import { renderToString } from "react-dom/server"
import { createRequire } from "node:module"
import { load } from "cheerio"
import { NextIntlClientProvider } from "next-intl"
import { MarkdownRenderer } from "@/components/chat/markdown-renderer"
import { TooltipProvider } from "@/components/ui/tooltip"
import messages from "@/i18n/messages/en.json"

async function main() {
  // JSDOM is supplied by the existing Jest environment, not an app dependency.
  const { JSDOM } = createRequire(require.resolve("jest-environment-jsdom"))("jsdom")
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://example.com" })
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })

  const failures: string[] = []
  const originalError = console.error
  const originalLog = console.log
  const originalWarn = console.warn
  console.log = () => undefined
  console.warn = () => undefined
  console.error = (...args: unknown[]) => {
    const message = args.map(String).join(" ")
    if (/cannot (?:contain|be)|hydration|hydrated/i.test(message)) failures.push(message)
  }

  const languages = ["mermaid", "diff", "chart", "a2ui", "math", "javascript"]
  const cases = [
    ...languages.map((language) => ({
      content: `Before <code class="language-${language}">x</code> after`,
      inline: true,
    })),
    ...languages.map((language) => ({
      content: `<a href="https://example.com"><code class="language-${language}">x</code></a>`,
      inline: true,
    })),
    { content: "Before <code>first\nsecond</code> after", inline: true },
    { content: 'Before <code class="language-math math-display">x</code> after', inline: true },
    { content: "Before $x^2$ after", inline: true },
    { content: "[Before $x^2$ after](https://example.com)", inline: true },
    ...languages.map((language) => ({ content: `\`\`\`${language}\nx\n\`\`\``, inline: false })),
    ...languages.map((language) => ({
      content: `<pre><code class="language-${language}">x</code></pre>`,
      inline: false,
    })),
    { content: "```\nx\n```", inline: false },
    { content: "    indented code", inline: false },
    { content: "$$\nx^2\n$$", inline: false },
  ]

  const results = []
  try {
    for (const state of ["loading", "success", "error"]) {
      process.env.MARKDOWN_RENDER_STATE = state
      for (const { content, inline } of cases) {
        const element = (
          <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
            <TooltipProvider>
              <MarkdownRenderer content={content} />
            </TooltipProvider>
          </NextIntlClientProvider>
        )
        const container = document.createElement("div")
        document.body.append(container)
        let root: Root | undefined
        let invalidServerElements = 0
        if (state === "error") {
          const created = createRoot(container)
          root = created
          await act(async () => created.render(element))
        } else {
          const html = renderToString(element)
          // XML mode preserves invalid server nesting instead of repairing it.
          const $ = load(html, { xmlMode: true })
          invalidServerElements = $("p div, p pre, p figure, p p, a button, a [tabindex]").length
          container.innerHTML = html
          await act(async () => {
            root = hydrateRoot(container, element, {
              onRecoverableError: (error) => failures.push(String(error)),
            })
          })
        }
        results.push({
          state,
          content,
          inline,
          invalidServerElements,
          invalidClientElements: container.querySelectorAll(
            "p div, p pre, p figure, p p, a button, a [tabindex]"
          ).length,
          hasParagraph: Boolean(container.querySelector("p")),
          hasBlock: Boolean(container.querySelector(".not-typeset")),
          hasLoading: Boolean(container.querySelector('[data-slot="skeleton"]')),
          hasError: Boolean(
            container.querySelector('[data-rich-block-error], [aria-label="Math render error"]')
          ),
        })
        await act(async () => root!.unmount())
        container.remove()
      }
    }
  } finally {
    console.error = originalError
    console.log = originalLog
    console.warn = originalWarn
    dom.window.close()
  }
  process.stdout.write("\nMARKDOWN_STATE_RESULT=" + JSON.stringify({ results, failures }))
}

// Logger transports used by the real error boundaries keep background timers.
// Exit only after every render, assertion snapshot and unmount has completed.
void main().then(() => process.exit(0))
