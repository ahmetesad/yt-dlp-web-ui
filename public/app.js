const storageKeys = {
  settings: "ytdlp_web_ui_settings",
  token: "ytdlp_web_ui_session_token"
};
const primaryQualityValues = ["1080", "480"];

const labelMap = {
  quality: {
    best: "best",
    2160: "2160p",
    1440: "1440p",
    1080: "1080p",
    720: "720p",
    480: "480p",
    360: "360p",
    240: "240p",
    worst: "smallest"
  },
  format: {
    mp4: "mp4",
    webm: "webm",
    mp3: "mp3",
    m4a: "m4a",
    wav: "wav"
  },
  remuxVideo: {
    none: "off",
    mp4: "mp4 for iPhone/iPad"
  }
};

const elements = {
  authMount: document.querySelector("#authMount"),
  audioOnly: document.querySelector("#audioOnly"),
  downloadButton: document.querySelector("#downloadButton"),
  downloadForm: document.querySelector("#downloadForm"),
  formatGroup: document.querySelector("#formatGroup"),
  includePlaylist: document.querySelector("#includePlaylist"),
  logoutButton: document.querySelector("#logoutButton"),
  mediaUrl: document.querySelector("#mediaUrl"),
  actionProgress: document.querySelector("#actionProgress"),
  actionProgressLabel: document.querySelector("#actionProgressLabel"),
  actionProgressMeter: document.querySelector("#actionProgressMeter"),
  actionProgressTrack: document.querySelector("#actionProgressTrack"),
  qualityGroup: document.querySelector("#qualityGroup"),
  qualityToggle: document.querySelector("#qualityToggle"),
  remuxField: document.querySelector("#remuxField"),
  remuxGroup: document.querySelector("#remuxGroup"),
  resetSettingsBtn: document.querySelector("#resetSettingsBtn"),
  results: document.querySelector("#results"),
  resultsList: document.querySelector("#resultsList"),
  statusMessage: document.querySelector("#statusMessage")
};

const state = {
  activeJobId: "",
  authenticated: false,
  authRequired: false,
  busy: false,
  client: null,
  jobStream: null,
  settings: null,
  showAllQualities: false,
  snapshotTimerId: 0
};

function readLocalStorage(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocalStorage(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    return;
  }
}

function removeLocalStorage(key) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    return;
  }
}

function getSavedToken() {
  return readLocalStorage(storageKeys.token) || "";
}

function setSavedToken(token) {
  if (typeof token === "string" && token) {
    writeLocalStorage(storageKeys.token, token);
  }
}

function clearSavedToken() {
  removeLocalStorage(storageKeys.token);
}

function getSavedSettings() {
  const rawValue = readLocalStorage(storageKeys.settings);

  if (!rawValue) {
    return {};
  }

  try {
    return JSON.parse(rawValue);
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  writeLocalStorage(storageKeys.settings, JSON.stringify(settings));
}

function clearSavedSettings() {
  removeLocalStorage(storageKeys.settings);
}

function getAvailableFormats(audioOnly) {
  return audioOnly ? state.client.formats.audio : state.client.formats.video;
}

function supportsRemux(settings = state.settings) {
  return Boolean(settings) && !settings.audioOnly && settings.format === "mp4";
}

function getVisibleQualityValues() {
  if (!state.client) {
    return [];
  }

  if (state.showAllQualities) {
    return state.client.qualities;
  }

  const visibleValues = new Set(primaryQualityValues);

  if (state.settings?.quality) {
    visibleValues.add(state.settings.quality);
  }

  return state.client.qualities.filter((value) => visibleValues.has(value));
}

function getAuthElements() {
  return {
    authButton: document.querySelector("#authButton"),
    authForm: document.querySelector("#authForm"),
    password: document.querySelector("#password")
  };
}

function focusPasswordInput() {
  const { password } = getAuthElements();

  if (password) {
    password.focus();
  }
}

function normalizeSettings(candidate = {}) {
  const defaults = state.client.defaults;
  const audioOnly =
    typeof candidate.audioOnly === "boolean"
      ? candidate.audioOnly
      : defaults.audioOnly;
  const includePlaylist =
    typeof candidate.includePlaylist === "boolean"
      ? candidate.includePlaylist
      : defaults.includePlaylist;
  const quality = state.client.qualities.includes(candidate.quality)
    ? candidate.quality
    : defaults.quality;
  const allowedFormats = getAvailableFormats(audioOnly);
  const defaultFormat = allowedFormats.includes(defaults.format)
    ? defaults.format
    : allowedFormats[0];
  const format = allowedFormats.includes(candidate.format)
    ? candidate.format
    : defaultFormat;
  const remuxOptions = Array.isArray(state.client.remuxVideoOptions)
    ? state.client.remuxVideoOptions
    : ["none"];
  const defaultRemuxVideo = remuxOptions.includes(defaults.remuxVideo)
    ? defaults.remuxVideo
    : "none";
  const remuxVideo = remuxOptions.includes(candidate.remuxVideo)
    ? candidate.remuxVideo
    : defaultRemuxVideo;

  return {
    audioOnly,
    format,
    includePlaylist,
    quality,
    remuxVideo
  };
}

function setStatus(message = "", tone = "") {
  elements.statusMessage.hidden = !message;
  elements.statusMessage.textContent = message;

  if (tone) {
    elements.statusMessage.dataset.tone = tone;
  } else {
    delete elements.statusMessage.dataset.tone;
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1024) {
    return `${bytes || 0} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = units[0];

  for (const nextUnit of units) {
    value /= 1024;
    unit = nextUnit;

    if (value < 1024) {
      break;
    }
  }

  return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
}

function getAuthHeaders() {
  const headers = new Headers();
  const token = getSavedToken();

  if (token) {
    headers.set("X-Session-Token", token);
  }

  return headers;
}

async function apiFetch(url, options = {}) {
  const headers = getAuthHeaders();

  for (const [key, value] of Object.entries(options.headers || {})) {
    headers.set(key, value);
  }

  const response = await fetch(url, {
    ...options,
    credentials: "same-origin",
    headers
  });
  const rawBody = await response.text();
  let payload = {};

  if (rawBody) {
    try {
      payload = JSON.parse(rawBody);
    } catch {
      payload = { error: rawBody };
    }
  }

  if (!response.ok) {
    throw new Error(payload.error || `Request failed (${response.status})`);
  }

  return payload;
}

function renderChoiceGroup(container, values, selectedValue, type) {
  container.replaceChildren();

  for (const value of values) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "choice";
    button.textContent = labelMap[type][value] || value;
    button.dataset.value = value;
    button.disabled = state.busy;
    button.setAttribute("aria-pressed", String(value === selectedValue));
    button.addEventListener("click", () => {
      state.settings = normalizeSettings({
        ...state.settings,
        [type]: value
      });
      syncForm();
      saveSettings(state.settings);
    });
    container.append(button);
  }
}

function syncForm() {
  elements.audioOnly.checked = state.settings.audioOnly;
  elements.includePlaylist.checked = state.settings.includePlaylist;

  renderChoiceGroup(
    elements.qualityGroup,
    getVisibleQualityValues(),
    state.settings.quality,
    "quality"
  );
  elements.qualityToggle.hidden = state.client.qualities.length <= primaryQualityValues.length;
  elements.qualityToggle.textContent = state.showAllQualities
    ? "show fewer"
    : "more qualities";
  renderChoiceGroup(
    elements.formatGroup,
    getAvailableFormats(state.settings.audioOnly),
    state.settings.format,
    "format"
  );

  if (supportsRemux(state.settings)) {
    elements.remuxField.hidden = false;
    renderChoiceGroup(
      elements.remuxGroup,
      state.client.remuxVideoOptions,
      state.settings.remuxVideo,
      "remuxVideo"
    );
  } else {
    elements.remuxField.hidden = true;
    elements.remuxGroup.replaceChildren();
  }
}

function setBusy(isBusy) {
  state.busy = isBusy;
  elements.audioOnly.disabled = isBusy;
  elements.downloadButton.disabled = isBusy;
  elements.includePlaylist.disabled = isBusy;
  elements.logoutButton.disabled = isBusy;
  elements.mediaUrl.disabled = isBusy;
  elements.resetSettingsBtn.disabled = isBusy;
  const { authButton, password } = getAuthElements();

  if (authButton) {
    authButton.disabled = isBusy;
  }

  if (password) {
    password.disabled = isBusy;
  }

  document.querySelectorAll(".choice").forEach((button) => {
    button.disabled = isBusy;
  });
}

function clearSnapshotTimer() {
  if (!state.snapshotTimerId) {
    return;
  }

  window.clearTimeout(state.snapshotTimerId);
  state.snapshotTimerId = 0;
}

function closeJobStream() {
  clearSnapshotTimer();

  if (!state.jobStream) {
    return;
  }

  state.jobStream.close();
  state.jobStream = null;
}

function clearActiveJob() {
  state.activeJobId = "";
  closeJobStream();
}

function getPhaseLabel(status, progress) {
  if (status === "queued") {
    return "queued";
  }

  if (progress?.phase === "postprocessing") {
    return "processing";
  }

  return "downloading";
}

function setProgressState({ progress = null, status = "running" } = {}) {
  const normalizedPercent = Number.isFinite(progress?.percent)
    ? Math.max(0, Math.min(100, progress.percent))
    : null;
  const phaseLabel = getPhaseLabel(status, progress);

  elements.actionProgress.hidden = false;
  elements.actionProgressLabel.textContent =
    status === "queued" && normalizedPercent === null
      ? "queued"
      : phaseLabel === "processing"
        ? normalizedPercent === null
          ? "processing"
          : `processing ${Math.round(normalizedPercent)}%`
        : normalizedPercent === null
          ? "starting"
          : `${Math.round(normalizedPercent)}%`;

  if (normalizedPercent === null) {
    elements.actionProgressTrack.dataset.indeterminate = "true";
    elements.actionProgressTrack.removeAttribute("aria-valuenow");
    elements.actionProgressTrack.setAttribute(
      "aria-valuetext",
      phaseLabel === "processing" ? "Processing media" : "Downloading media"
    );
    elements.actionProgressMeter.style.width = "";
    return;
  }

  elements.actionProgressTrack.dataset.indeterminate = "false";
  elements.actionProgressTrack.setAttribute(
    "aria-valuenow",
    String(Math.round(normalizedPercent))
  );
  elements.actionProgressTrack.setAttribute(
    "aria-valuetext",
    `${Math.round(normalizedPercent)} percent`
  );
  elements.actionProgressMeter.style.width = `${normalizedPercent}%`;
}

function hideProgress() {
  elements.actionProgress.hidden = true;
  elements.actionProgressLabel.textContent = "";
  elements.actionProgressTrack.dataset.indeterminate = "false";
  elements.actionProgressTrack.removeAttribute("aria-valuenow");
  elements.actionProgressTrack.removeAttribute("aria-valuetext");
  elements.actionProgressMeter.style.width = "0%";
}

function bindAuthForm() {
  const { authForm, password } = getAuthElements();

  if (!authForm || authForm.dataset.bound === "true") {
    return;
  }

  authForm.dataset.bound = "true";
  authForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const nextPassword = password?.value.trim() || "";

    if (!nextPassword) {
      setStatus("Enter the password first.", "error");
      password?.focus();
      return;
    }

    setBusy(true);
    setStatus("Checking password...", "info");

    try {
      const payload = await apiFetch("/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ password: nextPassword })
      });

      if (payload.token) {
        setSavedToken(payload.token);
      }

      state.authenticated = true;

      if (password) {
        password.value = "";
      }

      updateAuthVisibility();
      setStatus("Unlocked.", "success");
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      setBusy(false);
    }
  });
}

function updateAuthVisibility() {
  const showAuth = state.authRequired && !state.authenticated;

  if (showAuth) {
    elements.authMount.innerHTML = `
      <form class="auth-panel" id="authForm">
        <label class="field" for="password">
          <span class="field-label mono">password</span>
          <input
            id="password"
            name="password"
            type="password"
            placeholder="Enter password"
            autocomplete="current-password"
          >
        </label>

        <div class="action-row action-row-end">
          <button class="action" id="authButton" type="submit">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M7 10V7a5 5 0 0 1 10 0v3"></path>
              <rect x="5" y="10" width="14" height="10" rx="2"></rect>
              <path d="M12 14v2"></path>
            </svg>
            <span>Unlock</span>
          </button>
        </div>
      </form>
    `;
    bindAuthForm();
  } else {
    elements.authMount.replaceChildren();
  }

  elements.logoutButton.hidden = !state.authRequired || !state.authenticated;
  setBusy(state.busy);
}

function renderResults(files = []) {
  elements.resultsList.replaceChildren();
  elements.results.hidden = files.length === 0;

  for (const file of files) {
    const row = document.createElement("div");
    row.className = "results-row";

    const copy = document.createElement("div");
    copy.className = "result-copy";

    const name = document.createElement("p");
    name.className = "result-name";
    name.textContent = file.name;

    const meta = document.createElement("p");
    meta.className = "result-meta";
    meta.textContent = formatBytes(file.size);

    const action = document.createElement("button");
    action.type = "button";
    action.className = "action";
    action.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 4v10"></path>
        <path d="m8 10 4 4 4-4"></path>
        <path d="M5 19h14"></path>
      </svg>
      <span>Save</span>
    `;
    action.addEventListener("click", () => {
      triggerBrowserDownload(file);
    });

    copy.append(name, meta);
    row.append(copy, action);
    elements.resultsList.append(row);
  }
}

function triggerBrowserDownload(file) {
  const link = document.createElement("a");

  link.href = file.url;
  link.download = file.name;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}

function parseEventPayload(event) {
  if (!event || typeof event.data !== "string" || !event.data) {
    return null;
  }

  try {
    return JSON.parse(event.data);
  } catch {
    return null;
  }
}

function completeActiveJob(files = []) {
  clearActiveJob();
  setBusy(false);
  hideProgress();
  renderResults(files);

  if (files.length === 1) {
    triggerBrowserDownload(files[0]);
    setStatus("File is ready.", "success");
    return;
  }

  setStatus(`${files.length} files are ready.`, "success");
}

function failActiveJob(message) {
  clearActiveJob();
  setBusy(false);
  hideProgress();
  setStatus(message || "Download failed.", "error");
}

function applyJobSnapshot(snapshot) {
  if (!snapshot || snapshot.jobId !== state.activeJobId) {
    return;
  }

  setProgressState({
    progress: snapshot.progress,
    status: snapshot.status
  });

  if (snapshot.status === "completed") {
    completeActiveJob(snapshot.files);
    return;
  }

  if (snapshot.status === "failed") {
    failActiveJob(snapshot.error);
  }
}

async function syncJobSnapshot(jobId) {
  if (!jobId || jobId !== state.activeJobId) {
    return;
  }

  const snapshot = await apiFetch(`/api/jobs/${encodeURIComponent(jobId)}`);
  applyJobSnapshot(snapshot);
}

function queueSnapshotSync(jobId) {
  if (!jobId || jobId !== state.activeJobId || state.snapshotTimerId) {
    return;
  }

  state.snapshotTimerId = window.setTimeout(async () => {
    state.snapshotTimerId = 0;

    try {
      await syncJobSnapshot(jobId);
    } catch (error) {
      if (jobId !== state.activeJobId) {
        return;
      }

      if (error.message === "Password required.") {
        state.authenticated = false;
        updateAuthVisibility();
      }

      failActiveJob(error.message);
    }
  }, 1200);
}

function openJobStream(jobId) {
  closeJobStream();

  const stream = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/events`);
  state.jobStream = stream;

  stream.addEventListener("snapshot", (event) => {
    const payload = parseEventPayload(event);

    if (payload) {
      applyJobSnapshot(payload);
    }
  });

  stream.addEventListener("progress", (event) => {
    if (jobId !== state.activeJobId) {
      return;
    }

    const payload = parseEventPayload(event);

    if (!payload) {
      return;
    }

    setProgressState({
      progress: payload,
      status: payload.phase === "postprocessing" ? "postprocessing" : "running"
    });
  });

  stream.addEventListener("complete", (event) => {
    if (jobId !== state.activeJobId) {
      return;
    }

    const payload = parseEventPayload(event);
    completeActiveJob(payload?.files || []);
  });

  stream.addEventListener("error", (event) => {
    if (jobId !== state.activeJobId) {
      return;
    }

    const payload = parseEventPayload(event);

    if (payload && typeof payload.error === "string") {
      failActiveJob(payload.error);
      return;
    }

    queueSnapshotSync(jobId);
  });
}

async function bootstrap() {
  setBusy(true);
  hideProgress();
  setStatus("Loading...", "info");

  try {
    const payload = await apiFetch("/api/bootstrap");

    state.client = payload.client;
    state.authRequired = payload.authRequired;
    state.authenticated = payload.authenticated;
    state.settings = normalizeSettings(getSavedSettings());

    if (!state.authenticated) {
      clearSavedToken();
    }

    syncForm();
    updateAuthVisibility();
    renderResults();
    setStatus("");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    setBusy(false);
  }
}

elements.audioOnly.addEventListener("change", () => {
  state.settings = normalizeSettings({
    ...state.settings,
    audioOnly: elements.audioOnly.checked
  });
  syncForm();
  saveSettings(state.settings);
});

elements.includePlaylist.addEventListener("change", () => {
  state.settings = normalizeSettings({
    ...state.settings,
    includePlaylist: elements.includePlaylist.checked
  });
  saveSettings(state.settings);
});

elements.qualityToggle.addEventListener("click", () => {
  state.showAllQualities = !state.showAllQualities;
  syncForm();
});

elements.resetSettingsBtn.addEventListener("click", () => {
  state.showAllQualities = false;
  state.settings = normalizeSettings(state.client.defaults);
  clearSavedSettings();
  syncForm();
  setStatus("Defaults restored.", "success");
});

elements.logoutButton.addEventListener("click", async () => {
  try {
    await apiFetch("/api/auth/logout", {
      method: "POST"
    });
  } catch {
    return;
  } finally {
    clearSavedToken();
    state.authenticated = false;
    updateAuthVisibility();
    setStatus("Session removed from this browser.", "info");
  }
});

elements.downloadForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (state.busy || state.activeJobId) {
    return;
  }

  if (state.authRequired && !state.authenticated) {
    setStatus("Enter the password before downloading.", "error");
    focusPasswordInput();
    return;
  }

  const mediaUrl = elements.mediaUrl.value.trim();

  if (!mediaUrl) {
    setStatus("Paste a URL first.", "error");
    elements.mediaUrl.focus();
    return;
  }

  setBusy(true);
  renderResults();
  setStatus("");
  setProgressState({
    progress: {
      downloadedBytes: null,
      etaSeconds: null,
      message: "Creating download job...",
      percent: null,
      phase: "downloading",
      totalBytes: null
    },
    status: "queued"
  });

  try {
    const payload = await apiFetch("/api/download", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        mediaUrl,
        ...state.settings,
        remuxVideo: supportsRemux(state.settings) ? state.settings.remuxVideo : "none"
      })
    });

    state.activeJobId = payload.jobId;
    setProgressState({
      progress: {
        downloadedBytes: null,
        etaSeconds: null,
        message: "Waiting for yt-dlp to start...",
        percent: null,
        phase: "downloading",
        totalBytes: null
      },
      status: payload.status || "queued"
    });
    openJobStream(payload.jobId);
  } catch (error) {
    hideProgress();

    if (error.message === "Password required.") {
      state.authenticated = false;
      updateAuthVisibility();
    }

    setStatus(error.message, "error");
    setBusy(false);
  }
});

window.addEventListener("pagehide", () => {
  closeJobStream();
});

bootstrap();
