import { fireEvent, render, screen } from "@testing-library/react"
import { BestOfNRunCard } from "./best-of-n-run-card"
import { useDockTabsStore } from "@/stores/artifact/dock-tabs-store"
const navigate = jest.fn()
const expand = jest.fn()
const park = jest.fn()
jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("@/hooks/best-of-n/use-best-of-n-run", () => ({
  useBestOfNRun: () => ({
    summary: {
      group: {
        phase: "running",
        n: 2,
        candidates: [
          { candidateId: "a", index: 0, status: "succeeded" },
          { candidateId: "b", index: 1, status: "running" },
        ],
      },
    },
  }),
}))
jest.mock("@/lib/artifacts/dock-pages", () => ({
  dockSessionScopeKey: (id: string) => `scope:${id}`,
}))
jest.mock("@/stores/artifact/artifact-store", () => ({
  useArtifactStore: { getState: () => ({ setActiveArtifact: park }) },
}))
jest.mock("@/stores/artifact/artifact-dock-layout-store", () => ({
  useArtifactDockLayoutStore: { getState: () => ({ setDockCollapsed: expand }) },
}))
jest.mock("@/stores/context-workbench/context-workbench-store", () => ({
  ...jest.requireActual("@/stores/context-workbench/context-workbench-store"),
  useContextWorkbenchStore: { getState: () => ({ navigatePanel: navigate }) },
}))
it("opens the group's comparison in the parent session's dock", () => {
  render(<BestOfNRunCard groupId="group" sessionId="parent" />)
  expect(screen.getByRole("status")).toHaveTextContent("phase.running")
  fireEvent.click(screen.getByRole("button", { name: "compare" }))
  expect(useDockTabsStore.getState().bySession.parent.bestOfNGroupId).toBe("group")
  expect(navigate).toHaveBeenCalledWith("scope:parent", "best-of-n", "wide")
  expect(park).toHaveBeenCalledWith(null, "parent")
  expect(expand).toHaveBeenCalledWith(false)
})
