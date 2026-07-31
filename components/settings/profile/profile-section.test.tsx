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

// The real TimezoneSelect wraps a Radix Select (awkward to drive in jsdom);
// stub it to a button that fires onValueChange with a known zone.
jest.mock("@/components/scheduler/timezone-select", () => ({
  TimezoneSelect: ({
    value,
    onValueChange,
    testId,
  }: {
    value?: string
    onValueChange: (v: string) => void
    testId?: string
  }) => (
    <button
      data-testid={testId}
      data-value={value ?? ""}
      onClick={() => onValueChange("Asia/Tokyo")}
    />
  ),
}))

import { useUserProfile } from "@/lib/profile/use-user-profile"

import {
  BIO_MAX,
  DISPLAY_NAME_MAX,
  PRONOUNS_MAX,
  STATUS_MAX,
  ProfileSection,
} from "./profile-section"

const mockUseUserProfile = useUserProfile as jest.Mock

const baseResult = (overrides: Partial<ReturnType<typeof buildResult>> = {}) =>
  buildResult(overrides)

function buildResult(overrides: Record<string, unknown> = {}) {
  return {
    profile: {},
    loaded: true,
    resolvedDisplayName: null as string | null,
    resolvedAvatarUrl: null as string | null,
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

  it("saves pronouns on blur, capped at PRONOUNS_MAX", () => {
    const result = baseResult()
    mockUseUserProfile.mockReturnValue(result)
    render(<ProfileSection />)
    const input = screen.getByTestId("profile-pronouns")
    fireEvent.change(input, { target: { value: "p".repeat(PRONOUNS_MAX + 5) } })
    fireEvent.blur(input)
    expect(result.save).toHaveBeenCalledWith({ pronouns: "p".repeat(PRONOUNS_MAX) })
  })

  it("saves the status message on blur, capped at STATUS_MAX", () => {
    const result = baseResult()
    mockUseUserProfile.mockReturnValue(result)
    render(<ProfileSection />)
    const input = screen.getByTestId("profile-status")
    fireEvent.change(input, { target: { value: "s".repeat(STATUS_MAX + 5) } })
    fireEvent.blur(input)
    expect(result.save).toHaveBeenCalledWith({ statusMessage: "s".repeat(STATUS_MAX) })
  })

  it("renders stored pronouns and status values", () => {
    mockUseUserProfile.mockReturnValue(
      baseResult({ profile: { pronouns: "they/them", statusMessage: "shipping" } })
    )
    render(<ProfileSection />)
    expect(screen.getByTestId("profile-pronouns")).toHaveValue("they/them")
    expect(screen.getByTestId("profile-status")).toHaveValue("shipping")
  })

  it("shows the reset button when only a status exists and clears everything", () => {
    const result = baseResult({ profile: { statusMessage: "busy" } })
    mockUseUserProfile.mockReturnValue(result)
    render(<ProfileSection />)
    fireEvent.click(screen.getByTestId("profile-reset"))
    expect(result.save).toHaveBeenCalledWith({
      displayName: "",
      bio: "",
      pronouns: "",
      statusMessage: "",
      avatarDataUrl: "",
      timezone: "",
    })
  })

  it("hides the reset button for an empty profile", () => {
    render(<ProfileSection />)
    expect(screen.queryByTestId("profile-reset")).not.toBeInTheDocument()
  })

  it("shows the reset button when only a timezone is set", () => {
    mockUseUserProfile.mockReturnValue(baseResult({ profile: { timezone: "Asia/Tokyo" } }))
    render(<ProfileSection />)
    expect(screen.getByTestId("profile-reset")).toBeInTheDocument()
  })

  it("hides the email line when showEmail is false, even signed in", () => {
    mockUseUserProfile.mockReturnValue(
      baseResult({ resolvedDisplayName: "Max", email: "max@example.com" })
    )
    render(<ProfileSection showEmail={false} />)
    expect(screen.queryByTestId("profile-email")).not.toBeInTheDocument()
  })

  it("renders a live preview of the composed identity", () => {
    mockUseUserProfile.mockReturnValue(
      baseResult({
        profile: { pronouns: "they/them", statusMessage: "shipping" },
        resolvedDisplayName: "Max",
      })
    )
    render(<ProfileSection />)
    expect(screen.getByTestId("profile-preview")).toBeInTheDocument()
    expect(screen.getByTestId("profile-preview-name")).toHaveTextContent("Max")
    expect(screen.getByTestId("profile-preview-status")).toHaveTextContent("shipping")
    // No avatar → initials fallback, not the <img>.
    expect(screen.queryByTestId("profile-preview-avatar")).not.toBeInTheDocument()
  })

  it("shows the avatar image in the preview when one is set", () => {
    mockUseUserProfile.mockReturnValue(
      baseResult({ resolvedAvatarUrl: "data:image/webp;base64,AA", resolvedDisplayName: "Max" })
    )
    render(<ProfileSection />)
    expect(screen.getByTestId("profile-preview-avatar")).toBeInTheDocument()
  })

  it("updates the preview name live while typing the display name", () => {
    render(<ProfileSection />)
    fireEvent.change(screen.getByTestId("profile-display-name"), {
      target: { value: "Ada" },
    })
    expect(screen.getByTestId("profile-preview-name")).toHaveTextContent("Ada")
  })

  it("saves the timezone when the picker changes", () => {
    const result = baseResult()
    mockUseUserProfile.mockReturnValue(result)
    render(<ProfileSection />)
    fireEvent.click(screen.getByTestId("profile-timezone"))
    expect(result.save).toHaveBeenCalledWith({ timezone: "Asia/Tokyo" })
  })
})
