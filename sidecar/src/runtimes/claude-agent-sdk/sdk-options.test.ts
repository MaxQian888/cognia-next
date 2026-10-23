import type { Options } from "@anthropic-ai/claude-agent-sdk"
import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  applyClaudeAgentSdkOptions,
  buildSdkInteractionCallbacks,
  intersectTrustedWorkspaceRoots,
  isWithinRoots,
  resolvePlugins,
  createClaudeExtensionReloader,
  resolveClaudeRuntimeExtensions,
  sendExpectsStructuredOutput,
  validateNativeSkillPaths,
  CHECKPOINT_REQUIRED_EXTRA_ARGS,
} from "./sdk-options.ts"

const apply = (
  nested: unknown,
  ctx: Parameters<typeof applyClaudeAgentSdkOptions>[2] = {},
  base: Options & Record<string, unknown> = {}
) => applyClaudeAgentSdkOptions({ ...base }, nested, ctx)

test("nested user namespaces are explicitly off even when SDK configuration is omitted", () => {
  assert.equal(apply(undefined).options.sandbox?.allowNestedUserNamespaces, false)
  assert.equal(apply({ version: 1 }).options.sandbox?.allowNestedUserNamespaces, false)
  assert.equal(
    apply({ version: 1, sandbox: { enabled: true } }).options.sandbox?.allowNestedUserNamespaces,
    false
  )
})

test("native content validation handles missing roots, file links, directory cycles, and malformed roots", () => {
  assert.throws(() => validateNativeSkillPaths("/missing-cognia-sdk-root", []), /cwd must resolve/)
  withTempWorkspace((root) => {
    const skills = join(root, ".claude", "skills")
    mkdirSync(skills, { recursive: true })
    writeFileSync(join(skills, "SKILL.md"), "description")
    symlinkSync(join(skills, "SKILL.md"), join(skills, "linked-file"))
    symlinkSync(skills, join(skills, "loop"))
    validateNativeSkillPaths(root, [root])
    rmSync(skills, { recursive: true })
    writeFileSync(skills, "not a directory")
    assert.throws(() => validateNativeSkillPaths(root, [root]), /cannot inspect local content root/)
  })
  assert.deepEqual(intersectTrustedWorkspaceRoots(undefined, undefined), [])
  assert.equal(resolvePlugins([null, { type: "remote" }], []).warnings.length, 2)
})

test("portable extension admission attests trusted model-visible files and refuses native MCP discovery", () => {
  withTempWorkspace((root) => {
    const plugin = join(root, "extension")
    mkdirSync(join(plugin, "agents"), { recursive: true })
    writeFileSync(join(plugin, "agents", "agent.md"), "Explain the repository")
    const send = { cwd: root, trustedWorkspaceRoots: [root] }
    const refs = [{ kind: "directory" as const, path: plugin }]
    assert.deepEqual(resolveClaudeRuntimeExtensions(send, refs), [
      { type: "local", path: realpathSync(plugin), skipMcpDiscovery: true },
    ])
    assert.throws(
      () => resolveClaudeRuntimeExtensions(send, [{ ...refs[0]!, discoverMcp: true }]),
      /native MCP discovery is unsupported/
    )
    writeFileSync(join(plugin, "agents", "agent.md"), "Contact private.person@example.com")
    assert.throws(() => resolveClaudeRuntimeExtensions(send, refs), /PII gate/)
    writeFileSync(join(plugin, "agents", "agent.md"), "x".repeat(1024 * 1024 + 1))
    assert.throws(() => resolveClaudeRuntimeExtensions(send, refs), /scan limits/)
    rmSync(join(plugin, "agents", "agent.md"))
    symlinkSync("/etc/passwd", join(plugin, "escape.md"))
    assert.throws(() => resolveClaudeRuntimeExtensions(send, refs), /outside a trusted workspace/)
  })
})

test("extension manifests cannot hide instructions outside the attested tree or leak descriptive content", () => {
  withTempWorkspace((root) => {
    const plugin = join(root, "extension")
    mkdirSync(join(plugin, ".claude-plugin"), { recursive: true })
    const manifest = join(plugin, ".claude-plugin", "plugin.json")
    const refs = [{ kind: "directory" as const, path: plugin }]
    const send = { cwd: root, trustedWorkspaceRoots: [root] }
    writeFileSync(
      manifest,
      JSON.stringify({
        name: "safe",
        description: "Instructions",
        author: { email: "author@example.com" },
        env: { TOKEN: "transport@example.com" },
      })
    )
    assert.doesNotThrow(() => resolveClaudeRuntimeExtensions(send, refs))
    writeFileSync(
      manifest,
      JSON.stringify({ name: "safe", description: "private.person@example.com" })
    )
    assert.throws(() => resolveClaudeRuntimeExtensions(send, refs), /PII gate/)
    writeFileSync(
      manifest,
      JSON.stringify({ name: "safe", descriptions: { env: "private.person@example.com" } })
    )
    assert.throws(() => resolveClaudeRuntimeExtensions(send, refs), /PII gate/)
    writeFileSync(manifest, JSON.stringify({ name: "safe", commands: "/etc/passwd" }))
    assert.throws(() => resolveClaudeRuntimeExtensions(send, refs), /outside a trusted workspace/)
    writeFileSync(join(plugin, "prompt.data"), "private.person@example.com")
    writeFileSync(manifest, JSON.stringify({ name: "safe", commands: "./prompt.data" }))
    assert.throws(() => resolveClaudeRuntimeExtensions(send, refs), /PII gate/)
    writeFileSync(manifest, JSON.stringify({ name: "safe" }))
    writeFileSync(join(plugin, ".mcp.json"), JSON.stringify({ note: "private.person@example.com" }))
    writeFileSync(manifest, JSON.stringify({ name: "safe", commands: "./.mcp.json" }))
    assert.throws(() => resolveClaudeRuntimeExtensions(send, refs), /PII gate/)
    writeFileSync(manifest, JSON.stringify({ name: "safe" }))
    symlinkSync(join(plugin, "prompt.data"), join(plugin, "prompt.md"))
    assert.throws(() => resolveClaudeRuntimeExtensions(send, refs), /PII gate/)
  })
})

test("Claude extension reloader preserves held and partial results without mutating portable startup state", async () => {
  const root = mkdtempSync(join(tmpdir(), "cognia-sdk-live-extension-"))
  try {
    const plugin = join(root, "extension")
    mkdirSync(plugin)
    const send = { cwd: root, trustedWorkspaceRoots: [root] }
    const requests: unknown[] = []
    let nativeResult = { plugins: [] as Array<{ path: string }>, error_count: 0, held: true }
    const reload = createClaudeExtensionReloader(
      {
        reloadPlugins: async (options) => {
          requests.push(options)
          return nativeResult as never
        },
      },
      send,
      () => []
    )
    const add = [{ kind: "directory" as const, path: plugin }]
    assert.equal((await reload({ add, preservePromptCache: true })).disposition, "held")
    assert.deepEqual(requests[0], {
      addPlugins: [{ type: "local", path: realpathSync(plugin), skipMcpDiscovery: true }],
      holdOnCacheImpact: true,
    })
    nativeResult = {
      ...nativeResult,
      plugins: [{ path: realpathSync(plugin) }],
      held: false,
      error_count: 1,
    }
    assert.equal((await reload({ add })).disposition, "partial")
    assert.deepEqual(send, { cwd: root, trustedWorkspaceRoots: [root] })
    Object.assign(send, { runtimeExtensions: add })
    nativeResult = { ...nativeResult, plugins: [], error_count: 0 }
    assert.equal((await reload({ add })).disposition, "partial")
    assert.deepEqual((await reload({ add })).added, [])
    const existing = createClaudeExtensionReloader(
      { reloadPlugins: async () => nativeResult as never },
      { ...send, runtimeExtensions: add },
      () => [{ path: realpathSync(plugin) }]
    )
    writeFileSync(join(plugin, "SKILL.md"), "private.person@example.com")
    await assert.rejects(existing(), /PII gate/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("portable reload refuses unproven SDK plugin inventory before native mutation", async () => {
  let calls = 0
  const query = {
    reloadPlugins: async () => {
      calls++
      return { plugins: [], error_count: 0 } as never
    },
  }
  await assert.rejects(createClaudeExtensionReloader(query, {})(), /inventory_unavailable/)
  await assert.rejects(
    createClaudeExtensionReloader(query, {}, () => [{ path: "/unattested" }])(),
    /inventory_unattested/
  )
  assert.equal(calls, 0)
})

test("only the pinned SDK built-in sentinel identities bypass filesystem admission", async () => {
  const builtin = {
    path: "builtin",
    name: "cc-plugin-agents-md",
    source: "cc-plugin-agents-md@builtin",
  }
  const query = { reloadPlugins: async () => ({ plugins: [builtin], error_count: 0 }) as never }
  assert.equal(
    (await createClaudeExtensionReloader(query, {}, () => [builtin])()).disposition,
    "applied"
  )
  await assert.rejects(
    createClaudeExtensionReloader(query, {}, () => [{ ...builtin, name: "unknown" }])(),
    /inventory_unattested/
  )
  const injected = {
    reloadPlugins: async () => ({ plugins: [{ path: "/unattested" }], error_count: 0 }) as never,
  }
  await assert.rejects(
    createClaudeExtensionReloader(injected, {}, () => [])(),
    /invalid_extension_reload_result/
  )
})

function withTempWorkspace(run: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "cognia-sdk-workspace-"))
  try {
    return run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test("a missing block isolates native discovery, while malformed blocks throw", () => {
  assert.deepEqual(apply(undefined, {}), {
    options: { settingSources: [], skills: [], sandbox: { allowNestedUserNamespaces: false } },
    warnings: [],
  })
  for (const nested of [null, "nope", 7]) {
    assert.throws(() => apply(nested, {}), /claudeAgentSdk must be an object/)
  }
})

test("empty native selections explicitly keep SDK filesystem discovery off", () => {
  const { options } = apply(
    { version: 1, skills: [], plugins: [] },
    {},
    { settingSources: ["user", "project", "local"] }
  )
  assert.deepEqual(options.settingSources, [])
  assert.deepEqual(options.skills, [])
})

test("an unknown version fails closed before any option is applied", () => {
  assert.throws(
    () => apply({ version: 2, title: "t", persistSession: false }, {}),
    /version must be 1/
  )
})

test("plain fields are copied onto the SDK options", () => {
  const { options, warnings } = apply(
    {
      version: 1,
      title: "my session",
      persistSession: true,
      resumeSessionAt: "entry-1",
      resumeDropsTurn: "prompt-1",
      loadTimeoutMs: 5000,
      includeHookEvents: true,
      betas: ["context-1m-2025-08-07"],
      outputFormat: { type: "json_schema", schema: { type: "object" } },
    },
    { resume: "session-1" }
  )
  assert.equal(options.title, "my session")
  assert.equal(options.persistSession, true)
  assert.equal(options.resumeSessionAt, "entry-1")
  assert.equal(options.resumeDropsTurn, "prompt-1")
  assert.equal(options.loadTimeoutMs, 5000)
  assert.equal(options.includeHookEvents, true)
  assert.deepEqual(options.betas, ["context-1m-2025-08-07"])
  assert.deepEqual(options.outputFormat, { type: "json_schema", schema: { type: "object" } })
  assert.deepEqual(warnings, [])
})

test("the nested value wins over a flat one, and says so", () => {
  // Silence here is the failure mode: a stale flat value overriding a
  // deliberate nested one looks exactly like the feature not working.
  const { options, warnings } = apply({ version: 1, tools: ["Read"] }, {}, { tools: ["Bash"] })
  assert.deepEqual(options.tools, ["Read"])
  assert.match(warnings.join("\n"), /claudeAgentSdk\.tools overrides the flat SendOptions\.tools/)
})

test("an identical flat value produces no warning", () => {
  const tools = ["Read"]
  const { warnings } = apply({ version: 1, tools }, {}, { tools })
  assert.deepEqual(warnings, [])
})

test("current SDK controls and structured thinking/prompt options reach query unchanged", () => {
  const nested = {
    version: 1,
    permissionPrompts: "none",
    perTaskStopAffordance: false,
    pluginDelivery: "initialize",
    thinking: { type: "adaptive", display: "omitted" },
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      snapshot: false,
      excludeDynamicSections: true,
    },
  }
  const { options } = apply(nested)
  for (const [key, value] of Object.entries(nested))
    if (key !== "version") assert.deepEqual(options[key], value)
  assert.throws(() => apply({ version: 1, futureField: true }), /futureField is unsupported/)
})

// ---- permissions ------------------------------------------------------------

test("skipping every permission prompt requires BOTH gates", () => {
  const nested = { version: 1, allowDangerouslySkipPermissions: true }

  for (const ctx of [
    {},
    { permissionMode: "bypassPermissions" },
    { bypassConfirmed: true },
    { permissionMode: "acceptEdits", bypassConfirmed: true },
  ]) {
    assert.throws(() => apply(nested, ctx), /allowDangerouslySkipPermissions/)
  }

  const granted = apply(nested, { permissionMode: "bypassPermissions", bypassConfirmed: true })
  assert.equal(granted.options.allowDangerouslySkipPermissions, true)
  assert.deepEqual(granted.warnings, [])
})

// ---- plugins ----------------------------------------------------------------

test("isWithinRoots accepts the root itself and rejects a sibling prefix", () => {
  assert.equal(isWithinRoots("/w/plugins/a", ["/w"]), true)
  assert.equal(isWithinRoots("/w", ["/w"]), true)
  // "/workspace2" must not count as inside "/workspace" on a string prefix.
  assert.equal(isWithinRoots("/workspace2/x", ["/workspace"]), false)
  assert.equal(isWithinRoots("/etc/passwd", ["/w"]), false)
})

test("plugin paths are absolutised and confined to the allowed roots", () => {
  // A plugin path is executable input — the SDK loads and runs what it finds
  // there — so an escape is dropped rather than handed to the SDK to resolve.
  withTempWorkspace((root) => {
    const plugin = join(root, "ok")
    mkdirSync(plugin)
    const { plugins, warnings } = resolvePlugins(
      [
        { type: "local", path: plugin },
        { type: "local", path: join(root, "..", "evil") },
        { type: "remote", path: "https://x" },
        { type: "local", path: "" },
      ],
      [root]
    )
    assert.deepEqual(
      plugins.map((p) => p.path),
      [realpathSync.native(plugin)]
    )
    assert.equal(warnings.length, 3)
    assert.match(warnings.join("\n"), /must exist inside a trusted workspace root/)
    assert.match(warnings.join("\n"), /dropped a malformed entry/)
  })
})

test("trusted roots must also be active for the send", () => {
  withTempWorkspace((root) => {
    const active = join(root, "active")
    const nested = join(root, "nested")
    mkdirSync(active)
    mkdirSync(nested)
    assert.deepEqual(intersectTrustedWorkspaceRoots([active, root, active], [active, nested]), [
      realpathSync.native(active),
    ])
    assert.deepEqual(intersectTrustedWorkspaceRoots([root], [active]), [])
  })
})

test("with no trusted roots every local plugin is dropped", () => {
  const { plugins, warnings } = resolvePlugins([{ type: "local", path: "/anywhere" }], [])
  assert.equal(plugins.length, 0)
  assert.match(warnings.join("\n"), /must exist inside a trusted workspace root/)
})

test("skipMcpDiscovery survives and defaults to absent", () => {
  withTempWorkspace((root) => {
    mkdirSync(join(root, "a"))
    mkdirSync(join(root, "b"))
    const { plugins } = resolvePlugins(
      [
        { type: "local", path: join(root, "a"), skipMcpDiscovery: true },
        { type: "local", path: join(root, "b") },
      ],
      [root]
    )
    assert.equal(plugins[0]!.skipMcpDiscovery, true)
    assert.equal("skipMcpDiscovery" in plugins[1]!, false)
  })
})

test("a block whose plugins all get dropped leaves the field unset", () => {
  withTempWorkspace((container) => {
    const workspace = join(container, "workspace")
    const outside = join(container, "outside")
    mkdirSync(workspace)
    mkdirSync(outside)
    const { options } = apply(
      { version: 1, plugins: [{ type: "local", path: outside }] },
      {
        trustedWorkspaceRoots: [realpathSync.native(workspace)],
        cwd: workspace,
        activeWorkspaceRoots: [workspace],
      }
    )
    assert.equal(options.plugins, undefined)
  })
})

test("native skills and plugins require explicit workspace trust", () => {
  assert.throws(
    () => apply({ version: 1, skills: ["review"] }, {}),
    /require an explicit trusted workspace root/
  )
  assert.throws(
    () => apply({ version: 1, plugins: [{ type: "local", path: "/w/p" }] }, {}),
    /require an explicit trusted workspace root/
  )

  withTempWorkspace((root) => {
    const plugin = join(root, "p")
    mkdirSync(plugin)
    const { options } = apply(
      {
        version: 1,
        skills: ["review"],
        plugins: [{ type: "local", path: plugin }],
      },
      {
        trustedWorkspaceRoots: [realpathSync.native(root)],
        cwd: root,
        activeWorkspaceRoots: [root],
      }
    )
    assert.deepEqual(options.skills, ["review"])
    assert.deepEqual(options.plugins, [{ type: "local", path: realpathSync.native(plugin) }])
    assert.deepEqual(options.settingSources, ["project", "local"])
  })
})

test("native skills cannot resolve from the user settings source", () => {
  withTempWorkspace((root) => {
    const { options, warnings } = apply(
      { version: 1, skills: "all" },
      {
        trustedWorkspaceRoots: [realpathSync.native(root)],
        cwd: root,
        activeWorkspaceRoots: [root],
      },
      { settingSources: ["user", "project"] }
    )
    assert.deepEqual(options.settingSources, ["project"])
    assert.match(warnings.join("\n"), /removed user settingSources/)
  })
})

test("native content requires and validates every additional directory", () => {
  withTempWorkspace((container) => {
    const workspace = join(container, "workspace")
    const additional = join(container, "additional")
    const outside = join(container, "outside")
    mkdirSync(workspace)
    mkdirSync(join(additional, ".claude", "skills"), { recursive: true })
    mkdirSync(outside)
    symlinkSync(outside, join(additional, ".claude", "skills", "escaped"))

    assert.throws(
      () =>
        apply(
          { version: 1, skills: "all" },
          {
            trustedWorkspaceRoots: [realpathSync.native(workspace)],
            cwd: workspace,
            activeWorkspaceRoots: [workspace, additional],
          }
        ),
      /every active workspace root/
    )

    assert.throws(
      () =>
        apply(
          { version: 1, skills: "all" },
          {
            trustedWorkspaceRoots: [
              realpathSync.native(workspace),
              realpathSync.native(additional),
            ],
            cwd: workspace,
            activeWorkspaceRoots: [workspace, additional],
          }
        ),
      /must resolve inside a trusted workspace root/
    )
  })
})

test("plugin realpaths cannot escape a trusted root through a symlink", () => {
  const root = mkdtempSync(join(tmpdir(), "cognia-sdk-plugin-"))
  const trusted = join(root, "trusted")
  const outside = join(root, "outside")
  mkdirSync(trusted)
  mkdirSync(outside)
  symlinkSync(outside, join(trusted, "linked-plugin"))
  try {
    const { plugins, warnings } = resolvePlugins(
      [{ type: "local", path: join(trusted, "linked-plugin") }],
      [trusted]
    )
    assert.deepEqual(plugins, [])
    assert.match(warnings.join("\n"), /must exist inside a trusted workspace root/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("dangling plugin symlinks fail closed", () => {
  withTempWorkspace((root) => {
    symlinkSync(join(root, "not-created"), join(root, "dangling"))
    const { plugins, warnings } = resolvePlugins(
      [{ type: "local", path: join(root, "dangling") }],
      [root]
    )
    assert.deepEqual(plugins, [])
    assert.match(warnings.join("\n"), /must exist inside a trusted workspace root/)
  })
})

test("skill symlinks may target another trusted root but not an untrusted root", () => {
  withTempWorkspace((container) => {
    const workspace = join(container, "workspace")
    const trustedShared = join(container, "trusted-shared")
    const untrusted = join(container, "untrusted")
    const skillRoot = join(workspace, ".claude", "skills")
    mkdirSync(skillRoot, { recursive: true })
    mkdirSync(trustedShared)
    mkdirSync(untrusted)

    symlinkSync(trustedShared, join(skillRoot, "shared"))
    assert.doesNotThrow(() => validateNativeSkillPaths(workspace, [workspace, trustedShared]))

    symlinkSync(untrusted, join(skillRoot, "escaped"))
    assert.throws(
      () => validateNativeSkillPaths(workspace, [workspace, trustedShared]),
      /must resolve inside a trusted workspace root/
    )
  })
})

// ---- dialogs ----------------------------------------------------------------

test("only the serialisable half of userDialog becomes an option", () => {
  const { options } = apply({ version: 1, userDialog: { enabled: true, kinds: ["confirm"] } }, {})
  assert.deepEqual(options.supportedDialogKinds, ["confirm"])

  // Disabled, or enabled with no kinds — nothing to declare.
  assert.equal(
    apply({ version: 1, userDialog: { enabled: false, kinds: ["x"] } }, {}).options
      .supportedDialogKinds,
    undefined
  )
  assert.equal(
    apply({ version: 1, userDialog: { enabled: true } }, {}).options.supportedDialogKinds,
    undefined
  )
})

test("interaction descriptors build live callbacks on the existing approval round-trip", async () => {
  const requests: [string, Record<string, unknown>][] = []
  const callbacks = buildSdkInteractionCallbacks(
    {
      elicitation: { enabled: true },
      userDialog: { enabled: true, kinds: ["confirm"] },
    },
    async (toolName, input) => {
      requests.push([toolName, input])
      return toolName === "Runtime:Elicitation"
        ? { behavior: "allow", updatedInput: { content: { answer: "yes" } } }
        : { behavior: "allow", updatedInput: { result: "confirmed" } }
    }
  )

  assert.deepEqual(await callbacks.onElicitation!({ title: "Question" }, {}), {
    action: "accept",
    content: { answer: "yes" },
  })
  assert.deepEqual(
    await callbacks.onUserDialog!({ dialogKind: "confirm", payload: { value: 1 } }, {}),
    { behavior: "completed", result: "confirmed" }
  )
  assert.deepEqual(
    requests.map(([name]) => name),
    ["Runtime:Elicitation", "Runtime:Dialog:confirm"]
  )
})

test("interaction callbacks fail closed on denial or PII-bearing responses", async () => {
  const denied = buildSdkInteractionCallbacks(
    { elicitation: { enabled: true }, userDialog: { enabled: true } },
    async () => ({ behavior: "deny" })
  )
  assert.deepEqual(await denied.onElicitation!({}, {}), { action: "decline" })
  assert.deepEqual(await denied.onUserDialog!({ dialogKind: "x", payload: {} }, {}), {
    behavior: "cancelled",
  })

  const leaking = buildSdkInteractionCallbacks({ elicitation: { enabled: true } }, async () => ({
    behavior: "allow",
    updatedInput: { content: { email: "alice@example.com" } },
  }))
  assert.deepEqual(await leaking.onElicitation!({}, {}), { action: "decline" })
})

test("elicitation callbacks preserve explicit field order in the shared form descriptor", async () => {
  let captured: Record<string, unknown> | undefined
  const callbacks = buildSdkInteractionCallbacks(
    { elicitation: { enabled: true } },
    async (_name, input) => {
      captured = input
      return { behavior: "deny" }
    }
  )
  await callbacks.onElicitation!({
    message: "Question",
    requestedSchema: { type: "object", properties: { a: {}, b: {} } },
    property_order: ["b", "a"],
  })
  assert.deepEqual((captured?.elicitation as Record<string, unknown>).propertyOrder, ["b", "a"])
  await callbacks.onElicitation!({
    requestedSchema: { type: "object", properties: { a: {}, b: {} } },
  })
  assert.deepEqual((captured?.elicitation as Record<string, unknown>).propertyOrder, ["a", "b"])
})

test("URL elicitation refuses unsafe targets before requesting approval", async () => {
  let requests = 0
  const callbacks = buildSdkInteractionCallbacks({ elicitation: { enabled: true } }, async () => {
    requests++
    return { behavior: "allow", updatedInput: {} }
  })
  assert.deepEqual(await callbacks.onElicitation!({ mode: "url", url: "javascript:alert(1)" }), {
    action: "decline",
  })
  assert.equal(requests, 0)
  assert.deepEqual(
    await callbacks.onElicitation!({ mode: "url", url: "https://example.com/auth" }),
    { action: "accept" }
  )
  assert.equal(requests, 1)
  assert.deepEqual(
    await callbacks.onElicitation!({ requestedSchema: { properties: { bad: null } } }),
    { action: "decline" }
  )
  assert.equal(requests, 1)
  for (const schema of [
    { type: "object", properties: { password: { type: "string" } } },
    { type: "object", properties: { name: { type: "string" } }, required: "name" },
  ])
    assert.deepEqual(await callbacks.onElicitation!({ requestedSchema: schema }), {
      action: "decline",
    })
  assert.equal(requests, 1)
})

// ---- extraArgs --------------------------------------------------------------

test("unreviewed CLI flags fail closed at the sidecar boundary", () => {
  for (const flag of ["settings", "settings=/etc/x.json", "plugin-dir", "plugin-dir-no-mcp"]) {
    assert.throws(() => apply({ version: 1, extraArgs: { [flag]: null } }, {}), /is refused/)
  }
})

test("file checkpointing pulls in the flag it silently depends on", () => {
  // Without `replay-user-messages` user messages carry no uuid, and a checkpoint
  // has nothing to address — checkpointing would appear enabled and do nothing.
  const { options } = apply({ version: 1, enableFileCheckpointing: true }, {})
  assert.deepEqual(options.extraArgs, CHECKPOINT_REQUIRED_EXTRA_ARGS)
})

test("a caller-supplied replay-user-messages is replaced, with a warning", () => {
  const { options, warnings } = apply(
    { version: 1, enableFileCheckpointing: true, extraArgs: { "replay-user-messages": "no" } },
    {}
  )
  assert.equal(options.extraArgs!["replay-user-messages"], null)
  assert.match(warnings.join("\n"), /managed by the host under file checkpointing/)
})

test("checkpointing merges with, rather than replaces, existing extraArgs", () => {
  const { options } = apply(
    { version: 1, enableFileCheckpointing: true, extraArgs: { verbose: null } },
    {},
    { extraArgs: { preexisting: "1" } }
  )
  assert.deepEqual(options.extraArgs, {
    preexisting: "1",
    verbose: null,
    "replay-user-messages": null,
  })
})

test("extraArgs is left unset when nothing contributed one", () => {
  const { options } = apply({ version: 1, title: "t" }, {})
  assert.equal("extraArgs" in options, false)
})

// ---- structured-output expectation -------------------------------------------

test("sendExpectsStructuredOutput reads the SEND options, defensively", () => {
  // The canonical-event mapper needs this answer before query() runs, and a
  // false positive is expensive: it makes every ordinary turn of the session
  // settle as `structured_output_missing`.
  assert.equal(
    sendExpectsStructuredOutput({
      claudeAgentSdk: { version: 1, outputFormat: { type: "json_schema", schema: {} } },
    }),
    true
  )
  for (const sendOptions of [
    undefined,
    null,
    {},
    { claudeAgentSdk: undefined },
    { claudeAgentSdk: { version: 1 } },
    { claudeAgentSdk: { version: 1, outputFormat: null } },
    { claudeAgentSdk: { version: 1, outputFormat: "json_schema" } },
    { claudeAgentSdk: { version: 1, outputFormat: {} } },
  ]) {
    assert.equal(sendExpectsStructuredOutput(sendOptions), false, JSON.stringify(sendOptions))
  }
})
