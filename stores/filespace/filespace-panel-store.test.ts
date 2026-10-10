import type { FileSpacePath } from "@/types/filespace"

import { CONVERSATION_FILES_PANEL_ID, useFileSpacePanelStore } from "./filespace-panel-store"

const p = (value: string) => value as FileSpacePath

describe("useFileSpacePanelStore", () => {
  beforeEach(() => useFileSpacePanelStore.setState({ focus: null }))

  it("names the dock panel", () => {
    expect(CONVERSATION_FILES_PANEL_ID).toBe("conversation-files")
  })

  it("carries the conversation with every focus request and tells two apart", () => {
    useFileSpacePanelStore.getState().requestFocus("s1", p("/uploads/a.pdf"))
    const first = useFileSpacePanelStore.getState().focus
    useFileSpacePanelStore.getState().requestFocus("s1", p("/uploads/a.pdf"))
    const second = useFileSpacePanelStore.getState().focus
    expect(first).toMatchObject({ sessionId: "s1", path: "/uploads/a.pdf" })
    expect(second!.seq).toBeGreaterThan(first!.seq)
  })

  it("consumes only the request that was applied", () => {
    const store = useFileSpacePanelStore.getState()
    store.requestFocus("s1", p("/workspace"))
    const stale = useFileSpacePanelStore.getState().focus!.seq
    store.requestFocus("s2", p("/uploads/b.pdf"))
    useFileSpacePanelStore.getState().consumeFocus(stale)
    expect(useFileSpacePanelStore.getState().focus).toMatchObject({ sessionId: "s2" })
    useFileSpacePanelStore.getState().consumeFocus(useFileSpacePanelStore.getState().focus!.seq)
    expect(useFileSpacePanelStore.getState().focus).toBeNull()
  })
})
