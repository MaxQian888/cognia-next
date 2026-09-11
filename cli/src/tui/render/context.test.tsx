import React from "react"
import { render } from "@testing-library/react"
import { Text } from "ink"

import { RenderPrefsProvider, useRenderPrefs, useScreenReader } from "./context"
import { RENDER_DEFAULTS } from "../../config/schema"

function Probe() {
  const prefs = useRenderPrefs()
  const screenReader = useScreenReader()
  return <Text>{`${prefs.fileLineNumbers}:${prefs.toolResultMaxLines}:${screenReader}`}</Text>
}

describe("RenderPrefsProvider / useRenderPrefs", () => {
  it("propagates the accessibility mode", () => {
    const { container } = render(
      <RenderPrefsProvider prefs={RENDER_DEFAULTS} screenReader>
        <Probe />
      </RenderPrefsProvider>
    )
    expect(container.textContent).toContain(":true")
  })
  it("returns the defaults with no provider", () => {
    const { container } = render(<Probe />)
    expect(container.textContent).toContain(
      `${RENDER_DEFAULTS.fileLineNumbers}:${RENDER_DEFAULTS.toolResultMaxLines}`
    )
  })

  it("provides the supplied prefs to descendants", () => {
    const { container } = render(
      <RenderPrefsProvider
        prefs={{ ...RENDER_DEFAULTS, fileLineNumbers: false, toolResultMaxLines: 7 }}
      >
        <Probe />
      </RenderPrefsProvider>
    )
    expect(container.textContent).toContain("false:7")
  })
})
