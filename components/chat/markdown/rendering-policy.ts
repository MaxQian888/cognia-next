import rehypeRaw from "rehype-raw"
import rehypeSanitize, { defaultSchema } from "rehype-sanitize"
import type { StreamdownProps } from "streamdown"

/** Shared safe HTML and URL policy for finalized, streaming, and reasoning Markdown. */
export const chatMarkdownSanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    "div",
    "span",
    "summary",
    "details",
    "figure",
    "figcaption",
    "sup",
    "sub",
    "math",
    "annotation",
    "semantics",
    "mrow",
    "mi",
    "mo",
    "mn",
    "ms",
    "mtext",
    "mspace",
    "msqrt",
    "mroot",
    "mfrac",
    "msub",
    "msup",
    "msubsup",
    "munder",
    "mover",
    "munderover",
    "mtable",
    "mtr",
    "mtd",
    "menclose",
    "maction",
    "mpadded",
    "mphantom",
    "mglyph",
    "mlabeledtr",
    "mmultiscripts",
    "mprescripts",
    "none",
    "maligngroup",
    "malignmark",
  ],
  attributes: {
    ...(defaultSchema.attributes ?? {}),
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "className", "class", "aria-hidden"],
    div: [...(defaultSchema.attributes?.div ?? []), "className", "class", "style"],
    span: [...(defaultSchema.attributes?.span ?? []), "className", "class", "style"],
    a: [...(defaultSchema.attributes?.a ?? []), "className", "class"],
    img: [...(defaultSchema.attributes?.img ?? []), "className", "class", "loading"],
    ol: [...(defaultSchema.attributes?.ol ?? []), "start"],
    th: [
      ...(defaultSchema.attributes?.th ?? []),
      "align",
      "className",
      "class",
      "rowSpan",
      "colSpan",
    ],
    td: [
      ...(defaultSchema.attributes?.td ?? []),
      "align",
      "className",
      "class",
      "rowSpan",
      "colSpan",
    ],
    math: ["xmlns", "display"],
    annotation: ["encoding"],
    mrow: ["displaystyle"],
    mtable: ["columnalign", "columnspacing", "rowspacing"],
    mtd: ["columnalign"],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: ["http", "https", "mailto", "tel", "file"],
    src: ["http", "https", "data"],
  },
}

export function chatMarkdownUrlTransform(url: string, key?: string): string {
  if (/^data:image\//i.test(url)) return key === "src" || key === undefined ? url : ""
  const colon = url.indexOf(":")
  if (colon === -1) return url
  const protocol = url.slice(0, colon).toLowerCase()
  if (["http", "https", "irc", "ircs", "mailto", "xmpp"].includes(protocol)) return url
  if (["file", "tel"].includes(protocol)) return key === "href" || key === undefined ? url : ""
  return ""
}

/** Streamdown raw parsing with the finalized renderer's safe allow-list. */
export const chatStreamdownRehypePlugins: NonNullable<StreamdownProps["rehypePlugins"]> = [
  rehypeRaw,
  [rehypeSanitize, chatMarkdownSanitizeSchema],
]
