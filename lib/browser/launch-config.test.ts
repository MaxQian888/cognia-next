jest.mock("@/lib/file/file-operations", () => ({
  exists: jest.fn(),
  readTextFile: jest.fn(),
}))
jest.mock("./local-content-client", () => ({ detectDevServers: jest.fn() }))

import {
  buildLaunchCommand,
  isPortListening,
  launchPort,
  launchTargetUrl,
  loadLaunchConfigs,
  parseLaunchConfig,
  quoteShellArg,
  resolveLaunchCwd,
  startLaunchConfiguration,
  waitForPort,
  type LaunchConfiguration,
} from "./launch-config"
import type { DevServer } from "./local-content-client"

function config(overrides: Partial<LaunchConfiguration> = {}): LaunchConfiguration {
  return {
    name: "web",
    runtimeExecutable: "pnpm",
    runtimeArgs: ["dev"],
    port: 3000,
    url: null,
    cwd: null,
    env: {},
    ...overrides,
  }
}

function server(port: number): DevServer {
  return { url: `http://localhost:${port}/`, port, pid: null, process: null, title: null }
}

describe("parseLaunchConfig", () => {
  it("reads Claude Code's launch.json shape, with comments and trailing commas", () => {
    const parsed = parseLaunchConfig(`{
      // dev servers
      "version": "0.0.1",
      "configurations": [
        { "name": "web", "runtimeExecutable": "npm", "runtimeArgs": ["run", "dev"], "port": 3000, },
      ],
    }`)
    expect(parsed).toEqual({
      configurations: [
        {
          name: "web",
          runtimeExecutable: "npm",
          runtimeArgs: ["run", "dev"],
          port: 3000,
          url: null,
          cwd: null,
          env: {},
        },
      ],
      invalid: 0,
    })
  })

  it("keeps url, cwd and stringified env; counts malformed entries", () => {
    const parsed = parseLaunchConfig(
      JSON.stringify({
        configurations: [
          {
            name: "docs",
            runtimeExecutable: "pnpm",
            url: "http://localhost:3001/docs",
            cwd: "docs",
            env: { PORT: 3001, DEBUG: true, NESTED: { x: 1 } },
          },
          { name: "", runtimeExecutable: "x" },
          { name: "no-exe" },
          { name: "bad-args", runtimeExecutable: "x", runtimeArgs: [1] },
          "nope",
        ],
      })
    )
    expect(parsed.invalid).toBe(4)
    expect(parsed.configurations).toEqual([
      {
        name: "docs",
        runtimeExecutable: "pnpm",
        runtimeArgs: [],
        port: null,
        url: "http://localhost:3001/docs",
        cwd: "docs",
        env: { PORT: "3001", DEBUG: "true" },
      },
    ])
  })

  it("drops out-of-range ports and non-http urls", () => {
    const [entry] = parseLaunchConfig(
      JSON.stringify({
        configurations: [{ name: "a", runtimeExecutable: "x", port: 70000, url: "file:///x" }],
      })
    ).configurations
    expect(entry.port).toBeNull()
    expect(entry.url).toBeNull()
  })

  it("throws on syntax errors and on a missing configurations array", () => {
    expect(() => parseLaunchConfig("{")).toThrow(SyntaxError)
    expect(() => parseLaunchConfig(`{"version":"1"}`)).toThrow(/configurations/)
  })
})

describe("derived values", () => {
  it("resolves cwd against the root unless absolute", () => {
    expect(resolveLaunchCwd("/repo/", config())).toBe("/repo/")
    expect(resolveLaunchCwd("/repo/", config({ cwd: "./web" }))).toBe("/repo/web")
    expect(resolveLaunchCwd("/repo", config({ cwd: "/abs" }))).toBe("/abs")
    expect(resolveLaunchCwd("C:\\repo", config({ cwd: "D:\\x" }))).toBe("D:\\x")
  })

  it("derives port and target url", () => {
    expect(launchPort(config())).toBe(3000)
    expect(launchTargetUrl(config())).toBe("http://localhost:3000/")
    const withUrl = config({ port: null, url: "http://127.0.0.1:5173/app" })
    expect(launchPort(withUrl)).toBe(5173)
    expect(launchTargetUrl(withUrl)).toBe("http://127.0.0.1:5173/app")
    expect(launchPort(config({ port: null, url: "https://example.com/" }))).toBeNull()
    expect(launchTargetUrl(config({ port: null }))).toBeNull()
  })

  it("quotes args per shell family", () => {
    expect(quoteShellArg("dev", "macos")).toBe("dev")
    expect(quoteShellArg("a b", "linux")).toBe("'a b'")
    expect(quoteShellArg("it's", "macos")).toBe(`'it'\\''s'`)
    expect(quoteShellArg('say "hi"', "windows")).toBe('"say ""hi"""')
    expect(buildLaunchCommand(config({ runtimeArgs: ["run", "dev", "--host 0"] }), "macos")).toBe(
      "pnpm run dev '--host 0'"
    )
  })
})

describe("loadLaunchConfigs", () => {
  it("prefers .cognia/launch.json, then .claude/launch.json", async () => {
    const seen: string[] = []
    const file = await loadLaunchConfigs("/repo/", {
      exists: async (path) => {
        seen.push(path)
        return path.endsWith(".claude/launch.json")
      },
      readTextFile: async () => `{"configurations":[{"name":"w","runtimeExecutable":"x"}]}`,
    })
    expect(seen).toEqual(["/repo/.cognia/launch.json", "/repo/.claude/launch.json"])
    expect(file?.path).toBe("/repo/.claude/launch.json")
    expect(file?.configurations).toHaveLength(1)
  })

  it("returns null when no file exists and rejects a malformed one", async () => {
    await expect(loadLaunchConfigs("/r", { exists: async () => false })).resolves.toBeNull()
    await expect(
      loadLaunchConfigs("/r", { exists: async () => true, readTextFile: async () => "{" })
    ).rejects.toThrow(SyntaxError)
  })
})

describe("port probing", () => {
  it("treats a failing probe as not listening", async () => {
    await expect(isPortListening(3000, async () => [server(3000)])).resolves.toBe(true)
    await expect(isPortListening(3000, () => Promise.reject(new Error("x")))).resolves.toBe(false)
  })

  it("polls until the port answers, or gives up", async () => {
    const detect = jest
      .fn<Promise<DevServer[]>, []>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([server(3000)])
    await expect(waitForPort(3000, { detect, intervalMs: 1 })).resolves.toBe(true)
    expect(detect).toHaveBeenCalledTimes(2)
    await expect(waitForPort(3000, { detect: async () => [], timeoutMs: 0 })).resolves.toBe(false)
    const aborted = new AbortController()
    aborted.abort()
    await expect(waitForPort(3000, { detect, signal: aborted.signal })).resolves.toBe(false)
  })
})

describe("startLaunchConfiguration", () => {
  it("reuses a server that already answers", async () => {
    const run = jest.fn()
    const outcome = await startLaunchConfiguration({
      config: config(),
      root: "/repo",
      chatSessionId: "s",
      run,
      detect: async () => [server(3000)],
    })
    expect(outcome).toEqual({ kind: "reused", url: "http://localhost:3000/" })
    expect(run).not.toHaveBeenCalled()
  })

  it("runs the command in the configuration's cwd and waits for the port", async () => {
    const run = jest.fn().mockResolvedValue(undefined)
    const detect = jest
      .fn<Promise<DevServer[]>, []>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([server(3000)])
    const outcome = await startLaunchConfiguration({
      config: config({ cwd: "web", env: { A: "1" } }),
      root: "/repo",
      chatSessionId: "s",
      run,
      detect,
    })
    expect(run).toHaveBeenCalledWith(expect.stringMatching(/^pnpm dev$/), "/repo/web", "s", {
      env: { A: "1" },
      title: "web",
    })
    expect(outcome).toEqual({ kind: "ready", url: "http://localhost:3000/" })
  })

  it("reports started without a port and timeout when the port never opens", async () => {
    const run = jest.fn().mockResolvedValue(undefined)
    await expect(
      startLaunchConfiguration({
        config: config({ port: null }),
        root: "/r",
        chatSessionId: "s",
        run,
        detect: async () => [],
      })
    ).resolves.toEqual({ kind: "started" })
    await expect(
      startLaunchConfiguration({
        config: config(),
        root: "/r",
        chatSessionId: "s",
        run,
        detect: async () => [],
        timeoutMs: 0,
      })
    ).resolves.toEqual({ kind: "timeout", port: 3000 })
  })

  it("propagates a failed spawn", async () => {
    await expect(
      startLaunchConfiguration({
        config: config(),
        root: "/r",
        chatSessionId: "s",
        run: () => Promise.reject(new Error("denied")),
        detect: async () => [],
      })
    ).rejects.toThrow("denied")
  })
})
