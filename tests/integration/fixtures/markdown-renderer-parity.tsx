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
      {children}
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

process.stdout.write(
  JSON.stringify({ finalized: summarize(finalized), streaming: summarize(streaming) })
)
