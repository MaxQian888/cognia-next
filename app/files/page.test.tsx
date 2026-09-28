import { render } from "@testing-library/react"

jest.mock("@/components/files-library/files-library", () => ({
  FilesLibrary: () => <div data-testid="files-library" />,
}))

import FilesPage from "./page"

it("hosts the Files page in a full-height wrapper", () => {
  const { container, getByTestId } = render(<FilesPage />)
  expect(getByTestId("files-library")).toBeInTheDocument()
  expect(container.firstElementChild).toHaveClass("h-full", "min-h-0", "flex-1")
})
