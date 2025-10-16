//! Integration tests verifying the OCR extraction workflow.

use base64;
use text_extraction::{extract_text, extract_text_pages};

#[tokio::test]
async fn pdf_to_text() {
    let pdf_data = base64::decode("JVBERi0xLjQKMSAwIG9iaiA8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iaiA8PC9UeXBlL1BhZ2VzL0tpZHMgWzMgMCBSXS9Db3VudCAxPj4KZW5kb2JqCjMgMCBvYmoKPDwvVHlwZS9QYWdlL1BhcmVudCAyIDAgUi9Db250ZW50cyA0IDAgUi9NZWRpYUJveCBbMCAwIDIwMCAyMDBdPj4KZW5kb2JqCjQgMCBvYmoKPDwvTGVuZ3RoIDQ0Pj4Kc3RyZWFtCkJUL0YxIDI0IFRmIDEwMCAxMDAgVGQgKEhlbGxvKSBUagpFVAplbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA1CjAwMDAwMDAwMDAgNjU1MzUgZgowMDAwMDAwMDEwIDAwMDAwIG4gCjAwMDAwMDAwNjEgMDAwMDAgbiAKMDAwMDAwMDAxMTcgMDAwMDAgbiAKMDAwMDAwMDAxOTkgMDAwMDAgbiAKdHJhaWxlcgo8PC9TaXplIDUvUm9vdCAxIDAgUj4+CnN0YXJ0eHJlZgo3MjYKJSVFT0YK").unwrap();
    let path = "/tmp/test.pdf";
    tokio::fs::write(path, pdf_data).await.unwrap();
    let txt = extract_text(path).await.unwrap();
    assert!(txt.len() > 0);
    let _ = tokio::fs::remove_file(path).await;
}

#[tokio::test]
async fn ocr_image_pdf() {
    std::env::set_var("OCR_ENABLED", "1");
    std::env::set_var("LAYOUT_ENABLED", "0");
    std::env::set_var("MAX_PARALLEL_OCR", "1");

    let path = "/tmp/ocr_image.pdf";
    let pdf_data = base64::decode(include_str!("ocr_sample.b64")).unwrap();
    tokio::fs::write(path, pdf_data).await.unwrap();

    let pages = extract_text_pages(path).await.unwrap();
    assert!(!pages.is_empty());
    let page = &pages[0];
    assert!(page.ocr_used, "expected ocr fallback to be used");
    let char_count = page
        .text
        .to_lowercase()
        .chars()
        .filter(|c| !c.is_whitespace())
        .count();
    assert!(char_count > 0);

    let _ = tokio::fs::remove_file(path).await;
    std::env::remove_var("OCR_ENABLED");
    std::env::remove_var("LAYOUT_ENABLED");
    std::env::remove_var("MAX_PARALLEL_OCR");
}
