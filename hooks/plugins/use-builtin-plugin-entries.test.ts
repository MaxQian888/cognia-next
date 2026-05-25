/**
 * @jest-environment jsdom
 */

import { renderHook } from "@testing-library/react"

const useLiveQueryMock = jest.fn()
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (...args: unknown[]) => useLiveQueryMock(...args),
}))
jest.mock("@/lib/db/plugins", () => ({
  listPluginsBySource: jest.fn(),
}))

import { useBuiltinPluginEntries, mapBuiltinRowToEntry } from "./use-builtin-plugin-entries"
import type { PluginRow } from "@/lib/db/plugin-types"

function row(overrides: Partial<PluginRow> = {}): PluginRow {
  return {
    id: "com.cognia.cu",
    name: "Computer Use",
    version: "1.2.0",
    status: "enabled",
    source: "builtin",
    type: "frontend",
    enabled: true,
    capabilities: ["tools", "automation"],
    path: "builtin://com.cognia.cu",
    manifest: {
      description: "Native computer automation.",
      author: { name: "Cognia" },
      permissions: ["shell:execute"],
      signature: { verified: true },
    },
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

describe("mapBuiltinRowToEntry", () => {
  it("projects a PluginRow into a built-in marketplace entry", () => {
    const e = mapBuiltinRowToEntry(row())
    expect(e).toMatchObject({
      id: "com.cognia.cu",
      name: "Computer Use",
      version: "1.2.0",
      description: "Native computer automation.",
      author: "Cognia",
      type: "plugin",
      source: "builtin",
      capabilities: ["tools", "automation"],
      permissions: ["shell:execute"],
      signatureState: "verified",
      signed: true,
    })
  })

  it("reads a bare-string author and a failed signature", () => {
    const e = mapBuiltinRowToEntry(
      row({ manifest: { author: "Acme", signature: { failed: true } } })
    )
    expect(e.author).toBe("Acme")
    expect(e.signatureState).toBe("failed")
    expect(e.signed).toBe(false)
  })

  it("defaults capabilities/permissions and falls back to unverified when manifest is empty", () => {
    const e = mapBuiltinRowToEntry(row({ capabilities: undefined as never, manifest: {} }))
    expect(e.capabilities).toEqual([])
    expect(e.permissions).toEqual([])
    expect(e.signatureState).toBe("unverified")
    expect(e.description).toBeUndefined()
    expect(e.author).toBeUndefined()
  })
})

describe("useBuiltinPluginEntries", () => {
  beforeEach(() => useLiveQueryMock.mockReset())

  it("maps built-in rows returned by the live query", () => {
    useLiveQueryMock.mockReturnValue([row()])
    const { result } = renderHook(() => useBuiltinPluginEntries())
    expect(result.current).toHaveLength(1)
    expect(result.current[0]).toMatchObject({ id: "com.cognia.cu", source: "builtin" })
  })

  it("returns an empty array while the live query is unresolved", () => {
    useLiveQueryMock.mockReturnValue(undefined)
    const { result } = renderHook(() => useBuiltinPluginEntries())
    expect(result.current).toEqual([])
  })
})
