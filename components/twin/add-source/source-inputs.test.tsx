/**
 * Per-input coverage for the add-source panels. The staging layer is mocked
 * (covered in stage.test.ts); these tests verify each panel's wiring:
 * parameters passed, busy handling, error vs staged callbacks.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import {
  FileSourceInput,
  GitSourceInput,
  LarkSourceInput,
  PasteSourceInput,
  UrlSourceInput,
} from "./source-inputs"

jest.mock("@/lib/twin/ingest/stage", () => ({
  stageFile: jest.fn(),
  stageUrl: jest.fn(),
  stageLarkDoc: jest.fn(),
  stageGitRepo: jest.fn(),
  stagePaste: jest.fn(),
}))
jest.mock("@/lib/network/proxy-fetch", () => ({
  createProxyFetch: () => jest.fn(),
}))
jest.mock("@tauri-apps/plugin-dialog", () => ({
  open: jest.fn(),
}))
jest.mock("@/lib/db/adapter-instances", () => ({
  listAdapterInstancesByType: jest.fn(async () => [
    { id: "cai_solo", type: "lark", displayName: "Acme", enabled: true, settings: {} },
  ]),
}))
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))

import {
  stageFile,
  stageGitRepo,
  stageLarkDoc,
  stagePaste,
  stageUrl,
} from "@/lib/twin/ingest/stage"
import { open as tauriOpen } from "@tauri-apps/plugin-dialog"

const stageFileMock = stageFile as jest.Mock
const stageUrlMock = stageUrl as jest.Mock
const stageLarkMock = stageLarkDoc as jest.Mock
const stageGitMock = stageGitRepo as jest.Mock
const stagePasteMock = stagePaste as jest.Mock
const tauriOpenMock = tauriOpen as jest.Mock

const STAGED = {
  kind: "document",
  format: "markdown",
  title: "T",
  text: "body",
  bytes: 4,
  origin: "file",
}

function makeProps() {
  return {
    twinId: "twin_a",
    busy: false,
    setBusy: jest.fn(),
    onStaged: jest.fn(),
    onError: jest.fn(),
  }
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe("FileSourceInput", () => {
  it("stages every picked file and reports per-file notices", async () => {
    stageFileMock
      .mockResolvedValueOnce({ staged: [STAGED] })
      .mockResolvedValueOnce({ staged: [], error: { code: "unknownFileType" } })
    const props = makeProps()
    render(<FileSourceInput {...props} />)

    const input = screen.getByLabelText(/pick text files/i)
    await userEvent.upload(
      input,
      [
        new File(["a"], "a.md", { type: "text/plain" }),
        new File(["b"], "b.xyz", { type: "text/plain" }),
      ],
      { applyAccept: false }
    )

    await waitFor(() => expect(props.onStaged).toHaveBeenCalled())
    const [staged, notices] = props.onStaged.mock.calls[0]
    expect(staged).toHaveLength(1)
    expect(notices).toEqual([
      { filename: "a.md", staged: 1, error: undefined },
      { filename: "b.xyz", staged: 0, error: { code: "unknownFileType" } },
    ])
  })

  it("reports the first error when nothing staged", async () => {
    stageFileMock.mockResolvedValue({ staged: [], error: { code: "fileEmpty" } })
    const props = makeProps()
    render(<FileSourceInput {...props} />)
    await userEvent.upload(
      screen.getByLabelText(/pick text files/i),
      [new File(["x"], "e.md", { type: "text/plain" })],
      { applyAccept: false }
    )
    await waitFor(() => expect(props.onError).toHaveBeenCalledWith({ code: "fileEmpty" }))
    expect(props.onStaged).not.toHaveBeenCalled()
  })
})

describe("UrlSourceInput", () => {
  it("stages a URL with the Tauri proxy fetch and Jina fallback", async () => {
    stageUrlMock.mockResolvedValue({ staged: [STAGED] })
    const props = makeProps()
    render(<UrlSourceInput {...props} />)

    fireEvent.change(screen.getByLabelText(/url/i), {
      target: { value: "https://example.com/a" },
    })
    fireEvent.click(screen.getByTestId("twin-add-source-url-fetch"))

    await waitFor(() =>
      expect(stageUrlMock).toHaveBeenCalledWith(
        "https://example.com/a",
        expect.objectContaining({ jinaFallback: true, fetchImpl: expect.any(Function) })
      )
    )
    expect(props.onStaged).toHaveBeenCalledWith([STAGED])
  })

  it("surfaces staging errors", async () => {
    stageUrlMock.mockResolvedValue({ staged: [], error: { code: "urlInvalid" } })
    const props = makeProps()
    render(<UrlSourceInput {...props} />)
    fireEvent.click(screen.getByTestId("twin-add-source-url-fetch"))
    await waitFor(() => expect(props.onError).toHaveBeenCalledWith({ code: "urlInvalid" }))
  })

  it("blocks direct fetch for Feishu links and offers the Lark hand-off", async () => {
    const props = makeProps()
    const onSwitchToLark = jest.fn()
    render(<UrlSourceInput {...props} onSwitchToLark={onSwitchToLark} />)

    fireEvent.change(screen.getByLabelText(/url/i), {
      target: { value: "https://acme.feishu.cn/wiki/wikcnAbCdEfGh123456789" },
    })
    expect(screen.getByTestId("twin-add-source-url-fetch")).toBeDisabled()
    fireEvent.click(screen.getByTestId("twin-add-source-url-switch-lark"))
    expect(onSwitchToLark).toHaveBeenCalledWith(
      "https://acme.feishu.cn/wiki/wikcnAbCdEfGh123456789"
    )
  })
})

describe("LarkSourceInput", () => {
  it("prefills the URL and stages with the chosen account", async () => {
    stageLarkMock.mockResolvedValue({ staged: [STAGED] })
    const props = makeProps()
    render(<LarkSourceInput {...props} initialUrl="doxcnAbCdEfGh1234567890" />)
    await screen.findByTestId("twin-lark-picker")

    expect(screen.getByLabelText(/doc link or token/i)).toHaveValue("doxcnAbCdEfGh1234567890")
    fireEvent.click(screen.getByTestId("twin-add-source-lark-fetch"))

    await waitFor(() =>
      expect(stageLarkMock).toHaveBeenCalledWith("doxcnAbCdEfGh1234567890", {
        adapterId: "cai_solo",
      })
    )
    expect(props.onStaged).toHaveBeenCalledWith([STAGED])
  })

  it("shows the browser hint outside Tauri", async () => {
    const { isTauri } = jest.requireMock("@/lib/tauri") as { isTauri: jest.Mock }
    isTauri.mockReturnValue(false)
    render(<LarkSourceInput {...makeProps()} />)
    expect(screen.getByTestId("twin-add-source-lark-browser-hint")).toBeInTheDocument()
    isTauri.mockReturnValue(true)
  })
})

describe("PasteSourceInput", () => {
  it("stages the pasted content with title and format", () => {
    stagePasteMock.mockReturnValue({ staged: [STAGED] })
    const props = makeProps()
    render(<PasteSourceInput {...props} />)

    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "Note" } })
    fireEvent.change(screen.getByLabelText(/content/i), { target: { value: "text body" } })
    fireEvent.click(screen.getByTestId("twin-add-source-paste-stage"))

    expect(stagePasteMock).toHaveBeenCalledWith({
      content: "text body",
      format: "markdown",
      title: "Note",
    })
    expect(props.onStaged).toHaveBeenCalledWith([STAGED])
  })
})

describe("GitSourceInput", () => {
  it("walks the picked repo with maxCommits and author", async () => {
    tauriOpenMock.mockResolvedValue("/repo/path")
    stageGitMock.mockResolvedValue({ staged: [STAGED] })
    const props = makeProps()
    render(<GitSourceInput {...props} />)

    fireEvent.change(screen.getByLabelText(/max commits/i), { target: { value: "50" } })
    fireEvent.change(screen.getByLabelText(/author/i), { target: { value: "max" } })
    fireEvent.click(screen.getByTestId("twin-add-source-git-pick"))

    await waitFor(() =>
      expect(stageGitMock).toHaveBeenCalledWith({
        twinId: "twin_a",
        repoPath: "/repo/path",
        maxCommits: 50,
        author: "max",
      })
    )
    expect(props.onStaged).toHaveBeenCalledWith([STAGED])
  })

  it("does nothing when the picker is cancelled", async () => {
    tauriOpenMock.mockResolvedValue(null)
    const props = makeProps()
    render(<GitSourceInput {...props} />)
    fireEvent.click(screen.getByTestId("twin-add-source-git-pick"))
    await waitFor(() => expect(props.setBusy).toHaveBeenLastCalledWith(false))
    expect(stageGitMock).not.toHaveBeenCalled()
    expect(props.onError).not.toHaveBeenCalled()
  })
})
