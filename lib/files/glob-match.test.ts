import { matchesDeniedGlob } from "./glob-match"

describe("matchesDeniedGlob", () => {
  describe("bare token (no slash) — matches any whole segment exactly", () => {
    it("matches an exact segment anywhere in the path", () => {
      expect(matchesDeniedGlob(".env", ".env")).toBe(true)
      expect(matchesDeniedGlob("config/.env", ".env")).toBe(true)
      expect(matchesDeniedGlob("a/b/.env", ".env")).toBe(true)
    })

    it("does NOT match a segment that merely contains the token (the substring bug)", () => {
      expect(matchesDeniedGlob(".environment", ".env")).toBe(false)
      expect(matchesDeniedGlob("config/.environment", ".env")).toBe(false)
      expect(matchesDeniedGlob("prevent-error.ts", ".env")).toBe(false)
      expect(matchesDeniedGlob("my.git-backups/x", ".git")).toBe(false)
    })

    it("matches .git as a directory segment but not digital.gitignore", () => {
      expect(matchesDeniedGlob(".git/config", ".git")).toBe(true)
      expect(matchesDeniedGlob("src/.git/HEAD", ".git")).toBe(true)
      expect(matchesDeniedGlob("digital.gitignore", ".git")).toBe(false)
    })
  })

  describe("single-segment glob (no slash, with *)", () => {
    it("matches any segment by extension", () => {
      expect(matchesDeniedGlob("certs/key.pem", "*.pem")).toBe(true)
      expect(matchesDeniedGlob("key.pem", "*.pem")).toBe(true)
      expect(matchesDeniedGlob("id_rsa.pub", "id_rsa*")).toBe(true)
    })

    it("does not match across a path separator", () => {
      expect(matchesDeniedGlob("a/b.txt", "*.pem")).toBe(false)
      expect(matchesDeniedGlob("a/b", "a*b")).toBe(false)
    })
  })

  describe("multi-segment patterns with ** (zero-or-more segments)", () => {
    it("matches a directory anywhere via leading/trailing **", () => {
      expect(matchesDeniedGlob(".git/config", "**/.git/**")).toBe(true)
      expect(matchesDeniedGlob("a/b/.git/c", "**/.git/**")).toBe(true)
      expect(matchesDeniedGlob("a/b/c", "**/.git/**")).toBe(false)
    })

    it("supports a rooted prefix pattern", () => {
      expect(matchesDeniedGlob("node_modules/x/y", "node_modules/**")).toBe(true)
      expect(matchesDeniedGlob("src/node_modules/x", "node_modules/**")).toBe(false)
      expect(matchesDeniedGlob("secrets/db.key", "secrets/**")).toBe(true)
    })

    it("anchors a fully-specified path", () => {
      expect(matchesDeniedGlob("a/b/c", "a/b/c")).toBe(true)
      expect(matchesDeniedGlob("a/b/c/d", "a/b/c")).toBe(false)
      expect(matchesDeniedGlob("x/a/b/c", "a/b/c")).toBe(false)
    })

    it("matches a * segment inside a multi-segment pattern", () => {
      expect(matchesDeniedGlob("a/secret.key/b", "a/*.key/b")).toBe(true)
      expect(matchesDeniedGlob("a/secretkey/b", "a/*.key/b")).toBe(false)
    })
  })

  describe("slash-wrapped token normalizes to a bare-token matcher", () => {
    it("treats /.git/ as a .git-anywhere directory match", () => {
      expect(matchesDeniedGlob("a/.git/b", "/.git/")).toBe(true)
      expect(matchesDeniedGlob(".git/b", "/.git/")).toBe(true)
      expect(matchesDeniedGlob("a/digital.gitignore", "/.git/")).toBe(false)
    })
  })

  describe("edge cases", () => {
    it("empty pattern never matches", () => {
      expect(matchesDeniedGlob("a/b", "")).toBe(false)
      expect(matchesDeniedGlob("a/b", "/")).toBe(false)
    })

    it("empty path only matched by a ** pattern that allows empty", () => {
      expect(matchesDeniedGlob("", ".env")).toBe(false)
      expect(matchesDeniedGlob("", "**")).toBe(true)
    })

    it("** alone matches anything (including nested)", () => {
      expect(matchesDeniedGlob("a/b/c", "**")).toBe(true)
      expect(matchesDeniedGlob("a", "**")).toBe(true)
    })
  })
})
