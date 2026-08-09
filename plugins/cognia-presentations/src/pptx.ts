import JSZip from "jszip"
import {
  createPresentation,
  PPTX_MIME,
  type PresentationDeck,
  type PresentationSlide,
  type SlideElement,
} from "./model"

const EMU = 914400

export async function exportPptx(deck: PresentationDeck): Promise<Uint8Array> {
  const zip = new JSZip()
  const media: Array<{ path: string; base64: string }> = []
  zip.file("[Content_Types].xml", contentTypes(deck))
  zip.file("_rels/.rels", rootRelationships())
  zip.file("docProps/core.xml", coreProperties(deck))
  zip.file("docProps/app.xml", appProperties(deck))
  zip.file("ppt/presentation.xml", presentationXml(deck))
  zip.file("ppt/_rels/presentation.xml.rels", presentationRelationships(deck))
  zip.file(
    "ppt/presProps.xml",
    xmlHeader +
      `<p:presentationPr xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`
  )
  zip.file(
    "ppt/viewProps.xml",
    xmlHeader + `<p:viewPr xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`
  )
  zip.file(
    "ppt/tableStyles.xml",
    xmlHeader +
      `<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`
  )
  zip.file("ppt/theme/theme1.xml", themeXml(deck))
  zip.file("ppt/slideMasters/slideMaster1.xml", slideMasterXml())
  zip.file(
    "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    xmlHeader +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`
  )
  if (deck.slides.some((slide) => slide.speakerNotes)) {
    zip.file("ppt/notesMasters/notesMaster1.xml", notesMasterXml())
    zip.file(
      "ppt/notesMasters/_rels/notesMaster1.xml.rels",
      xmlHeader +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`
    )
  }
  zip.file("ppt/slideLayouts/slideLayout1.xml", slideLayoutXml())
  zip.file(
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
    xmlHeader +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`
  )
  deck.slides.forEach((slide, index) => {
    const rendered = slideXml(slide, deck, index + 1, media)
    zip.file(`ppt/slides/slide${index + 1}.xml`, rendered.xml)
    zip.file(`ppt/slides/_rels/slide${index + 1}.xml.rels`, rendered.rels)
    if (slide.speakerNotes) {
      zip.file(`ppt/notesSlides/notesSlide${index + 1}.xml`, notesXml(slide.speakerNotes))
      zip.file(
        `ppt/notesSlides/_rels/notesSlide${index + 1}.xml.rels`,
        xmlHeader +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="../slides/slide${index + 1}.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster" Target="../notesMasters/notesMaster1.xml"/></Relationships>`
      )
    }
  })
  for (const item of media) zip.file(item.path, item.base64, { base64: true })
  return new Uint8Array(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }))
}

export async function importPptx(
  bytes: Uint8Array,
  filename = "presentation.pptx"
): Promise<PresentationDeck> {
  const zip = await JSZip.loadAsync(bytes)
  if (!zip.file("ppt/presentation.xml"))
    throw new Error("Invalid PPTX package: ppt/presentation.xml is missing.")
  const deck = createPresentation(filename.replace(/\.pptx$/i, "") || "Presentation")
  deck.sourceFilename = filename
  const paths = Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    .sort((a, b) => slideNumber(a) - slideNumber(b))
  deck.slides = await Promise.all(
    paths.map(async (path, index) => {
      const xml = await zip.file(path)!.async("string")
      const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((match) => decodeXml(match[1]))
      return {
        id: `s${index + 1}`,
        title: texts[0] || `Slide ${index + 1}`,
        elements: texts.map((text, textIndex) => ({
          id: `t${textIndex + 1}`,
          type: "text" as const,
          x: 0.8,
          y: textIndex === 0 ? 0.5 : 1.4 + textIndex * 0.65,
          width: 11.7,
          height: 0.55,
          text,
          fontSize: textIndex === 0 ? 30 : 20,
        })),
      }
    })
  )
  if (Object.keys(zip.files).some((path) => path.startsWith("ppt/charts/")))
    deck.importedFeatures.push("native charts")
  if (Object.keys(zip.files).some((path) => path.startsWith("ppt/notesSlides/")))
    deck.importedFeatures.push("speaker notes")
  if (Object.keys(zip.files).some((path) => path.startsWith("ppt/media/")))
    deck.importedFeatures.push("embedded media")
  return deck
}

export async function validatePptxRoundTrip(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes)
  const presentation = zip.file("ppt/presentation.xml")
  if (!presentation) return { valid: false, slideCount: 0 }
  const xml = await presentation.async("string")
  return {
    valid: Boolean(
      zip.file("[Content_Types].xml") && zip.file("ppt/slideMasters/slideMaster1.xml")
    ),
    slideCount: [...xml.matchAll(/<p:sldId\b/g)].length,
  }
}

function slideXml(
  slide: PresentationSlide,
  deck: PresentationDeck,
  slideNumberValue: number,
  media: Array<{ path: string; base64: string }>
) {
  const relationships = [
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`,
  ]
  if (slide.speakerNotes) {
    relationships.push(
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${slideNumberValue}.xml"/>`
    )
  }
  let shapeId = 2
  const elements = slide.elements
    .flatMap((element) =>
      renderElement(element, shapeId++, deck, slideNumberValue, relationships, media)
    )
    .join("")
  const source = slide.sourceNote
    ? renderTextShape(
        {
          id: "source",
          type: "text",
          x: 0.5,
          y: deck.height - 0.35,
          width: deck.width - 1,
          height: 0.2,
          text: slide.sourceNote,
          fontSize: 9,
          color: "64748B",
        },
        shapeId++
      )
    : ""
  return {
    xml:
      xmlHeader +
      `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${elements}${source}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`,
    rels:
      xmlHeader +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships.join("")}</Relationships>`,
  }
}

function renderElement(
  element: SlideElement,
  id: number,
  deck: PresentationDeck,
  slideNumberValue: number,
  relationships: string[],
  media: Array<{ path: string; base64: string }>
): string[] {
  if (element.type === "text") return [renderTextShape(element, id)]
  if (element.type === "shape") return [renderShape(element, id)]
  if (element.type === "table")
    return element.rows.flatMap((row, rowIndex) =>
      row.map((cell, columnIndex) =>
        renderShape(
          {
            id: `${element.id}-${rowIndex}-${columnIndex}`,
            type: "shape",
            x: element.x + (columnIndex * element.width) / Math.max(row.length, 1),
            y: element.y + (rowIndex * element.height) / Math.max(element.rows.length, 1),
            width: element.width / Math.max(row.length, 1),
            height: element.height / Math.max(element.rows.length, 1),
            fill: rowIndex === 0 ? deck.theme.accent : "FFFFFF",
            line: "CBD5E1",
            text: cell,
          },
          id * 100 + rowIndex * 10 + columnIndex
        )
      )
    )
  if (element.type === "chart") {
    const max = Math.max(...element.values.map(Math.abs), 1)
    const bars = element.values.map((value, index) =>
      renderShape(
        {
          id: `${element.id}-${index}`,
          type: "shape",
          x: element.x + (index * element.width) / Math.max(element.values.length, 1),
          y: element.y + element.height * (1 - Math.abs(value) / max),
          width: (element.width / Math.max(element.values.length, 1)) * 0.75,
          height: (element.height * Math.abs(value)) / max,
          fill: deck.theme.accent,
          text: element.labels[index],
        },
        id * 100 + index
      )
    )
    return element.title
      ? [
          renderTextShape(
            {
              id: `${element.id}-title`,
              type: "text",
              x: element.x,
              y: element.y - 0.4,
              width: element.width,
              height: 0.35,
              text: element.title,
              fontSize: 18,
              bold: true,
            },
            id
          ),
          ...bars,
        ]
      : bars
  }
  const extension = element.mimeType === "image/png" ? "png" : "jpg"
  const mediaIndex = media.length + 1
  media.push({ path: `ppt/media/image${mediaIndex}.${extension}`, base64: element.dataBase64 })
  const relId = `rId${relationships.length + 1}`
  relationships.push(
    `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${mediaIndex}.${extension}"/>`
  )
  return [
    `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${escapeXml(element.alt)}" descr="${escapeXml(element.alt)}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${transform(element)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`,
  ]
}

function renderTextShape(element: Extract<SlideElement, { type: "text" }>, id: number) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escapeXml(element.id)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${transform(element)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square"/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="${Math.round((element.fontSize ?? 24) * 100)}"${element.bold ? ' b="1"' : ""}><a:solidFill><a:srgbClr val="${color(element.color ?? "0F172A")}"/></a:solidFill></a:rPr><a:t>${escapeXml(element.text)}</a:t></a:r><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`
}
function renderShape(element: Extract<SlideElement, { type: "shape" }>, id: number) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escapeXml(element.id)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${transform(element)}<a:prstGeom prst="${element.shape ?? "rect"}"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${color(element.fill ?? "FFFFFF")}"/></a:solidFill><a:ln><a:solidFill><a:srgbClr val="${color(element.line ?? "CBD5E1")}"/></a:solidFill></a:ln></p:spPr>${element.text ? `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="1600"/><a:t>${escapeXml(element.text)}</a:t></a:r></a:p></p:txBody>` : ""}</p:sp>`
}
function transform(element: { x: number; y: number; width: number; height: number }) {
  return `<a:xfrm><a:off x="${Math.round(element.x * EMU)}" y="${Math.round(element.y * EMU)}"/><a:ext cx="${Math.round(element.width * EMU)}" cy="${Math.round(element.height * EMU)}"/></a:xfrm>`
}
function presentationXml(deck: PresentationDeck) {
  const notesMasterId = deck.slides.some((slide) => slide.speakerNotes)
    ? `<p:notesMasterIdLst><p:notesMasterId r:id="rId${deck.slides.length + 5}"/></p:notesMasterIdLst>`
    : ""
  return (
    xmlHeader +
    `<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>${notesMasterId}<p:sldIdLst>${deck.slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join("")}</p:sldIdLst><p:sldSz cx="${Math.round(deck.width * EMU)}" cy="${Math.round(deck.height * EMU)}" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`
  )
}
function presentationRelationships(deck: PresentationDeck) {
  const notesMasterRelationship = deck.slides.some((slide) => slide.speakerNotes)
    ? `<Relationship Id="rId${deck.slides.length + 5}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster" Target="notesMasters/notesMaster1.xml"/>`
    : ""
  return (
    xmlHeader +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>${deck.slides.map((_, i) => `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join("")}<Relationship Id="rId${deck.slides.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps" Target="presProps.xml"/><Relationship Id="rId${deck.slides.length + 3}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps" Target="viewProps.xml"/><Relationship Id="rId${deck.slides.length + 4}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles" Target="tableStyles.xml"/>${notesMasterRelationship}</Relationships>`
  )
}
function contentTypes(deck: PresentationDeck) {
  const notesTypes = deck.slides
    .map((slide, index) =>
      slide.speakerNotes
        ? `<Override PartName="/ppt/notesSlides/notesSlide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`
        : ""
    )
    .join("")
  const notesMasterType = deck.slides.some((slide) => slide.speakerNotes)
    ? `<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/>`
    : ""
  return (
    xmlHeader +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${deck.slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("")}${notesTypes}${notesMasterType}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`
  )
}
function rootRelationships() {
  return (
    xmlHeader +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`
  )
}
function coreProperties(deck: PresentationDeck) {
  return (
    xmlHeader +
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${escapeXml(deck.title)}</dc:title><dc:creator>Cognia</dc:creator></cp:coreProperties>`
  )
}
function appProperties(deck: PresentationDeck) {
  return (
    xmlHeader +
    `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Cognia</Application><Slides>${deck.slides.length}</Slides></Properties>`
  )
}
function themeXml(deck: PresentationDeck) {
  return (
    xmlHeader +
    `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Cognia"><a:themeElements><a:clrScheme name="Cognia"><a:dk1><a:srgbClr val="${color(deck.theme.foreground)}"/></a:dk1><a:lt1><a:srgbClr val="${color(deck.theme.background)}"/></a:lt1><a:accent1><a:srgbClr val="${color(deck.theme.accent)}"/></a:accent1>${[2, 3, 4, 5, 6].map((n) => `<a:accent${n}><a:srgbClr val="${color(deck.theme.accent)}"/></a:accent${n}>`).join("")}<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Cognia"><a:majorFont><a:latin typeface="${escapeXml(deck.theme.fontFamily)}"/></a:majorFont><a:minorFont><a:latin typeface="${escapeXml(deck.theme.fontFamily)}"/></a:minorFont></a:fontScheme><a:fmtScheme name="Cognia"><a:fillStyleLst/><a:lnStyleLst/><a:effectStyleLst/><a:bgFillStyleLst/></a:fmtScheme></a:themeElements></a:theme>`
  )
}
function slideMasterXml() {
  return (
    xmlHeader +
    `<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst><p:sldLayoutId id="1" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`
  )
}
function slideLayoutXml() {
  return (
    xmlHeader +
    `<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`
  )
}
function notesXml(text: string) {
  return (
    xmlHeader +
    `<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${escapeXml(text)}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`
  )
}
function notesMasterXml() {
  return (
    xmlHeader +
    `<p:notesMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:hf hdr="1" ftr="1" dt="1" sldNum="1"/><p:notesStyle/></p:notesMaster>`
  )
}
function slideNumber(path: string) {
  return Number(path.match(/slide(\d+)/)?.[1] ?? 0)
}
function color(value: string) {
  return value.replace(/^#/, "").toUpperCase()
}
function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}
function decodeXml(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
}
const xmlHeader = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
export { PPTX_MIME }
