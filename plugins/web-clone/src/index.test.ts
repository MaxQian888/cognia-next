/**
 * @jest-environment jsdom
 */

import type { PluginContext } from "@cognia/plugin-sdk"
// Doubled at the SDK subpaths the plugin imports, not the host modules behind
// them. The git store double is gone entirely: the plugin reads the repo root
// through `ctx.git.getRoot()` now, so the test supplies it on the context.
jest.mock("@cognia/plugin-sdk/api/slash-command", () => ({
  registerSlashCommand: jest.fn(),
  unregisterSlashCommandsByPlugin: jest.fn(),
}))
jest.mock("@cognia/plugin-sdk/api/host-environment", () => ({
  readHostCapabilities: () => ({ tauri: true }),
}))

import {
  registerSlashCommand,
  unregisterSlashCommandsByPlugin as unregisterCommandsByPlugin,
} from "@cognia/plugin-sdk/api/slash-command"
import webClonePlugin, {
  parseWebCloneArgs,
  resolveOutput,
  buildJob,
  runWebCloneCommand,
} from "./index"

const registerMock = registerSlashCommand as jest.Mock
const unregisterMock = unregisterCommandsByPlugin as jest.Mock

beforeEach(() => jest.clearAllMocks())

describe("parseWebCloneArgs", () => {
  it("parses url + flags", () => {
    const p = parseWebCloneArgs("https://x.test/ -o out -m single --framework react --private")
    expect(p).toMatchObject({
      url: "https://x.test/",
      output: "out",
      mode: "single",
      framework: "react",
      allowPrivateHosts: true,
    })
  })
  it("defaults mode to bundle and ignores an unknown framework", () => {
    const p = parseWebCloneArgs("https://x.test/ --framework qwik")
    expect(p.mode).toBe("bundle")
    expect(p.framework).toBeUndefined()
  })
  it("treats --single as mode single and flags help", () => {
    expect(parseWebCloneArgs("https://x/ --single").mode).toBe("single")
    expect(parseWebCloneArgs("--help").help).toBe(true)
  })
})

describe("resolveOutput", () => {
  it("passes an absolute path through", () => {
    expect(resolveOutput(parseWebCloneArgs("https://x/ -o /abs/out"), "/repo", "1")).toBe(
      "/abs/out"
    )
  })
  it("joins a relative explicit output under the workspace", () => {
    expect(resolveOutput(parseWebCloneArgs("https://x/ -o site"), "/repo", "1")).toBe("/repo/site")
  })
  it("derives a default dir from the host + stamp", () => {
    const out = resolveOutput(parseWebCloneArgs("https://ex.ample.com/p"), "/repo", "42")
    expect(out).toBe("/repo/snapshots/ex.ample.com-42")
  })
  it("adds .html to a default single-file output", () => {
    const out = resolveOutput(parseWebCloneArgs("https://ex.com/ --single"), "/repo", "9")
    expect(out).toBe("/repo/snapshots/ex.com-9.html")
  })
  it("throws when there is no workspace and no absolute path", () => {
    expect(() => resolveOutput(parseWebCloneArgs("https://x/"), null, "1")).toThrow(
      /no open workspace/
    )
  })
  it("rejects a relative output that walks out of the workspace", () => {
    // Leading separators were stripped, but `..` was not — so this used to
    // resolve to /repo/../../.ssh/authorized_keys while still looking like a
    // workspace-relative path to the caller.
    expect(() =>
      resolveOutput(parseWebCloneArgs("https://x/ -o ../../.ssh/authorized_keys"), "/repo", "1")
    ).toThrow(/must stay inside the workspace/)
    expect(() =>
      resolveOutput(parseWebCloneArgs("https://x/ -o out/../../../etc/passwd"), "/repo", "1")
    ).toThrow(/must stay inside the workspace/)
  })
  it("still honours an absolute -o as the documented escape hatch", () => {
    // Absolute paths deliberately bypass the workspace (the no-workspace error
    // tells the user to pass one), so `..` inside them grants nothing new.
    expect(resolveOutput(parseWebCloneArgs("https://x/ -o /abs/out"), "/repo", "1")).toBe(
      "/abs/out"
    )
  })
  it("still allows a legitimate nested relative output", () => {
    expect(resolveOutput(parseWebCloneArgs("https://x/ -o out/site.a"), "/repo", "1")).toBe(
      "/repo/out/site.a"
    )
  })
})

describe("buildJob", () => {
  it("builds a snapshot job; a framework implies codegen + extraction", () => {
    const job = buildJob(parseWebCloneArgs("https://x/ --framework vue"), "/repo/out")
    expect(job.mode).toBe("snapshot")
    expect((job.options as Record<string, unknown>).extractComponents).toBe(true)
    expect((job.options as Record<string, unknown>).frameworkCodegen).toMatchObject({
      framework: "vue",
    })
  })
})

describe("runWebCloneCommand", () => {
  const deps = (invoke: jest.Mock, rootDir: string | null = "/repo") => ({
    invoke: invoke as never,
    rootDir: () => rootDir,
    now: () => 7,
  })

  it("returns usage when no url is given", async () => {
    const invoke = jest.fn()
    const r = await runWebCloneCommand("", deps(invoke))
    expect(r.message).toMatch(/Usage/)
    expect(invoke).not.toHaveBeenCalled()
  })

  it("invokes the command and reports success", async () => {
    const invoke = jest.fn().mockResolvedValue({
      envelope: {
        ok: true,
        result: {
          output: "/repo/snapshots/x.test-7",
          mode: "bundle",
          stats: { total: 5, fetched: 5 },
        },
      },
    })
    const r = await runWebCloneCommand("https://x.test/", deps(invoke))
    expect(invoke).toHaveBeenCalledWith(
      "web_clone_snapshot",
      expect.objectContaining({ job: expect.any(Object) })
    )
    expect(r.message).toMatch(/Snapshot written to .*5\/5 assets/)
  })

  it("surfaces a failure envelope", async () => {
    const invoke = jest.fn().mockResolvedValue({
      envelope: { ok: false, error: { name: "FetchTargetBlockedError", message: "blocked" } },
    })
    const r = await runWebCloneCommand("http://127.0.0.1/", deps(invoke))
    expect(r.message).toMatch(/web-clone failed: blocked/)
  })

  it("reports a missing-workspace error without invoking", async () => {
    const invoke = jest.fn()
    const r = await runWebCloneCommand("https://x/", deps(invoke, null))
    expect(r.message).toMatch(/no open workspace/)
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe("plugin definition", () => {
  it("declares /web-clone and handles it via the returned hook", async () => {
    const ctx = {
      pluginId: "cognia-web-clone",
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      ui: { showToast: jest.fn() },
    } as unknown as PluginContext
    const hooks = (await webClonePlugin.activate(ctx)) as unknown as {
      onCommand?: (c: string, a: string[]) => Promise<boolean>
    }
    // Declared, not imperatively registered — the manager owns registration
    // (namespacing, conflict detection, palette entry) and teardown.
    expect(registerMock).not.toHaveBeenCalled()
    const commands = (webClonePlugin.manifest as { commands?: Array<{ id: string }> }).commands
    expect(commands?.map((c) => c.id)).toEqual(["web-clone"])
    expect(await hooks?.onCommand?.("not-mine", [])).toBe(false)
    expect(webClonePlugin.deactivate).toBeUndefined()
    expect(unregisterMock).not.toHaveBeenCalled()
  })
})
