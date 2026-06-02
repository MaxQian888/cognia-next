/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import en from "@/i18n/messages/en.json"
import { WorkspaceRestrictedBanner } from "./workspace-restricted-banner"

function renderBanner(props: Partial<React.ComponentProps<typeof WorkspaceRestrictedBanner>> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <WorkspaceRestrictedBanner
        untrustedRoots={[{ id: "r", path: "/a", isPrimary: true }]}
        onTrust={jest.fn()}
        {...props}
      />
    </NextIntlClientProvider>
  )
}

it("renders title + untrusted root path", () => {
  renderBanner()
  expect(screen.getByText(en.chat.workspaceRestricted.title)).toBeInTheDocument()
  expect(screen.getByText("/a")).toBeInTheDocument()
})

it("renders nothing when there are no untrusted roots", () => {
  const { container } = renderBanner({ untrustedRoots: [] })
  expect(container).toBeEmptyDOMElement()
})

it("invokes onTrust when the button is clicked", async () => {
  const onTrust = jest.fn().mockResolvedValue(undefined)
  renderBanner({ onTrust })
  fireEvent.click(screen.getByRole("button", { name: en.chat.workspaceRestricted.trust }))
  await waitFor(() => expect(onTrust).toHaveBeenCalled())
})
