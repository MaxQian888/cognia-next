import React from "react"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { CliI18nProvider } from "../../i18n"
import { RenderPrefsProvider } from "../../render/context"
import { RENDER_DEFAULTS } from "../../../config/schema"
import { act, render, waitFor } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"
import { TuiInputProvider } from "../../input/input-router"
import { SkillFilesOverlay } from "./SkillFilesOverlay"

jest.mock("../../input/element-position", () => ({
  absoluteTopLeft: jest.fn(() => ({ top: 1, left: 0 })),
}))

const files = [
  { relPath: "SKILL.md", absPath: "/skill/SKILL.md" },
  { relPath: "scripts/nested/run.ts", absPath: "/skill/scripts/nested/run.ts" },
  { relPath: "scripts/setup.sh", absPath: "/skill/scripts/setup.sh" },
]
const readFile = jest.fn(async (_root: string, path: string) => ({
  body: `content ${path}`,
  format: "text" as const,
}))
const fire = (input: string, key: Record<string, boolean> = {}) =>
  act(() => __fireInput(input, key))
const mount = (props: Partial<React.ComponentProps<typeof SkillFilesOverlay>> = {}) =>
  render(
    <TuiInputProvider>
      <SkillFilesOverlay
        title="Example skill"
        root="/skill"
        files={files}
        columns={120}
        onClose={jest.fn()}
        readFile={readFile}
        {...props}
      />
    </TuiInputProvider>
  )
beforeEach(() => {
  __resetInk()
  readFile.mockClear()
})

it("opens SKILL.md initially and expands nested directories to switch the preview", async () => {
  const { container } = mount()
  await waitFor(() => expect(container.textContent).toContain("content /skill/SKILL.md"))
  expect(container.textContent).not.toContain("run.ts")
  fire("", { upArrow: true })
  fire("", { rightArrow: true })
  expect(container.textContent).toContain("nested/")
  fire("", { rightArrow: true })
  fire("", { return: true })
  expect(container.textContent).toContain("run.ts")
  fire("", { downArrow: true })
  fire("", { return: true })
  await waitFor(() =>
    expect(container.textContent).toContain("content /skill/scripts/nested/run.ts")
  )
  expect(readFile).toHaveBeenLastCalledWith("/skill", "/skill/scripts/nested/run.ts", "en")
  fire("", { tab: true })
  fire("", { leftArrow: true })
  fire("", { leftArrow: true })
  expect(container.textContent).not.toContain("›     run.ts")
  fire("", { leftArrow: true })
  fire("", { leftArrow: true })
  expect(container.textContent).not.toContain("setup.sh")
})

it("keeps narrow previews separate and returns to the tree before closing", async () => {
  const onClose = jest.fn()
  const { container } = mount({ columns: 60, onClose })
  await waitFor(() => expect(readFile).toHaveBeenCalled())
  expect(container.textContent).not.toContain("content /skill/SKILL.md")
  fire("", { return: true })
  await waitFor(() => expect(container.textContent).toContain("content /skill/SKILL.md"))
  fire("", { escape: true })
  expect(onClose).not.toHaveBeenCalled()
  expect(container.textContent).toContain("scripts/")
  fire("", { escape: true })
  expect(onClose).toHaveBeenCalledTimes(1)
})

it("ignores a stale file read and allows leaving a loading preview", async () => {
  let resolveFirst!: (value: { body: string; format: "text" }) => void
  const reader = jest
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve
        })
    )
    .mockResolvedValue({ body: "new document", format: "text" })
  const { container } = mount({ readFile: reader })
  expect(container.textContent).toContain("Loading")
  fire("", { tab: true })
  fire("", { escape: true })
  fire("", { upArrow: true })
  fire("", { rightArrow: true })
  fire("", { downArrow: true })
  fire("", { downArrow: true })
  fire("", { return: true })
  await waitFor(() => expect(container.textContent).toContain("new document"))
  await act(async () => resolveFirst({ body: "stale document", format: "text" }))
  expect(container.textContent).not.toContain("stale document")
})

it("reports read errors and handles an empty file list", async () => {
  const onClose = jest.fn()
  const { container, unmount } = mount({
    readFile: jest.fn().mockRejectedValue(new Error("Permission denied")),
    onClose,
  })
  await waitFor(() => expect(container.textContent).toContain("Permission denied"))
  fire("", { tab: true })
  fire("q")
  expect(onClose).not.toHaveBeenCalled()
  fire("q")
  expect(onClose).toHaveBeenCalledTimes(1)
  unmount()
  const empty = mount({ files: [] })
  expect(empty.container.textContent).toContain("No bundled files")
  fire("", { downArrow: true })
  fire("", { tab: true })
})

it("pages the tree independently from the document and supports top/bottom", async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    relPath: `file-${String(i).padStart(2, "0")}.txt`,
    absPath: `/skill/${i}`,
  }))
  const { container } = mount({ files: many, viewportRows: 10, columns: 60 })
  await waitFor(() => expect(readFile).toHaveBeenCalled())
  fire("", { pageDown: true })
  expect(container.textContent).toContain("› file-05.txt")
  fire("", { pageUp: true })
  expect(container.textContent).toContain("› file-00.txt")
  fire("G")
  expect(container.textContent).toContain("› file-29.txt")
  fire("g")
  expect(container.textContent).toContain("› file-00.txt")
  fire("", { downArrow: true })
  fire("", { upArrow: true })
  fire("", { leftArrow: true })
})

it("keeps Chinese screen-reader mode in a single column", async () => {
  const { container } = render(
    <CliI18nProvider locale="zh-CN">
      <RenderPrefsProvider prefs={RENDER_DEFAULTS} screenReader>
        <TuiInputProvider>
          <SkillFilesOverlay
            title="Example"
            root="/skill"
            files={files}
            columns={160}
            onClose={() => {}}
            readFile={readFile}
          />
        </TuiInputProvider>
      </RenderPrefsProvider>
    </CliI18nProvider>
  )
  await waitFor(() => expect(readFile).toHaveBeenCalled())
  expect(container.textContent).toContain("文件夹")
  expect(container.textContent).not.toContain("content /skill/SKILL.md")
  fire("", { tab: true })
  expect(container.textContent).toContain("content /skill/SKILL.md")
})

it("bounds nested tree and preview to real terminal geometry", () => {
  const dir = mkdtempSync(join(process.cwd(), "node_modules/.skill-layout-"))
  const outfile = join(dir, "skill.mjs")
  try {
    const result = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
 import {build} from 'esbuild';import {renderToString} from 'ink';import React from 'react';import assert from 'node:assert/strict';
 await build({stdin:{contents:"export {SkillFilesOverlay} from './cli/src/tui/components/overlays/SkillFilesOverlay';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',packages:'external',outfile:${JSON.stringify(outfile)},logLevel:'silent'});
 const {SkillFilesOverlay}=await import(${JSON.stringify(outfile)});
 for(const columns of [20,40,80,100,160]) for(const viewportRows of [8,16,30]){
 const out=renderToString(React.createElement(SkillFilesOverlay,{title:'Example long skill title',root:'/skill',files:${JSON.stringify(files)},columns,viewportRows,onClose:()=>{},readFile:async()=>({body:'preview',format:'text'})}),{columns});
 const lines=out.split('\\n');assert.ok(lines.length<=viewportRows,columns+': '+lines.length+' rows');assert.ok(lines.every(line=>line.length<=columns),out);
 }
 console.log('15 skill layouts passed');
 `,
      ],
      { encoding: "utf8", timeout: 30000 }
    )
    expect(result).toContain("15 skill layouts passed")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it("scrolls the preview under the pointer even while the file tree has keyboard focus", async () => {
  const body = Array.from({ length: 100 }, (_, i) => `row-${i + 1}`).join("\n")
  const { container } = mount({
    viewportRows: 16,
    readFile: async () => ({ body, format: "text" }),
  })
  await waitFor(() => expect(container.textContent).toContain("row-1"))
  fire("[<65;60;5M")
  expect(container.textContent).not.toContain("row-1row-2")
  expect(container.textContent).toContain("row-4")
  // Click to focus the preview, then keyboard paging also belongs to it.
  fire("[<0;60;5M")
  fire("", { pageDown: true })
  expect(container.textContent).not.toContain("row-4row-5")
  fire("g")
  expect(container.textContent).toContain("row-1")
})

it("routes wheel and click-to-focus through real Ink in a PTY", () => {
  const dir = mkdtempSync(join(process.cwd(), "node_modules/.skill-scroll-"))
  const outfile = join(dir, "scroll.mjs")
  const source = `import React from 'react';import {render} from 'ink';
    import {SkillFilesOverlay} from './cli/src/tui/components/overlays/SkillFilesOverlay';
    import {TuiInputProvider} from './cli/src/tui/input/input-router';
    render(React.createElement(TuiInputProvider,null,React.createElement(SkillFilesOverlay,{
      title:'Scroll test',root:'/skill',files:[{relPath:'SKILL.md',absPath:'/skill/SKILL.md'}],columns:120,viewportRows:16,onClose:()=>process.exit(0),
      readFile:async()=>({body:Array.from({length:100},(_,i)=>'row-'+(i+1)).join('\\n'),format:'text'})
    })),{exitOnCtrlC:false});`
  try {
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import {build} from 'esbuild';import pty from 'node-pty';
      await build({stdin:{contents:${JSON.stringify(source)},resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',packages:'external',outfile:${JSON.stringify(outfile)},logLevel:'silent'});
      await new Promise((resolve,reject)=>{
        const child=pty.spawn(process.execPath,[${JSON.stringify(outfile)}],{name:'xterm-256color',cols:120,rows:20,cwd:process.cwd(),env:{...process.env,TERM:'xterm-256color'}});
        let text='',stage=0;const timeout=setTimeout(()=>{child.kill();reject(new Error('PTY scroll failed: '+text.slice(-2000)))},10000);
        child.onData(chunk=>{text+=chunk;
          if(stage===0&&text.includes('1–8 / 100')){stage=1;text='';child.write('\\x1b[<65;60;5M')}
          else if(stage===1&&text.includes('4–11 / 100')){stage=2;text='';child.write('\\x1b[<0;60;5M');setTimeout(()=>child.write('\\x1b[6~'),30)}
          else if(stage===2&&text.includes('12–19 / 100')){clearTimeout(timeout);child.kill();resolve()}
        });
      });console.log('real PTY preview wheel and keyboard passed');
    `,
      ],
      { encoding: "utf8", timeout: 20000 }
    )
    expect(output).toContain("real PTY preview wheel and keyboard passed")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it("keeps tree wheel events and outside clicks from scrolling the preview", async () => {
  const body = Array.from({ length: 100 }, (_, i) => `row-${i + 1}`).join("\n")
  const many = Array.from({ length: 20 }, (_, i) => ({
    relPath: `file-${i}.txt`,
    absPath: `/skill/${i}`,
  }))
  const { container } = mount({
    files: many,
    viewportRows: 16,
    readFile: async () => ({ body, format: "text" }),
  })
  await waitFor(() => expect(container.textContent).toContain("row-1row-2"))
  fire("[<65;5;5M")
  expect(container.textContent).toContain("› file-11.txt")
  expect(container.textContent).toContain("row-1row-2")
  fire("[<65;60;99M")
  expect(container.textContent).toContain("row-1row-2")
})

it("scrolls the narrow preview after switching panes and returns to files", async () => {
  const body = Array.from({ length: 100 }, (_, i) => `row-${i + 1}`).join("\n")
  const { container } = mount({
    columns: 60,
    viewportRows: 16,
    readFile: async () => ({ body, format: "text" }),
  })
  await waitFor(() => expect(container.textContent).toContain("Files"))
  fire("", { tab: true })
  await waitFor(() => expect(container.textContent).toContain("row-1row-2"))
  fire("[<65;10;5M")
  expect(container.textContent).toContain("row-4row-5")
  fire("", { escape: true })
  expect(container.textContent).toContain("scripts/")
  expect(container.textContent).not.toContain("row-4row-5")
})
