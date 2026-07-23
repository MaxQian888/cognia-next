import { restorePermissionState } from "./permission-restore"

it("never restores an allowance: allow/allow_always downgrade to pending; deny and pending survive", () => {
  const restored = restorePermissionState([
    { requestId: "p1", toolName: "Bash", decision: "allow" },
    { requestId: "p2", toolName: "Edit", decision: "allow_always" },
    { requestId: "p3", toolName: "Write", decision: "deny" },
    { requestId: "p4", toolName: "Read", decision: "pending" },
  ])
  expect(restored).toEqual([
    { requestId: "p1", toolName: "Bash", state: "pending", downgradedFromAllow: true },
    { requestId: "p2", toolName: "Edit", state: "pending", downgradedFromAllow: true },
    { requestId: "p3", toolName: "Write", state: "denied" },
    { requestId: "p4", toolName: "Read", state: "pending" },
  ])
  // Structural guarantee: no restored state can be an allowance.
  expect(restored.every((p) => p.state === "pending" || p.state === "denied")).toBe(true)
})
