import { render, screen, fireEvent } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => true),
}))

const mockTrigger = jest.fn(async () => undefined)
jest.mock("@/components/plugins/dialogs/load-unpacked-button", () => ({
  useLoadUnpackedFlow: () => ({
    trigger: mockTrigger,
    busy: false,
    error: null,
    dialog: null,
  }),
}))

import { isTauri } from "@/lib/tauri"
import { LocalPluginDropzone } from "./local-plugin-dropzone"

const mockIsTauri = isTauri as jest.MockedFunction<typeof isTauri>

function renderWithIntl(node: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {node}
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  mockTrigger.mockClear()
  mockIsTauri.mockReset()
  mockIsTauri.mockReturnValue(true)
})

describe("LocalPluginDropzone", () => {
  it("renders the dropzone with localized title + hint in Tauri", () => {
    renderWithIntl(<LocalPluginDropzone />)
    expect(screen.getByTestId("local-plugin-dropzone")).toBeInTheDocument()
    expect(screen.getByText(enMessages.plugins.devtools.dropzone.title)).toBeInTheDocument()
  })

  it("renders nothing on web / Capacitor (no disk-path access)", () => {
    mockIsTauri.mockReturnValue(false)
    const { container } = renderWithIntl(<LocalPluginDropzone />)
    expect(container.firstChild).toBeNull()
  })

  it("triggers the load-unpacked flow on click", () => {
    renderWithIntl(<LocalPluginDropzone />)
    fireEvent.click(screen.getByTestId("local-plugin-dropzone"))
    expect(mockTrigger).toHaveBeenCalledTimes(1)
  })

  it("triggers the load-unpacked flow on Enter keydown", () => {
    renderWithIntl(<LocalPluginDropzone />)
    fireEvent.keyDown(screen.getByTestId("local-plugin-dropzone"), { key: "Enter" })
    expect(mockTrigger).toHaveBeenCalledTimes(1)
  })

  it("triggers the flow on drop when files are present", () => {
    renderWithIntl(<LocalPluginDropzone />)
    const zone = screen.getByTestId("local-plugin-dropzone")
    const file = new File(["x"], "plugin.json", { type: "application/json" })
    fireEvent.drop(zone, { dataTransfer: { files: [file] } })
    expect(mockTrigger).toHaveBeenCalledTimes(1)
  })

  it("passes the Tauri-provided dropped directory path to the install flow", () => {
    renderWithIntl(<LocalPluginDropzone />)
    const zone = screen.getByTestId("local-plugin-dropzone")
    const file = new File(["x"], "plugin.json") as File & { path?: string }
    file.path = "/plugins/demo"
    fireEvent.drop(zone, { dataTransfer: { files: [file] } })
    expect(mockTrigger).toHaveBeenCalledWith("/plugins/demo")
  })

  it("does not trigger on an empty drop", () => {
    renderWithIntl(<LocalPluginDropzone />)
    const zone = screen.getByTestId("local-plugin-dropzone")
    fireEvent.drop(zone, { dataTransfer: { files: [] } })
    expect(mockTrigger).not.toHaveBeenCalled()
  })

  it("highlights on drag over and clears on drag leave", () => {
    renderWithIntl(<LocalPluginDropzone />)
    const zone = screen.getByTestId("local-plugin-dropzone")
    fireEvent.dragOver(zone)
    expect(zone.className).toContain("border-primary")
    fireEvent.dragLeave(zone)
    expect(zone.className).not.toContain("border-primary")
  })
})
