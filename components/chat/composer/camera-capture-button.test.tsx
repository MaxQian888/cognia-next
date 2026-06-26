/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { CameraCaptureButton } from "./camera-capture-button"

// next-intl is mocked globally in jest.setup (loads real en messages).

const addMock = jest.fn()
jest.mock("@/components/ai-elements/prompt-input", () => ({
  usePromptInputAttachments: () => ({ add: addMock }),
}))

const pickPhotoMock = jest.fn()
jest.mock("@/lib/capacitor/camera", () => ({
  pickPhoto: (...a: unknown[]) => pickPhotoMock(...a),
}))

const toastError = jest.fn()
jest.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }))

// Keep the Radix tooltip out of the picture — render a plain button.
jest.mock("@/components/chat/ui/tooltip-icon-button", () => ({
  TooltipIconButton: ({
    children,
    onClick,
    ...rest
  }: {
    children: React.ReactNode
    onClick?: () => void
    "aria-label"?: string
  }) => (
    <button type="button" aria-label={rest["aria-label"]} onClick={onClick}>
      {children}
    </button>
  ),
}))

beforeEach(() => {
  addMock.mockClear()
  pickPhotoMock.mockReset()
  toastError.mockClear()
  global.fetch = jest.fn(async () => ({
    blob: async () => new Blob(["x"], { type: "image/jpeg" }),
  })) as unknown as typeof fetch
})

describe("<CameraCaptureButton />", () => {
  it("attaches a captured photo as an image File", async () => {
    pickPhotoMock.mockResolvedValue({
      kind: "captured",
      dataUrl: "data:image/jpeg;base64,xxx",
      format: "jpeg",
    })
    const user = userEvent.setup()
    render(<CameraCaptureButton />)
    await user.click(screen.getByRole("button"))
    await waitFor(() => expect(addMock).toHaveBeenCalledTimes(1))
    const file = addMock.mock.calls[0][0][0] as File
    expect(file).toBeInstanceOf(File)
    expect(file.type).toMatch(/^image\//)
    expect(toastError).not.toHaveBeenCalled()
  })

  it("toasts and does not attach when permission is denied", async () => {
    pickPhotoMock.mockResolvedValue({ kind: "permission_denied" })
    const user = userEvent.setup()
    render(<CameraCaptureButton />)
    await user.click(screen.getByRole("button"))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(addMock).not.toHaveBeenCalled()
  })

  it("is a no-op when the capture is cancelled", async () => {
    pickPhotoMock.mockResolvedValue({ kind: "cancelled" })
    const user = userEvent.setup()
    render(<CameraCaptureButton />)
    await user.click(screen.getByRole("button"))
    await waitFor(() => expect(pickPhotoMock).toHaveBeenCalled())
    expect(addMock).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
  })

  it("toasts on a capture error", async () => {
    pickPhotoMock.mockResolvedValue({ kind: "error", message: "boom" })
    const user = userEvent.setup()
    render(<CameraCaptureButton />)
    await user.click(screen.getByRole("button"))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(addMock).not.toHaveBeenCalled()
  })
})
