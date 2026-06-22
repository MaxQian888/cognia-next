import { render, waitFor } from "@testing-library/react"

const interruptRendererBackgroundTasksOnBoot = jest.fn(async () => undefined)

jest.mock("@/lib/background-tasks/renderer-subagent-registry", () => ({
  interruptRendererBackgroundTasksOnBoot: () => interruptRendererBackgroundTasksOnBoot(),
}))

import { BackgroundTaskInitializer } from "./background-task-initializer"

beforeEach(() => {
  interruptRendererBackgroundTasksOnBoot.mockClear()
})

it("reconciles renderer background tasks on client boot", async () => {
  const { container } = render(<BackgroundTaskInitializer />)

  expect(container).toBeEmptyDOMElement()
  await waitFor(() => expect(interruptRendererBackgroundTasksOnBoot).toHaveBeenCalledTimes(1))
})
