/**
 * The agent-backed Creator ports (ADR-0117, Phase 3).
 *
 * Three of the executor's four outside-world ports need a model: survey the
 * codebase, generate the scaffold, and review the result. All three are built
 * here from one injected `runTurn`, which keeps the prompts and — more
 * importantly — the *parsers* testable without a sidecar.
 *
 * Parsing is strict on purpose. Everything coming back is model output, which
 * is untrusted input: a plan is only accepted if it is a well-formed JSON
 * object with the exact shape below, and a single bad file entry rejects the
 * whole plan rather than being skipped. A partially-parsed plan would write
 * some files and silently drop others, which is worse than not writing at all.
 *
 * The reviewer runs on its own session id. That is what "independent context"
 * means in practice — same model, no shared conversation — and it is enforced
 * here rather than left to the caller to remember.
 */

import type {
  CreatorHandlers,
  CreatorRunContext,
  ExistingImplementation,
  ScaffoldPlan,
} from "./executor"
import type { CreatorReviewFinding } from "@/types/creator"

/** What the model is asked to do. Also the reviewer's isolation boundary. */
export type CreatorTurnPurpose = "survey" | "plan" | "review"

export interface CreatorTurnRequest {
  purpose: CreatorTurnPurpose
  prompt: string
  /** Absolute authoring-root path, used as the turn's working directory. */
  cwd: string
  /** Human-readable label for the execution broker. */
  label: string
}

/**
 * The single seam to the model.
 *
 * Implementations must run read-only: none of these three ports may write, and
 * the executor — not the model — is what puts bytes on disk.
 */
export type CreatorTurnRunner = (request: CreatorTurnRequest) => Promise<string>

export interface CreatorAgentDeps {
  runTurn: CreatorTurnRunner
}

// ---- prompts ---------------------------------------------------------------

const JSON_CONTRACT =
  "Reply with a single fenced ```json block and nothing else. No prose before or after."

export function buildSurveyPrompt(ctx: CreatorRunContext): string {
  return [
    `You are surveying an existing codebase before a new ${ctx.artifactKind} is written.`,
    "",
    "Requirements:",
    ctx.requirements,
    "",
    "Find anything already in this repository that does this or most of it.",
    "Report nothing rather than something tenuous — a false match costs more",
    "than a missed one, because it stops work that should have happened.",
    "",
    JSON_CONTRACT,
    'Shape: {"findings":[{"path":"repo/relative/path.ts","why":"one sentence"}]}',
  ].join("\n")
}

export function buildPlanPrompt(ctx: CreatorRunContext): string {
  return [
    `Generate a ${ctx.artifactKind} scaffold.`,
    "",
    "Requirements:",
    ctx.requirements,
    "",
    "Rules:",
    "- Every path is RELATIVE to the authoring root. Never absolute, never `..`.",
    "- List every capability the artifact needs, and only those it needs.",
    "- Give a one-line reason for each capability; unexplained ones get refused.",
    "",
    JSON_CONTRACT,
    'Shape: {"files":[{"path":"src/index.ts","contents":"..."}],' +
      '"capabilities":["fs.read"],"rationales":{"fs.read":"why"}}',
  ].join("\n")
}

export function buildReviewPrompt(
  ctx: CreatorRunContext,
  brief: { changedPaths: readonly string[]; verification: Record<string, boolean> }
): string {
  return [
    `Review a generated ${ctx.artifactKind}. You did not write it and you cannot change it.`,
    "",
    "The requirements it was meant to satisfy:",
    ctx.requirements,
    "",
    `Files it produced: ${brief.changedPaths.join(", ") || "(none)"}`,
    `Toolchain: ${JSON.stringify(brief.verification)}`,
    "",
    "Raise a blocker only for something that makes the artifact wrong or unsafe.",
    "",
    JSON_CONTRACT,
    'Shape: {"findings":[{"id":"f1","severity":"blocker|warning|info",' +
      '"summary":"...","path":"optional/relative/path"}]}',
  ].join("\n")
}

// ---- parsing ---------------------------------------------------------------

export class CreatorResponseError extends Error {
  constructor(
    readonly purpose: CreatorTurnPurpose,
    detail: string
  ) {
    super(`Creator ${purpose} response was unusable: ${detail}`)
    this.name = "CreatorResponseError"
  }
}

/**
 * Pull the JSON payload out of a model reply.
 *
 * Accepts a fenced block or a bare object, because models drift on the fence
 * even when told not to — but it does NOT scan for the first `{`, which would
 * happily parse an example embedded in prose.
 */
export function extractJson(text: string, purpose: CreatorTurnPurpose): unknown {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n?```/.exec(text)
  const candidate = (fenced ? fenced[1] : text).trim()
  if (candidate === "") throw new CreatorResponseError(purpose, "empty reply")
  try {
    return JSON.parse(candidate)
  } catch (error) {
    throw new CreatorResponseError(
      purpose,
      error instanceof Error ? error.message : "not valid JSON"
    )
  }
}

function asRecord(value: unknown, purpose: CreatorTurnPurpose): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CreatorResponseError(purpose, "expected a JSON object")
  }
  return value as Record<string, unknown>
}

function asArray(value: unknown, field: string, purpose: CreatorTurnPurpose): unknown[] {
  if (!Array.isArray(value)) throw new CreatorResponseError(purpose, `"${field}" must be an array`)
  return value
}

function asString(value: unknown, field: string, purpose: CreatorTurnPurpose): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CreatorResponseError(purpose, `"${field}" must be a non-empty string`)
  }
  return value
}

/**
 * A path the model proposed.
 *
 * Rejected here as well as in `writeCreatorFile`, and deliberately so: this one
 * fails the whole plan with a clear message, while the writer's check is the
 * boundary that must hold even if this parser is ever bypassed. Two checks for
 * two different jobs — early diagnosis and late enforcement.
 */
function assertRelativePath(path: string, purpose: CreatorTurnPurpose): string {
  const trimmed = path.trim()
  if (trimmed.startsWith("/") || /^[A-Za-z]:[/\\]/.test(trimmed) || trimmed.startsWith("\\\\")) {
    throw new CreatorResponseError(purpose, `path "${trimmed}" is absolute`)
  }
  if (trimmed.split(/[/\\]/).some((segment) => segment === "..")) {
    throw new CreatorResponseError(purpose, `path "${trimmed}" escapes the authoring root`)
  }
  return trimmed
}

export function parseScaffoldPlan(text: string): ScaffoldPlan {
  const root = asRecord(extractJson(text, "plan"), "plan")
  const files = asArray(root.files, "files", "plan").map((entry) => {
    const file = asRecord(entry, "plan")
    return {
      relativePath: assertRelativePath(asString(file.path, "files[].path", "plan"), "plan"),
      // Contents may legitimately be empty (a placeholder file), so this is the
      // one field not required to be non-empty.
      contents: typeof file.contents === "string" ? file.contents : "",
    }
  })

  const capabilities = asArray(root.capabilities ?? [], "capabilities", "plan").map((entry) =>
    asString(entry, "capabilities[]", "plan").trim()
  )

  const rationales: Record<string, string> = {}
  if (root.rationales !== undefined) {
    const raw = asRecord(root.rationales, "plan")
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === "string" && value.trim() !== "") rationales[key] = value.trim()
    }
  }

  return { files, capabilities, ...(Object.keys(rationales).length > 0 ? { rationales } : {}) }
}

export function parseSurveyFindings(text: string): ExistingImplementation[] {
  const root = asRecord(extractJson(text, "survey"), "survey")
  return asArray(root.findings ?? [], "findings", "survey").map((entry) => {
    const finding = asRecord(entry, "survey")
    return {
      path: asString(finding.path, "findings[].path", "survey"),
      why: asString(finding.why, "findings[].why", "survey"),
    }
  })
}

const SEVERITIES = new Set(["blocker", "warning", "info"])

export function parseReviewFindings(text: string): CreatorReviewFinding[] {
  const root = asRecord(extractJson(text, "review"), "review")
  return asArray(root.findings ?? [], "findings", "review").map((entry, index) => {
    const finding = asRecord(entry, "review")
    const severity = asString(finding.severity, "findings[].severity", "review")
    if (!SEVERITIES.has(severity)) {
      throw new CreatorResponseError("review", `unknown severity "${severity}"`)
    }
    return {
      id: typeof finding.id === "string" && finding.id.trim() !== "" ? finding.id : `f${index + 1}`,
      severity: severity as CreatorReviewFinding["severity"],
      summary: asString(finding.summary, "findings[].summary", "review"),
      ...(typeof finding.path === "string" && finding.path.trim() !== ""
        ? { path: finding.path.trim() }
        : {}),
    }
  })
}

// ---- handlers --------------------------------------------------------------

export function createAgentSurveyHandler(
  deps: CreatorAgentDeps
): CreatorHandlers["surveyExisting"] {
  return async (ctx) => ({
    findings: parseSurveyFindings(
      await deps.runTurn({
        purpose: "survey",
        prompt: buildSurveyPrompt(ctx),
        cwd: ctx.root.path,
        label: `Creator survey (${ctx.artifactKind})`,
      })
    ),
  })
}

export function createAgentPlanHandler(deps: CreatorAgentDeps): CreatorHandlers["planScaffold"] {
  return async (ctx) =>
    parseScaffoldPlan(
      await deps.runTurn({
        purpose: "plan",
        prompt: buildPlanPrompt(ctx),
        cwd: ctx.root.path,
        label: `Creator scaffold (${ctx.artifactKind})`,
      })
    )
}

/**
 * The reviewer port.
 *
 * `purpose: "review"` is what the runner keys the fresh session on, so the
 * reviewer never inherits the generator's conversation. The authority it
 * reports is the runner's, not a value this module invents — a reviewer that
 * self-reported "plan" while actually running wider would defeat the check the
 * review panel exists to make visible.
 */
export function createAgentReviewHandler(
  deps: CreatorAgentDeps & { reviewerAuthority: string }
): CreatorHandlers["review"] {
  return async (ctx, brief) => ({
    findings: parseReviewFindings(
      await deps.runTurn({
        purpose: "review",
        prompt: buildReviewPrompt(ctx, {
          changedPaths: brief.changedPaths,
          verification: brief.verification as unknown as Record<string, boolean>,
        }),
        cwd: ctx.root.path,
        label: `Creator review (${ctx.artifactKind})`,
      })
    ),
    reviewerAuthority: deps.reviewerAuthority,
  })
}

/** All three agent-backed ports, ready to spread into `createCreatorHandlers`. */
export function createAgentPorts(
  deps: CreatorAgentDeps & { reviewerAuthority: string }
): Pick<CreatorHandlers, "surveyExisting" | "planScaffold" | "review"> {
  return {
    surveyExisting: createAgentSurveyHandler(deps),
    planScaffold: createAgentPlanHandler(deps),
    review: createAgentReviewHandler(deps),
  }
}
