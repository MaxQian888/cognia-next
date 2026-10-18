import type { SessionCreateOptions } from "@cognia/agent-contracts/adapter"
import type {
  AcpConfigOption,
  ExternalAgentConfig,
  AcpPermissionMode,
  ExternalAgentSession,
  ExternalAgentMessage,
  ExternalAgentExecutionOptions,
  ExternalAgentEvent,
} from "@cognia/agent-contracts/external-agent"
import type { AcpClientAdapter } from "./client"
import { IsolatedAcpAdapter } from "./isolated-adapter"

const SUPPORTED_PERMISSION_MODES: readonly AcpPermissionMode[] = [
  "default",
  "plan",
  "bypassPermissions",
]

/**
 * MiniMax's permissionMode config option affects the entire process, while
 * session/set_mode controls Plan separately. Each conversation owns a process.
 * Native Default preapproves some operations without consulting ACP. It cannot
 * implement edit-only, deny-unapproved or mandatory host approval policies.
 */
export class MiniMaxAcpAdapter extends IsolatedAcpAdapter {
  protected override readonly isolationId = "minimax-code"
  protected override readonly label = "MiniMax Code"
  private readonly modeChanges = new Map<string, Promise<void>>()
  private readonly activePrompts = new Map<string, symbol>()

  override get capabilities() {
    return {
      ...super.capabilities,
      permissionModes: [...SUPPORTED_PERMISSION_MODES],
    }
  }

  override async connect(config: ExternalAgentConfig): Promise<void> {
    if (config.requireApprovalFor?.length)
      throw new Error(
        "MiniMax ACP cannot enforce requireApprovalFor: native tools can bypass ACP approval"
      )
    this.assertMode(config.defaultPermissionMode ?? "default")
    await super.connect(config)
  }

  private assertMode(mode: AcpPermissionMode): void {
    if (!SUPPORTED_PERMISSION_MODES.includes(mode))
      throw new Error(`MiniMax ACP cannot enforce ${mode}; use default, plan or bypassPermissions`)
  }

  protected override processConfig(
    suffix: string,
    options?: SessionCreateOptions
  ): ExternalAgentConfig {
    this.assertMode(options?.permissionMode ?? this._config?.defaultPermissionMode ?? "default")
    return super.processConfig(suffix, options)
  }

  protected override async prepareSession(
    child: AcpClientAdapter,
    session: ExternalAgentSession,
    options?: SessionCreateOptions
  ): Promise<void> {
    this.activePrompts.delete(session.id)
    await this.applyMode(
      child,
      session.id,
      options?.permissionMode ?? this._config?.defaultPermissionMode ?? "default"
    )
  }

  private async applyMode(
    child: AcpClientAdapter,
    sessionId: string,
    mode: AcpPermissionMode
  ): Promise<void> {
    this.assertMode(mode)
    await child.setConfigOption(
      sessionId,
      "permissionMode",
      mode === "bypassPermissions" ? mode : "default"
    )
    await child.setSessionMode(sessionId, mode === "plan" ? "plan" : "default")
    const session = child.getSession(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)
    session.permissionMode = mode
  }

  override async setSessionMode(sessionId: string, mode: AcpPermissionMode): Promise<void> {
    this.assertMode(mode)
    if (this.activePrompts.has(sessionId))
      throw new Error("Wait for the MiniMax turn to finish before changing permissions")
    const child = this.owner(sessionId)
    const previous = this.modeChanges.get(sessionId)
    const change = (async () => {
      if (previous) await previous
      if (this.getSession(sessionId) === undefined)
        throw new Error(`Session not found: ${sessionId}`)
      try {
        await this.applyMode(child, sessionId, mode)
      } catch (error) {
        // Partial two-axis changes have unknown authority: retire this child.
        await this.dispose(child).catch(() => undefined)
        throw error
      }
    })()
    this.modeChanges.set(sessionId, change)
    try {
      await change
    } finally {
      if (this.modeChanges.get(sessionId) === change) this.modeChanges.delete(sessionId)
    }
  }

  override async disconnect(): Promise<void> {
    try {
      await super.disconnect()
    } finally {
      this.activePrompts.clear()
      this.modeChanges.clear()
    }
  }

  override async setConfigOption(
    sessionId: string,
    configId: string,
    value: string | boolean
  ): Promise<AcpConfigOption[]> {
    if (configId !== "permissionMode") return super.setConfigOption(sessionId, configId, value)
    if (value !== "default" && value !== "bypassPermissions")
      throw new Error(
        "MiniMax Auto cannot enforce Cognia's edit-only permission policy; use the permission mode selector"
      )
    await this.setSessionMode(sessionId, value)
    return this.getConfigOptions(sessionId) ?? []
  }

  override getConfigOptions(sessionId: string): AcpConfigOption[] | undefined {
    // The host's canonical selector owns authority. Do not offer the separate
    // process-wide native control as another route around the broker.
    return super.getConfigOptions(sessionId)?.filter((option) => option.id !== "permissionMode")
  }

  override async *prompt(
    sessionId: string,
    message: ExternalAgentMessage,
    options?: ExternalAgentExecutionOptions
  ): AsyncIterable<ExternalAgentEvent> {
    if (options?.permissionMode) {
      this.assertMode(options.permissionMode)
      while (this.modeChanges.has(sessionId)) await this.modeChanges.get(sessionId)
      if (this.getSession(sessionId)?.permissionMode !== options.permissionMode)
        await this.setSessionMode(sessionId, options.permissionMode)
    }
    while (this.modeChanges.has(sessionId)) await this.modeChanges.get(sessionId)
    if (this.activePrompts.has(sessionId)) throw new Error("A MiniMax turn is already running")
    const token = Symbol(sessionId)
    this.activePrompts.set(sessionId, token)
    try {
      yield* super.prompt(sessionId, message, options)
    } finally {
      if (this.activePrompts.get(sessionId) === token) this.activePrompts.delete(sessionId)
    }
  }
}
