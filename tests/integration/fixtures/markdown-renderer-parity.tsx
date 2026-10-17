import { renderToStaticMarkup } from "react-dom/server"
import { NextIntlClientProvider } from "next-intl"
import { load } from "cheerio"
import { Streamdown } from "streamdown"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import rehypeRaw from "rehype-raw"
import rehypeSanitize from "rehype-sanitize"

import messages from "@/i18n/messages/en.json"
import {
  chatMarkdownSanitizeSchema,
  chatMarkdownUrlTransform,
  chatStreamdownRehypePlugins,
} from "@/components/chat/markdown/rendering-policy"
import { createSharedMarkdownComponents } from "@/components/chat/markdown/shared-components"
import { TooltipProvider } from "@/components/ui/tooltip"

const markdown = [
  "4. fourth",
  "5. fifth",
  "",
  "| Left | Center | Right |",
  "| :--- | :----: | ----: |",
  "| A | B | C |",
  "",
  "<details><summary>More</summary>Body</details>",
  "",
  "<kbd>Cmd</kbd>",
  "",
  "[call](tel:+12025550123) [project](file:///repo/file.ts) [unsafe](javascript:alert(1))",
  "",
  "![pixel](data:image/png;base64,iVBORw0KGgo=)",
].join("\n")

function withMessages(children: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <TooltipProvider>{children}</TooltipProvider>
    </NextIntlClientProvider>
  )
}

function summarize(html: string) {
  const $ = load(html)
  return {
    orderedListStart: $("ol").first().attr("start"),
    tableAlignment: $("th")
      .map((_, element) => $(element).attr("align") ?? $(element).attr("style"))
      .get(),
    details: $('[data-slot="collapsible-trigger"]').first().text().trim().endsWith("More"),
    keyboard: $('[data-slot="kbd"]').first().text(),
    tel: $('a[href^="tel:"]').length,
    file: $('a[href^="file:"]').length,
    unsafe: $('a[href^="javascript:"]').length,
    dataImage: $('img[src^="data:image/png"]').length,
  }
}

const sharedComponents = createSharedMarkdownComponents({ enableEnhancedImages: false })
const finalized = renderToStaticMarkup(
  withMessages(
    <ReactMarkdown
      components={sharedComponents}
      rehypePlugins={[rehypeRaw, [rehypeSanitize, chatMarkdownSanitizeSchema]]}
      remarkPlugins={[remarkGfm]}
      urlTransform={chatMarkdownUrlTransform}
    >
      {markdown}
    </ReactMarkdown>
  )
)
const streaming = renderToStaticMarkup(
  withMessages(
    <Streamdown
      components={sharedComponents}
      controls={{ table: false }}
      linkSafety={{ enabled: false }}
      mode="static"
      rehypePlugins={chatStreamdownRehypePlugins}
      urlTransform={chatMarkdownUrlTransform}
    >
      {markdown}
    </Streamdown>
  )
)

function renderMedia(markdown: string, streaming: boolean, enableEnhancedImages = true) {
  const components = createSharedMarkdownComponents({
    enableEnhancedImages,
    isStreaming: streaming,
  })
  return renderToStaticMarkup(
    withMessages(
      streaming ? (
        <Streamdown
          components={components}
          controls={{ table: false }}
          linkSafety={{ enabled: false }}
          mode="static"
          rehypePlugins={chatStreamdownRehypePlugins}
          urlTransform={chatMarkdownUrlTransform}
        >
          {markdown}
        </Streamdown>
      ) : (
        <ReactMarkdown
          components={components}
          rehypePlugins={[rehypeRaw, [rehypeSanitize, chatMarkdownSanitizeSchema]]}
          remarkPlugins={[remarkGfm]}
          urlTransform={chatMarkdownUrlTransform}
        >
          {markdown}
        </ReactMarkdown>
      )
    )
  )
}

function summarizeMedia(html: string) {
  // HTML parsers repair <p><figure> before selectors can catch it. XML mode
  // preserves the server markup so this check can detect the hydration bug.
  const $ = load(html, { xmlMode: true })
  return {
    invalidParagraphDescendants: $("p figure, p div").length,
    figures: $("figure").length,
    mediaParagraphs: $("[data-markdown-paragraph]").length,
  }
}

const media = [
  "![diagram](https://cdn.example.com/diagram.png)",
  "Before ![diagram](https://cdn.example.com/diagram.png) after",
  "[![diagram](https://cdn.example.com/diagram.png)](https://example.com)",
  "**![diagram](https://cdn.example.com/diagram.png)**",
  "> ![diagram](https://cdn.example.com/diagram.png)",
  "- Before ![diagram](https://cdn.example.com/diagram.png) after\n\n  More text",
  "Before ![video](https://cdn.example.com/demo.mp4) after",
  "Before ![audio](https://cdn.example.com/demo.mp3) after",
].map((markdown, index) => ({
  finalized: summarizeMedia(renderMedia(markdown, false, index < 6)),
  streaming: summarizeMedia(renderMedia(markdown, true, index < 6)),
}))
const nativeHtml = load(
  renderMedia(
    "Ordinary **text**.\n\nBefore ![image](https://cdn.example.com/pic.png) after",
    false,
    false
  ),
  { xmlMode: true }
)

process.stdout.write(
  JSON.stringify({
    finalized: summarize(finalized),
    streaming: summarize(streaming),
    media,
    nativeImages: {
      paragraphs: nativeHtml("p").length,
      mediaParagraphs: nativeHtml("[data-markdown-paragraph]").length,
    },
  })
)
