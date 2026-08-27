import { detectTrigger, spliceToken } from "./composer-trigger"

describe("detectTrigger — slash mode", () => {
  it("detects `/cmd` at the very start of the textarea", () => {
    const tg = detectTrigger("/help me", 5)
    expect(tg).toEqual({ kind: "slash", tokenStart: 0, tokenEnd: 5, query: "help" })
  })

  it("does not trigger when `/` is mid-line (urls / paths)", () => {
    expect(detectTrigger("hi /world", 9)).toBeNull()
  })

  it("detects `/cmd` at the start of a non-first line (multi-command)", () => {
    const value = "first line\n/help"
    const tg = detectTrigger(value, value.length)
    expect(tg).toEqual({ kind: "slash", tokenStart: 11, tokenEnd: 16, query: "help" })
  })

  it("detects a command line with leading whitespace", () => {
    const value = "a\n  /model opus"
    // caret right after `/model`
    const tg = detectTrigger(value, 8)
    expect(tg?.kind).toBe("slash")
    expect(tg?.tokenStart).toBe(4)
    expect(tg?.query).toBe("mod")
  })

  it("does not treat `!`/`#` on a later line as a trigger (mode rule unchanged)", () => {
    expect(detectTrigger("hello\n!ls", 9)).toBeNull()
    expect(detectTrigger("hello\n#note", 11)).toBeNull()
  })

  it("matches `/` even with an empty query", () => {
    expect(detectTrigger("/", 1)).toMatchObject({ kind: "slash", query: "" })
  })

  it("does NOT match `/` mid-line (file paths, URLs)", () => {
    expect(detectTrigger("read src/page.tsx", 17)).toBeNull()
    expect(detectTrigger("see /api/foo", 12)).toBeNull()
  })

  it("truncates the query at the caret so the popover filters on partial input", () => {
    expect(detectTrigger("/clear now", 4)).toMatchObject({ kind: "slash", query: "cle" })
  })

  // ── Same-line chaining (parse-segments rule 2b) ────────────────────────
  const hasPrefix = (names: string[]) => (q: string) => names.some((n) => n.startsWith(q))

  it("anchors to the SECOND token when the caret is inside it", () => {
    const value = "/compact /cl"
    expect(detectTrigger(value, value.length)).toEqual({
      kind: "slash",
      tokenStart: 9,
      tokenEnd: 12,
      query: "cl",
    })
  })

  it("anchors to a freshly typed second slash (empty query)", () => {
    expect(detectTrigger("/help /", 7)).toMatchObject({
      kind: "slash",
      tokenStart: 6,
      query: "",
    })
  })

  it("keeps the first-token anchor while the caret is still in the first token", () => {
    expect(detectTrigger("/compact /clear", 5)).toMatchObject({
      kind: "slash",
      tokenStart: 0,
      query: "comp",
    })
  })

  it("does not let a trailing ordinary token drag the anchor back", () => {
    // `/help /model opus` — caret in `/model` must still anchor there, otherwise
    // picking a command would overwrite `/help`.
    expect(detectTrigger("/help /model opus", 12)).toMatchObject({
      kind: "slash",
      tokenStart: 6,
      query: "model",
    })
  })

  it("treats a path argument as an argument, not a chained command", () => {
    // With the prefix predicate, `/usr/loc` matches no command name, so the
    // anchor stays on `/add-dir` and argument completion takes over.
    const value = "/add-dir /usr/loc"
    const tg = detectTrigger(value, value.length, {
      hasCommandPrefix: hasPrefix(["add-dir", "help", "clear"]),
    })
    expect(tg).toMatchObject({ kind: "slash", tokenStart: 0, query: "add-dir" })
    expect(tg?.argumentStart).toBe(9)
    expect(tg?.argumentQuery).toBe("/usr/loc")
  })

  it("still chains when the second token matches a real command prefix", () => {
    const value = "/compact /cle"
    expect(
      detectTrigger(value, value.length, { hasCommandPrefix: hasPrefix(["clear", "compact"]) })
    ).toMatchObject({ kind: "slash", tokenStart: 9, query: "cle" })
  })

  it("flags the caret in the trailing space after a chain as past-argument", () => {
    // `/clear /resume ▮` — the anchor falls back to the first token, which is
    // fine for identifying the command but must NOT reopen the panel: picking a
    // row there overwrote `/clear`.
    const value = "/clear /resume "
    const tg = detectTrigger(value, value.length, {
      hasCommandPrefix: hasPrefix(["clear", "resume"]),
    })
    expect(tg).toMatchObject({ kind: "slash", query: "clear", caretPastArgument: true })
    expect(tg?.argumentQuery).toBeUndefined()
  })

  it("does not flag past-argument while the caret is still in the command word", () => {
    expect(detectTrigger("/clear", 6)?.caretPastArgument).toBeUndefined()
    expect(detectTrigger("/clear ", 7)?.caretPastArgument).toBeUndefined()
  })
})

describe("detectTrigger — links are inert (parse-segments rule 2c)", () => {
  const hasPrefix = (names: string[]) => (q: string) => names.some((n) => n.startsWith(q))

  it("completes a command typed after a pasted link", () => {
    const value = "https://github.com/svenstaro/genact /cl"
    expect(
      detectTrigger(value, value.length, { hasCommandPrefix: hasPrefix(["clear"]) })
    ).toMatchObject({ kind: "slash", tokenStart: 36, query: "cl" })
  })

  it("does not trigger while the caret is still inside the leading link", () => {
    const value = "https://github.com/a /clear"
    expect(detectTrigger(value, 10, { hasCommandPrefix: hasPrefix(["clear"]) })).toBeNull()
  })

  it("keeps chaining across a link that sits between two commands", () => {
    const value = "/clear https://x.dev/a /res"
    expect(
      detectTrigger(value, value.length, { hasCommandPrefix: hasPrefix(["clear", "resume"]) })
    ).toMatchObject({ kind: "slash", tokenStart: 23, query: "res" })
  })

  it("completes a command after a FOLDED link, which has no scheme to see", () => {
    const value = "svenstaro/genact /cl"
    expect(
      detectTrigger(value, value.length, {
        hasCommandPrefix: hasPrefix(["clear"]),
        isLinkToken: (token) => token === "svenstaro/genact",
      })
    ).toMatchObject({ kind: "slash", tokenStart: 17, query: "cl" })
  })

  it("leaves an ordinary word before a slash as prose", () => {
    // Only LINKS are inert — a bare word still means "this line is not a chain".
    expect(detectTrigger("see /clear", 10, { hasCommandPrefix: hasPrefix(["clear"]) })).toBeNull()
  })
})

describe("detectTrigger — `!` / `#` first-line modes", () => {
  it("matches `!` only at the very start", () => {
    expect(detectTrigger("!ls -la", 7)).toMatchObject({ kind: "bash", query: "ls -la" })
    expect(detectTrigger("hi !ls", 6)).toBeNull()
  })

  it("matches `#` only at the very start", () => {
    expect(detectTrigger("#prefer 4-space tabs", 20)).toMatchObject({ kind: "memory" })
    expect(detectTrigger("issue #123", 10)).toBeNull()
  })

  it("covers the whole first line", () => {
    expect(detectTrigger("!cmd\nmore", 4)).toMatchObject({ kind: "bash", tokenEnd: 4 })
  })

  it("falls through to the slash rule on a later line", () => {
    // Regression: this used to return null, killing the `/` popover for the
    // entire rest of the message.
    expect(detectTrigger("#note\n/he", 9)).toMatchObject({
      kind: "slash",
      tokenStart: 6,
      query: "he",
    })
    expect(detectTrigger("!ls\n/cl", 7)).toMatchObject({ kind: "slash", query: "cl" })
  })

  it("falls through to the mention rule on a later line", () => {
    expect(detectTrigger("#note\nping @bo", 14)).toMatchObject({
      kind: "file",
      query: "bo",
    })
  })

  it("still yields nothing on a later line with no trigger char", () => {
    expect(detectTrigger("!cmd\nmore", 9)).toBeNull()
  })

  it("exposes the first argument fragment for inline command completion", () => {
    const value = "/permission-mode pl"
    const tg = detectTrigger(value, value.length)
    expect(tg).toEqual({
      kind: "slash",
      tokenStart: 0,
      tokenEnd: 16,
      query: "permission-mode",
      argumentStart: 17,
      argumentEnd: 19,
      argumentQuery: "pl",
    })
  })

  it("offers an empty argument query immediately after the command space", () => {
    const value = "/pet "
    const tg = detectTrigger(value, value.length)
    expect(tg).toMatchObject({
      kind: "slash",
      query: "pet",
      argumentStart: value.length,
      argumentEnd: value.length,
      argumentQuery: "",
    })
  })

  it("does not keep first-argument completion open after the caret moves to later args", () => {
    const value = "/goal update improve tests"
    const tg = detectTrigger(value, value.length)
    expect(tg?.query).toBe("goal")
    expect(tg?.argumentQuery).toBeUndefined()
  })
})

describe("detectTrigger — bash + memory", () => {
  it("detects `!cmd` at the start", () => {
    const tg = detectTrigger("!ls -la", 7)
    expect(tg?.kind).toBe("bash")
    expect(tg?.query).toBe("ls -la")
  })

  it("detects `#text` at the start", () => {
    const tg = detectTrigger("#remember this", 14)
    expect(tg?.kind).toBe("memory")
    expect(tg?.query).toBe("remember this")
  })
})

describe("detectTrigger — @file mode (default)", () => {
  it("detects an @file token after whitespace", () => {
    const tg = detectTrigger("look @src/foo", 13)
    expect(tg?.kind).toBe("file")
    expect(tg?.query).toBe("src/foo")
  })

  it("detects an @file token at the very start of the input", () => {
    expect(detectTrigger("@app/page", 9)).toMatchObject({ kind: "file", query: "app/page" })
  })

  it("ignores @ inside an email address", () => {
    expect(detectTrigger("send to user@example.com", 24)).toBeNull()
  })

  it("returns null for a caret outside the token range", () => {
    // typed @foo then moved caret way past it
    expect(detectTrigger("hi @foo bar", 11)).toBeNull()
  })
})

describe("detectTrigger — @agent mode", () => {
  it("returns the agent kind when mentionMode is agents", () => {
    const tg = detectTrigger("@codex hi", 6, { mentionMode: "agents" })
    expect(tg?.kind).toBe("agent")
    expect(tg?.query).toBe("codex")
    expect(tg?.tokenStart).toBe(0)
  })

  it("respects whitespace boundary in agent mode", () => {
    expect(detectTrigger("foo@bar", 7, { mentionMode: "agents" })).toBeNull()
  })

  it("falls back to file kind when mentionMode is files (explicit)", () => {
    const tg = detectTrigger("@codex", 6, { mentionMode: "files" })
    expect(tg?.kind).toBe("file")
  })

  it("supports an empty query right after the @ char", () => {
    const tg = detectTrigger("hi @", 4, { mentionMode: "agents" })
    expect(tg?.kind).toBe("agent")
    expect(tg?.query).toBe("")
  })

  it("combined mode yields a file-kind trigger (popover merges agents on top)", () => {
    const tg = detectTrigger("@rev", 4, { mentionMode: "combined" })
    expect(tg?.kind).toBe("file")
    expect(tg?.query).toBe("rev")
    expect(tg?.tokenStart).toBe(0)
  })

  it("combined mode still excludes email-like @ (whitespace boundary)", () => {
    expect(detectTrigger("foo@bar", 7, { mentionMode: "combined" })).toBeNull()
  })
})

describe("detectTrigger — @skill: / @preset: namespaced prefixes", () => {
  it("flips to skill kind once `@skill:` is typed (combined mode)", () => {
    const tg = detectTrigger("use @skill:rev", 14, { mentionMode: "combined" })
    expect(tg?.kind).toBe("skill")
    expect(tg?.query).toBe("rev")
    expect(tg?.tokenStart).toBe(4)
  })

  it("yields an empty query right after `@skill:`", () => {
    const tg = detectTrigger("@skill:", 7, { mentionMode: "files" })
    expect(tg?.kind).toBe("skill")
    expect(tg?.query).toBe("")
  })

  it("flips to preset kind for `@preset:`", () => {
    const tg = detectTrigger("@preset:cod", 11, { mentionMode: "combined" })
    expect(tg?.kind).toBe("preset")
    expect(tg?.query).toBe("cod")
  })

  it("stays a file token until the colon is typed", () => {
    const tg = detectTrigger("@skill", 6, { mentionMode: "combined" })
    expect(tg?.kind).toBe("file")
    expect(tg?.query).toBe("skill")
  })

  it("does NOT flip in agents mode (team workspace `@` means members)", () => {
    const tg = detectTrigger("@skill:rev", 10, { mentionMode: "agents" })
    expect(tg?.kind).toBe("agent")
    expect(tg?.query).toBe("skill:rev")
  })

  it("keeps a dotted/colon token as a single token (boundary at whitespace)", () => {
    const tg = detectTrigger("@skill:my.cool-skill ", 20, { mentionMode: "combined" })
    expect(tg?.kind).toBe("skill")
    expect(tg?.query).toBe("my.cool-skill")
    expect(tg?.tokenEnd).toBe(20)
  })
})

describe("detectTrigger — workflow mode (@node / @edge)", () => {
  it("makes a bare `@` mean a workflow node", () => {
    const tg = detectTrigger("look @draft", 11, { mentionMode: "workflow" })
    expect(tg?.kind).toBe("wfNode")
    expect(tg?.query).toBe("draft")
    expect(tg?.tokenStart).toBe(5)
  })

  it("flips to node kind for the `@node:` prefix", () => {
    const tg = detectTrigger("@node:n_a", 9, { mentionMode: "workflow" })
    expect(tg?.kind).toBe("wfNode")
    expect(tg?.query).toBe("n_a")
    expect(tg?.tokenStart).toBe(0)
  })

  it("flips to edge kind for the `@edge:` prefix", () => {
    const tg = detectTrigger("wire @edge:e_1", 14, { mentionMode: "workflow" })
    expect(tg?.kind).toBe("wfEdge")
    expect(tg?.query).toBe("e_1")
  })

  it("yields an empty query right after a bare `@`", () => {
    const tg = detectTrigger("hi @", 4, { mentionMode: "workflow" })
    expect(tg?.kind).toBe("wfNode")
    expect(tg?.query).toBe("")
  })

  it("does not treat `@skill:` as a namespaced picker in workflow mode", () => {
    // Only node:/edge: are workflow prefixes — `@skill:` stays a bare node token.
    const tg = detectTrigger("@skill:x", 8, { mentionMode: "workflow" })
    expect(tg?.kind).toBe("wfNode")
    expect(tg?.query).toBe("skill:x")
  })

  it("does not treat `@node:` as a workflow picker outside workflow mode", () => {
    // In the default file composer `node:` is not a prefix — it's plain query text.
    const tg = detectTrigger("@node:n_a", 9, { mentionMode: "files" })
    expect(tg?.kind).toBe("file")
    expect(tg?.query).toBe("node:n_a")
  })
})

describe("spliceToken", () => {
  it("inserts the replacement and adds a trailing space", () => {
    const result = spliceToken("hi @c", 3, 5, "@codex")
    expect(result.value).toBe("hi @codex ")
    expect(result.caret).toBe("hi @codex ".length)
  })

  it("does not double-add a trailing space when one is already present", () => {
    const result = spliceToken("hi @co rest", 3, 6, "@codex")
    expect(result.value).toBe("hi @codex rest")
  })

  it("replaces a slash token with the chosen command + trailing space", () => {
    const result = spliceToken("/cle", 0, 4, "/clear")
    expect(result.value).toBe("/clear ")
    expect(result.caret).toBe("/clear ".length)
  })

  it("keeps existing trailing text when the token ends before it", () => {
    const result = spliceToken("/cl x", 0, 3, "/clear")
    expect(result.value).toBe("/clear x")
    expect(result.caret).toBe("/clear".length)
  })
})

describe("detectTrigger — remote document namespaces (@lark: / @gdoc:)", () => {
  it("flips to the doc picker and records which provider was addressed", () => {
    expect(detectTrigger("@lark:spec", 10)).toEqual({
      kind: "doc",
      tokenStart: 0,
      tokenEnd: 10,
      query: "spec",
      namespace: "lark:",
    })
    expect(detectTrigger("@gdoc:budget", 12)).toMatchObject({
      kind: "doc",
      query: "budget",
      namespace: "gdoc:",
    })
  })

  it("yields an empty query the moment the prefix is complete", () => {
    expect(detectTrigger("@lark:", 6)).toMatchObject({ kind: "doc", query: "", namespace: "lark:" })
  })

  it("keeps a pasted document URL in the query as one token", () => {
    const url = "https://acme.feishu.cn/docx/doxcnAbCdEfGh1234567890"
    const value = `@lark:${url}`
    expect(detectTrigger(value, value.length)).toMatchObject({ kind: "doc", query: url })
  })

  it("is still a plain file trigger before the prefix is finished", () => {
    expect(detectTrigger("@lar", 4)).toMatchObject({ kind: "file", query: "lar" })
  })

  it("does not claim the prefixes in the agent-team composer", () => {
    expect(detectTrigger("@lark:spec", 10, { mentionMode: "agents" })).toMatchObject({
      kind: "agent",
      query: "lark:spec",
    })
  })

  it("does not claim the prefixes in the workflow composer", () => {
    expect(detectTrigger("@lark:spec", 10, { mentionMode: "workflow" })).toMatchObject({
      kind: "wfNode",
      query: "lark:spec",
    })
  })

  it("sets `namespace` only where the prefix is still needed after detection", () => {
    // The rule: a kind that maps 1:1 onto a prefix has nothing left to
    // disambiguate, so it carries none. `doc` and `entity` each cover several
    // sources, and `file` needs to tell an explicit `@file:` (files only) from
    // a bare `@` (files + subagents) — those three carry it.
    expect(detectTrigger("@skill:x", 8)).not.toHaveProperty("namespace")
    expect(detectTrigger("@preset:x", 9)).not.toHaveProperty("namespace")
    expect(detectTrigger("@agent:x", 8)).not.toHaveProperty("namespace")
    expect(detectTrigger("@src/app.ts", 11)).not.toHaveProperty("namespace")
    expect(detectTrigger("@lark:x", 7)?.namespace).toBe("lark:")
    expect(detectTrigger("@issue:x", 8)?.namespace).toBe("issue:")
    expect(detectTrigger("@file:x", 7)?.namespace).toBe("file:")
  })
})

describe("detectTrigger — entity namespaces (@memory: / @issue: / …)", () => {
  it("flips to entity kind and carries the prefix that chose the source", () => {
    const tg = detectTrigger("see @issue:rac", 14, { mentionMode: "combined" })
    expect(tg?.kind).toBe("entity")
    expect(tg?.namespace).toBe("issue:")
    expect(tg?.query).toBe("rac")
    expect(tg?.tokenStart).toBe(4)
  })

  it("covers every registered source", () => {
    for (const [prefix, expected] of [
      ["memory:", "memory:"],
      ["issue:", "issue:"],
      ["plan:", "plan:"],
      ["chat:", "chat:"],
      ["artifact:", "artifact:"],
    ] as const) {
      const tg = detectTrigger(`@${prefix}q`, prefix.length + 2, { mentionMode: "combined" })
      expect(tg?.kind).toBe("entity")
      expect(tg?.namespace).toBe(expected)
    }
  })

  it("yields an empty query right after the colon", () => {
    const tg = detectTrigger("@plan:", 6, { mentionMode: "combined" })
    expect(tg?.kind).toBe("entity")
    expect(tg?.query).toBe("")
  })

  it("stays a file token until the colon is typed", () => {
    const tg = detectTrigger("@issue", 6, { mentionMode: "combined" })
    expect(tg?.kind).toBe("file")
  })

  it("does NOT flip in the team workspace, where `@` means a member", () => {
    const tg = detectTrigger("@issue:rac", 10, { mentionMode: "agents" })
    expect(tg?.kind).toBe("agent")
    expect(tg?.query).toBe("issue:rac")
  })

  it("does NOT flip in the workflow composer", () => {
    const tg = detectTrigger("@issue:rac", 10, { mentionMode: "workflow" })
    expect(tg?.kind).toBe("wfNode")
  })
})

describe("detectTrigger — @file: / @agent: (CLI vocabulary parity)", () => {
  it("narrows `@file:` to files, carrying the prefix so agents can be suppressed", () => {
    const tg = detectTrigger("@file:src/a", 11, { mentionMode: "combined" })
    expect(tg?.kind).toBe("file")
    expect(tg?.namespace).toBe("file:")
    expect(tg?.query).toBe("src/a")
  })

  it("narrows `@agent:` to subagents", () => {
    const tg = detectTrigger("@agent:rev", 10, { mentionMode: "combined" })
    expect(tg?.kind).toBe("subagent")
    expect(tg?.query).toBe("rev")
  })

  it("leaves a bare `@` unnamespaced so the combined panel still lists both", () => {
    const tg = detectTrigger("@rev", 4, { mentionMode: "combined" })
    expect(tg?.kind).toBe("file")
    expect(tg?.namespace).toBeUndefined()
  })
})

describe("detectTrigger — mentions inside a slash command's arguments", () => {
  it("opens the file picker for `@` in a command's argument region", () => {
    // Previously the slash branch returned first and `hasSlashCompletion` shut
    // the panel, so `@` was unreachable on any line starting with `/`.
    const tg = detectTrigger("/review @src/a", 14, { mentionMode: "combined" })
    expect(tg?.kind).toBe("file")
    expect(tg?.query).toBe("src/a")
    expect(tg?.tokenStart).toBe(8)
  })

  it("names the host command so the hint bar can stay up", () => {
    const tg = detectTrigger("/review @src/a", 14, { mentionMode: "combined" })
    expect(tg?.withinCommand).toBe("review")
  })

  it("works for a namespaced mention too", () => {
    const tg = detectTrigger("/plan @issue:rac", 16, { mentionMode: "combined" })
    expect(tg?.kind).toBe("entity")
    expect(tg?.namespace).toBe("issue:")
    expect(tg?.withinCommand).toBe("plan")
  })

  it("works past the FIRST argument, where the panel used to be shut entirely", () => {
    const tg = detectTrigger("/review deep @src/a", 19, { mentionMode: "combined" })
    expect(tg?.kind).toBe("file")
    expect(tg?.query).toBe("src/a")
  })

  it("never reaches back over the command word", () => {
    // The caret is in the command word itself — still a slash trigger.
    const tg = detectTrigger("/review @src/a", 4, { mentionMode: "combined" })
    expect(tg?.kind).toBe("slash")
    expect(tg?.query).toBe("rev")
  })

  it("leaves an argument with no `@` as a plain slash trigger", () => {
    const tg = detectTrigger("/add-dir /usr/local", 19, { mentionMode: "combined" })
    expect(tg?.kind).toBe("slash")
  })

  it("still skips an email in a command argument", () => {
    const tg = detectTrigger("/mail me@host.com", 17, { mentionMode: "combined" })
    expect(tg?.kind).toBe("slash")
  })

  it("does not set withinCommand for a mention on an ordinary line", () => {
    const tg = detectTrigger("look at @src/a", 14, { mentionMode: "combined" })
    expect(tg?.withinCommand).toBeUndefined()
  })
})
