/** @jest-environment node */
import {
  fireAgentHook,
  gateExternalAgentPermission,
  noticeFromDecision,
  observeExternalAgentEvent,
} from "./agent-hooks-shim"

const ctx = { agentId: "a", sessionId: "s" }

describe("CLI external-agent hook shim", () => {
  it("keeps hook execution best-effort/no-op without Tauri", async () => {
    await expect(fireAgentHook("Stop", ctx)).resolves.toBeNull()
    await expect(
      observeExternalAgentEvent(ctx, { type: "done", success: true, timestamp: new Date() })
    ).resolves.toBeUndefined()
    const deny = jest.fn()
    await expect(
      gateExternalAgentPermission(
        ctx,
        {
          type: "permission_request",
          timestamp: new Date(),
          request: { id: "p1", requestId: "p1", options: [] },
        },
        deny
      )
    ).resolves.toBe(false)
    expect(deny).not.toHaveBeenCalled()
  })

  it("preserves consequential notice normalization", () => {
    expect(
      noticeFromDecision("PreToolUse", "bash", {
        block: "denied",
        warnings: ["warning"],
      })
    ).toMatchObject({ event: "PreToolUse", toolName: "bash", outcome: "blocked" })
  })
})
