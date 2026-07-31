import {
  COMPLETION_POPUP_CLAMP,
  TERMINAL_LAYOUT,
  completionListMaxHeight,
  terminalExitDotClass,
} from "./terminal-layout-tokens"

describe("terminal-layout-tokens", () => {
  it("exposes complete Tailwind class literals for each floating surface", () => {
    expect(TERMINAL_LAYOUT.searchInputWidth).toBe("w-44")
    expect(TERMINAL_LAYOUT.historyRailWidth).toBe("w-64")
    expect(TERMINAL_LAYOUT.commandMenuWidth).toBe("w-60")
    expect(TERMINAL_LAYOUT.quickFixMenuWidth).toBe("w-72")
    expect(TERMINAL_LAYOUT.completionPopupWidth).toBe("w-80")
    expect(TERMINAL_LAYOUT.stickyScrollHeight).toBe("h-[1.4em]")
  })

  describe("completionListMaxHeight", () => {
    it("floors at the readable minimum for a short dock", () => {
      expect(completionListMaxHeight(60)).toBe(COMPLETION_POPUP_CLAMP.minPx)
    })

    it("caps at the maximum when there is ample room above", () => {
      expect(completionListMaxHeight(400)).toBe(COMPLETION_POPUP_CLAMP.maxPx)
    })

    it("uses the space above minus the reserved hint room in between", () => {
      // 200 - 28 reserve = 172, between the 72/240 bounds.
      expect(completionListMaxHeight(200)).toBe(172)
    })
  })

  describe("terminalExitDotClass", () => {
    it("is muted for an unknown exit code", () => {
      expect(terminalExitDotClass(null)).toBe("bg-muted-foreground/60")
    })
    it("is green for a clean exit", () => {
      expect(terminalExitDotClass(0)).toBe("bg-emerald-500")
    })
    it("is red for a non-zero exit", () => {
      expect(terminalExitDotClass(1)).toBe("bg-red-500")
      expect(terminalExitDotClass(137)).toBe("bg-red-500")
    })
  })
})
