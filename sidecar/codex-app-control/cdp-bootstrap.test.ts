import assert from "node:assert/strict"
import test from "node:test"

import {
  attachFilesToComposer,
  bootstrapCodexTask,
  buildCodexTaskDeepLink,
  buildCodexThreadDeepLink,
  isComposerSubmitLabel,
  selectCodexRendererTarget,
  submitCodexComposerPrompt,
} from "./cdp-bootstrap.ts"
import type { CdpCommandResult, CdpConnection } from "./cdp-bootstrap.ts"

/** What a fake connection records per command. */
interface CommandParams {
  expression: string
  text?: string
  value?: string
}
interface SentCommand {
  method: string
  params: CommandParams
}

const asParams = (params: Record<string, unknown> | undefined): CommandParams => ({
  expression: "",
  ...(params as Partial<CommandParams> | undefined),
})

/** A CDP connection whose `send` is the test's; the rest are inert. */
function fakeConnection(
  send: (method: string, params: CommandParams) => CdpCommandResult | Promise<CdpCommandResult>
): CdpConnection {
  return {
    send: async (method, params) => send(method, asParams(params)),
    waitForEvent: async () => ({}),
    close() {},
  }
}

test("attachments use Codex renderer host messages without Accessibility", async () => {
  const commands: SentCommand[] = []
  const connection = fakeConnection(async (method, params) => {
    commands.push({ method, params })
    if (method === "Runtime.evaluate" && params.expression.includes("window.postMessage")) {
      return { result: { value: { injected: true, count: 2 } } }
    }
    if (method === "Runtime.evaluate" && params.expression.includes("requiredCounts")) {
      if (params.expression.includes("const expected = [];")) {
        return { result: { value: { ready: true, labels: ["existing.txt"] } } }
      }
      return {
        result: {
          value: {
            ready: true,
            expected: ["proof.txt", "evidence.pdf"],
            attached: ["proof.txt", "evidence.pdf"],
          },
        },
      }
    }
    return {}
  })

  const result = await attachFilesToComposer(
    connection,
    ["/private/tmp/proof.txt", "/private/tmp/evidence.pdf"],
    {
      threadId: "019ff223-2480-7c01-bdb2-6e6305ca8f1c",
      statImpl: async () => ({ isDirectory: () => false }),
    }
  )

  assert.equal(result.method, "renderer-host-message")
  assert.deepEqual(result.files, ["proof.txt", "evidence.pdf"])
  assert.deepEqual(
    commands.map(({ method }) => method),
    ["Runtime.evaluate", "Runtime.evaluate", "Runtime.evaluate"]
  )
  assert.match(commands[1]?.params.expression ?? "", /type: 'add-context-file'/)
  assert.match(commands[1]?.params.expression ?? "", /"fsPath":"\/private\/tmp\/proof.txt"/)
  assert.match(commands[2]?.params.expression ?? "", /const baseline = \["existing.txt"\]/)
})

test("directory attachments preserve Codex trailing-slash semantics", async () => {
  const commands: SentCommand[] = []
  const connection = fakeConnection(async (method, params) => {
    commands.push({ method, params })
    if (params.expression.includes("window.postMessage")) {
      return { result: { value: { injected: true, count: 1 } } }
    }
    return {
      result: {
        value: { ready: true, expected: ["project"], attached: ["project"] },
      },
    }
  })

  await attachFilesToComposer(connection, ["/private/tmp/project"], {
    statImpl: async () => ({ isDirectory: () => true }),
  })

  assert.match(commands[1]?.params.expression ?? "", /"path":"\/private\/tmp\/project\/"/)
})

test("buildCodexTaskDeepLink prepares an App-owned task with Browser context", () => {
  const deepLink = new URL(
    buildCodexTaskDeepLink({
      prompt: "Read the visible verification code.",
      browserUrl: "http://127.0.0.1:4319/browser-target?code=A&B",
      workspace: "/Users/example/My Project",
      nonce: "bootstrap-123",
    })
  )

  assert.equal(deepLink.protocol, "codex:")
  assert.equal(deepLink.host, "new")
  assert.equal(deepLink.searchParams.get("path"), "/Users/example/My Project")
  assert.equal(
    deepLink.searchParams.get("browserUrl"),
    "http://127.0.0.1:4319/browser-target?code=A&B"
  )
  assert.equal(
    deepLink.searchParams.get("prompt"),
    "Read the visible verification code.\n\n[COGNIA_BOOTSTRAP:bootstrap-123]"
  )
})

test("submitCodexComposerPrompt writes a marked follow-up into the App composer", async () => {
  const commands: SentCommand[] = []
  const connection = fakeConnection(async (method, params) => {
    commands.push({ method, params })
    if (method === "Runtime.evaluate" && params.expression.includes("candidates.at(-1)")) {
      return { result: { value: { composerFound: true, empty: true } } }
    }
    if (
      method === "Runtime.evaluate" &&
      params.expression.includes("return { expected, rendered, selected")
    ) {
      return {
        result: {
          value: {
            expected: "019ff223-2480-7c01-bdb2-6e6305ca8f1c",
            rendered: ["019ff223-2480-7c01-bdb2-6e6305ca8f1c"],
            selected: true,
          },
        },
      }
    }
    if (method === "Runtime.evaluate") {
      return { result: { value: { composerFound: true, submitted: true, method: "button" } } }
    }
    return {}
  })

  const result = await submitCodexComposerPrompt(
    {
      prompt: "Continue from Cognia Web",
      nonce: "follow-up-1",
      threadId: "019ff223-2480-7c01-bdb2-6e6305ca8f1c",
    },
    {
      openThread: async (value) => {
        commands.push({ method: "openThread", params: { expression: "", value } })
      },
      waitForRenderer: async () => ({
        id: "codex-renderer",
        webSocketDebuggerUrl: "ws://127.0.0.1/codex-renderer",
      }),
      connect: async () => connection,
    }
  )

  assert.equal(result.submission.submitted, true)
  assert.equal(result.threadId, "019ff223-2480-7c01-bdb2-6e6305ca8f1c")
  assert.equal(
    commands.find((entry) => entry.method === "openThread")?.params.value,
    "codex://threads/019ff223-2480-7c01-bdb2-6e6305ca8f1c"
  )
  assert.equal(
    commands.find((entry) => entry.method === "Input.insertText")?.params.text,
    "Continue from Cognia Web\n\n[COGNIA_BOOTSTRAP:follow-up-1]"
  )
})

test("follow-up preserves plugin mentions and refocuses after native attachments", async () => {
  const order: string[] = []
  let focusCount = 0
  const connection = fakeConnection(async (method, params) => {
    if (method === "Runtime.evaluate" && params.expression.includes("candidates.at(-1)")) {
      focusCount += 1
      assert.match(params.expression, /plugin-mention-name/)
      order.push(`focus:${focusCount}`)
      return { result: { value: { composerFound: true, empty: true, hasPluginMention: true } } }
    }
    if (
      method === "Runtime.evaluate" &&
      params.expression.includes("return { expected, rendered, selected")
    ) {
      return { result: { value: { selected: true } } }
    }
    if (method === "Input.insertText") order.push("insert")
    if (method === "Runtime.evaluate") {
      return { result: { value: { composerFound: true, submitted: true } } }
    }
    return {}
  })

  await submitCodexComposerPrompt(
    {
      prompt: "Use the selected Browser plugin",
      nonce: "plugin-follow-up",
      threadId: "019ff223-2480-7c01-bdb2-6e6305ca8f1c",
      filePaths: ["/private/tmp/proof.txt"],
    },
    {
      openThread: async () => {},
      waitForRenderer: async () => ({ id: "renderer", webSocketDebuggerUrl: "ws://renderer" }),
      connect: async () => connection,
      attachFiles: async () => {
        order.push("attach")
        return { files: ["proof.txt"], method: "renderer-host-message" as const }
      },
    }
  )

  assert.deepEqual(order, ["focus:1", "attach", "focus:2", "insert"])
})

test("thread deep links reject ambiguous ids", () => {
  assert.equal(
    buildCodexThreadDeepLink("019ff223-2480-7c01-bdb2-6e6305ca8f1c"),
    "codex://threads/019ff223-2480-7c01-bdb2-6e6305ca8f1c"
  )
  assert.throws(() => buildCodexThreadDeepLink("../../new"), /threadId is invalid/)
})

test("composer submit labels do not confuse environment controls with Queue", () => {
  assert.equal(isComposerSubmitLabel("Send"), true)
  assert.equal(isComposerSubmitLabel("Queue"), true)
  assert.equal(isComposerSubmitLabel("Select where to run the chat"), false)
  assert.equal(isComposerSubmitLabel("Set up local environment"), false)
})

test("selectCodexRendererTarget ignores Browser pages and DevTools targets", () => {
  const selected = selectCodexRendererTarget([
    {
      id: "browser-page",
      type: "page",
      title: "Verification",
      url: "http://127.0.0.1:4319/browser-target",
      webSocketDebuggerUrl: "ws://127.0.0.1/browser-page",
    },
    {
      id: "devtools",
      type: "page",
      title: "DevTools",
      url: "devtools://devtools/bundled/inspector.html",
      webSocketDebuggerUrl: "ws://127.0.0.1/devtools",
    },
    {
      id: "codex-renderer",
      type: "page",
      title: "Codex",
      url: "app://-/",
      webSocketDebuggerUrl: "ws://127.0.0.1/codex-renderer",
    },
  ])

  assert.equal(selected?.id, "codex-renderer")
})

test("bootstrapCodexTask opens the native route and submits the focused composer", async () => {
  const opened: string[] = []
  const commands: SentCommand[] = []
  const connection = fakeConnection(async (method, params) => {
    commands.push({ method, params })
    if (method === "Runtime.evaluate") {
      return {
        result: {
          value: {
            composerFound: true,
            promptMatched: true,
            submitted: true,
            method: "button",
          },
        },
      }
    }
    return {}
  })

  const result = await bootstrapCodexTask(
    {
      prompt: "Use the open Browser page.",
      browserUrl: "http://127.0.0.1:4319/browser-target",
      workspace: "/Users/example/project",
      nonce: "bootstrap-456",
    },
    {
      openDeepLink: async (value) => {
        opened.push(value)
      },
      waitForRenderer: async () => ({
        id: "codex-renderer",
        webSocketDebuggerUrl: "ws://127.0.0.1/codex-renderer",
      }),
      connect: async () => connection,
    }
  )

  assert.equal(opened.length, 1)
  assert.match(opened[0] ?? "", /^codex:\/\/new\?/)
  assert.deepEqual(
    commands.map((entry) => entry.method),
    ["Runtime.enable", "Runtime.evaluate"]
  )
  assert.equal(result.submission.method, "button")
  assert.equal(result.rendererId, "codex-renderer")
})
