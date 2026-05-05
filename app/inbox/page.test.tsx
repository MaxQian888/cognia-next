/**
 * @jest-environment jsdom
 */

// redirect() is imported from next/navigation, which is mocked in jest.setup.ts.
// We test that the page module calls redirect with /inbox/all.

const mockRedirect = jest.fn()

jest.mock("next/navigation", () => ({
  redirect: mockRedirect,
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/inbox",
}))

describe("app/inbox/page", () => {
  beforeEach(() => {
    mockRedirect.mockReset()
  })

  it("calls redirect('/inbox/all')", () => {
    // Import after mock is set up.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { default: InboxPage } = require("./page") as {
      default: () => void
    }
    // The component itself calls redirect during render (it's a server component
    // that throws internally — but in the test env it's a plain function call).
    try {
      InboxPage()
    } catch {
      // redirect() may throw in some environments; that's expected.
    }
    expect(mockRedirect).toHaveBeenCalledWith("/inbox/all")
  })
})
