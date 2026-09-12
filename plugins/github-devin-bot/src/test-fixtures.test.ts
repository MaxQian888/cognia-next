import { fixture, SHA } from "./test-fixtures"

it("isolates fixture stores and memoizes only completed durable steps", async () => {
  const a = fixture()
  const b = fixture()
  await a.context.storage.set("key", SHA)
  expect(await b.context.storage.get("key")).toBeUndefined()
  const fail = jest.fn().mockRejectedValueOnce(new Error("crash")).mockResolvedValue("done")
  await expect(a.run.step.run("step", fail)).rejects.toThrow("crash")
  expect(await a.run.step.run("step", fail)).toBe("done")
  expect(await a.run.step.run("step", fail)).toBe("done")
  expect(fail).toHaveBeenCalledTimes(2)
})
