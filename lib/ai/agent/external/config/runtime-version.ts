/**
 * Version probing, comparison and certification for external-Agent runtimes.
 *
 * Deliberately pure: no spawning, no filesystem, no clock of its own. The host
 * that owns the process (Rust on desktop, Node in CLI/headless) runs the probe
 * and hands the raw output here, so certification is decided in one place
 * instead of drifting between the two launchers — the same reason the security
 * policy lives in one JSON.
 *
 * The repo has no `semver` dependency and the one private comparator in
 * `lib/plugin/core/validation.ts` handles neither prerelease ordering nor
 * ranges, so the small subset needed here is implemented and pinned by tests
 * rather than reached for from another module's internals.
 *
 * @see types/agent/external-agent-lifecycle.ts
 */

import type {
  ExternalAgentLifecycleErrorCode,
  ExternalAgentVersionAssessment,
  ExternalAgentVersionParserId,
  ExternalAgentVersionVerdict,
} from "@/types/agent/external-agent-lifecycle"

// ============================================================================
// Semver subset
// ============================================================================

export interface ParsedSemver {
  major: number
  minor: number
  patch: number
  /** Dot-separated prerelease identifiers, empty for a release. */
  prerelease: (string | number)[]
  /** The exact `x.y.z[-pre]` text that was parsed. */
  raw: string
}

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** Parse a strict `x.y.z[-prerelease][+build]` string. */
export function parseSemver(value: string): ParsedSemver | undefined {
  const match = SEMVER_PATTERN.exec(value.trim())
  if (!match) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]
      ? match[4].split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part))
      : [],
    raw: match[0],
  }
}

function comparePrerelease(left: (string | number)[], right: (string | number)[]): number {
  // A release outranks any prerelease of the same x.y.z, and only then does
  // identifier-by-identifier ordering apply.
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1
  if (right.length === 0) return -1

  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    if (a === b) continue
    const aNumeric = typeof a === "number"
    const bNumeric = typeof b === "number"
    if (aNumeric && bNumeric) return a - b
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (aNumeric) return -1
    if (bNumeric) return 1
    return String(a) < String(b) ? -1 : 1
  }
  return 0
}

/** Compare two parsed versions: negative, zero or positive. */
export function compareSemver(left: ParsedSemver, right: ParsedSemver): number {
  if (left.major !== right.major) return left.major - right.major
  if (left.minor !== right.minor) return left.minor - right.minor
  if (left.patch !== right.patch) return left.patch - right.patch
  return comparePrerelease(left.prerelease, right.prerelease)
}

type Comparator = { operator: ">=" | ">" | "<=" | "<" | "="; version: ParsedSemver }

function expandCaret(version: ParsedSemver): Comparator[] {
  // ^0.2.3 allows <0.3.0 and ^0.0.3 allows <0.0.4 -- the leading zero rules
  // matter here because several agent CLIs are still pre-1.0.
  const upper =
    version.major > 0
      ? { major: version.major + 1, minor: 0, patch: 0 }
      : version.minor > 0
        ? { major: 0, minor: version.minor + 1, patch: 0 }
        : { major: 0, minor: 0, patch: version.patch + 1 }
  return [
    { operator: ">=", version },
    { operator: "<", version: { ...upper, prerelease: [], raw: "" } },
  ]
}

function expandTilde(version: ParsedSemver): Comparator[] {
  return [
    { operator: ">=", version },
    {
      operator: "<",
      version: {
        major: version.major,
        minor: version.minor + 1,
        patch: 0,
        prerelease: [],
        raw: "",
      },
    },
  ]
}

function parseComparator(token: string): Comparator[] | undefined {
  const match = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(token.trim())
  if (!match) return undefined
  const version = parseSemver(match[2])
  if (!version) return undefined
  switch (match[1]) {
    case "^":
      return expandCaret(version)
    case "~":
      return expandTilde(version)
    case ">=":
    case "<=":
    case ">":
    case "<":
      return [{ operator: match[1], version }]
    default:
      return [{ operator: "=", version }]
  }
}

function satisfiesComparator(version: ParsedSemver, comparator: Comparator): boolean {
  const order = compareSemver(version, comparator.version)
  switch (comparator.operator) {
    case ">=":
      return order >= 0
    case ">":
      return order > 0
    case "<=":
      return order <= 0
    case "<":
      return order < 0
    case "=":
      return order === 0
  }
}

/**
 * Does `version` satisfy `range`?
 *
 * Supports the subset the catalog actually uses: space-separated comparators
 * are ANDed, `||` separates ORed groups, and `^` / `~` expand as npm defines
 * them. A range that cannot be parsed returns `false` -- an unreadable
 * constraint must fail closed, never wave a version through.
 */
export function satisfiesRange(version: ParsedSemver, range: string): boolean {
  const groups = range.split("||")
  return groups.some((group) => {
    const tokens = group.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) return false
    const comparators: Comparator[] = []
    for (const token of tokens) {
      const parsed = parseComparator(token)
      if (!parsed) return false
      comparators.push(...parsed)
    }
    return comparators.every((comparator) => satisfiesComparator(version, comparator))
  })
}

// ============================================================================
// Probe output parsing
// ============================================================================

/** Longest probe output retained on an assessment, in characters. */
export const MAX_RETAINED_PROBE_OUTPUT = 512

const SEMVER_ANYWHERE = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/

/**
 * Read a version out of a probe's stdout.
 *
 * Returns `undefined` rather than guessing: an unreadable probe is a fail-closed
 * verdict, because "we could not tell which version this is" and "this version
 * is fine" are not the same answer.
 */
export function parseProbeVersion(
  parser: ExternalAgentVersionParserId,
  output: string
): string | undefined {
  const text = output.trim()
  if (!text) return undefined

  switch (parser) {
    case "semver-anywhere":
      return SEMVER_ANYWHERE.exec(text)?.[1]
    case "semver-first-line":
      return SEMVER_ANYWHERE.exec(text.split(/\r?\n/, 1)[0] ?? "")?.[1]
    case "semver-prefixed-v": {
      const match = /\bv(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(text)
      return match?.[1]
    }
    case "json-version-field": {
      try {
        const parsed: unknown = JSON.parse(text)
        if (parsed && typeof parsed === "object" && "version" in parsed) {
          const value = (parsed as { version: unknown }).version
          if (typeof value === "string") return SEMVER_ANYWHERE.exec(value)?.[1]
        }
      } catch {
        return undefined
      }
      return undefined
    }
  }
}

/** Trim probe output to what an assessment may retain. */
export function truncateProbeOutput(output: string): string {
  const text = output.trim()
  return text.length <= MAX_RETAINED_PROBE_OUTPUT
    ? text
    : `${text.slice(0, MAX_RETAINED_PROBE_OUTPUT)}…`
}

// ============================================================================
// Certification
// ============================================================================

/** Everything the catalog says about which versions may run. */
export interface RuntimeCertificationPolicy {
  runtimeId: string
  supportedRange?: string
  certifiedVersions?: readonly string[]
}

/** What the host observed when it probed. */
export interface RuntimeProbeObservation {
  /** Raw stdout of the probe; absent means the runtime could not be found. */
  output?: string
  parser: ExternalAgentVersionParserId
  executablePath?: string
  executableDigest?: string
  checkedAt: string
}

const VERDICT_BLOCKING_CODE: Partial<
  Record<ExternalAgentVersionVerdict, ExternalAgentLifecycleErrorCode>
> = {
  missing: "runtime_missing",
  unsupported: "version_unsupported",
  // Not a hard failure: it is the code a caller raises when consent is absent.
  "supported-uncertified": "version_uncertified",
  // An unreadable version cannot be certified, so it is refused as unsupported
  // rather than silently treated as "probably fine".
  unparseable: "version_unsupported",
}

/**
 * Decide whether the probed runtime may launch.
 *
 * The policy has one deliberate asymmetry: a runtime with NO `supportedRange`
 * is uncertified by policy rather than unconstrained, so every parseable
 * version lands on `supported-uncertified` and needs one explicit consent. That
 * is the honest reading of "Cognia has never certified a version of this CLI" —
 * the alternative, treating missing certification data as approval, is what
 * shipping these presets without a catalog already did.
 */
export function assessRuntimeVersion(
  policy: RuntimeCertificationPolicy,
  observation: RuntimeProbeObservation
): ExternalAgentVersionAssessment {
  const base = {
    runtimeId: policy.runtimeId,
    executablePath: observation.executablePath,
    executableDigest: observation.executableDigest,
    supportedRange: policy.supportedRange,
    checkedAt: observation.checkedAt,
  }

  if (observation.output === undefined) {
    return { ...base, verdict: "missing", blockingCode: VERDICT_BLOCKING_CODE.missing }
  }

  const detected = parseProbeVersion(observation.parser, observation.output)
  if (!detected) {
    return {
      ...base,
      verdict: "unparseable",
      rawOutput: truncateProbeOutput(observation.output),
      blockingCode: VERDICT_BLOCKING_CODE.unparseable,
    }
  }

  const parsed = parseSemver(detected)
  if (!parsed) {
    return {
      ...base,
      verdict: "unparseable",
      rawOutput: truncateProbeOutput(observation.output),
      blockingCode: VERDICT_BLOCKING_CODE.unparseable,
    }
  }

  if (policy.supportedRange && !satisfiesRange(parsed, policy.supportedRange)) {
    return {
      ...base,
      verdict: "unsupported",
      detectedVersion: detected,
      blockingCode: VERDICT_BLOCKING_CODE.unsupported,
    }
  }

  const certified = (policy.certifiedVersions ?? []).includes(detected)
  return certified
    ? { ...base, verdict: "certified", detectedVersion: detected }
    : {
        ...base,
        verdict: "supported-uncertified",
        detectedVersion: detected,
        blockingCode: VERDICT_BLOCKING_CODE["supported-uncertified"],
      }
}

/** May this verdict launch without any further user decision? */
export function verdictRunsUnattended(verdict: ExternalAgentVersionVerdict): boolean {
  return verdict === "certified"
}

/** Does this verdict fail closed regardless of consent? */
export function verdictFailsClosed(verdict: ExternalAgentVersionVerdict): boolean {
  return verdict === "unsupported" || verdict === "unparseable" || verdict === "missing"
}
