import {
  generateArtifactTitle,
  enhancedDetectArtifactType,
  type ArtifactTitleMessages,
} from "./utils"

const TRANSLATED_MESSAGES: ArtifactTitleMessages = {
  codeSnippet: "代码片段",
  codeWithLanguage: (language: string) => `${language} 代码`,
  document: "文档",
  svgGraphic: "SVG 图形",
  htmlPage: "HTML 页面",
  reactComponent: "React 组件",
  mermaidDiagram: "Mermaid 图表",
  dataChart: "数据图表",
  mathExpression: "数学表达式",
  jupyterNotebook: "Jupyter Notebook",
  untitled: "未命名",
  mermaidTypes: {
    graph: "流程图",
    flowchart: "流程图",
    sequenceDiagram: "时序图",
    classDiagram: "类图",
    stateDiagram: "状态图",
    erDiagram: "实体关系图",
    gantt: "甘特图",
    pie: "饼图",
    mindmap: "思维导图",
    gitGraph: "Git 图",
    journey: "用户旅程",
  },
}

describe("generateArtifactTitle", () => {
  it("extracts an HTML <title>", () => {
    expect(generateArtifactTitle("<html><title>My Page</title></html>", "html")).toBe("My Page")
  })

  it("extracts a React export name", () => {
    expect(generateArtifactTitle("export default function HeroBanner() {}", "react")).toBe(
      "HeroBanner"
    )
  })

  it("extracts a function/const/class name when no export", () => {
    expect(generateArtifactTitle("function compute(x) { return x }", "code")).toBe("compute")
    expect(generateArtifactTitle("const Greeter = () => null", "code")).toBe("Greeter")
    expect(generateArtifactTitle("class Widget {}", "code")).toBe("Widget")
  })

  it("recognizes Mermaid diagram types", () => {
    expect(generateArtifactTitle("sequenceDiagram\nA->>B: hi", "mermaid")).toBe("Sequence Diagram")
    expect(generateArtifactTitle("graph TD\nA-->B", "mermaid")).toBe("Flowchart")
  })

  it("falls back to a Mermaid generic title when no header is present", () => {
    expect(generateArtifactTitle("not-a-known-mermaid-keyword", "mermaid")).toBe("Mermaid Diagram")
  })

  it("uses type-defaults when content has no name", () => {
    expect(generateArtifactTitle("hello world", "document")).toBe("Document")
    expect(generateArtifactTitle("hello world", "svg")).toBe("SVG Graphic")
    expect(generateArtifactTitle("hello world", "math")).toBe("Math Expression")
    expect(generateArtifactTitle("hello world", "jupyter")).toBe("Jupyter Notebook")
    expect(generateArtifactTitle("hello world", "chart")).toBe("Data Chart")
    expect(generateArtifactTitle("hello world", "html")).toBe("HTML Page")
    expect(generateArtifactTitle("hello world", "react")).toBe("React Component")
  })

  it("uses language display name as fallback when no type is given", () => {
    expect(generateArtifactTitle("just some text", undefined, "javascript")).toBe("JavaScript")
    expect(generateArtifactTitle("just some text", undefined, "klingon")).toBe("Klingon Code")
  })

  it("includes language in default code title", () => {
    expect(generateArtifactTitle("just some text", "code", "python")).toBe("Python Code")
    expect(generateArtifactTitle("just some text", "code")).toBe("Code Snippet")
  })

  it("returns Code Snippet when nothing identifies the content", () => {
    expect(generateArtifactTitle("just some text")).toBe("Code Snippet")
  })

  describe("when messages are passed", () => {
    it("uses translated default titles for typed artifacts", () => {
      expect(generateArtifactTitle("hello world", "document", undefined, TRANSLATED_MESSAGES)).toBe(
        "文档"
      )
      expect(generateArtifactTitle("hello world", "react", undefined, TRANSLATED_MESSAGES)).toBe(
        "React 组件"
      )
      expect(generateArtifactTitle("hello world", "jupyter", undefined, TRANSLATED_MESSAGES)).toBe(
        "Jupyter Notebook"
      )
    })

    it("uses the codeWithLanguage formatter for typed code with a language", () => {
      expect(generateArtifactTitle("hello world", "code", "python", TRANSLATED_MESSAGES)).toBe(
        "Python 代码"
      )
    })

    it("uses translated mermaid diagram names", () => {
      expect(
        generateArtifactTitle(
          "sequenceDiagram\nA->>B: hi",
          "mermaid",
          undefined,
          TRANSLATED_MESSAGES
        )
      ).toBe("时序图")
      expect(
        generateArtifactTitle("graph TD\nA-->B", "mermaid", undefined, TRANSLATED_MESSAGES)
      ).toBe("流程图")
    })

    it("falls back to translated mermaidDiagram when keyword is unknown", () => {
      expect(
        generateArtifactTitle(
          "not-a-known-mermaid-keyword",
          "mermaid",
          undefined,
          TRANSLATED_MESSAGES
        )
      ).toBe("Mermaid 图表")
    })

    it("returns the translated codeSnippet when nothing identifies content", () => {
      expect(
        generateArtifactTitle("just some text", undefined, undefined, TRANSLATED_MESSAGES)
      ).toBe("代码片段")
    })

    it("preserves brand display names for known languages without type", () => {
      expect(
        generateArtifactTitle("just some text", undefined, "javascript", TRANSLATED_MESSAGES)
      ).toBe("JavaScript")
    })

    it("uses codeWithLanguage formatter for unknown languages without type", () => {
      expect(
        generateArtifactTitle("just some text", undefined, "klingon", TRANSLATED_MESSAGES)
      ).toBe("Klingon 代码")
    })
  })
})

describe("enhancedDetectArtifactType", () => {
  it("upgrades JSX/TSX code to react when content has React patterns", () => {
    const code = "import React from 'react'\nfunction X(){return <div/>}"
    expect(enhancedDetectArtifactType("code", "tsx", code)).toBe("react")
    expect(enhancedDetectArtifactType("code", "jsx", code)).toBe("react")
  })

  it("upgrades JSON code to chart when content matches chart patterns", () => {
    const data = '[{"name":"a","value":1},{"name":"b","value":2}]'
    expect(enhancedDetectArtifactType("code", "json", data)).toBe("chart")
  })

  it("leaves non-code base types alone", () => {
    expect(enhancedDetectArtifactType("html", "html", "<html></html>")).toBe("html")
  })

  it("does not upgrade tsx without React patterns", () => {
    expect(enhancedDetectArtifactType("code", "tsx", "const x = 1")).toBe("code")
  })

  it("returns the base type when no content provided", () => {
    expect(enhancedDetectArtifactType("code", "javascript")).toBe("code")
  })
})
