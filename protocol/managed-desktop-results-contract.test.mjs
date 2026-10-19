import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
const json = (path) => JSON.parse(read(path))
const prefix = "managed_desktop_results_"

test("results preserve closed authority-free request schemas and private read contract", () => {
  const requests = json("protocol/companion-request-schemas.json").commands
  const responses = json("protocol/companion-response-schemas.json").commands
  for (const [name, schema] of Object.entries(requests).filter(([name]) =>
    name.startsWith(prefix)
  )) {
    assert.equal(schema.additionalProperties, false, name)
    for (const key of ["ownerAccountId", "principalId", "hostId", "path", "base64", "confirmed"])
      assert.equal(key in schema.properties, false, `${name}:${key}`)
  }
  assert.equal(responses[prefix + "read_evidence"].properties.cacheControl.const, "no-store")
  assert.deepEqual(requests[prefix + "approve"].properties.decision.enum, ["approved", "rejected"])
  assert.deepEqual(requests[prefix + "capture"].properties.kind.enum, ["checkpoint", "failure"])
})

test("results routes use existing authenticated transports and cannot create or share", () => {
  const commands = json("protocol/companion-commands.json").commands.filter((x) =>
    x.name.startsWith(prefix)
  )
  assert.equal(commands.length, 9)
  for (const command of commands) {
    assert.deepEqual(command.transports, ["http", "websocket", "webrtc"])
    assert.equal(command.target, "execution")
    assert.equal(command.resource, "sandbox.managed_desktop.result")
    assert.equal(command.idempotency, command.operation === "read" ? "structural" : "required")
    assert.ok(
      read("crates/cognia-companion-rpc/src/managed_desktops.rs").includes(`"${command.name}"`)
    )
    assert.ok(read("crates/cognia-companion-rpc/src/rpc.rs").includes(`"${command.name}"`))
    assert.ok(!/create|share|export/.test(command.name))
  }
  assert.match(
    read("crates/cognia-companion-rpc/src/managed_desktop_results.rs"),
    /PRODUCTION_ACCEPTANCE_ENABLED: bool = false/
  )
})

test("agent and human decisions stay separate and cleanup never embeds artifact bytes", () => {
  const defs = json("protocol/companion-response-schemas.json").$defs
  const properties = defs.ManagedDesktopAcceptanceResult.properties
  assert.ok(properties.agentVerdict && properties.systemOutcome && properties.humanApprovals)
  assert.equal(
    properties.humanApprovals.items.properties.input.properties.expectedRevision.type,
    "integer"
  )
  const artifact = defs.ManagedDesktopEvidenceArtifact.properties
  assert.ok(artifact.sha256 && artifact.bytes && artifact.width && artifact.height)
  assert.equal("base64" in artifact, false)
  assert.equal("url" in artifact, false)
  const receipt = json("protocol/companion-response-schemas.json").commands[
    prefix + "commit_delete"
  ]
  assert.deepEqual(Object.keys(receipt.properties), [
    "operationId",
    "state",
    "cleanupPending",
    "taskIds",
  ])
})

test("private mutation retries bind wire keys without replaying result snapshots", () => {
  const descriptor = read("crates/cognia-companion-contract/src/command_manifest.rs")
  assert.match(
    descriptor,
    /self\.resource == "sandbox\.managed_desktop\.result"[\s\S]*CommandReceiptPolicy::HostSemantic/
  )
  const execution = read("crates/cognia-companion/src/remote_execution.rs")
  const semantic = execution.slice(
    execution.indexOf("async fn execute_host_semantic_request("),
    execution.indexOf("/// Which contract plane")
  )
  assert.match(semantic, /bind_host_semantic_request/)
  assert.match(semantic, /dispatch\.await/)
  assert.doesNotMatch(semantic, /replay_receipt|complete_idempotent_operation/)
  assert.match(semantic, /operation_id: None/)
  const store = read("crates/cognia-companion-security/src/security_store.rs")
  assert.match(store, /AND status != 'host-semantic'/)
  const capture = read("crates/cognia-companion-rpc/src/managed_desktop_results.rs")
  assert.ok(capture.indexOf("s.captured(") < capture.indexOf("service.control_frame("))
  assert.match(capture, /CAPTURE_PUBLICATION\.lock\(\)\.await/)
})
