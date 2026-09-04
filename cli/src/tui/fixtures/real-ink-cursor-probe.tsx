import { PassThrough, Writable } from "node:stream"
import React from "react"
import { render } from "ink"

import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import { ThemeProvider } from "../theme/context"
import { BUILTIN_THEMES } from "../theme/builtins"
import { TuiInputProvider } from "../input/input-router"
import { createInitialState } from "../state/initial"
import { Input } from "../components/Input"

let output = ""
const stdout = new Writable({
  write(chunk, _encoding, callback) {
    output += chunk.toString()
    callback()
  },
}) as NodeJS.WriteStream
stdout.columns = 80
stdout.rows = 24
stdout.isTTY = true
const stdin = new PassThrough() as unknown as NodeJS.ReadStream
stdin.isTTY = true
stdin.setRawMode = () => stdin
stdin.ref = () => stdin
stdin.unref = () => stdin

const config = { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work" }
const state = createInitialState(config, "cursor-probe")

const instance = render(
  <TuiInputProvider>
    <ThemeProvider palette={BUILTIN_THEMES.cognia}>
      <Input
        input={state.input}
        dispatch={() => {}}
        onSubmit={() => {}}
        disabled={false}
        cwd="/work"
        width={80}
      />
    </ThemeProvider>
  </TuiInputProvider>,
  { stdin, stdout, exitOnCtrlC: false, incrementalRendering: false }
)

await new Promise((resolve) => setTimeout(resolve, 25))
const frame = output
instance.unmount()

process.stdout.write(
  JSON.stringify({
    hasVisualCaret: frame.includes("█"),
    showsNativeCursor: frame.includes("\u001b[?25h"),
    // A caret drawn with SGR 7 is a caret nobody can see: reverse video paints
    // the FULL BLOCK in the background colour over the whole cell. The probe
    // reports the escapes around the glyph so the test can pin the difference
    // between "the caret is emitted" and "the caret is visible".
    invertedCaret: frame.includes("\u001b[7m█"),
    caretContext: frame.slice(Math.max(0, frame.indexOf("█") - 24), frame.indexOf("█")),
  })
)
