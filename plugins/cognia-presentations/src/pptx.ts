import JSZip from "jszip"
import {
  createPresentation,
  normalizeHexColor,
  sniffImageMime,
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

const MAX_IMPORT_SLIDES = 500
const MAX_IMPORT_MEDIA_BYTES = 16 * 1024 * 1024
const IMAGE_MIME_BY_EXTENSION: Record<string, "image/png" | "image/jpeg"> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
}

interface PackageRelationship {
  type: string
  target: string
}

export async function importPptx(
  bytes: Uint8Array,
  filename = "presentation.pptx"
): Promise<PresentationDeck> {
  const zip = await JSZip.loadAsync(bytes).catch(() => {
    throw new Error("Invalid PPTX package: not a readable ZIP archive.")
  })
  const presentationXml = await zip.file("ppt/presentation.xml")?.async("string")
  if (!presentationXml) throw new Error("Invalid PPTX package: ppt/presentation.xml is missing.")

  const features = new Set<string>()
  const deck = createPresentation((await packageTitle(zip)) || baseName(filename))
  deck.sourceFilename = filename

  const slideSize = presentationXml.match(/<p:sldSz\b[^>]*\/>?/)
  if (slideSize) {
    const cx = numberAttr(slideSize[0], "cx")
    const cy = numberAttr(slideSize[0], "cy")
    if (cx && cy) {
      deck.width = round2(cx / EMU)
      deck.height = round2(cy / EMU)
    }
  }

  const slidePaths = await slideOrder(zip, presentationXml)
  if (slidePaths.length > MAX_IMPORT_SLIDES) features.add("truncated slide list")
  // JSZip materialises intermediate directories as `dir: true` entries; only
  // real files count when scanning package parts.
  const partPaths = Object.keys(zip.files).filter((path) => !zip.files[path].dir)
  const chartParts = new Set(partPaths.filter((path) => /^ppt\/charts\/chart\d+\.xml$/.test(path)))
  const importedChartParts = new Set<string>()

  deck.slides = []
  for (const [index, path] of slidePaths.slice(0, MAX_IMPORT_SLIDES).entries()) {
    const xml = await zip.file(path)!.async("string")
    const rels = await relationships(zip, relsPathFor(path))
    const slide = await importSlide(zip, xml, rels, deck, index, features, importedChartParts)
    if (/<p:timing[\s>]/.test(xml) || /<p:transition[\s>]/.test(xml))
      features.add("animations/transitions")
    deck.slides.push(slide)
  }

  const mediaPaths = partPaths.filter((path) => /^ppt\/media\//.test(path))
  if (mediaPaths.some((path) => !IMAGE_MIME_BY_EXTENSION[fileExtension(path)]))
    features.add("embedded media")
  if (chartParts.size > importedChartParts.size) features.add("native charts")
  if (partPaths.some((path) => /^ppt\/diagrams\//.test(path))) features.add("SmartArt diagrams")
  if (partPaths.some((path) => /^ppt\/embeddings\//.test(path))) features.add("embedded objects")
  if (partPaths.some((path) => /^ppt\/comments\//.test(path))) features.add("comments")
  deck.importedFeatures = [...features]
  return deck
}

async function importSlide(
  zip: JSZip,
  xml: string,
  rels: Map<string, PackageRelationship>,
  deck: PresentationDeck,
  index: number,
  features: Set<string>,
  importedChartParts: Set<string>
): Promise<PresentationSlide> {
  const elements: SlideElement[] = []
  let fallbackY = 0.5
  let elementSequence = 0
  const nextId = () => `e${++elementSequence}`
  const blocks =
    xml.match(/<p:(?:sp|pic|graphicFrame)\b[\s\S]*?<\/p:(?:sp|pic|graphicFrame)>/g) ?? []
  for (const block of blocks) {
    const tag = block.match(/^<p:(sp|pic|graphicFrame)\b/)?.[1]
    const geometry = blockGeometry(block, deck, fallbackY)
    fallbackY = geometry.y + geometry.height + 0.25
    if (tag === "sp") {
      const element = importShape(block, geometry, nextId())
      if (element) elements.push(element)
    } else if (tag === "pic") {
      const element = await importPicture(zip, block, geometry, rels, nextId(), features)
      if (element) elements.push(element)
    } else if (tag === "graphicFrame") {
      const element = await importGraphicFrame(
        zip,
        block,
        geometry,
        rels,
        nextId(),
        importedChartParts
      )
      if (element) elements.push(element)
    }
  }
  const titled = elements.find(
    (element): element is Extract<SlideElement, { type: "text" | "shape" }> =>
      (element.type === "text" || element.type === "shape") &&
      typeof element.text === "string" &&
      element.text.trim().length > 0
  )
  const title = titled?.text?.trim() || `Slide ${index + 1}`
  const notesTarget = [...rels.values()].find((rel) => rel.type.endsWith("/notesSlide"))?.target
  const speakerNotes = notesTarget
    ? await importNotes(zip, resolvePart("ppt/slides", notesTarget))
    : undefined
  return {
    id: `s${index + 1}`,
    title,
    elements,
    ...(speakerNotes ? { speakerNotes } : {}),
  }
}

/** A `p:sp` becomes a text element for text boxes, otherwise a shape. */
function importShape(
  block: string,
  geometry: { x: number; y: number; width: number; height: number },
  id: string
): SlideElement | null {
  const paragraphs = blockParagraphs(block)
  const text = paragraphs.join("\n")
  const isTextBox = /\btxBox="1"/.test(block) || /<a:noFill\s*\/>/.test(spPrOf(block))
  const preset = block.match(/<a:prstGeom\s+prst="([^"]+)"/)?.[1]
  const fill = shapeFill(block)
  if (isTextBox || (!fill && (!preset || preset === "rect"))) {
    if (!text.trim()) return null
    const runProps = block.match(/<a:rPr\b[^>]*>/)?.[0] ?? ""
    const size = numberAttr(runProps, "sz")
    return {
      id,
      type: "text",
      ...geometry,
      text,
      ...(size ? { fontSize: size / 100 } : {}),
      ...(/\bb="1"/.test(runProps) ? { bold: true } : {}),
      ...(runColor(block) ? { color: runColor(block) } : {}),
    }
  }
  const shape = preset === "ellipse" || preset === "roundRect" ? preset : ("rect" as const)
  return {
    id,
    type: "shape",
    ...geometry,
    shape,
    ...(fill ? { fill } : {}),
    ...(shapeLine(block) ? { line: shapeLine(block) } : {}),
    ...(text.trim() ? { text } : {}),
  }
}

async function importPicture(
  zip: JSZip,
  block: string,
  geometry: { x: number; y: number; width: number; height: number },
  rels: Map<string, PackageRelationship>,
  id: string,
  features: Set<string>
): Promise<SlideElement | null> {
  const embed = block.match(/<a:blip\b[^>]*\br:embed="([^"]+)"/)?.[1]
  const target = embed ? rels.get(embed)?.target : undefined
  if (!target) return null
  const path = resolvePart("ppt/slides", target)
  const file = zip.file(path)
  if (!file || !IMAGE_MIME_BY_EXTENSION[fileExtension(path)]) {
    features.add("unsupported media")
    return null
  }
  const bytes = await file.async("uint8array")
  if (bytes.byteLength > MAX_IMPORT_MEDIA_BYTES) {
    features.add("oversized media")
    return null
  }
  // Trust the bytes, not the part name: a `.png` part holding a JPEG (or
  // something else entirely) would otherwise be re-exported mislabelled.
  const mimeType = sniffImageMime(bytes)
  if (!mimeType) {
    features.add("unsupported media")
    return null
  }
  const name = block.match(/<p:cNvPr\b[^>]*\bname="([^"]*)"/)?.[1]
  const descr = block.match(/<p:cNvPr\b[^>]*\bdescr="([^"]*)"/)?.[1]
  const alt = decodeXml(descr || name || file.name || "image")
  return {
    id,
    type: "image",
    ...geometry,
    dataBase64: base64Encode(bytes),
    mimeType,
    alt,
  }
}

async function importGraphicFrame(
  zip: JSZip,
  block: string,
  geometry: { x: number; y: number; width: number; height: number },
  rels: Map<string, PackageRelationship>,
  id: string,
  importedChartParts: Set<string>
): Promise<SlideElement | null> {
  if (/<a:tbl>[\s\S]*?<\/a:tbl>/.test(block)) {
    const rows = [...block.matchAll(/<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/g)].map((row) =>
      [...row[1].matchAll(/<a:tc\b[^>]*>([\s\S]*?)<\/a:tc>/g)].map((cell) =>
        cellTexts(cell[1]).join(" ")
      )
    )
    if (rows.length) return { id, type: "table", ...geometry, rows }
    return null
  }
  const chartRel = block.match(/<c:chart\b[^>]*\br:id="([^"]+)"/)?.[1]
  const chartTarget = chartRel ? rels.get(chartRel)?.target : undefined
  if (!chartTarget) return null
  const chartPath = resolvePart("ppt/slides", chartTarget)
  const chartXml = await zip.file(chartPath)?.async("string")
  if (!chartXml) return null
  importedChartParts.add(chartPath)
  return importChart(chartXml, geometry, id)
}

/** First `c:ser` of a chart part → a native chart element (categories + values). */
function importChart(
  xml: string,
  geometry: { x: number; y: number; width: number; height: number },
  id: string
): SlideElement | null {
  const series = xml.match(/<c:ser>[\s\S]*?<\/c:ser>/)?.[0]
  if (!series) return null
  const cat = series.match(/<c:cat>[\s\S]*?<\/c:cat>/)?.[0] ?? ""
  const val = series.match(/<c:val>[\s\S]*?<\/c:val>/)?.[0] ?? ""
  const labels = cachedPoints(cat).map((point) => point.text)
  const values = cachedPoints(val).map((point) => Number(point.text))
  if (!labels.length || labels.length !== values.length || values.some((v) => !Number.isFinite(v)))
    return null
  const title = xml.match(/<c:title>[\s\S]*?<\/c:title>/)?.[0]
  return {
    id,
    type: "chart",
    ...geometry,
    labels,
    values,
    ...(title ? { title: cellTexts(title).join(" ").trim() || undefined } : {}),
  }
}

async function importNotes(zip: JSZip, path: string): Promise<string | undefined> {
  const xml = await zip.file(path)?.async("string")
  if (!xml) return undefined
  const body = xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) ?? []
  // The notes slide's first shapes are placeholders (slide image, header); the
  // body text lives in the last text-bearing shape.
  const text = body
    .map((shape) => blockParagraphs(shape).join("\n"))
    .filter(Boolean)
    .join("\n")
  return text.trim() || undefined
}

/** `<a:t>` runs grouped per `<a:p>` paragraph. */
function blockParagraphs(block: string): string[] {
  const paragraphs = block.match(/<a:p>[\s\S]*?<\/a:p>/g) ?? [block]
  return paragraphs
    .map((paragraph) => cellTexts(paragraph).join(""))
    .filter((text) => text.length > 0)
}

function cellTexts(xml: string): string[] {
  return [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((match) => decodeXml(match[1]))
}

function spPrOf(block: string): string {
  return block.match(/<p:spPr\b[^>]*>[\s\S]*?<\/p:spPr>/)?.[0] ?? ""
}

function shapeFill(block: string): string | undefined {
  const spPr = spPrOf(block)
  return spPr.match(/<a:solidFill>\s*<a:srgbClr val="([0-9A-Fa-f]{6})"/)?.[1]?.toUpperCase()
}

function shapeLine(block: string): string | undefined {
  const spPr = spPrOf(block)
  return spPr.match(/<a:ln\b[^>]*>[\s\S]*?<a:srgbClr val="([0-9A-Fa-f]{6})"/)?.[1]?.toUpperCase()
}

function runColor(block: string): string | undefined {
  return block
    .match(/<a:rPr\b[^>]*>[\s\S]*?<a:solidFill>\s*<a:srgbClr val="([0-9A-Fa-f]{6})"/)?.[1]
    ?.toUpperCase()
}

function cachedPoints(xml: string): Array<{ idx: number; text: string }> {
  return [...xml.matchAll(/<c:pt\s+idx="(\d+)"[^>]*>\s*<c:v>([\s\S]*?)<\/c:v>\s*<\/c:pt>/g)]
    .map((match) => ({ idx: Number(match[1]), text: decodeXml(match[2]) }))
    .sort((a, b) => a.idx - b.idx)
}

function blockGeometry(
  block: string,
  deck: PresentationDeck,
  fallbackY: number
): { x: number; y: number; width: number; height: number } {
  const xfrm = block.match(/<[ap]:xfrm\b[^>]*>([\s\S]*?)<\/[ap]:xfrm>/)?.[1] ?? ""
  const off = xfrm.match(/<a:off\b[^>]*\/>/)?.[0] ?? ""
  const ext = xfrm.match(/<a:ext\b[^>]*\/>/)?.[0] ?? ""
  const x = numberAttr(off, "x")
  const y = numberAttr(off, "y")
  const cx = numberAttr(ext, "cx")
  const cy = numberAttr(ext, "cy")
  return {
    x: x !== undefined ? round2(x / EMU) : 0.8,
    y: y !== undefined ? round2(y / EMU) : fallbackY,
    width: cx !== undefined ? round2(cx / EMU) : Math.max(deck.width - 1.6, 1),
    height: cy !== undefined ? round2(cy / EMU) : 0.6,
  }
}

async function relationships(
  zip: JSZip,
  relsPath: string
): Promise<Map<string, PackageRelationship>> {
  const map = new Map<string, PackageRelationship>()
  const xml = await zip.file(relsPath)?.async("string")
  if (!xml) return map
  for (const match of xml.matchAll(/<Relationship\b[^>]*\/>/g)) {
    const id = match[0].match(/\bId="([^"]+)"/)?.[1]
    const type = match[0].match(/\bType="([^"]+)"/)?.[1]
    const target = match[0].match(/\bTarget="([^"]+)"/)?.[1]
    if (id && type && target) map.set(id, { type, target })
  }
  return map
}

/** Ordered slide part paths from `p:sldIdLst` → presentation rels. */
async function slideOrder(zip: JSZip, presentationXml: string): Promise<string[]> {
  const rels = await relationships(zip, "ppt/_rels/presentation.xml.rels")
  const ordered = [...presentationXml.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"[^>]*\/>/g)]
    .map((match) => rels.get(match[1]))
    .filter((rel): rel is PackageRelationship => Boolean(rel))
    .filter((rel) => rel.type.endsWith("/slide"))
    .map((rel) => resolvePart("ppt", rel.target))
    .filter((path) => Boolean(zip.file(path)))
  if (ordered.length) return ordered
  return Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    .sort((a, b) => slideNumber(a) - slideNumber(b))
}

function relsPathFor(partPath: string): string {
  const slash = partPath.lastIndexOf("/")
  return `${partPath.slice(0, slash)}/_rels/${partPath.slice(slash + 1)}.rels`
}

/** Resolve a relationship target relative to its owning part's directory. */
function resolvePart(baseDir: string, target: string): string {
  const segments = [...baseDir.split("/"), ...target.split("/")]
  const resolved: string[] = []
  for (const segment of segments) {
    if (!segment || segment === ".") continue
    if (segment === "..") resolved.pop()
    else resolved.push(segment)
  }
  return resolved.join("/")
}

async function packageTitle(zip: JSZip): Promise<string | undefined> {
  const xml = await zip.file("docProps/core.xml")?.async("string")
  const title = xml?.match(/<dc:title>([\s\S]*?)<\/dc:title>/)?.[1]
  return title ? decodeXml(title).trim() || undefined : undefined
}

function baseName(filename: string): string {
  return filename.replace(/\.pptx$/i, "").trim() || "Presentation"
}

function fileExtension(path: string): string {
  const dot = path.lastIndexOf(".")
  return dot >= 0 ? path.slice(dot + 1).toLowerCase() : ""
}

function numberAttr(tag: string, name: string): number | undefined {
  const value = tag.match(new RegExp(`\\b${name}="(-?\\d+)"`))?.[1]
  return value === undefined ? undefined : Number(value)
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function base64Encode(bytes: Uint8Array): string {
  let binary = ""
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
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
  const allocId = () => shapeId++
  const elements = slide.elements
    .flatMap((element) =>
      renderElement(element, allocId, deck, slideNumberValue, relationships, media)
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
        allocId()
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
  allocId: () => number,
  deck: PresentationDeck,
  slideNumberValue: number,
  relationships: string[],
  media: Array<{ path: string; base64: string }>
): string[] {
  if (element.type === "text") return [renderTextShape(element, allocId())]
  if (element.type === "shape") return [renderShape(element, allocId())]
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
          allocId()
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
        allocId()
      )
    )
    return element.title
      ? [
          renderTextShape(
            {
              id: `${element.id}-title`,
              type: "text",
              x: element.x,
              y: Math.max(element.y - 0.4, 0.05),
              width: element.width,
              height: 0.35,
              text: element.title,
              fontSize: 18,
              bold: true,
            },
            allocId()
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
    `<p:pic><p:nvPicPr><p:cNvPr id="${allocId()}" name="${escapeXml(element.alt)}" descr="${escapeXml(element.alt)}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${transform(element)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`,
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
  return normalizeHexColor(value, "000000")
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
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
}
const xmlHeader = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
export { PPTX_MIME }
