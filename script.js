const config = window.__WAN_SITE_CONFIG__ || {};
const form = document.getElementById("generate-form");
const promptField = document.getElementById("prompt");
const generateButton = document.getElementById("generate-button");
const activeStatus = document.getElementById("active-status");
const historyList = document.getElementById("history-list");
const setupNotice = document.getElementById("setup-notice");
const errorNotice = document.getElementById("error-notice");
const premiumPasswordWrap = document.getElementById("premium-password-wrap");
const premiumPasswordField = document.getElementById("premium-password");
const tierInputs = document.querySelectorAll('input[name="tier"]');
const HISTORY_STORAGE_KEY = "wan-site-api-history-v1";

const jobs = new Map();
const activePollers = new Map();

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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

function showNotice(element, html) {
  element.innerHTML = html;
  element.classList.remove("hidden");
}

function hideNotice(element) {
  element.innerHTML = "";
  element.classList.add("hidden");
}

function apiUrl(path = "") {
  return `${String(config.apiBaseUrl || "").replace(/\/$/, "")}${path}`;
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
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

function renderJobCard(job) {
  const progressPercent = Math.max(0, Math.min(100, Number(job.progress_percent || 0)));
  const errorBlock = job.error ? `<p class="error-text">${escapeHtml(job.error)}</p>` : "";
  const videoBlock = job.video_url
    ? `
      <video controls preload="metadata" src="${job.video_url}"></video>
      <a class="download-link" href="${job.download_url}" download>Скачать результат</a>
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
    return;
  }

  const emptyState = historyList.querySelector(".empty-history");
  if (emptyState) emptyState.remove();

  if (prepend) {
    historyList.insertAdjacentHTML("afterbegin", markup);
  } else {
    historyList.insertAdjacentHTML("beforeend", markup);
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

      if (job.status === "queued") {
        setActiveStatus("Задача в очереди...");
      }
      if (job.status === "running") {
        setActiveStatus(`Генерация... ${job.progress_percent || 0}%`);
      }
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
    if (job.status === "queued" || job.status === "running") {
      pollJob(job.job_id);
    }
  }
}

async function bootstrapConfig() {
  try {
    const data = await fetchJson("/api/config");
    hideNotice(errorNotice);

    const notes = [];
    notes.push(`<p>Сайт подключён к твоему серверу.</p>`);
    notes.push(`<p class="small-note">Текущий адрес: ${escapeHtml(apiUrl())}</p>`);
    notes.push(`<p class="small-note">Обычный режим: ${escapeHtml(String(data.default_fps || 8))} FPS, премиум: ${escapeHtml(String(data.premium_fps || 14))} FPS.</p>`);
    showNotice(setupNotice, notes.join(""));
  } catch (error) {
    showNotice(errorNotice, `<h2>Нужна настройка</h2><p>${escapeHtml(error.message || "Ошибка подключения.")}</p>`);
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

    const job = data.job;
    upsertJobCard(job, true);
    setActiveStatus("Задача отправлена.");
    promptField.value = "";
    premiumPasswordField.value = "";
    pollJob(job.job_id);
  } catch (error) {
    setActiveStatus(error.message || "Не удалось отправить prompt.", true);
  } finally {
    generateButton.disabled = false;
  }
});

syncPremiumVisibility();
clearBrokenHistory();
restoreHistory();
bootstrapConfig();
