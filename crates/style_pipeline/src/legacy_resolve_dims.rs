use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;

use crate::legacy_urls;
use crate::CompileRequest;

pub(crate) fn apply_legacy_resolve_width_height(
    req: &CompileRequest,
    content: &str,
    file_abs: &Path,
) -> String {
    if !content.contains("resolve(") && !content.contains("width(") && !content.contains("height(") {
        return content.to_string();
    }

    let out = resolve_re()
        .replace_all(content, |caps: &regex::Captures<'_>| {
            let raw = quoted_arg_from_caps(caps);
            let path = legacy_urls::strip_quotes(&raw);
            let (path_part, suffix) = legacy_urls::split_url_suffix(path);
            if legacy_urls::should_keep_url_unmodified(path_part) {
                return format!("url(\"{}\")", path);
            }

            let rewritten = path_to_public_url(req, file_abs, path_part);
            format!("url(\"{}{}\")", rewritten, suffix)
        })
        .to_string();

    let out = width_re()
        .replace_all(&out, |caps: &regex::Captures<'_>| {
            let raw = quoted_arg_from_caps(caps);
            dimension_call_result(req, file_abs, &raw, true).unwrap_or_else(|| caps[0].to_string())
        })
        .to_string();

    let out = height_re()
        .replace_all(&out, |caps: &regex::Captures<'_>| {
            let raw = quoted_arg_from_caps(caps);
            dimension_call_result(req, file_abs, &raw, false).unwrap_or_else(|| caps[0].to_string())
        })
        .to_string();

    normalize_calc_unary_minus(&out)
}

fn resolve_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"resolve\(\s*(?:'([^']+)'|"([^"]+)")\s*\)"#).expect("resolve regex must compile")
    })
}

fn width_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"width\(\s*(?:'([^']+)'|"([^"]+)")\s*\)"#).expect("width regex must compile")
    })
}

fn height_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"height\(\s*(?:'([^']+)'|"([^"]+)")\s*\)"#).expect("height regex must compile")
    })
}

fn quoted_arg_from_caps(caps: &regex::Captures<'_>) -> String {
    caps.get(1)
        .or_else(|| caps.get(2))
        .map(|m| m.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

fn path_to_public_url(req: &CompileRequest, file_abs: &Path, path_part: &str) -> String {
    let joined = resolve_asset_path(req, file_abs, path_part)
        .unwrap_or_else(|| file_abs.parent().unwrap_or(Path::new("")).join(path_part));
    let rel = joined.strip_prefix(&req.cwd).unwrap_or(&joined);
    format!("/{}", normalize_slashes(&rel.to_string_lossy()))
}

fn normalize_slashes(s: &str) -> String {
    s.replace('\\', "/")
}

fn dimension_call_result(req: &CompileRequest, file_abs: &Path, raw: &str, use_width: bool) -> Option<String> {
    let path = legacy_urls::strip_quotes(raw);
    let (path_part, _) = legacy_urls::split_url_suffix(path);
    if legacy_urls::should_keep_url_unmodified(path_part) {
        return None;
    }

    let abs = resolve_asset_path(&req, file_abs, path_part)
        .unwrap_or_else(|| file_abs.parent().unwrap_or(Path::new("")).join(path_part));
    let (w, h) = image_dimensions(&abs)?;
    if use_width {
        Some(format!("{w}px"))
    } else {
        Some(format!("{h}px"))
    }
}

fn resolve_asset_path(req: &CompileRequest, file_abs: &Path, path_part: &str) -> Option<PathBuf> {
    let mut candidates = Vec::<PathBuf>::new();
    let current_dir = file_abs.parent().unwrap_or(Path::new(""));
    candidates.push(current_dir.join(path_part));
    candidates.push(req.cwd.join(path_part));

    // Legacy postcss-assets parity: loadPaths includes <root>/img/dest.
    let out_dir_abs = if req.config.out_dir.is_absolute() {
        req.config.out_dir.clone()
    } else {
        req.cwd.join(&req.config.out_dir)
    };
    let root_dir = out_dir_abs.parent().unwrap_or(&req.cwd);
    candidates.push(root_dir.join("img").join("dest").join(path_part));
    candidates.push(root_dir.join("img").join(path_part));
    candidates.push(req.cwd.join("assets").join("img").join("dest").join(path_part));
    candidates.push(req.cwd.join("assets").join("img").join(path_part));

    for root in &req.config.import_roots {
        let abs_root = if root.is_absolute() {
            root.clone()
        } else {
            req.cwd.join(root)
        };
        candidates.push(abs_root.join(path_part));
        candidates.push(abs_root.join("img").join("dest").join(path_part));
    }

    candidates.into_iter().find(|p| p.exists())
}

fn image_dimensions(path: &Path) -> Option<(u32, u32)> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "png" => png_dimensions(path),
        "gif" => gif_dimensions(path),
        "jpg" | "jpeg" => jpeg_dimensions(path),
        "svg" => svg_dimensions(path),
        _ => None,
    }
}

fn normalize_calc_unary_minus(content: &str) -> String {
    calc_re()
        .replace_all(content, |caps: &regex::Captures<'_>| {
            let expr = caps.get(1).map(|m| m.as_str()).unwrap_or_default();
            format!("calc({})", normalize_unary_minus_expr(expr))
        })
        .to_string()
}

fn calc_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"calc\(([^)]*)\)"#).expect("calc regex must compile"))
}

fn normalize_unary_minus_expr(expr: &str) -> String {
    let chars: Vec<char> = expr.chars().collect();
    let mut out = String::with_capacity(expr.len());
    let mut i = 0usize;

    while i < chars.len() {
        if chars[i] == '-' {
            let prev_sig = out.chars().rev().find(|c| !c.is_whitespace());
            let is_unary = matches!(prev_sig, None | Some('(') | Some('+') | Some('-') | Some('*') | Some('/') | Some(','));
            if is_unary {
                let mut j = i + 1;
                while j < chars.len() && chars[j].is_whitespace() {
                    j += 1;
                }
                if j < chars.len() && (chars[j].is_ascii_digit() || chars[j] == '.') {
                    out.push('-');
                    i = j;
                    continue;
                }
            }
        }

        out.push(chars[i]);
        i += 1;
    }

    out
}

fn png_dimensions(path: &Path) -> Option<(u32, u32)> {
    let data = fs::read(path).ok()?;
    if data.len() < 24 {
        return None;
    }
    if &data[0..8] != b"\x89PNG\r\n\x1a\n" {
        return None;
    }
    if &data[12..16] != b"IHDR" {
        return None;
    }
    let w = u32::from_be_bytes([data[16], data[17], data[18], data[19]]);
    let h = u32::from_be_bytes([data[20], data[21], data[22], data[23]]);
    Some((w, h))
}

fn gif_dimensions(path: &Path) -> Option<(u32, u32)> {
    let data = fs::read(path).ok()?;
    if data.len() < 10 {
        return None;
    }
    if &data[0..3] != b"GIF" {
        return None;
    }
    let w = u16::from_le_bytes([data[6], data[7]]) as u32;
    let h = u16::from_le_bytes([data[8], data[9]]) as u32;
    Some((w, h))
}

fn jpeg_dimensions(path: &Path) -> Option<(u32, u32)> {
    let data = fs::read(path).ok()?;
    if data.len() < 4 || data[0] != 0xFF || data[1] != 0xD8 {
        return None;
    }

    let mut i = 2usize;
    while i + 3 < data.len() {
        if data[i] != 0xFF {
            i += 1;
            continue;
        }
        let marker = data[i + 1];
        i += 2;
        if marker == 0xD8 || marker == 0xD9 {
            continue;
        }
        if i + 1 >= data.len() {
            return None;
        }
        let seg_len = u16::from_be_bytes([data[i], data[i + 1]]) as usize;
        if seg_len < 2 || i + seg_len > data.len() {
            return None;
        }

        let is_sof = matches!(
            marker,
            0xC0 | 0xC1 | 0xC2 | 0xC3 | 0xC5 | 0xC6 | 0xC7 | 0xC9 | 0xCA | 0xCB | 0xCD | 0xCE | 0xCF
        );
        if is_sof && seg_len >= 7 {
            let h = u16::from_be_bytes([data[i + 3], data[i + 4]]) as u32;
            let w = u16::from_be_bytes([data[i + 5], data[i + 6]]) as u32;
            return Some((w, h));
        }
        i += seg_len;
    }
    None
}

fn svg_dimensions(path: &Path) -> Option<(u32, u32)> {
    let raw = fs::read_to_string(path).ok()?;
    let width = attr_px_value(&raw, "width");
    let height = attr_px_value(&raw, "height");
    if let (Some(w), Some(h)) = (width, height) {
        return Some((w, h));
    }

    let vb = viewbox_re().captures(&raw)?;
    let w = vb.get(3)?.as_str().parse::<f32>().ok()?;
    let h = vb.get(4)?.as_str().parse::<f32>().ok()?;
    Some((w.round() as u32, h.round() as u32))
}

fn attr_px_value(raw: &str, name: &str) -> Option<u32> {
    let re = match name {
        "width" => width_attr_re(),
        "height" => height_attr_re(),
        _ => return None,
    };
    let caps = re.captures(raw)?;
    let value = caps.get(1)?.as_str().trim();
    parse_svg_len(value)
}

fn parse_svg_len(value: &str) -> Option<u32> {
    let lower = value.to_ascii_lowercase();
    let cleaned = lower
        .strip_suffix("px")
        .or_else(|| lower.strip_suffix("pt"))
        .or_else(|| lower.strip_suffix("pc"))
        .or_else(|| lower.strip_suffix("cm"))
        .or_else(|| lower.strip_suffix("mm"))
        .or_else(|| lower.strip_suffix("in"))
        .or_else(|| lower.strip_suffix("%"))
        .unwrap_or(&lower)
        .trim();
    let num = cleaned.parse::<f32>().ok()?;
    Some(num.round() as u32)
}

fn width_attr_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"width\s*=\s*["']([^"']+)["']"#).expect("width attr regex must compile"))
}

fn height_attr_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"height\s*=\s*["']([^"']+)["']"#).expect("height attr regex must compile"))
}

fn viewbox_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"viewBox\s*=\s*["']\s*([0-9.+-]+)[\s,]+([0-9.+-]+)[\s,]+([0-9.+-]+)[\s,]+([0-9.+-]+)\s*["']"#)
            .expect("viewBox regex must compile")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn png_header_dimensions_are_detected() {
        let path = PathBuf::from("/tmp/non-existent.png");
        let _ = path;
        let data = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x10\0\0\0\x20\x08\x06\0\0\0";
        let tmp = std::env::temp_dir().join("style-pipeline-png-dim-test.png");
        fs::write(&tmp, data).expect("write png test");
        let got = png_dimensions(&tmp).expect("png dims");
        assert_eq!(got, (16, 32));
        let _ = fs::remove_file(tmp);
    }
}
