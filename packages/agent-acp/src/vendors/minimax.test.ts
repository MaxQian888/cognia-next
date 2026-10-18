import { minimaxAcpProfile } from "./minimax"

it("keeps native permission and plan axes distinct", () => {
  const modes = minimaxAcpProfile.permissionModes!
  expect(modes.toCanonical("default", "bypassPermissions")).toBe("bypassPermissions")
  expect(modes.toCanonical("plan", "bypassPermissions")).toBe("plan")
  expect(modes.toCanonical("default", "plan")).toBe("default")
  expect(modes.toNative("default")).toBe("default")
  expect(modes.toNative("bypassPermissions")).toBe("default")
  expect(modes.toNative("plan")).toBe("plan")
  expect(() => modes.toNative("acceptEdits")).toThrow("cannot enforce")
  expect(() => modes.toNative("dontAsk")).toThrow("cannot enforce")
})
