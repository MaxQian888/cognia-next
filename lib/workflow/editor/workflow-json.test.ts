/**
 * @jest-environment jsdom
 */
import {
  downloadWorkflowJson,
  downloadWorkflowsBundle,
  parseWorkflowImport,
  parseWorkflowsImport,
} from "./workflow-json"
import type { VisualWorkflow } from "@/types/workflow/visual"

describe("workflow-json", () => {
  describe("parseWorkflowImport", () => {
    it("returns the parsed workflow when nodes + edges arrays are present", () => {
      const parsed = parseWorkflowImport(JSON.stringify({ name: "X", nodes: [], edges: [] }))
      expect(parsed.name).toBe("X")
      expect(parsed.nodes).toEqual([])
    })

    it("throws on a non-object top-level value", () => {
      expect(() => parseWorkflowImport("42")).toThrow(/object/i)
    })

    it("throws when the nodes/edges arrays are missing", () => {
      expect(() => parseWorkflowImport(JSON.stringify({ name: "X" }))).toThrow(/nodes/i)
    })

    it("propagates JSON syntax errors", () => {
      expect(() => parseWorkflowImport("{not json")).toThrow()
    })

    it("rejects a malformed complete export instead of accepting its shallow shape", () => {
      const malformed: VisualWorkflow = {
        id: "wf_bad",
        schemaVersion: 2,
        name: "Bad",
        createdAt: 0,
        updatedAt: 0,
        nodes: [
          {
            id: "trigger",
            type: "trigger.manual",
            typeVersion: 1,
            position: { x: 0, y: 0 },
            data: { label: "Start", params: {} },
          },
        ],
        edges: [{ id: "dangling", source: "trigger", target: "missing" }],
        settings: {
          errorPolicy: "stop",
          timeoutMs: 60_000,
          concurrency: 1,
          retryDefaults: { attempts: 1, backoff: "fixed", baseMs: 0 },
        },
      }

      expect(() => parseWorkflowImport(JSON.stringify(malformed))).toThrow(/unknown node/i)
    })
  })

  describe("parseWorkflowsImport", () => {
    it("wraps a single workflow into a one-element array", () => {
      const out = parseWorkflowsImport(JSON.stringify({ name: "A", nodes: [], edges: [] }))
      expect(out).toHaveLength(1)
      expect(out[0].name).toBe("A")
    })

    it("unpacks a { workflows: [...] } bundle", () => {
      const bundle = {
        version: 1,
        workflows: [
          { name: "A", nodes: [], edges: [] },
          { name: "B", nodes: [], edges: [] },
        ],
      }
      const out = parseWorkflowsImport(JSON.stringify(bundle))
      expect(out.map((w) => w.name)).toEqual(["A", "B"])
    })

    it("throws on an empty bundle", () => {
      expect(() => parseWorkflowsImport(JSON.stringify({ workflows: [] }))).toThrow(/no workflows/i)
    })

    it("throws when a bundle entry is malformed", () => {
      const bundle = { workflows: [{ name: "A" }] }
      expect(() => parseWorkflowsImport(JSON.stringify(bundle))).toThrow(/nodes/i)
    })

    it("throws on a non-object single value", () => {
      expect(() => parseWorkflowsImport("42")).toThrow(/object/i)
    })
  })

  describe("downloadWorkflowsBundle", () => {
    it("writes a bundle file named after the count", () => {
      const createObjectURL = jest.fn(() => "blob:b")
      const revokeObjectURL = jest.fn()
      ;(URL as unknown as { createObjectURL: unknown }).createObjectURL = createObjectURL
      ;(URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revokeObjectURL
      const realCreate = document.createElement.bind(document)
      let downloadName = ""
      const spy = jest.spyOn(document, "createElement").mockImplementation((tag: string) => {
        const el = realCreate(tag)
        if (tag === "a") {
          ;(el as HTMLAnchorElement).click = () => {
            downloadName = (el as HTMLAnchorElement).download
          }
        }
        return el
      })

      downloadWorkflowsBundle([
        { name: "A", nodes: [], edges: [] } as unknown as VisualWorkflow,
        { name: "B", nodes: [], edges: [] } as unknown as VisualWorkflow,
      ])

      expect(createObjectURL).toHaveBeenCalledTimes(1)
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:b")
      expect(downloadName).toBe("workflows-2.json")
      spy.mockRestore()
    })
  })

  describe("downloadWorkflowJson", () => {
    it("creates, clicks, and revokes a blob anchor with a sanitized filename", () => {
      const click = jest.fn()
      const createObjectURL = jest.fn(() => "blob:x")
      const revokeObjectURL = jest.fn()
      ;(URL as unknown as { createObjectURL: unknown }).createObjectURL = createObjectURL
      ;(URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revokeObjectURL

      const realCreate = document.createElement.bind(document)
      let downloadName = ""
      const spy = jest.spyOn(document, "createElement").mockImplementation((tag: string) => {
        const el = realCreate(tag)
        if (tag === "a") {
          const a = el as HTMLAnchorElement
          a.click = () => {
            click()
            downloadName = a.download
          }
        }
        return el
      })

      downloadWorkflowJson({ name: "My Flow!?", nodes: [], edges: [] } as unknown as VisualWorkflow)

      expect(createObjectURL).toHaveBeenCalledTimes(1)
      expect(click).toHaveBeenCalledTimes(1)
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:x")
      expect(downloadName).toBe("My_Flow_.json")
      spy.mockRestore()
    })
  })
})
