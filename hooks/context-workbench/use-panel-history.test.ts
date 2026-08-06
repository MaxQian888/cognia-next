import {
  pushPanelHistory,
  navigateHistoryBack,
  navigateHistoryForward,
  canGoBack,
  canGoForward,
  pruneHistoryPanels,
  clearPanelHistory,
  resetPanelHistoryForTesting,
} from "./use-panel-history"

describe("panel history", () => {
  const scope = "test-scope::artifact-1"

  beforeEach(() => {
    resetPanelHistoryForTesting()
  })

  describe("pushPanelHistory", () => {
    it("records a panel visit", () => {
      pushPanelHistory(scope, "preview")
      expect(canGoBack(scope)).toBe(false)
      expect(canGoForward(scope)).toBe(false)
    })

    it("enables back navigation after two pushes", () => {
      pushPanelHistory(scope, "preview")
      pushPanelHistory(scope, "comments")
      expect(canGoBack(scope)).toBe(true)
      expect(canGoForward(scope)).toBe(false)
    })

    it("suppresses consecutive duplicates", () => {
      pushPanelHistory(scope, "preview")
      pushPanelHistory(scope, "preview")
      pushPanelHistory(scope, "preview")
      expect(canGoBack(scope)).toBe(false)
    })

    it("truncates forward history on new push", () => {
      pushPanelHistory(scope, "preview")
      pushPanelHistory(scope, "comments")
      pushPanelHistory(scope, "metadata")
      navigateHistoryBack(scope)
      navigateHistoryBack(scope) // now at preview
      expect(canGoForward(scope)).toBe(true)
      pushPanelHistory(scope, "workspace") // should truncate forward
      expect(canGoForward(scope)).toBe(false)
      expect(canGoBack(scope)).toBe(true)
    })

    it("caps stack at 20 entries", () => {
      for (let i = 0; i < 25; i++) {
        pushPanelHistory(scope, `panel-${i}`)
      }
      // Should be able to go back at most 19 times (from index 19 to 0)
      let backCount = 0
      while (navigateHistoryBack(scope) !== null) {
        backCount++
      }
      expect(backCount).toBe(19)
    })
  })

  describe("navigateHistoryBack", () => {
    it("returns null when at the start", () => {
      pushPanelHistory(scope, "preview")
      expect(navigateHistoryBack(scope)).toBeNull()
    })

    it("returns null for unknown scope", () => {
      expect(navigateHistoryBack("unknown")).toBeNull()
    })

    it("returns the previous panel id", () => {
      pushPanelHistory(scope, "preview")
      pushPanelHistory(scope, "comments")
      expect(navigateHistoryBack(scope)).toBe("preview")
    })

    it("can navigate back multiple steps", () => {
      pushPanelHistory(scope, "preview")
      pushPanelHistory(scope, "comments")
      pushPanelHistory(scope, "metadata")
      expect(navigateHistoryBack(scope)).toBe("comments")
      expect(navigateHistoryBack(scope)).toBe("preview")
      expect(navigateHistoryBack(scope)).toBeNull()
    })
  })

  describe("navigateHistoryForward", () => {
    it("returns null when at the end", () => {
      pushPanelHistory(scope, "preview")
      expect(navigateHistoryForward(scope)).toBeNull()
    })

    it("returns null for unknown scope", () => {
      expect(navigateHistoryForward("unknown")).toBeNull()
    })

    it("returns the next panel after going back", () => {
      pushPanelHistory(scope, "preview")
      pushPanelHistory(scope, "comments")
      navigateHistoryBack(scope)
      expect(navigateHistoryForward(scope)).toBe("comments")
    })

    it("back then forward round-trips correctly", () => {
      pushPanelHistory(scope, "preview")
      pushPanelHistory(scope, "comments")
      pushPanelHistory(scope, "metadata")
      navigateHistoryBack(scope) // → comments
      navigateHistoryBack(scope) // → preview
      expect(navigateHistoryForward(scope)).toBe("comments")
      expect(navigateHistoryForward(scope)).toBe("metadata")
      expect(navigateHistoryForward(scope)).toBeNull()
    })
  })

  describe("canGoBack / canGoForward", () => {
    it("both false for empty history", () => {
      expect(canGoBack(scope)).toBe(false)
      expect(canGoForward(scope)).toBe(false)
    })

    it("both false for single-entry history", () => {
      pushPanelHistory(scope, "preview")
      expect(canGoBack(scope)).toBe(false)
      expect(canGoForward(scope)).toBe(false)
    })

    it("canGoBack true, canGoForward false at end of stack", () => {
      pushPanelHistory(scope, "preview")
      pushPanelHistory(scope, "comments")
      expect(canGoBack(scope)).toBe(true)
      expect(canGoForward(scope)).toBe(false)
    })

    it("both true in the middle of stack", () => {
      pushPanelHistory(scope, "preview")
      pushPanelHistory(scope, "comments")
      pushPanelHistory(scope, "metadata")
      navigateHistoryBack(scope)
      expect(canGoBack(scope)).toBe(true)
      expect(canGoForward(scope)).toBe(true)
    })
  })

  describe("pruneHistoryPanels", () => {
    it("removes panels not in the available set", () => {
      pushPanelHistory(scope, "preview")
      pushPanelHistory(scope, "comments")
      pushPanelHistory(scope, "metadata")
      pruneHistoryPanels(scope, new Set(["preview", "metadata"]))
      // "comments" was removed; back from metadata should reach preview
      expect(navigateHistoryBack(scope)).toBe("preview")
      expect(navigateHistoryBack(scope)).toBeNull()
    })

    it("no-ops when all panels are available", () => {
      pushPanelHistory(scope, "preview")
      pushPanelHistory(scope, "comments")
      pruneHistoryPanels(scope, new Set(["preview", "comments"]))
      expect(canGoBack(scope)).toBe(true)
      expect(navigateHistoryBack(scope)).toBe("preview")
    })

    it("no-ops for unknown scope", () => {
      pruneHistoryPanels("unknown", new Set(["preview"]))
      // Should not throw
    })
  })

  describe("clearPanelHistory", () => {
    it("removes all history for a scope", () => {
      pushPanelHistory(scope, "preview")
      pushPanelHistory(scope, "comments")
      clearPanelHistory(scope)
      expect(canGoBack(scope)).toBe(false)
      expect(canGoForward(scope)).toBe(false)
    })
  })

  describe("scope isolation", () => {
    it("different scopes have independent histories", () => {
      const scope2 = "test-scope::artifact-2"
      pushPanelHistory(scope, "preview")
      pushPanelHistory(scope, "comments")
      pushPanelHistory(scope2, "metadata")
      pushPanelHistory(scope2, "workspace")
      expect(canGoBack(scope)).toBe(true)
      expect(canGoBack(scope2)).toBe(true)
      expect(navigateHistoryBack(scope)).toBe("preview")
      expect(navigateHistoryBack(scope2)).toBe("metadata")
    })
  })
})
