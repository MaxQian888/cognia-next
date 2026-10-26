//! Best-effort repair for PDFs whose page annotations contain form widgets
//! but whose catalog omits `/AcroForm`.

use std::collections::HashSet;

use lopdf::{
    Document as LoDocument, IncrementalDocument, Object, ObjectId, StringFormat, dictionary,
};
use pdfium::Library;

use crate::types::PdfInput;

/// Return a verified in-memory incremental repair, or `None` when the input is
/// already healthy, is ineligible, or cannot be repaired safely.
pub(crate) fn repair_orphaned_widgets(
    lib: &Library,
    input: &PdfInput,
    password: Option<&str>,
) -> Option<PdfInput> {
    let bytes = match input {
        PdfInput::Bytes(bytes) => bytes.clone(),
        #[cfg(not(target_arch = "wasm32"))]
        PdfInput::Path(path) => std::fs::read(path).ok()?,
        #[cfg(target_arch = "wasm32")]
        PdfInput::Path(_) => return None,
    };
    if !bytes
        .windows(b"/Widget".len())
        .any(|window| window == b"/Widget")
    {
        return None;
    }

    let (pages_before, form_type_before) = {
        let document = lib.load_document_from_bytes(&bytes, password).ok()?;
        (document.page_count(), document.form_type())
    };
    if form_type_before != 0 {
        return None;
    }

    let parsed = LoDocument::load_mem(&bytes).ok()?;
    if parsed.trailer.has(b"Encrypt") {
        return None;
    }
    let root_id = parsed.trailer.get(b"Root").ok()?.as_reference().ok()?;
    let catalog = parsed.get_dictionary(root_id).ok()?;
    if catalog.has(b"AcroForm") {
        return None;
    }
    let (field_refs, first_widget_page) = collect_orphaned_fields(&parsed)?;

    let mut update = IncrementalDocument::create_from(bytes, parsed);
    update.opt_clone_object_to_new_document(root_id).ok()?;
    let acroform_id = update.new_document.add_object(dictionary! {
        "Fields" => Object::Array(field_refs.into_iter().map(Object::Reference).collect()),
        "NeedAppearances" => true,
        "DA" => Object::String(b"/Helv 0 Tf 0 g".to_vec(), StringFormat::Literal),
    });
    update
        .new_document
        .get_dictionary_mut(root_id)
        .ok()?
        .set("AcroForm", Object::Reference(acroform_id));

    let mut repaired = Vec::new();
    update.save_to(&mut repaired).ok()?;

    let accepted = {
        let document = lib.load_document_from_bytes(&repaired, password).ok()?;
        if document.page_count() != pages_before || document.form_type() == 0 {
            false
        } else if let Some(form) = document.form_environment() {
            document
                .page(first_widget_page as i32)
                .ok()
                .is_some_and(|page| {
                    let view_box = page.view_box().unwrap_or(pdfium::RectF {
                        left: 0.0,
                        top: page.height(),
                        right: page.width(),
                        bottom: 0.0,
                    });
                    !page
                        .form_fields(&form, &view_box, first_widget_page + 1)
                        .is_empty()
                })
        } else {
            false
        }
    };
    accepted.then_some(PdfInput::Bytes(repaired))
}

fn collect_orphaned_fields(document: &LoDocument) -> Option<(Vec<ObjectId>, u32)> {
    let mut seen = HashSet::new();
    let mut fields = Vec::new();
    let mut first_page = None;

    for (page_number, page_id) in document.get_pages() {
        let page = document.get_dictionary(page_id).ok()?;
        let Ok(annots) = page.get(b"Annots") else {
            continue;
        };
        let (_, annots) = document.dereference(annots).ok()?;
        let Ok(annots) = annots.as_array() else {
            continue;
        };
        for entry in annots {
            let Ok(widget_id) = entry.as_reference() else {
                continue;
            };
            let Ok(widget) = document.get_dictionary(widget_id) else {
                continue;
            };
            if widget
                .get(b"Subtype")
                .ok()
                .and_then(|value| value.as_name().ok())
                != Some(b"Widget")
            {
                continue;
            }
            let field_id = widget
                .get(b"Parent")
                .ok()
                .and_then(|value| value.as_reference().ok())
                .or_else(|| widget.has(b"FT").then_some(widget_id));
            let Some(field_id) = field_id else { continue };
            first_page.get_or_insert(page_number.saturating_sub(1));
            if seen.insert(field_id) {
                fields.push(field_id);
            }
        }
    }
    Some((fields, first_page?))
}

#[cfg(test)]
mod tests {
    use lopdf::{Document, Object, Stream, StringFormat, dictionary};

    use crate::{config::LiteParseConfig, parser::LiteParse, types::PdfInput};

    #[test]
    fn widget_marker_gate_handles_split_positions() {
        let bytes = [b"prefix".as_slice(), b"/Widget", b"suffix"].concat();
        assert!(bytes.windows(7).any(|window| window == b"/Widget"));
    }

    fn form_pdf(include_acroform: bool) -> Vec<u8> {
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let widget_id = doc.add_object(dictionary! {
            "Type" => "Annot",
            "Subtype" => "Widget",
            "FT" => "Tx",
            "T" => Object::String(b"customer_name".to_vec(), StringFormat::Literal),
            "V" => Object::String(b"Ada Lovelace".to_vec(), StringFormat::Literal),
            "Rect" => vec![10.into(), 10.into(), 200.into(), 35.into()],
            "F" => 4,
        });
        let content_id = doc.add_object(Stream::new(dictionary! {}, Vec::new()));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            "Annots" => vec![Object::Reference(widget_id)],
            "Contents" => content_id,
        });
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![Object::Reference(page_id)],
                "Count" => 1,
            }),
        );
        let acroform_id = include_acroform.then(|| {
            doc.add_object(dictionary! {
                "Fields" => vec![Object::Reference(widget_id)],
                "NeedAppearances" => true,
                "DA" => Object::String(b"/Helv 0 Tf 0 g".to_vec(), StringFormat::Literal),
            })
        });
        let mut catalog = dictionary! { "Type" => "Catalog", "Pages" => pages_id };
        if let Some(acroform_id) = acroform_id {
            catalog.set("AcroForm", acroform_id);
        }
        let catalog_id = doc.add_object(catalog);
        doc.trailer.set("Root", catalog_id);
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        bytes
    }

    #[tokio::test]
    async fn extracts_healthy_acroform_fields_only_when_enabled() {
        let bytes = form_pdf(true);
        let disabled = LiteParse::new(LiteParseConfig {
            ocr_enabled: false,
            ..Default::default()
        })
        .parse_input(PdfInput::Bytes(bytes.clone()))
        .await
        .unwrap();
        assert!(disabled.pages[0].form_fields.is_none());

        let enabled = LiteParse::new(LiteParseConfig {
            ocr_enabled: false,
            extract_form_fields: true,
            ..Default::default()
        })
        .parse_input(PdfInput::Bytes(bytes))
        .await
        .unwrap();
        let fields = enabled.pages[0].form_fields.as_ref().unwrap();
        assert_eq!(fields.len(), 1);
        assert_eq!(fields[0].name.as_deref(), Some("customer_name"));
        assert_eq!(fields[0].value.as_deref(), Some("Ada Lovelace"));
        assert_eq!(fields[0].field_type, "text");
    }

    #[tokio::test]
    async fn repairs_orphaned_widgets_before_extraction() {
        let result = LiteParse::new(LiteParseConfig {
            ocr_enabled: false,
            extract_form_fields: true,
            ..Default::default()
        })
        .parse_input(PdfInput::Bytes(form_pdf(false)))
        .await
        .unwrap();
        let fields = result.pages[0].form_fields.as_ref().unwrap();
        assert_eq!(fields.len(), 1);
        assert_eq!(fields[0].value.as_deref(), Some("Ada Lovelace"));
    }
}
