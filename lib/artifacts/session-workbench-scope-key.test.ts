import {
  ARTIFACT_DOCK_WORKBENCH_HOST_KEY,
  SESSION_ARTIFACT_LIST_PANEL_ID,
  sessionWorkbenchScopeKey,
} from "./session-workbench-scope-key"

describe("sessionWorkbenchScopeKey", () => {
  it("scopes a conversation under its workbench instance", () => {
    expect(sessionWorkbenchScopeKey("browser:abc:artifact", "s-1")).toBe(
      "browser:abc:artifact::session:s-1"
    )
  })

  it("gives a dock with no conversation a stable scope", () => {
    // The workbench's own `?? "none"` fallback — both surfaces and the focus
    // seam must land on the identical string or their layouts diverge.
    expect(sessionWorkbenchScopeKey("browser:abc:artifact", null)).toBe(
      "browser:abc:artifact::session:none"
    )
  })

  it("names the dock host and the artifact-list panel the way the dock registers them", () => {
    expect(ARTIFACT_DOCK_WORKBENCH_HOST_KEY).toBe("artifact")
    expect(SESSION_ARTIFACT_LIST_PANEL_ID).toBe("artifacts")
  })
})
