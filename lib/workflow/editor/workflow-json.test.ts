/**
 * @jest-environment jsdom
 */
import { downloadWorkflowJson, parseWorkflowImport } from "./workflow-json"
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
