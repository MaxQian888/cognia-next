/** @jest-environment node */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  agentReadTextFile,
  agentWriteTextFile,
  agentDeleteTextFile,
  createCliAgentHost,
  createCliExternalAgentHost,
  getAcpHostCapabilities,
} from "./host-branch"
import { cliAgentHookPlane } from "./hook-plane"
import { cliTerminalPlane } from "./pty-terminals"

describe("CLI external-agent host branch", () => {
  it("deletes owned files idempotently and refuses symlinks and directory escapes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aider-host-delete-"))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "aider-host-outside-"))
    try {
      const file = path.join(root, "session.json")
      fs.writeFileSync(file, "history")
      await agentDeleteTextFile(file, [root])
      expect(fs.existsSync(file)).toBe(false)
      await agentDeleteTextFile(file, [root])
      const target = path.join(outside, "keep.txt")
      fs.writeFileSync(target, "keep")
      const link = path.join(root, "linked.txt")
      fs.symlinkSync(target, link)
      await expect(agentDeleteTextFile(link, [root])).rejects.toThrow()
      await expect(agentDeleteTextFile(target, [root])).rejects.toThrow(/outside/)
      await expect(agentDeleteTextFile(root, [root])).rejects.toThrow()
      expect(fs.readFileSync(target, "utf8")).toBe("keep")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
  it("reports the CLI host and its durable elicitation overlay", () => {
    expect(getAcpHostCapabilities("win32")).toMatchObject({ terminal: false, terminalAuth: false })
    expect(getAcpHostCapabilities()).toMatchObject({
      kind: "cli",
      terminal: process.platform !== "win32",
      terminalAuth: process.platform !== "win32",
      elicitation: { form: true, url: true, durableInteraction: true },
    })
  })

  it("routes invoke/listen to the Node backend and advertises PTYs only off Windows", async () => {
    const handlers = new Map<string, (payload: unknown) => void>()
    const backend = {
      invoke: jest.fn().mockResolvedValue("ok"),
      listen: jest.fn((event: string, handler: (payload: unknown) => void) => {
        handlers.set(event, handler)
        return () => handlers.delete(event)
      }),
    }
    const host = createCliAgentHost(backend, "darwin")
    expect(host.supportsExternalAgents()).toBe(true)
    expect(host.supportsAgentFs()).toBe(true)
    expect(host.supportsAgentTerminal()).toBe(true)
    await expect(host.agentInvoke("check_command_exists", { command: "codex" })).resolves.toBe("ok")
    const handler = jest.fn()
    const off = await host.agentListen("external-agent://stdout", handler)
    handlers.get("external-agent://stdout")?.({ agentId: "a", data: "x" })
    expect(handler).toHaveBeenCalledWith({ agentId: "a", data: "x" })
    off()

    expect(createCliAgentHost(backend, "win32").supportsAgentTerminal()).toBe(false)
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

describe("CLI external-agent host installation", () => {
  it("assembles the Node process plane, PTY terminals and the no-hooks policy", async () => {
    const backend = { invoke: jest.fn().mockResolvedValue(true), listen: jest.fn(() => () => {}) }
    const host = createCliExternalAgentHost(backend, "win32")
    expect(host.kind).toBe("cli")
    expect(host.terminals).toBe(cliTerminalPlane)
    expect(host.hooks).toBe(cliAgentHookPlane)
    expect(host.process.runsExternalAgentProcessesLocally()).toBe(true)
    expect(host.process.supportsAgentTerminal()).toBe(false)
    expect(host.process.getAcpHostCapabilities()).toMatchObject({ kind: "cli", terminal: false })
    expect(host.process.readTextFile).toBe(agentReadTextFile)
    expect(host.process.writeTextFile).toBe(agentWriteTextFile)
    expect(host.process.deleteTextFile).toBe(agentDeleteTextFile)
    await expect(host.process.invoke("check_command_exists", { command: "pi" })).resolves.toBe(true)
    expect(backend.invoke).toHaveBeenCalledWith("check_command_exists", { command: "pi" })
    expect(Object.isFrozen(host)).toBe(true)
    expect(Object.isFrozen(host.process)).toBe(true)
  })

  it("installs once, so the shared process plane, terminals and hooks reach the CLI", async () => {
    const { installCliExternalAgentHost } = await import("./host-branch")
    const { getInstalledExternalAgentHost } =
      await import("@/lib/ai/agent/external/host/installed-host")
    const uninstall = installCliExternalAgentHost()
    try {
      const installed = getInstalledExternalAgentHost()
      expect(installed?.kind).toBe("cli")
      expect(installed?.terminals).toBe(cliTerminalPlane)
      // Idempotent: a second boot path installing the same host is not a conflict.
      expect(() => installCliExternalAgentHost()).not.toThrow()
      expect(getInstalledExternalAgentHost()).toBe(installed)
    } finally {
      uninstall()
    }
    expect(getInstalledExternalAgentHost()).toBeNull()
  })

  it("only exposes workspace selection to the local host, not agent RPC", async () => {
    const { selectCliAgentWorkspace, installCliExternalAgentHost } = await import("./host-branch")
    const { getInstalledExternalAgentHost } =
      await import("@/lib/ai/agent/external/host/installed-host")
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-selected-host-"))
    const uninstall = installCliExternalAgentHost()
    try {
      expect(() => selectCliAgentWorkspace(root)).not.toThrow()
      await expect(
        getInstalledExternalAgentHost()!.process.invoke("select_workspace", { cwd: root })
      ).rejects.toThrow()
    } finally {
      uninstall()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
