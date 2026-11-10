let currentState = null;
let actionPending = false;
let refreshTimer = null;

const byId = (id) => document.getElementById(id);

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response || !response.ok) {
    throw new Error(response && response.error ? response.error : "扩展后台未响应");
  }
  return response.state;
}

function formatTime(value) {
  if (!value) return "尚未检查";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", { hour12: false });
}

function setActionError(message = "") {
  byId("actionError").textContent = message;
  byId("actionError").hidden = !message;
}

function statusLabel(status) {
  return {
    "dry-run": "待选课（演练）",
    selected: "已选成功",
    failed: "3 次失败",
    selecting: "正在提交",
    pending: "等待重试"
  }[status] || "待处理";
}

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function renderReports(state) {
  const list = byId("reportList");
  list.replaceChildren();
  byId("reportCount").textContent = String(state.lastReports.length);
  const failedCount = Object.values(state.records).filter((record) => record.status === "failed").length;
  byId("retryFailed").hidden = failedCount === 0;
  byId("retryFailed").textContent = `重试失败报告（${failedCount}）`;
  const emailFailedCount = Object.values(state.records).filter(
    (record) => record.status === "selected" && record.emailStatus === "failed"
  ).length;
  byId("retryEmails").hidden = emailFailedCount === 0;
  byId("retryEmails").textContent = `重发失败邮件（${emailFailedCount}）`;

  if (!state.lastReports.length) {
    list.append(makeElement("p", "empty", state.lastCheckAt ? "本次没有符合条件且当前可选的报告" : "启动后在这里显示识别结果"));
    return;
  }

  for (const report of state.lastReports) {
    const record = state.records[report.id] || {};
    const card = makeElement("article", "report-card");
    const titleRow = makeElement("div", "report-title-row");
    titleRow.append(makeElement("h3", "report-title", report.title));
    titleRow.append(makeElement("span", `report-status ${record.status || ""}`, statusLabel(record.status)));
    card.append(titleRow);
    card.append(makeElement(
      "p",
      "report-meta",
      `${report.location}\n报告：${report.reportTime}\n截止：${report.deadline} · 容量/已选：${report.capacity}/${report.selected}`
    ));
    if (record.lastError) card.append(makeElement("p", "report-error", record.lastError));
    if (record.status === "selected" && record.emailStatus) {
      const emailText = {
        sending: "成功邮件正在发送…",
        sent: "成功邮件已发送",
        failed: `成功邮件发送失败：${record.emailError || "可在下方重发"}`
      }[record.emailStatus] || "邮件状态未知";
      card.append(makeElement("p", record.emailStatus === "failed" ? "report-error" : "report-meta", emailText));
    }
    list.append(card);
  }
}

function renderLogs(state) {
  const list = byId("logList");
  list.replaceChildren();
  const logs = state.logs.slice(-15).reverse();
  if (!logs.length) {
    list.append(makeElement("p", "empty", "暂无运行记录"));
    return;
  }
  for (const entry of logs) {
    const item = makeElement("div", "log-item");
    item.append(makeElement("time", "", formatTime(entry.time)));
    item.append(makeElement("p", "", entry.message ? `${entry.title}：${entry.message}` : entry.title));
    list.append(item);
  }
}

function render(state) {
  currentState = state;
  const { monitoring, autoSubmit } = state.settings;
  byId("modeBadge").textContent = autoSubmit ? "真实自动模式" : "演练模式";
  byId("modeBadge").classList.toggle("auto", autoSubmit);
  byId("modeTitle").textContent = autoSubmit ? "真实自动选课已开启" : "当前只识别，不会选课";
  byId("modeDescription").textContent = autoSubmit
    ? "符合条件的新报告会立即真实提交，成功后继续监控。"
    : "先核对演练结果，确认识别正确后再开启真实提交。";
  byId("autoToggle").textContent = autoSubmit ? "切回演练模式" : "开启真实选课";
  byId("autoToggle").classList.toggle("danger", autoSubmit);

  byId("monitorToggle").textContent = monitoring ? "暂停监控" : "启动监控";
  byId("monitorToggle").classList.toggle("stop", monitoring);
  byId("statusDot").className = `status-dot ${monitoring ? "running" : ""} ${state.lastError ? "error" : ""}`;
  byId("statusText").textContent = state.checking
    ? "正在检查…"
    : monitoring
      ? (autoSubmit ? "后台监控中 · 会自动提交" : "后台监控中 · 仅演练")
      : (state.lastStatus === "auth" ? "登录失效，已暂停" : "监控已暂停");
  byId("lastCheck").textContent = `上次检查：${formatTime(state.lastCheckAt)}`;
  if (document.activeElement !== byId("locationKeyword")) {
    byId("locationKeyword").value = state.settings.locationKeyword;
  }
  const emailService = state.emailService;
  byId("emailConfigText").textContent = !emailService
    ? "正在检测邮件配置…"
    : emailService.available && emailService.configured
      ? `成功邮件：${emailService.sender} → ${emailService.recipient}`
      : emailService.available
        ? "邮件助手已运行，但尚未配置邮箱，请查看 README。"
        : "邮件助手未运行，请先按 README 完成邮箱配置。";

  byId("errorBox").hidden = !state.lastError;
  byId("errorTitle").textContent = state.lastStatus === "auth" ? "需要重新登录" : "最近一次检查异常";
  byId("errorText").textContent = state.lastError;

  renderReports(state);
  renderLogs(state);
  byId("checkNow").disabled = actionPending || state.checking;
}

async function refresh() {
  try {
    render(await send("GET_STATE"));
    setActionError();
  } catch (error) {
    setActionError(error.message || String(error));
  }
}

async function performAction(callback) {
  if (actionPending) return;
  actionPending = true;
  setActionError();
  for (const button of document.querySelectorAll("button")) button.disabled = true;
  try {
    render(await callback());
  } catch (error) {
    setActionError(error.message || String(error));
  } finally {
    actionPending = false;
    for (const button of document.querySelectorAll("button")) button.disabled = false;
    await refresh();
  }
}

byId("monitorToggle").addEventListener("click", () => performAction(async () => {
  return send("SET_MONITORING", { value: !currentState.settings.monitoring });
}));

byId("checkNow").addEventListener("click", () => performAction(async () => {
  return send("CHECK_NOW");
}));

byId("autoToggle").addEventListener("click", () => performAction(async () => {
  const enable = !currentState.settings.autoSubmit;
  if (enable) {
    const confirmed = window.confirm(
      `开启后会对所有地点包含“${currentState.settings.locationKeyword}”且当前可选的未选报告真实提交选课，包括当前已经存在的报告。\n\n确认开启真实自动选课吗？`
    );
    if (!confirmed) return send("GET_STATE");
  }
  return send("SET_AUTO_SUBMIT", { value: enable, confirmed: enable });
}));

byId("saveSettings").addEventListener("click", () => performAction(async () => {
  const value = byId("locationKeyword").value.trim();
  const changed = value !== currentState.settings.locationKeyword;
  if (changed && currentState.settings.autoSubmit && currentState.settings.monitoring) {
    const confirmed = window.confirm(
      `真实自动选课正在运行。保存后将对地点包含“${value}”的报告真实提交选课。确认修改吗？`
    );
    if (!confirmed) return send("GET_STATE");
  }
  return send("SET_LOCATION", { value, confirmed: true });
}));

byId("retryFailed").addEventListener("click", () => performAction(async () => {
  if (currentState.settings.autoSubmit) {
    const confirmed = window.confirm("将对失败的报告重新真实提交，最多再尝试 3 次。确认继续吗？");
    if (!confirmed) return send("GET_STATE");
  }
  return send("RETRY_FAILED");
}));

byId("retryEmails").addEventListener("click", () => performAction(async () => {
  return send("RETRY_EMAILS");
}));

byId("openPage").addEventListener("click", () => performAction(async () => {
  return send("OPEN_PAGE");
}));

chrome.storage.onChanged.addListener(() => {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 150);
});

refresh();
