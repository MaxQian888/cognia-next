// The session configuration a template can carry, and how it differs from the
// session you are currently in.
//
// Deliberately the same field shape as `SystemPromptPreset` plus three ids.
// That is not a coincidence to be tidied away later: presets already own the
// only tested answer in this repo to "apply a configuration onto a session
// without silently trampling what is there" (`lib/presets/apply-to-session.ts`,
// with its three strategies and conflict detection). Sharing the shape is what
// lets a template reuse that instead of growing a second, divergent one.
//
// The three additions are the ones a preset has no concept of, and the ones the
// original ask was actually about: which agent, which team, which repository.

import type { ChatSession, SystemPromptPreset } from "@cognia/agent-config-types"

/**
 * Which repository a template expects.
 *
 * Both halves are stored on purpose. `projectId` is how it resolves instantly
 * on the machine that saved it; `gitRemote` is the only half that survives the
 * trip to another machine, because a workspace is identified in this codebase
 * by a LOCAL ABSOLUTE PATH and nothing else — there is no portable repository
 * identity to store. Neither is sufficient alone.
 */
export interface ChatTemplateWorkspaceRef {
  projectId?: string
  /** e.g. `git@github.com:acme/app.git` — the portable half. */
  gitRemote?: string
  branch?: string
}

export interface ChatTemplateLaunchSpec {
  // ── same shape as SystemPromptPreset ──────────────────────────────────────
  systemPrompt?: string
  model?: string
  permissionMode?: ChatSession["permissionMode"]
  effort?: SystemPromptPreset["effort"]
  allowedTools?: string[]
  disallowedTools?: string[]
  mcpServerIds?: string[]
  skillIds?: string[]
  agentModeId?: string | null
  workingDir?: string
  // ── the three a preset cannot express ─────────────────────────────────────
  /** The persona the conversation runs as. */
  characterId?: string
  /** The Squad (executor) the conversation runs on — ADR-0140. */
  squadId?: string
  workspace?: ChatTemplateWorkspaceRef
}

/** A field the template would change, and what it would change it from. */
export interface LaunchSpecDifference {
  field: LaunchSpecField
  /** What the template asks for. */
  wanted: string
  /** What the session currently has, or undefined when it has nothing. */
  current?: string
}

export type LaunchSpecField =
  | "model"
  | "permissionMode"
  | "systemPrompt"
  | "workingDir"
  | "characterId"
  | "squadId"
  | "projectId"

/** Everything a session carries that a launch spec can speak about. */
export type LaunchSpecSubject = Pick<
  ChatSession,
  "model" | "permissionMode" | "systemPrompt" | "workingDir" | "characterId" | "squadId"
> & { projectId?: string }

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && !value.trim())
}

/**
 * What this template would change about the session it is being inserted into.
 *
 * Only fields the template actually SETS are considered — a template that says
 * nothing about the model is not proposing to clear it. And only fields whose
 * value genuinely differs are reported: proposing a change that would be a
 * no-op is how a warning bar becomes something people learn to dismiss without
 * reading.
 *
 * Nothing here writes. Deciding what to do about a difference belongs to the
 * caller, because the honest answer in an existing conversation is usually
 * "start a new one" rather than "rewrite the one you are in".
 */
export function diffLaunchSpec(
  spec: ChatTemplateLaunchSpec | undefined,
  session: LaunchSpecSubject
): LaunchSpecDifference[] {
  if (!spec) return []
  const out: LaunchSpecDifference[] = []
  const compare = (field: LaunchSpecField, wanted: unknown, current: unknown): void => {
    if (isBlank(wanted)) return
    if (String(wanted) === String(current ?? "")) return
    out.push({
      field,
      wanted: String(wanted),
      ...(isBlank(current) ? {} : { current: String(current) }),
    })
  }
  compare("characterId", spec.characterId, session.characterId)
  compare("squadId", spec.squadId, session.squadId)
  compare("projectId", spec.workspace?.projectId, session.projectId)
  compare("model", spec.model, session.model)
  compare("permissionMode", spec.permissionMode, session.permissionMode)
  compare("workingDir", spec.workingDir, session.workingDir)
  compare("systemPrompt", spec.systemPrompt, session.systemPrompt)
  return out
}

/** True when the spec would change nothing about this session. */
export function launchSpecMatches(
  spec: ChatTemplateLaunchSpec | undefined,
  session: LaunchSpecSubject
): boolean {
  return diffLaunchSpec(spec, session).length === 0
}

/** Whether a spec asks for anything at all. */
export function hasLaunchSpec(spec: ChatTemplateLaunchSpec | undefined): boolean {
  if (!spec) return false
  return Object.entries(spec).some(([, value]) => {
    if (value === undefined || value === null) return false
    if (Array.isArray(value)) return value.length > 0
    if (typeof value === "object") return Object.values(value).some((v) => !isBlank(v))
    return !isBlank(value)
  })
}

/**
 * The seed for a NEW conversation started from this template.
 *
 * Only the fields `startNewSession` actually persists. The rest of a launch
 * spec (tools, MCP servers, skills, agent mode) lives on the character and the
 * agent-mode store rather than on the session row — `apply-to-session.ts` says
 * as much — so a template that wants those should name a character that has
 * them, not try to smuggle them onto the row.
 */
export function launchSpecSeed(spec: ChatTemplateLaunchSpec | undefined): {
  model?: string
  systemPrompt?: string
  workingDir?: string
  characterId?: string
  squadId?: string
  projectId?: string
} {
  if (!spec) return {}
  return {
    ...(spec.model ? { model: spec.model } : {}),
    ...(spec.systemPrompt ? { systemPrompt: spec.systemPrompt } : {}),
    ...(spec.workingDir ? { workingDir: spec.workingDir } : {}),
    ...(spec.characterId ? { characterId: spec.characterId } : {}),
    ...(spec.squadId ? { squadId: spec.squadId } : {}),
    ...(spec.workspace?.projectId ? { projectId: spec.workspace.projectId } : {}),
  }
}
