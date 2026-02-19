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
    if !without_defs.contains("@mixin") {
        return without_defs;
    }

    for _ in 0..8 {
        let (expanded, changed) = expand_legacy_mixin_calls(&without_defs, &mixins);
        if !changed {
            break;
        }
        without_defs = expanded;
        if !without_defs.contains("@mixin") {
            break;
        }
    }
    without_defs
}

#[derive(Debug, Clone)]
struct MixinDef {
    body: String,
    body_without_content: Option<String>,
}

impl MixinDef {
    fn from_body(body: String) -> Self {
        let body_without_content = if body.contains("@mixin-content") {
            Some(mixin_content_re().replace_all(&body, "").into_owned())
        } else {
            None
        };
        Self {
            body,
            body_without_content,
        }
    }

    fn has_content_placeholder(&self) -> bool {
        self.body_without_content.is_some()
    }
}

fn extract_legacy_mixin_definitions(content: &str) -> (String, HashMap<String, MixinDef>) {
    let mut out = String::with_capacity(content.len());
    let mut mixins = HashMap::<String, MixinDef>::new();
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
                mixins.insert(name.to_string(), MixinDef::from_body(body));
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

fn expand_legacy_mixin_calls(content: &str, mixins: &HashMap<String, MixinDef>) -> (String, bool) {
    let mixin_content_re = mixin_content_re();
    let mut out = String::with_capacity(content.len());
    let bytes = content.as_bytes();
    let mut i = 0usize;
    let mut changed = false;

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

            if let Some(mixin) = mixins.get(name) {
                if j < bytes.len() && bytes[j] == b';' {
                    if let Some(body) = &mixin.body_without_content {
                        out.push_str(body);
                    } else {
                        out.push_str(&mixin.body);
                    }
                    i = j + 1;
                    changed = true;
                    continue;
                }
                if j < bytes.len() && bytes[j] == b'{' {
                    if let Some((inner, end)) = crate::parse_balanced_block(content, j) {
                        if mixin.has_content_placeholder() {
                            let expanded = mixin_content_re.replace_all(&mixin.body, inner).into_owned();
                            out.push_str(&expanded);
                        } else {
                            out.push_str(&mixin.body);
                        }
                        i = end;
                        changed = true;
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

    (out, changed)
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
