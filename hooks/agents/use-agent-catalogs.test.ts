/**
 * @jest-environment jsdom
 */

jest.mock("dexie-react-hooks", () => {
  const { useEffect, useState } = jest.requireActual<typeof import("react")>("react")
  return {
    useLiveQuery: (querier: () => unknown, deps: unknown[]) => {
      const [value, setValue] = useState<unknown>(undefined)
      useEffect(() => {
        let cancelled = false
        void Promise.resolve(querier()).then((result) => {
          if (!cancelled) setValue(result)
        })
        return () => {
          cancelled = true
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, deps)
      return value
    },
  }
})

jest.mock("@/lib/db/skills", () => ({ listSkills: jest.fn() }))
jest.mock("@/lib/db/mcp-servers", () => ({ listMcpServers: jest.fn() }))
jest.mock("@/lib/db/knowledge-bases", () => ({ listKnowledgeBases: jest.fn() }))

import { renderHook, waitFor } from "@testing-library/react"
import { listSkills } from "@/lib/db/skills"
import { listMcpServers } from "@/lib/db/mcp-servers"
import { listKnowledgeBases } from "@/lib/db/knowledge-bases"
import { useAgentCatalogs } from "./use-agent-catalogs"

const skills = listSkills as jest.Mock
const mcp = listMcpServers as jest.Mock
const kbs = listKnowledgeBases as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  skills.mockResolvedValue([{ id: "sk1" }])
  mcp.mockResolvedValue([{ id: "m1" }, { id: "m2" }])
  kbs.mockResolvedValue([{ id: "kb1" }])
})

describe("useAgentCatalogs", () => {
  it("starts with three empty catalogs while the reads are in flight", () => {
    skills.mockReturnValue(new Promise(() => {}))
    mcp.mockReturnValue(new Promise(() => {}))
    kbs.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useAgentCatalogs())
    expect(result.current).toEqual({ skills: [], mcpServers: [], knowledgeBases: [] })
  })

  it("hands back the same empty arrays on every render until data arrives", () => {
    skills.mockReturnValue(new Promise(() => {}))
    mcp.mockReturnValue(new Promise(() => {}))
    kbs.mockReturnValue(new Promise(() => {}))
    const { result, rerender } = renderHook(() => useAgentCatalogs())
    const first = result.current
    rerender()
    expect(result.current.skills).toBe(first.skills)
    expect(result.current.mcpServers).toBe(first.mcpServers)
    expect(result.current.knowledgeBases).toBe(first.knowledgeBases)
  })

  it("exposes skills, MCP servers and knowledge bases once loaded", async () => {
    const { result } = renderHook(() => useAgentCatalogs())
    await waitFor(() =>
      expect(result.current).toEqual({
        skills: [{ id: "sk1" }],
        mcpServers: [{ id: "m1" }, { id: "m2" }],
        knowledgeBases: [{ id: "kb1" }],
      })
    )
  })

  it("keeps each catalog independent of the others", async () => {
    mcp.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useAgentCatalogs())
    await waitFor(() => expect(result.current.skills).toEqual([{ id: "sk1" }]))
    expect(result.current.knowledgeBases).toEqual([{ id: "kb1" }])
    expect(result.current.mcpServers).toEqual([])
  })

  it("reads each catalog exactly once per mount", async () => {
    const { rerender } = renderHook(() => useAgentCatalogs())
    await waitFor(() => expect(skills).toHaveBeenCalled())
    rerender()
    expect(skills).toHaveBeenCalledTimes(1)
    expect(mcp).toHaveBeenCalledTimes(1)
    expect(kbs).toHaveBeenCalledTimes(1)
  })

  it("surfaces genuinely empty catalogs as empty arrays", async () => {
    skills.mockResolvedValue([])
    mcp.mockResolvedValue([])
    kbs.mockResolvedValue([])
    const { result } = renderHook(() => useAgentCatalogs())
    await waitFor(() => expect(skills).toHaveBeenCalled())
    await Promise.resolve()
    expect(result.current).toEqual({ skills: [], mcpServers: [], knowledgeBases: [] })
  })
})
