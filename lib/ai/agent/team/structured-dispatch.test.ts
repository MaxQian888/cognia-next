import { z } from "zod"
import { dispatchStructured } from "./structured-dispatch"
import type { TeamRunContext } from "./team-run-context"

const dispatchTeammateMock = jest.fn()
jest.mock("./dispatch-teammate", () => ({
  dispatchTeammate: (...a: unknown[]) => dispatchTeammateMock(...a),
}))

const ctx = {} as TeamRunContext
const schema = z.object({ real: z.boolean(), reasoning: z.string().min(1) })

beforeEach(() => jest.clearAllMocks())

describe("dispatchStructured", () => {
  it("parses a fenced JSON block and validates it", async () => {
    dispatchTeammateMock.mockResolvedValue({
      text: 'Here:\n```json\n{ "real": true, "reasoning": "sound" }\n```',
      teammateId: "tm1",
    })

    const { value, teammateId } = await dispatchStructured(
      ctx,
      { taskId: "t1", prompt: "verify" },
      schema
    )

    expect(value).toEqual({ real: true, reasoning: "sound" })
    expect(teammateId).toBe("tm1")
    expect(dispatchTeammateMock).toHaveBeenCalledTimes(1)
  })

  it("appends the JSON instruction (and schema hint) to the prompt", async () => {
    dispatchTeammateMock.mockResolvedValue({
      text: '{ "real": false, "reasoning": "refuted" }',
      teammateId: "tm1",
    })

    await dispatchStructured(ctx, { taskId: "t1", prompt: "base" }, schema, {
      schemaHint: "{ real, reasoning }",
    })

    const arg = dispatchTeammateMock.mock.calls[0][1] as { prompt: string }
    expect(arg.prompt).toContain("base")
    expect(arg.prompt).toContain("fenced JSON")
    expect(arg.prompt).toContain("{ real, reasoning }")
  })

  it("retries once with the validation error fed back, then succeeds", async () => {
    dispatchTeammateMock
      .mockResolvedValueOnce({ text: '{ "real": "yes" }', teammateId: "tm1" })
      .mockResolvedValueOnce({
        text: '```json\n{ "real": true, "reasoning": "ok" }\n```',
        teammateId: "tm2",
      })

    const { value, teammateId } = await dispatchStructured(
      ctx,
      { taskId: "t1", prompt: "verify" },
      schema
    )

    expect(value.real).toBe(true)
    expect(teammateId).toBe("tm2")
    expect(dispatchTeammateMock).toHaveBeenCalledTimes(2)
    const retryPrompt = (dispatchTeammateMock.mock.calls[1][1] as { prompt: string }).prompt
    expect(retryPrompt).toContain("previous response was invalid")
  })

  it("throws after two invalid attempts", async () => {
    dispatchTeammateMock.mockResolvedValue({ text: "not json at all", teammateId: "tm1" })

    await expect(
      dispatchStructured(ctx, { taskId: "t1", prompt: "verify" }, schema)
    ).rejects.toThrow(/no valid structured output after 2 attempts/)
    expect(dispatchTeammateMock).toHaveBeenCalledTimes(2)
  })

  it("retries when JSON parses but fails schema validation", async () => {
    dispatchTeammateMock
      .mockResolvedValueOnce({ text: '{ "real": true }', teammateId: "tm1" })
      .mockResolvedValueOnce({ text: '{ "real": true, "reasoning": "x" }', teammateId: "tm2" })

    const { value } = await dispatchStructured(ctx, { taskId: "t1", prompt: "v" }, schema)
    expect(value.reasoning).toBe("x")
  })

  it("forces validateOutput + disables store recording on the inner dispatch", async () => {
    dispatchTeammateMock.mockResolvedValue({
      text: '{ "real": true, "reasoning": "ok" }',
      teammateId: "tm1",
    })
    await dispatchStructured(ctx, { taskId: "t1", prompt: "v" }, schema)
    const arg = dispatchTeammateMock.mock.calls[0][1] as {
      validateOutput: boolean
      recordToStore: boolean
    }
    expect(arg.validateOutput).toBe(true)
    expect(arg.recordToStore).toBe(false)
  })
})
