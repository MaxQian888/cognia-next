import assert from "node:assert/strict"
import { test } from "node:test"
import { captureClaudeRuntime } from "../../../test-support/claude-runtime.ts"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { buildAnthropicOptions } from "./options.ts"
import { makeLazyLspResolver } from "../../services/lsp/lazy-resolver.ts"
import { createLspResolver } from "../../services/lsp/resolver.ts"
import { withProcessSandbox } from "../../platform/process/exec.ts"
import { createToolSessionContext } from "../../tools/session.ts"
import { createCallLedgerGate } from "../common/call-ledger-gate.ts"
import { createDoomLoopGuard } from "../../policy/doom-loop.ts"
import { createStderrLogSink } from "../../mcp/client/log.ts"

test("nested options and interaction callbacks reach the SDK after the final deny-all clamp", async () => {
  const { options, session, events } = captureClaudeRuntime(
    {
      model: "model",
      fallbackModel: "fallback",
      systemPrompt: "base",
      appendSystemPrompt: "dynamic",
      claudeAgentSdk: {
        version: 1,
        tools: ["Bash"],
        title: "nested title",
        elicitation: { enabled: true },
      },
    },
    () => ({ async *[Symbol.asyncIterator]() {}, interrupt() {}, close() {} })
  )
  assert.equal(options.title, "nested title")
  assert.equal(options.model, "model")
  assert.equal(options.fallbackModel, "fallback")
  assert.deepEqual(options.tools, [])
  assert.deepEqual(options.mcpServers, {})
  assert.equal(options.hooks, undefined)
  assert.equal(typeof options.onElicitation, "function")
  assert.ok(options.systemPrompt)
  assert.equal(
    events.some((event) => event.type === "sdk_option_warning"),
    false
  )
  session.closeInput()
})

test("native PostToolUse starts LSP with host ports before the first tool request", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-native-lsp-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, "tsconfig.json"), "{}")
  const file = path.join(root, "index.ts")
  fs.writeFileSync(file, "const value: number = 'invalid'")
  const sessionId = "native-hook-first"
  const trusted = { COGNIA_PORT: "41010", COGNIA_PORT_COUNT: "10", PORT: "41010" }
  const starts: Record<string, unknown>[] = []
  const hostCalls: string[] = []
  const hostRpc = {
    async call(method: string, params?: unknown) {
      hostCalls.push(method)
      assert.equal(method, "workspace.portEnv")
      assert.deepEqual(params, { cwd: fs.realpathSync(root) })
      return trusted
    },
  }
  const sendOptions = {
    cwd: root,
    lsp: {
      enabled: true,
      servers: [
        {
          id: "typescript",
          languages: ["typescript"],
          extensions: [".ts"],
          command: "typescript-language-server",
          rootMarkers: ["tsconfig.json"],
          env: { PORT: "9999" },
        },
      ],
    },
  }
  const log = () => {}
  const emit = () => {}
  const lsp = makeLazyLspResolver({ sendOptions, log }, async (opts) => {
    const resolver = createLspResolver({
      ...opts,
      diagnosticsWaitMs: 0,
      ensureCommand: (command) => command,
      service: {
        async start(params) {
          starts.push(params)
        },
        didOpen(params) {
          resolver.ingestDiagnostics({
            uri: params.uri,
            diagnostics: [{ message: "type mismatch", severity: 1 }],
          })
        },
        didChange() {},
        async request() {
          return { contents: "hover" }
        },
        stop() {},
      },
    })
    return resolver
  })
  t.after(() => lsp.dispose())
  const toolSession = createToolSessionContext({ sendOptions, sessionId, hostRpc, log })
  t.after(() => toolSession.dispose())
  const options = buildAnthropicOptions({
    sendOptions,
    sessionId,
    hostRpc,
    emit,
    log,
    toolSession,
    mcpStderrSink: createStderrLogSink({ sessionId, emit, source: "stderr" }),
    ledgerGate: createCallLedgerGate({ ledger: null, sessionId, emit }),
    sdkFallbackModel: undefined,
    sdkMaxBudgetUsd: undefined,
    pendingApprovals: new Map(),
    pendingPluginHookCalls: new Map(),
    doomGuard: createDoomLoopGuard(),
    interruptForLedger() {},
    surface: {
      mergedMcpServers: {},
      pluginToolNameAliases: new Map(),
      modelAllowedTools: [],
      disallowed: new Set(),
      lspEnabled: lsp.lspEnabled,
      lspResolver: lsp.lspResolver,
    },
  })
  const hook = options.hooks?.PostToolUse?.[0]?.hooks[0]
  assert.ok(hook)
  assert.equal(starts.length, 0)
  const result = await hook(
    {
      hook_event_name: "PostToolUse",
      session_id: sessionId,
      transcript_path: "",
      cwd: root,
      tool_name: "Write",
      tool_input: { file_path: file },
      tool_response: {},
      tool_use_id: "write-first",
    },
    "write-first",
    { signal: new AbortController().signal }
  )
  assert.ok("hookSpecificOutput" in result)
  assert.equal(result.hookSpecificOutput?.hookEventName, "PostToolUse")
  if (result.hookSpecificOutput?.hookEventName === "PostToolUse")
    assert.match(String(result.hookSpecificOutput.additionalContext), /type mismatch/)
  assert.deepEqual(hostCalls, ["workspace.portEnv"])
  assert.equal(starts.length, 1)
  assert.deepEqual(starts[0]!.env, trusted)
  assert.ok(lsp.lspResolver)
  assert.deepEqual(
    await withProcessSandbox(
      undefined,
      root,
      () => lsp.lspResolver!.request(file, "textDocument/hover"),
      { hostRpc, sessionId }
    ),
    { contents: "hover" }
  )
  assert.equal(starts.length, 1)
})
