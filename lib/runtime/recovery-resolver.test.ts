import type { OperationAvailability } from "./operation-availability"
import { resolveRuntimeRecovery } from "./recovery-resolver"

const availability = (
  state: OperationAvailability["state"],
  requiredGrant?: string
): OperationAvailability => ({
  state,
  reason: state === "requires-grant" ? "missing-grant" : "connection-offline",
  requiredGrant,
})

it("routes paired Web failures to the shared recovery mode", () => {
  expect(resolveRuntimeRecovery(availability("offline"), "web")).toEqual({
    kind: "route",
    href: "/pair?mode=recover&state=offline",
  })
  expect(resolveRuntimeRecovery(availability("incompatible"), "web")).toEqual({
    kind: "route",
    href: "/pair?mode=recover&state=incompatible",
  })
})

it("carries the exact missing grant into recovery without implying self-grant", () => {
  expect(resolveRuntimeRecovery(availability("requires-grant", "chat.send/admin"), "web")).toEqual({
    kind: "route",
    href: "/pair?mode=recover&state=requires-grant&requiredGrant=chat.send%2Fadmin",
  })
})

it("keeps native Tauri on its existing local Companion settings", () => {
  expect(resolveRuntimeRecovery(availability("offline"), "tauri")).toEqual({
    kind: "local-settings",
    section: "companion",
  })
})

it("routes pairing requirements to add mode and ignores non-actionable states", () => {
  expect(resolveRuntimeRecovery(availability("requires-pairing"), "web")).toEqual({
    kind: "route",
    href: "/pair?mode=add",
  })
  expect(resolveRuntimeRecovery(availability("read-only"), "web")).toEqual({ kind: "none" })
})
