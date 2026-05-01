/**
 * Tests for CSV Parser
 */

import {
  parseCSV,
  detectDelimiter,
  csvToJSON,
  getCSVStats,
  extractCSVEmbeddableContent,
  inferColumnTypes,
  getColumnStats,
} from "./csv-parser"

describe("detectDelimiter", () => {
  it("detects comma delimiter", () => {
    const content = "name,age,city\nJohn,30,NYC"
    expect(detectDelimiter(content)).toBe(",")
  })

  it("detects tab delimiter", () => {
    const content = "name\tage\tcity\nJohn\t30\tNYC"
    expect(detectDelimiter(content)).toBe("\t")
  })

  it("detects semicolon delimiter", () => {
    const content = "name;age;city\nJohn;30;NYC"
    expect(detectDelimiter(content)).toBe(";")
  })

  it("detects pipe delimiter", () => {
    const content = "name|age|city\nJohn|30|NYC"
    expect(detectDelimiter(content)).toBe("|")
  })

  it("defaults to comma when no delimiter found", () => {
    const content = "single value"
    expect(detectDelimiter(content)).toBe(",")
  })
})

describe("parseCSV", () => {
  it("parses basic CSV with header", () => {
    const content = "name,age,city\nJohn,30,NYC\nJane,25,LA"
    const result = parseCSV(content)

    expect(result.headers).toEqual(["name", "age", "city"])
    expect(result.data).toEqual([
      ["John", "30", "NYC"],
      ["Jane", "25", "LA"],
    ])
    expect(result.rowCount).toBe(2)
    expect(result.columnCount).toBe(3)
  })

  it("parses CSV without header", () => {
    const content = "John,30,NYC\nJane,25,LA"
    const result = parseCSV(content, { hasHeader: false })

    expect(result.headers).toEqual([])
    expect(result.data).toEqual([
      ["John", "30", "NYC"],
      ["Jane", "25", "LA"],
    ])
    expect(result.rowCount).toBe(2)
  })

  it("handles quoted values with commas", () => {
    const content = 'name,description\nJohn,"Hello, World"\nJane,"Nice, to meet you"'
    const result = parseCSV(content)

    expect(result.data).toEqual([
      ["John", "Hello, World"],
      ["Jane", "Nice, to meet you"],
    ])
  })

  it("handles escaped quotes", () => {
    const content = 'name,quote\nJohn,"He said ""Hello"""\nJane,"She said ""Hi"""'
    const result = parseCSV(content)

    expect(result.data).toEqual([
      ["John", 'He said "Hello"'],
      ["Jane", 'She said "Hi"'],
    ])
  })

  it("trims values by default", () => {
    const content = "name, age , city \nJohn , 30 , NYC "
    const result = parseCSV(content)

    expect(result.headers).toEqual(["name", "age", "city"])
    expect(result.data).toEqual([["John", "30", "NYC"]])
  })

  it("preserves whitespace when trimValues is false", () => {
    const content = "name, age \nJohn , 30 "
    const result = parseCSV(content, { trimValues: false })

    expect(result.headers).toEqual(["name", " age "])
    expect(result.data).toEqual([["John ", " 30 "]])
  })

  it("skips empty lines by default", () => {
    const content = "name,age\n\nJohn,30\n\nJane,25\n"
    const result = parseCSV(content)

    expect(result.rowCount).toBe(2)
  })

  it("handles TSV format", () => {
    const content = "name\tage\tcity\nJohn\t30\tNYC"
    const result = parseCSV(content, { delimiter: "\t" })

    expect(result.headers).toEqual(["name", "age", "city"])
    expect(result.data).toEqual([["John", "30", "NYC"]])
    expect(result.delimiter).toBe("\t")
  })

  it("auto-detects delimiter", () => {
    const content = "name;age;city\nJohn;30;NYC"
    const result = parseCSV(content)

    expect(result.delimiter).toBe(";")
    expect(result.headers).toEqual(["name", "age", "city"])
  })

  it("handles empty CSV", () => {
    const result = parseCSV("", { hasHeader: false })

    expect(result.data).toEqual([])
    expect(result.rowCount).toBe(0)
  })

  it("generates text representation", () => {
    const content = "name,age\nJohn,30"
    const result = parseCSV(content)

    expect(result.text).toContain("CSV Data")
    expect(result.text).toContain("name")
    expect(result.text).toContain("age")
  })
})

describe("csvToJSON", () => {
  it("converts CSV with headers to JSON objects", () => {
    const content = "name,age,city\nJohn,30,NYC\nJane,25,LA"
    const result = parseCSV(content)
    const json = csvToJSON(result)

    expect(json).toEqual([
      { name: "John", age: "30", city: "NYC", _row: "1" },
      { name: "Jane", age: "25", city: "LA", _row: "2" },
    ])
  })

  it("converts CSV without headers to JSON with column indices", () => {
    const content = "John,30,NYC\nJane,25,LA"
    const result = parseCSV(content, { hasHeader: false })
    const json = csvToJSON(result)

    expect(json).toEqual([
      { col1: "John", col2: "30", col3: "NYC", _row: "1" },
      { col1: "Jane", col2: "25", col3: "LA", _row: "2" },
    ])
  })

  it("handles missing values", () => {
    const content = "name,age,city\nJohn,30\nJane,,LA"
    const result = parseCSV(content)
    const json = csvToJSON(result)

    expect(json[0].city).toBe("")
    expect(json[1].age).toBe("")
  })
})

describe("getCSVStats", () => {
  it("calculates basic stats", () => {
    const content = "name,age,score\nJohn,30,95\nJane,25,88"
    const result = parseCSV(content)
    const stats = getCSVStats(result)

    expect(stats.rowCount).toBe(2)
    expect(stats.columnCount).toBe(3)
  })

  it("counts empty cells", () => {
    const content = "name,age\nJohn,\nJane,25"
    const result = parseCSV(content)
    const stats = getCSVStats(result)

    expect(stats.emptyCount).toBe(1)
  })

  it("detects numeric columns", () => {
    const content = "name,age,score\nJohn,30,95\nJane,25,88"
    const result = parseCSV(content)
    const stats = getCSVStats(result)

    expect(stats.numericColumns).toContain("age")
    expect(stats.numericColumns).toContain("score")
    expect(stats.numericColumns).not.toContain("name")
  })
})

describe("extractCSVEmbeddableContent", () => {
  it("includes column type summary and text", () => {
    const content = "name,age\nJohn,30"
    const result = parseCSV(content)
    const embeddable = extractCSVEmbeddableContent(result)

    expect(embeddable).toContain("Columns:")
    expect(embeddable).toContain(result.text)
  })

  it("returns just text when no headers", () => {
    const content = "John,30"
    const result = parseCSV(content, { hasHeader: false })
    const embeddable = extractCSVEmbeddableContent(result)

    expect(embeddable).toBe(result.text)
  })
})

describe("inferColumnTypes", () => {
  it("infers numeric columns", () => {
    const content = "name,age,score\nJohn,30,95.5\nJane,25,88.0\nBob,35,72.3"
    const result = parseCSV(content)
    const types = inferColumnTypes(result)

    expect(types).toHaveLength(3)
    expect(types[0].inferredType).toBe("string")
    expect(types[1].inferredType).toBe("number")
    expect(types[2].inferredType).toBe("number")
  })

  it("infers date columns", () => {
    const content = "name,date\nJohn,2024-01-15\nJane,2024-02-20\nBob,2024-03-10"
    const result = parseCSV(content)
    const types = inferColumnTypes(result)

    expect(types[1].inferredType).toBe("date")
  })

  it("infers boolean columns", () => {
    const content = "name,active\nJohn,true\nJane,false\nBob,true"
    const result = parseCSV(content)
    const types = inferColumnTypes(result)

    expect(types[1].inferredType).toBe("boolean")
  })

  it("detects mixed columns", () => {
    const content = "name,value\nJohn,30\nJane,hello\nBob,42"
    const result = parseCSV(content)
    const types = inferColumnTypes(result)

    expect(types[1].inferredType).toBe("mixed")
  })

  it("detects empty columns", () => {
    const content = "name,empty\nJohn,\nJane,\nBob,"
    const result = parseCSV(content)
    const types = inferColumnTypes(result)

    expect(types[1].inferredType).toBe("empty")
  })

  it("includes sample values and unique count", () => {
    const content = "name,age\nJohn,30\nJane,25\nBob,30"
    const result = parseCSV(content)
    const types = inferColumnTypes(result)

    expect(types[1].sampleValues.length).toBeGreaterThan(0)
    expect(types[1].uniqueCount).toBe(2) // 30 and 25
  })
})

describe("getColumnStats", () => {
  it("computes min/max/mean for numeric columns", () => {
    const content = "name,score\nAlice,90\nBob,80\nCarol,70"
    const result = parseCSV(content)
    const stats = getColumnStats(result)

    const scoreStats = stats.find((s) => s.columnName === "score")
    expect(scoreStats).toBeDefined()
    expect(scoreStats!.min).toBe(70)
    expect(scoreStats!.max).toBe(90)
    expect(scoreStats!.mean).toBe(80)
  })

  it("computes median for numeric columns", () => {
    const content = "val\n10\n20\n30\n40\n50"
    const result = parseCSV(content)
    const stats = getColumnStats(result)

    expect(stats[0].median).toBe(30)
  })

  it("handles even number of values for median", () => {
    const content = "val\n10\n20\n30\n40"
    const result = parseCSV(content)
    const stats = getColumnStats(result)

    expect(stats[0].median).toBe(25)
  })

  it("does not compute numeric stats for string columns", () => {
    const content = "name\nAlice\nBob"
    const result = parseCSV(content)
    const stats = getColumnStats(result)

    expect(stats[0].min).toBeUndefined()
    expect(stats[0].max).toBeUndefined()
    expect(stats[0].mean).toBeUndefined()
  })

  it("tracks null counts", () => {
    const content = "name,age\nJohn,30\nJane,\nBob,25"
    const result = parseCSV(content)
    const stats = getColumnStats(result)

    const ageStats = stats.find((s) => s.columnName === "age")
    expect(ageStats!.nullCount).toBe(1)
  })
})

describe("multi-line quoted fields", () => {
  it("parses quoted values containing newlines", () => {
    const content = 'name,bio\nJohn,"Line 1\nLine 2"\nJane,"Simple"'
    const result = parseCSV(content)

    expect(result.rowCount).toBe(2)
    expect(result.data[0][1]).toBe("Line 1\nLine 2")
    expect(result.data[1][1]).toBe("Simple")
  })

  it("handles CRLF in quoted values", () => {
    const content = 'a,b\n"hello\r\nworld",2'
    const result = parseCSV(content)

    expect(result.rowCount).toBe(1)
    expect(result.data[0][0]).toContain("hello")
    expect(result.data[0][0]).toContain("world")
  })
})
