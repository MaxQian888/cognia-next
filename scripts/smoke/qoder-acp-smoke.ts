/** Qoder ACP acceptance through Cognia's real sandbox and adapter.
 * Vendor-specific auth refusal and native flags cannot be verified by other smokes.
 * Requires the official qoder binary on PATH. Default mode never uses saved credentials;
 * --authenticated explicitly opts into the local Qoder CLI login.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { selectCliAgentWorkspace } from "@/cli/src/runtime/external/host-branch"
import { createAcpClientAdapter } from "@/lib/ai/agent/external/integrations/acp"
import { createAgentFromPreset } from "@/lib/ai/agent/external/config/presets"

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function main() {
  const authenticated = process.argv.includes("--authenticated")
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(process.cwd(), ".smoke-qoder-acp-")))
  const configRoot = authenticated
    ? path.join(os.homedir(), ".qoder")
    : path.join(scratch, "qoder-state")
  const config = createAgentFromPreset("qoder", {
    id: `qoder-smoke-${randomUUID()}`,
    process: {
      command: "qoder",
      cwd: scratch,
      env: {
        QODER_CONFIG_DIR: configRoot,
        QODER_PERSONAL_ACCESS_TOKEN: "",
      },
    },
    timeout: 20_000,
    retryConfig: { maxRetries: 0, retryDelay: 0, exponentialBackoff: false },
  })
  check(config, "Missing Qoder preset")
  const adapter = createAcpClientAdapter()
  let sessionId: string | undefined
  // The probe must not inherit a credential from the shell's Qoder environment.
  const previousPat = process.env.QODER_PERSONAL_ACCESS_TOKEN
  process.env.QODER_PERSONAL_ACCESS_TOKEN = ""
  try {
    selectCliAgentWorkspace(scratch)
    await adapter.connect(config)
    const init = adapter.getAcpInitializationMetadata()
    check(init.protocolVersion === 1, "Qoder did not negotiate ACP v1")
    check(init.agentInfo?.name === "qoder-cli", "Unexpected ACP implementation")
    check(
      adapter
        .getAuthMethods()
        .some((method) => ["qodercli-login", "qodercli-login-terminal"].includes(method.id)),
      `No Qoder login method advertised: ${JSON.stringify(adapter.getAuthMethods())}`
    )
    check(fs.existsSync(configRoot), "The sandbox did not provision Qoder's custom state root")
    if (authenticated) {
      const session = await adapter.createSession({ cwd: scratch, mcpServers: [] })
      sessionId = session.id
      await adapter.setSessionMode(sessionId, "default")
      const marker = `QODER_OK_${randomUUID().replaceAll("-", "")}`
      let reply = ""
      let stopReason: string | undefined
      const events: Record<string, number> = {}
      for await (const event of adapter.prompt(
        sessionId,
        {
          id: randomUUID(),
          role: "user",
          content: [{ type: "text", text: `Do not use any tools. Reply with exactly: ${marker}` }],
          timestamp: new Date(),
        },
        { timeout: 120_000 }
      )) {
        events[event.type] = (events[event.type] ?? 0) + 1
        if (event.type === "message_delta" && event.delta.type === "text") reply += event.delta.text
        if (event.type === "done") stopReason = event.stopReason
        if (event.type === "permission_request") {
          await adapter.respondToPermission(sessionId, {
            requestId: event.request.requestId ?? event.request.id,
            granted: false,
            scope: "once",
          })
        }
      }
      check(reply.trim() === marker, `Unexpected Qoder model reply: ${reply}`)
      check(stopReason === "end_turn", `Unexpected Qoder stop reason: ${stopReason}`)
      const models = adapter.getSessionModels(sessionId)
      check(
        (await adapter.listSessions({ cwd: scratch })).some(
          (entry) => entry.sessionId === sessionId
        ),
        "Qoder omitted the saved smoke session"
      )
      await adapter.disconnect()
      await adapter.connect(config)
      await adapter.loadSession(sessionId, { cwd: scratch })
      await adapter.deleteSession(sessionId)
      check(
        !(await adapter.listSessions({ cwd: scratch })).some(
          (entry) => entry.sessionId === sessionId
        ),
        "Qoder did not delete the smoke session"
      )
      sessionId = undefined
      console.log(
        JSON.stringify(
          {
            ok: true,
            version: init.agentInfo?.version,
            protocolVersion: init.protocolVersion,
            sandboxedConnection: true,
            cliLogin: true,
            authenticatedModelCalls: true,
            reply,
            events,
            stopReason,
            models,
            defaultPermissionMode: true,
            list: true,
            reconnectLoad: true,
            delete: true,
            nativeEditsAndMcpCalls: "not tested",
          },
          null,
          2
        )
      )
      return
    }
    let refused = false
    try {
      await adapter.createSession({ cwd: scratch, mcpServers: [] })
    } catch (error) {
      refused = /Authentication required/i.test(
        error instanceof Error ? error.message : String(error)
      )
    }
    check(refused, "Qoder must refuse a new session without authentication")
    await adapter.disconnect()
    await adapter.connect(config)
    check(adapter.getAcpInitializationMetadata().protocolVersion === 1, "Qoder failed to reconnect")
    console.log(
      JSON.stringify(
        {
          ok: true,
          version: init.agentInfo?.version,
          protocolVersion: init.protocolVersion,
          sandboxedConnection: true,
          customStateRoot: true,
          authenticationRequired: true,
          reconnect: true,
          advertisedCapabilities: init.agentCapabilities,
          authenticatedModelCalls: "not tested",
        },
        null,
        2
      )
    )
  } finally {
    if (sessionId) await adapter.deleteSession(sessionId).catch(() => undefined)
    await adapter.disconnect()
    if (previousPat === undefined) delete process.env.QODER_PERSONAL_ACCESS_TOKEN
    else process.env.QODER_PERSONAL_ACCESS_TOKEN = previousPat
    selectCliAgentWorkspace(process.cwd())
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
