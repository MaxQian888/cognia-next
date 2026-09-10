import assert from "node:assert/strict"
import test from "node:test"

import {
  auditContract,
  hasArm,
  resolveVerb,
  scanClientSource,
  wireName,
} from "./check-command-grammar.mjs"

const resources = {
  session: { children: { message: {} } },
  git: {},
  browser: { children: { page: {} } },
}
const verbs = {
  standard: { list: "Page through a collection.", get: "Read one record." },
  custom: {
    send: "Deliver a message.",
    status: "Lifecycle summary.",
    read: "Read bytes.",
    stop: "Halt.",
    cancel: "End.",
  },
  refused: {
    kill: { replacement: "stop", note: "stop with force:true" },
    abort: { replacement: "cancel" },
  },
  exceptions: { git: ["abort"] },
}

function command(overrides = {}) {
  return {
    name: "session.message.send",
    resource: "session.message",
    verb: "send",
    arm: "message_send",
    target: "execution",
    operation: "side-effect",
    capability: "client.write",
    risk: "low",
    approval: "none",
    idempotency: "required",
    transports: ["http", "internal"],
    pagination: "none",
    longRunning: false,
    inputSchema: "#/$defs/X",
    outputSchema: "#/$defs/Y",
    ...overrides,
  }
}

const dispatch = [
  {
    path: "rpc.rs",
    source: `match name {\n  "message_send" => {}\n  "session_list" | "git_status" => {}\n}`,
  },
]

test("a well-formed command passes every rule", () => {
  const { failures } = auditContract({
    commands: [command()],
    resources,
    verbs,
    renames: {},
    dispatchSources: dispatch,
  })
  assert.deepEqual(failures, [])
})

test("R1 reports a name that is not resource.verb until the cut, then fails", () => {
  const legacy = command({ name: "message_send" })
  const before = auditContract({
    commands: [legacy],
    resources,
    verbs,
    renames: {},
    dispatchSources: dispatch,
  })
  assert.equal(before.applied, false)
  assert.ok(before.reports.some((r) => r.startsWith("R1 message_send")))
  assert.deepEqual(before.failures, [])
  // Once the cut is applied (any dotted name exists), a straggler is a failure.
  const after = auditContract({
    commands: [
      command(),
      command({ name: "git_status", resource: "git", verb: "status", arm: "git_status" }),
    ],
    resources,
    verbs,
    renames: {},
    dispatchSources: dispatch,
  })
  assert.ok(after.failures.some((f) => f.startsWith("R1 git_status")))
})

test("R2 refuses an unknown resource, an unknown verb, and a refused verb with its replacement", () => {
  const { failures } = auditContract({
    commands: [
      command({ name: "nope.send", resource: "nope" }),
      command({ name: "session.message.frobnicate", verb: "frobnicate" }),
      command({ name: "session.message.kill", verb: "kill" }),
    ],
    resources,
    verbs,
    renames: {},
    dispatchSources: dispatch,
  })
  assert.ok(failures.some((f) => f.includes('resource "nope" is not in')))
  assert.ok(failures.some((f) => f.includes('verb "frobnicate" is not in')))
  assert.ok(
    failures.some((f) => f.includes('verb "kill" is refused; write "stop" (stop with force:true)'))
  )
})

test("R2 allows a refused verb where the resource registers it as domain vocabulary", () => {
  const { failures } = auditContract({
    commands: [command({ name: "git.abort", resource: "git", verb: "abort", arm: "git_status" })],
    resources,
    verbs,
    renames: {},
    dispatchSources: dispatch,
  })
  assert.deepEqual(failures, [])
})

test("R2 accepts a qualified verb whose head is in the vocabulary", () => {
  assert.equal(resolveVerb(new Set(["read", "list"]), "read_chunk"), "read")
  assert.equal(resolveVerb(new Set(["read", "list"]), "list_pending"), "list")
  assert.equal(resolveVerb(new Set(["read"]), "chunk_read"), null)
})

test("R2 refuses a vocabulary verb without a definition", () => {
  const { failures } = auditContract({
    commands: [],
    resources,
    verbs: { ...verbs, custom: { ...verbs.custom, empty: "" } },
    renames: {},
    dispatchSources: dispatch,
  })
  assert.ok(failures.some((f) => f.includes('verb "empty" has no definition')))
})

test("R3 holds list verbs to page-token pagination and byte-range to read/write", () => {
  const { failures } = auditContract({
    commands: [
      command({
        name: "session.message.list",
        verb: "list",
        arm: "session_list",
        pagination: "none",
      }),
      command({ name: "session.message.send", pagination: "byte-range" }),
    ],
    resources,
    verbs,
    renames: {},
    dispatchSources: dispatch,
  })
  assert.ok(
    failures.some((f) => f.startsWith("R3 session.message.list: list verbs paginate by token"))
  )
  assert.ok(failures.some((f) => f.includes("byte-range pagination belongs to read/write")))
})

test("R4 fails a legacy paging parameter on a page-token command and reports the rest", () => {
  const { failures, reports } = auditContract({
    commands: [
      command({
        name: "session.message.list",
        verb: "list",
        arm: "session_list",
        pagination: "page-token",
      }),
    ],
    resources,
    verbs,
    renames: {},
    requestSchemas: {
      "session.message.list": {
        type: "object",
        additionalProperties: false,
        properties: { limit: {}, session_id: {} },
      },
    },
    dispatchSources: dispatch,
  })
  // Two paging vocabularies on one command is the B3 regression this rule
  // exists to catch, so it is the one R4 finding that fails.
  assert.equal(failures.length, 1)
  assert.ok(failures[0].includes('"limit" is not a paging parameter'))
  assert.ok(reports.some((r) => r.includes('"session_id" is not camelCase')))
  assert.ok(reports.some((r) => r.includes("take pageSize and pageToken")))
})

test("R4 only reports a legacy paging parameter on a command that does not page yet", () => {
  const { failures, reports } = auditContract({
    commands: [command({ name: "session.message.get", verb: "get" })],
    resources,
    verbs,
    renames: {},
    requestSchemas: {
      "session.message.get": {
        type: "object",
        additionalProperties: false,
        properties: { limit: {}, cursor: {} },
      },
    },
    dispatchSources: dispatch,
  })
  assert.deepEqual(failures, [])
  assert.ok(reports.some((r) => r.includes('"limit" is not a paging parameter')))
  assert.ok(reports.some((r) => r.includes('"cursor" is not a paging parameter')))
})

test("R6 requires a unique arm with a dispatch arm in some rpc source", () => {
  const { failures, reports } = auditContract({
    commands: [
      command(),
      command({ name: "session.message.get", verb: "get" }),
      command({
        name: "browser.page.list",
        resource: "browser.page",
        verb: "list",
        arm: "browser_pages",
        pagination: "page-token",
      }),
    ],
    resources,
    verbs,
    renames: {},
    dispatchSources: dispatch,
  })
  assert.ok(
    failures.some((f) => f.includes('arm "message_send" is also the arm of session.message.send'))
  )
  assert.ok(failures.some((f) => f.includes('arm "browser_pages" has no dispatch arm')))
  assert.deepEqual(
    reports.filter((r) => r.startsWith("R6")),
    []
  )
})

test("R6 does not demand a dispatch arm for client-target commands", () => {
  const { failures } = auditContract({
    commands: [
      command({
        name: "session.message.get",
        verb: "get",
        arm: "local_only",
        target: "client",
        transports: ["internal"],
      }),
    ],
    resources,
    verbs,
    renames: {},
    dispatchSources: dispatch,
  })
  assert.deepEqual(failures, [])
})

test("hasArm matches both arm spellings rustfmt produces", () => {
  const src = `"a" => {}\n"b" | "c" => {}\n"d"\n| "e" => {}`
  for (const arm of ["a", "b", "c", "d", "e"]) assert.equal(hasArm(src, arm), true, arm)
  assert.equal(hasArm(src, "f"), false)
  assert.equal(hasArm(`let x = "a";`, "a"), false)
  assert.equal(hasArm(`if name == "browser_session_close" {`, "browser_session_close"), true)
})

test("R7 reports surviving old literals before the cut and fails after it", () => {
  const renames = { message_send: { to: "session.message.send" } }
  const hits = scanClientSource(
    "lib/x.ts",
    `await transport.call("message_send", {})\n// command-rename-exempt:\ninvoke("message_send")\n// command-rename-exempt: dynamic dispatcher\ninvoke("message_send")`,
    new Set(["message_send"])
  )
  assert.equal(hits.length, 3)
  const before = auditContract({
    commands: [command({ name: "message_send" })],
    resources,
    verbs,
    renames,
    dispatchSources: dispatch,
    clientLiteralHits: hits,
  })
  assert.ok(before.reports.some((r) => r.includes("lib/x.ts:1")))
  assert.ok(before.failures.some((f) => f.includes("command-rename-exempt needs a reason")))
  const after = auditContract({
    commands: [command()],
    resources,
    verbs,
    renames,
    dispatchSources: dispatch,
    clientLiteralHits: hits,
  })
  assert.ok(
    after.failures.some((f) =>
      f.includes('"message_send" is a renamed name; use session.message.send')
    )
  )
  assert.equal(after.failures.filter((f) => f.includes("lib/x.ts:5")).length, 0)
})

test("R7 refuses a rename whose target is not a command once the cut is applied", () => {
  const { failures } = auditContract({
    commands: [command()],
    resources,
    verbs,
    renames: { old: { to: "nowhere.get" } },
    dispatchSources: dispatch,
  })
  assert.ok(failures.some((f) => f.includes("target is not a command")))
})

test("R7 holds a pending rename to the command's own resource and verb before the cut", () => {
  const legacy = command({ name: "message_send" })
  const ok = auditContract({
    commands: [legacy],
    resources,
    verbs,
    renames: { message_send: { to: "session.message.send" } },
    dispatchSources: dispatch,
  })
  assert.deepEqual(ok.failures, [])
  const bad = auditContract({
    commands: [legacy],
    resources,
    verbs,
    renames: { message_send: { to: "session.message.deliver" }, ghost: { to: "x.y" } },
    dispatchSources: dispatch,
  })
  assert.ok(bad.failures.some((f) => f.includes("disagrees with resource.verb")))
  assert.ok(bad.failures.some((f) => f.includes("rename ghost: not a command")))
})

test("R8 keeps the policy invariants the Rust loader used to assert", () => {
  const { failures } = auditContract({
    commands: [
      command({
        name: "session.message.get",
        verb: "get",
        arm: "session_list",
        operation: "write",
        idempotency: "structural",
      }),
      command({
        name: "git.status",
        resource: "git",
        verb: "status",
        arm: "git_status",
        target: "service",
        transports: ["http"],
        capability: "",
      }),
    ],
    resources,
    verbs,
    renames: {},
    dispatchSources: dispatch,
  })
  assert.ok(failures.some((f) => f.includes("mutations require idempotency")))
  assert.ok(failures.some((f) => f.includes("service commands are internal-only")))
  assert.ok(failures.some((f) => f.includes("capability is empty")))
})

test("wireName joins with a dot", () => {
  assert.equal(wireName("team.task", "cancel"), "team.task.cancel")
})
