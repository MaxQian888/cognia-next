/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}))

jest.mock("sonner", () => ({
  toast: { error: jest.fn() },
}))

// Stub the crop/zoom dialog so these tests stay focused on the picker's own
// job: validate the picked file and hand it to the editor. The dialog renders
// only when `file` is non-null and exposes confirm/cancel hooks.
jest.mock("./avatar-edit-dialog", () => ({
  AvatarEditDialog: ({
    file,
    onCancel,
    onConfirm,
  }: {
    file: File | null
    onCancel: () => void
    onConfirm: (dataUrl: string) => void | Promise<void>
  }) =>
    file ? (
      <div data-testid="mock-edit-dialog">
        <span data-testid="mock-edit-file">{file.name}</span>
        <button
          data-testid="mock-edit-confirm"
          onClick={() => void onConfirm("data:image/webp;base64,XX")}
        >
          confirm
        </button>
        <button data-testid="mock-edit-cancel" onClick={onCancel}>
          cancel
        </button>
      </div>
    ) : null,
}))

import { toast } from "sonner"

import { ProfileAvatarPicker } from "./profile-avatar-picker"

const mockToastError = (toast as unknown as { error: jest.Mock }).error

beforeEach(() => {
  jest.clearAllMocks()
})

const pickFile = async (file: File) => {
  const input = screen.getByTestId("profile-avatar-input") as HTMLInputElement
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } })
  })
}

describe("ProfileAvatarPicker", () => {
  it("opens the edit dialog for a valid image", async () => {
    render(<ProfileAvatarPicker value={null} fallbackName="Max" onChange={() => {}} />)
    await pickFile(new File([new Uint8Array([1])], "a.png", { type: "image/png" }))
    expect(screen.getByTestId("mock-edit-dialog")).toBeInTheDocument()
    expect(screen.getByTestId("mock-edit-file")).toHaveTextContent("a.png")
  })

  it("rejects unsupported mime types with a toast and no dialog", async () => {
    render(<ProfileAvatarPicker value={null} fallbackName="Max" onChange={() => {}} />)
    await pickFile(new File([new Uint8Array([1])], "a.svg", { type: "image/svg+xml" }))
    expect(screen.queryByTestId("mock-edit-dialog")).not.toBeInTheDocument()
    expect(mockToastError).toHaveBeenCalledWith("avatarInvalidType")
  })

  it("persists the cropped data URL and closes the dialog on confirm", async () => {
    const onChange = jest.fn().mockResolvedValue(undefined)
    render(<ProfileAvatarPicker value={null} fallbackName="Max" onChange={onChange} />)
    await pickFile(new File([new Uint8Array([1])], "a.png", { type: "image/png" }))
    await act(async () => {
      fireEvent.click(screen.getByTestId("mock-edit-confirm"))
    })
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("data:image/webp;base64,XX"))
    await waitFor(() => expect(screen.queryByTestId("mock-edit-dialog")).not.toBeInTheDocument())
  })

  it("closes the dialog without saving on cancel", async () => {
    const onChange = jest.fn()
    render(<ProfileAvatarPicker value={null} fallbackName="Max" onChange={onChange} />)
    await pickFile(new File([new Uint8Array([1])], "a.png", { type: "image/png" }))
    await act(async () => {
      fireEvent.click(screen.getByTestId("mock-edit-cancel"))
    })
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.queryByTestId("mock-edit-dialog")).not.toBeInTheDocument()
  })

  it("opens the file picker from the upload button", () => {
    render(<ProfileAvatarPicker value={null} fallbackName="Max" onChange={() => {}} />)
    const input = screen.getByTestId("profile-avatar-input") as HTMLInputElement
    const clickSpy = jest.spyOn(input, "click").mockImplementation(() => {})
    fireEvent.click(screen.getByTestId("profile-avatar-upload"))
    expect(clickSpy).toHaveBeenCalled()
  })

  it("shows the clear button only when an avatar is set, and clears with null", () => {
    const onChange = jest.fn()
    const { rerender } = render(
      <ProfileAvatarPicker value={null} fallbackName="Max" onChange={onChange} />
    )
    expect(screen.queryByTestId("profile-avatar-clear")).not.toBeInTheDocument()

    rerender(
      <ProfileAvatarPicker
        value="data:image/webp;base64,AA"
        fallbackName="Max"
        onChange={onChange}
      />
    )
    fireEvent.click(screen.getByTestId("profile-avatar-clear"))
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it("disables the buttons when disabled", () => {
    render(
      <ProfileAvatarPicker
        value="data:image/webp;base64,AA"
        fallbackName="Max"
        onChange={() => {}}
        disabled
      />
    )
    expect(screen.getByTestId("profile-avatar-upload")).toBeDisabled()
    expect(screen.getByTestId("profile-avatar-clear")).toBeDisabled()
  })

  it("disables the buttons while the edit dialog is open", async () => {
    render(<ProfileAvatarPicker value={null} fallbackName="Max" onChange={() => {}} />)
    await pickFile(new File([new Uint8Array([1])], "a.png", { type: "image/png" }))
    expect(screen.getByTestId("profile-avatar-upload")).toBeDisabled()
  })

  it("renders the avatar image when a value is present", () => {
    render(
      <ProfileAvatarPicker
        value="data:image/webp;base64,AA"
        fallbackName="Max"
        onChange={() => {}}
      />
    )
    const img = document.querySelector("img")
    expect(img).not.toBeNull()
    expect(img!.getAttribute("src")).toBe("data:image/webp;base64,AA")
  })
})
