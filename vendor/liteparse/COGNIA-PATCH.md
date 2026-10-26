# Cognia LiteParse security patch

This directory contains the published `liteparse` 2.15.1 crate from crates.io,
upstream revision `ab8879623ee45a0b7a775d12b42a9a7ae9dab16b`
(`crates/liteparse`). Sources, README, original manifest and VCS metadata are preserved. Upstream
tests are retained, with two additional co-located regression tests for XMP
loading and a deeply nested malicious Catalog in src/document_metadata.rs. The crates.io archive SHA-256 is
`aebab0be136b71fe6003ee23eb397f798863165ff3a6f959438267c5317b894c`.
The Apache-2.0 LICENSE is copied from the same upstream revision.
The generated upstream Cargo.lock and local registry marker are omitted; the
repository root Cargo.lock owns dependency resolution.

The only functional patch is in Cargo.toml: the non-Wasm lopdf requirement
changes from `0.38` to `0.46.0`, fixing RUSTSEC-2026-0187. The original manifest
is retained unchanged as Cargo.toml.orig. PDFium stays at the existing version;
Cognia keeps LiteParse default features disabled. No OCR behavior is changed.

The root `[patch.crates-io]` redirects the existing optional parse-liteparse
consumer to this directory. A direct lopdf override cannot satisfy upstream's
`^0.38` constraint. Remove this directory, the root patch and workspace exclude
when an upstream LiteParse release requires lopdf >=0.42 and passes the same
PDF metadata, AcroForm repair and native parsing checks.

See docs/evidence/2026-10-22-rust-security-dependencies.md for validation and
known platform boundaries. No separately installed LiteParse tool is changed.
