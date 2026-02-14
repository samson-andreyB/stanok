#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use notify::{Config as NotifyConfig, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{
  Arc,
  Mutex,
  atomic::{AtomicBool, Ordering},
  mpsc::{self, RecvTimeoutError},
};
use std::time::Duration;
use tauri::Emitter;
#[cfg(not(target_os = "linux"))]
use sysinfo::{ProcessesToUpdate, System};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProjectsResponse {
  verstak: Vec<ProjectItem>,
  polki: Vec<ProjectItem>,
  git: Vec<ProjectItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProjectItem {
  name: String,
  pure_name: String,
  project_type: String,
  data: Option<Value>,
  link: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct BuildConfig {
  nest: String,
  root: String,
  style: String,
  img: String,
  layouts: String,
  b: String,
  html: String,
  lib: String,
  browsers: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct BuildPayload {
  projects_path: String,
  project_name: String,
  config: BuildConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WatchSnapshot {
  css: u64,
  img: u64,
  layout: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ResourceSnapshot {
  process_jiffies: u64,
  total_jiffies: u64,
  rss_kb: u64,
  cpu_count: u32,
  cpu_percent: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ResourceStatsEvent {
  cpu_percent: f64,
  rss_kb: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProjectWatchEvent {
  css_changed: bool,
  img_changed: bool,
  layout_changed: bool,
  error: Option<String>,
}

struct ProjectWatchHandle {
  stop: Arc<AtomicBool>,
}

#[derive(Default)]
struct ProjectWatchState {
  handle: Mutex<Option<ProjectWatchHandle>>,
}

struct BranchWatchHandle {
  stop: Arc<AtomicBool>,
}

#[derive(Default)]
struct BranchWatchState {
  handle: Mutex<Option<BranchWatchHandle>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct BranchWatchEvent {
  group_name: String,
  branch: String,
}

#[derive(Default)]
struct ProjectsCacheState {
  mem: Mutex<HashMap<String, ProjectsResponse>>,
}

#[derive(Default)]
struct BuildOrchestratorState {
  entries: Mutex<HashMap<String, BuildQueueEntry>>,
  workers: Mutex<HashMap<String, NodeWorker>>,
}

#[derive(Default, Clone)]
struct BuildQueueEntry {
  running: bool,
  pending_styles: bool,
  pending_images: bool,
}

struct NodeWorker {
  child: Child,
  stdin: ChildStdin,
  stdout: BufReader<ChildStdout>,
}

impl Drop for BuildOrchestratorState {
  fn drop(&mut self) {
    if let Ok(mut workers) = self.workers.lock() {
      for (_, worker) in workers.iter_mut() {
        let _ = worker.child.kill();
        let _ = worker.child.wait();
      }
      workers.clear();
    }
  }
}

#[derive(Clone, Copy)]
enum BuildKind {
  Styles,
  Images,
}

const PROJECTS_CACHE_TTL_SECS: u64 = 60 * 60;

#[tauri::command]
fn choose_projects_path() -> Option<String> {
  rfd::FileDialog::new()
    .set_title("Выберите папку с проектами")
    .pick_folder()
    .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
fn get_projects(
  state: tauri::State<ProjectsCacheState>,
  projects_path: String,
) -> Result<ProjectsResponse, String> {
  refresh_projects_cache(state, projects_path)
}

#[tauri::command]
fn get_projects_cached(
  state: tauri::State<ProjectsCacheState>,
  projects_path: String,
) -> Result<Option<ProjectsResponse>, String> {
  if let Ok(guard) = state.mem.lock() {
    if let Some(cached) = guard.get(&projects_path) {
      return Ok(Some(cached.clone()));
    }
  }

  if let Some(cached) = load_projects_cache_from_disk(&projects_path) {
    if let Ok(mut guard) = state.mem.lock() {
      guard.insert(projects_path.clone(), cached.clone());
    }
    return Ok(Some(cached));
  }

  Ok(None)
}

#[tauri::command]
fn refresh_projects_cache(
  state: tauri::State<ProjectsCacheState>,
  projects_path: String,
) -> Result<ProjectsResponse, String> {
  let scanned = scan_projects(&projects_path)?;
  if let Ok(mut guard) = state.mem.lock() {
    guard.insert(projects_path.clone(), scanned.clone());
  }
  let _ = save_projects_cache_to_disk(&projects_path, &scanned);
  Ok(scanned)
}

#[tauri::command]
fn get_git_branch(repo_path: String) -> Result<String, String> {
  let output = Command::new("git")
    .arg("-C")
    .arg(repo_path)
    .arg("rev-parse")
    .arg("--abbrev-ref")
    .arg("HEAD")
    .output()
    .map_err(|e| format!("Не удалось запустить git: {}", e))?;

  if !output.status.success() {
    return Ok(String::new());
  }

  Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[tauri::command]
fn open_in_explorer(path: String) -> Result<(), String> {
  open::that(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
  open::that(url).map_err(|e| e.to_string())
}

#[tauri::command]
fn build_styles(
  state: tauri::State<BuildOrchestratorState>,
  projects_path: String,
  project_name: String,
  project_data: Option<Value>,
) -> Result<String, String> {
  let config = build_config_from_project_data(project_data.as_ref());
  let payload = BuildPayload {
    projects_path,
    project_name,
    config,
  };
  run_build_orchestrated(state.inner(), BuildKind::Styles, payload)
}

#[tauri::command]
fn build_images(
  state: tauri::State<BuildOrchestratorState>,
  projects_path: String,
  project_name: String,
  project_data: Option<Value>,
) -> Result<String, String> {
  let config = build_config_from_project_data(project_data.as_ref());
  let payload = BuildPayload {
    projects_path,
    project_name,
    config,
  };
  run_build_orchestrated(state.inner(), BuildKind::Images, payload)
}

#[tauri::command]
fn project_watch_snapshot(
  projects_path: String,
  project_name: String,
  project_data: Option<Value>,
) -> Result<WatchSnapshot, String> {
  let config = build_config_from_project_data(project_data.as_ref());
  compute_project_watch_snapshot(&projects_path, &project_name, &config)
}

#[tauri::command]
fn start_project_watch(
  app: tauri::AppHandle,
  state: tauri::State<ProjectWatchState>,
  projects_path: String,
  project_name: String,
  project_data: Option<Value>,
) -> Result<(), String> {
  stop_project_watch_inner(state.inner());
  let config = build_config_from_project_data(project_data.as_ref());

  let stop = Arc::new(AtomicBool::new(false));
  let stop_worker = Arc::clone(&stop);
  let app_handle = app.clone();

  std::thread::spawn(move || {
    run_project_watch_event_loop(&app_handle, &stop_worker, &projects_path, &project_name, &config);
  });

  let mut guard = state.handle.lock().map_err(|_| "Ошибка блокировки watcher".to_string())?;
  *guard = Some(ProjectWatchHandle { stop });
  Ok(())
}

fn run_project_watch_event_loop(
  app_handle: &tauri::AppHandle,
  stop_worker: &AtomicBool,
  projects_path: &str,
  project_name: &str,
  config: &BuildConfig,
) {
  let watch_paths = resolve_watch_paths(projects_path, project_name, config);
  let (tx, rx) = mpsc::channel();

  let mut watcher = match RecommendedWatcher::new(
    move |result| {
      let _ = tx.send(result);
    },
    NotifyConfig::default(),
  ) {
    Ok(value) => value,
    Err(error) => {
      let _ = app_handle.emit(
        "project://watch",
        ProjectWatchEvent {
          css_changed: false,
          img_changed: false,
          layout_changed: false,
          error: Some(format!("notify watcher error: {}", error)),
        },
      );
      run_project_watch_polling_loop(app_handle, stop_worker, projects_path, project_name, config);
      return;
    }
  };

  let mut watched_any = false;
  for path in &watch_paths {
    if !path.exists() {
      continue;
    }
    if watcher.watch(path, RecursiveMode::Recursive).is_ok() {
      watched_any = true;
    }
  }

  if !watched_any {
    run_project_watch_polling_loop(app_handle, stop_worker, projects_path, project_name, config);
    return;
  }

  let mut previous = match compute_project_watch_snapshot(projects_path, project_name, config) {
    Ok(snapshot) => Some(snapshot),
    Err(error) => {
      let _ = app_handle.emit(
        "project://watch",
        ProjectWatchEvent {
          css_changed: false,
          img_changed: false,
          layout_changed: false,
          error: Some(error),
        },
      );
      None
    }
  };

  while !stop_worker.load(Ordering::Relaxed) {
    match rx.recv_timeout(Duration::from_millis(700)) {
      Ok(Ok(_)) => {
        // Debounce burst updates from editors/compilers.
        loop {
          match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(_) => continue,
            Err(RecvTimeoutError::Timeout) => break,
            Err(RecvTimeoutError::Disconnected) => return,
          }
        }

        match compute_project_watch_snapshot(projects_path, project_name, config) {
          Ok(snapshot) => {
            if let Some(prev) = &previous {
              let css_changed = snapshot.css != prev.css;
              let img_changed = snapshot.img != prev.img;
              let layout_changed = snapshot.layout != prev.layout;
              if css_changed || img_changed || layout_changed {
                let _ = app_handle.emit(
                  "project://watch",
                  ProjectWatchEvent {
                    css_changed,
                    img_changed,
                    layout_changed,
                    error: None,
                  },
                );
              }
            }
            previous = Some(snapshot);
          }
          Err(error) => {
            let _ = app_handle.emit(
              "project://watch",
              ProjectWatchEvent {
                css_changed: false,
                img_changed: false,
                layout_changed: false,
                error: Some(error),
              },
            );
          }
        }
      }
      Ok(Err(error)) => {
        let _ = app_handle.emit(
          "project://watch",
          ProjectWatchEvent {
            css_changed: false,
            img_changed: false,
            layout_changed: false,
            error: Some(format!("watch event error: {}", error)),
          },
        );
      }
      Err(RecvTimeoutError::Timeout) => {}
      Err(RecvTimeoutError::Disconnected) => return,
    }
  }
}

fn run_project_watch_polling_loop(
  app_handle: &tauri::AppHandle,
  stop_worker: &AtomicBool,
  projects_path: &str,
  project_name: &str,
  config: &BuildConfig,
) {
  let mut previous: Option<WatchSnapshot> = None;
  let mut idle_ticks = 0u8;
  let mut delay_ms = 3500u64;

  while !stop_worker.load(Ordering::Relaxed) {
    match compute_project_watch_snapshot(projects_path, project_name, config) {
      Ok(snapshot) => {
        if let Some(prev) = &previous {
          let css_changed = snapshot.css != prev.css;
          let img_changed = snapshot.img != prev.img;
          let layout_changed = snapshot.layout != prev.layout;
          let has_changes = css_changed || img_changed || layout_changed;

          if has_changes {
            let _ = app_handle.emit(
              "project://watch",
              ProjectWatchEvent {
                css_changed,
                img_changed,
                layout_changed,
                error: None,
              },
            );
            idle_ticks = 0;
            delay_ms = 3500;
          } else {
            idle_ticks = idle_ticks.saturating_add(1);
            if idle_ticks >= 4 {
              delay_ms = 9000;
            }
          }
        }
        previous = Some(snapshot);
      }
      Err(error) => {
        let _ = app_handle.emit(
          "project://watch",
          ProjectWatchEvent {
            css_changed: false,
            img_changed: false,
            layout_changed: false,
            error: Some(error),
          },
        );
        delay_ms = 9000;
      }
    }

    sleep_with_stop(stop_worker, delay_ms);
  }
}

#[tauri::command]
fn stop_project_watch(state: tauri::State<ProjectWatchState>) -> Result<(), String> {
  stop_project_watch_inner(state.inner());
  Ok(())
}

#[tauri::command]
fn start_branch_watch(
  app: tauri::AppHandle,
  state: tauri::State<BranchWatchState>,
  projects_path: String,
  group_names: Vec<String>,
) -> Result<(), String> {
  stop_branch_watch_inner(state.inner());

  let groups: Vec<String> = group_names
    .into_iter()
    .map(|name| name.trim().to_string())
    .filter(|name| !name.is_empty())
    .collect();

  if groups.is_empty() {
    return Ok(());
  }

  let stop = Arc::new(AtomicBool::new(false));
  let stop_worker = Arc::clone(&stop);
  let app_handle = app.clone();

  std::thread::spawn(move || {
    run_branch_watch_event_loop(&app_handle, &stop_worker, &projects_path, &groups);
  });

  let mut guard = state.handle.lock().map_err(|_| "Ошибка блокировки branch watcher".to_string())?;
  *guard = Some(BranchWatchHandle { stop });
  Ok(())
}

fn run_branch_watch_event_loop(
  app_handle: &tauri::AppHandle,
  stop_worker: &AtomicBool,
  projects_path: &str,
  groups: &[String],
) {
  let repo_entries: Vec<(String, String, PathBuf)> = groups
    .iter()
    .map(|group| {
      let repo_path = PathBuf::from(projects_path).join(group).to_string_lossy().to_string();
      let watch_target = resolve_git_watch_target(&repo_path).unwrap_or_else(|| PathBuf::from(&repo_path));
      (group.clone(), repo_path, watch_target)
    })
    .collect();

  let (tx, rx) = mpsc::channel();
  let mut watcher = match RecommendedWatcher::new(
    move |result| {
      let _ = tx.send(result);
    },
    NotifyConfig::default(),
  ) {
    Ok(value) => value,
    Err(_) => {
      run_branch_watch_polling_loop(app_handle, stop_worker, projects_path, groups);
      return;
    }
  };

  let mut watched_any = false;
  for (_, _, target) in &repo_entries {
    if !target.exists() {
      continue;
    }
    if watcher.watch(target, RecursiveMode::Recursive).is_ok() {
      watched_any = true;
    }
  }

  if !watched_any {
    run_branch_watch_polling_loop(app_handle, stop_worker, projects_path, groups);
    return;
  }

  let mut previous: HashMap<String, String> = HashMap::new();
  emit_branch_changes(app_handle, &repo_entries, &mut previous, true);

  while !stop_worker.load(Ordering::Relaxed) {
    match rx.recv_timeout(Duration::from_millis(1200)) {
      Ok(Ok(_)) => {
        loop {
          match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(_) => continue,
            Err(RecvTimeoutError::Timeout) => break,
            Err(RecvTimeoutError::Disconnected) => return,
          }
        }
        emit_branch_changes(app_handle, &repo_entries, &mut previous, false);
      }
      Ok(Err(_)) => {}
      Err(RecvTimeoutError::Timeout) => {}
      Err(RecvTimeoutError::Disconnected) => return,
    }
  }
}

fn run_branch_watch_polling_loop(
  app_handle: &tauri::AppHandle,
  stop_worker: &AtomicBool,
  projects_path: &str,
  groups: &[String],
) {
  let repo_entries: Vec<(String, String, PathBuf)> = groups
    .iter()
    .map(|group| {
      let repo_path = PathBuf::from(projects_path).join(group).to_string_lossy().to_string();
      (group.clone(), repo_path, PathBuf::new())
    })
    .collect();

  let mut previous: HashMap<String, String> = HashMap::new();
  let mut first_pass = true;

  while !stop_worker.load(Ordering::Relaxed) {
    emit_branch_changes(app_handle, &repo_entries, &mut previous, first_pass);
    first_pass = false;
    sleep_with_stop(stop_worker, 10_000);
  }
}

fn emit_branch_changes(
  app_handle: &tauri::AppHandle,
  repo_entries: &[(String, String, PathBuf)],
  previous: &mut HashMap<String, String>,
  first_pass: bool,
) {
  for (group, repo_path, _) in repo_entries {
    let branch = get_git_branch(repo_path.clone()).unwrap_or_default();
    let prev = previous.get(group).cloned().unwrap_or_default();
    if first_pass || branch != prev {
      let _ = app_handle.emit(
        "git://branch",
        BranchWatchEvent {
          group_name: group.clone(),
          branch: branch.clone(),
        },
      );
      previous.insert(group.clone(), branch);
    }
  }
}

fn resolve_git_watch_target(repo_path: &str) -> Option<PathBuf> {
  let git_path = PathBuf::from(repo_path).join(".git");
  if git_path.is_dir() {
    return Some(git_path);
  }
  if !git_path.is_file() {
    return None;
  }

  let content = fs::read_to_string(&git_path).ok()?;
  let marker = "gitdir:";
  let line = content.lines().next()?.trim();
  if !line.starts_with(marker) {
    return None;
  }

  let raw = line[marker.len()..].trim();
  let target = PathBuf::from(raw);
  if target.is_absolute() {
    Some(target)
  } else {
    git_path.parent().map(|p| p.join(target))
  }
}

#[tauri::command]
fn stop_branch_watch(state: tauri::State<BranchWatchState>) -> Result<(), String> {
  stop_branch_watch_inner(state.inner());
  Ok(())
}

#[tauri::command]
fn get_resource_snapshot() -> Result<ResourceSnapshot, String> {
  #[cfg(target_os = "linux")]
  {
    let process_jiffies = read_process_jiffies()?;
    let total_jiffies = read_total_jiffies()?;
    let rss_kb = read_process_rss_kb().unwrap_or(0);
    let cpu_count = std::thread::available_parallelism()
      .map(|n| n.get() as u32)
      .unwrap_or(1);

    return Ok(ResourceSnapshot {
      process_jiffies,
      total_jiffies,
      rss_kb,
      cpu_count,
      cpu_percent: None,
    });
  }

  #[cfg(not(target_os = "linux"))]
  {
    let pid = sysinfo::get_current_pid().map_err(|e| e.to_string())?;
    let mut system = System::new_all();
    system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
    let process = system
      .process(pid)
      .ok_or("Не найден текущий процесс в sysinfo".to_string())?;
    let cpu_count = std::thread::available_parallelism()
      .map(|n| n.get() as u32)
      .unwrap_or(1);

    Ok(ResourceSnapshot {
      process_jiffies: 0,
      total_jiffies: 0,
      rss_kb: process.memory() / 1024,
      cpu_count,
      cpu_percent: Some(process.cpu_usage() as f64),
    })
  }
}

fn spawn_resource_stats_emitter(app: tauri::AppHandle) {
  std::thread::spawn(move || {
    #[cfg(target_os = "linux")]
    {
      let mut prev_process = 0u64;
      let mut prev_total = 0u64;
      let mut has_prev = false;

      loop {
        let snapshot = match get_resource_snapshot() {
          Ok(value) => value,
          Err(_) => {
            std::thread::sleep(Duration::from_secs(4));
            continue;
          }
        };

        let cpu_percent = if has_prev {
          let delta_process = snapshot.process_jiffies.saturating_sub(prev_process) as f64;
          let delta_total = snapshot.total_jiffies.saturating_sub(prev_total) as f64;
          if delta_total > 0.0 {
            let cpus = snapshot.cpu_count.max(1) as f64;
            ((delta_process / delta_total) * 100.0 * cpus).max(0.0)
          } else {
            0.0
          }
        } else {
          0.0
        };

        prev_process = snapshot.process_jiffies;
        prev_total = snapshot.total_jiffies;
        has_prev = true;

        let payload = ResourceStatsEvent {
          cpu_percent,
          rss_kb: snapshot.rss_kb,
        };

        let _ = app.emit("resource://stats", payload);
        std::thread::sleep(Duration::from_secs(4));
      }
    }

    #[cfg(not(target_os = "linux"))]
    {
      let pid = match sysinfo::get_current_pid() {
        Ok(value) => value,
        Err(_) => return,
      };
      let mut system = System::new_all();

      loop {
        system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
        if let Some(process) = system.process(pid) {
          let payload = ResourceStatsEvent {
            cpu_percent: process.cpu_usage() as f64,
            rss_kb: process.memory() / 1024,
          };
          let _ = app.emit("resource://stats", payload);
        }
        std::thread::sleep(Duration::from_secs(4));
      }
    }
  });
}

fn run_node_script(
  state: &BuildOrchestratorState,
  script_name: &str,
  payload: &BuildPayload,
) -> Result<String, String> {
  const WORKER_RETRIES: u8 = 1;
  let mut last_error: Option<String> = None;

  for attempt in 0..=WORKER_RETRIES {
    match run_node_script_with_worker(state, script_name, payload) {
      Ok(output) => return Ok(output),
      Err(error) => {
        last_error = Some(error.clone());
        if attempt < WORKER_RETRIES && is_retryable_worker_error(&error) {
          std::thread::sleep(Duration::from_millis(120));
          continue;
        }
        break;
      }
    }
  }

  match run_node_script_once(script_name, payload) {
    Ok(output) => Ok(output),
    Err(fallback_error) => {
      if let Some(worker_error) = last_error {
        if worker_error.trim() == fallback_error.trim() {
          Err(fallback_error)
        } else {
          Err(format!("{}\n{}", worker_error, fallback_error))
        }
      } else {
        Err(fallback_error)
      }
    }
  }
}

fn run_node_script_with_worker(
  state: &BuildOrchestratorState,
  script_name: &str,
  payload: &BuildPayload,
) -> Result<String, String> {
  let workspace_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    .parent()
    .ok_or("Не найден корень workspace")?
    .to_path_buf();

  let worker_path = workspace_root.join("scripts").join("build-worker.mjs");
  if !worker_path.exists() {
    return Err(format!("Не найден скрипт {}", worker_path.display()));
  }

  let mut workers = state
    .workers
    .lock()
    .map_err(|_| "Ошибка блокировки worker pool".to_string())?;
  if !workers.contains_key(script_name) {
    let spawned = spawn_node_worker(&workspace_root, &worker_path)?;
    workers.insert(script_name.to_string(), spawned);
  }
  let worker = workers
    .get_mut(script_name)
    .ok_or("Не удалось получить worker".to_string())?;

  if worker
    .child
    .try_wait()
    .map_err(|e| e.to_string())?
    .is_some()
  {
    *worker = spawn_node_worker(&workspace_root, &worker_path)?;
  }

  let request = serde_json::json!({
    "id": 1,
    "script": script_name,
    "payload": payload
  });
  let request_line = serde_json::to_string(&request).map_err(|e| e.to_string())?;

  if writeln!(worker.stdin, "{}", request_line).is_err() || worker.stdin.flush().is_err() {
    *worker = spawn_node_worker(&workspace_root, &worker_path)?;
    writeln!(worker.stdin, "{}", request_line).map_err(|e| e.to_string())?;
    worker.stdin.flush().map_err(|e| e.to_string())?;
  }

  let mut line = String::new();
  let read = worker.stdout.read_line(&mut line).map_err(|e| e.to_string())?;
  if read == 0 {
    *worker = spawn_node_worker(&workspace_root, &worker_path)?;
    writeln!(worker.stdin, "{}", request_line).map_err(|e| e.to_string())?;
    worker.stdin.flush().map_err(|e| e.to_string())?;
    line.clear();
    let reread = worker.stdout.read_line(&mut line).map_err(|e| e.to_string())?;
    if reread == 0 {
      return Err("Worker не вернул ответ".to_string());
    }
  }

  let response: serde_json::Value = serde_json::from_str(line.trim()).map_err(|e| e.to_string())?;
  if response.get("ok").and_then(Value::as_bool).unwrap_or(false) {
    return Ok(
      response
        .get("output")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string(),
    );
  }

  let message = response
    .get("error")
    .and_then(Value::as_str)
    .map(compact_script_error)
    .unwrap_or_else(|| "Ошибка сборки".to_string());
  Err(message)
}

fn spawn_node_worker(workspace_root: &Path, worker_path: &Path) -> Result<NodeWorker, String> {
  let mut child = Command::new("node")
    .arg(worker_path)
    .current_dir(workspace_root)
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::null())
    .spawn()
    .map_err(|e| format!("Ошибка запуска worker: {}", e))?;

  let stdin = child.stdin.take().ok_or("Не удалось открыть stdin worker")?;
  let stdout = child.stdout.take().ok_or("Не удалось открыть stdout worker")?;
  Ok(NodeWorker {
    child,
    stdin,
    stdout: BufReader::new(stdout),
  })
}

fn run_node_script_once(script_name: &str, payload: &BuildPayload) -> Result<String, String> {
  let workspace_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    .parent()
    .ok_or("Не найден корень workspace")?
    .to_path_buf();
  let script_path = workspace_root.join("scripts").join(script_name);
  if !script_path.exists() {
    return Err(format!("Не найден скрипт {}", script_path.display()));
  }

  let payload_json = serde_json::to_string(payload).map_err(|e| e.to_string())?;
  let output = Command::new("node")
    .arg(script_path)
    .arg(payload_json)
    .current_dir(workspace_root)
    .output()
    .map_err(|e| format!("Ошибка запуска node: {}", e))?;
  let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
  let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
  if !output.status.success() {
    let message = if !stderr.is_empty() {
      compact_script_error(&stderr)
    } else {
      "Ошибка сборки".to_string()
    };
    return Err(message);
  }
  Ok(stdout)
}

fn is_retryable_worker_error(error: &str) -> bool {
  let lowered = error.to_ascii_lowercase();
  lowered.contains("timeout")
    || lowered.contains("timed out")
    || lowered.contains("broken pipe")
    || lowered.contains("connection reset")
    || lowered.contains("worker не вернул ответ")
    || lowered.contains("eof")
}

fn compact_script_error(stderr: &str) -> String {
  let lines: Vec<&str> = stderr
    .lines()
    .map(str::trim)
    .filter(|line| !line.is_empty())
    .collect();

  if lines.is_empty() {
    return "Ошибка сборки".to_string();
  }

  // Prefer explicit file/line diagnostics (e.g. "...css:9:13: Missed semicolon").
  for line in &lines {
    if looks_like_file_diagnostic(line) {
      return (*line).to_string();
    }
  }

  // Then prefer explicit error lines.
  for line in &lines {
    if is_noise_stderr_line(line) {
      continue;
    }
    if line.contains("Error:")
      || line.contains("SyntaxError")
      || line.contains("CssSyntaxError")
      || line.contains("Ошибка")
    {
      return (*line).to_string();
    }
  }

  // Fallback: last non-noise line.
  for line in lines.iter().rev() {
    if !is_noise_stderr_line(line) {
      return (*line).to_string();
    }
  }

  "Ошибка сборки".to_string()
}

#[cfg(target_os = "linux")]
fn read_process_jiffies() -> Result<u64, String> {
  let stat = fs::read_to_string("/proc/self/stat").map_err(|e| e.to_string())?;
  let right_paren = stat
    .rfind(')')
    .ok_or("Некорректный формат /proc/self/stat")?;
  let rest = stat
    .get(right_paren + 2..)
    .ok_or("Некорректный формат /proc/self/stat")?;
  let fields: Vec<&str> = rest.split_whitespace().collect();
  if fields.len() <= 12 {
    return Err("Недостаточно полей в /proc/self/stat".to_string());
  }

  let utime = fields[11]
    .parse::<u64>()
    .map_err(|e| format!("Ошибка чтения utime: {}", e))?;
  let stime = fields[12]
    .parse::<u64>()
    .map_err(|e| format!("Ошибка чтения stime: {}", e))?;
  Ok(utime + stime)
}

#[cfg(target_os = "linux")]
fn read_total_jiffies() -> Result<u64, String> {
  let stat = fs::read_to_string("/proc/stat").map_err(|e| e.to_string())?;
  let line = stat
    .lines()
    .find(|l| l.starts_with("cpu "))
    .ok_or("Не найдена строка cpu в /proc/stat")?;

  line
    .split_whitespace()
    .skip(1)
    .map(|v| v.parse::<u64>().map_err(|e| e.to_string()))
    .try_fold(0u64, |acc, v| v.map(|n| acc + n))
}

#[cfg(target_os = "linux")]
fn read_process_rss_kb() -> Result<u64, String> {
  let status = fs::read_to_string("/proc/self/status").map_err(|e| e.to_string())?;
  let line = status
    .lines()
    .find(|l| l.starts_with("VmRSS:"))
    .ok_or("Не найден VmRSS в /proc/self/status")?;
  let value = line
    .split_whitespace()
    .nth(1)
    .ok_or("Некорректный формат VmRSS")?;
  value.parse::<u64>().map_err(|e| e.to_string())
}

fn stop_project_watch_inner(state: &ProjectWatchState) {
  if let Ok(mut guard) = state.handle.lock() {
    if let Some(handle) = guard.take() {
      handle.stop.store(true, Ordering::Relaxed);
    }
  }
}

fn stop_branch_watch_inner(state: &BranchWatchState) {
  if let Ok(mut guard) = state.handle.lock() {
    if let Some(handle) = guard.take() {
      handle.stop.store(true, Ordering::Relaxed);
    }
  }
}

fn sleep_with_stop(stop: &AtomicBool, total_ms: u64) {
  let mut left = total_ms;
  while left > 0 {
    if stop.load(Ordering::Relaxed) {
      return;
    }
    let chunk = left.min(250);
    std::thread::sleep(Duration::from_millis(chunk));
    left -= chunk;
  }
}

fn is_noise_stderr_line(line: &str) -> bool {
  line.is_empty()
    || line == "{"
    || line == "}"
    || line == "^"
    || line.starts_with("at ")
    || line.starts_with("node:")
    || line.starts_with("Node.js")
}

fn looks_like_file_diagnostic(line: &str) -> bool {
  // Very lightweight match for "<path>:<line>:<column>: <message>".
  let bytes = line.as_bytes();
  let mut first_colon = None;
  let mut second_colon = None;
  let mut third_colon = None;

  for (i, b) in bytes.iter().enumerate() {
    if *b == b':' {
      if first_colon.is_none() {
        first_colon = Some(i);
      } else if second_colon.is_none() {
        second_colon = Some(i);
      } else {
        third_colon = Some(i);
        break;
      }
    }
  }

  let (a, b, c) = match (first_colon, second_colon, third_colon) {
    (Some(a), Some(b), Some(c)) => (a, b, c),
    _ => return false,
  };

  if b <= a + 1 || c <= b + 1 {
    return false;
  }

  let line_num = &line[a + 1..b];
  let col_num = &line[b + 1..c];

  !line_num.is_empty()
    && !col_num.is_empty()
    && line_num.chars().all(|ch| ch.is_ascii_digit())
    && col_num.chars().all(|ch| ch.is_ascii_digit())
}

fn resolve_project_dir(projects_path: &str, project_name: &str, nest: &str) -> PathBuf {
  let group = project_name.split('/').next().unwrap_or_default();
  let mut path = PathBuf::from(projects_path).join(group);
  let nest_clean = normalize_rel(nest);
  if !nest_clean.is_empty() {
    path = path.join(nest_clean);
  }
  path
}

fn normalize_rel(value: &str) -> String {
  value
    .trim_matches('/')
    .trim_matches('\\')
    .to_string()
}

fn build_config_from_project_data(project_data: Option<&Value>) -> BuildConfig {
  const DEFAULT_BROWSERS: [&str; 6] = [
    "last 5 versions",
    "Chrome 27",
    "ff 12",
    "ie 8",
    "ie 9",
    "opera 12",
  ];

  let empty = Value::Null;
  let data = project_data.unwrap_or(&empty);

  let path = data.get("path").and_then(Value::as_object);
  let path_str = |key: &str| -> Option<&str> {
    path
      .and_then(|p| p.get(key))
      .and_then(Value::as_str)
  };

  let root = match path_str("root") {
    Some("") => String::new(),
    Some(value) => {
      let normalized = value.replace('\\', "/");
      let trimmed = normalized
        .trim_start_matches('/')
        .trim_end_matches('/')
        .to_string();
      format!("{}/", trimmed)
    }
    None => "assets/".to_string(),
  };

  let browsers = data
    .get("browsers")
    .and_then(Value::as_array)
    .map(|arr| {
      arr
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect::<Vec<String>>()
    })
    .unwrap_or_else(|| DEFAULT_BROWSERS.iter().map(|v| (*v).to_string()).collect());

  BuildConfig {
    nest: data
      .get("nest")
      .and_then(Value::as_str)
      .unwrap_or("")
      .to_string(),
    root,
    style: path_str("style").unwrap_or("css").to_string(),
    img: path_str("img").unwrap_or("img").to_string(),
    layouts: path_str("layouts").unwrap_or("_layouts").to_string(),
    b: path_str("b").unwrap_or("src/b").to_string(),
    html: path_str("html").unwrap_or("_html").to_string(),
    lib: path_str("lib").unwrap_or("../lib").to_string(),
    browsers,
  }
}

fn latest_mtime_by_ext(path: &Path, exts: &[&str]) -> Result<u64, String> {
  if !path.exists() {
    return Ok(0);
  }

  let mut stack = vec![path.to_path_buf()];
  let mut latest = 0u64;

  while let Some(current) = stack.pop() {
    let entries = fs::read_dir(&current).map_err(|e| e.to_string())?;
    for entry in entries {
      let entry = entry.map_err(|e| e.to_string())?;
      let file_path = entry.path();
      let metadata = entry.metadata().map_err(|e| e.to_string())?;
      if metadata.is_dir() {
        if should_skip_dir(&file_path) {
          continue;
        }
        stack.push(file_path);
        continue;
      }
      if !metadata.is_file() {
        continue;
      }

      let ext = file_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
      if !exts.iter().any(|e| *e == ext) {
        continue;
      }

      let modified = metadata
        .modified()
        .ok()
        .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

      if modified > latest {
        latest = modified;
      }
    }
  }

  Ok(latest)
}

fn compute_project_watch_snapshot(
  projects_path: &str,
  project_name: &str,
  config: &BuildConfig,
) -> Result<WatchSnapshot, String> {
  let project_dir = resolve_project_dir(projects_path, project_name, &config.nest);
  let root = normalize_rel(&config.root);
  let root_path = if root.is_empty() {
    project_dir.clone()
  } else {
    project_dir.join(root)
  };

  let css_path = root_path.join(&config.style).join("src");
  let img_path = root_path.join(&config.img).join("src");
  let layout_root = root_path.join(&config.layouts);
  let html_root = root_path.join(&config.html);

  let css = latest_mtime_by_ext(&css_path, &["css"])?;
  let img = latest_mtime_by_ext(&img_path, &["png", "jpg", "jpeg", "gif", "svg"])?;
  let mut layout = latest_mtime_by_ext(&layout_root, &["php", "js"])?;
  if html_root.exists() {
    layout = layout.max(latest_mtime_by_ext(&html_root, &["html"])?);
  }

  Ok(WatchSnapshot { css, img, layout })
}

fn resolve_watch_paths(projects_path: &str, project_name: &str, config: &BuildConfig) -> Vec<PathBuf> {
  let project_dir = resolve_project_dir(projects_path, project_name, &config.nest);
  let root = normalize_rel(&config.root);
  let root_path = if root.is_empty() {
    project_dir
  } else {
    project_dir.join(root)
  };

  let mut paths = vec![
    root_path.join(&config.style).join("src"),
    root_path.join(&config.img).join("src"),
    root_path.join(&config.layouts),
    root_path.join(&config.html),
  ];
  paths.sort();
  paths.dedup();
  paths
}

fn scan_projects(projects_path: &str) -> Result<ProjectsResponse, String> {
  let base = Path::new(projects_path);
  if !base.exists() {
    return Err(format!("Путь не найден: {}", projects_path));
  }

  let mut out = ProjectsResponse {
    verstak: Vec::new(),
    polki: Vec::new(),
    git: Vec::new(),
  };

  let entries = fs::read_dir(base).map_err(|e| e.to_string())?;
  for entry in entries {
    let entry = entry.map_err(|e| e.to_string())?;
    let dir_path = entry.path();
    if !dir_path.is_dir() {
      continue;
    }

    let pure_name = entry.file_name().to_string_lossy().to_string();
    let mut has_project_manifest = false;

    for file_name in ["verstak.json", "polki.json"] {
      let manifest = dir_path.join(file_name);
      if manifest.exists() {
        let project_type = if file_name == "verstak.json" { "verstak" } else { "polki" };
        let parsed = parse_project_manifest(base, &pure_name, &manifest, project_type)?;
        has_project_manifest = true;
        if project_type == "verstak" {
          out.verstak.extend(parsed);
        } else {
          out.polki.extend(parsed);
        }
      }
    }

    if !has_project_manifest && dir_path.join(".git").exists() {
      out.git.push(ProjectItem {
        name: pure_name.clone(),
        pure_name,
        project_type: "git".to_string(),
        data: None,
        link: None,
      });
    }
  }

  Ok(out)
}

fn projects_cache_file(projects_path: &str) -> Option<PathBuf> {
  let cache_root = if let Ok(xdg) = env::var("XDG_CACHE_HOME") {
    PathBuf::from(xdg)
  } else if let Ok(local_app_data) = env::var("LOCALAPPDATA") {
    // Windows fallback.
    PathBuf::from(local_app_data)
  } else if let Ok(home) = env::var("HOME") {
    PathBuf::from(home).join(".cache")
  } else {
    // Last-resort fallback for restricted CI/user envs.
    env::temp_dir()
  };

  let mut hasher = DefaultHasher::new();
  projects_path.hash(&mut hasher);
  let hash = hasher.finish();
  Some(cache_root.join("stanok").join(format!("projects-{:x}.json", hash)))
}

fn save_projects_cache_to_disk(projects_path: &str, data: &ProjectsResponse) -> Result<(), String> {
  let file = projects_cache_file(projects_path).ok_or("Не удалось определить путь к кэшу")?;
  if let Some(parent) = file.parent() {
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  }
  let body = serde_json::to_string(data).map_err(|e| e.to_string())?;
  fs::write(file, body).map_err(|e| e.to_string())
}

fn load_projects_cache_from_disk(projects_path: &str) -> Option<ProjectsResponse> {
  let file = projects_cache_file(projects_path)?;
  if cache_file_is_stale(&file) {
    let _ = fs::remove_file(&file);
    return None;
  }
  let raw = fs::read_to_string(file).ok()?;
  serde_json::from_str::<ProjectsResponse>(&raw).ok()
}

fn cache_file_is_stale(file: &Path) -> bool {
  let meta = match fs::metadata(file) {
    Ok(value) => value,
    Err(_) => return true,
  };

  let modified = match meta.modified() {
    Ok(value) => value,
    Err(_) => return true,
  };

  let age = match modified.elapsed() {
    Ok(value) => value,
    Err(_) => return true,
  };

  age.as_secs() > PROJECTS_CACHE_TTL_SECS
}

fn run_build_orchestrated(
  state: &BuildOrchestratorState,
  kind: BuildKind,
  payload: BuildPayload,
) -> Result<String, String> {
  let key = format!("{}::{}", payload.projects_path, payload.project_name);

  {
    let mut guard = state.entries.lock().map_err(|_| "Ошибка блокировки очереди сборки".to_string())?;
    let entry = guard.entry(key.clone()).or_default();
    if entry.running {
      match kind {
        BuildKind::Styles => entry.pending_styles = true,
        BuildKind::Images => entry.pending_images = true,
      }
      return Ok("Задача поставлена в очередь".to_string());
    }
    entry.running = true;
    match kind {
      BuildKind::Styles => entry.pending_styles = true,
      BuildKind::Images => entry.pending_images = true,
    }
  }

  let mut outputs: Vec<String> = Vec::new();
  loop {
    let (run_styles, run_images) = {
      let mut guard = state.entries.lock().map_err(|_| "Ошибка блокировки очереди сборки".to_string())?;
      let entry = guard.entry(key.clone()).or_default();
      let s = entry.pending_styles;
      let i = entry.pending_images;
      entry.pending_styles = false;
      entry.pending_images = false;
      (s, i)
    };

    let run_result = (|| -> Result<(), String> {
      if run_images {
        let out = run_node_script(state, "build-images.mjs", &payload)?;
        if !out.is_empty() {
          outputs.push(out);
        }
      }
      if run_styles {
        let out = run_node_script(state, "build-css.mjs", &payload)?;
        if !out.is_empty() {
          outputs.push(out);
        }
      }
      Ok(())
    })();

    if let Err(error) = run_result {
      if let Ok(mut guard) = state.entries.lock() {
        if let Some(entry) = guard.get_mut(&key) {
          entry.running = false;
          entry.pending_styles = false;
          entry.pending_images = false;
        }
      }
      return Err(error);
    }

    let should_continue = {
      let mut guard = state.entries.lock().map_err(|_| "Ошибка блокировки очереди сборки".to_string())?;
      let entry = guard.entry(key.clone()).or_default();
      if entry.pending_styles || entry.pending_images {
        true
      } else {
        entry.running = false;
        false
      }
    };

    if !should_continue {
      break;
    }
  }

  if outputs.is_empty() {
    Ok("Сборка завершена".to_string())
  } else {
    Ok(outputs.join("\n"))
  }
}

fn should_skip_dir(path: &Path) -> bool {
  let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
  matches!(
    name,
    "node_modules"
      | ".git"
      | "target"
      | "dist"
      | "dest"
      | "maps"
      | ".idea"
      | ".vscode"
      | ".cache"
  )
}

fn parse_project_manifest(
  projects_root: &Path,
  pure_name: &str,
  manifest_path: &Path,
  project_type: &str,
) -> Result<Vec<ProjectItem>, String> {
  let source = fs::read_to_string(manifest_path).map_err(|e| e.to_string())?;
  let mut data: Value = serde_json::from_str(&source).map_err(|e| format!("{}: {}", manifest_path.display(), e))?;

  let mut nest = String::new();
  if let Some(nested) = data.get("nest").and_then(Value::as_str) {
    nest = nested.to_string();
    let manifest_name = manifest_path
      .file_name()
      .and_then(|s| s.to_str())
      .unwrap_or("verstak.json");
    let nested_path = projects_root.join(pure_name).join(nested).join(manifest_name);
    let nested_source = fs::read_to_string(&nested_path).map_err(|e| e.to_string())?;
    data = serde_json::from_str(&nested_source).map_err(|e| format!("{}: {}", nested_path.display(), e))?;
  }

  let mut items = Vec::new();
  match data {
    Value::Array(list) => {
      for item in list {
        if let Value::Object(mut obj) = item {
          if !obj.contains_key("name") {
            obj.insert("name".to_string(), Value::String("main".to_string()));
          }
          obj.insert("nest".to_string(), Value::String(nest.clone()));
          items.push(make_project_item(pure_name, project_type, Value::Object(obj))?);
        }
      }
    }
    Value::Object(mut obj) => {
      if !obj.contains_key("name") {
        obj.insert("name".to_string(), Value::String("main".to_string()));
      }
      obj.insert("nest".to_string(), Value::String(nest));
      items.push(make_project_item(pure_name, project_type, Value::Object(obj))?);
    }
    _ => {}
  }

  Ok(items)
}

fn make_project_item(pure_name: &str, project_type: &str, data: Value) -> Result<ProjectItem, String> {
  let short_name = data
    .get("name")
    .and_then(Value::as_str)
    .unwrap_or("main");

  let full_name = format!("{}/{}", pure_name, short_name);
  let normalized_data = normalize_project_data(data);
  let link = build_project_link(&full_name, normalized_data.as_ref());

  Ok(ProjectItem {
    name: full_name,
    pure_name: pure_name.to_string(),
    project_type: project_type.to_string(),
    data: normalized_data,
    link,
  })
}

fn normalize_project_data(data: Value) -> Option<Value> {
  let mut obj = data.as_object()?.clone();
  let root_default = "assets".to_string();
  let data_default = "_layouts".to_string();

  let path_value = obj
    .entry("path")
    .or_insert_with(|| {
      serde_json::json!({
        "root": root_default,
        "data": data_default
      })
    });

  if let Some(path_obj) = path_value.as_object_mut() {
    if !path_obj.contains_key("data") {
      if let Some(layouts) = path_obj.get("layouts").cloned() {
        path_obj.insert("data".to_string(), layouts);
      } else {
        if !path_obj.contains_key("root") {
          path_obj.insert("root".to_string(), Value::String("assets".to_string()));
        }
        path_obj.insert("data".to_string(), Value::String("_layouts".to_string()));
      }
    }

    let root = path_obj
      .get("root")
      .and_then(Value::as_str)
      .unwrap_or_default()
      .to_string();

    if let Some(Value::String(data_segment)) = path_obj.get("data").cloned() {
      let joined = if root.is_empty() {
        data_segment
      } else {
        format!("{}/{}", root, data_segment)
      };
      path_obj.insert(
        "data".to_string(),
        Value::String(joined.replace('\\', "/")),
      );
    }
  }

  Some(Value::Object(obj))
}

fn build_project_link(name: &str, data: Option<&Value>) -> Option<String> {
  let data = data?;
  let path_data = data
    .get("path")
    .and_then(Value::as_object)
    .and_then(|p| p.get("data"))
    .and_then(Value::as_str)?;

  let prefix = if name.contains("samsonpost") {
    "some"
  } else if name.contains("dev.test") {
    "dev"
  } else {
    "local"
  };

  let mut host = name.split('/').next().unwrap_or_default().to_string();

  if host.starts_with("dev.") && prefix != "dev" {
    host = host.replacen("dev.", &format!("{}.", prefix), 1);
  } else if prefix == "local" && !host.starts_with("local.") {
    host = format!("local.{}", host);
  } else if prefix == "some" && !host.starts_with("some.") {
    host = format!("some.{}", host);
  } else if prefix == "dev" && !host.starts_with("dev.") {
    host = format!("dev.{}", host);
  }

  if host.starts_with("lib") {
    host = host.replacen("lib", "local.lib.intsite.org", 1);
  }

  let link = format!("{}/{}", host, path_data);

  Some(format!("http://{}", link.replace("//", "/")))
}

fn main() {
  tauri::Builder::default()
    .plugin(tauri_plugin_window_state::Builder::default().build())
    .manage(ProjectWatchState::default())
    .manage(BranchWatchState::default())
    .manage(ProjectsCacheState::default())
    .manage(BuildOrchestratorState::default())
    .setup(|app| {
      spawn_resource_stats_emitter(app.handle().clone());
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      choose_projects_path,
      get_projects,
      get_projects_cached,
      refresh_projects_cache,
      get_git_branch,
      open_in_explorer,
      open_external_url,
      build_styles,
      build_images,
      project_watch_snapshot,
      start_project_watch,
      stop_project_watch,
      start_branch_watch,
      stop_branch_watch,
      get_resource_snapshot,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::time::{SystemTime, UNIX_EPOCH};
  use serde_json::json;

  #[test]
  fn compact_script_error_prefers_css_diagnostic() {
    let input = "node:internal/errors:542\npostcss-import: /tmp/a.css:9:13: Missed semicolon\nat x";
    let out = compact_script_error(input);
    assert_eq!(out, "postcss-import: /tmp/a.css:9:13: Missed semicolon");
  }

  #[test]
  fn compact_script_error_skips_noise_tail() {
    let input = "node:internal/errors:542\n^\n}\nError: Failed task\nat run";
    let out = compact_script_error(input);
    assert_eq!(out, "Error: Failed task");
  }

  #[test]
  fn build_config_keeps_explicit_empty_root() {
    let data = json!({ "path": { "root": "" } });
    let cfg = build_config_from_project_data(Some(&data));
    assert_eq!(cfg.root, "");
  }

  #[test]
  fn build_config_applies_defaults() {
    let data = json!({});
    let cfg = build_config_from_project_data(Some(&data));
    assert_eq!(cfg.root, "assets/");
    assert_eq!(cfg.style, "css");
    assert_eq!(cfg.img, "img");
    assert_eq!(cfg.layouts, "_layouts");
    assert_eq!(cfg.html, "_html");
  }

  #[test]
  fn build_config_normalizes_custom_root() {
    let data = json!({ "path": { "root": "/custom/root/" } });
    let cfg = build_config_from_project_data(Some(&data));
    assert_eq!(cfg.root, "custom/root/");
  }

  #[test]
  fn watch_snapshot_detects_css_and_img_changes() {
    let uniq = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .unwrap_or_default()
      .as_nanos();
    let root = std::env::temp_dir().join(format!("stanok-watch-test-{}", uniq));
    let project_root = root.join("demo").join("assets");

    let css_src = project_root.join("css").join("src");
    let img_src = project_root.join("img").join("src");
    let layouts = project_root.join("_layouts");
    fs::create_dir_all(&css_src).expect("css src dir");
    fs::create_dir_all(&img_src).expect("img src dir");
    fs::create_dir_all(&layouts).expect("layouts dir");

    fs::write(css_src.join("_main.css"), ".A{color:red;}").expect("write css");
    fs::write(img_src.join("x.png"), "png").expect("write img");
    fs::write(layouts.join("a.php"), "<?php echo 1;").expect("write layout");

    let cfg = build_config_from_project_data(Some(&json!({})));
    let first = compute_project_watch_snapshot(
      root.to_string_lossy().as_ref(),
      "demo/main",
      &cfg,
    )
    .expect("first snapshot");

    std::thread::sleep(Duration::from_millis(15));
    fs::write(css_src.join("_main.css"), ".A{color:blue;}").expect("rewrite css");
    let second = compute_project_watch_snapshot(
      root.to_string_lossy().as_ref(),
      "demo/main",
      &cfg,
    )
    .expect("second snapshot");
    assert_ne!(first.css, second.css);

    std::thread::sleep(Duration::from_millis(15));
    fs::write(img_src.join("x.png"), "png2").expect("rewrite img");
    let third = compute_project_watch_snapshot(
      root.to_string_lossy().as_ref(),
      "demo/main",
      &cfg,
    )
    .expect("third snapshot");
    assert_ne!(second.img, third.img);

    let _ = fs::remove_dir_all(root);
  }
}
