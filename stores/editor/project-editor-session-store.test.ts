/** @jest-environment jsdom */

import {
  activateProjectEditorAccountStorage,
  clearProjectEditorAccountStorage,
  purgeProjectEditorAccountStorage,
  useProjectEditorSessionStore,
} from "./project-editor-session-store"

const legacySession = {
  rootKey: "/repo",
  openPaths: ["src/index.ts"],
  activePath: "src/index.ts",
}

describe("useProjectEditorSessionStore", () => {
  beforeEach(() => {
    window.localStorage.clear()
    clearProjectEditorAccountStorage()
  })

  it("stores editor sessions by generic scope key", () => {
    useProjectEditorSessionStore.getState().setSession("session:chat-1", legacySession)
    useProjectEditorSessionStore.getState().setSession("session:chat-1", {
      activePath: "src/next.ts",
    })

    expect(useProjectEditorSessionStore.getState().sessions["session:chat-1"]).toEqual({
      ...legacySession,
      activePath: "src/next.ts",
    })
  })

  it("imports legacy team editor sessions on first account activation", () => {
    window.localStorage.setItem(
      "cognia-agent-teams:acct-a",
      JSON.stringify({ state: { editorSession: { team1: legacySession } }, version: 6 })
    )

    activateProjectEditorAccountStorage("acct-a")

    expect(useProjectEditorSessionStore.getState().sessions["team:team1"]).toEqual(legacySession)
    expect(
      JSON.parse(window.localStorage.getItem("cognia-project-editor-sessions:acct-a") ?? "{}").state
        ?.sessions?.["team:team1"]
    ).toEqual(legacySession)
    expect(window.localStorage.getItem("cognia-agent-teams:acct-a")).not.toBeNull()

    clearProjectEditorAccountStorage()
    activateProjectEditorAccountStorage("acct-a")
    expect(useProjectEditorSessionStore.getState().sessions["team:team1"]).toEqual(legacySession)
  })

  it("keeps account snapshots isolated and never overwrites a new snapshot with legacy data", () => {
    activateProjectEditorAccountStorage("acct-a")
    useProjectEditorSessionStore.getState().setSession("session:a", legacySession)

    activateProjectEditorAccountStorage("acct-b")
    expect(useProjectEditorSessionStore.getState().sessions).toEqual({})
    useProjectEditorSessionStore.getState().setSession("session:b", {
      ...legacySession,
      rootKey: "/other",
    })

    activateProjectEditorAccountStorage("acct-a")
    expect(useProjectEditorSessionStore.getState().sessions).toEqual({
      "session:a": legacySession,
    })

    window.localStorage.setItem(
      "cognia-agent-teams:acct-a",
      JSON.stringify({ state: { editorSession: { stale: legacySession } }, version: 6 })
    )
    activateProjectEditorAccountStorage("acct-a")
    expect(useProjectEditorSessionStore.getState().sessions).not.toHaveProperty("team:stale")
  })

  it("clears runtime state and purges only the requested account", () => {
    activateProjectEditorAccountStorage("acct-a")
    useProjectEditorSessionStore.getState().setSession("session:a", legacySession)
    activateProjectEditorAccountStorage("acct-b")
    useProjectEditorSessionStore.getState().setSession("session:b", legacySession)

    purgeProjectEditorAccountStorage("acct-a")
    clearProjectEditorAccountStorage()

    expect(useProjectEditorSessionStore.getState().sessions).toEqual({})
    expect(window.localStorage.getItem("cognia-project-editor-sessions:acct-a")).toBeNull()
    expect(window.localStorage.getItem("cognia-project-editor-sessions:acct-b")).not.toBeNull()
  })

  it("treats malformed or non-object account snapshots as empty", () => {
    window.localStorage.setItem("cognia-project-editor-sessions:invalid-json", "{")
    activateProjectEditorAccountStorage("invalid-json")
    expect(useProjectEditorSessionStore.getState().sessions).toEqual({})

    window.localStorage.setItem("cognia-project-editor-sessions:null-json", "null")
    activateProjectEditorAccountStorage("null-json")
    expect(useProjectEditorSessionStore.getState().sessions).toEqual({})

    window.localStorage.setItem(
      "cognia-project-editor-sessions:no-sessions",
      JSON.stringify({ state: {} })
    )
    activateProjectEditorAccountStorage("no-sessions")
    expect(useProjectEditorSessionStore.getState().sessions).toEqual({})
  })

  it("ignores a malformed legacy editor session map", () => {
    window.localStorage.setItem(
      "cognia-agent-teams:bad-legacy",
      JSON.stringify({ state: { editorSession: "invalid" } })
    )

    activateProjectEditorAccountStorage("bad-legacy")

    expect(useProjectEditorSessionStore.getState().sessions).toEqual({})
  })
})
