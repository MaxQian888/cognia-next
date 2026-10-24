// Which permission classes a tool call belongs to (ADR-0224 A7).
//
// An unattended run's permission profile names a level per class; the ladder
// and the Claude Agent SDK profile hook ask this module which classes a call
// is in. The answer is derived, never declared by the model:
//
//   - built-in `cognia-tools` that require approval are workspace file and
//     shell tools (the catalog's read-only tools are in no class), and so are
//     the Agent SDK's own editors and shell;
//   - a plugin tool carries the classes the host derived from its plugin's
//     declared permissions (`pluginTools[].permissionClasses`);
//   - an MCP server tool the user added is in no class: nothing about it is
//     known here, and it keeps the ordinary ladder.
//
// The sandbox-executed set is narrower than the workspace class on purpose:
// the sandbox auto-allow covers only the first-party sandboxed tools, which
// run inside the placement or refuse. A built-in `write` in a sandboxed
// session still writes to this machine, so a verified sandbox says nothing
// about it.

import type {
  PermissionClass,
  ResolvedPermissionProfile,
} from "@cognia/agent-config-types/unattended-permission"

import { BUILTIN_SERVER_NAME, READ_ONLY_TOOL_NAMES } from "../tool-catalog/catalog.ts"
import { PLUGIN_TOOLS_SERVER_NAME, splitToolName } from "../tool-catalog/names.ts"

/** The Agent SDK's native file editors and shell: workspace class. */
const NATIVE_WORKSPACE_TOOLS: ReadonlySet<string> = new Set([
  "Bash",
  "KillShell",
  "KillBash",
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "str_replace_based_edit_tool",
])

/** The first-party plugin whose tools execute inside the session's sandbox placement. */
export const SANDBOXED_TOOLS_PLUGIN_ID = "cognia-sandboxed-tools"

/** Its tools: every call runs in the placement or refuses, never on this machine. */
export const SANDBOX_EXECUTED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "sandbox_bash",
  "sandbox_edit",
  "sandbox_write",
  "sandbox_text_editor",
])

/** The classes whose `ask` no permission mode, grant or rule may skip. */
export const ALWAYS_ASK_CLASSES: ReadonlySet<PermissionClass> = new Set([
  "outbound",
  "secrets",
  "hostConfig",
])

const KNOWN_CLASSES: ReadonlySet<string> = new Set([
  "workspace",
  "outbound",
  "secrets",
  "hostConfig",
])

interface PluginToolEntry {
  name?: unknown
  pluginId?: unknown
  permissionClasses?: unknown
}

/** What the session's plugin manifest says about classes, read once per gate. */
export interface PluginClassIndex {
  /** Bare plugin tool name -> its classes. */
  classes: ReadonlyMap<string, readonly PermissionClass[]>
  /** Bare names of the sandbox-executed tools actually declared by the first-party plugin. */
  sandboxExecuted: ReadonlySet<string>
}

export const EMPTY_PLUGIN_CLASS_INDEX: PluginClassIndex = Object.freeze({
  classes: new Map(),
  sandboxExecuted: new Set<string>(),
})

/** Index `SendOptions.pluginTools`. Unknown classes are dropped rather than trusted. */
export function buildPluginClassIndex(pluginTools: unknown): PluginClassIndex {
  if (!Array.isArray(pluginTools)) return EMPTY_PLUGIN_CLASS_INDEX
  const classes = new Map<string, PermissionClass[]>()
  const sandboxExecuted = new Set<string>()
  for (const raw of pluginTools as unknown[]) {
    const entry = raw as PluginToolEntry | null
    if (!entry || typeof entry.name !== "string") continue
    if (Array.isArray(entry.permissionClasses)) {
      const declared = entry.permissionClasses.filter(
        (cls): cls is PermissionClass => typeof cls === "string" && KNOWN_CLASSES.has(cls)
      )
      if (declared.length > 0) classes.set(entry.name, [...new Set(declared)])
    }
    if (
      entry.pluginId === SANDBOXED_TOOLS_PLUGIN_ID &&
      SANDBOX_EXECUTED_TOOL_NAMES.has(entry.name)
    ) {
      sandboxExecuted.add(entry.name)
    }
  }
  return { classes, sandboxExecuted }
}

/** Every class the call belongs to, in no particular order. */
export function classesOfTool(toolName: string, index: PluginClassIndex): PermissionClass[] {
  const { server, bare } = splitToolName(toolName)
  if (!server) {
    return NATIVE_WORKSPACE_TOOLS.has(bare) ? ["workspace"] : []
  }
  if (server === BUILTIN_SERVER_NAME) {
    return READ_ONLY_TOOL_NAMES.has(bare) ? [] : ["workspace"]
  }
  if (server === PLUGIN_TOOLS_SERVER_NAME) {
    const declared = index.classes.get(bare)
    if (declared) return [...declared]
    return index.sandboxExecuted.has(bare) ? ["workspace"] : []
  }
  return []
}

/** Whether the call runs inside the sandbox placement (or refuses). */
export function isSandboxExecuted(toolName: string, index: PluginClassIndex): boolean {
  const { server, bare } = splitToolName(toolName)
  return server === PLUGIN_TOOLS_SERVER_NAME && index.sandboxExecuted.has(bare)
}

/** What the profile says about one call. */
export type ProfileVerdict =
  /** No profile, or no class of this call is restricted beyond the ordinary ladder. */
  | { kind: "none" }
  | { kind: "deny"; cls: PermissionClass }
  /** A class whose `ask` no shortcut may skip. */
  | { kind: "always-ask"; cls: PermissionClass }

/**
 * The strictest thing the profile requires of a call: a `deny` in any of its
 * classes wins, then an always-ask class at `ask`. Workspace `sandbox` and
 * `ask` leave the call to the ladder (the sandbox step reads the level itself).
 */
export function profileVerdict(
  profile: ResolvedPermissionProfile | null | undefined,
  toolName: string,
  index: PluginClassIndex
): ProfileVerdict {
  if (!profile) return { kind: "none" }
  const classes = classesOfTool(toolName, index)
  for (const cls of classes) {
    if (profile[cls] === "deny") return { kind: "deny", cls }
  }
  for (const cls of classes) {
    if (ALWAYS_ASK_CLASSES.has(cls) && profile[cls] === "ask") return { kind: "always-ask", cls }
  }
  return { kind: "none" }
}

/** Model-facing text for a profile denial. English on purpose: the model reads it. */
export function profileDenialMessage(toolName: string, cls: PermissionClass): string {
  const what: Record<PermissionClass, string> = {
    workspace: "workspace file and shell operations",
    outbound: "outbound messages",
    secrets: "secret use",
    hostConfig: "host configuration changes",
  }
  return `denied: this unattended run's permission profile does not allow ${what[cls]} ("${toolName}"). Do not retry it; finish without it and say what it would have done.`
}

const LEVELS: Readonly<Record<PermissionClass, readonly string[]>> = {
  workspace: ["sandbox", "ask", "deny"],
  outbound: ["ask", "deny"],
  secrets: ["ask", "deny"],
  hostConfig: ["ask", "deny"],
}

/**
 * Read `SendOptions.permissionProfile`. Absent stays absent (an interactive
 * turn). A present but malformed class fails closed to `ask`: the run is
 * unattended either way, and a host bug must not hand it a level nobody chose.
 */
export function readPermissionProfile(raw: unknown): ResolvedPermissionProfile | null {
  if (raw === undefined || raw === null) return null
  const record =
    typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const level = <C extends PermissionClass>(cls: C) => {
    const value = record[cls]
    return (
      typeof value === "string" && LEVELS[cls].includes(value) ? value : "ask"
    ) as ResolvedPermissionProfile[C]
  }
  return {
    workspace: level("workspace"),
    outbound: level("outbound"),
    secrets: level("secrets"),
    hostConfig: level("hostConfig"),
  }
}

/** Whether `SendOptions.sandboxAttestation` attests an isolated placement. */
export function readSandboxAttested(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false
  const attestation = raw as { schemaVersion?: unknown; tier?: unknown }
  return (
    attestation.schemaVersion === 1 &&
    (attestation.tier === "microvm" || attestation.tier === "container")
  )
}

/** The approval wait ceiling from `SendOptions.approvalTtlMs`, or undefined for none. */
export function readApprovalTtlMs(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined
}

/**
 * Tools that must reach a person, or at least the host, on every call
 * (`SendOptions.alwaysExplicitTools`, ADR-0239).
 *
 * - `enforce`: no shortcut may allow a listed call: not a grant, a ruleset
 *   allow, a suppress entry, an attested sandbox, acceptEdits or bypass. It
 *   asks, and dontAsk or a missing approval channel denies it. A deny still
 *   comes first.
 * - `observe`: the ladder is unchanged. When a shortcut allows a listed call
 *   the gate reports it with an `explicit_tool_allowed` frame, so the host can
 *   record what the outbound policy would have decided without changing what
 *   is sent.
 *
 * Phase 1 lists outbound tools only, so a listed call is labelled
 * `permissionClass: "outbound"` when the run's profile names no class for it.
 */
export interface ExplicitToolPolicy {
  /** Normalized names: see {@link explicitToolName}. */
  tools: ReadonlySet<string>
  mode: "observe" | "enforce"
}

/**
 * A tool name reduced to the name it was registered under: the last `__`
 * segment, trimmed and lowercased, so `mcp__cognia-tools__send_email` and
 * `send_email` are one entry. The same reduction as the host's
 * `normalizeToolId` (`lib/policy/risk/outbound-tools.ts`), pinned by
 * `lib/policy/risk/outbound-tools.sidecar-parity.test.ts`.
 */
export function explicitToolName(toolName: string): string {
  const tail = toolName.split("__").pop() ?? toolName
  return tail.trim().toLowerCase()
}

/**
 * Read the list and its mode. No list, or an empty one, is no policy. Any mode
 * other than exactly `observe` enforces: a malformed value must not quietly
 * turn the always-ask off.
 */
export function readExplicitToolPolicy(
  rawTools: unknown,
  rawMode: unknown
): ExplicitToolPolicy | null {
  if (!Array.isArray(rawTools)) return null
  const tools = new Set<string>()
  for (const entry of rawTools as unknown[]) {
    if (typeof entry !== "string") continue
    const name = explicitToolName(entry)
    if (name) tools.add(name)
  }
  if (tools.size === 0) return null
  return { tools, mode: rawMode === "observe" ? "observe" : "enforce" }
}

/** Whether `toolName` is listed, in either mode. */
export function isExplicitTool(
  toolName: string,
  policy: ExplicitToolPolicy | null | undefined
): boolean {
  return Boolean(policy?.tools.has(explicitToolName(toolName)))
}

/** Whether no shortcut may allow `toolName`. */
export function explicitToolMustAsk(
  toolName: string,
  policy: ExplicitToolPolicy | null | undefined
): boolean {
  return policy?.mode === "enforce" && isExplicitTool(toolName, policy)
}

/** Whether a shortcut allowing `toolName` is to be reported. */
export function explicitToolObserved(
  toolName: string,
  policy: ExplicitToolPolicy | null | undefined
): boolean {
  return policy?.mode === "observe" && isExplicitTool(toolName, policy)
}

/**
 * The class a permission request names: the profile's always-ask class, else
 * `outbound` for a listed tool, else the call's first class under a profile.
 */
export function requestPermissionClass(
  verdict: ProfileVerdict,
  profile: ResolvedPermissionProfile | null | undefined,
  toolName: string,
  index: PluginClassIndex,
  explicit: ExplicitToolPolicy | null | undefined
): PermissionClass | undefined {
  if (verdict.kind === "always-ask") return verdict.cls
  if (isExplicitTool(toolName, explicit)) return "outbound"
  return profile ? classesOfTool(toolName, index)[0] : undefined
}

/** The frame a gate emits when a shortcut allowed an observed call. */
export function explicitToolAllowedFrame(
  sessionId: string | undefined,
  toolName: string,
  input: unknown,
  toolUseID?: string
): Record<string, unknown> {
  return {
    type: "explicit_tool_allowed",
    sessionId,
    ...(toolUseID ? { toolUseID } : {}),
    toolName,
    input,
    permissionClass: "outbound",
  }
}
