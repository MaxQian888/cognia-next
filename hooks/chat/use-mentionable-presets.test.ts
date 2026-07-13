/**
 * @jest-environment jsdom
 */

import type { SystemPromptPreset } from "@cognia/agent-config-types"

const rowsRef: { current: SystemPromptPreset[] | undefined } = { current: [] }
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (fn: () => unknown) => {
    void fn()
    return rowsRef.current
  },
}))
const listPresetsMock = jest.fn(() => Promise.resolve(rowsRef.current ?? []))
jest.mock("@/lib/db/prompt-presets", () => ({
  ...jest.requireActual("@/lib/db/prompt-presets"),
  listPresets: () => listPresetsMock(),
}))

import { renderHook } from "@testing-library/react"
import { useMentionablePresets } from "./use-mentionable-presets"

const mkPreset = (id: string, name: string): SystemPromptPreset =>
  ({ id, name, content: "sys", createdAt: 0, updatedAt: 0 }) as SystemPromptPreset

beforeEach(() => {
  rowsRef.current = []
  listPresetsMock.mockClear()
})

describe("useMentionablePresets", () => {
  it("returns the live preset list", () => {
    rowsRef.current = [mkPreset("p1", "Coding"), mkPreset("p2", "Writing")]
    const { result } = renderHook(() => useMentionablePresets())
    expect(result.current.map((p) => p.name)).toEqual(["Coding", "Writing"])
  })

  it("returns an empty list while loading (undefined)", () => {
    rowsRef.current = undefined
    const { result } = renderHook(() => useMentionablePresets())
    expect(result.current).toEqual([])
  })

  it("does not query Dexie when disabled", () => {
    renderHook(() => useMentionablePresets(false))
    expect(listPresetsMock).not.toHaveBeenCalled()
  })
})
