/**
 * A2UI Parser Tests
 */

import {
  parseA2UIMessages,
  parseA2UIInput,
  parseA2UIString,
  detectA2UIContent,
  extractA2UIFromResponse,
  createA2UISurface,
  isCreateSurfaceMessage,
  isUpdateComponentsMessage,
  isUpdateDataModelMessage,
  isConnectorActionMessage,
  extractA2UIBlocks,
  parseA2UIMessage,
  parseA2UIJsonl,
  isDeleteSurfaceMessage,
  isSurfaceReadyMessage,
} from "./parser"
import type { A2UIConnectorActionMessage } from "@/types/a2ui/schema"

describe("A2UI Parser", () => {
  it.each([
    { type: "updateComponents", surfaceId: 3, components: [] },
    { type: "updateComponents", surfaceId: "s", components: [null] },
    { type: "updateComponents", surfaceId: "s", components: [{ id: "x" }] },
    { type: "dataModelUpdate", surfaceId: "s", data: [] },
    { type: "dataModelUpdate", surfaceId: "s", data: {}, merge: "false" },
    { type: "createSurface", surfaceId: "s", surfaceType: "invalid" },
    { type: "createSurface", surfaceId: "__proto__" },
    { type: "surfaceReady", surfaceId: {} },
    { surface: { id: 12 }, components: [] },
    { components: [{ id: "__proto__", component: "Text", text: "bad" }] },
    { components: [], dataModel: [] },
  ])("rejects malformed envelopes before they reach state: %j", (input) => {
    expect(parseA2UIInput(input).messages).toEqual([])
  })

  it("returns exact spans for all valid blocks and keeps malformed fences out", () => {
    const valid = '```a2ui\n{"type":"surfaceReady","surfaceId":"s"}\n```'
    const prefix = '```json\n{"example":true}\n```\n```a2ui\n{broken}\n```\nBefore\n'
    const raw = '{"type":"deleteSurface","surfaceId":"s"}'
    const text = `${prefix}${valid}\nBetween ${raw} After`
    expect(extractA2UIBlocks(text).map(({ start, end }) => text.slice(start, end))).toEqual([
      valid,
      raw,
    ])
  })

  it("supports JSONL in CRLF and tilde fences", () => {
    const result = parseA2UIInput(
      '~~~jsonl\r\n{"type":"createSurface","surfaceId":"s"}\r\n{"type":"surfaceReady","surfaceId":"s"}\r\n~~~'
    )
    expect(result.messages.map((message) => message.type)).toEqual([
      "createSurface",
      "surfaceReady",
    ])
  })

  it("does not mine inner JSON from an unfinished or unrelated outer fence", () => {
    expect(extractA2UIBlocks('```a2ui\n{"type":"surfaceReady","surfaceId":"s"}')).toEqual([])
    expect(
      extractA2UIBlocks('````markdown\n```a2ui\n{"type":"surfaceReady","surfaceId":"s"}\n```\n````')
    ).toEqual([])
  })

  it("uses distinct stable fallbacks for anonymous blocks", () => {
    const text = '```a2ui\n{"components":[]}\n```\n```a2ui\n{"components":[]}\n```'
    const blocks = extractA2UIBlocks(text, { fallbackSurfaceId: "message" })
    expect(blocks.map((block) => block.content.surfaceId)).toEqual(["message", "message:1"])
  })

  describe("parseA2UIMessages", () => {
    it("should parse an array of messages", () => {
      const messages = [
        { type: "createSurface", surfaceId: "test", surfaceType: "inline" },
        { type: "updateComponents", surfaceId: "test", components: [] },
      ]
      const result = parseA2UIMessages(messages)
      expect(result.success).toBe(true)
      expect(result.messages).toHaveLength(2)
    })

    it("should parse a single message object", () => {
      const message = { type: "createSurface", surfaceId: "test", surfaceType: "inline" }
      const result = parseA2UIMessages(message)
      expect(result.success).toBe(true)
      expect(result.messages).toHaveLength(1)
    })

    it("should handle empty array", () => {
      const result = parseA2UIMessages([])
      // Empty array returns success: false with no valid messages
      expect(result.messages).toHaveLength(0)
    })

    it("should fail for invalid message type", () => {
      const message = { type: "invalid", surfaceId: "test" }
      const result = parseA2UIMessages(message)
      expect(result.success).toBe(false)
    })
  })

  describe("parseA2UIInput", () => {
    it("keeps standard component updates on their existing surface", () => {
      const update = {
        type: "updateComponents",
        surfaceId: "existing",
        components: [{ id: "text", component: "Text", text: "Updated" }],
      }
      expect(parseA2UIInput(update)).toEqual({
        surfaceId: "existing",
        messages: [update],
        errors: [],
      })
    })

    it("honors fallback surface identity for simplified payloads", () => {
      const result = parseA2UIInput(
        { components: [{ id: "root", component: "Text", text: "Hi" }] },
        { fallbackSurfaceId: "message-surface" }
      )
      expect(result.surfaceId).toBe("message-surface")
      expect(result.messages.every((message) => message.surfaceId === "message-surface")).toBe(true)
    })

    it("collects all fenced protocol blocks in response order", () => {
      const result = parseA2UIInput(
        'Before\n```a2ui\n{"type":"createSurface","surfaceId":"s"}\n```\nMiddle\n```a2ui\n{"type":"surfaceReady","surfaceId":"s"}\n```\nAfter'
      )
      expect(result.messages.map((message) => message.type)).toEqual([
        "createSurface",
        "surfaceReady",
      ])
    })

    it("parses a JSONL protocol without dropping later events", () => {
      const result = parseA2UIInput(
        '{"type":"createSurface","surfaceId":"s"}\n{"type":"surfaceReady","surfaceId":"s"}'
      )
      expect(result.messages.map((message) => message.type)).toEqual([
        "createSurface",
        "surfaceReady",
      ])
    })

    it("should parse A2UI JSON string", () => {
      const result = parseA2UIInput(
        JSON.stringify([{ type: "createSurface", surfaceId: "input-1", surfaceType: "inline" }])
      )

      expect(result.messages).toHaveLength(1)
      expect(result.surfaceId).toBe("input-1")
      expect(result.errors).toEqual([])
    })

    it("should parse object payload directly", () => {
      const result = parseA2UIInput({
        type: "createSurface",
        surfaceId: "input-2",
        surfaceType: "inline",
        widget: {
          hostStrategy: "native",
          theme: "inherit",
        },
      })

      expect(result.messages).toHaveLength(1)
      expect(result.surfaceId).toBe("input-2")
      expect(result.messages[0]).toMatchObject({
        type: "createSurface",
        widget: {
          hostStrategy: "native",
          theme: "inherit",
        },
      })
    })

    it("should parse A2UI code block in mixed text", () => {
      const result = parseA2UIInput(
        'prefix\n```json\n{"type":"createSurface","surfaceId":"input-3","surfaceType":"inline"}\n```\nsuffix'
      )

      expect(result.messages).toHaveLength(1)
      expect(result.surfaceId).toBe("input-3")
    })

    it("should parse tool-result-like content payload", () => {
      const result = parseA2UIInput({
        content: [
          {
            type: "text",
            text: '[{"type":"createSurface","surfaceId":"input-4","surfaceType":"inline"}]',
          },
        ],
      })

      expect(result.messages).toHaveLength(1)
      expect(result.surfaceId).toBe("input-4")
    })

    it("should return parse errors for invalid JSON-like A2UI input", () => {
      const result = parseA2UIInput('{"type":"createSurface","surfaceId":')

      expect(result.messages).toHaveLength(0)
      expect(result.errors.length).toBeGreaterThan(0)
    })
  })

  describe("parseA2UIString", () => {
    it("should parse valid JSON string", () => {
      const json = JSON.stringify({
        type: "createSurface",
        surfaceId: "test",
        surfaceType: "inline",
      })
      const result = parseA2UIString(json)
      expect(result.success).toBe(true)
    })

    it("should fail for invalid JSON", () => {
      const result = parseA2UIString("not json")
      expect(result.success).toBe(false)
    })
  })

  describe("detectA2UIContent", () => {
    it("should detect A2UI content in string", () => {
      const content = '{"type":"createSurface","surfaceId":"test"}'
      expect(detectA2UIContent(content)).toBe(true)
    })

    it("should detect A2UI in code block", () => {
      const content = '```json\n{"type":"updateComponents","surfaceId":"test","components":[]}\n```'
      expect(detectA2UIContent(content)).toBe(true)
    })

    it("should return false for non-A2UI content", () => {
      expect(detectA2UIContent("Hello world")).toBe(false)
      expect(detectA2UIContent('{"name":"John"}')).toBe(false)
    })
  })

  describe("extractA2UIFromResponse", () => {
    it("does not interpret code samples in unrelated languages as surfaces", () => {
      expect(
        extractA2UIFromResponse(
          '```typescript\n{"type":"createSurface","surfaceId":"example"}\n```'
        )
      ).toBeNull()
    })

    it("handles brackets and escaped quotes inside raw JSON strings", () => {
      const payload = {
        surface: { id: "raw" },
        components: [{ id: "root", component: "Text", text: 'A } bracket and \\"quote" [' }],
      }
      expect(extractA2UIFromResponse(`Before ${JSON.stringify(payload)} After`)?.surfaceId).toBe(
        "raw"
      )
    })

    it("should extract A2UI from response with code block", () => {
      const response =
        'Here is the UI:\n```json\n{"type":"createSurface","surfaceId":"test-1","surfaceType":"inline"}\n```'
      const result = extractA2UIFromResponse(response)
      expect(result).not.toBeNull()
      expect(result?.surfaceId).toBe("test-1")
    })

    it("should return null for non-A2UI response", () => {
      const response = "This is just text without A2UI content"
      const result = extractA2UIFromResponse(response)
      expect(result).toBeNull()
    })
  })

  describe("message type guards", () => {
    it("should identify createSurface messages", () => {
      const msg = {
        type: "createSurface" as const,
        surfaceId: "test",
        surfaceType: "inline" as const,
      }
      expect(isCreateSurfaceMessage(msg)).toBe(true)
    })

    it("should identify updateComponents messages", () => {
      const msg = { type: "updateComponents" as const, surfaceId: "test", components: [] }
      expect(isUpdateComponentsMessage(msg)).toBe(true)
    })

    it("should identify dataModelUpdate messages", () => {
      const msg = { type: "dataModelUpdate" as const, surfaceId: "test", data: {} }
      expect(isUpdateDataModelMessage(msg)).toBe(true)
    })

    it("should identify connectorAction messages and reject server messages", () => {
      const action: A2UIConnectorActionMessage = {
        type: "connectorAction",
        surfaceId: "test",
        actionType: "button",
        value: "approve",
      }
      expect(isConnectorActionMessage(action)).toBe(true)
      expect(isConnectorActionMessage({ type: "surfaceReady", surfaceId: "test" })).toBe(false)
    })
  })

  describe("createA2UISurface", () => {
    it("should create surface messages", () => {
      const components = [{ id: "text-1", component: "Text" as const, text: "Hello" }]
      const dataModel = { greeting: "Hello" }
      const messages = createA2UISurface("test-surface", components, dataModel, {
        surfaceType: "inline",
        title: "Test Surface",
        widget: {
          hostStrategy: "native",
          sizing: "auto",
        },
      })

      // Includes createSurface, updateComponents, dataModelUpdate, surfaceReady
      expect(messages).toHaveLength(4)
      expect(messages[0].type).toBe("createSurface")
      expect(messages[0]).toMatchObject({
        widget: {
          hostStrategy: "native",
          sizing: "auto",
        },
      })
      expect(messages[1].type).toBe("updateComponents")
      expect(messages[2].type).toBe("dataModelUpdate")
      expect(messages[3].type).toBe("surfaceReady")
    })

    it("should skip dataModelUpdate if no data provided", () => {
      const components = [{ id: "text-1", component: "Text" as const, text: "Hello" }]
      const messages = createA2UISurface("test-surface", components)

      // Includes createSurface, updateComponents, surfaceReady
      expect(messages).toHaveLength(3)
      expect(messages[0].type).toBe("createSurface")
      expect(messages[1].type).toBe("updateComponents")
      expect(messages[2].type).toBe("surfaceReady")
    })
  })
})

describe("A2UI parser boundaries", () => {
  const ready = { type: "surfaceReady" as const, surfaceId: "s" }

  it.each([
    null,
    undefined,
    false,
    42,
    "text",
    {},
    { type: 7 },
    { type: "createSurface", surfaceId: "s", title: 4 },
    { type: "createSurface", surfaceId: "s", catalogId: false },
    { type: "createSurface", surfaceId: "s", widget: null },
    { type: "createSurface", surfaceId: "s", widget: [] },
    { type: "createSurface", surfaceId: "s", widget: "invalid" },
    { type: "updateComponents", surfaceId: "s", components: {} },
    { type: "updateComponents", surfaceId: "s", components: [42] },
    { type: "updateComponents", surfaceId: "s", components: [[]] },
    { type: "updateComponents", surfaceId: "s", components: [{ id: 2, component: "Text" }] },
    { type: "updateComponents", surfaceId: "s", components: [{ id: "t", component: "" }] },
  ])("single-message parsing rejects malformed boundary value %j", (value) => {
    expect(parseA2UIMessage(value)).toBeNull()
  })

  it("returns valid lifecycle events and distinguishes each guard", () => {
    const deleted = { type: "deleteSurface" as const, surfaceId: "s" }
    const created = {
      type: "createSurface" as const,
      surfaceId: "s",
      surfaceType: "inline" as const,
    }
    expect(parseA2UIMessage(ready)).toEqual(ready)
    expect(parseA2UIMessage(deleted)).toEqual(deleted)
    expect(isSurfaceReadyMessage(ready)).toBe(true)
    expect(isSurfaceReadyMessage(deleted)).toBe(false)
    expect(isDeleteSurfaceMessage(deleted)).toBe(true)
    expect(isDeleteSurfaceMessage(ready)).toBe(false)
    expect(isCreateSurfaceMessage(ready)).toBe(false)
    expect(isUpdateComponentsMessage(created)).toBe(false)
    expect(isUpdateDataModelMessage(created)).toBe(false)
  })

  it("reports invalid array entries while preserving valid message order", () => {
    expect(parseA2UIMessages([ready, false, { type: "deleteSurface", surfaceId: "s" }])).toEqual({
      success: true,
      messages: [ready, { type: "deleteSurface", surfaceId: "s" }],
      errors: ["Invalid message at index 1"],
    })
    expect(parseA2UIMessages(null)).toMatchObject({
      success: false,
      errors: ["Input is null or undefined"],
    })
  })

  it("JSONL skips blank lines and reports both malformed JSON and invalid events", () => {
    const result = parseA2UIJsonl(
      "\n" + JSON.stringify(ready) + '\n \n{"type":"unknown","surfaceId":"s"}\n{broken}\n'
    )
    expect(result.success).toBe(true)
    expect(result.messages).toEqual([ready])
    expect(result.errors).toEqual([
      "Invalid message at line 2",
      expect.stringContaining("JSON parse error at line 3:"),
    ])
    expect(parseA2UIJsonl(" \n")).toEqual({ success: false, messages: [], errors: [] })
  })

  it.each([null, undefined, "", "  \n", "ordinary prose"])(
    "empty or unrelated input keeps fallback identity %j",
    (value) => {
      expect(parseA2UIInput(value, { fallbackSurfaceId: "fallback" })).toEqual({
        surfaceId: "fallback",
        messages: [],
        errors: [],
      })
    }
  )

  it.each([
    { surface: null, components: [] },
    { surface: [], components: [] },
    { surface: "bad", components: [] },
    { surface: { id: "constructor" }, components: [] },
    { surface: { type: "unsupported" }, components: [] },
    { surface: {}, components: "bad" },
  ])("rejects malformed simplified surface envelopes %j", (value) => {
    expect(parseA2UIInput(value).messages).toEqual([])
  })

  it("parses simplified data models and empty models without losing surface options", () => {
    const input = {
      surface: { id: "simplified", type: "panel", title: "Panel" },
      components: [],
      dataModel: { count: 0 },
    }
    const result = parseA2UIInput(input)
    expect(result.messages[0]).toMatchObject({
      type: "createSurface",
      surfaceType: "panel",
      title: "Panel",
    })
    expect(result.messages).toContainEqual({
      type: "dataModelUpdate",
      surfaceId: "simplified",
      data: { count: 0 },
    })
    expect(
      parseA2UIInput({ ...input, dataModel: {} }).messages.map((message) => message.type)
    ).toEqual(["createSurface", "updateComponents", "surfaceReady"])
  })

  it("unwraps nested message arrays and retains invalid nested errors", () => {
    expect(parseA2UIInput({ messages: [ready] })).toMatchObject({
      surfaceId: "s",
      messages: [ready],
      errors: [],
    })
    const invalid = parseA2UIInput({ messages: [{ type: "unknown", surfaceId: "s" }] })
    expect(invalid.messages).toEqual([])
    expect(invalid.errors).toContain("Invalid message at index 0")
  })

  it("collects text, result, and resource tool payloads in order while retaining parse errors", () => {
    const result = parseA2UIInput({
      text: JSON.stringify(ready),
      result: '{"type":"deleteSurface","surfaceId":"s"}',
      content: [
        null,
        4,
        { type: "image" },
        { type: "resource", resource: null },
        { type: "resource", resource: { text: 5 } },
        {
          type: "resource",
          resource: { text: JSON.stringify({ type: "createSurface", surfaceId: "next" }) },
        },
        { type: "text", text: "{broken}" },
        { type: "text", text: "plain prose" },
      ],
    })
    expect(result.messages.map((message) => message.type)).toEqual([
      "surfaceReady",
      "deleteSurface",
      "createSurface",
    ])
    expect(result.errors).toEqual([expect.stringContaining("JSON parse error:")])
  })

  it("returns errors from a tool payload containing no valid A2UI", () => {
    expect(parseA2UIInput({ text: "{broken}" })).toMatchObject({
      surfaceId: null,
      messages: [],
      errors: [expect.stringContaining("JSON parse error:")],
    })
    expect(parseA2UIInput('{"ordinary":true}').messages).toEqual([])
  })

  it.each([
    ["```a2ui\nnot yet complete", true],
    ['{"surface":{},"components":[]}', true],
    ['{"component":"Slider"}', true],
    ['{"component":"Unknown"}', false],
  ])("detects format signals without claiming validity: %s", (input, expected) => {
    expect(detectA2UIContent(input)).toBe(expected)
  })

  it("skips mismatched raw brackets and preserves a later valid payload", () => {
    const raw = JSON.stringify(ready)
    const response = "[mismatch}\n" + raw
    const blocks = extractA2UIBlocks(response)
    expect(blocks).toHaveLength(1)
    expect(response.slice(blocks[0].start, blocks[0].end)).toBe(raw)
  })

  it("does not accept a partially valid array or JSONL fence as a complete surface", () => {
    expect(extractA2UIBlocks("```a2ui\n[" + JSON.stringify(ready) + ",null]\n```")).toEqual([])
    expect(
      extractA2UIBlocks(
        "```jsonl\n" + JSON.stringify(ready) + '\n{"type":"unknown","surfaceId":"s"}\n```'
      )
    ).toEqual([])
  })
})
