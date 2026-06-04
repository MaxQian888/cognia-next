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

jest.mock("@/lib/profile/avatar-image", () => {
  const actual = jest.requireActual("@/lib/profile/avatar-image")
  return {
    ...actual,
    downscaleToDataUrl: jest.fn(),
  }
})

import { toast } from "sonner"
import { downscaleToDataUrl } from "@/lib/profile/avatar-image"

import { ProfileAvatarPicker } from "./profile-avatar-picker"

const mockDownscale = downscaleToDataUrl as jest.Mock
const mockToastError = (toast as unknown as { error: jest.Mock }).error

beforeEach(() => {
  jest.clearAllMocks()
  mockDownscale.mockResolvedValue("data:image/webp;base64,AA")
})

const pickFile = async (file: File) => {
  const input = screen.getByTestId("profile-avatar-input") as HTMLInputElement
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } })
  })
}

describe("ProfileAvatarPicker", () => {
  it("processes a valid image through the downscale pipeline", async () => {
    const onChange = jest.fn()
    render(<ProfileAvatarPicker value={null} fallbackName="Max" onChange={onChange} />)
    await pickFile(new File([new Uint8Array([1])], "a.png", { type: "image/png" }))
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("data:image/webp;base64,AA"))
    expect(mockDownscale).toHaveBeenCalledTimes(1)
  })

  it("rejects unsupported mime types with a toast and no onChange", async () => {
    const onChange = jest.fn()
    render(<ProfileAvatarPicker value={null} fallbackName="Max" onChange={onChange} />)
    await pickFile(new File([new Uint8Array([1])], "a.svg", { type: "image/svg+xml" }))
    expect(onChange).not.toHaveBeenCalled()
    expect(mockToastError).toHaveBeenCalledWith("avatarInvalidType")
    expect(mockDownscale).not.toHaveBeenCalled()
  })

  it("toasts when the downscale pipeline fails", async () => {
    mockDownscale.mockRejectedValueOnce(new Error("avatar image too large after downscale"))
    const onChange = jest.fn()
    render(<ProfileAvatarPicker value={null} fallbackName="Max" onChange={onChange} />)
    await pickFile(new File([new Uint8Array([1])], "a.png", { type: "image/png" }))
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("avatarProcessFailed"))
    expect(onChange).not.toHaveBeenCalled()
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
