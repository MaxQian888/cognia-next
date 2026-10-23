//! PostScript glyph-name → Unicode resolution (Adobe Glyph List conventions).
//!
//! Used to recover text when a font has no usable /ToUnicode CMap. Glyph names
//! come from the PDF's /Encoding /Differences array or the embedded font
//! program (via the fork's `FPDFFont_GetCharGlyphName`).
//!
//! Implements the AGL "reverse mapping" algorithm:
//! 1. Strip any variant suffix after the first '.' ("fi.alt" → "fi").
//! 2. Split on '_' and resolve each component ("f_i" → "fi").
//! 3. Per component: `uni` + 4n hex digits, `u` + 4-6 hex digits, or a lookup
//!    in the static AGL subset table below.

/// Resolve a glyph name to its Unicode string. Returns None when the name is
/// meaningless (subset-generated names like "g42", "cid1234") or unknown.
pub fn resolve_glyph_name(name: &str) -> Option<String> {
    let base = name.split('.').next()?;
    if base.is_empty() {
        return None;
    }
    let mut out = String::new();
    for component in base.split('_') {
        for c in resolve_component(component)?.chars() {
            match presentation_form_expansion(c) {
                Some(s) => out.push_str(s),
                None => out.push(c),
            }
        }
    }
    if out.is_empty() { None } else { Some(out) }
}

/// Strict single-codepoint glyph-name resolution for the raw item mode
/// ([`crate::raw_text`]), where every glyph must map to exactly one codepoint.
/// Differs from [`resolve_glyph_name`] in three ways: no `_` component
/// splitting, no ligature expansion (the AGL codepoint itself is returned), and
/// a `uni` name must carry exactly four hex digits. Returns `None` for
/// anything that does not resolve to exactly one codepoint, and for control /
/// private-use results, which are never legitimate rendered text.
pub(crate) fn resolve_glyph_name_codepoint(name: &str) -> Option<u32> {
    let base = name.split('.').next()?;
    if base.is_empty() {
        return None;
    }
    let codepoint = algorithmic_codepoint(base).or_else(|| {
        let idx = AGL_SUBSET.binary_search_by(|(n, _)| (*n).cmp(base)).ok()?;
        let mut chars = AGL_SUBSET[idx].1.chars();
        let c = chars.next()?;
        chars.next().is_none().then_some(c as u32)
    })?;
    let control_or_private_use = codepoint <= 0x1F
        || (0x7F..=0x9F).contains(&codepoint)
        || (codepoint > 0xE000 && codepoint <= 0xF8FF);
    if control_or_private_use {
        return None;
    }
    // SOFT HYPHEN (U+00AD) is a discretionary line-break hint, not visible text:
    // renderers show nothing for it and text consumers strip it. A glyph a Type3
    // font names "sfthyphen" / "softhyphen" / "uni00AD" is nevertheless drawn as a
    // dash (it sits at code 45 in every such font seen so far), and the glyph-shape
    // path that decoded these fonts before /Differences names were consulted
    // returned '-'. Keep the visible character.
    Some(if codepoint == 0x00AD {
        0x002D
    } else {
        codepoint
    })
}

/// `uniXXXX` (exactly four hex digits) or `uXXXX`..`uXXXXXX`, hex digits in
/// either case.
fn algorithmic_codepoint(base: &str) -> Option<u32> {
    let hex = if let Some(hex) = base.strip_prefix("uni") {
        (hex.len() == 4).then_some(hex)?
    } else if let Some(hex) = base.strip_prefix('u') {
        (4..=6).contains(&hex.len()).then_some(hex)?
    } else {
        return None;
    };
    if !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let codepoint = u32::from_str_radix(hex, 16).ok()?;
    char::from_u32(codepoint).map(|_| codepoint)
}

/// ASCII expansion for ligature presentation forms, matching the existing
/// extraction-time ligature handling.
pub fn presentation_form_expansion(c: char) -> Option<&'static str> {
    match c {
        '\u{FB00}' => Some("ff"),
        '\u{FB01}' => Some("fi"),
        '\u{FB02}' => Some("fl"),
        '\u{FB03}' => Some("ffi"),
        '\u{FB04}' => Some("ffl"),
        '\u{FB05}' | '\u{FB06}' => Some("st"),
        _ => None,
    }
}

fn resolve_component(comp: &str) -> Option<String> {
    if comp.is_empty() {
        return None;
    }

    // uniXXXX (one or more groups of exactly 4 uppercase hex digits)
    if let Some(hex) = comp.strip_prefix("uni")
        && !hex.is_empty()
        && hex.len() % 4 == 0
        && hex.bytes().all(is_agl_hex_digit)
    {
        let mut s = String::new();
        for group in hex.as_bytes().chunks(4) {
            let v = u32::from_str_radix(std::str::from_utf8(group).ok()?, 16).ok()?;
            // Surrogate range is invalid scalar values
            s.push(char::from_u32(v)?);
        }
        return Some(s);
    }

    // uXXXX / uXXXXX / uXXXXXX
    if let Some(hex) = comp.strip_prefix('u')
        && (4..=6).contains(&hex.len())
        && hex.bytes().all(is_agl_hex_digit)
    {
        let v = u32::from_str_radix(hex, 16).ok()?;
        return char::from_u32(v).map(String::from);
    }

    // Static table lookup
    if let Ok(idx) = AGL_SUBSET.binary_search_by(|(n, _)| (*n).cmp(comp)) {
        return Some(AGL_SUBSET[idx].1.to_string());
    }

    None
}

fn is_agl_hex_digit(b: u8) -> bool {
    b.is_ascii_digit() || (b'A'..=b'F').contains(&b)
}

/// Curated subset of the Adobe Glyph List, sorted by name for binary search.
/// Covers ASCII, Latin-1/Latin Extended accents, ligatures, common punctuation
/// and symbols, and Greek — the ranges that show up in real-world Differences
/// arrays and embedded Latin font programs.
static AGL_SUBSET: &[(&str, &str)] = &[
    ("A", "A"),
    ("AE", "Æ"),
    ("Aacute", "Á"),
    ("Abreve", "Ă"),
    ("Acircumflex", "Â"),
    ("Adieresis", "Ä"),
    ("Agrave", "À"),
    ("Alpha", "Α"),
    ("Amacron", "Ā"),
    ("Aogonek", "Ą"),
    ("Aring", "Å"),
    ("Atilde", "Ã"),
    ("B", "B"),
    ("Beta", "Β"),
    ("C", "C"),
    ("Cacute", "Ć"),
    ("Ccaron", "Č"),
    ("Ccedilla", "Ç"),
    ("Chi", "Χ"),
    ("D", "D"),
    ("Dcaron", "Ď"),
    ("Dcroat", "Đ"),
    ("Delta", "Δ"),
    ("E", "E"),
    ("Eacute", "É"),
    ("Ecaron", "Ě"),
    ("Ecircumflex", "Ê"),
    ("Edieresis", "Ë"),
    ("Egrave", "È"),
    ("Emacron", "Ē"),
    ("Eogonek", "Ę"),
    ("Epsilon", "Ε"),
    ("Eta", "Η"),
    ("Eth", "Ð"),
    ("Euro", "€"),
    ("F", "F"),
    ("G", "G"),
    ("Gamma", "Γ"),
    ("Gbreve", "Ğ"),
    ("H", "H"),
    ("I", "I"),
    ("Iacute", "Í"),
    ("Icircumflex", "Î"),
    ("Idieresis", "Ï"),
    ("Idotaccent", "İ"),
    ("Igrave", "Ì"),
    ("Imacron", "Ī"),
    ("Iota", "Ι"),
    ("J", "J"),
    ("K", "K"),
    ("Kappa", "Κ"),
    ("L", "L"),
    ("Lacute", "Ĺ"),
    ("Lambda", "Λ"),
    ("Lcaron", "Ľ"),
    ("Lslash", "Ł"),
    ("M", "M"),
    ("Mu", "Μ"),
    ("N", "N"),
    ("Nacute", "Ń"),
    ("Ncaron", "Ň"),
    ("Ntilde", "Ñ"),
    ("Nu", "Ν"),
    ("O", "O"),
    ("OE", "Œ"),
    ("Oacute", "Ó"),
    ("Ocircumflex", "Ô"),
    ("Odieresis", "Ö"),
    ("Ograve", "Ò"),
    ("Ohungarumlaut", "Ő"),
    ("Omacron", "Ō"),
    ("Omega", "Ω"),
    ("Omicron", "Ο"),
    ("Oslash", "Ø"),
    ("Otilde", "Õ"),
    ("P", "P"),
    ("Phi", "Φ"),
    ("Pi", "Π"),
    ("Psi", "Ψ"),
    ("Q", "Q"),
    ("R", "R"),
    ("Racute", "Ŕ"),
    ("Rcaron", "Ř"),
    ("Rho", "Ρ"),
    ("S", "S"),
    ("Sacute", "Ś"),
    ("Scaron", "Š"),
    ("Scedilla", "Ş"),
    ("Sigma", "Σ"),
    ("T", "T"),
    ("Tau", "Τ"),
    ("Tbar", "Ŧ"),
    ("Tcaron", "Ť"),
    ("Theta", "Θ"),
    ("Thorn", "Þ"),
    ("U", "U"),
    ("Uacute", "Ú"),
    ("Ucircumflex", "Û"),
    ("Udieresis", "Ü"),
    ("Ugrave", "Ù"),
    ("Uhungarumlaut", "Ű"),
    ("Umacron", "Ū"),
    ("Uogonek", "Ų"),
    ("Upsilon", "Υ"),
    ("Uring", "Ů"),
    ("V", "V"),
    ("W", "W"),
    ("X", "X"),
    ("Xi", "Ξ"),
    ("Y", "Y"),
    ("Yacute", "Ý"),
    ("Ydieresis", "Ÿ"),
    ("Z", "Z"),
    ("Zacute", "Ź"),
    ("Zcaron", "Ž"),
    ("Zdotaccent", "Ż"),
    ("Zeta", "Ζ"),
    ("a", "a"),
    ("aacute", "á"),
    ("abreve", "ă"),
    ("acircumflex", "â"),
    ("acute", "´"),
    ("adieresis", "ä"),
    ("ae", "æ"),
    ("agrave", "à"),
    ("alpha", "α"),
    ("amacron", "ā"),
    ("ampersand", "&"),
    ("aogonek", "ą"),
    ("approxequal", "≈"),
    ("aring", "å"),
    ("asciicircum", "^"),
    ("asciitilde", "~"),
    ("asterisk", "*"),
    ("at", "@"),
    ("atilde", "ã"),
    ("b", "b"),
    ("backslash", "\\"),
    ("bar", "|"),
    ("beta", "β"),
    ("braceleft", "{"),
    ("braceright", "}"),
    ("bracketleft", "["),
    ("bracketright", "]"),
    ("breve", "˘"),
    ("brokenbar", "¦"),
    ("bullet", "•"),
    ("c", "c"),
    ("cacute", "ć"),
    ("caron", "ˇ"),
    ("ccaron", "č"),
    ("ccedilla", "ç"),
    ("cedilla", "¸"),
    ("cent", "¢"),
    ("chi", "χ"),
    ("circumflex", "ˆ"),
    ("colon", ":"),
    ("comma", ","),
    ("copyright", "©"),
    ("currency", "¤"),
    ("d", "d"),
    ("dagger", "†"),
    ("daggerdbl", "‡"),
    ("dcaron", "ď"),
    ("dcroat", "đ"),
    ("degree", "°"),
    ("delta", "δ"),
    ("dieresis", "¨"),
    ("divide", "÷"),
    ("dollar", "$"),
    ("dotaccent", "˙"),
    ("dotlessi", "ı"),
    ("e", "e"),
    ("eacute", "é"),
    ("ecaron", "ě"),
    ("ecircumflex", "ê"),
    ("edieresis", "ë"),
    ("egrave", "è"),
    ("eight", "8"),
    ("ellipsis", "…"),
    ("emacron", "ē"),
    ("emdash", "—"),
    ("endash", "–"),
    ("eogonek", "ę"),
    ("epsilon", "ε"),
    ("equal", "="),
    ("eta", "η"),
    ("eth", "ð"),
    ("exclam", "!"),
    ("exclamdown", "¡"),
    ("f", "f"),
    ("ff", "ff"),
    ("ffi", "ffi"),
    ("ffl", "ffl"),
    ("fi", "fi"),
    ("five", "5"),
    ("fl", "fl"),
    ("florin", "ƒ"),
    ("four", "4"),
    ("fraction", "⁄"),
    ("g", "g"),
    ("gamma", "γ"),
    ("gbreve", "ğ"),
    ("germandbls", "ß"),
    ("grave", "`"),
    ("greater", ">"),
    ("greaterequal", "≥"),
    ("guillemotleft", "«"),
    ("guillemotright", "»"),
    ("guilsinglleft", "‹"),
    ("guilsinglright", "›"),
    ("h", "h"),
    ("hungarumlaut", "˝"),
    ("hyphen", "-"),
    ("i", "i"),
    ("iacute", "í"),
    ("icircumflex", "î"),
    ("idieresis", "ï"),
    ("igrave", "ì"),
    ("imacron", "ī"),
    ("infinity", "∞"),
    ("iota", "ι"),
    ("j", "j"),
    ("k", "k"),
    ("kappa", "κ"),
    ("l", "l"),
    ("lacute", "ĺ"),
    ("lambda", "λ"),
    ("lcaron", "ľ"),
    ("less", "<"),
    ("lessequal", "≤"),
    ("logicalnot", "¬"),
    ("lslash", "ł"),
    ("m", "m"),
    ("macron", "¯"),
    ("minus", "−"),
    ("mu", "μ"),
    ("multiply", "×"),
    ("n", "n"),
    ("nacute", "ń"),
    ("ncaron", "ň"),
    ("nine", "9"),
    ("notequal", "≠"),
    ("ntilde", "ñ"),
    ("nu", "ν"),
    ("numbersign", "#"),
    ("o", "o"),
    ("oacute", "ó"),
    ("ocircumflex", "ô"),
    ("odieresis", "ö"),
    ("oe", "œ"),
    ("ogonek", "˛"),
    ("ograve", "ò"),
    ("ohungarumlaut", "ő"),
    ("omacron", "ō"),
    ("omega", "ω"),
    ("omicron", "ο"),
    ("one", "1"),
    ("onehalf", "½"),
    ("onequarter", "¼"),
    ("onesuperior", "¹"),
    ("ordfeminine", "ª"),
    ("ordmasculine", "º"),
    ("oslash", "ø"),
    ("otilde", "õ"),
    ("p", "p"),
    ("paragraph", "¶"),
    ("parenleft", "("),
    ("parenright", ")"),
    ("partialdiff", "∂"),
    ("percent", "%"),
    ("period", "."),
    ("periodcentered", "·"),
    ("perthousand", "‰"),
    ("phi", "φ"),
    ("pi", "π"),
    ("plus", "+"),
    ("plusminus", "±"),
    ("psi", "ψ"),
    ("q", "q"),
    ("question", "?"),
    ("questiondown", "¿"),
    ("quotedbl", "\""),
    ("quotedblbase", "„"),
    ("quotedblleft", "“"),
    ("quotedblright", "”"),
    ("quoteleft", "‘"),
    ("quoteright", "’"),
    ("quotesinglbase", "‚"),
    ("quotesingle", "'"),
    ("r", "r"),
    ("racute", "ŕ"),
    ("radical", "√"),
    ("rcaron", "ř"),
    ("registered", "®"),
    ("rho", "ρ"),
    ("ring", "˚"),
    ("s", "s"),
    ("sacute", "ś"),
    ("scaron", "š"),
    ("scedilla", "ş"),
    ("section", "§"),
    ("semicolon", ";"),
    ("seven", "7"),
    ("sigma", "σ"),
    ("sigma1", "ς"),
    ("six", "6"),
    ("slash", "/"),
    ("space", " "),
    ("sterling", "£"),
    ("summation", "∑"),
    ("t", "t"),
    ("tau", "τ"),
    ("tbar", "ŧ"),
    ("tcaron", "ť"),
    ("theta", "θ"),
    ("thorn", "þ"),
    ("three", "3"),
    ("threequarters", "¾"),
    ("threesuperior", "³"),
    ("tilde", "˜"),
    ("trademark", "™"),
    ("two", "2"),
    ("twosuperior", "²"),
    ("u", "u"),
    ("uacute", "ú"),
    ("ucircumflex", "û"),
    ("udieresis", "ü"),
    ("ugrave", "ù"),
    ("uhungarumlaut", "ű"),
    ("umacron", "ū"),
    ("underscore", "_"),
    ("uogonek", "ų"),
    ("upsilon", "υ"),
    ("uring", "ů"),
    ("v", "v"),
    ("w", "w"),
    ("x", "x"),
    ("xi", "ξ"),
    ("y", "y"),
    ("yacute", "ý"),
    ("ydieresis", "ÿ"),
    ("yen", "¥"),
    ("z", "z"),
    ("zacute", "ź"),
    ("zcaron", "ž"),
    ("zdotaccent", "ż"),
    ("zero", "0"),
    ("zeta", "ζ"),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agl_subset_is_sorted_and_unique() {
        for w in AGL_SUBSET.windows(2) {
            assert!(w[0].0 < w[1].0, "{} >= {}", w[0].0, w[1].0);
        }
    }

    #[test]
    fn resolves_plain_names() {
        assert_eq!(resolve_glyph_name("germandbls").as_deref(), Some("ß"));
        assert_eq!(resolve_glyph_name("adieresis").as_deref(), Some("ä"));
        assert_eq!(resolve_glyph_name("fl").as_deref(), Some("fl"));
        assert_eq!(resolve_glyph_name("ffi").as_deref(), Some("ffi"));
        assert_eq!(resolve_glyph_name("A").as_deref(), Some("A"));
        assert_eq!(resolve_glyph_name("space").as_deref(), Some(" "));
    }

    #[test]
    fn resolves_uni_and_u_forms() {
        assert_eq!(resolve_glyph_name("uni0041").as_deref(), Some("A"));
        assert_eq!(resolve_glyph_name("uniFB01").as_deref(), Some("fi"));
        assert_eq!(resolve_glyph_name("uni00410042").as_deref(), Some("AB"));
        assert_eq!(resolve_glyph_name("u1F600").as_deref(), Some("😀"));
        assert_eq!(resolve_glyph_name("u0041").as_deref(), Some("A"));
        // lowercase hex is not AGL-valid
        assert_eq!(resolve_glyph_name("uni00e9"), None);
        // surrogate halves are invalid
        assert_eq!(resolve_glyph_name("uniD800"), None);
    }

    #[test]
    fn resolves_compounds_and_suffixes() {
        assert_eq!(resolve_glyph_name("f_i").as_deref(), Some("fi"));
        assert_eq!(resolve_glyph_name("f_f_l").as_deref(), Some("ffl"));
        assert_eq!(resolve_glyph_name("fi.alt").as_deref(), Some("fi"));
        assert_eq!(resolve_glyph_name("uni0041.sc").as_deref(), Some("A"));
    }

    #[test]
    fn rejects_meaningless_names() {
        assert_eq!(resolve_glyph_name("g42"), None);
        assert_eq!(resolve_glyph_name("cid1234"), None);
        assert_eq!(resolve_glyph_name("glyph7"), None);
        assert_eq!(resolve_glyph_name(""), None);
        assert_eq!(resolve_glyph_name(".notdef"), None);
    }
}
