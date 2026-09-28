import type { HookAudit } from "./kernel/types.ts"
import type { AddressInfo } from "node:net"
import { test } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  mapDecisionToOutput,
  runCommandHandler,
  runGroups,
  runWebhookHandler,
} from "./agent-hooks.ts"
import { nodeCmd } from "../../test-support/hook-command.ts"

test("native handler PermissionRequest denial is enforced before later allows", async () => {
  const groups = [{ hooks: [{ type: "agent" }, { type: "prompt" }] }]
  const decision = await runGroups(groups, null, "{}", undefined, process.cwd(), {
    eventName: "PermissionRequest",
    executeNativeHandler: async (handler) => ({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision:
          handler.type === "agent"
            ? { behavior: "deny", message: "Policy" }
            : { behavior: "allow" },
      },
    }),
  })
  assert.equal(decision.block, "Policy")
  assert.deepEqual(mapDecisionToOutput("PermissionRequest", decision), {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "deny", message: "Policy" },
    },
  })
})

test("plugin and command hooks retain event-specific SDK decisions", async () => {
  const output = {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "deny", message: "No", interrupt: true },
    },
  }
  const command = nodeCmd(
    `process.stdout.write(JSON.stringify(${JSON.stringify(output).replaceAll('"', "'")}))`
  )
  const commandResult = await runCommandHandler(command, 2, "{}", undefined, process.cwd())
  assert.deepEqual(mapDecisionToOutput("PermissionRequest", commandResult), output)
  const pendingPluginHookCalls = new Map()
  const pluginResult = await runGroups(
    [{ hooks: [{ type: "plugin", pluginId: "test", hookId: "guard" }] }],
    null,
    "{}",
    undefined,
    process.cwd(),
    {
      sessionId: "s",
      eventName: "PermissionRequest",
      pendingPluginHookCalls,
      newId: () => "test-call",
      emitRaw: () => pendingPluginHookCalls.get("test-call").resolve({ result: output }),
    }
  )
  assert.deepEqual(mapDecisionToOutput("PermissionRequest", pluginResult), output)
  assert.equal(pendingPluginHookCalls.size, 0)
})

test("malformed and failing hook transports produce bounded warnings", async () => {
  const audits: HookAudit[] = []
  const result = await runGroups(
    [null, {}, { hooks: [null, { type: "plugin" }, { type: "mcp_tool" }] }],
    null,
    "{}",
    undefined,
    undefined,
    { onAudit: (audit) => audits.push(audit) }
  )
  assert.equal(result.warnings.length, 3)
  assert.equal(audits.length, 3)
  assert.match(
    (await runWebhookHandler("http://127.0.0.1:0", undefined, 1, "{}")).warning!,
    /failed/
  )
  assert.match((await runCommandHandler("", 1, "{}", undefined)).warning!, /spawn failed/)
  const controller = new AbortController()
  const pending = runCommandHandler(nodeCmd("setTimeout(()=>{},1000)"), 3, "{}", controller.signal)
  controller.abort()
  assert.equal((await pending).warning!, "hook aborted")
})

test("async command handlers never block and are never awaited", async () => {
  const groups = [
    {
      hooks: [
        // Sleeps far longer than runGroups takes: a runner that awaited this
        // would stall the test, and the exit-2 tail would block if its output
        // were ever observed.
        {
          type: "command",
          command: nodeCmd("setTimeout(()=>process.exit(2),2000)"),
          async: true,
        },
        { type: "command", command: nodeCmd("process.exit(0)") },
      ],
    },
  ]
  const started = Date.now()
  const dec = await runGroups(groups, "Bash", "{}", undefined, process.cwd(), {
    eventName: "PreToolUse",
  })
  assert.equal(dec.block, undefined)
  assert.ok(Date.now() - started < 2000, "async hook must not be awaited")
})

test("a managed async hook can never fail closed into a block", async () => {
  // policyClass "managed" promotes warnings to blocks — but an async handler
  // reports no decision, so even a managed async hook stays non-blocking.
  const dec = await runGroups(
    [
      {
        hooks: [
          {
            type: "command",
            command: nodeCmd("process.exit(2)"),
            async: true,
            policyClass: "managed",
          },
        ],
      },
    ],
    "Bash",
    "{}",
    undefined,
    process.cwd(),
    { eventName: "PreToolUse" }
  )
  assert.equal(dec.block, undefined)
})

test("async exit failures surface through the audit channel, not the decision", async () => {
  const audits: HookAudit[] = []
  const dec = await runGroups(
    [{ hooks: [{ type: "command", command: nodeCmd("process.exit(7)"), async: true }] }],
    "Bash",
    "{}",
    undefined,
    process.cwd(),
    { eventName: "PreToolUse", sessionId: "s", onAudit: (a) => audits.push(a) }
  )
  assert.equal(dec.block, undefined)
  assert.equal(dec.warnings.length, 0)
  // The dispatch audit lands immediately; the detached child's non-zero exit
  // lands a second, diagnostic-only entry once it closes.
  for (let i = 0; i < 50 && !audits.some((a) => a.outcome === "warning"); i++) {
    await new Promise((r) => setTimeout(r, 20))
  }
  const failure = audits.find((a) => a.outcome === "warning")
  assert.ok(failure, "expected an audit entry for the async exit")
  assert.match(failure.error!, /exited with code 7/)
  assert.equal(failure.handlerType, "command")
})

test("async handlers still receive the event payload on stdin", async () => {
  const outFile = join(tmpdir(), `cognia-async-hook-${process.pid}.txt`)
  const helper = join(tmpdir(), `cognia-async-hook-capture-${process.pid}.mjs`)
  writeFileSync(
    helper,
    `import{writeFileSync as w}from"node:fs";let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>w(${JSON.stringify(outFile)},d));`
  )
  try {
    const dec = await runGroups(
      [{ hooks: [{ type: "command", command: `node ${JSON.stringify(helper)}`, async: true }] }],
      "Bash",
      JSON.stringify({ hook_event_name: "PostToolUse", probe: "stdin-pipe" }),
      undefined,
      process.cwd(),
      { eventName: "PostToolUse" }
    )
    assert.equal(dec.block, undefined)
    // The detached child may still be running — poll briefly for its output.
    for (let i = 0; i < 100 && !existsSync(outFile); i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    assert.match(readFileSync(outFile, "utf8"), /stdin-pipe/)
  } finally {
    rmSync(outFile, { force: true })
    rmSync(helper, { force: true })
  }
})

test("runGroups: canonical http handler executes like the legacy webhook alias", async () => {
  let calls = 0
  const server = http.createServer((_req, res) => {
    calls += 1
    res.writeHead(204)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  try {
    const dec = await runGroups(
      [{ hooks: [{ type: "http", url: `http://127.0.0.1:${port}/hook` }] }],
      "",
      "{}"
    )
    assert.equal(dec.block, undefined)
    assert.equal(calls, 1)
  } finally {
    server.close()
  }
})

test("runGroups: executes the canonical http handler spelling", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ additionalContext: "from-http" }))
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const port = (server.address() as AddressInfo).port
  try {
    const decision = await runGroups(
      [{ hooks: [{ type: "http", url: `http://127.0.0.1:${port}/hook` }] }],
      "",
      JSON.stringify({ hook_event_name: "Stop" })
    )
    assert.equal(decision.additionalContext, "from-http")
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test("runGroups: matcher filters, block short-circuits later handlers", async () => {
  const groups = [
    { matcher: "Read", hooks: [{ type: "command", command: nodeCmd("process.exit(2)") }] },
    {
      matcher: "Bash",
      hooks: [
        { type: "command", command: nodeCmd("process.stderr.write('blocked');process.exit(2)") },
        { type: "command", command: nodeCmd("process.stdout.write('should not run')") },
      ],
    },
  ]
  const dec = await runGroups(groups, "Bash", "{}")
  assert.equal(dec.block, "blocked")
  // The second handler (context) must not have run.
  assert.equal(dec.additionalContext, undefined)
})

test("runGroups: missing native adapters warn while unknown handler types stay inert", async () => {
  const dec = await runGroups(
    [
      {
        hooks: [
          { type: "prompt", prompt: "x" },
          { type: "mcp_tool" },
          { type: "agent" },
          { type: "mystery" },
        ],
      },
    ],
    "Bash",
    "{}"
  )
  assert.equal(dec.block, undefined)
  assert.deepEqual(dec.warnings, [
    "hook prompt runtime adapter unavailable",
    "hook mcp_tool runtime adapter unavailable",
    "hook agent runtime adapter unavailable",
  ])
})

test("runGroups: handlers run in parallel but merge deterministically in config order", async () => {
  // The FIRST handler is slow and blocks; the second is fast and allows.
  // Parallel execution + array-order merge ⇒ the slow handler's block wins.
  const groups = [
    {
      hooks: [
        {
          type: "command",
          command: nodeCmd(
            "setTimeout(()=>{process.stderr.write('slow-block');process.exit(2)},300)"
          ),
        },
        {
          type: "command",
          command: nodeCmd("console.log(JSON.stringify({additionalContext:'fast'}))"),
        },
      ],
    },
  ]
  const started = Date.now()
  const dec = await runGroups(groups, "Bash", "{}")
  assert.equal(dec.block, "slow-block")
  // Parallel: total ≈ max(300, fast), well under the serial sum with margin.
  assert.ok(Date.now() - started < 5000)
})

test("runGroups: model-backed handlers use the native adapter and parse decision output", async () => {
  const seen: unknown[] = []
  const dec = await runGroups(
    [{ hooks: [{ type: "prompt", prompt: "review" }] }],
    "",
    '{"hook_event_name":"Stop"}',
    undefined,
    undefined,
    {
      hookDepth: 0,
      executeNativeHandler: async (handler, payload, context) => {
        seen.push({ handler, payload, context })
        return { output: '{"additionalContext":"native"}' }
      },
    }
  )
  assert.equal(dec.additionalContext, "native")
  assert.equal((seen[0] as { context: { depth: number } }).context.depth, 0)
})

test("runGroups: redacts lifecycle payloads before model-backed handlers", async () => {
  let received = ""
  await runGroups(
    [{ hooks: [{ type: "prompt", prompt: "review" }] }],
    "",
    JSON.stringify({ email: "alice@example.com", safe: "ok" }),
    undefined,
    undefined,
    {
      executeNativeHandler: async (_handler, payload) => {
        received = payload
        return { output: "{}" }
      },
    }
  )
  assert.ok(!received.includes("alice@example.com"))
  assert.match(received, /<EMAIL_001>/)
})

test("runGroups: managed hook failures fail closed while user hooks stay open", async () => {
  const executeNativeHandler = async () => ({ warning: "provider unavailable" })
  const managed = await runGroups(
    [{ hooks: [{ type: "agent", prompt: "review", policyClass: "managed" }] }],
    "",
    "{}",
    undefined,
    undefined,
    { executeNativeHandler }
  )
  const user = await runGroups(
    [{ hooks: [{ type: "agent", prompt: "review" }] }],
    "",
    "{}",
    undefined,
    undefined,
    { executeNativeHandler }
  )
  assert.match(managed.block!, /Managed hook failed closed/)
  assert.equal(user.block, undefined)
  assert.deepEqual(user.warnings, ["provider unavailable"])
})

test("runGroups: a crashing native adapter follows the same failure policy", async () => {
  const dec = await runGroups(
    [{ hooks: [{ type: "prompt", prompt: "review" }] }],
    "",
    "{}",
    undefined,
    undefined,
    {
      executeNativeHandler: () => {
        throw new Error("boom")
      },
    }
  )
  assert.deepEqual(dec.warnings, ["hook prompt failed: boom"])
  assert.equal(dec.block, undefined)
})

test("runGroups: the agents selector narrows independently of the matcher", async () => {
  const groups = [
    { matcher: "Bash", agents: "teammate", hooks: [{ type: "command", command: "exit 2" }] },
  ]
  const payload = JSON.stringify({ tool_name: "Bash" })

  // Right tool, right agent → the group runs and its block lands.
  const hit = await runGroups(groups, "Bash", payload, undefined, undefined, {
    eventName: "PreToolUse",
    agentIdentity: { agent_kind: "teammate" },
  })
  assert.equal(typeof hit.block, "string")

  // Right tool, wrong agent → skipped entirely.
  const missAgent = await runGroups(groups, "Bash", payload, undefined, undefined, {
    eventName: "PreToolUse",
    agentIdentity: { agent_kind: "chat" },
  })
  assert.equal(missAgent.block, undefined)

  // Right agent, wrong tool → still skipped; the two selectors are ANDed.
  const missTool = await runGroups(groups, "Read", payload, undefined, undefined, {
    eventName: "PreToolUse",
    agentIdentity: { agent_kind: "teammate" },
  })
  assert.equal(missTool.block, undefined)
})

test("runGroups: agents narrows even the matcher-less events", async () => {
  // hookMatchTarget returns null for UserPromptSubmit, so `matcher` is ignored
  // there — `agents` must still apply or the selector would be silently
  // inert on exactly the events guards care about most.
  const groups = [{ agents: "chat", hooks: [{ type: "command", command: "exit 2" }] }]
  const payload = JSON.stringify({ prompt: "hi" })

  const hit = await runGroups(groups, null, payload, undefined, undefined, {
    eventName: "UserPromptSubmit",
    agentIdentity: { agent_kind: "chat" },
  })
  assert.equal(typeof hit.block, "string")

  const miss = await runGroups(groups, null, payload, undefined, undefined, {
    eventName: "UserPromptSubmit",
    agentIdentity: { agent_kind: "scheduler" },
  })
  assert.equal(miss.block, undefined)
})
