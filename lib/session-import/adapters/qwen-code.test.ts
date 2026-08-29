import { qwenCodeSessionSource } from "./qwen-code"

describe("qwenCodeSessionSource", () => {
  it("accepts official JSON/JSONL exports and local session artifacts", () => {
    expect(qwenCodeSessionSource.acceptedExtensions).toEqual([".json", ".jsonl"])
    expect(qwenCodeSessionSource.scanRoots("/home/u")).toEqual([
      "/home/u/.qwen/sessions",
      "/home/u/.qwen/tmp",
    ])
    expect(qwenCodeSessionSource.parseGraph).toEqual(expect.any(Function))
  })
})
