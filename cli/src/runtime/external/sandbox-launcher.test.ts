/** @jest-environment node */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  buildSandboxLauncherArgs,
  bundledLauncherCandidates,
  defaultSandboxRuntime,
  findSandboxLauncher,
  isDevCheckout,
  launcherName,
  resolveSandboxedExternalAgentLaunch,
  sandboxLauncherUnavailableMessage,
  sandboxSupportsPlatform,
} from "./sandbox-launcher"
import { toolHostRuntimeDir } from "../../agent/tool-host/protocol"

describe("external-agent sandbox launcher", () => {
  it("discovers launchers beside both single-file and split bundles", () => {
    expect(
      bundledLauncherCandidates(
        "file:///opt/cognia/cli/dist/chunks/external-host.mjs",
        "cognia-external-agent-launcher"
      )
    ).toEqual([
      "/opt/cognia/cli/dist/chunks/cognia-external-agent-launcher",
      "/opt/cognia/cli/dist/cognia-external-agent-launcher",
    ])
  })

  it("passes the workspace, readable home, network gate, and target argv", () => {
    expect(
      buildSandboxLauncherArgs(
        { id: "a", command: "codex", args: ["app-server"], cwd: "/work/repo" },
        "/home/user"
      )
    ).toEqual([
      "--cwd",
      "/work/repo",
      "--writable",
      "/work/repo",
      "--writable",
      "/home/user/.codex",
      "--writable",
      toolHostRuntimeDir(),
      "--readable",
      "/home/user",
      "--network",
      "--",
      "codex",
      "app-server",
    ])
  })

  it("binds the dedicated tool-host runtime directory instead of the whole temp root", () => {
    const args = buildSandboxLauncherArgs(
      { id: "a", command: "codex", cwd: "/work/repo" },
      "/home/user"
    )
    const writableRoots = args
      .map((arg, index) => [arg, args[index + 1]] as const)
      .filter(([arg]) => arg === "--writable")
      .map(([, value]) => value)

    expect(writableRoots).toContain(toolHostRuntimeDir())
    expect(writableRoots).not.toContain(os.tmpdir())
  })

  it("grants only the selected agent's state directory and npx cache", () => {
    expect(
      buildSandboxLauncherArgs(
        {
          id: "a",
          command: "npx",
          args: ["-y", "@agentclientprotocol/claude-agent-acp"],
          cwd: "/work/repo",
        },
        "/home/user"
      )
    ).toEqual(
      expect.arrayContaining([
        "--writable",
        "/home/user/.claude",
        "--writable",
        "/home/user/.claude.json",
        "--writable",
        "/home/user/.claude.json.backup",
        "--writable",
        "/home/user/.npm",
      ])
    )
    expect(
      buildSandboxLauncherArgs({ id: "a", command: "opencode", cwd: "/work/repo" }, "/home/user")
    ).not.toContain("/home/user/.codex")
  })

  it.each([
    ["npx", ["-y", "@google/gemini-cli", "--acp"], ".gemini"],
    ["npx", ["-y", "@qwen-code/qwen-code", "--acp"], ".qwen"],
    ["npx", ["-y", "pi-acp"], ".pi"],
    // Native Pi spawns the `pi` binary directly, not through the npx bridge,
    // so it needs its own arm of `agentStateWritableRoots` — without it Pi
    // cannot read its own credentials or write its session files.
    ["pi", ["--mode", "rpc"], ".pi"],
    ["copilot", ["--acp"], ".copilot"],
    ["kiro-cli", ["acp"], ".kiro"],
    ["droid", ["exec", "--output-format", "acp"], ".factory"],
    ["cursor-agent", ["acp"], ".cursor"],
  ])("grants %s its writable state root", (command, args, stateDir) => {
    expect(
      buildSandboxLauncherArgs({ id: "agent", command, args, cwd: "/work/repo" }, "/home/user")
    ).toEqual(expect.arrayContaining(["--writable", `/home/user/${stateDir}`]))
  })

  it("only creates writable state directories, never file-shaped roots", async () => {
    const ensureDir = jest.fn()
    const ensureFile = jest.fn()
    await resolveSandboxedExternalAgentLaunch(
      {
        id: "a",
        command: "npx",
        args: ["-y", "@agentclientprotocol/claude-agent-acp"],
        cwd: "/work/repo",
      },
      {
        platform: "darwin",
        homedir: "/home/user",
        candidates: ["/launcher"],
        isExecutable: () => true,
        ensureDir,
        ensureFile,
      }
    )
    expect(ensureDir).toHaveBeenCalledWith("/home/user/.claude")
    expect(ensureDir).toHaveBeenCalledWith("/home/user/.npm")
    expect(ensureDir).not.toHaveBeenCalledWith(expect.stringMatching(/\.json/))
    expect(ensureFile).toHaveBeenCalledWith("/home/user/.claude.json")
    expect(ensureFile).toHaveBeenCalledWith("/home/user/.claude.json.backup")
  })

  it("resolves only an executable launcher and never falls back unsandboxed", async () => {
    const launcher = path.join(path.sep, "opt", "cognia-external-agent-launcher")
    await expect(
      resolveSandboxedExternalAgentLaunch(
        { id: "a", command: "codex", args: ["app-server"], cwd: "/work/repo" },
        {
          platform: "darwin",
          homedir: "/home/user",
          candidates: [launcher],
          isExecutable: (candidate) => candidate === launcher,
        }
      )
    ).resolves.toEqual({
      command: launcher,
      args: expect.arrayContaining(["--", "codex", "app-server"]),
    })

    await expect(
      resolveSandboxedExternalAgentLaunch(
        { id: "a", command: "codex", cwd: "/work/repo" },
        {
          platform: "linux",
          homedir: "/home/user",
          candidates: [],
          isExecutable: () => false,
        }
      )
    ).rejects.toThrow(/sandbox launcher is unavailable/)
  })

  it("fails closed on unsupported platforms", async () => {
    await expect(
      resolveSandboxedExternalAgentLaunch(
        { id: "a", command: "codex", cwd: "C:\\work" },
        {
          platform: "win32",
          homedir: "C:\\Users\\u",
          candidates: ["launcher.exe"],
          isExecutable: () => true,
        }
      )
    ).rejects.toThrow(/not available on win32/)
  })

  /**
   * ADR-0119 considered and rejected an unsandboxed escape hatch for Pi (a
   * desktop one-time confirmation, a CLI flag, a headless env var). This pins
   * the rejection: Pi gets no exemption from ADR-0077's "never falls back to
   * an unsandboxed process", on any platform, with or without a launcher.
   *
   * A future bypass would most plausibly be added as a per-command special
   * case, which is exactly what these two assertions would catch.
   */
  it("gives native Pi no sandbox exemption", async () => {
    const piConfig = { id: "pi", command: "pi", args: ["--mode", "rpc"], cwd: "/work/repo" }

    await expect(
      resolveSandboxedExternalAgentLaunch(piConfig, {
        platform: "linux",
        homedir: "/home/user",
        candidates: [],
        isExecutable: () => false,
      })
    ).rejects.toThrow(/sandbox launcher is unavailable/)

    await expect(
      resolveSandboxedExternalAgentLaunch(
        { ...piConfig, cwd: "C:\\work" },
        {
          platform: "win32",
          homedir: "C:\\Users\\u",
          candidates: ["launcher.exe"],
          isExecutable: () => true,
        }
      )
    ).rejects.toThrow(/not available on win32/)
  })
})

describe("sandbox readiness reporting", () => {
  it("reports the first executable candidate, or nothing", () => {
    expect(
      findSandboxLauncher({
        candidates: ["/a", "/b"],
        isExecutable: (candidate) => candidate === "/b",
      })
    ).toBe("/b")
    expect(findSandboxLauncher({ candidates: ["/a"], isExecutable: () => false })).toBeUndefined()
  })

  it.each([
    ["darwin", true],
    ["linux", true],
    ["win32", false],
  ] as const)("gates hosting on %s", (platform, supported) => {
    expect(sandboxSupportsPlatform(platform)).toBe(supported)
  })

  it("keeps the maintainer build command out of an installed CLI's error", () => {
    const installed = sandboxLauncherUnavailableMessage("codex", false)
    expect(installed).toContain("sandbox launcher is unavailable")
    expect(installed).toContain("COGNIA_EXTERNAL_AGENT_LAUNCHER")
    expect(installed).not.toContain("pnpm")

    expect(sandboxLauncherUnavailableMessage("codex", true)).toContain(
      "pnpm cli:external-host:build"
    )
  })

  it("detects a repo checkout by the presence of cli/package.json", () => {
    const existsSync = jest.spyOn(fs, "existsSync")
    try {
      existsSync.mockReturnValue(true)
      expect(isDevCheckout()).toBe(true)
      existsSync.mockReturnValue(false)
      expect(isDevCheckout()).toBe(false)
      existsSync.mockImplementation(() => {
        throw new Error("EACCES")
      })
      expect(isDevCheckout()).toBe(false)
    } finally {
      existsSync.mockRestore()
    }
  })

  it("spells the launcher per platform", () => {
    expect(launcherName("darwin")).toBe("cognia-external-agent-launcher")
    expect(launcherName("win32")).toBe("cognia-external-agent-launcher.exe")
  })

  it("refuses to build args without a workspace to sandbox", () => {
    expect(() => buildSandboxLauncherArgs({ id: "a", command: "codex" }, "/home/user")).toThrow(
      /requires a working directory/
    )
  })

  it("tolerates an npx invocation with no arguments", () => {
    expect(
      buildSandboxLauncherArgs({ id: "a", command: "npx", cwd: "/work" }, "/home/user")
    ).toEqual(expect.arrayContaining(["--writable", "/home/user/.npm"]))
  })

  it("creates real state roots through the host runtime's fs shims", () => {
    const runtime = defaultSandboxRuntime()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-sandbox-"))
    try {
      const dir = path.join(root, "state")
      const file = path.join(root, "state.json")
      runtime.ensureDir?.(dir)
      runtime.ensureFile?.(file)
      expect(fs.statSync(dir).isDirectory()).toBe(true)
      expect(fs.statSync(file).isFile()).toBe(true)
      expect(runtime.candidates.length).toBeGreaterThan(0)
      expect(runtime.isExecutable(path.join(root, "nope"))).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("names the agent it could not launch", async () => {
    await expect(
      resolveSandboxedExternalAgentLaunch(
        { id: "a", command: "codex", cwd: "/work/repo" },
        {
          platform: "linux",
          homedir: "/home/user",
          candidates: [],
          isExecutable: () => false,
          isDevCheckout: () => false,
        }
      )
    ).rejects.toThrow(/Can't launch "codex"/)
  })
})
