/** Real official Goose + production Cognia ACP/sandbox, with a local deterministic provider.
 * This verifies wire/runtime behavior, not remote-provider model quality or billing.
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import http from "node:http"
import { selectCliAgentWorkspace } from "@/cli/src/runtime/external/host-branch"
import { createAcpClientAdapter } from "@/lib/ai/agent/external/integrations/acp"
import { createAgentFromPreset } from "@/lib/ai/agent/external/config/presets"
import { gooseSessionExtension } from "@cognia/agent-acp/goose-session"

async function main() {
  const root = fs.realpathSync(process.cwd())
  const scratch = path.join(root, ".cache/goose-v156-implementation/workspace")
  fs.mkdirSync(scratch, { recursive: true })
  fs.writeFileSync(path.join(scratch, "boa-output.txt"), "")
  fs.writeFileSync(path.join(scratch, "boa-denied.txt"), "UNCHANGED")
  const skillRoot = path.join(scratch, ".agents/skills/cognia-goose-fixture")
  fs.mkdirSync(skillRoot, { recursive: true })
  fs.writeFileSync(
    path.join(skillRoot, "SKILL.md"),
    "---\nname: cognia-goose-fixture\ndescription: GOOSE_SKILL_DISCOVERY_SENTINEL\n---\nUse only for this local fixture.\n"
  )
  const aliasNames = ["search.docs", "search_docs", `lookup_${"long_".repeat(18)}`]
  const aliasLog = path.join(scratch, "alias-calls.jsonl")
  fs.writeFileSync(aliasLog, "")
  const providerRequests: Record<string, unknown>[] = []
  const mcpRequests: unknown[] = []
  let resumeReady = false
  let codeModeChildFinalUnavailable = false
  let activeChildren = 0
  let peakChildren = 0
  let parallelChildren = 0
  let cancelStarted: (() => void) | undefined
  let releaseCancelled: (() => void) | undefined
  const server = http.createServer(async (req, res) => {
    if (req.url === "/mcp") {
      if (req.method !== "POST") {
        res.writeHead(405).end()
        return
      }
      let raw = ""
      for await (const chunk of req) raw += chunk
      const request = JSON.parse(raw)
      mcpRequests.push(request)
      fs.writeFileSync(
        path.join(root, ".cache/goose-v156-implementation/mcp-requests.json"),
        JSON.stringify(mcpRequests, null, 2)
      )
      if (!("id" in request)) {
        res.writeHead(202).end()
        return
      }
      if (!["initialize", "tools/list", "tools/call", "ping"].includes(request.method)) {
        res.setHeader("content-type", "application/json")
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32601, message: "Method not found" },
          })
        )
        return
      }
      let result: unknown = {}
      if (request.method === "initialize")
        result = {
          protocolVersion: request.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "alias-fixture", version: "1" },
        }
      if (request.method === "tools/list")
        result = {
          tools: aliasNames.map((name) => ({
            name,
            description: `GOOSE_ALIAS_FIXTURE ${name}`,
            inputSchema: { type: "object", properties: {} },
          })),
        }
      if (request.method === "tools/call") {
        assert(aliasNames.includes(request.params.name))
        fs.appendFileSync(aliasLog, JSON.stringify(request.params.name) + "\n")
        result = { content: [{ type: "text", text: request.params.name }] }
      }
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }))
      return
    }
    if (req.method === "GET") {
      res.setHeader("content-type", "application/json")
      res.end(
        JSON.stringify({
          object: "list",
          data: [{ id: "cognia-goose-fixture", object: "model", owned_by: "fixture" }],
        })
      )
      return
    }
    let raw = ""
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    providerRequests.push(body)
    fs.writeFileSync(
      path.join(root, ".cache/goose-v156-implementation/provider-requests.json"),
      JSON.stringify(providerRequests, null, 2)
    )
    if (req.url?.endsWith("/responses")) {
      const message = {
        type: "message",
        id: "response-message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "GOOSE_RESPONSES_OK", annotations: [] }],
      }
      const response = {
        id: "fixture-responses",
        object: "response",
        status: "completed",
        created_at: 1792886400,
        model: body.model,
        error: null,
        incomplete_details: null,
        instructions: null,
        metadata: {},
        parallel_tool_calls: true,
        temperature: 1,
        top_p: 1,
        tool_choice: "auto",
        tools: [],
        text: { format: { type: "text" } },
        truncation: "disabled",
        output: [message],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120,
          input_tokens_details: { cached_tokens: 10 },
        },
      }
      res.setHeader("content-type", body.stream ? "text/event-stream" : "application/json")
      if (body.stream) {
        let sequence = 0
        for (const event of [
          {
            type: "response.created",
            response: { ...response, output: [], status: "in_progress" },
          },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...message, content: [], status: "in_progress" },
          },
          {
            type: "response.output_text.delta",
            output_index: 0,
            content_index: 0,
            delta: "GOOSE_RESPONSES_OK",
            item_id: "response-message",
            logprobs: [],
          },
          { type: "response.output_item.done", output_index: 0, item: message },
          { type: "response.completed", response },
        ])
          res.write(
            `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: sequence++ })}\n\n`
          )
        res.end()
      } else res.end(JSON.stringify(response))
      return
    }
    const messages = body.messages ?? []
    const textOf = (value: unknown): string =>
      typeof value === "string"
        ? value
        : Array.isArray(value)
          ? value.map((part) => part.text ?? "").join("\n")
          : ""
    const lastUser = messages.findLastIndex((m: { role: string }) => m.role === "user")
    const latestText = textOf(messages[lastUser]?.content)
    const user = JSON.stringify(messages[lastUser]?.content ?? "")
    const outputs = messages.slice(lastUser + 1).filter((m: { role: string }) => m.role === "tool")
    const tools = (body.tools ?? []).map(
      (tool: { function: { name: string } }) => tool.function.name
    )
    let content: string | null = "GOOSE_V156_OK"
    const childRequest =
      tools.length > 0 && textOf(messages[0]?.content).includes("specialized subagent")
    if (childRequest && latestText.includes("[case:parallel-child]") && outputs.length === 0) {
      parallelChildren++
      peakChildren = Math.max(peakChildren, ++activeChildren)
      await new Promise((resolve) => setTimeout(resolve, 100))
      activeChildren--
    }
    if (childRequest && latestText.includes("[case:cancel-child]") && !resumeReady) {
      cancelStarted?.()
      await new Promise<void>((resolve) => {
        releaseCancelled = resolve
      })
    }
    let calls: unknown[] | undefined
    if (tools.length > 0 && latestText.includes("Resume this existing child")) {
      const childId = latestText.match(/"resume":"([^"]+)"/)?.[1]
      assert(childId)
      calls = [
        {
          index: 0,
          id: "resume-child",
          type: "function",
          function: { name: "delegate", arguments: JSON.stringify({ resume: childId }) },
        },
      ]
      content = null
    } else if (tools.length > 0 && childRequest && resumeReady && outputs.length === 0) {
      const final = (body.tools ?? []).find((tool: { function: { name: string } }) =>
        tool.function.name.endsWith("final_output")
      )
      if (!final) {
        codeModeChildFinalUnavailable = true
      } else {
        const finalArgs = Object.fromEntries(
          (final.function.parameters.required ?? []).map((key: string) => [key, "CHILD_RESUMED"])
        )
        calls = [
          {
            index: 0,
            id: "child-final",
            type: "function",
            function: { name: final.function.name, arguments: JSON.stringify(finalArgs) },
          },
        ]
        content = null
      }
    } else if (tools.length > 0 && user.includes("[case:aliases]")) {
      const aliases = (body.tools ?? []).filter((tool: { function: { description?: string } }) =>
        tool.function.description?.includes("GOOSE_ALIAS_FIXTURE")
      )
      if (!aliases.length && !outputs.length) {
        calls = [
          {
            index: 0,
            id: "enable-aliases",
            type: "function",
            function: {
              name: "extensionmanager__manage_extensions",
              arguments: JSON.stringify({ action: "enable", extension_name: "alias-fixture" }),
            },
          },
        ]
      } else if (
        !outputs.some((output: { tool_call_id?: string }) =>
          output.tool_call_id?.startsWith("alias-")
        )
      ) {
        assert.equal(
          aliases.length,
          aliasNames.length,
          "MCP fixture must expose every sanitized alias"
        )
        calls = aliases.map((tool: { function: { name: string } }, index: number) => ({
          index,
          id: `alias-${index}`,
          type: "function",
          function: { name: tool.function.name, arguments: "{}" },
        }))
      }
      if (calls) content = null
    } else if (tools.length > 0 && user.includes("[case:parallel]") && outputs.length === 0) {
      calls = [0, 1].map((index) => ({
        index,
        id: `parallel-${index}`,
        type: "function",
        function: {
          name: "delegate",
          arguments: JSON.stringify({
            instructions: `[case:parallel-child] Task ${index}`,
            max_turns: 2,
          }),
        },
      }))
      content = null
    } else if (tools.length > 0 && user.includes("[case:cancel]") && outputs.length === 0) {
      calls = [
        {
          index: 0,
          id: "cancel-child",
          type: "function",
          function: {
            name: "delegate",
            arguments: JSON.stringify({
              instructions: "[case:cancel-child] Wait for cancellation.",
              max_turns: 2,
            }),
          },
        },
      ]
      content = null
    } else if (
      tools.length > 0 &&
      (user.includes("[case:delegate-fail]") || user.includes("[case:delegate-safe-child]")) &&
      outputs.length === 0
    ) {
      calls = [
        {
          index: 0,
          id: "create-child",
          type: "function",
          function: {
            name: "delegate",
            arguments: JSON.stringify({
              instructions: "[case:child] Complete the fixture.",
              max_turns: 1,
              ...(user.includes("[case:delegate-safe-child]") ? { extensions: ["developer"] } : {}),
            }),
          },
        },
      ]
      content = null
    } else if (tools.length > 0 && user.includes("[case:boa-limit]") && outputs.length === 0) {
      calls = [
        {
          index: 0,
          id: "boa-limit",
          type: "function",
          function: {
            name: tools.find((name: string) => name.endsWith("execute_javascript")),
            arguments: JSON.stringify({
              code: "async function run(){ return 'x'.repeat(1000000); }",
            }),
          },
        },
      ]
      content = null
    } else if (tools.length > 0 && user.includes("[case:boa-limit]")) {
      content = JSON.stringify(outputs.map((m: { content: unknown }) => m.content))
    } else if (tools.length > 0 && user.includes("[case:boa-cancel]") && outputs.length === 0) {
      calls = [
        {
          index: 0,
          id: "boa-cancel",
          type: "function",
          function: {
            name: tools.find((name: string) => name.endsWith("execute_javascript")),
            arguments: JSON.stringify({
              code: "async function run(){ return tools.call('shell', {command:'sleep 30'}); }",
            }),
          },
        },
      ]
      content = null
    } else if (tools.length > 0 && user.includes("[case:boa-deny]") && outputs.length === 0) {
      calls = [
        {
          index: 0,
          id: "boa-denied",
          type: "function",
          function: {
            name: tools.find((name: string) => name.endsWith("execute_javascript")),
            arguments: JSON.stringify({
              code: "async function run(){ return tools.call('write', {path:'boa-denied.txt',content:'MUST_NOT_WRITE'}); }",
            }),
          },
        },
      ]
      content = null
    } else if (tools.length > 0 && user.includes("[case:boa]") && outputs.length === 0) {
      calls = [
        {
          index: 0,
          id: "boa-catalog",
          type: "function",
          function: {
            name: tools.find((name: string) => name.endsWith("list_functions")),
            arguments: "{}",
          },
        },
        {
          index: 1,
          id: "boa-details",
          type: "function",
          function: {
            name: tools.find((name: string) => name.endsWith("get_function_details")),
            arguments: JSON.stringify({ functions: ["write"] }),
          },
        },
      ]
      content = null
    } else if (
      tools.length > 0 &&
      user.includes("[case:boa]") &&
      !outputs.some((output: { tool_call_id?: string }) => output.tool_call_id === "boa-call")
    ) {
      const name = tools.find((name: string) => name.endsWith("execute_javascript"))
      assert(name, `Boa tool missing: ${tools.join(",")}`)
      calls = [
        {
          index: 0,
          id: "boa-call",
          type: "function",
          function: {
            name,
            arguments: JSON.stringify({
              code: "async function run(){ const nested = await tools.call('write', { path: 'boa-output.txt', content: 'BOA_NESTED' }); return { answer: 6 * 7, process: typeof process, require: typeof require, nested }; }",
            }),
          },
        },
      ]
      content = null
    } else if (tools.length > 0 && user.includes("[case:boa]"))
      content = JSON.stringify(outputs.map((m: { content: unknown }) => m.content))
    const delta = { role: "assistant", content, ...(calls ? { tool_calls: calls } : {}) }
    const usage = {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 10 },
    }
    res.setHeader("content-type", body.stream ? "text/event-stream" : "application/json")
    if (body.stream) {
      const chunk = (delta: unknown, finish_reason: string | null) => ({
        id: "fixture-response",
        object: "chat.completion.chunk",
        created: 1792886400,
        model: body.model,
        choices: [{ index: 0, delta, finish_reason }],
      })
      res.write(`data: ${JSON.stringify(chunk(delta, null))}\n\n`)
      res.write(
        `data: ${JSON.stringify({ ...chunk({}, calls ? "tool_calls" : "stop"), usage })}\n\n`
      )
      res.end("data: [DONE]\n\n")
    } else
      res.end(
        JSON.stringify({
          id: "fixture-response",
          object: "chat.completion",
          created: 1792886400,
          model: body.model,
          choices: [{ index: 0, message: delta, finish_reason: calls ? "tool_calls" : "stop" }],
          usage,
        })
      )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert(address && typeof address !== "string")
  let adapter = createAcpClientAdapter()
  const config = createAgentFromPreset("goose", {
    id: "goose-v156-local",
    timeout: 45000,
    process: {
      command: "goose",
      args: ["acp", "--with-builtin", "developer,code_execution"],
      cwd: scratch,
      env: {
        GOOSE_PATH_ROOT: path.join(scratch, "state"),
        GOOSE_DISABLE_KEYRING: "1",
        GOOSE_PROVIDER: "openai",
        GOOSE_MODEL: "cognia-goose-fixture",
        GOOSE_CONTEXT_LIMIT: "131072",
        GOOSE_MAX_CONCURRENT_SUBAGENTS: "1",
        GOOSE_TELEMETRY_ENABLED: "false",
        OPENAI_HOST: `http://127.0.0.1:${address.port}`,
        OPENAI_BASE_PATH: "v1/chat/completions",
        OPENAI_API_KEY: "fixture-local-only",
      },
    },
  })!
  // The preset factory selects launch fields; instance approval lists are
  // normally applied by the configuration normalizer, and are explicit here.
  config.requireApprovalFor = ["write"]
  config.autoApprovePatterns = ["execute_javascript"]
  try {
    selectCliAgentWorkspace(scratch)
    await adapter.connect(config)
    let session = await adapter.createSession({ cwd: scratch })
    const events: Record<string, unknown>[] = []
    let denyBoa = false
    let cancelBoa = false
    async function prompt(text: string) {
      let output = ""
      for await (const event of adapter.prompt(session.id, {
        id: crypto.randomUUID(),
        role: "user",
        content: [{ type: "text", text }],
        timestamp: new Date(),
      })) {
        events.push(event as unknown as Record<string, unknown>)
        if (event.type === "permission_request") {
          await adapter.respondToPermission(session.id, {
            requestId: event.request.requestId ?? event.request.id,
            granted: !(denyBoa && event.request.toolInfo.name === "execute_javascript"),
            scope: "once",
          })
          if (cancelBoa && event.request.toolInfo.name === "execute_javascript") {
            setTimeout(() => {
              void adapter.cancel(session.id)
            }, 250)
          }
        }
        if (event.type === "message_delta" && event.delta.type === "text")
          output += event.delta.text
      }
      return output
    }
    assert.match(await prompt("[case:hello] Reply with the fixture greeting."), /GOOSE_V156_OK/)
    const boa = await prompt("[case:boa] Execute the Boa fixture.")
    assert.match(boa, /42/)
    assert.match(boa, /undefined/)
    assert.equal(fs.readFileSync(path.join(scratch, "boa-output.txt"), "utf8"), "BOA_NESTED")
    fs.writeFileSync(
      path.join(root, ".cache/goose-v156-implementation/boa-events.json"),
      JSON.stringify(events, null, 2)
    )
    assert(
      events.some(
        (event) =>
          event.type === "permission_request" &&
          (event.request as { toolInfo?: { name?: string } })?.toolInfo?.name ===
            "execute_javascript"
      ),
      "Boa batch mutation must reach Cognia approval"
    )
    assert(events.some((event) => event.type === "permission_request"))
    denyBoa = true
    await prompt("[case:boa-deny] Try the denied fixture batch.")
    assert.equal(fs.readFileSync(path.join(scratch, "boa-denied.txt"), "utf8"), "UNCHANGED")
    denyBoa = false
    cancelBoa = true
    const cancelAt = Date.now()
    await prompt("[case:boa-cancel] Run the slow fixture then stop it.")
    assert(Date.now() - cancelAt < 10000, "Cancelling Boa must terminate the turn promptly")
    cancelBoa = false
    assert.match(
      await prompt("[case:hello] Confirm the session remains responsive after cancellation."),
      /GOOSE_V156_OK/
    )
    const bounded = await prompt("[case:boa-limit] Return the oversized fixture result.")
    assert(bounded.length < 100000, "Boa must bound a one-million-character return value")
    const codeModeControls = gooseSessionExtension.resolve(adapter)
    assert(
      codeModeControls,
      `Native Goose controls unavailable: ${JSON.stringify(adapter.getAcpInitializationMetadata().agentInfo)}`
    )
    await prompt("[case:delegate-fail] Create a child while Code Mode is enabled.")
    const [codeModeChild] = await codeModeControls.listChildren(session.id)
    assert(codeModeChild)
    assert.equal((await codeModeControls.inspect(session.id, codeModeChild)).completed, false)
    resumeReady = true
    await prompt(await codeModeControls.recoveryPrompt(session.id, codeModeChild))
    assert.equal((await codeModeControls.inspect(session.id, codeModeChild)).completed, false)
    assert(
      codeModeChildFinalUnavailable,
      "Pin the 1.56 inherited-Code-Mode child final-output limitation"
    )
    resumeReady = false
    await prompt(
      "[case:delegate-safe-child] Create a developer-only child from this Code Mode parent."
    )
    const safeChild = (await codeModeControls.listChildren(session.id)).find(
      (id) => id !== codeModeChild
    )
    assert(safeChild)
    assert.equal((await codeModeControls.inspect(session.id, safeChild)).completed, false)
    resumeReady = true
    await prompt(await codeModeControls.recoveryPrompt(session.id, safeChild))
    assert.equal((await codeModeControls.inspect(session.id, safeChild)).completed, true)
    resumeReady = false
    await adapter.disconnect()
    adapter = createAcpClientAdapter()
    await adapter.connect({ ...config, requireApprovalFor: undefined, autoApprovePatterns: [] })
    const legacy = await adapter.createSession({ cwd: scratch })
    await adapter.setSessionMode(legacy.id, "bypassPermissions")
    await adapter.disconnect()
    adapter = createAcpClientAdapter()
    await adapter.connect(config)
    session = await adapter.loadSession(legacy.id, {
      cwd: scratch,
      permissionMode: "bypassPermissions",
    })
    const beforeReload = events.length
    denyBoa = true
    await prompt("[case:boa-deny] The restored legacy-auto session must require batch review.")
    assert(
      events.slice(beforeReload).some((event) => event.type === "permission_request"),
      "Reloading legacy auto must restore mandatory approvals"
    )
    assert.equal(fs.readFileSync(path.join(scratch, "boa-denied.txt"), "utf8"), "UNCHANGED")
    denyBoa = false
    // Exercise delegation independently of the opt-in Code Mode process.
    await adapter.disconnect()
    adapter = createAcpClientAdapter()
    await adapter.connect({
      ...config,
      id: "goose-v156-children",
      process: {
        ...config.process!,
        args: ["acp", "--with-builtin", "developer"],
        env: { ...config.process!.env, GOOSE_PATH_ROOT: path.join(scratch, "child-state") },
      },
    })
    session = await adapter.createSession({
      cwd: scratch,
      mcpServers: [
        {
          name: "alias-fixture",
          type: "http",
          url: `http://127.0.0.1:${address.port}/mcp`,
          headers: [],
        },
      ],
    })
    const controls = gooseSessionExtension.resolve(adapter)
    assert(controls)
    assert.deepEqual(await controls.listChildren(session.id), [])
    await prompt("[case:delegate-fail] Create the fixture child and report its outcome.")
    const children = await controls.listChildren(session.id)
    assert.equal(children.length, 1)
    const child = await controls.inspect(session.id, children[0])
    assert.equal(child.completed, false)
    const recovery = await controls.recoveryPrompt(session.id, child.id)
    resumeReady = true
    await prompt(recovery)
    assert.equal((await controls.inspect(session.id, child.id)).completed, true)
    await assert.rejects(controls.recoveryPrompt(session.id, child.id), /Completed/)
    await prompt("[case:parallel] Delegate both independent fixture tasks together.")
    assert.equal(parallelChildren, 2)
    assert.equal(peakChildren, 1, "GOOSE_MAX_CONCURRENT_SUBAGENTS=1 must serialize native children")
    resumeReady = false
    const started = new Promise<void>((resolve) => {
      cancelStarted = resolve
    })
    const cancelledTurn = prompt("[case:cancel] Delegate the cancellation fixture.")
    await Promise.race([
      started,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Cancelled child did not start")), 15000)
      ),
    ])
    await adapter.cancel(session.id)
    await Promise.race([
      cancelledTurn,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Cancellation did not terminate the parent turn")), 15000)
      ),
    ])
    releaseCancelled?.()
    const cancelledChildren = (await controls.listChildren(session.id)).filter(
      (id) => id !== child.id
    )
    const cancelled = []
    for (const id of cancelledChildren) {
      const candidate = await controls.inspect(session.id, id)
      if (!candidate.completed) cancelled.push(candidate)
    }
    assert.equal(cancelled.length, 1, "Cancelled delegate must remain inspectable")
    resumeReady = true
    await prompt(await controls.recoveryPrompt(session.id, cancelled[0].id))
    assert.equal((await controls.inspect(session.id, cancelled[0].id)).completed, true)
    const beforeAlias = events.length
    await prompt("[case:aliases] Call all three independent fixture tools.")
    assert.deepEqual(
      fs
        .readFileSync(aliasLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .sort(),
      [...aliasNames].sort()
    )
    const aliasApprovals = events
      .slice(beforeAlias)
      .filter((event) => event.type === "permission_request")
    assert(aliasApprovals.length >= aliasNames.length)
    assert(
      providerRequests.some((request) =>
        JSON.stringify(request.messages).includes("GOOSE_SKILL_DISCOVERY_SENTINEL")
      ),
      "Native .agents/skills discovery must reach the provider context"
    )
    const listed = await adapter.listSessions({ cwd: scratch })
    assert(listed.some((row) => row.sessionId === session.id))
    await adapter.disconnect()
    adapter = createAcpClientAdapter()
    await adapter.connect({
      ...config,
      id: "goose-v156-responses",
      process: {
        ...config.process!,
        args: ["acp", "--with-builtin", "developer"],
        env: {
          ...config.process!.env,
          GOOSE_PATH_ROOT: path.join(scratch, "responses-state"),
          OPENAI_BASE_PATH: "v1/responses",
        },
      },
    })
    session = await adapter.createSession({ cwd: scratch })
    assert.match(await prompt("[case:responses] First turn."), /GOOSE_RESPONSES_OK/)
    assert.match(await prompt("[case:responses] Second turn."), /GOOSE_RESPONSES_OK/)
    // Goose also makes title-generation requests without tools; check the two
    // actual conversation turns, whose tool catalogs distinguish that path.
    const responses = providerRequests.filter(
      (request) => "input" in request && Array.isArray(request.tools) && request.tools.length > 0
    )
    assert.equal(responses.length, 2)
    assert(
      responses.every((request) => request.prompt_cache_key === session.id),
      "Responses cache key must remain the owning session ID"
    )
    const report = {
      runtime: "Goose 1.56.0",
      provider: "local deterministic Chat Completions and Responses fixtures",
      connect: true,
      session: true,
      boa: true,
      boaNestedWrite: true,
      boaBatchRejectionPreservesFile: true,
      boaCancellation: true,
      boaOutputBounded: true,
      codeModeParentDeveloperChildRecovery: true,
      knownLimitations: {
        inheritedCodeModeChildFinalOutputUnavailable: codeModeChildFinalUnavailable,
      },
      legacyAutoReloadRequiresApproval: true,
      approval: true,
      passiveExport: true,
      list: true,
      failedChildRecovery: true,
      completedChildRecoveryRefused: true,
      concurrencyLimit: { configured: 1, peak: peakChildren, completedChildren: parallelChildren },
      cancelledChildRecovery: true,
      mcpAliases: { originals: aliasNames, approvals: aliasApprovals.length },
      skillsDiscovery: true,
      responsesSessionCacheKey: true,
      providerRequests: providerRequests.length,
      events: events.map((event) => event.type),
    }
    fs.writeFileSync(
      path.join(root, ".cache/goose-v156-implementation/acceptance.json"),
      JSON.stringify(report, null, 2)
    )
    console.log(JSON.stringify(report))
  } finally {
    releaseCancelled?.()
    await adapter.disconnect()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
