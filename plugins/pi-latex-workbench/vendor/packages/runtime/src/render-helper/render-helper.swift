/**
 * render-helper — Swift/PDFKit page renderer + inspector (M4).
 *
 * argv: render-helper <pdfPath> <mode> <outDir> <dpi>
 *   mode "json":      writes ONE JSON object to <outDir>/render.json —
 *                   {pageCount, pages:[{page, size:{w,h}, text,
 *                     lineBoxes:[{rect,text}], links:[{rect,url}], fonts[]}]}
 *   mode "pages":     writes <outDir>/page-<n>.png per page at <dpi>
 *                   (72 = screen, 144 = detail) plus render.json.
 *   mode "selfcheck": prints a version line and exits 0 (doctor probe).
 *
 * Failure contract: any malformed/unreadable PDF or IO failure exits nonzero
 * with a single `render-helper: <reason>` line on stderr. Nothing is ever
 * silently skipped: a page that PDFKit cannot open is an error, not a gap.
 *
 * CGPDF SAFETY: values arriving via CGPDFDictionaryApplyFunction are opaque
 * untyped refs — CGPDFObjectGetType MUST gate every typed getter. An
 * unguarded CGPDFObjectGetValue on the wrong type segfaulted in earlier
 * probes; every call site below is type-checked first.
 */
import Foundation
import PDFKit
import CoreGraphics
import AppKit

let HELPER_VERSION = "render-helper/1 (pdfkit+cgpdf, macOS)"

enum Fail: Error {
    case usage(String)
    case unreadable(String)
    case writeFailed(String)
}

func fail(_ error: Fail) -> Never {
    let message: String
    switch error {
    case .usage(let m): message = m
    case .unreadable(let m): message = m
    case .writeFailed(let m): message = m
    }
    FileHandle.standardError.write("render-helper: \(message)\n".data(using: .utf8)!)
    switch error {
    case .usage: exit(3)
    case .unreadable: exit(2)
    case .writeFailed: exit(4)
    }
}

// ---------------------------------------------------------------------------
// Font collection: walk each page's Resources → Font (and nested XObject
// resources) via CGPDF object graph. Every callback value is type-gated.
// ---------------------------------------------------------------------------
final class FontScan {
    /// BaseFont name → embedded (FontFile/FontFile2/FontFile3 present in the
    /// font descriptor). A font with no descriptor counts as not-embedded.
    var fonts: [String: Bool] = [:]
    var depth = 0
    static let maxDepth = 8
}

/// obj must already be verified .name by the caller — returns the bytes.
func pdfNameString(_ obj: CGPDFObjectRef) -> String? {
    guard CGPDFObjectGetType(obj) == .name else { return nil }
    var ptr: UnsafePointer<CChar>? = nil
    guard CGPDFObjectGetValue(obj, .name, &ptr), let p = ptr else { return nil }
    return String(cString: p)
}

func pdfDict(_ obj: CGPDFObjectRef) -> CGPDFDictionaryRef? {
    guard CGPDFObjectGetType(obj) == .dictionary else { return nil }
    var d: CGPDFDictionaryRef? = nil
    guard CGPDFObjectGetValue(obj, .dictionary, &d) else { return nil }
    return d
}

func pdfArray(_ obj: CGPDFObjectRef) -> CGPDFArrayRef? {
    guard CGPDFObjectGetType(obj) == .array else { return nil }
    var a: CGPDFArrayRef? = nil
    guard CGPDFObjectGetValue(obj, .array, &a) else { return nil }
    return a
}

func pdfStream(_ obj: CGPDFObjectRef) -> CGPDFStreamRef? {
    guard CGPDFObjectGetType(obj) == .stream else { return nil }
    var s: CGPDFStreamRef? = nil
    guard CGPDFObjectGetValue(obj, .stream, &s) else { return nil }
    return s
}

func pdfBool(_ obj: CGPDFObjectRef) -> Bool? {
    guard CGPDFObjectGetType(obj) == .boolean else { return nil }
    var b = false
    guard CGPDFObjectGetValue(obj, .boolean, &b) else { return nil }
    return b
}

/// A font dictionary's embeddedness: FontDescriptor → FontFile{,2,3}.
/// Type0 fonts carry the descriptor on their DescendantFonts entry instead;
/// both shapes are handled here.
func fontEmbedded(_ fontDict: CGPDFDictionaryRef) -> Bool {
    var fd: CGPDFDictionaryRef? = nil
    if CGPDFDictionaryGetDictionary(fontDict, "FontDescriptor", &fd), let desc = fd {
        for key in ["FontFile", "FontFile2", "FontFile3"] {
            var obj: CGPDFObjectRef? = nil
            if CGPDFDictionaryGetObject(desc, key, &obj), let o = obj,
               pdfStream(o) != nil || pdfDict(o) != nil {
                return true
            }
        }
    }
    return false
}

/// Record BaseFont names + embeddedness from a /Font dictionary entry value —
/// also descends into DescendantFonts arrays (Type0 composite fonts).
func recordFontEntry(_ obj: CGPDFObjectRef, _ scan: FontScan) {
    if let d = pdfDict(obj) {
        var baseName: String? = nil
        var base: CGPDFObjectRef? = nil
        if CGPDFDictionaryGetObject(d, "BaseFont", &base), let b = base {
            baseName = pdfNameString(b)
        }
        var embedded = fontEmbedded(d)
        var df: CGPDFObjectRef? = nil
        if CGPDFDictionaryGetObject(d, "DescendantFonts", &df), let dfo = df,
           let arr = pdfArray(dfo) {
            for i in 0..<CGPDFArrayGetCount(arr) {
                var item: CGPDFObjectRef? = nil
                guard CGPDFArrayGetObject(arr, i, &item), let io = item,
                      let idict = pdfDict(io) else { continue }
                var bf: CGPDFObjectRef? = nil
                if CGPDFDictionaryGetObject(idict, "BaseFont", &bf), let bo = bf,
                   let n = pdfNameString(bo), baseName == nil {
                    baseName = n
                }
                if fontEmbedded(idict) { embedded = true }
            }
        }
        if let name = baseName {
            // Once marked embedded stays embedded — two entries may alias the
            // same BaseFont through different resource scopes.
            scan.fonts[name] = (scan.fonts[name] ?? false) || embedded
        }
    }
}

func scanResourceDict(_ dict: CGPDFDictionaryRef, _ scan: FontScan) {
    guard scan.depth < FontScan.maxDepth else { return }
    scan.depth += 1
    defer { scan.depth -= 1 }

    var fontDict: CGPDFDictionaryRef? = nil
    if CGPDFDictionaryGetDictionary(dict, "Font", &fontDict), let fd = fontDict {
        let info = Unmanaged.passUnretained(scan).toOpaque()
        CGPDFDictionaryApplyFunction(fd, { _, value, info in
            guard let info = info else { return }
            let scan = Unmanaged<FontScan>.fromOpaque(info).takeUnretainedValue()
            // `value` is opaque: type-gate before ANY typed read.
            switch CGPDFObjectGetType(value) {
            case .dictionary, .stream:
                recordFontEntry(value, scan)
            default:
                break
            }
        }, info)
    }

    // Form XObjects may carry their own Resources with their own /Font.
    var xobj: CGPDFDictionaryRef? = nil
    if CGPDFDictionaryGetDictionary(dict, "XObject", &xobj), let xd = xobj {
        let info = Unmanaged.passUnretained(scan).toOpaque()
        CGPDFDictionaryApplyFunction(xd, { _, value, info in
            guard let info = info else { return }
            let scan = Unmanaged<FontScan>.fromOpaque(info).takeUnretainedValue()
            guard CGPDFObjectGetType(value) == .stream,
                  let s = pdfStream(value),
                  let sd = CGPDFStreamGetDictionary(s) else { return }
            var res: CGPDFDictionaryRef? = nil
            if CGPDFDictionaryGetDictionary(sd, "Resources", &res), let r = res {
                scanResourceDict(r, scan)
            }
        }, info)
    }
}

func fontsForPage(_ cgdoc: CGPDFDocument, pageIndex: Int) -> [[String: Any]] {
    let scan = FontScan()
    guard let page = cgdoc.page(at: pageIndex + 1), let pageDict = page.dictionary else {
        return []
    }
    var res: CGPDFDictionaryRef? = nil
    if CGPDFDictionaryGetDictionary(pageDict, "Resources", &res), let r = res {
        scanResourceDict(r, scan)
    }
    return scan.fonts.keys.sorted().map { ["name": $0, "embedded": scan.fonts[$0] ?? false] }
}

// ---------------------------------------------------------------------------
// Page inspection
// ---------------------------------------------------------------------------
struct PageReport {
    let page: Int
    let widthPt: Double
    let heightPt: Double
    let text: String
    let lineBoxes: [[String: Any]]
    let links: [[String: Any]]
    let fonts: [[String: Any]]
}

func rectJson(_ r: CGRect) -> [String: Double] {
    ["x": Double(r.origin.x), "y": Double(r.origin.y),
     "w": Double(r.size.width), "h": Double(r.size.height)]
}

func inspectPage(_ page: PDFPage, index: Int, cgdoc: CGPDFDocument?) -> PageReport {
    let bounds = page.bounds(for: .mediaBox)
    let text = page.string ?? ""

    var lineBoxes: [[String: Any]] = []
    if let selection = page.selection(for: bounds) {
        for line in selection.selectionsByLine() {
            for pageSel in line.selectionsByLine() {
                let b = pageSel.bounds(for: page)
                let t = pageSel.string ?? ""
                if !t.isEmpty {
                    lineBoxes.append(["rect": rectJson(b), "text": t])
                }
            }
        }
    }

    var links: [[String: Any]] = []
    for annotation in page.annotations {
        var url: URL? = nil
        if annotation.type == "Link" {
            url = annotation.url
            if url == nil, let action = annotation.action as? PDFActionURL {
                url = action.url
            }
        }
        if let u = url {
            links.append(["rect": rectJson(annotation.bounds), "url": u.absoluteString])
        }
    }

    let fonts = cgdoc.map { fontsForPage($0, pageIndex: index) } ?? []
    return PageReport(
        page: index + 1,
        widthPt: Double(bounds.width),
        heightPt: Double(bounds.height),
        text: text,
        lineBoxes: lineBoxes,
        links: links,
        fonts: fonts,
    )
}

// ---------------------------------------------------------------------------
// PNG rasterization — deterministic for identical inputs: fixed color space,
// fixed scale, white background, alpha-free bitmap context.
// ---------------------------------------------------------------------------
func renderPagePng(_ page: PDFPage, dpi: CGFloat, to url: URL) throws {
    let scale = dpi / 72.0
    let bounds = page.bounds(for: .mediaBox)
    let w = max(1, Int((bounds.width * scale).rounded()))
    let h = max(1, Int((bounds.height * scale).rounded()))
    guard let ctx = CGContext(
        data: nil, width: w, height: h,
        bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue,
    ) else {
        throw Fail.writeFailed("could not create bitmap context for page")
    }
    ctx.setFillColor(.white)
    ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
    ctx.scaleBy(x: scale, y: scale)
    page.draw(with: .mediaBox, to: ctx)
    guard let image = ctx.makeImage() else {
        throw Fail.writeFailed("bitmap context produced no image")
    }
    let rep = NSBitmapImageRep(cgImage: image)
    rep.size = NSSize(width: bounds.width, height: bounds.height)
    guard let png = rep.representation(using: .png, properties: [:]) else {
        throw Fail.writeFailed("PNG encode failed")
    }
    do {
        try png.write(to: url, options: .atomic)
    } catch {
        throw Fail.writeFailed("cannot write \(url.path): \(error.localizedDescription)")
    }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
let args = CommandLine.arguments
if args.count >= 2, args[1] == "selfcheck" {
    print(HELPER_VERSION)
    exit(0)
}
guard args.count == 5 else {
    fail(.usage("usage: render-helper <pdfPath> <json|pages|selfcheck> <outDir> <dpi>"))
}
let pdfPath = args[1]
let mode = args[2]
let outDir = args[3]
guard let dpi = Double(args[4]), dpi > 0, dpi <= 600 else {
    fail(.usage("dpi must be a positive number <= 600"))
}
guard mode == "json" || mode == "pages" else {
    fail(.usage("mode must be 'json' or 'pages'"))
}

let pdfUrl = URL(fileURLWithPath: pdfPath)
guard let doc = PDFDocument(url: pdfUrl) else {
    fail(.unreadable("cannot open PDF \(pdfPath)"))
}
// A document with zero pages is not renderable — treat as malformed input.
guard doc.pageCount > 0 else {
    fail(.unreadable("PDF has zero pages: \(pdfPath)"))
}
let cgdoc = CGPDFDocument(pdfUrl as CFURL)

let fm = FileManager.default
do {
    try fm.createDirectory(atPath: outDir, withIntermediateDirectories: true)
} catch {
    fail(.writeFailed("cannot create outDir \(outDir): \(error.localizedDescription)"))
}

var reports: [PageReport] = []
var writtenFiles: [String] = []
for i in 0..<doc.pageCount {
    guard let page = doc.page(at: i) else {
        fail(.unreadable("page \(i + 1) is unreadable"))
    }
    reports.append(inspectPage(page, index: i, cgdoc: cgdoc))
    if mode == "pages" {
        let name = "page-\(i + 1).png"
        do {
            try renderPagePng(page, dpi: CGFloat(dpi), to: URL(fileURLWithPath: outDir + "/" + name))
            writtenFiles.append(name)
        } catch let e as Fail {
            fail(e)
        } catch {
            fail(.writeFailed("page \(i + 1) render failed: \(error.localizedDescription)"))
        }
    }
}

let pagesJson: [[String: Any]] = reports.map { r in
    [
        "page": r.page,
        "size": ["w": r.widthPt, "h": r.heightPt],
        "text": r.text,
        "lineBoxes": r.lineBoxes,
        "links": r.links,
        "fonts": r.fonts,
    ]
}
var manifest: [String: Any] = [
    "helper": HELPER_VERSION,
    "mode": mode,
    "dpi": dpi,
    "pageCount": doc.pageCount,
    "pages": pagesJson,
]
if mode == "pages" {
    manifest["files"] = writtenFiles
}
do {
    let data = try JSONSerialization.data(withJSONObject: manifest, options: [.sortedKeys])
    try data.write(to: URL(fileURLWithPath: outDir + "/render.json"))
} catch {
    fail(.writeFailed("cannot write render.json: \(error.localizedDescription)"))
}
exit(0)
