/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => jest.requireActual("./test-intl").echoTranslations(),
}))
jest.mock("@/lib/files/download", () => ({
  downloadFile: jest.fn(async () => ({ kind: "downloaded" })),
}))
jest.mock("@/lib/tauri/clipboard", () => ({ writeClipboardText: jest.fn(async () => {}) }))

import { act, fireEvent, render, screen } from "@testing-library/react"

import { downloadFile } from "@/lib/files/download"
import { writeClipboardText } from "@/lib/tauri/clipboard"

import { RecoveryKeySetup } from "./recovery-key-setup"

const KEY = "0123-4567-89AB-CDEF-GHJK-MNPQ-RW"
const POSITIONS = [0, 4, 10, 25]
// Characters without hyphens: 0123456789ABCDEFGHJKMNPQRW
const ANSWERS = ["0", "4", "a", "w"]

function setup() {
  const onConfirmed = jest.fn()
  const onCancel = jest.fn()
  render(
    <RecoveryKeySetup
      recoveryKeyText={KEY}
      account="ada@example.com"
      positions={POSITIONS}
      onConfirmed={onConfirmed}
      onCancel={onCancel}
    />
  )
  return { onConfirmed, onCancel }
}

describe("RecoveryKeySetup", () => {
  it("shows the key and asks for the characters at the given positions", () => {
    setup()
    expect(screen.getByTestId("recovery-key-text")).toHaveTextContent(KEY)
    expect(screen.getByText("confirmPositions(1, 5, 11, 26)")).toBeInTheDocument()
    expect(screen.getByLabelText("characterLabel(26)")).toBeInTheDocument()
  })

  it("continues once the typed characters match", () => {
    const { onConfirmed } = setup()
    ANSWERS.forEach((answer, index) =>
      fireEvent.change(screen.getByTestId(`recovery-key-char-${index}`), {
        target: { value: answer },
      })
    )
    fireEvent.click(screen.getByTestId("recovery-key-continue"))
    expect(onConfirmed).toHaveBeenCalled()
  })

  it("refuses wrong characters", () => {
    const { onConfirmed } = setup()
    fireEvent.change(screen.getByTestId("recovery-key-char-0"), { target: { value: "9" } })
    fireEvent.click(screen.getByTestId("recovery-key-continue"))
    expect(onConfirmed).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent("wrong")
  })

  it("accepts a downloaded kit the person says they stored", async () => {
    const { onConfirmed } = setup()
    const acknowledge = screen.getByTestId("recovery-key-acknowledge")
    expect(acknowledge).toBeDisabled()
    await act(async () => {
      fireEvent.click(screen.getByTestId("recovery-key-download"))
    })
    const [fileName, contents] = jest.mocked(downloadFile).mock.calls[0]!
    expect(fileName).toMatch(/^cognia-sync-recovery-key-\d{4}-\d{2}-\d{2}\.txt$/)
    expect(contents).toContain(KEY)
    expect(contents).toContain("ada@example.com")
    expect(acknowledge).not.toBeDisabled()
    fireEvent.click(acknowledge)
    fireEvent.click(screen.getByTestId("recovery-key-continue"))
    expect(onConfirmed).toHaveBeenCalled()
  })

  it("copies the key and cancels", async () => {
    const { onCancel } = setup()
    await act(async () => {
      fireEvent.click(screen.getByTestId("recovery-key-copy"))
    })
    expect(writeClipboardText).toHaveBeenCalledWith(KEY)
    expect(screen.getByTestId("recovery-key-copy")).toHaveTextContent("copied")
    fireEvent.click(screen.getByTestId("recovery-key-cancel"))
    expect(onCancel).toHaveBeenCalled()
  })
})
