import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import {
  applyClaudeAgentSdkOptions,
  buildSdkInteractionCallbacks,
  intersectTrustedWorkspaceRoots,
  isWithinRoots,
  resolvePlugins,
  sendExpectsStructuredOutput,
  validateNativeSkillPaths,
  CHECKPOINT_REQUIRED_EXTRA_ARGS,
} from "./claude-sdk-options.mjs"

const apply = (nested, ctx, base = {}) => applyClaudeAgentSdkOptions({ ...base }, nested, ctx)

function withTempWorkspace(run) {
  const root = mkdtempSync(join(tmpdir(), "cognia-sdk-workspace-"))
  try {
    return run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test("a missing block isolates native discovery, while malformed blocks throw", () => {
  assert.deepEqual(apply(undefined, {}), {
    options: { settingSources: [], skills: [] },
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
  const { warnings } = apply({ version: 1, tools: "same" }, {}, { tools: "same" })
  assert.deepEqual(warnings, [])
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
    assert.equal(plugins[0].skipMcpDiscovery, true)
    assert.equal("skipMcpDiscovery" in plugins[1], false)
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
  const requests = []
  const callbacks = buildSdkInteractionCallbacks(
    {
      elicitation: { enabled: true },
      userDialog: { enabled: true, kinds: ["confirm"] },
    },
    async (toolName, input) => {
      requests.push([toolName, input])
      return toolName === "SDK:Elicitation"
        ? { behavior: "allow", updatedInput: { content: { answer: "yes" } } }
        : { behavior: "allow", updatedInput: { result: "confirmed" } }
    }
  )

  assert.deepEqual(await callbacks.onElicitation({ title: "Question" }, {}), {
    action: "accept",
    content: { answer: "yes" },
  })
  assert.deepEqual(
    await callbacks.onUserDialog({ dialogKind: "confirm", payload: { value: 1 } }, {}),
    { behavior: "completed", result: "confirmed" }
  )
  assert.deepEqual(
    requests.map(([name]) => name),
    ["SDK:Elicitation", "SDK:Dialog:confirm"]
  )
})

test("interaction callbacks fail closed on denial or PII-bearing responses", async () => {
  const denied = buildSdkInteractionCallbacks(
    { elicitation: { enabled: true }, userDialog: { enabled: true } },
    async () => ({ behavior: "deny" })
  )
  assert.deepEqual(await denied.onElicitation({}, {}), { action: "decline" })
  assert.deepEqual(await denied.onUserDialog({ dialogKind: "x", payload: {} }, {}), {
    behavior: "cancelled",
  })

  const leaking = buildSdkInteractionCallbacks({ elicitation: { enabled: true } }, async () => ({
    behavior: "allow",
    updatedInput: { content: { email: "alice@example.com" } },
  }))
  assert.deepEqual(await leaking.onElicitation({}, {}), { action: "decline" })
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
  assert.equal(options.extraArgs["replay-user-messages"], null)
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
