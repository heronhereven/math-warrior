(function () {
  const DAILY_GOAL_MINUTES = 120;
  const SAVE_DELAY = 600;
  const LEARNER_POLL_MS = 20000;
  const ADMIN_POLL_MS = 30000;
  const CIRCUMFERENCE = 2 * Math.PI * 52;
  const STAMP_POOL = [
    { emoji: "🐹", rarity: 1, label: "仓鼠" },
    { emoji: "🐰", rarity: 2, label: "兔兔" },
    { emoji: "🐱", rarity: 3, label: "小猫" },
    { emoji: "🐶", rarity: 4, label: "小狗" },
    { emoji: "🦊", rarity: 5, label: "狐狸" },
    { emoji: "🐼", rarity: 6, label: "熊猫" },
    { emoji: "🦁", rarity: 7, label: "狮子" },
    { emoji: "🦄", rarity: 8, label: "独角兽" },
    { emoji: "🐥", rarity: 9, label: "小鸭子" },
  ];
  const TASK_LABELS = {
    correction: { title: "订正错题", copy: "把今天绊脚的题一个个哄顺。" },
    difficulty: { title: "解决难点", copy: "把最卡的那一块掰开揉碎。" },
    review: { title: "复习知识点", copy: "让会做的东西别偷偷溜走。" },
  };
  const LEVEL_AVATARS = ["🍜", "🥢", "🍥", "🍤", "🧋", "✨", "🏆", "👑"];
  const LEVELS = [
    { level: 1, name: "新手学徒", xp: 0 },
    { level: 2, name: "初级探索者", xp: 100 },
    { level: 3, name: "数学战士", xp: 250 },
    { level: 4, name: "方程猎人", xp: 450 },
    { level: 5, name: "积分法师", xp: 700 },
    { level: 6, name: "极限骑士", xp: 1000 },
    { level: 7, name: "微积分大师", xp: 1400 },
    { level: 8, name: "数学传奇", xp: 1900 },
  ];

  const app = {
    user: null,
    state: defaultState(),
    submissions: [],
    adminUsers: [],
    adminDetailCache: new Map(),
    adminSelectedUserId: null,
    adminGroup: "pending",
    learnerView: "dashboard",
    calendarCursor: monthAnchor(),
    saveTimer: null,
    saveInFlight: false,
    pendingSave: false,
    checkinInFlight: false,
    pollTimer: null,
    lastTotalXp: 0,
    booted: false,
    latestStampDate: null,
    backendReachable: false,
  };

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
      checkin: { stamped: false, emoji: "", rarity: 0, label: "", stampedAt: null, comboBonusXp: 0, comboDays: 0, rewardXp: 0 },
      status: {
        goalMinutes: DAILY_GOAL_MINUTES,
        approvedMinutes: 0,
        pendingMinutes: 0,
        rejectedMinutes: 0,
        approvedCount: 0,
        pendingCount: 0,
        rejectedCount: 0,
        progressState: "locked",
        rewardState: "idle",
      },
    };
  }

  function clampInt(value, minimum, maximum, fallback = 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) return fallback;
    return Math.max(minimum, Math.min(maximum, parsed));
  }

  function localDateKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function monthAnchor(date = new Date()) {
    return new Date(date.getFullYear(), date.getMonth(), 1);
  }

  function parseDateKey(dateKey) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ""))) return null;
    const parsed = new Date(`${dateKey}T12:00:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  function formatDate(dateKey) {
    const parsed = parseDateKey(dateKey);
    if (!parsed) return dateKey || "—";
    return parsed.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "short" });
  }

  function formatDateTime(value) {
    if (!value) return "—";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return String(value);
    return parsed.toLocaleString("zh-CN", { hour12: false });
  }

  function formatMinutes(minutes) {
    const safe = clampInt(minutes, 0, 10000, 0);
    const hours = Math.floor(safe / 60);
    const mins = safe % 60;
    if (!hours) return `${mins} 分钟`;
    if (!mins) return `${hours} 小时`;
    return `${hours} 小时 ${mins} 分`;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function normalizeCheckin(raw) {
    const base = defaultDay().checkin;
    if (!raw || typeof raw !== "object") return { ...base };
    return {
      stamped: Boolean(raw.stamped),
      emoji: typeof raw.emoji === "string" ? raw.emoji : "",
      rarity: clampInt(raw.rarity, 0, 10, 0),
      label: typeof raw.label === "string" ? raw.label : "",
      stampedAt: typeof raw.stampedAt === "string" ? raw.stampedAt : null,
      comboBonusXp: clampInt(raw.comboBonusXp, 0, 200000, 0),
      comboDays: clampInt(raw.comboDays, 0, 365, 0),
      rewardXp: clampInt(raw.rewardXp, 0, 200000, 0),
    };
  }

  function normalizeStatus(raw) {
    const base = defaultDay().status;
    if (!raw || typeof raw !== "object") return { ...base };
    return {
      goalMinutes: clampInt(raw.goalMinutes, 1, 720, DAILY_GOAL_MINUTES),
      approvedMinutes: clampInt(raw.approvedMinutes, 0, 720, 0),
      pendingMinutes: clampInt(raw.pendingMinutes, 0, 720, 0),
      rejectedMinutes: clampInt(raw.rejectedMinutes, 0, 720, 0),
      approvedCount: clampInt(raw.approvedCount, 0, 1000, 0),
      pendingCount: clampInt(raw.pendingCount, 0, 1000, 0),
      rejectedCount: clampInt(raw.rejectedCount, 0, 1000, 0),
      progressState: typeof raw.progressState === "string" ? raw.progressState : "locked",
      rewardState: typeof raw.rewardState === "string" ? raw.rewardState : "idle",
    };
  }

  function normalizeDay(raw) {
    const base = defaultDay();
    if (!raw || typeof raw !== "object") return base;
    if (Array.isArray(raw.segments)) {
      base.segments = raw.segments
        .map((item) => {
          const start = clampInt(item?.s, 0, 720, 0);
          const end = clampInt(item?.e, 0, 720, 0);
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
    base.xpEarned = clampInt(raw.xpEarned, 0, 10000000, 0);
    base.rewardShown = Boolean(raw.rewardShown);
    base.checkin = normalizeCheckin(raw.checkin);
    base.status = normalizeStatus(raw.status);
    return base;
  }

  function normalizeState(raw) {
    const base = defaultState();
    if (!raw || typeof raw !== "object") return base;
    base.totalXp = clampInt(raw.totalXp, 0, 10000000, 0);
    base.streak = clampInt(raw.streak, 0, 36500, 0);
    base.lastDate = typeof raw.lastDate === "string" ? raw.lastDate : null;
    if (raw.history && typeof raw.history === "object") {
      Object.entries(raw.history).forEach(([dateKey, day]) => {
        base.history[dateKey] = normalizeDay(day);
      });
    }
    return base;
  }

  function editableStatePayload() {
    const history = {};
    Object.entries(app.state.history || {}).forEach(([dateKey, day]) => {
      history[dateKey] = {
        tasks: { ...day.tasks },
        journal: { ...day.journal },
        mood: day.mood,
        energy: day.energy,
        rewardShown: Boolean(day.rewardShown),
      };
    });
    return { history };
  }

  function getLevelInfo(totalXp) {
    let current = LEVELS[0];
    for (const level of LEVELS) {
      if (totalXp >= level.xp) current = level;
    }
    const index = LEVELS.findIndex((item) => item.level === current.level);
    const next = LEVELS[index + 1] || null;
    return { current, next, index };
  }

  function currentDayKey() {
    return localDateKey();
  }

  function ensureDay(dateKey = currentDayKey()) {
    if (!app.state.history[dateKey]) {
      app.state.history[dateKey] = defaultDay();
    } else {
      app.state.history[dateKey] = normalizeDay(app.state.history[dateKey]);
    }
    return app.state.history[dateKey];
  }

  function approvedMinutes(day) {
    return clampInt(day?.status?.approvedMinutes, 0, 720, 0);
  }

  function pendingMinutes(day) {
    return clampInt(day?.status?.pendingMinutes, 0, 720, 0);
  }

  function countDoneTasks(day) {
    return Object.values(day?.tasks || {}).filter(Boolean).length;
  }

  function journalCount(day) {
    const journal = day?.journal || {};
    return [journal.top, journal.stuck, journal.feel].filter((item) => String(item || "").trim()).length;
  }

  function isAllTasksDone(day) {
    return countDoneTasks(day) === 3;
  }

  function api(path, options = {}) {
    const request = { credentials: "same-origin", ...options };
    const headers = new Headers(request.headers || {});
    if (request.body && typeof request.body !== "string" && !(request.body instanceof FormData)) {
      headers.set("Content-Type", "application/json");
      request.body = JSON.stringify(request.body);
    }
    request.headers = headers;
    return fetch(path, request).then(async (response) => {
      const contentType = response.headers.get("Content-Type") || "";
      const payload = contentType.includes("application/json") ? await response.json() : await response.text();
      if (!response.ok) {
        const error = new Error(typeof payload === "string" ? payload : payload.error || "请求失败");
        error.status = response.status;
        error.payload = payload;
        throw error;
      }
      return payload;
    });
  }

  function explainError(error, fallback) {
    if (error?.payload?.error) return error.payload.error;
    if (error?.status == null) {
      return "现在打开的是静态页面，注册和登录都需要后端服务。请先运行 python server.py，再打开 http://127.0.0.1:8000。";
    }
    return fallback;
  }

  function setAuthMode(mode) {
    document.querySelectorAll("[data-auth-mode]").forEach((button) => {
      button.classList.toggle("active", button.dataset.authMode === mode);
    });
    document.getElementById("login-form").classList.toggle("mq-hidden", mode !== "login");
    document.getElementById("register-form").classList.toggle("mq-hidden", mode !== "register");
    document.getElementById("auth-error").textContent = "";
  }

  function showBoot(text) {
    document.getElementById("boot-screen").classList.remove("mq-hidden");
    document.getElementById("boot-text").textContent = text;
  }

  function hideBoot() {
    document.getElementById("boot-screen").classList.add("mq-hidden");
  }

  function showAuth(message = "") {
    document.getElementById("auth-screen").classList.remove("mq-hidden");
    document.getElementById("learner-app").classList.add("mq-hidden");
    document.getElementById("admin-app").classList.add("mq-hidden");
    document.getElementById("auth-error").textContent = message;
    hideBoot();
  }

  function hideAuth() {
    document.getElementById("auth-screen").classList.add("mq-hidden");
    document.getElementById("auth-error").textContent = "";
  }

  function showToast(message, tone = "") {
    const toast = document.getElementById("toast");
    toast.textContent = message;
    toast.className = `mq-toast show ${tone}`.trim();
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => {
      toast.className = "mq-toast";
    }, 2600);
  }

  function playStampSound() {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return;
    const context = new AudioContextCtor();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "triangle";
    oscillator.frequency.setValueAtTime(120, context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(50, context.currentTime + 0.18);
    gain.gain.setValueAtTime(0.001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.35, context.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.24);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.25);
    window.setTimeout(() => void context.close(), 350);
  }

  function setPollTimer() {
    if (app.pollTimer) {
      window.clearInterval(app.pollTimer);
      app.pollTimer = null;
    }
    if (!app.user) return;
    const interval = app.user.is_admin ? ADMIN_POLL_MS : LEARNER_POLL_MS;
    app.pollTimer = window.setInterval(() => {
      if (!app.user) return;
      if (app.user.is_admin) {
        void refreshAdminBundle(true);
      } else {
        void refreshLearnerBundle(true);
      }
    }, interval);
  }

  function mergeServerState(nextState, options = {}) {
    const previousXp = app.state.totalXp || 0;
    app.state = normalizeState(nextState);
    if (options.animate && app.state.totalXp > previousXp) {
      animateXpGain(app.state.totalXp - previousXp);
    }
    app.lastTotalXp = app.state.totalXp;
  }

  async function refreshLearnerBundle(silent = false) {
    const [stateData, submissionData] = await Promise.all([api("/api/state"), api("/api/submissions/mine")]);
    mergeServerState(stateData.state, { animate: !silent && app.booted });
    app.submissions = Array.isArray(submissionData.submissions) ? submissionData.submissions : [];
    renderLearner();
  }

  async function refreshAdminBundle(silent = false) {
    const data = await api("/api/admin/users");
    app.adminUsers = Array.isArray(data.users) ? data.users : [];
    if (!app.adminUsers.length) {
      app.adminSelectedUserId = null;
      renderAdmin();
      return;
    }
    if (!app.adminUsers.some((item) => item.user?.id === app.adminSelectedUserId)) {
      app.adminSelectedUserId = app.adminUsers[0].user?.id || null;
    }
    renderAdmin();
    if (app.adminSelectedUserId) {
      await loadAdminDetail(app.adminSelectedUserId, !silent);
    }
  }

  async function loadAdminDetail(userId, refresh = false) {
    if (!refresh && app.adminDetailCache.has(userId)) {
      renderAdmin();
      return;
    }
    const detail = await api(`/api/admin/users/${userId}`);
    app.adminDetailCache.set(userId, detail);
    renderAdmin();
  }

  async function persistState() {
    if (!app.user || app.user.is_admin) return;
    if (app.saveInFlight) {
      app.pendingSave = true;
      return;
    }
    app.saveInFlight = true;
    window.clearTimeout(app.saveTimer);
    try {
      const data = await api("/api/state", { method: "PUT", body: { state: editableStatePayload() } });
      mergeServerState(data.state, { animate: false });
      renderLearner();
    } catch (error) {
      if (error.status === 401) {
        await handleLogout(false);
        showAuth("登录已失效，请重新登录");
        return;
      }
      showToast(error.payload?.error || "同步失败", "error");
    } finally {
      app.saveInFlight = false;
      if (app.pendingSave) {
        app.pendingSave = false;
        void persistState();
      }
    }
  }

  function scheduleSave() {
    window.clearTimeout(app.saveTimer);
    app.saveTimer = window.setTimeout(() => {
      void persistState();
    }, SAVE_DELAY);
  }

  async function maybeAutoCheckin() {
    if (!app.user || app.user.is_admin || app.checkinInFlight) return;
    const dateKey = currentDayKey();
    const day = ensureDay(dateKey);
    if (!isAllTasksDone(day) || day.checkin.stamped) return;
    app.checkinInFlight = true;
    try {
      const data = await api("/api/checkin", { method: "POST", body: { date_key: dateKey } });
      mergeServerState(data.state, { animate: false });
      app.latestStampDate = dateKey;
      playStampSound();
      renderLearner();
      showToast(`${data.checkin?.emoji || "🫶"} 今天的印章盖好了，等小和点头就会发奖励`);
    } catch (error) {
      showToast(error.payload?.error || "自动盖章失败", "error");
    } finally {
      app.checkinInFlight = false;
    }
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("读取凭证失败"));
      reader.readAsDataURL(file);
    });
  }

  async function submitProof(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const minutes = clampInt(form.querySelector("[name='duration_minutes']").value, 0, 720, 0);
    const dateKey = form.querySelector("[name='date_key']").value || currentDayKey();
    const note = form.querySelector("[name='note']").value.trim();
    const file = form.querySelector("[name='evidence']").files?.[0];
    if (!minutes) {
      showToast("先填一个有效的学习时长", "error");
      return;
    }
    if (!file) {
      showToast("每次送出证明都要附上凭证", "error");
      return;
    }
    const button = form.querySelector("button[type='submit']");
    button.disabled = true;
    button.textContent = "送出中...";
    try {
      const evidenceData = await fileToDataUrl(file);
      await api("/api/submissions", {
        method: "POST",
        body: {
          date_key: dateKey,
          duration_minutes: minutes,
          note,
          evidence_name: file.name || "proof",
          evidence_data: evidenceData,
        },
      });
      form.reset();
      form.querySelector("[name='date_key']").value = currentDayKey();
      await refreshLearnerBundle(true);
      showToast("证明已经送到小和桌上啦");
    } catch (error) {
      showToast(error.payload?.error || "送出失败", "error");
    } finally {
      button.disabled = false;
      button.textContent = "送出学习证明";
    }
  }

  async function handleLogin(event) {
    event.preventDefault();
    if (!app.backendReachable) {
      showAuth("现在打开的是静态页面，登录需要后端服务。请先运行 python server.py，再打开 http://127.0.0.1:8000。");
      return;
    }
    const username = document.getElementById("login-username").value.trim();
    const password = document.getElementById("login-password").value;
    showBoot("正在打开你的存档...");
    try {
      const data = await api("/api/auth/login", { method: "POST", body: { username, password } });
      app.user = data.user;
      hideAuth();
      await afterLogin();
    } catch (error) {
      showAuth(explainError(error, "登录失败"));
    }
  }

  async function handleRegister(event) {
    event.preventDefault();
    if (!app.backendReachable) {
      showAuth("现在打开的是静态页面，注册需要后端服务。请先运行 python server.py，再打开 http://127.0.0.1:8000。");
      return;
    }
    const username = document.getElementById("register-username").value.trim();
    const displayName = document.getElementById("register-display-name").value.trim();
    const password = document.getElementById("register-password").value;
    showBoot("正在准备你的新冒险...");
    try {
      const data = await api("/api/auth/register", {
        method: "POST",
        body: { username, display_name: displayName, password },
      });
      app.user = data.user;
      hideAuth();
      await afterLogin();
    } catch (error) {
      showAuth(explainError(error, "注册失败"));
    }
  }

  async function handleLogout(showMessage = true) {
    window.clearTimeout(app.saveTimer);
    if (app.user && !app.user.is_admin) {
      try {
        await persistState();
      } catch (_error) {
        // ignore
      }
    }
    try {
      await api("/api/auth/logout", { method: "POST" });
    } catch (_error) {
      // ignore
    }
    app.user = null;
    app.state = defaultState();
    app.submissions = [];
    app.adminUsers = [];
    app.adminSelectedUserId = null;
    app.adminDetailCache.clear();
    setPollTimer();
    if (showMessage) showToast("已经退出啦");
    showAuth("");
  }

  async function afterLogin() {
    app.calendarCursor = monthAnchor();
    app.adminDetailCache.clear();
    app.adminSelectedUserId = null;
    app.lastTotalXp = 0;
    if (app.user.is_admin) {
      await refreshAdminBundle();
      document.getElementById("learner-app").classList.add("mq-hidden");
      document.getElementById("admin-app").classList.remove("mq-hidden");
    } else {
      await refreshLearnerBundle();
      document.getElementById("admin-app").classList.add("mq-hidden");
      document.getElementById("learner-app").classList.remove("mq-hidden");
    }
    setPollTimer();
    app.booted = true;
    hideBoot();
  }

  function renderMetricCard(label, value, tone = "") {
    return `
      <article class="mq-mini-metric ${tone}">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
      </article>
    `;
  }

  function statusCopy(day) {
    const approved = approvedMinutes(day);
    const pending = pendingMinutes(day);
    if (approved > DAILY_GOAL_MINUTES) return "今天已经闪金啦，圆环正在冒光。";
    if (approved >= DAILY_GOAL_MINUTES) return "今天的目标稳稳完成，小和看到会很高兴。";
    if (pending > 0) return "证明已经送出去了，先等小和回信。";
    if (day.checkin.stamped) return "章先盖上了，奖励会在审核通过后落下来。";
    return "把三件小任务点亮，今天的印章就会自己砰地一声盖下来。";
  }

  function renderHero() {
    const { current, next, index } = getLevelInfo(app.state.totalXp);
    const ratio = next ? Math.max(0, Math.min(1, (app.state.totalXp - current.xp) / (next.xp - current.xp))) : 1;
    const today = ensureDay();
    document.getElementById("hero-avatar").textContent = LEVEL_AVATARS[index] || LEVEL_AVATARS[LEVEL_AVATARS.length - 1];
    document.getElementById("hero-level").textContent = `LV.${current.level}`;
    document.getElementById("hero-name").textContent = app.user?.display_name || "泡面侠";
    document.getElementById("hero-title").textContent = statusCopy(today);
    document.getElementById("xp-total").textContent = `${app.state.totalXp} XP`;
    document.getElementById("xp-next").textContent = next ? `距离 Lv.${next.level} 还差 ${Math.max(0, next.xp - app.state.totalXp)} XP` : "已经把这个世界刷到顶了";
    document.getElementById("xp-fill").style.width = `${Math.round(ratio * 100)}%`;
    const streak = document.getElementById("hero-streak");
    streak.classList.toggle("mq-hidden", app.state.streak <= 1);
    streak.textContent = `连签 ${app.state.streak} 天`;
    document.getElementById("learner-role-pill").textContent = "泡面侠";

    document.getElementById("hero-metrics").innerHTML = [
      renderMetricCard("今日已认可", formatMinutes(approvedMinutes(today)), approvedMinutes(today) >= DAILY_GOAL_MINUTES ? "green" : ""),
      renderMetricCard("待审核", pendingMinutes(today) ? formatMinutes(pendingMinutes(today)) : "0 分钟", pendingMinutes(today) ? "gray" : ""),
      renderMetricCard("今日经验", `+${today.xpEarned} XP`, approvedMinutes(today) ? "gold" : "gray"),
      renderMetricCard("最近签到", app.state.lastDate ? formatDate(app.state.lastDate) : "还没盖章", today.checkin.rewardXp > 0 ? "green" : "gray"),
    ].join("");
  }

  function ringTone(day) {
    const state = day?.status?.progressState;
    if (state === "over") return "gold";
    if (state === "goal") return "green";
    if (pendingMinutes(day) > 0 || day?.checkin?.stamped) return "gray";
    return "";
  }

  function ringStroke(day) {
    const approved = approvedMinutes(day);
    if (!approved) return CIRCUMFERENCE;
    const percent = Math.max(0, Math.min(1, approved / DAILY_GOAL_MINUTES));
    return CIRCUMFERENCE * (1 - percent);
  }

  function progressBadge(day) {
    if (day.status.progressState === "over") return `<span class="mq-state-badge gold">超额完成</span>`;
    if (day.status.progressState === "goal") return `<span class="mq-state-badge green">今日达标</span>`;
    if (pendingMinutes(day) > 0) return `<span class="mq-state-badge gray">等待审核</span>`;
    if (day.checkin.stamped) return `<span class="mq-state-badge gray">已盖章，奖励待定</span>`;
    return `<span class="mq-state-badge">还没开始结算</span>`;
  }

  function renderTaskButtons(day) {
    return Object.entries(TASK_LABELS)
      .map(([key, meta]) => {
        const active = day.tasks[key];
        return `
          <button type="button" class="mq-task-card ${active ? "done" : ""}" data-task="${key}">
            <span class="mq-task-mark">${active ? "✓" : "○"}</span>
            <span class="mq-task-copy">
              <strong>${escapeHtml(meta.title)}</strong>
              <small>${escapeHtml(meta.copy)}</small>
            </span>
          </button>
        `;
      })
      .join("");
  }

  function renderScoreButtons(field, value) {
    return `
      <div class="mq-score-row">
        ${[1, 2, 3, 4, 5]
          .map(
            (score) => `
              <button type="button" class="mq-score-btn ${score === value ? "active" : ""}" data-score-field="${field}" data-score-value="${score}">
                ${score}
              </button>
            `,
          )
          .join("")}
      </div>
    `;
  }

  function submissionStatusLabel(status) {
    if (status === "approved") return "小和赞许了你的工作！";
    if (status === "rejected") return "小和想再看看";
    return "小和查看中";
  }

  function submissionTone(status) {
    if (status === "approved") return "green";
    if (status === "rejected") return "red";
    return "gray";
  }

  function renderProofList() {
    if (!app.submissions.length) {
      return `<div class="mq-empty-card">今天送出的证明还没有出现。先去学一点，再把它们送给小和。</div>`;
    }
    return app.submissions
      .slice(0, 8)
      .map((item) => {
        const status = submissionStatusLabel(item.status);
        const note = item.admin_note ? `<div class="mq-proof-note">小和留言：${escapeHtml(item.admin_note)}</div>` : "";
        return `
          <article class="mq-proof-card ${submissionTone(item.status)}">
            <div class="mq-proof-top">
              <div>
                <strong>${formatMinutes(item.duration_minutes)}</strong>
                <span>${escapeHtml(item.date_key)} · ${formatDateTime(item.created_at)}</span>
              </div>
              <span class="mq-proof-badge ${submissionTone(item.status)}">${escapeHtml(status)}</span>
            </div>
            ${item.note ? `<p>${escapeHtml(item.note)}</p>` : ""}
            ${note}
            <div class="mq-proof-actions">
              <a href="${item.evidence_url}" target="_blank" rel="noreferrer">查看凭证</a>
            </div>
          </article>
        `;
      })
      .join("");
  }

  function renderCalendarLegend() {
    return STAMP_POOL.slice()
      .sort((left, right) => right.rarity - left.rarity)
      .map(
        (item) => `
          <span class="mq-legend-chip ${item.rarity === 9 ? "top" : ""}">
            <span>${item.emoji}</span>
            <small>${escapeHtml(item.label)}</small>
          </span>
        `,
      )
      .join("");
  }

  function renderCalendarGrid() {
    const start = new Date(app.calendarCursor);
    const month = start.getMonth();
    const firstWeekday = (start.getDay() + 6) % 7;
    const gridStart = new Date(start);
    gridStart.setDate(start.getDate() - firstWeekday);
    const dayLabels = ["一", "二", "三", "四", "五", "六", "日"]
      .map((label) => `<div class="mq-calendar-weekday">${label}</div>`)
      .join("");
    const cells = [];
    for (let index = 0; index < 42; index += 1) {
      const current = new Date(gridStart);
      current.setDate(gridStart.getDate() + index);
      const key = localDateKey(current);
      const day = normalizeDay(app.state.history[key]);
      const isCurrentMonth = current.getMonth() === month;
      const isToday = key === currentDayKey();
      const stamped = day.checkin.stamped;
      const tone = stamped
        ? day.status.rewardState === "over"
          ? "gold"
          : day.status.rewardState === "earned"
            ? "green"
            : "gray"
        : "";
      const stampHtml = stamped
        ? `
          <div class="mq-stamp-wrap ${tone} ${app.latestStampDate === key ? "thunk" : ""}">
            <div class="mq-stamp-ring ${tone}"></div>
            <div class="mq-stamp-emoji">${day.checkin.emoji}</div>
          </div>
        `
        : `<div class="mq-stamp-wrap empty"></div>`;
      cells.push(`
        <article class="mq-calendar-cell ${isCurrentMonth ? "" : "muted"} ${isToday ? "today" : ""}" data-date-key="${key}">
          <span class="mq-calendar-daynum">${current.getDate()}</span>
          ${stampHtml}
        </article>
      `);
    }
    return `
      <div class="mq-calendar-shell">
        <div class="mq-calendar-head">
          <button type="button" class="mq-ghost-btn" data-calendar-shift="-1">上个月</button>
          <strong>${app.calendarCursor.toLocaleDateString("zh-CN", { year: "numeric", month: "long" })}</strong>
          <button type="button" class="mq-ghost-btn" data-calendar-shift="1">下个月</button>
        </div>
        <div class="mq-calendar-grid">
          ${dayLabels}
          ${cells.join("")}
        </div>
      </div>
    `;
  }

  function renderDashboardView() {
    const day = ensureDay();
    const approved = approvedMinutes(day);
    const pending = pendingMinutes(day);
    const ringClass = ringTone(day);
    return `
      <div class="mq-dashboard-grid">
        <section class="mq-panel-card mq-ring-card ${ringClass}">
          <div class="mq-panel-head">
            <div>
              <p class="mq-panel-kicker">today ring</p>
              <h2>今日圆环</h2>
            </div>
            ${progressBadge(day)}
          </div>
          <div class="mq-ring-layout">
            <div class="mq-ring-widget ${ringClass}">
              <svg viewBox="0 0 140 140" aria-hidden="true">
                <circle class="mq-ring-track" cx="70" cy="70" r="52"></circle>
                <circle class="mq-ring-fill ${ringClass}" cx="70" cy="70" r="52" style="stroke-dasharray:${CIRCUMFERENCE};stroke-dashoffset:${ringStroke(day)}"></circle>
              </svg>
              <div class="mq-ring-core">
                <strong class="pixel">${approved ? formatMinutes(approved).replaceAll(" ", "") : "--"}</strong>
                <span>${approved ? "已被认可" : pending ? "等待小和点头" : "还没开始结算"}</span>
              </div>
            </div>
            <div class="mq-ring-side">
              ${renderMetricCard("今日目标", `${DAILY_GOAL_MINUTES} 分钟`)}
              ${renderMetricCard("待审核", pending ? formatMinutes(pending) : "0 分钟", pending ? "gray" : "")}
              ${renderMetricCard("签到奖励", day.checkin.rewardXp ? `+${day.checkin.rewardXp} XP` : "暂未结算", day.checkin.rewardXp ? "gold" : "gray")}
              ${renderMetricCard("今日总 XP", `+${day.xpEarned} XP`, approved ? "green" : "gray")}
            </div>
          </div>
        </section>

        <section class="mq-panel-card">
          <div class="mq-panel-head">
            <div>
              <p class="mq-panel-kicker">send proof</p>
              <h2>送出学习证明</h2>
            </div>
          </div>
          <form id="proof-form" class="mq-proof-form">
            <label>学习时长
              <input name="duration_minutes" type="number" min="1" max="720" placeholder="例如 45" required>
            </label>
            <label>学习日期
              <input name="date_key" type="date" value="${currentDayKey()}" required>
            </label>
            <label class="wide">补充说明
              <textarea name="note" rows="3" placeholder="写一句今天具体学了什么，或者想让小和先看到什么。"></textarea>
            </label>
            <label class="wide">学习凭证
              <input name="evidence" type="file" accept="image/*,.pdf" required>
            </label>
            <button type="submit" class="mq-primary-btn">送出学习证明</button>
          </form>
          <p class="mq-helper">在小和返回之前，不会点亮圆环、等级或经验条。但你的印章可以先盖上。</p>
        </section>
      </div>

      <div class="mq-dashboard-grid lower">
        <section class="mq-panel-card">
          <div class="mq-panel-head">
            <div>
              <p class="mq-panel-kicker">daily checklist</p>
              <h2>今天的小任务</h2>
            </div>
            <span class="mq-soft-note">${isAllTasksDone(day) ? "任务齐了，印章会自己跳下来" : "把三件事都点亮，就会自动签到"}</span>
          </div>
          <div class="mq-task-grid">${renderTaskButtons(day)}</div>
          <div class="mq-journal-grid">
            <label>今天最值得记住的瞬间
              <textarea data-journal-field="top" rows="3" placeholder="例如：终于看懂了导数题的破题点">${escapeHtml(day.journal.top)}</textarea>
            </label>
            <label>今天最卡的地方
              <textarea data-journal-field="stuck" rows="3" placeholder="例如：圆锥曲线条件一多就开始乱">${escapeHtml(day.journal.stuck)}</textarea>
            </label>
            <label>给今天一句总结
              <textarea data-journal-field="feel" rows="3" placeholder="例如：虽然慢，但我真的在往前挪">${escapeHtml(day.journal.feel)}</textarea>
            </label>
          </div>
          <div class="mq-score-grid">
            <div><span>难度感</span>${renderScoreButtons("difficulty", day.journal.difficulty)}</div>
            <div><span>专注度</span>${renderScoreButtons("focus", day.journal.focus)}</div>
            <div><span>努力值</span>${renderScoreButtons("effort", day.journal.effort)}</div>
            <div><span>心情</span>${renderScoreButtons("mood", day.mood)}</div>
            <div><span>能量</span>${renderScoreButtons("energy", day.energy)}</div>
          </div>
        </section>

        <section class="mq-panel-card">
          <div class="mq-panel-head">
            <div>
              <p class="mq-panel-kicker">review status</p>
              <h2>小和的回信</h2>
            </div>
          </div>
          <div class="mq-proof-list">${renderProofList()}</div>
        </section>
      </div>

      <section class="mq-panel-card">
        <div class="mq-panel-head">
          <div>
            <p class="mq-panel-kicker">stamp calendar</p>
            <h2>印章月历</h2>
          </div>
          <div class="mq-legend-row">${renderCalendarLegend()}</div>
        </div>
        ${renderCalendarGrid()}
      </section>
    `;
  }

  function renderJourneyView() {
    const days = Object.entries(app.state.history)
      .sort((left, right) => right[0].localeCompare(left[0]))
      .filter(([, day]) => {
        const normalized = normalizeDay(day);
        return approvedMinutes(normalized) || pendingMinutes(normalized) || normalized.checkin.stamped || journalCount(normalized) || countDoneTasks(normalized);
      });
    const recent = days.length
      ? days
          .map(([dateKey, rawDay]) => {
            const day = normalizeDay(rawDay);
            const tone = ringTone(day);
            return `
              <article class="mq-journey-card ${tone}">
                <div class="mq-journey-top">
                  <strong>${escapeHtml(dateKey)}</strong>
                  <span>+${day.xpEarned} XP</span>
                </div>
                <p>已认可 ${formatMinutes(approvedMinutes(day))} · 待审核 ${formatMinutes(pendingMinutes(day))}</p>
                <p>任务 ${countDoneTasks(day)}/3 · 日志 ${journalCount(day)}/3</p>
                <div class="mq-journey-footer">
                  <span>${day.checkin.stamped ? `${day.checkin.emoji} ${escapeHtml(day.checkin.label || "今日印章")}` : "还没有盖章"}</span>
                  <span>${day.status.rewardState === "over" ? "闪金完成" : day.status.rewardState === "earned" ? "达标完成" : day.status.rewardState === "pending" ? "奖励待定" : "静静等待"}</span>
                </div>
              </article>
            `;
          })
          .join("")
      : `<div class="mq-empty-card">这里会放下你每一天的小胜利。现在先去完成第一天吧。</div>`;

    const duckDays = days.filter(([, day]) => normalizeDay(day).checkin.emoji === "🐥").length;
    const overDays = days.filter(([, day]) => normalizeDay(day).status.progressState === "over").length;
    const comboMax = days.reduce((max, [, day]) => Math.max(max, normalizeDay(day).checkin.comboDays || 0), 0);
    return `
      <div class="mq-dashboard-grid">
        <section class="mq-panel-card">
          <div class="mq-panel-head">
            <div><p class="mq-panel-kicker">milestones</p><h2>成长里程碑</h2></div>
          </div>
          <div class="mq-achievement-grid">
            ${renderMetricCard("小鸭子印章", `${duckDays} 次`, duckDays ? "gold" : "gray")}
            ${renderMetricCard("闪金天数", `${overDays} 天`, overDays ? "gold" : "gray")}
            ${renderMetricCard("最长同章连击", `${comboMax} 天`, comboMax > 1 ? "green" : "gray")}
            ${renderMetricCard("总经验", `${app.state.totalXp} XP`, app.state.totalXp ? "green" : "gray")}
          </div>
        </section>

        <section class="mq-panel-card">
          <div class="mq-panel-head">
            <div><p class="mq-panel-kicker">cute summary</p><h2>小和会看到的你</h2></div>
          </div>
          <div class="mq-story-list">
            <div class="mq-story-line">最近一次盖章：${app.state.lastDate ? formatDate(app.state.lastDate) : "还没有"}</div>
            <div class="mq-story-line">连续签到：${app.state.streak} 天</div>
            <div class="mq-story-line">最近 7 天里，只要小和点头，经验条就会跟着冲刺。</div>
          </div>
        </section>
      </div>

      <section class="mq-panel-card">
        <div class="mq-panel-head">
          <div><p class="mq-panel-kicker">journey</p><h2>最近的成长足迹</h2></div>
        </div>
        <div class="mq-journey-list">${recent}</div>
      </section>
    `;
  }

  function renderSettingsView() {
    return `
      <section class="mq-panel-card">
        <div class="mq-panel-head">
          <div><p class="mq-panel-kicker">account</p><h2>账号设置</h2></div>
        </div>
        <form id="settings-form" class="mq-settings-form">
          <label>显示名称<input name="display_name" value="${escapeHtml(app.user?.display_name || "")}" autocomplete="nickname"></label>
          <label>当前密码<input name="current_password" type="password" autocomplete="current-password" placeholder="只有改密码时才需要填写"></label>
          <label>新密码<input name="new_password" type="password" autocomplete="new-password" placeholder="留空则不修改"></label>
          <button type="submit" class="mq-primary-btn">保存这份新模样</button>
        </form>
      </section>
    `;
  }

  function renderLearner() {
    renderHero();
    document.querySelectorAll(".mq-nav button").forEach((button) => {
      button.classList.toggle("active", button.dataset.view === app.learnerView);
    });
    const views = {
      dashboard: renderDashboardView(),
      calendar: `
        <section class="mq-panel-card">
          <div class="mq-panel-head">
            <div><p class="mq-panel-kicker">month stamps</p><h2>整张印章月历</h2></div>
            <div class="mq-legend-row">${renderCalendarLegend()}</div>
          </div>
          ${renderCalendarGrid()}
        </section>
      `,
      journey: renderJourneyView(),
      settings: renderSettingsView(),
    };
    Object.entries(views).forEach(([name, html]) => {
      const element = document.getElementById(`learner-view-${name}`);
      element.innerHTML = html;
      element.classList.toggle("mq-hidden", name !== app.learnerView);
    });

    const proofForm = document.getElementById("proof-form");
    if (proofForm) proofForm.addEventListener("submit", submitProof);
    const settingsForm = document.getElementById("settings-form");
    if (settingsForm) {
      settingsForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const displayName = form.display_name.value.trim();
        const currentPassword = form.current_password.value;
        const newPassword = form.new_password.value;
        try {
          const data = await api("/api/me", {
            method: "PUT",
            body: { display_name: displayName, current_password: currentPassword, new_password: newPassword },
          });
          app.user = data.user;
          renderLearner();
          showToast("账号信息已经换成新的样子啦");
        } catch (error) {
          showToast(error.payload?.error || "保存失败", "error");
        }
      });
    }

    window.setTimeout(() => {
      app.latestStampDate = null;
    }, 500);
    void maybeAutoCheckin();
  }

  function adminGroups() {
    const users = app.adminUsers || [];
    return {
      pending: users.filter((item) => (item.pending_count || 0) > 0),
      shining: users.filter((item) => item.recent_days?.[0]?.progressState === "over" || item.recent_days?.[0]?.rewardState === "over"),
      all: users,
    };
  }

  function renderAdminOverview() {
    const users = app.adminUsers || [];
    const pendingTotal = users.reduce((sum, item) => sum + (item.pending_count || 0), 0);
    const overCount = users.filter((item) => item.recent_days?.[0]?.progressState === "over").length;
    const activeToday = users.filter((item) => item.summary?.lastActiveDate === currentDayKey()).length;
    document.getElementById("admin-overview").innerHTML = `
      <section class="mq-admin-hero-card">
        <div>
          <p class="mq-panel-kicker">xiaohe dashboard</p>
          <h2>小和今天先看哪里</h2>
          <p>这里不是学习页，而是专门给小和盯进度、回证明、看谁在发光的后台。</p>
        </div>
        <div class="mq-admin-hero-stats">
          ${renderMetricCard("待处理证明", `${pendingTotal} 份`, pendingTotal ? "gold" : "gray")}
          ${renderMetricCard("今日闪金", `${overCount} 位`, overCount ? "gold" : "gray")}
          ${renderMetricCard("今日有动静", `${activeToday} 位`, activeToday ? "green" : "gray")}
          ${renderMetricCard("泡面侠总数", `${users.length} 位`, users.length ? "green" : "gray")}
        </div>
      </section>
    `;
  }

  function renderAdminQueue() {
    const focusUsers = (app.adminUsers || []).filter((item) => (item.pending_count || 0) > 0);
    document.getElementById("admin-queue").innerHTML = focusUsers.length
      ? focusUsers
          .slice(0, 8)
          .map(
            (item) => `
              <button type="button" class="mq-queue-card ${item.user?.id === app.adminSelectedUserId ? "active" : ""}" data-admin-user-id="${item.user?.id}">
                <strong>${escapeHtml(item.user?.display_name || item.user?.username || "泡面侠")}</strong>
                <span>${item.pending_count} 份证明等小和点头</span>
              </button>
            `,
          )
          .join("")
      : `<div class="mq-empty-card">现在桌上没有待看的证明，可以先去喝口水。</div>`;
  }

  function renderAdminUserTabs() {
    const groups = adminGroups();
    const tabs = [
      { id: "pending", label: "待夸夸", count: groups.pending.length },
      { id: "shining", label: "闪金中", count: groups.shining.length },
      { id: "all", label: "全部泡面侠", count: groups.all.length },
    ];
    document.getElementById("admin-group-tabs").innerHTML = tabs
      .map(
        (item) => `
          <button type="button" class="${app.adminGroup === item.id ? "active" : ""}" data-admin-group="${item.id}">
            ${escapeHtml(item.label)} <small>${item.count}</small>
          </button>
        `,
      )
      .join("");

    const users = groups[app.adminGroup] || [];
    document.getElementById("admin-user-tabs").innerHTML = users.length
      ? users
          .map((item) => {
            const summary = item.summary || {};
            const hot = item.pending_count ? `待审 ${item.pending_count}` : summary.lastActiveDate || "安静一下";
            return `
              <button type="button" class="mq-admin-user-pill ${item.user?.id === app.adminSelectedUserId ? "active" : ""}" data-admin-user-id="${item.user?.id}">
                <strong>${escapeHtml(item.user?.display_name || item.user?.username || "泡面侠")}</strong>
                <span>Lv.${summary.level?.level || 1} · ${escapeHtml(hot)}</span>
              </button>
            `;
          })
          .join("")
      : `<div class="mq-empty-card">这一栏现在没有泡面侠。</div>`;
  }

  function renderAdminFocus() {
    const focusEl = document.getElementById("admin-focus");
    if (!app.adminSelectedUserId) {
      focusEl.innerHTML = `<div class="mq-empty-card">先从左边点开一位泡面侠吧。</div>`;
      return;
    }
    const detail = app.adminDetailCache.get(app.adminSelectedUserId);
    if (!detail) {
      focusEl.innerHTML = `<div class="mq-empty-card">正在展开这位泡面侠的看板...</div>`;
      return;
    }
    const summary = detail.summary || {};
    const state = normalizeState(detail.state || {});
    const historyKeys = Object.keys(state.history || {}).sort((left, right) => right.localeCompare(left));
    const snapshotKey = historyKeys[0] || currentDayKey();
    const day = normalizeDay(state.history[snapshotKey]);
    const reviewCards = (detail.submissions || []).length
      ? detail.submissions
          .map((item) => {
            const pending = item.status === "pending";
            return `
              <article class="mq-admin-review-card ${submissionTone(item.status)}">
                <div class="mq-proof-top">
                  <div>
                    <strong>${formatMinutes(item.duration_minutes)}</strong>
                    <span>${escapeHtml(item.date_key)} · ${formatDateTime(item.created_at)}</span>
                  </div>
                  <span class="mq-proof-badge ${submissionTone(item.status)}">${escapeHtml(submissionStatusLabel(item.status))}</span>
                </div>
                ${item.note ? `<p>${escapeHtml(item.note)}</p>` : ""}
                <div class="mq-proof-actions"><a href="${item.evidence_url}" target="_blank" rel="noreferrer">查看凭证</a></div>
                ${
                  pending
                    ? `
                      <div class="mq-admin-review-actions">
                        <input id="review-note-${item.id}" placeholder="给这位泡面侠留一句话（可选）">
                        <button type="button" class="mq-ghost-btn" data-review-action="reject" data-submission-id="${item.id}">再补一点</button>
                        <button type="button" class="mq-primary-btn" data-review-action="approve" data-submission-id="${item.id}">点头通过</button>
                      </div>
                    `
                    : item.admin_note
                      ? `<div class="mq-proof-note">小和留言：${escapeHtml(item.admin_note)}</div>`
                      : ""
                }
              </article>
            `;
          })
          .join("")
      : `<div class="mq-empty-card">这位泡面侠暂时还没送来学习证明。</div>`;

    const recentDays = (summary.recentDays || [])
      .map(
        (item) => `
          <div class="mq-admin-activity-row">
            <strong>${escapeHtml(item.date)}</strong>
            <span>${formatMinutes(item.studyMinutes || 0)} · +${item.xpEarned || 0} XP</span>
            <div class="mq-admin-activity-bar">
              <div class="mq-admin-activity-fill ${item.progressState === "over" ? "gold" : item.progressState === "goal" ? "green" : ""}" style="width:${Math.min(100, Math.round(((item.studyMinutes || 0) / DAILY_GOAL_MINUTES) * 100))}%"></div>
            </div>
          </div>
        `,
      )
      .join("");

    focusEl.innerHTML = `
      <section class="mq-admin-focus-card">
        <div class="mq-admin-focus-head">
          <div>
            <p class="mq-panel-kicker">ramen hero detail</p>
            <h2>${escapeHtml(detail.user?.display_name || detail.user?.username || "泡面侠")}</h2>
            <p>@${escapeHtml(detail.user?.username || "")} · 最近登录 ${formatDateTime(detail.user?.last_login_at)}</p>
          </div>
          <div class="mq-admin-focus-badges">
            <span class="mq-pill">Lv.${summary.level?.level || 1}</span>
            <span class="mq-pill">${summary.totalXp || 0} XP</span>
          </div>
        </div>

        <div class="mq-admin-focus-grid">
          <section class="mq-panel-card">
            <div class="mq-panel-head">
              <div><p class="mq-panel-kicker">snapshot</p><h2>${escapeHtml(snapshotKey)}</h2></div>
            </div>
            <div class="mq-admin-snapshot-grid">
              ${renderMetricCard("已认可时长", formatMinutes(approvedMinutes(day)), day.status.progressState === "goal" ? "green" : day.status.progressState === "over" ? "gold" : "gray")}
              ${renderMetricCard("待审核时长", formatMinutes(pendingMinutes(day)), pendingMinutes(day) ? "gray" : "")}
              ${renderMetricCard("今日经验", `+${day.xpEarned} XP`, approvedMinutes(day) ? "gold" : "gray")}
              ${renderMetricCard("签到印章", day.checkin.stamped ? `${day.checkin.emoji} ${day.checkin.label || ""}` : "未盖章", day.checkin.rewardXp ? "green" : "gray")}
            </div>
            <div class="mq-task-grid compact">${renderTaskButtons(day)}</div>
          </section>

          <section class="mq-panel-card">
            <div class="mq-panel-head">
              <div><p class="mq-panel-kicker">notes</p><h2>这位泡面侠写了什么</h2></div>
            </div>
            <div class="mq-story-list">
              <div class="mq-story-line">印象最深：${escapeHtml(day.journal.top || "还没有记录")}</div>
              <div class="mq-story-line">卡点：${escapeHtml(day.journal.stuck || "还没有记录")}</div>
              <div class="mq-story-line">感受：${escapeHtml(day.journal.feel || "还没有记录")}</div>
              <div class="mq-story-line">难度 ${day.journal.difficulty}/5 · 专注 ${day.journal.focus}/5 · 努力 ${day.journal.effort}/5</div>
            </div>
          </section>
        </div>

        <section class="mq-panel-card">
          <div class="mq-panel-head">
            <div><p class="mq-panel-kicker">recent waves</p><h2>最近的成长波形</h2></div>
          </div>
          <div class="mq-admin-activity-list">${recentDays || `<div class="mq-empty-card">最近还没有成长波形。</div>`}</div>
        </section>

        <section class="mq-panel-card">
          <div class="mq-panel-head">
            <div><p class="mq-panel-kicker">proof review</p><h2>学习证明处理台</h2></div>
          </div>
          <div class="mq-admin-review-list">${reviewCards}</div>
        </section>
      </section>
    `;
  }

  function renderAdmin() {
    renderAdminOverview();
    renderAdminQueue();
    renderAdminUserTabs();
    renderAdminFocus();
  }

  async function handleAdminReview(action, submissionId) {
    const noteInput = document.getElementById(`review-note-${submissionId}`);
    const adminNote = noteInput ? noteInput.value.trim() : "";
    try {
      await api(`/api/admin/submissions/${submissionId}/review`, {
        method: "POST",
        body: { action, admin_note: adminNote },
      });
      await refreshAdminBundle(true);
      showToast(action === "approve" ? "小和赞许了你的工作！" : "已经请对方再补一点证明啦");
    } catch (error) {
      showToast(error.payload?.error || "处理失败", "error");
    }
  }

  function animateXpGain(amount) {
    const track = document.querySelector(".mq-xp-track");
    if (!track) return;
    track.classList.add("boost");
    window.setTimeout(() => track.classList.remove("boost"), 850);
    const layer = document.getElementById("exp-layer");
    const rect = track.getBoundingClientRect();
    const count = Math.max(6, Math.min(24, Math.round(amount / 20)));
    for (let index = 0; index < count; index += 1) {
      const particle = document.createElement("span");
      particle.className = "mq-exp-particle";
      particle.textContent = index % 5 === 0 ? `+${amount}` : "EXP";
      particle.style.left = `${rect.left + rect.width * (0.15 + Math.random() * 0.7)}px`;
      particle.style.top = `${rect.top + rect.height / 2 + Math.random() * 12}px`;
      particle.style.animationDelay = `${index * 18}ms`;
      layer.appendChild(particle);
      window.setTimeout(() => particle.remove(), 1400);
    }
  }

  function bindStaticEvents() {
    document.querySelector(".mq-auth-tabs").addEventListener("click", (event) => {
      const button = event.target.closest("[data-auth-mode]");
      if (!button) return;
      setAuthMode(button.dataset.authMode);
    });
    document.getElementById("login-form").addEventListener("submit", handleLogin);
    document.getElementById("register-form").addEventListener("submit", handleRegister);
    document.getElementById("logout-btn").addEventListener("click", () => void handleLogout());
    document.getElementById("admin-logout-btn").addEventListener("click", () => void handleLogout());
    document.querySelector(".mq-nav").addEventListener("click", (event) => {
      const button = event.target.closest("[data-view]");
      if (!button) return;
      app.learnerView = button.dataset.view;
      renderLearner();
    });

    const learnerRoot = document.getElementById("learner-app");
    learnerRoot.addEventListener("click", (event) => {
      const taskButton = event.target.closest("[data-task]");
      if (taskButton) {
        const day = ensureDay();
        const key = taskButton.dataset.task;
        day.tasks[key] = !day.tasks[key];
        renderLearner();
        scheduleSave();
        void maybeAutoCheckin();
        return;
      }

      const scoreButton = event.target.closest("[data-score-field]");
      if (scoreButton) {
        const field = scoreButton.dataset.scoreField;
        const value = clampInt(scoreButton.dataset.scoreValue, 1, 5, 0);
        const day = ensureDay();
        if (["difficulty", "focus", "effort"].includes(field)) {
          day.journal[field] = value;
        } else {
          day[field] = value;
        }
        renderLearner();
        scheduleSave();
        return;
      }

      const shiftButton = event.target.closest("[data-calendar-shift]");
      if (shiftButton) {
        const shift = clampInt(shiftButton.dataset.calendarShift, -12, 12, 0);
        app.calendarCursor = new Date(app.calendarCursor.getFullYear(), app.calendarCursor.getMonth() + shift, 1);
        renderLearner();
      }
    });

    learnerRoot.addEventListener("input", (event) => {
      const field = event.target.dataset.journalField;
      if (!field) return;
      const day = ensureDay();
      day.journal[field] = event.target.value;
      scheduleSave();
    });

    document.getElementById("admin-refresh-btn").addEventListener("click", () => void refreshAdminBundle(true));
    document.getElementById("admin-group-tabs").addEventListener("click", (event) => {
      const button = event.target.closest("[data-admin-group]");
      if (!button) return;
      app.adminGroup = button.dataset.adminGroup;
      renderAdmin();
    });
    document.getElementById("admin-queue").addEventListener("click", (event) => {
      const button = event.target.closest("[data-admin-user-id]");
      if (!button) return;
      app.adminSelectedUserId = clampInt(button.dataset.adminUserId, 0, 10000000, 0);
      void loadAdminDetail(app.adminSelectedUserId, true);
    });
    document.getElementById("admin-user-tabs").addEventListener("click", (event) => {
      const button = event.target.closest("[data-admin-user-id]");
      if (!button) return;
      app.adminSelectedUserId = clampInt(button.dataset.adminUserId, 0, 10000000, 0);
      void loadAdminDetail(app.adminSelectedUserId, true);
    });
    document.getElementById("admin-focus").addEventListener("click", (event) => {
      const actionButton = event.target.closest("[data-review-action]");
      if (!actionButton) return;
      const action = actionButton.dataset.reviewAction;
      const submissionId = clampInt(actionButton.dataset.submissionId, 0, 10000000, 0);
      void handleAdminReview(action, submissionId);
    });
  }

  async function boot() {
    bindStaticEvents();
    setAuthMode("login");
    showBoot("正在检查登录状态...");
    try {
      const data = await api("/api/me");
      app.backendReachable = true;
      app.user = data.user;
      hideAuth();
      await afterLogin();
    } catch (error) {
      if (error.status === 401) {
        app.backendReachable = true;
        showAuth("");
      } else {
        app.backendReachable = false;
        showAuth("后端暂时没有连上，静态页面已经换成新客户端了。把服务跑起来后，这里会直接切到真实存档。");
      }
    }
  }

  void boot();
})();
