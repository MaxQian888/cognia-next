import {
  A2UI_PREVIEW_MAX_DEPTH,
  A2UI_PREVIEW_SURFACE_PREFIX,
  completePartialJson,
  isA2UIPreviewSurfaceId,
  parseStreamingA2UI,
} from "./streaming-preview"
import type { A2UIServerMessage } from "@/types/a2ui/schema"

const PREVIEW_ID = `${A2UI_PREVIEW_SURFACE_PREFIX}test`

function componentsOf(messages: A2UIServerMessage[]) {
  return messages.flatMap((message) =>
    message.type === "updateComponents" ? message.components.map((c) => c.id) : []
  )
}

function dataOf(messages: A2UIServerMessage[]) {
  const update = messages.find((message) => message.type === "dataModelUpdate")
  return update && update.type === "dataModelUpdate" ? update.data : undefined
}

describe("completePartialJson", () => {
  it.each([
    ["", null, false],
    ["no json here", null, false],
    ["{", "{}", false],
    ['{"a":', "{}", false],
    ['{"a":1', "{}", false],
    ['{"a":1,', '{"a":1}', false],
    ['{"a":12', "{}", false],
    ['{"a":"hel', "{}", false],
    ['{"a":"x","b":"hel', '{"a":"x"}', false],
    ['{"list":[1,2', '{"list":[1]}', false],
    ['{"list":[{"x":1},{"y"', '{"list":[{"x":1},{}]}', false],
    ['{"s":"a,b}]","t', '{"s":"a,b}]"}', false],
    ['{"s":"quote \\" , still string', "{}", false],
    ['{"a":[]}', '{"a":[]}', true],
    ["  [1,[2,3]]", "[1,[2,3]]", true],
  ])("completes %j", (input, json, complete) => {
    const result = completePartialJson(input)
    expect(result).toEqual({ json, complete })
    if (json) expect(() => JSON.parse(json)).not.toThrow()
  })

  it("rejects mismatched brackets", () => {
    expect(completePartialJson('{"a":]')).toEqual({ json: null, complete: false })
  })

  it("never yields a truncated scalar", () => {
    const full = '{"title":"Quarterly","total":12345,"ok":true,"items":["alpha","beta"]}'
    for (let length = 1; length < full.length; length++) {
      const { json } = completePartialJson(full.slice(0, length))
      if (!json) continue
      const value = JSON.parse(json) as Record<string, unknown>
      if ("title" in value) expect(value.title).toBe("Quarterly")
      if ("total" in value) expect(value.total).toBe(12345)
      if ("ok" in value) expect(value.ok).toBe(true)
      if (Array.isArray(value.items)) {
        for (const item of value.items) expect(["alpha", "beta"]).toContain(item)
      }
    }
  })
})

describe("parseStreamingA2UI", () => {
  const simplified = JSON.stringify({
    surface: { id: "trip", type: "panel", title: "Trip" },
    components: [
      { id: "root", component: "Column", children: ["title", "go"] },
      { id: "title", component: "Text", text: "Plan your trip" },
      { id: "go", component: "Button", text: "Search", action: "search" },
    ],
    dataModel: { city: "Hangzhou" },
  })

  it("returns null until a renderable component arrives", () => {
    expect(parseStreamingA2UI("", PREVIEW_ID)).toBeNull()
    expect(parseStreamingA2UI('{"surface":{"id":"tr', PREVIEW_ID)).toBeNull()
  })

  it("grows the component list as components complete", () => {
    const cut = simplified.indexOf('{"id":"go"')
    const preview = parseStreamingA2UI(simplified.slice(0, cut + 5), PREVIEW_ID)
    expect(preview).not.toBeNull()
    expect(componentsOf(preview!.messages)).toEqual(["root", "title"])
    expect(preview!.complete).toBe(false)
  })

  it("retargets every message to an inline preview surface", () => {
    const preview = parseStreamingA2UI(simplified, PREVIEW_ID)!
    expect(preview.complete).toBe(true)
    for (const message of preview.messages) {
      expect("surfaceId" in message && message.surfaceId).toBe(PREVIEW_ID)
    }
    const create = preview.messages.find((message) => message.type === "createSurface")
    expect(create).toMatchObject({ surfaceType: "inline", widget: undefined })
    expect(dataOf(preview.messages)).toEqual({ city: "Hangzhou" })
  })

  it("never streams a half-written data value", () => {
    const cut = simplified.indexOf("Hangzhou") + 4
    const preview = parseStreamingA2UI(simplified.slice(0, cut), PREVIEW_ID)!
    expect(componentsOf(preview.messages)).toEqual(["root", "title", "go"])
    expect(dataOf(preview.messages)).toBeUndefined()
  })

  it("keeps finished JSONL lines and completes the line in progress", () => {
    const lines = [
      JSON.stringify({ type: "createSurface", surfaceId: "s", surfaceType: "inline" }),
      JSON.stringify({
        type: "updateComponents",
        surfaceId: "s",
        components: [
          { id: "root", component: "Column", children: ["a", "b"] },
          { id: "a", component: "Text", text: "A" },
          { id: "b", component: "Text", text: "B" },
        ],
      }),
    ]
    const partial = `${lines[0]}\n${lines[1].slice(0, lines[1].indexOf('{"id":"b"') + 6)}`
    const preview = parseStreamingA2UI(partial, PREVIEW_ID)!
    expect(preview.messages[0]).toMatchObject({ type: "createSurface", surfaceId: PREVIEW_ID })
    expect(componentsOf(preview.messages)).toEqual(["root", "a"])
  })

  it("drops messages that would act on the real store", () => {
    const body = [
      JSON.stringify({ type: "deleteSurface", surfaceId: "other" }),
      JSON.stringify({ type: "createSurface", surfaceId: "s", surfaceType: "inline" }),
    ].join("\n")
    const preview = parseStreamingA2UI(body, PREVIEW_ID)!
    expect(preview.messages.map((message) => message.type)).toEqual(["createSurface"])
  })

  it("ignores content that is not A2UI", () => {
    expect(parseStreamingA2UI('{"hello":"world"}', PREVIEW_ID)).toBeNull()
  })
})

describe("parseStreamingA2UI on hostile or unfinished input", () => {
  it("gives up on nesting deeper than a surface ever needs, without throwing", () => {
    const deep = "[".repeat(5_000)
    expect(completePartialJson(deep)).toEqual({ json: null, complete: false })
    expect(() => parseStreamingA2UI(deep, PREVIEW_ID)).not.toThrow()
    expect(parseStreamingA2UI(deep, PREVIEW_ID)).toBeNull()
    expect(completePartialJson("[".repeat(A2UI_PREVIEW_MAX_DEPTH)).json).not.toBeNull()
  })

  const protocol = [
    {
      type: "createSurface",
      surfaceId: "cart",
      surfaceType: "inline",
      computed: { "/total": { op: "multiply", args: [{ path: "/qty" }, { path: "/price" }] } },
    },
    {
      type: "updateComponents",
      surfaceId: "cart",
      components: [{ id: "root", component: "Text", text: "x" }],
    },
    { type: "dataModelUpdate", surfaceId: "cart", data: { qty: 2, price: 5 }, merge: false },
  ]

  it("holds computed declarations back until the fence is complete", () => {
    const whole = JSON.stringify(protocol)
    const cut = whole.indexOf('{"path":"/price"}')
    const partial = parseStreamingA2UI(whole.slice(0, cut), PREVIEW_ID)!
    const create = partial.messages.find((message) => message.type === "createSurface")
    expect(create).toBeDefined()
    expect(create).not.toHaveProperty("computed")

    const done = parseStreamingA2UI(whole, PREVIEW_ID)!
    expect(done.complete).toBe(true)
    expect(done.messages.find((message) => message.type === "createSurface")).toHaveProperty(
      "computed"
    )
  })

  it("merges a data update until its merge flag and the fence are complete", () => {
    const whole = JSON.stringify(protocol)
    const cut = whole.indexOf(',"merge"')
    const partial = parseStreamingA2UI(whole.slice(0, cut), PREVIEW_ID)!
    expect(partial.messages.find((message) => message.type === "dataModelUpdate")).toMatchObject({
      merge: true,
    })
    const done = parseStreamingA2UI(whole, PREVIEW_ID)!
    expect(done.messages.find((message) => message.type === "dataModelUpdate")).toMatchObject({
      merge: false,
    })
  })
})

describe("isA2UIPreviewSurfaceId", () => {
  it("matches only reserved preview ids", () => {
    expect(isA2UIPreviewSurfaceId(PREVIEW_ID)).toBe(true)
    expect(isA2UIPreviewSurfaceId("trip")).toBe(false)
  })
})
