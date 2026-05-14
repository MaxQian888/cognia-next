import { render, screen, fireEvent } from "@testing-library/react"
import { act } from "react"
import {
  __resetTerminalBridgeForTesting,
  configureTerminalBridge,
  createTerminal,
  type ShellChildProcess,
  type ShellSpawnFn,
} from "@/lib/plugin/vscode-shim/terminal-bridge"
import {
  __resetTerminalPanelStateForTesting,
  configureTerminalOutputSink,
  VscodeTerminalPanel,
} from "./vscode-terminal-panel"

function makeFakeSpawn(): ShellSpawnFn & {
  lastChild?: {
    emitStdout: (text: string) => void
    emitStderr: (text: string) => void
  }
} {
  const fn = jest.fn() as unknown as ShellSpawnFn & {
    lastChild?: {
      emitStdout: (text: string) => void
      emitStderr: (text: string) => void
    }
  }
  ;(fn as jest.Mock).mockImplementation(() => {
    const stdoutListeners: Array<(c: string) => void> = []
    const stderrListeners: Array<(c: string) => void> = []
    const child: ShellChildProcess = {
      pid: 1,
      write: jest.fn(),
      kill: jest.fn(),
      finished: new Promise(() => {
        // Never resolve for these tests.
      }),
      onStdout: (l) => {
        stdoutListeners.push(l)
        return () => {}
      },
      onStderr: (l) => {
        stderrListeners.push(l)
        return () => {}
      },
    }
    fn.lastChild = {
      emitStdout: (t) => stdoutListeners.forEach((l) => l(t)),
      emitStderr: (t) => stderrListeners.forEach((l) => l(t)),
    }
    return child
  })
  return fn
}

describe("<VscodeTerminalPanel />", () => {
  beforeEach(() => {
    __resetTerminalBridgeForTesting()
    __resetTerminalPanelStateForTesting()
  })

  it("renders the empty state when no terminals exist", () => {
    const sink = configureTerminalOutputSink()
    configureTerminalBridge({ spawn: makeFakeSpawn(), outputSink: sink })
    render(<VscodeTerminalPanel />)
    expect(screen.getByTestId("vscode-terminal-panel-empty")).toBeInTheDocument()
  })

  it("auto-selects the first terminal when one is created", async () => {
    const spawn = makeFakeSpawn()
    const sink = configureTerminalOutputSink()
    configureTerminalBridge({ spawn, outputSink: sink })
    const { rerender } = render(<VscodeTerminalPanel />)
    expect(screen.getByTestId("vscode-terminal-panel-empty")).toBeInTheDocument()

    await act(async () => {
      createTerminal({
        extensionId: "ext.cline",
        name: "Build",
        shellPath: "/bin/echo",
      })
    })
    // Force a microtask flush so the bridge listener fires.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    rerender(<VscodeTerminalPanel />)
    expect(screen.queryByTestId("vscode-terminal-panel-empty")).not.toBeInTheDocument()
    expect(screen.getByText("Build")).toBeInTheDocument()
  })

  it("streams stdout lines into the log", async () => {
    const spawn = makeFakeSpawn()
    const sink = configureTerminalOutputSink()
    configureTerminalBridge({ spawn, outputSink: sink })
    render(<VscodeTerminalPanel />)
    await act(async () => {
      createTerminal({
        extensionId: "ext.cline",
        name: "Build",
        shellPath: "/bin/echo",
      })
      await new Promise((r) => setTimeout(r, 0))
    })
    await act(async () => {
      spawn.lastChild!.emitStdout("hello world\n")
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(screen.getByText(/hello world/)).toBeInTheDocument()
  })

  it("sends user input via the composer Send button", async () => {
    const spawn = makeFakeSpawn()
    const sink = configureTerminalOutputSink()
    configureTerminalBridge({ spawn, outputSink: sink })
    render(<VscodeTerminalPanel />)
    await act(async () => {
      createTerminal({
        extensionId: "ext.cline",
        name: "Build",
        shellPath: "/bin/echo",
      })
      await new Promise((r) => setTimeout(r, 0))
    })
    const input = screen.getByLabelText("Terminal input") as HTMLInputElement
    fireEvent.change(input, { target: { value: "ls" } })
    fireEvent.click(screen.getByText("Send"))
    expect((spawn as unknown as jest.Mock).mock.results[0]!.value.write).toHaveBeenCalledWith(
      "ls\n"
    )
  })

  it("Enter key triggers a send", async () => {
    const spawn = makeFakeSpawn()
    const sink = configureTerminalOutputSink()
    configureTerminalBridge({ spawn, outputSink: sink })
    render(<VscodeTerminalPanel />)
    await act(async () => {
      createTerminal({
        extensionId: "ext.cline",
        name: "Build",
        shellPath: "/bin/echo",
      })
      await new Promise((r) => setTimeout(r, 0))
    })
    const input = screen.getByLabelText("Terminal input") as HTMLInputElement
    fireEvent.change(input, { target: { value: "pwd" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect((spawn as unknown as jest.Mock).mock.results[0]!.value.write).toHaveBeenCalledWith(
      "pwd\n"
    )
  })
})
