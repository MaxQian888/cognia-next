import {
  OpenVsxVersionError,
  isPrerelease,
  resolveVersion,
  type VersionCandidate,
} from "./openvsx-version"

/**
 * rust-analyzer's real live shape (curl-verified 2026-07-15). Its newest
 * version is aliased BOTH "latest" and "pre-release" while `preRelease: true`
 * — the exact trap this module exists to avoid.
 */
const RUST_ANALYZER: VersionCandidate[] = [
  { version: "0.4.2973", preRelease: true, versionAlias: ["latest", "pre-release"] },
  { version: "0.4.2972", preRelease: true, versionAlias: [] },
  { version: "0.3.2622", preRelease: false, versionAlias: [] },
  { version: "0.3.2621", preRelease: false, versionAlias: [] },
]

describe("resolveVersion — the versionAlias trap", () => {
  it("latest_alias_with_prerelease_true_is_not_auto_selected", () => {
    const picked = resolveVersion(RUST_ANALYZER)
    // NOT 0.4.2973, despite it being aliased "latest".
    expect(picked.version).toBe("0.3.2622")
    expect(picked.preRelease).toBe(false)
  })

  it("ignores versionAlias entirely when choosing", () => {
    // Same versions, but the "latest" alias moved onto an old stable build.
    // Selection must not change — it reads preRelease, not the alias.
    const aliasMoved: VersionCandidate[] = [
      { version: "0.4.2973", preRelease: true, versionAlias: [] },
      { version: "0.3.2621", preRelease: false, versionAlias: ["latest"] },
      { version: "0.3.2622", preRelease: false, versionAlias: [] },
    ]
    expect(resolveVersion(aliasMoved).version).toBe("0.3.2622")
  })
})

describe("resolveVersion — stability", () => {
  it("prefers_stable_over_prerelease", () => {
    const candidates: VersionCandidate[] = [
      { version: "2.0.0", preRelease: true },
      { version: "1.5.0", preRelease: false },
    ]
    expect(resolveVersion(candidates).version).toBe("1.5.0")
  })

  it("picks the newest stable by version order, not array order", () => {
    // The API returns newest-first today, but nothing promises it.
    const candidates: VersionCandidate[] = [
      { version: "1.2.0" },
      { version: "1.10.0" },
      { version: "1.9.0" },
    ]
    expect(resolveVersion(candidates).version).toBe("1.10.0")
  })

  it("treats an absent preRelease flag as stable", () => {
    expect(isPrerelease({ version: "1.0.0" })).toBe(false)
    expect(isPrerelease({ version: "1.0.0", preRelease: false })).toBe(false)
    expect(isPrerelease({ version: "1.0.0", preRelease: true })).toBe(true)
    expect(resolveVersion([{ version: "1.0.0" }]).version).toBe("1.0.0")
  })
})

describe("resolveVersion — prerelease-only extensions", () => {
  const prereleaseOnly: VersionCandidate[] = [
    { version: "0.2.0", preRelease: true, versionAlias: ["latest", "pre-release"] },
    { version: "0.1.0", preRelease: true },
  ]

  it("prerelease_only_extension_requires_opt_in", () => {
    const error = (() => {
      try {
        resolveVersion(prereleaseOnly)
        return null
      } catch (e) {
        return e
      }
    })()

    expect(error).toBeInstanceOf(OpenVsxVersionError)
    expect((error as OpenVsxVersionError).reason).toBe("prerelease_only")
    // Says so explicitly rather than silently installing one.
    expect((error as OpenVsxVersionError).message).toMatch(/only pre-release/)
    expect((error as OpenVsxVersionError).message).toMatch(/0\.2\.0/)
  })

  it("installs the newest prerelease once the caller opts in", () => {
    expect(resolveVersion(prereleaseOnly, { allowPrerelease: true }).version).toBe("0.2.0")
  })

  it("still prefers stable when opted in and both exist", () => {
    // Opting in means "prereleases are acceptable", not "prefer prereleases".
    expect(resolveVersion(RUST_ANALYZER, { allowPrerelease: true }).version).toBe("0.3.2622")
  })
})

describe("resolveVersion — explicit version", () => {
  it("returns an explicitly requested version, prerelease or not", () => {
    const picked = resolveVersion(RUST_ANALYZER, { requestedVersion: "0.4.2973" })
    expect(picked.version).toBe("0.4.2973")
    expect(picked.preRelease).toBe(true)
  })

  it("fails with a named error for an unpublished version", () => {
    const error = (() => {
      try {
        resolveVersion(RUST_ANALYZER, { requestedVersion: "9.9.9" })
        return null
      } catch (e) {
        return e
      }
    })()
    expect((error as OpenVsxVersionError).reason).toBe("version_not_found")
    expect((error as OpenVsxVersionError).message).toMatch(/9\.9\.9/)
  })

  it("fails with a named error when there are no versions at all", () => {
    const error = (() => {
      try {
        resolveVersion([])
        return null
      } catch (e) {
        return e
      }
    })()
    expect((error as OpenVsxVersionError).reason).toBe("no_versions")
  })
})
