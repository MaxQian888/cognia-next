/** @jest-environment node */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  buildSandboxLauncherArgs,
  codexExtraWritableRoots,
  bundledLauncherCandidates,
  defaultSandboxRuntime,
  findSandboxLauncher,
  isDevCheckout,
  launcherName,
  launcherSupportsBotIsolation,
  resolveSandboxedExternalAgentLaunch,
  sandboxLauncherUnavailableMessage,
  sandboxSupportsPlatform,
  workspaceToolchainReadableRoots,
} from "./sandbox-launcher"
import { toolHostRuntimeDir } from "../../agent/tool-host/protocol"

describe("external-agent sandbox launcher", () => {
  it("resolves symlinked toolchain roots without exposing local share", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-toolchain-"))
    try {
      const modules = path.join(home, ".nvm/versions/node/v22/lib/node_modules")
      const executable = path.join(modules, "agent/bin/agent")
      fs.mkdirSync(path.dirname(executable), { recursive: true })
      fs.writeFileSync(executable, "#!/bin/sh\n", { mode: 0o755 })
      const bin = path.join(home, ".local/bin")
      fs.mkdirSync(bin, { recursive: true })
      const link = path.join(bin, "codex")
      fs.symlinkSync(executable, link)
      const roots = workspaceToolchainReadableRoots(link, home)
      expect(roots).toContain(bin)
      expect(roots).toContain(fs.realpathSync(modules))
      expect(roots).not.toContain(path.join(home, ".local"))
      expect(roots).not.toContain(fs.realpathSync(path.join(home, ".local")))
      expect(roots).not.toContain(home)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it("mirrors native policy modes across platforms and bot isolation", async () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      for (const network of ["full", "allowlist", "off"] as const) {
        for (const bot of [false, true]) {
          for (const readableScope of ["home", "workspace"] as const) {
            const config = {
              id: "policy",
              command: "codex",
              cwd: "/work/project",
              sandboxPolicy: {
                network,
                allowedHosts: ["api.example.com", "*.example.org"],
                readableScope,
              },
              env: bot
                ? { COGNIA_BOT_ISOLATION: "1", COGNIA_BOT_STATE_DIR: "/work/state" }
                : ({} as Record<string, string>),
            }
            const promise = resolveSandboxedExternalAgentLaunch(config, {
              platform,
              homedir: "/home/dev",
              candidates: ["/launcher"],
              isExecutable: () => true,
              ensureDir: () => {},
              ensureFile: () => {},
              supportsBotIsolation: () => true,
            })
            if (platform === "win32") {
              await expect(promise).rejects.toThrow()
              continue
            }
            const { args } = await promise
            const pairs = args.slice(0, -1).map((arg, index) => [arg, args[index + 1]])
            expect(args.includes("--network")).toBe(network === "full")
            expect(pairs.filter(([arg]) => arg === "--network-allow")).toHaveLength(
              network === "allowlist" ? 2 : 0
            )
            expect(
              pairs.some(([flag, value]) => flag === "--readable" && value === "/home/dev")
            ).toBe(!bot && readableScope === "home")
            expect(args.includes("--workspace-readable")).toBe(
              !bot && readableScope === "workspace"
            )
            if (bot) expect(pairs).toContainEqual(["--deny-readable", "/home/dev"])
          }
        }
      }
    }
  })

  it("keeps git/toolchain reads and Aider credential denies with empty allowlist", () => {
    const args = buildSandboxLauncherArgs(
      {
        id: "a",
        command: "aider",
        cwd: "/work/project",
        sandboxPolicy: { network: "allowlist", readableScope: "workspace" },
      },
      "/home/dev"
    )
    const pairs = args.slice(0, -1).map((arg, index) => [arg, args[index + 1]])
    for (const root of ["/home/dev/.gitconfig", "/home/dev/.config/git", "/home/dev/.cargo/bin"])
      expect(pairs).toContainEqual(["--readable", root])
    expect(pairs).toContainEqual(["--deny-readable", "/home/dev/.aider.conf.yml"])
    expect(args).not.toContain("--network")
    expect(args).not.toContain("--network-allow")
    expect(() =>
      buildSandboxLauncherArgs(
        {
          id: "a",
          command: "codex",
          cwd: "/work",
          sandboxPolicy: { allowedHosts: ["https://example.com"] },
        },
        "/home/dev"
      )
    ).toThrow()
  })

  it("rejects foreign drive paths on the POSIX hosts supported by the wrapper", () => {
    const report = jest.spyOn(console, "warn").mockImplementation(() => {})
    try {
      expect(
        codexExtraWritableRoots({
          id: "codex",
          command: "codex",
          cwd: "/work",
          env: { COGNIA_AGENT_CODEX_WRITABLE_ROOTS: '["C:/work"]' },
        })
      ).toEqual([])
      expect(report).toHaveBeenCalledWith(
        "Ignoring Codex writable root",
        expect.objectContaining({ reason: "an absolute path on this host is required" })
      )
    } finally {
      report.mockRestore()
    }
  })

  it("treats a filesystem-root ceiling as containing safe descendant roots", () => {
    expect(
      codexExtraWritableRoots({
        id: "codex",
        command: "codex",
        cwd: "/work",
        env: {
          COGNIA_AGENT_CODEX_WRITABLE_ROOTS: '["/work/extra"]',
          COGNIA_AGENT_CODEX_WRITABLE_CEILING: '["/"]',
        },
      })
    ).toEqual(["/work/extra"])
  })

  it("refuses an extra root symlink escaping the independently canonicalized session ceiling", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-ceiling-"))
    const workspace = path.join(temp, "workspace")
    const outside = path.join(temp, "outside")
    fs.mkdirSync(path.join(workspace, "inside"), { recursive: true })
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(workspace, "escape"))
    const report = jest.spyOn(console, "warn").mockImplementation(() => {})
    try {
      expect(
        codexExtraWritableRoots({
          id: "codex",
          command: "codex",
          cwd: workspace,
          env: {
            COGNIA_AGENT_CODEX_WRITABLE_ROOTS: JSON.stringify([
              path.join(workspace, "inside"),
              path.join(workspace, "escape"),
            ]),
            COGNIA_AGENT_CODEX_WRITABLE_CEILING: JSON.stringify([workspace]),
          },
        })
      ).toEqual([fs.realpathSync(path.join(workspace, "inside"))])
      expect(report).toHaveBeenCalledWith(
        "Ignoring Codex writable root",
        expect.objectContaining({ reason: "outside the canonical session writable ceiling" })
      )
    } finally {
      report.mockRestore()
      fs.rmSync(temp, { recursive: true, force: true })
    }
  })

  it("grants only validated explicit Codex roots in the outer wrapper", () => {
    const report = jest.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const args = buildSandboxLauncherArgs(
        {
          id: "codex",
          command: "codex",
          cwd: "/work",
          env: {
            COGNIA_AGENT_CODEX_WRITABLE_ROOTS: JSON.stringify([
              "/work/extra",
              "relative",
              "/etc",
              "/",
            ]),
          },
        },
        "/home/user"
      )
      const roots = args.flatMap((arg, index) => (arg === "--writable" ? [args[index + 1]] : []))
      expect(roots).toContain("/work/extra")
      expect(roots).not.toContain("/etc")
      expect(roots).not.toContain("relative")
      expect(roots).not.toContain("/")
      expect(report).toHaveBeenCalledTimes(3)
    } finally {
      report.mockRestore()
    }
  })

  it("rejects a Kimi Bot home symlink outside its owned state before provisioning", async () => {
    const owned = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-owned-"))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-outside-"))
    const ensureDir = jest.fn()
    try {
      fs.symlinkSync(outside, path.join(owned, "escape"))
      await expect(
        resolveSandboxedExternalAgentLaunch(
          {
            id: "kimi",
            command: "kimi",
            cwd: "/work",
            env: {
              COGNIA_BOT_ISOLATION: "1",
              COGNIA_BOT_STATE_DIR: owned,
              KIMI_CODE_HOME: path.join(owned, "escape/new"),
            },
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
      ).rejects.toThrow("inside the Bot state")
      expect(ensureDir).not.toHaveBeenCalled()
      expect(fs.existsSync(path.join(outside, "new"))).toBe(false)
    } finally {
      fs.rmSync(owned, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
  it.each([
    [{}, "/home/user/.kimi-code"],
    [{ KIMI_CODE_HOME: "/isolated/kimi" }, "/isolated/kimi"],
    [{ KIMI_CODE_HOME: "state/../kimi" }, "/work/project/kimi"],
    [{ KIMI_CODE_HOME: " state " }, "/work/project/ state "],
  ])("scopes Kimi state and temp to the selected native home", async (env, root) => {
    const ensureDir = jest.fn()
    const launch = await resolveSandboxedExternalAgentLaunch(
      { id: "kimi", command: "kimi", args: ["acp"], cwd: "/work/project", env },
      {
        platform: "darwin",
        homedir: "/home/user",
        candidates: ["/launcher"],
        isExecutable: () => true,
        ensureDir,
      }
    )
    const writable = launch.args.filter((_, i) => launch.args[i - 1] === "--writable")
    expect(writable).toContain(root)
    if (root !== "/home/user/.kimi-code") expect(writable).not.toContain("/home/user/.kimi-code")
    expect(launch.env).toMatchObject({
      KIMI_CODE_HOME: root,
      KIMI_CODE_NO_AUTO_UPDATE: "1",
      KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT: "0",
      TMPDIR: `${root}/tmp`,
      TMP: `${root}/tmp`,
      TEMP: `${root}/tmp`,
    })
    expect(ensureDir).toHaveBeenCalledWith(`${root}/tmp`)
  })

  it("uses ambient Kimi home unless explicit configuration overrides it", async () => {
    const previous = process.env.KIMI_CODE_HOME
    process.env.KIMI_CODE_HOME = "/ambient/kimi"
    try {
      for (const [env, expected] of [
        [{}, "/ambient/kimi"],
        [{ KIMI_CODE_HOME: "/explicit/kimi" }, "/explicit/kimi"],
      ] as const) {
        const launch = await resolveSandboxedExternalAgentLaunch(
          { id: "kimi", command: "kimi", cwd: "/work", env },
          {
            platform: "darwin",
            homedir: "/home/user",
            candidates: ["/launcher"],
            isExecutable: () => true,
          }
        )
        expect(launch.env?.KIMI_CODE_HOME).toBe(expected)
      }
    } finally {
      if (previous === undefined) delete process.env.KIMI_CODE_HOME
      else process.env.KIMI_CODE_HOME = previous
    }
  })

  it.each(["", "   ", "/work/state/../escape", "/home/user/.kimi-code"])(
    "rejects unsafe Kimi Bot home %p",
    (selected) => {
      expect(() =>
        buildSandboxLauncherArgs(
          {
            id: "kimi",
            command: "kimi",
            cwd: "/work",
            env: {
              COGNIA_BOT_ISOLATION: "1",
              COGNIA_BOT_STATE_DIR: "/work/state",
              KIMI_CODE_HOME: selected,
            },
          },
          "/home/user"
        )
      ).toThrow(/Kimi/)
    }
  )

  it("keeps Kimi Bot state separate from host subscription credentials", async () => {
    const previous = process.env.KIMI_CODE_HOME
    delete process.env.KIMI_CODE_HOME
    try {
      const launch = await resolveSandboxedExternalAgentLaunch(
        {
          id: "kimi",
          command: "kimi",
          cwd: "/work",
          env: { COGNIA_BOT_ISOLATION: "1", COGNIA_BOT_STATE_DIR: "/work/state" },
        },
        {
          platform: "darwin",
          homedir: "/home/user",
          candidates: ["/launcher"],
          isExecutable: () => true,
          supportsBotIsolation: () => true,
        }
      )
      expect(launch.env?.KIMI_CODE_HOME).toBe("/work/state/.kimi-code")
      expect(launch.args).not.toContain("/home/user/.kimi-code")
      expect(launch.args).toEqual(expect.arrayContaining(["--deny-readable", "/home/user"]))
    } finally {
      if (previous !== undefined) process.env.KIMI_CODE_HOME = previous
    }
  })
  it.each([
    [{}, [], "/home/user/.cline"],
    [{ CLINE_DIR: "/isolated/cline" }, [], "/isolated/cline"],
    [{ CLINE_DIR: "/ignored" }, ["--config", "state"], "/work/project/state"],
    [{}, ["--config=/isolated/other"], "/isolated/other"],
  ])("scopes Cline state to its actual ACP config root", async (env, args, root) => {
    const launch = await resolveSandboxedExternalAgentLaunch(
      {
        id: "cline",
        command: "cline",
        args: args as string[],
        cwd: "/work/project",
        env: env as Record<string, string>,
      },
      {
        platform: "darwin",
        homedir: "/home/user",
        candidates: ["/launcher"],
        isExecutable: () => true,
        ensureDir: jest.fn(),
      }
    )
    const writable = launch.args.filter((_, i) => launch.args[i - 1] === "--writable")
    expect(writable).toContain(root)
    if (root !== "/home/user/.cline") expect(writable).not.toContain("/home/user/.cline")
    expect(launch.env?.CLINE_DIR).toBe(root)
    expect(launch.env?.TMPDIR).toBe(`${root}/tmp`)
  })
  it.each([
    ["--config", ""],
    ["--data-dir", "/state"],
  ])("refuses ineffective or empty Cline selectors: %s", (...args) => {
    expect(() =>
      buildSandboxLauncherArgs({ id: "cline", command: "cline", cwd: "/work", args }, "/home/user")
    ).toThrow(/Cline/)
  })

  it("refuses Cline state outside a Bot's owned root", () => {
    expect(() =>
      buildSandboxLauncherArgs(
        {
          id: "cline",
          command: "cline",
          cwd: "/work",
          env: {
            COGNIA_BOT_ISOLATION: "1",
            COGNIA_BOT_STATE_DIR: "/work/state",
            CLINE_DIR: "/work/state/../escape",
          },
        },
        "/home/user"
      )
    ).toThrow("inside the Bot state")
  })

  it.each([
    [{}, undefined, "/home/user/.qoder"],
    [{ QODER_CONFIG_DIR: "/isolated/qoder" }, undefined, "/isolated/qoder"],
    [{ QODER_CONFIG_DIR: "/ignored" }, ["--config-dir", "state"], "/work/project/state"],
    [{}, ["--config-dir=/isolated/other"], "/isolated/other"],
  ])("scopes Qoder config writes to the selected root", async (env, args, root) => {
    const ensureDir = jest.fn()
    const launch = await resolveSandboxedExternalAgentLaunch(
      {
        id: "qoder",
        command: "qoder",
        args: args as string[] | undefined,
        cwd: "/work/project",
        env: env as Record<string, string>,
      },
      {
        platform: "darwin",
        homedir: "/home/user",
        candidates: ["/launcher"],
        isExecutable: () => true,
        ensureDir,
      }
    )
    const writable = launch.args.filter((_, index) => launch.args[index - 1] === "--writable")
    expect(writable).toContain(root)
    if (root !== "/home/user/.qoder") expect(writable).not.toContain("/home/user/.qoder")
    expect(launch.env?.QODER_CONFIG_DIR).toBe(root)
    expect(launch.env?.TMPDIR).toBe(`${root}/tmp`)
    expect(ensureDir).toHaveBeenCalledWith(root)
  })

  it("refuses a Qoder config root outside isolated Bot state", async () => {
    await expect(
      resolveSandboxedExternalAgentLaunch(
        {
          id: "qoder",
          command: "qoder",
          cwd: "/work",
          env: {
            COGNIA_BOT_ISOLATION: "1",
            COGNIA_BOT_STATE_DIR: "/work/state",
            QODER_CONFIG_DIR: "/work/state/../outside",
          },
        },
        {
          platform: "darwin",
          homedir: "/home/user",
          candidates: ["/launcher"],
          isExecutable: () => true,
          supportsBotIsolation: () => true,
        }
      )
    ).rejects.toThrow("inside the Bot state")
  })

  it("exposes only Qoder program directories from the host home to an isolated Bot", () => {
    const args = buildSandboxLauncherArgs(
      {
        id: "qoder-bot",
        command: "qoder",
        cwd: "/work",
        env: { COGNIA_BOT_ISOLATION: "1", COGNIA_BOT_STATE_DIR: "/work/state" },
      },
      "/home/user"
    )
    const readable = args.filter((_, index) => args[index - 1] === "--readable")
    expect(readable).toContain("/home/user/.qoder/entry")
    expect(readable).toContain("/home/user/.qoder/bin")
    expect(readable).not.toContain("/home/user/.qoder")
    expect(args).toEqual(expect.arrayContaining(["--deny-readable", "/home/user"]))
  })

  it("rejects an empty Qoder --config-dir", () => {
    expect(() =>
      buildSandboxLauncherArgs(
        { id: "qoder", command: "qoder", cwd: "/work", args: ["--config-dir"] },
        "/home/user"
      )
    ).toThrow("must not be empty")
  })

  it("hides implicit Aider config and dotenv files in home, cwd and Git ancestors", () => {
    const args = buildSandboxLauncherArgs(
      { id: "aider-test", command: "aider", cwd: "/work/project/sub" },
      "/home/user"
    )
    const denied = args.filter((_, index) => args[index - 1] === "--deny-readable")
    for (const file of [
      "/home/user/.aider.conf.yml",
      "/work/project/sub/.env",
      "/work/project/.aider.conf.yml",
      "/work/.aider.model.settings.yml",
      "/.aider.model.metadata.json",
      "/home/user/.aider/oauth-keys.env",
    ])
      expect(denied).toContain(file)
    expect(args.slice(args.indexOf("--") + 1)).toEqual(["aider"])
    const sibling = buildSandboxLauncherArgs(
      { id: "pi", command: "pi", cwd: "/work" },
      "/home/user"
    )
    expect(sibling).not.toContain("--deny-readable")
  })
  it("keeps Goose temporary files in the gateway task home", async () => {
    const taskHome = "/work/task-home"
    const launch = await resolveSandboxedExternalAgentLaunch(
      {
        id: "goose-task",
        command: "goose",
        cwd: "/work",
        env: { COGNIA_GATEWAY_TASK_HOME: taskHome },
      },
      {
        platform: "darwin",
        homedir: "/home/user",
        candidates: ["/launcher"],
        isExecutable: () => true,
      }
    )
    expect(launch.env?.TMPDIR).toBe(`${taskHome}/.local/state/goose/tmp`)
    expect(launch.args).toEqual(expect.arrayContaining(["--writable", taskHome]))
  })

  it("gives Goose a temporary directory inside its existing writable state root", async () => {
    const ensureDir = jest.fn()
    const launch = await resolveSandboxedExternalAgentLaunch(
      {
        id: "goose",
        command: "goose",
        args: ["acp"],
        cwd: "/work",
        env: { GOOSE_PATH_ROOT: "/untrusted", TMPDIR: "/ambient/tmp" },
      },
      {
        platform: "darwin",
        homedir: "/home/user",
        candidates: ["/launcher"],
        isExecutable: () => true,
        ensureDir,
      }
    )
    expect(ensureDir).toHaveBeenCalledWith("/home/user/.local/state/goose/tmp")
    expect(launch.env).toEqual({
      TMPDIR: "/home/user/.local/state/goose/tmp",
      TMP: "/home/user/.local/state/goose/tmp",
      TEMP: "/home/user/.local/state/goose/tmp",
    })
    expect(launch.args).not.toContain("/untrusted")
    expect(launch.args).not.toContain("/ambient/tmp")
    expect(launch.args).toContain("/home/user/.local/state/goose")
  })

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

  it("denies every supported runtime's ambient login state to a gateway task", () => {
    const taskHome = "/home/user/.local/share/cognia-agent-tasks/kimi-task"
    const args = buildSandboxLauncherArgs(
      {
        id: "task",
        command: "kimi",
        args: ["acp"],
        cwd: "/work",
        env: { COGNIA_GATEWAY_TASK_HOME: taskHome },
      },
      "/home/user"
    )
    for (const relative of [
      ".kimi-code",
      ".minimax",
      ".kimi",
      ".copilot",
      ".config/goose",
      ".local/share/goose",
      ".local/state/goose",
      ".aider",
    ])
      expect(args).toEqual(expect.arrayContaining(["--deny-readable", `/home/user/${relative}`]))
    expect(args).toEqual(expect.arrayContaining(["--writable", taskHome]))
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

it.each([
  [{ MINIMAX_DATA_DIR: "", MAVIS_DATA_DIR: "" }, "/home/user/.minimax"],
  [{ MINIMAX_DATA_DIR: "/owned/minimax", MAVIS_DATA_DIR: "/ignored" }, "/owned/minimax"],
  [{ MINIMAX_DATA_DIR: "", MAVIS_DATA_DIR: "state/../minimax" }, "/work/minimax"],
])(
  "scopes MiniMax aliases and image scratch to the selected state directory",
  async (env, root) => {
    const ensureDir = jest.fn()
    const launch = await resolveSandboxedExternalAgentLaunch(
      { id: "mm", command: "mcode", args: ["acp"], cwd: "/work", env },
      {
        platform: "darwin",
        homedir: "/home/user",
        candidates: ["/launcher"],
        isExecutable: () => true,
        ensureDir,
      }
    )
    expect(launch.env).toMatchObject({
      MINIMAX_DATA_DIR: root,
      MAVIS_DATA_DIR: root,
      TMPDIR: `${root}/tmp`,
    })
    expect(launch.args).toContain(root)
    expect(ensureDir).toHaveBeenCalledWith(`${root}/tmp`)
    if (root !== "/home/user/.minimax") expect(launch.args).not.toContain("/home/user/.minimax")
  }
)

it("refuses MiniMax Bot state escape before creating a directory", async () => {
  const ensureDir = jest.fn()
  await expect(
    resolveSandboxedExternalAgentLaunch(
      {
        id: "mm",
        command: "mcode",
        args: ["acp"],
        cwd: "/work",
        env: {
          COGNIA_BOT_ISOLATION: "1",
          COGNIA_BOT_STATE_DIR: "/owned",
          MINIMAX_DATA_DIR: "/outside",
        },
      },
      {
        platform: "darwin",
        homedir: "/home/user",
        candidates: ["/launcher"],
        isExecutable: () => true,
        ensureDir,
        supportsBotIsolation: () => true,
      }
    )
  ).rejects.toThrow("inside the Bot")
  expect(ensureDir).not.toHaveBeenCalled()
})

it.each([
  [{ GROK_HOME: "/owned/grok" }, "/owned/grok"],
  [{ GROK_HOME: "state/../grok" }, "/work/grok"],
])("scopes Grok state and temporary paths and disables hosted updates", async (env, root) => {
  const ensureDir = jest.fn()
  const launch = await resolveSandboxedExternalAgentLaunch(
    {
      id: "grok",
      command: "grok",
      args: ["agent", "--no-leader", "stdio"],
      cwd: "/work",
      env: { ...env, GROK_DISABLE_AUTOUPDATER: "0", GROK_CHANGELOG_OFFLINE: "0" },
    },
    {
      platform: "darwin",
      homedir: "/home/user",
      candidates: ["/launcher"],
      isExecutable: () => true,
      ensureDir,
    }
  )
  const writable = launch.args.filter((_, index) => launch.args[index - 1] === "--writable")
  expect(writable).toContain(root)
  expect(writable).not.toContain("/home/user/.grok")
  expect(writable).not.toContain("/tmp/sessions")
  expect(launch.env).toMatchObject({
    GROK_HOME: root,
    GROK_DISABLE_AUTOUPDATER: "1",
    GROK_CHANGELOG_OFFLINE: "1",
    TMPDIR: `${root}/tmp`,
    TMP: `${root}/tmp`,
    TEMP: `${root}/tmp`,
  })
  expect(ensureDir).toHaveBeenCalledWith(`${root}/tmp`)
})

it.each(["", "   ", "/work/state/../escape", "/home/user/.grok"])(
  "rejects an invalid Grok Bot home before provisioning: %s",
  async (selected) => {
    const ensureDir = jest.fn()
    await expect(
      resolveSandboxedExternalAgentLaunch(
        {
          id: "grok",
          command: "grok",
          cwd: "/work",
          env: {
            COGNIA_BOT_ISOLATION: "1",
            COGNIA_BOT_STATE_DIR: "/work/state",
            GROK_HOME: selected,
          },
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
    ).rejects.toThrow(/Grok/)
    expect(ensureDir).not.toHaveBeenCalled()
  }
)
