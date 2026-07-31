import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"
import { ProjectResourceSessionRelinker } from "./project-resource-session-relinker"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (query: () => Promise<unknown>) => {
    void query()
    return [
      {
        id: "old-session",
        kind: "resource-workbench",
        surfaceBinding: {
          kind: "project-file",
          projectId: "project",
          rootId: "/repo",
          relPath: "src/old.ts",
        },
      },
    ]
  },
}))
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ sessions: { toArray: jest.fn().mockResolvedValue([]) } }),
}))

it("lets the user reassociate an old repository-scoped embedded thread", async () => {
  useContextWorkbenchStore.setState({ sessionOverrides: {} })
  render(
    <ProjectResourceSessionRelinker
      resourceKey="project:project:/repo:src/new.ts"
      projectId="project"
      rootId="/repo"
      relPath="src/new.ts"
    />
  )
  await userEvent.click(screen.getByRole("button", { name: /src\/old.ts/ }))
  expect(
    useContextWorkbenchStore.getState().sessionOverrides["project:project:/repo:src/new.ts"]
  ).toBe("old-session")
})
