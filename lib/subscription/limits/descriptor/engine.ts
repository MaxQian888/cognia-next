// Declarative descriptor engine. Turns a `SourceDescriptor` (data) into an
// ordinary `LimitsSource` (behavior) so a new coding-plan / credit provider can
// be added as config. Pure except for the injected `authedGet`/`now`, exactly
// like the hand-written sources — tests stay offline.
//
// Flow: substitute `{{token}}`/`{{baseUrl}}`/`{{accountId}}` into the request →
// authed GET → JSON-parse → extract by dot-path → build meters via the shared
// `windowMeter`/`balanceMeter`. A thrown GET (transport/HTTP error) surfaces as
// an `errorLimits` snapshot; a parseable-but-unrecognized body yields `null`
// (the runner then falls through to the next candidate).

import { trimBase } from "@/lib/subscription/balance/adapters/_shared"

import { balanceMeter, errorLimits, windowMeter } from "../meters"
import { coerceNum, getAtPath, numAtPath } from "./path"

import type {
  BalanceExtract,
  BalanceSnapshot,
  DescriptorExtract,
  LimitsMeter,
  LimitsSource,
  LimitsSourceContext,
  ProviderLimits,
  ResetUnit,
  SourceDescriptor,
  WindowSpec,
} from "@/types/subscription"

/** Substitution variables a descriptor request can reference. */
export interface DescriptorVars {
  token: string
  baseUrl: string
  accountId: string
}

/** Replace `{{token}}`/`{{baseUrl}}`/`{{accountId}}` occurrences in a template. */
export function substitute(template: string, vars: DescriptorVars): string {
  return template.replace(/\{\{\s*(token|baseUrl|accountId)\s*\}\}/g, (_m, key: string) => {
    if (key === "token") return vars.token
    if (key === "baseUrl") return vars.baseUrl
    return vars.accountId
  })
}

/** Resolve a reset wall-clock (epoch ms) from a raw value per its unit. */
export function resolveReset(
  root: unknown,
  path: string | undefined,
  unit: ResetUnit | undefined,
  now: number
): number | null {
  if (!path) return null
  const raw = getAtPath(root, path)
  if (unit === "iso") {
    if (typeof raw !== "string") return null
    const ms = Date.parse(raw)
    return Number.isFinite(ms) ? ms : null
  }
  const num = coerceNum(raw)
  if (num == null) return null
  switch (unit) {
    case "ms":
      return num
    case "relativeSeconds":
      return now + num * 1000
    case "unix":
    default:
      // Seconds → ms heuristic (a sub-1e12 value can't be epoch-ms).
      return num < 1e12 ? num * 1000 : num
  }
}

function buildWindows(root: unknown, specs: WindowSpec[], now: number): LimitsMeter[] {
  const meters: LimitsMeter[] = []
  for (const spec of specs) {
    const raw = numAtPath(root, spec.usedPctPath)
    if (raw == null) continue
    const scale =
      typeof spec.usedPctScale === "number" && Number.isFinite(spec.usedPctScale)
        ? spec.usedPctScale
        : 1
    const scaled = raw * scale
    const utilization = spec.invert ? 100 - scaled : scaled
    meters.push(
      windowMeter(spec.id, spec.labelKey, {
        utilization,
        resetAt: resolveReset(root, spec.resetAtPath, spec.resetUnit, now),
      })
    )
  }
  return meters
}

function buildBalance(
  root: unknown,
  spec: BalanceExtract,
  ctx: { providerKey: string; accountId: string; now: number }
): LimitsMeter | null {
  const scale = typeof spec.scale === "number" && Number.isFinite(spec.scale) ? spec.scale : 1
  const scaled = (n: number | null): number | undefined => (n == null ? undefined : n * scale)
  const total = scaled(numAtPath(root, spec.totalPath))
  const used = scaled(numAtPath(root, spec.usedPath))
  const remaining = scaled(numAtPath(root, spec.remainingPath))
  if (total === undefined && used === undefined && remaining === undefined) return null

  const snap: BalanceSnapshot = {
    fetchedAt: ctx.now,
    providerKey: ctx.providerKey,
    accountId: ctx.accountId,
    kind: "credit",
    currency: spec.currency,
    unit: spec.unit ?? spec.currency,
    total,
    used,
    remaining,
    raw: (root && typeof root === "object" ? (root as Record<string, unknown>) : {}) as Record<
      string,
      unknown
    >,
  }
  return balanceMeter(snap)
}

function extractMeters(
  root: unknown,
  extract: DescriptorExtract,
  ctx: { providerKey: string; accountId: string; now: number }
): LimitsMeter[] {
  if (extract.kind === "window") return buildWindows(root, extract.windows, ctx.now)
  const meter = buildBalance(root, extract, ctx)
  return meter ? [meter] : []
}

/**
 * Run one descriptor against a resolved context. Returns a `ProviderLimits`
 * snapshot (meters or an `error`), or `null` when the source doesn't apply
 * (no token, no baseUrl, or an unrecognized response shape).
 */
export async function runDescriptor(
  descriptor: SourceDescriptor,
  ctx: LimitsSourceContext
): Promise<ProviderLimits | null> {
  if (!ctx.token) return null
  const base = ctx.baseUrl
  if (!base) return null

  const vars: DescriptorVars = {
    token: ctx.token,
    baseUrl: trimBase(base),
    accountId: ctx.accountId,
  }
  const url = `${trimBase(base)}${substitute(descriptor.request.path, vars)}`
  const extra = descriptor.request.headers ?? {}
  const hasAuthOverride = Object.keys(extra).some((k) => k.toLowerCase() === "authorization")
  const headers: Record<string, string> = { Accept: "application/json" }
  // Default to a bearer token unless the descriptor supplies its own Authorization.
  if (!hasAuthOverride) headers.Authorization = `Bearer ${ctx.token}`
  for (const [k, v] of Object.entries(extra)) {
    headers[k] = substitute(v, vars)
  }

  let body: string
  try {
    body = await ctx.authedGet(url, headers)
  } catch (err) {
    return errorLimits(ctx, descriptor.id, err instanceof Error ? err.message : String(err))
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }

  const meters = extractMeters(parsed, descriptor.extract, {
    providerKey: descriptor.id,
    accountId: ctx.accountId,
    now: ctx.now,
  })
  if (meters.length === 0) return null

  return {
    provider: descriptor.id,
    accountId: ctx.accountId,
    accountLabel: ctx.accountLabel,
    fetchedAt: ctx.now,
    meters,
  }
}

/** Project a declarative descriptor into a runnable `LimitsSource`. */
export function descriptorToSource(descriptor: SourceDescriptor): LimitsSource {
  return {
    key: descriptor.id,
    matches(q) {
      const { providerKey, baseUrlIncludes } = descriptor.match
      if (providerKey && q.providerKey === providerKey) return true
      if (baseUrlIncludes && q.baseUrl?.includes(baseUrlIncludes)) return true
      return false
    },
    fetch(ctx) {
      return runDescriptor(descriptor, ctx)
    },
  }
}
