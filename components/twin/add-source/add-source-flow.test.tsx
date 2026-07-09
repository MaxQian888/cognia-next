/**
 * Flow-level coverage: pick type → input → review → commit, plus error
 * banners and the URL→Lark hand-off. The staging layer is mocked — its own
 * branches are covered in `lib/twin/ingest/stage.test.ts`.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { AddSourceFlow } from "./add-source-flow"

jest.mock("@/lib/twin/ingest/stage", () => ({
  stageFile: jest.fn(),
  stageUrl: jest.fn(),
  stageLarkDoc: jest.fn(),
  stageGitRepo: jest.fn(),
  stagePaste: jest.fn(),
  commitStagedSources: jest.fn(),
}))
jest.mock("@/lib/db/adapter-instances", () => ({
  listAdapterInstancesByType: jest.fn(async () => []),
}))
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

import {
  commitStagedSources,
  stagePaste,
  stageLarkDoc,
  type StagedSource,
} from "@/lib/twin/ingest/stage"
import { listAdapterInstancesByType } from "@/lib/db/adapter-instances"
import { toast } from "sonner"

const stagePasteMock = stagePaste as jest.Mock
const stageLarkMock = stageLarkDoc as jest.Mock
const commitMock = commitStagedSources as jest.Mock
const listAdaptersMock = listAdapterInstancesByType as jest.Mock

function staged(title: string): StagedSource {
  return {
    kind: "document",
    format: "markdown",
    title,
    text: "body",
    bytes: 4,
    origin: "paste",
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  listAdaptersMock.mockResolvedValue([])
})

describe("AddSourceFlow", () => {
  it("walks paste → review → commit and reports via toast", async () => {
    stagePasteMock.mockReturnValue({ staged: [staged("Snippet")] })
    commitMock.mockResolvedValue(1)
    const onAdded = jest.fn()
    render(<AddSourceFlow twinId="twin_a" onAdded={onAdded} />)

    fireEvent.click(screen.getByTestId("twin-add-source-type-paste"))
    fireEvent.change(screen.getByLabelText(/content/i), { target: { value: "note" } })
    fireEvent.click(screen.getByTestId("twin-add-source-paste-stage"))

    expect(await screen.findByTestId("twin-add-source-review")).toBeInTheDocument()
    expect(screen.getByText("Snippet")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("twin-add-source-confirm"))
    await waitFor(() => expect(commitMock).toHaveBeenCalledWith("twin_a", [expect.anything()]))
    expect(toast.success).toHaveBeenCalled()
    expect(onAdded).toHaveBeenCalledWith(1)
    // Flow resets to the type picker after a successful commit.
    expect(screen.getByTestId("twin-add-source-type-paste")).toBeInTheDocument()
  })

  it("shows a localized banner on staging errors and stays on the input", async () => {
    stagePasteMock.mockReturnValue({ staged: [], error: { code: "pasteContentRequired" } })
    render(<AddSourceFlow twinId="twin_a" />)

    fireEvent.click(screen.getByTestId("twin-add-source-type-paste"))
    fireEvent.click(screen.getByTestId("twin-add-source-paste-stage"))

    expect(await screen.findByTestId("twin-add-source-error")).toBeInTheDocument()
    expect(screen.getByTestId("twin-add-source-paste")).toBeInTheDocument()
  })

  it("navigates back from input to the type picker", () => {
    render(<AddSourceFlow twinId="twin_a" />)
    fireEvent.click(screen.getByTestId("twin-add-source-type-url"))
    expect(screen.getByTestId("twin-add-source-url")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("twin-add-source-back-to-pick"))
    expect(screen.getByTestId("twin-add-source-type-url")).toBeInTheDocument()
  })

  it("hands a Feishu URL off to the Lark input with the URL prefilled", async () => {
    render(<AddSourceFlow twinId="twin_a" />)
    fireEvent.click(screen.getByTestId("twin-add-source-type-url"))
    fireEvent.change(screen.getByLabelText(/url/i), {
      target: { value: "https://acme.feishu.cn/docx/doxcnAbCdEfGh1234567890" },
    })
    fireEvent.click(await screen.findByTestId("twin-add-source-url-switch-lark"))

    expect(screen.getByTestId("twin-add-source-lark")).toBeInTheDocument()
    expect(screen.getByLabelText(/doc link or token/i)).toHaveValue(
      "https://acme.feishu.cn/docx/doxcnAbCdEfGh1234567890"
    )
  })

  it("requires a bound account before fetching a Lark doc", async () => {
    render(<AddSourceFlow twinId="twin_a" />)
    fireEvent.click(screen.getByTestId("twin-add-source-type-lark"))
    await screen.findByTestId("twin-lark-picker-empty")

    fireEvent.change(screen.getByLabelText(/doc link or token/i), {
      target: { value: "doxcnAbCdEfGh1234567890" },
    })
    fireEvent.click(screen.getByTestId("twin-add-source-lark-fetch"))

    expect(await screen.findByTestId("twin-add-source-error")).toHaveTextContent(
      /No Feishu account/i
    )
    expect(stageLarkMock).not.toHaveBeenCalled()
  })

  it("fetches a Lark doc with the auto-selected account", async () => {
    listAdaptersMock.mockResolvedValue([
      { id: "cai_solo", type: "lark", displayName: "Acme", enabled: true, settings: {} },
    ])
    stageLarkMock.mockResolvedValue({ staged: [staged("飞书文档")] })
    render(<AddSourceFlow twinId="twin_a" />)

    fireEvent.click(screen.getByTestId("twin-add-source-type-lark"))
    await screen.findByTestId("twin-lark-picker")

    fireEvent.change(screen.getByLabelText(/doc link or token/i), {
      target: { value: "doxcnAbCdEfGh1234567890" },
    })
    fireEvent.click(screen.getByTestId("twin-add-source-lark-fetch"))

    await waitFor(() =>
      expect(stageLarkMock).toHaveBeenCalledWith("doxcnAbCdEfGh1234567890", {
        adapterId: "cai_solo",
      })
    )
    expect(await screen.findByTestId("twin-add-source-review")).toBeInTheDocument()
  })

  it("shows an error banner when the commit itself fails", async () => {
    stagePasteMock.mockReturnValue({ staged: [staged("Snippet")] })
    commitMock.mockRejectedValue(new Error("dexie down"))
    render(<AddSourceFlow twinId="twin_a" />)

    fireEvent.click(screen.getByTestId("twin-add-source-type-paste"))
    fireEvent.change(screen.getByLabelText(/content/i), { target: { value: "note" } })
    fireEvent.click(screen.getByTestId("twin-add-source-paste-stage"))
    fireEvent.click(await screen.findByTestId("twin-add-source-confirm"))

    expect(await screen.findByTestId("twin-add-source-error")).toBeInTheDocument()
    expect(toast.success).not.toHaveBeenCalled()
    // Still on review so the user can retry.
    expect(screen.getByTestId("twin-add-source-review")).toBeInTheDocument()
  })

  it("navigates back from review to the same input type", async () => {
    stagePasteMock.mockReturnValue({ staged: [staged("Snippet")] })
    render(<AddSourceFlow twinId="twin_a" />)

    fireEvent.click(screen.getByTestId("twin-add-source-type-paste"))
    fireEvent.change(screen.getByLabelText(/content/i), { target: { value: "note" } })
    fireEvent.click(screen.getByTestId("twin-add-source-paste-stage"))
    await screen.findByTestId("twin-add-source-review")

    fireEvent.click(screen.getByRole("button", { name: /back/i }))
    expect(screen.getByTestId("twin-add-source-paste")).toBeInTheDocument()
  })

  it("renders the file and git input panels", () => {
    render(<AddSourceFlow twinId="twin_a" />)
    fireEvent.click(screen.getByTestId("twin-add-source-type-file"))
    expect(screen.getByTestId("twin-add-source-file")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("twin-add-source-back-to-pick"))
    fireEvent.click(screen.getByTestId("twin-add-source-type-git"))
    expect(screen.getByTestId("twin-add-source-git")).toBeInTheDocument()
  })

  it("stringifies non-Error commit failures", async () => {
    stagePasteMock.mockReturnValue({ staged: [staged("Snippet")] })
    commitMock.mockRejectedValue("string failure")
    render(<AddSourceFlow twinId="twin_a" />)

    fireEvent.click(screen.getByTestId("twin-add-source-type-paste"))
    fireEvent.change(screen.getByLabelText(/content/i), { target: { value: "note" } })
    fireEvent.click(screen.getByTestId("twin-add-source-paste-stage"))
    fireEvent.click(await screen.findByTestId("twin-add-source-confirm"))

    expect(await screen.findByTestId("twin-add-source-error")).toBeInTheDocument()
  })

  it("disables the git type outside Tauri", () => {
    const { isTauri } = jest.requireMock("@/lib/tauri") as { isTauri: jest.Mock }
    isTauri.mockReturnValue(false)
    render(<AddSourceFlow twinId="twin_a" />)
    expect(screen.getByTestId("twin-add-source-type-git")).toBeDisabled()
    isTauri.mockReturnValue(true)
  })
})
