(function () {
  const SAVE_DELAY = 600;
  let currentUser = null;
  let saveTimer = null;
  let saveInFlight = false;
  let pendingSave = false;
  let shellReady = false;
  let bootEl = null;
  let authEl = null;
  let accountEl = null;
  let originalRenderAll = null;

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
          <div class="mq-card-subtitle">登录后，学习记录会和账号绑定。管理员账号可以查看所有人的情况。</div>
          <div class="mq-auth-switch">
            <button type="button" id="mq-auth-tab-login" class="active">登录</button>
            <button type="button" id="mq-auth-tab-register">注册</button>
          </div>
          <div id="mq-auth-error" class="mq-auth-error"></div>
          <form id="mq-login-form" class="mq-auth-form">
            <label>用户名<input id="mq-login-username" name="username" autocomplete="username" required></label>
            <label>密码<input id="mq-login-password" name="password" type="password" autocomplete="current-password" required></label>
            <div class="mq-auth-actions">
              <span class="mq-account-sub">默认管理员：<code>admin</code> / <code>admin123456</code></span>
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
          <button type="button" id="mq-logout-btn" class="mq-mini-btn">退出登录</button>
        </div>
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
          <div class="section-title">🛡 管理员总览</div>
          <div id="mq-admin-summary" class="mq-admin-summary"></div>
          <div class="btn-row" style="margin-bottom:10px">
            <button type="button" id="mq-admin-refresh" class="btn btn-teal">刷新列表</button>
          </div>
          <div id="mq-admin-users"></div>
        </div>
      </div>
      `,
    );

    bootEl = document.getElementById("mq-boot");
    authEl = document.getElementById("mq-auth");
    accountEl = document.getElementById("mq-account");

    document.getElementById("mq-auth-tab-login").addEventListener("click", () => setAuthMode("login"));
    document.getElementById("mq-auth-tab-register").addEventListener("click", () => setAuthMode("register"));
    document.getElementById("mq-login-form").addEventListener("submit", handleLogin);
    document.getElementById("mq-register-form").addEventListener("submit", handleRegister);
    document.getElementById("mq-logout-btn").addEventListener("click", handleLogout);
    document.getElementById("mq-admin-refresh").addEventListener("click", () => {
      void refreshAdminOverview();
    });

    originalRenderAll = renderAll;
    renderAll = function () {
      originalRenderAll();
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
    hideBoot();
    document.getElementById("mq-auth-error").textContent = message;
  }

  function hideAuth() {
    authEl.classList.add("mq-hidden");
    document.getElementById("mq-auth-error").textContent = "";
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
      return;
    }

    if (heroName) heroName.textContent = currentUser.display_name;
    accountEl.classList.remove("mq-hidden");
    document.getElementById("mq-account-name").textContent = currentUser.display_name;
    document.getElementById("mq-account-sub").textContent = `@${currentUser.username} · 创建于 ${formatDateTime(currentUser.created_at)}`;
    document.getElementById("mq-role-pill").textContent = currentUser.is_admin ? "管理员" : "普通用户";
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

  async function finishSession(user, toastMessage) {
    currentUser = user;
    syncUserChrome();
    showBoot("正在加载任务数据...");
    try {
      const data = await api("/api/state");
      state = normalizeState(data.state);
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
    syncUserChrome();
    showAuth("已退出登录");
    setAuthMode("login");
  }

  function renderAdminUsers(users) {
    const summaryEl = document.getElementById("mq-admin-summary");
    const usersEl = document.getElementById("mq-admin-users");
    if (!Array.isArray(users) || users.length === 0) {
      summaryEl.innerHTML = "";
      usersEl.innerHTML = `<div class="mq-admin-empty">暂无用户数据。</div>`;
      return;
    }

    const today = localDateKey();
    const totalXp = users.reduce((sum, item) => sum + (item.summary?.totalXp || 0), 0);
    const activeToday = users.filter((item) => item.summary?.lastActiveDate === today).length;
    summaryEl.innerHTML = `
      <div class="mq-admin-card"><strong>${users.length}</strong><span>账号总数</span></div>
      <div class="mq-admin-card"><strong>${activeToday}</strong><span>今日活跃</span></div>
      <div class="mq-admin-card"><strong>${totalXp}</strong><span>全站总 XP</span></div>
    `;

    usersEl.innerHTML = users
      .slice()
      .sort((left, right) => (right.summary?.totalXp || 0) - (left.summary?.totalXp || 0))
      .map((item) => {
        const user = item.user || {};
        const summary = item.summary || {};
        const recentDays = Array.isArray(item.recent_days) ? item.recent_days : [];
        const recentHtml = recentDays.length
          ? recentDays
              .map(
                (day) => `
                  <div class="mq-admin-day">
                    <strong>${escapeHtml(day.date)}</strong>
                    <small>学习 ${day.studyMinutes || 0} 分钟 · XP +${day.xpEarned || 0} · 支线 ${day.taskCount || 0}/3</small>
                    ${day.top ? `<div class="mq-admin-day-note">${escapeHtml(day.top)}</div>` : ""}
                  </div>
                `,
              )
              .join("")
          : `<div class="mq-admin-empty">暂无历史记录。</div>`;

        return `
          <div class="mq-admin-user">
            <div class="mq-admin-user-top">
              <div>
                <div class="mq-admin-user-name">${escapeHtml(user.display_name || user.username || "未命名用户")}</div>
                <div class="mq-admin-user-meta">@${escapeHtml(user.username || "")} · ${user.is_admin ? "管理员" : "普通用户"}</div>
              </div>
              <div class="mq-admin-user-meta">最近登录：${formatDateTime(user.last_login_at)}</div>
            </div>
            <div class="mq-admin-user-grid">
              <div>总 XP：${summary.totalXp || 0}</div>
              <div>等级：Lv.${summary.level?.level || 1}</div>
              <div>连击：${summary.streak || 0} 天</div>
              <div>记录天数：${summary.daysRecorded || 0}</div>
              <div>累计学习：${summary.totalMinutes || 0} 分钟</div>
              <div>最后活跃：${escapeHtml(summary.lastActiveDate || "—")}</div>
            </div>
            <div class="mq-admin-recent">${recentHtml}</div>
          </div>
        `;
      })
      .join("");
  }

  async function refreshAdminOverview() {
    if (!isAdmin()) return;
    const summaryEl = document.getElementById("mq-admin-summary");
    const usersEl = document.getElementById("mq-admin-users");
    summaryEl.innerHTML = `<div class="mq-admin-card"><strong>...</strong><span>加载中</span></div>`;
    usersEl.innerHTML = `<div class="mq-admin-empty">正在读取所有用户信息...</div>`;
    try {
      const data = await api("/api/admin/users");
      renderAdminUsers(data.users || []);
    } catch (error) {
      usersEl.innerHTML = `<div class="mq-admin-empty">读取失败：${escapeHtml(error.payload?.error || error.message)}</div>`;
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
