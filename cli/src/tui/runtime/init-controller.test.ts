import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  agentsTemplate,
  buildRewritePrompt,
  gatherProjectContext,
  INSTRUCTION_FILENAMES,
  lockdownRewriteOptions,
  NODE_FS,
  runInit,
  scaffoldFiles,
  type InitFs,
} from "./init-controller"
import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { BuildOptionsContext } from "@/lib/claude/build-options"
import type { SendOptions } from "@cognia/agent-config-types"
import type { TuiAction } from "../state/types"

describe("agentsTemplate", () => {
  it("titles the document with the project name and includes the standard sections", () => {
    const t = agentsTemplate("my-app")
    expect(t.startsWith("# my-app")).toBe(true)
    expect(t).toContain("## Project overview")
    expect(t).toContain("## Tech stack")
    expect(t).toContain("## Commands")
    expect(t).toContain("## Notes for the agent")
  })
})

describe("scaffoldFiles", () => {
  it("returns the four split instruction/agent files", () => {
    const files = scaffoldFiles("my-app")
    expect(Object.keys(files)).toEqual([
      ".cognia/instructions/stack.md",
      ".cognia/instructions/commands.md",
      ".cognia/instructions/conventions.md",
      ".cognia/agents/example.md",
    ])
    expect(files[".cognia/agents/example.md"]).toContain("my-app")
    expect(files[".cognia/agents/example.md"]).toContain("description:")
  })
})

describe("buildRewritePrompt", () => {
  it("embeds the current body and project context, asking for markdown-only output", () => {
    const p = buildRewritePrompt({
      projectName: "app",
      current: "# old",
      scripts: ["build", "test"],
      deps: ["react"],
      dirs: ["src", "lib"],
      readme: "Hello readme",
    })
    expect(p).toContain('AGENTS.md for "app"')
    expect(p).toContain("# old")
    expect(p).toContain("Scripts: build, test")
    expect(p).toContain("Dependencies: react")
    expect(p).toContain("Top-level dirs: src, lib")
    expect(p).toContain("Hello readme")
    expect(p).toContain("Output ONLY the markdown content")
  })

  it("renders placeholders when context is empty", () => {
    const p = buildRewritePrompt({
      projectName: "app",
      current: "",
      scripts: [],
      deps: [],
      dirs: [],
      readme: "",
    })
    expect(p).toContain("(empty)")
    expect(p).toContain("Scripts: (none found)")
  })
})

// ── In-memory fs harness ──────────────────────────────────────────────────────
function harness(files: Record<string, string> = {}) {
  const actions: TuiAction[] = []
  const store = new Map<string, string>()
  const norm = (p: string) => p.replace(/\\/g, "/")
  for (const [k, v] of Object.entries(files)) store.set(norm(k), v)
  const dirs = new Set<string>()
  const fsApi: InitFs = {
    exists: (p) => store.has(norm(p)),
    read: (p) => {
      const v = store.get(norm(p))
      if (v === undefined) throw new Error(`ENOENT ${p}`)
      return v
    },
    write: (p, c) => {
      store.set(norm(p), c)
    },
    mkdir: (p) => {
      dirs.add(norm(p))
    },
    readdir: (p) => {
      const base = norm(p).replace(/\/$/, "")
      const names = new Set<string>()
      for (const key of store.keys()) {
        if (key.startsWith(`${base}/`)) {
          names.add(key.slice(base.length + 1).split("/")[0])
        }
      }
      if (names.size === 0 && !dirs.has(base)) throw new Error(`ENOENT ${p}`)
      return [...names]
    },
  }
  return { actions, store, dirs, norm, fsApi }
}

function lastNotice(actions: TuiAction[]): string | undefined {
  for (let i = actions.length - 1; i >= 0; i--) {
    const a = actions[i]
    if (a.type === "NOTICE") return a.message
  }
  return undefined
}

describe("runInit — bare (menu or create)", () => {
  it("writes AGENTS.md named after the cwd when none exists", async () => {
    const h = harness()
    await runInit({ dispatch: (a) => h.actions.push(a), cwd: "/work/my-app", fsApi: h.fsApi })
    expect(h.store.get("/work/my-app/AGENTS.md")?.startsWith("# my-app")).toBe(true)
    expect(lastNotice(h.actions)).toMatch(/Created/)
  })

  it.each(INSTRUCTION_FILENAMES)("opens the action menu when %s exists", async (existing) => {
    const h = harness({ [`/work/my-app/${existing}`]: "# x" })
    await runInit({ dispatch: (a) => h.actions.push(a), cwd: "/work/my-app", fsApi: h.fsApi })
    const open = h.actions.find((a) => a.type === "OVERLAY_OPEN")
    expect(open).toBeDefined()
    if (open?.type === "OVERLAY_OPEN" && open.overlay.kind === "select") {
      expect(open.overlay.onSelectCommand).toBe("init")
      expect(open.overlay.items.map((i) => i.id)).toEqual([
        "create",
        "rewrite",
        "preview",
        "scaffold",
      ])
    }
  })

  it("surfaces a write failure as a notice", async () => {
    const h = harness()
    h.fsApi.write = () => {
      throw new Error("read-only fs")
    }
    await runInit({ dispatch: (a) => h.actions.push(a), cwd: "/work/my-app", fsApi: h.fsApi })
    expect(lastNotice(h.actions)).toMatch(/Could not write AGENTS.md: read-only fs/)
  })
})

describe("runInit — create", () => {
  it("writes directly when no AGENTS.md exists", async () => {
    const h = harness()
    await runInit({
      action: "create",
      dispatch: (a) => h.actions.push(a),
      cwd: "/work/app",
      fsApi: h.fsApi,
    })
    expect(h.store.get("/work/app/AGENTS.md")).toBeDefined()
    expect(lastNotice(h.actions)).toMatch(/Created/)
  })

  it("stages a draft + opens confirm overlay when AGENTS.md exists", async () => {
    const h = harness({ "/work/app/AGENTS.md": "# old" })
    await runInit({
      action: "regenerate",
      dispatch: (a) => h.actions.push(a),
      cwd: "/work/app",
      fsApi: h.fsApi,
    })
    // Not yet written
    expect(h.store.get("/work/app/AGENTS.md")).toBe("# old")
    const setDraft = h.actions.find((a) => a.type === "SET_INIT_DRAFT")
    expect(setDraft).toMatchObject({ type: "SET_INIT_DRAFT" })
    const open = h.actions.find((a) => a.type === "OVERLAY_OPEN")
    expect(open?.type === "OVERLAY_OPEN" && open.overlay.kind === "confirm").toBe(true)
    if (open?.type === "OVERLAY_OPEN" && open.overlay.kind === "confirm") {
      expect(open.overlay.onConfirmCommand).toBe("init apply")
    }
  })
})

describe("runInit — rewrite", () => {
  const config = { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work/app" }

  it("notices when AGENTS.md is missing", async () => {
    const h = harness()
    await runInit({
      action: "rewrite",
      dispatch: (a) => h.actions.push(a),
      cwd: "/work/app",
      config,
      fsApi: h.fsApi,
    })
    expect(lastNotice(h.actions)).toMatch(/No AGENTS.md to rewrite/)
  })

  it("notices when no config is provided", async () => {
    const h = harness({ "/work/app/AGENTS.md": "# old" })
    await runInit({
      action: "rewrite",
      dispatch: (a) => h.actions.push(a),
      cwd: "/work/app",
      fsApi: h.fsApi,
    })
    expect(lastNotice(h.actions)).toMatch(/active model config/)
  })

  it("calls the model and stages the result for confirmation", async () => {
    const h = harness({
      "/work/app/AGENTS.md": "# old",
      "/work/app/package.json": JSON.stringify({
        scripts: { build: "x" },
        dependencies: { react: "1" },
      }),
      "/work/app/README.md": "Readme text",
    })
    const rewriteWithModel = jest.fn().mockResolvedValue("# rewritten\n\nbody")
    await runInit({
      action: "optimize",
      dispatch: (a) => h.actions.push(a),
      cwd: "/work/app",
      config,
      fsApi: h.fsApi,
      rewriteWithModel,
    })
    expect(rewriteWithModel).toHaveBeenCalledTimes(1)
    const promptArg = rewriteWithModel.mock.calls[0][0].prompt as string
    expect(promptArg).toContain("# old")
    expect(promptArg).toContain("build")
    const setDraft = h.actions.find((a) => a.type === "SET_INIT_DRAFT")
    expect(setDraft).toMatchObject({ type: "SET_INIT_DRAFT", content: "# rewritten\n\nbody" })
  })

  it("clears the draft and notices on rewrite failure", async () => {
    const h = harness({ "/work/app/AGENTS.md": "# old" })
    const rewriteWithModel = jest.fn().mockRejectedValue(new Error("model down"))
    await runInit({
      action: "rewrite",
      dispatch: (a) => h.actions.push(a),
      cwd: "/work/app",
      config,
      fsApi: h.fsApi,
      rewriteWithModel,
    })
    expect(h.actions.some((a) => a.type === "CLEAR_INIT_DRAFT")).toBe(true)
    expect(lastNotice(h.actions)).toMatch(/Rewrite failed: model down/)
  })

  it("notices on an empty rewrite", async () => {
    const h = harness({ "/work/app/AGENTS.md": "# old" })
    const rewriteWithModel = jest.fn().mockResolvedValue("   \n  ")
    await runInit({
      action: "rewrite",
      dispatch: (a) => h.actions.push(a),
      cwd: "/work/app",
      config,
      fsApi: h.fsApi,
      rewriteWithModel,
    })
    expect(lastNotice(h.actions)).toMatch(/empty rewrite/)
    expect(h.actions.some((a) => a.type === "SET_INIT_DRAFT")).toBe(false)
  })
})

describe("runInit — preview", () => {
  it("opens a document overlay with the current body", async () => {
    const h = harness({ "/work/app/AGENTS.md": "# body" })
    await runInit({
      action: "preview",
      dispatch: (a) => h.actions.push(a),
      cwd: "/work/app",
      fsApi: h.fsApi,
    })
    const open = h.actions.find((a) => a.type === "OVERLAY_OPEN")
    expect(open?.type === "OVERLAY_OPEN" && open.overlay.kind === "document").toBe(true)
    if (open?.type === "OVERLAY_OPEN" && open.overlay.kind === "document") {
      expect(open.overlay.body).toBe("# body")
    }
  })

  it("notices when there is nothing to preview", async () => {
    const h = harness()
    await runInit({
      action: "preview",
      dispatch: (a) => h.actions.push(a),
      cwd: "/work/app",
      fsApi: h.fsApi,
    })
    expect(lastNotice(h.actions)).toMatch(/No AGENTS.md to preview/)
  })
})

describe("runInit — scaffold", () => {
  it("creates missing files and skips existing ones", async () => {
    const h = harness({ "/work/app/.cognia/instructions/stack.md": "exists" })
    await runInit({
      action: "scaffold",
      dispatch: (a) => h.actions.push(a),
      cwd: "/work/app",
      fsApi: h.fsApi,
    })
    expect(h.store.get("/work/app/.cognia/instructions/commands.md")).toBeDefined()
    expect(h.store.get("/work/app/.cognia/agents/example.md")).toBeDefined()
    // stack.md untouched
    expect(h.store.get("/work/app/.cognia/instructions/stack.md")).toBe("exists")
    const notice = lastNotice(h.actions)
    expect(notice).toMatch(/Created:/)
    expect(notice).toMatch(/Skipped \(exist\):/)
  })
})

describe("runInit — apply / cancel", () => {
  it("apply writes the staged draft and clears it", async () => {
    const h = harness()
    await runInit({
      action: "apply",
      dispatch: (a) => h.actions.push(a),
      cwd: "/work/app",
      initDraft: { target: "/work/app/AGENTS.md", content: "# applied" },
      fsApi: h.fsApi,
    })
    expect(h.store.get("/work/app/AGENTS.md")).toBe("# applied")
    expect(h.actions.some((a) => a.type === "CLEAR_INIT_DRAFT")).toBe(true)
    expect(lastNotice(h.actions)).toMatch(/Updated/)
  })

  it("apply notices when no draft is staged", async () => {
    const h = harness()
    await runInit({
      action: "apply",
      dispatch: (a) => h.actions.push(a),
      cwd: "/work/app",
      fsApi: h.fsApi,
    })
    expect(lastNotice(h.actions)).toMatch(/No pending init change/)
  })

  it("apply keeps the draft when the write fails", async () => {
    const h = harness()
    h.fsApi.write = () => {
      throw new Error("disk full")
    }
    await runInit({
      action: "apply",
      dispatch: (a) => h.actions.push(a),
      cwd: "/work/app",
      initDraft: { target: "/work/app/AGENTS.md", content: "# x" },
      fsApi: h.fsApi,
    })
    expect(h.actions.some((a) => a.type === "CLEAR_INIT_DRAFT")).toBe(false)
    expect(lastNotice(h.actions)).toMatch(/disk full/)
  })

  it("cancel clears a staged draft", async () => {
    const h = harness()
    await runInit({
      action: "cancel",
      dispatch: (a) => h.actions.push(a),
      cwd: "/work/app",
      initDraft: { target: "/work/app/AGENTS.md", content: "# x" },
      fsApi: h.fsApi,
    })
    expect(h.actions.some((a) => a.type === "CLEAR_INIT_DRAFT")).toBe(true)
  })
})

describe("runInit — unknown action", () => {
  it("notices the supported verbs", async () => {
    const h = harness()
    await runInit({
      action: "frobnicate",
      dispatch: (a) => h.actions.push(a),
      cwd: "/work/app",
      fsApi: h.fsApi,
    })
    expect(lastNotice(h.actions)).toMatch(/Unknown \/init action/)
  })
})

describe("NODE_FS", () => {
  it("round-trips through the real filesystem", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "init-fs-"))
    try {
      const nested = path.join(dir, "a", "b")
      NODE_FS.mkdir(nested)
      const file = path.join(nested, "AGENTS.md")
      expect(NODE_FS.exists(file)).toBe(false)
      NODE_FS.write(file, "# hi")
      expect(NODE_FS.exists(file)).toBe(true)
      expect(NODE_FS.read(file)).toBe("# hi")
      expect(NODE_FS.readdir(nested)).toContain("AGENTS.md")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("lockdownRewriteOptions", () => {
  it("strips every tool and bypasses approvals", async () => {
    const resolve = jest.fn(
      async () => ({ allowedTools: ["write", "bash"], permissionMode: "default" }) as SendOptions
    )
    const opts = await lockdownRewriteOptions({} as BuildOptionsContext, resolve)
    expect(opts.allowedTools).toEqual([])
    expect(opts.permissionMode).toBe("bypassPermissions")
    expect(resolve).toHaveBeenCalledTimes(1)
  })
})

describe("runInit — preview read failure", () => {
  it("notices when the file can't be read despite existing", async () => {
    const h = harness({ "/work/app/AGENTS.md": "# body" })
    h.fsApi.read = () => {
      throw new Error("perm denied")
    }
    await runInit({
      action: "preview",
      dispatch: (a) => h.actions.push(a),
      cwd: "/work/app",
      fsApi: h.fsApi,
    })
    expect(lastNotice(h.actions)).toMatch(/Could not read AGENTS.md: perm denied/)
  })
})

describe("runInit — scaffold write failure", () => {
  it("reports files that failed to write", async () => {
    const h = harness()
    h.fsApi.write = () => {
      throw new Error("disk full")
    }
    await runInit({
      action: "scaffold",
      dispatch: (a) => h.actions.push(a),
      cwd: "/work/app",
      fsApi: h.fsApi,
    })
    expect(lastNotice(h.actions)).toMatch(/Failed:/)
  })
})

describe("gatherProjectContext", () => {
  it("reads scripts, deps, dirs, and readme excerpt", () => {
    const h = harness({
      "/work/app/package.json": JSON.stringify({
        scripts: { build: "x", test: "y" },
        dependencies: { react: "1" },
        devDependencies: { jest: "2" },
      }),
      "/work/app/README.md": "R".repeat(2000),
      "/work/app/src/index.ts": "x",
      "/work/app/node_modules/dep/index.js": "x",
    })
    const ctx = gatherProjectContext("/work/app", h.fsApi)
    expect(ctx.projectName).toBe("app")
    expect(ctx.scripts).toEqual(["build", "test"])
    expect(ctx.deps).toEqual(expect.arrayContaining(["react", "jest"]))
    expect(ctx.readme.length).toBe(1200)
    expect(ctx.dirs).toContain("src")
    expect(ctx.dirs).not.toContain("node_modules")
  })

  it("degrades gracefully when files are missing", () => {
    const h = harness()
    const ctx = gatherProjectContext("/work/empty", h.fsApi)
    expect(ctx.scripts).toEqual([])
    expect(ctx.deps).toEqual([])
    expect(ctx.readme).toBe("")
    expect(ctx.dirs).toEqual([])
  })
})
