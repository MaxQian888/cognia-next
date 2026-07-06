import { buildGitDiffDoc } from "./git-diff"

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
