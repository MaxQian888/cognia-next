import { act, renderHook, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${JSON.stringify(values)}` : key,
}))
jest.mock("sonner", () => ({ toast: { info: jest.fn(), error: jest.fn() } }))
jest.mock("@/lib/browser/local-client", () => ({
  localBrowser: {
    onEvent: jest.fn(),
    stageUpload: jest.fn(),
    answerFileChooser: jest.fn(),
  },
}))

import { toast } from "sonner"

import { localBrowser } from "@/lib/browser/local-client"

import { asFileChooserOpened, useLocalFileChooser } from "./use-local-file-chooser"

const onEvent = localBrowser.onEvent as jest.Mock
const stageUpload = localBrowser.stageUpload as jest.Mock
const answerFileChooser = localBrowser.answerFileChooser as jest.Mock

let emit: (event: unknown) => void = () => undefined
const unlisten = jest.fn()

function opened(overrides: Record<string, unknown> = {}) {
  return {
    type: "filechooser.opened",
    sessionId: "s1",
    pageId: "p1",
    chooserId: "c1",
    multiple: false,
    ...overrides,
  }
}

async function mount(sessionId: string | null = "s1") {
  const hook = renderHook(() => useLocalFileChooser(sessionId))
  if (sessionId) await waitFor(() => expect(onEvent).toHaveBeenCalled())
  return hook
}

beforeEach(() => {
  jest.clearAllMocks()
  onEvent.mockImplementation(async (callback: (event: unknown) => void) => {
    emit = callback
    return unlisten
  })
  stageUpload.mockResolvedValue(["/app/browser/uploads/x/cv.pdf"])
  answerFileChooser.mockResolvedValue({ ok: true, cancelled: false })
})

describe("asFileChooserOpened", () => {
  it("accepts only well-formed filechooser.opened events", () => {
    expect(asFileChooserOpened(opened())).toEqual(opened())
    expect(asFileChooserOpened(opened({ multiple: "yes" }))?.multiple).toBe(false)
    expect(asFileChooserOpened(opened({ type: "dialog.opened" }))).toBeNull()
    expect(asFileChooserOpened(opened({ chooserId: "" }))).toBeNull()
    expect(asFileChooserOpened(opened({ sessionId: 1 }))).toBeNull()
    expect(asFileChooserOpened(null)).toBeNull()
  })
})

it("stages the user's pick and answers the chooser with the staged paths", async () => {
  await mount()
  await act(async () => emit(opened()))
  await waitFor(() =>
    expect(answerFileChooser).toHaveBeenCalledWith("s1", "c1", ["/app/browser/uploads/x/cv.pdf"])
  )
  expect(stageUpload).toHaveBeenCalledTimes(1)
  expect(toast.error).not.toHaveBeenCalled()
})

it("passes every staged file to a multiple chooser", async () => {
  stageUpload.mockResolvedValue(["/u/a/1.png", "/u/b/2.png"])
  await mount()
  await act(async () => emit(opened({ multiple: true })))
  await waitFor(() =>
    expect(answerFileChooser).toHaveBeenCalledWith("s1", "c1", ["/u/a/1.png", "/u/b/2.png"])
  )
  expect(toast.info).not.toHaveBeenCalled()
})

it("keeps only the first file for a single-file chooser and says so", async () => {
  stageUpload.mockResolvedValue(["/u/a/1.png", "/u/b/2.png"])
  await mount()
  await act(async () => emit(opened()))
  await waitFor(() => expect(answerFileChooser).toHaveBeenCalledWith("s1", "c1", ["/u/a/1.png"]))
  expect(toast.info).toHaveBeenCalledWith('singleFile {"name":"1.png"}')
})

it("cancels the chooser when the picker is cancelled", async () => {
  stageUpload.mockResolvedValue([])
  await mount()
  await act(async () => emit(opened()))
  await waitFor(() => expect(answerFileChooser).toHaveBeenCalledWith("s1", "c1", []))
  expect(toast.error).not.toHaveBeenCalled()
})

it("reports a failed staging and still cancels the chooser", async () => {
  stageUpload.mockRejectedValue("browser_upload_invalid: big.iso is larger than 100 MB")
  await mount()
  await act(async () => emit(opened()))
  await waitFor(() => expect(answerFileChooser).toHaveBeenCalledWith("s1", "c1", []))
  expect(toast.error).toHaveBeenCalledWith(
    'failed {"message":"browser_upload_invalid: big.iso is larger than 100 MB"}'
  )
})

it("reports a refused answer but not a chooser that is already gone", async () => {
  answerFileChooser.mockRejectedValueOnce(new Error("browser_upload_path_denied: outside"))
  await mount()
  await act(async () => emit(opened()))
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith(
      'failed {"message":"browser_upload_path_denied: outside"}'
    )
  )
  answerFileChooser.mockRejectedValueOnce({ message: "browser_file_chooser_not_found: gone" })
  await act(async () => emit(opened({ chooserId: "c2" })))
  await waitFor(() => expect(answerFileChooser).toHaveBeenCalledTimes(2))
  expect(toast.error).toHaveBeenCalledTimes(1)
})

it("answers choosers one at a time, in order", async () => {
  let release: (paths: string[]) => void = () => undefined
  stageUpload.mockImplementationOnce(
    () =>
      new Promise<string[]>((resolve) => {
        release = resolve
      })
  )
  await mount()
  await act(async () => {
    emit(opened())
    emit(opened({ chooserId: "c2" }))
  })
  expect(stageUpload).toHaveBeenCalledTimes(1)
  await act(async () => release(["/u/a"]))
  await waitFor(() => expect(answerFileChooser).toHaveBeenCalledTimes(2))
  expect(answerFileChooser.mock.calls.map((call) => call[1])).toEqual(["c1", "c2"])
})

it("ignores other sessions and does nothing without a session", async () => {
  const { unmount } = await mount()
  await act(async () => emit(opened({ sessionId: "other" })))
  expect(stageUpload).not.toHaveBeenCalled()
  unmount()
  expect(unlisten).toHaveBeenCalled()

  onEvent.mockClear()
  await mount(null)
  expect(onEvent).not.toHaveBeenCalled()
})
