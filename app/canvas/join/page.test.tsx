/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const push = jest.fn()
let searchParams = new URLSearchParams("")
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => searchParams,
}))

const setSelectedGuild = jest.fn()
jest.mock("@/stores/ui", () => ({
  useUIStore: <T,>(selector: (s: { setSelectedGuild: typeof setSelectedGuild }) => T): T =>
    selector({ setSelectedGuild }),
}))

const documents: Record<string, { id: string; projectId?: string }> = {}
const setActiveCanvas = jest.fn()
jest.mock("@/stores/artifact/artifact-store", () => ({
  useArtifactStore: {
    getState: () => ({
      getCanvasDocumentForWorkspace: (id: string) => documents[id] ?? null,
      setActiveCanvas,
    }),
  },
}))

jest.mock("@cognia/logging", () => ({
  loggers: { canvas: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } },
}))

import CanvasJoinPage from "./page"

beforeEach(() => {
  push.mockClear()
  setActiveCanvas.mockClear()
  setSelectedGuild.mockClear()
  for (const key of Object.keys(documents)) delete documents[key]
})

function renderWith(search: string) {
  searchParams = new URLSearchParams(search)
  render(<CanvasJoinPage />)
}

describe("CanvasJoinPage", () => {
  it("opens a document this device has", async () => {
    documents["doc_1"] = { id: "doc_1", projectId: "ws_1" }
    renderWith("org=org_1&workspace=ws_1&document=doc_1")

    expect(await screen.findByTestId("canvas-join-open")).toBeInTheDocument()
    expect(screen.queryByTestId("canvas-join-error")).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId("canvas-join-open"))
    expect(setActiveCanvas).toHaveBeenCalledWith("doc_1")
    expect(setSelectedGuild).toHaveBeenCalledWith({ kind: "canvas" })
    expect(push).toHaveBeenCalledWith("/")
  })

  it("tells the user an old link is expired rather than showing a decode failure", async () => {
    // The old link carried a serialized session and, worse, a `?server=` URL
    // this page wrote into persisted settings with `enabled: true`.
    renderWith("session=eyJhIjoxfQ&server=ws://attacker.example/x")

    expect(await screen.findByTestId("canvas-join-error")).toHaveTextContent(/older version/i)
    expect(screen.queryByTestId("canvas-join-open")).not.toBeInTheDocument()
  })

  it("never opens Canvas for a link it could not honour", async () => {
    renderWith("session=eyJhIjoxfQ")
    await screen.findByTestId("canvas-join-error")
    expect(setSelectedGuild).not.toHaveBeenCalled()
    expect(setActiveCanvas).not.toHaveBeenCalled()
  })

  it("reports a malformed link", async () => {
    renderWith("org=org_1&workspace=ws_1")
    expect(await screen.findByTestId("canvas-join-error")).toHaveTextContent(/not a valid/i)
  })

  it("reports a bare visit with no link at all", async () => {
    renderWith("")
    expect(await screen.findByTestId("canvas-join-error")).toHaveTextContent(/does not name/i)
  })

  it("says so when the document is not on this device", async () => {
    // Reporting success and opening an empty document would be worse than
    // saying the document is not here.
    renderWith("org=org_1&workspace=ws_1&document=doc_missing")

    expect(await screen.findByTestId("canvas-join-error")).toHaveTextContent(/not on this device/i)
    expect(screen.queryByTestId("canvas-join-open")).not.toBeInTheDocument()
  })

  it("shows the document it is opening", async () => {
    documents["doc_1"] = { id: "doc_1", projectId: "ws_1" }
    renderWith("org=org_1&workspace=ws_1&document=doc_1")
    expect(await screen.findByText("doc_1")).toBeInTheDocument()
  })
})
