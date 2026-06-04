/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (k: string, _params?: Record<string, unknown>) => k
    return t
  },
}))

jest.mock("@/lib/profile/use-user-profile", () => ({
  useUserProfile: jest.fn(),
}))

jest.mock("./profile-avatar-picker", () => ({
  ProfileAvatarPicker: ({
    value,
    onChange,
  }: {
    value: string | null
    onChange: (v: string | null) => void
  }) => (
    <div data-testid="picker-stub" data-value={value ?? ""}>
      <button data-testid="picker-set" onClick={() => onChange("data:image/webp;base64,BB")} />
      <button data-testid="picker-clear" onClick={() => onChange(null)} />
    </div>
  ),
}))

import { useUserProfile } from "@/lib/profile/use-user-profile"

import { BIO_MAX, DISPLAY_NAME_MAX, ProfileSection } from "./profile-section"

const mockUseUserProfile = useUserProfile as jest.Mock

const baseResult = (overrides: Partial<ReturnType<typeof buildResult>> = {}) =>
  buildResult(overrides)

function buildResult(overrides: Record<string, unknown> = {}) {
  return {
    profile: {},
    loaded: true,
    resolvedDisplayName: null,
    resolvedAvatarUrl: null,
    email: "",
    credentialLoading: false,
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockUseUserProfile.mockReturnValue(baseResult())
})

describe("ProfileSection", () => {
  it("shows a skeleton until settings hydrate", () => {
    mockUseUserProfile.mockReturnValue(baseResult({ loaded: false }))
    render(<ProfileSection />)
    expect(screen.getByTestId("profile-section-skeleton")).toBeInTheDocument()
    expect(screen.queryByTestId("profile-display-name")).not.toBeInTheDocument()
  })

  it("renders stored values and the read-only email line", () => {
    mockUseUserProfile.mockReturnValue(
      baseResult({
        profile: { displayName: "Max", bio: "hello" },
        resolvedDisplayName: "Max",
        email: "max@example.com",
      })
    )
    render(<ProfileSection />)
    expect(screen.getByTestId("profile-display-name")).toHaveValue("Max")
    expect(screen.getByTestId("profile-bio")).toHaveValue("hello")
    expect(screen.getByTestId("profile-email")).toBeInTheDocument()
  })

  it("hides the email line when signed out", () => {
    render(<ProfileSection />)
    expect(screen.queryByTestId("profile-email")).not.toBeInTheDocument()
  })

  it("saves the trimmed display name on blur when changed", () => {
    const result = baseResult({ profile: { displayName: "Old" } })
    mockUseUserProfile.mockReturnValue(result)
    render(<ProfileSection />)
    const input = screen.getByTestId("profile-display-name")
    fireEvent.change(input, { target: { value: "  New Name  " } })
    fireEvent.blur(input)
    expect(result.save).toHaveBeenCalledWith({ displayName: "New Name" })
  })

  it("does not save when the display name is unchanged", () => {
    const result = baseResult({ profile: { displayName: "Same" } })
    mockUseUserProfile.mockReturnValue(result)
    render(<ProfileSection />)
    const input = screen.getByTestId("profile-display-name")
    fireEvent.change(input, { target: { value: "Same" } })
    fireEvent.blur(input)
    expect(result.save).not.toHaveBeenCalled()
  })

  it("does not save on blur without an edit", () => {
    const result = baseResult()
    mockUseUserProfile.mockReturnValue(result)
    render(<ProfileSection />)
    fireEvent.blur(screen.getByTestId("profile-display-name"))
    expect(result.save).not.toHaveBeenCalled()
  })

  it("caps the committed display name at DISPLAY_NAME_MAX", () => {
    const result = baseResult()
    mockUseUserProfile.mockReturnValue(result)
    render(<ProfileSection />)
    const input = screen.getByTestId("profile-display-name")
    const long = "x".repeat(DISPLAY_NAME_MAX + 20)
    fireEvent.change(input, { target: { value: long } })
    fireEvent.blur(input)
    expect(result.save).toHaveBeenCalledWith({ displayName: "x".repeat(DISPLAY_NAME_MAX) })
  })

  it("saves the bio on blur and caps it at BIO_MAX", () => {
    const result = baseResult()
    mockUseUserProfile.mockReturnValue(result)
    render(<ProfileSection />)
    const textarea = screen.getByTestId("profile-bio")
    const long = "b".repeat(BIO_MAX + 50)
    fireEvent.change(textarea, { target: { value: long } })
    fireEvent.blur(textarea)
    expect(result.save).toHaveBeenCalledWith({ bio: "b".repeat(BIO_MAX) })
  })

  it("updates the bio counter while typing", () => {
    render(<ProfileSection />)
    fireEvent.change(screen.getByTestId("profile-bio"), { target: { value: "abc" } })
    expect(screen.getByTestId("profile-bio-counter")).toBeInTheDocument()
  })

  it("persists avatar changes from the picker", () => {
    const result = baseResult()
    mockUseUserProfile.mockReturnValue(result)
    render(<ProfileSection />)
    fireEvent.click(screen.getByTestId("picker-set"))
    expect(result.save).toHaveBeenCalledWith({ avatarDataUrl: "data:image/webp;base64,BB" })
    fireEvent.click(screen.getByTestId("picker-clear"))
    expect(result.save).toHaveBeenCalledWith({ avatarDataUrl: "" })
  })

  it("shows the reset button only when a profile exists and clears everything", () => {
    const result = baseResult({ profile: { displayName: "Max" } })
    mockUseUserProfile.mockReturnValue(result)
    render(<ProfileSection />)
    fireEvent.click(screen.getByTestId("profile-reset"))
    expect(result.save).toHaveBeenCalledWith({ displayName: "", bio: "", avatarDataUrl: "" })
  })

  it("hides the reset button for an empty profile", () => {
    render(<ProfileSection />)
    expect(screen.queryByTestId("profile-reset")).not.toBeInTheDocument()
  })
})
