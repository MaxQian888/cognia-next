import path from "node:path"

import { createCogniaClient } from "./client"
import { HostNotFoundError, openHost } from "./host"

describe("agent host discovery", () => {
  it("reports every explicit missing host path", () => {
    const missing = path.join(process.cwd(), ".missing-cognia-host")
    expect(() => openHost({ kind: "path", path: missing })).toThrow(HostNotFoundError)
    try {
      openHost({ kind: "path", path: missing })
    } catch (error) {
      expect(error).toMatchObject({ code: "host_not_found", searchedLocations: [missing] })
    }
  })

  it("maps a PATH spawn failure to host_not_found", async () => {
    await expect(
      createCogniaClient({
        host: { kind: "path", path: `missing-cognia-host-${process.pid}`, startupTimeoutMs: 100 },
      })
    ).rejects.toMatchObject({ code: "host_not_found" })
  })
})
