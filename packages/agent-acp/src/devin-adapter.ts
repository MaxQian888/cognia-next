/**
 * Devin reads native MCP configuration once per process. Each conversation
 * therefore owns an ACP transport and an immutable host-prepared configuration.
 * The discovery transport carries no conversation credentials.
 */
import { defineAdapterExtension } from "@cognia/agent-contracts/adapter-extension"
import type { ExternalAgentConfig, AcpConfigOption } from "@cognia/agent-contracts/external-agent"
import type { SessionCreateOptions } from "@cognia/agent-contracts/adapter"
import {
  DEVIN_THOUGHT_LEVEL_OPTION_ID,
  devinModelIdForLevel,
  withDevinThoughtLevelOption,
} from "./devin-model-axis"
import { findModelConfigOption } from "@cognia/agent-runtime-kit/config-options"

import { IsolatedAcpAdapter } from "./isolated-adapter"

/** Devin's native MCP configuration is immutable for the process lifetime. */
export class DevinAcpAdapter extends IsolatedAcpAdapter {
  protected override readonly isolationId = "devin"
  protected override readonly label = "Devin"

  protected override processConfig(
    suffix: string,
    options?: SessionCreateOptions
  ): ExternalAgentConfig {
    const config = super.processConfig(suffix, options)
    return {
      ...config,
      process: {
        ...config.process!,
        env: {
          ...config.process?.env,
          COGNIA_DEVIN_MCP_SERVERS: JSON.stringify(options?.mcpServers ?? []),
        },
      },
    }
  }

  protected override sessionOptions(options?: SessionCreateOptions): SessionCreateOptions {
    return { ...options, mcpServers: [] }
  }

  /**
   * Devin publishes no `thought_level` option — its reasoning ladder lives
   * inside the `model` select's ids (`…-low`, `…-high`, `…-max`). A write to
   * the synthesized axis is therefore a `model` write to the family member
   * carrying that level; every other config id delegates unchanged. The reply
   * re-synthesizes the option so the caller sees model and thinking state
   * agree after the write.
   */
  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string | boolean
  ): Promise<AcpConfigOption[]> {
    const child = this.owner(sessionId)
    if (configId !== DEVIN_THOUGHT_LEVEL_OPTION_ID) {
      return child.setConfigOption(sessionId, configId, value)
    }
    const modelOption = findModelConfigOption(child.getConfigOptions(sessionId))
    const modelId = typeof value === "string" ? devinModelIdForLevel(modelOption, value) : undefined
    if (!modelOption || !modelId) {
      throw new Error(`Devin thinking level '${String(value)}' is not available on this model`)
    }
    await child.setConfigOption(sessionId, modelOption.id, modelId)
    return this.getConfigOptions(sessionId) ?? []
  }
  /**
   * The child's wire options plus the synthesized `thought_level` axis —
   * appended rather than merged into session metadata so the raw list stays
   * exactly what the agent sent (and a genuine `thought_level`, if Devin ever
   * publishes one, wins untouched).
   */
  getConfigOptions(sessionId: string): AcpConfigOption[] | undefined {
    return withDevinThoughtLevelOption(super.getConfigOptions(sessionId))
  }
}

/**
 * Devin's per-conversation processes: the host routes a child process exit
 * here and reconciles the sessions it retired.
 */
export const devinAcpExtension = defineAdapterExtension<DevinAcpAdapter>("acp.devin", (adapter) =>
  adapter instanceof DevinAcpAdapter ? adapter : undefined
)
