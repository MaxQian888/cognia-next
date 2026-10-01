/** Account-free Cline acceptance through the real Cognia adapter and host sandbox.
 * Cline-specific config precedence, authentication refusal and Plan/Act negotiation
 * need a native-process probe. Uses isolated state and never sends a model prompt.
 */
import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { selectCliAgentWorkspace } from "@/cli/src/runtime/external/host-branch"
import { AcpClientAdapter } from "@/lib/ai/agent/external/runtimes/acp/acp-client"
import { createAgentFromPreset } from "@/lib/ai/agent/external/config/presets"

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function main() {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(process.cwd(), ".smoke-cline-acp-")))
  const state = path.join(scratch, "cline-state")
  const config = createAgentFromPreset("cline", {
    id: `cline-smoke-${randomUUID()}`,
    process: {
      command: "cline",
      cwd: scratch,
      args: ["--acp", "--auto-approve", "false", "--config", state],
      env: {
        CLINE_DIR: state,
        CLINE_API_KEY: "",
        CLINE_PROVIDER: "anthropic",
        CLINE_MODEL: "claude-sonnet-4-6",
      },
    },
    timeout: 30_000,
    retryConfig: { maxRetries: 0, retryDelay: 0, exponentialBackoff: false },
  })
  check(config, "Missing Cline preset")
  const adapter = new AcpClientAdapter()
  try {
    selectCliAgentWorkspace(scratch)
    await adapter.connect(config)
    const init = adapter.getAcpInitializationMetadata()
    check(init.protocolVersion === 1, "Cline did not negotiate ACP v1")
    check(
      adapter.getAuthMethods().some((method) => method.id === "cline"),
      "Cline OAuth method missing"
    )
    check(
      adapter.getAuthMethods().some((method) => method.id === "openai-codex"),
      "ChatGPT OAuth method missing"
    )
    let refused = false
    try {
      await adapter.createSession({ cwd: scratch, mcpServers: [] })
    } catch (error) {
      refused = /auth/i.test(error instanceof Error ? error.message : String(error))
    }
    check(refused, "Cline must refuse sessions without authentication")
    await adapter.disconnect()

    // Synthetic key exercises session configuration only: never authenticate or prompt.
    config.process!.env!.CLINE_API_KEY = "synthetic-account-free-cline-fixture"
    await adapter.connect(config)
    const session = await adapter.createSession({ cwd: scratch, mcpServers: [] })
    check(session.permissionMode === "default", "Act must map to Cognia default approvals")
    await adapter.setSessionMode(session.id, "plan")
    check(adapter.getSession(session.id)?.permissionMode === "plan", "Plan negotiation failed")
    await adapter.setSessionMode(session.id, "default")
    check(adapter.getSession(session.id)?.permissionMode === "default", "Act negotiation failed")
    const options = adapter.getConfigOptions(session.id)
    check(
      options?.some((option) => option.id === "auto_approve" && option.currentValue === false),
      "Cline auto-approval is not disabled"
    )
    check(
      options?.some((option) => option.id === "model"),
      "Model selector missing"
    )
    check(fs.existsSync(state), "Sandbox did not provision the selected state root")
    console.log(
      JSON.stringify(
        {
          ok: true,
          version: init.agentInfo?.version,
          protocolVersion: init.protocolVersion,
          sandboxedConnection: true,
          isolatedState: true,
          authenticationRequired: true,
          syntheticSessionConfiguration: true,
          planAct: true,
          approvalsDisabled: true,
          reconnect: true,
          authenticatedModelCalls: "not tested",
          nativeEditsAndMcpCalls: "not tested",
        },
        null,
        2
      )
    )
  } finally {
    await adapter.disconnect()
    selectCliAgentWorkspace(process.cwd())
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
