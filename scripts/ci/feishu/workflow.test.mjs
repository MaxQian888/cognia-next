import assert from "node:assert/strict"
import { readFile, readdir } from "node:fs/promises"
import { test } from "node:test"
import { parse } from "yaml"
import { WORKFLOWS } from "./policy.mjs"

const root = new URL("../../../", import.meta.url)
const read = (path) => readFile(new URL(path, root), "utf8")
const load = async () => parse(await read(".github/workflows/feishu-notify.yml"))

test("Feishu covers every source workflow without recursively notifying itself", async () => {
  const workflow = await load()
  const files = await readdir(new URL(".github/workflows/", root))
  const sourceFiles = files.filter((file) => /\.ya?ml$/.test(file) && file !== "feishu-notify.yml")
  assert.deepEqual(Object.keys(WORKFLOWS).sort(), [...sourceFiles].sort())
  const sources = await Promise.all(
    sourceFiles.map(async (file) => parse(await read(`.github/workflows/${file}`)).name)
  )
  assert.deepEqual([...workflow.on.workflow_run.workflows].sort(), sources.sort())
  assert.deepEqual(workflow.on.workflow_run.types, ["completed"])
  assert.equal(workflow.on.push, undefined)
  assert.equal(workflow.on.pull_request_target, undefined)
  assert.equal(workflow.on.schedule[0].cron, "17 1 * * *")
})

test("manual preview is safe by default and automatic delivery is opt-in", async () => {
  const workflow = await load()
  const inputs = workflow.on.workflow_dispatch.inputs
  assert.equal(inputs.run_id.type, "string")
  assert.equal(inputs.run_id.required, false)
  assert.equal(inputs.dry_run.type, "boolean")
  assert.equal(inputs.dry_run.default, true)
  assert.equal(inputs.resend_unknown.default, false)
  const job = workflow.jobs.notify
  assert.match(job.if, /github.event_name == 'workflow_dispatch' && inputs.dry_run/)
  assert.match(job.if, /vars.FEISHU_ENABLED == 'true'/)
  assert.match(job.if, /github.event_name != 'schedule' \|\| vars.FEISHU_DAILY_DIGEST == 'true'/)
  assert.equal(job.env.FEISHU_MODE, "${{ vars.FEISHU_MODE || 'changes' }}")
  assert.equal(
    job.env.DRY_RUN,
    "${{ github.event_name == 'workflow_dispatch' && inputs.dry_run || false }}"
  )
  assert.equal(
    job.env.RESEND_UNKNOWN,
    "${{ github.event_name == 'workflow_dispatch' && inputs.resend_unknown || false }}"
  )
  assert.equal(job.env.SOURCE_RUN_ID, "${{ inputs.run_id || github.event.workflow_run.id }}")
})

test("notification executes only trusted default-branch code with read-only credentials", async () => {
  const workflow = await load()
  assert.deepEqual(workflow.permissions, {
    contents: "read",
    actions: "read",
    "pull-requests": "read",
  })
  const job = workflow.jobs.notify
  assert.equal(job["timeout-minutes"], 10)
  assert.equal(job.permissions, undefined)
  assert.equal(
    workflow.concurrency.group,
    "feishu-${{ github.event.workflow_run.id || inputs.run_id || 'digest' }}"
  )
  assert.equal(workflow.concurrency["cancel-in-progress"], false)
  const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout@"))
  assert.equal(checkout.with.ref, "${{ github.event.repository.default_branch }}")
  assert.equal(checkout.with["persist-credentials"], false)
  const node = job.steps.find((step) => step.uses?.startsWith("actions/setup-node@"))
  assert.equal(node.with["node-version"], "26.x")
  assert.equal(node.with["package-manager-cache"], false)
  for (const step of job.steps) {
    if (step.uses) assert.match(step.uses, /^actions\/[a-z-]+@[a-f0-9]{40}$/)
    assert.doesNotMatch(step.run ?? "", /pnpm|npm install|download-artifact|\$\{\{/)
    if (!step.run?.startsWith("node scripts/ci/feishu/notify.mjs ")) {
      assert.doesNotMatch(JSON.stringify(step.env ?? {}), /secrets\.|github.token/)
    }
  }
  assert.doesNotMatch(JSON.stringify(job.env), /secrets\.|github.token/)
  for (const id of ["prepare", "deliver"]) {
    const step = job.steps.find((candidate) => candidate.id === id)
    assert.equal(step.env.FEISHU_OUTPUT_DIR, "${{ runner.temp }}/feishu")
    assert.equal(step.env.GITHUB_TOKEN, "${{ github.token }}")
    for (const route of ["", "CI_", "RELEASE_", "OPS_"]) {
      for (const field of ["WEBHOOK_URL", "SIGNING_SECRET"]) {
        const key = `FEISHU_${route}${field}`
        assert.equal(step.env[key], `\${{ secrets.${key} }}`)
      }
    }
  }
})

test("delivery requires a persisted claim and preserves receipts and diagnostics on failure", async () => {
  const steps = (await load()).jobs.notify.steps
  const index = (id) => steps.findIndex((step) => step.id === id)
  assert.ok(index("prepare") >= 0)
  assert.ok(index("prepare") < index("claim"))
  assert.ok(index("claim") < index("deliver"))
  assert.ok(index("deliver") < index("receipt"))
  const claim = steps[index("claim")]
  assert.equal(claim.if, "steps.prepare.outputs.prepared == 'true'")
  assert.equal(claim.with.name, "${{ steps.prepare.outputs.claim_name }}")
  assert.equal(claim.with.path, "${{ runner.temp }}/feishu/claim.json")
  assert.equal(claim.with["retention-days"], 90)
  assert.equal(claim.with["if-no-files-found"], "error")
  assert.equal(claim.with.overwrite, true)
  const deliver = steps[index("deliver")]
  assert.equal(deliver.if, "steps.prepare.outputs.prepared == 'true'")
  assert.equal(deliver["continue-on-error"], undefined)
  const receipt = steps[index("receipt")]
  assert.equal(receipt.if, "always() && steps.deliver.outputs.receipt_name != ''")
  assert.equal(receipt.with.name, "${{ steps.deliver.outputs.receipt_name }}")
  assert.equal(receipt.with.path, "${{ runner.temp }}/feishu/receipt.json")
  assert.equal(receipt.with["retention-days"], 90)
  const diagnostics = steps.find((step) => step.id === "diagnostics")
  assert.equal(diagnostics.if, "always()")
  assert.equal(diagnostics.with["retention-days"], 14)
  assert.match(diagnostics.with.name, /github.run_id.*github.run_attempt/)
  assert.match(diagnostics.with.path, /diagnostic.json/)
  assert.match(diagnostics.with.path, /preview.json/)
  assert.match(diagnostics.with.path, /preview.html/)
  for (const step of steps.filter((item) => item.uses?.startsWith("actions/upload-artifact@"))) {
    assert.doesNotMatch(step.with.path, /plan.json|\*\*/)
  }
})

test("the existing CI script gate discovers Feishu regression tests", async () => {
  const pkg = JSON.parse(await read("package.json"))
  assert.match(pkg.scripts["scripts:test:ci"], /scripts\/ci\/feishu\/\*\.test\.mjs/)
})
