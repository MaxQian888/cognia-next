/**
 * Command table: turns `incident create --title-en …` into the exact HTTP
 * operation the CLI will preview and send. Every write body is validated
 * with the same contract parsers the Worker uses, so an invalid write fails
 * here, before any preview or network call.
 */

import {
  COMPONENT_IDS,
  PROFILE_IDS,
  type ComponentId,
  type DeliveryRetryRequest,
  type IncidentCreateRequest,
  type IncidentResolveRequest,
  type IncidentUpdateRequest,
  type LocalizedText,
  type MaintenanceChangeRequest,
  type MaintenanceScheduleRequest,
  type ProbeDisableRequest,
  type ProbeEnrollRequest,
  type ProbeSetReferenceRequest,
} from "../../../../lib/status/contract"
import {
  parseDeliveryRetry,
  parseIncidentCreate,
  parseIncidentResolve,
  parseIncidentUpdate,
  parseMaintenanceChange,
  parseMaintenanceSchedule,
  parseProbeDisable,
  parseProbeEnroll,
  parseProbeSetReference,
  type ParseResult,
} from "../../../../lib/status/validate"
import {
  UsageError,
  integerValue,
  listValue,
  optionalValue,
  parseArgs,
  requiredValue,
  type ParsedArgs,
} from "./args"

export const GLOBAL_VALUES = ["api", "operation-id"] as const
export const GLOBAL_SWITCHES = ["yes", "json", "help"] as const

export type ReadView = "incidents" | "incident" | "maintenance" | "probes" | "deliveries"

export type Operation =
  | { kind: "read"; method: "GET"; path: string; view: ReadView }
  | {
      kind: "write"
      method: "POST"
      path: string
      body: { operationId: string } & Record<string, unknown>
      /** One line saying what the write does, for the preview. */
      summary: string
    }

export interface CommandContext {
  newOperationId(): string
}

export interface BuiltCommand {
  operation: Operation
  args: ParsedArgs
}

interface Spec {
  values: readonly string[]
  switches: readonly string[]
  build(args: ParsedArgs, ctx: CommandContext): Operation
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function positionalId(args: ParsedArgs, label: string): string {
  const id = args.positionals[0]
  if (!id) throw new UsageError(`missing <${label}>`)
  if (!ID.test(id)) throw new UsageError(`invalid ${label}: ${id}`)
  if (args.positionals.length > 1)
    throw new UsageError(`unexpected argument: ${args.positionals[1]}`)
  return id
}

function noPositionals(args: ParsedArgs): void {
  if (args.positionals.length > 0)
    throw new UsageError(`unexpected argument: ${args.positionals[0]}`)
}

function localized(args: ParsedArgs, prefix: string, required: true): LocalizedText
function localized(args: ParsedArgs, prefix: string, required: false): LocalizedText | undefined
function localized(args: ParsedArgs, prefix: string, required: boolean): LocalizedText | undefined {
  const en = optionalValue(args, `${prefix}-en`)
  const zh = optionalValue(args, `${prefix}-zh`)
  if (en === undefined) {
    if (zh !== undefined)
      throw new UsageError(`--${prefix}-zh needs --${prefix}-en (English is required)`)
    if (required) throw new UsageError(`--${prefix}-en is required`)
    return undefined
  }
  return zh === undefined || zh.trim() === "" ? { en } : { en, "zh-CN": zh }
}

function components(args: ParsedArgs, required: boolean): ComponentId[] | undefined {
  const list = listValue(args, "components")
  if (list === undefined) {
    if (required) throw new UsageError(`--components is required (${COMPONENT_IDS.join(", ")})`)
    return undefined
  }
  return list as ComponentId[]
}

function operationId(args: ParsedArgs, ctx: CommandContext): string {
  return optionalValue(args, "operation-id") ?? ctx.newOperationId()
}

function validated<T>(result: ParseResult<T>): T {
  if (!result.ok) throw new UsageError(`invalid request: ${result.error}`)
  return result.value
}

function write(path: string, body: { operationId: string } & object, summary: string): Operation {
  return {
    kind: "write",
    method: "POST",
    path,
    body: body as { operationId: string } & Record<string, unknown>,
    summary,
  }
}

const localizedFlags = (prefix: string) => [`${prefix}-en`, `${prefix}-zh`]
const enc = encodeURIComponent

const SPECS: Record<string, Spec> = {
  "incident create": {
    values: [
      ...localizedFlags("title"),
      ...localizedFlags("message"),
      "impact",
      "components",
      "state",
    ],
    switches: [],
    build(args, ctx) {
      noPositionals(args)
      const body: IncidentCreateRequest = validated(
        parseIncidentCreate({
          operationId: operationId(args, ctx),
          title: localized(args, "title", true),
          message: localized(args, "message", true),
          impact: requiredValue(args, "impact"),
          componentIds: components(args, true),
          state: optionalValue(args, "state") ?? "investigating",
        })
      )
      return write(
        "/admin/incidents",
        body,
        `create a ${body.impact} incident (${body.state}) for ${body.componentIds.join(", ")}`
      )
    },
  },
  "incident update": {
    values: [
      "revision",
      ...localizedFlags("message"),
      "state",
      "impact",
      "components",
      "correction-of",
    ],
    switches: ["pin", "unpin"],
    build(args, ctx) {
      const id = positionalId(args, "incident-id")
      if (args.switches.has("pin") && args.switches.has("unpin"))
        throw new UsageError("--pin and --unpin conflict")
      const raw: Record<string, unknown> = {
        operationId: operationId(args, ctx),
        expectedRevision: integerValue(args, "revision", true),
        message: localized(args, "message", true),
      }
      const state = optionalValue(args, "state")
      const impact = optionalValue(args, "impact")
      const ids = components(args, false)
      const correctionOf = optionalValue(args, "correction-of")
      if (state !== undefined) raw.state = state
      if (impact !== undefined) raw.impact = impact
      if (ids !== undefined) raw.componentIds = ids
      if (correctionOf !== undefined) raw.correctionOf = correctionOf
      if (args.switches.has("pin")) raw.pin = true
      if (args.switches.has("unpin")) raw.pin = false
      const body: IncidentUpdateRequest = validated(parseIncidentUpdate(raw))
      const what = [
        body.correctionOf ? `correct update ${body.correctionOf}` : "append an update",
        body.state ? `state → ${body.state}` : null,
        body.impact ? `impact → ${body.impact}` : null,
        body.pin === true
          ? "take manual ownership"
          : body.pin === false
            ? "hand back to automation"
            : null,
      ].filter(Boolean)
      return write(
        `/admin/incidents/${enc(id)}/updates`,
        body,
        `incident ${id} @ revision ${body.expectedRevision}: ${what.join(", ")}`
      )
    },
  },
  "incident resolve": {
    values: ["revision", ...localizedFlags("message"), "reason"],
    switches: [],
    build(args, ctx) {
      const id = positionalId(args, "incident-id")
      const body: IncidentResolveRequest = validated(
        parseIncidentResolve({
          operationId: operationId(args, ctx),
          expectedRevision: integerValue(args, "revision", true),
          message: localized(args, "message", true),
          reason: requiredValue(args, "reason"),
        })
      )
      return write(
        `/admin/incidents/${enc(id)}/resolve`,
        body,
        `resolve incident ${id} @ revision ${body.expectedRevision}`
      )
    },
  },
  "incident list": {
    values: ["limit", "cursor"],
    switches: [],
    build(args) {
      noPositionals(args)
      return {
        kind: "read",
        method: "GET",
        path: `/admin/incidents${pageQuery(args)}`,
        view: "incidents",
      }
    },
  },
  "incident show": {
    values: [],
    switches: [],
    build(args) {
      return {
        kind: "read",
        method: "GET",
        path: `/admin/incidents/${enc(positionalId(args, "incident-id"))}`,
        view: "incident",
      }
    },
  },
  "maintenance schedule": {
    values: [
      ...localizedFlags("title"),
      ...localizedFlags("description"),
      "components",
      "starts-at",
      "ends-at",
    ],
    switches: ["exclude", "no-exclude"],
    build(args, ctx) {
      noPositionals(args)
      const exclude = args.switches.has("exclude")
      const noExclude = args.switches.has("no-exclude")
      if (exclude === noExclude) {
        throw new UsageError(
          "say whether the window is excluded from availability: --exclude or --no-exclude"
        )
      }
      const body: MaintenanceScheduleRequest = validated(
        parseMaintenanceSchedule({
          operationId: operationId(args, ctx),
          title: localized(args, "title", true),
          description: localized(args, "description", true),
          componentIds: components(args, true),
          startsAt: requiredValue(args, "starts-at"),
          endsAt: requiredValue(args, "ends-at"),
          excludeFromAvailability: exclude,
        })
      )
      return write(
        "/admin/maintenance",
        body,
        `schedule maintenance ${body.startsAt} → ${body.endsAt} for ${body.componentIds.join(", ")}${exclude ? " (excluded from availability)" : ""}`
      )
    },
  },
  ...Object.fromEntries(
    (["extend", "reschedule", "complete", "cancel"] as const).map((action): [string, Spec] => [
      `maintenance ${action}`,
      {
        values: [
          "revision",
          ...localizedFlags("message"),
          ...(action === "extend"
            ? ["ends-at"]
            : action === "reschedule"
              ? ["starts-at", "ends-at"]
              : []),
        ],
        switches: [],
        build(args, ctx) {
          const id = positionalId(args, "maintenance-id")
          const raw: Record<string, unknown> = {
            operationId: operationId(args, ctx),
            expectedRevision: integerValue(args, "revision", true),
          }
          const message = localized(args, "message", false)
          if (message) raw.message = message
          if (action === "extend") raw.endsAt = requiredValue(args, "ends-at")
          if (action === "reschedule") {
            raw.startsAt = requiredValue(args, "starts-at")
            raw.endsAt = requiredValue(args, "ends-at")
          }
          const body: MaintenanceChangeRequest = validated(parseMaintenanceChange(raw))
          const window = body.startsAt
            ? ` to ${body.startsAt} → ${body.endsAt}`
            : body.endsAt
              ? ` to end ${body.endsAt}`
              : ""
          return write(
            `/admin/maintenance/${enc(id)}/${action}`,
            body,
            `${action} maintenance ${id}${window} @ revision ${body.expectedRevision}`
          )
        },
      },
    ])
  ),
  "maintenance list": {
    values: ["limit", "cursor"],
    switches: [],
    build(args) {
      noPositionals(args)
      return {
        kind: "read",
        method: "GET",
        path: `/admin/maintenance${pageQuery(args)}`,
        view: "maintenance",
      }
    },
  },
  "probe list": {
    values: [],
    switches: [],
    build(args) {
      noPositionals(args)
      return { kind: "read", method: "GET", path: "/admin/probes", view: "probes" }
    },
  },
  "probe enroll": {
    values: [
      "probe-id",
      "source",
      ...localizedFlags("label"),
      ...localizedFlags("location"),
      "provider",
      "enrolled-at",
      "profile",
      "key-id",
    ],
    switches: [],
    build(args, ctx) {
      noPositionals(args)
      const profiles = (args.values.get("profile") ?? []).map(parseProfile)
      if (profiles.length === 0)
        throw new UsageError("at least one --profile <id>:<http s|->:<protocol s|-> is required")
      const body: ProbeEnrollRequest = validated(
        parseProbeEnroll({
          operationId: operationId(args, ctx),
          probeId: requiredValue(args, "probe-id"),
          source: optionalValue(args, "source") ?? "external",
          label: localized(args, "label", true),
          location: localized(args, "location", false) ?? null,
          provider: optionalValue(args, "provider") ?? null,
          enrolledAt: requiredValue(args, "enrolled-at"),
          profiles,
          keyId: requiredValue(args, "key-id"),
        })
      )
      return write(
        "/admin/probes",
        body,
        `enroll probe ${body.probeId} (${body.source}) signing with key ${body.keyId} from ${body.enrolledAt}`
      )
    },
  },
  ...Object.fromEntries(
    (["disable", "enable"] as const).map((action): [string, Spec] => [
      `probe ${action}`,
      {
        values: ["reason"],
        switches: [],
        build(args, ctx) {
          const probeId = positionalId(args, "probe-id")
          const body: ProbeDisableRequest = validated(
            parseProbeDisable({
              operationId: operationId(args, ctx),
              probeId,
              disabled: action === "disable",
              reason: requiredValue(args, "reason"),
            })
          )
          return write("/admin/probes/disable", body, `${action} probe ${probeId}`)
        },
      },
    ])
  ),
  "probe set-reference": {
    values: ["effective-at", "reason"],
    switches: [],
    build(args, ctx) {
      const probeId = positionalId(args, "probe-id")
      const body: ProbeSetReferenceRequest = validated(
        parseProbeSetReference({
          operationId: operationId(args, ctx),
          probeId,
          effectiveAt: requiredValue(args, "effective-at"),
          reason: requiredValue(args, "reason"),
        })
      )
      return write(
        "/admin/probes/set-reference",
        body,
        `make ${probeId} the reference observer from ${body.effectiveAt}`
      )
    },
  },
  "delivery inspect": {
    values: ["state", "limit"],
    switches: [],
    build(args) {
      noPositionals(args)
      const query = new URLSearchParams()
      const state = optionalValue(args, "state")
      const limit = integerValue(args, "limit", false)
      if (state) query.set("state", state)
      if (limit !== undefined) query.set("limit", String(limit))
      const qs = query.toString()
      return {
        kind: "read",
        method: "GET",
        path: `/admin/delivery${qs ? `?${qs}` : ""}`,
        view: "deliveries",
      }
    },
  },
  "delivery retry": {
    values: [],
    switches: ["acknowledge-uncertain"],
    build(args, ctx) {
      const outboxId = positionalId(args, "outbox-id")
      const body: DeliveryRetryRequest = validated(
        parseDeliveryRetry({
          operationId: operationId(args, ctx),
          outboxId,
          acknowledgeUncertain: args.switches.has("acknowledge-uncertain"),
        })
      )
      return write(
        "/admin/delivery/retry",
        body,
        `deliberately resend outbox row ${outboxId}${body.acknowledgeUncertain ? " (provider evidence checked for an uncertain send)" : ""}`
      )
    },
  },
}

function pageQuery(args: ParsedArgs): string {
  const query = new URLSearchParams()
  const limit = integerValue(args, "limit", false)
  const cursor = optionalValue(args, "cursor")
  if (limit !== undefined) query.set("limit", String(limit))
  if (cursor) query.set("cursor", cursor)
  const qs = query.toString()
  return qs ? `?${qs}` : ""
}

/** `native:60:60`, `web:-:300` (`-` = that check class is not run). */
export function parseProfile(raw: string): {
  id: string
  httpCadenceSeconds: number | null
  protocolCadenceSeconds: number | null
} {
  const parts = raw.split(":")
  if (parts.length !== 3 || !(PROFILE_IDS as readonly string[]).includes(parts[0] ?? "")) {
    throw new UsageError(
      `--profile must be <${PROFILE_IDS.join("|")}>:<http seconds|->:<protocol seconds|->, got ${raw}`
    )
  }
  const cadence = (value: string | undefined): number | null => {
    if (value === "-") return null
    if (!value || !/^\d+$/.test(value)) throw new UsageError(`invalid cadence in --profile ${raw}`)
    return Number(value)
  }
  return {
    id: parts[0] ?? "",
    httpCadenceSeconds: cadence(parts[1]),
    protocolCadenceSeconds: cadence(parts[2]),
  }
}

export const COMMANDS = Object.keys(SPECS).sort()

/** Resolve the command words and parse its flags (plus the global ones). */
export function buildCommand(argv: readonly string[], ctx: CommandContext): BuiltCommand {
  const [group, verb, ...rest] = argv
  const name = `${group ?? ""} ${verb ?? ""}`
  const spec = SPECS[name]
  if (!spec || !Object.hasOwn(SPECS, name))
    throw new UsageError(`unknown command: ${name.trim() || "(none)"}`)
  const args = parseArgs(rest, {
    values: [...spec.values, ...GLOBAL_VALUES],
    switches: [...spec.switches, ...GLOBAL_SWITCHES],
  })
  return { operation: spec.build(args, ctx), args }
}
