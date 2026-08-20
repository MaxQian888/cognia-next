import type { QuickFixAction } from "./matchers"
import { runQuickFixAction } from "./run-action"

function effects() {
  return {
    write: jest.fn(),
    openUrl: jest.fn(),
    killPort: jest.fn(async () => [1234]),
  }
}

describe("runQuickFixAction", () => {
  it("auto-runs a deterministic command fix", async () => {
    const fx = effects()
    await runQuickFixAction(
      { type: "run-command", command: "pnpm install", addNewLine: true } as QuickFixAction,
      fx
    )
    expect(fx.write).toHaveBeenCalledWith("pnpm install\r")
  })

  // A suggestion-derived fix is a proposal, not a decision — it lands on the
  // prompt for the user to confirm.
  it("leaves a suggested command on the prompt", async () => {
    const fx = effects()
    await runQuickFixAction(
      {
        type: "run-command",
        command: "git push --set-upstream",
        addNewLine: false,
      } as QuickFixAction,
      fx
    )
    expect(fx.write).toHaveBeenCalledWith("git push --set-upstream")
  })

  it("opens a URL through the allowlist rather than writing it", async () => {
    const fx = effects()
    await runQuickFixAction(
      { type: "open-url", url: "https://example.test/pr/1" } as QuickFixAction,
      fx
    )
    expect(fx.openUrl).toHaveBeenCalledWith("https://example.test/pr/1")
    expect(fx.write).not.toHaveBeenCalled()
  })

  // The port belongs to whichever machine ran the command. This used to be a
  // direct Tauri `invoke`, so in a browser it freed nothing and then re-ran the
  // command into the same occupied port.
  it("frees the port on the host, then re-runs the command", async () => {
    const fx = effects()
    await runQuickFixAction(
      { type: "kill-port", port: 3000, command: "pnpm dev" } as QuickFixAction,
      fx
    )
    expect(fx.killPort).toHaveBeenCalledWith(3000)
    expect(fx.write).toHaveBeenCalledWith("pnpm dev\r")
  })

  it("does not re-run the command when the port could not be freed", async () => {
    const fx = effects()
    fx.killPort.mockRejectedValue(new Error("missing_capability"))
    await runQuickFixAction(
      { type: "kill-port", port: 3000, command: "pnpm dev" } as QuickFixAction,
      fx
    )
    expect(fx.write).not.toHaveBeenCalled()
  })

  // A failed quick fix must never take the terminal with it.
  it("swallows an effect that throws", async () => {
    const fx = effects()
    fx.openUrl.mockImplementation(() => {
      throw new Error("blocked")
    })
    await expect(
      runQuickFixAction({ type: "open-url", url: "https://example.test" } as QuickFixAction, fx)
    ).resolves.toBeUndefined()
  })
})
