/** Official Antigravity ACP through Cognia's real process host and OS sandbox.
 * Default: fresh file-only credential storage, no model prompts or real credentials.
 * --live-provider: explicit opt-in, requires GEMINI_API_KEY in this process.
 * A separate script is needed because generic acp-live bypasses Cognia's host,
 * companion validation, sandbox and native permission-mode reconciliation.
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import {
  installCliExternalAgentHost,
  selectCliAgentWorkspace,
} from "@/cli/src/runtime/external/host-branch"
import { probeRuntimeVersion } from "@/cli/src/runtime/external/version-probe"
import { createAcpClientAdapter } from "@/lib/ai/agent/external/integrations/acp"
import { createAgentFromPreset } from "@/lib/ai/agent/external/config/presets"
import { parseProbeVersion } from "@/lib/ai/agent/external/config/runtime-version"

async function main() {
  const live = process.argv.includes("--live-provider")
  if (live) assert.ok(process.env.GEMINI_API_KEY, "Set GEMINI_API_KEY locally for the live lane")
  const runtimeArgument = process.argv.indexOf("--runtime-dir")
  const runtime = path.resolve(
    runtimeArgument >= 0
      ? process.argv[runtimeArgument + 1]
      : ".cache/antigravity-contract-spike/runtime"
  )
  const output = path.resolve(".cache/gemini-antigravity-cli-audit/antigravity-smoke.json")
  fs.mkdirSync(path.dirname(output), { recursive: true })
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cognia-antigravity-")))
  const geminiHome = path.join(workspace, "gemini-home")
  const oldPath = process.env.PATH
  process.env.PATH = `${runtime}${path.delimiter}${oldPath ?? ""}`
  const uninstall = installCliExternalAgentHost()
  selectCliAgentWorkspace(workspace)
  const adapter = createAcpClientAdapter()
  const result: Record<string, unknown> = { platform: process.platform, liveProvider: live }
  const config = createAgentFromPreset("antigravity-acp", {
    id: `antigravity-smoke-${randomUUID()}`,
    process: {
      command: "agy_acp_server.par",
      args: [],
      cwd: workspace,
      env: {
        GEMINI_HOME: geminiHome,
        AGY_ACP_FORCE_FILE_STORAGE: "1",
        GEMINI_API_KEY: "",
        GOOGLE_API_KEY: "",
      },
    },
    requireApprovalFor: ["*"],
    timeout: 45_000,
    retryConfig: { maxRetries: 0, retryDelay: 0, exponentialBackoff: false },
  })
  assert.ok(config)
  try {
    const probe = await probeRuntimeVersion("antigravity-acp")
    assert.ok(probe.output, probe.detail ?? "Version probe failed")
    assert.equal(parseProbeVersion("antigravity-build-label", probe.output), "1.4.3")
    assert.match(probe.executableDigest ?? "", /^[0-9a-f]{64}$/)
    result.version = "1.4.3"
    result.bundleDigest = probe.executableDigest
    await adapter.connect(config)
    const init = adapter.getAcpInitializationMetadata()
    assert.equal(init.protocolVersion, 1)
    assert.equal(init.agentInfo?.name, "antigravity-acp")
    assert.equal(init.agentInfo?.version, "1.4.3")
    result.initialization = init
    assert.ok(adapter.getAuthMethods().some((method) => method.id === "gemini-api-key"))
    await assert.rejects(adapter.createSession({ cwd: workspace }), /auth|credential|API.key/i)
    result.unauthenticatedSessionRefused = true
    await adapter.disconnect()

    // A synthetic key selects the native BYOK harness, never a model request.
    const settings = path.join(geminiHome, "antigravity-acp", "settings.json")
    fs.mkdirSync(path.dirname(settings), { recursive: true })
    fs.writeFileSync(settings, JSON.stringify({ auth: { type: "gemini-api-key" } }))
    config.process!.env!.GEMINI_API_KEY = live
      ? process.env.GEMINI_API_KEY!
      : "cognia-synthetic-no-inference"
    await adapter.connect(config)
    const session = await adapter.createSession({
      cwd: workspace,
      systemPrompt: "This is a disposable Cognia compatibility check. Never use tools.",
    })
    assert.equal(session.permissionMode, "default")
    await assert.rejects(adapter.setSessionMode(session.id, "plan"), /Plan mode/)
    await adapter.setSessionMode(session.id, "acceptEdits")
    assert.equal(adapter.getSession(session.id)?.permissionMode, "acceptEdits")
    await adapter.setSessionMode(session.id, "default")
    result.localSessionAndModeNegotiation = true
    result.modelOptions = adapter.getSessionModels(session.id)
    const listed = await adapter.listSessions({ cwd: workspace })
    assert.ok(listed.some((entry) => entry.sessionId === session.id))
    result.listed = true

    if (live) {
      const marker = `ANTIGRAVITY_OK_${randomUUID().replaceAll("-", "")}`
      let reply = ""
      for await (const event of adapter.prompt(
        session.id,
        {
          id: randomUUID(),
          role: "user",
          timestamp: new Date(),
          content: [{ type: "text", text: `Do not use tools. Reply exactly: ${marker}` }],
        },
        { timeout: 90_000 }
      )) {
        if (event.type === "message_delta" && event.delta.type === "text") reply += event.delta.text
        if (event.type === "permission_request")
          await adapter.respondToPermission(session.id, {
            requestId: event.request.requestId ?? event.request.id,
            granted: false,
            scope: "once",
          })
        if (event.type === "error") throw new Error(event.error)
      }
      assert.equal(reply.trim(), marker)
      result.authenticatedModelReply = true
    } else result.authenticatedModelReply = "not exercised: no real credential"
    await adapter.disconnect()
    await adapter.connect(config)
    const restored = await adapter.loadSession(session.id, {
      cwd: workspace,
      permissionMode: "dontAsk",
    })
    assert.equal(restored.permissionMode, "dontAsk")
    result.reconnectLoad = live ? "with model history" : "empty session only"
    result.ok = true
  } catch (error) {
    result.ok = false
    result.error = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    await adapter.disconnect()
    selectCliAgentWorkspace(process.cwd())
    uninstall()
    if (oldPath === undefined) delete process.env.PATH
    else process.env.PATH = oldPath
    fs.rmSync(workspace, { recursive: true, force: true })
    fs.writeFileSync(output, JSON.stringify(result, null, 2) + "\n")
    console.log(JSON.stringify(result, null, 2))
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
