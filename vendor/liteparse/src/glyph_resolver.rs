//! Optional out-of-tree glyph recovery hook.
//!
//! liteparse's built-in recovery for fonts with missing/garbage `/ToUnicode`
//! (PostScript glyph-name → Adobe Glyph List, then the embedded font program's
//! reverse cmap; see [`crate::extract`]) is deterministic but cannot decode
//! buggy/obfuscated fonts whose glyph names and cmap are also junk. A
//! [`GlyphResolver`] lets a caller plug in a richer recovery strategy — e.g. a
//! glyph-outline → unicode database — without liteparse taking on that
//! dependency.
//!
//! The resolver is supplied the glyph's *vector outline* (path segments), not a
//! pdfium handle, so the implementation needs no pdfium of its own and stays
//! decoupled from liteparse's font internals. It is consulted only as a last
//! resort, after the built-in recovery has failed on a glyph liteparse already
//! considers untrusted.

/// Font size, in points, at which glyph path segments are sampled before being
/// handed to a [`GlyphResolver`].
///
/// Resolvers that key on a hash of the outline must sample at this exact size
/// for their keys to line up.
pub const GLYPH_RESOLVER_FONT_SIZE: f32 = 10.0;

/// Recovers the unicode text for a glyph liteparse's built-in cmap/AGL recovery
/// could not decode, from the glyph's vector outline.
///
/// Implementations live out-of-tree (the published `@llamaindex/liteparse`
/// ships no resolver). Inject one with [`crate::LiteParse::with_glyph_resolver`].
pub trait GlyphResolver: Send + Sync {
    /// Resolve a glyph from its outline.
    ///
    /// `segments` is one `(segment_type, x, y)` triple per path segment, as
    /// produced by `pdfium::Font::glyph_path_segments` at
    /// [`GLYPH_RESOLVER_FONT_SIZE`] — `segment_type` is the raw pdfium
    /// `FPDF_SEGMENT_*` value (LINETO=0, BEZIERTO=1, MOVETO=2).
    ///
    /// Return the replacement text (one or more chars, e.g. for a ligature),
    /// or `None` if the glyph is not recognized.
    fn resolve(&self, segments: &[(i32, f32, f32)]) -> Option<String>;

    /// Resolve a glyph to a single codepoint, without the ligature expansion
    /// [`resolve`](Self::resolve) may apply. Used by the raw item mode
    /// ([`crate::raw_text`]), which maps every glyph to exactly one codepoint.
    /// The default derives it from `resolve` and answers `None` for
    /// multi-character replacements; a resolver backed by a codepoint database
    /// should override it to return the recorded value.
    fn resolve_codepoint(&self, segments: &[(i32, f32, f32)]) -> Option<u32> {
        let text = self.resolve(segments)?;
        let mut chars = text.chars();
        let c = chars.next()?;
        chars.next().is_none().then_some(c as u32)
    }
}
