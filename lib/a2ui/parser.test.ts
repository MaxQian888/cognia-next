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
} from "./parser"

describe("A2UI Parser", () => {
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
