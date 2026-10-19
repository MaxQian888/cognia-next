import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import Ajv2020 from "ajv/dist/2020.js"
import { buildCompanionRequestSchemaContracts } from "../scripts/build/companion-request-schema-contracts.mjs"

const schemas = buildCompanionRequestSchemaContracts()
const ajv = new Ajv2020({ strict: false })
const mutation = {
  groupId: "group",
  expectedVersion: 0,
  ownerId: "runtime",
  leaseDurationMs: 60_000,
}
const start = {
  requestId: "request",
  repositoryId: "repository",
  sourceRoot: "/workspace",
  targetIsNew: true,
  budgetPolicy: {},
  candidates: [{ agentId: "claude" }, { agentId: "claude", model: "model" }],
  ownerId: "runtime",
  leaseDurationMs: 60_000,
}

test("best-of-N allocation contract requires fixed fan-out and valid budgets", () => {
  const validate = ajv.compile(schemas.get("best_of_n_start"))
  assert.equal(validate({ input: start }), true, JSON.stringify(validate.errors))
  for (const n of [0, 1, 5]) {
    assert.equal(
      validate({
        input: { ...start, candidates: Array.from({ length: n }, () => ({ agentId: "claude" })) },
      }),
      false
    )
  }
  assert.equal(validate({ input: { ...start, budgetPolicy: { maxCostUsd: -1 } } }), false)
  assert.equal(validate({ input: { ...start, leaseDurationMs: 0 } }), false)
})

test("selection cannot assert an interactive origin in caller-controlled args", () => {
  const validate = ajv.compile(schemas.get("best_of_n_select"))
  const input = { mutation, candidateId: "candidate", headSha: "head" }
  assert.equal(validate({ input }), true)
  assert.equal(validate({ input, origin: "interactiveUser" }), false)
  assert.equal(validate({ input: { ...input, origin: "interactiveUser" } }), false)
  assert.equal(
    validate({ input: { ...input, mutation: { ...mutation, expectedVersion: -1 } } }),
    false
  )
})

test("candidate cost is nullable and progress is Host service-only", () => {
  const validate = ajv.compile(schemas.get("best_of_n_candidate_progress"))
  const input = {
    mutation,
    candidateId: "candidate",
    status: "running",
    hasChanges: false,
    costUsd: null,
  }
  assert.equal(validate({ input }), true)
  assert.equal(validate({ input: { ...input, costUsd: -1 } }), false)
  const manifest = JSON.parse(
    readFileSync(new URL("./companion-commands.json", import.meta.url), "utf8")
  )
  for (const name of ["best_of_n_candidate_progress", "best_of_n_recover"]) {
    assert.equal(manifest.commands.find((command) => command.name === name).target, "service")
  }
  assert.equal(
    manifest.commands.find((command) => command.name === "best_of_n_select").approval,
    "interactive"
  )
})

test("every best-of-N command has a concrete output schema and registered dispatcher", () => {
  const outputs = JSON.parse(
    readFileSync(new URL("./companion-response-schemas.json", import.meta.url), "utf8")
  )
  const source = readFileSync(
    new URL("../crates/cognia-companion-rpc/src/rpc/filesystem.rs", import.meta.url),
    "utf8"
  )
  for (const name of [...schemas.keys()].filter((name) => name.startsWith("best_of_n_"))) {
    assert.ok(outputs.commands[name], `${name} output`)
    assert.ok(source.includes(`"${name}" =>`), `${name} dispatch`)
  }
  const select = source.split('"best_of_n_select" =>')[1].split('\n        "')[0]
  assert.ok(select.includes("StatusCode::FORBIDDEN"))
  assert.ok(!select.includes("required(&args"))
})
