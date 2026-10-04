/**
 * Protected-content analysis (M2, API_CONTRACT §2.2 + SPEC §5.2).
 *
 * Detection is token/structure-based: math environments and inline math are
 * located by scanning delimiters, citation keys / labels / numeric anchors
 * are compared as SETS, and unknown control sequences are never assumed
 * safe. Per ADR-0005: any byte change intersecting a math region is a
 * ProtectedChange — including whitespace-only edits — because typeset
 * spacing is semantic in math. Anything the analyzer cannot classify is
 * reported as `unknown-macro`, never silently passed.
 *
 * COORDINATES: all `*Byte` fields are real UTF-8 byte offsets — the same
 * space patch edit ranges live in. Regions are located in JS-string
 * (UTF-16 code-unit) space and translated through a char→byte prefix map,
 * so intersection tests are exact on non-ASCII files. `*Char` fields are
 * kept only for slicing excerpt text.
 */
import type { ProtectedChange } from "@latexwb/contracts";
import { TOOLCHAIN_COMMANDS } from "./known-commands.generated.ts";

export interface ByteRange {
  startByte: number;
  endByte: number;
}

const MATH_ENVS = new Set([
  "equation", "equation*", "align", "align*", "gather", "gather*",
  "multline", "multline*", "eqnarray", "eqnarray*", "displaymath",
  "math", "flalign", "flalign*", "alignat", "alignat*", "subequations",
  "dmath", "dmath*", "dseries", "dgroup", "darray",
]);

const VERBATIM_ENVS = new Set(["verbatim", "lstlisting", "minted", "Verbatim"]);
const QUOTE_ENVS = new Set(["quote", "quotation"]);

const CITE_COMMANDS =
  /\\(?:[Cc]ite[tp]?|citealp|citealt|citeauthor|citeyear|parencite|textcite|autocite|footcite|smartcite|supercite|nocite|citeyearpar|citepos)(?:\[[^\]]*\])*\{([^}]*)\}/g;
const LABEL_DEF = /\\label\{([^}]*)\}/g;
const REF_USE = /\\(?:eqref|autoref|cref|Cref|vref|pageref|nameref|ref)\{([^}]*)\}/g;
const NUM_ANCHOR = /\\(?:num|SI|si|qty|unit)\s*(?:\[[^\]]*\])?\{([^}]*)\}/g;
const MACRO_DEF =
  /\\(?:newcommand|renewcommand|providecommand|DeclareMathOperator|DeclareRobustCommand|def)\s*\*?\s*\\([A-Za-z@]+)/g;

/** Macros that are safe to recognize unflagged when they appear in changed text. */
const KNOWN_MACROS = new Set([
  "documentclass", "usepackage", "RequirePackage", "begin", "end", "section",
  "subsection", "subsubsection", "paragraph", "subparagraph", "chapter", "part",
  "textbf", "textit", "texttt", "textrm", "textsf", "textsc", "emph", "text",
  "mathbf", "mathit", "mathrm", "mathsf", "mathtt", "mathcal", "mathbb",
  "mathfrak", "operatorname", "frac", "dfrac", "tfrac", "sqrt", "sum", "prod",
  "int", "oint", "lim", "infty", "partial", "nabla", "cdot", "cdots", "ldots",
  "dots", "times", "div", "pm", "mp", "leq", "leqslant", "geq", "geqslant",
  "neq", "approx", "equiv", "sim", "simeq", "cong", "propto", "in", "notin",
  "subset", "subseteq", "supset", "supseteq", "cup", "cap", "setminus",
  "emptyset", "forall", "exists", "nexists", "neg", "land", "lor", "wedge",
  "vee", "oplus", "otimes", "odot", "circ", "bullet", "star", "ast", "dagger",
  "ddagger", "alpha", "beta", "gamma", "delta", "epsilon", "varepsilon",
  "zeta", "eta", "theta", "vartheta", "iota", "kappa", "lambda", "mu", "nu",
  "xi", "pi", "varpi", "rho", "varrho", "sigma", "varsigma", "tau", "upsilon",
  "phi", "varphi", "chi", "psi", "omega", "Gamma", "Delta", "Theta", "Lambda",
  "Xi", "Pi", "Sigma", "Upsilon", "Phi", "Psi", "Omega",
  "left", "right", "leftarrow", "rightarrow", "Leftarrow", "Rightarrow",
  "leftrightarrow", "Leftrightarrow", "mapsto", "to", "gets", "implies",
  "impliedby", "iff", "uparrow", "downarrow", "updownarrow",
  "big", "Big", "bigg", "Bigg", "bigl", "bigr", "Bigl", "Bigr", "biggl",
  "biggr", "Biggl", "Biggr", "langle", "rangle", "lceil", "rceil", "lfloor",
  "rfloor", "lvert", "rvert", "lVert", "rVert", "vert", "Vert", "mid",
  "overline", "underline", "overbrace", "underbrace", "widehat", "widetilde",
  "hat", "tilde", "bar", "vec", "dot", "ddot", "acute", "grave", "check",
  "breve", "mathring", "prime", "boxed", "binom", "dbinom", "tbinom",
  "begin{array}", "array", "matrix", "pmatrix", "bmatrix", "vmatrix",
  "Bmatrix", "Vmatrix", "smallmatrix", "cases", "substack",
  "item", "caption", "centering", "raggedright", "raggedleft", "hline",
  "cline", "multicolumn", "multirow", "toprule", "midrule", "bottomrule",
  "cmidrule", "addlinespace", "tabularnewline",
  "includegraphics", "input", "include", "subfile", "bibliography",
  "bibliographystyle", "addbibresource", "printbibliography", "footnote",
  "thanks", "maketitle", "title", "author", "date", "abstract", "appendix",
  "tableofcontents", "listoffigures", "listoftables", "label", "ref", "eqref",
  "autoref", "cref", "Cref", "vref", "pageref", "nameref", "url", "href",
  "verb", "hspace", "vspace", "hfill",
  "vfill", "newline", "linebreak", "pagebreak", "clearpage",
  "newpage", "noindent", "indent", "par", "parbox", "minipage", "rule",
  "raisebox", "makebox", "framebox", "fbox", "mbox", "sbox", "color",
  "textcolor", "colorbox", "definecolor", "setlength", "addtolength",
  "setcounter", "addtocounter", "refstepcounter", "stepcounter", "value",
  "newenvironment", "renewenvironment", "newtheorem", "theoremstyle",
  "qed", "qedsymbol", "proof", "frame", "frametitle", "framesubtitle",
  "pause", "only", "onslide", "uncover", "visible", "invisible", "alert",
  "structure", "columns", "column", "block", "alertblock", "exampleblock",
  "usetheme", "usecolortheme", "usefonttheme", "setbeamertemplate",
  "setbeamercolor", "setbeamerfont", "ctexset", "zihao", "kaishu", "songti",
  "heiti", "fangsong", "today", "And", "and", "or", "not",
  "hyphenation", "PassOptionsToPackage", "DeclareOption",
  "ProcessOptions", "AtBeginDocument", "AtEndDocument", "if", "else", "fi",
  "ifx", "ifnum", "ifdim", "ifodd", "ifcase", "loop", "repeat",
  "newcount", "newdimen", "newlength", "newif", "count", "dimen", "advance",
  "multiply", "divide", "number", "the", "romannumeral", "edef", "xdef",
  "gdef", "let", "csname", "endcsname", "expandafter", "noexpand", "relax",
  "protect", "string", "meaning", "show", "message", "write", "openout",
  "closeout", "read", "inputlineno", "jobname", "space", "quad", "qquad",
  "enspace", "thinspace", "medspace", "thickspace", "negthinspace",
  "negmedspace", "negthickspace", "kern", "mkern", "mspace", "phantom",
  "hphantom", "vphantom", "smash", "mathstrut", "strut", "displaystyle",
  "textstyle", "scriptstyle", "scriptscriptstyle", "limits", "nolimits",
  "mathop", "mathbin", "mathrel", "mathopen", "mathclose", "mathpunct",
  "mathinner", "mathord", "mod", "bmod", "pmod", "arg", "deg", "det", "dim",
  "exp", "gcd", "hom", "inf", "ker", "lg", "ln", "log", "max", "min", "Pr",
  "sec", "sin", "sinh", "sup", "tan", "tanh", "cos", "cosh", "cot", "coth",
  "csc", "arccos", "arcsin", "arctan", "argmin", "argmax", "subjectto",
  "stackrel", "overset", "underset", "sideset", "xrightarrow", "xleftarrow",
  "xmapsto", "hookrightarrow", "hookleftarrow", "rightharpoonup",
  "leftharpoonup", "rightleftharpoons", "overrightarrow", "overleftarrow",
  "underrightarrow", "underleftarrow", "cancel", "bcancel", "xcancel",
  "cancelto", "nicefrac", "unitfrac", "SI", "si", "num", "qty", "ang",
  "percent", "permille", "micro", "ohm", "degree", "celsius",
]);

/**
 * Standard kernel/package commands beyond the core list above: font sizes and
 * switches, spacing/length registers, boxes and graphics scaling, float and
 * table helpers, citation/cross-reference families, theorem/proof helpers,
 * common math symbols, TikZ/listing/algorithm/beamer/ctex/exam vocabulary.
 * The generated TOOLCHAIN_COMMANDS (scripts/generate-known-commands.py:
 * every user-level name the pinned bundle's kernel and common packages
 * define) is consulted too; this list keeps dynamically defined names
 * (algpseudocode's \State, beamer overlays) the generator cannot see.
 * These are layout or markup commands a writer legitimately adds; flagging
 * them as "unknown" pushed real agents into contortions (e.g. transposing a
 * table because \small and \resizebox were gated). A command that hides
 * protected content inside project-specific semantics is still caught: only
 * names outside this vocabulary and not defined/used in the project flag.
 */
const STANDARD_MACROS = new Set(`
tiny scriptsize footnotesize small normalsize large Large LARGE huge Huge
bfseries mdseries itshape slshape upshape scshape rmfamily sffamily ttfamily
normalfont em bf it rm sf tt sl sc textup textmd textnormal textsl mathnormal
MakeUppercase MakeLowercase uppercase lowercase underline sout uline
smallskip medskip bigskip vskip hskip baselineskip baselinestretch linespread
parindent parskip textwidth linewidth columnwidth textheight paperwidth
paperheight hsize vsize tabcolsep arraystretch arraycolsep extracolsep
fboxsep fboxrule topmargin oddsidemargin evensidemargin headheight headsep
footskip marginparwidth abovedisplayskip belowdisplayskip jot stretch fill
setstretch onehalfspacing doublespacing singlespacing enlargethispage
resizebox scalebox rotatebox reflectbox adjustbox graphicspath
DeclareGraphicsExtensions captionof captionsetup subcaption subcaptionbox
subfigure subfloat FloatBarrier suppressfloats newcolumntype arraybackslash
specialrule morecmidrules endhead endfirsthead endfoot endlastfoot
rowcolor cellcolor columncolor rowcolors multirowcell makecell thead
cite citep citet citealp citealt citeauthor citeyear citeyearpar parencite
textcite autocite footcite smartcite supercite nocite fullcite citetitle
bibitem newblock bibname refname setcitestyle bibpunct defbibheading
crefname Crefname crefformat labelcref hyperref hypersetup nolinkurl
phantomsection texorpdfstring footnotemark footnotetext marginpar
newtheorem theoremstyle qedhere proofname swapnumbers newtheoremstyle
newcommand renewcommand providecommand DeclareMathOperator
DeclarePairedDelimiter DeclareRobustCommand NewDocumentCommand
RenewDocumentCommand ProvideDocumentCommand ensuremath
le ge ne lt gt ll gg leqq geqq lesssim gtrsim prec succ preceq succeq perp
parallel angle triangle square blacksquare Box Diamond vdots ddots colon
lbrace rbrace lbrack rbrack backslash Longrightarrow Longleftarrow
Longleftrightarrow longrightarrow longleftarrow longleftrightarrow longmapsto
nearrow searrow swarrow nwarrow rightsquigarrow leadsto top bot vdash dashv
models aleph hbar ell wp Re Im imath jmath varnothing complement bigcup
bigcap bigoplus bigotimes bigodot biguplus bigsqcup bigvee bigwedge coprod
iint iiint sqcup sqcap uplus amalg smallsetminus wr triangleq doteq coloneqq
eqqcolon mathscr mathds mathbbm boldsymbol bm pmb tag notag nonumber
intertext shortintertext middle genfrac cfrac overleftrightarrow limsup
liminf varinjlim varprojlim injlim projlim varkappa varGamma varDelta
varTheta varLambda varXi varPi varSigma varUpsilon varPhi varPsi varOmega
digamma lhd rhd unlhd unrhd sharp flat natural clubsuit diamondsuit
heartsuit spadesuit checkmark mathclap mathllap mathrlap underbracket
overbracket xleftrightarrow xLeftarrow xRightarrow xLeftrightarrow
lvert rvert rightarrowtail twoheadrightarrow circlearrowleft
LaTeX TeX LaTeXe XeLaTeX XeTeX LuaLaTeX BibTeX
textbackslash textasciitilde textasciicircum textbar textless textgreater
textendash textemdash textquoteleft textquoteright textquotedblleft
textquotedblright textregistered texttrademark textcopyright textdegree
textbullet textperiodcentered textsuperscript textsubscript S P dag ddag
copyright pounds euro slash nobreak nobreakspace allowbreak discretionary
hyp fcolorbox pagecolor centerline ignorespaces unskip leavevmode null hrule
vrule hrulefill dotfill leftskip rightskip hfil vfil thispagestyle
pagestyle pagenumbering markboth markright cleardoublepage nopagebreak
nolinebreak addcontentsline addtocontents contentsline numberline
geometry newgeometry restoregeometry usetikzlibrary tikz node draw
filldraw path coordinate foreach tikzset tikzstyle pgfplotsset addplot
addlegendentry legend nextgroupplot pgfmathsetmacro pgfmathparse
lstset lstinline lstinputlisting mintinline inputminted
State If Else ElsIf EndIf For ForAll EndFor While EndWhile Repeat Until
Loop EndLoop Return Procedure EndProcedure Function EndFunction Require
Ensure Comment Call STATE IF ELSE ELSIF ENDIF FOR ENDFOR WHILE ENDWHILE
RETURN REQUIRE ENSURE COMMENT KwIn KwOut KwData KwResult KwRet SetAlgoLined
DontPrintSemicolon SetKwInOut algorithmicrequire algorithmicensure
sisetup SIrange numrange qtyrange unit
setmainfont setsansfont setmonofont newfontfamily fontspec setCJKmainfont
setCJKsansfont setCJKmonofont setCJKfamilyfont CJKfamily selectlanguage
foreignlanguage xspace microtypesetup setlist newlist setlength
lishu youyuan CTEXoptions ctexset CJKsetup
useinnertheme useoutertheme insertframenumber inserttotalframenumber
titlepage institute logo AtBeginSection AtBeginSubsection subtitle
titlegraphic setbeamersize beamertemplatenavigationsymbolsempty
transdissolve againframe note
question questions part parts subpart subparts choices choice
CorrectChoice checkboxes solution printanswers noprintanswers points
pointsinmargin totalpoints numquestions numpoints gradetable pointtable
fullwidth header footer firstpageheader runningheader firstpagefooter
runningfooter extraheadheight bonuspoints droppoints
appendixpage keywords IEEEkeywords IEEEPARstart ccsdesc acmConference
email affiliation address orcid
`.split(/\s+/).filter((name) => name.length > 0));

interface Region {
  kind: "math" | "verbatim" | "quote";
  /** UTF-16 code-unit offsets — used only for slicing excerpt text. */
  startChar: number;
  endChar: number;
  contentStartChar: number;
  contentEndChar: number;
  /** UTF-8 byte offsets — used for changed-range intersection tests. */
  startByte: number;
  endByte: number;
}

/**
 * UTF-16 code-unit index → UTF-8 byte offset prefix map. map[i] is the byte
 * offset of code unit i; map[text.length] is the total byte length.
 */
function charToByteMap(text: string): Uint32Array {
  const map = new Uint32Array(text.length + 1);
  let byte = 0;
  let i = 0;
  while (i < text.length) {
    map[i] = byte;
    const cp = text.codePointAt(i) as number;
    const u16 = cp > 0xffff ? 2 : 1;
    if (u16 === 2) map[i + 1] = byte;
    byte += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
    i += u16;
  }
  map[text.length] = byte;
  return map;
}

interface Scanner {
  text: string;
  map: Uint32Array;
  /** [startChar, endChar) regions where math delimiters must not be parsed. */
  verbatimChars: [number, number][];
}

function inVerbatim(scanner: Scanner, charIndex: number): boolean {
  return scanner.verbatimChars.some(([s, e]) => charIndex >= s && charIndex < e);
}

function pushRegion(
  scanner: Scanner,
  regions: Region[],
  kind: Region["kind"],
  startChar: number,
  endChar: number,
  contentStartChar: number,
  contentEndChar: number,
): void {
  regions.push({
    kind,
    startChar,
    endChar,
    contentStartChar,
    contentEndChar,
    startByte: scanner.map[startChar] as number,
    endByte: scanner.map[endChar] as number,
  });
}

interface Lexed {
  /**
   * The source with every comment (`%` to end of line, outside verbatim)
   * replaced by spaces. Same UTF-16 length as the input, so every index in
   * it is an index into the original text.
   */
  masked: string;
  /** Verbatim environments: [startChar, endChar, contentStartChar, contentEndChar]. */
  verbatim: [number, number, number, number][];
}

const VERBATIM_BEGIN = /\\begin\{(verbatim|lstlisting|minted|Verbatim)\}/y;

/**
 * One left-to-right lexical pass that resolves the comment/verbatim
 * chicken-and-egg correctly: a `%` inside lstlisting is literal text, while
 * `\begin{verbatim}` inside a comment is not an environment. Escapes (`\%`,
 * `\\`) and inline `\verb|…|` are honoured. Comments carry no document
 * content — a `\cite{key}` or `$x$` in a comment must not be analysed as a
 * citation or a math region (a template's "% cite with \cite{key}" hint once
 * made replacing the template a hard-refused "citation removal").
 */
function lexSource(text: string): Lexed {
  const out: string[] = [];
  const verbatim: [number, number, number, number][] = [];
  let copyFrom = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      VERBATIM_BEGIN.lastIndex = i;
      const vm = VERBATIM_BEGIN.exec(text);
      if (vm !== null) {
        const endNeedle = `\\end{${vm[1] as string}}`;
        const endIdx = text.indexOf(endNeedle, i + vm[0].length);
        if (endIdx !== -1) {
          verbatim.push([i, endIdx + endNeedle.length, i + vm[0].length, endIdx]);
          i = endIdx + endNeedle.length;
          continue;
        }
      }
      const verb = /^\\verb\*?([^A-Za-z\s*])/.exec(text.slice(i, i + 8));
      if (verb !== null) {
        const delim = verb[1] as string;
        const close = text.indexOf(delim, i + verb[0].length);
        const eol = text.indexOf("\n", i);
        if (close !== -1 && (eol === -1 || close < eol)) {
          i = close + 1;
          continue;
        }
      }
      i += 2; // escaped character: `\%` is text, `\\` is a line break
      continue;
    }
    if (ch === "%") {
      let eol = text.indexOf("\n", i);
      if (eol === -1) eol = text.length;
      out.push(text.slice(copyFrom, i), " ".repeat(eol - i));
      copyFrom = eol;
      i = eol;
      continue;
    }
    i += 1;
  }
  out.push(text.slice(copyFrom));
  return { masked: out.join(""), verbatim };
}

/** The source with comments blanked (same length; indices stay aligned). */
export function maskComments(text: string): string {
  return lexSource(text).masked;
}

/**
 * Find environment and delimiter-delimited regions in a .tex source.
 * Verbatim regions are found FIRST and every later scan skips matches that
 * start inside them — a `$` or `\begin{equation}` inside lstlisting is
 * literal text, not math. Comments are masked before scanning. A
 * `\[`/`\]`/`\(`/`\)` delimiter directly preceded by a backslash is a
 * line-break fragment (`\\[2pt]`), not math.
 */
function scanRegions(source: string, lexed: Lexed = lexSource(source)): Region[] {
  const regions: Region[] = [];
  const map = charToByteMap(source);
  // Delimiter searches run on the comment-masked text; offsets are shared.
  const text = lexed.masked;
  const scanner: Scanner = { text, map, verbatimChars: [] };

  // Pass 1: verbatim environments establish the exclusion zones.
  for (const [startChar, endChar, contentStartChar, contentEndChar] of lexed.verbatim) {
    regions.push({
      kind: "verbatim",
      startChar,
      endChar,
      contentStartChar,
      contentEndChar,
      startByte: map[startChar] as number,
      endByte: map[endChar] as number,
    });
    scanner.verbatimChars.push([startChar, endChar]);
  }

  // Pass 2: math/quote environments, skipping \begin inside verbatim.
  const beginRe = /\\begin\{([A-Za-z*]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = beginRe.exec(text)) !== null) {
    const env = m[1] as string;
    if (VERBATIM_ENVS.has(env) || inVerbatim(scanner, m.index)) continue;
    const kind = MATH_ENVS.has(env) ? "math" : QUOTE_ENVS.has(env) ? "quote" : null;
    if (kind === null) continue;
    const endNeedle = `\\end{${env}}`;
    const endIdx = text.indexOf(endNeedle, m.index + m[0].length);
    if (endIdx === -1) continue;
    pushRegion(scanner, regions, kind, m.index, endIdx + endNeedle.length, m.index + m[0].length, endIdx);
    beginRe.lastIndex = endIdx + endNeedle.length;
  }

  // Pass 3: \[...\], $$...$$, \(...\) — opener/closer must not be escaped or
  // inside verbatim.
  for (const [open, close] of [
    ["\\[", "\\]"],
    ["$$", "$$"],
    ["\\(", "\\)"],
  ] as const) {
    let pos = 0;
    for (;;) {
      const o = text.indexOf(open, pos);
      if (o === -1) break;
      pos = o + open.length;
      if (open.startsWith("\\") && o > 0 && text[o - 1] === "\\") continue;
      if (inVerbatim(scanner, o)) continue;
      let c = o + open.length;
      for (;;) {
        c = text.indexOf(close, c);
        if (c === -1) break;
        if (close.startsWith("\\") && c > 0 && text[c - 1] === "\\") {
          c += close.length;
          continue;
        }
        break;
      }
      if (c === -1) break;
      pushRegion(scanner, regions, "math", o, c + close.length, o + open.length, c);
      pos = c + close.length;
    }
  }

  // Pass 4: inline $...$ — single unescaped dollar, no blank line inside,
  // not inside verbatim or an already-found region.
  let i = 0;
  while (i < text.length) {
    const d = text.indexOf("$", i);
    if (d === -1) break;
    i = d + 1;
    if (d > 0 && text[d - 1] === "\\") continue;
    if (text.startsWith("$$", d)) {
      i = d + 2;
      continue; // $$ handled above
    }
    if (inVerbatim(scanner, d)) continue;
    if (regions.some((r) => d >= r.startChar && d < r.endChar)) continue;
    let close = d + 1;
    for (;;) {
      close = text.indexOf("$", close);
      if (close === -1) break;
      if (close > 0 && text[close - 1] === "\\") {
        close += 1;
        continue;
      }
      break;
    }
    if (close === -1) break;
    const inner = text.slice(d + 1, close);
    if (inner.length > 0 && !inner.includes("\n\n")) {
      pushRegion(scanner, regions, "math", d, close + 1, d + 1, close);
    }
    i = close + 1;
  }
  regions.sort((a, b) => a.startByte - b.startByte);
  return regions;
}

function stripWs(s: string): string {
  return s.replace(/\s+/g, "");
}

function matchSet(text: string, re: RegExp): Set<string> {
  const out = new Set<string>();
  const r = new RegExp(re.source, re.flags);
  let m: RegExpExecArray | null;
  while ((m = r.exec(text)) !== null) {
    const keys = (m[1] as string).split(",").map((k) => k.trim()).filter((k) => k.length > 0);
    for (const k of keys) out.add(k);
  }
  return out;
}

function definedMacros(text: string): Set<string> {
  const out = new Set<string>();
  const r = new RegExp(MACRO_DEF.source, MACRO_DEF.flags);
  let m: RegExpExecArray | null;
  while ((m = r.exec(text)) !== null) out.add(m[1] as string);
  return out;
}

function truncate(s: string, n = 200): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

function intersects(range: ByteRange, startByte: number, endByte: number): boolean {
  return range.startByte < endByte && range.endByte > startByte;
}

function anyIntersect(ranges: ByteRange[], startByte: number, endByte: number): boolean {
  return ranges.some((ch) => intersects(ch, startByte, endByte));
}

/** Whether a protected change is admissible under host "authoring" mode. */
export function isAdditiveChange(change: ProtectedChange): boolean {
  return change.change === "added" && change.category !== "template";
}

/**
 * Compare before/after content of one file for protected changes.
 * `rangesBefore`/`rangesAfter` are the UTF-8 byte ranges that actually
 * changed, expressed in each version's own coordinates (patch.ts computes
 * the after-side deltas while applying edits). For create/attach the caller
 * passes an empty before list and a whole-file after range; for delete the
 * inverse. Returns ProtectedChange entries — empty means nothing protected
 * moved. Each entry carries `change`: `added` (new protected content that
 * did not exist before), `modified`, or `removed`.
 *
 * Comments are masked before any scan: they carry no typeset content.
 */
export function analyzeProtectedChanges(options: {
  path: string;
  role: string;
  before: string | null;
  after: string | null;
  rangesBefore: ByteRange[];
  rangesAfter: ByteRange[];
  /** Union of \newcommand-style macros defined anywhere in the project. */
  projectDefinedMacros?: Set<string>;
  /** Control sequences already used anywhere in the base snapshot. */
  projectUsedMacros?: Set<string>;
  /** Explicit key renames the caller asserts were applied consistently. */
  citekeyMapping?: Record<string, string> | undefined;
}): ProtectedChange[] {
  const { path, role, before, after, rangesBefore, rangesAfter } = options;
  const out: ProtectedChange[] = [];

  // Whole-file role protection: templates and raw assets are never
  // byte-edited without review, regardless of content. A brand-new raw
  // asset (no before side) is an addition; replacing one is a modification.
  if (role === "template" || role === "raw-asset") {
    if (before !== after) {
      out.push({
        path,
        category: role === "template" ? "template" : "raw-asset",
        change: before === null ? "added" : after === null ? "removed" : "modified",
        before: truncate(before ?? ""),
        after: truncate(after ?? ""),
        reason: `file role '${role}' is protected; content changed`,
      });
    }
    return out;
  }

  const beforeText = before ?? "";
  const afterText = after ?? "";
  if (before === null && after === null) return out;
  if (before === after) return out;

  const beforeLex = lexSource(beforeText);
  const afterLex = lexSource(afterText);
  const beforeMasked = beforeLex.masked;
  const afterMasked = afterLex.masked;
  const beforeRegions = scanRegions(beforeText, beforeLex);
  const afterRegions = scanRegions(afterText, afterLex);

  // ---- math regions ------------------------------------------------------
  // Pair before/after math regions: identical whitespace-stripped content
  // pairs regardless of position; leftovers pair by order; unpaired
  // before-side = removed, unpaired after-side = added. A paired region
  // whose raw bytes (delimiters included) differ in ANY way — whitespace
  // too (ADR-0005) — is flagged. A region re-emitted byte-for-byte by an
  // edit that merely spans it (sentence-level prose rewrites) is unchanged:
  // not one byte of the math moved.
  const bMath = beforeRegions.filter((x) => x.kind === "math");
  const aMath = afterRegions.filter((x) => x.kind === "math");
  const contentOf = (masked: string, r: Region): string =>
    stripWs(masked.slice(r.contentStartChar, r.contentEndChar));
  const rawOf = (masked: string, r: Region): string => masked.slice(r.startChar, r.endChar);
  const bContent = bMath.map((r) => contentOf(beforeMasked, r));
  const aContent = aMath.map((r) => contentOf(afterMasked, r));

  const aUsed = new Set<number>();
  const bUsed = new Set<number>();
  const flagged: { before: Region | null; after: Region | null }[] = [];

  // Exact-content pairs first (prefer byte-identical raw text, then
  // whitespace-insensitive content).
  const bPair = new Map<number, number>();
  for (let bi = 0; bi < bMath.length; bi += 1) {
    const raw = rawOf(beforeMasked, bMath[bi] as Region);
    let ai = aMath.findIndex((r, j) => !aUsed.has(j) && rawOf(afterMasked, r) === raw);
    if (ai < 0) ai = aContent.findIndex((c, j) => !aUsed.has(j) && c === (bContent[bi] as string));
    if (ai >= 0) {
      bPair.set(bi, ai);
      aUsed.add(ai);
      bUsed.add(bi);
    }
  }
  // Remaining regions pair by order (same slot, edited content).
  const ub = bMath.map((_, i) => i).filter((i) => !bUsed.has(i));
  const ua = aMath.map((_, i) => i).filter((i) => !aUsed.has(i));
  for (let k = 0; k < Math.min(ub.length, ua.length); k += 1) {
    bPair.set(ub[k] as number, ua[k] as number);
    bUsed.add(ub[k] as number);
    aUsed.add(ua[k] as number);
  }

  for (const [bi, ai] of [...bPair.entries()].sort((x, y) => x[0] - y[0])) {
    const b = bMath[bi] as Region;
    const a = aMath[ai] as Region;
    if (rawOf(beforeMasked, b) === rawOf(afterMasked, a)) continue;
    const bHit = anyIntersect(rangesBefore, b.startByte, b.endByte);
    const aHit = anyIntersect(rangesAfter, a.startByte, a.endByte);
    const sameTokens = (bContent[bi] as string) === (aContent[ai] as string);
    if (!bHit && !aHit && sameTokens) continue;
    flagged.push({ before: b, after: a });
  }
  // Unpaired leftovers: removed (before) / added (after) regions, flagged
  // independently of whether any other math was touched.
  for (const bi of bMath.map((_, i) => i).filter((i) => !bUsed.has(i))) {
    flagged.push({ before: bMath[bi] as Region, after: null });
  }
  for (const ai of aMath.map((_, i) => i).filter((i) => !aUsed.has(i))) {
    flagged.push({ before: null, after: aMath[ai] as Region });
  }

  for (const pair of flagged) {
    const beforeContent =
      pair.before === null
        ? ""
        : beforeText.slice(pair.before.contentStartChar, pair.before.contentEndChar);
    const afterContent =
      pair.after === null
        ? ""
        : afterText.slice(pair.after.contentStartChar, pair.after.contentEndChar);
    const sameTokens = stripWs(beforeContent) === stripWs(afterContent);
    let reason: string;
    let change: ProtectedChange["change"];
    if (pair.before === null) {
      reason = "math region added";
      change = "added";
    } else if (pair.after === null) {
      reason = "math region removed or repositioned";
      change = "removed";
    } else if (sameTokens && beforeContent !== "") {
      reason = "whitespace-only change inside a math region — typeset spacing is semantic";
      change = "modified";
    } else {
      reason = "math region content changed";
      change = "modified";
    }
    out.push({
      path,
      category: "math",
      change,
      before: truncate(beforeContent),
      after: truncate(afterContent),
      reason,
    });
  }

  // ---- verbatim/quote ------------------------------------------------------
  // Touching an existing literal region so that its exact text no longer
  // exists afterwards is a modification; a literal region whose content did
  // not exist before is new material.
  const literal = (r: Region) => r.kind === "verbatim" || r.kind === "quote";
  const afterLiteralRaw = new Set(
    afterRegions.filter(literal).map((r) => afterText.slice(r.startChar, r.endChar)),
  );
  const beforeLiteralContents = new Set(
    beforeRegions.filter(literal).map((r) => stripWs(beforeText.slice(r.contentStartChar, r.contentEndChar))),
  );
  const quoteModified = beforeRegions.some(
    (r) =>
      literal(r) &&
      anyIntersect(rangesBefore, r.startByte, r.endByte) &&
      !afterLiteralRaw.has(beforeText.slice(r.startChar, r.endChar)),
  );
  const quoteAdded = afterRegions.some(
    (r) =>
      literal(r) &&
      anyIntersect(rangesAfter, r.startByte, r.endByte) &&
      !beforeLiteralContents.has(stripWs(afterText.slice(r.contentStartChar, r.contentEndChar))),
  );
  if (quoteModified || quoteAdded) {
    out.push({
      path,
      category: "quote",
      change: quoteModified ? "modified" : "added",
      before: "",
      after: "",
      reason: quoteModified
        ? "verbatim/quoted material changed — literal content is protected"
        : "verbatim/quoted material added",
    });
  }

  // ---- citation keys -------------------------------------------------------
  const beforeCites = matchSet(beforeMasked, CITE_COMMANDS);
  const afterCites = matchSet(afterMasked, CITE_COMMANDS);
  const removed = [...beforeCites].filter((k) => !afterCites.has(k));
  const added = [...afterCites].filter((k) => !beforeCites.has(k));
  if (removed.length > 0 || added.length > 0) {
    const mapping = options.citekeyMapping ?? {};
    const unmapped = removed.filter((k) => !(k in mapping));
    if (unmapped.length > 0 && added.length > 0) {
      // Keys removed while others appear: indistinguishable from a silent
      // rename, which the patch service refuses outright (DOM-10-3).
      out.push({
        path,
        category: "citation-key",
        change: "modified",
        before: removed.join(","),
        after: added.join(","),
        reason:
          `citation keys removed without an explicit mapping: ${unmapped.join(",")}; ` +
          "renames must provide a citekeyMapping covering every removed key " +
          "(if this is not a rename, remove the old citation and add the new one in separate patches)",
      });
    } else if (removed.length > 0 && added.length === 0) {
      out.push({
        path,
        category: "citation-key",
        change: "removed",
        before: removed.join(","),
        after: "",
        reason: `citation key(s) removed: ${removed.join(",")} — removing a citation needs host review`,
      });
    } else if (removed.length === 0) {
      out.push({
        path,
        category: "citation-key",
        change: "added",
        before: "",
        after: added.join(","),
        reason: `citation key(s) added: ${added.join(",")}`,
      });
    } else {
      out.push({
        path,
        category: "citation-key",
        change: "modified",
        before: removed.join(","),
        after: added.join(","),
        reason: `citation key set changed (${removed.length} removed, ${added.length} added)`,
      });
    }
  }

  // ---- labels ---------------------------------------------------------------
  const beforeLabels = matchSet(beforeMasked, LABEL_DEF);
  const afterLabels = matchSet(afterMasked, LABEL_DEF);
  const lostLabels = [...beforeLabels].filter((l) => !afterLabels.has(l));
  if (lostLabels.length > 0) {
    // A removed \label breaks every \ref that named it — flag with the
    // dangling references named in the reason.
    const refs = matchSet(afterMasked, REF_USE);
    const dangling = lostLabels.filter((l) => refs.has(l));
    out.push({
      path,
      category: "label",
      change: "removed",
      before: lostLabels.join(","),
      after: "",
      reason:
        dangling.length > 0
          ? `label(s) removed while still referenced: ${dangling.join(",")}`
          : `label definition(s) removed: ${lostLabels.join(",")}`,
    });
  }
  const newLabels = [...afterLabels].filter((l) => !beforeLabels.has(l));
  if (newLabels.length > 0) {
    out.push({
      path,
      category: "label",
      change: "added",
      before: "",
      after: newLabels.join(","),
      reason: `label definition(s) added: ${newLabels.join(",")}`,
    });
  }

  // ---- numeric anchors ------------------------------------------------------
  const beforeNums = matchSet(beforeMasked, NUM_ANCHOR);
  const afterNums = matchSet(afterMasked, NUM_ANCHOR);
  const lostNums = [...beforeNums].filter((n) => !afterNums.has(n));
  const newNums = [...afterNums].filter((n) => !beforeNums.has(n));
  if (lostNums.length > 0 || newNums.length > 0) {
    out.push({
      path,
      category: "reported-result",
      change: lostNums.length > 0 ? "modified" : "added",
      before: lostNums.join(","),
      after: newNums.join(","),
      reason:
        lostNums.length > 0
          ? "numeric anchor (\\num/\\SI/\\qty) value changed"
          : "numeric anchor (\\num/\\SI/\\qty) value added",
    });
  }

  // ---- unknown macros -------------------------------------------------------
  // Scan the AFTER text for control sequences and keep those whose UTF-8
  // byte span intersects an after-side change range — before-side ranges
  // applied to afterText would point at the wrong bytes once earlier edits
  // shift content. Full-file changes (create/attach) cover everything.
  // Known = the standard vocabulary, anything the project defines, and
  // anything the base snapshot already uses (it has been in the document
  // under review before; only a new-to-the-project name is unknown).
  const defined = new Set<string>([
    ...definedMacros(beforeMasked),
    ...definedMacros(afterMasked),
    ...(options.projectDefinedMacros ?? new Set<string>()),
    ...(options.projectUsedMacros ?? new Set<string>()),
    ...usedMacros(beforeMasked),
  ]);
  const afterMap = charToByteMap(afterText);
  const scanRanges =
    rangesAfter.length > 0
      ? rangesAfter
      : afterText.length > 0
        ? [{ startByte: 0, endByte: afterMap[afterText.length] as number }]
        : [];
  const verbatimChars = afterRegions.filter((r) => r.kind === "verbatim").map((r) => [r.startChar, r.endChar] as const);
  const unknownSeen = new Set<string>();
  let mm: RegExpExecArray | null;
  const re = /\\([A-Za-z@]+)/g;
  while ((mm = re.exec(afterMasked)) !== null) {
    const at = mm.index;
    if (verbatimChars.some(([s, e]) => at >= s && at < e)) continue; // literal text
    // `\\foo` is a line break followed by text: an odd run of preceding
    // backslashes means this one is escaped (`\\\foo` is break + \foo).
    let run = 0;
    while (at - run - 1 >= 0 && afterMasked[at - run - 1] === "\\") run += 1;
    if (run % 2 === 1) continue;
    const startByte = afterMap[at] as number;
    const endByte = afterMap[at + mm[0].length] as number;
    if (!anyIntersect(scanRanges, startByte, endByte)) continue;
    const name = mm[1] as string;
    if (!KNOWN_MACROS.has(name) && !STANDARD_MACROS.has(name) && !TOOLCHAIN_COMMANDS.has(name) && !defined.has(name)) {
      unknownSeen.add(name);
    }
  }
  for (const name of unknownSeen) {
    out.push({
      path,
      category: "unknown-macro",
      change: "added",
      before: "",
      after: `\\${name}`,
      reason: `control sequence \\${name} is not a known command and is not defined or used elsewhere in the project — flagged rather than assumed safe`,
    });
  }

  return out;
}

/** Every control-sequence name used in (comment-masked) text. */
function usedMacros(masked: string): Set<string> {
  const out = new Set<string>();
  const re = /\\([A-Za-z@]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) out.add(m[1] as string);
  return out;
}

/** Collect every control sequence used across all text files of a snapshot. */
export function collectProjectUsedMacros(texts: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) {
    for (const name of usedMacros(maskComments(t))) out.add(name);
  }
  return out;
}

/** Collect project-defined macros across all text files of a snapshot. */
export function collectProjectMacros(texts: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) {
    for (const name of definedMacros(maskComments(t))) out.add(name);
  }
  return out;
}

/**
 * Set-level protected-content extraction (M4 release check): the same
 * scanners as the patch analyzer, reduced to sorted content multisets so two
 * SNAPSHOTS can be compared without knowing edit ranges. Position is not
 * protected content — only the values are.
 */
export interface ProtectedSets {
  /** Whitespace-stripped math region contents (multiset). */
  math: string[];
  citationKeys: string[];
  labels: string[];
  /** \num/\SI/\qty values. */
  reportedResults: string[];
  /** Whitespace-stripped quote/verbatim environment contents (multiset). */
  quotes: string[];
}

export function extractProtectedSets(source: string): ProtectedSets {
  const lexed = lexSource(source);
  const text = lexed.masked;
  const regions = scanRegions(source, lexed);
  const contentOf = (r: Region): string =>
    stripWs((r.kind === "math" ? text : source).slice(r.contentStartChar, r.contentEndChar));
  return {
    math: regions
      .filter((r) => r.kind === "math")
      .map(contentOf)
      .filter((s) => s.length > 0)
      .sort(),
    citationKeys: [...matchSet(text, CITE_COMMANDS)].sort(),
    labels: [...matchSet(text, LABEL_DEF)].sort(),
    reportedResults: [...matchSet(text, NUM_ANCHOR)].sort(),
    quotes: regions
      .filter((r) => r.kind === "quote" || r.kind === "verbatim")
      .map(contentOf)
      .sort(),
  };
}
