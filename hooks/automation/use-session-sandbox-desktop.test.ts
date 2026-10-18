import { renderHook } from "@testing-library/react"

import { useSessionSandboxDesktop } from "./use-session-sandbox-desktop"
import { resolveCharacterById } from "@/lib/db/characters"
import { getSandboxConnection } from "@/lib/db/sandbox-connections"
import { getSession } from "@/lib/db/sessions"
import { projectSandboxConnectionCapabilities } from "@/lib/sandbox/runtime-availability"

// The hook is a thin live query; capture its querier and run it directly so the
// test exercises the real binding ladder (`lib/sandbox/binding.ts`).
let querier: (() => Promise<unknown>) | undefined
let deps: unknown[] | undefined
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (fn: () => Promise<unknown>, nextDeps: unknown[]) => {
    querier = fn
    deps = nextDeps
    return undefined
  },
}))
jest.mock("@/lib/db/sessions", () => ({ getSession: jest.fn() }))
jest.mock("@/lib/db/characters", () => ({ resolveCharacterById: jest.fn() }))
jest.mock("@/lib/db/sandbox-connections", () => ({ getSandboxConnection: jest.fn() }))
jest.mock("@/lib/sandbox/runtime-availability", () => ({
  projectSandboxConnectionCapabilities: jest.fn(),
}))
jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))
let appSandboxTier: string | undefined
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (select: (state: { settings: { sandboxTier?: string } }) => unknown) =>
    select({ settings: { sandboxTier: appSandboxTier } }),
}))

const session = jest.mocked(getSession)
const character = jest.mocked(resolveCharacterById)
const connection = jest.mocked(getSandboxConnection)
const capabilities = jest.mocked(projectSandboxConnectionCapabilities)

function dockerConnection(state: string) {
  return {
    id: "c1",
    state,
    config: { provider: "docker", containerId: "k1" },
  } as unknown as Awaited<ReturnType<typeof getSandboxConnection>>
}

async function resolve(sessionId: string | null) {
  renderHook(() => useSessionSandboxDesktop(sessionId))
  return querier!()
}

beforeEach(() => {
  jest.resetAllMocks()
  querier = undefined
  deps = undefined
  appSandboxTier = undefined
  capabilities.mockReturnValue({ gui: true } as ReturnType<
    typeof projectSandboxConnectionCapabilities
  >)
})

test("no session or a session without a bound GUI connection has no desktop", async () => {
  expect(await resolve(null)).toBeNull()
  session.mockResolvedValue(undefined)
  expect(await resolve("s1")).toBeNull()
  session.mockResolvedValue({ id: "s1" } as Awaited<ReturnType<typeof getSession>>)
  expect(await resolve("s1")).toBeNull()
  session.mockResolvedValue({ id: "s1", computerUseTarget: "local" } as Awaited<
    ReturnType<typeof getSession>
  >)
  expect(await resolve("s1")).toBeNull()
  expect(connection).not.toHaveBeenCalled()
})

test("a session-bound connection is shown and enabled only while running with GUI", async () => {
  session.mockResolvedValue({ id: "s1", computerUseTarget: { connectionId: "c1" } } as Awaited<
    ReturnType<typeof getSession>
  >)
  connection.mockResolvedValue(dockerConnection("running"))
  expect(await resolve("s1")).toEqual({ connectionId: "c1", containerId: "k1", enabled: true })
  expect(capabilities).toHaveBeenCalledWith(dockerConnection("running"), true)

  connection.mockResolvedValue(dockerConnection("stopped"))
  expect(await resolve("s1")).toEqual({ connectionId: "c1", containerId: "k1", enabled: false })

  connection.mockResolvedValue(dockerConnection("running"))
  capabilities.mockReturnValue({ gui: false } as ReturnType<
    typeof projectSandboxConnectionCapabilities
  >)
  expect(await resolve("s1")).toEqual({ connectionId: "c1", containerId: "k1", enabled: false })

  // A deleted connection keeps the panel (so the user sees why) but disabled.
  connection.mockResolvedValue(undefined)
  expect(await resolve("s1")).toEqual({
    connectionId: "c1",
    containerId: undefined,
    enabled: false,
  })
})

test("the character's binding is inherited and the app tier is a dependency", async () => {
  session.mockResolvedValue({ id: "s1", characterId: "ch1" } as Awaited<
    ReturnType<typeof getSession>
  >)
  character.mockResolvedValue({ id: "ch1", computerUseTarget: { connectionId: "c1" } } as Awaited<
    ReturnType<typeof resolveCharacterById>
  >)
  connection.mockResolvedValue(dockerConnection("running"))
  appSandboxTier = "cua-desktop"
  expect(await resolve("s1")).toEqual({ connectionId: "c1", containerId: "k1", enabled: true })
  expect(character).toHaveBeenCalledWith("ch1")
  expect(deps).toEqual(["s1", "cua-desktop"])
})
