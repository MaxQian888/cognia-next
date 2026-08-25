import {
  deriveParams,
  paramKindChange,
  seedParamValues,
  templateSlug,
  unfilledRequiredParams,
  type ChatTemplateParam,
} from "./template"

describe("deriveParams", () => {
  it("makes every token in the body a required string parameter", () => {
    // This is what lets "save what I just wrote" work without a form: the
    // tokens are already in the text.
    expect(deriveParams("review {{module}} on {{branch}}")).toEqual([
      { id: "module", label: "module", required: true, kind: "string" },
      { id: "branch", label: "branch", required: true, kind: "string" },
    ])
  })

  it("keeps an existing declaration rather than resetting it", () => {
    const existing: ChatTemplateParam[] = [
      {
        id: "module",
        label: "Which module",
        description: "e.g. auth",
        required: false,
        kind: "enum",
        options: ["auth", "billing"],
      },
    ]

    expect(deriveParams("review {{module}}", existing)).toEqual(existing)
  })

  it("follows the body's order, not the previous list's", () => {
    // The editor walks parameters in reading order; a list that drifted out of
    // order would send Tab jumping backwards through the sentence.
    const existing = deriveParams("{{b}} {{a}}")

    expect(deriveParams("{{a}} then {{b}}", existing).map((p) => p.id)).toEqual(["a", "b"])
  })

  it("declares a repeated token once", () => {
    expect(deriveParams("{{who}} told {{who}}").map((p) => p.id)).toEqual(["who"])
  })

  it("ignores tokens inside code", () => {
    expect(deriveParams("set {{live}}\n```\n{{ jinja }}\n```").map((p) => p.id)).toEqual(["live"])
  })

  it("drops a declaration whose token has left the body", () => {
    const existing = deriveParams("{{gone}} {{kept}}")

    expect(deriveParams("{{kept}}", existing).map((p) => p.id)).toEqual(["kept"])
  })

  it("returns nothing for a body with no parameters", () => {
    expect(deriveParams("just prose")).toEqual([])
  })
})

describe("templateSlug", () => {
  it("lowercases and dash-joins", () => {
    expect(templateSlug("Review This PR")).toBe("review-this-pr")
  })

  it("keeps dots, underscores and dashes", () => {
    expect(templateSlug("v1.2_final-draft")).toBe("v1.2_final-draft")
  })

  it("strips leading and trailing separators", () => {
    expect(templateSlug("  !! hi !!  ")).toBe("hi")
  })

  it("falls back rather than returning an empty id", () => {
    // A blank slug would make two differently-named templates collide.
    expect(templateSlug("中文名")).toBe("untitled")
    expect(templateSlug("")).toBe("untitled")
  })
})

describe("unfilledRequiredParams", () => {
  const filled = {
    templateId: "t",
    version: "1",
    insertedAt: 0,
    params: { a: { kind: "text" as const, value: "x" } },
  }

  it("treats an undeclared token as required", () => {
    expect(unfilledRequiredParams(["a", "b"], filled)).toEqual(["b"])
  })

  it("lets a declared-optional parameter through unfilled", () => {
    const declarations = [
      { id: "b", label: "b", required: false, kind: "string" as const },
      { id: "c", label: "c", required: true, kind: "string" as const },
    ]
    expect(unfilledRequiredParams(["a", "b", "c"], filled, declarations)).toEqual(["c"])
  })

  it("ignores declarations for tokens no longer in the text", () => {
    const declarations = [{ id: "gone", label: "gone", required: true, kind: "string" as const }]
    expect(unfilledRequiredParams(["a"], filled, declarations)).toEqual([])
  })
})

describe("seedParamValues", () => {
  const declarations = [
    { id: "a", label: "a", required: true, kind: "string" as const, defaultValue: "fallback" },
    { id: "b", label: "b", required: true, kind: "string" as const },
    {
      id: "c",
      label: "c",
      required: true,
      kind: "resource" as const,
      resourceKind: "file" as const,
      defaultValue: "src/app.ts",
    },
  ]

  it("prefers last time's value over the declared default", () => {
    const seeded = seedParamValues(declarations, { a: { kind: "text", value: "used" } })
    expect(seeded.a).toEqual({ kind: "text", value: "used" })
  })

  it("falls back to the declared default", () => {
    expect(seedParamValues(declarations, {}).a).toEqual({ kind: "text", value: "fallback" })
  })

  it("leaves a parameter with neither unset", () => {
    expect(seedParamValues(declarations, {}).b).toBeUndefined()
  })

  // A default for a resource would be a bare id with no label behind it — the
  // dangling reference the `{id, label}` pair exists to prevent.
  it("never seeds a resource parameter from a default string", () => {
    expect(seedParamValues(declarations, {}).c).toBeUndefined()
  })

  it("drops a remembered value whose token the body no longer declares", () => {
    const seeded = seedParamValues(declarations, { gone: { kind: "text", value: "stale" } })
    expect(seeded.gone).toBeUndefined()
  })
})

describe("paramKindChange", () => {
  const param: ChatTemplateParam = { id: "a", label: "a", required: true, kind: "string" }

  // A picker that opens on nothing looks like the type change did not apply.
  it("gives a new reference somewhere to pick from", () => {
    expect(paramKindChange(param, "resource")).toEqual({ kind: "resource", resourceKind: "file" })
  })

  it("leaves a chosen source alone", () => {
    expect(paramKindChange({ ...param, resourceKind: "subagent" }, "resource")).toEqual({
      kind: "resource",
    })
  })

  // Switching away and back must not throw away a list someone typed out.
  it("keeps the fields of the type being left", () => {
    const enumParam: ChatTemplateParam = { ...param, kind: "enum", options: ["a", "b"] }
    expect(paramKindChange(enumParam, "string")).toEqual({ kind: "string" })
  })
})
