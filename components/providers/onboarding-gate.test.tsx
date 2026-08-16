/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"

const replace = jest.fn()
let pathname = "/"
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => pathname,
}))

const gate = jest.fn()
jest.mock("@/hooks/onboarding/use-onboarding-gate", () => ({
  useOnboardingGate: () => gate(),
}))
jest.mock("@/components/ui/loading-states", () => ({
  PageLoading: ({ variant, milestone }: { variant?: string; milestone?: string }) => (
    <div data-testid="page-loading" data-variant={variant} data-milestone={milestone} />
  ),
}))

import { OnboardingGate } from "./onboarding-gate"

beforeEach(() => {
  replace.mockClear()
  gate.mockReset()
  pathname = "/"
})

describe("OnboardingGate", () => {
  it("keeps the boot screen up, as its preferences step, while the verdict is still resolving", () => {
    gate.mockReturnValue({ status: "resolving", shell: "tauri" })
    render(
      <OnboardingGate>
        <p>app</p>
      </OnboardingGate>
    )
    const loading = screen.getByTestId("page-loading")
    expect(loading).toHaveAttribute("data-variant", "workspace")
    expect(loading).toHaveAttribute("data-milestone", "preferences")
    expect(screen.queryByText("app")).not.toBeInTheDocument()
    expect(replace).not.toHaveBeenCalled()
  })

  it("passes the app through once the user is known to be onboarded", () => {
    gate.mockReturnValue({ status: "skip", shell: "tauri" })
    render(
      <OnboardingGate>
        <p>app</p>
      </OnboardingGate>
    )
    expect(screen.getByText("app")).toBeInTheDocument()
    expect(replace).not.toHaveBeenCalled()
  })

  it("routes a first-run device into the flow and holds the app back meanwhile", () => {
    gate.mockReturnValue({ status: "enter", shell: "tauri" })
    render(
      <OnboardingGate>
        <p>app</p>
      </OnboardingGate>
    )
    expect(replace).toHaveBeenCalledWith("/onboarding")
    // Holding children back is what stops the chat shell flashing behind it;
    // the boot screen stays up for the frame the replace takes to land.
    expect(screen.queryByText("app")).toBeNull()
    expect(screen.getByTestId("page-loading")).toHaveAttribute("data-milestone", "preferences")
  })

  it("never redirects onto itself", () => {
    pathname = "/onboarding"
    gate.mockReturnValue({ status: "enter", shell: "tauri" })
    render(
      <OnboardingGate>
        <p>flow</p>
      </OnboardingGate>
    )
    expect(replace).not.toHaveBeenCalled()
    expect(screen.getByText("flow")).toBeInTheDocument()
  })

  it("renders the flow route for an already-onboarded user re-running setup", () => {
    // The Settings "run setup again" entry point would be dead otherwise.
    pathname = "/onboarding"
    gate.mockReturnValue({ status: "skip", shell: "tauri" })
    render(
      <OnboardingGate>
        <p>flow</p>
      </OnboardingGate>
    )
    expect(screen.getByText("flow")).toBeInTheDocument()
  })

  it("renders the flow route even while the verdict is resolving", () => {
    pathname = "/onboarding"
    gate.mockReturnValue({ status: "resolving", shell: "tauri" })
    render(
      <OnboardingGate>
        <p>flow</p>
      </OnboardingGate>
    )
    expect(screen.getByText("flow")).toBeInTheDocument()
  })
})
