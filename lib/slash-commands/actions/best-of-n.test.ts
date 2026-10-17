import { handleBestOfN, parseBestOfNCommand } from "./best-of-n"
import { BUILTIN_SLASH_COMMANDS, type SlashContext } from "../builtin"
import {
  canManageBestOfNRuns,
  listBestOfNRuns,
  refreshBestOfNRun,
} from "@/lib/best-of-n/projection"
import { cancelBestOfN } from "@/lib/best-of-n/service"
import { pickBestOfNCandidate } from "@/lib/best-of-n/publication"
import { requestBestOfNCancel } from "@/lib/best-of-n/paired"
jest.mock("@/lib/i18n/runtime-translator", () => ({
  getRuntimeTranslator: async () => (key: string) => key,
}))
jest.mock("@/lib/best-of-n/projection", () => ({
  canManageBestOfNRuns: jest.fn(() => true),
  bestOfNDeviceRole: () =>
    jest.requireMock("@/lib/best-of-n/projection").canManageBestOfNRuns()
      ? "host"
      : "pairedObserver",
  listBestOfNRuns: jest.fn(),
  refreshBestOfNRun: jest.fn(),
}))
jest.mock("@/lib/best-of-n/service", () => ({ cancelBestOfN: jest.fn() }))
jest.mock("@/lib/best-of-n/publication", () => ({ pickBestOfNCandidate: jest.fn() }))
jest.mock("@/lib/best-of-n/paired", () => ({ requestBestOfNCancel: jest.fn() }))
const group = {
  groupId: "g",
  phase: "running",
  candidates: [
    { candidateId: "c1", index: 0, status: "succeeded" },
    { candidateId: "c2", index: 1, status: "running" },
  ],
}
const ctx = (args: string) =>
  ({
    args,
    activeSessionId: "s",
    chatStatus: "idle",
    pushSystemMessage: jest.fn(),
    startBestOfN: jest.fn(async () => true),
  }) as unknown as SlashContext
beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(canManageBestOfNRuns).mockReturnValue(true)
  jest
    .mocked(listBestOfNRuns)
    .mockResolvedValue([{ id: "g", updatedAt: 1, group: { ...group, createdAt: 1 } }] as never)
  jest.mocked(refreshBestOfNRun).mockResolvedValue({ group } as never)
})
it("registers a real action and preserves multiline prompt with optional count", () => {
  expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "best-of-n")?.handler).toBe(
    handleBestOfN
  )
  expect(parseBestOfNCommand("3 fix this\nwith tests")).toEqual({
    kind: "start",
    n: 3,
    prompt: "fix this\nwith tests",
  })
  expect(parseBestOfNCommand("fix this")).toEqual({ kind: "start", n: 2, prompt: "fix this" })
  for (const invalid of ["", "5 fix", "3", "pick", "pick 1 2", "status extra"])
    expect(parseBestOfNCommand(invalid)).toEqual({ kind: "invalid" })
})
it("assigns one named agent per candidate and infers the count from the list", () => {
  expect(parseBestOfNCommand("--agents claude-code,codex fix bug\ninclude tests")).toEqual({
    kind: "start",
    n: 2,
    prompt: "fix bug\ninclude tests",
    agents: ["claude-code", "codex"],
  })
  expect(parseBestOfNCommand("3 --agents=session,codex,session fix")).toEqual({
    kind: "start",
    n: 3,
    prompt: "fix",
    agents: ["session", "codex", "session"],
  })
  for (const invalid of [
    "3 --agents a,b fix",
    "--agents a fix",
    "--agents a,b,c,d,e fix",
    "--agents a,,b fix",
    "--agents a,b",
  ])
    expect(parseBestOfNCommand(invalid)).toEqual({ kind: "invalid" })
})
it("hands the named agents to the composer preview", async () => {
  const context = ctx("--agents session,codex fix")
  await handleBestOfN(context)
  expect(context.startBestOfN).toHaveBeenCalledWith("fix", 2, ["session", "codex"])
})
it("consumes start through the composer preview exactly once", async () => {
  const context = ctx("4 fix")
  await handleBestOfN(context)
  expect(context.startBestOfN).toHaveBeenCalledTimes(1)
  expect(context.startBestOfN).toHaveBeenCalledWith("fix", 4, undefined)
  expect(context.pushSystemMessage).not.toHaveBeenCalled()
})
it("picks only a user-named candidate from this session's latest run", async () => {
  await handleBestOfN(ctx("pick 1"))
  expect(pickBestOfNCandidate).toHaveBeenCalledWith("g", "c1")
  await handleBestOfN(ctx("pick foreign"))
  expect(pickBestOfNCandidate).toHaveBeenCalledTimes(1)
})
it("allows status and cancel while candidates run", async () => {
  const status = ctx("status")
  await handleBestOfN(status)
  expect(status.pushSystemMessage).toHaveBeenCalled()
  await handleBestOfN(ctx("cancel"))
  expect(cancelBestOfN).toHaveBeenCalledWith("g")
})
it("refuses start during streaming or with attachments", async () => {
  const busy = ctx("2 fix")
  busy.chatStatus = "streaming"
  await handleBestOfN(busy)
  expect(busy.startBestOfN).not.toHaveBeenCalled()
  const attached = ctx("2 fix")
  attached.stagedFiles = [{ id: "f", url: "blob:f", mediaType: "image/png" }]
  await handleBestOfN(attached)
  expect(attached.startBestOfN).not.toHaveBeenCalled()
})

it("paired observers read synced status, ask the Host to stop, and cannot pick", async () => {
  jest.mocked(canManageBestOfNRuns).mockReturnValue(false)
  const status = ctx("status")
  await handleBestOfN(status)
  expect(status.pushSystemMessage).toHaveBeenCalled()
  expect(refreshBestOfNRun).not.toHaveBeenCalled()
  const pick = ctx("pick 1")
  await handleBestOfN(pick)
  expect(pick.pushSystemMessage).toHaveBeenCalledWith("unavailable")
  const cancel = ctx("cancel")
  await handleBestOfN(cancel)
  expect(requestBestOfNCancel).toHaveBeenCalledWith("g")
  expect(cancel.pushSystemMessage).toHaveBeenCalledWith("stopRequested")
  expect(cancelBestOfN).not.toHaveBeenCalled()
  expect(pickBestOfNCandidate).not.toHaveBeenCalled()
})
