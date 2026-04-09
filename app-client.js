(function () {
  const DAILY_GOAL_MINUTES = 120;
  const SAVE_DELAY = 600;
  const LEARNER_POLL_MS = 20000;
  const ADMIN_POLL_MS = 30000;
  const CIRCUMFERENCE = 2 * Math.PI * 52;
  const STAMP_POOL = [
    { emoji: "🐹", rarity: 1, label: "仓鼠", weight: 20 },
    { emoji: "🐰", rarity: 2, label: "兔兔", weight: 18 },
    { emoji: "🐱", rarity: 3, label: "小猫", weight: 15 },
    { emoji: "🐶", rarity: 4, label: "小狗", weight: 12 },
    { emoji: "🦊", rarity: 5, label: "狐狸", weight: 9 },
    { emoji: "🐼", rarity: 6, label: "熊猫", weight: 7 },
    { emoji: "🦁", rarity: 7, label: "狮子", weight: 5 },
    { emoji: "🦄", rarity: 8, label: "独角兽", weight: 3 },
    { emoji: "🐥", rarity: 9, label: "小鸭子", weight: 1 },
  ];
  const LOCAL_STORE_KEY = "mq_local_backend_v1";
  const WEEKEND_GOAL_MINUTES = 180;
  const TASK_XP = { correction: 24, difficulty: 22, review: 18 };
  const JOURNAL_XP = 22;
  const GOAL_BONUS_XP = 46;
  const OVERACHIEVE_BONUS_XP = 36;
  const STAMP_REWARD_BASE = 14;
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
    bonusTasks: [],
    bonusSubmissions: [],
    adminUsers: [],
    adminDetailCache: new Map(),
    adminBonusTasks: [],
    adminBonusSubmissions: [],
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
    transport: "remote",
    pendingCheckinDateKey: null,
    dismissedCheckinDateKey: null,
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
        bonusReward: 0,
        bonusApprovedCount: 0,
        bonusPendingCount: 0,
        bonusLatestTitle: "",
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
      moodNote: typeof raw.moodNote === "string" ? raw.moodNote : "",
      progressNote: typeof raw.progressNote === "string" ? raw.progressNote : "",
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
      bonusReward: clampInt(raw.bonusReward, 0, 1000000, 0),
      bonusApprovedCount: clampInt(raw.bonusApprovedCount, 0, 1000, 0),
      bonusPendingCount: clampInt(raw.bonusPendingCount, 0, 1000, 0),
      bonusLatestTitle: typeof raw.bonusLatestTitle === "string" ? raw.bonusLatestTitle : "",
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

  function goalMinutesForDate(dateKey = currentDayKey()) {
    const parsed = parseDateKey(dateKey);
    if (!parsed) return DAILY_GOAL_MINUTES;
    const weekday = parsed.getDay();
    return weekday === 0 || weekday === 6 ? WEEKEND_GOAL_MINUTES : DAILY_GOAL_MINUTES;
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

  function submittedMinutes(day) {
    return approvedMinutes(day) + pendingMinutes(day);
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

  function currentIso() {
    return new Date().toISOString();
  }

  function defaultLocalBackend() {
    return {
      currentUserId: null,
      nextUserId: 2,
      nextSubmissionId: 1,
      nextBonusTaskId: 1,
      nextBonusSubmissionId: 1,
      users: [
        {
          id: 1,
          username: "admin",
          display_name: "小和",
          password: "admin123456",
          is_admin: true,
          created_at: currentIso(),
          last_login_at: null,
        },
      ],
      states: {},
      submissions: [],
      bonusTasks: [],
      bonusTaskSubmissions: [],
    };
  }

  function loadLocalBackend() {
    try {
      const raw = window.localStorage.getItem(LOCAL_STORE_KEY);
      const parsed = raw ? JSON.parse(raw) : defaultLocalBackend();
      return normalizeLocalBackend(parsed);
    } catch (_error) {
      return defaultLocalBackend();
    }
  }

  function saveLocalBackend(store) {
    window.localStorage.setItem(LOCAL_STORE_KEY, JSON.stringify(store));
  }

  function normalizeLocalBackend(raw) {
    const base = defaultLocalBackend();
    if (!raw || typeof raw !== "object") return base;
    if (Array.isArray(raw.users)) {
      base.users = raw.users
        .filter((item) => item && typeof item === "object" && typeof item.username === "string")
        .map((item) => ({
          id: clampInt(item.id, 1, 10000000, 0),
          username: item.username,
          display_name: typeof item.display_name === "string" ? item.display_name : item.username,
          password: typeof item.password === "string" ? item.password : "",
          is_admin: Boolean(item.is_admin),
          created_at: typeof item.created_at === "string" ? item.created_at : currentIso(),
          last_login_at: typeof item.last_login_at === "string" ? item.last_login_at : null,
        }))
        .filter((item) => item.id > 0);
    }
    if (!base.users.some((item) => item.username === "admin")) {
      base.users.unshift(defaultLocalBackend().users[0]);
    }
    base.currentUserId = clampInt(raw.currentUserId, 0, 10000000, 0) || null;
    base.nextUserId = clampInt(raw.nextUserId, 2, 10000000, Math.max(...base.users.map((item) => item.id), 1) + 1);
    base.nextSubmissionId = clampInt(raw.nextSubmissionId, 1, 10000000, 1);
    base.nextBonusTaskId = clampInt(raw.nextBonusTaskId, 1, 10000000, 1);
    base.nextBonusSubmissionId = clampInt(raw.nextBonusSubmissionId, 1, 10000000, 1);
    if (raw.states && typeof raw.states === "object") {
      Object.entries(raw.states).forEach(([key, value]) => {
        base.states[key] = normalizeState(value);
      });
    }
    if (Array.isArray(raw.submissions)) {
      base.submissions = raw.submissions
        .filter((item) => item && typeof item === "object")
        .map((item) => ({
          id: clampInt(item.id, 1, 10000000, 0),
          user_id: clampInt(item.user_id, 1, 10000000, 0),
          date_key: typeof item.date_key === "string" ? item.date_key : currentDayKey(),
          duration_minutes: clampInt(item.duration_minutes, 1, 720, 1),
          note: typeof item.note === "string" ? item.note : "",
          status: typeof item.status === "string" ? item.status : "pending",
          admin_note: typeof item.admin_note === "string" ? item.admin_note : "",
          created_at: typeof item.created_at === "string" ? item.created_at : currentIso(),
          reviewed_at: typeof item.reviewed_at === "string" ? item.reviewed_at : null,
          reviewed_by: clampInt(item.reviewed_by, 0, 10000000, 0) || null,
          evidence_name: typeof item.evidence_name === "string" ? item.evidence_name : "proof",
          evidence_mime: typeof item.evidence_mime === "string" ? item.evidence_mime : "application/octet-stream",
          evidence_url: typeof item.evidence_url === "string" ? item.evidence_url : "",
        }))
        .filter((item) => item.id > 0 && item.user_id > 0);
    }
    if (Array.isArray(raw.bonusTasks)) {
      base.bonusTasks = raw.bonusTasks
        .filter((item) => item && typeof item === "object")
        .map((item) => ({
          id: clampInt(item.id, 1, 10000000, 0),
          title: typeof item.title === "string" ? item.title : "",
          description: typeof item.description === "string" ? item.description : "",
          difficulty: clampInt(item.difficulty, 1, 5, 1),
          target_days: clampInt(item.target_days, 1, 30, 3),
          active: item.active !== false,
          created_at: typeof item.created_at === "string" ? item.created_at : currentIso(),
        }))
        .filter((item) => item.id > 0);
    }
    if (Array.isArray(raw.bonusTaskSubmissions)) {
      base.bonusTaskSubmissions = raw.bonusTaskSubmissions
        .filter((item) => item && typeof item === "object")
        .map((item) => ({
          id: clampInt(item.id, 1, 10000000, 0),
          task_id: clampInt(item.task_id, 1, 10000000, 0),
          user_id: clampInt(item.user_id, 1, 10000000, 0),
          completed_date_key: typeof item.completed_date_key === "string" ? item.completed_date_key : currentDayKey(),
          note: typeof item.note === "string" ? item.note : "",
          status: typeof item.status === "string" ? item.status : "pending",
          admin_note: typeof item.admin_note === "string" ? item.admin_note : "",
          created_at: typeof item.created_at === "string" ? item.created_at : currentIso(),
          reviewed_at: typeof item.reviewed_at === "string" ? item.reviewed_at : null,
          reviewed_by: clampInt(item.reviewed_by, 0, 10000000, 0) || null,
          reward_total: clampInt(item.reward_total, 0, 1000000, 0),
          speed_tier: typeof item.speed_tier === "string" ? item.speed_tier : "",
          speed_multiplier: Number.isFinite(Number(item.speed_multiplier)) ? Number(item.speed_multiplier) : 1,
          evidence_name: typeof item.evidence_name === "string" ? item.evidence_name : "proof",
          evidence_mime: typeof item.evidence_mime === "string" ? item.evidence_mime : "application/octet-stream",
          evidence_url: typeof item.evidence_url === "string" ? item.evidence_url : "",
        }))
        .filter((item) => item.id > 0 && item.user_id > 0 && item.task_id > 0);
    }
    return base;
  }

  function localPublicUser(user) {
    return {
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      is_admin: user.is_admin,
      created_at: user.created_at,
      last_login_at: user.last_login_at,
    };
  }

  function localUserById(store, userId) {
    return store.users.find((item) => item.id === userId) || null;
  }

  function localCurrentUser(store) {
    return localUserById(store, store.currentUserId);
  }

  function localRawState(store, userId) {
    return normalizeState(store.states[String(userId)] || defaultState());
  }

  function localSaveRawState(store, userId, state) {
    store.states[String(userId)] = normalizeState(state);
  }

  function computeStudyXp(minutes) {
    if (minutes <= 0) return 0;
    return Math.round(14 * (Math.exp(minutes / 95) - 1));
  }

  function pickLocalStamp() {
    const totalWeight = STAMP_POOL.reduce((sum, item) => sum + item.weight, 0);
    let roll = Math.random() * totalWeight;
    for (const item of STAMP_POOL) {
      roll -= item.weight;
      if (roll <= 0) return item;
    }
    return STAMP_POOL[STAMP_POOL.length - 1];
  }

  function localHydrateState(store, userId) {
    const raw = localRawState(store, userId);
    const history = { ...(raw.history || {}) };
    const submissions = store.submissions.filter((item) => item.user_id === userId);
    submissions.forEach((item) => {
      if (!history[item.date_key]) history[item.date_key] = defaultDay();
    });
    const stampedDates = [];
    let totalXp = 0;
    let lastDate = null;
    Object.keys(history)
      .sort()
      .forEach((dateKey) => {
        const day = normalizeDay(history[dateKey]);
        const daySubs = submissions.filter((item) => item.date_key === dateKey);
        const dayBonus = store.bonusTaskSubmissions
          .filter((item) => item.user_id === userId && item.completed_date_key === dateKey)
          .map((item) => ({
            ...item,
            task_title: store.bonusTasks.find((task) => task.id === item.task_id)?.title || "",
          }));
        const approved = daySubs.filter((item) => item.status === "approved");
        const pending = daySubs.filter((item) => item.status === "pending");
        const rejected = daySubs.filter((item) => item.status === "rejected");
        const approvedBonus = dayBonus.filter((item) => item.status === "approved");
        const pendingBonus = dayBonus.filter((item) => item.status === "pending");
        const approvedMinutes = approved.reduce((sum, item) => sum + item.duration_minutes, 0);
        const pendingMinutesValue = pending.reduce((sum, item) => sum + item.duration_minutes, 0);
        const rejectedMinutes = rejected.reduce((sum, item) => sum + item.duration_minutes, 0);
        const goalMinutes = goalMinutesForDate(dateKey);
        day.segments = approvedMinutes ? [{ s: 0, e: approvedMinutes }] : [];
        day.status = {
          goalMinutes,
          approvedMinutes,
          pendingMinutes: pendingMinutesValue,
          rejectedMinutes,
          approvedCount: approved.length,
          pendingCount: pending.length,
          rejectedCount: rejected.length,
          progressState: approvedMinutes > goalMinutes ? "over" : approvedMinutes >= goalMinutes ? "goal" : approvedMinutes > 0 ? "growing" : "locked",
          rewardState: !day.checkin.stamped
            ? "idle"
            : approvedMinutes > goalMinutes
              ? "over"
              : approvedMinutes >= goalMinutes
                ? "earned"
                : pendingMinutesValue > 0
                  ? "pending"
                  : "muted",
          bonusReward: approvedBonus.reduce((sum, item) => sum + item.reward_total, 0),
          bonusApprovedCount: approvedBonus.length,
          bonusPendingCount: pendingBonus.length,
          bonusLatestTitle: approvedBonus[0]?.task_title || pendingBonus[0]?.task_title || "",
        };
        let comboDays = 0;
        if (day.checkin.stamped) {
          comboDays = 1;
          let cursor = new Date(`${dateKey}T12:00:00`);
          while (true) {
            cursor.setDate(cursor.getDate() - 1);
            const prevKey = localDateKey(cursor);
            const prev = normalizeDay(history[prevKey]);
            if (!prev.checkin.stamped || prev.checkin.emoji !== day.checkin.emoji) break;
            comboDays += 1;
          }
        }
        const baseReward = day.checkin.stamped && approvedMinutes >= goalMinutes ? STAMP_REWARD_BASE * day.checkin.rarity : 0;
        const comboBonus = comboDays > 1 && baseReward ? baseReward * (2 ** (comboDays - 1)) : 0;
        const overBoost = approvedMinutes > goalMinutes && baseReward ? Math.round(baseReward * 0.4 + comboBonus * 0.25) : 0;
        day.checkin.comboDays = comboDays;
        day.checkin.comboBonusXp = comboBonus;
        day.checkin.rewardXp = baseReward + comboBonus + overBoost;
        let xp = 0;
        if (approvedMinutes > 0) {
          xp += computeStudyXp(approvedMinutes);
          if ((day.checkin.moodNote || "").trim() || (day.checkin.progressNote || "").trim()) xp += JOURNAL_XP;
          if (approvedMinutes >= goalMinutes) xp += GOAL_BONUS_XP;
          if (approvedMinutes > goalMinutes) xp += OVERACHIEVE_BONUS_XP;
          xp += day.checkin.rewardXp;
        }
        xp += day.status.bonusReward;
        day.xpEarned = xp;
        history[dateKey] = day;
        totalXp += xp;
        if (day.checkin.stamped) stampedDates.push(dateKey);
        if (approvedMinutes > 0 || pendingMinutesValue > 0 || day.checkin.stamped) lastDate = dateKey;
      });

    let streak = 0;
    if (stampedDates.length) {
      const set = new Set(stampedDates);
      let cursor = new Date(`${stampedDates.sort().slice(-1)[0]}T12:00:00`);
      while (set.has(localDateKey(cursor))) {
        streak += 1;
        cursor.setDate(cursor.getDate() - 1);
      }
    }
    return normalizeState({ totalXp, streak, lastDate, history });
  }

  function localSummary(store, user) {
    const state = localHydrateState(store, user.id);
    const keys = Object.keys(state.history || {}).sort((left, right) => right.localeCompare(left));
    const recentDays = keys.slice(0, 7).map((dateKey) => {
      const day = normalizeDay(state.history[dateKey]);
      return {
        date: dateKey,
        xpEarned: day.xpEarned || 0,
        studyMinutes: approvedMinutes(day),
        taskCount: countDoneTasks(day),
        mood: day.mood || 0,
        top: day.journal.top || "",
        stuck: day.journal.stuck || "",
        progressState: day.status.progressState,
        rewardState: day.status.rewardState,
      };
    });
    return {
      totalXp: state.totalXp,
      streak: state.streak,
      level: getLevelInfo(state.totalXp).current,
      daysRecorded: keys.length,
      lastActiveDate: state.lastDate,
      totalMinutes: recentDays.reduce((sum, item) => sum + (item.studyMinutes || 0), 0),
      recentDays,
    };
  }

  function localError(status, error) {
    const err = new Error(error);
    err.status = status;
    err.payload = { error };
    throw err;
  }

  async function localApi(path, options = {}) {
    const method = (options.method || "GET").toUpperCase();
    const body = options.body || {};
    const store = loadLocalBackend();
    const currentUser = localCurrentUser(store);
    const currentPublicUser = currentUser ? localPublicUser(currentUser) : null;

    if (path === "/api/me" && method === "GET") {
      if (!currentUser) localError(401, "未登录");
      return { authenticated: true, user: currentPublicUser };
    }

    if (path === "/api/auth/register" && method === "POST") {
      const username = String(body.username || "").trim();
      const displayName = String(body.display_name || "").trim() || username;
      const password = String(body.password || "");
      if (!/^[A-Za-z0-9_-]{3,24}$/.test(username)) localError(400, "用户名需为 3-24 位字母、数字、下划线或减号");
      if (password.length < 6) localError(400, "密码至少 6 位");
      if (store.users.some((item) => item.username === username)) localError(409, "用户名已存在");
      const now = currentIso();
      const user = {
        id: store.nextUserId,
        username,
        display_name: displayName.slice(0, 32),
        password,
        is_admin: false,
        created_at: now,
        last_login_at: now,
      };
      store.nextUserId += 1;
      store.currentUserId = user.id;
      store.users.push(user);
      localSaveRawState(store, user.id, defaultState());
      saveLocalBackend(store);
      return { message: "注册成功", user: localPublicUser(user) };
    }

    if (path === "/api/auth/login" && method === "POST") {
      const username = String(body.username || "").trim();
      const password = String(body.password || "");
      const user = store.users.find((item) => item.username === username && item.password === password);
      if (!user) localError(401, "用户名或密码错误");
      user.last_login_at = currentIso();
      store.currentUserId = user.id;
      saveLocalBackend(store);
      return { message: "登录成功", user: localPublicUser(user) };
    }

    if (path === "/api/auth/logout" && method === "POST") {
      store.currentUserId = null;
      saveLocalBackend(store);
      return { message: "已退出登录" };
    }

    if (!currentUser) localError(401, "未登录");

    if (path === "/api/state" && method === "GET") {
      return { state: localHydrateState(store, currentUser.id) };
    }

    if (path === "/api/state" && method === "PUT") {
      const current = localRawState(store, currentUser.id);
      const incoming = normalizeState(body.state || {});
      const merged = normalizeState(current);
      Object.entries(incoming.history || {}).forEach(([dateKey, incomingDay]) => {
        const existing = normalizeDay(merged.history[dateKey] || defaultDay());
        existing.tasks = incomingDay.tasks;
        existing.journal = incomingDay.journal;
        existing.mood = incomingDay.mood;
        existing.energy = incomingDay.energy;
        existing.rewardShown = incomingDay.rewardShown;
        merged.history[dateKey] = existing;
      });
      localSaveRawState(store, currentUser.id, merged);
      saveLocalBackend(store);
      return { message: "保存成功", state: localHydrateState(store, currentUser.id) };
    }

    if (path === "/api/checkin" && method === "POST") {
      if (currentUser.is_admin) localError(403, "小和不会在这里签到");
      const dateKey = String(body.date_key || currentDayKey());
      const raw = localRawState(store, currentUser.id);
      const day = normalizeDay(raw.history[dateKey] || defaultDay());
      const todaySubs = store.submissions.filter((item) => item.user_id === currentUser.id && item.date_key === dateKey);
      const eligibleMinutes = todaySubs.reduce((sum, item) => sum + item.duration_minutes, 0);
      if (eligibleMinutes < goalMinutesForDate(dateKey)) localError(400, "完成当日目标时长对应的学习提交后，才可以盖章");
      if (!day.checkin.stamped) {
        const stamp = pickLocalStamp();
        day.checkin = {
          stamped: true,
          emoji: stamp.emoji,
          rarity: stamp.rarity,
          label: stamp.label,
          stampedAt: currentIso(),
          moodNote: String(body.mood_note || "").slice(0, 120),
          progressNote: String(body.progress_note || "").slice(0, 120),
          comboBonusXp: 0,
          comboDays: 1,
          rewardXp: 0,
        };
        day.journal.feel = day.checkin.moodNote;
        day.journal.top = day.checkin.progressNote;
        raw.history[dateKey] = day;
        localSaveRawState(store, currentUser.id, raw);
        saveLocalBackend(store);
      }
      const state = localHydrateState(store, currentUser.id);
      return { message: "签到成功", date_key: dateKey, checkin: state.history[dateKey].checkin, state };
    }

    if (path === "/api/submissions/mine" && method === "GET") {
      const submissions = store.submissions
        .filter((item) => item.user_id === currentUser.id)
        .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
      return { submissions };
    }

    if (path === "/api/bonus-tasks" && method === "GET") {
      const tasks = (currentUser.is_admin ? store.bonusTasks : store.bonusTasks.filter((item) => item.active)).slice().sort((left, right) => right.id - left.id);
      const submissions = store.bonusTaskSubmissions
        .filter((item) => (currentUser.is_admin ? true : item.user_id === currentUser.id))
        .map((item) => ({
          ...item,
          task: store.bonusTasks.find((task) => task.id === item.task_id) || null,
          user: currentUser.is_admin ? localPublicUser(localUserById(store, item.user_id)) : undefined,
          evidence_url: item.evidence_url,
        }))
        .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
      return { tasks, submissions, state: localHydrateState(store, currentUser.id) };
    }

    if (path === "/api/submissions" && method === "POST") {
      if (currentUser.is_admin) localError(403, "小和不会在这里提交学习证明");
      const submission = {
        id: store.nextSubmissionId,
        user_id: currentUser.id,
        date_key: String(body.date_key || currentDayKey()),
        duration_minutes: clampInt(body.duration_minutes, 1, 720, 0),
        note: String(body.note || "").slice(0, 500),
        status: "pending",
        admin_note: "",
        created_at: currentIso(),
        reviewed_at: null,
        reviewed_by: null,
        evidence_name: String(body.evidence_name || "proof"),
        evidence_mime: String((body.evidence_data || "").split(";")[0].replace("data:", "") || "application/octet-stream"),
        evidence_url: String(body.evidence_data || ""),
      };
      if (!submission.duration_minutes) localError(400, "学习时长至少 1 分钟");
      if (!submission.evidence_url) localError(400, "每次上传都需要附上凭证");
      store.nextSubmissionId += 1;
      store.submissions.push(submission);
      saveLocalBackend(store);
      return { submission };
    }

    if (path === "/api/bonus-task-submissions" && method === "POST") {
      if (currentUser.is_admin) localError(403, "小和不会在这里提交附加任务");
      const taskId = clampInt(body.task_id, 1, 10000000, 0);
      const task = store.bonusTasks.find((item) => item.id === taskId && item.active);
      if (!task) localError(404, "附加任务不存在");
      const completedDateKey = String(body.completed_date_key || currentDayKey());
      const state = localHydrateState(store, currentUser.id);
      const day = normalizeDay(state.history[completedDateKey]);
      if (!day.checkin.stamped) localError(400, "盖章之后才会解锁附加任务");
      const evidenceUrl = String(body.evidence_data || "");
      if (!evidenceUrl) localError(400, "附加任务提交也需要附上凭证");
      const submission = {
        id: store.nextBonusSubmissionId,
        task_id: taskId,
        user_id: currentUser.id,
        completed_date_key: completedDateKey,
        note: String(body.note || "").slice(0, 500),
        status: "pending",
        admin_note: "",
        created_at: currentIso(),
        reviewed_at: null,
        reviewed_by: null,
        reward_total: 0,
        speed_tier: "",
        speed_multiplier: 1,
        evidence_name: String(body.evidence_name || "proof"),
        evidence_mime: String((body.evidence_data || "").split(";")[0].replace("data:", "") || "application/octet-stream"),
        evidence_url: evidenceUrl,
      };
      store.nextBonusSubmissionId += 1;
      store.bonusTaskSubmissions.push(submission);
      saveLocalBackend(store);
      return { submission: { ...submission, task } };
    }

    if (path === "/api/me" && method === "PUT") {
      const displayName = String(body.display_name || "").trim();
      const currentPassword = String(body.current_password || "");
      const newPassword = String(body.new_password || "");
      if (!displayName && !newPassword) localError(400, "没有可更新的内容");
      if (displayName) currentUser.display_name = displayName.slice(0, 32);
      if (newPassword) {
        if (!currentPassword) localError(400, "修改密码需要输入当前密码");
        if (currentUser.password !== currentPassword) localError(400, "当前密码不正确");
        if (newPassword.length < 6) localError(400, "新密码至少 6 位");
        currentUser.password = newPassword;
      }
      saveLocalBackend(store);
      return { message: "账号信息已更新", user: localPublicUser(currentUser) };
    }

    if (path === "/api/admin/users" && method === "GET") {
      if (!currentUser.is_admin) localError(403, "需要管理员权限");
      const users = store.users
        .filter((item) => !item.is_admin)
        .map((user) => {
          const summary = localSummary(store, user);
          return {
            user: localPublicUser(user),
            summary: {
              totalXp: summary.totalXp,
              streak: summary.streak,
              level: summary.level,
              daysRecorded: summary.daysRecorded,
              lastActiveDate: summary.lastActiveDate,
              totalMinutes: summary.totalMinutes,
            },
            recent_days: summary.recentDays,
            pending_count: store.submissions.filter((item) => item.user_id === user.id && item.status === "pending").length,
          };
        });
      return { users };
    }

    if (path.startsWith("/api/admin/users/") && method === "GET") {
      if (!currentUser.is_admin) localError(403, "需要管理员权限");
      const userId = clampInt(path.split("/").pop(), 1, 10000000, 0);
      const target = localUserById(store, userId);
      if (!target) localError(404, "用户不存在");
      const summary = localSummary(store, target);
      return {
        user: localPublicUser(target),
        summary,
        state: localHydrateState(store, target.id),
        submissions: store.submissions.filter((item) => item.user_id === target.id).sort((left, right) => String(right.created_at).localeCompare(String(left.created_at))),
        bonus_submissions: store.bonusTaskSubmissions
          .filter((item) => item.user_id === target.id)
          .map((item) => ({ ...item, task: store.bonusTasks.find((task) => task.id === item.task_id) || null, user: localPublicUser(target) }))
          .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at))),
      };
    }

    if (path === "/api/admin/bonus-tasks" && method === "GET") {
      if (!currentUser.is_admin) localError(403, "需要管理员权限");
      return {
        tasks: store.bonusTasks.slice().sort((left, right) => right.id - left.id),
        submissions: store.bonusTaskSubmissions
          .map((item) => ({
            ...item,
            task: store.bonusTasks.find((task) => task.id === item.task_id) || null,
            user: localPublicUser(localUserById(store, item.user_id)),
          }))
          .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at))),
      };
    }

    if (path === "/api/admin/bonus-tasks" && method === "POST") {
      if (!currentUser.is_admin) localError(403, "需要管理员权限");
      const title = String(body.title || "").trim().slice(0, 80);
      if (!title) localError(400, "附加任务要有标题");
      const task = {
        id: store.nextBonusTaskId,
        title,
        description: String(body.description || "").slice(0, 500),
        difficulty: clampInt(body.difficulty, 1, 5, 1),
        target_days: clampInt(body.target_days, 1, 30, 3),
        active: true,
        created_at: currentIso(),
      };
      store.nextBonusTaskId += 1;
      store.bonusTasks.push(task);
      saveLocalBackend(store);
      return { task };
    }

    if (path.startsWith("/api/admin/submissions/") && path.endsWith("/review") && method === "POST") {
      if (!currentUser.is_admin) localError(403, "需要管理员权限");
      const parts = path.split("/");
      const submissionId = clampInt(parts[4], 1, 10000000, 0);
      const submission = store.submissions.find((item) => item.id === submissionId);
      if (!submission) localError(404, "提交不存在");
      const action = String(body.action || "").trim().toLowerCase();
      if (!["approve", "reject"].includes(action)) localError(400, "action 只能是 approve 或 reject");
      submission.status = action === "approve" ? "approved" : "rejected";
      submission.admin_note = String(body.admin_note || "").slice(0, 500);
      submission.reviewed_at = currentIso();
      submission.reviewed_by = currentUser.id;
      saveLocalBackend(store);
      return {
        submission: {
          ...submission,
          user: localPublicUser(localUserById(store, submission.user_id)),
        },
      };
    }

    if (path.startsWith("/api/admin/bonus-task-submissions/") && path.endsWith("/review") && method === "POST") {
      if (!currentUser.is_admin) localError(403, "需要管理员权限");
      const parts = path.split("/");
      const submissionId = clampInt(parts[4], 1, 10000000, 0);
      const submission = store.bonusTaskSubmissions.find((item) => item.id === submissionId);
      if (!submission) localError(404, "提交不存在");
      const task = store.bonusTasks.find((item) => item.id === submission.task_id);
      const action = String(body.action || "").trim().toLowerCase();
      if (!["approve", "reject"].includes(action)) localError(400, "action 只能是 approve 或 reject");
      submission.status = action === "approve" ? "approved" : "rejected";
      submission.admin_note = String(body.admin_note || "").slice(0, 500);
      submission.reviewed_at = currentIso();
      submission.reviewed_by = currentUser.id;
      if (submission.status === "approved" && task) {
        const elapsed = Math.max(0, (new Date(submission.created_at).getTime() - new Date(task.created_at).getTime()) / 86400000);
        if (elapsed <= Math.max(0.5, task.target_days * 0.5)) {
          submission.speed_tier = "闪电完成";
          submission.speed_multiplier = 1.8;
        } else if (elapsed <= task.target_days) {
          submission.speed_tier = "稳稳拿下";
          submission.speed_multiplier = 1.35;
        } else {
          submission.speed_tier = "坚持完成";
          submission.speed_multiplier = 1.0;
        }
        submission.reward_total = Math.round((80 + task.difficulty * 35) * submission.speed_multiplier);
      } else {
        submission.speed_tier = "";
        submission.speed_multiplier = 1;
        submission.reward_total = 0;
      }
      saveLocalBackend(store);
      return { submission: { ...submission, task, user: localPublicUser(localUserById(store, submission.user_id)) } };
    }

    localError(404, "接口不存在");
  }

  function api(path, options = {}) {
    if (app.transport === "local") {
      return Promise.resolve().then(() => localApi(path, options));
    }
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
      return "当前没有连上后端，已经切到本地测试模式。这里的账号和记录会保存在当前浏览器里。";
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
    const [stateData, submissionData, bonusData] = await Promise.all([
      api("/api/state"),
      api("/api/submissions/mine"),
      api("/api/bonus-tasks"),
    ]);
    mergeServerState(stateData.state, { animate: !silent && app.booted });
    app.submissions = Array.isArray(submissionData.submissions) ? submissionData.submissions : [];
    app.bonusTasks = Array.isArray(bonusData.tasks) ? bonusData.tasks : [];
    app.bonusSubmissions = Array.isArray(bonusData.submissions) ? bonusData.submissions : [];
    renderLearner();
  }

  async function refreshAdminBundle(silent = false) {
    const [data, bonusData] = await Promise.all([api("/api/admin/users"), api("/api/admin/bonus-tasks")]);
    app.adminUsers = Array.isArray(data.users) ? data.users : [];
    app.adminBonusTasks = Array.isArray(bonusData.tasks) ? bonusData.tasks : [];
    app.adminBonusSubmissions = Array.isArray(bonusData.submissions) ? bonusData.submissions : [];
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

  function shouldPromptCheckin(dateKey = currentDayKey()) {
    if (!app.user || app.user.is_admin) return false;
    const day = ensureDay(dateKey);
    return !day.checkin.stamped && submittedMinutes(day) >= goalMinutesForDate(dateKey);
  }

  function openCheckinModal(dateKey = currentDayKey()) {
    app.pendingCheckinDateKey = dateKey;
    app.dismissedCheckinDateKey = null;
    document.getElementById("checkin-mood").value = "";
    document.getElementById("checkin-progress").value = "";
    document.getElementById("checkin-modal").classList.remove("mq-hidden");
  }

  function closeCheckinModal() {
    if (app.pendingCheckinDateKey) {
      app.dismissedCheckinDateKey = app.pendingCheckinDateKey;
    }
    app.pendingCheckinDateKey = null;
    document.getElementById("checkin-modal").classList.add("mq-hidden");
  }

  async function submitCheckin(event) {
    event.preventDefault();
    const dateKey = app.pendingCheckinDateKey || currentDayKey();
    app.checkinInFlight = true;
    try {
      const data = await api("/api/checkin", {
        method: "POST",
        body: {
          date_key: dateKey,
          mood_note: document.getElementById("checkin-mood").value.trim(),
          progress_note: document.getElementById("checkin-progress").value.trim(),
        },
      });
      mergeServerState(data.state, { animate: false });
      app.latestStampDate = dateKey;
      playStampSound();
      app.pendingCheckinDateKey = null;
      app.dismissedCheckinDateKey = null;
      document.getElementById("checkin-modal").classList.add("mq-hidden");
      renderLearner();
      showToast(`${data.checkin?.emoji || "🫶"} 今天的印章盖好了，等小和点头后奖励会落下来`);
    } catch (error) {
      showToast(error.payload?.error || "盖章失败", "error");
    } finally {
      app.checkinInFlight = false;
    }
  }

  function maybePromptCheckin() {
    if (app.checkinInFlight || app.pendingCheckinDateKey) return;
    const dateKey = currentDayKey();
    if (app.dismissedCheckinDateKey === dateKey) return;
    if (shouldPromptCheckin(dateKey)) {
      openCheckinModal(dateKey);
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
      app.dismissedCheckinDateKey = null;
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
    const goal = day?.status?.goalMinutes || goalMinutesForDate();
    if (approved > goal) return "今天已经闪金啦，圆环正在冒光。";
    if (approved >= goal) return "今天的目标稳稳完成，小和看到会很高兴。";
    if (pending > 0) return "证明已经送出去了，先等小和回信。";
    if (day.checkin.stamped) return "章先盖上了，奖励会在审核通过后落下来。";
    return `今天的盖章目标是 ${goal} 分钟，送出够量的学习证明后就能盖章。`;
  }

  function renderHero() {
    const { current, next, index } = getLevelInfo(app.state.totalXp);
    const ratio = next ? Math.max(0, Math.min(1, (app.state.totalXp - current.xp) / (next.xp - current.xp))) : 1;
    const today = ensureDay();
    document.getElementById("hero-avatar").textContent = LEVEL_AVATARS[index] || LEVEL_AVATARS[LEVEL_AVATARS.length - 1];
    document.getElementById("hero-level").textContent = `LV.${current.level}`;
    document.getElementById("hero-name").textContent = app.user?.display_name || "泡面侠";
    document.getElementById("hero-title").textContent = statusCopy(today);
    document.getElementById("xp-total").textContent = `${app.state.totalXp} 块泡面`;
    document.getElementById("xp-next").textContent = next ? `距离 Lv.${next.level} 还差 ${Math.max(0, next.xp - app.state.totalXp)} 块泡面` : "已经把这个世界刷到顶了";
    document.getElementById("xp-fill").style.width = `${Math.round(ratio * 100)}%`;
    const streak = document.getElementById("hero-streak");
    streak.classList.toggle("mq-hidden", app.state.streak <= 1);
    streak.textContent = `连签 ${app.state.streak} 天`;
    document.getElementById("learner-role-pill").textContent = "泡面侠";

    document.getElementById("hero-metrics").innerHTML = [
      renderMetricCard("今日已认可", formatMinutes(approvedMinutes(today)), approvedMinutes(today) >= (today.status.goalMinutes || goalMinutesForDate()) ? "green" : ""),
      renderMetricCard("待审核", pendingMinutes(today) ? formatMinutes(pendingMinutes(today)) : "0 分钟", pendingMinutes(today) ? "gray" : ""),
      renderMetricCard("今日泡面", `+${today.xpEarned} 块泡面`, approvedMinutes(today) ? "gold" : "gray"),
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
    const goal = day?.status?.goalMinutes || goalMinutesForDate();
    if (!approved) return CIRCUMFERENCE;
    const percent = Math.max(0, Math.min(1, approved / goal));
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

  function renderBonusTasks(day) {
    if (!day.checkin.stamped) {
      return `<div class="mq-empty-card locked">今天还没盖章，附加任务会在盖章之后解锁。</div>`;
    }
    if (!app.bonusTasks.length) {
      return `<div class="mq-empty-card">小和还没发布新的附加任务。先把今天的章贴好，等她发新挑战。</div>`;
    }
    return app.bonusTasks
      .map((task) => {
        const related = app.bonusSubmissions.filter((item) => item.task_id === task.id);
        const latest = related[0];
        const formId = `bonus-form-${task.id}`;
        return `
          <article class="mq-bonus-card">
            <div class="mq-bonus-top">
              <strong>${escapeHtml(task.title)}</strong>
              <span class="mq-pill">难度 ${task.difficulty}/5</span>
            </div>
            <p class="mq-proof-note">${escapeHtml(task.description || "小和给你留了一份新的附加挑战。")}</p>
            <div class="mq-bonus-meta">
              <span>建议在 ${task.target_days} 天内完成</span>
              <span>通过后会掉很多泡面</span>
            </div>
            ${
              latest
                ? `
                  <div class="mq-bonus-meta">
                    <span>${submissionStatusLabel(latest.status)}</span>
                    <span>${latest.reward_total ? `+${latest.reward_total} 块泡面` : "等待结算"}</span>
                  </div>
                  ${latest.admin_note ? `<div class="mq-proof-note">小和留言：${escapeHtml(latest.admin_note)}</div>` : ""}
                `
                : `
                  <form id="${formId}" class="mq-bonus-form" data-bonus-task-id="${task.id}">
                    <textarea name="note" placeholder="写一句你是怎么完成这份附加任务的。"></textarea>
                    <input name="evidence" type="file" accept="image/*,.pdf" required>
                    <button type="submit" class="mq-primary-btn">提交附加任务凭证</button>
                  </form>
                `
            }
          </article>
        `;
      })
      .join("");
  }

  function renderLineChart(days) {
    const points = days.length ? days : [{ date: currentDayKey(), studyMinutes: 0, xpEarned: 0 }];
    const width = 420;
    const height = 220;
    const pad = 24;
    const maxValue = Math.max(1, ...points.map((item) => item.studyMinutes || 0));
    const coordinates = points
      .map((item, index) => {
        const x = pad + (index * (width - pad * 2)) / Math.max(1, points.length - 1);
        const y = height - pad - ((item.studyMinutes || 0) / maxValue) * (height - pad * 2);
        return { x, y, item };
      });
    const polyline = coordinates.map((point) => `${point.x},${point.y}`).join(" ");
    const dots = coordinates
      .map(
        (point) => `
          <circle cx="${point.x}" cy="${point.y}" r="4" fill="#f5c842"></circle>
          <text x="${point.x}" y="${point.y - 10}" text-anchor="middle" fill="#b7c2d8" font-size="11">${point.item.studyMinutes || 0}m</text>
        `,
      )
      .join("");
    const labels = points
      .map((item) => `<span>${escapeHtml(item.date.slice(5))}</span>`)
      .join("");
    return `
      <div class="mq-line-chart">
        <svg viewBox="0 0 ${width} ${height}" aria-hidden="true">
          <rect x="0" y="0" width="${width}" height="${height}" rx="18" fill="rgba(255,255,255,0.02)"></rect>
          <polyline points="${polyline}" fill="none" stroke="#f5c842" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></polyline>
          ${dots}
        </svg>
        <div class="mq-chart-labels">${labels}</div>
      </div>
    `;
  }

  function renderDonutChart(completed, pending, over) {
    const total = Math.max(1, completed + pending + over);
    const circumference = 2 * Math.PI * 54;
    const slices = [
      { value: completed, color: "#4ade80" },
      { value: over, color: "#f5c842" },
      { value: pending, color: "#94a3b8" },
    ];
    let offset = 0;
    const circles = slices
      .map((slice) => {
        const length = (slice.value / total) * circumference;
        const node = `<circle cx="90" cy="90" r="54" fill="none" stroke="${slice.color}" stroke-width="18" stroke-dasharray="${length} ${circumference - length}" stroke-dashoffset="${-offset}" transform="rotate(-90 90 90)"></circle>`;
        offset += length;
        return node;
      })
      .join("");
    return `
      <div class="mq-donut-chart">
        <svg viewBox="0 0 180 180" aria-hidden="true">
          <circle cx="90" cy="90" r="54" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="18"></circle>
          ${circles}
          <text x="90" y="86" text-anchor="middle" fill="#eef2ff" font-size="20" font-weight="700">${completed + over}</text>
          <text x="90" y="108" text-anchor="middle" fill="#b7c2d8" font-size="12">达标天数</text>
        </svg>
      </div>
    `;
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
    const goal = day.status.goalMinutes || goalMinutesForDate();
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
              ${renderMetricCard("今日目标", `${goal} 分钟`, goal > DAILY_GOAL_MINUTES ? "gold" : "")}
              ${renderMetricCard("待审核", pending ? formatMinutes(pending) : "0 分钟", pending ? "gray" : "")}
              ${renderMetricCard("签到奖励", day.checkin.rewardXp ? `+${day.checkin.rewardXp} 块泡面` : "暂未结算", day.checkin.rewardXp ? "gold" : "gray")}
              ${renderMetricCard("今日总泡面", `+${day.xpEarned} 块泡面`, approved ? "green" : "gray")}
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
          <p class="mq-helper">今天的目标时长满足后，就会弹出盖章窗口。通过审核前，奖励会先静静等待。</p>
        </section>
      </div>

      <div class="mq-dashboard-grid lower">
        <section class="mq-panel-card">
          <div class="mq-panel-head">
            <div>
              <p class="mq-panel-kicker">bonus quest</p>
              <h2>盖章后的附加任务</h2>
            </div>
            <span class="mq-soft-note">${day.checkin.stamped ? "小和发布的附加挑战会在这里出现" : `先把今天的 ${goal} 分钟目标送出来，再来解锁这里`}</span>
          </div>
          <div class="mq-bonus-list">${renderBonusTasks(day)}</div>
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
                  <span>+${day.xpEarned} 块泡面</span>
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
    const recentChartDays = days
      .slice(0, 7)
      .map(([date, rawDay]) => ({ date, studyMinutes: approvedMinutes(normalizeDay(rawDay)), xpEarned: normalizeDay(rawDay).xpEarned || 0 }))
      .reverse();
    const goalDays = days.filter(([, rawDay]) => normalizeDay(rawDay).status.progressState === "goal").length;
    const pendingDays = days.filter(([, rawDay]) => pendingMinutes(normalizeDay(rawDay)) > 0).length;
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
            ${renderMetricCard("总泡面", `${app.state.totalXp} 块泡面`, app.state.totalXp ? "green" : "gray")}
          </div>
        </section>

        <section class="mq-panel-card">
          <div class="mq-panel-head">
            <div><p class="mq-panel-kicker">cute summary</p><h2>小和会看到的你</h2></div>
          </div>
          <div class="mq-story-list">
            <div class="mq-story-line">最近一次盖章：${app.state.lastDate ? formatDate(app.state.lastDate) : "还没有"}</div>
            <div class="mq-story-line">连续签到：${app.state.streak} 天</div>
            <div class="mq-story-line">最近 7 天里，只要小和点头，泡面条就会跟着冲刺。</div>
          </div>
        </section>
      </div>

      <div class="mq-chart-grid">
        <section class="mq-chart-card">
          <h3>最近 7 天学习折线</h3>
          ${renderLineChart(recentChartDays)}
        </section>
        <section class="mq-chart-card">
          <h3>达标状态分布</h3>
          ${renderDonutChart(goalDays, pendingDays, overDays)}
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
    const learnerChip = document.getElementById("learner-display-name");
    if (learnerChip) learnerChip.textContent = app.user?.display_name || "泡面侠";
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
    document.querySelectorAll("[data-bonus-task-id]").forEach((form) => {
      form.addEventListener("submit", handleBonusSubmission);
    });
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
    void maybePromptCheckin();
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
    const pendingBonus = (app.adminBonusSubmissions || []).filter((item) => item.status === "pending");
    const latestTasks = (app.adminBonusTasks || []).slice(0, 3)
      .map((task) => `<div class="mq-proof-note">${escapeHtml(task.title)} · 难度 ${task.difficulty}/5 · ${task.target_days} 天</div>`)
      .join("");
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
      <section class="mq-panel-card">
        <div class="mq-panel-head">
          <div><p class="mq-panel-kicker">bonus mission desk</p><h2>附加任务发布台</h2></div>
          <span class="mq-soft-note">${pendingBonus.length ? `${pendingBonus.length} 份附加任务提交正在等你` : "新的附加任务会从这里发出去"}</span>
        </div>
        <form id="admin-bonus-form" class="mq-proof-form">
          <label>任务标题<input name="title" placeholder="例如：把今天最卡的题型做成一页小总结" required></label>
          <label>目标天数<input name="target_days" type="number" min="1" max="30" value="3" required></label>
          <label class="wide">任务说明<textarea name="description" rows="3" placeholder="告诉泡面侠这份附加任务想练什么。"></textarea></label>
          <label>难度<input name="difficulty" type="number" min="1" max="5" value="3" required></label>
          <div class="wide"><button type="submit" class="mq-primary-btn">发布附加任务</button></div>
        </form>
        <div class="mq-bonus-admin-list">${latestTasks || `<div class="mq-empty-card">还没有发布过附加任务。</div>`}</div>
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
    const bonusSubmissions = Array.isArray(detail.bonus_submissions) ? detail.bonus_submissions : [];
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
    const bonusCards = bonusSubmissions.length
      ? bonusSubmissions
          .map((item) => `
            <article class="mq-bonus-submission-card">
              <div class="mq-bonus-top">
                <strong>${escapeHtml(item.task?.title || "附加任务")}</strong>
                <span class="mq-proof-badge ${submissionTone(item.status)}">${escapeHtml(submissionStatusLabel(item.status))}</span>
              </div>
              <div class="mq-bonus-meta">
                <span>难度 ${item.task?.difficulty || 1}/5 · 建议 ${item.task?.target_days || 3} 天</span>
                <span>${item.reward_total ? `+${item.reward_total} 块泡面` : "等待结算"}</span>
              </div>
              ${item.note ? `<div class="mq-proof-note">${escapeHtml(item.note)}</div>` : ""}
              <div class="mq-proof-actions"><a href="${item.evidence_url}" target="_blank" rel="noreferrer">查看附加任务凭证</a></div>
              ${
                item.status === "pending"
                  ? `
                    <div class="mq-admin-review-actions">
                      <input id="bonus-review-note-${item.id}" placeholder="给这份附加任务留一句话（可选）">
                      <button type="button" class="mq-ghost-btn" data-bonus-review-action="reject" data-bonus-submission-id="${item.id}">再补一点</button>
                      <button type="button" class="mq-primary-btn" data-bonus-review-action="approve" data-bonus-submission-id="${item.id}">点头通过</button>
                    </div>
                  `
                  : item.admin_note
                    ? `<div class="mq-proof-note">小和留言：${escapeHtml(item.admin_note)}</div>`
                    : ""
              }
            </article>
          `)
          .join("")
      : `<div class="mq-empty-card">这位泡面侠还没送来附加任务凭证。</div>`;

    const recentDays = (summary.recentDays || [])
      .map(
        (item) => `
          <div class="mq-admin-activity-row">
            <strong>${escapeHtml(item.date)}</strong>
            <span>${formatMinutes(item.studyMinutes || 0)} · +${item.xpEarned || 0} 块泡面</span>
            <div class="mq-admin-activity-bar">
              <div class="mq-admin-activity-fill ${item.progressState === "over" ? "gold" : item.progressState === "goal" ? "green" : ""}" style="width:${Math.min(100, Math.round(((item.studyMinutes || 0) / goalMinutesForDate(item.date)) * 100))}%"></div>
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
            <span class="mq-pill">${summary.totalXp || 0} 块泡面</span>
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
              ${renderMetricCard("今日泡面", `+${day.xpEarned} 块泡面`, approvedMinutes(day) ? "gold" : "gray")}
              ${renderMetricCard("签到印章", day.checkin.stamped ? `${day.checkin.emoji} ${day.checkin.label || ""}` : "未盖章", day.checkin.rewardXp ? "green" : "gray")}
            </div>
            <div class="mq-story-list">
              <div class="mq-story-line">今日目标：${day.status.goalMinutes || goalMinutesForDate(snapshotKey)} 分钟</div>
              <div class="mq-story-line">签到留言：${escapeHtml(day.checkin.moodNote || "还没有写")}</div>
              <div class="mq-story-line">进步留言：${escapeHtml(day.checkin.progressNote || "还没有写")}</div>
            </div>
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

        <section class="mq-panel-card">
          <div class="mq-panel-head">
            <div><p class="mq-panel-kicker">bonus review</p><h2>附加任务处理台</h2></div>
          </div>
          <div class="mq-admin-review-list">${bonusCards}</div>
        </section>
      </section>
    `;
  }

  function renderAdmin() {
    const adminChip = document.getElementById("admin-display-name");
    if (adminChip) adminChip.textContent = app.user?.display_name || "小和";
    renderAdminOverview();
    renderAdminQueue();
    renderAdminUserTabs();
    renderAdminFocus();
    const bonusForm = document.getElementById("admin-bonus-form");
    if (bonusForm) bonusForm.addEventListener("submit", handleCreateBonusTask);
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

  async function handleAdminBonusReview(action, submissionId) {
    const noteInput = document.getElementById(`bonus-review-note-${submissionId}`);
    const adminNote = noteInput ? noteInput.value.trim() : "";
    try {
      await api(`/api/admin/bonus-task-submissions/${submissionId}/review`, {
        method: "POST",
        body: { action, admin_note: adminNote },
      });
      await refreshAdminBundle(true);
      showToast(action === "approve" ? "小和给这份附加任务发了很多泡面！" : "小和想让这份附加任务再补一点");
    } catch (error) {
      showToast(error.payload?.error || "处理失败", "error");
    }
  }

  async function handleCreateBonusTask(event) {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await api("/api/admin/bonus-tasks", {
        method: "POST",
        body: {
          title: form.title.value.trim(),
          description: form.description.value.trim(),
          difficulty: clampInt(form.difficulty.value, 1, 5, 1),
          target_days: clampInt(form.target_days.value, 1, 30, 3),
        },
      });
      form.reset();
      form.target_days.value = "3";
      form.difficulty.value = "3";
      await refreshAdminBundle(true);
      showToast("新的附加任务已经发出去了");
    } catch (error) {
      showToast(error.payload?.error || "发布失败", "error");
    }
  }

  async function handleBonusSubmission(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const taskId = clampInt(form.dataset.bonusTaskId, 1, 10000000, 0);
    const file = form.evidence.files?.[0];
    if (!file) {
      showToast("附加任务也要附上凭证", "error");
      return;
    }
    try {
      const evidenceData = await fileToDataUrl(file);
      await api("/api/bonus-task-submissions", {
        method: "POST",
        body: {
          task_id: taskId,
          completed_date_key: currentDayKey(),
          note: form.note.value.trim(),
          evidence_name: file.name || "proof",
          evidence_data: evidenceData,
        },
      });
      await refreshLearnerBundle(true);
      showToast("附加任务已经送去给小和啦");
    } catch (error) {
      showToast(error.payload?.error || "提交失败", "error");
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
      particle.textContent = index % 5 === 0 ? `+${amount}泡面` : "泡面";
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
    document.getElementById("checkin-form").addEventListener("submit", submitCheckin);
    document.getElementById("checkin-later-btn").addEventListener("click", closeCheckinModal);
    document.querySelector(".mq-nav").addEventListener("click", (event) => {
      const button = event.target.closest("[data-view]");
      if (!button) return;
      app.learnerView = button.dataset.view;
      renderLearner();
    });

    const learnerRoot = document.getElementById("learner-app");
    learnerRoot.addEventListener("click", (event) => {
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
      if (actionButton) {
        const action = actionButton.dataset.reviewAction;
        const submissionId = clampInt(actionButton.dataset.submissionId, 0, 10000000, 0);
        void handleAdminReview(action, submissionId);
        return;
      }
      const bonusAction = event.target.closest("[data-bonus-review-action]");
      if (!bonusAction) return;
      void handleAdminBonusReview(
        bonusAction.dataset.bonusReviewAction,
        clampInt(bonusAction.dataset.bonusSubmissionId, 0, 10000000, 0),
      );
    });
  }

  async function boot() {
    bindStaticEvents();
    setAuthMode("login");
    showBoot("正在检查登录状态...");
    try {
      const data = await api("/api/me");
      app.backendReachable = true;
      app.transport = "remote";
      app.user = data.user;
      hideAuth();
      await afterLogin();
    } catch (error) {
      if (error.status === 401) {
        app.backendReachable = true;
        app.transport = "remote";
        showAuth("");
      } else {
        app.backendReachable = false;
        app.transport = "local";
        showAuth("当前是本地测试模式。你可以直接注册和登录，所有数据会保存在这个浏览器里。之后打开桌面客户端时，再切回真实同步。");
      }
    }
  }

  void boot();
})();
