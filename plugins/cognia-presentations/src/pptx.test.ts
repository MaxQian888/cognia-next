import JSZip from "jszip"
import { applyPresentationOperations, createPresentation } from "./model"
import { exportPptx, importPptx, validatePptxRoundTrip } from "./pptx"

const RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
const OFFICE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const C_NS = "http://schemas.openxmlformats.org/drawingml/2006/chart"

it("exports a native PPTX package and reopens slide text", async () => {
  const deck = applyPresentationOperations(createPresentation("Launch"), [
    {
      op: "addSlide",
      title: "Overview",
      speakerNotes: "Open with the customer outcome.",
      elements: [
        {
          id: "t1",
          type: "text",
          x: 1,
          y: 1,
          width: 8,
          height: 1,
          text: "Launch plan",
          fontSize: 28,
        },
        {
          id: "c1",
          type: "chart",
          x: 1,
          y: 2,
          width: 8,
          height: 3,
          labels: ["A", "B"],
          values: [10, 20],
        },
      ],
    },
  ])
  const bytes = await exportPptx(deck)
  await expect(validatePptxRoundTrip(bytes)).resolves.toEqual({ valid: true, slideCount: 1 })
  const imported = await importPptx(bytes, "launch.pptx")
  // The core-properties title wins over the filename.
  expect(imported.title).toBe("Launch")
  expect(imported.slides).toHaveLength(1)
  expect(imported.slides[0].speakerNotes).toContain("Open with the customer outcome.")
  expect(imported.slides[0].elements).toEqual(
    expect.arrayContaining([expect.objectContaining({ type: "text", text: "Launch plan" })])
  )
  // Text geometry survives the round trip within EMU rounding.
  const text = imported.slides[0].elements.find((el) => el.type === "text")
  expect(text?.x).toBeCloseTo(1, 1)
  expect(text?.y).toBeCloseTo(1, 1)
  // Chart bars export as shapes; nothing is flagged as lost on our own output.
  expect(imported.importedFeatures).toEqual([])
})

it("rejects a non-ZIP payload", async () => {
  await expect(importPptx(new TextEncoder().encode("not a zip"))).rejects.toThrow(
    "not a readable ZIP"
  )
})

it("imports slide order, geometry, images, tables, charts, and notes from a real package", async () => {
  const zip = new JSZip()
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/></Types>`
  )
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0"?><Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${OFFICE_REL}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`
  )
  zip.file(
    "docProps/core.xml",
    `<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Quarterly &amp; Results</dc:title></cp:coreProperties>`
  )
  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0"?><p:presentation xmlns:a="${A_NS}" xmlns:r="${R_NS}" xmlns:p="${P_NS}"><p:sldMasterIdLst/><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`
  )
  // Deliberately reversed: slide2.xml is first in sldIdLst order.
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    `<?xml version="1.0"?><Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${OFFICE_REL}/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId2" Type="${OFFICE_REL}/slide" Target="slides/slide2.xml"/><Relationship Id="rId3" Type="${OFFICE_REL}/slide" Target="slides/slide1.xml"/></Relationships>`
  )
  zip.file(
    "ppt/slides/slide1.xml",
    `<?xml version="1.0"?><p:sld xmlns:a="${A_NS}" xmlns:r="${R_NS}" xmlns:p="${P_NS}" xmlns:c="${C_NS}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>` +
      `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="457200"/><a:ext cx="7315200" cy="685800"/></a:xfrm><a:prstGeom prst="rect"/><a:noFill/></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="en-US" sz="3200" b="1"><a:solidFill><a:srgbClr val="112233"/></a:solidFill></a:rPr><a:t>First &lt;Deck&gt;</a:t></a:r></a:p></p:txBody></p:sp>` +
      `<p:pic><p:nvPicPr><p:cNvPr id="4" name="logo" descr="Company logo"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/></p:blipFill><p:spPr><a:xfrm><a:off x="914400" y="1828800"/><a:ext cx="1828800" cy="914400"/></a:xfrm></p:spPr></p:pic>` +
      `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="914400" y="2743200"/><a:ext cx="4572000" cy="1143000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>H1</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>H2</a:t></a:r></a:p></a:txBody></a:tc></a:tr><a:tr><a:tc><a:txBody><a:p><a:r><a:t>A</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>B</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>` +
      `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="6" name="Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="5486400" y="2743200"/><a:ext cx="5486400" cy="2743200"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="rId3"/></a:graphicData></a:graphic></p:graphicFrame>` +
      `</p:spTree></p:cSld><p:transition spd="slow"/></p:sld>`
  )
  zip.file(
    "ppt/slides/_rels/slide1.xml.rels",
    `<?xml version="1.0"?><Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${OFFICE_REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${OFFICE_REL}/image" Target="../media/image1.png"/><Relationship Id="rId3" Type="${OFFICE_REL}/chart" Target="../charts/chart1.xml"/><Relationship Id="rId4" Type="${OFFICE_REL}/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`
  )
  zip.file(
    "ppt/slides/slide2.xml",
    `<?xml version="1.0"?><p:sld xmlns:a="${A_NS}" xmlns:r="${R_NS}" xmlns:p="${P_NS}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="457200"/><a:ext cx="7315200" cy="685800"/></a:xfrm><a:noFill/></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:t>Second</a:t></a:r></a:p></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
  )
  zip.file(
    "ppt/slides/_rels/slide2.xml.rels",
    `<?xml version="1.0"?><Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${OFFICE_REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`
  )
  zip.file(
    "ppt/charts/chart1.xml",
    `<?xml version="1.0"?><c:chartSpace xmlns:c="${C_NS}" xmlns:a="${A_NS}"><c:chart><c:title><a:t>Revenue</a:t></c:title><c:plotArea><c:barChart><c:ser><c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="1"><c:v>20</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>`
  )
  zip.file(
    "ppt/notesSlides/notesSlide1.xml",
    `<?xml version="1.0"?><p:notes xmlns:a="${A_NS}" xmlns:p="${P_NS}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>Talk about pricing.</a:t></a:r></a:p></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`
  )
  zip.file("ppt/media/image1.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]))

  const deck = await importPptx(new Uint8Array(await zip.generateAsync({ type: "uint8array" })))
  expect(deck.title).toBe("Quarterly & Results")
  expect(deck.width).toBeCloseTo(13.33, 1)
  expect(deck.height).toBeCloseTo(7.5, 1)
  // sldIdLst order wins over filename order.
  expect(deck.slides.map((slide) => slide.title)).toEqual(["Second", "First <Deck>"])

  const first = deck.slides[1]
  const text = first.elements.find((el) => el.type === "text")
  expect(text).toMatchObject({ fontSize: 32, bold: true, color: "112233" })
  const image = first.elements.find((el) => el.type === "image")
  expect(image).toMatchObject({ type: "image", mimeType: "image/png", alt: "Company logo" })
  const table = first.elements.find((el) => el.type === "table")
  expect(table).toMatchObject({
    type: "table",
    rows: [
      ["H1", "H2"],
      ["A", "B"],
    ],
  })
  const chart = first.elements.find((el) => el.type === "chart")
  expect(chart).toMatchObject({ type: "chart", labels: ["Q1", "Q2"], values: [10, 20] })
  expect(first.speakerNotes).toBe("Talk about pricing.")
  // The chart part was consumed; only the transition remains flagged.
  expect(deck.importedFeatures).toEqual(["animations/transitions"])
})
