/** @jest-environment jsdom */

import { safeOrigin } from "./cognia-workflow-app"

describe("Cognia Workflow App embed origin validation", () => {
  it.each(["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"])(
    "accepts the supported loopback origin %s",
    (origin) => {
      expect(safeOrigin(origin, "https://host.example/portal")).toBe(origin)
    }
  )

  it("rejects insecure non-loopback origins", () => {
    expect(safeOrigin("http://embed.example", "https://host.example/portal")).toBeUndefined()
  })
})
