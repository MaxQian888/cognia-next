#!/usr/bin/env node
/**
 * Evidence ledger helper for the evidence-driven-dev skill.
 *
 *   node ledger.mjs new <slug> [--title "…"] [--lane standard|deep] [--request "…"] [--dir docs/evidence]
 *   node ledger.mjs check <file…> [--final]
 *   node ledger.mjs open [--dir docs/evidence]
 *
 * `check` validates structure and the epistemic rules (stale verification,
 * decisions resting on unverified knowledge, high risks without obligations,
 * unclosed obligations once the ledger claims to be verifying/closed).
 * `open` lists everything still unresolved across every non-closed ledger —
 * the cross-session list of pending smokes, open questions and residual risks.
 *
 * Zero dependencies; run from the repo root.
 */

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TEMPLATE = path.join(HERE, "..", "assets", "ledger-template.md")

export const LEDGER_STATUS = ["exploring", "building", "verifying", "closed"]
export const LANES = ["standard", "deep"]

const KNOWLEDGE_STATES = {
  O: ["Observed", "Verified", "Contested", "Unknown", "Invalidated"],
  H: ["Hypothesized", "Verified", "Contested", "Unknown", "Invalidated"],
  A: ["Hypothesized", "Verified", "Contested", "Unknown", "Invalidated"],
  C: ["Observed", "Hypothesized", "Verified", "Contested", "Unknown", "Invalidated"],
  G: ["Proposed", "Agreed", "Revised"],
  Q: ["Open", "Answered"],
}
const COMPLEXITY_DIMENSIONS = ["scale", "technical", "coupling", "requirement", "verification", "risk"]
const COMPLEXITY_RATINGS = ["low", "medium", "high", "unknown"]
const SEVERITIES = ["low", "medium", "high"]
const INDEPENDENCE = ["self", "subagent", "fresh-reviewer", "tool", "other-model", "human", "real-env"]
const OBLIGATION_STATUS = ["planned", "passed", "failed", "blocked", "waived"]
const ACTIONS = [
  "implement",
  "spike",
  "diagnose",
  "experiment",
  "harden",
  "escalate",
  "scope-down",
  "stop",
  "ship",
]
const RESIDUAL_STATUS = ["open", "accepted", "closed"]
const OUTCOME_STATUS = ["pending", "met", "not-met", "not-measurable"]

/** Section heading → expected first header cell + allowed ID prefixes. */
const TABLES = {
  Knowledge: { header: ["ID", "Statement", "State", "Basis", "Depends on"], prefixes: "OHGCAQ" },
  "Complexity profile": { header: ["Dimension", "Rating", "Why / what would resolve it"] },
  Risks: { header: ["ID", "Risk (impact)", "Severity", "Source", "Claim", "Refuted by"], prefixes: "R" },
  "Verification obligations": {
    header: ["ID", "Risk", "Method", "Independence", "Evidence", "Coverage", "Status"],
    prefixes: "V",
  },
  Decisions: { header: ["ID", "Date", "Decision", "Action", "Based on", "Reversal trigger"], prefixes: "D" },
  "Residual risks": {
    header: ["ID", "Residual", "From", "Why still open", "Next action", "Status"],
    prefixes: "X",
  },
  Outcome: { header: ["ID", "Signal", "How / when measured", "Result", "Status"], prefixes: "M" },
}
const REQUIRED_SECTIONS = ["Original request", "Problem frame", ...Object.keys(TABLES)]

const ID_RE = /^([A-Z])(\d+)$/
const EMPTY = new Set(["", "-", "—", "n/a", "none"])

const isEmpty = (cell) => EMPTY.has((cell ?? "").trim().toLowerCase())
const idList = (cell) =>
  isEmpty(cell)
    ? []
    : cell
        .split(/[,\s]+/)
        .map((part) => part.trim())
        .filter(Boolean)

function splitRow(line) {
  const cells = []
  let current = ""
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "")
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === "\\" && body[i + 1] === "|") {
      current += "|"
      i += 1
    } else if (body[i] === "|") {
      cells.push(current.trim())
      current = ""
    } else {
      current += body[i]
    }
  }
  cells.push(current.trim())
  return cells
}

/** Parse a ledger into header fields, section bodies, and tables keyed by section. */
export function parseLedger(text) {
  const stripped = text.replace(/<!--[\s\S]*?-->/g, "")
  const lines = stripped.split(/\r?\n/)
  const fields = {}
  const sections = {}
  let title = null
  let current = null
  for (const line of lines) {
    const h1 = /^#\s+(.*)$/.exec(line)
    if (h1 && !title) {
      title = h1[1].trim()
      continue
    }
    const h2 = /^##\s+(.*)$/.exec(line)
    if (h2) {
      current = h2[1].trim()
      sections[current] = []
      continue
    }
    if (current === null) {
      const field = /^-\s+([A-Za-z]+):\s*(.*)$/.exec(line)
      if (field) fields[field[1].toLowerCase()] = field[2].trim()
      continue
    }
    sections[current].push(line)
  }
  const tables = {}
  for (const [name, body] of Object.entries(sections)) {
    const rows = body.filter((line) => line.trim().startsWith("|")).map(splitRow)
    if (rows.length === 0) continue
    const [header, separator, ...data] = rows
    const isSeparator = separator && separator.every((cell) => /^:?-{3,}:?$/.test(cell))
    tables[name] = { header, rows: isSeparator ? data : rows.slice(1) }
  }
  return { title, fields, sections, tables }
}

function rowsAsRecords(table, header) {
  if (!table) return []
  return table.rows.map((cells) => Object.fromEntries(header.map((key, i) => [key, cells[i] ?? ""])))
}

/**
 * Validate a parsed ledger. `final` forces the closure rules regardless of the
 * declared status (the rules apply automatically at verifying/closed).
 */
export function checkLedger(ledger, { final = false } = {}) {
  const errors = []
  const warnings = []
  const status = (ledger.fields.status ?? "").toLowerCase()
  const lane = (ledger.fields.lane ?? "").toLowerCase()

  if (!LEDGER_STATUS.includes(status)) errors.push(`Status "${ledger.fields.status ?? ""}" must be one of ${LEDGER_STATUS.join(", ")}`)
  if (!LANES.includes(lane)) errors.push(`Lane "${ledger.fields.lane ?? ""}" must be one of ${LANES.join(", ")}`)
  for (const section of REQUIRED_SECTIONS) {
    if (!(section in ledger.sections)) errors.push(`Missing section "## ${section}"`)
  }

  const records = {}
  for (const [name, spec] of Object.entries(TABLES)) {
    const table = ledger.tables[name]
    if (!table) {
      if (name in ledger.sections) errors.push(`Section "${name}" has no table`)
      records[name] = []
      continue
    }
    const header = table.header.map((cell) => cell.trim())
    if (header.join("|") !== spec.header.join("|")) {
      errors.push(`Table "${name}" header must be: | ${spec.header.join(" | ")} |`)
    }
    records[name] = rowsAsRecords(table, spec.header)
  }

  // Index every ID; enforce prefixes and uniqueness.
  const items = new Map()
  for (const [name, spec] of Object.entries(TABLES)) {
    if (!spec.prefixes) continue
    for (const row of records[name]) {
      const id = row.ID.trim()
      const match = ID_RE.exec(id)
      if (!match || !spec.prefixes.includes(match[1])) {
        errors.push(`${name}: ID "${id}" must use prefix ${spec.prefixes.split("").join("/")} followed by a number`)
        continue
      }
      if (items.has(id)) errors.push(`Duplicate ID ${id}`)
      items.set(id, { table: name, row })
    }
  }
  const resolve = (owner, column, cell) => {
    for (const ref of idList(cell)) {
      if (!items.has(ref)) errors.push(`${owner}: ${column} references unknown ID ${ref}`)
    }
  }

  // Knowledge
  const knowledgeState = (id) => items.get(id)?.row.State?.trim()
  for (const row of records.Knowledge) {
    const id = row.ID.trim()
    const prefix = id[0]
    if (isEmpty(row.Statement)) {
      warnings.push(`${id}: placeholder row has no statement — fill it in or delete it`)
      continue
    }
    const allowed = KNOWLEDGE_STATES[prefix]
    if (allowed && !allowed.includes(row.State.trim())) {
      errors.push(`${id}: state "${row.State}" must be one of ${allowed.join(", ")}`)
    }
    if (["O", "C"].includes(prefix) && row.State.trim() === "Observed" && isEmpty(row.Basis)) {
      errors.push(`${id}: an Observed item needs a Basis (source, scope, date)`)
    }
    if (row.State.trim() === "Verified" && isEmpty(row.Basis)) {
      errors.push(`${id}: a Verified item needs a Basis naming the evidence and its scope`)
    }
    resolve(id, "Depends on", row["Depends on"])
    for (const dep of idList(row["Depends on"])) {
      if (knowledgeState(dep) !== "Invalidated") continue
      if (row.State.trim() === "Verified") {
        errors.push(`${id} is Verified but depends on Invalidated ${dep} — stale verification; re-check ${id}`)
      } else if (!["Invalidated", "Answered"].includes(row.State.trim())) {
        warnings.push(`${id} depends on Invalidated ${dep} — re-evaluate it`)
      }
    }
    if (status === "closed" && prefix === "Q" && row.State.trim() === "Open") {
      warnings.push(`${id}: question still Open on a closed ledger`)
    }
  }

  // Complexity
  const complexity = new Map(
    records["Complexity profile"].map((row) => [row.Dimension.trim().toLowerCase(), row]),
  )
  for (const dimension of COMPLEXITY_DIMENSIONS) {
    const row = complexity.get(dimension)
    if (!row) {
      errors.push(`Complexity profile is missing dimension "${dimension}"`)
      continue
    }
    const rating = row.Rating.trim().toLowerCase()
    if (isEmpty(rating)) {
      warnings.push(`Complexity "${dimension}" not rated yet (use "unknown" if it cannot be judged)`)
    } else if (!COMPLEXITY_RATINGS.includes(rating)) {
      errors.push(`Complexity "${dimension}" rating "${row.Rating}" must be one of ${COMPLEXITY_RATINGS.join(", ")}`)
    } else if (rating === "unknown" && isEmpty(row["Why / what would resolve it"])) {
      errors.push(`Complexity "${dimension}" is unknown — say what would resolve it`)
    }
  }

  // Risks
  const risks = records.Risks
  for (const row of risks) {
    const id = row.ID.trim()
    if (!SEVERITIES.includes(row.Severity.trim().toLowerCase())) {
      errors.push(`${id}: severity "${row.Severity}" must be one of ${SEVERITIES.join(", ")}`)
    }
    if (isEmpty(row.Source)) errors.push(`${id}: name the Source that surfaced this risk`)
    const severity = row.Severity.trim().toLowerCase()
    if (severity !== "low" && isEmpty(row["Refuted by"])) {
      errors.push(`${id}: a ${severity} risk needs a "Refuted by" observation (what would prove the claim false)`)
    }
  }
  const sources = risks.map((row) => row.Source.trim().toLowerCase()).filter((s) => !isEmpty(s))
  if (risks.length >= 3 && sources.every((s) => s === "self" || s === "brainstorm")) {
    warnings.push("Every risk came from your own brainstorm — add an independent source (catalog, ADR, git history, lens, fresh reviewer)")
  }

  // Obligations
  const obligations = records["Verification obligations"]
  const obligationsByRisk = new Map()
  for (const row of obligations) {
    const id = row.ID.trim()
    const refs = idList(row.Risk)
    if (refs.length === 0) errors.push(`${id}: name the R id(s) it discharges`)
    for (const ref of refs) {
      if (!items.has(ref)) errors.push(`${id}: Risk references unknown ID ${ref}`)
      else if (!ref.startsWith("R")) errors.push(`${id}: Risk column must reference R ids, got ${ref}`)
      if (!obligationsByRisk.has(ref)) obligationsByRisk.set(ref, [])
      obligationsByRisk.get(ref).push(row)
    }
    const independence = row.Independence.trim().toLowerCase()
    if (!INDEPENDENCE.includes(independence)) {
      errors.push(`${id}: independence "${row.Independence}" must be one of ${INDEPENDENCE.join(", ")}`)
    }
    const obligationStatus = row.Status.trim().toLowerCase()
    if (!OBLIGATION_STATUS.includes(obligationStatus)) {
      errors.push(`${id}: status "${row.Status}" must be one of ${OBLIGATION_STATUS.join(", ")}`)
    }
    if (obligationStatus === "passed" && isEmpty(row.Evidence)) {
      errors.push(`${id}: passed without Evidence — record the command/result, commit, or artifact`)
    }
    if (obligationStatus === "passed" && /should (pass|work)|looks (good|fine)/i.test(row.Evidence)) {
      errors.push(`${id}: Evidence "${row.Evidence}" is a prediction, not evidence`)
    }
    if (obligationStatus === "passed" && isEmpty(row.Coverage)) {
      warnings.push(`${id}: passed with no Coverage — say what conditions the evidence does and does not cover`)
    }
  }

  const progressed = ["building", "verifying", "closed"].includes(status)
  for (const row of risks) {
    const id = row.ID.trim()
    const severity = row.Severity.trim().toLowerCase()
    const own = obligationsByRisk.get(id) ?? []
    if (severity === "high" && own.length === 0) {
      ;(progressed ? errors : warnings).push(`${id}: high risk has no verification obligation`)
    } else if (severity === "medium" && own.length === 0 && progressed) {
      warnings.push(`${id}: medium risk has no verification obligation`)
    }
    const passed = own.filter((o) => o.Status.trim().toLowerCase() === "passed")
    if (severity === "high" && passed.length > 0 && passed.every((o) => o.Independence.trim().toLowerCase() === "self")) {
      warnings.push(`${id}: high risk is discharged only by self-checks — add an independent obligation`)
    }
  }

  // Decisions
  for (const row of records.Decisions) {
    const id = row.ID.trim()
    if (!ACTIONS.includes(row.Action.trim().toLowerCase())) {
      errors.push(`${id}: action "${row.Action}" must be one of ${ACTIONS.join(", ")}`)
    }
    resolve(id, "Based on", row["Based on"])
    const action = row.Action.trim().toLowerCase()
    const commits = ["implement", "ship", "harden"].includes(action)
    for (const ref of idList(row["Based on"])) {
      const state = knowledgeState(ref)
      if (state === "Invalidated") errors.push(`${id} rests on Invalidated ${ref} — reopen the decision`)
      else if (commits && ["Hypothesized", "Unknown", "Contested"].includes(state)) {
        warnings.push(`${id} commits (${action}) on ${state} ${ref} — verify it first or record why the risk is acceptable`)
      }
    }
  }

  // Residual risks
  const residuals = records["Residual risks"]
  const residualFrom = new Set()
  for (const row of residuals) {
    const id = row.ID.trim()
    resolve(id, "From", row.From)
    for (const ref of idList(row.From)) residualFrom.add(ref)
    if (!RESIDUAL_STATUS.includes(row.Status.trim().toLowerCase())) {
      errors.push(`${id}: status "${row.Status}" must be one of ${RESIDUAL_STATUS.join(", ")}`)
    }
    if (row.Status.trim().toLowerCase() === "open" && isEmpty(row["Next action"])) {
      errors.push(`${id}: an open residual needs a Next action`)
    }
    if (/\d+\s*%/.test(row.Residual) || /\d+\s*%/.test(row["Why still open"])) {
      warnings.push(`${id}: avoid invented confidence percentages — describe source, impact, and scope instead`)
    }
  }

  // Outcome
  const outcomes = records.Outcome
  for (const row of outcomes) {
    const id = row.ID.trim()
    if (!OUTCOME_STATUS.includes(row.Status.trim().toLowerCase())) {
      errors.push(`${id}: status "${row.Status}" must be one of ${OUTCOME_STATUS.join(", ")}`)
    }
  }

  // Closure rules
  const closing = final || status === "verifying" || status === "closed"
  if (closing) {
    for (const row of obligations) {
      const id = row.ID.trim()
      const obligationStatus = row.Status.trim().toLowerCase()
      if (obligationStatus === "passed") continue
      const covered = residualFrom.has(id) || idList(row.Risk).some((ref) => residualFrom.has(ref))
      if (!covered) errors.push(`${id} is ${obligationStatus} — record it in Residual risks (From: ${id}) before verifying/closing`)
    }
    for (const [dimension, row] of complexity) {
      if (row.Rating.trim().toLowerCase() === "unknown") {
        warnings.push(`Complexity "${dimension}" is still unknown at ${status || "final"} — was it resolved?`)
      }
    }
    if (outcomes.length === 0) errors.push("No Outcome signal — say how the original problem will be seen to improve")
  }
  if (status === "closed") {
    for (const row of residuals) {
      if (row.Status.trim().toLowerCase() === "open") {
        errors.push(`${row.ID.trim()} is still open — a closed ledger needs every residual accepted (by the user) or closed`)
      }
    }
    for (const row of outcomes) {
      if (row.Status.trim().toLowerCase() === "pending") {
        const id = row.ID.trim()
        if (!residualFrom.has(id)) errors.push(`${id} outcome is pending on a closed ledger — measure it or carry it as an accepted residual`)
      }
    }
  }

  return { errors, warnings }
}

/** Everything still unresolved in one ledger, for `open`. */
export function openItems(ledger) {
  const status = (ledger.fields.status ?? "").toLowerCase()
  const out = []
  const pick = (name, header, predicate, render) => {
    const table = ledger.tables[name]
    for (const row of rowsAsRecords(table, header)) if (predicate(row)) out.push(render(row))
  }
  pick(
    "Knowledge",
    TABLES.Knowledge.header,
    (r) => !isEmpty(r.Statement) && ["Open", "Unknown", "Contested"].includes(r.State.trim()),
    (r) => `${r.ID} [${r.State.trim()}] ${r.Statement}`,
  )
  pick(
    "Verification obligations",
    TABLES["Verification obligations"].header,
    (r) => ["planned", "failed", "blocked"].includes(r.Status.trim().toLowerCase()),
    (r) => `${r.ID} [${r.Status.trim()}] ${r.Method} (for ${r.Risk})`,
  )
  pick(
    "Residual risks",
    TABLES["Residual risks"].header,
    (r) => r.Status.trim().toLowerCase() === "open",
    (r) => `${r.ID} [open] ${r.Residual} → ${r["Next action"]}`,
  )
  pick(
    "Outcome",
    TABLES.Outcome.header,
    (r) => r.Status.trim().toLowerCase() === "pending",
    (r) => `${r.ID} [pending] ${r.Signal} — ${r["How / when measured"]}`,
  )
  return { status, items: out }
}

function repoRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()
  } catch {
    return process.cwd()
  }
}

function localDate(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

export function renderTemplate(template, { title, lane, request, date }) {
  return template
    .replaceAll("{{TITLE}}", title)
    .replaceAll("{{LANE}}", lane)
    .replaceAll("{{DATE}}", date)
    .replaceAll("{{REQUEST}}", request.replace(/\n/g, "\n> "))
}

function parseFlags(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--final") flags.final = true
    else if (arg.startsWith("--")) {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`)
      flags[arg.slice(2)] = value
      i += 1
    } else positional.push(arg)
  }
  return { positional, flags }
}

function cmdNew(positional, flags) {
  const slug = positional[0]
  if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error("new needs a kebab-case <slug>")
  const lane = flags.lane ?? "standard"
  if (!LANES.includes(lane)) throw new Error(`--lane must be one of ${LANES.join(", ")}`)
  const dir = path.resolve(repoRoot(), flags.dir ?? "docs/evidence")
  const date = localDate()
  const file = path.join(dir, `${date}-${slug}.md`)
  if (existsSync(file)) throw new Error(`${path.relative(process.cwd(), file)} already exists — edit it instead`)
  mkdirSync(dir, { recursive: true })
  const title = flags.title ?? slug.replace(/-/g, " ")
  const request = flags.request ?? "<paste the user's original words, unedited>"
  writeFileSync(file, renderTemplate(readFileSync(TEMPLATE, "utf8"), { title, lane, request, date }))
  console.log(path.relative(process.cwd(), file))
  return 0
}

function cmdCheck(positional, flags) {
  if (positional.length === 0) throw new Error("check needs at least one ledger file")
  let failed = false
  for (const file of positional) {
    const { errors, warnings } = checkLedger(parseLedger(readFileSync(file, "utf8")), { final: flags.final })
    console.log(`${errors.length ? "✗" : "✓"} ${file}  (${errors.length} error(s), ${warnings.length} warning(s))`)
    for (const e of errors) console.log(`  error   ${e}`)
    for (const w of warnings) console.log(`  warning ${w}`)
    if (errors.length) failed = true
  }
  return failed ? 1 : 0
}

function cmdOpen(flags) {
  const dir = path.resolve(repoRoot(), flags.dir ?? "docs/evidence")
  if (!existsSync(dir)) {
    console.log(`No ledgers (${path.relative(process.cwd(), dir) || dir} does not exist)`)
    return 0
  }
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort()
  let any = false
  for (const name of files) {
    const ledger = parseLedger(readFileSync(path.join(dir, name), "utf8"))
    const { status, items } = openItems(ledger)
    if (status === "closed" || items.length === 0) continue
    any = true
    console.log(`\n${name}  [${status}]  ${ledger.title ?? ""}`)
    for (const item of items) console.log(`  - ${item}`)
  }
  if (!any) console.log("Nothing open across ledgers.")
  return 0
}

export function main(argv) {
  const [command, ...rest] = argv
  const { positional, flags } = parseFlags(rest)
  if (command === "new") return cmdNew(positional, flags)
  if (command === "check") return cmdCheck(positional, flags)
  if (command === "open") return cmdOpen(flags)
  console.error("usage: ledger.mjs new <slug> [--title …] [--lane standard|deep] [--request …]\n       ledger.mjs check <file…> [--final]\n       ledger.mjs open [--dir docs/evidence]")
  return 2
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(`ledger: ${error.message}`)
    process.exitCode = 2
  }
}
