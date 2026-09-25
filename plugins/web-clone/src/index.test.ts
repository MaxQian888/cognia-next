import type { PluginContext } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import webClonePlugin, {
  manifest,
  parseWebCloneArgs,
  resolveOutput,
  resolveInputPath,
  buildJob,
  runWebCloneCommand,
} from "./index"
import { englishWebCloneT, interpolateWebCloneMessage } from "./i18n"

// The snapshot engine is the host's `web_clone` tool, reached through
// `ctx.agent.invokeTool` — the plugin makes no native call of its own.
const mockInvoke = jest.fn()

beforeEach(() => {
  jest.clearAllMocks()
})

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
    expect(p.errors).toEqual([])
  })
  it("defaults mode to bundle and reports an unknown framework", () => {
    const p = parseWebCloneArgs("https://x.test/ --framework qwik")
    expect(p.mode).toBe("bundle")
    expect(p.framework).toBeUndefined()
    // Silent drops used to let a typo'd flag through; now it's a parse error.
    expect(p.errors).toEqual([{ code: "invalidValue", flag: "--framework", value: "qwik" }])
  })
  it("treats --single as mode single and flags help", () => {
    expect(parseWebCloneArgs("https://x/ --single").mode).toBe("single")
    expect(parseWebCloneArgs("--help").help).toBe(true)
  })
  it("supports the --flag=value form for long and short flags", () => {
    const p = parseWebCloneArgs("--convert=./snap -o=out --framework=svelte --max-assets=50")
    expect(p).toMatchObject({
      convertLocal: "./snap",
      output: "out",
      framework: "svelte",
      maxAssets: 50,
    })
    expect(p.errors).toEqual([])
  })
  it("does not let a value flag swallow the next flag", () => {
    // `-o --private` used to make "--private" the output path AND lose the flag.
    const p = parseWebCloneArgs("https://x/ -o --private")
    expect(p.output).toBeUndefined()
    expect(p.allowPrivateHosts).toBe(true)
    expect(p.errors).toEqual([{ code: "missingValue", flag: "-o" }])
  })
  it("reports unknown flags, extra positionals, bad numbers and bool-flag values", () => {
    expect(parseWebCloneArgs("https://x/ --bogus").errors).toEqual([
      { code: "unknownFlag", flag: "--bogus" },
    ])
    expect(parseWebCloneArgs("a b c").errors).toEqual([
      { code: "unexpectedArg", value: "b" },
      { code: "unexpectedArg", value: "c" },
    ])
    expect(parseWebCloneArgs("https://x/ --timeout abc").errors).toEqual([
      { code: "invalidValue", flag: "--timeout", value: "abc" },
    ])
    expect(parseWebCloneArgs("https://x/ --private=yes").errors).toEqual([
      { code: "invalidValue", flag: "--private", value: "yes" },
    ])
    // A prototype-chain name must not hit the number-flag table — "1" here is
    // the url positional, not a swallowed flag value.
    const proto = parseWebCloneArgs("--has-own-property 1")
    expect(proto.errors).toEqual([{ code: "unknownFlag", flag: "--has-own-property" }])
    expect(proto.url).toBe("1")
  })
  it("accepts -m bundle explicitly and reports a bad --framework-hint", () => {
    expect(parseWebCloneArgs("https://x/ -m bundle").mode).toBe("bundle")
    expect(parseWebCloneArgs("https://x/ --framework-hint qwik").errors).toEqual([
      { code: "invalidValue", flag: "--framework-hint", value: "qwik" },
    ])
    expect(parseWebCloneArgs("https://x/ -m bogus").errors).toEqual([
      { code: "invalidValue", flag: "-m", value: "bogus" },
    ])
  })
  it("treats a bare '-' as a positional, not a flag", () => {
    expect(parseWebCloneArgs("-").url).toBe("-")
  })
  it("flags url + --convert as mutually exclusive", () => {
    expect(parseWebCloneArgs("https://x/ --convert ./snap").errors).toEqual([
      { code: "convertWithUrl" },
    ])
    expect(parseWebCloneArgs("--convert ./snap").errors).toEqual([])
  })
  it("parses the tuning + codegen flags", () => {
    const p = parseWebCloneArgs(
      "https://x/ --framework-hint vue --concurrency 8 --timeout 20000 --max-file-size 1024 --pretty --extract-components --drafts --extract-shared --no-typescript"
    )
    expect(p).toMatchObject({
      frameworkHint: "vue",
      concurrency: 8,
      timeout: 20000,
      maxFileSize: 1024,
      pretty: true,
      extractComponents: true,
      codegenGenerateDrafts: true,
      codegenExtractShared: true,
      codegenTypescript: false,
    })
    expect(p.errors).toEqual([])
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
  it("derives a convert-* default dir for --convert", () => {
    const out = resolveOutput(parseWebCloneArgs("--convert ./snap"), "/repo", "9")
    expect(out).toBe("/repo/snapshots/convert-9")
  })
  it("throws when there is no workspace and no absolute path", () => {
    expect(() => resolveOutput(parseWebCloneArgs("https://x/"), null, "1")).toThrow(
      /no open project/
    )
    // Explicit relative -o hits the same refusal on its own branch.
    expect(() => resolveOutput(parseWebCloneArgs("https://x/ -o rel"), null, "1")).toThrow(
      /no open project/
    )
  })
  it("joins under a Windows-style root with its separator", () => {
    expect(resolveOutput(parseWebCloneArgs("https://x/ -o site"), "C:\\repo", "1")).toBe(
      "C:\\repo\\site"
    )
    expect(resolveOutput(parseWebCloneArgs("https://x/"), "C:\\repo", "1")).toBe(
      "C:\\repo\\snapshots\\x-1"
    )
  })
  it("rejects a relative output that walks out of the workspace", () => {
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
  it("refuses ~ rather than writing a literal ~ directory", () => {
    expect(() => resolveOutput(parseWebCloneArgs("https://x/ -o ~/snaps"), "/repo", "1")).toThrow(
      /not expanded/
    )
  })
  it("falls back to 'snapshot' when the host can't be derived from the URL", () => {
    // Unparseable → catch arm; parseable-but-hostless (file:) → `|| "snapshot"`.
    expect(resolveOutput(parseWebCloneArgs("notaurl"), "/repo", "9")).toBe(
      "/repo/snapshots/snapshot-9"
    )
    expect(resolveOutput(parseWebCloneArgs("file:///x"), "/repo", "9")).toBe(
      "/repo/snapshots/snapshot-9"
    )
  })
})

describe("resolveInputPath", () => {
  it("confines a relative --convert path under the workspace", () => {
    expect(resolveInputPath("snapshots/site", "/repo")).toBe("/repo/snapshots/site")
    expect(resolveInputPath("/abs/snap", "/repo")).toBe("/abs/snap")
    expect(() => resolveInputPath("../outside", "/repo")).toThrow(/must stay inside/)
    expect(() => resolveInputPath("snap", null)).toThrow(/no open project/)
    expect(() => resolveInputPath("~/snaps", "/repo")).toThrow(/not expanded/)
    // "."-only input normalizes to the workspace root itself.
    expect(resolveInputPath("./", "/repo")).toBe("/repo")
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
  it("maps the tuning + codegen flags into engine options", () => {
    const job = buildJob(
      parseWebCloneArgs(
        "https://x/ --framework react --framework-hint vue --drafts --extract-shared --no-typescript --max-assets 5 --concurrency 2 --timeout 9000 --max-file-size 64 --pretty"
      ),
      "/repo/out"
    )
    const options = job.options as Record<string, unknown>
    expect(options).toMatchObject({
      maxAssets: 5,
      concurrency: 2,
      timeout: 9000,
      maxFileSize: 64,
      pretty: true,
      frameworkHint: "vue",
    })
    expect(options.frameworkCodegen).toMatchObject({
      framework: "react",
      typescript: false,
      generateDrafts: true,
      extractSharedLogic: true,
    })
  })
  it("clamps out-of-range tuning values", () => {
    const job = buildJob(
      parseWebCloneArgs("https://x/ --max-assets 99999 --concurrency 0 --timeout 1"),
      "/repo/out"
    )
    expect(job.options).toMatchObject({ maxAssets: 5000, concurrency: 1, timeout: 1000 })
  })
  it("builds a convert job: url-free, extractComponents forced", () => {
    const job = buildJob(
      parseWebCloneArgs("--convert ./snap --framework vue"),
      "/repo/out",
      "/repo/snap"
    )
    expect(job.mode).toBe("convert")
    expect(job.url).toBeUndefined()
    const options = job.options as Record<string, unknown>
    expect(options.url).toBeUndefined()
    expect(options.convertLocal).toBe("/repo/snap")
    expect(options.extractComponents).toBe(true)
  })
  it("forces extractComponents on convert even without a framework", () => {
    // Extraction IS the convert job — codegen is the optional layer on top.
    const job = buildJob(parseWebCloneArgs("--convert ./snap"), "/repo/out", "/repo/snap")
    const options = job.options as Record<string, unknown>
    expect(options.extractComponents).toBe(true)
    expect(options.frameworkCodegen).toBeUndefined()
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
    expect(r.ok).toBe(true)
    expect(r.message).toMatch(/Usage/)
    expect(invoke).not.toHaveBeenCalled()
  })

  it("returns usage on --help and parse errors on bad input without invoking", async () => {
    const invoke = jest.fn()
    const help = await runWebCloneCommand("--help", deps(invoke))
    expect(help.ok).toBe(true)
    expect(help.message).toMatch(/Usage/)

    const bad = await runWebCloneCommand("https://x/ --bogus", deps(invoke))
    expect(bad.ok).toBe(false)
    expect(bad.message).toMatch(/unknown flag --bogus/)
    expect(invoke).not.toHaveBeenCalled()
  })

  it("translates every parse-error code in the failure message", async () => {
    const invoke = jest.fn()
    const cases: Array<[string, RegExp]> = [
      ["https://x/ -o", /missing a value for -o/],
      ["a b", /unexpected argument "b"/],
      ["https://x/ --framework q", /invalid value "q" for --framework/],
      ["https://x/ --convert s", /--convert re-runs codegen/],
    ]
    for (const [input, re] of cases) {
      const r = await runWebCloneCommand(input, deps(invoke))
      expect(r.ok).toBe(false)
      expect(r.message).toMatch(re)
      expect(r.message).toMatch(/Usage/)
    }
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
    expect(r.ok).toBe(true)
    expect(invoke).toHaveBeenCalledWith(
      "web_clone_snapshot",
      expect.objectContaining({ job: expect.any(Object) })
    )
    expect(r.message).toMatch(/Snapshot written to .*5\/5 assets/)
  })

  it("reports failed/skipped counts when the run was partial", async () => {
    const invoke = jest.fn().mockResolvedValue({
      envelope: {
        ok: true,
        result: {
          output: "/repo/snapshots/x-7",
          mode: "bundle",
          stats: { total: 5, fetched: 3, failed: 1, skipped: 1 },
        },
      },
    })
    const r = await runWebCloneCommand("https://x/", deps(invoke))
    expect(r.ok).toBe(true)
    expect(r.message).toMatch(/3\/5 fetched, 1 failed, 1 skipped/)
  })

  it("surfaces a failure envelope", async () => {
    const invoke = jest.fn().mockResolvedValue({
      envelope: { ok: false, error: { name: "FetchTargetBlockedError", message: "blocked" } },
    })
    const r = await runWebCloneCommand("http://127.0.0.1/", deps(invoke))
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/web-clone failed: blocked/)
  })

  it("appends the --private hint on a private-host refusal", async () => {
    const invoke = jest.fn().mockResolvedValue({
      envelope: {
        ok: false,
        error: { name: "FetchTargetBlockedError", message: "blocked", reason: "private-host" },
      },
    })
    const r = await runWebCloneCommand("http://192.168.1.1/", deps(invoke))
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/--private/)
  })

  it("reports a missing-workspace error without invoking", async () => {
    const invoke = jest.fn()
    const r = await runWebCloneCommand("https://x/", deps(invoke, null))
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/no open project/)
    expect(invoke).not.toHaveBeenCalled()
  })

  it("runs a convert job and reports the convert result", async () => {
    const invoke = jest.fn().mockResolvedValue({
      envelope: {
        ok: true,
        result: { output: "/repo/snapshots/convert-7", mode: "convert", stats: {} },
      },
    })
    const r = await runWebCloneCommand("--convert ./snap --framework react", deps(invoke))
    expect(r.ok).toBe(true)
    const job = invoke.mock.calls[0]![1] as {
      job: { mode: string; url?: string; options: { convertLocal: string } }
    }
    expect(job.job.mode).toBe("convert")
    expect(job.job.url).toBeUndefined()
    expect(job.job.options.convertLocal).toBe("/repo/snap")
    expect(r.message).toMatch(/Converted snapshot written to/)
  })

  it("reports an invoke throw as a failure — Error or bare value", async () => {
    const invoke = jest.fn().mockRejectedValue(new Error("runner missing"))
    const r = await runWebCloneCommand("https://x/", deps(invoke))
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/runner missing/)

    const invoke2 = jest.fn().mockImplementation(() => Promise.reject("boom"))
    const r2 = await runWebCloneCommand("https://x/", deps(invoke2))
    expect(r2.ok).toBe(false)
    expect(r2.message).toMatch(/web-clone failed: boom/)
  })

  it("treats ok-without-result and a missing error as 'unknown error'", async () => {
    const invoke = jest.fn().mockResolvedValue({ envelope: { ok: true } })
    const r = await runWebCloneCommand("https://x/", deps(invoke))
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/unknown error/)

    invoke.mockResolvedValue({ envelope: { ok: false } })
    const r2 = await runWebCloneCommand("https://x/", deps(invoke))
    expect(r2.ok).toBe(false)
    expect(r2.message).toMatch(/unknown error/)
  })

  it("reports result.mode 'convert' even when the envelope outlives a snapshot request", async () => {
    const invoke = jest.fn().mockResolvedValue({
      envelope: {
        ok: true,
        result: { output: "/repo/out", mode: "convert", stats: {} },
      },
    })
    const r = await runWebCloneCommand("https://x/", deps(invoke))
    expect(r.ok).toBe(true)
    expect(r.message).toMatch(/Converted snapshot written to/)
  })

  it("honours an injected translator", async () => {
    const invoke = jest.fn()
    const r = await runWebCloneCommand("--help", { ...deps(invoke), t: (k) => `T:${k}` })
    expect(r.message).toBe("T:usage")
  })
})

describe("runWebCloneCommand cancellation and progress", () => {
  const ok = {
    envelope: {
      ok: true,
      result: { output: "/repo/snapshots/x-7", mode: "bundle", stats: { total: 1, fetched: 1 } },
    },
  }

  it("does not start when the command was already cancelled", async () => {
    const invoke = jest.fn().mockResolvedValue(ok)
    const controller = new AbortController()
    controller.abort()
    const r = await runWebCloneCommand("https://x/", {
      invoke,
      rootDir: () => "/repo",
      now: () => 7,
      signal: controller.signal,
    })
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/cancelled/) })
    expect(invoke).not.toHaveBeenCalled()
  })

  it("stops waiting as soon as the signal aborts mid-run, and says a started run may finish", async () => {
    const controller = new AbortController()
    const invoke = jest.fn(() => new Promise<typeof ok>(() => undefined))
    const pending = runWebCloneCommand("https://x/", {
      invoke,
      rootDir: () => "/repo",
      now: () => 7,
      signal: controller.signal,
    })
    controller.abort()
    const r = await pending
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/cancelled/)
    expect(r.message).toMatch(/keeps running/)
  })

  it("reports progress at the start and the end of a run", async () => {
    const reportProgress = jest.fn()
    const invoke = jest.fn().mockResolvedValue(ok)
    await runWebCloneCommand("https://x.test/", {
      invoke,
      rootDir: () => "/repo",
      now: () => 7,
      reportProgress,
    })
    expect(reportProgress).toHaveBeenNthCalledWith(1, 0, "Snapshotting https://x.test/…")
    expect(reportProgress).toHaveBeenLastCalledWith(1)
  })

  it("labels convert progress separately and skips the final tick on failure", async () => {
    const reportProgress = jest.fn()
    const invoke = jest.fn().mockResolvedValue({ envelope: { ok: false, error: { message: "x" } } })
    await runWebCloneCommand("--convert ./snap", {
      invoke,
      rootDir: () => "/repo",
      now: () => 7,
      reportProgress,
    })
    expect(reportProgress).toHaveBeenCalledTimes(1)
    expect(reportProgress).toHaveBeenCalledWith(0, "Converting the saved snapshot…")
  })

  it("reports a failing root lookup instead of mistaking it for a missing project", async () => {
    const invoke = jest.fn()
    const r = await runWebCloneCommand("https://x/", {
      invoke,
      rootDir: () => {
        throw new Error("Permission denied: filesystem:read")
      },
      now: () => 7,
    })
    expect(r).toEqual({ ok: false, message: "web-clone: Permission denied: filesystem:read" })
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe("plugin definition", () => {
  type Locale = keyof typeof manifestJson.i18n.locales
  const translator =
    (locale: Locale) => (key: string, params?: Record<string, string | number | boolean>) =>
      interpolateWebCloneMessage(
        (manifestJson.i18n.locales[locale] as Record<string, string>)[key] ?? key,
        params
      )

  const makeCtx = (opts: { tauri?: boolean; root?: string | null; locale?: Locale } = {}) =>
    ({
      pluginId: "cognia-web-clone",
      logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      ui: { showToast: jest.fn() },
      capabilities: { tauri: opts.tauri ?? true, mobile: false },
      workspace: {
        getActiveRoot: jest.fn(() => (opts.root === null ? undefined : (opts.root ?? "/repo"))),
      },
      i18n: { t: jest.fn(translator(opts.locale ?? "en")) },
      agent: { invokeTool: mockInvoke },
    }) as unknown as PluginContext

  type Hooks = {
    onCommand: (
      c: string,
      a: string[],
      context?: { signal?: AbortSignal; reportProgress?: jest.Mock }
    ) => Promise<boolean | { handled: boolean; message?: string }>
  }

  it("adopts plugin.json itself as the manifest, strings included", () => {
    expect(manifest).toEqual(manifestJson)
    expect(webClonePlugin.manifest).toBe(manifest)
    const en = Object.keys(manifestJson.i18n.locales.en)
    expect(Object.keys(manifestJson.i18n.locales["zh-CN"]).sort()).toEqual([...en].sort())
    // Reads the active project root, not the Source-Control repo.
    expect(manifestJson.permissions).toContain("filesystem:read")
    expect(manifestJson.permissions).not.toContain("git:read")
    // The host's web_clone egress clamp refuses a plugin with no networkAccess,
    // and the user names the target page at runtime.
    expect(manifestJson.networkAccess.allowedDomains).toEqual(["*"])
  })

  it("declares /web-clone and declines foreign commands via the returned hook", async () => {
    const hooks = (await webClonePlugin.activate(makeCtx())) as unknown as Hooks
    // Declared, not imperatively registered — the manager owns registration
    // (namespacing, conflict detection, palette entry) and teardown.
    expect(manifestJson.commands.map((c) => c.id)).toEqual(["web-clone"])
    expect(await hooks.onCommand("not-mine", [])).toBe(false)
    expect(webClonePlugin.deactivate).toBeUndefined()
  })

  it("returns the result message through the structured contract + a success toast", async () => {
    mockInvoke.mockResolvedValue({
      ok: true,
      envelope: {
        ok: true,
        result: { output: "/repo/snapshots/x-7", mode: "bundle", stats: { total: 2, fetched: 2 } },
      },
    } as never)
    const ctx = makeCtx()
    const hooks = (await webClonePlugin.activate(ctx)) as unknown as Hooks
    const result = (await hooks.onCommand("web-clone", ["https://x/"])) as {
      handled: boolean
      message?: string
    }
    expect(result).toMatchObject({ handled: true })
    expect(result.message).toMatch(/Snapshot written to/)
    expect(ctx.ui.showToast).toHaveBeenCalledWith(result.message, "success")
  })

  it("resolves relative output under the active project root", async () => {
    mockInvoke.mockResolvedValue({
      ok: true,
      envelope: { ok: true, result: { output: "/proj/out", mode: "bundle", stats: {} } },
    } as never)
    const ctx = makeCtx({ root: "/proj" })
    const hooks = (await webClonePlugin.activate(ctx)) as unknown as Hooks
    await hooks.onCommand("web-clone", ["https://x/", "-o", "out"])
    expect(ctx.workspace.getActiveRoot).toHaveBeenCalled()
    expect(mockInvoke).toHaveBeenCalledWith(
      "web_clone",
      expect.objectContaining({
        job: expect.objectContaining({ options: expect.objectContaining({ output: "/proj/out" }) }),
      }),
      expect.any(Object)
    )
  })

  it("hands the command's signal and progress sink to the run", async () => {
    mockInvoke.mockResolvedValue({
      ok: true,
      envelope: { ok: true, result: { output: "/repo/o", mode: "bundle", stats: {} } },
    } as never)
    const hooks = (await webClonePlugin.activate(makeCtx())) as unknown as Hooks
    const reportProgress = jest.fn()
    await hooks.onCommand("web-clone", ["https://x/"], { reportProgress })
    expect(reportProgress).toHaveBeenLastCalledWith(1)

    const controller = new AbortController()
    controller.abort()
    mockInvoke.mockClear()
    const cancelled = (await hooks.onCommand("web-clone", ["https://x/"], {
      signal: controller.signal,
    })) as { message?: string }
    expect(cancelled.message).toMatch(/cancelled/)
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("surfaces failures as an error toast and a handled result message", async () => {
    mockInvoke.mockResolvedValue({
      ok: true,
      envelope: { ok: false, error: { name: "E", message: "boom" } },
    } as never)
    const ctx = makeCtx()
    const hooks = (await webClonePlugin.activate(ctx)) as unknown as Hooks
    const result = (await hooks.onCommand("web-clone", ["https://x/"])) as {
      handled: boolean
      message?: string
    }
    expect(result.handled).toBe(true)
    expect(result.message).toMatch(/web-clone failed: boom/)
    expect(ctx.ui.showToast).toHaveBeenCalledWith(result.message, "error")
  })

  it("reports a host refusal of the web_clone tool as a failure", async () => {
    mockInvoke.mockResolvedValue({
      ok: false,
      code: "blocked",
      error: "web_clone to x is outside plugin cognia-web-clone's networkAccess.allowedDomains.",
    })
    const ctx = makeCtx()
    const hooks = (await webClonePlugin.activate(ctx)) as unknown as Hooks
    const result = (await hooks.onCommand("web-clone", ["https://x/"])) as { message?: string }
    expect(result.message).toMatch(/outside plugin cognia-web-clone/)
    expect(ctx.ui.showToast).toHaveBeenCalledWith(result.message, "error")
  })

  it("refuses off the desktop (ctx.capabilities) with a handled result, not an invoke", async () => {
    const ctx = makeCtx({ tauri: false })
    const hooks = (await webClonePlugin.activate(ctx)) as unknown as Hooks
    const result = (await hooks.onCommand("web-clone", ["https://x/"])) as { message?: string }
    expect(result.message).toMatch(/desktop app/)
    expect(mockInvoke).not.toHaveBeenCalled()
    expect(ctx.ui.showToast).toHaveBeenCalledWith(expect.any(String), "error")
  })

  it("reports the missing project before invoking anything", async () => {
    const hooks = (await webClonePlugin.activate(makeCtx({ root: null }))) as unknown as Hooks
    const result = (await hooks.onCommand("web-clone", ["https://x/"])) as { message?: string }
    expect(result.message).toMatch(/no open project/)
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("translates through ctx.i18n.t in the user's locale", async () => {
    const hooks = (await webClonePlugin.activate(
      makeCtx({ tauri: false, locale: "zh-CN" })
    )) as unknown as Hooks
    const result = (await hooks.onCommand("web-clone", ["https://x/"])) as { message?: string }
    expect(result.message).toBe(manifestJson.i18n.locales["zh-CN"].desktopOnly)
  })

  it("defaults the exported helpers to the English bundle from plugin.json", () => {
    expect(englishWebCloneT("desktopOnly")).toBe(manifestJson.i18n.locales.en.desktopOnly)
  })
})
