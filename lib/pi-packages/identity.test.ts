import {
  parsePiSource,
  piPackageDisplayName,
  piPackageIdentity,
  piPackageVersion,
} from "./identity"

describe("parsePiSource", () => {
  it("splits an npm spec into name and version", () => {
    expect(parsePiSource("npm:pi-mcp-adapter@2.23.0")).toMatchObject({
      kind: "npm",
      name: "pi-mcp-adapter",
      version: "2.23.0",
    })
  })

  it("keeps an npm scope attached to the name", () => {
    expect(parsePiSource("npm:@aliou/pi-guardrails@0.17.0")).toMatchObject({
      kind: "npm",
      name: "@aliou/pi-guardrails",
      version: "0.17.0",
    })
  })

  it("handles an unpinned npm spec", () => {
    expect(parsePiSource("npm:simple-pkg")).toMatchObject({
      kind: "npm",
      name: "simple-pkg",
      version: undefined,
    })
  })

  it("parses every git form Pi documents", () => {
    expect(parsePiSource("git:github.com/user/repo")).toMatchObject({
      kind: "git",
      host: "github.com",
      path: "user/repo",
    })
    expect(parsePiSource("git:git@github.com:user/repo")).toMatchObject({
      kind: "git",
      host: "github.com",
      path: "user/repo",
    })
    expect(parsePiSource("https://github.com/user/repo")).toMatchObject({
      kind: "git",
      host: "github.com",
      path: "user/repo",
    })
    expect(parsePiSource("ssh://git@github.com/user/repo")).toMatchObject({
      kind: "git",
      host: "github.com",
      path: "user/repo",
    })
  })

  it("strips a .git suffix and a trailing ref", () => {
    expect(parsePiSource("git:github.com/user/repo.git@v1")).toMatchObject({
      path: "user/repo",
      version: "v1",
    })
  })

  it("treats anything else as a local path", () => {
    expect(parsePiSource("./local/path")).toMatchObject({ kind: "local", path: "./local/path" })
    expect(parsePiSource("/abs/path")).toMatchObject({ kind: "local", path: "/abs/path" })
  })
})

describe("piPackageIdentity", () => {
  /** Version is stripped: the same package at two pins is one package. */
  it("ignores the npm version", () => {
    expect(piPackageIdentity("npm:pkg@1.0.0")).toBe("npm:pkg")
    expect(piPackageIdentity("npm:pkg@2.0.0")).toBe("npm:pkg")
    expect(piPackageIdentity("npm:@scope/pkg@1.0.0")).toBe("npm:@scope/pkg")
  })

  /** The reason host/path are extracted rather than the URL kept. */
  it("collapses SSH and HTTPS git forms onto one identity", () => {
    const forms = [
      "git:github.com/user/repo",
      "git:git@github.com:user/repo",
      "https://github.com/user/repo",
      "ssh://git@github.com/user/repo",
      "git:github.com/user/repo.git",
      "https://GitHub.com/user/repo",
    ]
    const identities = new Set(forms.map((f) => piPackageIdentity(f)))
    expect([...identities]).toEqual(["git:github.com/user/repo"])
  })

  it("keeps different repos distinct", () => {
    expect(piPackageIdentity("git:github.com/a/repo")).not.toBe(
      piPackageIdentity("git:github.com/b/repo")
    )
  })

  it("resolves a relative local path against the scope base dir", () => {
    expect(piPackageIdentity("./ext", "/repo/.pi")).toBe("local:/repo/.pi/ext")
    expect(piPackageIdentity("./ext", "/home/u/.pi/agent")).toBe("local:/home/u/.pi/agent/ext")
  })

  it("normalizes . and .. inside a local path", () => {
    expect(piPackageIdentity("../ext/./x", "/repo/.pi")).toBe("local:/repo/ext/x")
  })

  it("leaves an absolute local path alone regardless of base dir", () => {
    expect(piPackageIdentity("/abs/ext", "/repo/.pi")).toBe("local:/abs/ext")
  })

  it("gives an unparseable git locator a stable identity instead of collapsing it", () => {
    const a = piPackageIdentity("git:garbage")
    const b = piPackageIdentity("git:other-garbage")
    expect(a).not.toBe(b)
    expect(a).toBe(piPackageIdentity("git:garbage"))
  })
})

describe("piPackageDisplayName / piPackageVersion", () => {
  it("shows the npm name and pin", () => {
    expect(piPackageDisplayName("npm:@aliou/pi-guardrails@0.17.0")).toBe("@aliou/pi-guardrails")
    expect(piPackageVersion("npm:@aliou/pi-guardrails@0.17.0")).toBe("0.17.0")
  })

  it("shows the repo name for a git source", () => {
    expect(piPackageDisplayName("git:github.com/user/my-ext")).toBe("my-ext")
  })

  it("shows the last segment for a local path", () => {
    expect(piPackageDisplayName("./extensions/my-ext/")).toBe("my-ext")
  })

  it("has no version for an unpinned spec", () => {
    expect(piPackageVersion("npm:simple-pkg")).toBeUndefined()
  })
})
