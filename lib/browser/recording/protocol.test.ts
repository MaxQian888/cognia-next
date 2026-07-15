import {
  appendStep,
  hasTarget,
  isReplayable,
  requiredSecrets,
  resolveStepUrl,
  secretKey,
  supersedes,
  type ClickStep,
  type FillStep,
  type NavigateStep,
  type PressKeyStep,
  type RecordedFlow,
  type RecordedStep,
  type RecordedTarget,
  type SelectStep,
  type WaitForStep,
} from "@/lib/browser/recording/protocol"

function target(selector: string, over: Partial<RecordedTarget> = {}): RecordedTarget {
  return { selector, role: "button", name: "Sign in", domPath: "form > button", ...over }
}

function click(selector: string, at = 1): ClickStep {
  return { act: "click", at, target: target(selector) }
}

function fill(selector: string, value: string, at = 1): FillStep {
  return { act: "fill", at, target: target(selector, { role: "textbox", name: "Email" }), value }
}

function select(selector: string, value: string, at = 1): SelectStep {
  return { act: "select", at, target: target(selector, { role: "combobox", name: "Plan" }), value }
}

function navigate(url: string, at = 1): NavigateStep {
  return { act: "navigate", at, url }
}

function flow(over: Partial<RecordedFlow> = {}): RecordedFlow {
  return {
    id: "flow_1",
    name: "login",
    baseUrl: "http://localhost:3000",
    createdAt: 0,
    updatedAt: 0,
    steps: [],
    ...over,
  }
}

describe("hasTarget", () => {
  it("narrows element-addressing steps", () => {
    expect(hasTarget(click("#a"))).toBe(true)
    expect(hasTarget(fill("#a", "x"))).toBe(true)
    expect(hasTarget(select("#a", "x"))).toBe(true)
  })

  it("rejects steps with no element", () => {
    expect(hasTarget(navigate("http://localhost:3000/"))).toBe(false)
    expect(hasTarget({ act: "wait_for", at: 1, text: "Welcome" } satisfies WaitForStep)).toBe(false)
  })

  it("treats a targetless press_key as untargeted", () => {
    const bare: PressKeyStep = { act: "press_key", at: 1, key: "Enter" }
    const aimed: PressKeyStep = { act: "press_key", at: 1, key: "Enter", target: target("#a") }
    expect(hasTarget(bare)).toBe(false)
    expect(hasTarget(aimed)).toBe(true)
  })
})

describe("supersedes", () => {
  it("supersedes a fill on the same element", () => {
    expect(supersedes(fill("#email", "a@"), fill("#email", "a@b.c"))).toBe(true)
  })

  it("supersedes a select on the same element", () => {
    expect(supersedes(select("#plan", "free"), select("#plan", "pro"))).toBe(true)
  })

  it("does not supersede across different elements", () => {
    expect(supersedes(fill("#email", "x"), fill("#password", "y"))).toBe(false)
  })

  it("does not supersede across different acts", () => {
    expect(supersedes(fill("#email", "x"), click("#email"))).toBe(false)
  })

  it("never supersedes clicks — two clicks are two real interactions", () => {
    expect(supersedes(click("#submit"), click("#submit"))).toBe(false)
  })

  it("never supersedes navigations", () => {
    expect(supersedes(navigate("http://a/"), navigate("http://a/"))).toBe(false)
  })
})

describe("appendStep", () => {
  it("appends to an empty flow", () => {
    expect(appendStep([], click("#a"))).toEqual([click("#a")])
  })

  it("collapses keystroke-level edits into the settled value", () => {
    let steps: RecordedStep[] = []
    steps = appendStep(steps, fill("#email", "a"))
    steps = appendStep(steps, fill("#email", "a@b"))
    steps = appendStep(steps, fill("#email", "a@b.c"))
    expect(steps).toHaveLength(1)
    expect((steps[0] as FillStep).value).toBe("a@b.c")
  })

  it("keeps fills on distinct elements", () => {
    let steps: RecordedStep[] = []
    steps = appendStep(steps, fill("#email", "a@b.c"))
    steps = appendStep(steps, fill("#password", "hunter2"))
    expect(steps).toHaveLength(2)
  })

  it("drops a duplicate navigation — click + history hook both report it", () => {
    const steps = appendStep(
      [navigate("http://localhost:3000/x")],
      navigate("http://localhost:3000/x")
    )
    expect(steps).toHaveLength(1)
  })

  it("keeps a navigation to a genuinely different url", () => {
    const steps = appendStep(
      [navigate("http://localhost:3000/a")],
      navigate("http://localhost:3000/b")
    )
    expect(steps).toHaveLength(2)
  })

  it("does not collapse a navigation that returns to an earlier url", () => {
    let steps: RecordedStep[] = []
    steps = appendStep(steps, navigate("http://localhost:3000/a"))
    steps = appendStep(steps, navigate("http://localhost:3000/b"))
    steps = appendStep(steps, navigate("http://localhost:3000/a"))
    expect(steps).toHaveLength(3)
  })

  it("does not mutate the input array", () => {
    const original = [fill("#email", "a")]
    const next = appendStep(original, fill("#email", "ab"))
    expect(original).toHaveLength(1)
    expect((original[0] as FillStep).value).toBe("a")
    expect(next).not.toBe(original)
  })
})

// Secrecy is a property of the FIELD, not of one `change` event. A user can
// reveal a password field (the eye toggle flips it to `type="text"`) and fix a
// typo, and the overlay then reports a second, plaintext `change` on the same
// selector. Collapsing that into the recorded step must never drop the flag:
// the surviving step feeds `requiredSecrets` (what the panel prompts for), the
// Playwright export (`process.env.*` vs a literal), and the agent export (a
// model prompt). A downgrade here writes the credential to all three.
describe("appendStep — secrecy is sticky", () => {
  const pwTarget = target("#pw", { role: "textbox", name: "Password" })
  const secretPw = (at = 1): FillStep => ({
    act: "fill",
    at,
    target: pwTarget,
    value: "",
    secret: true,
  })
  /** The same field after the reveal toggle: `type="text"`, so it fills plain. */
  const revealedPw = (value: string, at = 2): FillStep => ({
    act: "fill",
    at,
    target: pwTarget,
    value,
  })

  it("does not let a revealed plaintext fill downgrade the secret step", () => {
    const steps = appendStep([secretPw()], revealedPw("hunter2-fixed"))
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ act: "fill", secret: true, value: "" })
  })

  it("never keeps the plaintext credential in the collapsed value", () => {
    const steps = appendStep([secretPw()], revealedPw("hunter2-fixed"))
    expect(JSON.stringify(steps)).not.toContain("hunter2-fixed")
  })

  it("still prompts for the secret after a reveal-toggle edit", () => {
    const steps = appendStep([secretPw()], revealedPw("hunter2-fixed"))
    expect(requiredSecrets(flow({ steps }))).toEqual(["PASSWORD"])
  })

  it("promotes to secret when the plain fill lands first", () => {
    const steps = appendStep([revealedPw("hunter2", 1)], secretPw(2))
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ act: "fill", secret: true, value: "" })
  })

  it("leaves an ordinary field alone — stickiness only latches on secrets", () => {
    const steps = appendStep([fill("#email", "a@b")], fill("#email", "a@b.c", 2))
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ value: "a@b.c" })
    expect((steps[0] as FillStep).secret).toBeUndefined()
  })

  it("does not leak secrecy onto a different field", () => {
    let steps: RecordedStep[] = []
    steps = appendStep(steps, secretPw())
    steps = appendStep(steps, fill("#email", "a@b.c", 2))
    expect(steps).toHaveLength(2)
    expect((steps[1] as FillStep).secret).toBeUndefined()
    expect((steps[1] as FillStep).value).toBe("a@b.c")
  })

  it("collapses a select without inventing a secret flag", () => {
    const steps = appendStep([select("#plan", "free")], select("#plan", "pro", 2))
    expect(steps).toEqual([select("#plan", "pro", 2)])
  })
})

describe("isReplayable", () => {
  it("rejects an empty flow", () => {
    expect(isReplayable(flow())).toBe(false)
  })

  it("rejects an assertion-only flow — there is nothing to drive", () => {
    expect(isReplayable(flow({ steps: [{ act: "wait_for", at: 1, text: "Welcome" }] }))).toBe(false)
  })

  it("accepts a flow with a real interaction", () => {
    expect(isReplayable(flow({ steps: [click("#submit")] }))).toBe(true)
  })
})

describe("secretKey", () => {
  it("derives the key from the accessible name", () => {
    expect(secretKey(target("#pw", { name: "Password" }))).toBe("PASSWORD")
  })

  it("normalizes punctuation and spacing into one underscore run", () => {
    expect(secretKey(target("#pw", { name: "Admin  API-Token!" }))).toBe("ADMIN_API_TOKEN")
  })

  it("falls back to the selector when the field has no name", () => {
    expect(secretKey(target("#api_key", { name: null }))).toBe("API_KEY")
  })

  it("falls back to the selector when the name is only whitespace", () => {
    expect(secretKey(target("#pw", { name: "   " }))).toBe("PW")
  })

  it("degrades to SECRET when nothing yields an identifier", () => {
    expect(secretKey(target("###", { name: null }))).toBe("SECRET")
  })
})

describe("requiredSecrets", () => {
  const secretFill = (selector: string, name: string): FillStep => ({
    act: "fill",
    at: 1,
    target: target(selector, { name }),
    value: "",
    secret: true,
  })

  it("is empty for a flow with no secrets", () => {
    expect(requiredSecrets(flow({ steps: [fill("#email", "a@b.c")] }))).toEqual([])
  })

  it("lists the keys replay must be given", () => {
    expect(
      requiredSecrets(flow({ steps: [secretFill("#pw", "Password"), secretFill("#tok", "Token")] }))
    ).toEqual(["PASSWORD", "TOKEN"])
  })

  it("dedupes a secret entered twice", () => {
    expect(
      requiredSecrets(
        flow({ steps: [secretFill("#pw", "Password"), secretFill("#pw", "Password")] })
      )
    ).toEqual(["PASSWORD"])
  })

  it("ignores non-secret fills", () => {
    expect(
      requiredSecrets(flow({ steps: [fill("#email", "a@b.c"), secretFill("#pw", "Password")] }))
    ).toEqual(["PASSWORD"])
  })
})

describe("resolveStepUrl", () => {
  it("passes an absolute url through", () => {
    expect(resolveStepUrl(flow(), "http://localhost:3000/login")).toBe(
      "http://localhost:3000/login"
    )
  })

  it("resolves a relative url against the base", () => {
    expect(resolveStepUrl(flow(), "/login")).toBe("http://localhost:3000/login")
  })

  it("keeps a cross-origin navigation recorded within the flow", () => {
    expect(resolveStepUrl(flow(), "https://auth.example.com/sso")).toBe(
      "https://auth.example.com/sso"
    )
  })

  it("returns the raw value when neither the url nor the base can parse", () => {
    expect(resolveStepUrl(flow({ baseUrl: "not-a-url" }), "///")).toBe("///")
  })
})
