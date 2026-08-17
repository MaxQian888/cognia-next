/** @jest-environment jsdom */

import { purgeProjectBuckets, registerProjectBucketPurger } from "./project-bucket-purge"

beforeEach(() => {
  window.localStorage.clear()
})

it("purges loaded stores and every persisted account bucket for one project", () => {
  const livePurge = jest.fn()
  registerProjectBucketPurger("test-live-store", livePurge)
  window.localStorage.setItem(
    "cognia-artifacts:acct",
    JSON.stringify({
      version: 5,
      state: {
        artifacts: {
          remove: { id: "remove", projectId: "A" },
          keep: { id: "keep", projectId: "B" },
        },
        canvasDocuments: {
          removeCanvas: { id: "removeCanvas", projectId: "A" },
          keepCanvas: { id: "keepCanvas", projectId: "B" },
        },
        pendingReviews: { remove: {}, keepCanvas: {} },
        openArtifactIdsBySession: { s1: ["remove", "keep"], s2: ["remove"] },
        activeArtifactIdBySession: { s1: "remove", s2: "keep" },
        activeCanvasId: "removeCanvas",
      },
    })
  )
  window.localStorage.setItem(
    "cognia-agent-teams",
    JSON.stringify({
      version: 4,
      state: {
        teams: {
          removeTeam: { id: "removeTeam", projectId: "A" },
          keepTeam: { id: "keepTeam", projectId: "B" },
          // A pre-isolation row (no projectId): not this workspace's, so the
          // purge leaves it — persist v7 stamps it DEFAULT_PROJECT_ID on load.
          legacyTeam: { id: "legacyTeam" },
        },
        teammates: {
          removeMate: { id: "removeMate", teamId: "removeTeam" },
          keepMate: { id: "keepMate", teamId: "keepTeam" },
        },
        tasks: {
          removeTask: { id: "removeTask", teamId: "removeTeam" },
          keepTask: { id: "keepTask", teamId: "keepTeam" },
        },
        editorSession: { removeTeam: {}, keepTeam: {} },
        activeTeamId: "removeTeam",
      },
    })
  )

  purgeProjectBuckets("A")

  expect(livePurge).toHaveBeenCalledWith("A")
  const artifacts = JSON.parse(window.localStorage.getItem("cognia-artifacts:acct")!)
  expect(artifacts.state).toMatchObject({
    artifacts: { keep: expect.any(Object) },
    canvasDocuments: { keepCanvas: expect.any(Object) },
    pendingReviews: { keepCanvas: {} },
    openArtifactIdsBySession: { s1: ["keep"] },
    activeArtifactIdBySession: { s2: "keep" },
    activeCanvasId: null,
  })
  const teams = JSON.parse(window.localStorage.getItem("cognia-agent-teams")!)
  expect(Object.keys(teams.state.teams).sort()).toEqual(["keepTeam", "legacyTeam"])
  expect(teams.state).toMatchObject({
    teams: { keepTeam: expect.any(Object) },
    teammates: { keepMate: expect.any(Object) },
    tasks: { keepTask: expect.any(Object) },
    editorSession: { keepTeam: {} },
    activeTeamId: null,
  })
})

it("leaves malformed snapshots untouched", () => {
  window.localStorage.setItem("cognia-artifacts", "{not-json")
  purgeProjectBuckets("A")
  expect(window.localStorage.getItem("cognia-artifacts")).toBe("{not-json")
})
