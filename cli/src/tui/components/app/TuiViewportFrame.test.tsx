import React from "react"
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
