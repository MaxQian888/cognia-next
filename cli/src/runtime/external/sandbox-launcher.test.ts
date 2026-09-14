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
  launcherSupportsBotIsolation,
  resolveSandboxedExternalAgentLaunch,
  sandboxLauncherUnavailableMessage,
  sandboxSupportsPlatform,
} from "./sandbox-launcher"
import { toolHostRuntimeDir } from "../../agent/tool-host/protocol"

describe("external-agent sandbox launcher", () => {
  it("provisions all Bot environment directories without adding writable roots", async () => {
    const ensureDir = jest.fn()
    const launch = await resolveSandboxedExternalAgentLaunch(
      {
        id: "bot-cache",
        command: "devin",
        args: ["acp"],
        cwd: "/work/repo",
        env: { COGNIA_BOT_ISOLATION: "1", COGNIA_BOT_STATE_DIR: "/work/state" },
      },
      {
        platform: "darwin",
        homedir: "/home/user",
        candidates: ["/launcher"],
        isExecutable: () => true,
        supportsBotIsolation: () => true,
        ensureDir,
      }
    )
    for (const relative of [
      "data",
      "cache",
      "state",
      "tmp",
      "cache/npm",
      "cache/pnpm-store",
      "cache/pnpm",
    ])
      expect(ensureDir).toHaveBeenCalledWith(`/work/state/${relative}`)
    const writable = launch.args.flatMap((arg, index) =>
      arg === "--writable" ? [launch.args[index + 1]] : []
    )
    expect(writable).toEqual(["/work/repo", "/work/state", toolHostRuntimeDir()])
  })

  it("requires Bot isolation and keeps ambient home out of readable and writable roots", () => {
    const args = buildSandboxLauncherArgs(
      {
        id: "bot",
        command: "devin",
        args: ["acp"],
        cwd: "/work/repo",
        env: { COGNIA_BOT_ISOLATION: "1", COGNIA_BOT_STATE_DIR: "/work/state" },
      },
      "/home/user"
    )
    expect(args).toContain("--bot-isolation")
    expect(
      args.slice(args.indexOf("--deny-readable"), args.indexOf("--deny-readable") + 2)
    ).toEqual(["--deny-readable", "/home/user"])
    const readRoots = args.filter((_, index) => args[index - 1] === "--readable")
    const writeRoots = args.filter((_, index) => args[index - 1] === "--writable")
    expect(readRoots).not.toContain("/home/user")
    expect(writeRoots).toContain("/work/state")
    expect(writeRoots).not.toContain("/home/user/.local/share/devin")
    expect(() =>
      buildSandboxLauncherArgs(
        { id: "bot", command: "devin", cwd: "/work", env: { COGNIA_BOT_ISOLATION: "1" } },
        "/home/user"
      )
    ).toThrow("owned state")
  })
  it("does not trust caller-supplied XDG paths as Devin writable capabilities", () => {
    const args = buildSandboxLauncherArgs(
      {
        id: "devin",
        command: "devin",
        args: ["acp"],
        cwd: "/work/repo",
        env: { XDG_CONFIG_HOME: "/untrusted/private", COGNIA_DEVIN_MCP_SERVERS: "[]" },
      },
      "/home/user"
    )
    expect(args).not.toContain("/untrusted/private")
    expect(args).not.toContain("COGNIA_DEVIN_MCP_SERVERS")
  })

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

  it("denies the ambient Qwen credentials while allowing its task state", () => {
    const taskHome = "/home/user/.local/share/cognia-agent-tasks/qwen-task"
    const args = buildSandboxLauncherArgs(
      {
        id: "task",
        command: "npx",
        args: ["-y", "@qwen-code/qwen-code", "--acp"],
        cwd: "/work",
        env: { COGNIA_GATEWAY_TASK_HOME: taskHome },
      },
      "/home/user"
    )
    expect(args).toEqual(
      expect.arrayContaining(["--deny-readable", "/home/user/.qwen", "--writable", taskHome])
    )
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
    // Pi spawns its own binary; the `npx -y pi-acp` bridge that used to appear
    // here was removed with its runtime. `agentStateWritableRoots` matches Pi
    // on the BASE command — without this arm Pi cannot read its own
    // credentials or write its session files.
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
  it("probes Bot support without a target and rejects old or broken launchers", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-launcher-capability-"))
    const launcher = path.join(root, "launcher")
    try {
      fs.writeFileSync(
        launcher,
        '#!/bin/sh\n[ "$#" = 1 ] && [ "$1" = --bot-isolation ] || exit 2\nprintf "%s\\n" "cognia-external-agent-launcher: missing -- target separator" >&2\nexit 1\n',
        { mode: 0o700 }
      )
      expect(launcherSupportsBotIsolation(launcher)).toBe(true)
      fs.writeFileSync(
        launcher,
        '#!/bin/sh\nprintf "%s\\n" "cognia-external-agent-launcher: unknown argument: --bot-isolation" >&2\nexit 1\n'
      )
      expect(launcherSupportsBotIsolation(launcher)).toBe(false)
      fs.writeFileSync(launcher, "#!/bin/sh\nexit 0\n")
      expect(launcherSupportsBotIsolation(launcher)).toBe(false)
      expect(launcherSupportsBotIsolation(path.join(root, "missing"))).toBe(false)
      expect(launcherSupportsBotIsolation(null as never)).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("refuses a stale selected launcher before provisioning and does not silently switch binaries", async () => {
    const supportsBotIsolation = jest.fn(() => false)
    const ensureDir = jest.fn()
    await expect(
      resolveSandboxedExternalAgentLaunch(
        {
          id: "bot",
          command: "devin",
          cwd: "/work/repo",
          env: { COGNIA_BOT_ISOLATION: "1", COGNIA_BOT_STATE_DIR: "/work/state" },
        },
        {
          platform: "darwin",
          homedir: "/home/user",
          candidates: ["/stale", "/fresh"],
          isExecutable: () => true,
          supportsBotIsolation,
          ensureDir,
        }
      )
    ).rejects.toThrow("BOT_ISOLATION_LAUNCHER_UNSUPPORTED")
    expect(supportsBotIsolation).toHaveBeenCalledTimes(1)
    expect(supportsBotIsolation).toHaveBeenCalledWith("/stale")
    expect(ensureDir).not.toHaveBeenCalled()
  })

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
