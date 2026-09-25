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
import { DESKTOP_LOCAL_ACCOUNT_ID } from "@/lib/accounts/desktop-local-account"

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
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
})

function enterTauri(): void {
  ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
}

describe("OnboardingGate", () => {
  it.each(["/lark/workbench", "/lark/workbench/", "/lark/workbench.html"])(
    "lets the workbench capture its SSO fragment before first-run routing at %s",
    (route) => {
      pathname = route
      window.history.replaceState(null, "", `${route}?adapter_id=lk-1#lark_session=token`)
      gate.mockReturnValue({ status: "enter", shell: "web" })
      const { rerender } = render(
        <OnboardingGate>
          <p>entry</p>
        </OnboardingGate>
      )
      expect(screen.getByText("entry")).toBeInTheDocument()
      expect(replace).not.toHaveBeenCalled()
      expect(window.location.hash).toBe("#lark_session=token")
      pathname = "/"
      rerender(
        <OnboardingGate>
          <p>app</p>
        </OnboardingGate>
      )
      expect(replace).toHaveBeenCalledWith("/onboarding")
      expect(screen.queryByText("app")).not.toBeInTheDocument()
      window.history.replaceState(null, "", "/")
    }
  )

  // ADR-0037, "The anonymous visitor": reading a share needs no setup, and
  // the redirect would leave the page and drop the `#k=` key with it.
  it.each(["/share/view", "/share/view/", "/share/view.html"])(
    "lets a first-run account read a share link at %s",
    (route) => {
      pathname = route
      window.history.replaceState(null, "", `${route}?c=code#k=key`)
      gate.mockReturnValue({ status: "enter", shell: "web" })
      const { rerender } = render(
        <OnboardingGate>
          <p>share</p>
        </OnboardingGate>
      )
      expect(screen.getByText("share")).toBeInTheDocument()
      expect(replace).not.toHaveBeenCalled()
      expect(window.location.hash).toBe("#k=key")
      // Entering the app from the viewer still goes through the flow.
      pathname = "/"
      rerender(
        <OnboardingGate>
          <p>app</p>
        </OnboardingGate>
      )
      expect(replace).toHaveBeenCalledWith("/onboarding")
      expect(screen.queryByText("app")).not.toBeInTheDocument()
      window.history.replaceState(null, "", "/")
    }
  )

  it("renders the share viewer while the verdict is still resolving", () => {
    pathname = "/share/view"
    gate.mockReturnValue({ status: "resolving", shell: "web" })
    render(
      <OnboardingGate>
        <p>share</p>
      </OnboardingGate>
    )
    expect(screen.getByText("share")).toBeInTheDocument()
    expect(screen.queryByTestId("page-loading")).not.toBeInTheDocument()
  })

  it("does not exempt similarly prefixed routes", () => {
    pathname = "/lark/workbench-admin"
    gate.mockReturnValue({ status: "enter", shell: "web" })
    render(
      <OnboardingGate>
        <p>app</p>
      </OnboardingGate>
    )
    expect(replace).toHaveBeenCalledWith("/onboarding")
  })

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

  it("passes the app through for the workspace `pnpm tauri dev` provisions", () => {
    setNodeEnv("development")
    enterTauri()
    unlockedAccountId = DESKTOP_LOCAL_ACCOUNT_ID
    gate.mockReturnValue({ status: "enter", shell: "desktop" })
    render(
      <OnboardingGate>
        <p>app</p>
      </OnboardingGate>
    )
    expect(replace).not.toHaveBeenCalled()
    expect(screen.getByText("app")).toBeInTheDocument()
  })

  it("routes the desktop workspace into the flow in a release build", () => {
    setNodeEnv("production")
    enterTauri()
    unlockedAccountId = DESKTOP_LOCAL_ACCOUNT_ID
    gate.mockReturnValue({ status: "enter", shell: "desktop" })
    render(
      <OnboardingGate>
        <p>app</p>
      </OnboardingGate>
    )
    expect(replace).toHaveBeenCalledWith("/onboarding")
  })

  it("does not treat the desktop workspace id as a bypass outside the desktop shell", () => {
    setNodeEnv("development")
    unlockedAccountId = DESKTOP_LOCAL_ACCOUNT_ID
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
