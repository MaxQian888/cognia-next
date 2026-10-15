/**
 * The repository's review policy: the `review` block of `.cognia/workspace.json`
 * (ADR-0227 §3).
 *
 *   "review": {
 *     "protectedPaths": ["db/schema/**", "billing/**"],
 *     "requiredChecks": ["unit"],
 *     "humanApproval": "protected",
 *     "reviewAgent": "required",
 *     "largeChangeLines": 800
 *   }
 *
 * Read the way `acceptanceProfiles` is read (ADR-0188 D15) and for the same
 * reasons: strict and closed-world, every problem addressed by an RFC 6901
 * pointer, duplicate keys refused because `JSON.parse` silently keeps the last
 * one, and the block stays out of `WorkspaceRepositoryConfigV1` so the ADR-0147
 * trust digest of every existing file is unchanged.
 *
 * **It is read at the target ref, never from the changeset.** A policy the
 * change under review could rewrite is no policy: an agent that deletes its own
 * protected path from this block would otherwise approve itself. The caller
 * passes the ref the changeset integrates into, and `.cognia/**` is itself a
 * built-in protected path, so editing the policy is a change a human approves.
 *
 * The policy can only ADD protection. Built-in protected paths
 * (`assess-change-risk.ts`) are not configurable here, and `humanApproval`
 * has no "never": a repository can ask for more ceremony, not less.
 */

import {
  parseTree,
  getNodeValue,
  printParseErrorCode,
  type Node,
  type ParseError,
} from "jsonc-parser"

import {
  jsonPointer,
  WORKSPACE_CONFIG_MAX_BYTES,
  WORKSPACE_CONFIG_PATH,
} from "@/lib/project-environment/workspace-config"

/** The top-level key in `.cognia/workspace.json`. */
export const REVIEW_POLICY_KEY = "review"

export type ReviewHumanApproval = "protected" | "always"
export type ReviewAgentMode = "required" | "optional" | "off"

export interface ReviewPolicy {
  /** Repository-relative globs that always owe a human approval. */
  protectedPaths: string[]
  /** Acceptance profile ids (ADR-0188) that must pass at the changeset head and at the candidate. */
  requiredChecks: string[]
  /** `protected`: a human approves protected or high-risk changes. `always`: every change. */
  humanApproval: ReviewHumanApproval
  /**
   * `required`: an unavailable reviewer owes a human approval. `optional`: an
   * unavailable reviewer is recorded and does not block. `off`: no agent review.
   */
  reviewAgent: ReviewAgentMode
  /** Changed lines (insertions + deletions) above which a change is medium risk. */
  largeChangeLines: number
}

export const REVIEW_POLICY_LIMITS = {
  maxProtectedPaths: 128,
  maxRequiredChecks: 32,
  maxGlobLength: 512,
  minLargeChangeLines: 1,
  maxLargeChangeLines: 1_000_000,
} as const

export const DEFAULT_REVIEW_POLICY: Readonly<ReviewPolicy> = Object.freeze({
  protectedPaths: [],
  requiredChecks: [],
  humanApproval: "protected",
  reviewAgent: "required",
  largeChangeLines: 1_000,
})

export type ReviewPolicyProblemCode =
  | "review_policy_document_invalid"
  | "review_policy_not_object"
  | "review_policy_key_duplicate"
  | "review_policy_field_unknown"
  | "review_policy_paths_invalid"
  | "review_policy_checks_invalid"
  | "review_policy_human_approval_invalid"
  | "review_policy_review_agent_invalid"
  | "review_policy_large_change_invalid"

export interface ReviewPolicyProblem {
  code: ReviewPolicyProblemCode
  pointer: string
  message: string
}

export type ReviewPolicyParseResult =
  { ok: true; policy: ReviewPolicy } | { ok: false; problems: ReviewPolicyProblem[] }

/** A file's policy, plus whether the file declared a `review` block at all. */
export type WorkspaceReviewPolicyParseResult =
  | { ok: true; policy: ReviewPolicy; declared: boolean }
  | { ok: false; problems: ReviewPolicyProblem[] }

/** A fresh copy of the defaults, safe to mutate. */
export function defaultReviewPolicy(): ReviewPolicy {
  return { ...DEFAULT_REVIEW_POLICY, protectedPaths: [], requiredChecks: [] }
}

const REVIEW_POLICY_FIELDS: ReadonlySet<string> = new Set([
  "protectedPaths",
  "requiredChecks",
  "humanApproval",
  "reviewAgent",
  "largeChangeLines",
])
/** Same alphabet as acceptance profile ids, which `requiredChecks` names. */
const CHECK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const HUMAN_APPROVAL: ReadonlySet<string> = new Set(["protected", "always"])
const REVIEW_AGENT: ReadonlySet<string> = new Set(["required", "optional", "off"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** A confined repository-relative glob: no absolute path, no `..`, no backslash. */
function validGlob(value: unknown): value is string {
  if (typeof value !== "string") return false
  const glob = value.trim()
  if (!glob || glob.length > REVIEW_POLICY_LIMITS.maxGlobLength) return false
  if (glob.includes("\\") || glob.startsWith("/") || /^[A-Za-z]:/.test(glob)) return false
  return !glob.split("/").some((segment) => segment === "..")
}

function stringList(
  value: unknown,
  pointer: string,
  max: number,
  valid: (entry: unknown) => boolean,
  code: ReviewPolicyProblemCode,
  what: string,
  problems: ReviewPolicyProblem[]
): string[] {
  if (!Array.isArray(value)) {
    problems.push({ code, pointer, message: `${what} must be an array` })
    return []
  }
  if (value.length > max) {
    problems.push({ code, pointer, message: `at most ${max} ${what}` })
    return []
  }
  const out: string[] = []
  value.forEach((entry, index) => {
    if (!valid(entry)) {
      problems.push({
        code,
        pointer: jsonPointer(pointer, index),
        message: `invalid ${what} entry`,
      })
      return
    }
    const normalized = (entry as string).trim()
    if (!out.includes(normalized)) out.push(normalized)
  })
  return out
}

/**
 * Validate a `review` value already in memory. `undefined` declares none and
 * yields the defaults. `pointer` is where the value sits in its document.
 */
export function parseReviewPolicyValue(
  value: unknown,
  pointer = jsonPointer("", REVIEW_POLICY_KEY)
): ReviewPolicyParseResult {
  if (value === undefined) return { ok: true, policy: defaultReviewPolicy() }
  if (!isRecord(value)) {
    return {
      ok: false,
      problems: [
        { code: "review_policy_not_object", pointer, message: "review must be an object" },
      ],
    }
  }
  const problems: ReviewPolicyProblem[] = []
  for (const key of Object.keys(value)) {
    if (!REVIEW_POLICY_FIELDS.has(key)) {
      problems.push({
        code: "review_policy_field_unknown",
        pointer: jsonPointer(pointer, key),
        message: `unknown field "${key}"`,
      })
    }
  }

  const policy = defaultReviewPolicy()
  if (value.protectedPaths !== undefined) {
    policy.protectedPaths = stringList(
      value.protectedPaths,
      jsonPointer(pointer, "protectedPaths"),
      REVIEW_POLICY_LIMITS.maxProtectedPaths,
      validGlob,
      "review_policy_paths_invalid",
      "protected paths",
      problems
    )
  }
  if (value.requiredChecks !== undefined) {
    policy.requiredChecks = stringList(
      value.requiredChecks,
      jsonPointer(pointer, "requiredChecks"),
      REVIEW_POLICY_LIMITS.maxRequiredChecks,
      (entry) => typeof entry === "string" && CHECK_ID.test(entry),
      "review_policy_checks_invalid",
      "required checks",
      problems
    )
  }
  if (value.humanApproval !== undefined) {
    if (typeof value.humanApproval === "string" && HUMAN_APPROVAL.has(value.humanApproval)) {
      policy.humanApproval = value.humanApproval as ReviewHumanApproval
    } else {
      problems.push({
        code: "review_policy_human_approval_invalid",
        pointer: jsonPointer(pointer, "humanApproval"),
        message: 'humanApproval must be "protected" or "always"',
      })
    }
  }
  if (value.reviewAgent !== undefined) {
    if (typeof value.reviewAgent === "string" && REVIEW_AGENT.has(value.reviewAgent)) {
      policy.reviewAgent = value.reviewAgent as ReviewAgentMode
    } else {
      problems.push({
        code: "review_policy_review_agent_invalid",
        pointer: jsonPointer(pointer, "reviewAgent"),
        message: 'reviewAgent must be "required", "optional" or "off"',
      })
    }
  }
  if (value.largeChangeLines !== undefined) {
    const lines = value.largeChangeLines
    const { minLargeChangeLines, maxLargeChangeLines } = REVIEW_POLICY_LIMITS
    if (
      typeof lines === "number" &&
      Number.isSafeInteger(lines) &&
      lines >= minLargeChangeLines &&
      lines <= maxLargeChangeLines
    ) {
      policy.largeChangeLines = lines
    } else {
      problems.push({
        code: "review_policy_large_change_invalid",
        pointer: jsonPointer(pointer, "largeChangeLines"),
        message: `largeChangeLines must be an integer from ${minLargeChangeLines} to ${maxLargeChangeLines}`,
      })
    }
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, policy }
}

function duplicateKeyProblems(node: Node, pointer: string, problems: ReviewPolicyProblem[]): void {
  if (node.type === "object") {
    const seen = new Set<string>()
    for (const property of node.children ?? []) {
      const [keyNode, valueNode] = property.children ?? []
      if (!keyNode) continue
      const key = String(keyNode.value)
      const at = jsonPointer(pointer, key)
      if (seen.has(key)) {
        problems.push({
          code: "review_policy_key_duplicate",
          pointer: at,
          message: `duplicate key "${key}": JSON readers disagree on which one wins`,
        })
      }
      seen.add(key)
      if (valueNode) duplicateKeyProblems(valueNode, at, problems)
    }
  } else if (node.type === "array") {
    ;(node.children ?? []).forEach((child, index) =>
      duplicateKeyProblems(child, jsonPointer(pointer, index), problems)
    )
  }
}

/** The `review` block of a `.cognia/workspace.json` text; defaults when absent. */
export function parseWorkspaceReviewPolicy(source: string): WorkspaceReviewPolicyParseResult {
  const errors: ParseError[] = []
  const root = parseTree(source, errors, {
    disallowComments: true,
    allowTrailingComma: false,
    allowEmptyContent: false,
  })
  if (errors.length > 0 || !root || root.type !== "object") {
    const [first] = errors
    return {
      ok: false,
      problems: [
        {
          code: "review_policy_document_invalid",
          pointer: "",
          message: first
            ? `workspace.json is not valid JSON: ${printParseErrorCode(first.error)} at offset ${first.offset}`
            : "workspace.json must be an object",
        },
      ],
    }
  }
  const pointer = jsonPointer("", REVIEW_POLICY_KEY)
  const blocks = (root.children ?? []).filter(
    (property) => property.children?.[0]?.value === REVIEW_POLICY_KEY
  )
  if (blocks.length === 0) return { ok: true, policy: defaultReviewPolicy(), declared: false }
  if (blocks.length > 1) {
    return {
      ok: false,
      problems: [
        {
          code: "review_policy_key_duplicate",
          pointer,
          message: `duplicate key "${REVIEW_POLICY_KEY}": JSON readers disagree on which one wins`,
        },
      ],
    }
  }
  const valueNode = blocks[0].children?.[1]
  const duplicates: ReviewPolicyProblem[] = []
  if (valueNode) duplicateKeyProblems(valueNode, pointer, duplicates)
  if (duplicates.length > 0) return { ok: false, problems: duplicates }
  const parsed = parseReviewPolicyValue(valueNode ? getNodeValue(valueNode) : null, pointer)
  return parsed.ok ? { ...parsed, declared: true } : parsed
}

/** Reads one file at a ref; `null` when the file does not exist there. */
export type ReadBlobAtRef = (repoPath: string, ref: string, path: string) => Promise<string | null>

/**
 * The review policy as the target ref declares it. A missing file or block is
 * the defaults; an invalid block is a refusal, never the defaults — a broken
 * policy that silently relaxed to defaults would be a downgrade nobody chose.
 */
export async function readReviewPolicyAtRef(
  repoPath: string,
  ref: string,
  readBlob: ReadBlobAtRef
): Promise<WorkspaceReviewPolicyParseResult> {
  const source = await readBlob(repoPath, ref, WORKSPACE_CONFIG_PATH)
  if (source === null) return { ok: true, policy: defaultReviewPolicy(), declared: false }
  if (new TextEncoder().encode(source).byteLength > WORKSPACE_CONFIG_MAX_BYTES) {
    return {
      ok: false,
      problems: [
        {
          code: "review_policy_document_invalid",
          pointer: "",
          message: `workspace.json exceeds ${WORKSPACE_CONFIG_MAX_BYTES} bytes`,
        },
      ],
    }
  }
  return parseWorkspaceReviewPolicy(source)
}
