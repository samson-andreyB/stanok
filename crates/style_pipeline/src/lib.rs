use std::ffi::OsStr;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub input: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourceMapMode {
    None,
    Inline,
    External,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Targets {
    pub query: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetConfig {
    pub rewrite_urls: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompatibilityMode {
    LegacyCompatible,
    StrictLightning,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipelineConfig {
    pub entries: Vec<Entry>,
    pub out_dir: PathBuf,
    pub source_maps: SourceMapMode,
    pub minify: bool,
    pub targets: Targets,
    pub browserslist_query: Option<String>,
    pub import_roots: Vec<PathBuf>,
    pub asset: AssetConfig,
    pub compatibility: CompatibilityMode,
}

impl Default for PipelineConfig {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
            out_dir: PathBuf::from("."),
            source_maps: SourceMapMode::External,
            minify: false,
            targets: Targets { query: None },
            browserslist_query: None,
            import_roots: Vec::new(),
            asset: AssetConfig { rewrite_urls: true },
            compatibility: CompatibilityMode::LegacyCompatible,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompileRequest {
    pub cwd: PathBuf,
    pub config: PipelineConfig,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompileArtifact {
    pub entry: PathBuf,
    pub css_path: PathBuf,
    pub map_path: Option<PathBuf>,
    pub extra_outputs: Vec<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diagnostic {
    pub code: &'static str,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompileResult {
    pub artifacts: Vec<CompileArtifact>,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PipelineError {
    InvalidConfig(String),
    Io(String),
}

impl std::fmt::Display for PipelineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidConfig(message) => write!(f, "{message}"),
            Self::Io(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for PipelineError {}

pub fn compile(req: CompileRequest) -> Result<CompileResult, PipelineError> {
    validate_config(&req.config)?;
    let entries = if req.config.entries.is_empty() {
        discover_entries(&req.cwd.join(&req.config.out_dir))?
    } else {
        req.config.entries.clone()
    };

    if entries.is_empty() {
        return Err(PipelineError::InvalidConfig(
            "No entry files matching _main*.css were found in <out_dir>/src".to_string(),
        ));
    }

    let artifacts = entries
        .iter()
        .map(|entry| CompileArtifact {
            entry: entry.input.clone(),
            css_path: output_css_path(&req.config.out_dir, &entry.input),
            map_path: output_map_path(&req.config.out_dir, &entry.input, &req.config.source_maps),
            extra_outputs: Vec::new(),
        })
        .collect();

    Ok(CompileResult {
        artifacts,
        diagnostics: vec![Diagnostic {
            code: "PLANNED_OUTPUTS",
            message:
                "style_pipeline compile stub: entry discovery and output contract are implemented"
                    .to_string(),
        }],
    })
}

pub fn validate_config(config: &PipelineConfig) -> Result<(), PipelineError> {
    if config.out_dir.as_os_str().is_empty() {
        return Err(PipelineError::InvalidConfig(
            "Pipeline config must define out_dir".to_string(),
        ));
    }
    Ok(())
}

pub fn discover_entries(style_dir: &Path) -> Result<Vec<Entry>, PipelineError> {
    let src_dir = style_dir.join("src");
    if !src_dir.exists() {
        return Ok(Vec::new());
    }

    let mut entries = Vec::new();
    let read_dir = std::fs::read_dir(&src_dir).map_err(|err| {
        PipelineError::Io(format!(
            "Failed to read style source directory '{}': {err}",
            src_dir.display()
        ))
    })?;

    for dir_entry in read_dir {
        let dir_entry = dir_entry.map_err(|err| {
            PipelineError::Io(format!(
                "Failed to iterate style source directory '{}': {err}",
                src_dir.display()
            ))
        })?;
        let path = dir_entry.path();

        if !path.is_file() || path.extension() != Some(OsStr::new("css")) {
            continue;
        }

        let Some(file_name) = path.file_name().and_then(|f| f.to_str()) else {
            continue;
        };

        if file_name.starts_with("_main") {
            entries.push(Entry { input: path });
        }
    }

    entries.sort_by(|a, b| a.input.cmp(&b.input));
    Ok(entries)
}

fn output_css_path(out_dir: &Path, input: &Path) -> PathBuf {
    let file_name = input.file_name().and_then(|f| f.to_str()).unwrap_or("_main.css");
    let output_name = file_name.strip_prefix('_').unwrap_or(file_name);
    out_dir.join(output_name)
}

fn output_map_path(out_dir: &Path, input: &Path, source_maps: &SourceMapMode) -> Option<PathBuf> {
    if !matches!(source_maps, SourceMapMode::External) {
        return None;
    }
    let css_path = output_css_path(out_dir, input);
    let css_name = css_path.file_name().and_then(|f| f.to_str()).unwrap_or("main.css");
    Some(out_dir.join("maps").join(format!("{css_name}.map")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn pipeline_config_defaults_are_stable() {
        let cfg = PipelineConfig::default();
        assert_eq!(cfg.entries.len(), 0);
        assert_eq!(cfg.out_dir, PathBuf::from("."));
        assert_eq!(cfg.source_maps, SourceMapMode::External);
        assert_eq!(cfg.minify, false);
        assert_eq!(cfg.compatibility, CompatibilityMode::LegacyCompatible);
        assert_eq!(cfg.asset.rewrite_urls, true);
    }

    #[test]
    fn validate_config_accepts_discovery_mode_without_entries() {
        let cfg = PipelineConfig::default();
        validate_config(&cfg).expect("empty entries are valid when discovery mode is used");
    }

    #[test]
    fn compile_returns_planned_artifacts_for_explicit_entries() {
        let mut cfg = PipelineConfig::default();
        cfg.entries.push(Entry {
            input: PathBuf::from("assets/css/src/_main.css"),
        });
        cfg.out_dir = PathBuf::from("assets/css");

        let result = compile(CompileRequest {
            cwd: PathBuf::from("."),
            config: cfg,
        })
        .expect("valid config should compile in stub mode");

        assert_eq!(result.artifacts.len(), 1);
        assert_eq!(result.artifacts[0].css_path, PathBuf::from("assets/css/main.css"));
        assert_eq!(
            result.artifacts[0].map_path,
            Some(PathBuf::from("assets/css/maps/main.css.map"))
        );
        assert_eq!(result.diagnostics.len(), 1);
        assert_eq!(result.diagnostics[0].code, "PLANNED_OUTPUTS");
    }
}
