const getRun = jest.fn()
const getInstallation = jest.fn()
const resolve = jest.fn()
jest.mock("@/lib/db/execution-runs", () => ({
  getExecutionRun: (...args: unknown[]) => getRun(...args),
}))
jest.mock("@/lib/db/bot-installations", () => ({
  getBotInstallation: (...args: unknown[]) => getInstallation(...args),
}))
jest.mock("@/lib/bot/installed-bot", () => ({
  resolveInstalledBot: (...args: unknown[]) => resolve(...args),
}))
import { requireOwnedBotRun } from "./owned-run"

beforeEach(() => {
  getRun.mockResolvedValue({ kind: "bot", sourceId: "installation", status: "running" })
  getInstallation.mockResolvedValue({
    status: "enabled",
    definitionSource: "plugin",
    definitionId: "owner:bot",
  })
  resolve.mockResolvedValue({ definition: { handler: jest.fn() } })
})
it("resolves only a live owned Bot on this host", async () => {
  expect(await requireOwnedBotRun("owner", "run")).toHaveProperty(
    "installation.definitionId",
    "owner:bot"
  )
  await expect(requireOwnedBotRun("intruder", "run")).rejects.toThrow("does not belong")
})
it.each([undefined, { kind: "chat" }, { kind: "bot", sourceId: "i", status: "completed" }])(
  "denies invalid run %j",
  async (run) => {
    getRun.mockResolvedValue(run)
    await expect(requireOwnedBotRun("owner", "run")).rejects.toThrow("no longer active")
  }
)
it.each([
  undefined,
  { syncedFromHost: "remote" },
  { status: "disabled" },
  { definitionSource: "local" },
])("denies invalid installation %j", async (override) => {
  getInstallation.mockResolvedValue(
    override
      ? { status: "enabled", definitionSource: "plugin", definitionId: "owner:bot", ...override }
      : undefined
  )
  await expect(requireOwnedBotRun("owner", "run")).rejects.toThrow("does not belong")
})
it("denies unloaded handlers", async () => {
  resolve.mockResolvedValue(null)
  await expect(requireOwnedBotRun("owner", "run")).rejects.toThrow("unavailable")
  resolve.mockResolvedValue({ definition: {} })
  await expect(requireOwnedBotRun("owner", "run")).rejects.toThrow("unavailable")
})
