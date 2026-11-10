import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../popup.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../popup.html", import.meta.url), "utf8");

class FakeElement {
  constructor(tag = "div", id = "") {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.disabled = false;
    this.hidden = false;
    this.textContent = "";
    this.className = "";
    this.children = [];
    this.listeners = {};
    this.classList = { toggle() {} };
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  async click() {
    assert.equal(this.disabled, false, `${this.id} 不应处于禁用状态`);
    if (this.listeners.click) await this.listeners.click();
  }
}

function createPopupHarness() {
  const elements = new Map();
  for (const match of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g)) {
    elements.set(match[2], new FakeElement(match[1], match[2]));
  }
  const buttons = [...elements.values()].filter((element) => element.tagName === "BUTTON");
  const state = {
    settings: { monitoring: false, autoSubmit: false, locationKeyword: "高新" },
    emailService: { available: true, configured: true, sender: "sender@example.com", recipient: "recipient@example.net" },
    records: {},
    lastReports: [],
    logs: [],
    lastCheckAt: null,
    lastStatus: "idle",
    lastError: "",
    checking: false
  };
  const document = {
    getElementById: (id) => elements.get(id),
    querySelectorAll: (selector) => selector === "button" ? buttons : [],
    createElement: (tag) => new FakeElement(tag)
  };
  const chrome = {
    runtime: {
      async sendMessage(message) {
        if (message.type === "SET_MONITORING") state.settings.monitoring = message.value;
        if (message.type === "SET_AUTO_SUBMIT") state.settings.autoSubmit = message.value;
        return { ok: true, state: structuredClone(state) };
      }
    },
    storage: { onChanged: { addListener() {} } }
  };
  const context = vm.createContext({
    document,
    chrome,
    window: { confirm: () => false },
    console,
    structuredClone,
    setTimeout,
    clearTimeout
  });
  vm.runInContext(source, context, { filename: "popup.js" });
  return { elements, buttons };
}

test("完成一次操作后恢复所有按钮，取消确认后仍可再次点击", async () => {
  const { elements, buttons } = createPopupHarness();
  await new Promise(setImmediate);
  await elements.get("monitorToggle").click();
  for (const button of buttons) {
    assert.equal(button.disabled, false, `${button.id} 应在操作完成后恢复`);
  }
  await elements.get("autoToggle").click();
  assert.equal(elements.get("autoToggle").disabled, false, "取消确认后开启按钮仍应可用");
  assert.equal(elements.get("monitorToggle").disabled, false);
});
