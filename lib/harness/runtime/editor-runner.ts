/**
 * One editor stage: an invariant or domain proposal, or a composition (ADR-0237).
 *
 * Both channels see the same evidence, the context tree
 * (`../context-tree.ts`), and are held to the same retry-once contract
 * (`runEditorStage`): an invalid proposal is sent back once with the
 * validator's errors, and a second invalid one makes the stage inherit its
 * input harness.
 *
 * - Structured: one model call with the tree inlined; the answer is a JSON
 *   object of whole-file replacements. Cheap and predictable; used when the
 *   tree fits.
 * - Agentic: an editor agent works in a scratch directory holding the tree,
 *   edits files under `harness/` and writes `NOTES.md`; the proposal is read
 *   off the before/after trees. Used when the evidence is too large to inline,
 *   as Harness²'s editors read it.
 *
 * The agentic editor reads untrusted run output, so it gets file tools only,
 * confined to its directory, may write nothing but `harness/**` and
 * `NOTES.md`, and has no shell, web, MCP server, subagent or plugin tool.
 */

import type { AgentCapabilityGrantV1 } from "@cognia/agent-config-types/agent-capability-grant"
import type { Character, PermissionRequestEvent, SendOptions } from "@cognia/agent-config-types"
import type { UsageInfo } from "@/lib/claude/adapter"
import type { CaptureStreamEvent, RunAndCaptureResult } from "@/lib/claude/run-and-capture"
import type { HarnessEvolutionRun } from "@/types/harness/evolution"
import type { HarnessComponentsV1 } from "@/types/harness/snapshot"
import {
  HARNESS_DIR,
  OMITTED_HEADER,
  harnessTreeOf,
  inlineContextTree,
  type ContextTree,
} from "../context-tree"
import {
  parseStructuredProposal,
  proposalFromEditedTree,
  runEditorStage,
  type EditorStageResult,
  type ProposalPolicy,
} from "../editor"
import { editorSystemPrompt, editorUserPrompt, type EditorRole } from "../prompts"
import type { HarnessTree } from "../tree"
import { probeDirectory, syntheticProject, type IsolationFsDeps } from "./isolation"
import { callHarnessModel, roleModel, type HarnessModelDeps } from "./model-call"
import {
  PROBE_DENIED_TOOLS,
  PROBE_FILE_READ_TOOLS,
  PROBE_FILE_WRITE_TOOLS,
  PROBE_PERMISSION_PROFILE,
  decideProbeToolCall,
  isInsideRoot,
  pathsInToolInput,
  resolveProbePath,
} from "./probe-policy"
import { bookProbeUsage, type ProbeRunnerDeps, type ProbeUsage } from "./probe-runner"

/** Characters of evidence a structured editor is given inline. */
export const STRUCTURED_CONTEXT_MAX_CHARS = 160_000
/** Output ceiling of a structured editor answer (whole files are rewritten). */
export const EDITOR_MAX_OUTPUT_TOKENS = 16_000
/** Agentic turns an editor session may take. */
export const AGENTIC_EDITOR_MAX_TURNS = 40
const AGENTIC_EDITOR_TIMEOUT_MS = 15 * 60 * 1000
const NOTES_FILE = "NOTES.md"

/** Native and built-in file tools an agentic editor may see. */
const EDITOR_READ_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "LS",
  "read",
  "grep",
  "glob",
  "ls",
  "file_search",
  "content_search",
  "file_exists",
  "file_info",
]
const EDITOR_WRITE_TOOLS = [
  "Write",
  "Edit",
  "MultiEdit",
  "write",
  "edit",
  "multi_edit",
  "file_append",
  "directory_create",
]
const EDITOR_DENIED_TOOLS = [
  "Bash",
  "bash",
  "BashOutput",
  "KillShell",
  "WebFetch",
  "WebSearch",
  "Task",
  "Agent",
  "Skill",
  "NotebookEdit",
  "apply_patch",
  "ast_grep_replace",
  "file_copy",
  "file_move",
  "file_rename",
  "file_binary_write",
  "directory_delete",
  "git_stage",
  "git_commit",
]

const withAliases = (names: readonly string[]) =>
  names.flatMap((n) => [n, `mcp__cognia-tools__${n}`])

export interface EditorSessionInput {
  run: Pick<HarnessEvolutionRun, "id" | "config" | "projectId">
  label: string
  /** The step's attempt counter, for usage ids and scratch directories. */
  attempt: number
  role: EditorRole
  round?: number
  context: ContextTree
  current: HarnessComponentsV1
  policy: ProposalPolicy
  /** The evolving agent; its model is the editor's fallback. */
  agent: Pick<Character, "providerId" | "model">
  signal: AbortSignal
}

export interface EditorSessionOutcome extends EditorStageResult {
  channel: "structured" | "agentic"
  usage: ProbeUsage
  modelCalls: number
}

export interface EditorRunnerDeps {
  model: HarnessModelDeps
  /** Session plumbing shared with probes (agentic channel). */
  agentic: Pick<
    ProbeRunnerDeps,
    | "createSession"
    | "deleteSession"
    | "getSettings"
    | "resolveSendOptions"
    | "runTurn"
    | "claimTurnUsage"
    | "bookUsage"
    | "surfaceUsageFromUsageInfo"
    | "now"
    | "newId"
  >
  fs: Pick<
    IsolationFsDeps,
    "writeAppDataFile" | "appDataPath" | "removeAppDataDirectory" | "walk" | "readText"
  >
}

function addUsage(a: ProbeUsage, b: ProbeUsage): ProbeUsage {
  const costUsd =
    a.costUsd === undefined && b.costUsd === undefined
      ? undefined
      : (a.costUsd ?? 0) + (b.costUsd ?? 0)
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(costUsd !== undefined ? { costUsd } : {}),
    costUnknown: a.costUnknown || b.costUnknown,
  }
}

const NO_USAGE: ProbeUsage = { inputTokens: 0, outputTokens: 0, costUnknown: false }

/** Which channel a stage uses. `auto` inlines when the evidence fits. */
export function chooseEditorChannel(
  setting: HarnessEvolutionRun["config"]["editorChannel"],
  context: ContextTree
): { channel: "structured" | "agentic"; inlined: string } {
  const inlined = inlineContextTree(context, STRUCTURED_CONTEXT_MAX_CHARS)
  if (setting === "structured") return { channel: "structured", inlined }
  if (setting === "agentic") return { channel: "agentic", inlined }
  return { channel: inlined.includes(OMITTED_HEADER) ? "agentic" : "structured", inlined }
}

export async function runEditorSession(
  input: EditorSessionInput,
  deps: EditorRunnerDeps
): Promise<EditorSessionOutcome> {
  const { channel, inlined } = chooseEditorChannel(input.run.config.editorChannel, input.context)
  const modelRole = input.role === "COMPOSE" ? "composer" : "editor"
  const model = roleModel(modelRole, input.run.config.models, input.agent)
  let usage = NO_USAGE
  let modelCalls = 0

  if (channel === "structured") {
    let previousAnswer: string | undefined
    const result = await runEditorStage(input.current, input.policy, async (retryErrors) => {
      modelCalls += 1
      const answer = await callHarnessModel(
        {
          role: modelRole,
          model,
          system: editorSystemPrompt(input.role, "structured"),
          prompt: editorUserPrompt({
            role: input.role,
            ...(input.round ? { round: input.round } : {}),
            inlined,
            ...(retryErrors ? { retryErrors } : {}),
            ...(retryErrors && previousAnswer ? { previousAnswer } : {}),
          }),
          maxTokens: EDITOR_MAX_OUTPUT_TOKENS,
          runId: input.run.id,
          operationId: `harness:${input.run.id}:${input.label}:${input.attempt}:${modelCalls}`,
          signal: input.signal,
        },
        deps.model
      )
      usage = addUsage(usage, answer.usage)
      previousAnswer = answer.text
      return parseStructuredProposal(answer.text)
    })
    return { ...result, channel, usage, modelCalls }
  }

  const dir = `${probeDirectory(input.run.id, input.label)}/editor-${input.attempt}`
  try {
    for (const [path, content] of Object.entries(input.context)) {
      await deps.fs.writeAppDataFile(`${dir}/${path}`, new TextEncoder().encode(content))
    }
    const root = await deps.fs.appDataPath(dir)
    const before = harnessTreeOf(input.context)
    const result = await runEditorStage(input.current, input.policy, async (retryErrors) => {
      modelCalls += 1
      const turn = await runAgenticEditorTurn(
        {
          ...input,
          root,
          model,
          prompt: editorUserPrompt({
            role: input.role,
            ...(input.round ? { round: input.round } : {}),
            ...(retryErrors ? { retryErrors } : {}),
          }),
          call: modelCalls,
        },
        deps
      )
      usage = addUsage(usage, turn.usage)
      const after = await readHarnessTree(root, deps.fs)
      const notes = await deps.fs
        .readText(root, NOTES_FILE, 64 * 1024)
        .then((r) => r.content)
        .catch(() => "")
      return { ok: true as const, proposal: proposalFromEditedTree(before, after, notes) }
    })
    return { ...result, channel, usage, modelCalls }
  } finally {
    await deps.fs.removeAppDataDirectory(dir).catch(() => undefined)
  }
}

async function readHarnessTree(root: string, fs: EditorRunnerDeps["fs"]): Promise<HarnessTree> {
  const walked = await fs.walk(root)
  const tree: HarnessTree = {}
  for (const file of walked.files) {
    const rel = file.relPath.replace(/\\/g, "/")
    if (!rel.startsWith(`${HARNESS_DIR}/`)) continue
    const read = await fs.readText(root, rel, 256 * 1024)
    tree[rel.slice(HARNESS_DIR.length + 1)] = read.content
  }
  return tree
}

/** The permission responder of an agentic editor: reads anywhere in its directory, writes only the harness and its notes. */
export function decideEditorToolCall(toolName: string, toolInput: unknown, root: string) {
  const bare = toolName.replace(/^mcp__cognia-tools__/, "")
  const policyDecision = decideProbeToolCall(toolName, toolInput, {
    isolation: "files",
    root,
    networkOff: true,
    allowedMcpServerNames: new Set(),
  })
  if (!policyDecision.allow) return policyDecision
  if (PROBE_FILE_READ_TOOLS.has(bare)) return policyDecision
  if (!PROBE_FILE_WRITE_TOOLS.has(bare) || !EDITOR_WRITE_TOOLS.includes(bare)) {
    return { allow: false as const, reason: `"${bare}" is not available to a harness editor.` }
  }
  for (const raw of pathsInToolInput(toolInput)) {
    const resolved = resolveProbePath(raw, root)
    const harnessRoot = `${root.replace(/[\\/]+$/, "")}/${HARNESS_DIR}`
    const notes = `${root.replace(/[\\/]+$/, "")}/${NOTES_FILE}`
    if (
      !resolved ||
      !(isInsideRoot(resolved, harnessRoot) || resolved === resolveProbePath(notes, root))
    ) {
      return {
        allow: false as const,
        reason: `Editors write only under harness/ and ${NOTES_FILE}.`,
      }
    }
  }
  return policyDecision
}

function editorCharacter(role: EditorRole, now: number): Character {
  return {
    id: "__harness-editor__",
    name: "Harness Editor",
    avatarColor: "oklch(0.6 0 0)",
    systemPrompt: editorSystemPrompt(role, "agentic"),
    createdAt: now,
    updatedAt: now,
  }
}

function editorGrant(input: {
  runId: string
  label: string
  model: { providerId?: string; model?: string }
  restrictTo: readonly string[]
  pluginToolDenials: readonly string[]
}): AgentCapabilityGrantV1 {
  return {
    schemaVersion: 1,
    source: { kind: "harness-evolution", id: `${input.runId}:${input.label}:editor` },
    ...(input.model.model ? { model: input.model.model } : {}),
    ...(input.model.providerId ? { provider: input.model.providerId } : {}),
    maxTurns: AGENTIC_EDITOR_MAX_TURNS,
    permissionMode: "default",
    permissionProfile: { ...PROBE_PERMISSION_PROFILE },
    mcpServers: { only: [] },
    subagents: { only: [] },
    tools: {
      restrictTo: [...input.restrictTo],
      deny: [
        ...new Set([
          ...PROBE_DENIED_TOOLS,
          ...withAliases(EDITOR_DENIED_TOOLS),
          ...input.pluginToolDenials,
        ]),
      ].sort(),
    },
  }
}

async function runAgenticEditorTurn(
  input: EditorSessionInput & {
    root: string
    model: { providerId?: string; model?: string }
    prompt: string
    call: number
  },
  deps: EditorRunnerDeps
): Promise<{ usage: ProbeUsage }> {
  const d = deps.agentic
  const session = await d.createSession({
    title: `Harness editor ${input.label}`,
    memoryLearn: false,
    visibility: "embedded",
    workingDir: input.root,
    workspaceConfinementEnabled: true,
  })
  try {
    const now = d.now()
    const character = editorCharacter(input.role, now)
    const project = syntheticProject(
      `harness-editor:${input.run.id}:${input.label}`,
      "Harness editor",
      input.root,
      now
    )
    const appSettings = await d.getSettings()
    const turnId = d.newId()
    const resolve = (restrictTo: readonly string[], pluginToolDenials: readonly string[]) =>
      d.resolveSendOptions({
        session,
        character,
        appSettings,
        activeProject: project,
        agentKind: "system",
        routingSurface: "agent",
        capabilityGrants: [
          editorGrant({
            runId: input.run.id,
            label: input.label,
            model: input.model,
            restrictTo,
            pluginToolDenials,
          }),
        ],
        turnId,
      })
    // First pass learns the runtime lane and the plugin manifest. The Claude
    // Agent SDK auto-approves `allowedTools`, so there writers stay out of the
    // allow list and ask the responder; the AI-SDK lane treats it as the
    // visible set, so writers must be in it (and still ask: the mode is default).
    const probe = await resolve(withAliases(EDITOR_READ_TOOLS), [])
    const sdkLane = probe.execution?.runtimeAdapter === "claude-agent-sdk"
    const restrictTo = sdkLane
      ? withAliases(EDITOR_READ_TOOLS)
      : withAliases([...EDITOR_READ_TOOLS, ...EDITOR_WRITE_TOOLS])
    // An editor needs no plugin tool at all, skills and web included.
    const pluginDenials = (probe.pluginTools ?? []).flatMap((t) => [
      t.name,
      `mcp__cognia-plugin-tools__${t.name}`,
    ])
    const resolved = await resolve(restrictTo, pluginDenials)
    const options: SendOptions = { ...resolved, turnId: resolved.turnId ?? turnId }
    if (options.turnId) d.claimTurnUsage(session.id, options.turnId)
    let streamed: UsageInfo | undefined
    let result: RunAndCaptureResult | undefined
    const book = () =>
      bookProbeUsage(result?.usage ?? streamed, {
        operationId: `harness:${input.run.id}:${input.label}:${input.attempt}:${input.call}`,
        runId: input.run.id,
        ...(input.run.projectId ? { projectId: input.run.projectId } : {}),
        options,
        sdkLane,
        deps: d,
      })
    try {
      result = await d.runTurn(session.id, input.prompt, options, {
        signal: input.signal,
        timeoutMs: AGENTIC_EDITOR_TIMEOUT_MS,
        onEvent: (event: CaptureStreamEvent) => {
          if (event.type === "usage" && !event.partial) streamed = event.usage
        },
        onPermissionRequest: (request: PermissionRequestEvent) => {
          const verdict = decideEditorToolCall(request.toolName, request.input, input.root)
          return verdict.allow
            ? { decision: "allow", attribution: { authority: "policy-rule" } }
            : {
                decision: "deny",
                message: verdict.reason,
                attribution: { authority: "policy-deny" },
              }
        },
        execution: {
          kind: "subagent",
          label: `Harness editor ${input.label}`,
          runId: input.run.id,
          taskId: `${input.run.id}:${input.label}`,
          ...(input.run.projectId ? { projectId: input.run.projectId } : {}),
        },
      })
    } catch (error) {
      // Billed calls are booked even when the session failed.
      await book()
      throw error
    }
    const usage = await book()
    if (result.resultSubtype?.startsWith("error")) {
      // Its spend is already booked; the run's ledger reads it from the usage rows.
      throw new Error(`The editor session ended with ${result.resultSubtype}`)
    }
    return { usage }
  } finally {
    await d.deleteSession(session.id).catch(() => undefined)
  }
}
