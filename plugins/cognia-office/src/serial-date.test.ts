import { dateToSerial, serialToDate } from "./serial-date"

describe("serial dates", () => {
  it("maps local calendar dates onto the 1900 date system", () => {
    expect(dateToSerial(new Date(1970, 0, 1))).toBe(25569)
    expect(dateToSerial(new Date(2024, 0, 15))).toBe(45306)
    expect(dateToSerial(new Date(2024, 0, 15, 12))).toBe(45306.5)
  })

  it("round-trips a serial through a local Date", () => {
    const date = serialToDate(45306.25)
    expect([date.getFullYear(), date.getMonth(), date.getDate(), date.getHours()]).toEqual([
      2024, 0, 15, 6,
    ])
    expect(dateToSerial(date)).toBe(45306.25)
  })
})
