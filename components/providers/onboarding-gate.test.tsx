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

let unlockedAccountId: string | null = null
let activeAccountId: string | null = null
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (state: unknown) => unknown) =>
    selector({ unlockedAccountId, activeAccountId }),
}))

import { DEV_LOCAL_ACCOUNT_ID } from "@/lib/accounts/dev-auto-unlock"

import { OnboardingGate } from "./onboarding-gate"

const ORIGINAL_NODE_ENV = process.env.NODE_ENV

function setNodeEnv(value: string | undefined): void {
  Object.defineProperty(process.env, "NODE_ENV", { value, configurable: true })
}

beforeEach(() => {
  replace.mockClear()
  gate.mockReset()
  pathname = "/"
  unlockedAccountId = null
  activeAccountId = null
})

afterEach(() => {
  setNodeEnv(ORIGINAL_NODE_ENV)
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

  it("passes the app through for the dev server's disposable account", () => {
    // That account is provisioned fresh on every new browser profile, so it is
    // permanently a first run. Routing it into the flow would put the wizard
    // back in front of every browser the dev server sees.
    setNodeEnv("development")
    unlockedAccountId = DEV_LOCAL_ACCOUNT_ID
    gate.mockReturnValue({ status: "enter", shell: "web" })
    render(
      <OnboardingGate>
        <p>app</p>
      </OnboardingGate>
    )
    expect(replace).not.toHaveBeenCalled()
    expect(screen.getByText("app")).toBeInTheDocument()
  })

  it("still routes an account the developer created into the flow", () => {
    setNodeEnv("development")
    unlockedAccountId = "acct_mine"
    gate.mockReturnValue({ status: "enter", shell: "web" })
    render(
      <OnboardingGate>
        <p>app</p>
      </OnboardingGate>
    )
    expect(replace).toHaveBeenCalledWith("/onboarding")
  })

  it("does not honour the bypass in a shipped build", () => {
    setNodeEnv("production")
    unlockedAccountId = DEV_LOCAL_ACCOUNT_ID
    gate.mockReturnValue({ status: "enter", shell: "web" })
    render(
      <OnboardingGate>
        <p>app</p>
      </OnboardingGate>
    )
    expect(replace).toHaveBeenCalledWith("/onboarding")
  })
})
