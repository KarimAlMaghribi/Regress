//! Helper utilities for combining and storing SharePoint sourced PDFs.

use std::path::{Path, PathBuf};

use std::collections::BTreeMap;

use anyhow::{anyhow, Context, Result};
use lopdf::{Document, Object, ObjectId};

/// Merges the provided PDF files into a single output document.
pub fn merge_pdfs(inputs: &[PathBuf], output: &Path) -> Result<()> {
    if inputs.is_empty() {
        anyhow::bail!("no pdf inputs provided");
    }

    let mut documents_objects: BTreeMap<ObjectId, Object> = BTreeMap::new();
    let mut documents_pages: BTreeMap<ObjectId, Object> = BTreeMap::new();
    let mut max_id = 1u32;

    for input in inputs {
        let mut doc = Document::load(input).with_context(|| format!("loading pdf {:?}", input))?;
        doc.renumber_objects_with(max_id);
        max_id = doc.max_id + 1;

        let pages = doc.get_pages();
        for page_id in pages.values() {
            if let Ok(page) = doc.get_object(*page_id) {
                documents_pages.insert(*page_id, page.clone());
            }
        }

        documents_objects.extend(doc.objects);
    }

    let mut document = Document::with_version("1.5");

    let mut catalog_object: Option<(ObjectId, Object)> = None;
    let mut pages_object: Option<(ObjectId, Object)> = None;

    for (object_id, object) in documents_objects.into_iter() {
        match object.type_name().unwrap_or(b"") {
            b"Catalog" => {
                if catalog_object.is_none() {
                    catalog_object = Some((object_id, object.clone()));
                }
            }
            b"Pages" => {
                if let Ok(dictionary) = object.as_dict() {
                    let mut dictionary = dictionary.clone();
                    if let Some((_, ref existing)) = pages_object {
                        if let Ok(existing_dict) = existing.as_dict() {
                            dictionary.extend(existing_dict);
                        }
                    }
                    pages_object = Some((object_id, Object::Dictionary(dictionary)));
                }
            }
            b"Page" | b"Outlines" | b"Outline" => {
                // handled later or ignored
            }
            _ => {
                document.objects.insert(object_id, object);
            }
        }
    }

    let (page_id, page_object) =
        pages_object.ok_or_else(|| anyhow!("no page tree found while merging"))?;

    for (object_id, object) in documents_pages.iter() {
        if let Ok(dictionary) = object.as_dict() {
            let mut dictionary = dictionary.clone();
            dictionary.set("Parent", page_id);
            document
                .objects
                .insert(*object_id, Object::Dictionary(dictionary));
        }
    }

    let (catalog_id, catalog_object) =
        catalog_object.ok_or_else(|| anyhow!("no catalog found while merging"))?;

    if let Ok(dictionary) = page_object.as_dict() {
        let mut dictionary = dictionary.clone();
        dictionary.set("Count", documents_pages.len() as u32);
        dictionary.set(
            "Kids",
            documents_pages
                .keys()
                .copied()
                .map(Object::Reference)
                .collect::<Vec<_>>(),
        );
        document
            .objects
            .insert(page_id, Object::Dictionary(dictionary));
    }

    if let Ok(dictionary) = catalog_object.as_dict() {
        let mut dictionary = dictionary.clone();
        dictionary.set("Pages", page_id);
        dictionary.remove(b"Outlines");
        document
            .objects
            .insert(catalog_id, Object::Dictionary(dictionary));
    }

    document.trailer.set("Root", catalog_id);
    document.max_id = document.objects.len() as u32;
    document.renumber_objects();
    document.adjust_zero_pages();
    document
        .save(output)
        .with_context(|| format!("saving merged pdf to {:?}", output))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    use lopdf::content::{Content, Operation};
    use lopdf::{dictionary, Object, Stream};

    fn write_test_pdf(path: &Path, text: &str) {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let font_id = doc.add_object(
            dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica" },
        );
        let resources_id =
            doc.add_object(dictionary! { "Font" => dictionary! { "F1" => font_id } });
        let operations = vec![
            Operation::new("BT", vec![]),
            Operation::new("Tf", vec!["F1".into(), 18.into()]),
            Operation::new("Td", vec![100.into(), 700.into()]),
            Operation::new("Tj", vec![Object::string_literal(text)]),
            Operation::new("ET", vec![]),
        ];
        let content = Content { operations };
        let content_id = doc.add_object(Stream::new(dictionary! {}, content.encode().unwrap()));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "Contents" => content_id,
            "Resources" => resources_id,
            "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
        });
        let pages = dictionary! {
            "Type" => "Pages",
            "Kids" => vec![page_id.into()],
            "Count" => 1,
        };
        doc.objects.insert(pages_id, Object::Dictionary(pages));
        let catalog_id = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", catalog_id);
        doc.save(path).expect("save test pdf");
    }

    #[test]
    fn merge_two_pdfs() {
        let dir = tempdir().unwrap();
        let pdf1 = dir.path().join("a.pdf");
        let pdf2 = dir.path().join("b.pdf");
        write_test_pdf(&pdf1, "Hello");
        write_test_pdf(&pdf2, "World");
        let merged = dir.path().join("merged.pdf");

        merge_pdfs(&[pdf1.clone(), pdf2.clone()], &merged).expect("merge works");

        assert!(merged.exists());
        let metadata = std::fs::metadata(&merged).unwrap();
        assert!(metadata.len() > 0);
    }
}
