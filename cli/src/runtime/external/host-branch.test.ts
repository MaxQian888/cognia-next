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
    await agentWriteTextFile(file, "hello", [dir])
    await expect(agentReadTextFile(file, [dir])).resolves.toBe("hello")
  })

  it("rejects lexical and symlink escapes from ACP session roots", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-host-root-"))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-host-outside-"))
    const secret = path.join(outside, "secret.txt")
    fs.writeFileSync(secret, "secret")
    const link = path.join(root, "escape")
    fs.symlinkSync(outside, link, "dir")

    await expect(agentReadTextFile(secret, [root])).rejects.toThrow(/outside.*workspace roots/i)
    await expect(agentReadTextFile(path.join(link, "secret.txt"), [root])).rejects.toThrow(
      /outside.*workspace roots/i
    )
    await expect(agentWriteTextFile(path.join(link, "new.txt"), "x", [root])).rejects.toThrow(
      /outside.*workspace roots/i
    )
    expect(fs.existsSync(path.join(outside, "new.txt"))).toBe(false)
  })

  it("rejects relative paths and missing session roots", async () => {
    await expect(agentReadTextFile("relative.txt", [process.cwd()])).rejects.toThrow(/absolute/i)
    await expect(agentWriteTextFile("relative.txt", "x", [process.cwd()])).rejects.toThrow(
      /absolute/i
    )
    await expect(
      agentReadTextFile(path.resolve("package.json"), ["/missing/root"])
    ).rejects.toThrow(/no valid.*roots/i)
  })

  it("rejects missing parent directories and final-component symlinks", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-host-boundary-"))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-host-target-"))
    const target = path.join(outside, "target.txt")
    fs.writeFileSync(target, "untouched")
    const link = path.join(root, "linked.txt")
    fs.symlinkSync(target, link)

    await expect(agentWriteTextFile(link, "changed", [root])).rejects.toThrow()
    await expect(
      agentWriteTextFile(path.join(root, "missing", "file.txt"), "x", [root])
    ).rejects.toThrow()
    expect(fs.readFileSync(target, "utf8")).toBe("untouched")
  })
})
