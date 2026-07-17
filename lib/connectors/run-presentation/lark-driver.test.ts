import { createLarkRunPresentationDriver } from "./lark-driver"
import type { RunProjectionSnapshot } from "@/types/execution/run"

const snapshot = (
  revision: number,
  status: RunProjectionSnapshot["status"] = "running"
): RunProjectionSnapshot => ({
  runId: "run-1",
  kind: "workflow",
  title: "Release workflow",
  status,
  revision,
  startedAt: 1,
  updatedAt: revision + 1,
  progress: { completed: 1, total: 2, ratio: 0.5, trustworthy: true },
  activeSteps: [{ id: "build", title: "Build", status: "in_progress" }],
  recentSteps: [],
  pendingSteps: [],
  pendingStepCount: 1,
  elapsedMs: 1_000,
  artifacts: [],
  allowedActions: status === "running" ? ["stop", "pause"] : [],
})

describe("Lark run presentation driver", () => {
  it("creates, sends, and updates a CardKit 2.0 entity with monotonic sequences", async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = []
    const driver = createLarkRunPresentationDriver(async (method, path, body) => {
      calls.push({ method, path, body })
      if (path === "/cardkit/v1/cards") return { data: { card_id: "card-1" } }
      if (path.startsWith("/im/v1/messages")) return { data: { message_id: "msg-1" } }
      return { data: {} }
    })

    const target = { adapterId: "lark-1", conversationKey: "lark:lark-1:chat-1" }
    const ref = await driver.open(target, snapshot(1))
    const updated = await driver.update(ref, snapshot(2))
    await driver.finish(updated, snapshot(3, "completed"))

    expect(calls.map((call) => [call.method, call.path])).toEqual([
      ["POST", "/cardkit/v1/cards"],
      ["POST", "/im/v1/messages?receive_id_type=chat_id"],
      ["PUT", "/cardkit/v1/cards/card-1"],
      ["PUT", "/cardkit/v1/cards/card-1"],
    ])
    expect((calls[2].body as { sequence: number }).sequence).toBe(1)
    expect((calls[3].body as { sequence: number }).sequence).toBe(2)
    expect(ref.platformMessageId).toBe("msg-1")
    expect(updated.opaqueState?.sequence).toBe(1)
  })

  it("trims oversized card bodies below the CardKit 30KB limit", async () => {
    let createdData = ""
    const driver = createLarkRunPresentationDriver(async (_method, path, body) => {
      if (path === "/cardkit/v1/cards") {
        createdData = (body as { data: string }).data
        return { data: { card_id: "card-1" } }
      }
      return { data: { message_id: "msg-1" } }
    })
    const large = snapshot(1)
    large.summary = "x".repeat(50_000)

    await driver.open({ adapterId: "lark-1", conversationKey: "lark:lark-1:chat-1" }, large)

    expect(new TextEncoder().encode(createdData).byteLength).toBeLessThanOrEqual(30_000)
    expect(createdData).toContain("truncated")
  })

  it("checkpoints the card entity and resumes without creating a duplicate", async () => {
    const calls: string[] = []
    const checkpoints: Array<{ opaqueState?: Record<string, unknown> }> = []
    const driver = createLarkRunPresentationDriver(async (_method, path) => {
      calls.push(path)
      if (path === "/cardkit/v1/cards") return { data: { card_id: "card-checkpoint" } }
      return { data: { message_id: "message-checkpoint" } }
    })
    const target = { adapterId: "lark-1", conversationKey: "lark:lark-1:chat-1" }
    const first = await driver.open(target, snapshot(1), {
      checkpoint: async (ref) => {
        checkpoints.push(ref)
      },
    })

    await driver.open(target, snapshot(1), { previousRef: first })

    expect(calls.filter((path) => path === "/cardkit/v1/cards")).toHaveLength(1)
    expect(checkpoints[0]?.opaqueState?.cardId).toBe("card-checkpoint")
  })
})
