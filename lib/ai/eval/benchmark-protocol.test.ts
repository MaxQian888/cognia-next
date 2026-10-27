import {
  TEAM_BENCHMARK_CASES,
  benchmarkPrompt,
  benchmarkSchedule,
  checkBenchmarkOutput,
  benchmarkPercentile,
  validateBenchmarkEndpoint,
} from "./benchmark-protocol"

it("refuses endpoint credentials before a manifest can persist them", () => {
  expect(validateBenchmarkEndpoint("http://127.0.0.1:8787/v1")).toBe("http://127.0.0.1:8787/v1")
  for (const value of [
    "https://user:secret@example.com/v1",
    "https://example.com/v1?api_key=secret",
    "https://example.com/v1#secret",
    "file:///secret",
  ])
    expect(() => validateBenchmarkEndpoint(value)).toThrow()
})

it("grades parsed artifacts independently and rejects claimed success or extra fields", () => {
  const item = TEAM_BENCHMARK_CASES[0]!
  expect(checkBenchmarkOutput(item, '{"y":119,"x":43}')).toBe(true)
  expect(checkBenchmarkOutput(item, '```json\n{"x":43,"y":119}\n```')).toBe(true)
  expect(checkBenchmarkOutput(item, '{"x":43,"y":119,"done":true}')).toBe(false)
  expect(checkBenchmarkOutput(item, "I solved it successfully")).toBe(false)
  expect(benchmarkPrompt(item)).not.toContain('"x":43')
})
it("freezes reproducible balanced blocks for all three candidates", () => {
  const schedule = benchmarkSchedule(["one", "two"], 3, 42)
  expect(schedule).toEqual(benchmarkSchedule(["one", "two"], 3, 42))
  expect(schedule).toHaveLength(18)
  for (let i = 0; i < schedule.length; i += 3)
    expect(new Set(schedule.slice(i, i + 3).map((row) => row.variant)).size).toBe(3)
  expect(() => benchmarkSchedule(["one"], 0, 42)).toThrow()
})
it("labels empty timing populations unavailable and includes slow failures in the input population", () => {
  expect(benchmarkPercentile([], 0.95)).toBeNull()
  expect(benchmarkPercentile([1, 2, 1000], 0.95)).toBe(1000)
})
