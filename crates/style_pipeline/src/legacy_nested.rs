pub(crate) fn apply_legacy_nested_selectors(content: &str) -> String {
    flatten_css_level(content)
}

fn flatten_css_level(content: &str) -> String {
    let mut out = String::with_capacity(content.len());
    let bytes = content.as_bytes();
    let mut i = 0usize;
    let mut last = 0usize;

    while i < bytes.len() {
        if bytes[i] == b'{' {
            let prelude = sanitize_selector_prelude(content[last..i].trim());
            if let Some((inner, end)) = crate::parse_balanced_block(content, i) {
                if prelude.starts_with('@') {
                    // Keep at-rules structure, but flatten inside.
                    out.push_str(&content[last..i]);
                    out.push('{');
                    out.push_str(&flatten_css_level(&inner));
                    out.push('}');
                } else {
                    let selectors = split_selectors(prelude);
                    if selectors.is_empty() {
                        out.push_str(&content[last..end]);
                    } else {
                        out.push_str(&flatten_rule_block(&selectors, &inner));
                    }
                }
                i = end;
                last = end;
                continue;
            }
        }
        i += 1;
    }

    if last < content.len() {
        out.push_str(&content[last..]);
    }
    out
}

fn flatten_rule_block(parent_selectors: &[String], inner: &str) -> String {
    let mut local = String::new();
    let mut nested_out = String::new();
    let bytes = inner.as_bytes();
    let mut i = 0usize;
    let mut last = 0usize;

    while i < bytes.len() {
        if bytes[i] == b'{' {
            let segment = &inner[last..i];
            let (local_prefix, raw_prelude) = split_local_prefix_and_prelude(segment);
            let prelude = sanitize_selector_prelude(raw_prelude);
            if let Some((child_inner, end)) = crate::parse_balanced_block(inner, i) {
                if prelude.starts_with('@') {
                    local.push_str(local_prefix);
                    local.push_str(prelude);
                    // Preserve nested at-rules in-place under current selector.
                    local.push('{');
                    local.push_str(&flatten_css_level(&child_inner));
                    local.push('}');
                } else {
                    local.push_str(local_prefix);
                    let child_selectors = split_selectors(prelude);
                    if child_selectors.is_empty() {
                        local.push_str(prelude);
                        local.push('{');
                        local.push_str(&child_inner);
                        local.push('}');
                    } else {
                        let combined = combine_selectors(parent_selectors, &child_selectors);
                        nested_out.push_str(&flatten_rule_block(&combined, &child_inner));
                    }
                }
                i = end;
                last = end;
                continue;
            }
        }
        i += 1;
    }
    if last < inner.len() {
        local.push_str(&inner[last..]);
    }

    let mut out = String::new();
    if !local.trim().is_empty() {
        out.push_str(&parent_selectors.join(", "));
        out.push_str(" {\n");
        out.push_str(local.trim());
        out.push_str("\n}\n");
    }
    out.push_str(&nested_out);
    out
}

fn split_local_prefix_and_prelude(segment: &str) -> (&str, &str) {
    let bytes = segment.as_bytes();
    let mut i = 0usize;
    let mut in_single = false;
    let mut in_double = false;
    let mut in_line_comment = false;
    let mut in_block_comment = false;
    let mut escaped = false;
    let mut paren = 0i32;
    let mut bracket = 0i32;
    let mut last_stmt_end = 0usize;

    while i < bytes.len() {
        let b = bytes[i];
        let next = bytes.get(i + 1).copied();

        if in_line_comment {
            if b == b'\n' {
                in_line_comment = false;
            }
            i += 1;
            continue;
        }
        if in_block_comment {
            if b == b'*' && next == Some(b'/') {
                in_block_comment = false;
                i += 2;
            } else {
                i += 1;
            }
            continue;
        }
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

        if b == b'/' && next == Some(b'/') {
            in_line_comment = true;
            i += 2;
            continue;
        }
        if b == b'/' && next == Some(b'*') {
            in_block_comment = true;
            i += 2;
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

        match b {
            b'(' => paren += 1,
            b')' => paren -= 1,
            b'[' => bracket += 1,
            b']' => bracket -= 1,
            b';' if paren == 0 && bracket == 0 => last_stmt_end = i + 1,
            _ => {}
        }

        i += 1;
    }

    let mut prelude_start = last_stmt_end;
    while prelude_start < segment.len() && segment.as_bytes()[prelude_start].is_ascii_whitespace()
    {
        prelude_start += 1;
    }

    let mut local_prefix = &segment[..prelude_start];
    let mut prelude = segment[prelude_start..].trim();
    if prelude.contains(';') {
        if let Some(pos) = segment.rfind(';') {
            let split_at = (pos + 1).min(segment.len());
            local_prefix = &segment[..split_at];
            prelude = segment[split_at..].trim();
        }
    }
    (local_prefix, prelude)
}

fn sanitize_selector_prelude(mut prelude: &str) -> &str {
    loop {
        let trimmed = prelude.trim_start();
        if trimmed.starts_with("/*") {
            if let Some(end) = trimmed.find("*/") {
                prelude = &trimmed[end + 2..];
                continue;
            }
        }
        if trimmed.starts_with("//") {
            if let Some(end) = trimmed.find('\n') {
                prelude = &trimmed[end + 1..];
                continue;
            }
            return "";
        }
        return trimmed;
    }
}

fn split_selectors(prelude: &str) -> Vec<String> {
    let mut parts = Vec::<String>::new();
    let mut cur = String::new();
    let mut paren = 0i32;
    let mut bracket = 0i32;
    let mut in_single = false;
    let mut in_double = false;
    let mut escaped = false;

    for ch in prelude.chars() {
        if in_single {
            cur.push(ch);
            if !escaped && ch == '\'' {
                in_single = false;
            }
            escaped = ch == '\\' && !escaped;
            continue;
        }
        if in_double {
            cur.push(ch);
            if !escaped && ch == '"' {
                in_double = false;
            }
            escaped = ch == '\\' && !escaped;
            continue;
        }

        match ch {
            '\'' => {
                in_single = true;
                escaped = false;
                cur.push(ch);
            }
            '"' => {
                in_double = true;
                escaped = false;
                cur.push(ch);
            }
            '(' => {
                paren += 1;
                cur.push(ch);
            }
            ')' => {
                paren -= 1;
                cur.push(ch);
            }
            '[' => {
                bracket += 1;
                cur.push(ch);
            }
            ']' => {
                bracket -= 1;
                cur.push(ch);
            }
            ',' if paren == 0 && bracket == 0 => {
                let s = cur.trim();
                if !s.is_empty() {
                    parts.push(s.to_string());
                }
                cur.clear();
            }
            _ => cur.push(ch),
        }
    }
    let tail = cur.trim();
    if !tail.is_empty() {
        parts.push(tail.to_string());
    }
    parts
}

fn combine_selectors(parents: &[String], children: &[String]) -> Vec<String> {
    let mut out = Vec::<String>::new();
    for p in parents {
        for c in children {
            let combined = if c.contains('&') {
                c.replace('&', p)
            } else {
                format!("{p} {c}")
            };
            out.push(combined.trim().to_string());
        }
    }
    out
}
