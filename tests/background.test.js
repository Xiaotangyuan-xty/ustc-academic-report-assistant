import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../background.js", import.meta.url), "utf8");

function sampleReport(overrides = {}) {
  return {
    BGBM: "report-1",
    BGTMZW: "测试学术报告",
    DD: "高新校区图教中心 C101",
    BGSJ: "2026-11-18 10:00",
    JZSJ: "2026-11-15 23:59:59",
    KXRS: 80,
    YXRS: "34",
    SFKXK: "1",
    ...overrides
  };
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => (typeof body === "string" ? JSON.parse(body) : body)
  };
}

function createHarness(options = {}) {
  const stored = options.stored || {};
  const calls = {
    list: 0,
    select: 0,
    email: 0,
    listBodies: [],
    selectBodies: [],
    emailBodies: [],
    notifications: []
  };
  const reports = options.reports || [sampleReport()];
  const selectResults = options.selectResults || [];
  let defaultSelectResult = options.defaultSelectResult || { code: "0" };

  const event = () => ({ addListener() {} });
  const chrome = {
    storage: {
      local: {
        async get() { return structuredClone(stored); },
        async set(values) {
          for (const [key, value] of Object.entries(values)) stored[key] = structuredClone(value);
        }
      }
    },
    runtime: {
      onInstalled: event(),
      onStartup: event(),
      onMessage: event(),
      getURL: (path) => `chrome-extension://test/${path}`
    },
    alarms: {
      onAlarm: event(),
      async clear() { return true; },
      create() {}
    },
    notifications: {
      onClicked: event(),
      async create(id, payload) { calls.notifications.push({ id, ...payload }); }
    },
    tabs: { async create() {} }
  };

  const context = vm.createContext({
    chrome,
    console,
    URLSearchParams,
    AbortController,
    structuredClone,
    setTimeout: (callback) => { callback(); return 1; },
    clearTimeout() {},
    fetch: async (url, init) => {
      if (url.endsWith("/wxbgbgdz.do")) {
        calls.list += 1;
        calls.listBodies.push(init.body.toString());
        if (options.listError) throw options.listError;
        if (options.listResponse !== undefined) return response(options.listResponse);
        const pageNumber = Number(new URLSearchParams(init.body).get("pageNumber"));
        const pageRows = options.paginated
          ? reports.slice((pageNumber - 1) * 100, pageNumber * 100)
          : reports;
        return response({
          code: "0",
          datas: {
            wxbgbgdz: {
              totalSize: reports.length,
              pageNumber,
              pageSize: 100,
              rows: pageRows
            }
          }
        });
      }
      if (url.endsWith("/selectBg.do")) {
        calls.select += 1;
        calls.selectBodies.push(init.body.toString());
        const result = selectResults.length ? selectResults.shift() : defaultSelectResult;
        if (result instanceof Error) throw result;
        return response(result);
      }
      if (url === "http://127.0.0.1:17826/health") {
        return response(options.emailHealth || { ok: true, configured: false });
      }
      if (url === "http://127.0.0.1:17826/send") {
        calls.email += 1;
        calls.emailBodies.push(JSON.parse(init.body));
        if (options.emailError) throw new TypeError("fetch failed");
        return response(options.emailResponse || { ok: true, alreadySent: false });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }
  });
  vm.runInContext(source, context, { filename: "background.js" });
  return {
    stored,
    calls,
    run: (code) => vm.runInContext(code, context)
  };
}

test("演练模式识别报告但绝不调用选课接口", async () => {
  const harness = createHarness();
  const result = await harness.run('runCheck("manual")');
  assert.equal(result.ok, true);
  assert.equal(harness.calls.select, 0);
  assert.equal(harness.calls.email, 0);
  assert.equal(harness.stored.records["report-1"].status, "dry-run");
  assert.equal(harness.calls.notifications.length, 1);
});

test("列表请求同时使用地点包含和当前可选条件", async () => {
  const harness = createHarness();
  await harness.run('runCheck("manual")');
  const params = new URLSearchParams(harness.calls.listBodies[0]);
  const query = JSON.parse(params.get("querySetting"));
  assert.deepEqual(
    query.find((item) => item.name === "DD"),
    { name: "DD", caption: "地点", linkOpt: "AND", builderList: "cbl_String", builder: "include", value: "高新" }
  );
  assert.equal(query.find((item) => item.name === "SFKXK").value, "1");
  assert.equal(query.find((item) => item.name === "SFKXK").builder, "equal");
});

test("真实模式成功提交一次并记录成功", async () => {
  const harness = createHarness({
    stored: { settings: { autoSubmit: true, retryDelaySeconds: 0 } }
  });
  await harness.run('runCheck("manual")');
  assert.equal(harness.calls.select, 1);
  assert.equal(harness.stored.records["report-1"].status, "selected");
  assert.equal(harness.stored.records["report-1"].emailStatus, "sent");
  assert.equal(harness.calls.email, 1);
  assert.equal(harness.calls.emailBodies[0].id, "report-1");
  const payload = JSON.parse(new URLSearchParams(harness.calls.selectBodies[0]).get("data"));
  assert.deepEqual(payload, { BGBM: "report-1" });
});

test("失败后总共尝试三次，后续扫描不重复提交", async () => {
  const harness = createHarness({
    stored: { settings: { autoSubmit: true, retryDelaySeconds: 0 } },
    defaultSelectResult: { code: "1", msg: "名额已满" }
  });
  await harness.run('runCheck("manual")');
  assert.equal(harness.calls.select, 3);
  assert.equal(harness.stored.records["report-1"].status, "failed");
  assert.equal(harness.stored.records["report-1"].attempts, 3);
  assert.equal(harness.stored.records["report-1"].lastError, "名额已满");
  await harness.run('runCheck("manual")');
  assert.equal(harness.calls.select, 3);
  assert.ok(harness.calls.notifications.some((item) => item.title.includes("失败")));
});

test("演练阶段发现的报告在开启真实模式后会被处理", async () => {
  const harness = createHarness({ stored: { settings: { retryDelaySeconds: 0 } } });
  await harness.run('runCheck("manual")');
  assert.equal(harness.stored.records["report-1"].status, "dry-run");
  harness.stored.settings.autoSubmit = true;
  await harness.run('runCheck("manual")');
  assert.equal(harness.calls.select, 1);
  assert.equal(harness.stored.records["report-1"].status, "selected");
});

test("即使服务器忽略地点条件，客户端也不会错误提交", async () => {
  const harness = createHarness({
    reports: [sampleReport({ DD: "西区第三教学楼" })],
    stored: { settings: { autoSubmit: true } }
  });
  await harness.run('runCheck("manual")');
  assert.equal(harness.calls.select, 0);
  assert.deepEqual(harness.stored.lastReports, []);
});

test("登录页面代替 JSON 返回时暂停监控且不提交", async () => {
  const harness = createHarness({
    listResponse: "<html>login</html>",
    stored: { settings: { monitoring: true, autoSubmit: true } }
  });
  const result = await harness.run('runCheck("manual")');
  assert.equal(result.ok, false);
  assert.equal(harness.stored.settings.monitoring, false);
  assert.equal(harness.stored.lastStatus, "auth");
  assert.equal(harness.calls.select, 0);
});

test("列表超过一百条时继续翻页并去重", async () => {
  const reports = Array.from({ length: 101 }, (_, index) => sampleReport({
    BGBM: `report-${index}`,
    BGTMZW: `报告 ${index}`
  }));
  reports[100] = { ...reports[100], BGBM: "report-0" };
  const harness = createHarness({ reports, paginated: true });
  await harness.run('runCheck("manual")');
  assert.equal(harness.calls.list, 2);
  assert.equal(harness.stored.lastReports.length, 100);
  assert.equal(harness.calls.select, 0);
});

test("邮件失败不改变选课成功状态，可单独重发且不会重复选课", async () => {
  const options = {
    stored: { settings: { autoSubmit: true, retryDelaySeconds: 0 } },
    emailError: true
  };
  const harness = createHarness(options);
  await harness.run('runCheck("manual")');
  assert.equal(harness.stored.records["report-1"].status, "selected");
  assert.equal(harness.stored.records["report-1"].emailStatus, "failed");
  assert.equal(harness.calls.select, 1);
  assert.equal(harness.calls.email, 1);
  assert.ok(harness.calls.notifications.some((item) => item.title.includes("邮件发送失败")));

  options.emailError = false;
  await harness.run('handleMessage({type:"RETRY_EMAILS"})');
  assert.equal(harness.stored.records["report-1"].emailStatus, "sent");
  assert.equal(harness.calls.select, 1);
  assert.equal(harness.calls.email, 2);

  await harness.run('runCheck("manual")');
  assert.equal(harness.calls.select, 1);
  assert.equal(harness.calls.email, 2);
});

test("每位用户可修改地点关键词，查询和客户端筛选同步更新", async () => {
  const harness = createHarness({
    reports: [sampleReport({ DD: "东区第二教学楼" })],
    stored: { settings: { locationKeyword: "东区" } }
  });
  await harness.run('runCheck("manual")');
  const query = JSON.parse(new URLSearchParams(harness.calls.listBodies[0]).get("querySetting"));
  assert.equal(query.find((item) => item.name === "DD").value, "东区");
  assert.equal(harness.stored.records["report-1"].status, "dry-run");
});

test("弹窗能读取当前用户自己的邮箱配置", async () => {
  const harness = createHarness({
    emailHealth: {
      ok: true,
      configured: true,
      sender: "sender@example.com",
      recipient: "recipient@example.net"
    }
  });
  const state = await harness.run('handleMessage({type:"GET_STATE"})');
  assert.equal(state.emailService.available, true);
  assert.equal(state.emailService.configured, true);
  assert.equal(state.emailService.recipient, "recipient@example.net");
});
