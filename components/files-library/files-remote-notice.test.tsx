/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen } from "@testing-library/react"

import { FilesRemoteNotice } from "./files-remote-notice"

it("says nothing while the library reads fine, or where it is this device's own", () => {
  const { container, rerender } = render(
    <FilesRemoteNotice error={undefined} refresh={jest.fn()} />
  )
  expect(container).toBeEmptyDOMElement()
  rerender(<FilesRemoteNotice error="files_remote_busy" refresh={undefined} />)
  expect(container).toBeEmptyDOMElement()
})

it("names why the host's library may be stale and retries on demand", async () => {
  let finish!: () => void
  const refresh = jest.fn(() => new Promise<void>((resolve) => (finish = resolve)))
  render(<FilesRemoteNotice error="files_remote_unreachable" refresh={refresh} touch />)
  expect(screen.getByTestId("files-remote-notice")).toHaveTextContent(
    "Couldn’t read the desktop’s library"
  )
  expect(screen.getByText("Couldn’t reach the desktop.")).toBeInTheDocument()
  const retry = screen.getByTestId("files-remote-retry")
  fireEvent.click(retry)
  expect(refresh).toHaveBeenCalledTimes(1)
  expect(retry).toBeDisabled()
  await act(async () => finish())
  expect(retry).not.toBeDisabled()
})

it("reads an unknown code as the generic failure", () => {
  render(<FilesRemoteNotice error="something_new" refresh={jest.fn(async () => {})} />)
  expect(screen.getByText("Something went wrong. Try again.")).toBeInTheDocument()
})
