/** @jest-environment node */
import path from "node:path"

import { buildSandboxLauncherArgs, resolveSandboxedExternalAgentLaunch } from "./sandbox-launcher"

describe("external-agent sandbox launcher", () => {
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
      "--readable",
      "/home/user",
      "--network",
      "--",
      "codex",
      "app-server",
    ])
  })

  it("grants only the selected agent's state directory and npx cache", () => {
    expect(
      buildSandboxLauncherArgs(
        {
          id: "a",
          command: "npx",
          args: ["-y", "@zed-industries/claude-code-acp"],
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

  it("only creates writable state directories, never file-shaped roots", async () => {
    const ensureDir = jest.fn()
    await resolveSandboxedExternalAgentLaunch(
      {
        id: "a",
        command: "npx",
        args: ["-y", "@zed-industries/claude-code-acp"],
        cwd: "/work/repo",
      },
      {
        platform: "darwin",
        homedir: "/home/user",
        candidates: ["/launcher"],
        isExecutable: () => true,
        ensureDir,
      }
    )
    expect(ensureDir).toHaveBeenCalledWith("/home/user/.claude")
    expect(ensureDir).toHaveBeenCalledWith("/home/user/.npm")
    expect(ensureDir).not.toHaveBeenCalledWith(expect.stringMatching(/\.json/))
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
})
