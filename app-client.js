(function () {
  const SAVE_DELAY = 600;
  const DAILY_GOAL_MINUTES = 120;
  const STAMP_POOL = [
    { emoji: "🐹", rarity: 1, weight: 20, label: "仓鼠" },
    { emoji: "🐰", rarity: 2, weight: 18, label: "兔兔" },
    { emoji: "🐱", rarity: 3, weight: 15, label: "小猫" },
    { emoji: "🐶", rarity: 4, weight: 12, label: "小狗" },
    { emoji: "🦊", rarity: 5, weight: 9, label: "狐狸" },
    { emoji: "🐼", rarity: 6, weight: 7, label: "熊猫" },
    { emoji: "🦁", rarity: 7, weight: 5, label: "狮子" },
    { emoji: "🦄", rarity: 8, weight: 3, label: "独角兽" },
    { emoji: "🐥", rarity: 9, weight: 1, label: "小鸭子" },
  ];
  let currentUser = null;
  let saveTimer = null;
  let saveInFlight = false;
  let pendingSave = false;
  let shellReady = false;
  let bootEl = null;
  let authEl = null;
  let accountEl = null;
  let originalRenderAll = null;
  let adminUsers = [];
  let adminSelectedUserId = null;
  let adminDetailCache = new Map();
  let adminRefreshTimer = null;
  let mySubmissions = [];
  let settingsEl = null;
  let lastTotalXp = 0;
  let lastStampCelebrationKey = null;
  let submissionRefreshTimer = null;

  function localDateKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function formatDateTime(value) {
    if (!value) return "—";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return escapeHtml(value);
    return parsed.toLocaleString("zh-CN", { hour12: false });
  }

  function defaultState() {
    return { totalXp: 0, streak: 0, lastDate: null, history: {} };
  }

  function defaultDay() {
    return {
      segments: [],
      tasks: { correction: false, difficulty: false, review: false },
      journal: { top: "", stuck: "", feel: "", difficulty: 0, focus: 0, effort: 0 },
      mood: 0,
      energy: 0,
      xpEarned: 0,
      rewardShown: false,
    };
  }

  function clampInt(value, minimum, maximum, fallback = 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) return fallback;
    return Math.max(minimum, Math.min(maximum, parsed));
  }

  function normalizeDay(raw) {
    const base = defaultDay();
    if (!raw || typeof raw !== "object") return base;

    if (Array.isArray(raw.segments)) {
      base.segments = raw.segments
        .map((item) => {
          const start = clampInt(item?.s, 0, 180, 0);
          const end = clampInt(item?.e, 0, 180, 0);
          return start < end ? { s: start, e: end } : null;
        })
        .filter(Boolean);
    }

    if (raw.tasks && typeof raw.tasks === "object") {
      Object.keys(base.tasks).forEach((key) => {
        base.tasks[key] = Boolean(raw.tasks[key]);
      });
    }

    if (raw.journal && typeof raw.journal === "object") {
      ["top", "stuck", "feel"].forEach((key) => {
        base.journal[key] = typeof raw.journal[key] === "string" ? raw.journal[key] : "";
      });
      ["difficulty", "focus", "effort"].forEach((key) => {
        base.journal[key] = clampInt(raw.journal[key], 0, 5, 0);
      });
    }

    base.mood = clampInt(raw.mood, 0, 5, 0);
    base.energy = clampInt(raw.energy, 0, 5, 0);
    base.xpEarned = clampInt(raw.xpEarned, 0, 100000, 0);
    base.rewardShown = Boolean(raw.rewardShown);
    return base;
  }

  function normalizeState(raw) {
    const base = defaultState();
    if (!raw || typeof raw !== "object") return base;
    base.streak = clampInt(raw.streak, 0, 36500, 0);
    base.lastDate = typeof raw.lastDate === "string" ? raw.lastDate : null;
    if (raw.history && typeof raw.history === "object") {
      Object.entries(raw.history).forEach(([dateKey, day]) => {
        if (typeof dateKey === "string") {
          base.history[dateKey] = normalizeDay(day);
        }
      });
    }
    base.totalXp = Object.values(base.history).reduce((sum, day) => sum + (day.xpEarned || 0), 0);
    return base;
  }

  function sumApprovedMinutes(day) {
    return (day?.segments || []).reduce((sum, segment) => sum + (segment.e - segment.s), 0);
  }

  function computeStudyXp(minutes) {
    if (minutes <= 0) return 0;
    return Math.round(14 * (Math.exp(minutes / 95) - 1));
  }

  function computeDayProgress(day) {
    const approvedMinutes = sumApprovedMinutes(day);
    if (approvedMinutes <= 0) {
      return { xp: 0, allDone: false, studyMins: 0, overAchieved: false };
    }
    let xp = computeStudyXp(approvedMinutes);
    if (day.tasks?.correction) xp += XP_VAL.correction;
    if (day.tasks?.difficulty) xp += XP_VAL.difficulty;
    if (day.tasks?.review) xp += XP_VAL.review;
    const journalCount = [day.journal?.top, day.journal?.stuck, day.journal?.feel].filter((value) => (value || "").trim()).length;
    if (journalCount >= 1) xp += XP_VAL.journal;
    const allDone = approvedMinutes >= DAILY_GOAL_MINUTES && day.tasks?.correction && day.tasks?.difficulty && day.tasks?.review;
    if (allDone) xp += XP_VAL.allDone;
    xp += Number(day.checkin?.comboBonusXp || 0);
    return { xp, allDone, studyMins: approvedMinutes, overAchieved: approvedMinutes > DAILY_GOAL_MINUTES };
  }

  function pickStampAnimal() {
    const totalWeight = STAMP_POOL.reduce((sum, item) => sum + item.weight, 0);
    let roll = Math.random() * totalWeight;
    for (const item of STAMP_POOL) {
      roll -= item.weight;
      if (roll <= 0) return item;
    }
    return STAMP_POOL[STAMP_POOL.length - 1];
  }

  function ensureCheckin(day) {
    if (!day.checkin || typeof day.checkin !== "object") {
      day.checkin = { stamped: false, emoji: "", rarity: 0, stampedAt: null };
    }
    return day.checkin;
  }

  function playStampSound() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const context = new AudioCtx();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(90, context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(45, context.currentTime + 0.18);
    gain.gain.setValueAtTime(0.001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.35, context.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.22);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.25);
    window.setTimeout(() => {
      void context.close();
    }, 300);
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("读取凭证失败"));
      reader.readAsDataURL(file);
    });
  }

  function rebuildStudySection() {
    const studySection = document.querySelector("#pane-today .section");
    if (!studySection) return;
    studySection.innerHTML = `
      <div class="section-title">⏱ 学习圆环</div>
      <div class="mq-ring-layout">
        <div class="mq-ring-shell">
          <svg class="mq-ring-svg" viewBox="0 0 180 180" aria-hidden="true">
            <circle class="mq-ring-track" cx="90" cy="90" r="72"></circle>
            <circle id="mq-ring-fill" class="mq-ring-fill" cx="90" cy="90" r="72"></circle>
          </svg>
          <div class="mq-ring-center">
            <div class="study-total" id="study-total-disp">0m</div>
            <div class="mq-ring-state" id="mq-ring-state">今日目标 120 分钟</div>
            <div class="mq-ring-badge mq-hidden" id="mq-ring-badge">超额完成</div>
          </div>
        </div>
        <div class="mq-study-stats">
          <div class="mq-study-stat-card"><strong id="mq-approved-mins">0</strong><span>已被认可的分钟</span></div>
          <div class="mq-study-stat-card"><strong id="mq-pending-count">0</strong><span>小和查看中</span></div>
          <div class="mq-study-stat-card"><strong id="mq-study-xp">0</strong><span>时长 XP</span></div>
        </div>
      </div>

      <div class="mq-upload-panel">
        <div class="mq-upload-title">上传本次学习凭证</div>
        <div class="mq-upload-grid">
          <label>学习时长（分钟）<input id="mq-session-minutes" type="number" min="1" max="720" placeholder="例如 45"></label>
          <label>学习日期<input id="mq-session-date" type="date"></label>
        </div>
        <label>补充说明<textarea id="mq-session-note" rows="2" placeholder="写一句这次学了什么，或者给小和留一句话"></textarea></label>
        <label>上传凭证<input id="mq-session-evidence" type="file" accept="image/*,.pdf" /></label>
        <div class="mq-upload-actions">
          <button type="button" class="btn btn-gold" id="mq-submit-session">送出证明</button>
          <div class="mq-upload-help">每次学习记录都需要附上凭证。等小和点头之后，它才会计入圆环、XP 和每日时长状态。</div>
        </div>
      </div>

      <div id="mq-session-status" class="mq-session-status"></div>
      <div id="mq-submission-list" class="mq-submission-list"></div>

      <div id="study-pct" class="mq-hidden"></div>
      <div class="bar-fill hp mq-hidden" id="study-bar"></div>
      <div class="timeline mq-hidden" id="timeline"></div>
      <div class="seg-chips mq-hidden" id="seg-chips"></div>
    `;

    document.getElementById("mq-session-date").value = localDateKey();
    document.getElementById("mq-submit-session").addEventListener("click", () => {
      void submitStudyProof();
    });
    renderStampLegend();
  }

  function renderStampLegend() {
    const legendEl = document.getElementById("mq-checkin-rarity");
    if (!legendEl) return;
    legendEl.innerHTML = STAMP_POOL.slice()
      .sort((left, right) => right.rarity - left.rarity)
      .map(
        (item) => `<span class="mq-stamp-legend-item ${item.rarity === 9 ? "top" : ""}">${item.emoji}<small>${escapeHtml(item.label)}</small></span>`,
      )
      .join("");
  }

  async function api(path, options = {}) {
    const request = { credentials: "same-origin", ...options };
    const headers = new Headers(request.headers || {});
    if (request.body && typeof request.body !== "string" && !(request.body instanceof FormData)) {
      headers.set("Content-Type", "application/json");
      request.body = JSON.stringify(request.body);
    }
    request.headers = headers;

    const response = await fetch(path, request);
    const contentType = response.headers.get("Content-Type") || "";
    const payload = contentType.includes("application/json") ? await response.json() : await response.text();
    if (!response.ok) {
      const error = new Error(typeof payload === "string" ? payload : payload.error || "请求失败");
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  function isAdmin() {
    return Boolean(currentUser && currentUser.is_admin);
  }

  function ensureShell() {
    if (shellReady) return;

    document.body.insertAdjacentHTML(
      "afterbegin",
      `
      <div id="mq-boot" class="mq-overlay">
        <div class="mq-card">
          <div class="mq-card-title mq-logo-title">MATH<br><span>QUEST</span> ⚔️</div>
          <div class="mq-card-subtitle" id="mq-boot-text">正在连接服务器...</div>
        </div>
      </div>
      <div id="mq-auth" class="mq-overlay mq-hidden">
        <div class="mq-card">
          <div class="mq-card-title mq-logo-title">MATH<br><span>QUEST</span> ⚔️</div>
          <div class="mq-card-kicker">账号存档</div>
          <div class="mq-card-subtitle">登录后，学习记录会和账号绑定。小和也能从观察台里看到大家的成长进度。</div>
          <div class="mq-auth-switch">
            <button type="button" id="mq-auth-tab-login" class="active">登录</button>
            <button type="button" id="mq-auth-tab-register">注册</button>
          </div>
          <div id="mq-auth-error" class="mq-auth-error"></div>
          <form id="mq-login-form" class="mq-auth-form">
            <label>用户名<input id="mq-login-username" name="username" autocomplete="username" required></label>
            <label>密码<input id="mq-login-password" name="password" type="password" autocomplete="current-password" required></label>
            <div class="mq-auth-actions">
              <span class="mq-account-sub">登录后即可同步学习存档和小和的查看进度</span>
              <button type="submit" class="mq-auth-submit">登录</button>
            </div>
          </form>
          <form id="mq-register-form" class="mq-auth-form mq-hidden">
            <label>用户名<input id="mq-register-username" name="username" autocomplete="username" required></label>
            <label>昵称<input id="mq-register-display-name" name="display_name" autocomplete="nickname" required></label>
            <label>密码<input id="mq-register-password" name="password" type="password" autocomplete="new-password" required></label>
            <div class="mq-auth-actions">
              <span class="mq-account-sub">用户名仅允许字母、数字、下划线和减号</span>
              <button type="submit" class="mq-auth-submit">注册并登录</button>
            </div>
          </form>
        </div>
      </div>
      `,
    );

    const header = document.querySelector(".header");
    header.insertAdjacentHTML(
      "afterend",
      `
      <div id="mq-account" class="mq-account-bar mq-hidden">
        <div class="mq-account-meta">
          <div class="mq-account-name" id="mq-account-name"></div>
          <div class="mq-account-sub" id="mq-account-sub"></div>
        </div>
        <div class="mq-account-actions">
          <span id="mq-role-pill" class="mq-pill"></span>
          <span id="mq-sync-pill" class="mq-pill">未同步</span>
          <button type="button" id="mq-settings-btn" class="mq-mini-btn">账号设置</button>
          <button type="button" id="mq-logout-btn" class="mq-mini-btn">退出登录</button>
        </div>
      </div>
      `,
    );

    const heroCard = document.querySelector(".hero-card");
    heroCard.insertAdjacentHTML(
      "afterend",
      `
      <div id="mq-checkin-card" class="section mq-checkin-section">
        <div class="section-title">📅 每日签到</div>
        <div class="mq-checkin-head">
          <div>
            <div class="mq-checkin-title">印章月历</div>
            <div class="mq-checkin-sub">完成今日清单后会自动盖章。下方圆点会告诉你时长状态，绿色是达标，金色是超额闪光。</div>
          </div>
          <div class="mq-checkin-rarity" id="mq-checkin-rarity"></div>
        </div>
        <div id="mq-checkin-calendar" class="mq-checkin-calendar"></div>
      </div>
      `,
    );

    const tabs = document.querySelector(".tabs");
    tabs.querySelectorAll(".tab").forEach((button) => {
      const onclick = button.getAttribute("onclick") || "";
      const match = onclick.match(/switchTab\('(.+?)'\)/);
      if (match) button.dataset.tab = match[1];
    });
    tabs.insertAdjacentHTML(
      "beforeend",
      `<button id="mq-admin-tab" class="tab mq-hidden" data-tab="admin" onclick="switchTab('admin')">🛡 管理</button>`,
    );

    const reportPane = document.getElementById("pane-report");
    reportPane.insertAdjacentHTML(
      "afterend",
      `
      <div id="pane-admin" class="pane" style="display:none">
        <div class="section">
          <div class="section-title">🛡 小和观察台</div>
          <div class="mq-admin-toolbar">
            <div>
              <div class="mq-admin-toolbar-title">小勇者状态巡航</div>
              <div id="mq-admin-status" class="mq-admin-toolbar-sub">准备打开大家的成长小宇宙...</div>
            </div>
            <button type="button" id="mq-admin-refresh" class="btn btn-teal">立即刷新</button>
          </div>
          <div id="mq-admin-summary" class="mq-admin-summary"></div>
          <div id="mq-admin-tabs" class="mq-admin-tabs"></div>
          <div id="mq-admin-dashboard"></div>
        </div>
      </div>
      `,
    );

    document.body.insertAdjacentHTML(
      "beforeend",
      `
      <div id="mq-settings" class="mq-overlay mq-hidden">
        <div class="mq-card">
          <div class="mq-card-title mq-logo-title">MATH<br><span>QUEST</span> ⚔️</div>
          <div class="mq-card-kicker">账号设置</div>
          <div class="mq-card-subtitle">可以改成更喜欢的名字，也可以顺手把密码换掉。</div>
          <div id="mq-settings-error" class="mq-auth-error"></div>
          <form id="mq-settings-form" class="mq-auth-form">
            <label>显示名称<input id="mq-settings-display-name" autocomplete="nickname"></label>
            <label>当前密码<input id="mq-settings-current-password" type="password" autocomplete="current-password"></label>
            <label>新密码<input id="mq-settings-new-password" type="password" autocomplete="new-password"></label>
            <div class="mq-auth-actions">
              <button type="button" id="mq-settings-cancel" class="mq-mini-btn">取消</button>
              <button type="submit" class="mq-auth-submit">保存设置</button>
            </div>
          </form>
        </div>
      </div>
      `,
    );

    bootEl = document.getElementById("mq-boot");
    authEl = document.getElementById("mq-auth");
    accountEl = document.getElementById("mq-account");
    settingsEl = document.getElementById("mq-settings");

    rebuildStudySection();

    document.getElementById("mq-auth-tab-login").addEventListener("click", () => setAuthMode("login"));
    document.getElementById("mq-auth-tab-register").addEventListener("click", () => setAuthMode("register"));
    document.getElementById("mq-login-form").addEventListener("submit", handleLogin);
    document.getElementById("mq-register-form").addEventListener("submit", handleRegister);
    document.getElementById("mq-settings-btn").addEventListener("click", openSettings);
    document.getElementById("mq-logout-btn").addEventListener("click", handleLogout);
    document.getElementById("mq-settings-cancel").addEventListener("click", closeSettings);
    document.getElementById("mq-settings-form").addEventListener("submit", handleSettingsSave);
    document.getElementById("mq-admin-refresh").addEventListener("click", () => {
      void refreshAdminOverview();
    });
    document.getElementById("mq-admin-tabs").addEventListener("click", (event) => {
      const tab = event.target.closest("[data-admin-user-id]");
      if (!tab) return;
      const userId = Number.parseInt(tab.dataset.adminUserId || "", 10);
      if (Number.isNaN(userId) || userId === adminSelectedUserId) return;
      adminSelectedUserId = userId;
      renderAdminTabs();
      void loadAdminUserDashboard(userId, false);
    });
    document.getElementById("mq-admin-dashboard").addEventListener("click", (event) => {
      const actionBtn = event.target.closest("[data-review-action]");
      if (!actionBtn) return;
      const submissionId = Number.parseInt(actionBtn.dataset.submissionId || "", 10);
      const action = actionBtn.dataset.reviewAction;
      if (!submissionId || !action) return;
      const noteInput = document.getElementById(`mq-review-note-${submissionId}`);
      const admin_note = noteInput ? noteInput.value.trim() : "";
      void reviewSubmission(submissionId, action, admin_note);
    });

    originalRenderAll = renderAll;
    calcDayXp = computeDayProgress;
    renderAll = function () {
      originalRenderAll();
      renderStudyExperience();
      renderSubmissionQueue();
      renderCheckinCalendar();
      maybeAutoCheckin();
      syncUserChrome();
    };

    switchTab = function (name) {
      document.querySelectorAll(".pane").forEach((pane) => {
        pane.style.display = "none";
      });
      document.querySelectorAll(".tab").forEach((tab) => {
        tab.classList.remove("active");
      });
      const pane = document.getElementById(`pane-${name}`);
      if (pane) pane.style.display = "block";
      const activeTab = document.querySelector(`.tab[data-tab="${name}"]`);
      if (activeTab) activeTab.classList.add("active");
      setAdminAutoRefresh(name === "admin");
      if (name === "status" || name === "history" || name === "report") {
        renderAll();
      }
      if (name === "admin") {
        void refreshAdminOverview();
      }
    };

    todayKey = function () {
      return localDateKey();
    };

    save = function (nextState) {
      state = normalizeState(nextState);
      if (!currentUser) return;
      updateSyncPill("同步中...", false);
      clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        void persistState();
      }, SAVE_DELAY);
    };

    shellReady = true;
  }

  function setAuthMode(mode) {
    document.getElementById("mq-auth-tab-login").classList.toggle("active", mode === "login");
    document.getElementById("mq-auth-tab-register").classList.toggle("active", mode === "register");
    document.getElementById("mq-login-form").classList.toggle("mq-hidden", mode !== "login");
    document.getElementById("mq-register-form").classList.toggle("mq-hidden", mode !== "register");
    document.getElementById("mq-auth-error").textContent = "";
  }

  function showBoot(text) {
    bootEl.classList.remove("mq-hidden");
    document.getElementById("mq-boot-text").textContent = text;
  }

  function hideBoot() {
    bootEl.classList.add("mq-hidden");
  }

  function showAuth(message = "") {
    document.body.classList.remove("mq-ready");
    authEl.classList.remove("mq-hidden");
    closeSettings();
    setSubmissionAutoRefresh(false);
    hideBoot();
    document.getElementById("mq-auth-error").textContent = message;
  }

  function hideAuth() {
    authEl.classList.add("mq-hidden");
    document.getElementById("mq-auth-error").textContent = "";
  }

  function openSettings() {
    if (!currentUser) return;
    document.getElementById("mq-settings-display-name").value = currentUser.display_name || "";
    document.getElementById("mq-settings-current-password").value = "";
    document.getElementById("mq-settings-new-password").value = "";
    document.getElementById("mq-settings-error").textContent = "";
    settingsEl.classList.remove("mq-hidden");
  }

  function closeSettings() {
    settingsEl.classList.add("mq-hidden");
    document.getElementById("mq-settings-error").textContent = "";
  }

  function updateSyncPill(text, isError) {
    const pill = document.getElementById("mq-sync-pill");
    pill.textContent = text;
    pill.classList.toggle("error", Boolean(isError));
  }

  function syncUserChrome() {
    const heroName = document.querySelector(".hero-name");
    if (!currentUser) {
      if (heroName) heroName.textContent = "MATH WARRIOR";
      accountEl.classList.add("mq-hidden");
      document.getElementById("mq-admin-tab").classList.add("mq-hidden");
      setAdminAutoRefresh(false);
      return;
    }

    if (heroName) heroName.textContent = currentUser.display_name;
    accountEl.classList.remove("mq-hidden");
    document.getElementById("mq-account-name").textContent = currentUser.display_name;
    document.getElementById("mq-account-sub").textContent = `@${currentUser.username} · 创建于 ${formatDateTime(currentUser.created_at)}`;
    document.getElementById("mq-role-pill").textContent = currentUser.is_admin ? "小和" : "小勇者";
    document.getElementById("mq-role-pill").classList.toggle("admin", Boolean(currentUser.is_admin));
    document.getElementById("mq-admin-tab").classList.toggle("mq-hidden", !currentUser.is_admin);
  }

  async function persistState() {
    if (!currentUser) return;
    if (saveInFlight) {
      pendingSave = true;
      return;
    }

    saveInFlight = true;
    clearTimeout(saveTimer);
    try {
      const data = await api("/api/state", { method: "PUT", body: { state } });
      state = normalizeState(data.state);
      updateSyncPill("已同步", false);
    } catch (error) {
      if (error.status === 401) {
        currentUser = null;
        state = defaultState();
        syncUserChrome();
        showAuth("登录已失效，请重新登录");
        return;
      }
      updateSyncPill("同步失败", true);
    } finally {
      saveInFlight = false;
      if (pendingSave) {
        pendingSave = false;
        void persistState();
      }
    }
  }

  async function loadStudyBundle() {
    const [stateData, submissionData] = await Promise.all([api("/api/state"), api("/api/submissions/mine")]);
    state = normalizeState(stateData.state);
    mySubmissions = Array.isArray(submissionData.submissions) ? submissionData.submissions : [];
  }

  async function finishSession(user, toastMessage) {
    currentUser = user;
    syncUserChrome();
    showBoot("正在加载任务数据...");
    try {
      await loadStudyBundle();
      setSubmissionAutoRefresh(true);
      document.body.classList.add("mq-ready");
      hideAuth();
      renderAll();
      updateSyncPill("已同步", false);
      hideBoot();
      if (toastMessage) showToast(toastMessage);
    } catch (error) {
      showAuth(error.payload?.error || "读取数据失败");
    }
  }

  async function handleLogin(event) {
    event.preventDefault();
    const username = document.getElementById("mq-login-username").value.trim();
    const password = document.getElementById("mq-login-password").value;
    try {
      showBoot("正在登录...");
      const data = await api("/api/auth/login", { method: "POST", body: { username, password } });
      await finishSession(data.user, "登录成功");
    } catch (error) {
      showAuth(error.payload?.error || "登录失败");
    }
  }

  async function handleRegister(event) {
    event.preventDefault();
    const username = document.getElementById("mq-register-username").value.trim();
    const display_name = document.getElementById("mq-register-display-name").value.trim();
    const password = document.getElementById("mq-register-password").value;
    try {
      showBoot("正在注册...");
      const data = await api("/api/auth/register", {
        method: "POST",
        body: { username, display_name, password },
      });
      await finishSession(data.user, "注册成功");
    } catch (error) {
      showAuth(error.payload?.error || "注册失败");
    }
  }

  async function handleLogout() {
    clearTimeout(saveTimer);
    try {
      if (currentUser) {
        await persistState();
      }
    } catch (_error) {
      // Ignore save errors on logout and continue clearing the session.
    }

    try {
      await api("/api/auth/logout", { method: "POST" });
    } catch (_error) {
      // Best-effort logout.
    }

    currentUser = null;
    state = defaultState();
    adminUsers = [];
    adminSelectedUserId = null;
    adminDetailCache.clear();
    mySubmissions = [];
    setSubmissionAutoRefresh(false);
    setAdminAutoRefresh(false);
    syncUserChrome();
    showAuth("已退出登录");
    setAuthMode("login");
  }

  async function handleSettingsSave(event) {
    event.preventDefault();
    const display_name = document.getElementById("mq-settings-display-name").value.trim();
    const current_password = document.getElementById("mq-settings-current-password").value;
    const new_password = document.getElementById("mq-settings-new-password").value;
    try {
      const data = await api("/api/me", {
        method: "PUT",
        body: { display_name, current_password, new_password },
      });
      currentUser = data.user;
      syncUserChrome();
      closeSettings();
      showToast("账号信息已更新");
    } catch (error) {
      document.getElementById("mq-settings-error").textContent = error.payload?.error || "保存失败";
    }
  }

  async function submitStudyProof() {
    const minutes = Number.parseInt(document.getElementById("mq-session-minutes").value || "", 10);
    const date_key = document.getElementById("mq-session-date").value || localDateKey();
    const note = document.getElementById("mq-session-note").value.trim();
    const file = document.getElementById("mq-session-evidence").files?.[0];
    const statusEl = document.getElementById("mq-session-status");
    if (!minutes || minutes < 1) {
      statusEl.innerHTML = `<div class="mq-progress-card error">请先填写有效的学习时长。</div>`;
      return;
    }
    if (!file) {
      statusEl.innerHTML = `<div class="mq-progress-card error">每次上传都需要附上凭证。</div>`;
      return;
    }

    statusEl.innerHTML = `
      <div class="mq-progress-card">
        <div class="mq-progress-title">上传中</div>
        <div class="mq-progress-steps">
          <span class="active">1 送出证明</span>
          <span>2 小和查看中</span>
          <span>3 注入圆环</span>
        </div>
      </div>
    `;

    try {
      const evidence_data = await fileToDataUrl(file);
      await api("/api/submissions", {
        method: "POST",
        body: {
          date_key,
          duration_minutes: minutes,
          note,
          evidence_data,
          evidence_name: file.name,
        },
      });
      document.getElementById("mq-session-minutes").value = "";
      document.getElementById("mq-session-note").value = "";
      document.getElementById("mq-session-evidence").value = "";
      await loadStudyBundle();
      renderAll();
      statusEl.innerHTML = `
        <div class="mq-progress-card success">
          <div class="mq-progress-title">小和已经收到啦</div>
          <div class="mq-progress-steps">
            <span class="done">1 送出证明</span>
            <span class="active">2 小和查看中</span>
            <span>3 注入圆环</span>
          </div>
        </div>
      `;
      showToast("凭证已经送到小和手上啦");
    } catch (error) {
      statusEl.innerHTML = `<div class="mq-progress-card error">${escapeHtml(error.payload?.error || error.message)}</div>`;
    }
  }

  function getSubmissionStatusLabel(status) {
    if (status === "approved") return "小和赞许了你的工作！";
    if (status === "rejected") return "小和想再看看补充证明";
    return "小和正在认真看";
  }

  function renderSubmissionQueue() {
    const listEl = document.getElementById("mq-submission-list");
    const statusEl = document.getElementById("mq-session-status");
    if (!listEl) return;

    const todayItems = mySubmissions.filter((item) => item.date_key === localDateKey());
    const pendingCount = mySubmissions.filter((item) => item.status === "pending").length;
    const latest = mySubmissions[0];
    if (!statusEl.innerHTML && latest) {
      statusEl.innerHTML = `
        <div class="mq-progress-card ${latest.status}">
          <div class="mq-progress-title">${getSubmissionStatusLabel(latest.status)}</div>
          <div class="mq-progress-steps">
            <span class="done">1 送出证明</span>
            <span class="${latest.status === "pending" ? "active" : "done"}">2 小和查看中</span>
            <span class="${latest.status === "approved" ? "active done" : ""}">3 注入圆环</span>
          </div>
        </div>
      `;
    }

    if (!mySubmissions.length) {
      listEl.innerHTML = `<div class="mq-admin-empty">今天先送出一条学习证明吧。等小和点头之后，圆环和月历就会一起亮起来。</div>`;
      document.getElementById("mq-pending-count").textContent = String(pendingCount);
      return;
    }

    listEl.innerHTML = `
      <div class="mq-submission-list-title">学习证明小队列</div>
      ${mySubmissions
        .slice(0, 8)
        .map(
          (item) => `
            <div class="mq-submission-card ${item.status}">
              <div class="mq-submission-top">
                <div>
                  <div class="mq-submission-minutes">${item.duration_minutes} 分钟</div>
                  <div class="mq-submission-meta">${escapeHtml(item.date_key)} · ${formatDateTime(item.created_at)}</div>
                </div>
                <span class="mq-submission-badge ${item.status}">${getSubmissionStatusLabel(item.status)}</span>
              </div>
              ${item.note ? `<div class="mq-submission-note">${escapeHtml(item.note)}</div>` : ""}
              <div class="mq-submission-actions">
                <a class="mq-mini-link" href="${item.evidence_url}" target="_blank" rel="noreferrer">查看凭证</a>
                ${item.admin_note ? `<span class="mq-submission-admin-note">小和留言：${escapeHtml(item.admin_note)}</span>` : ""}
              </div>
            </div>
          `,
        )
        .join("")}
    `;
    document.getElementById("mq-pending-count").textContent = String(pendingCount);
  }

  function triggerXpCelebration(amount) {
    if (!amount || amount <= 0) return;
    const bar = document.getElementById("xp-bar");
    if (!bar) return;
    const rect = bar.getBoundingClientRect();
    const count = Math.max(8, Math.min(32, Math.round(amount / 4)));
    for (let index = 0; index < count; index += 1) {
      const particle = document.createElement("div");
      particle.className = "mq-exp-particle";
      particle.textContent = "EXP";
      particle.style.left = `${rect.left + window.scrollX + Math.random() * rect.width}px`;
      particle.style.top = `${rect.top + window.scrollY + 36 + Math.random() * 70}px`;
      particle.style.animationDelay = `${index * 20}ms`;
      document.body.appendChild(particle);
      window.setTimeout(() => particle.remove(), 1600);
    }
    bar.classList.remove("mq-bar-burst");
    void bar.offsetWidth;
    bar.classList.add("mq-bar-burst");
  }

  spawnXpPopup = function (text) {
    const amount = Number.parseInt(String(text).replace(/[^\d]/g, ""), 10) || 0;
    triggerXpCelebration(amount);
  };

  function renderStudyExperience() {
    const day = getDay();
    const progress = computeDayProgress(day);
    const approvedMinutes = progress.studyMins;
    const pct = Math.min(100, (approvedMinutes / DAILY_GOAL_MINUTES) * 100);
    const ringFill = document.getElementById("mq-ring-fill");
    const ringState = document.getElementById("mq-ring-state");
    const ringBadge = document.getElementById("mq-ring-badge");
    const circumference = 2 * Math.PI * 72;
    const progressRatio = Math.min(1, pct / 100);
    ringFill.style.strokeDasharray = `${circumference}`;
    ringFill.style.strokeDashoffset = `${circumference * (1 - progressRatio)}`;
    ringFill.classList.toggle("gold", approvedMinutes > DAILY_GOAL_MINUTES);
    ringFill.classList.toggle("green", approvedMinutes >= DAILY_GOAL_MINUTES && approvedMinutes <= DAILY_GOAL_MINUTES);
    document.getElementById("mq-approved-mins").textContent = String(approvedMinutes);
    document.getElementById("mq-study-xp").textContent = String(computeStudyXp(approvedMinutes));
    if (approvedMinutes <= 0) {
      ringState.textContent = "小和点头之前，圆环还在静静等待";
      ringBadge.classList.add("mq-hidden");
    } else if (approvedMinutes > DAILY_GOAL_MINUTES) {
      ringState.textContent = `超额 ${approvedMinutes - DAILY_GOAL_MINUTES} 分钟`;
      ringBadge.classList.remove("mq-hidden");
    } else if (approvedMinutes >= DAILY_GOAL_MINUTES) {
      ringState.textContent = "今日时长目标完成";
      ringBadge.classList.add("mq-hidden");
    } else {
      ringState.textContent = `距离目标还差 ${DAILY_GOAL_MINUTES - approvedMinutes} 分钟`;
      ringBadge.classList.add("mq-hidden");
    }

    const currentTotalXp = state.totalXp || 0;
    if (currentTotalXp > lastTotalXp) {
      triggerXpCelebration(currentTotalXp - lastTotalXp);
    }
    lastTotalXp = currentTotalXp;
  }

  function renderCheckinCalendar() {
    const calendarEl = document.getElementById("mq-checkin-calendar");
    if (!calendarEl) return;
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const startWeekday = first.getDay() || 7;
    const days = [];
    for (let index = 1; index < startWeekday; index += 1) {
      days.push(`<div class="mq-calendar-cell ghost"></div>`);
    }

    for (let dayNumber = 1; dayNumber <= last.getDate(); dayNumber += 1) {
      const date = new Date(now.getFullYear(), now.getMonth(), dayNumber);
      const dateKey = localDateKey(date);
      const dayState = state.history?.[dateKey];
      const checkin = dayState ? ensureCheckin(dayState) : null;
      const approvedMinutes = dayState ? sumApprovedMinutes(dayState) : 0;
      const goalClass = approvedMinutes <= 0 ? "idle" : approvedMinutes > DAILY_GOAL_MINUTES ? "gold" : approvedMinutes >= DAILY_GOAL_MINUTES ? "green" : "red";
      const stamped = Boolean(checkin?.stamped);
      const stampEmoji = stamped ? checkin.emoji : "";
      const animateClass = lastStampCelebrationKey === dateKey ? "stamp" : "";
      days.push(`
        <div class="mq-calendar-cell ${dateKey === localDateKey() ? "today" : ""}">
          <div class="mq-calendar-day">${dayNumber}</div>
          <div class="mq-calendar-ring ${stamped ? goalClass : ""}">
            <div class="mq-calendar-stamp ${animateClass}">${escapeHtml(stampEmoji)}</div>
          </div>
        </div>
      `);
    }

    calendarEl.innerHTML = `
      <div class="mq-calendar-week">一</div>
      <div class="mq-calendar-week">二</div>
      <div class="mq-calendar-week">三</div>
      <div class="mq-calendar-week">四</div>
      <div class="mq-calendar-week">五</div>
      <div class="mq-calendar-week">六</div>
      <div class="mq-calendar-week">日</div>
      ${days.join("")}
    `;
    lastStampCelebrationKey = null;
  }

  function maybeAutoCheckin() {
    const day = getDay();
    const checkin = ensureCheckin(day);
    const tasksDone = Boolean(day.tasks?.correction && day.tasks?.difficulty && day.tasks?.review);
    if (!tasksDone || checkin.stamped) return;

    const stamp = pickStampAnimal();
    checkin.stamped = true;
    checkin.emoji = stamp.emoji;
    checkin.rarity = stamp.rarity;
    checkin.stampedAt = new Date().toISOString();

    let comboDays = 1;
    let cursor = new Date();
    cursor.setDate(cursor.getDate() - 1);
    while (true) {
      const previousKey = localDateKey(cursor);
      const previous = state.history?.[previousKey]?.checkin;
      if (!previous?.stamped || previous.emoji !== stamp.emoji) break;
      comboDays += 1;
      cursor.setDate(cursor.getDate() - 1);
    }
    checkin.comboDays = comboDays;
    checkin.comboBonusXp = comboDays > 1 ? 30 * stamp.rarity * 2 ** Math.max(0, comboDays - 2) : 0;
    lastStampCelebrationKey = localDateKey();
    playStampSound();
    renderCheckinCalendar();
    showToast(`${stamp.emoji} 今日签到成功，等小和点头后就能结算奖励`);
    save(state);
    originalRenderAll();
    renderStudyExperience();
    renderSubmissionQueue();
    renderCheckinCalendar();
    syncUserChrome();
  }

  function setAdminStatus(text) {
    const statusEl = document.getElementById("mq-admin-status");
    if (statusEl) statusEl.textContent = text;
  }

  function setSubmissionAutoRefresh(enabled) {
    if (submissionRefreshTimer) {
      window.clearInterval(submissionRefreshTimer);
      submissionRefreshTimer = null;
    }
    if (!enabled || !currentUser) return;
    submissionRefreshTimer = window.setInterval(async () => {
      if (!currentUser) return;
      try {
        await loadStudyBundle();
        renderAll();
      } catch (_error) {
        // Silent retry loop for review state sync.
      }
    }, 20000);
  }

  function setAdminAutoRefresh(enabled) {
    if (adminRefreshTimer) {
      window.clearInterval(adminRefreshTimer);
      adminRefreshTimer = null;
    }
    if (!enabled || !isAdmin()) return;
    adminRefreshTimer = window.setInterval(() => {
      void refreshAdminOverview(true);
    }, 30000);
  }

  function sumStudyMinutes(day) {
    return (day?.segments || []).reduce((sum, segment) => sum + (segment.e - segment.s), 0);
  }

  function countTasks(day) {
    return Object.values(day?.tasks || {}).filter(Boolean).length;
  }

  function countJournal(day) {
    const journal = day?.journal || {};
    return [journal.top, journal.stuck, journal.feel].filter((value) => (value || "").trim()).length;
  }

  function scorePercent(value, max) {
    if (!max) return 0;
    return Math.max(0, Math.min(100, Math.round((value / max) * 100)));
  }

  function getSortedHistoryKeys(userState) {
    return Object.keys(userState?.history || {}).sort((left, right) => right.localeCompare(left));
  }

  function getDefaultAdminUser(users) {
    return users.find((item) => !item.user?.is_admin) || users[0] || null;
  }

  function renderAdminSummary(users) {
    const summaryEl = document.getElementById("mq-admin-summary");
    if (!Array.isArray(users) || users.length === 0) {
      summaryEl.innerHTML = "";
      return;
    }

    const today = localDateKey();
    const totalXp = users.reduce((sum, item) => sum + (item.summary?.totalXp || 0), 0);
    const activeToday = users.filter((item) => item.summary?.lastActiveDate === today).length;
    const recordedUsers = users.filter((item) => (item.summary?.daysRecorded || 0) > 0).length;
    const averageXp = Math.round(totalXp / users.length);
    summaryEl.innerHTML = `
      <div class="mq-admin-card"><strong>${users.length}</strong><span>账号总数</span></div>
      <div class="mq-admin-card"><strong>${activeToday}</strong><span>今日活跃</span></div>
      <div class="mq-admin-card"><strong>${recordedUsers}</strong><span>留下脚印的小勇者</span></div>
      <div class="mq-admin-card"><strong>${averageXp}</strong><span>人均 XP</span></div>
    `;
  }

  function renderAdminTabs() {
    const tabsEl = document.getElementById("mq-admin-tabs");
    if (!Array.isArray(adminUsers) || adminUsers.length === 0) {
      tabsEl.innerHTML = `<div class="mq-admin-empty">还没有可以查看的小勇者。</div>`;
      return;
    }

    tabsEl.innerHTML = adminUsers
      .map((item) => {
        const user = item.user || {};
        const summary = item.summary || {};
        const pendingCount = item.pending_count || 0;
        const isActive = user.id === adminSelectedUserId;
        const activeLabel = summary.lastActiveDate === localDateKey() ? "今日有记录" : summary.lastActiveDate || "暂无记录";
        return `
          <button type="button" class="mq-admin-user-tab ${isActive ? "active" : ""}" data-admin-user-id="${user.id}">
            <span class="mq-admin-user-tab-top">
              <span class="mq-admin-user-tab-name">${escapeHtml(user.display_name || user.username || "未命名小勇者")}</span>
              <span class="mq-admin-user-tab-level">Lv.${summary.level?.level || 1}</span>
            </span>
            <span class="mq-admin-user-tab-sub">@${escapeHtml(user.username || "")}</span>
            <span class="mq-admin-user-tab-meta">XP ${summary.totalXp || 0} · ${escapeHtml(activeLabel)}${pendingCount ? ` · 待审 ${pendingCount}` : ""}</span>
          </button>
        `;
      })
      .join("");
  }

  function renderAdminMeters(items) {
    return items
      .map(
        (item) => `
          <div class="mq-admin-meter">
            <div class="mq-admin-meter-top">
              <span>${item.label}</span>
              <strong>${item.value}</strong>
            </div>
            <div class="mq-admin-meter-track">
              <div class="mq-admin-meter-fill ${item.tone || ""}" style="width:${item.percent}%"></div>
            </div>
          </div>
        `,
      )
      .join("");
  }

  function renderAdminDashboard(detail) {
    const dashboardEl = document.getElementById("mq-admin-dashboard");
    if (!detail) {
      dashboardEl.innerHTML = `<div class="mq-admin-empty">点开一个小勇者，就能看到 TA 的成长看板。</div>`;
      return;
    }

    const user = detail.user || {};
    const summary = detail.summary || {};
    const userState = normalizeState(detail.state || {});
    const historyKeys = getSortedHistoryKeys(userState);
    const today = localDateKey();
    const snapshotKey = historyKeys.includes(today) ? today : historyKeys[0] || null;
    const snapshotDay = snapshotKey ? normalizeDay(userState.history[snapshotKey]) : defaultDay();
    const studyMinutes = sumStudyMinutes(snapshotDay);
    const taskCount = countTasks(snapshotDay);
    const journalCount = countJournal(snapshotDay);
    const journal = snapshotDay.journal || {};
    const segmentSummary = (snapshotDay.segments || []).length
      ? snapshotDay.segments.map((segment) => `${fmt(segment.s)}→${fmt(segment.e)}`).join(" · ")
      : "暂无学习分段";
    const taskChips = [
      ["订正错题", snapshotDay.tasks?.correction],
      ["解决难点", snapshotDay.tasks?.difficulty],
      ["复习知识点", snapshotDay.tasks?.review],
    ]
      .map(
        ([label, done]) => `<span class="mq-admin-task-chip ${done ? "done" : ""}">${done ? "✓" : "○"} ${label}</span>`,
      )
      .join("");
    const recentDays = Array.isArray(summary.recentDays) ? summary.recentDays : [];
    const submissions = Array.isArray(detail.submissions) ? detail.submissions : [];
    const recentHtml = recentDays.length
      ? recentDays
          .map((day) => {
            const pct = scorePercent(day.studyMinutes || 0, 180);
            return `
              <div class="mq-admin-activity-row">
                <div class="mq-admin-activity-head">
                  <strong>${escapeHtml(day.date)}</strong>
                  <span>学习 ${day.studyMinutes || 0} 分钟 · XP +${day.xpEarned || 0}</span>
                </div>
                <div class="mq-admin-activity-bar">
                  <div class="mq-admin-activity-fill" style="width:${pct}%"></div>
                </div>
                <div class="mq-admin-activity-foot">支线 ${day.taskCount || 0}/3 · 心情 ${day.mood || 0}/5${day.top ? ` · ${escapeHtml(day.top)}` : ""}</div>
              </div>
            `;
          })
          .join("")
      : `<div class="mq-admin-empty">这位小勇者还没留下学习足迹。</div>`;
    const submissionHtml = submissions.length
      ? submissions
          .map(
            (item) => `
              <div class="mq-admin-review-card ${item.status}">
                <div class="mq-admin-review-top">
                  <div>
                    <strong>${item.duration_minutes} 分钟</strong>
                    <span>${escapeHtml(item.date_key)} · ${formatDateTime(item.created_at)}</span>
                  </div>
                  <span class="mq-submission-badge ${item.status}">${getSubmissionStatusLabel(item.status)}</span>
                </div>
                ${item.note ? `<div class="mq-admin-day-note">${escapeHtml(item.note)}</div>` : ""}
                <div class="mq-admin-review-actions">
                  <a class="mq-mini-link" href="${item.evidence_url}" target="_blank" rel="noreferrer">查看凭证</a>
                  ${
                    item.status === "pending"
                      ? `
                        <input id="mq-review-note-${item.id}" class="mq-admin-review-note" placeholder="给这位小勇者留一句话（可选）" />
                        <button type="button" class="mq-mini-btn" data-review-action="approve" data-submission-id="${item.id}">通过</button>
                        <button type="button" class="mq-mini-btn" data-review-action="reject" data-submission-id="${item.id}">再补一点</button>
                      `
                      : item.admin_note
                        ? `<span class="mq-submission-admin-note">小和留言：${escapeHtml(item.admin_note)}</span>`
                        : ""
                  }
                </div>
              </div>
            `,
          )
          .join("")
      : `<div class="mq-admin-empty">这位小勇者暂时还没送来学习证明。</div>`;

    dashboardEl.innerHTML = `
      <div class="mq-admin-hero">
        <div>
          <div class="mq-admin-hero-title">${escapeHtml(user.display_name || user.username || "未命名小勇者")}</div>
          <div class="mq-admin-hero-sub">@${escapeHtml(user.username || "")} · ${user.is_admin ? "小和主控台" : "小勇者档案"}</div>
        </div>
        <div class="mq-admin-hero-side">
          <span class="mq-pill ${user.is_admin ? "admin" : ""}">Lv.${summary.level?.level || 1} ${escapeHtml(summary.level?.name || "新手学徒")}</span>
          <span class="mq-pill">最近登录 ${formatDateTime(user.last_login_at)}</span>
        </div>
      </div>

      <div class="mq-admin-kpi-grid">
        <div class="mq-admin-kpi"><span>总 XP</span><strong>${summary.totalXp || 0}</strong></div>
        <div class="mq-admin-kpi"><span>连击天数</span><strong>${summary.streak || 0}</strong></div>
        <div class="mq-admin-kpi"><span>记录天数</span><strong>${summary.daysRecorded || 0}</strong></div>
        <div class="mq-admin-kpi"><span>最后活跃</span><strong>${escapeHtml(summary.lastActiveDate || "—")}</strong></div>
      </div>

      <div class="mq-admin-dashboard-grid">
        <div class="mq-admin-panel">
          <div class="mq-admin-panel-title">状态快照 ${snapshotKey ? `· ${escapeHtml(snapshotKey)}` : ""}</div>
          ${renderAdminMeters([
            { label: "学习进度", value: `${studyMinutes} / 180 分钟`, percent: scorePercent(studyMinutes, 180), tone: "gold" },
            { label: "支线完成", value: `${taskCount} / 3`, percent: scorePercent(taskCount, 3), tone: "teal" },
            { label: "日志完整度", value: `${journalCount} / 3`, percent: scorePercent(journalCount, 3), tone: "purple" },
            { label: "心情", value: `${snapshotDay.mood || 0} / 5`, percent: scorePercent(snapshotDay.mood || 0, 5), tone: "teal" },
            { label: "精力", value: `${snapshotDay.energy || 0} / 5`, percent: scorePercent(snapshotDay.energy || 0, 5), tone: "gold" },
            { label: "专注", value: `${journal.focus || 0} / 5`, percent: scorePercent(journal.focus || 0, 5), tone: "purple" },
          ])}
          <div class="mq-admin-task-row">${taskChips}</div>
          <div class="mq-admin-segments">学习分段：${escapeHtml(segmentSummary)}</div>
        </div>

        <div class="mq-admin-panel">
          <div class="mq-admin-panel-title">小勇者观察</div>
          <div class="mq-admin-note-block">
            <span>印象最深</span>
            <p>${escapeHtml(journal.top || "暂无记录")}</p>
          </div>
          <div class="mq-admin-note-block">
            <span>现在卡住的点</span>
            <p>${escapeHtml(journal.stuck || "暂无记录")}</p>
          </div>
          <div class="mq-admin-note-block">
            <span>主观感受</span>
            <p>${escapeHtml(journal.feel || "暂无记录")}</p>
          </div>
          <div class="mq-admin-note-grid">
            <div><span>难度感</span><strong>${journal.difficulty || 0}/5</strong></div>
            <div><span>努力值</span><strong>${journal.effort || 0}/5</strong></div>
          </div>
        </div>
      </div>

      <div class="mq-admin-panel">
        <div class="mq-admin-panel-title">最近 7 次成长波形</div>
        <div class="mq-admin-activity-list">${recentHtml}</div>
      </div>

      <div class="mq-admin-panel">
        <div class="mq-admin-panel-title">学习证明观察列</div>
        <div class="mq-admin-review-list">${submissionHtml}</div>
      </div>
    `;
  }

  async function reviewSubmission(submissionId, action, admin_note) {
    try {
      await api(`/api/admin/submissions/${submissionId}/review`, {
        method: "POST",
        body: { action, admin_note },
      });
      await refreshAdminOverview(true);
      showToast(action === "approve" ? "小和赞许了你的工作！" : "已经请对方再补一点证明啦");
    } catch (error) {
      setAdminStatus(`小和刚刚绊了一下 · ${escapeHtml(error.payload?.error || error.message)}`);
    }
  }

  async function loadAdminUserDashboard(userId, preferCache = true) {
    const dashboardEl = document.getElementById("mq-admin-dashboard");
    if (preferCache && adminDetailCache.has(userId)) {
      renderAdminDashboard(adminDetailCache.get(userId));
    } else {
      dashboardEl.innerHTML = `<div class="mq-admin-empty">正在展开这位小勇者的成长看板...</div>`;
    }

    try {
      const detail = await api(`/api/admin/users/${userId}`);
      adminDetailCache.set(userId, detail);
      if (adminSelectedUserId === userId) {
        renderAdminDashboard(detail);
      }
    } catch (error) {
      if (adminSelectedUserId === userId) {
        dashboardEl.innerHTML = `<div class="mq-admin-empty">这份成长看板打开失败了：${escapeHtml(error.payload?.error || error.message)}</div>`;
      }
    }
  }

  async function refreshAdminOverview(silent = false) {
    if (!isAdmin()) return;
    const summaryEl = document.getElementById("mq-admin-summary");
    const tabsEl = document.getElementById("mq-admin-tabs");
    const dashboardEl = document.getElementById("mq-admin-dashboard");
    if (!silent && !adminUsers.length) {
      summaryEl.innerHTML = `<div class="mq-admin-card"><strong>...</strong><span>加载中</span></div>`;
      tabsEl.innerHTML = `<div class="mq-admin-empty">正在召集小勇者名单...</div>`;
      dashboardEl.innerHTML = `<div class="mq-admin-empty">成长看板准备中...</div>`;
    }
    setAdminStatus(silent ? "小和正在后台悄悄同步大家的进度..." : "小和正在整理这张观察台...");
    try {
      const data = await api("/api/admin/users");
      adminUsers = (data.users || []).slice().sort((left, right) => (right.summary?.totalXp || 0) - (left.summary?.totalXp || 0));
      renderAdminSummary(adminUsers);
      if (!adminUsers.length) {
        tabsEl.innerHTML = `<div class="mq-admin-empty">还没有小勇者加入这里。</div>`;
        dashboardEl.innerHTML = `<div class="mq-admin-empty">等第一位小勇者出现，这里就会亮起来。</div>`;
        setAdminStatus("现在还没有可以查看的小勇者。");
        return;
      }

      const selectedStillExists = adminUsers.some((item) => item.user?.id === adminSelectedUserId);
      if (!selectedStillExists) {
        adminSelectedUserId = getDefaultAdminUser(adminUsers)?.user?.id || adminUsers[0].user?.id || null;
      }
      renderAdminTabs();
      await loadAdminUserDashboard(adminSelectedUserId, true);
      setAdminStatus(`已刷新 · ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`);
    } catch (error) {
      tabsEl.innerHTML = `<div class="mq-admin-empty">读取失败：${escapeHtml(error.payload?.error || error.message)}</div>`;
      dashboardEl.innerHTML = `<div class="mq-admin-empty">这张成长看板暂时还展开不了。</div>`;
      setAdminStatus(`小和这次没刷新成功 · ${escapeHtml(error.payload?.error || error.message)}`);
    }
  }

  async function boot() {
    ensureShell();
    setAuthMode("login");
    syncUserChrome();

    try {
      showBoot("正在检查登录状态...");
      const data = await api("/api/me");
      await finishSession(data.user);
    } catch (error) {
      if (error.status === 401) {
        showAuth("");
        return;
      }
      showAuth(error.payload?.error || "无法连接后端服务");
    }
  }

  void boot();
})();
