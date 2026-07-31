/**
 * Fixture builders for the chat render-performance benchmark
 * (`tests/e2e/quality/chat-render-perf.spec.ts`).
 *
 * Dev/E2E only — reached exclusively through `expose-test-globals.tsx`, which
 * is dead-code-eliminated unless `NEXT_PUBLIC_E2E === "1"`.
 *
 * Split from the seeder so the message-shaping logic is unit-testable in
 * jsdom: `buildPerfConversation` is pure and takes the image factory as a
 * parameter (the same seam `prepareComposerAttachments` uses for
 * `optimizeImage`), while `createNoiseImageDataUrl` is the browser-only half
 * that needs a real canvas.
 */

/** 1x1 transparent PNG — the jsdom / no-canvas fallback. */
export const TRANSPARENT_PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

export interface ChatPerfMediaOptions {
  /** Total images to scatter across assistant turns, round-robin. */
  images?: number
  /** Long edge in px of each generated image. Default 1568. */
  imageLongEdge?: number
  /** Total mermaid diagrams to scatter across assistant turns. */
  charts?: number
  /** Nodes per generated mermaid diagram. Default 12. */
  chartNodes?: number
  /** When set, append one assistant turn carrying a markdown table of N rows. */
  tableRows?: number
  /** When set, append one assistant turn carrying a fenced code block of N lines. */
  codeLines?: number
}

export interface SeededPerfMessage {
  id: string
  role: "user" | "assistant"
  parts: Array<Record<string, unknown>>
  metadata: { sessionId: string; createdAt: number }
}

export interface BuildPerfConversationInput {
  sessionId: string
  /** Number of user/assistant pairs. */
  turns: number
  media?: ChatPerfMediaOptions
  /** Produces a data URL for image `index`. Injected so tests can stub it. */
  makeImage: (index: number) => string
  /** Deterministic clock base — callers pass `Date.now()` once. */
  baseTime: number
}

export interface BuildPerfConversationResult {
  messages: SeededPerfMessage[]
  /** Total bytes of image payload embedded in the conversation. */
  imageBytes: number
}

/**
 * Aspect ratio of a typical desktop screenshot (16:10). The benchmark's whole
 * point is to reproduce the agent-screenshot shape, so the short edge is
 * derived rather than configurable.
 */
const SHORT_EDGE_RATIO = 10 / 16

export function imageDimensions(longEdge: number): { width: number; height: number } {
  return { width: longEdge, height: Math.round(longEdge * SHORT_EDGE_RATIO) }
}

/**
 * Build the message array for a benchmark conversation.
 *
 * Images ride as `file` parts (`{type:"file", url, mediaType, filename}`) —
 * the shape `MessageRenderer` collects into `MessageImageGallery` and the
 * shared lightbox, i.e. the same path a real attachment or agent screenshot
 * takes. Charts/tables/code ride as markdown inside a `text` part so they go
 * through `MarkdownRenderer`'s fence routing.
 */
export function buildPerfConversation({
  sessionId,
  turns,
  media = {},
  makeImage,
  baseTime,
}: BuildPerfConversationInput): BuildPerfConversationResult {
  const { images = 0, charts = 0, chartNodes = 12, tableRows = 0, codeLines = 0 } = media

  const messages: SeededPerfMessage[] = []
  let imageBytes = 0
  let clock = baseTime

  // Spread N artifacts over `turns` assistant turns as evenly as possible:
  // turn `t` carries images with index in [floor(t*N/turns), floor((t+1)*N/turns)).
  const spread = (total: number, turn: number): [number, number] =>
    turns <= 0
      ? [0, 0]
      : [Math.floor((turn * total) / turns), Math.floor(((turn + 1) * total) / turns)]

  for (let turn = 0; turn < turns; turn++) {
    messages.push({
      id: `seed-u-${turn}`,
      role: "user",
      parts: [{ type: "text", text: `Question number ${turn}` }],
      metadata: { sessionId, createdAt: clock++ },
    })

    const parts: Array<Record<string, unknown>> = [
      {
        type: "text",
        // Long enough that a handful of turns overflow the viewport, which is
        // the precondition for anything scroll-related.
        text: `Answer number ${turn}. ${"filler ".repeat(40)}`,
      },
    ]

    const [chartFrom, chartTo] = spread(charts, turn)
    for (let c = chartFrom; c < chartTo; c++) {
      parts.push({
        type: "text",
        text: "```mermaid\n" + buildMermaidSource(chartNodes, c) + "\n```",
      })
    }

    const [imgFrom, imgTo] = spread(images, turn)
    for (let i = imgFrom; i < imgTo; i++) {
      const url = makeImage(i)
      imageBytes += url.length
      parts.push({
        type: "file",
        url,
        mediaType: dataUrlMediaType(url),
        filename: `screenshot-${i}.jpg`,
      })
    }

    messages.push({
      id: `seed-a-${turn}`,
      role: "assistant",
      parts,
      metadata: { sessionId, createdAt: clock++ },
    })
  }

  if (tableRows > 0) {
    messages.push({
      id: "seed-u-table",
      role: "user",
      parts: [{ type: "text", text: "Show me the table" }],
      metadata: { sessionId, createdAt: clock++ },
    })
    messages.push({
      id: "seed-a-table",
      role: "assistant",
      parts: [{ type: "text", text: buildMarkdownTable(tableRows) }],
      metadata: { sessionId, createdAt: clock++ },
    })
  }

  if (codeLines > 0) {
    messages.push({
      id: "seed-u-code",
      role: "user",
      parts: [{ type: "text", text: "Show me the code" }],
      metadata: { sessionId, createdAt: clock++ },
    })
    messages.push({
      id: "seed-a-code",
      role: "assistant",
      parts: [{ type: "text", text: "```ts\n" + buildCodeBlock(codeLines) + "\n```" }],
      metadata: { sessionId, createdAt: clock++ },
    })
  }

  return { messages, imageBytes }
}

/** `data:image/jpeg;base64,…` → `image/jpeg`; falls back to `image/png`. */
export function dataUrlMediaType(url: string): string {
  const match = /^data:([^;,]+)/.exec(url)
  return match ? match[1] : "image/png"
}

/**
 * A flowchart with `nodes` nodes chained in a line plus a few cross edges, so
 * layout cost grows with the node count rather than degenerating into a
 * trivially-laid-out chain.
 */
export function buildMermaidSource(nodes: number, seed: number): string {
  const count = Math.max(2, nodes)
  const lines = [`flowchart TD`]
  for (let i = 0; i < count - 1; i++) {
    lines.push(`  n${seed}_${i}["Step ${i} of diagram ${seed}"] --> n${seed}_${i + 1}`)
  }
  // Cross edges every 4th node give the layout engine real work to do.
  for (let i = 0; i + 4 < count; i += 4) {
    lines.push(`  n${seed}_${i} -.-> n${seed}_${i + 4}`)
  }
  return lines.join("\n")
}

/** A GFM table of `rows` data rows over 4 columns. */
export function buildMarkdownTable(rows: number): string {
  const lines = ["| id | name | status | detail |", "| --- | --- | --- | --- |"]
  for (let r = 0; r < rows; r++) {
    lines.push(`| ${r} | item-${r} | ${r % 3 === 0 ? "ok" : "pending"} | detail text ${r} |`)
  }
  return lines.join("\n")
}

/** `lines` lines of plausible TypeScript, for the Shiki highlight path. */
export function buildCodeBlock(lines: number): string {
  const out: string[] = []
  for (let i = 0; i < lines; i++) {
    out.push(`export const value${i} = { id: ${i}, label: "row ${i}", enabled: ${i % 2 === 0} }`)
  }
  return out.join("\n")
}

/**
 * A full-frame noise image at the requested long edge, encoded as JPEG.
 *
 * Two properties the benchmark depends on:
 *   - **Noise, not a gradient** — a compressible frame would encode to a few
 *     KB and measure nothing. Full noise lands in the same byte band as a real
 *     Retina screenshot.
 *   - **Distinct per seed** — reusing one string would let V8 share the
 *     backing store across every message, and the heap measurement would
 *     under-report by the whole point of the test.
 *
 * Returns the transparent pixel when there is no 2D context (jsdom), matching
 * how `packages/ocr/src/image-prep.ts` degrades.
 */
export function createNoiseImageDataUrl(longEdge: number, seed: number): string {
  if (typeof document === "undefined") return TRANSPARENT_PIXEL
  const { width, height } = imageDimensions(longEdge)
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d")
  if (!ctx) return TRANSPARENT_PIXEL

  const frame = ctx.createImageData(width, height)
  const data = frame.data
  // xorshift32 — seeded per image so no two frames share bytes.
  let state = seed * 2654435761 || 1
  for (let i = 0; i < data.length; i += 4) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    state |= 0
    data[i] = state & 0xff
    data[i + 1] = (state >>> 8) & 0xff
    data[i + 2] = (state >>> 16) & 0xff
    data[i + 3] = 255
  }
  ctx.putImageData(frame, 0, 0)
  return canvas.toDataURL("image/jpeg", 0.92)
}
