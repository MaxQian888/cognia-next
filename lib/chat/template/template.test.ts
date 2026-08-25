import { deriveParams, templateSlug, type ChatTemplateParam } from "./template"

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
