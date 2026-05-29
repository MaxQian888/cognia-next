import { renderHook, act } from "@testing-library/react"

jest.mock("dexie-react-hooks", () => ({
  // Return the default (initialValue) synchronously; we exercise the action
  // callbacks, not the live-query reactivity.
  useLiveQuery: (_fn: unknown, _deps: unknown, initial: unknown) => initial,
}))

jest.mock("@/lib/db/sandbox-connections", () => ({
  listSandboxConnections: jest.fn().mockResolvedValue([]),
  putSandboxConnection: jest.fn().mockResolvedValue(undefined),
  deleteSandboxConnection: jest.fn().mockResolvedValue(undefined),
  getSandboxConnection: jest.fn(),
}))

jest.mock("@/lib/automation/sandbox-client", () => ({
  sandboxClient: {
    start: jest.fn().mockResolvedValue(49160),
    stop: jest.fn().mockResolvedValue(undefined),
    health: jest.fn().mockResolvedValue(true),
  },
}))

import { useSandboxConnections } from "@/hooks/automation/use-sandbox-connections"
import * as db from "@/lib/db/sandbox-connections"
import { sandboxClient } from "@/lib/automation/sandbox-client"

const put = db.putSandboxConnection as jest.Mock
const get = db.getSandboxConnection as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
})

test("create writes a docker row with defaults", async () => {
  const { result } = renderHook(() => useSandboxConnections())
  await act(async () => {
    await result.current.create({ name: "home" })
  })
  expect(put).toHaveBeenCalledTimes(1)
  const row = put.mock.calls[0][0]
  expect(row).toMatchObject({
    name: "home",
    provider: "docker",
    image: "ghcr.io/trycua/cua-xfce:latest",
    host: "127.0.0.1",
    port: 0,
    lastHealthStatus: "unknown",
  })
})

test("start calls sandboxClient.start and records the port", async () => {
  get.mockResolvedValue({
    id: "c1",
    name: "home",
    provider: "docker",
    image: "img",
    host: "127.0.0.1",
    port: 0,
    lastHealthStatus: "unknown",
    createdAt: 1,
    updatedAt: 1,
  })
  const { result } = renderHook(() => useSandboxConnections())
  await act(async () => {
    await result.current.start("c1")
  })
  expect(sandboxClient.start).toHaveBeenCalledWith("c1", "img")
  // last put records ok + the resolved port
  const last = put.mock.calls.at(-1)?.[0]
  expect(last).toMatchObject({ port: 49160, lastHealthStatus: "ok" })
})
