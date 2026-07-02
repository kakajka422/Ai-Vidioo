const config = window.__WAN_SITE_CONFIG__ || {};
const form = document.getElementById("generate-form");
const promptField = document.getElementById("prompt");
const generateButton = document.getElementById("generate-button");
const activeStatus = document.getElementById("active-status");
const historyList = document.getElementById("history-list");
const errorNotice = document.getElementById("error-notice");
const premiumPasswordWrap = document.getElementById("premium-password-wrap");
const premiumPasswordField = document.getElementById("premium-password");
const tierInputs = document.querySelectorAll('input[name="tier"]');
const HISTORY_STORAGE_KEY = "wan-site-api-history-v1";

const jobs = new Map();
const activePollers = new Map();
const mediaBlobUrls = new Map();

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getApiBaseUrl() {
  return String(config.apiBaseUrl || "").trim().replace(/\/$/, "");
}

function resolveAssetUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith("/")) return `${getApiBaseUrl()}${raw}`;
  return `${getApiBaseUrl()}/${raw.replace(/^\/+/, "")}`;
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDuration(seconds) {
  const safe = Math.max(0, Math.round(Number(seconds || 0)));
  const minutes = Math.floor(safe / 60);
  const remainingSeconds = safe % 60;
  if (minutes <= 0) return `${remainingSeconds} сек`;
  if (remainingSeconds === 0) return `${minutes} мин`;
  return `${minutes} мин ${remainingSeconds} сек`;
}

function getEstimatedProgress(job) {
  if (!job) return 0;
  if (job.status === "done") return 100;
  if (job.status === "error") return Math.max(0, Math.min(99, Number(job.progress_percent || 0)));
  if (job.status === "queued") return 0;

  const startedAt = parseDate(job.started_at);
  const estimatedTotal = Number(job.estimated_total_seconds || 0);
  if (!startedAt || estimatedTotal <= 0) {
    return Math.max(1, Math.min(95, Number(job.progress_percent || 1)));
  }

  const elapsedSeconds = Math.max(0, (Date.now() - startedAt.getTime()) / 1000);
  const estimatedPercent = Math.round((elapsedSeconds / estimatedTotal) * 100);
  return Math.max(3, Math.min(95, estimatedPercent));
}

function getEstimatedProgressText(job) {
  if (!job || job.status !== "running") return "";

  const startedAt = parseDate(job.started_at);
  const estimatedTotal = Number(job.estimated_total_seconds || 0);
  if (!startedAt || estimatedTotal <= 0) return "";

  const elapsedSeconds = Math.max(0, (Date.now() - startedAt.getTime()) / 1000);
  const remainingSeconds = Math.max(0, estimatedTotal - elapsedSeconds);
  return `Примерно осталось: ${formatDuration(remainingSeconds)}`;
}

function getSelectedTier() {
  const selected = document.querySelector('input[name="tier"]:checked');
  return selected ? selected.value : "standard";
}

function syncPremiumVisibility() {
  const isPremium = getSelectedTier() === "premium";
  premiumPasswordWrap.classList.toggle("hidden", !isPremium);
  premiumPasswordField.required = isPremium;
}

function setActiveStatus(text, isError = false) {
  activeStatus.textContent = text;
  activeStatus.style.color = isError ? "var(--danger)" : "var(--muted)";
}

function showErrorNotice(text) {
  if (!errorNotice) return;
  errorNotice.innerHTML = `<h2>Ошибка</h2><p>${escapeHtml(text)}</p>`;
  errorNotice.classList.remove("hidden");
}

function hideErrorNotice() {
  if (!errorNotice) return;
  errorNotice.innerHTML = "";
  errorNotice.classList.add("hidden");
}

function apiUrl(path = "") {
  return `${getApiBaseUrl()}${path}`;
}

function saveHistory() {
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(Array.from(jobs.values())));
  } catch {
    // ignore localStorage failures
  }
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function clearBrokenHistory() {
  const savedJobs = loadHistory();
  const validJobs = savedJobs.filter((job) => job && typeof job === "object" && typeof job.job_id === "string");
  if (validJobs.length !== savedJobs.length) {
    try {
      localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(validJobs));
    } catch {
      // ignore localStorage failures
    }
  }
}

async function fetchMediaBlob(remoteUrl) {
  if (!remoteUrl) return "";
  if (mediaBlobUrls.has(remoteUrl)) return mediaBlobUrls.get(remoteUrl);

  const response = await fetch(remoteUrl, {
    headers: {
      "ngrok-skip-browser-warning": "true",
    },
  });

  if (!response.ok) {
    throw new Error(`Не удалось загрузить видеофайл (${response.status}).`);
  }

  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("text/html") || contentType.includes("text/plain")) {
    throw new Error("Сервер вместо видео вернул страницу или текст. Проверь FastAPI и ngrok.");
  }

  const blob = await response.blob();
  const blobUrl = URL.createObjectURL(blob);
  mediaBlobUrls.set(remoteUrl, blobUrl);
  return blobUrl;
}

async function hydrateMedia(card) {
  const video = card.querySelector("video[data-remote-src]");
  const openLink = card.querySelector("a[data-open-href]");
  const downloadLink = card.querySelector("a[data-download-href]");
  if (!video || !openLink || !downloadLink) return;

  const remoteVideoUrl = video.dataset.remoteSrc;
  const remoteDownloadUrl = downloadLink.dataset.downloadHref || remoteVideoUrl;
  if (!remoteVideoUrl) return;

  openLink.href = remoteVideoUrl;
  downloadLink.href = remoteDownloadUrl;

  if (video.dataset.ready === "1" || video.dataset.ready === "loading") return;
  video.dataset.ready = "loading";

  try {
    const blobUrl = await fetchMediaBlob(remoteVideoUrl);
    video.src = blobUrl;
    downloadLink.href = blobUrl;
    downloadLink.setAttribute("download", remoteDownloadUrl.split("/").pop() || "result.mp4");
    video.dataset.ready = "1";
  } catch (error) {
    video.dataset.ready = "error";
    const oldError = card.querySelector(".media-error");
    if (oldError) oldError.remove();
    const errorText = document.createElement("p");
    errorText.className = "error-text media-error";
    errorText.textContent = error.message || "Не удалось загрузить видео.";
    video.insertAdjacentElement("afterend", errorText);
  }
}

function hydrateAllMedia() {
  const cards = historyList.querySelectorAll(".history-card");
  cards.forEach((card) => hydrateMedia(card));
}

function renderJobCard(job) {
  const progressPercent = getEstimatedProgress(job);
  const progressHint = getEstimatedProgressText(job);
  const errorBlock = job.error ? `<p class="error-text">${escapeHtml(job.error)}</p>` : "";
  const hintBlock = progressHint ? `<p class="small-note">${escapeHtml(progressHint)}</p>` : "";
  const videoUrl = resolveAssetUrl(job.video_url);
  const downloadUrl = resolveAssetUrl(job.download_url || job.video_url);
  const videoBlock = videoUrl
    ? `
      <video controls playsinline preload="metadata" data-remote-src="${videoUrl}"></video>
      <div class="media-links">
        <a class="download-link" data-open-href="${videoUrl}" href="${videoUrl}" target="_blank" rel="noopener noreferrer">Открыть видео</a>
        <a class="download-link" data-download-href="${downloadUrl}" href="${downloadUrl}" target="_blank" rel="noopener noreferrer">Скачать результат</a>
      </div>
    `
    : "";

  return `
    <article class="history-card" data-job-id="${job.job_id}">
      <div class="card-top">
        <span class="job-status job-${job.status}">${escapeHtml(job.status || "queued")}</span>
        <time datetime="${escapeHtml(job.created_at || "")}">${escapeHtml(formatDate(job.created_at || ""))}</time>
      </div>
      <div class="meta-row">
        <span class="meta-badge">${escapeHtml(job.tier || "standard")}</span>
        <span class="meta-badge">${escapeHtml(String(job.fps || config.defaultFps || 8))} FPS</span>
      </div>
      <p class="prompt-text">${escapeHtml(job.prompt || "")}</p>
      <div class="progress-block ${job.status === "done" || job.status === "error" ? "progress-muted" : ""}">
        <div class="progress-top progress-top-simple">
          <span class="progress-value progress-value-large">${progressPercent}%</span>
        </div>
        <div class="progress-bar"><span style="width: ${progressPercent}%"></span></div>
      </div>
      ${hintBlock}
      ${errorBlock}
      ${videoBlock}
    </article>
  `;
}

function upsertJobCard(job, prepend = false) {
  if (!job?.job_id) return;
  jobs.set(job.job_id, { ...jobs.get(job.job_id), ...job });
  saveHistory();

  const existing = historyList.querySelector(`[data-job-id="${job.job_id}"]`);
  const markup = renderJobCard(jobs.get(job.job_id));

  if (existing) {
    existing.outerHTML = markup;
    const newCard = historyList.querySelector(`[data-job-id="${job.job_id}"]`);
    if (newCard) hydrateMedia(newCard);
    return;
  }

  const emptyState = historyList.querySelector(".empty-history");
  if (emptyState) emptyState.remove();

  if (prepend) {
    historyList.insertAdjacentHTML("afterbegin", markup);
  } else {
    historyList.insertAdjacentHTML("beforeend", markup);
  }

  const newCard = historyList.querySelector(`[data-job-id="${job.job_id}"]`);
  if (newCard) hydrateMedia(newCard);
}

function rerenderActiveJobs() {
  for (const job of jobs.values()) {
    if (job.status === "running") {
      upsertJobCard(job);
    }
  }
}

async function fetchJson(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("ngrok-skip-browser-warning", "true");

  const response = await fetch(apiUrl(path), {
    ...options,
    headers,
  });

  const text = await response.text().catch(() => "");
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(text.includes("ngrok") ? "Ngrok вернул защитную страницу вместо API. Проверь адрес туннеля." : text || "Сервер вернул не JSON.");
    }
  }

  if (!response.ok) {
    throw new Error(data.error || data.detail || "Ошибка запроса.");
  }
  return data;
}

async function pollJob(jobId) {
  if (!jobId || activePollers.has(jobId)) return;

  const timer = setInterval(async () => {
    try {
      const data = await fetchJson(`/api/jobs/${encodeURIComponent(jobId)}`);
      const job = data.job;
      upsertJobCard(job);

      if (job.status === "queued") setActiveStatus("Задача в очереди...");
      if (job.status === "running") setActiveStatus(`Генерация... ${getEstimatedProgress(job)}%`);
      if (job.status === "done") {
        clearInterval(timer);
        activePollers.delete(jobId);
        setActiveStatus("Готово. Видео сохранено.");
      }
      if (job.status === "error") {
        clearInterval(timer);
        activePollers.delete(jobId);
        setActiveStatus(job.error || "Ошибка генерации.", true);
      }
    } catch (error) {
      clearInterval(timer);
      activePollers.delete(jobId);
      setActiveStatus(error.message || "Не удалось обновить статус задачи.", true);
    }
  }, 3000);

  activePollers.set(jobId, timer);
}

function restoreHistory() {
  const savedJobs = loadHistory();
  if (!savedJobs.length) return;

  historyList.innerHTML = "";
  for (const job of savedJobs) {
    upsertJobCard(job);
    if (job.status === "queued" || job.status === "running") pollJob(job.job_id);
  }
  hydrateAllMedia();
}

async function bootstrapConfig() {
  try {
    await fetchJson("/api/config");
    hideErrorNotice();
  } catch (error) {
    showErrorNotice(error.message || "Ошибка подключения.");
  }
}

tierInputs.forEach((input) => input.addEventListener("change", syncPremiumVisibility));

form?.addEventListener("submit", async (event) => {
  event.preventDefault();

  const prompt = promptField.value.trim();
  const tier = getSelectedTier();
  const password = premiumPasswordField.value;

  if (!prompt) {
    setActiveStatus("Введите prompt перед запуском.", true);
    return;
  }

  if (tier === "premium" && !password.trim()) {
    setActiveStatus("Введите пароль для премиум-режима.", true);
    return;
  }

  generateButton.disabled = true;
  setActiveStatus("Создаю задачу...");

  try {
    const data = await fetchJson("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, tier, password })
    });

    hideErrorNotice();
    const job = data.job;
    upsertJobCard(job, true);
    setActiveStatus("Задача отправлена.");
    promptField.value = "";
    premiumPasswordField.value = "";
    pollJob(job.job_id);
  } catch (error) {
    showErrorNotice(error.message || "Ошибка отправки.");
    setActiveStatus(error.message || "Не удалось отправить prompt.", true);
  } finally {
    generateButton.disabled = false;
  }
});

syncPremiumVisibility();
clearBrokenHistory();
restoreHistory();
bootstrapConfig();
setInterval(rerenderActiveJobs, 1000);
