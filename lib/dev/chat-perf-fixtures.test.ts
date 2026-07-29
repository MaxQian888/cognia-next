import {
  TRANSPARENT_PIXEL,
  buildCodeBlock,
  buildMarkdownTable,
  buildMermaidSource,
  buildPerfConversation,
  createNoiseImageDataUrl,
  dataUrlMediaType,
  imageDimensions,
  type SeededPerfMessage,
} from "./chat-perf-fixtures"

const makeImage = (index: number) => `data:image/jpeg;base64,IMG${index}`

function build(overrides: Partial<Parameters<typeof buildPerfConversation>[0]> = {}) {
  return buildPerfConversation({
    sessionId: "s1",
    turns: 2,
    makeImage,
    baseTime: 1000,
    ...overrides,
  })
}

function partsOf(messages: SeededPerfMessage[], id: string) {
  return messages.find((m) => m.id === id)?.parts ?? []
}

describe("buildPerfConversation", () => {
  it("emits one user and one assistant message per turn with a monotonic clock", () => {
    const { messages } = build({ turns: 3 })

    expect(messages).toHaveLength(6)
    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ])
    expect(messages.map((m) => m.id)).toEqual([
      "seed-u-0",
      "seed-a-0",
      "seed-u-1",
      "seed-a-1",
      "seed-u-2",
      "seed-a-2",
    ])
    const times = messages.map((m) => m.metadata.createdAt)
    expect(times).toEqual([1000, 1001, 1002, 1003, 1004, 1005])
    expect(messages.every((m) => m.metadata.sessionId === "s1")).toBe(true)
  })

  it("returns no messages for zero turns", () => {
    expect(build({ turns: 0 }).messages).toEqual([])
  })

  it("spreads images across assistant turns and reports their byte total", () => {
    const { messages, imageBytes } = build({ turns: 2, media: { images: 4 } })

    const first = partsOf(messages, "seed-a-0").filter((p) => p.type === "file")
    const second = partsOf(messages, "seed-a-1").filter((p) => p.type === "file")
    expect(first).toHaveLength(2)
    expect(second).toHaveLength(2)
    expect(imageBytes).toBe([0, 1, 2, 3].reduce((sum, index) => sum + makeImage(index).length, 0))
  })

  it("gives each image the file-part shape the renderer collects into the gallery", () => {
    const { messages } = build({ turns: 1, media: { images: 1 } })

    expect(partsOf(messages, "seed-a-0")[1]).toEqual({
      type: "file",
      url: "data:image/jpeg;base64,IMG0",
      mediaType: "image/jpeg",
      filename: "screenshot-0.jpg",
    })
  })

  it("distributes an image count that does not divide evenly across turns", () => {
    const { messages } = build({ turns: 3, media: { images: 5 } })

    const perTurn = [0, 1, 2].map(
      (turn) => partsOf(messages, `seed-a-${turn}`).filter((p) => p.type === "file").length
    )
    expect(perTurn.reduce((a, b) => a + b, 0)).toBe(5)
    expect(Math.max(...perTurn) - Math.min(...perTurn)).toBeLessThanOrEqual(1)
  })

  it("drops media when there are no turns to carry it", () => {
    const { messages, imageBytes } = build({ turns: 0, media: { images: 3, charts: 2 } })

    expect(messages).toEqual([])
    expect(imageBytes).toBe(0)
  })

  it("scatters mermaid fences across assistant turns", () => {
    const { messages } = build({ turns: 2, media: { charts: 2, chartNodes: 3 } })

    const fences = messages
      .flatMap((m) => m.parts)
      .filter((p) => typeof p.text === "string" && (p.text as string).startsWith("```mermaid"))
    expect(fences).toHaveLength(2)
    expect(fences[0].text).toContain("flowchart TD")
  })

  it("appends a dedicated turn for a large table", () => {
    const { messages } = build({ turns: 1, media: { tableRows: 3 } })

    expect(messages.map((m) => m.id)).toEqual([
      "seed-u-0",
      "seed-a-0",
      "seed-u-table",
      "seed-a-table",
    ])
    expect(partsOf(messages, "seed-a-table")[0].text).toContain("| 2 | item-2 |")
  })

  it("appends a dedicated turn for a large code block", () => {
    const { messages } = build({ turns: 1, media: { codeLines: 2 } })

    expect(messages.map((m) => m.id)).toEqual([
      "seed-u-0",
      "seed-a-0",
      "seed-u-code",
      "seed-a-code",
    ])
    expect(partsOf(messages, "seed-a-code")[0].text).toContain("```ts")
  })

  it("omits the table and code turns when their counts are zero", () => {
    const { messages } = build({ turns: 1, media: { tableRows: 0, codeLines: 0 } })

    expect(messages).toHaveLength(2)
  })

  it("keeps the clock monotonic across the appended table and code turns", () => {
    const { messages } = build({ turns: 1, media: { tableRows: 1, codeLines: 1 } })

    const times = messages.map((m) => m.metadata.createdAt)
    expect(times).toEqual([...times].sort((a, b) => a - b))
    expect(new Set(times).size).toBe(times.length)
  })
})

describe("dataUrlMediaType", () => {
  it("reads the media type out of a data URL", () => {
    expect(dataUrlMediaType("data:image/jpeg;base64,AAAA")).toBe("image/jpeg")
    expect(dataUrlMediaType("data:image/png,AAAA")).toBe("image/png")
  })

  it("falls back to png for anything that is not a data URL", () => {
    expect(dataUrlMediaType("https://example.com/a.gif")).toBe("image/png")
  })
})

describe("buildMermaidSource", () => {
  it("chains the requested number of nodes", () => {
    const source = buildMermaidSource(4, 7)

    expect(source.split("\n")[0]).toBe("flowchart TD")
    expect(source).toContain("n7_0")
    expect(source).toContain("n7_3")
    expect(source).not.toContain("n7_4")
  })

  it("adds a cross edge every fourth node", () => {
    expect(buildMermaidSource(6, 1)).toContain("n1_0 -.-> n1_4")
    expect(buildMermaidSource(4, 1)).not.toContain("-.->")
  })

  it("clamps to at least two nodes so the diagram always has an edge", () => {
    expect(buildMermaidSource(0, 0)).toContain("-->")
  })
})

describe("buildMarkdownTable", () => {
  it("emits a header, a separator and one line per row", () => {
    const lines = buildMarkdownTable(3).split("\n")

    expect(lines).toHaveLength(5)
    expect(lines[1]).toBe("| --- | --- | --- | --- |")
    expect(lines[2]).toContain("ok")
    expect(lines[3]).toContain("pending")
  })

  it("emits only the header for zero rows", () => {
    expect(buildMarkdownTable(0).split("\n")).toHaveLength(2)
  })
})

describe("buildCodeBlock", () => {
  it("emits one line per requested line", () => {
    const lines = buildCodeBlock(3).split("\n")

    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain("value0")
    expect(lines[0]).toContain("enabled: true")
    expect(lines[1]).toContain("enabled: false")
  })

  it("returns an empty string for zero lines", () => {
    expect(buildCodeBlock(0)).toBe("")
  })
})

describe("imageDimensions", () => {
  it("derives a 16:10 frame from the long edge", () => {
    expect(imageDimensions(1568)).toEqual({ width: 1568, height: 980 })
  })
})

describe("createNoiseImageDataUrl", () => {
  const realDocument = (globalThis as { document?: unknown }).document

  afterEach(() => {
    if (realDocument === undefined) delete (globalThis as { document?: unknown }).document
    else (globalThis as { document?: unknown }).document = realDocument
  })

  function stubCanvas(getContext: () => unknown) {
    ;(globalThis as { document?: unknown }).document = {
      createElement: () => ({ width: 0, height: 0, getContext, toDataURL: () => "" }),
    }
  }

  it("returns the transparent pixel when there is no document", () => {
    delete (globalThis as { document?: unknown }).document

    expect(createNoiseImageDataUrl(64, 1)).toBe(TRANSPARENT_PIXEL)
  })

  it("returns the transparent pixel when the canvas has no 2D context", () => {
    stubCanvas(() => null)

    expect(createNoiseImageDataUrl(64, 1)).toBe(TRANSPARENT_PIXEL)
  })

  it("fills every pixel with opaque noise and encodes it", () => {
    let captured: Uint8ClampedArray | null = null
    ;(globalThis as { document?: unknown }).document = {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          createImageData: (w: number, h: number) => ({
            data: new Uint8ClampedArray(w * h * 4),
          }),
          putImageData: (frame: { data: Uint8ClampedArray }) => {
            captured = frame.data
          },
        }),
        toDataURL: () => `data:image/jpeg;base64,${captured?.join("").slice(0, 32)}`,
      }),
    }

    const url = createNoiseImageDataUrl(16, 5)

    expect(url.startsWith("data:image/jpeg;base64,")).toBe(true)
    const data = captured as unknown as Uint8ClampedArray
    // 16x10 frame → 160 pixels → every alpha byte opaque.
    expect(data).toHaveLength(16 * 10 * 4)
    for (let i = 3; i < data.length; i += 4) expect(data[i]).toBe(255)
    expect(data.some((byte) => byte !== 0 && byte !== 255)).toBe(true)
  })

  it("produces different bytes for different seeds", () => {
    const frames: string[] = []
    ;(globalThis as { document?: unknown }).document = {
      createElement: () => {
        let snapshot = ""
        return {
          width: 0,
          height: 0,
          getContext: () => ({
            createImageData: (w: number, h: number) => ({
              data: new Uint8ClampedArray(w * h * 4),
            }),
            putImageData: (frame: { data: Uint8ClampedArray }) => {
              snapshot = frame.data.slice(0, 16).join(",")
            },
          }),
          toDataURL: () => `data:image/jpeg;base64,${snapshot}`,
        }
      },
    }

    frames.push(createNoiseImageDataUrl(16, 1), createNoiseImageDataUrl(16, 2))

    expect(frames[0]).not.toBe(frames[1])
  })
})
