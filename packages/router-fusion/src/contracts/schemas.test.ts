import Ajv2020 from "ajv/dist/2020"

import examples from "./spec/examples.json"
import internalSchema from "./spec/internal.schema.json"
import { CONTRACT_SCHEMAS, type ContractName } from "./schemas"

type JsonSchema = Record<string, unknown>

const defs = (internalSchema as { $defs: Record<string, JsonSchema> }).$defs

const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false })
ajv.addSchema(internalSchema as object, "contracts")

function ajvValid(name: string, value: unknown): boolean {
  const validate = ajv.getSchema(`contracts#/$defs/${name}`)
  if (!validate) throw new Error(`no ajv schema for ${name}`)
  return validate(value) as boolean
}

function zodValid(name: ContractName, value: unknown): boolean {
  return CONTRACT_SCHEMAS[name].safeParse(value).success
}

const FORMAT_SAMPLES: Record<string, string> = {
  uuid: "11111111-1111-4111-8111-111111111111",
  "date-time": "2026-09-15T08:00:00Z",
  uri: "https://example.invalid/artifact",
}

const PATTERN_SAMPLES: Record<string, string> = {
  "^(0|[1-9][0-9]{0,5})(\\.[0-9]{1,6})?$": "0.500000",
  "^[0-9a-f]{64}$": "a".repeat(64),
}

/**
 * Conditional keywords (`allOf`/`if`/`then`, `dependentRequired`) are not
 * expressible by the structural sampler below; these fix-ups turn the sampled
 * superset into the one valid shape for each conditional definition.
 */
const CONDITIONAL_FIXUPS: Record<
  string,
  (value: Record<string, unknown>) => Record<string, unknown>
> = {
  QualityEstimate: (value) => ({ ...value, source: "rule", p_pass: null }),
  ResumeRequest: ({ approval_id: _approval, decision: _decision, ...rest }) => ({
    ...rest,
    kind: "input",
  }),
}

function sampleDef(name: string): unknown {
  const value = sample(defs[name])
  const fixup = CONDITIONAL_FIXUPS[name]
  return fixup ? fixup(value as Record<string, unknown>) : value
}

/** Build the smallest instance that satisfies a JSON Schema node, including optional fields. */
function sample(node: JsonSchema): unknown {
  if (typeof node.$ref === "string") {
    return sampleDef(node.$ref.replace("#/$defs/", ""))
  }
  if ("const" in node) return node.const
  if (Array.isArray(node.enum)) return node.enum[0]
  if (Array.isArray(node.anyOf)) return sample(node.anyOf[0] as JsonSchema)
  switch (node.type) {
    case "string": {
      if (typeof node.format === "string") return FORMAT_SAMPLES[node.format]
      if (typeof node.pattern === "string") return PATTERN_SAMPLES[node.pattern]
      const min = typeof node.minLength === "number" ? node.minLength : 0
      return "x".repeat(Math.max(1, min))
    }
    case "integer":
    case "number":
      return typeof node.minimum === "number" ? node.minimum : 0
    case "boolean":
      return false
    case "array": {
      const min = typeof node.minItems === "number" ? node.minItems : 0
      const items = node.items as JsonSchema
      if (min === 0) return []
      // uniqueItems arrays of enums need distinct members.
      if (node.uniqueItems && Array.isArray(items.enum)) return items.enum.slice(0, min)
      return Array.from({ length: min }, () => sample(items))
    }
    case "object": {
      const out: Record<string, unknown> = {}
      const props = (node.properties ?? {}) as Record<string, JsonSchema>
      for (const [key, prop] of Object.entries(props)) out[key] = sample(prop)
      return out
    }
    default:
      return {}
  }
}

describe("Router + Fusion contract parity with internal.schema.json", () => {
  it("mirrors every $defs entry and nothing else", () => {
    expect(Object.keys(CONTRACT_SCHEMAS).sort()).toEqual(Object.keys(defs).sort())
  })

  it.each(Object.keys(defs))("accepts a generated valid %s in both validators", (name) => {
    const value = sampleDef(name)
    expect(ajvValid(name, value)).toBe(true)
    expect(zodValid(name as ContractName, value)).toBe(true)
  })

  it.each(Object.keys(defs).filter((name) => defs[name].type === "object"))(
    "[ACC:AUTH-06] rejects unknown fields on %s in both validators",
    (name) => {
      const value = { ...(sampleDef(name) as object), tenant_id: "forged" }
      expect(ajvValid(name, value)).toBe(false)
      expect(zodValid(name as ContractName, value)).toBe(false)
    }
  )

  const requiredCases = Object.entries(defs).flatMap(([name, node]) =>
    ((node.required as string[] | undefined) ?? []).map((field) => [name, field] as const)
  )

  it.each(requiredCases)("rejects %s without required %s in both validators", (name, field) => {
    const value = { ...(sampleDef(name) as Record<string, unknown>) }
    delete value[field]
    expect(ajvValid(name, value)).toBe(false)
    expect(zodValid(name as ContractName, value)).toBe(false)
  })

  const enumCases = Object.entries(defs).flatMap(([name, node]) =>
    Object.entries((node.properties ?? {}) as Record<string, JsonSchema>)
      .filter(([, prop]) => Array.isArray(prop.enum))
      .map(([field]) => [name, field] as const)
  )

  it.each(enumCases)("rejects an out-of-enum %s.%s in both validators", (name, field) => {
    const value = { ...(sampleDef(name) as Record<string, unknown>), [field]: "__not_in_enum__" }
    expect(ajvValid(name, value)).toBe(false)
    expect(zodValid(name as ContractName, value)).toBe(false)
  })

  it.each(
    (examples as Array<{ name: string; schema: string; value: unknown }>).map((e) => [e.name, e])
  )("accepts the bundled example %s", (_label, example) => {
    expect(ajvValid(example.schema, example.value)).toBe(true)
    expect(zodValid(example.schema as ContractName, example.value)).toBe(true)
  })

  it("rejects money with binary-float noise or more than six decimals", () => {
    for (const bad of ["0.1234567", "01.5", "-1", "1e3", "1000000"]) {
      expect(ajvValid("MoneyUSD", bad)).toBe(false)
      expect(zodValid("MoneyUSD", bad)).toBe(false)
    }
  })

  it("enforces dependentRequired between session_id and expected_session_version", () => {
    const { expected_session_version: _dropped, ...value } = sampleDef("RunRequest") as Record<
      string,
      unknown
    >
    expect(ajvValid("RunRequest", value)).toBe(false)
    expect(zodValid("RunRequest", value)).toBe(false)
  })

  it("[ACC:ROUTE-01] refuses an individual p_pass from a rule or eval source", () => {
    for (const source of ["rule", "eval"]) {
      const value = { ...(sampleDef("QualityEstimate") as object), source, p_pass: 0.95 }
      expect(ajvValid("QualityEstimate", value)).toBe(false)
      expect(zodValid("QualityEstimate", value)).toBe(false)
    }
  })

  it("requires p_pass and predictor_version from a model source", () => {
    const base = sampleDef("QualityEstimate") as Record<string, unknown>
    const ok = { ...base, source: "model", p_pass: 0.7, predictor_version: "logreg-1" }
    expect(ajvValid("QualityEstimate", ok)).toBe(true)
    expect(zodValid("QualityEstimate", ok)).toBe(true)
    for (const bad of [
      { ...ok, p_pass: null },
      { ...ok, predictor_version: null },
    ]) {
      expect(ajvValid("QualityEstimate", bad)).toBe(false)
      expect(zodValid("QualityEstimate", bad)).toBe(false)
    }
  })

  it("keeps input and approval resumes mutually exclusive", () => {
    const input = sampleDef("ResumeRequest") as Record<string, unknown>
    const approval = {
      kind: "approval",
      expected_run_version: 3,
      approval_id: "33333333-3333-4333-8333-333333333333",
      decision: "approve",
    }
    expect(ajvValid("ResumeRequest", approval)).toBe(true)
    expect(zodValid("ResumeRequest", approval)).toBe(true)
    for (const bad of [
      { ...input, decision: "approve" },
      { ...approval, input_messages: input.input_messages },
      { kind: "approval", expected_run_version: 1 },
      { kind: "input", expected_run_version: 1 },
    ]) {
      expect(ajvValid("ResumeRequest", bad)).toBe(false)
      expect(zodValid("ResumeRequest", bad)).toBe(false)
    }
  })

  it("enforces uniqueItems on allowed_modes", () => {
    const value = {
      ...(sampleDef("RunRequest") as Record<string, unknown>),
      allowed_modes: ["direct", "direct"],
    }
    expect(ajvValid("RunRequest", value)).toBe(false)
    expect(zodValid("RunRequest", value)).toBe(false)
  })
})
