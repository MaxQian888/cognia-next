import type { Options, Query } from "@anthropic-ai/claude-agent-sdk"
import type { ClaudeAgentSdkOptionsV1 } from "@cognia/agent-config-types/claude-agent-sdk-options"
import type {
  AgentExtensionReloadOptions,
  AgentExtensionReloadResult,
  AgentLocalExtensionRef,
} from "@cognia/agent-contracts/session-operations"
import { elicitationFormSchemaSafetyError } from "@cognia/agent-contracts/external-agent"
import type { SendOptions } from "../../shared/wire/inbound.ts"
import type { Dirent } from "node:fs"
import type { createAnthropicCanUseTool } from "../../policy/permission/sdk-can-use-tool.ts"
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
// Two constraints of the serialisable nested option overlay:
//
//   * It never constructs a callback or a live object. `hooks`, `canUseTool`,
//     `onElicitation`, `onUserDialog`, `sessionStore`, `stderr` are built by
//     the caller using the interaction helpers below; the block carries only descriptors.
//   * It never honours a host-only capability. `executable`, `settings`,
//     `pathToClaudeCodeExecutable`, `spawnClaudeCodeProcess` and friends are
//     absent from the contract type, and `extraArgs` is filtered so a raw CLI
//     flag cannot put them back.

import { resolve as resolvePath, sep as pathSep, extname, basename, dirname } from "node:path"
import {
  realpathSync,
  readdirSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  fstatSync,
  constants,
} from "node:fs"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import {
  expectsStructuredOutput,
  validateClaudeAgentSdkOptions,
} from "@cognia/agent-config-types/claude-agent-sdk-options"

/**
 * CLI flags accepted inside `extraArgs`.
 *
 * Mirrors `ALLOWED_EXTRA_ARGS` in the contract's validator. The sidecar invokes
 * that validator again at this boundary, including for companion/CLI payloads
 * that never passed through renderer validation.
 */
export const ALLOWED_EXTRA_ARGS = new Set(["verbose", "replay-user-messages"])

/**
 * File checkpointing addresses messages by uuid, and user messages only carry
 * one when the CLI is asked to replay them. Callers should not have to know
 * that, so it is added here whenever checkpointing is on.
 */
export const CHECKPOINT_REQUIRED_EXTRA_ARGS = { "replay-user-messages": null }

function canonicalExistingPath(path: string) {
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
 */
export function sendExpectsStructuredOutput(
  sendOptions: { claudeAgentSdk?: unknown } | null | undefined
) {
  return expectsStructuredOutput(sendOptions?.claudeAgentSdk)
}

/** True when `candidate` is inside one of `roots` (or equal to it). */
export function isWithinRoots(candidate: string, roots: readonly string[]) {
  const target = resolvePath(candidate)
  return roots.some((root) => {
    const base = resolvePath(root)
    return target === base || target.startsWith(base.endsWith(pathSep) ? base : base + pathSep)
  })
}

/** Keep only explicitly trusted roots that are also active for this send. */
export function intersectTrustedWorkspaceRoots(
  trustedRoots: readonly string[] | undefined,
  activeRoots: readonly (string | undefined)[] | undefined
) {
  const active = (activeRoots ?? [])
    .filter((root): root is string => typeof root === "string" && !!root)
    .map(canonicalExistingPath)
    .filter((root): root is string => root !== null)
  return [
    ...new Set(
      (trustedRoots ?? [])
        .filter((root): root is string => typeof root === "string" && !!root)
        .map(canonicalExistingPath)
        .filter((root): root is string => root !== null)
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
export function resolvePlugins(
  plugins:
    readonly ({ type?: string; path?: string; skipMcpDiscovery?: boolean } | null)[] | undefined,
  roots: readonly string[]
) {
  const out: NonNullable<Options["plugins"]> = []
  const warnings = []
  const canonicalRoots = roots
    .map(canonicalExistingPath)
    .filter((root): root is string => root !== null)
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

/** Bound synchronous admission work before the SDK opens local model instructions. */
function validateExtensionContent(paths: readonly string[], trustedRoots: readonly string[]) {
  const visited = new Set<string>()
  let entries = 0
  let totalBytes = 0
  const walk = (path: string, depth: number, forceText = false) => {
    const canonical = canonicalExistingPath(path)
    if (!canonical || !isWithinRoots(canonical, trustedRoots))
      throw new Error("extension content resolves outside a trusted workspace")
    if (!hasNoLeakingPiiDeep(canonical)) throw new Error("extension names blocked by the PII gate")
    if (++entries > 4096 || depth > 32)
      throw new Error("extension content exceeds admission scan limits")
    const stat = statSync(canonical)
    if (stat.isDirectory()) {
      const visitKey = `${forceText}:${canonical}`
      if (visited.has(visitKey)) return
      visited.add(visitKey)
      for (const entry of readdirSync(canonical))
        walk(resolvePath(canonical, entry), depth + 1, forceText)
      return
    }
    if (!stat.isFile())
      throw new Error("extension content must contain only readable regular files")
    const extensions = [extname(path).toLowerCase(), extname(canonical).toLowerCase()]
    const isManifest = extensions.includes(".json")
    if (
      !extensions.some((extension) =>
        [".md", ".mdx", ".txt", ".yaml", ".yml"].includes(extension)
      ) &&
      !isManifest &&
      !forceText
    )
      return
    if (stat.size > 1024 * 1024 || totalBytes + stat.size > 8 * 1024 * 1024)
      throw new Error("extension content exceeds admission scan limits")
    const fd = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    let text: string
    try {
      if (!fstatSync(fd).isFile()) throw new Error("extension content must be a regular file")
      const bytes = Buffer.alloc(stat.size + 1)
      let size = 0
      while (size < bytes.length) {
        const count = readSync(fd, bytes, size, bytes.length - size, null)
        if (!count) break
        size += count
      }
      if (size !== stat.size) throw new Error("extension content changed during admission")
      totalBytes += size
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))
    } finally {
      closeSync(fd)
    }
    let modelContent: unknown = text
    if (isManifest) {
      const manifest: unknown = JSON.parse(text)
      // Transport credentials are not model instructions. Native MCP discovery
      // is disabled below; those servers must enter through the host relay.
      modelContent =
        forceText || extname(path).toLowerCase() !== ".json"
          ? manifest
          : basename(canonical) === ".mcp.json"
            ? {}
            : basename(canonical) === "plugin.json" &&
                manifest &&
                typeof manifest === "object" &&
                !Array.isArray(manifest)
              ? Object.fromEntries(
                  Object.entries(manifest).filter(
                    ([key]) => !["env", "headers", "mcpServers", "author"].includes(key)
                  )
                )
              : manifest
      if (basename(canonical) === "plugin.json" && manifest && typeof manifest === "object") {
        for (const key of ["agents", "commands", "skills", "outputStyles"]) {
          const refs = (manifest as Record<string, unknown>)[key]
          for (const ref of typeof refs === "string" ? [refs] : Array.isArray(refs) ? refs : []) {
            if (typeof ref !== "string")
              throw new Error("extension manifest resource paths must be strings")
            const base =
              basename(dirname(canonical)) === ".claude-plugin"
                ? dirname(dirname(canonical))
                : dirname(canonical)
            const target = resolvePath(base, ref)
            // Reject glob references rather than treating an uninspected match as admitted.
            if (/[*?\[\]{}]/.test(ref))
              throw new Error("extension manifest resource globs are not supported by admission")
            walk(target, depth + 1, true)
          }
        }
      }
    }
    if (!hasNoLeakingPiiDeep(modelContent))
      throw new Error("extension content blocked by the PII gate")
  }
  for (const path of paths) walk(path, 0)
}

/** One trust and content boundary for startup restoration and live additions. */
export function resolveClaudeRuntimeExtensions(
  sendOptions: Pick<
    SendOptions,
    "cwd" | "additionalDirectories" | "trustedWorkspaceRoots" | "toolSurface"
  >,
  extensions: readonly AgentLocalExtensionRef[] = []
): NonNullable<Options["plugins"]> {
  if (
    !Array.isArray(extensions) ||
    extensions.some(
      (ref) =>
        !ref ||
        ref.kind !== "directory" ||
        typeof ref.path !== "string" ||
        !ref.path ||
        (ref.discoverMcp !== undefined && typeof ref.discoverMcp !== "boolean")
    )
  )
    throw new Error("invalid_runtime_extension")
  if (!extensions.length) return []
  if (sendOptions.toolSurface === "none") throw new Error("tool surface is disabled")
  if (extensions.some((ref) => ref.discoverMcp === true))
    throw new Error(
      "extension native MCP discovery is unsupported; configure MCP servers through the host"
    )
  const roots = intersectTrustedWorkspaceRoots(sendOptions.trustedWorkspaceRoots, [
    sendOptions.cwd,
    ...(sendOptions.additionalDirectories ?? []),
  ])
  const resolved = resolvePlugins(
    extensions.map((ref) => ({ type: "local", path: ref.path, skipMcpDiscovery: true })),
    roots
  )
  if (
    resolved.warnings.length ||
    resolved.plugins.some((plugin) => !statSync(plugin.path).isDirectory())
  )
    throw new Error(
      "extension paths must be existing directories inside a trusted active workspace"
    )
  if (!hasNoLeakingPiiDeep(resolved.plugins))
    throw new Error("extension paths blocked by the PII gate")
  validateExtensionContent(
    resolved.plugins.map((plugin) => plugin.path),
    roots
  )
  return resolved.plugins
}

type ClaudePluginInventoryEntry = { path: string; name?: string; source?: string }

/** Built-ins shipped by the pinned SDK use a sentinel instead of a filesystem path. */
function isSdkBuiltinPlugin(plugin: ClaudePluginInventoryEntry) {
  return (
    plugin.path === "builtin" &&
    plugin.source === `${plugin.name}@builtin` &&
    ["cc-plugin-agents-md", "cc-plugin-telemetry", "cc-plugin-plugin-authoring"].includes(
      plugin.name ?? ""
    )
  )
}

/** Translate the portable operation; the host owns deadlines and acknowledged persistence. */
export function createClaudeExtensionReloader(
  query: Partial<Pick<Query, "reloadPlugins">>,
  sendOptions: SendOptions,
  currentPluginInventory: () => readonly ClaudePluginInventoryEntry[] | undefined = () => undefined
) {
  let acknowledgedInventory: readonly ClaudePluginInventoryEntry[] | undefined
  return async (options: AgentExtensionReloadOptions = {}): Promise<AgentExtensionReloadResult> => {
    if (typeof query.reloadPlugins !== "function") throw new Error("unsupported_provider")
    // Refreshing reloads existing plugin files too: re-attest their current content.
    const legacy = (sendOptions.claudeAgentSdk?.plugins ?? []).map((plugin) => ({
      kind: "directory" as const,
      path: plugin.path,
      discoverMcp: plugin.skipMcpDiscovery !== true,
    }))
    const current = [...legacy, ...(sendOptions.runtimeExtensions ?? [])]
    const currentPlugins = resolveClaudeRuntimeExtensions(sendOptions, current)
    const inventory = acknowledgedInventory ?? currentPluginInventory()
    if (!inventory) throw new Error("extension_inventory_unavailable")
    const admitted = new Set(currentPlugins.map((plugin) => plugin.path))
    if (
      inventory.some(
        (plugin) =>
          !plugin ||
          typeof plugin.path !== "string" ||
          (!isSdkBuiltinPlugin(plugin) && !admitted.has(canonicalExistingPath(plugin.path) ?? ""))
      )
    )
      throw new Error("extension_inventory_unattested")
    const plugins = resolveClaudeRuntimeExtensions(sendOptions, options.add)
    const result = await query.reloadPlugins({
      ...(options.preservePromptCache !== undefined
        ? { holdOnCacheImpact: options.preservePromptCache }
        : {}),
      ...(options.add !== undefined ? { addPlugins: plugins } : {}),
    })
    const expectedPaths = new Set([...currentPlugins, ...plugins].map((plugin) => plugin.path))
    if (
      !result ||
      !Array.isArray(result.plugins) ||
      result.plugins.some(
        (plugin) =>
          !plugin ||
          typeof plugin.path !== "string" ||
          (!isSdkBuiltinPlugin(plugin) &&
            !expectedPaths.has(canonicalExistingPath(plugin.path) ?? ""))
      ) ||
      (result.held !== undefined && typeof result.held !== "boolean") ||
      !Number.isSafeInteger(result.error_count) ||
      result.error_count < 0
    )
      throw new Error("invalid_extension_reload_result")
    acknowledgedInventory = result.plugins
    const added =
      result.held === true
        ? []
        : plugins.filter((plugin) => result.plugins.some((loaded) => loaded.path === plugin.path))
    return {
      disposition:
        result.held === true
          ? "held"
          : result.error_count > 0 || added.length !== plugins.length
            ? "partial"
            : "applied",
      added: added.map((plugin) => ({ kind: "directory", path: plugin.path, discoverMcp: false })),
      details: result,
    }
  }
}

/**
 * Validate every provider-visible project skill entry by realpath.
 *
 * Symlinks are supported, including links into another trusted root. Dangling
 * links and links outside all trusted roots fail closed. Walking the whole
 * project skill tree is intentional: SDK skill names can come from SKILL.md
 * frontmatter, so directory-name filtering alone would not prove provenance.
 */
export function validateNativeSkillPaths(cwd: string, trustedRoots: readonly string[]) {
  const canonicalRoots = trustedRoots
    .map(canonicalExistingPath)
    .filter((root): root is string => root !== null)
  const canonicalCwd = canonicalExistingPath(cwd)
  if (!canonicalCwd || !isWithinRoots(canonicalCwd, canonicalRoots)) {
    throw new Error("claudeAgentSdk.skills: cwd must resolve inside a trusted workspace root")
  }

  const visitedDirectories = new Set<string>()
  const walk = (directory: string, directoryEntries: Dirent[]) => {
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
          if ((error as NodeJS.ErrnoException)?.code === "ENOTDIR") continue
          throw new Error(
            `claudeAgentSdk.skills: cannot inspect "${candidate}": ${error instanceof Error ? error.message : String(error)}`
          )
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
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue
      throw new Error(
        `claudeAgentSdk.skills/plugins: cannot inspect local content root: ${error instanceof Error ? error.message : String(error)}`
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
export function buildSdkInteractionCallbacks(
  nested: Pick<ClaudeAgentSdkOptionsV1, "elicitation" | "userDialog"> | undefined,
  requestApproval: ReturnType<typeof createAnthropicCanUseTool>
) {
  if (!nested || typeof nested !== "object" || typeof requestApproval !== "function") return {}
  const callbacks: {
    onElicitation?: (
      request: {
        title?: string
        displayName?: string
        description?: string
        message?: string
        serverName?: string
        mode?: "form" | "url"
        requestedSchema?: Record<string, unknown>
        property_order?: string[]
        url?: string
        elicitationId?: string
      },
      context?: { signal?: AbortSignal }
    ) => Promise<unknown>
    onUserDialog?: (
      request: { dialogKind?: string; payload?: unknown },
      context?: { signal?: AbortSignal }
    ) => Promise<unknown>
  } = {}

  if (nested.elicitation?.enabled) {
    callbacks.onElicitation = async (request, { signal } = {}) => {
      let target: URL | undefined
      if (request.mode === "url") {
        try {
          target = new URL(request.url ?? "")
          const loopback = target.hostname === "localhost" || target.hostname === "127.0.0.1"
          if (
            target.username ||
            target.password ||
            (target.protocol !== "https:" && !(target.protocol === "http:" && loopback))
          )
            return { action: "decline" }
        } catch {
          return { action: "decline" }
        }
      }
      const properties = request.requestedSchema?.properties
      if (
        request.mode !== "url" &&
        request.requestedSchema !== undefined &&
        elicitationFormSchemaSafetyError(request.requestedSchema)
      ) {
        return { action: "decline" }
      }
      const propertyOrder = Array.isArray(request.property_order)
        ? request.property_order.filter((key): key is string => typeof key === "string")
        : properties && typeof properties === "object"
          ? Object.keys(properties)
          : undefined
      const elicitation = {
        mode: request.mode ?? "form",
        message: request.message ?? request.title ?? "",
        requestedSchema: request.requestedSchema,
        propertyOrder,
        url: target?.href,
        origin: target?.origin,
        elicitationId: request.elicitationId,
        raw: {},
      }
      const outcome = await requestApproval(
        "Runtime:Elicitation",
        { request, elicitation, content: {} },
        {
          signal,
          title: request?.title,
          displayName: request?.displayName,
          description: request?.description,
          requiresInteraction: true,
        }
      )
      if (outcome?.behavior !== "allow") return { action: "decline" }
      const content = (outcome.updatedInput as Record<string, unknown> | undefined)?.content
      const result = {
        action: "accept" as const,
        ...(content && typeof content === "object"
          ? { content: content as Record<string, unknown> }
          : {}),
      }
      return hasNoLeakingPiiDeep(result) ? result : { action: "decline" }
    }
  }

  if (nested.userDialog?.enabled) {
    callbacks.onUserDialog = async (request, { signal } = {}) => {
      const outcome = await requestApproval(
        `Runtime:Dialog:${request?.dialogKind ?? "unknown"}`,
        { request, result: request?.payload },
        { signal, title: request?.dialogKind, requiresInteraction: true }
      )
      if (outcome?.behavior !== "allow") return { behavior: "cancelled" }
      const result = {
        behavior: "completed" as const,
        result: (outcome.updatedInput as Record<string, unknown> | undefined)?.result,
      }
      return hasNoLeakingPiiDeep(result) ? result : { behavior: "cancelled" }
    }
  }

  return callbacks
}

/** Copy `keys` from `src` onto `dest` when present, recording flat conflicts. */
function overlay(
  dest: Record<string, unknown>,
  src: Record<string, unknown>,
  keys: readonly string[],
  conflicts: string[],
  flat: boolean
) {
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
  "permissionPrompts",
  "perTaskStopAffordance",
  "pluginDelivery",
  "thinking",
  "systemPrompt",
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
 */
export function applyClaudeAgentSdkOptions<T extends Options>(
  options: T,
  nested: unknown,
  ctx: {
    resume?: string
    forkSession?: boolean
    permissionMode?: string
    bypassConfirmed?: boolean
    trustedWorkspaceRoots?: string[]
    cwd?: string
    activeWorkspaceRoots?: (string | undefined)[]
  } = {}
) {
  const warnings: string[] = []
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

  const validated = nested as ClaudeAgentSdkOptionsV1
  const localContentRequested =
    validated.skills === "all" ||
    (Array.isArray(validated.skills) && validated.skills.length > 0) ||
    (Array.isArray(validated.plugins) && validated.plugins.length > 0)
  const trustedWorkspaceRoots = ctx.trustedWorkspaceRoots ?? []
  if (localContentRequested && trustedWorkspaceRoots.length === 0) {
    throw new Error(
      "claudeAgentSdk skills/plugins require an explicit trusted workspace root for this send"
    )
  }

  if (localContentRequested) {
    const activeWorkspaceRoots = (ctx.activeWorkspaceRoots ?? []).map((root) =>
      canonicalExistingPath(root!)
    )
    if (
      activeWorkspaceRoots.length === 0 ||
      activeWorkspaceRoots.some((root) => !root || !trustedWorkspaceRoots.includes(root))
    ) {
      throw new Error(
        "claudeAgentSdk skills/plugins require every active workspace root to be explicitly trusted"
      )
    }
    for (const root of activeWorkspaceRoots) {
      validateNativeSkillPaths(root!, trustedWorkspaceRoots)
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

  overlay(
    options as Record<string, unknown>,
    validated as unknown as Record<string, unknown>,
    PLAIN_KEYS,
    warnings,
    false
  )
  overlay(
    options as Record<string, unknown>,
    validated as unknown as Record<string, unknown>,
    OVERLAPPING_KEYS,
    warnings,
    true
  )

  // ---- permissions ----------------------------------------------------------
  // The boundary validator above already requires both host permission gates.
  if (validated.allowDangerouslySkipPermissions) {
    options.allowDangerouslySkipPermissions = true
  }

  // ---- plugins --------------------------------------------------------------
  if (validated.plugins) {
    const resolved = resolvePlugins(validated.plugins, trustedWorkspaceRoots)
    warnings.push(...resolved.warnings)
    if (resolved.plugins.length > 0) options.plugins = resolved.plugins
  }

  // ---- dialogs --------------------------------------------------------------
  // `userDialog` is a descriptor; the callback is built by the caller. Only the
  // serialisable half — which dialog kinds this host can render — is an option.
  if (validated.userDialog?.enabled && Array.isArray(validated.userDialog.kinds)) {
    options.supportedDialogKinds = validated.userDialog.kinds
  }

  // ---- extraArgs ------------------------------------------------------------
  const extraArgs = { ...(options.extraArgs ?? {}) }
  for (const [key, value] of Object.entries(validated.extraArgs ?? {})) {
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
