// Overlay `SendOptions.claudeAgentSdk` onto the SDK `query()` options
// (ADR-0090 SDK-parity plan §2.1).
//
// `anthropic.mjs` builds its options from an explicit allowlist — deliberately,
// because Cognia sends protocol-only fields the SDK would reject. The cost is
// that anything not in the allowlist is invisible, which is how 29 of the SDK's
// 63 options ended up unreachable. This module is the one place the nested
// block is translated, so the allowlist grows in a single reviewable spot.
//
// Precedence is fixed and asymmetric on purpose:
//
//   nested block  >  flat SendOptions field  >  SDK default
//
// A caller that sets both wins with the nested value and gets a WARNING naming
// the field, rather than the two silently disagreeing. Silence here is the
// failure mode that matters: the flat fields predate the block, so a stale flat
// value quietly overriding a deliberate nested one would be indistinguishable
// from the feature not working.
//
// Two things this module refuses to do, and both are load-bearing:
//
//   * It never constructs a callback or a live object. `hooks`, `canUseTool`,
//     `onElicitation`, `onUserDialog`, `sessionStore`, `stderr` are built by
//     the caller; the block carries only descriptors.
//   * It never honours a host-only capability. `executable`, `settings`,
//     `pathToClaudeCodeExecutable`, `spawnClaudeCodeProcess` and friends are
//     absent from the contract type, and `extraArgs` is filtered so a raw CLI
//     flag cannot put them back.

import { resolve as resolvePath, sep as pathSep } from "node:path"
import { realpathSync, readdirSync } from "node:fs"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import {
  expectsStructuredOutput,
  validateClaudeAgentSdkOptions,
} from "@cognia/agent-config-types/claude-agent-sdk-options"

/**
 * CLI flags accepted inside `extraArgs`.
 *
 * Mirrors `ALLOWED_EXTRA_ARGS` in the contract's validator. Checked in BOTH
 * places on purpose: the renderer-side validator gives a good error message,
 * this one is the boundary that actually holds when a payload arrives from
 * somewhere else (companion, CLI, a replayed job).
 */
export const ALLOWED_EXTRA_ARGS = new Set(["verbose", "replay-user-messages"])

/**
 * File checkpointing addresses messages by uuid, and user messages only carry
 * one when the CLI is asked to replay them. Callers should not have to know
 * that, so it is added here whenever checkpointing is on.
 */
export const CHECKPOINT_REQUIRED_EXTRA_ARGS = { "replay-user-messages": null }

function canonicalExistingPath(path) {
  try {
    return realpathSync.native(path)
  } catch {
    return null
  }
}

/**
 * Whether this send asked the model for schema-shaped output.
 *
 * Read off the SEND options rather than the built SDK options because the
 * canonical-event mapper needs the answer before `query()` is called, and
 * because it must be the same answer the caller intended even if the overlay
 * later drops the field. Mirrors `expectsStructuredOutput` in
 * `@cognia/agent-config-types/claude-agent-sdk-options`.
 *
 * @param {any} sendOptions
 */
export function sendExpectsStructuredOutput(sendOptions) {
  return expectsStructuredOutput(sendOptions?.claudeAgentSdk)
}

/** True when `candidate` is inside one of `roots` (or equal to it). */
export function isWithinRoots(candidate, roots) {
  const target = resolvePath(candidate)
  return roots.some((root) => {
    const base = resolvePath(root)
    return target === base || target.startsWith(base.endsWith(pathSep) ? base : base + pathSep)
  })
}

/** Keep only explicitly trusted roots that are also active for this send. */
export function intersectTrustedWorkspaceRoots(trustedRoots, activeRoots) {
  const active = (activeRoots ?? [])
    .filter((root) => typeof root === "string" && root)
    .map(canonicalExistingPath)
    .filter(Boolean)
  return [
    ...new Set(
      (trustedRoots ?? [])
        .filter((root) => typeof root === "string" && root)
        .map(canonicalExistingPath)
        .filter(Boolean)
        .filter((root) => active.includes(root))
    ),
  ]
}

/**
 * Resolve plugin refs to absolute paths, dropping any that escape the allowed
 * roots.
 *
 * A plugin path is executable input: the SDK loads and runs what it finds
 * there. Accepting an arbitrary renderer-supplied path would make "load a
 * plugin" a general code-execution primitive, so an escape is dropped with a
 * warning rather than passed through for the SDK to resolve.
 */
export function resolvePlugins(plugins, roots) {
  const out = []
  const warnings = []
  const canonicalRoots = roots.map(canonicalExistingPath).filter(Boolean)
  for (const plugin of plugins ?? []) {
    if (plugin?.type !== "local" || typeof plugin.path !== "string" || plugin.path === "") {
      warnings.push(`claudeAgentSdk.plugins: dropped a malformed entry`)
      continue
    }
    const absolute = canonicalExistingPath(resolvePath(plugin.path))
    if (!absolute || canonicalRoots.length === 0 || !isWithinRoots(absolute, canonicalRoots)) {
      warnings.push(
        `claudeAgentSdk.plugins: dropped "${plugin.path}" — path must exist inside a trusted workspace root`
      )
      continue
    }
    out.push({
      type: "local",
      path: absolute,
      ...(plugin.skipMcpDiscovery ? { skipMcpDiscovery: true } : {}),
    })
  }
  return { plugins: out, warnings }
}

/**
 * Validate every provider-visible project skill entry by realpath.
 *
 * Symlinks are supported, including links into another trusted root. Dangling
 * links and links outside all trusted roots fail closed. Walking the whole
 * project skill tree is intentional: SDK skill names can come from SKILL.md
 * frontmatter, so directory-name filtering alone would not prove provenance.
 */
export function validateNativeSkillPaths(cwd, trustedRoots) {
  const canonicalRoots = trustedRoots.map(canonicalExistingPath).filter(Boolean)
  const canonicalCwd = canonicalExistingPath(cwd)
  if (!canonicalCwd || !isWithinRoots(canonicalCwd, canonicalRoots)) {
    throw new Error("claudeAgentSdk.skills: cwd must resolve inside a trusted workspace root")
  }

  const visitedDirectories = new Set()
  const walk = (directory, directoryEntries) => {
    const canonicalDirectory = canonicalExistingPath(directory)
    if (!canonicalDirectory || !isWithinRoots(canonicalDirectory, canonicalRoots)) {
      throw new Error(
        `claudeAgentSdk.skills: "${directory}" resolves outside every trusted workspace root`
      )
    }
    if (visitedDirectories.has(canonicalDirectory)) return
    visitedDirectories.add(canonicalDirectory)

    for (const entry of directoryEntries) {
      const candidate = resolvePath(directory, entry.name)
      const canonicalCandidate = canonicalExistingPath(candidate)
      if (!canonicalCandidate || !isWithinRoots(canonicalCandidate, canonicalRoots)) {
        throw new Error(
          `claudeAgentSdk.skills: "${candidate}" must resolve inside a trusted workspace root`
        )
      }
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        let children
        try {
          children = readdirSync(canonicalCandidate, { withFileTypes: true })
        } catch (error) {
          if (error?.code === "ENOTDIR") continue
          throw new Error(`claudeAgentSdk.skills: cannot inspect "${candidate}": ${error.message}`)
        }
        walk(canonicalCandidate, children)
      }
    }
  }
  for (const localContentRoot of [
    resolvePath(canonicalCwd, ".claude", "skills"),
    resolvePath(canonicalCwd, ".claude", "plugins"),
  ]) {
    let entries
    try {
      entries = readdirSync(localContentRoot, { withFileTypes: true })
    } catch (error) {
      if (error?.code === "ENOENT") continue
      throw new Error(
        `claudeAgentSdk.skills/plugins: cannot inspect local content root: ${error.message}`
      )
    }
    walk(localContentRoot, entries)
  }
}

/**
 * Construct the SDK's live interaction callbacks from serialisable descriptors.
 * The supplied requester is the existing renderer permission round-trip, so
 * desktop, CLI, and headless policy keep one user-interaction authority.
 */
export function buildSdkInteractionCallbacks(nested, requestApproval) {
  if (!nested || typeof nested !== "object" || typeof requestApproval !== "function") return {}
  const callbacks = {}

  if (nested.elicitation?.enabled) {
    callbacks.onElicitation = async (request, { signal } = {}) => {
      const outcome = await requestApproval(
        "SDK:Elicitation",
        { request, content: {} },
        {
          signal,
          title: request?.title,
          displayName: request?.displayName,
          description: request?.description,
        }
      )
      if (outcome?.behavior !== "allow") return { action: "decline" }
      const content = outcome.updatedInput?.content
      const result = {
        action: "accept",
        ...(content && typeof content === "object" ? { content } : {}),
      }
      return hasNoLeakingPiiDeep(result) ? result : { action: "decline" }
    }
  }

  if (nested.userDialog?.enabled) {
    callbacks.onUserDialog = async (request, { signal } = {}) => {
      const outcome = await requestApproval(
        `SDK:Dialog:${request?.dialogKind ?? "unknown"}`,
        { request, result: request?.payload },
        { signal, title: request?.dialogKind }
      )
      if (outcome?.behavior !== "allow") return { behavior: "cancelled" }
      const result = { behavior: "completed", result: outcome.updatedInput?.result }
      return hasNoLeakingPiiDeep(result) ? result : { behavior: "cancelled" }
    }
  }

  return callbacks
}

/** Copy `keys` from `src` onto `dest` when present, recording flat conflicts. */
function overlay(dest, src, keys, conflicts, flat) {
  for (const key of keys) {
    if (src[key] === undefined) continue
    if (flat && dest[key] !== undefined && dest[key] !== src[key]) {
      conflicts.push(
        `claudeAgentSdk.${key} overrides the flat SendOptions.${key} ` +
          `(${JSON.stringify(dest[key])} -> ${JSON.stringify(src[key])})`
      )
    }
    dest[key] = src[key]
  }
}

/** Fields whose flat counterpart exists and can therefore conflict. */
const OVERLAPPING_KEYS = ["tools"]

/** Fields with no flat counterpart — a plain copy. */
const PLAIN_KEYS = [
  "outputFormat",
  "sessionId",
  "continue",
  "resumeSessionAt",
  "resumeDropsTurn",
  "persistSession",
  "title",
  "enableFileCheckpointing",
  "permissionPromptToolName",
  "planModeInstructions",
  "skills",
  "toolAliases",
  "toolConfig",
  "includeHookEvents",
  "agentProgressSummaries",
  "promptSuggestions",
  "taskBudget",
  "loadTimeoutMs",
  "sandbox",
  "betas",
]

/**
 * Apply the nested block to an already-built SDK options object, in place.
 *
 * @param {Record<string, unknown>} options the allowlist object from anthropic.mjs
 * @param {any} nested `sendOptions.claudeAgentSdk`
 * @param {{
 *   permissionMode?: string,
 *   bypassConfirmed?: boolean,
 *   trustedWorkspaceRoots?: string[],
 *   cwd?: string,
 *   activeWorkspaceRoots?: string[],
 * }} ctx
 * @returns {{ options: Record<string, unknown>, warnings: string[] }}
 */
export function applyClaudeAgentSdkOptions(options, nested, ctx = {}) {
  const warnings = []
  if (nested === undefined) {
    // SDK omission is not isolation: the CLI would otherwise discover user,
    // project and local skills/plugins implicitly. Native discovery is opt-in
    // through the trusted nested contract only.
    options.settingSources = []
    options.skills = []
    return { options, warnings }
  }
  const validation = validateClaudeAgentSdkOptions(nested, {
    resume: ctx.resume,
    forkSession: ctx.forkSession,
    permissionMode: ctx.permissionMode,
    bypassConfirmed: ctx.bypassConfirmed,
  })
  if (!validation.ok) {
    throw new Error(`invalid claudeAgentSdk options: ${validation.errors.join("; ")}`)
  }
  warnings.push(...validation.warnings)

  const localContentRequested =
    nested.skills === "all" ||
    (Array.isArray(nested.skills) && nested.skills.length > 0) ||
    (Array.isArray(nested.plugins) && nested.plugins.length > 0)
  const trustedWorkspaceRoots = ctx.trustedWorkspaceRoots ?? []
  if (localContentRequested && trustedWorkspaceRoots.length === 0) {
    throw new Error(
      "claudeAgentSdk skills/plugins require an explicit trusted workspace root for this send"
    )
  }

  if (localContentRequested) {
    const activeWorkspaceRoots = (ctx.activeWorkspaceRoots ?? []).map(canonicalExistingPath)
    if (
      activeWorkspaceRoots.length === 0 ||
      activeWorkspaceRoots.some((root) => !root || !trustedWorkspaceRoots.includes(root))
    ) {
      throw new Error(
        "claudeAgentSdk skills/plugins require every active workspace root to be explicitly trusted"
      )
    }
    for (const root of activeWorkspaceRoots) {
      validateNativeSkillPaths(root, trustedWorkspaceRoots)
    }
    const sources = options.settingSources ?? ["user", "project", "local"]
    options.settingSources = sources.filter((source) => source === "project" || source === "local")
    if (sources.includes("user")) {
      warnings.push(
        "claudeAgentSdk.skills/plugins: removed user settingSources so native content resolves only from trusted project/local roots"
      )
    }
  } else {
    options.settingSources = []
    options.skills = []
  }

  overlay(options, nested, PLAIN_KEYS, warnings, false)
  overlay(options, nested, OVERLAPPING_KEYS, warnings, true)

  // ---- permissions ----------------------------------------------------------
  // Re-checked here even though the contract validator already ran: this is the
  // boundary that holds for payloads that never passed through the renderer.
  if (nested.allowDangerouslySkipPermissions) {
    if (ctx.permissionMode === "bypassPermissions" && ctx.bypassConfirmed) {
      options.allowDangerouslySkipPermissions = true
    } else {
      warnings.push(
        "claudeAgentSdk.allowDangerouslySkipPermissions was requested but not granted: it " +
          "needs permissionMode 'bypassPermissions' plus a confirmed host policy and user " +
          "confirmation"
      )
    }
  }

  // ---- plugins --------------------------------------------------------------
  if (nested.plugins) {
    const resolved = resolvePlugins(nested.plugins, trustedWorkspaceRoots)
    warnings.push(...resolved.warnings)
    if (resolved.plugins.length > 0) options.plugins = resolved.plugins
  }

  // ---- dialogs --------------------------------------------------------------
  // `userDialog` is a descriptor; the callback is built by the caller. Only the
  // serialisable half — which dialog kinds this host can render — is an option.
  if (nested.userDialog?.enabled && Array.isArray(nested.userDialog.kinds)) {
    options.supportedDialogKinds = nested.userDialog.kinds
  }

  // ---- extraArgs ------------------------------------------------------------
  const extraArgs = { ...(options.extraArgs ?? {}) }
  for (const [key, value] of Object.entries(nested.extraArgs ?? {})) {
    if (!ALLOWED_EXTRA_ARGS.has(key)) {
      throw new Error(
        `claudeAgentSdk.extraArgs["${key}"] is refused: only reviewed, content-free ` +
          "CLI flags are allowed"
      )
    }
    extraArgs[key] = value
  }
  if (options.enableFileCheckpointing) {
    if (
      "replay-user-messages" in extraArgs &&
      extraArgs["replay-user-messages"] !== CHECKPOINT_REQUIRED_EXTRA_ARGS["replay-user-messages"]
    ) {
      warnings.push(
        'extraArgs["replay-user-messages"] is managed by the host under file checkpointing; ' +
          "the caller-supplied value was replaced"
      )
    }
    Object.assign(extraArgs, CHECKPOINT_REQUIRED_EXTRA_ARGS)
  }
  if (Object.keys(extraArgs).length > 0) options.extraArgs = extraArgs

  return { options, warnings }
}
