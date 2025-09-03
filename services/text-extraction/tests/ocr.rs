use base64;
use text_extraction::extract_text;

#[tokio::test]
async fn pdf_to_text() {
    let pdf_data = base64::decode("JVBERi0xLjQKMSAwIG9iaiA8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iaiA8PC9UeXBlL1BhZ2VzL0tpZHMgWzMgMCBSXS9Db3VudCAxPj4KZW5kb2JqCjMgMCBvYmoKPDwvVHlwZS9QYWdlL1BhcmVudCAyIDAgUi9Db250ZW50cyA0IDAgUi9NZWRpYUJveCBbMCAwIDIwMCAyMDBdPj4KZW5kb2JqCjQgMCBvYmoKPDwvTGVuZ3RoIDQ0Pj4Kc3RyZWFtCkJUL0YxIDI0IFRmIDEwMCAxMDAgVGQgKEhlbGxvKSBUagpFVAplbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA1CjAwMDAwMDAwMDAgNjU1MzUgZgowMDAwMDAwMDEwIDAwMDAwIG4gCjAwMDAwMDAwNjEgMDAwMDAgbiAKMDAwMDAwMDAxMTcgMDAwMDAgbiAKMDAwMDAwMDAxOTkgMDAwMDAgbiAKdHJhaWxlcgo8PC9TaXplIDUvUm9vdCAxIDAgUj4+CnN0YXJ0eHJlZgo3MjYKJSVFT0YK").unwrap();
    let path = "/tmp/test.pdf";
    tokio::fs::write(path, pdf_data).await.unwrap();
    let txt = extract_text(path).await.unwrap();
    assert!(txt.len() > 0);
    let _ = tokio::fs::remove_file(path).await;
}
