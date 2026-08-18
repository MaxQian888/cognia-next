import {
  PI_INSTALL_PARAM,
  PI_PACKAGES_SECTION,
  piPackageInstallHref,
  piPackagesHref,
  readPiInstallParam,
} from "./deep-link"

describe("piPackageInstallHref", () => {
  it("targets the agent-packages section with the spec staged", () => {
    expect(piPackageInstallHref("npm:pi-memory@0.4.2")).toBe(
      "/plugins?section=agent-packages&piInstall=npm%3Api-memory%400.4.2"
    )
  })

  /**
   * Specs carry `@`, `/` and `:`, and git/local forms carry more. Without
   * encoding, `npm:@a/b@1.0.0` would truncate at the `/` on the way back.
   */
  it("encodes a scoped spec so it survives the round trip", () => {
    const href = piPackageInstallHref("npm:@narumitw/pi-subagents@1.0.0")
    const params = new URLSearchParams(href.slice(href.indexOf("?") + 1))
    expect(params.get(PI_INSTALL_PARAM)).toBe("npm:@narumitw/pi-subagents@1.0.0")
  })

  it("round-trips a local path spec", () => {
    const href = piPackageInstallHref("./my ext")
    const params = new URLSearchParams(href.slice(href.indexOf("?") + 1))
    expect(params.get(PI_INSTALL_PARAM)).toBe("./my ext")
  })
})

describe("piPackagesHref", () => {
  it("opens the section with nothing staged", () => {
    expect(piPackagesHref()).toBe(`/plugins?section=${PI_PACKAGES_SECTION}`)
    expect(piPackagesHref()).not.toContain(PI_INSTALL_PARAM)
  })
})

describe("readPiInstallParam", () => {
  const params = (query: string) => new URLSearchParams(query)

  it("reads the staged spec", () => {
    expect(readPiInstallParam(params("piInstall=npm%3Api-memory%400.4.2"))).toBe(
      "npm:pi-memory@0.4.2"
    )
  })

  it("is null when the param is absent", () => {
    expect(readPiInstallParam(params("section=agent-packages"))).toBeNull()
  })

  /** A blank value must not open a dialog for the empty spec. */
  it("is null for a blank or whitespace value", () => {
    expect(readPiInstallParam(params("piInstall="))).toBeNull()
    expect(readPiInstallParam(params("piInstall=%20%20"))).toBeNull()
  })

  it("is null when there are no params at all", () => {
    expect(readPiInstallParam(null)).toBeNull()
  })
})
