import { maybeAutoPushToCli } from "./auto-push"
import { pushToCli, type PushReport } from "./push-to-cli"
import type { AppSettings } from "@/lib/claude/types"

const ON = { id: "singleton", cliBridge: { autoSync: true } } as AppSettings
const OFF = { id: "singleton", cliBridge: { autoSync: false } } as AppSettings

describe("maybeAutoPushToCli", () => {
  it("pushes config + credentials + history when enabled on desktop", async () => {
    const push = jest.fn<Promise<PushReport>, Parameters<typeof pushToCli>>(async () => ({
      home: "/h",
    }))
    const report = await maybeAutoPushToCli(ON, { isTauri: () => true, push })
    expect(report).toEqual({ home: "/h" })
    expect(push).toHaveBeenCalledWith(ON, { config: true, credentials: true, history: true })
  })

  it("skips when auto-sync is off", async () => {
    const push = jest.fn<Promise<PushReport>, Parameters<typeof pushToCli>>(async () => ({
      home: "/h",
    }))
    expect(await maybeAutoPushToCli(OFF, { isTauri: () => true, push })).toBeNull()
    expect(push).not.toHaveBeenCalled()
  })

  it("skips off the desktop", async () => {
    const push = jest.fn<Promise<PushReport>, Parameters<typeof pushToCli>>(async () => ({
      home: "/h",
    }))
    expect(await maybeAutoPushToCli(ON, { isTauri: () => false, push })).toBeNull()
    expect(push).not.toHaveBeenCalled()
  })

  it("uses the real isTauri default when no deps given (null in jsdom)", async () => {
    // No injected deps → exercises the `?? isTauri` default; jsdom isn't Tauri.
    expect(await maybeAutoPushToCli(ON)).toBeNull()
  })

  it("falls back to the real pushToCli when only isTauri is forced", async () => {
    // isTauri forced true + no push dep → exercises the `?? pushToCli` default;
    // the real pushToCli finds no CLI home in jsdom and reports home: null.
    const report = await maybeAutoPushToCli(ON, { isTauri: () => true })
    expect(report?.home).toBeNull()
  })

  it("does not auto-push MCP (chip-controlled)", async () => {
    const push = jest.fn<Promise<PushReport>, Parameters<typeof pushToCli>>(async () => ({
      home: "/h",
    }))
    await maybeAutoPushToCli(ON, { isTauri: () => true, push })
    expect(push.mock.calls[0][1]).not.toHaveProperty("mcp", true)
  })
})
