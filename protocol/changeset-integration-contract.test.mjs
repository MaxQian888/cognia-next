import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import Ajv2020 from "ajv/dist/2020.js"
import { parse as parseYaml } from "yaml"
import { buildCompanionRequestSchemaContracts } from "../scripts/build/companion-request-schema-contracts.mjs"

const check = {
  headSha: "head-1",
  profileId: "unit",
  outcome: "passed",
  tier: null,
  reportDigest: null,
  logTail: null,
  ranAt: 1,
}
const review = {
  headSha: "head-1",
  verdict: "approve",
  reviewer: "agent",
  riskTier: "low",
  reasons: [],
  findings: [{ path: "src/example.rs", severity: "info", note: "Reviewed" }],
  requiresHumanApproval: false,
  recordedAt: 1,
}
const requests = {
  task_workspace_changeset_get: { changesetId: "change-1" },
  task_workspace_changeset_list: { filter: {} },
  task_workspace_changeset_eligibility: { changesetId: "change-1" },
  task_workspace_changeset_capture: { input: { workspaceId: "workspace-1", title: "Change" } },
  task_workspace_changeset_mark_ready: { changesetId: "change-1" },
  task_workspace_changeset_record_review: { changesetId: "change-1", review },
  task_workspace_changeset_record_check: { changesetId: "change-1", check },
  task_workspace_changeset_approve: {
    changesetId: "change-1",
    headSha: "head-1",
    approver: "user-1",
  },
  task_workspace_changeset_abandon: { changesetId: "change-1" },
  task_workspace_integration_analyze: { changesetIds: ["change-1"], targetRef: null },
  task_workspace_integration_get: { integrationId: "integration-1" },
  task_workspace_integration_list: { filter: {} },
  task_workspace_integration_prepare: {
    input: {
      changesetIds: ["change-1"],
      targetRef: "refs/heads/main",
      strategy: "merge",
      onConflict: "stop",
    },
  },
  task_workspace_integration_record_check: {
    integrationId: "integration-1",
    candidateSha: "head-1",
    check,
  },
  task_workspace_integration_publish: {
    integrationId: "integration-1",
    candidateSha: "head-1",
    requiredChecks: ["unit"],
  },
  task_workspace_integration_rebuild: { integrationId: "integration-1" },
  task_workspace_integration_drop_item: { integrationId: "integration-1", changesetId: "change-1" },
  task_workspace_integration_abort: { integrationId: "integration-1" },
  task_workspace_integration_rollback: { integrationId: "integration-1" },
}
const reads = new Set([
  "task_workspace_changeset_get",
  "task_workspace_changeset_list",
  "task_workspace_changeset_eligibility",
  "task_workspace_integration_analyze",
  "task_workspace_integration_get",
  "task_workspace_integration_list",
])
const schemas = buildCompanionRequestSchemaContracts()
const ajv = new Ajv2020({
  strict: false,
  formats: { int64: true, uint32: true, uint64: true },
})

function validator(name) {
  assert.ok(schemas.has(name), `${name} has a concrete request schema`)
  return ajv.compile(schemas.get(name))
}

test("ADR-0227 requests admit every fixed TypeScript command argument and reject omissions", () => {
  assert.equal(Object.keys(requests).length, 19)
  const client = readFileSync(new URL("../lib/scm/host.ts", import.meta.url), "utf8")
  const commands = [
    ...client.matchAll(/"(task_workspace_(?:changeset|integration)_[a-z_]+)"/g),
  ].map((match) => match[1])
  assert.deepEqual(commands.sort(), Object.keys(requests).sort())
  for (const [name, body] of Object.entries(requests)) {
    const validate = validator(name)
    assert.equal(validate(body), true, `${name}: ${JSON.stringify(validate.errors)}`)
    assert.equal(validate({ ...body, unknownArgument: true }), false, name)
    for (const key of schemas.get(name).required ?? []) {
      const incomplete = { ...body }
      delete incomplete[key]
      assert.equal(validate(incomplete), false, `${name} requires ${key}`)
    }
  }
})

test("ADR-0227 nested schemas preserve optional/null fields and reject invalid evidence", () => {
  const capture = validator("task_workspace_changeset_capture")
  assert.equal(
    capture({
      input: {
        workspaceId: "workspace-1",
        title: "Change",
        targetRef: null,
        changesetId: null,
        dependsOn: ["change-0"],
        requiredChecks: ["unit"],
      },
    }),
    true
  )
  const list = validator("task_workspace_changeset_list")
  assert.equal(
    list({ filter: { repoCommonDir: null, ownerRef: null, sessionId: null, states: null } }),
    true
  )
  assert.equal(list({ filter: { states: ["changesRequested", "rolledBack"] } }), true)
  assert.equal(list({ filter: { states: ["changes_requested"] } }), false)
  const integrations = validator("task_workspace_integration_list")
  assert.equal(
    integrations({ filter: { repoCommonDir: null, targetRef: null, states: null } }),
    true
  )
  assert.equal(integrations({ filter: { states: ["prepared", "rolledBack"] } }), true)
  assert.equal(integrations({ filter: { states: ["merged"] } }), false)
  const prepare = validator("task_workspace_integration_prepare")
  const input = requests.task_workspace_integration_prepare.input
  for (const provisioning of [
    null,
    {},
    {
      sparsePaths: ["src"],
      cacheLinks: [{ source: "node_modules", target: "node_modules" }],
      include: [".env"],
    },
  ]) {
    assert.equal(prepare({ input: { ...input, provisioning, integrationId: null } }), true)
  }
  assert.equal(
    prepare({ input: { ...input, provisioning: { cacheLinks: [{ source: "node_modules" }] } } }),
    false
  )
  assert.equal(prepare({ input: { ...input, strategy: "squash" } }), false)
  assert.equal(prepare({ input: { ...input, onConflict: "ignore" } }), false)
  const recordReview = validator("task_workspace_changeset_record_review")
  assert.equal(
    recordReview({ changesetId: "change-1", review: { ...review, verdict: "approved" } }),
    false
  )
  assert.equal(
    recordReview({
      changesetId: "change-1",
      review: { ...review, findings: [{ path: "src/a.rs", note: "Missing severity" }] },
    }),
    false
  )
  for (const name of [
    "task_workspace_changeset_record_check",
    "task_workspace_integration_record_check",
  ]) {
    const validate = validator(name)
    assert.equal(validate({ ...requests[name], check: { ...check, outcome: "success" } }), false)
    assert.equal(validate({ ...requests[name], check: { ...check, ranAt: 1.5 } }), false)
  }
})

test("ADR-0227 manifest exposes reads and leased mutations on every remote transport", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("./companion-commands.json", import.meta.url), "utf8")
  )
  for (const name of Object.keys(requests)) {
    const matches = manifest.commands.filter((command) => command.name === name)
    assert.equal(matches.length, 1, name)
    const command = matches[0]
    const read = reads.has(name)
    assert.equal(command.arm, name)
    assert.equal(command.target, "execution")
    assert.equal(command.operation, read ? "read" : "side-effect")
    assert.equal(command.approval, read ? "none" : "interactive")
    assert.equal(command.capability, read ? "host.observe" : "workspace.write")
    assert.equal(command.idempotency, read ? "structural" : "required")
    assert.equal(command.pagination, "none")
    if (name.endsWith("_list")) assert.equal(command.verb, "query")
    assert.deepEqual(command.transports, ["http", "websocket", "webrtc"])
  }
})

test("ADR-0227 published planes require the admin lease only for device mutations", () => {
  const device = parseYaml(
    readFileSync(new URL("../docs/api/mobile-companion-api.openapi.yaml", import.meta.url), "utf8")
  )
  const service = parseYaml(
    readFileSync(new URL("../docs/api/headless-service-api.openapi.yaml", import.meta.url), "utf8")
  )
  for (const [name, body] of Object.entries(requests)) {
    for (const [spec, prefix, needsLease] of [
      [device, "/api/_rpc/", !reads.has(name)],
      [service, "/internal/_rpc/", false],
    ]) {
      const operation = spec.paths[`${prefix}${name}`]?.post
      assert.ok(operation, `${prefix}${name}`)
      const validate = ajv.compile(operation.requestBody.content["application/json"].schema)
      assert.equal(
        validate(body),
        !needsLease,
        `${prefix}${name}: ${JSON.stringify(validate.errors)}`
      )
      if (needsLease) {
        assert.equal(validate({ ...body, adminLease: "lease-1" }), true, name)
        assert.equal(validate({ ...body, adminLease: "" }), false, name)
      }
    }
  }
})

test("ADR-0227 response schemas preserve nullable reads, list arrays, and object eligibility", () => {
  const catalog = JSON.parse(
    readFileSync(new URL("./companion-response-schemas.json", import.meta.url), "utf8")
  )
  for (const name of Object.keys(requests)) {
    assert.ok(catalog.commands[name], `${name} has a concrete response schema`)
  }
  const validateResponse = (name) =>
    ajv.compile({
      ...catalog.commands[name],
      $defs: catalog.$defs,
    })
  for (const name of ["task_workspace_changeset_get", "task_workspace_integration_get"]) {
    assert.equal(validateResponse(name)(null), true, name)
    assert.equal(validateResponse(name)({}), false, name)
  }
  for (const name of ["task_workspace_changeset_list", "task_workspace_integration_list"]) {
    assert.equal(validateResponse(name)([]), true, name)
    assert.equal(validateResponse(name)({ items: [] }), false, name)
  }
  const eligibility = validateResponse("task_workspace_changeset_eligibility")
  assert.equal(eligibility({ eligible: false, gaps: [{ kind: "missingReview" }] }), true)
  assert.equal(eligibility([false, [{ kind: "missingReview" }]]), false)
  assert.equal(
    eligibility({
      eligible: false,
      gaps: [{ kind: "checkNotPassed", profile: "unit", outcome: "failed" }],
    }),
    true
  )
  assert.equal(
    eligibility({
      eligible: false,
      gaps: [{ kind: "checkNotPassed", profile: "unit", outcome: "success" }],
    }),
    false
  )
})
