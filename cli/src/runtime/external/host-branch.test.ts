/** @jest-environment node */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { agentReadTextFile, agentWriteTextFile, createCliAgentHost } from "./host-branch"

describe("CLI external-agent host branch", () => {
  it("routes invoke/listen to the Node backend and advertises fs without terminals", async () => {
    const handlers = new Map<string, (payload: unknown) => void>()
    const backend = {
      invoke: jest.fn().mockResolvedValue("ok"),
      listen: jest.fn((event: string, handler: (payload: unknown) => void) => {
        handlers.set(event, handler)
        return () => handlers.delete(event)
      }),
    }
    const host = createCliAgentHost(backend)
    expect(host.supportsExternalAgents()).toBe(true)
    expect(host.supportsAgentFs()).toBe(true)
    expect(host.supportsAgentTerminal()).toBe(false)
    await expect(host.agentInvoke("check_command_exists", { command: "codex" })).resolves.toBe("ok")
    const handler = jest.fn()
    const off = await host.agentListen("external-agent://stdout", handler)
    handlers.get("external-agent://stdout")?.({ agentId: "a", data: "x" })
    expect(handler).toHaveBeenCalledWith({ agentId: "a", data: "x" })
    off()
  })

  it("reads and writes ACP text files through node fs", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-host-fs-"))
    const file = path.join(dir, "note.txt")
    await agentWriteTextFile(file, "hello")
    await expect(agentReadTextFile(file)).resolves.toBe("hello")
  })
})
