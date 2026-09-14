import {
  applyPresentationOperations,
  assertSlideElements,
  createPresentation,
  normalizeHexColor,
  parsePresentation,
  validatePresentation,
  type PresentationDeck,
} from "./model"

it("applies slide operations and validates layout and accessibility", () => {
  const deck = applyPresentationOperations(createPresentation("Launch"), [
    {
      op: "addSlide",
      title: "Overview",
      elements: [
        {
          id: "t1",
          type: "text",
          x: 1,
          y: 1,
          width: 8,
          height: 1,
          text: "Launch plan",
          fontSize: 28,
        },
      ],
    },
  ])
  expect(deck.slides).toHaveLength(1)
  expect(validatePresentation(deck)).toEqual([])
})

it("never reuses slide ids after removal", () => {
  const deck = applyPresentationOperations(createPresentation("Deck"), [
    { op: "addSlide", title: "A" },
    { op: "addSlide", title: "B" },
    { op: "removeSlide", slideId: "s1" },
    { op: "addSlide", title: "C" },
  ])
  expect(deck.slides.map((slide) => slide.id)).toEqual(["s2", "s3"])
})

it("reorders slides and replaces content atomically", () => {
  const deck = applyPresentationOperations(createPresentation("Deck"), [
    { op: "addSlide", title: "A" },
    { op: "addSlide", title: "B" },
    { op: "reorderSlide", slideId: "s2", index: 0 },
    {
      op: "replaceSlide",
      slideId: "s2",
      elements: [{ id: "e1", type: "text", x: 1, y: 1, width: 4, height: 1, text: "Updated" }],
    },
  ])
  expect(deck.slides.map((slide) => slide.title)).toEqual(["B", "A"])
  expect(deck.slides[0].elements[0]).toMatchObject({ text: "Updated" })
  expect(() =>
    applyPresentationOperations(deck, [{ op: "removeSlide", slideId: "missing" }])
  ).toThrow("Slide not found")
})

describe("assertSlideElements", () => {
  it.each([
    ["not-an-array", "must be an array"],
    [[{ id: "e1", type: "text", x: 0, y: 0, width: 1, height: 1 }], "requires a string text"],
    [
      [{ id: "e1", type: "text", x: Number.NaN, y: 0, width: 1, height: 1, text: "x" }],
      "finite number x",
    ],
    [
      [
        { id: "e1", type: "text", x: 0, y: 0, width: 1, height: 1, text: "a" },
        { id: "e1", type: "text", x: 0, y: 0, width: 1, height: 1, text: "b" },
      ],
      "duplicate id",
    ],
    [[{ id: "e1", type: "video", x: 0, y: 0, width: 1, height: 1 }], "unsupported type"],
    [
      [{ id: "e1", type: "shape", x: 0, y: 0, width: 1, height: 1, shape: "star" }],
      "unsupported shape",
    ],
    [
      [
        {
          id: "e1",
          type: "image",
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          dataBase64: "",
          mimeType: "image/png",
          alt: "a",
        },
      ],
      "dataBase64",
    ],
    [
      [
        {
          id: "e1",
          type: "image",
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          dataBase64: "AA==",
          mimeType: "image/gif",
          alt: "a",
        },
      ],
      "image/png or image/jpeg",
    ],
    [
      [{ id: "e1", type: "table", x: 0, y: 0, width: 1, height: 1, rows: [] }],
      "rows of non-empty string arrays",
    ],
    [
      [
        {
          id: "e1",
          type: "chart",
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          labels: ["A"],
          values: [Number.POSITIVE_INFINITY],
        },
      ],
      "finite values",
    ],
  ])("rejects %j", (elements, message) => {
    expect(() => assertSlideElements(elements)).toThrow(message as string)
  })

  it("accepts a fully-formed element set", () => {
    expect(() =>
      assertSlideElements([
        { id: "t", type: "text", x: 0, y: 0, width: 1, height: 1, text: "hi" },
        { id: "s", type: "shape", x: 0, y: 0, width: 1, height: 1, shape: "ellipse" },
        {
          id: "i",
          type: "image",
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          dataBase64: "AA==",
          mimeType: "image/jpeg",
          alt: "alt",
        },
        { id: "tb", type: "table", x: 0, y: 0, width: 1, height: 1, rows: [["a"]] },
        { id: "c", type: "chart", x: 0, y: 0, width: 1, height: 1, labels: ["A"], values: [1] },
      ])
    ).not.toThrow()
  })
})

describe("parsePresentation", () => {
  it("fills missing deck fields with defaults", () => {
    const deck = parsePresentation(
      JSON.stringify({ schemaVersion: 1, slides: [{ id: "s1", title: "T", elements: [] }] })
    )
    expect(deck.title).toBe("Presentation")
    expect(deck.width).toBeCloseTo(13.333)
    expect(deck.theme.fontFamily).toBe("Aptos")
    expect(deck.importedFeatures).toEqual([])
  })

  it.each([
    ["{}", "Unsupported Cognia presentation schema"],
    [JSON.stringify({ schemaVersion: 2, slides: [] }), "Unsupported Cognia presentation schema"],
    [JSON.stringify({ schemaVersion: 1, slides: [{ id: "s1" }] }), "a slide is malformed"],
  ])("rejects corrupt payloads", (content, message) => {
    expect(() => parsePresentation(content)).toThrow(message as string)
  })
})

describe("validatePresentation", () => {
  const base = () => createPresentation("Deck")
  it("flags duplicate slide ids, ragged tables, and chart mismatches", () => {
    const deck: PresentationDeck = {
      ...base(),
      slides: [
        {
          id: "s1",
          title: "One",
          elements: [
            {
              id: "tb",
              type: "table",
              x: 0,
              y: 0,
              width: 4,
              height: 2,
              rows: [["a", "b"], ["c"]],
            },
            {
              id: "c",
              type: "chart",
              x: 0,
              y: 3,
              width: 4,
              height: 2,
              labels: ["A", "B"],
              values: [1],
            },
          ],
        },
        { id: "s1", title: "Dup", elements: [] },
      ],
    }
    const codes = validatePresentation(deck).map((finding) => finding.code)
    expect(codes).toEqual(
      expect.arrayContaining(["slide.duplicate", "table.ragged", "chart.length", "slide.empty"])
    )
  })

  it("flags non-finite geometry before bounds checks", () => {
    const deck: PresentationDeck = {
      ...base(),
      slides: [
        {
          id: "s1",
          title: "One",
          elements: [
            {
              id: "e1",
              type: "text",
              x: Number.NaN,
              y: 0,
              width: 1,
              height: 1,
              text: "x",
            },
          ],
        },
      ],
    }
    const finding = validatePresentation(deck).find((item) => item.code === "element.geometry")
    expect(finding?.severity).toBe("error")
  })
})

describe("normalizeHexColor", () => {
  it.each([
    ["ff0000", "FF0000"],
    ["#00ff00", "00FF00"],
    [" 123abc ", "123ABC"],
    ["red", "000000"],
    ["#fff", "000000"],
    [undefined, "000000"],
    ["zzzzzz", "000000"],
  ])("normalizes %p", (input, expected) => {
    expect(normalizeHexColor(input as string | undefined, "000000")).toBe(expected)
  })
})
