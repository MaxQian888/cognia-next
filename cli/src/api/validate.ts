/**
 * Turn typed flags and `--data` into a request body, or refuse before sending.
 *
 * Every companion request schema is `additionalProperties: false` and the host
 * enforces it at runtime, so an unrecognised field is a guaranteed 422. The
 * generated index already knows the whole shape, which means the CLI can turn
 * that round trip into a local refusal that names the field it did not
 * recognise and the ones it did. The same is true of a missing required field
 * and of an enum the host would reject.
 */

import fs from "node:fs"

import { GLOBAL_FLAG_NAMES } from "../cli/format"
import type { ApiCommandEntry, ApiCommandFlag } from "./types"

export interface BodyRefusal {
  ok: false
  error: string
  details?: string[]
  fix: string[]
}

export interface BodyAccepted {
  ok: true
  body: Record<string, unknown>
}

export type BodyResult = BodyAccepted | BodyRefusal

/** Read `--data`: inline JSON, `@file`, or `-` for stdin. */
export interface DataSourceDeps {
  readFile?: (target: string) => string
  readStdin?: () => string
}

export function parseDataFlag(
  raw: string,
  deps: DataSourceDeps = {}
): { ok: true; value: unknown } | BodyRefusal {
  let text = raw
  try {
    if (raw === "-") {
      // Descriptor 0 rather than `process.stdin`, so a piped body is read
      // synchronously and the caller stays a plain function.
      const readStdin = deps.readStdin ?? (() => fs.readFileSync(0, "utf8"))
      text = readStdin()
    } else if (raw.startsWith("@")) {
      const readFile = deps.readFile ?? ((target: string) => fs.readFileSync(target, "utf8"))
      text = readFile(raw.slice(1))
    }
  } catch (error) {
    return {
      ok: false,
      error: `cannot read --data ${raw}`,
      details: [error instanceof Error ? error.message : String(error)],
      fix: ["point --data at a readable file, or pass the JSON inline"],
    }
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch (error) {
    return {
      ok: false,
      error: "--data is not valid JSON",
      details: [error instanceof Error ? error.message : String(error)],
      fix: ["pass a JSON object, or use @file to read one from disk"],
    }
  }
}

function coerce(
  flag: ApiCommandFlag,
  raw: string | boolean
): { value: unknown } | { error: string } {
  if (flag.type === "boolean") {
    if (typeof raw === "boolean") return { value: raw }
    if (raw === "true") return { value: true }
    if (raw === "false") return { value: false }
    return { error: `--${flag.flag} takes true or false, got "${raw}"` }
  }
  if (typeof raw === "boolean") {
    return { error: `--${flag.flag} needs a value` }
  }
  if (flag.nullable && raw === "null") return { value: null }
  if (flag.type === "integer" || flag.type === "number") {
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return { error: `--${flag.flag} takes a number, got "${raw}"` }
    if (flag.type === "integer" && !Number.isInteger(parsed)) {
      return { error: `--${flag.flag} takes a whole number, got "${raw}"` }
    }
    return { value: parsed }
  }
  if (flag.type === "json") {
    try {
      return { value: JSON.parse(raw) as unknown }
    } catch {
      return {
        error: `--${flag.flag} takes JSON (this field is an object or array), got "${raw}"`,
      }
    }
  }
  return { value: raw }
}

function nearestFlag(entry: ApiCommandEntry, name: string): string | undefined {
  const candidates = entry.flags.map((flag) => flag.flag).filter((flag) => flag.length > 0)
  let best: { flag: string; score: number } | undefined
  for (const candidate of candidates) {
    let shared = 0
    while (
      shared < candidate.length &&
      shared < name.length &&
      candidate[shared] === name[shared]
    ) {
      shared++
    }
    if (shared >= 3 && (!best || shared > best.score)) best = { flag: candidate, score: shared }
  }
  return best?.flag
}

export interface BuildBodyInput {
  entry: ApiCommandEntry
  /** The parsed flag map, globals included. */
  flags: Record<string, string | boolean>
  /** Already-parsed `--data`, when one was given. */
  data?: unknown
}

export function buildRequestBody(input: BuildBodyInput): BodyResult {
  const { entry, flags, data } = input

  if (data !== undefined && (typeof data !== "object" || data === null || Array.isArray(data))) {
    return {
      ok: false,
      error: "--data must be a JSON object, because a request body is a set of named fields",
      fix: [`cognia-agent api schema ${entry.name} --template`],
    }
  }

  const body: Record<string, unknown> = { ...((data as Record<string, unknown>) ?? {}) }
  const byFlag = new Map(
    entry.flags.filter((flag) => flag.flag.length > 0).map((flag) => [flag.flag, flag])
  )

  if (entry.bodyKind === "composed") {
    const stray = Object.keys(flags).filter(
      (name) => !GLOBAL_FLAG_NAMES.has(name) && !name.startsWith("_")
    )
    if (stray.length > 0) {
      return {
        ok: false,
        error: `${entry.name} takes alternative request shapes, so it has no per-field flags`,
        details: [`unused: ${stray.map((name) => `--${name}`).join(", ")}`],
        fix: [
          `pass the whole body with --data, e.g. cognia-agent api call ${entry.name} --data '{}'`,
        ],
      }
    }
    if (data === undefined) {
      return {
        ok: false,
        error: `${entry.name} needs --data`,
        details: ["its request body is a choice between shapes, which flags cannot express"],
        fix: [`cognia-agent api describe ${entry.name}`],
      }
    }
    return { ok: true, body }
  }

  const unknown: string[] = []
  for (const [name, raw] of Object.entries(flags)) {
    if (GLOBAL_FLAG_NAMES.has(name)) continue
    const flag = byFlag.get(name)
    if (!flag) {
      unknown.push(name)
      continue
    }
    const coerced = coerce(flag, raw)
    if ("error" in coerced) {
      return {
        ok: false,
        error: coerced.error,
        ...(flag.enum ? { details: [`allowed: ${flag.enum.join(", ")}`] } : {}),
        fix: [`cognia-agent api describe ${entry.name}`],
      }
    }
    body[flag.name] = coerced.value
  }

  if (unknown.length > 0) {
    const suggestions = unknown
      .map((name) => {
        const near = nearestFlag(entry, name)
        return near
          ? `--${name} is not a field of ${entry.name} (did you mean --${near}?)`
          : undefined
      })
      .filter((line): line is string => line !== undefined)
    return {
      ok: false,
      error: `${entry.name} has no field for ${unknown.map((name) => `--${name}`).join(", ")}`,
      details: suggestions.length > 0 ? suggestions : undefined,
      fix: [
        `cognia-agent api describe ${entry.name}`,
        "the host rejects unknown fields outright, so this would have failed on the wire",
      ],
    }
  }

  // Enum membership, checked only for what the caller actually supplied. A
  // value that came in through --data gets the same check as one from a flag.
  for (const flag of entry.flags) {
    const value = body[flag.name]
    if (value === undefined) continue
    if (value === null && flag.nullable) continue
    if (flag.enum && typeof value === "string" && !flag.enum.includes(value)) {
      return {
        ok: false,
        error: `${flag.name} does not accept "${value}"`,
        details: [`allowed: ${flag.enum.join(", ")}`],
        fix: [`cognia-agent api describe ${entry.name}`],
      }
    }
  }

  const missing = entry.flags
    .filter((flag) => flag.required && body[flag.name] === undefined)
    .map((flag) => flag)
  if (missing.length > 0) {
    return {
      ok: false,
      error: `${entry.name} is missing ${missing.map((flag) => flag.name).join(", ")}`,
      fix: missing.map((flag) =>
        flag.flag.length > 0
          ? `pass --${flag.flag} <${flag.type}>`
          : `include "${flag.name}" in --data`
      ),
    }
  }

  for (const group of entry.requireOneOf ?? []) {
    if (group.some((name) => body[name] !== undefined)) continue
    return {
      ok: false,
      error: `${entry.name} needs one of ${group.join(" or ")}`,
      details: ["these are alternative spellings of the same field"],
      fix: [`pass --${group[0].replace(/_/g, "-")} <value>`],
    }
  }

  return { ok: true, body }
}

/** A fillable request body for `api schema --template`. */
export function requestTemplate(entry: ApiCommandEntry): Record<string, unknown> {
  if (entry.bodyKind === "composed") return {}
  const template: Record<string, unknown> = {}
  const seen = new Set<string>()
  for (const flag of entry.flags) {
    // Only one spelling of an alias pair belongs in a template. Sending both
    // is not wrong, but it invites editing one and forgetting the other.
    const group = entry.requireOneOf?.find((names) => names.includes(flag.name))
    if (group) {
      if (seen.has(group[0])) continue
      seen.add(group[0])
      if (flag.name !== group[0]) continue
    }
    if (flag.enum) {
      template[flag.name] = flag.enum[0]
    } else if (flag.type === "boolean") {
      template[flag.name] = false
    } else if (flag.type === "integer" || flag.type === "number") {
      template[flag.name] = 0
    } else if (flag.type === "json") {
      template[flag.name] = {}
    } else {
      template[flag.name] = ""
    }
  }
  return template
}
