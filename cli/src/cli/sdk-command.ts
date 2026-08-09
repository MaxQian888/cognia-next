/** Typed CLI access to the Claude Agent SDK product surface (ADR-0090 Stage 5). */
import { boolFlag, stringFlag, type ParsedArgs } from "./args"
import type { OutputSink } from "./output"
import type { AgentCapabilitySnapshot } from "@/lib/ai/agent/execution/capability-snapshot"

export const SDK_HELP = `cognia-agent sdk — Claude Agent SDK management

  sdk capabilities [--json]                         capability snapshot
  sdk sessions [--json]                             list native sessions
  sdk info --session <id> [--json]                  inspect one session
  sdk messages --session <id> [--json]              compacted message chain
  sdk subagents --session <id> [--json]              list session subagents
  sdk subagent-messages --session <id> --agent <id> [--json]
  sdk rename --session <id> --title <title>
  sdk tag --session <id> [--tag <tag>]               set or clear a tag
  sdk fork --session <id> [--json]
  sdk delete --session <id> --confirm                irreversible
  sdk settings [--cwd <dir>] [--json]                effective SDK settings
`

interface SdkApi {
  list(): Promise<unknown>
  info(sessionId: string): Promise<unknown>
  messages(sessionId: string): Promise<unknown>
  subagents(sessionId: string): Promise<unknown>
  subagentMessages(sessionId: string, agentId: string): Promise<unknown>
  rename(sessionId: string, title: string): Promise<void>
  tag(sessionId: string, tag: string | null): Promise<void>
  delete(sessionId: string): Promise<void>
  fork(sessionId: string): Promise<unknown>
  settings(cwd?: string): Promise<unknown>
}

export interface SdkCommandDeps {
  out: OutputSink
  buildSnapshot?: () => AgentCapabilitySnapshot
  bootstrap?: () => Promise<{ shutdown(): Promise<void> }>
  api?: SdkApi
}

async function defaultDeps(out: OutputSink): Promise<Required<SdkCommandDeps>> {
  const [runtime, resolver, flags, bootstrap, ipc] = await Promise.all([
    import("@/lib/ai/agent/execution/capability-snapshot"),
    import("@/lib/ai/agent/execution/resolve-agent-execution-spec"),
    import("@/lib/ai/agent/execution/feature-flags"),
    import("../runtime/bootstrap"),
    import("@/lib/claude/ipc"),
  ])
  return {
    out,
    buildSnapshot: () =>
      runtime.buildCapabilitySnapshot(
        resolver.resolveAgentExecutionSpec({
          surface: "cli",
          environment: { isTauri: false, isHeadlessHost: true },
          flags: flags.getAgentExecutionFlags(),
          policy: { executionKind: "agent", runtimePolicy: "claude-agent-sdk" },
          legacy: { providerId: "anthropic", toolsEnabled: true },
        }).spec
      ),
    bootstrap: () => bootstrap.bootstrapSidecar(),
    api: {
      list: () => ipc.listSdkSessions(),
      info: (sessionId) => ipc.getSdkSessionInfo(sessionId),
      messages: (sessionId) => ipc.getSdkSessionMessages(sessionId),
      subagents: (sessionId) => ipc.listSdkSubagents(sessionId),
      subagentMessages: (sessionId, agentId) => ipc.getSdkSubagentMessages(sessionId, agentId),
      rename: ipc.renameSdkSession,
      tag: ipc.tagSdkSession,
      delete: ipc.deleteSdkSession,
      fork: (sessionId) => ipc.forkSdkSession(sessionId),
      settings: (cwd) => ipc.resolveSdkSettings(cwd ? { dir: cwd } : undefined),
    },
  }
}

function emit(out: OutputSink, value: unknown, json: boolean): void {
  if (json) out.json(value)
  else out.write(`${JSON.stringify(value, null, 2)}\n`)
}

export async function sdkCommand(args: ParsedArgs, provided?: SdkCommandDeps): Promise<number> {
  const out = provided?.out
  if (!out) throw new Error("sdkCommand requires an output sink")
  const deps =
    provided.buildSnapshot && provided.bootstrap && provided.api
      ? (provided as Required<SdkCommandDeps>)
      : await defaultDeps(out)
  const verb = args.subcommand ?? args.positionals[0]
  const json = boolFlag(args, "json")
  if (!verb || verb === "help") {
    out.write(SDK_HELP)
    return verb ? 0 : 2
  }
  if (verb === "capabilities") {
    emit(out, deps.buildSnapshot(), json)
    return 0
  }

  const sessionId = stringFlag(args, "session")
  if (
    [
      "info",
      "messages",
      "subagents",
      "subagent-messages",
      "rename",
      "tag",
      "fork",
      "delete",
    ].includes(verb) &&
    !sessionId
  ) {
    out.error(`sdk ${verb}: --session <id> is required\n`)
    return 2
  }
  if (verb === "delete" && !boolFlag(args, "confirm")) {
    out.error("sdk delete: --confirm is required because transcript deletion is irreversible\n")
    return 2
  }
  const title = stringFlag(args, "title")
  if (verb === "rename" && !title) {
    out.error("sdk rename: --title <title> is required\n")
    return 2
  }
  const agentId = stringFlag(args, "agent")
  if (verb === "subagent-messages" && !agentId) {
    out.error("sdk subagent-messages: --agent <id> is required\n")
    return 2
  }

  const sidecar = await deps.bootstrap()
  try {
    switch (verb) {
      case "sessions":
        emit(out, await deps.api.list(), json)
        break
      case "info":
        emit(out, await deps.api.info(sessionId!), json)
        break
      case "messages":
        emit(out, await deps.api.messages(sessionId!), json)
        break
      case "subagents":
        emit(out, await deps.api.subagents(sessionId!), json)
        break
      case "subagent-messages":
        emit(out, await deps.api.subagentMessages(sessionId!, agentId!), json)
        break
      case "rename":
        await deps.api.rename(sessionId!, title!)
        out.write("SDK session renamed.\n")
        break
      case "tag":
        await deps.api.tag(sessionId!, stringFlag(args, "tag") ?? null)
        out.write("SDK session tag updated.\n")
        break
      case "fork":
        emit(out, await deps.api.fork(sessionId!), json)
        break
      case "delete":
        await deps.api.delete(sessionId!)
        out.write("SDK session deleted.\n")
        break
      case "settings":
        emit(out, await deps.api.settings(stringFlag(args, "cwd")), json)
        break
      default:
        out.error(`sdk: unknown operation "${verb}"\n\n${SDK_HELP}`)
        return 2
    }
    return 0
  } catch (error) {
    out.error(`sdk ${verb}: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  } finally {
    await sidecar.shutdown()
  }
}
