use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;

use crate::{CompileRequest, PipelineError};

#[derive(Default)]
pub(crate) struct PreprocessImportCache {
    source_cache: HashMap<PathBuf, String>,
    resolve_cache: HashMap<(PathBuf, String), PathBuf>,
    canonical_cache: HashMap<PathBuf, PathBuf>,
}

pub(crate) fn preprocess_source_recursive(
    req: &CompileRequest,
    file_abs: &Path,
    stack: &mut HashSet<PathBuf>,
    cache: &mut PreprocessImportCache,
) -> Result<String, PipelineError> {
    let canonical = canonicalize_cached(file_abs, cache).map_err(|err| {
        PipelineError::Resolve(format!(
            "Failed to resolve css file '{}': {err}",
            file_abs.display()
        ))
    })?;

    if let Some(cached) = cache.source_cache.get(&canonical) {
        return Ok(cached.clone());
    }

    if stack.contains(&canonical) {
        return Err(PipelineError::Resolve(format!(
            "Circular @import detected at '{}'",
            file_abs.display()
        )));
    }
    stack.insert(canonical.clone());

    let mut source = std::fs::read_to_string(&canonical).map_err(|err| {
        PipelineError::Io(format!(
            "Failed to read css file '{}': {err}",
            canonical.display()
        ))
    })?;

    if req.config.asset.rewrite_urls {
        source = crate::apply_legacy_import_url_rewrite(req, &source, &canonical);
    }
    source = crate::apply_legacy_resolve_width_height(req, &source, &canonical);
    source = crate::apply_legacy_svg_function(req, &source, &canonical);

    if !source.contains("@import") {
        stack.remove(&canonical);
        return Ok(source);
    }
    // Equivalent to postcss-import style flattening for simple `@import "..."` forms.
    let import_re = import_re();
    let source_scan = mask_css_comments_for_import_scan(&source);
    let mut result = String::new();
    let mut last = 0usize;

    for capture in import_re.captures_iter(&source_scan) {
        let Some(m) = capture.get(0) else {
            continue;
        };
        let Some(spec) = capture.get(1) else {
            continue;
        };

        result.push_str(&source[last..m.start()]);
        let spec = spec.as_str().trim();

        if is_external_import(spec) {
            result.push_str(m.as_str());
        } else {
            let resolved = resolve_import_path(
                req,
                canonical.parent().unwrap_or(Path::new("")),
                spec,
                cache,
            )?;
            let imported = preprocess_source_recursive(req, &resolved, stack, cache)?;
            result.push_str(&imported);
            if !imported.ends_with('\n') {
                result.push('\n');
            }
        }
        last = m.end();
    }
    result.push_str(&source[last..]);

    stack.remove(&canonical);
    cache.source_cache.insert(canonical, result.clone());
    Ok(result)
}

fn canonicalize_cached(path: &Path, cache: &mut PreprocessImportCache) -> std::io::Result<PathBuf> {
    let key = path.to_path_buf();
    if let Some(cached) = cache.canonical_cache.get(&key) {
        return Ok(cached.clone());
    }
    let canonical = std::fs::canonicalize(path)?;
    cache.canonical_cache.insert(key, canonical.clone());
    Ok(canonical)
}

fn import_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?m)^\s*@import\s+(?:url\()?\s*["']([^"']+)["']\s*\)?\s*;\s*$"#)
            .expect("import regex must compile")
    })
}

fn mask_css_comments_for_import_scan(input: &str) -> String {
    let mut out = input.as_bytes().to_vec();
    let bytes = input.as_bytes();
    let mut i = 0usize;
    let mut in_single = false;
    let mut in_double = false;
    let mut escaped = false;

    while i < bytes.len() {
        let b = bytes[i];
        let next = bytes.get(i + 1).copied();

        if in_single {
            if !escaped && b == b'\'' {
                in_single = false;
            }
            escaped = b == b'\\' && !escaped;
            i += 1;
            continue;
        }
        if in_double {
            if !escaped && b == b'"' {
                in_double = false;
            }
            escaped = b == b'\\' && !escaped;
            i += 1;
            continue;
        }

        if b == b'\'' {
            in_single = true;
            escaped = false;
            i += 1;
            continue;
        }
        if b == b'"' {
            in_double = true;
            escaped = false;
            i += 1;
            continue;
        }

        if b == b'/' && next == Some(b'*') {
            out[i] = b' ';
            if i + 1 < out.len() {
                out[i + 1] = b' ';
            }
            i += 2;
            while i < bytes.len() {
                let cb = bytes[i];
                let cn = bytes.get(i + 1).copied();
                if cb == b'*' && cn == Some(b'/') {
                    out[i] = b' ';
                    if i + 1 < out.len() {
                        out[i + 1] = b' ';
                    }
                    i += 2;
                    break;
                }
                out[i] = if cb == b'\n' { b'\n' } else { b' ' };
                i += 1;
            }
            continue;
        }

        if b == b'/' && next == Some(b'/') {
            out[i] = b' ';
            if i + 1 < out.len() {
                out[i + 1] = b' ';
            }
            i += 2;
            while i < bytes.len() {
                let cb = bytes[i];
                if cb == b'\n' {
                    i += 1;
                    break;
                }
                out[i] = b' ';
                i += 1;
            }
            continue;
        }
        i += 1;
    }

    String::from_utf8(out).expect("masked css bytes must remain valid utf-8")
}

fn resolve_import_path(
    req: &CompileRequest,
    current_dir: &Path,
    spec: &str,
    cache: &mut PreprocessImportCache,
) -> Result<PathBuf, PipelineError> {
    let cache_key = (current_dir.to_path_buf(), spec.to_string());
    if let Some(found) = cache.resolve_cache.get(&cache_key) {
        return Ok(found.clone());
    }

    let mut candidates = Vec::<PathBuf>::new();
    let spec_path = PathBuf::from(spec);

    if spec_path.is_absolute() {
        candidates.push(spec_path);
    } else {
        candidates.push(current_dir.join(&spec_path));
        for root in &req.config.import_roots {
            let abs_root = if root.is_absolute() {
                root.clone()
            } else {
                req.cwd.join(root)
            };
            candidates.push(abs_root.join(&spec_path));
        }
    }

    for candidate in candidates {
        if let Some(found) = candidate_with_css_extension(candidate) {
            cache.resolve_cache.insert(cache_key, found.clone());
            return Ok(found);
        }
    }

    Err(PipelineError::Resolve(format!(
        "Failed to resolve @import '{}'",
        spec
    )))
}

fn candidate_with_css_extension(candidate: PathBuf) -> Option<PathBuf> {
    if candidate.exists() {
        return Some(candidate);
    }
    if candidate.extension().is_none() {
        let css = candidate.with_extension("css");
        if css.exists() {
            return Some(css);
        }
    }
    None
}

fn is_external_import(spec: &str) -> bool {
    spec.starts_with("http://")
        || spec.starts_with("https://")
        || spec.starts_with("data:")
        || spec.starts_with("//")
}
