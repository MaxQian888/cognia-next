/**
 * @jest-environment jsdom
 *
 * ADR-0201: credential-field refusal parity with the Chromium service, snapshot
 * redaction of secret values, and the login-form autofill helpers
 * (`__cogniaDetectLogin` / `__cogniaFillLogin`). Evaluates the real injected
 * overlay bytes against jsdom — no logic is duplicated here.
 */
import fs from "node:fs"
import path from "node:path"

const CODE = fs.readFileSync(path.join(__dirname, "overlay.injected.js"), "utf8")

type SnapshotNode = {
  ref: string
  role: string
  name: string
  tag: string
  value: string | null
  secret?: boolean
}

type Win = Record<string, unknown> & {
  __cogniaSnapshot: (optsJson?: string) => string
  __cogniaAct: (ref: string, action: string, argsJson: string) => string
  __cogniaDetectLogin: () => string
  __cogniaFillLogin: (username: unknown, password: unknown, expectedOrigin?: string) => string
  __cogniaOverlay: {
    resolveRef: (ref: string) => Element | null
    isAgentSecretField: (el: Element) => boolean
  }
}

function win(): Win {
  return window as unknown as Win
}

function install() {
  delete (window as unknown as Record<string, unknown>).__cogniaOverlayInstalled
  ;(0, eval)(CODE)
}

/**
 * The element carrying a ref. The login helpers are defined non-configurable,
 * so the first install's helpers stay bound for the whole file (a later
 * `install()` cannot replace them); look refs up in the DOM rather than
 * through the latest install's `resolveRef`.
 */
function byRef(ref: string): Element | null {
  return document.querySelector(`[data-cognia-ref="${ref}"]`)
}

function snapshotNodes(): SnapshotNode[] {
  return JSON.parse(win().__cogniaSnapshot()).snapshot.nodes as SnapshotNode[]
}

function refOf(id: string): string {
  const el = document.getElementById(id)!
  snapshotNodes()
  return el.getAttribute("data-cognia-ref")!
}

beforeEach(() => {
  document.body.innerHTML = ""
  sessionStorage.clear()
})

describe("secret-field classification", () => {
  beforeEach(() => install())

  it.each([
    [`<input id="f" type="password" />`, true],
    [`<input id="f" type="text" autocomplete="one-time-code" />`, true],
    [`<input id="f" type="text" name="api_token" />`, true],
    [`<input id="f" type="text" placeholder="验证码" />`, true],
    [`<input id="f" type="text" aria-label="Your secret" />`, true],
    [`<textarea id="f" name="recovery-secret"></textarea>`, true],
    [`<input id="f" type="email" name="email" />`, false],
    [`<input id="f" type="text" name="query" />`, false],
    [`<button id="f" name="password-reset">Reset</button>`, false],
  ])("%s → %s", (html, expected) => {
    document.body.innerHTML = html
    expect(win().__cogniaOverlay.isAgentSecretField(document.getElementById("f")!)).toBe(expected)
  })

  it("stays secret after a reveal toggle flips type to text", () => {
    document.body.innerHTML = `<input id="f" type="password" />`
    const input = document.getElementById("f") as HTMLInputElement
    input.dispatchEvent(new Event("focusin", { bubbles: true }))
    // Recording latches on focus only while armed; latch directly instead.
    input.setAttribute("data-cognia-secret", "1")
    input.setAttribute("type", "text")
    expect(win().__cogniaOverlay.isAgentSecretField(input)).toBe(true)
  })
})

describe("snapshot redaction", () => {
  it("withholds a secret field's value and flags the node", () => {
    document.body.innerHTML = `
      <input id="u" type="text" name="user" value="alice" />
      <input id="p" type="password" value="hunter2" />
    `
    install()
    const nodes = snapshotNodes()
    const user = nodes.find((n) => n.value === "alice")
    expect(user).toBeDefined()
    expect(user!.secret).toBeUndefined()
    const pw = nodes.find((n) => n.secret === true)
    expect(pw).toBeDefined()
    expect(pw!.value).toBeNull()
    expect(JSON.stringify(nodes)).not.toContain("hunter2")
  })
})

describe("__cogniaAct refuses credential fields", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <input id="u" type="text" name="user" />
      <input id="p" type="password" />
    `
    install()
  })

  it.each(["fill", "type", "click", "focus", "hover", "double_click", "select", "scroll"])(
    "refuses %s with browser_human_input_required",
    (action) => {
      const pw = document.getElementById("p") as HTMLInputElement
      const res = JSON.parse(win().__cogniaAct(refOf("p"), action, JSON.stringify({ text: "x" })))
      expect(res.ok).toBe(false)
      expect(res.code).toBe("browser_human_input_required")
      expect(res.error).toMatch(/^browser_human_input_required:/)
      expect(pw.value).toBe("")
    }
  )

  it("refuses a key press on a ref'd secret field", () => {
    const res = JSON.parse(win().__cogniaAct(refOf("p"), "key", JSON.stringify({ key: "a" })))
    expect(res.code).toBe("browser_human_input_required")
  })

  it("refuses a ref-less key press while a secret field has focus", () => {
    ;(document.getElementById("p") as HTMLInputElement).focus()
    const res = JSON.parse(win().__cogniaAct("", "key", JSON.stringify({ key: "Enter" })))
    expect(res.ok).toBe(false)
    expect(res.code).toBe("browser_human_input_required")
  })

  it("still acts on an ordinary field", () => {
    const res = JSON.parse(win().__cogniaAct(refOf("u"), "fill", JSON.stringify({ text: "bob" })))
    expect(res.ok).toBe(true)
    expect((document.getElementById("u") as HTMLInputElement).value).toBe("bob")
  })

  it("lets a human-provided secret replay fill, and only fill/type", () => {
    const pw = document.getElementById("p") as HTMLInputElement
    const fill = JSON.parse(
      win().__cogniaAct(
        refOf("p"),
        "fill",
        JSON.stringify({ text: "s3cret", humanProvidedSecret: true })
      )
    )
    expect(fill.ok).toBe(true)
    expect(pw.value).toBe("s3cret")
    const click = JSON.parse(
      win().__cogniaAct(refOf("p"), "click", JSON.stringify({ humanProvidedSecret: true }))
    )
    expect(click.code).toBe("browser_human_input_required")
  })

  it("does not honor a truthy-but-not-true opt-in", () => {
    const res = JSON.parse(
      win().__cogniaAct(
        refOf("p"),
        "fill",
        JSON.stringify({ text: "x", humanProvidedSecret: "true" })
      )
    )
    expect(res.code).toBe("browser_human_input_required")
  })
})

describe("__cogniaDetectLogin", () => {
  it("reports each login form by ref with its username and password fields", () => {
    document.body.innerHTML = `
      <form id="login">
        <input id="search" type="search" />
        <input id="email" type="email" name="email" />
        <input id="pw" type="password" />
        <button>Sign in</button>
      </form>
    `
    install()
    const out = JSON.parse(win().__cogniaDetectLogin())
    expect(out.forms).toHaveLength(1)
    const [form] = out.forms
    const resolve = (ref: string) => byRef(ref)
    expect(resolve(form.ref)).toBe(document.getElementById("login"))
    expect(resolve(form.usernameRef)).toBe(document.getElementById("email"))
    expect(resolve(form.passwordRef)).toBe(document.getElementById("pw"))
    expect(form.origin).toBe(window.location.origin)
  })

  it("prefers autocomplete=username over a plain text field", () => {
    document.body.innerHTML = `
      <form>
        <input id="user" type="text" autocomplete="username" />
        <input id="nick" type="text" name="nickname" />
        <input id="pw" type="password" />
      </form>
    `
    install()
    const [form] = JSON.parse(win().__cogniaDetectLogin()).forms
    expect(byRef(form.usernameRef)).toBe(document.getElementById("user"))
  })

  it("handles a password field outside any form and one with no username", () => {
    document.body.innerHTML = `<div><input id="pw" type="password" /></div>`
    install()
    const [form] = JSON.parse(win().__cogniaDetectLogin()).forms
    expect(form.usernameRef).toBeNull()
    expect(form.ref).toBe(form.passwordRef)
  })

  it("ignores hidden and disabled password fields and never leaks values", () => {
    document.body.innerHTML = `
      <form><input type="password" hidden value="a" /></form>
      <form><input type="password" disabled value="b" /></form>
      <form><input id="u" type="text" value="alice" /><input type="password" value="c" /></form>
    `
    install()
    const raw = win().__cogniaDetectLogin()
    expect(JSON.parse(raw).forms).toHaveLength(1)
    expect(raw).not.toMatch(/alice|"a"|"b"|"c"/)
  })

  it("returns no forms on a page without a password field", () => {
    document.body.innerHTML = `<form><input type="text" /></form>`
    install()
    expect(JSON.parse(win().__cogniaDetectLogin())).toEqual({ forms: [] })
  })
})

describe("login helper locking", () => {
  it("defines the helpers non-writable and non-configurable", () => {
    install()
    for (const name of ["__cogniaDetectLogin", "__cogniaFillLogin"]) {
      const descriptor = Object.getOwnPropertyDescriptor(window, name)
      expect(descriptor).toBeDefined()
      expect(descriptor?.writable).toBe(false)
      expect(descriptor?.configurable).toBe(false)
      expect(typeof descriptor?.value).toBe("function")
    }
  })

  it("keeps a page from swapping in its own fill helper", () => {
    document.body.innerHTML = `<form><input id="p" type="password" /></form>`
    install()
    const original = win().__cogniaFillLogin
    const stolen: unknown[] = []
    const evil = (...args: unknown[]) => {
      stolen.push(args)
      return "{}"
    }
    expect(() => {
      ;(window as unknown as Record<string, unknown>).__cogniaFillLogin = evil
    }).toThrow(TypeError)
    expect(() =>
      Object.defineProperty(window, "__cogniaFillLogin", { value: evil, configurable: true })
    ).toThrow(TypeError)
    expect(() => delete (window as unknown as Record<string, unknown>).__cogniaFillLogin).toThrow(
      TypeError
    )
    expect(win().__cogniaFillLogin).toBe(original)
    expect(JSON.parse(win().__cogniaFillLogin("a", "pw")).filled).toBe(true)
    expect(stolen).toEqual([])
  })

  it("a second install in the same document keeps working", () => {
    install()
    const first = win().__cogniaFillLogin
    expect(() => install()).not.toThrow()
    expect(win().__cogniaFillLogin).toBe(first)
  })
})

describe("__cogniaFillLogin", () => {
  it("fills username and password through the native setter with events", () => {
    document.body.innerHTML = `
      <form>
        <input id="u" type="text" name="username" />
        <input id="p" type="password" />
      </form>
    `
    install()
    const events: string[] = []
    const u = document.getElementById("u") as HTMLInputElement
    const p = document.getElementById("p") as HTMLInputElement
    for (const el of [u, p]) {
      el.addEventListener("input", () => events.push(`${el.id}:input`))
      el.addEventListener("change", () => events.push(`${el.id}:change`))
    }
    const res = JSON.parse(win().__cogniaFillLogin("alice", "hunter2"))
    expect(res).toEqual({ filled: true, username: "alice" })
    expect(u.value).toBe("alice")
    expect(p.value).toBe("hunter2")
    expect(events).toEqual(["u:input", "u:change", "p:input", "p:change"])
  })

  it("defeats a framework-style value override on the instance", () => {
    document.body.innerHTML = `<form><input id="p" type="password" /></form>`
    install()
    const p = document.getElementById("p") as HTMLInputElement
    let tracked = ""
    Object.defineProperty(p, "value", {
      configurable: true,
      get: () => tracked,
      set: (v: string) => {
        tracked = `instance:${v}`
      },
    })
    JSON.parse(win().__cogniaFillLogin("", "pw"))
    // The prototype setter wrote the real value; the instance override saw nothing.
    expect(tracked).toBe("")
  })

  it("fills the form that holds focus when several exist", () => {
    document.body.innerHTML = `
      <form><input id="u1" type="text" /><input id="p1" type="password" /></form>
      <form><input id="u2" type="text" /><input id="p2" type="password" /></form>
    `
    install()
    ;(document.getElementById("u2") as HTMLInputElement).focus()
    JSON.parse(win().__cogniaFillLogin("bob", "pw"))
    expect((document.getElementById("p2") as HTMLInputElement).value).toBe("pw")
    expect((document.getElementById("p1") as HTMLInputElement).value).toBe("")
  })

  it("reports no_login_form when there is nothing to fill", () => {
    document.body.innerHTML = `<input type="text" />`
    install()
    expect(JSON.parse(win().__cogniaFillLogin("a", "b"))).toEqual({
      filled: false,
      username: null,
      reason: "no_login_form",
    })
  })

  it("refuses when the page origin no longer matches", () => {
    document.body.innerHTML = `<form><input id="p" type="password" /></form>`
    install()
    const res = JSON.parse(win().__cogniaFillLogin("a", "b", "https://elsewhere.example"))
    expect(res).toEqual({ filled: false, username: null, reason: "origin_mismatch" })
    expect((document.getElementById("p") as HTMLInputElement).value).toBe("")
  })

  it("fills the password alone and reports no username when there is no field", () => {
    document.body.innerHTML = `<form><input id="p" type="password" /></form>`
    install()
    expect(JSON.parse(win().__cogniaFillLogin("alice", "pw"))).toEqual({
      filled: true,
      username: null,
    })
  })

  it("never echoes a page-thrown error message", () => {
    document.body.innerHTML = `<form><input id="p" type="password" /></form>`
    install()
    const p = document.getElementById("p") as HTMLInputElement
    p.addEventListener("input", () => {
      throw new Error("leak hunter2")
    })
    // jsdom reports listener errors instead of propagating them; force a throw
    // from the setter path instead.
    const proto = HTMLInputElement.prototype
    const desc = Object.getOwnPropertyDescriptor(proto, "value")!
    Object.defineProperty(proto, "value", {
      configurable: true,
      get: desc.get,
      set() {
        throw new Error("leak hunter2")
      },
    })
    try {
      const raw = win().__cogniaFillLogin("a", "hunter2")
      expect(raw).not.toContain("hunter2")
      expect(JSON.parse(raw)).toEqual({ filled: false, username: null, reason: "fill_failed" })
    } finally {
      Object.defineProperty(proto, "value", desc)
    }
  })
})
