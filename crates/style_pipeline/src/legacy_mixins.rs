use std::collections::HashMap;
use std::sync::OnceLock;

use regex::Regex;

pub(crate) fn apply_legacy_mixins(content: &str) -> String {
    if !content.contains("@define-mixin") && !content.contains("@mixin") {
        return content.to_string();
    }
    let (mut without_defs, mixins) = extract_legacy_mixin_definitions(content);
    if mixins.is_empty() {
        return without_defs;
    }

    for _ in 0..8 {
        let expanded = expand_legacy_mixin_calls(&without_defs, &mixins);
        if expanded == without_defs {
            break;
        }
        without_defs = expanded;
    }
    without_defs
}

fn extract_legacy_mixin_definitions(content: &str) -> (String, HashMap<String, String>) {
    let mut out = String::with_capacity(content.len());
    let mut mixins = HashMap::<String, String>::new();
    let bytes = content.as_bytes();
    let mut i = 0usize;

    while i < bytes.len() {
        if starts_with_bytes_at(bytes, i, b"@define-mixin") {
            let mut j = i + "@define-mixin".len();
            while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            let name_start = j;
            while j < bytes.len()
                && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'_' || bytes[j] == b'-')
            {
                j += 1;
            }
            let name = content.get(name_start..j).unwrap_or("").trim();
            while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            if name.is_empty() || j >= bytes.len() || bytes[j] != b'{' {
                let ch = content[i..].chars().next().unwrap_or('\0');
                if ch != '\0' {
                    out.push(ch);
                    i += ch.len_utf8();
                } else {
                    i += 1;
                }
                continue;
            }

            if let Some((body, end)) = crate::parse_balanced_block(content, j) {
                mixins.insert(name.to_string(), body);
                i = end;
                continue;
            }
        }

        let ch = content[i..].chars().next().unwrap_or('\0');
        if ch != '\0' {
            out.push(ch);
            i += ch.len_utf8();
        } else {
            i += 1;
        }
    }

    (out, mixins)
}

fn expand_legacy_mixin_calls(content: &str, mixins: &HashMap<String, String>) -> String {
    let mixin_content_re = mixin_content_re();
    let mut out = String::with_capacity(content.len());
    let bytes = content.as_bytes();
    let mut i = 0usize;

    while i < bytes.len() {
        if starts_with_bytes_at(bytes, i, b"@mixin") {
            let mut j = i + "@mixin".len();
            while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            let name_start = j;
            while j < bytes.len()
                && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'_' || bytes[j] == b'-')
            {
                j += 1;
            }
            let name = content.get(name_start..j).unwrap_or("").trim();
            if name.is_empty() {
                let ch = content[i..].chars().next().unwrap_or('\0');
                if ch != '\0' {
                    out.push(ch);
                    i += ch.len_utf8();
                } else {
                    i += 1;
                }
                continue;
            }

            while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                j += 1;
            }

            if let Some(body) = mixins.get(name) {
                if j < bytes.len() && bytes[j] == b';' {
                    let expanded = mixin_content_re.replace_all(body, "").to_string();
                    out.push_str(&expanded);
                    i = j + 1;
                    continue;
                }
                if j < bytes.len() && bytes[j] == b'{' {
                    if let Some((inner, end)) = crate::parse_balanced_block(content, j) {
                        let expanded = mixin_content_re.replace_all(body, inner).to_string();
                        out.push_str(&expanded);
                        i = end;
                        continue;
                    }
                }
            }
        }

        let ch = content[i..].chars().next().unwrap_or('\0');
        if ch != '\0' {
            out.push(ch);
            i += ch.len_utf8();
        } else {
            i += 1;
        }
    }

    out
}

fn mixin_content_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"@mixin-content\s*;?").expect("mixin-content regex must compile")
    })
}

fn starts_with_bytes_at(haystack: &[u8], offset: usize, needle: &[u8]) -> bool {
    haystack
        .get(offset..)
        .map(|tail| tail.starts_with(needle))
        .unwrap_or(false)
}
