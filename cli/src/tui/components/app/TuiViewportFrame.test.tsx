import React from "react"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { render } from "@testing-library/react"
import { Text } from "ink"

import { TuiViewportFrame } from "./TuiViewportFrame"

describe("TuiViewportFrame", () => {
  it("clips a fullscreen overlay above the fixed bottom region", () => {
    const { container } = render(
      <TuiViewportFrame
        columns={40}
        rows={12}
        fullscreen
        overlayOpen
        transcript={<Text>transcript</Text>}
        overlays={<Text>overlay</Text>}
        bottom={<Text>bottom</Text>}
      />
    )

    expect(container.textContent).not.toContain("transcript")
    expect(container.textContent).toContain("overlay")
    expect(container.textContent).toContain("bottom")
    expect(container.querySelector('[data-testid="fullscreen-overlay-region"]')).toHaveAttribute(
      "data-flex-grow",
      "1"
    )
  })

  it("keeps transcript and overlays in scrollback mode", () => {
    const { container } = render(
      <TuiViewportFrame
        columns={80}
        rows={24}
        fullscreen={false}
        overlayOpen
        transcript={<Text>transcript</Text>}
        overlays={<Text>overlay</Text>}
        bottom={<Text>bottom</Text>}
      />
    )
    expect(container.textContent).toBe("transcriptoverlaybottom")
  })
})

it("docks compact fullscreen panels directly above the footer in real Yoga", () => {
  const dir = mkdtempSync(join(process.cwd(), "node_modules/.overlay-dock-"))
  const outfile = join(dir, "frame.mjs")
  try {
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import {build} from 'esbuild'; import {renderToString,Box,Text} from 'ink';
      import React from 'react'; import assert from 'node:assert/strict';
      await build({stdin:{contents:"export {TuiViewportFrame} from './cli/src/tui/components/app/TuiViewportFrame'; export {SettingsOverlay} from './cli/src/tui/components/overlays/SettingsOverlay';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',packages:'external',outfile:${JSON.stringify(outfile)},logLevel:'silent'});
      const {TuiViewportFrame,SettingsOverlay}=await import(${JSON.stringify(outfile)});
      const text=value=>React.createElement(Text,null,value);
      const frame=over=>React.createElement(TuiViewportFrame,{columns:40,rows:12,fullscreen:true,overlayOpen:true,transcript:text('TRANSCRIPT'),overlays:text('PANEL'),bottom:text('FOOTER'),...over});
      const compact=renderToString(frame({}),{columns:40}).split('\\n');
      assert.equal(compact.length,12,compact.join('\\n'));
      assert.equal(compact[10].trim(),'PANEL'); assert.equal(compact[11].trim(),'FOOTER');
      const tall=renderToString(frame({overlays:React.createElement(Box,{flexDirection:'column'},...Array.from({length:11},(_,i)=>text('ROW'+i)))}),{columns:40}).split('\\n');
      assert.equal(tall.length,12);assert.equal(tall[0].trim(),'ROW0');assert.equal(tall[10].trim(),'ROW10');assert.equal(tall[11].trim(),'FOOTER');
      const inline=renderToString(frame({overlayTakesScreen:false,transcript:React.createElement(Box,{flexGrow:1},text('TRANSCRIPT')),overlays:text('APPROVAL')}),{columns:40}).split('\\n');
      assert.ok(inline[0].includes('TRANSCRIPT'));assert.equal(inline[10].trim(),'APPROVAL');assert.equal(inline[11].trim(),'FOOTER');
      const native=renderToString(frame({fullscreen:false}),{columns:40});
      assert.equal(native,'TRANSCRIPT\\nPANEL\\nFOOTER');
      for(const [columns,rows,count,index] of [[40,12,60,0],[80,24,60,30],[80,24,3,0]]) {
        const sections=[{id:'advanced',title:'Advanced',rows:Array.from({length:count},(_,i)=>({id:String(i),label:'Setting '+i,value:'value',description:'Selected setting description',control:{type:'readonly'}}))}];
        const panel=React.createElement(SettingsOverlay,{sections,section:0,index,width:columns,viewportRows:rows-1,onMoveRow:()=>{},onSwitchSection:()=>{},onAdjust:()=>{},onToggle:()=>{},onActivate:()=>{},onClose:()=>{}});
        const output=renderToString(frame({columns,rows,overlays:panel}),{columns}).split('\\n');
        assert.equal(output.length,rows,output.join('\\n'));
        assert.ok(output[rows-2].includes('╰'),output.join('\\n'));
        assert.equal(output[rows-1].trim(),'FOOTER');
        if(count>rows) assert.ok(output[0].includes('╭'),output.join('\\n'));
      }
      console.log('4 real Yoga layouts passed; 3 settings layouts passed');
    `,
      ],
      { encoding: "utf8", timeout: 30000 }
    )
    expect(output).toContain("4 real Yoga layouts passed")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it("keeps inline approvals beside the transcript rather than using the fullscreen docking region", () => {
  const { container } = render(
    <TuiViewportFrame
      columns={80}
      rows={24}
      fullscreen
      overlayOpen
      overlayTakesScreen={false}
      transcript={<Text>transcript</Text>}
      overlays={<Text>approval</Text>}
      bottom={<Text>footer</Text>}
    />
  )
  expect(container.textContent).toBe("transcriptapprovalfooter")
  expect(container.querySelector('[data-testid="fullscreen-overlay-region"]')).toBeNull()
})
