import { RenderPrefsProvider } from "../../render/context"
import { RENDER_DEFAULTS } from "../../../config/schema"
import { CliI18nProvider } from "../../i18n"
import React from "react"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { act, render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { DocumentViewer } from "./DocumentViewer"

const longBody = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n")

/** Fire a key and flush the resulting local-state re-render. */
function fire(input: string, key: Record<string, boolean> = {}): void {
  act(() => __fireInput(input, key))
}

describe("DocumentViewer", () => {
  it("bounds long inspect blocks to real terminal rows and columns", () => {
    const dir = mkdtempSync(join(process.cwd(), "node_modules/.inspect-layout-"))
    const outfile = join(dir, "viewer.mjs")
    try {
      const result = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        import {build} from 'esbuild'; import {renderToString} from 'ink';
        import React from 'react'; import assert from 'node:assert/strict';
        await build({stdin:{contents:"export {DocumentViewer} from './cli/src/tui/components/overlays/DocumentViewer';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',packages:'external',outfile:${JSON.stringify(outfile)},logLevel:'silent'});
        const {DocumentViewer}=await import(${JSON.stringify(outfile)});
        const body='## Invocation\\n\\n### Command\\n\\n~~~bash\\n'+'head -n 80; cat file; '.repeat(25)+'\\n~~~\\n\\n### Output\\n\\n~~~text\\n'+Array.from({length:100},(_,i)=>'row '+i).join('\\n')+'\\n~~~';
        for(const columns of [20,40,80,160]) {
          const out=renderToString(React.createElement(DocumentViewer,{title:'bash output',body,format:'markdown',columns,viewportRows:16,onClose:()=>{}}),{columns});
          const lines=out.split('\\n');
          assert.ok(lines.length<=16, columns+': '+lines.length+' rows');
          assert.ok(lines.every(line=>line.length<=columns),out);
          assert.ok(out.includes('1–'),out);
        }
        console.log('4 inspect layouts passed');
      `,
        ],
        { encoding: "utf8", timeout: 30000 }
      )
      expect(result).toContain("4 inspect layouts passed")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  beforeEach(() => __resetInk())

  it("scrolls through wrapped code rows to the actual document end", () => {
    const { container } = render(
      <DocumentViewer
        title="Inspect"
        format="markdown"
        body={"~~~bash\n" + "echo abc; ".repeat(40) + "\n~~~\n\nEND OF OUTPUT"}
        columns={24}
        viewportRows={12}
        onClose={() => {}}
      />
    )
    expect(container.textContent).not.toContain("END OF OUTPUT")
    fire("G")
    expect(container.textContent).toContain("END OF OUTPUT")
    fire("g")
    expect(container.textContent).not.toContain("END OF OUTPUT")
  })

  it("renders the title and a viewport window of text lines", () => {
    const { container } = render(
      <DocumentViewer
        title="Doc"
        body={longBody}
        format="text"
        onClose={() => {}}
        viewportRows={16}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("Doc")
    expect(text).toContain("line 1")
    expect(text).toContain("line 10")
    // Beyond the viewport window is not rendered yet.
    expect(text).not.toContain("line 11")
    expect(text).toContain("1–10 / 100")
  })

  it("scrolls down a line on ↓ and up on ↑", () => {
    const { container } = render(
      <DocumentViewer
        title="Doc"
        body={longBody}
        format="text"
        onClose={() => {}}
        viewportRows={16}
      />
    )
    fire("", { downArrow: true })
    expect(container.textContent).toContain("line 11")
    fire("", { upArrow: true })
    expect(container.textContent).toContain("1–10 / 100")
  })

  it("scrolls on the mouse wheel (down then up) and ignores the raw escape", () => {
    const { container } = render(
      <DocumentViewer
        title="Doc"
        body={longBody}
        format="text"
        onClose={() => {}}
        viewportRows={16}
      />
    )
    // SGR wheel-down → scroll forward by WHEEL_SCROLL_LINES (3).
    fire("[<65;5;5M")
    expect(container.textContent).toContain("4–13 / 100")
    // The raw escape must not have been rendered as document text.
    expect(container.textContent ?? "").not.toContain("[<65")
    // SGR wheel-up → scroll back.
    fire("[<64;5;5M")
    expect(container.textContent).toContain("1–10 / 100")
  })

  it("pages with PgDn and jumps to the bottom on G", () => {
    const { container } = render(
      <DocumentViewer
        title="Doc"
        body={longBody}
        format="text"
        onClose={() => {}}
        viewportRows={16}
      />
    )
    fire("", { pageDown: true })
    expect(container.textContent).toContain("line 11")
    fire("G")
    expect(container.textContent).toContain("line 100")
    expect(container.textContent).toContain("91–100 / 100")
  })

  it("clamps scrolling at the top and bottom", () => {
    const { container } = render(
      <DocumentViewer
        title="Doc"
        body={longBody}
        format="text"
        onClose={() => {}}
        viewportRows={16}
      />
    )
    fire("", { upArrow: true }) // already at top
    expect(container.textContent).toContain("1–10 / 100")
    fire("G")
    fire("", { downArrow: true }) // already at bottom
    expect(container.textContent).toContain("91–100 / 100")
  })

  it("pages with Space/b and returns to the top on g", () => {
    const { container } = render(
      <DocumentViewer
        title="Doc"
        body={longBody}
        format="text"
        onClose={() => {}}
        viewportRows={16}
      />
    )
    fire(" ") // space → page down
    expect(container.textContent).toContain("line 11")
    fire("b") // b → page up
    expect(container.textContent).toContain("1–10 / 100")
    fire("G")
    fire("g") // g → back to top
    expect(container.textContent).toContain("1–10 / 100")
  })

  it("falls back to the terminal height when no viewportRows is given", () => {
    const { container } = render(
      <DocumentViewer title="Doc" body={"a\nb\nc"} format="text" onClose={() => {}} />
    )
    expect(container.textContent).toContain("Doc")
    expect(container.textContent).toContain("a")
  })

  it("renders markdown bodies through the markdown renderer", () => {
    const { container } = render(
      <DocumentViewer
        title="Skill"
        body={"# Heading\n\nsome **bold** text"}
        format="markdown"
        onClose={() => {}}
        viewportRows={20}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("Heading")
    expect(text).toContain("bold")
  })

  it("shows a repeated document title once and copies the unmodified source", () => {
    const body = "# Built-in tools\n\n- Read files\n- Edit files"
    const onCopy = jest.fn()
    const { container } = render(
      <DocumentViewer
        title="Built-in tools"
        body={body}
        format="markdown"
        onClose={() => {}}
        onCopy={onCopy}
      />
    )
    expect(container.textContent!.match(/Built-in tools/g)).toHaveLength(1)
    expect(container.textContent).toContain("Read files")
    fire("y")
    expect(onCopy).toHaveBeenCalledWith(body)
  })

  it("recomputes heading visibility when only the panel title changes", () => {
    const props = {
      body: "# Built-in tools\n\nRead files",
      format: "markdown" as const,
      onClose: () => {},
    }
    const { container, rerender } = render(<DocumentViewer {...props} title="Built-in tools" />)
    expect(container.textContent!.match(/Built-in tools/g)).toHaveLength(1)
    rerender(<DocumentViewer {...props} title="Tool reference" />)
    expect(container.textContent).toContain("Tool reference")
    expect(container.textContent).toContain("Built-in tools")
  })

  it("searches and pages the remaining document after removing the repeated heading", () => {
    const body = "# Tools\n\n" + Array.from({ length: 30 }, (_, i) => `- tool_${i}`).join("\n")
    const { container } = render(
      <DocumentViewer
        title="Tools"
        body={body}
        format="markdown"
        viewportRows={10}
        onClose={() => {}}
      />
    )
    expect(container.textContent).toContain("1–4 / 30")
    fire("/")
    fire("tool_29")
    fire("", { return: true })
    expect(container.textContent).toContain("tool_29")
    expect(container.textContent).toContain("27–30 / 30")
    fire("n")
    fire("N")
    expect(container.textContent).toContain("1/1 matches")
    fire("/")
    fire("absent")
    fire("", { return: true })
    expect(container.textContent).toContain("0/0 matches")
    fire("n")
    fire("/")
    fire("a")
    fire("", { backspace: true })
    fire("", { return: true })
    expect(container.textContent).not.toContain("matches")
    fire("/")
    fire("", { escape: true })
    fire("u", { ctrl: true })
    fire("d", { ctrl: true })
    fire("", { pageUp: true })
    fire("[<0;1;1M")
    fire("x")
  })

  it("renders a diff body as a GitHub-style numbered patch", () => {
    const patch = `diff --git a/f.ts b/f.ts\nindex 1111111..2222222 100644\n--- a/f.ts\n+++ b/f.ts\n@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+more\n`
    const { container } = render(
      <DocumentViewer
        title="f.ts"
        body={patch}
        format="diff"
        lang="typescript"
        onClose={() => {}}
        viewportRows={16}
      />
    )
    const text = container.textContent ?? ""
    // Numbered gutters + signs replace the raw +/- dump, and the raw patch
    // headers (index/---/+++) are folded away.
    expect(text).toContain("@@ -1,2 +1,3 @@")
    expect(text).toContain("- old")
    expect(text).toContain("+ new")
    expect(text).not.toContain("index 1111111")
    expect(text).not.toContain("--- a/f.ts")
    expect(text).toContain("hunk 1/1")
    expect(text).toContain("s split view")
  })

  it("jumps between hunks with [ and ] and reports the hunk position", () => {
    const hunks = Array.from(
      { length: 6 },
      (_, i) => `@@ -${i * 10},1 +${i * 10},1 @@\n-old${i}\n+new${i}\n`
    ).join("")
    const patch = `diff --git a/f.ts b/f.ts\n${hunks}`
    const { container } = render(
      <DocumentViewer
        title="f.ts"
        body={patch}
        format="diff"
        onClose={() => {}}
        viewportRows={12}
      />
    )
    expect(container.textContent).toContain("hunk 1/6")
    fire("]")
    expect(container.textContent).toContain("hunk 2/6")
    fire("]")
    fire("]")
    fire("]")
    fire("]")
    expect(container.textContent).toContain("hunk 6/6")
    expect(container.textContent).toContain("new5")
    // Layout toggles re-anchor on the current hunk instead of losing position.
    fire("s")
    expect(container.textContent).toContain("hunk 6/6")
    fire("s")
    expect(container.textContent).toContain("hunk 6/6")
    fire("[")
    expect(container.textContent).toContain("hunk 5/6")
    fire("[")
    fire("[")
    fire("[")
    fire("[")
    fire("[")
    expect(container.textContent).toContain("hunk 1/6")
  })

  it("toggles between unified and split layouts on s", () => {
    const patch = `diff --git a/f.ts b/f.ts\n@@ -1,2 +1,2 @@\n ctx\n-old code\n+new code\n`
    const { container } = render(
      <DocumentViewer
        title="f.ts"
        body={patch}
        format="diff"
        onClose={() => {}}
        viewportRows={16}
        columns={90}
      />
    )
    expect(container.textContent).toContain("s split view")
    expect(container.textContent).not.toContain("│")
    fire("s")
    expect(container.textContent).toContain("s unified view")
    expect(container.textContent).toContain("│")
    const text = container.textContent ?? ""
    const paired = text.split("\n").find((line) => line.includes("old code"))
    expect(paired).toContain("new code")
    fire("s")
    expect(container.textContent).not.toContain("│")
  })

  it("labels staged/unstaged sections inside one file body", () => {
    const staged = `diff --git a/f.ts b/f.ts\n@@ -1 +1 @@\n-oldS\n+newS\n`
    const unstaged = `diff --git a/f.ts b/f.ts\n@@ -1 +1 @@\n-oldU\n+newU\n`
    const { container } = render(
      <DocumentViewer
        title="f.ts"
        body={`${staged}\n${unstaged}`}
        format="diff"
        diffSections={[
          { label: "staged", body: staged },
          { label: "unstaged", body: unstaged },
        ]}
        onClose={() => {}}
        viewportRows={20}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("staged")
    expect(text).toContain("unstaged")
  })

  it("keeps the plain text rendering for diff bodies in screen-reader mode", () => {
    const patch = `diff --git a/f.ts b/f.ts\n@@ -1 +1 @@\n-old\n+new\n`
    const { container } = render(
      <RenderPrefsProvider prefs={RENDER_DEFAULTS} screenReader>
        <DocumentViewer
          title="f.ts"
          body={patch}
          format="diff"
          lang="diff"
          onClose={() => {}}
          viewportRows={16}
        />
      </RenderPrefsProvider>
    )
    const text = container.textContent ?? ""
    // Raw patch lines stay verbatim for the reader — no gutters or hunk bars.
    expect(text).toContain("@@ -1 +1 @@")
    expect(text).toContain("-old")
    expect(text).not.toContain("hunk 1/1")
  })

  it("closes on Escape, q, and Enter", () => {
    const onClose = jest.fn()
    render(
      <DocumentViewer
        title="Doc"
        body={longBody}
        format="text"
        onClose={onClose}
        viewportRows={16}
      />
    )
    fire("", { escape: true })
    fire("q")
    fire("", { return: true })
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it("shows 'all' for a document that fits the viewport", () => {
    const { container } = render(
      <DocumentViewer
        title="Doc"
        body={"a\nb\nc"}
        format="text"
        onClose={() => {}}
        viewportRows={16}
      />
    )
    expect(container.textContent).toContain("all")
  })

  it("searches, jumps between matches, and copies the complete document", () => {
    const onCopy = jest.fn()
    const { container } = render(
      <DocumentViewer
        title="Transcript"
        body={longBody}
        format="text"
        onClose={() => {}}
        onCopy={onCopy}
        viewportRows={16}
      />
    )
    fire("/")
    for (const char of "line 50") fire(char)
    fire("", { return: true })
    expect(container.textContent).toContain("line 50")
    expect(container.textContent).toContain("1/1 matches")
    fire("y")
    expect(onCopy).toHaveBeenCalledWith(longBody)
  })
})

it("keeps reader search editable and navigable without a decorative caret", () => {
  __resetInk()
  const onCopy = jest.fn()
  const body = "first match\nother\nlast match"
  const { container } = render(
    <CliI18nProvider locale="zh-CN">
      <RenderPrefsProvider prefs={RENDER_DEFAULTS} screenReader>
        <DocumentViewer title="Doc" body={body} format="text" onClose={() => {}} onCopy={onCopy} />
      </RenderPrefsProvider>
    </CliI18nProvider>
  )
  fire("/")
  fire("match")
  expect(container.textContent).toContain("/match")
  expect(container.textContent).not.toContain("█")
  fire("", { return: true })
  expect(container.textContent).toContain("1/2")
  fire("n")
  expect(container.textContent).toContain("2/2")
  fire("y")
  expect(onCopy).toHaveBeenCalledWith(body)
})
