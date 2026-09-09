import {
  GITHUB_DOT_COM,
  isGithubDotCom,
  parseGithubHost,
  remoteHostname,
  repositoryRemoteUrl,
  resolveGithubHostForRemote,
} from "./host"

describe("parseGithubHost", () => {
  it("accepts either end of a GitHub Enterprise URL and produces both bases", () => {
    // The two shapes a user copies out of their own documentation. Guessing
    // wrong here produces 404s that read like a broken token.
    const fromWeb = parseGithubHost("https://ghe.example.com")
    const fromApi = parseGithubHost("https://ghe.example.com/api/v3")
    const withSlash = parseGithubHost("  https://ghe.example.com/api/v3/  ")

    expect(fromWeb).toEqual({
      id: "ghe.example.com",
      apiBaseUrl: "https://ghe.example.com/api/v3",
      webBaseUrl: "https://ghe.example.com",
    })
    expect(fromApi).toEqual(fromWeb)
    expect(withSlash).toEqual(fromWeb)
  })

  it("keeps a base path a GHES is mounted under", () => {
    expect(parseGithubHost("https://corp.example/github")).toEqual({
      id: "corp.example",
      apiBaseUrl: "https://corp.example/github/api/v3",
      webBaseUrl: "https://corp.example/github",
    })
  })

  it("assumes https for a bare hostname", () => {
    expect(parseGithubHost("ghe.example.com")?.webBaseUrl).toBe("https://ghe.example.com")
  })

  it("collapses every spelling of the public host onto one value", () => {
    for (const spelling of [
      "github.com",
      "https://github.com",
      "https://www.github.com",
      "https://api.github.com",
      "https://github.com/",
    ]) {
      expect(parseGithubHost(spelling)).toBe(GITHUB_DOT_COM)
    }
  })

  it("refuses anything a credential must not be sent to", () => {
    // A token is sent to this origin. Plaintext, a non-URL, and an empty field
    // are all "not a host", so the caller falls back to github.com or reports
    // the field invalid. Neither of those puts the token on the wire in clear.
    for (const bad of [
      "http://ghe.example.com",
      "ftp://ghe.example.com",
      "javascript:alert(1)",
      "not a url",
      "",
      "   ",
      null,
      undefined,
    ]) {
      expect(parseGithubHost(bad)).toBeUndefined()
    }
  })
})

describe("resolveGithubHostForRemote", () => {
  const ghe = parseGithubHost("https://ghe.example.com")!

  it("recognises the public host with nothing configured", () => {
    expect(resolveGithubHostForRemote("https://github.com/o/r.git")).toBe(GITHUB_DOT_COM)
    expect(resolveGithubHostForRemote("git@github.com:o/r.git")).toBe(GITHUB_DOT_COM)
  })

  it("matches a configured enterprise host in both remote spellings", () => {
    expect(resolveGithubHostForRemote("https://ghe.example.com/o/r.git", [ghe])).toBe(ghe)
    expect(resolveGithubHostForRemote("git@ghe.example.com:o/r.git", [ghe])).toBe(ghe)
    expect(resolveGithubHostForRemote("ssh://git@ghe.example.com/o/r.git", [ghe])).toBe(ghe)
  })

  it("refuses an unknown host rather than falling back to github.com", () => {
    // The fallback would send a github.com installation token to whatever host
    // the remote named, which is the whole mistake the per-account host closes.
    expect(resolveGithubHostForRemote("https://ghe.example.com/o/r.git")).toBeUndefined()
    expect(resolveGithubHostForRemote("https://evil.example/o/r.git", [ghe])).toBeUndefined()
    expect(resolveGithubHostForRemote("")).toBeUndefined()
  })
})

describe("remoteHostname", () => {
  it("reads the host out of every spelling git accepts", () => {
    expect(remoteHostname("https://github.com/o/r.git")).toBe("github.com")
    expect(remoteHostname("ssh://git@ghe.example.com:22/o/r.git")).toBe("ghe.example.com")
    expect(remoteHostname("git@GHE.Example.com:o/r.git")).toBe("ghe.example.com")
    // A hostless URL is not a host: a local `file://` remote is never GitHub.
    expect(remoteHostname("file:///srv/git/repo.git")).toBeUndefined()
    expect(remoteHostname("nonsense")).toBeUndefined()
  })
})

describe("repositoryRemoteUrl", () => {
  it("builds the remote from the host and the identity, on either deployment", () => {
    expect(repositoryRemoteUrl(GITHUB_DOT_COM, "octo/hello-world")).toBe(
      "https://github.com/octo/hello-world.git"
    )
    expect(repositoryRemoteUrl(parseGithubHost("https://ghe.example.com")!, "octo/hello")).toBe(
      "https://ghe.example.com/octo/hello.git"
    )
  })

  it("tolerates a name that already carries slashes or a .git suffix", () => {
    expect(repositoryRemoteUrl(GITHUB_DOT_COM, " /octo/hello.git/ ")).toBe(
      "https://github.com/octo/hello.git"
    )
  })

  it("refuses anything that is not owner/repository", () => {
    // The push target must never be assemblable from a partial name: a remote
    // that resolves to the wrong path is a push to the wrong repository.
    for (const bad of ["octo", "octo/hello/extra", "", "  ", "octo /hello"]) {
      expect(() => repositoryRemoteUrl(GITHUB_DOT_COM, bad)).toThrow(/owner\/repository/)
    }
  })
})

describe("isGithubDotCom", () => {
  it("separates the public deployment from an enterprise one", () => {
    expect(isGithubDotCom(GITHUB_DOT_COM)).toBe(true)
    expect(isGithubDotCom(parseGithubHost("https://ghe.example.com")!)).toBe(false)
  })
})
