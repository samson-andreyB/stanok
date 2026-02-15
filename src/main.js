import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

const state = {
  projectsPath: null,
  currentProjectId: null,
  projectMap: new Map(),
  branchWatchUnlisten: null,
  branchSnapshot: new Map(),
  startSequenceId: 0,
  projectsLoadSeq: 0,
  projectWatchUnlisten: null,
  projectWatchLastEventAt: 0,
  branchWatchLastEventAt: 0,
  watchLastError: '',
  watchStatusTimer: null,
  resourceTimer: null,
  resourcePollIntervalMs: 4000,
  resourcePollHiddenMs: 15000,
  lastResourceSample: null,
  resourceEventsSupported: false,
  resourceFallbackStarted: false,
  resourceUnlisten: null,
  windowFocused: true,
  watchBuildInFlight: false,
  watchBuildPendingCss: false,
  watchBuildPendingImg: false,
};

const MAX_PROJECT_LOG_ENTRIES = 200;
const MAX_GLOBAL_LOG_CHARS = 20000;
const INVOKE_DEFAULT_TIMEOUT_MS = 12000;
const INVOKE_BUILD_TIMEOUT_MS = 10 * 60 * 1000;

const ui = {
  projectsPathInfo: document.querySelector('#projectsPathInfo'),
  projectsPathChoose: document.querySelector('#projectsPathChoose'),
  refresh: document.querySelector('.ProjectsChooser__refresh'),
  projectsPanel: document.querySelector('.Panel--projects'),
  projects: document.querySelector('.Projects'),
  log: document.querySelector('#log'),
  projectsCount: document.querySelector('#projectsCount'),
  activeProjectName: document.querySelector('#activeProjectName'),
  cpuUsage: document.querySelector('#cpuUsage'),
  memoryUsage: document.querySelector('#memoryUsage'),
  watcherStatus: document.querySelector('#watcherStatus'),
  runtimeAppVersion: document.querySelector('#runtimeAppVersion'),
  runtimeTauriVersion: document.querySelector('#runtimeTauriVersion'),
  runtimeNodeVersion: document.querySelector('#runtimeNodeVersion'),
};

function setProjectsPanelVisible(visible) {
  if (!ui.projectsPanel) {
    return;
  }
  ui.projectsPanel.style.display = visible ? '' : 'none';
}

async function invokeWithPolicy(command, args = {}, options = {}) {
  const timeoutMs = Number(options.timeoutMs || INVOKE_DEFAULT_TIMEOUT_MS);
  const retries = Math.max(0, Number(options.retries || 0));
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs || 250));
  const retryOn = typeof options.retryOn === 'function'
    ? options.retryOn
    : (error) => isInvokeTimeoutError(error);

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await withTimeout(invoke(command, args), timeoutMs, command);
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !retryOn(error)) {
        throw error;
      }
      await delay(retryDelayMs);
    }
  }

  throw lastError || new Error(`Не удалось выполнить команду: ${command}`);
}

function withTimeout(promise, timeoutMs, command) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }

  return new Promise((resolve, reject) => {
    const id = window.setTimeout(() => {
      reject(new Error(`Timeout ${timeoutMs}ms: ${command}`));
    }, timeoutMs);

    promise
      .then((value) => {
        window.clearTimeout(id);
        resolve(value);
      })
      .catch((error) => {
        window.clearTimeout(id);
        reject(error);
      });
  });
}

function isInvokeTimeoutError(error) {
  const text = String(error || '').toLowerCase();
  return text.includes('timeout');
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

init().catch((error) => {
  addLog(String(error), 'error');
});

async function init() {
  patchConsole();
  bindEvents();
  await setupBranchEvents();
  await setupProjectWatchEvents();
  startWatchStatusTicker();
  state.windowFocused = document.hasFocus();
  startResourceUpdates();
  await loadRuntimeInfo();

  const savedPath = localStorage.getItem('projectsPath');
  if (savedPath) {
    await setProjectsPath(savedPath, false);
  } else {
    await chooseProjectsPath();
  }
}

async function loadRuntimeInfo() {
  try {
    const info = await invokeWithPolicy('get_runtime_info', {}, { timeoutMs: 5000 });
    if (ui.runtimeAppVersion) {
      ui.runtimeAppVersion.textContent = String(info?.app_version || '--');
    }
    if (ui.runtimeTauriVersion) {
      ui.runtimeTauriVersion.textContent = String(info?.tauri_version || '--');
    }
    if (ui.runtimeNodeVersion) {
      ui.runtimeNodeVersion.textContent = String(info?.node_version || '--');
    }
  } catch {
    if (ui.runtimeAppVersion) ui.runtimeAppVersion.textContent = '--';
    if (ui.runtimeTauriVersion) ui.runtimeTauriVersion.textContent = '--';
    if (ui.runtimeNodeVersion) ui.runtimeNodeVersion.textContent = '--';
  }
}

function startWatchStatusTicker() {
  if (state.watchStatusTimer) {
    window.clearInterval(state.watchStatusTimer);
  }
  updateWatcherStatusUi();
  state.watchStatusTimer = window.setInterval(updateWatcherStatusUi, 2000);
}

async function setupBranchEvents() {
  if (typeof state.branchWatchUnlisten === 'function') {
    state.branchWatchUnlisten();
    state.branchWatchUnlisten = null;
  }

  state.branchWatchUnlisten = await listen('git://branch', (event) => {
    const payload = event?.payload;
    if (!payload || typeof payload !== 'object') {
      return;
    }

    const groupName = String(payload.group_name || '');
    if (!groupName) {
      return;
    }

    const branch = String(payload.branch || '');
    state.branchSnapshot.set(groupName, branch);
    state.branchWatchLastEventAt = Date.now();
    const group = document.querySelector(`.Project__group[data-project-group-name="${escapeSelector(groupName)}"]`);
    if (!group) {
      return;
    }
    const branchEl = group.querySelector('.Project__branch');
    if (branchEl) {
      branchEl.textContent = branch;
    }
  });
}

async function setupProjectWatchEvents() {
  if (typeof state.projectWatchUnlisten === 'function') {
    state.projectWatchUnlisten();
    state.projectWatchUnlisten = null;
  }

  state.projectWatchUnlisten = await listen('project://watch', (event) => {
    const payload = event?.payload;
    if (!payload || typeof payload !== 'object') {
      return;
    }
    state.projectWatchLastEventAt = Date.now();
    void handleProjectWatchPayload(payload);
  });
}

async function handleProjectWatchPayload(payload) {
  if (!state.currentProjectId) {
    return;
  }

  if (payload.error) {
    state.watchLastError = String(payload.error);
    addLog(`Ошибка автослежения: ${state.watchLastError}`, 'warn');
    return;
  }

  state.watchLastError = '';
  if (payload.img_changed) {
    state.watchBuildPendingImg = true;
  }
  if (payload.css_changed) {
    state.watchBuildPendingCss = true;
  }
  if (payload.img_changed || payload.css_changed) {
    void processWatchBuildQueue();
  }
  if (payload.layout_changed) {
    addLog('Обнаружены изменения разметки/скриптов');
  }
}

async function processWatchBuildQueue() {
  if (state.watchBuildInFlight) {
    return;
  }

  state.watchBuildInFlight = true;
  try {
    while (state.watchBuildPendingImg || state.watchBuildPendingCss) {
      const runImages = state.watchBuildPendingImg;
      const runStyles = state.watchBuildPendingCss;
      state.watchBuildPendingImg = false;
      state.watchBuildPendingCss = false;

      if (runImages && runStyles) {
        addLog('Обнаружены изменения стилей и изображений');
      } else if (runImages) {
        addLog('Обнаружены изменения изображений');
      } else if (runStyles) {
        addLog('Обнаружены изменения стилей');
      }

      if (runImages) {
        await buildImages();
      }
      if (runStyles) {
        await buildStyles();
      }
    }
  } finally {
    state.watchBuildInFlight = false;
  }
}

function updateWatcherStatusUi() {
  if (!ui.watcherStatus) {
    return;
  }

  const now = Date.now();
  const active = Boolean(state.currentProjectId);
  const isVisible = isAppActive();
  const projectAgeMs = state.projectWatchLastEventAt ? now - state.projectWatchLastEventAt : Number.POSITIVE_INFINITY;
  const branchAgeMs = state.branchWatchLastEventAt ? now - state.branchWatchLastEventAt : Number.POSITIVE_INFINITY;

  let text = 'idle';
  let cls = '';

  if (!isVisible) {
    text = 'paused';
    cls = 'Stat__value--warn';
  } else if (state.watchLastError && projectAgeMs < 30000) {
    text = 'error';
    cls = 'Stat__value--error';
  } else if (active && projectAgeMs > 20000) {
    text = 'stale';
    cls = 'Stat__value--warn';
  } else if (state.branchWatchLastEventAt > 0 && branchAgeMs > 25000 && state.projectsPath) {
    text = 'branch stale';
    cls = 'Stat__value--warn';
  } else if (active) {
    text = 'active';
    cls = 'Stat__value--ok';
  } else if (state.projectsPath) {
    text = 'ready';
    cls = 'Stat__value--ok';
  }

  ui.watcherStatus.textContent = text;
  ui.watcherStatus.className = `Stat__value Stat__value--small ${cls}`.trim();
}

function startResourceUpdates() {
  stopResourceUpdates();

  listen('resource://stats', (event) => {
    const payload = event?.payload;
    if (!payload || typeof payload !== 'object') {
      return;
    }

    state.resourceEventsSupported = true;
    setResourceUi(`${Number(payload.cpu_percent || 0).toFixed(1)}%`, `${(Number(payload.rss_kb || 0) / 1024).toFixed(0)} MB`);
  })
    .then((unlisten) => {
      state.resourceUnlisten = unlisten;
      window.setTimeout(() => {
        if (!state.resourceEventsSupported && !state.resourceFallbackStarted) {
          state.resourceFallbackStarted = true;
          startResourcePolling();
        }
      }, 3000);
    })
    .catch(() => {
      state.resourceFallbackStarted = true;
      startResourcePolling();
    });
}

function startResourcePolling() {
  stopResourcePolling();

  const tick = async () => {
    if (!isAppActive()) {
      state.resourceTimer = window.setTimeout(tick, state.resourcePollHiddenMs);
      return;
    }

    try {
      const snapshot = await invokeWithPolicy('get_resource_snapshot', {}, {
        timeoutMs: 3000,
        retries: 1,
        retryDelayMs: 120,
      });
      updateResourceStats(snapshot);
    } catch {
      setResourceUi('--', '--');
    } finally {
      state.resourceTimer = window.setTimeout(tick, state.resourcePollIntervalMs);
    }
  };

  state.resourceTimer = window.setTimeout(tick, 0);
}

function stopResourceUpdates() {
  stopResourcePolling();
  if (typeof state.resourceUnlisten === 'function') {
    state.resourceUnlisten();
  }
  state.resourceUnlisten = null;
  state.resourceEventsSupported = false;
  state.resourceFallbackStarted = false;
}

function stopResourcePolling() {
  if (state.resourceTimer) {
    window.clearTimeout(state.resourceTimer);
    state.resourceTimer = null;
  }
}

function updateResourceStats(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return;
  }

  const rssKb = Number(snapshot.rss_kb || 0);
  const memMb = Math.max(0, rssKb / 1024);

  let cpuText = '--';
  const directCpu = Number(snapshot.cpu_percent);
  if (Number.isFinite(directCpu) && directCpu >= 0) {
    cpuText = `${Math.max(0, directCpu).toFixed(1)}%`;
  } else {
    const prev = state.lastResourceSample;
    if (prev) {
      const deltaProcess = Number(snapshot.process_jiffies || 0) - Number(prev.process_jiffies || 0);
      const deltaTotal = Number(snapshot.total_jiffies || 0) - Number(prev.total_jiffies || 0);
      const cpuCount = Math.max(1, Number(snapshot.cpu_count || 1));
      if (deltaProcess >= 0 && deltaTotal > 0) {
        const cpuPercent = (deltaProcess / deltaTotal) * 100 * cpuCount;
        cpuText = `${Math.max(0, cpuPercent).toFixed(1)}%`;
      }
    }
  }

  state.lastResourceSample = snapshot;
  setResourceUi(cpuText, `${memMb.toFixed(0)} MB`);
}

function setResourceUi(cpu, ram) {
  if (ui.cpuUsage) {
    ui.cpuUsage.textContent = `CPU: ${cpu}`;
  }
  if (ui.memoryUsage) {
    ui.memoryUsage.textContent = `RAM: ${ram}`;
  }
}

function bindEvents() {
  ui.projectsPathChoose.addEventListener('click', () => {
    chooseProjectsPath().catch((error) => addLog(String(error), 'error'));
  });

  ui.refresh.addEventListener('click', () => {
    if (!state.projectsPath) {
      addLog('Сначала выберите папку с проектами', 'warn');
      return;
    }

    loadProjects().catch((error) => addLog(String(error), 'error'));
  });

  document.addEventListener('click', onDocumentClick);
  window.addEventListener('focus', handleAppStateChange);
  window.addEventListener('blur', handleAppStateChange);
  document.addEventListener('visibilitychange', handleAppStateChange);
}

function handleAppStateChange() {
  state.windowFocused = document.hasFocus();

  if (isAppActive()) {
    startResourceUpdates();
    if (state.projectsPath) {
      startBranchPolling().catch(() => {});
    }
    return;
  }

  stopResourceUpdates();
  stopBranchPolling();
}

async function onDocumentClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  if (await handleProjectToggle(target)) return;
  if (await handleBuildAction(target)) return;
  if (await handleOpenInExplorer(target)) return;
  await handleExternalLink(target, event);
}

async function handleProjectToggle(target) {
  if (!target.classList.contains('Project__start')) {
    return false;
  }
  const projectEl = target.closest('.Project');
  if (!projectEl) return true;
  await toggleProject(projectEl.dataset.projectId);
  return true;
}

async function handleBuildAction(target) {
  if (target.classList.contains('Project__build--styles')) {
    await buildStyles();
    return true;
  }

  if (target.classList.contains('Project__build--images')) {
    await buildImages();
    return true;
  }

  return false;
}

async function handleOpenInExplorer(target) {
  if (!target.classList.contains('Project__explorer')) {
    return false;
  }
  const projectPath = target.dataset.projectPath;
  if (projectPath) {
    await invokeWithPolicy('open_in_explorer', { path: projectPath }, { timeoutMs: 5000 });
  }
  return true;
}

async function handleExternalLink(target, event) {
  if (target.tagName !== 'A' || target.getAttribute('target') !== '_blank') {
    return false;
  }

  event.preventDefault();
  const href = target.getAttribute('href');
  if (href) {
    await invokeWithPolicy('open_external_url', { url: href }, { timeoutMs: 5000 });
  }
  return true;
}

async function chooseProjectsPath() {
  const path = await invokeWithPolicy('choose_projects_path', {}, { timeoutMs: 120000 });
  if (!path) {
    return;
  }
  await setProjectsPath(path, true);
}

async function setProjectsPath(path, save) {
  state.projectsPath = path;
  ui.projectsPathInfo.textContent = path;
  const loadSeq = ++state.projectsLoadSeq;

  if (save) {
    localStorage.setItem('projectsPath', path);
  }

  await restoreProjectsFromCache(path, loadSeq);
  await loadProjects(loadSeq);
}

async function loadProjects(loadSeq = ++state.projectsLoadSeq) {
  if (!state.projectsPath) {
    return;
  }

  const projects = await invokeWithPolicy('refresh_projects_cache', {
    projectsPath: state.projectsPath,
  }, {
    timeoutMs: 30000,
    retries: 1,
    retryDelayMs: 300,
  });
  if (loadSeq !== state.projectsLoadSeq) {
    return;
  }
  const totalCount = projects.verstak.length + projects.polki.length + projects.git.length;

  if (!totalCount) {
    stopBranchPolling();
    ui.projectsPathInfo.textContent = `В указанной папке (${state.projectsPath}) не найдены проекты Верстака. Укажите другую папку:`;
    ui.projects.innerHTML = '';
    setProjectsCount(0);
    setProjectsPanelVisible(false);
    return;
  }

  setProjectsPanelVisible(true);
  renderProjects(projects);
  setProjectsCount(totalCount);
  startBranchPolling().catch(() => {});
}

async function restoreProjectsFromCache(projectsPath, loadSeq) {
  if (loadSeq !== state.projectsLoadSeq) {
    return false;
  }

  let cached = null;
  try {
    cached = await invokeWithPolicy('get_projects_cached', { projectsPath }, { timeoutMs: 5000 });
  } catch {
    cached = null;
  }

  if (!cached) {
    return false;
  }

  const totalCount = cached.verstak.length + cached.polki.length + cached.git.length;
  if (!totalCount) {
    setProjectsPanelVisible(false);
    return false;
  }

  setProjectsPanelVisible(true);
  renderProjects(cached);
  setProjectsCount(totalCount);
  startBranchPolling().catch(() => {});
  return true;
}

function renderProjects(projects) {
  state.projectMap.clear();
  state.currentProjectId = null;
  stopBranchPolling();
  state.branchSnapshot.clear();
  stopProjectWatch();
  setActiveProjectLabel(null);

  const html = [
    renderProjectGroup(projects.verstak, 'verstak'),
    renderProjectGroup(projects.polki, 'polki'),
    renderProjectGroup(projects.git, 'git'),
  ]
    .filter(Boolean)
    .join('');

  ui.projects.innerHTML = html;
}

function renderProjectGroup(projects, type) {
  if (!projects.length) {
    return '';
  }

  const grouped = new Map();
  for (const project of projects) {
    const groupName = project.pure_name || project.name.split('/')[0];
    if (!grouped.has(groupName)) {
      grouped.set(groupName, []);
    }
    grouped.get(groupName).push(project);
  }

  const title = type === 'verstak' || type === 'polki' ? `${type}.json` : type;
  let result = `<div class="Projects__group Projects__group--${type}">`;
  result += `<h2 class="Projects__header">${title}</h2>`;

  for (const [groupName, items] of grouped) {
    result += `<div class="Project__group" data-project-group-name="${escapeHtml(groupName)}">`;
    result += `<div class="Project__groupTitle"><span class="Project__icon Project__icon--group" aria-hidden="true"></span><span class="Project__groupTitleText">${escapeHtml(groupName)}</span></div>`;
    result += `<span class="Project__explorer" data-project-path="${escapeHtml(`${state.projectsPath}/${groupName}`)}">Открыть в проводнике</span>`;

    for (const project of items) {
      const id = crypto.randomUUID();
      state.projectMap.set(id, project);
      result += renderProject(project, id);
    }

    result += '<span class="Project__branch"></span>';
    result += '</div>';
  }

  result += '</div>';
  return result;
}

function renderProject(project, id) {
  const hide = project.project_type === 'verstak' ? '' : 'hidden';

  let header = `<span class="Project__name">${escapeHtml(project.name.replace(/^dev\./, ''))}</span>`;
  if (project.data && project.link) {
    header = `<a class="Project__name" href="${escapeHtml(`${project.link}?th=true`)}" target="_blank">${escapeHtml(project.name.replace(/^dev\./, ''))}</a>`;
  }

  let result = `<div class="Project" data-project-id="${id}" data-project-name="${escapeHtml(project.name)}">`;
  result += `<div class="Project__header"><div class="Project__title">${header}</div></div>`;
  result += `<div class="Project__wrapper Project__controls" ${hide}><button class="Project__start" type="button"></button><button class="Project__build Project__build--styles" type="button">Обработать стили</button><button class="Project__build Project__build--images" type="button">Обработать изображения</button></div>`;

  result += '<div class="Project__log"></div>';
  result += '</div>';

  return result;
}

async function toggleProject(id) {
  if (!id || !state.projectMap.has(id)) {
    return;
  }

  stopProjectWatch();

  if (state.currentProjectId) {
    const prevEl = document.querySelector(`.Project[data-project-id="${state.currentProjectId}"]`);
    if (prevEl) {
      prevEl.classList.remove('Project--is-active');
      prevEl.classList.remove('Project--is-starting');
    }
    const prev = state.projectMap.get(state.currentProjectId);
    if (prev) {
      addLog(`Остановлена сборка проекта ${prev.name}`);
    }
    if (state.currentProjectId === id) {
      state.currentProjectId = null;
      setActiveProjectLabel(null);
      return;
    }
  }

  state.currentProjectId = id;
  const startSeq = ++state.startSequenceId;
  const el = document.querySelector(`.Project[data-project-id="${id}"]`);
  if (el) {
    el.classList.add('Project--is-active');
    el.classList.add('Project--is-starting');
  }
  const project = state.projectMap.get(id);
  setActiveProjectLabel(project);
  addProjectLog(id, `Начата сборка проекта ${project.name}`);

  // Start initial build without blocking UI interactions.
  queueMicrotask(async () => {
    const startedAt = Date.now();
    try {
      await runInitialBuild(project, id, startSeq);
      if (state.currentProjectId === id && state.startSequenceId === startSeq) {
        await startProjectWatch(project, id, startSeq);
      }
    } finally {
      const elapsed = Date.now() - startedAt;
      const delay = Math.max(0, 300 - elapsed);
      window.setTimeout(() => {
        const currentEl = document.querySelector(`.Project[data-project-id="${id}"]`);
        if (currentEl) {
          currentEl.classList.remove('Project--is-starting');
        }
      }, delay);
    }
  });
}

async function buildStyles() {
  await runProjectBuild({
    startMessage: (project) => `Запуск сборки стилей для ${project.name}`,
    command: 'build_styles',
    successMessage: 'Стили обработаны',
  });
}

async function buildImages() {
  await runProjectBuild({
    startMessage: (project) => `Запуск обработки изображений для ${project.name}`,
    command: 'build_images',
    successMessage: 'Изображения обработаны',
  });
}

async function runInitialBuild(project, projectId, startSeq) {
  if (!project?.data) {
    return;
  }
  if (state.currentProjectId !== projectId || state.startSequenceId !== startSeq) {
    return;
  }
  await runProjectBuildFor(project, projectId, {
    startMessage: (target) => `Запуск обработки изображений для ${target.name}`,
    command: 'build_images',
    successMessage: 'Изображения обработаны',
    staleGuard: () => state.currentProjectId === projectId && state.startSequenceId === startSeq,
  });
  if (state.currentProjectId !== projectId || state.startSequenceId !== startSeq) {
    return;
  }
  await runProjectBuildFor(project, projectId, {
    startMessage: (target) => `Запуск сборки стилей для ${target.name}`,
    command: 'build_styles',
    successMessage: 'Стили обработаны',
    staleGuard: () => state.currentProjectId === projectId && state.startSequenceId === startSeq,
  });
}

async function startProjectWatch(project, projectId = state.currentProjectId, startSeq = state.startSequenceId) {
  if (!project?.data || !state.projectsPath) {
    return;
  }

  if (state.currentProjectId !== projectId || state.startSequenceId !== startSeq) {
    return;
  }

  try {
    state.projectWatchLastEventAt = 0;
    state.watchLastError = '';
    await invokeWithPolicy('start_project_watch', {
      projectsPath: state.projectsPath,
      projectName: project.name,
      projectData: project.data || null,
    }, {
      timeoutMs: 10000,
    });
  } catch (error) {
    if (state.currentProjectId === projectId && state.startSequenceId === startSeq) {
      addProjectLog(projectId, `Ошибка запуска автослежения: ${String(error)}`, 'warn');
    }
  }
}

function stopProjectWatch() {
  invokeWithPolicy('stop_project_watch', {}, { timeoutMs: 3000 }).catch(() => {});
}

function startBranchPolling() {
  if (!state.projectsPath || !isAppActive()) {
    return Promise.resolve();
  }

  const groupNames = Array.from(document.querySelectorAll('.Project__group'))
    .map((group) => String(group.dataset.projectGroupName || '').trim())
    .filter((name) => name.length > 0);

  return invokeWithPolicy('start_branch_watch', {
    projectsPath: state.projectsPath,
    groupNames,
  }, {
    timeoutMs: 10000,
    retries: 1,
    retryDelayMs: 300,
  }).catch((error) => {
    addLog(`Ошибка запуска слежения за ветками: ${String(error)}`, 'warn');
  });
}

function stopBranchPolling() {
  invokeWithPolicy('stop_branch_watch', {}, { timeoutMs: 3000 }).catch(() => {});
}

function isAppActive() {
  return state.windowFocused && document.visibilityState === 'visible';
}

function getCurrentProject() {
  if (!state.currentProjectId) {
    return null;
  }
  return state.projectMap.get(state.currentProjectId) || null;
}

function addLog(text, type = '') {
  if (!text) {
    return;
  }

  if (type === 'error') {
    try {
      new Notification('Станок', {
        body: 'Ошибка. Детали в истории проекта',
      });
    } catch {
      // no-op
    }
  }

  const entry = `\n[${timeNow()}] ${type ? `[${type}] ` : ''}${String(text)}`;
  const current = getCurrentProject();
  if (current && state.currentProjectId) {
    const projectLog = document.querySelector(`.Project[data-project-id="${state.currentProjectId}"] .Project__log`);
    if (projectLog) {
      projectLog.insertAdjacentHTML('afterbegin', `<div class="Log Log--${escapeHtml(type)}"><div class="Log__box Log__box--data">${escapeHtml(entry)}</div></div>`);
      while (projectLog.childElementCount > MAX_PROJECT_LOG_ENTRIES) {
        projectLog.lastElementChild?.remove();
      }
      return;
    }
  }

  if (ui.log) {
    ui.log.textContent = `${entry}${ui.log.textContent}`.slice(0, MAX_GLOBAL_LOG_CHARS);
  }
}

function addProjectLog(projectId, text, type = '') {
  if (!text) {
    return;
  }

  if (!projectId) {
    addLog(text, type);
    return;
  }

  if (type === 'error') {
    try {
      new Notification('Станок', {
        body: 'Ошибка. Детали в истории проекта',
      });
    } catch {
      // no-op
    }
  }

  const projectLog = document.querySelector(`.Project[data-project-id="${projectId}"] .Project__log`);
  if (!projectLog) {
    addLog(text, type);
    return;
  }

  const entry = `\n[${timeNow()}] ${type ? `[${type}] ` : ''}${String(text)}`;
  projectLog.insertAdjacentHTML('afterbegin', `<div class="Log Log--${escapeHtml(type)}"><div class="Log__box Log__box--data">${escapeHtml(entry)}</div></div>`);
  while (projectLog.childElementCount > MAX_PROJECT_LOG_ENTRIES) {
    projectLog.lastElementChild?.remove();
  }
}

function patchConsole() {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  console.log = wrapConsoleMethod(originalLog);
  console.warn = wrapConsoleMethod(originalWarn, 'warn');
  console.error = wrapConsoleMethod(originalError, 'error');

  window.addEventListener('error', (event) => {
    if (event.error?.stack) {
      addLog(event.error.stack, 'error');
    } else if (event.message) {
      addLog(event.message, 'error');
    }
  });
}

function wrapConsoleMethod(original, type = '') {
  return (...args) => {
    original(...args);
    addLog(args.map(String).join(' '), type);
  };
}

async function runProjectBuild({ startMessage, command, successMessage }) {
  const project = getCurrentProject();
  if (!project) {
    addLog('Не выбран активный проект', 'warn');
    return;
  }

  if (!project.data) {
    addLog('У этого проекта нет конфигурации verstak/polki', 'warn');
    return;
  }

  const currentId = state.currentProjectId;
  await runProjectBuildFor(project, currentId, {
    startMessage,
    command,
    successMessage,
    staleGuard: () => state.currentProjectId === currentId,
  });
}

async function runProjectBuildFor(project, projectId, { startMessage, command, successMessage, staleGuard = null }) {
  if (!project?.data) {
    return;
  }

  if (typeof staleGuard === 'function' && !staleGuard()) {
    return;
  }

  addProjectLog(projectId, startMessage(project));

  const loadingClass = command === 'build_styles' ? 'Project--styles-loading' : 'Project--images-loading';
  const projectEl = projectId
    ? document.querySelector(`.Project[data-project-id="${projectId}"]`)
    : null;
  if (projectEl) {
    projectEl.classList.add(loadingClass);
  }

  try {
    const output = await invokeWithPolicy(command, {
      projectsPath: state.projectsPath,
      projectName: project.name,
      projectData: project.data || null,
    }, {
      timeoutMs: INVOKE_BUILD_TIMEOUT_MS,
    });
    if (typeof staleGuard !== 'function' || staleGuard()) {
      addProjectLog(projectId, output || successMessage, 'success');
    }
  } catch (error) {
    if (typeof staleGuard !== 'function' || staleGuard()) {
      addProjectLog(projectId, String(error), 'error');
    }
  } finally {
    if (projectEl) {
      projectEl.classList.remove(loadingClass);
    }
  }
}

function timeNow() {
  const now = new Date();
  const z = (n, len = 2) => String(n).padStart(len, '0');
  return `${z(now.getDate())}.${z(now.getMonth() + 1)}.${now.getFullYear()} ${z(now.getHours())}:${z(now.getMinutes())}:${z(now.getSeconds())}.${z(now.getMilliseconds(), 3)}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeSelector(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(String(value));
  }
  return String(value).replace(/(["\\#.:,>+~*^$|\\[\\](){}])/g, '\\$1');
}

function setProjectsCount(count) {
  if (!ui.projectsCount) {
    return;
  }
  ui.projectsCount.textContent = String(count);
}

function setActiveProjectLabel(project) {
  if (!ui.activeProjectName) {
    return;
  }
  ui.activeProjectName.textContent = project ? project.name.replace(/^dev\./, '') : 'не выбран';
}
