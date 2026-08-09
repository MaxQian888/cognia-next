/** @jest-environment jsdom */

jest.mock("@/lib/native/utils", () => ({ isTauri: jest.fn() }))
jest.mock("@/lib/native/external-agent", () => ({
  acpTerminalCreate: jest.fn(),
  acpTerminalKill: jest.fn(),
  acpTerminalOutput: jest.fn(),
  acpTerminalRelease: jest.fn(),
  acpTerminalWaitForExit: jest.fn(),
}))

import { isTauri } from "@/lib/native/utils"
import {
  acpTerminalCreate,
  acpTerminalOutput,
  acpTerminalRelease,
  acpTerminalWaitForExit,
} from "@/lib/native/external-agent"
import { __setLarkCliProcessRunnerForTests, runLarkCliProcess } from "./process"

const options = { timeoutMs: 1_000, maxOutputBytes: 4_096 }

beforeEach(() => {
  jest.clearAllMocks()
  __setLarkCliProcessRunnerForTests(null)
  jest.mocked(isTauri).mockReturnValue(false)
})

afterAll(() => __setLarkCliProcessRunnerForTests(null))

it("fails closed in a browser without a desktop process host", async () => {
  await expect(runLarkCliProcess("lark-cli", ["--version"], options)).resolves.toMatchObject({
    notFound: true,
  })
})

it("runs through the bounded Tauri terminal bridge", async () => {
  jest.mocked(isTauri).mockReturnValue(true)
  jest.mocked(acpTerminalCreate).mockResolvedValue("terminal-1")
  jest.mocked(acpTerminalWaitForExit).mockResolvedValue({
    exitStatus: { exitCode: 0, signal: null },
  })
  jest.mocked(acpTerminalOutput).mockResolvedValue({
    output: "lark-cli version 1.0.83",
    truncated: false,
    exitStatus: { exitCode: 0, signal: null },
  })
  jest.mocked(acpTerminalRelease).mockResolvedValue(undefined)

  await expect(
    runLarkCliProcess("lark-cli", ["--version"], {
      ...options,
      env: { LARK_APP_ID: "cli_test" },
    })
  ).resolves.toMatchObject({ stdout: "lark-cli version 1.0.83", exitCode: 0 })
  expect(acpTerminalCreate).toHaveBeenCalledWith(
    "cognia:lark-cli",
    "lark-cli",
    ["--version"],
    undefined,
    { LARK_APP_ID: "cli_test" },
    4_096
  )
  expect(acpTerminalRelease).toHaveBeenCalledWith("terminal-1")
})

it("supports a deterministic runner override", async () => {
  const runner = jest.fn(async () => ({ stdout: "ok", stderr: "", exitCode: 0 }))
  __setLarkCliProcessRunnerForTests(runner)
  await expect(runLarkCliProcess("custom", ["x"], options)).resolves.toMatchObject({
    stdout: "ok",
  })
  expect(runner).toHaveBeenCalledWith("custom", ["x"], options)
})
