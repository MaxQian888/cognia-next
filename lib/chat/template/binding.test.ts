import {
  isParamFilled,
  paramState,
  paramValueText,
  pruneBinding,
  unfilledParams,
  withParamValue,
  type ChatTemplateBinding,
  type ChatTemplateParamValue,
} from "./binding"

const text = (value: string): ChatTemplateParamValue => ({ kind: "text", value })
const resource = (id: string, label = "Auth module"): ChatTemplateParamValue => ({
  kind: "resource",
  resourceKind: "file",
  id,
  label,
})

function binding(params: Record<string, ChatTemplateParamValue> = {}): ChatTemplateBinding {
  return { templateId: "user.chat.review", version: "1.2.0", params, insertedAt: 1 }
}

describe("isParamFilled", () => {
  it("treats a missing entry as unfilled", () => {
    expect(isParamFilled(undefined)).toBe(false)
  })

  it("does not count whitespace as a value", () => {
    expect(isParamFilled(text("   "))).toBe(false)
    expect(isParamFilled(text("a"))).toBe(true)
  })

  it("counts a resource by its id, not its label", () => {
    // A label with no id is a leftover from a resource that was cleared; it
    // must not read as filled, or the send gate would wave it through.
    expect(isParamFilled(resource(""))).toBe(false)
    expect(isParamFilled(resource("root-1"))).toBe(true)
  })
})

describe("paramValueText", () => {
  it("contributes the text of a text value", () => {
    expect(paramValueText(text("login module"))).toBe("login module")
  })

  it("contributes a resource's label, never its id", () => {
    // A prompt reads "the auth module", never `root-a1b2c3`.
    expect(paramValueText(resource("root-a1b2c3", "the auth module"))).toBe("the auth module")
  })

  it("contributes nothing for an unset parameter", () => {
    expect(paramValueText(undefined)).toBe("")
  })
})

describe("paramState", () => {
  it("reads empty when nothing is set", () => {
    expect(paramState(undefined)).toBe("empty")
    expect(paramState(text(" "))).toBe("empty")
  })

  it("reads filled for a text value", () => {
    expect(paramState(text("x"))).toBe("filled")
  })

  it("assumes a resource resolves when no resolver is given", () => {
    // The right default on the device that filled it in.
    expect(paramState(resource("root-1"))).toBe("filled")
  })

  it("reads unresolved when the resource is gone on this device", () => {
    expect(paramState(resource("root-1"), () => false)).toBe("unresolved")
  })

  it("never asks the resolver about a text value", () => {
    const resolver = jest.fn(() => false)
    expect(paramState(text("x"), resolver)).toBe("filled")
    expect(resolver).not.toHaveBeenCalled()
  })
})

describe("unfilledParams", () => {
  it("returns the unfilled ids in the order given", () => {
    expect(unfilledParams(["a", "b", "c"], binding({ b: text("set") }))).toEqual(["a", "c"])
  })

  it("treats a missing binding as everything unfilled", () => {
    expect(unfilledParams(["a", "b"], undefined)).toEqual(["a", "b"])
  })
})

describe("withParamValue", () => {
  it("sets one parameter and leaves the others alone", () => {
    const next = withParamValue(binding({ a: text("one") }), "b", text("two"))

    expect(next.params).toEqual({ a: text("one"), b: text("two") })
  })

  it("does not mutate the input", () => {
    const original = binding({ a: text("one") })
    withParamValue(original, "b", text("two"))

    expect(original.params).toEqual({ a: text("one") })
  })
})

describe("pruneBinding", () => {
  it("drops values whose token has left the text", () => {
    // Breaking a token is how the user demotes a chip. The value must go with
    // it, or retyping `{{b}}` later would resurrect a value from a sentence
    // that no longer exists.
    const next = pruneBinding(binding({ a: text("keep"), b: text("gone") }), ["a"])

    expect(next.params).toEqual({ a: text("keep") })
  })

  it("returns the same object when nothing changed, so callers can skip a write", () => {
    const original = binding({ a: text("keep") })

    expect(pruneBinding(original, ["a", "b"])).toBe(original)
  })
})
