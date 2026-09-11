import {
  buildGitDiffDoc,
  loadGitDiff,
  gitDiffFileBody,
  splitRawGitDiff,
  gitDiffFileStats,
} from "./git-diff"

const UNSTAGED = `diff --git a/foo.ts b/foo.ts
index 111..222 100644
--- a/foo.ts
+++ b/foo.ts
@@ -1 +1 @@
-old
+new`

const STAGED = `diff --git a/bar.ts b/bar.ts
index 333..444 100644
--- a/bar.ts
+++ b/bar.ts
@@ -1 +1 @@
-x
+y`

describe("buildGitDiffDoc", () => {
  it("returns null when both diffs are empty/whitespace", () => {
    expect(buildGitDiffDoc("", "")).toBeNull()
    expect(buildGitDiffDoc("   \n", "\t")).toBeNull()
  })

  it("renders an unstaged-only diff in a ```diff fence", () => {
    const doc = buildGitDiffDoc(UNSTAGED, "")
    expect(doc).not.toBeNull()
    expect(doc!.title).toBe("Git diff")
    expect(doc!.body).toContain("## Unstaged changes")
    expect(doc!.body).not.toContain("## Staged changes")
    expect(doc!.body).toContain("```diff")
    expect(doc!.body).toContain("+new")
    expect(doc!.body).toContain("1 file changed")
  })

  it("renders staged before unstaged and counts both files", () => {
    const doc = buildGitDiffDoc(UNSTAGED, STAGED)!
    expect(doc.body.indexOf("## Staged changes")).toBeLessThan(
      doc.body.indexOf("## Unstaged changes")
    )
    expect(doc.body).toContain("2 files changed")
  })

  it("pluralizes the file count correctly", () => {
    expect(buildGitDiffDoc(UNSTAGED, "")!.body).toContain("1 file changed")
    expect(buildGitDiffDoc(UNSTAGED, STAGED)!.body).toContain("2 files changed")
  })
})

describe("git review inventory", () => {
  it("deduplicates files appearing in staged and unstaged sections", () => {
    expect(buildGitDiffDoc(UNSTAGED, UNSTAGED)!.body).toContain("1 file changed")
  })

  it("loads untracked files without shell parsing and honors ignored paths", async () => {
    const { execFileSync } = await import("node:child_process")
    const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const cwd = mkdtempSync(join(tmpdir(), "cognia-diff-"))
    try {
      const git = (...args: string[]) => execFileSync("git", args, { cwd })
      git("init", "--quiet")
      writeFileSync(join(cwd, ".gitignore"), "ignored.txt\n")
      writeFileSync(join(cwd, "tracked.txt"), "base\n")
      git("add", ".")
      git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "base")
      git("branch", "base")
      writeFileSync(join(cwd, "tracked.txt"), "committed branch change\n")
      git("add", "tracked.txt")
      git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-qm",
        "branch change"
      )
      mkdirSync(join(cwd, "subdir"))
      writeFileSync(join(cwd, "tracked.txt"), "staged\n")
      git("add", "tracked.txt")
      writeFileSync(join(cwd, "tracked.txt"), "unstaged\n")
      const unusual = "新文件 $(touch injected) ;.txt"
      writeFileSync(join(cwd, unusual), "new content\n")
      writeFileSync(join(cwd, "ignored.txt"), "secret\n")
      writeFileSync(join(cwd, "empty.txt"), "")
      writeFileSync(join(cwd, "binary.bin"), Buffer.from([0, 1, 2, 3]))
      const { runExec } = await import("../../agent/run-git")
      const commands: string[][] = []
      const result = await loadGitDiff(join(cwd, "subdir"), undefined, async (file, args, opts) => {
        commands.push(args)
        return runExec(file, args, opts)
      })
      expect(commands.filter((args) => args.includes("--raw"))).toHaveLength(2)
      expect(commands.some((args) => args.includes("--name-only"))).toBe(false)
      expect(result.files.map((file) => file.path).sort()).toEqual(
        ["binary.bin", "empty.txt", "tracked.txt", unusual].sort()
      )
      expect(result.files.find((file) => file.path === "tracked.txt")).toMatchObject({
        staged: expect.stringContaining("+staged"),
        unstaged: expect.stringContaining("+unstaged"),
      })
      expect(result.files.find((file) => file.path === unusual)?.untracked).toContain(
        "+new content"
      )
      expect(result.files.find((file) => file.path === "empty.txt")?.untracked).toContain(
        "new file mode"
      )
      expect(result.files.find((file) => file.path === "binary.bin")?.untracked).toContain(
        "Binary files"
      )
      const compared = await loadGitDiff(cwd, "HEAD")
      expect(compared.baseRef).toBe("HEAD")
      expect(compared.files.some((file) => file.branch)).toBe(false)
      const branch = await loadGitDiff(cwd, "base")
      expect(branch.files.find((file) => file.path === "tracked.txt")?.branch).toContain(
        "+committed branch change"
      )
      await expect(loadGitDiff(cwd, "--output=bad")).rejects.toThrow()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

it("selects scopes without mixing branch patches into working changes", () => {
  const file = {
    path: "a",
    staged: "staged",
    unstaged: "unstaged",
    untracked: "",
    branch: "branch",
  }
  expect(gitDiffFileBody(file, "all")).toBe("staged\nunstaged")
  expect(gitDiffFileBody(file, "branch")).toBe("branch")
  expect(gitDiffFileBody({ ...file, branch: undefined }, "branch")).toBe("")
})

it("propagates git failures instead of claiming a clean tree", async () => {
  await expect(
    loadGitDiff("/missing", undefined, async () => ({
      code: 128,
      stdout: "",
      stderr: "not a git repository",
    }))
  ).rejects.toThrow("not a git repository")
  await expect(
    loadGitDiff("/missing", undefined, async () => ({ code: 127, stdout: "", stderr: "" }))
  ).rejects.toThrow("failed (127)")
})

it("does not show a partial review after a listed new file disappears", async () => {
  const { runExec } = await import("../../agent/run-git")
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const cwd = mkdtempSync(join(tmpdir(), "cognia-diff-race-"))
  try {
    await runExec("git", ["init", "--quiet"], { cwd })
    writeFileSync(join(cwd, "vanish.txt"), "content")
    await expect(
      loadGitDiff(cwd, undefined, async (file, args, opts) => {
        if (args.includes("--no-index")) rmSync(join(cwd, "vanish.txt"))
        return runExec(file, args, opts)
      })
    ).rejects.toThrow()
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

it("localizes compatibility documents", () => {
  const doc = buildGitDiffDoc(UNSTAGED, "", "zh-CN")!
  expect(doc.title).toBe("Git 变更")
  expect(doc.body).toContain("1 个文件有变更")
})

it("rejects capture failures even when the process reports diff exit 1", async () => {
  await expect(
    loadGitDiff("/repo", undefined, async () => ({
      code: 1,
      stdout: "partial",
      stderr: "",
      error: "stdout maxBuffer length exceeded",
    }))
  ).rejects.toThrow("maxBuffer")
})

it("splits batched patches by NUL paths without guessing quoted header names", () => {
  const paths = ["a file\nwith newline", "二.ts"]
  const output =
    paths.map((path) => `:100644 100644 abc 000 M\0${path}\0`).join("") +
    "\0" +
    UNSTAGED +
    "\n" +
    STAGED
  expect(splitRawGitDiff(output)).toEqual([
    { path: paths[0], body: UNSTAGED + "\n" },
    { path: paths[1], body: STAGED },
  ])
  expect(splitRawGitDiff("")).toEqual([])
  expect(splitRawGitDiff("::100644 100644 100644 abc def 000 MM\0conflict\0")).toBeNull()
  expect(splitRawGitDiff(":100644 100644 abc 000 U\0conflict\0\0" + UNSTAGED)).toBeNull()
  expect(splitRawGitDiff(":100644 100644 abc 000 M\0a\0\0unexpected")).toBeNull()
  expect(splitRawGitDiff("odd\0\0patch")).toBeNull()
})

it("falls back to literal per-file queries for combined conflict formats", async () => {
  const seen: string[][] = []
  const result = await loadGitDiff("/repo", undefined, async (_file, args) => {
    seen.push(args)
    const stdout = args.includes("rev-parse")
      ? "/repo\n"
      : args.includes("ls-files") || args.includes("--cached")
        ? ""
        : args.includes("--raw")
          ? "::100644 100644 100644 abc def 000 MM\0conflict[1].ts\0"
          : args.includes("--name-only")
            ? "conflict[1].ts\0"
            : "diff --cc conflict[1].ts\n++<<<<<<< HEAD\n"
    return { stdout, stderr: "", code: 0 }
  })
  expect(result.files[0].unstaged).toContain("<<<<<<< HEAD")
  expect(seen.some((args) => args.includes(":(top,literal)conflict[1].ts"))).toBe(true)
})

it("counts only hunk bodies across working scopes, keeping branch separate", () => {
  const patch =
    "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n---literal content\n+++literal content\n same\n\\ No newline at end of file\n"
  const file = { path: "x", staged: patch, unstaged: patch, untracked: "", branch: STAGED }
  expect(gitDiffFileStats(file, "all")).toEqual({
    additions: 2,
    deletions: 2,
    hunks: 2,
    binary: false,
  })
  expect(gitDiffFileStats(file, "branch")).toEqual({
    additions: 1,
    deletions: 1,
    hunks: 1,
    binary: false,
  })
  expect(gitDiffFileStats(file, "untracked")).toEqual({
    additions: 0,
    deletions: 0,
    hunks: 0,
    binary: false,
  })
})

it("recognizes binary patches and combined conflict hunks without counting metadata", () => {
  const file = {
    path: "x",
    staged: "diff --git a/x b/x\nBinary files a/x and b/x differ",
    unstaged: "diff --cc x\n@@@ -1,1 -1,1 +1,1 @@@\n--removed\n++added",
    untracked: "",
  }
  expect(gitDiffFileStats(file, "all")).toEqual({
    additions: 1,
    deletions: 1,
    hunks: 1,
    binary: true,
  })
  expect(
    gitDiffFileStats({ ...file, staged: "GIT binary patch", unstaged: "" }, "all").binary
  ).toBe(true)
})

it("preserves empty untracked files when Git omits their patch without inventing content", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const cwd = mkdtempSync(join(tmpdir(), "cognia-empty-diff-"))
  const path = 'empty\n"name.txt'
  const exec = async (_file: string, args: string[]) => ({
    code: 0,
    stderr: "",
    stdout: args.includes("rev-parse") ? cwd + "\n" : args.includes("ls-files") ? path + "\0" : "",
  })
  try {
    writeFileSync(join(cwd, path), "")
    const review = await loadGitDiff(cwd, undefined, exec)
    expect(review.files[0].path).toBe(path)
    expect(review.files[0].untracked).toContain("new file mode 100644")
    expect(review.files[0].untracked).not.toContain("@@")
    expect(gitDiffFileStats(review.files[0], "all")).toEqual({
      additions: 0,
      deletions: 0,
      binary: false,
      hunks: 0,
    })
    writeFileSync(join(cwd, path), "real content")
    await expect(loadGitDiff(cwd, undefined, exec)).rejects.toThrow("Git returned no patch")
    rmSync(join(cwd, path))
    await expect(loadGitDiff(cwd, undefined, exec)).rejects.toThrow()
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

it("keeps nested repositories visible without diffing a directory against /dev/null", async () => {
  const { execFileSync } = await import("node:child_process")
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const cwd = mkdtempSync(join(tmpdir(), "cognia-nested-diff-"))
  try {
    execFileSync("git", ["init", "-q", cwd])
    for (const name of ["Cognia", "committed"]) {
      const nested = join(cwd, name)
      mkdirSync(nested)
      execFileSync("git", ["init", "-q", nested])
      writeFileSync(join(nested, "private.txt"), "nested contents must not be expanded")
      if (name === "committed") {
        execFileSync("git", ["add", "."], { cwd: nested })
        execFileSync(
          "git",
          ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "base"],
          { cwd: nested }
        )
      }
    }
    writeFileSync(join(cwd, "ordinary.txt"), "visible change\n")
    const result = await loadGitDiff(cwd)
    expect(result.files.map((file) => file.path)).toEqual(
      ["Cognia/", "committed/", "ordinary.txt"].sort((a, b) => a.localeCompare(b))
    )
    const directory = result.files.find((file) => file.path === "Cognia/")!
    expect(directory).toMatchObject({ untrackedDirectory: true })
    expect(gitDiffFileBody(directory, "untracked", "zh-CN")).toContain("目录")
    expect(gitDiffFileBody(directory, "all")).toContain("directory")
    expect(gitDiffFileBody(directory, "staged")).toBe("")
    expect(gitDiffFileBody(directory, "branch")).toBe("")
    expect(gitDiffFileStats(directory, "all").additions).toBe(0)
    expect(result.files.find((file) => file.path === "ordinary.txt")?.untracked).toContain(
      "+visible change"
    )
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
