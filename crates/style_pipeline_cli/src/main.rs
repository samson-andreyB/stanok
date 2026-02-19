use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process;
use std::collections::BTreeSet;

use serde_json::json;
use style_pipeline::{
    compile, CompileRequest, CompatibilityMode, Entry, PipelineConfig, SourceMapMode, Targets,
};

#[derive(Debug, Clone, PartialEq, Eq)]
enum CompileMode {
    InputOutput { input: PathBuf, output: PathBuf },
    Config { config: PathBuf },
}

#[derive(Debug, Clone, PartialEq)]
struct CompareMode {
    golden_dir: PathBuf,
    actual_dir: PathBuf,
    summary_json: Option<PathBuf>,
    max_mismatch_pct: f64,
}

fn main() {
    let exit_code = match run() {
        Ok(code) => code,
        Err(message) => {
            eprintln!("{message}");
            1
        }
    };
    process::exit(exit_code);
}

fn run() -> Result<i32, String> {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() {
        return Err(usage("Missing command"));
    }

    match args[0].as_str() {
        "compile" => handle_compile(&args[1..]).map(|_| 0),
        "compare" => handle_compare(&args[1..]),
        "--help" | "-h" | "help" => {
            println!("{}", usage("style-pipeline CLI skeleton"));
            Ok(0)
        }
        other => Err(usage(&format!("Unknown command: {other}"))),
    }
}

fn handle_compile(args: &[String]) -> Result<(), String> {
    let mode = parse_compile_mode(args)?;
    match mode {
        CompileMode::InputOutput { input, output } => {
            if !input.exists() {
                return Err(format!("Input file does not exist: {}", input.display()));
            }

            let out_dir = output
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| PathBuf::from("."));

            let cfg = PipelineConfig {
                entries: vec![Entry { input }],
                out_dir,
                source_maps: SourceMapMode::External,
                minify: false,
                targets: Targets { query: None },
                browserslist_query: None,
                import_roots: Vec::new(),
                asset: style_pipeline::AssetConfig {
                    rewrite_urls: true,
                    enable_svg_fallback: false,
                    svg_fallback_dir: None,
                },
                compatibility: CompatibilityMode::LegacyCompatible,
            };

            let req = CompileRequest {
                cwd: env::current_dir().map_err(|e| format!("Cannot resolve cwd: {e}"))?,
                config: cfg,
            };
            let result = compile(req).map_err(|e| format!("Compile failed: {e}"))?;
            println!(
                "compile(stub): ok; diagnostics={}, artifacts={}",
                result.diagnostics.len(),
                result.artifacts.len()
            );
            Ok(())
        }
        CompileMode::Config { config } => {
            let raw = fs::read_to_string(&config)
                .map_err(|e| format!("Cannot read config {}: {e}", config.display()))?;
            if raw.trim().is_empty() {
                return Err(format!("Config file is empty: {}", config.display()));
            }

            // Config parsing is intentionally deferred to the next PRs.
            // For now we validate readability/non-empty and run compile stub.
            let cfg = PipelineConfig {
                entries: vec![Entry {
                    input: PathBuf::from(format!("config://{}", config.display())),
                }],
                out_dir: env::current_dir().map_err(|e| format!("Cannot resolve cwd: {e}"))?,
                ..PipelineConfig::default()
            };
            let req = CompileRequest {
                cwd: env::current_dir().map_err(|e| format!("Cannot resolve cwd: {e}"))?,
                config: cfg,
            };
            let result = compile(req).map_err(|e| format!("Compile failed: {e}"))?;
            println!(
                "compile(stub, config mode): ok; diagnostics={}, artifacts={}",
                result.diagnostics.len(),
                result.artifacts.len()
            );
            Ok(())
        }
    }
}

fn handle_compare(args: &[String]) -> Result<i32, String> {
    let mode = parse_compare_mode(args)?;
    let summary = compare_css_dirs(&mode.golden_dir, &mode.actual_dir)?;

    println!(
        "compare: files={}, matched={}, mismatched={}, mismatch_pct={:.2}",
        summary.files_checked, summary.matched, summary.mismatched, summary.mismatch_pct
    );
    for mismatch in &summary.mismatches {
        println!(
            " - {}: {}",
            mismatch.path.display(),
            mismatch.reason
        );
    }

    if let Some(path) = mode.summary_json {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Cannot create summary dir {}: {e}", parent.display()))?;
        }
        fs::write(&path, summary.to_json())
            .map_err(|e| format!("Cannot write summary {}: {e}", path.display()))?;
    }

    if summary.mismatch_pct > mode.max_mismatch_pct {
        return Ok(2);
    }
    Ok(0)
}

fn parse_compile_mode(args: &[String]) -> Result<CompileMode, String> {
    let mut input: Option<PathBuf> = None;
    let mut output: Option<PathBuf> = None;
    let mut config: Option<PathBuf> = None;

    let mut i = 0usize;
    while i < args.len() {
        match args[i].as_str() {
            "--input" => {
                let value = args.get(i + 1).ok_or_else(|| "Missing value for --input".to_string())?;
                input = Some(PathBuf::from(value));
                i += 2;
            }
            "--output" => {
                let value = args.get(i + 1).ok_or_else(|| "Missing value for --output".to_string())?;
                output = Some(PathBuf::from(value));
                i += 2;
            }
            "--config" => {
                let value = args.get(i + 1).ok_or_else(|| "Missing value for --config".to_string())?;
                config = Some(PathBuf::from(value));
                i += 2;
            }
            unknown => return Err(format!("Unknown argument: {unknown}")),
        }
    }

    if let Some(cfg) = config {
        if input.is_some() || output.is_some() {
            return Err("Do not mix --config with --input/--output".to_string());
        }
        return Ok(CompileMode::Config { config: cfg });
    }

    match (input, output) {
        (Some(input), Some(output)) => Ok(CompileMode::InputOutput { input, output }),
        (Some(_), None) => Err("Missing --output".to_string()),
        (None, Some(_)) => Err("Missing --input".to_string()),
        (None, None) => Err("Either --config or --input/--output must be provided".to_string()),
    }
}

fn parse_compare_mode(args: &[String]) -> Result<CompareMode, String> {
    let mut golden_dir: Option<PathBuf> = None;
    let mut actual_dir: Option<PathBuf> = None;
    let mut summary_json: Option<PathBuf> = None;
    let mut max_mismatch_pct = 0.0_f64;

    let mut i = 0usize;
    while i < args.len() {
        match args[i].as_str() {
            "--golden-dir" => {
                let value = args.get(i + 1).ok_or_else(|| "Missing value for --golden-dir".to_string())?;
                golden_dir = Some(PathBuf::from(value));
                i += 2;
            }
            "--actual-dir" => {
                let value = args.get(i + 1).ok_or_else(|| "Missing value for --actual-dir".to_string())?;
                actual_dir = Some(PathBuf::from(value));
                i += 2;
            }
            "--summary-json" => {
                let value = args.get(i + 1).ok_or_else(|| "Missing value for --summary-json".to_string())?;
                summary_json = Some(PathBuf::from(value));
                i += 2;
            }
            "--max-mismatch-pct" => {
                let value = args.get(i + 1).ok_or_else(|| "Missing value for --max-mismatch-pct".to_string())?;
                max_mismatch_pct = value
                    .parse::<f64>()
                    .map_err(|_| format!("Invalid --max-mismatch-pct: {value}"))?;
                if !(0.0..=100.0).contains(&max_mismatch_pct) {
                    return Err("--max-mismatch-pct must be between 0 and 100".to_string());
                }
                i += 2;
            }
            unknown => return Err(format!("Unknown argument: {unknown}")),
        }
    }

    let golden_dir = golden_dir.ok_or_else(|| "Missing --golden-dir".to_string())?;
    let actual_dir = actual_dir.ok_or_else(|| "Missing --actual-dir".to_string())?;
    Ok(CompareMode {
        golden_dir,
        actual_dir,
        summary_json,
        max_mismatch_pct,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CompareMismatch {
    path: PathBuf,
    reason: String,
}

#[derive(Debug, Clone, PartialEq)]
struct CompareSummary {
    files_checked: usize,
    matched: usize,
    mismatched: usize,
    mismatch_pct: f64,
    mismatches: Vec<CompareMismatch>,
}

impl CompareSummary {
    fn to_json(&self) -> String {
        let items: Vec<_> = self
            .mismatches
            .iter()
            .map(|m| {
                json!({
                    "path": m.path.display().to_string(),
                    "reason": m.reason,
                })
            })
            .collect();
        json!({
            "files_checked": self.files_checked,
            "matched": self.matched,
            "mismatched": self.mismatched,
            "mismatch_pct": self.mismatch_pct,
            "mismatches": items,
        })
        .to_string()
    }
}

fn compare_css_dirs(golden_dir: &Path, actual_dir: &Path) -> Result<CompareSummary, String> {
    if !golden_dir.exists() {
        return Err(format!("Golden dir does not exist: {}", golden_dir.display()));
    }
    if !actual_dir.exists() {
        return Err(format!("Actual dir does not exist: {}", actual_dir.display()));
    }

    let golden = collect_css_rel_paths(golden_dir)?;
    let actual = collect_css_rel_paths(actual_dir)?;
    let all: BTreeSet<PathBuf> = golden.union(&actual).cloned().collect();

    let mut matched = 0usize;
    let mut mismatches = Vec::new();

    for rel in &all {
        let g = golden_dir.join(rel);
        let a = actual_dir.join(rel);
        match (g.exists(), a.exists()) {
            (false, true) => mismatches.push(CompareMismatch {
                path: rel.clone(),
                reason: "missing in golden".to_string(),
            }),
            (true, false) => mismatches.push(CompareMismatch {
                path: rel.clone(),
                reason: "missing in actual".to_string(),
            }),
            (true, true) => {
                let gs = fs::read_to_string(&g)
                    .map_err(|e| format!("Cannot read golden {}: {e}", g.display()))?;
                let as_ = fs::read_to_string(&a)
                    .map_err(|e| format!("Cannot read actual {}: {e}", a.display()))?;
                if normalize_css_for_semantic_compare(&gs) == normalize_css_for_semantic_compare(&as_) {
                    matched += 1;
                } else {
                    mismatches.push(CompareMismatch {
                        path: rel.clone(),
                        reason: "semantic css mismatch".to_string(),
                    });
                }
            }
            (false, false) => {}
        }
    }

    let files_checked = all.len();
    let mismatched = mismatches.len();
    let mismatch_pct = if files_checked == 0 {
        0.0
    } else {
        (mismatched as f64 / files_checked as f64) * 100.0
    };
    Ok(CompareSummary {
        files_checked,
        matched,
        mismatched,
        mismatch_pct,
        mismatches,
    })
}

fn collect_css_rel_paths(root: &Path) -> Result<BTreeSet<PathBuf>, String> {
    let mut out = BTreeSet::new();
    collect_css_rel_paths_recursive(root, root, &mut out)?;
    Ok(out)
}

fn collect_css_rel_paths_recursive(
    root: &Path,
    cur: &Path,
    out: &mut BTreeSet<PathBuf>,
) -> Result<(), String> {
    let entries = fs::read_dir(cur).map_err(|e| format!("Cannot read dir {}: {e}", cur.display()))?;
    for e in entries {
        let e = e.map_err(|err| format!("Cannot iterate dir {}: {err}", cur.display()))?;
        let p = e.path();
        if p.is_dir() {
            collect_css_rel_paths_recursive(root, &p, out)?;
            continue;
        }
        if !should_compare_css_file(&p) {
            continue;
        }
        let rel = p
            .strip_prefix(root)
            .map_err(|err| format!("Cannot relativize {}: {err}", p.display()))?;
        out.insert(rel.to_path_buf());
    }
    Ok(())
}

fn should_compare_css_file(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|v| v.to_str()) else {
        return false;
    };
    if !name.ends_with(".css") {
        return false;
    }
    if name.contains("_data.css") {
        return false;
    }
    name.starts_with("main")
}

fn normalize_css_for_semantic_compare(input: &str) -> String {
    let without_comments = strip_css_comments(input);
    let mut out = String::with_capacity(without_comments.len());
    let mut prev_was_space = false;
    for ch in without_comments.chars() {
        if ch.is_whitespace() {
            if !prev_was_space {
                out.push(' ');
                prev_was_space = true;
            }
        } else {
            out.push(ch);
            prev_was_space = false;
        }
    }
    out.replace(" {", "{")
        .replace("{ ", "{")
        .replace("; ", ";")
        .replace(": ", ":")
        .replace(", ", ",")
        .replace(" }", "}")
        .trim()
        .to_string()
}

fn strip_css_comments(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if i + 1 < bytes.len() && bytes[i] == b'/' && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(bytes.len());
        } else {
            out.push(bytes[i] as char);
            i += 1;
        }
    }
    out
}

fn usage(prefix: &str) -> String {
    format!(
        "{prefix}\n\
         Usage:\n\
          style-pipeline compile --input <_mainX.css> --output <mainX.css>\n\
          style-pipeline compile --config <style-pipeline.toml>\n\
          style-pipeline compare --golden-dir <dir> --actual-dir <dir> [--summary-json <file>] [--max-mismatch-pct <n>]\n\
         Exit codes:\n\
          0 success\n\
          1 compile/config/runtime error\n\
          2 compare mismatch threshold exceeded"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_compile_mode_input_output_ok() {
        let args = vec![
            "--input".to_string(),
            "assets/css/src/_main.css".to_string(),
            "--output".to_string(),
            "assets/css/main.css".to_string(),
        ];
        let mode = parse_compile_mode(&args).expect("must parse");
        match mode {
            CompileMode::InputOutput { input, output } => {
                assert_eq!(input, PathBuf::from("assets/css/src/_main.css"));
                assert_eq!(output, PathBuf::from("assets/css/main.css"));
            }
            _ => panic!("expected input/output mode"),
        }
    }

    #[test]
    fn parse_compile_mode_config_ok() {
        let args = vec!["--config".to_string(), "style-pipeline.toml".to_string()];
        let mode = parse_compile_mode(&args).expect("must parse");
        match mode {
            CompileMode::Config { config } => {
                assert_eq!(config, PathBuf::from("style-pipeline.toml"));
            }
            _ => panic!("expected config mode"),
        }
    }

    #[test]
    fn parse_compile_mode_rejects_mixed_flags() {
        let args = vec![
            "--config".to_string(),
            "style-pipeline.toml".to_string(),
            "--input".to_string(),
            "assets/css/src/_main.css".to_string(),
        ];
        let err = parse_compile_mode(&args).expect_err("must reject mixed mode");
        assert_eq!(err, "Do not mix --config with --input/--output");
    }

    #[test]
    fn parse_compare_mode_ok() {
        let args = vec![
            "--golden-dir".to_string(),
            "fixtures/golden".to_string(),
            "--actual-dir".to_string(),
            "fixtures/actual".to_string(),
            "--summary-json".to_string(),
            "tmp/summary.json".to_string(),
            "--max-mismatch-pct".to_string(),
            "15".to_string(),
        ];
        let mode = parse_compare_mode(&args).expect("must parse");
        assert_eq!(mode.golden_dir, PathBuf::from("fixtures/golden"));
        assert_eq!(mode.actual_dir, PathBuf::from("fixtures/actual"));
        assert_eq!(mode.summary_json, Some(PathBuf::from("tmp/summary.json")));
        assert_eq!(mode.max_mismatch_pct, 15.0);
    }

    #[test]
    fn compare_ignores_data_css_and_matches_semantically() {
        let dir = std::env::temp_dir().join("style_pipeline_cli_compare_semantic");
        let _ = fs::remove_dir_all(&dir);
        let golden = dir.join("golden");
        let actual = dir.join("actual");
        fs::create_dir_all(&golden).expect("golden dir should be created");
        fs::create_dir_all(&actual).expect("actual dir should be created");

        fs::write(golden.join("main.css"), ".A { color: red; } /* c */\n").expect("write golden main");
        fs::write(actual.join("main.css"), ".A{color:red;}").expect("write actual main");
        fs::write(golden.join("main_data.css"), ".x{}").expect("write golden data");
        fs::write(actual.join("main_data.css"), ".y{}").expect("write actual data");

        let summary = compare_css_dirs(&golden, &actual).expect("compare should succeed");
        assert_eq!(summary.files_checked, 1);
        assert_eq!(summary.mismatched, 0);
    }

    #[test]
    fn compare_threshold_yields_exit_code_2() {
        let dir = std::env::temp_dir().join("style_pipeline_cli_compare_threshold");
        let _ = fs::remove_dir_all(&dir);
        let golden = dir.join("golden");
        let actual = dir.join("actual");
        fs::create_dir_all(&golden).expect("golden dir should be created");
        fs::create_dir_all(&actual).expect("actual dir should be created");
        fs::write(golden.join("main.css"), ".A{color:red;}").expect("write golden");
        fs::write(actual.join("main.css"), ".A{color:blue;}").expect("write actual");

        let code = handle_compare(&[
            "--golden-dir".to_string(),
            golden.display().to_string(),
            "--actual-dir".to_string(),
            actual.display().to_string(),
            "--max-mismatch-pct".to_string(),
            "0".to_string(),
        ])
        .expect("compare should run");
        assert_eq!(code, 2);
    }
}
