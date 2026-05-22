/**
 * @jest-environment jsdom
 */

import { renderHook } from "@testing-library/react"
import type { PluginRow } from "@/lib/db/plugin-types"

const ROW: PluginRow = {
  id: "p1",
  name: "P1",
  version: "1.0.0",
  status: "enabled",
  source: "builtin",
  type: "frontend",
  enabled: true,
  capabilities: [],
  path: "/p1",
  manifest: {},
  createdAt: 1,
  updatedAt: 1,
}

// Two phases: "loading" returns the default (sentinel); "resolved" returns
// whatever the inner getPlugin promise produced (PluginRow or undefined).
// The hook must use a referentially-stable sentinel as the third arg, so
// the comparison `result === default` works after the query resolves.
let phase: "loading" | "resolved" = "loading"
let resolvedValue: PluginRow | undefined = undefined

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: <T>(_fn: () => unknown, _deps: unknown[], def?: T) => {
    return phase === "loading" ? def : resolvedValue
  },
}))

jest.mock("@/lib/db/plugins", () => ({
  getPlugin: jest.fn(),
}))

import { usePluginRow } from "./use-plugin-row"

describe("usePluginRow", () => {
  beforeEach(() => {
    phase = "loading"
    resolvedValue = undefined
  })

  it("returns state=loading before the live-query resolves", () => {
    phase = "loading"
    const { result } = renderHook(() => usePluginRow("p1"))
    expect(result.current).toEqual({ state: "loading" })
  })

  it("returns state=ready when the row resolves to a PluginRow", () => {
    phase = "resolved"
    resolvedValue = ROW
    const { result } = renderHook(() => usePluginRow("p1"))
    expect(result.current).toEqual({ state: "ready", row: ROW })
  })

  it("returns state=not-found when the row resolves to undefined", () => {
    phase = "resolved"
    resolvedValue = undefined
    const { result } = renderHook(() => usePluginRow("p1"))
    expect(result.current).toEqual({ state: "not-found" })
  })
})
