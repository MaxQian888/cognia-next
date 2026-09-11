import React from "react"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { act, render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { ConfirmOverlay } from "./ConfirmOverlay"

const longBody = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n")

function fire(input: string, key: Record<string, boolean> = {}): void {
  act(() => __fireInput(input, key))
}

describe("ConfirmOverlay", () => {
  beforeEach(() => __resetInk())

  it("renders the title and a viewport window with the confirm/cancel footer", () => {
    const { container } = render(
      <ConfirmOverlay
        title="Overwrite?"
        body={longBody}
        format="text"
        onConfirm={() => {}}
        onCancel={() => {}}
        viewportRows={16}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("Overwrite?")
    expect(text).toContain("line 1")
    expect(text).toContain("line 10")
    expect(text).not.toContain("line 11")
    expect(text).toContain("Enter confirm")
    expect(text).toContain("Esc cancel")
  })

  it("shares duplicate-heading suppression and preserves a different heading", () => {
    const props = {
      body: "# Review changes\n\n- Keep source intact",
      format: "markdown" as const,
      onConfirm: jest.fn(),
      onCancel: jest.fn(),
    }
    const { container, rerender } = render(<ConfirmOverlay {...props} title="Review changes" />)
    expect(container.textContent!.match(/Review changes/g)).toHaveLength(1)
    expect(container.textContent).toContain("Keep source intact")
    rerender(<ConfirmOverlay {...props} title="Confirm overwrite?" />)
    expect(container.textContent).toContain("Confirm overwrite?")
    expect(container.textContent).toContain("Review changes")
    expect(props.onConfirm).not.toHaveBeenCalled()
  })

  it("keeps every navigation route available after heading suppression", () => {
    const { container } = render(
      <ConfirmOverlay
        title="Tools"
        body={"# Tools\n\n" + Array.from({ length: 30 }, (_, i) => `- tool_${i}`).join("\n")}
        format="markdown"
        viewportRows={10}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    )
    fire("[<65;1;1M")
    expect(container.textContent).toContain("2–5 / 30")
    fire("[<64;1;1M")
    fire("[<0;1;1M")
    fire(" ")
    fire("b")
    fire("", { pageDown: true })
    fire("", { pageUp: true })
    fire("G")
    fire("g")
    fire("", { upArrow: true })
    expect(container.textContent).toContain("1–4 / 30")
    fire("x")
  })

  it("confirms on Enter", () => {
    const onConfirm = jest.fn()
    const onCancel = jest.fn()
    render(
      <ConfirmOverlay
        title="t"
        body={longBody}
        format="text"
        onConfirm={onConfirm}
        onCancel={onCancel}
        viewportRows={16}
      />
    )
    fire("", { return: true })
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
  })

  it("cancels on Escape and q", () => {
    const onCancel = jest.fn()
    render(
      <ConfirmOverlay
        title="t"
        body={longBody}
        format="text"
        onConfirm={() => {}}
        onCancel={onCancel}
        viewportRows={16}
      />
    )
    fire("", { escape: true })
    fire("q")
    expect(onCancel).toHaveBeenCalledTimes(2)
  })

  it("scrolls the body without confirming", () => {
    const onConfirm = jest.fn()
    const { container } = render(
      <ConfirmOverlay
        title="t"
        body={longBody}
        format="text"
        onConfirm={onConfirm}
        onCancel={() => {}}
        viewportRows={16}
      />
    )
    fire("", { downArrow: true })
    expect(container.textContent).toContain("line 11")
    fire("", { pageDown: true })
    fire("G")
    expect(container.textContent).toContain("line 100")
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it("renders markdown bodies through the markdown renderer", () => {
    const { container } = render(
      <ConfirmOverlay
        title="t"
        body={"# Heading\n\nsome **bold** text"}
        format="markdown"
        onConfirm={() => {}}
        onCancel={() => {}}
        viewportRows={20}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("Heading")
    expect(text).toContain("bold")
  })
})

describe("ConfirmOverlay remembered acknowledgement", () => {
  beforeEach(() => __resetInk())

  function setup() {
    const callbacks = { onConfirm: jest.fn(), onRemember: jest.fn(), onCancel: jest.fn() }
    const view = render(
      <ConfirmOverlay
        title="Bypass?"
        body={longBody}
        format="text"
        viewportRows={16}
        {...callbacks}
      />
    )
    return { ...callbacks, ...view }
  }

  it("defaults to this session and never implicitly remembers", () => {
    const view = setup()
    expect(view.container.textContent).toContain("❯ Enable for this session only")
    expect(view.container.textContent).toContain("Enable and don't ask again")
    fire("", { return: true })
    expect(view.onConfirm).toHaveBeenCalledTimes(1)
    expect(view.onRemember).not.toHaveBeenCalled()
    expect(view.onCancel).not.toHaveBeenCalled()
  })

  it("requires selecting the remember choice before dispatching it", () => {
    const view = setup()
    fire("", { downArrow: true })
    expect(view.container.textContent).toContain("❯ Enable and don't ask again")
    expect(view.container.textContent).toContain("1–7 / 100")
    fire("", { return: true })
    expect(view.onRemember).toHaveBeenCalledTimes(1)
    expect(view.onConfirm).not.toHaveBeenCalled()
  })

  it("wraps to cancel with Up and cancels on Enter or Escape", () => {
    const view = setup()
    fire("", { upArrow: true })
    expect(view.container.textContent).toContain("❯ Cancel")
    fire("", { return: true })
    fire("", { escape: true })
    expect(view.onCancel).toHaveBeenCalledTimes(2)
    expect(view.onRemember).not.toHaveBeenCalled()
    expect(view.onConfirm).not.toHaveBeenCalled()
  })

  it("keeps paging and wheel scrolling independent from the selected choice", () => {
    const view = setup()
    fire("", { downArrow: true })
    fire("", { pageDown: true })
    expect(view.container.textContent).toContain("8–14 / 100")
    fire("", { pageUp: true })
    fire("[<65;1;1M")
    expect(view.container.textContent).toContain("2–8 / 100")
    fire("", { return: true })
    expect(view.onRemember).toHaveBeenCalledTimes(1)
  })
})

it("keeps bypass choices visible below wrapped warning text in real Ink", () => {
  const dir = mkdtempSync(join(process.cwd(), "node_modules/.bypass-layout-"))
  const outfile = join(dir, "overlay.mjs")
  try {
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import {build} from 'esbuild'; import {renderToString, Text} from 'ink';
      import React from 'react'; import assert from 'node:assert/strict';
      await build({stdin:{contents:"export {ConfirmOverlay} from './cli/src/tui/components/overlays/ConfirmOverlay'; export {TuiViewportFrame} from './cli/src/tui/components/app/TuiViewportFrame'; export {BYPASS_CONFIRM_BODY,BYPASS_CONFIRM_TITLE} from './cli/src/tui/runtime/permission-mode-switch';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',packages:'external',outfile:${JSON.stringify(outfile)},logLevel:'silent'});
      const {ConfirmOverlay,TuiViewportFrame,BYPASS_CONFIRM_BODY,BYPASS_CONFIRM_TITLE}=await import(${JSON.stringify(outfile)});
      for(const [columns,rows] of [[40,10],[80,12],[80,24]]) {
        const panel=React.createElement(ConfirmOverlay,{columns,viewportRows:rows-1,title:BYPASS_CONFIRM_TITLE,body:BYPASS_CONFIRM_BODY,format:'markdown',onConfirm:()=>{},onRemember:()=>{},onCancel:()=>{}});
        const frame=React.createElement(TuiViewportFrame,{columns,rows,fullscreen:true,overlayOpen:true,transcript:null,overlays:panel,bottom:React.createElement(Text,null,'FOOTER')});
        const rendered=renderToString(frame,{columns}).split('\\n');
        assert.equal(rendered.length,rows,rendered.join('\\n'));
        const text=rendered.join('\\n');
        assert.ok(text.includes('Enable for this session only'),text);
        assert.ok(text.includes("Enable and don't ask again"),text);
        assert.ok(text.includes('Cancel'),text);
        assert.equal(rendered[rows-1].trim(),'FOOTER');
      }
      console.log('3 bypass layouts passed');
    `,
      ],
      { encoding: "utf8", timeout: 30000 }
    )
    expect(output).toContain("3 bypass layouts passed")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
