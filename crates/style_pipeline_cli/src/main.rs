use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process;

use style_pipeline::{
    compile, CompileRequest, CompatibilityMode, Entry, PipelineConfig, SourceMapMode, Targets,
};

#[derive(Debug, Clone, PartialEq, Eq)]
enum CompileMode {
    InputOutput { input: PathBuf, output: PathBuf },
    Config { config: PathBuf },
}

fn main() {
    let exit_code = match run() {
        Ok(()) => 0,
        Err(message) => {
            eprintln!("{message}");
            1
        }
    };
    process::exit(exit_code);
}

fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() {
        return Err(usage("Missing command"));
    }

    match args[0].as_str() {
        "compile" => handle_compile(&args[1..]),
        "--help" | "-h" | "help" => {
            println!("{}", usage("style-pipeline CLI skeleton"));
            Ok(())
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
                asset: style_pipeline::AssetConfig { rewrite_urls: true },
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

fn usage(prefix: &str) -> String {
    format!(
        "{prefix}\n\
         Usage:\n\
           style-pipeline compile --input <_mainX.css> --output <mainX.css>\n\
           style-pipeline compile --config <style-pipeline.toml>\n\
         Exit codes:\n\
           0 success\n\
           1 compile/config/runtime error"
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
}
