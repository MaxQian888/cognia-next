/**
 * The ONE Cognia context resolver shared by every TUI backend.
 *
 * Before this module existed, `session-runner.ts` (built-in sidecar) resolved a
 * session's full meaning — project instructions, output style, agent mode,
 * skills, tool policy, plugin/host tool manifests, attachments, twin grounding —
 * while `external-agent-session.ts` independently forwarded a five-field subset
 * of `ResolvedConfig`. Selecting Claude Code or Codex therefore silently changed
 * what the session *meant*, not just how it was transported.
 *
 * So the semantics live here, once, and each backend only translates the result:
 *   - the built-in mapper feeds sidecar `SendOptions`;
 *   - the external mapper feeds ACP/Codex `session/new` + prompt content.
 *
 * Nothing here builds a second prompt stack: `toBuildContext` →
 * `resolveSendOptions` remains the source of truth, and this module is the seam
 * that makes its result reachable from both transports (plus the per-turn work
 * — attachments, twin recall, subagent dispatch context — that used to be
 * trapped inside the built-in runner).
 */

import {
  resolveSendOptions as defaultResolveSendOptions,
  type BuildOptionsContext,
} from "@/lib/claude/build-options"
import type { SendContent, SendOptions, SessionKind, McpServer } from "@cognia/agent-config-types"

import { buildAttachmentContent, type BuiltAttachmentContent } from "./attachments/build"
import { type ResolvedConfig } from "../config/schema"
import { toBuildContext } from "../config/to-build-context"
import { loadMcpServers } from "../mcp/load-mcp-config"
import { applyDisabled, readDisabled, readDisabledTools } from "../mcp/mcp-state"
import { readEnabled } from "../skill/skill-state"
import { ensureCliDb, CliDbSnapshotError } from "../db/bootstrap"
import { ensurePluginRuntime } from "../plugin/plugin-runtime"
import { resolveDevPluginsDir } from "../plugin/dev-plugins"
import { fetchTwinContext as defaultFetchTwinContext } from "../twin/context-client"
import { readToolApprovals } from "./tool-approvals"
import { withCliAutoApprovedTools, withCliDisabledMcpTools } from "./tool-suppression"
import {
  applySubagentModelOverrides,
  discoverDispatchableAgents,
  type AgentSummary,
} from "./discover-agents"
import { withBuiltinAgents } from "./builtin-agents"
import { discoverCustomAgentModes, resolveAgentMode as selectAgentMode } from "../config/agent-mode"
import type { AgentModeConfig } from "@/types/agent/agent-mode"
import { buildCliSubagentToolManifest } from "./subagent-dispatch"
import { buildLoadSkillManifestEntry, type LoadableSkill } from "./skill-load-tool"
import { hashContextVersion } from "./context-version"

/** What the attachment builder did with this turn's `@<path>` references. */
export interface AttachmentSummary {
  /** Images encoded as native blocks. */
  imageCount: number
  /** PDFs sent as native document blocks. */
  documentCount: number
  /** Refs whose extracted text was folded into the prompt. */
  injectedFiles: string[]
  /** Refs that went through OCR (a subset of `injectedFiles`). */
  ocr: string[]
  /** Refs that could not be read/extracted. */
  failed: string[]
  /** `@refs` with an unknown/binary extension — left literal. */
  skipped: string[]
}

/**
 * The backend-neutral meaning of a session.
 *
 * `sendOptions` is the resolved desktop payload and stays the single carrier of
 * prompt/tool/policy truth; the sibling fields are the parts a non-sidecar
 * transport needs to read WITHOUT understanding `SendOptions` (an ACP
 * `session/new` has no field for "the resolved plugin manifest").
 */
export interface ResolvedCliSessionContext {
  sessionId: string
  cwd: string
  /** `/add-dir` roots, already deduped. */
  additionalDirectories: string[]
  /** The full desktop-resolved payload — prompt, tools, policy, MCP, model. */
  sendOptions: SendOptions
  /** The MCP rows the user enabled (`.mcp.json` minus the `/mcp` overlay). */
  mcpServers: McpServer[]
  /** Dispatchable subagents backing `dispatch_agent`. */
  agents: AgentSummary[]
  /** True when the `dispatch_agent` manifest entry was surfaced. */
  subagentToolEnabled: boolean
  /** Skill ids that resolved into the prompt (empty for plain chat). */
  activeSkillIds: string[]
  /** Set when the CLI-local db refused to open with an unsafe snapshot. */
  databaseError: CliDbSnapshotError | null
  /**
   * Hash over every field an external protocol bakes into `session/new`.
   *
   * A change here means the external agent's conversational context no longer
   * matches what Cognia would send, so the protocol session must be recreated
   * rather than silently continued (see ADR-0090 / the external restart path).
   * The built-in backend re-resolves options instead, so it ignores this.
   */
  contextVersion: string
}

/** Everything one turn contributes on top of the session context. */
export interface ResolvedCliTurn {
  /** Wire content for this turn (string, or multimodal blocks). */
  content: SendContent
  /** Attachment report, or null when the prompt referenced no `@<path>`. */
  attachments: AttachmentSummary | null
  /** Per-turn twin RAG recall, already redacted. Belongs to THIS message. */
  dynamicTwinContext?: string
  /**
   * Twin persona/identity, returned only on the first grounded turn.
   *
   * Session-stable in meaning but only obtainable once a message exists (the
   * twin bridge scores the message), so each backend places it itself: the
   * built-in path appends it to the cached system prompt, the external path —
   * whose `session/new` already happened — folds it into the turn content.
   */
  stableTwinContext?: string
  /** One-shot notice when twin grounding was requested but unreachable. */
  twinNotice?: string
}

export interface CliContextAssemblerParams {
  config: ResolvedConfig
  sessionId: string
  home: string
  sessionKind?: SessionKind
  now?: () => number
  resolveOptions?: (ctx: BuildOptionsContext) => Promise<SendOptions>
  buildContent?: (
    prompt: string,
    cwd: string
  ) => BuiltAttachmentContent | Promise<BuiltAttachmentContent>
  resolveMcpServers?: () => McpServer[]
  resolveSkillIds?: () => string[]
  resolveLoadableSkills?: (ids: string[]) => Promise<LoadableSkill[]>
  resolveDisabledMcpTools?: () => Set<string>
  ensureDb?: () => Promise<unknown>
  resolveApprovedTools?: () => Set<string>
  loadPluginRuntime?: () => Promise<unknown>
  resolveAgents?: () => Promise<AgentSummary[]>
  resolveAgentMode?: () => Promise<AgentModeConfig | null>
  fetchTwin?: typeof defaultFetchTwinContext
}

export interface CliContextAssembler {
  /** Resolve (and cache) the session-stable context. */
  resolveSession(): Promise<ResolvedCliSessionContext>
  /** Resolve one turn against an already-resolved session context. */
  resolveTurn(prompt: string, session: ResolvedCliSessionContext): Promise<ResolvedCliTurn>
  /** Drop the cached session context so the next resolve re-reads everything. */
  invalidate(): void
  /** The cached context, or null before the first resolve. Never resolves. */
  peek(): ResolvedCliSessionContext | null
  /** Re-read the user's MCP rows / approvals without a full re-resolve. */
  readonly config: ResolvedConfig
  readonly home: string
}

/**
 * Build the shared assembler. Every seam defaults to the same implementation
 * the built-in runner used, so extracting this changed no behavior.
 */
export function createCliContextAssembler(params: CliContextAssemblerParams): CliContextAssembler {
  const now = params.now ?? Date.now
  const { config, home, sessionId } = params
  const resolveOptions = params.resolveOptions ?? defaultResolveSendOptions
  const resolveMcpServers =
    params.resolveMcpServers ??
    (() => applyDisabled(loadMcpServers([config.cwd, home]), readDisabled(home)))
  const resolveSkillIds = params.resolveSkillIds ?? (() => [...readEnabled(home)])
  const skillLoadMode = config.skillLoadMode ?? "name"
  const resolveLoadableSkills =
    params.resolveLoadableSkills ??
    (async (ids: string[]): Promise<LoadableSkill[]> => {
      const { listEnabledSkillsByIds } = await import("@/lib/db/skills")
      const rows = await listEnabledSkillsByIds(ids)
      return rows.map((s) => ({ id: s.id, name: s.name, description: s.description }))
    })
  const resolveDisabledMcpTools = params.resolveDisabledMcpTools ?? (() => readDisabledTools(home))
  const ensureDb = params.ensureDb ?? (() => ensureCliDb())
  const resolveApprovedTools = params.resolveApprovedTools ?? (() => readToolApprovals(home))
  const devPluginsEnabled = config.devPlugins === true
  const pluginToolsEnabled = config.pluginTools === true || devPluginsEnabled
  const devPluginsDir = devPluginsEnabled
    ? (resolveDevPluginsDir(config.devPluginsDir, config.cwd) ?? undefined)
    : undefined
  const loadPluginRuntime =
    params.loadPluginRuntime ?? (() => ensurePluginRuntime({ devPluginsDir }))
  const resolveAgents =
    params.resolveAgents ??
    (async () =>
      applySubagentModelOverrides(
        withBuiltinAgents(await discoverDispatchableAgents([config.cwd, home])),
        config.subagentModels
      ))
  const resolveAgentMode =
    params.resolveAgentMode ??
    (async () =>
      selectAgentMode(config.agentMode, await discoverCustomAgentModes([config.cwd, home])) ?? null)
  const buildContentOverride = params.buildContent
  const fetchTwin = params.fetchTwin ?? defaultFetchTwinContext
  const twinEnabled = config.twin?.enabled === true && !!config.twin.characterId

  let cached: ResolvedCliSessionContext | null = null
  let inflight: Promise<ResolvedCliSessionContext> | null = null
  // The twin persona is emitted ONCE per resolved context; `invalidate` resets
  // it so a rebuilt prompt gets the persona back.
  let twinStableEmitted = false
  let twinNoticeShown = false

  async function build(): Promise<ResolvedCliSessionContext> {
    // Hydrate the in-tree plugin runtime BEFORE resolving options so
    // `buildPluginToolsManifest` (inside `resolveSendOptions`) sees the plugins.
    // Graceful: a failure leaves the manifest empty, chat unaffected.
    if (pluginToolsEnabled) await loadPluginRuntime()
    let ephemeralSkillIds = resolveSkillIds()
    let databaseError: CliDbSnapshotError | null = null
    // The desktop build-options pipeline reads enabled skills from Dexie via
    // `getDb()`, which throws unless the CLI-local db (and its `window` +
    // IndexedDB shims) is open. Plain chat touches no Dexie table, so open it
    // lazily — only when a skill is enabled.
    if (ephemeralSkillIds.length > 0) {
      try {
        await ensureDb()
      } catch (err) {
        // Degrade gracefully: resolve options WITHOUT skills rather than let the
        // build-options Dexie read crash the whole turn. An unsafe snapshot is
        // different in kind — the user's data was moved aside, so degrading
        // silently would read as it having vanished.
        if (err instanceof CliDbSnapshotError) databaseError = err
        ephemeralSkillIds = []
      }
    }
    const agentMode = await resolveAgentMode().catch(() => null)
    const mcpServers = resolveMcpServers()
    const ctx = toBuildContext({
      sessionId,
      config,
      mcpServers,
      ephemeralSkillIds,
      ...(params.sessionKind ? { sessionKind: params.sessionKind } : {}),
      ...(agentMode ? { agentMode } : {}),
      // Live TUI turn: request token-level partials so the deltas keep feeding
      // the idle watchdog through a long single generation (large file write).
      interactive: true,
      now: now(),
    })
    const sendOptions = withCliDisabledMcpTools(
      withCliAutoApprovedTools(await resolveOptions(ctx), resolveApprovedTools()),
      resolveDisabledMcpTools()
    )
    // Surface the `dispatch_agent` (Task) tool so the model can launch a
    // subagent. The CLI's dispatch is ALWAYS its own: a model call round-trips
    // (`plugin_tool_exec` → the CLI handle → `runCliSubagent`) and runs over THIS
    // host's sidecar/provider — so the desktop agent map is dropped and the
    // provider-agnostic plugin tool becomes the single dispatch path.
    const agents = await resolveAgents().catch(() => withBuiltinAgents([]))
    delete sendOptions.agents
    let subagentToolEnabled = false
    const manifest = buildCliSubagentToolManifest(agents)
    if (manifest) {
      sendOptions.pluginTools = [...(sendOptions.pluginTools ?? []), manifest]
      subagentToolEnabled = true
    }
    // Name-only skill loading (progressive disclosure): the prompt carries only
    // the catalog, so the model needs `load_skill` to pull a body on demand.
    if (skillLoadMode === "name" && ephemeralSkillIds.length > 0) {
      const loadable = await resolveLoadableSkills(ephemeralSkillIds).catch(
        (): LoadableSkill[] => []
      )
      sendOptions.pluginTools = [
        ...(sendOptions.pluginTools ?? []),
        buildLoadSkillManifestEntry(loadable),
      ]
    }
    const additionalDirectories = [...new Set(config.additionalRoots ?? [])]
    return {
      sessionId,
      cwd: config.cwd,
      additionalDirectories,
      sendOptions,
      mcpServers,
      agents,
      subagentToolEnabled,
      activeSkillIds: ephemeralSkillIds,
      databaseError,
      contextVersion: hashContextVersion({
        sendOptions,
        cwd: config.cwd,
        additionalDirectories,
        mcpServers,
      }),
    }
  }

  return {
    config,
    home,
    peek() {
      return cached
    },
    invalidate() {
      cached = null
      inflight = null
      twinStableEmitted = false
    },
    async resolveSession() {
      if (cached) return cached
      // Dedupe concurrent first turns: two sends racing the first resolve must
      // not each hydrate the plugin runtime and resolve options.
      if (!inflight) {
        inflight = build().then(
          (ctx) => {
            cached = ctx
            inflight = null
            return ctx
          },
          (err) => {
            inflight = null
            throw err
          }
        )
      }
      return inflight
    },
    async resolveTurn(prompt, session) {
      const sendOptions = session.sendOptions
      let dynamicTwinContext: string | undefined
      let stableTwinContext: string | undefined
      let twinNotice: string | undefined
      // Digital-twin grounding (opt-in): REDACTED context from the running
      // desktop. Unreachable desktop → one notice, turn ungrounded.
      if (twinEnabled) {
        const twin = await fetchTwin({
          characterId: config.twin!.characterId!,
          message: prompt,
          sessionId,
        })
        if (!twin) {
          if (!twinNoticeShown) {
            twinNoticeShown = true
            twinNotice =
              "Twin context unavailable — the Cognia desktop app is not reachable; continuing without it."
          }
        } else if (twin.applied) {
          const stable = twin.applied.stable ?? twin.applied.systemPrompt
          if (!twinStableEmitted && stable) {
            twinStableEmitted = true
            stableTwinContext = stable
          }
          dynamicTwinContext = twin.applied.dynamic
        }
      }
      // Assemble multimodal content: encode `@image` refs, inject text/rich-doc
      // content, and resolve `@*.pdf` per the active model (native block vs OCR).
      const activeProvider = sendOptions.provider ?? config.provider ?? "anthropic"
      const built = await (buildContentOverride
        ? buildContentOverride(prompt, config.cwd)
        : buildAttachmentContent(prompt, config.cwd, {
            provider: activeProvider,
            model: sendOptions.model ?? "",
            isAnthropic: activeProvider === "anthropic",
            anthropicKey: () =>
              config.providers["anthropic"]?.apiKey ?? process.env.ANTHROPIC_API_KEY ?? null,
          }))
      const touched =
        built.imageCount > 0 ||
        built.documentCount > 0 ||
        built.injectedFiles.length > 0 ||
        built.ocr.length > 0 ||
        built.failed.length > 0 ||
        built.skipped.length > 0
      return {
        content: built.content,
        attachments: touched
          ? {
              imageCount: built.imageCount,
              documentCount: built.documentCount,
              injectedFiles: built.injectedFiles,
              ocr: built.ocr,
              failed: built.failed,
              skipped: built.skipped,
            }
          : null,
        ...(dynamicTwinContext ? { dynamicTwinContext } : {}),
        ...(stableTwinContext ? { stableTwinContext } : {}),
        ...(twinNotice ? { twinNotice } : {}),
      }
    },
  }
}

/** Wrap `text` in the `<twin-context>` envelope both backends send. */
export function twinContextBlock(text: string): string {
  return `<twin-context>\n${text}\n</twin-context>`
}

/** Prepend a text block to this turn's content, preserving multimodal shape. */
export function prependTextBlock(content: SendContent, block: string): SendContent {
  if (!block) return content
  return typeof content === "string"
    ? `${block}\n\n${content}`
    : [{ type: "text" as const, text: block }, ...content]
}
