/**
 * @jest-environment node
 */
import { pathToFileURL } from "node:url"

import { runSidecarRole } from "./sidecar-role"

describe("runSidecarRole", () => {
  it("imports the resolved sidecar script as a file URL", async () => {
    const importer = jest.fn().mockResolvedValue(undefined)
    const resolveScript = jest.fn().mockReturnValue("/dist/sidecar/claude-host.mjs")

    await runSidecarRole({ resolveScript, importer })

    expect(resolveScript).toHaveBeenCalledTimes(1)
    expect(importer).toHaveBeenCalledWith(pathToFileURL("/dist/sidecar/claude-host.mjs").href)
  })

  it("propagates an import failure", async () => {
    const importer = jest.fn().mockRejectedValue(new Error("boom"))
    const resolveScript = jest.fn().mockReturnValue("/x/claude-host.mjs")

    await expect(runSidecarRole({ resolveScript, importer })).rejects.toThrow("boom")
  })
})
