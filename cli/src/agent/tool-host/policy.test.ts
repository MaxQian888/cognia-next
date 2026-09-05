/**
 * @jest-environment node
 */
import path from "node:path"

import type { SendOptions } from "@cognia/agent-config-types"
import { namespaced } from "@/lib/settings/builtin-tools"

import {
  READ_ONLY_BUILTIN_TOOLS,
  checkConfinement,
  confinementRoots,
  extractPathArguments,
  isInsideRoots,
  isSecretPath,
  namespacedHostTool,
  needsApproval,
  visibleBuiltinTools,
  visibleHostTools,
} from "./policy"
import type { ResolvedCliSessionContext } from "../session-context"

const options = (o: Partial<SendOptions> = {}): SendOptions =>
  ({
    builtinTools: { git: true, coreFiles: true },
    ...o,
  }) as SendOptions

describe("visibleBuiltinTools", () => {
  it("withholds native and relay tools for a sealed empty surface", () => {
    const sealed = options({ toolSurface: "none", pluginTools: [{ name: "ask_user" }] } as never)
    expect(visibleBuiltinTools(sealed)).toEqual([])
    expect(visibleHostTools(sealed)).toEqual([])
  })
  it("exposes only the enabled categories", () => {
    const gitOnly = visibleBuiltinTools(options({ builtinTools: { git: true } } as never))
    expect(gitOnly).toContain("git_status")
    expect(gitOnly).not.toContain("read")
  })

  it("returns nothing when every category is off", () => {
    expect(visibleBuiltinTools(options({ builtinTools: {} } as never))).toEqual([])
  })

  it("drops disallowed tools in both the bare and namespaced form", () => {
    const bare = visibleBuiltinTools(options({ disallowedTools: ["git_status"] }))
    expect(bare).not.toContain("git_status")
    const full = visibleBuiltinTools(options({ disallowedTools: [namespaced("git_status")] }))
    expect(full).not.toContain("git_status")
  })

  it("treats a non-empty allowlist as exhaustive", () => {
    const out = visibleBuiltinTools(options({ allowedTools: [namespaced("git_status")] }))
    expect(out).toEqual(["git_status"])
  })

  it("hides every mutating tool in plan mode but keeps the read-only surface", () => {
    const out = visibleBuiltinTools(options({ permissionMode: "plan" }))
    expect(out.length).toBeGreaterThan(0)
    for (const name of out) expect(READ_ONLY_BUILTIN_TOOLS.has(name)).toBe(true)
    expect(out).not.toContain("write")
    expect(out).not.toContain("bash")
  })
})

describe("visibleHostTools", () => {
  const withPlugins = (extra: Partial<SendOptions> = {}) =>
    options({
      pluginTools: [
        { name: "ask_user", description: "", jsonSchema: {}, pluginId: "core" },
        { name: "dispatch_agent", description: "", jsonSchema: {}, pluginId: "core" },
        { name: "load_skill_resource", description: "", jsonSchema: {}, pluginId: "core" },
        { name: "web_search", description: "", jsonSchema: {}, pluginId: "web" },
      ],
      ...extra,
    })

  it("advertises the resolved manifest", () => {
    expect(visibleHostTools(withPlugins())).toEqual([
      "ask_user",
      "dispatch_agent",
      "load_skill_resource",
      "web_search",
    ])
  })

  it("keeps the explore→plan tools callable in plan mode and drops the rest", () => {
    expect(visibleHostTools(withPlugins({ permissionMode: "plan" }))).toEqual([
      "ask_user",
      "dispatch_agent",
      "load_skill_resource",
    ])
  })

  it("honours the disabled overlay by namespaced name", () => {
    const out = visibleHostTools(
      withPlugins({ disallowedTools: [namespacedHostTool("web_search")] })
    )
    expect(out).not.toContain("web_search")
  })

  it("is empty when the session resolved no plugin manifest", () => {
    expect(visibleHostTools(options())).toEqual([])
  })
})

describe("path confinement", () => {
  it("recognises credential paths wherever they sit", () => {
    expect(isSecretPath("/home/u/.ssh/id_rsa")).toBe(true)
    expect(isSecretPath("/home/u/project/.aws/config")).toBe(true)
    expect(isSecretPath("/home/u/project/src/index.ts")).toBe(false)
  })

  it("treats a root itself and its descendants as inside, siblings as outside", () => {
    expect(isInsideRoots(["/work"], "/work")).toBe(true)
    expect(isInsideRoots(["/work"], "/work/src/a.ts")).toBe(true)
    expect(isInsideRoots(["/work"], "/work-other/a.ts")).toBe(false)
    expect(isInsideRoots(["/work"], "/etc/passwd")).toBe(false)
  })

  it("resolves relative arguments against the session cwd", () => {
    expect(extractPathArguments({ file_path: "src/a.ts" }, "/work")).toEqual([
      path.resolve("/work/src/a.ts"),
    ])
  })

  it("reaches into batched edit entries", () => {
    expect(
      extractPathArguments({ edits: [{ file_path: "a.ts" }, { file_path: "b.ts" }] }, "/work")
    ).toEqual([path.resolve("/work/a.ts"), path.resolve("/work/b.ts")])
  })

  it("catches a traversal escape even when it starts inside the workspace", () => {
    const verdict = checkConfinement(["/work"], "/work", { path: "../../etc/passwd" })
    expect(verdict.allowed).toBe(false)
    expect(verdict.reason).toMatch(/outside the session workspace/)
  })

  it("refuses a credential path even when it IS inside the workspace", () => {
    const verdict = checkConfinement(["/work"], "/work", { path: "/work/.ssh/id_rsa" })
    expect(verdict.allowed).toBe(false)
    expect(verdict.reason).toMatch(/credential path/)
  })

  it("allows an in-workspace path", () => {
    expect(checkConfinement(["/work"], "/work", { path: "src/a.ts" }).allowed).toBe(true)
  })

  it("still refuses credentials when confinement is off (empty roots)", () => {
    expect(checkConfinement([], "/work", { path: "/home/u/.aws/credentials" }).allowed).toBe(false)
    expect(checkConfinement([], "/work", { path: "/elsewhere/a.ts" }).allowed).toBe(true)
  })

  it("unions cwd, policy roots and /add-dir roots", () => {
    const session = {
      cwd: "/work",
      additionalDirectories: ["/extra"],
      sendOptions: { confinement: { enabled: true, roots: ["/work", "/pkg"] } },
    } as unknown as ResolvedCliSessionContext
    expect(confinementRoots(session).sort()).toEqual(["/extra", "/pkg", "/work"])
  })

  it("returns no roots when the session is unconfined", () => {
    const session = {
      cwd: "/work",
      additionalDirectories: [],
      sendOptions: { confinement: { enabled: false, roots: [] } },
    } as unknown as ResolvedCliSessionContext
    expect(confinementRoots(session)).toEqual([])
  })
})

describe("needsApproval", () => {
  it("skips the prompt for a session-suppressed (read-only / always-allow) tool", () => {
    const opts = options({ suppressApprovalForTools: [namespaced("read")] })
    expect(needsApproval(opts, namespaced("read"))).toBe(false)
    expect(needsApproval(opts, namespaced("write"))).toBe(true)
  })

  it("skips every prompt in bypassPermissions", () => {
    expect(
      needsApproval(options({ permissionMode: "bypassPermissions" }), namespaced("bash"))
    ).toBe(false)
  })

  it("auto-approves the edit family in acceptEdits but not exec tools", () => {
    const opts = options({ permissionMode: "acceptEdits" })
    expect(needsApproval(opts, namespaced("write"))).toBe(false)
    expect(needsApproval(opts, namespaced("edit"))).toBe(false)
    expect(needsApproval(opts, namespaced("bash"))).toBe(true)
    expect(needsApproval(opts, namespaced("git_commit"))).toBe(true)
  })
})
