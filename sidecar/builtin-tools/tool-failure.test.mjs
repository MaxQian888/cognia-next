import assert from "node:assert/strict"
import test from "node:test"

import {
  TOOL_FAILURE_KINDS,
  TOOL_FAILURE_POLICY,
  classifyToolFailure,
  failureMessage,
  renderFailureForModel,
} from "./tool-failure.mjs"
import { toolError, toolText } from "./safety.mjs"

const errno = (code, message = "boom") => Object.assign(new Error(message), { code })

test("every kind has a policy, and every policy names a kind", () => {
  assert.deepEqual(Object.keys(TOOL_FAILURE_POLICY).sort(), [...TOOL_FAILURE_KINDS].sort())
  for (const kind of TOOL_FAILURE_KINDS) {
    const policy = TOOL_FAILURE_POLICY[kind]
    assert.equal(typeof policy.retryable, "boolean")
    assert.ok(policy.guidance.length > 0, `${kind} must say something to the model`)
  }
})

test("errno beats message shape — a full disk is not a tool bug", () => {
  const out = classifyToolFailure(errno("ENOSPC", "write failed: invalid"))
  assert.equal(out.kind, "resource-exhausted")
  assert.equal(out.retryable, false)
  assert.match(out.guidance, /machine limit/)
})

test("classifies the errnos that used to read as generic failures", () => {
  const cases = {
    ENOENT: "not-found",
    EACCES: "permission-denied",
    EPERM: "permission-denied",
    EMFILE: "resource-exhausted",
    ETIMEDOUT: "timeout",
    ECONNREFUSED: "backend-unavailable",
    EISDIR: "invalid-args",
    ENOEXEC: "environment",
  }
  for (const [code, kind] of Object.entries(cases)) {
    assert.equal(classifyToolFailure(errno(code)).kind, kind, code)
  }
})

test("reads an errno through a wrapped cause", () => {
  const wrapped = new Error("open failed", { cause: errno("ENOSPC") })
  assert.equal(classifyToolFailure(wrapped).kind, "resource-exhausted")
})

test("an explicit kind from the caller wins over inference", () => {
  const out = classifyToolFailure(errno("ENOENT"), { kind: "user-rejected" })
  assert.equal(out.kind, "user-rejected")
})

test("ignores a kind that is not in the closed set", () => {
  const out = classifyToolFailure(new Error("nope"), { kind: "made-up" })
  assert.equal(out.kind, "execution-failed")
})

test("an AbortError is aborted, not a generic failure", () => {
  const err = new Error("The operation was aborted")
  err.name = "AbortError"
  const out = classifyToolFailure(err)
  assert.equal(out.kind, "aborted")
  assert.equal(out.retryable, false)
})

test("falls back to message shape when there is no errno", () => {
  assert.equal(classifyToolFailure(new Error("permission denied")).kind, "permission-denied")
  assert.equal(classifyToolFailure(new Error("no such file or directory")).kind, "not-found")
  assert.equal(classifyToolFailure("request timed out").kind, "timeout")
  assert.equal(classifyToolFailure(new Error("command not found: rg")).kind, "environment")
})

test("an unrecognised failure stays retryable rather than pretending to know", () => {
  const out = classifyToolFailure(new Error("something went sideways"))
  assert.equal(out.kind, "execution-failed")
  assert.equal(out.retryable, true)
})

test("the four kinds a model most needs to stop retrying are non-retryable", () => {
  for (const kind of ["invalid-args", "permission-denied", "user-rejected", "resource-exhausted"]) {
    assert.equal(TOOL_FAILURE_POLICY[kind].retryable, false, kind)
  }
})

test("failureMessage strips nothing but the stack", () => {
  assert.equal(failureMessage(new Error("plain")), "plain")
  assert.equal(failureMessage("string"), "string")
  assert.equal(failureMessage(42), "42")
})

test("the model-facing text names the kind and the guidance", () => {
  const failure = classifyToolFailure(errno("EACCES", "cannot open /etc/shadow"))
  const text = renderFailureForModel(failure, "read")
  assert.match(text, /^read: cannot open \/etc\/shadow/)
  assert.match(text, /\[permission-denied\]/)
  assert.match(text, /Only the user can grant this/)
})

test("toolError carries the classification in both channels", () => {
  const result = toolError(errno("ENOSPC", "disk full"), "write")
  assert.equal(result.isError, true)
  // Model channel: prose that says not to retry.
  assert.match(result.content[0].text, /\[resource-exhausted\]/)
  assert.match(result.content[0].text, /retrying will fail the same way/i)
  // Structured channel: typed, for the UI and telemetry.
  assert.deepEqual(result._meta["cognia/failure"], {
    kind: "resource-exhausted",
    retryable: false,
  })
})

test("toolError still accepts a bare string and a caller-known kind", () => {
  const plain = toolError("something broke")
  assert.equal(plain.isError, true)
  assert.equal(plain._meta["cognia/failure"].kind, "execution-failed")

  const known = toolError(new Error("nope"), "tool", { kind: "user-rejected" })
  assert.equal(known._meta["cognia/failure"].kind, "user-rejected")
  assert.equal(known._meta["cognia/failure"].retryable, false)
})

test("a successful toolText carries no failure metadata", () => {
  const ok = toolText({ a: 1 })
  assert.equal(ok.isError, undefined)
  assert.equal(ok._meta, undefined)
})
