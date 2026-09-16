import { absoluteTopLeft } from "../../input/element-position"
jest.mock("../../input/element-position", () => ({ absoluteTopLeft: jest.fn(() => null) }))
import React from "react"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { act, render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"
import { TuiInputProvider } from "../../input/input-router"
import { GitDiffOverlay } from "./GitDiffOverlay"
import { CliI18nProvider } from "../../i18n"
import { RenderPrefsProvider } from "../../render/context"
import { RENDER_DEFAULTS } from "../../../config/schema"
import type { GitDiffReview } from "../../runtime/git-diff"

const review: GitDiffReview = {
  files: [
    { path: "a.ts", staged: "+staged", unstaged: "+unstaged", untracked: "" },
    {
      path: "new.ts",
      staged: "",
      unstaged: "",
      untracked: Array.from({ length: 80 }, (_, i) => `+new ${i}`).join("\n"),
    },
  ],
}
const fire = (input: string, key: Record<string, boolean> = {}) =>
  act(() => __fireInput(input, key))

beforeEach(() => {
  __resetInk()
  jest.mocked(absoluteTopLeft).mockReturnValue(null)
})

it("opens a selected file, searches/copies its entire patch and returns to files", () => {
  const onCopy = jest.fn()
  const onClose = jest.fn()
  const { container } = render(
    <TuiInputProvider>
      <GitDiffOverlay
        review={review}
        columns={60}
        viewportRows={20}
        onCopy={onCopy}
        onClose={onClose}
      />
    </TuiInputProvider>
  )
  expect(container.textContent).toContain("2 files")
  fire("", { downArrow: true })
  fire("", { return: true })
  fire("/")
  fire("new 79")
  fire("", { return: true })
  expect(container.textContent).toContain("+new 79")
  fire("y")
  expect(onCopy).toHaveBeenCalledWith(review.files[1].untracked)
  fire("", { escape: true })
  expect(onClose).not.toHaveBeenCalled()
  expect(container.textContent).toContain("a.ts")
  fire("", { escape: true })
  expect(onClose).toHaveBeenCalledTimes(1)
})

it("marks files viewed with x, walks the review queue, and hides them with X", () => {
  const { container } = render(
    <TuiInputProvider>
      <GitDiffOverlay review={review} columns={60} viewportRows={20} onClose={() => {}} />
    </TuiInputProvider>
  )
  // a.ts is selected; x marks it and advances to the next unviewed file.
  fire("x")
  expect(container.textContent).toContain("1 viewed")
  expect(container.textContent).toContain("✓ a.ts")
  fire("x")
  expect(container.textContent).toContain("2 viewed")
  // Everything is viewed now: X hides the whole list, X again restores it.
  fire("X")
  expect(container.textContent).not.toContain("✓")
  fire("X")
  // Back to full view: a.ts is selected (shows ›), new.ts keeps its ✓.
  expect(container.textContent).toContain("✓ new.ts")
  // x on a viewed file unmarks it.
  fire("", { upArrow: true })
  fire("x")
  expect(container.textContent).toContain("1 viewed")
})

it("renders the patch pane as a numbered GitHub-style diff", () => {
  const file = {
    path: "file.ts",
    staged:
      "diff --git a/file.ts b/file.ts\nindex 1111111..2222222 100644\n--- a/file.ts\n+++ b/file.ts\n@@ -1,2 +1,2 @@\n keep\n-old code\n+new code\n",
    unstaged: "",
    untracked: "",
  }
  const { container } = render(
    <TuiInputProvider>
      <GitDiffOverlay
        review={{ files: [file] }}
        columns={60}
        viewportRows={20}
        onClose={() => {}}
      />
    </TuiInputProvider>
  )
  fire("", { return: true })
  const text = container.textContent ?? ""
  expect(text).toContain("@@ -1,2 +1,2 @@")
  expect(text).toContain("- old code")
  expect(text).toContain("+ new code")
  expect(text).not.toContain("index 1111111")
  expect(text).toContain("hunk 1/1")
})

it("switches staged/unstaged/untracked scope and handles an empty scope", () => {
  const { container } = render(
    <TuiInputProvider>
      <GitDiffOverlay review={review} columns={140} onClose={() => {}} />
    </TuiInputProvider>
  )
  fire("", { rightArrow: true, ctrl: true })
  expect(container.textContent).toContain("1 file")
  expect(container.textContent).toContain("+staged")
  expect(container.textContent).not.toContain("+unstaged")
  fire("", { rightArrow: true, ctrl: true })
  expect(container.textContent).toContain("+unstaged")
  fire("", { rightArrow: true, ctrl: true })
  expect(container.textContent).toContain("new.ts")
  fire("", { tab: true })
  fire("G")
  expect(container.textContent).toContain("+new 79")
})

it("shows explicit branch comparison and an empty state", () => {
  const { container } = render(
    <TuiInputProvider>
      <GitDiffOverlay review={{ files: [], baseRef: "main" }} onClose={() => {}} />
    </TuiInputProvider>
  )
  expect(container.textContent).toContain("main")
  expect(container.textContent).toContain("No changes")
  fire("", { upArrow: true })
  fire("", { tab: true })
  fire("", { leftArrow: true, ctrl: true })
})

it("refreshes without closing or losing the selected file", () => {
  const onRefresh = jest.fn()
  const onClose = jest.fn()
  const { container, rerender } = render(
    <TuiInputProvider>
      <GitDiffOverlay review={review} onRefresh={onRefresh} onClose={onClose} />
    </TuiInputProvider>
  )
  fire("", { downArrow: true })
  fire("r")
  expect(onRefresh).toHaveBeenCalledTimes(1)
  expect(onClose).not.toHaveBeenCalled()
  rerender(
    <TuiInputProvider>
      <GitDiffOverlay
        review={{ files: [review.files[0]] }}
        onRefresh={onRefresh}
        onClose={onClose}
      />
    </TuiInputProvider>
  )
  expect(container.textContent).toContain("a.ts")
  fire("", { return: true })
  expect(container.textContent).toContain("+staged")
})

it("uses Chinese copy and a single reading column in screen-reader mode", () => {
  const { container } = render(
    <CliI18nProvider locale="zh-CN">
      <RenderPrefsProvider prefs={RENDER_DEFAULTS} screenReader>
        <TuiInputProvider>
          <GitDiffOverlay review={review} columns={160} onClose={() => {}} />
        </TuiInputProvider>
      </RenderPrefsProvider>
    </CliI18nProvider>
  )
  expect(container.textContent).toContain("全部工作区变更")
  expect(container.textContent).not.toContain("+staged")
  fire("", { return: true })
  expect(container.textContent).toContain("+staged")
  expect(container.textContent).toContain("搜索")
})

it("bounds both file list and wide preview to the actual terminal", () => {
  const dir = mkdtempSync(join(process.cwd(), "node_modules/.diff-layout-"))
  const outfile = join(dir, "review.mjs")
  try {
    const result = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import {build} from 'esbuild'; import {renderToString} from 'ink';
      import React from 'react'; import assert from 'node:assert/strict';
      await build({stdin:{contents:"export {GitDiffOverlay} from './cli/src/tui/components/overlays/GitDiffOverlay';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',packages:'external',outfile:${JSON.stringify(outfile)},logLevel:'silent'});
      const {GitDiffOverlay}=await import(${JSON.stringify(outfile)});
      const review={files:Array.from({length:80},(_,i)=>({path:'src/very-long-directory/file-'+i+'.ts',staged:'+added\\n'.repeat(100),unstaged:'',untracked:''}))};
      for(const columns of [20,40,80,160]) {
        const out=renderToString(React.createElement(GitDiffOverlay,{review,columns,viewportRows:16,onClose:()=>{}}),{columns});
        const lines=out.split('\\n');
        assert.ok(lines.length<=16, columns+': '+lines.length+' rows');
        assert.ok(lines.every(line=>line.length<=columns),out);
      }
      console.log('4 diff layouts passed');
    `,
      ],
      { encoding: "utf8", timeout: 30000 }
    )
    expect(result).toContain("4 diff layouts passed")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it("pages and bounds file navigation independently from patch scrolling", () => {
  const onClose = jest.fn()
  const files = Array.from({ length: 30 }, (_, index) => ({
    ...review.files[0],
    path: `file-${index}.ts`,
  }))
  const { container } = render(
    <TuiInputProvider>
      <GitDiffOverlay review={{ files }} columns={60} viewportRows={12} onClose={onClose} />
    </TuiInputProvider>
  )
  fire("", { pageDown: true })
  expect(container.textContent).toContain("file-6.ts")
  fire("", { pageUp: true })
  fire("G")
  expect(container.textContent).toContain("file-29.ts")
  fire("g")
  expect(container.textContent).toContain("file-0.ts")
  fire("", { upArrow: true })
  fire("r")
  fire("q")
  expect(onClose).toHaveBeenCalledTimes(1)
})

it("filters file paths across pages without search keys triggering refresh or exit", () => {
  const onRefresh = jest.fn()
  const onClose = jest.fn()
  const { container } = render(
    <TuiInputProvider>
      <GitDiffOverlay review={review} onRefresh={onRefresh} onClose={onClose} />
    </TuiInputProvider>
  )
  fire("/")
  fire("q r")
  expect(onRefresh).not.toHaveBeenCalled()
  expect(onClose).not.toHaveBeenCalled()
  fire("", { return: true })
  expect(container.textContent).toContain("No matching files")
  fire("", { escape: true })
  fire("/")
  fire("new")
  fire("", { return: true })
  expect(container.textContent).toContain("1/2 files")
  expect(container.textContent).not.toContain("a.ts")
  fire("", { return: true })
  fire("r", { ctrl: true })
  expect(onRefresh).toHaveBeenCalledTimes(1)
  fire("", { escape: true })
  expect(container.textContent).toContain("new.ts")
  fire("", { escape: true })
  expect(container.textContent).toContain("a.ts")
  expect(onClose).not.toHaveBeenCalled()
})

it("shows per-file additions/deletions and binary state", () => {
  const file = {
    path: "file.ts",
    staged:
      "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n",
    unstaged: "",
    untracked: "",
  }
  const { container, rerender } = render(
    <TuiInputProvider>
      <GitDiffOverlay review={{ files: [file] }} onClose={() => {}} />
    </TuiInputProvider>
  )
  expect(container.textContent).toContain("+1 −1")
  expect(container.textContent).toContain("1 hunks")
  rerender(
    <TuiInputProvider>
      <GitDiffOverlay
        review={{ files: [{ ...file, staged: "Binary files a/file.ts and b/file.ts differ" }] }}
        onClose={() => {}}
      />
    </TuiInputProvider>
  )
  expect(container.textContent).toContain("Binary change")
})

it("routes mouse wheels to the pane under the pointer and supports file clicks", () => {
  jest.mocked(absoluteTopLeft).mockReturnValue({ top: 1, left: 0 })
  const { container } = render(
    <TuiInputProvider>
      <GitDiffOverlay review={review} columns={140} viewportRows={20} onClose={() => {}} />
    </TuiInputProvider>
  )
  // Wheel down over the file list selects the next file.
  fire("[<65;5;6M")
  expect(container.textContent).toContain("+new 0")
  // Wheel over the preview must scroll that document even with file focus.
  for (let i = 0; i < 30; i++) fire("[<65;100;6M")
  expect(container.textContent).toContain("+new 79")
  // First file: root title + panel border + filter heading precede it.
  fire("[<0;5;4M")
  expect(container.textContent).toContain("+staged")
  expect(container.textContent).not.toContain("+new 79")
})

it("escapes control characters in file labels without changing the copied patch", () => {
  const onCopy = jest.fn()
  const file = { ...review.files[0], path: "line\nbreak\tfile.ts" }
  const { container } = render(
    <TuiInputProvider>
      <GitDiffOverlay review={{ files: [file] }} columns={80} onClose={() => {}} onCopy={onCopy} />
    </TuiInputProvider>
  )
  expect(container.textContent).toContain("line\\nbreak\\tfile.ts")
  fire("", { return: true })
  fire("y")
  expect(onCopy).toHaveBeenCalledWith(`${file.staged}\n${file.unstaged}`)
})

it("shows localized directory boundaries and does not claim failures are clean", () => {
  const { container, rerender } = render(
    <CliI18nProvider locale="zh-CN">
      <TuiInputProvider>
        <GitDiffOverlay
          review={{
            files: [
              {
                path: "Cognia/",
                staged: "",
                unstaged: "",
                untracked: "",
                untrackedDirectory: true,
              },
            ],
          }}
          columns={160}
          onClose={() => {}}
        />
      </TuiInputProvider>
    </CliI18nProvider>
  )
  expect(container.textContent).toContain("Cognia/")
  expect(container.textContent).toContain("嵌套仓库")
  for (const status of ["loading", "failed"] as const) {
    rerender(
      <TuiInputProvider>
        <GitDiffOverlay review={{ files: [] }} status={status} onClose={() => {}} />
      </TuiInputProvider>
    )
    expect(container.textContent).not.toContain("No changes in this scope")
    expect(container.textContent).not.toContain("0 files")
    expect(container.textContent).toContain(
      status === "failed" ? "Press r to retry" : "Loading changes"
    )
  }
})
