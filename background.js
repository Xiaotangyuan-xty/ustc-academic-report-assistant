const ALARM_NAME = "ustc-report-monitor";
const ORIGIN = "https://yjs1.ustc.edu.cn";
const LIST_URL = `${ORIGIN}/gsapp/sys/xsbgglappustc/modules/xsbgxk/wxbgbgdz.do`;
const SELECT_URL = `${ORIGIN}/gsapp/sys/xsbgglappustc/xsbgxkController/selectBg.do`;
const PORTAL_URL = `${ORIGIN}/gsapp/sys/yjsemaphome/portal/index.do?forceCas=1`;
const EMAIL_URL = "http://127.0.0.1:17826/send";
const EMAIL_HEALTH_URL = "http://127.0.0.1:17826/health";
const PAGE_SIZE = 100;

const DEFAULT_SETTINGS = {
  monitoring: false,
  autoSubmit: false,
  locationKeyword: "高新",
  intervalSeconds: 30,
  maxAttempts: 3,
  retryDelaySeconds: 5
};

class AuthError extends Error {}

let activeCheck = null;

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function serverMessage(data, fallback = "网站返回了未知错误") {
  if (!data || typeof data !== "object") return fallback;
  return String(data.msg || data.description || data.message || fallback);
}

async function readJsonResponse(response) {
  if (response.status === 401 || response.status === 403) {
    throw new AuthError("登录状态已失效，请重新登录研究生综合服务平台");
  }
  if (!response.ok) {
    throw new Error(`网站请求失败（HTTP ${response.status}）`);
  }

  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new AuthError("网站未返回有效数据，可能是登录状态已失效");
  }
}

async function getState() {
  const data = await chrome.storage.local.get(null);
  return {
    settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) },
    records: data.records && typeof data.records === "object" ? data.records : {},
    lastReports: Array.isArray(data.lastReports) ? data.lastReports : [],
    logs: Array.isArray(data.logs) ? data.logs : [],
    lastCheckAt: data.lastCheckAt || null,
    lastStatus: data.lastStatus || "idle",
    lastError: data.lastError || "",
    lastSummary: data.lastSummary || null
  };
}

async function saveState(state) {
  await chrome.storage.local.set({
    settings: state.settings,
    records: state.records,
    lastReports: state.lastReports,
    logs: state.logs.slice(-100),
    lastCheckAt: state.lastCheckAt,
    lastStatus: state.lastStatus,
    lastError: state.lastError,
    lastSummary: state.lastSummary
  });
}

function addLog(state, type, title, message = "") {
  state.logs.push({ time: nowIso(), type, title, message });
  state.logs = state.logs.slice(-100);
}

async function notify(title, message, requireInteraction = false) {
  try {
    await chrome.notifications.create(`ustc-report-${Date.now()}-${Math.random()}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon128.png"),
      title,
      message: String(message).slice(0, 500),
      requireInteraction
    });
  } catch (error) {
    console.warn("无法显示浏览器通知", error);
  }
}

function normalizeReport(row) {
  return {
    id: String(row.BGBM || ""),
    title: String(row.BGTMZW || "未命名报告"),
    location: String(row.DD || ""),
    reportTime: String(row.BGSJ || "未提供"),
    deadline: String(row.JZSJ || "未提供"),
    capacity: Number(row.KXRS || 0),
    selected: Number(row.YXRS || 0),
    selectable: String(row.SFKXK) === "1"
  };
}

async function fetchReportPage(settings, pageNumber) {
  const querySetting = [
    {
      name: "DD",
      caption: "地点",
      linkOpt: "AND",
      builderList: "cbl_String",
      builder: "include",
      value: settings.locationKeyword
    },
    {
      name: "SFKXK",
      caption: "是否可选课",
      linkOpt: "AND",
      builderList: "cbl_String",
      builder: "equal",
      value: "1"
    },
    { name: "*order", value: "-BGSJ", linkOpt: "AND", builder: "equal" }
  ];

  if (pageNumber === 1) {
    querySetting.push({
      name: "_gotoFirstPage",
      value: true,
      linkOpt: "AND",
      builder: "equal"
    });
  }

  const response = await fetch(LIST_URL, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest"
    },
    body: new URLSearchParams({
      "*order": "-BGSJ",
      querySetting: JSON.stringify(querySetting),
      pageSize: String(PAGE_SIZE),
      pageNumber: String(pageNumber)
    })
  });
  const data = await readJsonResponse(response);
  if (String(data.code) !== "0") {
    throw new Error(serverMessage(data, "报告列表查询失败"));
  }

  const model = data.datas && data.datas.wxbgbgdz;
  if (!model || !Array.isArray(model.rows)) {
    throw new Error("报告列表结构发生变化，已停止本次处理");
  }
  return model;
}

async function fetchSelectableReports(settings) {
  const firstPage = await fetchReportPage(settings, 1);
  const totalSize = Number(firstPage.totalSize || 0);
  const totalPages = Math.min(100, Math.max(1, Math.ceil(totalSize / PAGE_SIZE)));
  const rows = [...firstPage.rows];

  for (let page = 2; page <= totalPages; page += 1) {
    const nextPage = await fetchReportPage(settings, page);
    rows.push(...nextPage.rows);
  }

  const unique = new Map();
  for (const row of rows) {
    const report = normalizeReport(row);
    // Client-side checks are deliberate: never submit if the server ignores a filter.
    if (
      report.id &&
      report.selectable &&
      report.location.includes(settings.locationKeyword)
    ) {
      unique.set(report.id, report);
    }
  }
  return [...unique.values()];
}

async function selectReportOnce(report) {
  const response = await fetch(SELECT_URL, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest"
    },
    body: new URLSearchParams({
      data: JSON.stringify({ BGBM: report.id })
    })
  });
  const data = await readJsonResponse(response);
  if (String(data.code) === "0") return { ok: true };
  return { ok: false, message: serverMessage(data, "选课失败") };
}

function updateRecord(state, report, patch = {}) {
  const previous = state.records[report.id] || {};
  state.records[report.id] = {
    ...previous,
    id: report.id,
    title: report.title,
    location: report.location,
    reportTime: report.reportTime,
    deadline: report.deadline,
    updatedAt: nowIso(),
    ...patch
  };
  return state.records[report.id];
}

async function requestSuccessEmail(report) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(EMAIL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: report.id,
        title: report.title,
        location: report.location,
        reportTime: report.reportTime,
        deadline: report.deadline
      }),
      signal: controller.signal
    });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("本地邮件助手返回了无效响应");
    }
    if (!response.ok || !data.ok) {
      throw new Error(data.error || `邮件助手请求失败（HTTP ${response.status}）`);
    }
    return data;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("本地邮件助手响应超时");
    if (error instanceof TypeError) {
      throw new Error("无法连接本地邮件助手，请先完成邮箱配置");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function getEmailHealth() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(EMAIL_HEALTH_URL, { signal: controller.signal });
    const data = await response.json();
    return {
      available: Boolean(response.ok && data.ok),
      configured: Boolean(data.configured),
      sender: String(data.sender || ""),
      recipient: String(data.recipient || "")
    };
  } catch {
    return { available: false, configured: false, sender: "", recipient: "" };
  } finally {
    clearTimeout(timeout);
  }
}

async function deliverSuccessEmail(state, report) {
  updateRecord(state, report, { emailStatus: "sending", emailError: "" });
  await saveState(state);
  try {
    await requestSuccessEmail(report);
    updateRecord(state, report, { emailStatus: "sent", emailSentAt: nowIso(), emailError: "" });
    addLog(state, "email", report.title, "选课成功邮件已发送");
    await saveState(state);
    return true;
  } catch (error) {
    const message = error.message || String(error);
    updateRecord(state, report, { emailStatus: "failed", emailError: message });
    addLog(state, "email-failed", report.title, message);
    await notify("选课成功，但邮件发送失败", `${report.title}\n${message}`, true);
    await saveState(state);
    return false;
  }
}

async function processReport(state, report) {
  const previous = state.records[report.id];
  if (previous && (previous.status === "selected" || previous.status === "failed")) {
    updateRecord(state, report);
    return "skipped";
  }

  if (!state.settings.autoSubmit) {
    const isNew = !previous || previous.status !== "dry-run";
    updateRecord(state, report, { status: "dry-run", attempts: 0, lastError: "" });
    if (isNew) {
      addLog(state, "dry-run", report.title, `${report.location} · ${report.reportTime}`);
      await notify("发现符合条件的报告（演练）", `${report.title}\n${report.location}`);
    }
    return "dry-run";
  }

  updateRecord(state, report, { status: "selecting", lastError: "" });
  await saveState(state);
  let lastError = "";
  const maxAttempts = Math.max(1, Number(state.settings.maxAttempts) || 3);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    updateRecord(state, report, { status: "selecting", attempts: attempt, lastError });
    await saveState(state);

    try {
      const result = await selectReportOnce(report);
      if (result.ok) {
        updateRecord(state, report, { status: "selected", attempts: attempt, lastError: "" });
        addLog(state, "selected", report.title, `第 ${attempt} 次尝试成功`);
        await notify("学术报告选课成功", `${report.title}\n${report.reportTime}`);
        await saveState(state);
        await deliverSuccessEmail(state, report);
        return "selected";
      }
      lastError = result.message;
    } catch (error) {
      if (error instanceof AuthError) throw error;
      lastError = error.message || String(error);
    }

    updateRecord(state, report, { status: "selecting", attempts: attempt, lastError });
    await saveState(state);
    if (attempt < maxAttempts) {
      await sleep(Math.max(0, Number(state.settings.retryDelaySeconds) || 0) * 1000);
    }
  }

  updateRecord(state, report, { status: "failed", attempts: maxAttempts, lastError });
  addLog(state, "failed", report.title, `已尝试 ${maxAttempts} 次：${lastError}`);
  await notify(
    "学术报告自动选课失败",
    `${report.title}\n已尝试 ${maxAttempts} 次：${lastError}`,
    true
  );
  await saveState(state);
  return "failed";
}

async function applyAlarm(settings) {
  await chrome.alarms.clear(ALARM_NAME);
  if (settings.monitoring) {
    const seconds = Math.max(30, Number(settings.intervalSeconds) || 30);
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: seconds / 60 });
  }
}

async function performCheck(trigger) {
  const state = await getState();
  if (trigger === "alarm" && !state.settings.monitoring) {
    return { ok: true, skipped: true };
  }

  try {
    const reports = await fetchSelectableReports(state.settings);
    state.lastReports = reports;
    state.lastCheckAt = nowIso();
    state.lastStatus = "ok";
    state.lastError = "";
    const summary = { dryRun: 0, selected: 0, failed: 0, skipped: 0, total: reports.length };

    for (const report of reports) {
      const result = await processReport(state, report);
      if (result === "dry-run") summary.dryRun += 1;
      if (result === "selected") summary.selected += 1;
      if (result === "failed") summary.failed += 1;
      if (result === "skipped") summary.skipped += 1;
    }

    state.lastSummary = { ...summary, time: nowIso() };
    await saveState(state);
    return { ok: true, summary };
  } catch (error) {
    state.lastCheckAt = nowIso();
    state.lastError = error.message || String(error);
    state.lastStatus = error instanceof AuthError ? "auth" : "error";

    if (error instanceof AuthError) {
      state.settings.monitoring = false;
      await applyAlarm(state.settings);
      addLog(state, "auth", "监控已暂停", state.lastError);
      await notify("登录失效，监控已暂停", "请打开研究生综合服务平台重新登录，然后再启动监控。", true);
    } else {
      addLog(state, "error", "本次检查失败", state.lastError);
    }
    await saveState(state);
    return { ok: false, error: state.lastError };
  }
}

function runCheck(trigger = "manual") {
  if (!activeCheck) {
    activeCheck = performCheck(trigger).finally(() => {
      activeCheck = null;
    });
  }
  return activeCheck;
}

async function handleMessage(message) {
  if (!message || typeof message.type !== "string") throw new Error("无效操作");

  if (message.type === "GET_STATE") {
    return {
      ...(await getState()),
      checking: Boolean(activeCheck),
      emailService: await getEmailHealth()
    };
  }

  if (message.type === "CHECK_NOW") {
    await runCheck("manual");
    return { ...(await getState()), checking: Boolean(activeCheck) };
  }

  if (message.type === "SET_MONITORING") {
    const state = await getState();
    state.settings.monitoring = Boolean(message.value);
    await saveState(state);
    await applyAlarm(state.settings);
    if (state.settings.monitoring) await runCheck("manual");
    return { ...(await getState()), checking: Boolean(activeCheck) };
  }

  if (message.type === "SET_AUTO_SUBMIT") {
    const value = Boolean(message.value);
    if (value && message.confirmed !== true) {
      throw new Error("开启真实选课前必须明确确认");
    }
    const state = await getState();
    state.settings.autoSubmit = value;
    await saveState(state);
    if (value && state.settings.monitoring) await runCheck("manual");
    return { ...(await getState()), checking: Boolean(activeCheck) };
  }

  if (message.type === "SET_LOCATION") {
    const keyword = String(message.value || "").trim();
    if (!keyword || keyword.length > 50) throw new Error("地点关键词需为 1–50 个字符");
    const state = await getState();
    const changed = keyword !== state.settings.locationKeyword;
    if (changed && state.settings.autoSubmit && state.settings.monitoring && message.confirmed !== true) {
      throw new Error("真实监控期间修改地点必须明确确认");
    }
    state.settings.locationKeyword = keyword;
    await saveState(state);
    if (changed && state.settings.monitoring) await runCheck("manual");
    return { ...(await getState()), checking: Boolean(activeCheck) };
  }

  if (message.type === "RETRY_FAILED") {
    const state = await getState();
    for (const record of Object.values(state.records)) {
      if (record.status === "failed") {
        record.status = "pending";
        record.attempts = 0;
        record.lastError = "";
      }
    }
    await saveState(state);
    await runCheck("manual");
    return { ...(await getState()), checking: Boolean(activeCheck) };
  }

  if (message.type === "RETRY_EMAILS") {
    const state = await getState();
    const failedRecords = Object.values(state.records).filter(
      (record) => record.status === "selected" && record.emailStatus === "failed"
    );
    for (const record of failedRecords) {
      await deliverSuccessEmail(state, {
        id: record.id,
        title: record.title,
        location: record.location,
        reportTime: record.reportTime,
        deadline: record.deadline
      });
    }
    await saveState(state);
    return { ...(await getState()), checking: Boolean(activeCheck) };
  }

  if (message.type === "OPEN_PAGE") {
    await chrome.tabs.create({ url: PORTAL_URL });
    return { ...(await getState()), checking: Boolean(activeCheck) };
  }

  throw new Error("未知操作");
}

chrome.runtime.onInstalled.addListener(() => {
  getState()
    .then(async (state) => {
      await saveState(state);
      await applyAlarm(state.settings);
    })
    .catch(console.error);
});

chrome.runtime.onStartup.addListener(() => {
  getState().then(applyAlarm).catch(console.error);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) runCheck("alarm").catch(console.error);
});

chrome.notifications.onClicked.addListener(() => {
  chrome.tabs.create({ url: PORTAL_URL }).catch(console.error);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((result) => sendResponse({ ok: true, state: result }))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});
