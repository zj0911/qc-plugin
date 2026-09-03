// 质检规则优化扩展 — 后台 Service Worker (MV3)  v4.17.5
console.log('[QC Ext] v4.17.23 background.js loaded');

// ── 工具栏图标点击 = 刷新当前页插件（无需刷新网页）──
// 场景：某些网页在插件生效前就已打开，悬浮按钮始终注入不进来。
// 点地址栏旁的插件图标：若 content script 已注入则发消息触发重建+重新提取；
// 若未注入则立即就地注入 content.js 再触发，一次点击搞定。
const IS_QC_DOMAIN = (u = '') => /^https:\/\/(?:ics\.alipay\.com|ics-site-pre\.alipay\.com)([:/]|$)/i.test(String(u || ''));

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || tab.id == null) return;
  // 仅在质检平台域名下生效；其他网页点击工具栏图标不做任何事
  if (!IS_QC_DOMAIN(tab.url || '')) {
    console.log('[QC Ext] 非质检域名，工具栏点击忽略:', tab.url);
    return;
  }
  const tabId = tab.id;
  let got = false;
  try {
    const resp = await chrome.tabs.sendMessage(tabId, { type: 'QC_REFRESH' });
    got = !!(resp && resp.ok);
  } catch (e) { got = false; }
  if (!got) {
    // content script 未注入 → 就地注入再触发
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      await sleep(400);
      await chrome.tabs.sendMessage(tabId, { type: 'QC_REFRESH' });
    } catch (e2) {
      console.warn('[QC Ext] 工具栏点击刷新失败:', String(e2 && e2.message || e2));
    }
  }
  // 角标反馈（短暂显示后清除）
  try {
    await chrome.action.setBadgeText({ tabId, text: '⟳' });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#1a73e8' });
    await sleep(1200);
    await chrome.action.setBadgeText({ tabId, text: '' });
  } catch (e) { /* 忽略角标异常 */ }
});

// 模式B 双通道：
//   ① 通道 JSON（首选）：在质检平台质检点页面(ruleManage)以 MAIN world 注入 hook.js，
//      捕获页面自身调用 queryRuleByPage 的真实响应(复用页面会话与动态防重放签名)，
//      再于插件侧做本地模糊匹配 —— 稳定、不切换用户页面、不占用 Agent 上下文。
//   ② 通道 Agent（兜底）：若页面无接口响应(如未登录/页面不可达)，退回跨页签驱动
//      Agent 聊天输入(qc-drive)读数。
//
// 注：queryRuleByPage 无对外公开文档，且带动态签名(starpoint-data2)。因此不虚构接口、
//     不硬编码任何会话凭据，而是复用页面自身真实发起的请求响应。

// ── 双环境（正式/预发）自适应 ──
// 按来源页面环境推导站点/API/Agent 域名：预发的 host 均含 "-pre.alipay.com"
const ENV_HOST = {
  formal: { site: 'https://ics.alipay.com',          api: 'https://ics-api.alipay.com' },
  pre:    { site: 'https://ics-site-pre.alipay.com', api: 'https://ics-api-pre.alipay.com' }
};
const AGENT_PATH = '/ics-quality/quality/ruleManage';
const envOf = (u = '') => /-pre\.alipay\.com/i.test(String(u || '')) ? 'pre' : 'formal';
const agentPageOf = (u = '') => ENV_HOST[envOf(u)].site + AGENT_PATH;
const apiHostOf = (u = '') => ENV_HOST[envOf(u)].api;
const AGENT_PAGE = agentPageOf(); // 保留默认值（正式）以兼容旧引用

const INPUT_SEL = 'textarea[placeholder*="描述你想要的质检规则"]';
const ASSIST_SEL = '[class*="messageBubbleAssistant"]';
const DRIVE_TIMEOUT = 120000;   // Agent 兜底：最长等待回复（毫秒）
const STABLE_POLLS = 3;         // 连续 N 次内容不变视为回复完成
const POLL_INTERVAL = 600;      // 轮询间隔（毫秒）
const CAPTURE_TIMEOUT = 60000;  // 通道 JSON：最长等待接口响应捕获（毫秒）
const HOOK_RELOAD_WAIT = 2000;  // reload 后等待注入完成

// ── 消息入口 ──
// 先判断当前激活页：仅当消息来源页签就是其所在窗口当前激活(focus)的页签时才处理，
// 否则忽略——避免正式/预发多个质检标签页同时打开时，非焦点页也发起同一请求/动作。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  const srcUrl = (sender && sender.tab && sender.tab.url) || '';
  (async () => {
    const active = await isActiveSender(sender);
    if (!active) {
      sendResponse({ ok: false, ignored: 'not-active',
        error: '非当前激活页，已忽略：请先把要操作的正式/预发页面切到前台再触发' });
      return;
    }
    if (msg.type === 'qc-drive') {
      try {
        sendResponse(await handleDrive(String(msg.keyword || ''), undefined, undefined, srcUrl));
      } catch (err) { sendResponse({ ok: false, error: String(err && err.message || err) }); }
      return;
    }
    if (msg.type === 'qc-query-rules') {
      try {
        sendResponse(await handleQueryRules(String(msg.keyword || ''), srcUrl));
      } catch (err) { sendResponse({ ok: false, error: String(err && err.message || err) }); }
      return;
    }
    if (msg.type === 'qc-version-history') {
      try {
        sendResponse(await handleQueryVersionHistory(msg.qcRuleId, srcUrl));
      } catch (err) { sendResponse({ ok: false, error: String(err && err.message || err) }); }
      return;
    }
    if (msg.type === 'qc-rca-agent') {
      try {
        sendResponse(await handleRCA(String(msg.prompt || ''), srcUrl, !!msg.newSession));
      } catch (err) { sendResponse({ ok: false, error: String(err && err.message || err) }); }
      return;
    }
    if (msg.type === 'qc-evalset') {
      try {
        sendResponse(await handleEvalset(msg, srcUrl));
      } catch (err) { sendResponse({ ok: false, error: String(err && err.message || err) }); }
      return;
    }
    // 未知类型：不响应（保持原有行为）
  })();
  return true; // 异步 sendResponse
});

// 判断消息来源页签是否为其所在窗口当前激活(focus)的前台页签。
async function isActiveSender(sender) {
  try {
    if (!sender || !sender.tab || sender.tab.id == null || sender.tab.windowId == null) return false;
    const tabs = await chrome.tabs.query({ active: true, windowId: sender.tab.windowId });
    return tabs.some((t) => t.id === sender.tab.id);
  } catch (e) {
    return true; // 查询失败不阻塞，放行
  }
}
// hook 捕获消息：可忽略（缓存已存于页面 window），仅用于唤醒检查
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'qc-rule-captured') { /* 心跳，无操作 */ }
});

// ══════════════════════════════════════════
// 通道 JSON：抓取真实接口响应
// ══════════════════════════════════════════
async function handleQueryRules(keyword, sourceUrl) {
  const tab = await getRuleTab(sourceUrl);
  const data = await ensureCache(tab.id);
  if (data == null) {
    // 接口通道拿不到数据 → 退回 Agent 兜底
    return await handleDriveToResult(keyword, sourceUrl);
  }
  return { ok: true, mode: 'api', data, url: agentPageOf(sourceUrl), via: 'queryRuleByPage 接口真实响应（页面自身请求捕获）' };
}

// 复用已打开的目标页签，否则新开（active:false = 不切换用户当前页面）
// 按来源页面环境打开对应的正式/预发 Agent 页签
async function getRuleTab(sourceUrl) {
  const agent = agentPageOf(sourceUrl);
  let tab = (await chrome.tabs.query({ url: agent + '*' }))[0];
  if (!tab) tab = await chrome.tabs.create({ url: agent, active: false });
  return tab;
}

// 读取页面中 hook 捕获到的【所有】queryRuleByPage 响应并合并成一份匹配池。
// 页面可能按「已发布/未发布(草稿)」等分段各发一次请求，多次捕获的状态不同；
// 只取最新一条会丢掉另一状态 → 看起来「只能抓到最新的」。因此这里全部合并。
async function readCache(tabId) {
  const res = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      const c = window.__QC_RULES_CACHE__;
      if (!Array.isArray(c) || c.length === 0) return null;
      const seenTime = new Set();
      const merged = [];
      for (const x of c) {
        if (!x || !x.data) continue;
        if (seenTime.has(x.time)) continue;   // 相同时间戳视为同一次响应
        seenTime.add(x.time);
        merged.push(x.data);
      }
      return merged.length ? merged : null;
    }
  });
  return res && res[0] && res[0].result ? res[0].result : null;
}

// 判断页面是否已注入 hook
async function hookInstalled(tabId) {
  const res = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => !!window.__QC_HOOK_INSTALLED__
  });
  return !!(res && res[0] && res[0].result);
}

// 确保拿到接口响应：优先读缓存；无则 reload 触发页面重新请求并等捕获
async function ensureCache(tabId) {
  let data = await readCache(tabId);
  if (data != null) return data;

  const installed = await hookInstalled(tabId);
  if (!installed) {
    // 页签在本扩展 hook 注册前已打开 → reload 安装 hook 并重新请求
    await chrome.tabs.reload(tabId);
    await sleep(HOOK_RELOAD_WAIT);
  } else {
    // hook 已装但暂无捕获 → 再 reload 一次触发页面重新请求
    await chrome.tabs.reload(tabId);
    await sleep(HOOK_RELOAD_WAIT);
  }

  const start = Date.now();
  for (;;) {
    data = await readCache(tabId);
    if (data != null) return data;
    if (Date.now() - start > CAPTURE_TIMEOUT) return null;
    await sleep(1500);
  }
}

// ══════════════════════════════════════════
// 通道历史版本：按 qcRuleId 拉取 getRuleVersionHistory 的已发布版本
// ══════════════════════════════════════════
const VH_TIMEOUT = 30000; // 历史版本拉取最长等待（毫秒）

async function handleQueryVersionHistory(qcRuleId, sourceUrl) {
  if (qcRuleId === undefined || qcRuleId === null || qcRuleId === '') {
    return { ok: false, error: 'no-qcRuleId' };
  }
  const tab = await getRuleTab(sourceUrl);
  const qid = String(qcRuleId);

  // 先读缓存：若页面已自然捕获(如用户手动打开过历史版本 UI)则直接命中
  let hit = await readVersionCache(tab.id, qid);
  if (hit) return { ok: true, data: hit, url: agentPageOf(sourceUrl), via: 'getRuleVersionHistory 页面自身请求捕获' };

  // 未命中 → 在页面 MAIN 上下文主动发起请求（复用页面签名链路）
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: (id) => {
        if (typeof window.__qcQueryVersionHistory === 'function') {
          window.__qcQueryVersionHistory(String(id)); // 结果会回写入缓存，无需等待 Promise
        }
      },
      args: [qid]
    });
  } catch (err) {
    return { ok: false, error: 'inject-failed: ' + String(err && err.message || err) };
  }

  // 轮询等待捕获
  const start = Date.now();
  for (;;) {
    hit = await readVersionCache(tab.id, qid);
    if (hit) return { ok: true, data: hit, url: agentPageOf(sourceUrl), via: 'getRuleVersionHistory 主动发起（页面签名链路）' };
    if (Date.now() - start > VH_TIMEOUT) {
      return { ok: false, error: 'timeout-via-active', hint: '若页面接口因动态签名校验(starpoint-data2)拒绝，请手动打开该质检点页面的「历史版本」，捕获后重试' };
    }
    await sleep(1200);
  }
}

async function readVersionCache(tabId, qid) {
  const res = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (id) => {
      const c = window.__QC_VERSION_HISTORY_CACHE__;
      if (!c) return null;
      const e = c[String(id)];
      return (e && e.time) ? e.data : null;
    },
    args: [qid]
  });
  return res && res[0] && res[0].result ? res[0].result : null;
}

// ══════════════════════════════════════════
// 通道 Agent：兜底，跨页签驱动质检 Agent 聊天输入
// ══════════════════════════════════════════

// API 直连（实验性纯后台路线）：用上一轮 UI 驱动时捕获的请求模板直接复刻
// chat.json 请求——网络请求不受后台页签节流影响，全程不碰页面 UI。
// 在 MAIN world 走 window.fetch，页面的签名拦截层/cookie 会自动附加。
async function tryDirectApi(tabId, prompt, debug) {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (p) => {
        // 前置：页面当前技能必须是「质检规则Agent」——直连不碰 UI、不会切技能，
        // 技能不对时返回失败，交给 UI 驱动路线主动切换
        const selItem = document.querySelector('.chatHeaderAgentSelect-fSCiDfST .ant-select-selection-item') ||
          document.querySelector('[class*="chatHeaderAgentSelect"] .ant-select-selection-item');
        const curSkill = selItem ? (selItem.textContent || '').trim() : '';
        if (curSkill && !curSkill.includes('质检规则')) return { ok: false, error: 'skill-not-current', skill: curSkill };
        const tpl = window.__QC_CHAT_REQ__;
        if (!tpl || !tpl.body) return { ok: false, error: 'no-template' };
        let obj = null;
        try { obj = JSON.parse(tpl.body); } catch (e) { return { ok: false, error: 'tpl-not-json', head: tpl.body.slice(0, 400) }; }
        // ① 顶层挑最像 prompt 的长字符串字段替换成新内容
        const rePrompt = /prompt|question|content|query|message|input|text/i;
        let hit = '';
        for (const k of Object.keys(obj)) {
          const v = obj[k];
          if (typeof v === 'string' && v.length >= 30 && rePrompt.test(k)) { obj[k] = p; hit = k; break; }
        }
        // ② 兜底：message/messages 数组里最长的字符串元素
        if (!hit) {
          for (const k of ['message', 'messages']) {
            if (Array.isArray(obj[k])) {
              let best = null;
              for (const it of obj[k]) {
                if (it && typeof it === 'object') for (const kk of Object.keys(it)) {
                  if (typeof it[kk] === 'string' && (!best || it[kk].length > best.v.length)) best = { it, kk, v: it[kk] };
                }
              }
              if (best) { best.it[best.kk] = p; hit = k + '[].' + best.kk; }
            }
            if (hit) break;
          }
        }
        if (!hit) return { ok: false, error: 'no-prompt-field', keys: Object.keys(obj), head: tpl.body.slice(0, 400) };
        // ③ 新会话：sessionId 为前端生成的 UUID，替换成全新值即可开新会话
        // （不能删除——实测删除后服务端返回 400，该字段必填）
        const uuid = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() :
          'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
          });
        let newSession = false;
        for (const k of Object.keys(obj)) {
          if (/^sessionid$/i.test(k)) { obj[k] = uuid; newSession = true; }
        }
        const headers = Object.assign({}, tpl.headers || {}, { Accept: 'text/event-stream' });
        return window.fetch(tpl.url, { method: tpl.method || 'POST', headers, body: JSON.stringify(obj), credentials: 'include' })
          .then((r) => r.ok
            ? { ok: true, via: 'direct-api', hit, newSession, status: r.status }
            : { ok: false, error: 'http-' + r.status, hit, newSession, keys: Object.keys(obj) });
      },
      args: [prompt]
    });
    const r = (res && res[0] && res[0].result) || { ok: false, error: 'no-result' };
    Object.assign(debug, r);
    if (r.ok) console.log('[QC Ext] ✅ API 直连发送成功（纯后台），替换字段:', r.hit);
    else console.warn('[QC Ext] ⚠️ API 直连失败:', JSON.stringify(r));
    return !!r.ok;
  } catch (e) {
    debug.directApiError = String(e && e.message || e);
    return false;
  }
}

async function handleDrive(keyword, skill, opts, sourceUrl) {
  if (!keyword) return { ok: false, error: 'no-keyword' };
  const tab = await getRuleTab(sourceUrl);

  // 保活脚本仍注入（伪装可见 + 音频豁免），减轻页面自身对 hidden 的响应
  await keepAwakeTab(tab.id);

  const ready = await waitForReady(tab.id);
  if (!ready) return { ok: false, error: 'agent-page-not-ready' };
  // 新页签首次注入保活时页面可能尚未加载，这里补一次（幂等，内部有防重入标记）
  await keepAwakeTab(tab.id);

  const debug = { version: '4.17.23' };

  // 环境判定：正式=ics.alipay.com，预发=ics-site-pre.alipay.com（正式清会话只保留「垃圾桶」）。
  // 注：预发「非首轮 reload 页面」方案已废弃——reload 会连同插件面板（业务线/质检点/RCA 编辑框）
  // 一起冲掉，导致 RCA 数据丢失。改由 hook.js「伪造 SSE 流结束」（wrapChatStream）解页面卡死：
  // 流停滞后主动 close → React 自然收尾 → 输入框恢复，既不 reload、也不点「停止」，
  // 从根本上避开「内容输出后点停止/新建会话 → systemPrompt.content 崩溃」与数据丢失。
  const isFormal = !/pre\.alipay\.com/.test(String(sourceUrl || ''));

  // 清掉上一轮残留的流缓存（MAIN world；driveAgent 跑在 ISOLATED，写不到 MAIN 全局）
  const clearStreamCache = () => chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: () => { window.__QC_AGENT_STREAM__ = null; window.__QC_AGENT_STREAMS__ = []; return true; }
  });
  try { await clearStreamCache(); } catch (e) { /* 忽略 */ }

  // 发送前 DOM 基线：最后一条回复气泡的快照。
  // 用于轮询期的 DOM 稳定判定——API 直连不经过页面 UI、DOM 不会更新，
  // 若气泡内容等于基线则是上一轮的旧回复，不能当成本轮答案
  const domBaseline = (await readAssistantDom(tab.id)).text;

  // ── 路线一（纯后台）：API 直连 —— 复刻页面自己的 chat.json 请求，全程不碰 UI ──
  // 仅限查询兜底等非交互场景（skipDirectApi 未开启时）。
  // RCA/对话链路固定跳过：实测模板重放不可靠（服务端对重放请求可能静默失效，
  // 页面既不清会话也不显示发送），而 UI 路线保证「点删除图标清会话 → 输入 → 发送」。
  if (!(opts && opts.skipDirectApi) && await tryDirectApi(tab.id, keyword, debug)) {
    // 给足完整时限：一次回复（思考 + 加载技能 + 答案）常超 30 秒，短时限会拿到半成品；
    // 若流根本没出现（发送实际失败），STREAM_APPEAR_WAIT 内就会快速回退 UI 路线
    const direct = await pollAgentStream(tab.id, debug, 0, domBaseline);
    if (direct && direct.ok) {
      console.log('[QC Ext] ✅ 纯后台完成（API 直连），长度:', direct.text.length);
      return direct;
    }
    console.warn('[QC Ext] ⚠️ API 直连未拿到有效回复，回退 UI 驱动路线');
    try { await clearStreamCache(); } catch (e) { /* 忽略 */ }
  }

  // ── 路线二：UI 驱动（首次使用 / 直连失败兜底）──
  // 后台页签中 Agent 页面的 React 调度（MessageChannel）被浏览器节流，
  // 「清会话确认框 → 输入 → 发送」多步连环交互会卡死，故切前台执行，结束自动切回。
  let rcaPrevTabId = 0;
  try {
    const cur = await chrome.tabs.query({ active: true, currentWindow: true });
    if (cur && cur[0] && cur[0].id !== tab.id) rcaPrevTabId = cur[0].id;
    if (rcaPrevTabId) await chrome.tabs.update(tab.id, { active: true });
  } catch (e) { /* 忽略 */ }

  try {
    // 第一步：注入驱动脚本——切换 Skill、清空上一轮会话、填入 prompt 并发送，发完即返回
    // 环境由 sourceUrl 推导传入（正式=ics.alipay.com，预发=ics-site-pre.alipay.com）。
    // 正式环境清会话只保留「垃圾桶」：跳过「新建会话(方法0)」和「历史(方法2)」。
    // 注：isFormal 已在前文（路线二之前）计算，此处复用。
    // 崩溃自捕获钩子（MAIN world，幂等）：页面 React 一旦崩溃（如 reading 'content'），
    // 把「崩溃发生时的最后执行步骤」和错误信息写进 console + DOM data 属性，便于定位崩在哪一步。
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: () => {
          if (window.__QC_CRASH_HOOK__) return;
          window.__QC_CRASH_HOOK__ = true;
          const record = (msg) => {
            let step = 'unknown';
            try { step = document.documentElement.getAttribute('data-qc-step') || 'unknown'; } catch (e2) {}
            const line = '[QC_CRASH] at-step=' + step + ' ' + msg;
            try { console.error(line); } catch (e2) {}
            try { document.documentElement.setAttribute('data-qc-crash', line); } catch (e2) {}
          };
          window.addEventListener('error', e => record('error: ' + (e && e.message || String(e)) + ' @' + (e && e.filename || '') + ':' + (e && e.lineno || '')), true);
          window.addEventListener('unhandledrejection', e => record('unhandledrejection: ' + String((e && e.reason) || e)), true);
        }
      });
    } catch (e) { /* 钩子注入失败不阻断主流程 */ }

    let sent;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: driveAgent,
        args: [keyword, skill, opts, isFormal]
      });
      sent = results && results[0] && results[0].result;
    } catch (err) {
      return { ok: false, error: 'inject-failed: ' + String(err && err.message || err), directApi: debug };
    }
    if (!sent) return { ok: false, error: 'empty-result', directApi: debug };
    // 把 skillDebug 打印到 background console，方便排查（含直连诊断）
    if (sent.skillDebug) {
      sent.skillDebug.directApi = debug;
      console.log('[QC Ext] skillDebug:', JSON.stringify(sent.skillDebug));
    }
    if (!sent.ok) return sent; // { ok:false, error:'no-input', skillDebug }

    // 第二步：优先网络层直捕 SSE 流（解析精准且快），失败回退 DOM 轮询
    let polled = await pollAgentStream(tab.id, sent.skillDebug, 0, domBaseline);
    if (!polled) polled = await pollAssistantReply(tab.id, sent.skillDebug);
    return polled;
  } finally {
    // 无论成功失败，切回用户原来的页签
    if (rcaPrevTabId) {
      try { await chrome.tabs.update(rcaPrevTabId, { active: true }); } catch (e) { /* 忽略 */ }
    }
  }
}

// 注入「保活」脚本（MAIN world）：页签留在后台时尽量让 Agent 页面照常运行——
//  ① 伪装 document.visibilityState/hidden 为可见，应用读到的始终是前台状态；
//  ② 拦截 visibilitychange/pagehide/freeze 等生命周期事件，避免触发应用隐藏逻辑；
//  ③ 播放近无声音频，使页签豁免 Chrome 的后台高强度定时器节流。
async function keepAwakeTab(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        // 重复注入时不重装拦截器，但要重试恢复音频：首次注入若无用户手势，
        // AudioContext 会因自动播放策略停在 suspended，豁免根本不生效
        if (window.__QC_KEEP_AWAKE__) {
          try {
            const c = window.__QC_AWAKE_CTX__;
            if (c && c.state === 'suspended') c.resume().catch(() => {});
          } catch (e) { /* 忽略 */ }
          return window.__QC_AWAKE_CTX__ ? window.__QC_AWAKE_CTX__.state : 'no-audio';
        }
        window.__QC_KEEP_AWAKE__ = true;
        try {
          Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        } catch (e) { /* 忽略 */ }
        for (const ev of ['visibilitychange', 'pagehide', 'freeze']) {
          try {
            document.addEventListener(ev, e => { try { e.stopImmediatePropagation(); } catch (e2) {} }, true);
          } catch (e) { /* 忽略 */ }
        }
        try {
          window.addEventListener('blur', e => { try { e.stopImmediatePropagation(); } catch (e2) {} }, true);
        } catch (e) { /* 忽略 */ }
        try {
          const AC = window.AudioContext || window.webkitAudioContext;
          if (AC) {
            const ctx = new AC();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            gain.gain.value = 0.0001; // 近无声，仅为获得「播放中」状态豁免节流
            osc.connect(gain); gain.connect(ctx.destination);
            osc.start();
            window.__QC_AWAKE_CTX__ = ctx;
            if (ctx.state === 'suspended') ctx.resume().catch(() => {});
            return ctx.state;
          }
        } catch (e) { /* 音频不可用时依赖前两招 */ }
        return 'no-audio';
      }
    });
  } catch (e) { /* 保活注入失败不阻断主流程 */ }
}

// ══ 网络层直捕 Agent 回复（SSE）：不依赖页面渲染，后台页签被节流也能拿到结果 ══
// hook.js 把 qa/chat.json 的响应流累积在 window.__QC_AGENT_STREAM__，这里轮询读取并解析。
const STREAM_APPEAR_WAIT = 12000; // 发送后等流出现的最长时间，超过则回退 DOM 轮询
const STREAM_STALL_DONE = 10000;  // 流停止增长这么久且已解析出回复 → 视为完成（长连接保活场景）
const STREAM_ANSWER_GRACE = 8000; // 答案 finished 后再观察这么久，没有新流才确认真正结束
const STREAM_TOOL_SHORT_GRACE = 45000; // 「短答案 + 含工具调用」的完成流视为中间轮，等下一条流这么久
// （多轮工具调用场景：每轮对应一条 chat.json 流，轮间隔着一轮服务端工具执行，间隔可远超 8 秒。
//   中间轮的 TEXT 是旁白（如「query_chat_record 失败了。让我尝试…」，短小），最终结果在最后一条流里；
//   长答案（正式优化结果/RCA 报告）不受影响，仍按短宽限期尽快返回）
const STREAM_NEXT_WAIT = 8000;    // 流结束但没解析出答案时，再等这么久仍无进展 → 激活页签兜底
const DOM_STABLE_MS = 6000;       // DOM 气泡须连续这么久一字不变才认定输出结束
// （工具轮间隙/流式输出的停顿都可能超过 2 秒，按次数判稳定会误判；6 秒 + 「生成中」指示一票否决双保险）

// 解析 qa/chat.json 的 SSE 原文（真实格式，多轮样本确认）：
// 载荷 {data:{finished, message:[{id, type, content}...]}}；
// 每个事件的 id 都是新的（不能按 id 分组），content 为增量片段，须按 type 分组拼接；
// type 实测有 THINKING（思考过程）、TOOL_RESULT（工具结果）、TEXT（正式答案）；
// finished=true 表示本轮回复结束。
function extractStreamText(raw) {
  const events = String(raw).split(/\r?\n\r?\n/);
  const typeBuf = {}, typeOrder = [];
  let finished = false;
  for (const ev of events) {
    let dataStr = '';
    for (const ln of ev.split(/\r?\n/)) {
      if (/^data:/.test(ln)) dataStr += ln.replace(/^data:/, '').trim();
    }
    if (!dataStr || dataStr === '[DONE]') continue;
    let obj = null;
    try { obj = JSON.parse(dataStr); } catch (e) { continue; }
    const d = (obj && obj.data && typeof obj.data === 'object') ? obj.data : obj;
    if (!d || typeof d !== 'object') continue;
    if (d.finished === true) finished = true;
    const msgs = Array.isArray(d.message) ? d.message : (d.message ? [d.message] : []);
    for (const m of msgs) {
      if (!m || typeof m.content !== 'string' || !m.content) continue;
      const t = String(m.type || 'TEXT');
      if (!(t in typeBuf)) { typeBuf[t] = ''; typeOrder.push(t); }
      typeBuf[t] += m.content; // 增量片段按 type 累积
    }
  }
  // 答案 = 最后一个「非思考、非工具」type 分组（实测为 TEXT）；
  // THINKING 是思考过程，TOOL_* 是工具调用/结果（如 "Successfully loaded skill..." 技能加载通知）
  const isNoise = t => /think/i.test(t) || /tool/i.test(t);
  const ansTypes = typeOrder.filter(t => !isNoise(t));
  const ansType = ansTypes.length ? ansTypes[ansTypes.length - 1] : '';
  const hasAnswer = !!ansType;
  let text = ansType ? String(typeBuf[ansType]).trim() : '';
  while (/^思考过程/.test(text)) text = text.replace(/^思考过程[：:\s]*/, '').trim();
  // 清理残留的思考标签（TEXT 段头部偶带 <think>/</think>）与多余空行
  text = text.replace(/<\/?think>/gi, '').replace(/\n{3,}/g, '\n\n').trim();
  const segs = typeOrder.map(t => ({ type: t, len: typeBuf[t].length }));
  const lastSegs = segs.slice(-3).map(s => ({ type: s.type, len: s.len, head: typeBuf[s.type].slice(0, 150) }));
  return { text, finished, hasAnswer, segs, lastSegs };
}

// 读取 Agent 页面最后一条 assistant 气泡的正文（前台页签的 DOM 渲染的是完整最终回复，
// 比单条 chat.json 流更完整——回复可能被拆在多条流里，任何单条都可能是截断的）。
// 同时返回 busy：页面是否仍处于「生成中」（停止按钮/加载指示/输入框禁用等），
// 用于 DOM 稳定性判定的一票否决——工具轮间隙 DOM 也会静止，不能只凭不变就认定结束。
async function readAssistantDom(tabId) {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const nodes = document.querySelectorAll('[class*="messageBubbleAssistant"]');
        const last = nodes.length ? nodes[nodes.length - 1] : null;
        // ── 「生成中」指示探测（多候选，任一命中即视为仍在输出）──
        let busy = false, busyHint = '';
        try {
          // ① 停止生成按钮（文本或类名含 停止/stop）
          const btns = document.querySelectorAll('button, [role="button"], a, span');
          for (const b of btns) {
            const txt = ((b.textContent || '').trim());
            if (txt === '停止' || txt === '停止生成' || /stop/i.test(txt)) { busy = true; busyHint = 'stop-btn'; break; }
            const cls = String(b.className || '');
            if (/stop/i.test(cls)) { busy = true; busyHint = 'stop-cls'; break; }
          }
          // ② 旋转加载指示（限最后一个气泡所在的会话容器内，避开页面其他 spinner）
          if (!busy && last) {
            const cont = last.closest('[class*="chat" i], [class*="message" i], [class*="conversation" i]') || document.body;
            if (cont.querySelector('.ant-spin-spinning, [class*="loading" i], [class*="generating" i], [class*="typing" i]')) {
              busy = true; busyHint = 'spinner';
            }
          }
          // ③ 输入框/发送区被禁用（生成期间常见）
          if (!busy) {
            const ta = document.querySelector('textarea[placeholder*="描述你想要的质检规则"]');
            if (ta && ta.disabled) { busy = true; busyHint = 'input-disabled'; }
          }
        } catch (e) { /* 探测失败不影响正文读取 */ }
        if (!last) return { text: '', busy, busyHint };
        // 优先取正文区 .mdBlock，避开「思考过程」toggle 的噪音；否则退回整块文本
        const block = last.querySelector('.mdBlock, [class*="mdBlock"]');
        let t = (block ? block.innerText : last.innerText || last.textContent || '').trim();
        // 去掉文本最前面的「思考过程」字样
        while (/^思考过程/.test(t)) t = t.replace(/^思考过程[：:\s]*/, '').trim();
        return { text: t, busy, busyHint };
      }
    });
    const r = (res && res[0] && res[0].result) || { text: '', busy: false, busyHint: '' };
    let text = String(r.text || '');
    // 新对话的默认「欢迎语」气泡不是回复
    if (text && text.length < 200 && /你好|我是质检规则助手|描述你想要的质检规则/.test(text)) text = '';
    return { text, busy: !!r.busy, busyHint: String(r.busyHint || '') };
  } catch (e) { return { text: '', busy: false, busyHint: '' }; }
}

// 轮询网络层流缓存；返回 null 表示无流/解析失败 → 调用方回退 DOM 轮询
// 一次 RCA 会产生多条 chat.json 流：工具调用轮（THINKING + TOOL_RESULT）→ 答案轮（正式回复）。
// hook.js 把所有流按顺序存在 window.__QC_AGENT_STREAMS__，这里取「最后一条含答案段的流」。
async function pollAgentStream(tabId, skillDebug, maxWait, domBaseline) {
  const limit = maxWait || DRIVE_TIMEOUT; // API 直连路线传短时限，拿不到尽快回退 UI 路线
  const start = Date.now();
  let lastTotal = -1, stallSince = 0, answerDoneSince = 0, allDoneSince = 0, seenTurns = 0;
  let activated = false, prevTabId = 0;
  let lastDomText = '', domStableSince = 0; // 长宽限期内的 DOM 气泡稳定性判定（时间制）
  let busyLogAt = 0; // busy 否决诊断日志的节流时间戳
  // 曾为触发答案轮而激活过 Agent 页签：成功拿到回复后切回用户原来的页签
  const restoreActive = async () => {
    if (activated && prevTabId) {
      try { await chrome.tabs.update(prevTabId, { active: true }); } catch (e) { /* 忽略 */ }
    }
  };
  for (;;) {
    await sleep(POLL_INTERVAL);
    let streams = null;
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
          const arr = Array.isArray(window.__QC_AGENT_STREAMS__) && window.__QC_AGENT_STREAMS__.length
            ? window.__QC_AGENT_STREAMS__
            : (window.__QC_AGENT_STREAM__ ? [window.__QC_AGENT_STREAM__] : []);
          return arr.map(e => ({ raw: e.raw, done: e.done, err: e.err, chunks: e.chunks || 0 }));
        }
      });
      streams = (res && res[0] && res[0].result) || null;
    } catch (e) { /* 页面导航瞬间，继续等待 */ }
    if (!streams || !streams.length) {
      if (Date.now() - start > STREAM_APPEAR_WAIT) return null; // 流没出现 → 回退 DOM 轮询
      continue;
    }
    if (streams.length > seenTurns) {
      console.log('[QC Ext] 捕获到第 ' + streams.length + ' 条 chat 流');
      seenTurns = streams.length;
      answerDoneSince = 0; allDoneSince = 0; stallSince = 0; // 新流出现，各计时器重置
      domStableSince = 0; lastDomText = ''; // 新流出现 → DOM 稳定判定重新计时
    }
    const parsed = streams.map(s => ({ s, p: extractStreamText(s.raw || '') }));
    // 取最后一条已出现答案段的流（答案轮在工具轮之后）
    let best = null;
    for (let i = parsed.length - 1; i >= 0; i--) {
      if (parsed[i].p.hasAnswer && parsed[i].p.text.length >= 20) { best = parsed[i]; break; }
    }
    const totalLen = streams.reduce((a, s) => a + s.raw.length, 0);
    const allDone = streams.every(s => s.done);
    if (best) {
      const complete = best.p.finished || best.s.done;
      if (complete) {
        // 答案轮已完成：再观察一段宽限期，若期间又来一条流（多轮工具调用）会自动重置计时。
        // 自适应：答案短小且任一条流含工具段 → 大概率是多轮工具调用的中间轮旁白，
        // 用长宽限期等最终答案流；长答案（正式输出）按短宽限期尽快返回
        if (!answerDoneSince) answerDoneSince = Date.now();
        const anyTool = parsed.some(x => x.p.segs.some(sg => /tool/i.test(sg.type)));
        const shortToolTurn = anyTool && best.p.text.length < 150;
        const grace = shortToolTurn ? STREAM_TOOL_SHORT_GRACE : STREAM_ANSWER_GRACE;
        if (Date.now() - answerDoneSince > grace) {
          skillDebug.streamSegs = best.p.segs;
          skillDebug.streamTurns = streams.length;
          await restoreActive();
          console.log('[QC Ext] ✅ 网络层直捕 Agent 回复成功，长度:', best.p.text.length,
            '| 流数:', streams.length, '| 答案轮分段:', JSON.stringify(best.p.segs));
          return { ok: true, text: best.p.text, skillDebug, via: 'stream' };
        }
        // 工具场景长宽限期内：直接读 DOM 气泡做稳定判定。页面渲染的是完整最终回复
        // （比任何单条流都全——最终答案可能被拆在多条流里）。
        // 三道闸：① 页面「生成中」指示（停止按钮/spinner/输入框禁用）存在 → 一票否决；
        //         ② 气泡内容须不同于发送前基线（防 API 直连时旧气泡被采信）；
        //         ③ 连续 DOM_STABLE_MS 毫秒一字不变（工具轮间隙的静止不算结束）。
        if (shortToolTurn) {
          const dom = await readAssistantDom(tabId);
          const domText = dom.text;
          if (dom.busy) {
            domStableSince = 0; // 仍在生成 → 稳定计时清零
            if (Date.now() - busyLogAt > 5000) {
              busyLogAt = Date.now();
              console.log('[QC Ext] ⏸️ 页面仍在生成中（' + dom.busyHint + '），DOM 稳定判定暂停，气泡长度:', domText.length);
            }
          } else if (domText && domText.length >= 150 && domText !== domBaseline) {
            if (domText !== lastDomText) {
              lastDomText = domText;
              domStableSince = Date.now(); // 内容变了 → 重新起算
            } else if (!domStableSince) {
              domStableSince = Date.now();
            }
            const stableFor = Date.now() - domStableSince;
            if (stableFor >= DOM_STABLE_MS) {
              skillDebug.streamSegs = best.p.segs;
              skillDebug.streamTurns = streams.length;
              await restoreActive();
              console.log('[QC Ext] ✅ Agent 回复完成（DOM 气泡稳定 ' + Math.round(stableFor / 1000) +
                's，比单条流更完整），长度:', domText.length);
              return { ok: true, text: domText, skillDebug, via: 'dom-bubble' };
            }
          } else {
            domStableSince = 0; // 气泡过短/等于基线 → 不采信，计时清零
          }
        }
      }
    }
    // 所有流都已结束但还没拿到答案段：先等答案轮自己出现；等不到则激活页签触发一次
    if (!best && allDone) {
      if (!allDoneSince) allDoneSince = Date.now();
      if (Date.now() - allDoneSince > STREAM_NEXT_WAIT) {
        if (!activated) {
          // 后台页签不会发出后续「答案轮」请求（实测确认）→ 激活 Agent 页签触发，然后再等一轮
          try {
            const cur = await chrome.tabs.query({ active: true, currentWindow: true });
            prevTabId = (cur && cur[0] && cur[0].id !== tabId) ? cur[0].id : 0;
            await chrome.tabs.update(tabId, { active: true });
            activated = true;
            allDoneSince = Date.now();
            console.warn('[QC Ext] ⚠️ 答案轮流未在后台发出，已激活 Agent 页签触发后续请求（完成后自动切回）');
            continue;
          } catch (e) { /* 激活失败，走下方放弃逻辑 */ }
        }
        // 已激活过一次仍无答案段 → 放弃流通道，回退 DOM 轮询（保持前台正好利于 DOM 轮询）
        const last = parsed[parsed.length - 1];
        const rawStr = String(last.s.raw || '');
        const sample = 'HEAD>>>' + rawStr.slice(0, 800) + '\n<<<TAIL>>>' + rawStr.slice(-400) + '<<<END';
        skillDebug.streamSample = sample;
        skillDebug.streamSegsAll = parsed.map(x => x.p.segs);
        // 类型统计（各 type 的总字数）+ 末 3 段内容摘要：看清答案到底在不在流里、长什么样
        const typeStat = {};
        for (const x of parsed) for (const sg of x.p.segs) typeStat[sg.type] = (typeStat[sg.type] || 0) + sg.len;
        if (activated && prevTabId) skillDebug.restoreTabId = prevTabId; // DOM 轮询结束后由 handleDrive 切回
        console.warn('[QC Ext] ⚠️ ' + streams.length + ' 条流均无答案段（rawLen=' + rawStr.length +
          '），回退 DOM 轮询。类型统计:' + JSON.stringify(typeStat) +
          ' 末3段:' + JSON.stringify(last.p.lastSegs));
        return null;
      }
    } else if (!allDone) {
      allDoneSince = 0;
    }
    // 流停止增长 + 已有可解析回复 → 视为完成（服务端可能保持长连接不关闭）
    if (totalLen === lastTotal) {
      if (!stallSince) stallSince = Date.now();
      if (best && Date.now() - stallSince > STREAM_STALL_DONE) {
        skillDebug.streamSegs = best.p.segs;
        skillDebug.streamTurns = streams.length;
        await restoreActive();
        console.log('[QC Ext] ✅ 网络层直捕 Agent 回复成功（流停止增长），长度:', best.p.text.length,
          '| 流数:', streams.length, '| 答案轮分段:', JSON.stringify(best.p.segs));
        return { ok: true, text: best.p.text, skillDebug, via: 'stream-stall' };
      }
    } else {
      lastTotal = totalLen;
      stallSince = 0;
    }
    if (Date.now() - start > limit) {
      console.warn('[QC Ext] ⏱️ 网络层捕获超时，流数:', streams.length, '已有答案长度:', best ? best.p.text.length : 0);
      if (best) {
        await restoreActive();
        return { ok: false, error: 'timeout', text: best.p.text, skillDebug };
      }
      if (activated && prevTabId) skillDebug.restoreTabId = prevTabId;
      return null;
    }
  }
}

// 后台轮询 Agent 页面的最后一条 assistant 回复：连续 STABLE_POLLS 次内容不变视为完成；
// 超过 DRIVE_TIMEOUT 返回 timeout（附带已收到的部分文本）。
async function pollAssistantReply(tabId, skillDebug) {
  const start = Date.now();
  let lastText = '';
  let unchanged = 0;
  for (;;) {
    await sleep(POLL_INTERVAL);
    let text = '';
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const nodes = document.querySelectorAll('[class*="messageBubbleAssistant"]');
          const last = nodes.length ? nodes[nodes.length - 1] : null;
          if (!last) return '';
          // 优先取正文区 .mdBlock，避开「思考过程」toggle 的噪音；否则退回整块文本
          const block = last.querySelector('.mdBlock, [class*="mdBlock"]');
          let t = (block ? block.innerText : last.innerText || last.textContent || '').trim();
          // 去掉文本最前面的「思考过程」字样
          while (/^思考过程/.test(t)) t = t.replace(/^思考过程[：:\s]*/, '').trim();
          return t;
        }
      });
      text = String((res && res[0] && res[0].result) || '');
      // 新对话的默认「欢迎语」气泡不是回复：回复气泡尚未出现时最后一条就是欢迎语，
      // 若不加排除会被稳定性判定误当成回复提前返回
      if (text && text.length < 200 && /你好|我是质检规则助手|描述你想要的质检规则/.test(text)) text = '';
    } catch (e) { /* 页面导航/重载瞬间读取失败，继续等待 */ }
    // 过滤未成型/过短的碎片，再判定内容是否稳定
    if (text.length >= 20 && text === lastText) {
      unchanged++;
      if (unchanged >= STABLE_POLLS) {
        console.log('[QC Ext] ✅ 收到回复，长度:', text.length);
        return { ok: true, text, skillDebug };
      }
    } else if (text && text !== lastText) {
      lastText = text;
      unchanged = 1;
    }
    if (Date.now() - start > DRIVE_TIMEOUT) {
      console.warn('[QC Ext] ⏱️ 超时，最后文本长度:', lastText.length);
      return { ok: false, error: 'timeout', text: lastText, skillDebug };
    }
  }
}

async function handleDriveToResult(keyword, sourceUrl) {
  const r = await handleDrive(keyword, undefined, undefined, sourceUrl);
  if (!r.ok) return { ok: false, error: 'no-cache-and-agent-failed: ' + String(r.error || '') };
  const text = String(r.text || '').trim();
  if (!text) return { ok: false, error: 'no-cache-and-agent-empty' };
  return { ok: true, mode: 'agent', text, url: agentPageOf(sourceUrl), via: 'Agent 页面回复（跨页签兜底）' };
}

async function handleRCA(prompt, sourceUrl, newSession) {
  // RCA 根因分析：切到「质检规则Agent」（其 systemPrompt 内含 RCA 路由，会自动加载 qc-rca-analyzer Skill）
  // skipDirectApi：RCA/对话必须「真实发送」（直连模板重放实测会被服务端静默拒绝），走 UI 驱动路线。
  // newSession：是否本轮新一轮（由 content.js 决定）。预发环境 RCA 直接发送(newSession=false)
  // 沿用当前会话直接发；用户新发提示词(newSession=true)先清会话。
  // 注：v5.0.5 起 RCA 直发也改为 newSession=true（预发同样新建会话），false 分支仅历史兼容。
  return await handleDrive(prompt, '质检规则Agent', { skipDirectApi: true, newSession: !!newSession }, sourceUrl);
}

// 轮询注入探针，直到 Agent 页面聊天输入框可用。
// ⚠️ 方案A 后「不再点停止」：预发 SSE 流永不 close，页面会一直卡在「生成中」（停止按钮常驻、
//    输入框 disabled）；而实测「内容输出后点停止」会触发 systemPrompt.content 崩溃。改由 hook.js
//    的 wrapChatStream 在数据停滞后主动 close 流 → 页面 React 自然收尾 → 输入框恢复可编辑。
//    这里只做纯轮询等待，把解卡完全交给 hook.js，避免任何程序化中断流导致的崩溃。
async function waitForReady(tabId, maxWait = 60000) {
  const startedAt = Date.now();
  for (;;) {
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          // 目标输入框出现且可编辑即就绪（生成中时 placeholder 变为「AI 正在回复中...」且 disabled，
          // 匹配不到就绪条件 → 继续轮询，等 hook.js 自动关流后页面恢复）
          const ta = document.querySelector('textarea[placeholder*="描述你想要的质检规则"]');
          return { ready: !!(ta && !ta.disabled) };
        }
      });
      const r = res && res[0] && res[0].result;
      if (r && r.ready) return true;
    } catch (e) { /* 页面尚未加载完成，继续等待 */ }
    if (Date.now() - startedAt > maxWait) return false;
    await sleep(1000);
  }
}

// ── 注入到 Agent 页面的驱动函数（自包含，运行于该页面上下文）──
// 职责：切换 Skill → （可选）清空上一轮会话 → 填入 prompt 并发送；发完即返回。
// 回复轮询由 background 的 pollAssistantReply 负责（页面内 setTimeout 在后台页签会被节流）。
async function driveAgent(keyword, skillName, opts, isFormal) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  console.log('[QC v4.17.23] driveAgent start, skillName=' + (skillName || '(none)') + ', isFormal=' + !!isFormal)

  // opts.newSession=false 表示「RCA 直接发送」轮，两个环境均沿用当前会话、不清会话
  // （直接发送前 RCA 生成轮可能刚结束流式，waitForReady 已等 hook.js 自动关流、输入框恢复，
  // 此时再清会话会叠加删除/新建操作触发 React 渲染崩溃）；
  // 其余情况（首轮生成 RCA / 用户新一轮提示词）维持每次清会话的既有行为。
  const shouldClearSession = !(opts && opts.newSession === false);

  // 逐步打点：把当前执行步骤写入 DOM data 属性（MAIN world 崩溃钩子读取）并打印 console，
  // 崩溃时能定位到崩在哪一步，而不是只见白屏报错。
  const markStep = (n, label) => {
    try { document.documentElement.setAttribute('data-qc-step', n); } catch (e) {}
    console.warn('[QC 步骤 ' + n + '] ' + (label || ''));
  };

  // ═══════════════════════════════════════
  // 前置：确保已切换到目标 Skill
  // ═══════════════════════════════════════
  let skillDebug = {
    version: '4.17.23', needSwitch: false, foundSelector: false,
    oldSkill: '', switched: false, triedMethods: [], allSelectTexts: [], availableOptions: []
  };

  if (skillName) {
    const findSkillSelect = () => {
      const m1 = document.querySelector('.chatHeaderAgentSelect-fSCiDfST');
      if (m1) { skillDebug.triedMethods.push('exact'); return m1; }
      const m2 = document.querySelector('div[class*="chatHeaderAgentSelect"]');
      if (m2) { skillDebug.triedMethods.push('fuzzy-chatHeader'); return m2; }
      const header = document.querySelector('[class*="chatHeader"]');
      if (header) {
        const m3 = header.querySelector('.ant-select');
        if (m3) { skillDebug.triedMethods.push('header-ant-select'); return m3; }
      }
      return null;
    };

    let select = findSkillSelect();
    skillDebug.foundSelector = !!select;

    // ── 终极兜底：遍历所有 ant-select，通过展开下拉查看 item 内容来定位目标 Skill ──
    if (!select) {
      console.log('[QC v4.17.23] 标准选择器未命中，启动 ant-select 全局扫描…');
      const allSelects = Array.from(document.querySelectorAll('.ant-select'));
      skillDebug.allSelectTexts = allSelects.map(s => {
        const item = s.querySelector('.ant-select-selection-item');
        return item ? item.textContent.trim() : '';
      }).filter(Boolean);
      console.log('[QC v4.17.23] 发现 ' + allSelects.length + ' 个 .ant-select，当前文本:', skillDebug.allSelectTexts);

      for (const s of allSelects) {
        const item = s.querySelector('.ant-select-selection-item');
        const currentTxt = item ? item.textContent.trim() : '';
        if (!currentTxt) continue;

        // 如果当前已经是目标 skill，直接命中
        if (currentTxt.includes(skillName)) {
          select = s;
          skillDebug.triedMethods.push('scan-already-target');
          console.log('[QC v4.17.23] 扫描命中已处于目标 Skill 的选择器');
          break;
        }

        // 否则展开这个 select，看看下拉里有没有目标
        s.click();
        await sleep(800);
        let foundInDropdown = false;
        const dropdowns = document.querySelectorAll('.ant-select-dropdown');
        for (const dd of dropdowns) {
          if (window.getComputedStyle(dd).display === 'none') continue;
          const opts = dd.querySelectorAll('.ant-select-item-option-content, .ant-select-item');
          for (const opt of opts) {
            if (opt.textContent.includes(skillName)) {
              opt.click();
              foundInDropdown = true;
              skillDebug.triedMethods.push('scan-dropdown-click');
              console.log('[QC v4.17.23] 扫描 dropdown 命中并点击目标 Skill');
              break;
            }
          }
          if (foundInDropdown) break;
        }
        // 没展开出目标，按 Escape 关掉避免干扰
        if (!foundInDropdown) {
          document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          await sleep(200);
        } else {
          select = s;
          break;
        }
      }
      skillDebug.foundSelector = !!select;
    }

    if (select) {
      const currentItem = select.querySelector('.ant-select-selection-item');
      const oldName = currentItem ? (currentItem.textContent || '').trim() : '';
      skillDebug.oldSkill = oldName;
      skillDebug.needSwitch = !oldName.includes(skillName);
      console.log('[QC v4.17.23] 当前 Agent:', oldName, '| 需要切换:', skillDebug.needSwitch);

      if (!oldName.includes(skillName)) {
        // ★ 打开下拉：antd v5 真正监听 .ant-select-selector 的 mousedown，
        //   仅点外层 (chatHeaderAgentSelect/.ant-select) 不触发，这里定位到内层触发元素。
        const selEl = select.querySelector('.ant-select-selector') || select.querySelector('.ant-select') || select;
        selEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, button: 0 }));
        selEl.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, button: 0 }));
        selEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        // 兜底：外层再点一次
        select.click();
        await sleep(1000);

        let switched = false;
        let allOptions = [];
        let debugHtml = '';
        for (let i = 0; i < 25; i++) {
          // 尝试多种下拉菜单选择器（下拉由 rc-trigger portal 渲染，类名可能带前缀）
          const dropdowns = document.querySelectorAll('.ant-select-dropdown, [class*="ant-select-dropdown"], [class*="select-dropdown"], div[role="listbox"], [role="listbox"], .rc-virtual-list, div[class*="rc-virtual-list"]');
          console.log('[QC v4.17.23] 第' + (i+1) + '次尝试，发现 ' + dropdowns.length + ' 个下拉菜单');
          for (const dd of dropdowns) {
            const style = window.getComputedStyle(dd);
            console.log('[QC v4.17.23] 下拉菜单 display=' + style.display + ', visibility=' + style.visibility + ', height=' + style.height);
            if (style.display === 'none' || style.visibility === 'hidden' || style.height === '0px') continue;
            // 尝试多种选择器找选项
            const options = dd.querySelectorAll('.ant-select-item-option, [role="option"], .rc-virtual-list-holder div[title], .ant-select-item');
            console.log('[QC v4.17.23] 找到 ' + options.length + ' 个选项');
            if (options.length === 0) {
              const fallback = dd.querySelectorAll('div[class*="item"], div[class*="option"], [class*="rc-virtual-list"]');
              console.log('[QC v4.17.23] fallback 找到 ' + fallback.length + ' 个元素');
              for (const fb of fallback) {
                const txt = (fb.textContent || '').trim();
                if (txt.length > 1 && txt.length < 50 && !allOptions.includes(txt)) allOptions.push(txt);
              }
              debugHtml = dd.innerHTML.substring(0, 800);
            } else {
              for (const opt of options) {
                const content = opt.querySelector('.ant-select-item-option-content');
                const txt = content ? content.textContent.trim() : (opt.textContent || '').trim();
                if (!allOptions.includes(txt)) allOptions.push(txt);
                if (txt.includes(skillName)) {
                  console.log('[QC v4.17.23] 找到目标选项:', txt);
                  opt.click();
                  await sleep(600);
                  switched = true;
                  console.log('[QC v4.17.23] ✅ 已点击目标选项:', txt);
                  break;
                }
              }
            }
            if (switched) break;
          }
          if (switched) break;
          document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          await sleep(500);
        }
        skillDebug.switched = switched;
        skillDebug.availableOptions = allOptions.slice(0, 20);
        console.log('[QC v4.17.23] 切换结果:', switched, '| 找到选项:', allOptions.length);
        console.log('[QC v4.17.23] 选项列表:', allOptions);
        if (debugHtml) console.log('[QC v4.17.23] 下拉菜单 HTML 片段:', debugHtml);
        if (!switched && allOptions.length > 0) {
          console.log('[QC v4.17.23] ⚠️ 未找到目标，目标应为:', skillName);
        }
        // ★ 切换失败时抓取 Agent 头部 DOM，便于下一步精准定位（避免反复盲试）
        if (!switched) {
          try {
            const scope = document.querySelector('[class*="chatHeader"]') || document.body;
            skillDebug.agentHeaderHtml = (scope.outerHTML || scope.innerHTML || '').slice(0, 2500);
          } catch (e) { skillDebug.agentHeaderHtml = 'ERR:' + e; }
        }
        if (switched) await sleep(600);
      }
    } else {
      console.warn('[QC v4.17.23] ⚠️ 未找到任何 Skill 选择器，将使用当前默认 Skill');
    }
  }

  const ta = document.querySelector('textarea[placeholder*="描述你想要的质检规则"]');
  if (!ta) {
    console.error('[QC v4.17.23] ❌ textarea 输入框未找到');
    return { ok: false, error: 'no-input', skillDebug };
  }

  // ═══════════════════════════════════════
  // 前置：清除上一轮会话（用户可能多次调用 RCA，需保证本次独立、不使用旧上下文）
  // ═══════════════════════════════════════
  // 预发环境：仅在新一轮（用户新发送提示词 / RCA 直发）时清会话；false 时沿用当前会话直接发。
  // 正式环境：维持「每次发送均清会话」的既有行为。
  // ⚠️ 方案A 后全程不再程序化点「停止」：前置 waitForReady 已确保输入框可编辑（页面未卡「生成中」）；
  //    若仍偶发卡在生成中（预发 SSE 流永不 close），交由 hook.js 的 wrapChatStream 数据停滞后自动
  //    close 流解卡，这里只轮询等待页面恢复，绝不点停止（内容输出后点停止会触发 systemPrompt.content 崩溃）。
  if (shouldClearSession) {
    markStep('2-clear-session', '进入清会话阶段（新一轮：等页面解卡后新建/删除会话）');
    // 辅助判断：textarea placeholder 在生成中会变为「AI 正在回复中...」，
    // 但停止按钮的检测优先于 textarea，避免 textarea 找不到时误判为“稳定”。
    const isGenerating = () => {
      try {
        return Array.from(document.querySelectorAll('button')).some(el => {
          const t = (el.textContent || '').trim();
          return /停止|stop/i.test(t) && (el.className || '').toLowerCase().includes('danger');
        });
      } catch (e) { return false; }
    };
    const isTextareaReady = () => {
      try {
        const probe = document.querySelector('textarea[placeholder*="描述你想要的质检规则"]');
        return !!(probe && !probe.disabled);
      } catch (e) { return false; }
    };
    // 步骤 A：若页面仍卡在「生成中」，不再点「停止」——内容输出后点停止会触发 systemPrompt.content 崩溃。
    // 改由 hook.js 的 wrapChatStream 在数据停滞后自动 close 流，页面 React 自然收尾；这里只轮询等其恢复可编辑。
    if (isGenerating()) {
      console.log('[QC v4.17.23] 检测到 Agent 仍在生成中，等待 hook.js 自动关流解卡（不点停止）');
      // 等停止按钮消失（hook.js 关流后 React 收尾）+ textarea 恢复可用，最长 ~15s
      for (let w = 0; w < 30; w++) {
        if (!isGenerating() && isTextareaReady()) break;
        await sleep(500);
      }
      await sleep(800); // 收尾后额外留白，确保 React 状态稳定再操作会话
    }
    // 步骤 B：持续稳定检测（textarea 可用 + 无停止按钮 连续 3s）。
    // 不再在检测期间点「停止」——同样交给 hook.js 自动关流；这里仅在页面仍生成中时重置计时并等待。
    const STABLE_REQUIRED = 3000;
    let stableSince = Date.now();
    for (let s = 0; s < 30; s++) {
      const stableNow = isTextareaReady() && !isGenerating();
      if (stableNow) {
        if (Date.now() - stableSince >= STABLE_REQUIRED) break;
      } else {
        stableSince = Date.now();
      }
      await sleep(500);
    }
    // 新对话也会有一条默认「欢迎语」assistant 气泡，不能以"气泡数为 0"判断清空成功；
    // 改为：记录清理前的气泡快照，清理后内容变化或仅剩欢迎语即视为成功。
    const bubbleTexts = () => Array.from(document.querySelectorAll('[class*="messageBubbleAssistant"]'))
      .map(n => ((n.innerText || n.textContent) || '').trim().slice(0, 120));
    const WELCOME_RE = /你好|我是质检规则助手|描述你想要的质检规则/;
    const stripThink = (s) => { let t = String(s || '').trim(); while (/^思考过程/.test(t)) t = t.replace(/^思考过程[：:\s]*/, '').trim(); return t; };
    const isFreshState = (texts) => texts.length === 0 ||
      (texts.length === 1 && WELCOME_RE.test(stripThink(texts[0])));

    const beforeSnap = bubbleTexts();
    const hasOldSession = !isFreshState(beforeSnap);
    let cleared = false;
    let clearMethod = '';
    // 严格验证：只有气泡真正重置为「空 / 仅欢迎语」才算清除成功。
    // 不能以「快照有变化」放行——上一轮流式输出末段抖动/截断差异都会让快照变化，
    // 误判放行会让第二次提示词带着旧会话上下文发送（Agent 输出残留上一轮格式数据）。
    const verifyCleared = () => isFreshState(bubbleTexts());
    // 轮询等待重置完成（页面删除会话后异步加载欢迎语），最长 timeout 毫秒
    const waitForFresh = async (timeout) => {
      const t0 = Date.now();
      for (;;) {
        if (verifyCleared()) return true;
        if (Date.now() - t0 >= timeout) return false;
        await sleep(300);
      }
    };
    // 点击 chatHeader 垃圾桶图标（删除当前会话入口）；若弹确认框则点「确定/确认/删除」
    const clickDeleteIcon = async () => {
      const headerEl0 = document.querySelector('[class*="chatHeader"]');
      const delIcon = headerEl0 && headerEl0.querySelector('.anticon-delete');
      const delBtn = delIcon && delIcon.closest('button');
      if (!delBtn) return false;
      // ⚠️ AI 流式输出期间垃圾桶/新建会话按钮是 disabled，此时 .click() 为空操作（不触发任何事件）。
      // 先轮询等按钮解除 disabled（最长 6s），确认可点击后再触发，避免"没点就报错"。
      const delT0 = Date.now();
      while ((delBtn.disabled || delBtn.getAttribute && delBtn.getAttribute('aria-disabled') === 'true') && Date.now() - delT0 < 6000) {
        await sleep(200);
      }
      // ⚠️ 会话切换安抚（与「新建会话」同源）：删除当前会话同样是破坏性操作，
      // 连续第二轮时 React 仍持有上一会话状态，毫秒级直接删除会触发与 reading 'content'
      // 同类的渲染崩溃。点前留白让 React 收尾（前面步骤 A/B 已等页面解卡稳定，此处再补一档）。
      await sleep(1200);
      delBtn.click();
      await sleep(1500);
      const modals = Array.from(document.querySelectorAll('.ant-modal, .ant-modal-confirm, [class*="modal"], [class*="Modal"], .ant-popconfirm'))
        .filter(m => window.getComputedStyle(m).display !== 'none');
      let confirmBtn = null;
      for (const m of modals) {
        const btns = m.querySelectorAll('button');
        for (const b of btns) {
          const t = (b.textContent || '').trim();
          if (t && t.length < 12 && /确定|确认|删除|OK|Confirm/i.test(t)) { confirmBtn = b; break; }
        }
        if (confirmBtn) break;
      }
      if (confirmBtn) { confirmBtn.click(); await sleep(600); }
      return true;
    };

    if (hasOldSession) {
      markStep('2a-new-session', '尝试「新建会话」按钮（正式环境跳过）');
      // 方法0（最优先）：直接点击页面上显式的「新建会话」按钮。
      // 预发/正式 agent 页头部常为「新建会话 + 历史会话」相邻布局，正确动作是点「新建会话」；
      // 显式排除「历史/历史会话」，避免误点相邻的历史入口导致载入旧会话/报错。
      // 命中即点击并验证会话刷新；失败则继续后续兜底方法。
      // ⚠️ 仅预发走「新建会话」；正式环境只保留「垃圾桶」，跳过本方法。
      if (!isFormal && !cleared) {
        const NEW_LABELS = ['新建会话', '新对话', '新聊天', '新的对话', '新建对话', '新增会话'];
        const SKIP_RE = /历史|history/i;
        let newBtn = null, matchedLabel = '新建';
        try {
          const cands = Array.from(document.querySelectorAll('button, [role="button"], a, [class*="new"], [class*="add"]'));
          for (const el of cands) {
            const st = window.getComputedStyle(el);
            if (st.display === 'none' || st.visibility === 'hidden') continue;
            const t = (el.textContent || '').trim();
            const title = (el.getAttribute && el.getAttribute('title')) || '';
            if (!t && !title) continue;
            if (SKIP_RE.test(t + ' ' + title)) continue;
            for (const L of NEW_LABELS) {
              if (t.includes(L) || title.includes(L)) { newBtn = el; matchedLabel = t.slice(0, 20) || L; break; }
            }
            if (newBtn) break;
          }
        } catch (e) { /* 忽略 */ }
        if (newBtn) {
          try {
            // ⚠️ 新建会话按钮在 AI 流式输出期间为 disabled，此时 .click() 是空操作（无点击动作）。
            // 先轮询等按钮解除 disabled（最长 6s），确认可点击后再触发。
            const newT0 = Date.now();
            while ((newBtn.disabled || newBtn.getAttribute && newBtn.getAttribute('aria-disabled') === 'true') && Date.now() - newT0 < 6000) {
              await sleep(200);
            }
            // ⚠️ v5.0.4 修复 reading 'content' 崩溃：人工点击「新建会话」不崩溃，
            // 但代码 .click() 崩溃。差异在于：
            //   1) .click() 只触发 click 事件，缺少 mousedown/mouseup（React/antd 依赖完整事件链）
            //   2) 代码点击时页面可能尚未完全稳定（React 内部 state 仍在过渡）
            // 修复：① 先等页面就绪（textarea 可编辑 + 无生成中）再操作；
            //       ② 用完整鼠标事件链（mousedown → mouseup → click）模拟人工。
            for (let r = 0; r < 15; r++) {
              let ready = false;
              try {
                const probe = document.querySelector('textarea[placeholder*="描述你想要的质检规则"]');
                const genStop = Array.from(document.querySelectorAll('button')).some(el => {
                  const t = (el.textContent || '').trim();
                  return /停止|stop/i.test(t) && (el.className || '').toLowerCase().includes('danger');
                });
                ready = !!(probe && !probe.disabled && !genStop);
              } catch (e) { /* */ }
              if (ready) break;
              await sleep(500);
            }
            // 人工节奏留白：人工看到按钮 → 移鼠标 → 点击，中间有自然停顿
            await sleep(1500);
            // ★ 模拟真实鼠标事件链（人工点击触发 mousedown → mouseup → click 完整序列）
            // .click() 只触发 click 事件，缺少 mousedown/mouseup，antd 的 Button 组件
            // 在 mousedown 阶段可能做状态准备（如 focus、active 态），缺失会导致
            // React 在后续重渲染中读到中间态 state（systemPrompt = undefined）而崩溃。
            const evtOpts = { bubbles: true, cancelable: true, view: window, button: 0 };
            newBtn.dispatchEvent(new MouseEvent('mousedown', evtOpts));
            await sleep(120);
            newBtn.dispatchEvent(new MouseEvent('mouseup', evtOpts));
            newBtn.dispatchEvent(new MouseEvent('click', evtOpts));
            // 点后再留白一段，让新会话的首次渲染（systemPrompt 就绪）落地，再进入气泡轮询校验。
            await sleep(2000);
            // 用轮询等会话真正重置（与方法1 垃圾桶一致），而非单次 sleep+verify：
            // 预发点「新建会话」后旧气泡异步清除、欢迎语异步加载，固定 sleep(1500) 里
            // 页面往往还没重置完，单次 verifyCleared 返回 false 会误判为「点击无效」，
            // 继续走后面方法（预发无垃圾桶）最终返回 cannot-clear-old-session。
            cleared = await waitForFresh(5000);
            clearMethod = 'direct-new-session:' + matchedLabel;
            console.log('[QC v4.17.23] ✅ 点击「新建会话」按钮，会话已刷新:', cleared, '→', matchedLabel);
          } catch (e) {
            console.warn('[QC v4.17.23] 新建会话按钮点击失败:', String(e && e.message || e));
          }
        }
      }

      // 方法1（真实 DOM 确认）：chatHeader 右侧的 delete（垃圾桶）图标按钮，即「删除当前会话」入口。
      markStep('2b-delete-icon', '尝试「垃圾桶」删除会话图标');
      // 仅在方法0未命中时执行：预发环境用「新建会话」按钮、正式环境用垃圾桶，二者各自命中后即停，
      // 不再做对方环境的无效尝试（原先无条件执行会在预发点完新建会话后又去找垃圾桶、找不到打 warn）。
      // <button aria-describedby ...><span class="anticon anticon-delete">...</span></button>
      if (!cleared) {
      try {
        if (await clickDeleteIcon()) {
          cleared = await waitForFresh(5000);
          if (!cleared) {
            // 删除可能未生效（确认框时序/异步删除未完成）→ 重试一次
            console.warn('[QC v4.17.23] 删除会话后未重置为欢迎语状态，重试一次垃圾桶入口');
            if (await clickDeleteIcon()) cleared = await waitForFresh(5000);
          }
          clearMethod = 'chatHeader-delete-icon(strict-fresh)';
          console.log('[QC v4.17.23] 垃圾桶删除会话 → 已重置为欢迎语状态:', cleared);
        } else {
          console.warn('[QC v4.17.23] chatHeader 未找到 delete 图标按钮');
        }
      } catch (e) {
        console.warn('[QC v4.17.23] delete 按钮方式失败:', String(e && e.message || e));
      }
      } // end if (!cleared) 方法1

      // 方法2：点击「历史」按钮打开会话面板，在面板内逐个尝试可能的「新对话/切换会话」入口
      // （兼容其它版本页面；当前版本实测 chatHeader 没有「历史」按钮）
      // ⚠️ 正式环境只保留「垃圾桶」，同样跳过「历史」方法。
      if (!isFormal && !cleared) {
      try {
        const headerEl0 = document.querySelector('[class*="chatHeader"]');
        const histIcon = headerEl0 && headerEl0.querySelector('.anticon-history');
        const histBtn = headerEl0 && (
          Array.from(headerEl0.querySelectorAll('button')).find(b => /历史/.test(b.textContent || '')) ||
          (histIcon && histIcon.closest('button'))
        );
        skillDebug.clearDiag = { histBtn: !!histBtn };
        if (histBtn) {
          histBtn.click();
          await sleep(1200);
          // 面板容器候选：抽屉/弹层类 + rightPanel 兜底（列表可能直接渲染在右侧面板里）
          let scopes = Array.from(document.querySelectorAll(
            '.ant-drawer, .ant-modal, .ant-popover, [class*="drawer"], [class*="history"], [class*="session"], [class*="conversation"], [class*="chatList"], [class*="chatHistory"]'
          )).filter(el => {
            const st = window.getComputedStyle(el);
            return st.display !== 'none' && st.visibility !== 'hidden' && st.height !== '0px';
          });
          if (!scopes.length) {
            const rp = document.querySelector('[class*="rightPanel"]');
            if (rp) scopes = [rp];
          }
          skillDebug.clearDiag.scopes = scopes.length;

          // 收集可点击候选并按优先级排序：文字命中 > +图标 > 列表项（切换会话）
          const NEW_RE = /新建会话|新对话|新的对话|新建对话|新增会话|添加会话|开始新对话|清空|新聊天/;
          const candidates = [];
          for (const sc of scopes) {
            const els = sc.querySelectorAll('button, a, [role="button"], li, div[class*="item"]');
            for (const el of els) {
              if (el === histBtn) continue;
              const st = window.getComputedStyle(el);
              if (st.display === 'none' || st.visibility === 'hidden') continue;
              const t = (el.textContent || '').trim();
              const title = (el.getAttribute && el.getAttribute('title')) || '';
              if (/历史|history/i.test(t + ' ' + title)) continue; // 绝不点击历史会话入口
              let prio = 9;
              if (NEW_RE.test(t) || NEW_RE.test(title)) prio = 0;
              else if (el.querySelector && el.querySelector('.anticon-plus, .anticon-plus-circle')) prio = 1;
              else if (t && t.length <= 40 && /li|item/i.test(el.tagName + el.className)) prio = 3;
              else continue;
              candidates.push({ el, prio, txt: (t || title).slice(0, 24) });
            }
          }
          candidates.sort((a, b) => a.prio - b.prio);
          skillDebug.clearDiag.candidates = candidates.slice(0, 12).map(c => c.txt || '(icon)');
          console.log('[QC v4.17.23] 历史面板候选入口:', skillDebug.clearDiag.candidates.join(' | ') || '(无)');

          // 逐个尝试：每次点击后验证会话是否刷新；面板被关掉（scopes 消失）则停止
          for (const c of candidates.slice(0, 8)) {
            try { c.el.click(); } catch (e) { continue; }
            await sleep(1400);
            if (verifyCleared()) {
              cleared = true;
              clearMethod = 'history-panel-click:' + (c.txt || '(icon)');
              console.log('[QC v4.17.23] ✅ 点击「' + (c.txt || '(icon)') + '」后会话已刷新');
              break;
            }
            const stillOpen = scopes.some(s => document.contains(s) && window.getComputedStyle(s).display !== 'none');
            if (!stillOpen) { console.log('[QC v4.17.23] 面板已关闭，停止尝试'); break; }
          }
          if (!cleared && scopes.length) {
            // 记录会话面板真实 DOM，便于下一轮精准定位（避免盲试）
            skillDebug.historyPanelHtml = scopes.map(s => (s.innerHTML || '').slice(0, 1500)).join('\n---\n').slice(0, 4000);
          }
          // 关闭历史面板，避免遮挡后续输入
          document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          await sleep(400);
        }
      } catch (e) {
        console.warn('[QC v4.17.23] 历史面板方式失败:', String(e && e.message || e));
      }
      } // end if (!cleared) 方法2

      // 方法3：chatHeader 的 edit 图标按钮（部分版本可能是新对话入口）
      if (!cleared) {
        const headerEl = document.querySelector('[class*="chatHeader"]');
        const editIcon = headerEl && headerEl.querySelector('.anticon-edit');
        const newBtn = editIcon && editIcon.closest('button');
        if (newBtn) {
          try {
            const newT0 = Date.now();
            while ((newBtn.disabled || newBtn.getAttribute && newBtn.getAttribute('aria-disabled') === 'true') && Date.now() - newT0 < 6000) {
              await sleep(200);
            }
            newBtn.click();
            await sleep(1500);
            cleared = verifyCleared();
            clearMethod = 'chatHeader-edit-icon';
            console.log('[QC v4.17.23] 已点击 chatHeader edit 按钮，会话已刷新:', cleared);
          } catch (e) {
            console.warn('[QC v4.17.23] edit 按钮点击失败:', String(e && e.message || e));
          }
        }
      }

      // 方法4：文字按钮匹配（页面版本若出现文字按钮则兼容）
      if (!cleared) {
        const CLEAR_LABELS = ['新对话', '新建会话', '清空会话', '清空当前会话', '重新开始', '重置会话', '清空'];
        const candidates = Array.from(document.querySelectorAll(
          'button, [role="button"], [class*="new-chat"], [class*="newChat"], [class*="clear"], [class*="reset"]'
        ));
        let clearBtn = null, matchedLabel = '';
        for (const el of candidates) {
          const t = (el.textContent || '').trim();
          const title = (el.getAttribute && el.getAttribute('title')) || '';
          for (const L of CLEAR_LABELS) {
            if (t.includes(L) || title.includes(L)) { clearBtn = el; matchedLabel = L; break; }
          }
          if (clearBtn) break;
        }
        if (clearBtn) {
          try {
            clearBtn.click();
            await sleep(1300);
            cleared = verifyCleared();
            clearMethod = 'label:' + matchedLabel;
            console.log('[QC v4.17.23] 已点击「' + (clearBtn.textContent.trim() || matchedLabel) + '」，会话已刷新:', cleared);
          } catch (e) {
            console.warn('[QC v4.17.23] 清空会话点击失败:', String(e && e.message || e));
          }
        }
      }

      // 各方法执行后状态已刷新（可能是附带效果清掉的）也算成功
      if (!cleared && verifyCleared()) {
        cleared = true;
        clearMethod = 'state-changed-incidentally';
      }

      // 全部失败 → 不再带旧上下文继续（避免污染 RCA），返回错误并输出完整诊断
      if (!cleared) {
        console.warn('[QC v4.17.23] ⚠️ 无法清除旧会话，终止本次分析（避免历史上下文污染 RCA）');
        try {
          const rp = document.querySelector('[class*="rightPanel"]') || document.querySelector('[class*="chatHeader"]');
          skillDebug.clearDiag.panelSnapshot = ((rp && rp.outerHTML) || '').slice(0, 6000);
          skillDebug.clearDiag.bubbles = bubbleTexts().map(t => t.slice(0, 60));
          console.log('[QC v4.17.23] CLEAR_DIAG_DUMP_START' + JSON.stringify(skillDebug.clearDiag) + 'CLEAR_DIAG_DUMP_END');
        } catch (e) { /* 忽略 */ }
        skillDebug.clearOldSession = { found: false, method: 'all-methods-failed' };
        return { ok: false, error: 'cannot-clear-old-session', skillDebug };
      }
    }
    skillDebug.clearOldSession = { found: true, method: clearMethod || 'no-old-session' };
  } else {
    // 预发环境 RCA 直接发送（newSession=false）：不动会话，沿用当前上下文直接发送
    skillDebug.clearOldSession = { found: true, method: 'skip-direct-send' };
  }

  // 注：原本这里在预发环境会主动点击「停止」按钮来中断生成中的流式输出。
  // 但实测在预发平台点击「停止」后毫秒内就继续清会话/塞值会触发页面 React 崩溃
  // （流式中断时 message 为 undefined，渲染读 message.content 抛 TypeError: reading 'content'，
  // 弹「Something went wrong」）。方案A 后全程不再点停止：改由 hook.js 的 wrapChatStream 在数据停滞后
  // 自动 close 流 → 页面 React 自然收尾 → 前置 waitForReady 纯轮询等输入框恢复可编辑。
  // 走到这里时页面应已稳定，下面再用模拟人工粘贴的方式填入 prompt。
  markStep('3-fill', '会话已清空，开始填入 RCA 分析文本');

  // 模拟人工粘贴：用 execCommand('insertText') 走浏览器真实文本输入管线，
  // React 的 onChange 会自然触发，比直接 setter 注值 + 合成 input 事件更贴近人工操作，
  // 避免预发平台对「非真实输入」敏感导致的渲染异常。各步骤间留足停顿给 React 收尾。
  const desc = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
  const setter = desc && desc.set;
  // 先聚焦输入框（人工操作第一步永远是点输入框）
  ta.focus();
  await sleep(150);
  // 残留清理：删除会话后输入框可能仍保留上一轮的草稿文本，先全选删除
  if (ta.value) {
    ta.select();
    await sleep(80);
    if (setter) setter.call(ta, ''); else ta.value = '';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(200);
  }
  // 用真实粘贴管线写入提示词：聚焦后再 insertText，React onChange 自然接管
  ta.focus();
  await sleep(100);
  let inserted = false;
  try {
    if (document.execCommand && document.execCommand('insertText', false, keyword)) inserted = true;
  } catch (e) { /* execCommand 不可用则回退到 setter */ }
  if (!inserted) {
    if (setter) setter.call(ta, keyword); else ta.value = keyword;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  // 给 React 充分时间同步 state（人工粘贴后也会停顿一下再点发送）
  await sleep(400);

  let btn = null;
  const scope = ta.closest('div[class*="chatInput"]') || ta.parentElement || document;
  const primary = scope.querySelectorAll('button.ant-btn-primary');
  for (const b of primary) {
    if (!b.disabled && /发送/.test(b.textContent || '')) { btn = b; break; }
  }
  // ⚠️ 发送边界加固（v4.18 修复 reading 'content' 崩溃）：
  // 崩溃栈清晰指向「点击发送」——handleSend → onClick → Object.useState → systemPrompt...content，
  // 即点发送瞬间 React 重渲染去读新会话尚未提交的 systemPrompt 的 .content=undefined 而崩，
  // 被 React error boundary 接住后页面闪「Something went wrong」。上一版安抚放在
  // 「新建会话/垃圾桶」点击前后，未覆盖发送边界，因此无效。这里在点发送前等待：
  // ① 文本域可编辑（非生成中）；② 无红「停止」按钮；③ 新会话欢迎语已上屏（= systemPrompt
  // 已提交到渲染树）——贴近人工打字后停顿几秒再点发送的节奏，避免重渲染读到中间态。
  markStep('4-send-wait', '发送前等待新会话 systemPrompt 就绪');
  // ⚠️ 发送边界加固 v2（修复预发环境 reading 'content' 崩溃）：
  // 崩溃栈指向「点发送 → React 重渲染 → 读 systemPrompt.content → undefined 崩溃」。
  // 根因：欢迎语气泡上屏 ≠ systemPrompt state 就绪（React 先渲染 DOM 后完成 state 提交）。
  // 自适应策略：预发「新建会话」不产生欢迎语，仅等 textarea + 无停止按钮；
  // 正式「垃圾桶」产生欢迎语，额外等欢迎语稳定 1.5s 确保 systemPrompt 已提交。
  let welcomeDetectedAt = 0;
  let welcomeEverSeen = false;
  for (let tries = 0; tries < 25; tries++) {
    let taOk = false, genStop = false, welcomeOk = false;
    try {
      const probe = document.querySelector('textarea[placeholder*="描述你想要的质检规则"]');
      taOk = !!(probe && !probe.disabled);
      genStop = Array.from(document.querySelectorAll('button')).some(el => {
        const t = (el.textContent || '').trim();
        return /停止|stop/i.test(t) && (el.className || '').toLowerCase().includes('danger');
      });
      welcomeOk = Array.from(document.querySelectorAll('[class*="messageBubbleAssistant"]'))
        .some(n => {
          const s = ((n.innerText || n.textContent) || '').trim();
          return /你好|我是质检规则助手|描述你想要的质检规则/.test(s);
        });
    } catch (e) { /* 页面中间态，继续等 */ }
    if (welcomeOk) welcomeEverSeen = true;
    if (taOk && !genStop) {
      if (!welcomeEverSeen) break; // 新建会话流程无欢迎语，textarea 就绪即走
      // 垃圾桶流程：欢迎语已上屏，再等 1.5s 让 React 完成 systemPrompt state 提交
      if (!welcomeDetectedAt) welcomeDetectedAt = Date.now();
      if (Date.now() - welcomeDetectedAt >= 1500) break;
    } else {
      welcomeDetectedAt = 0;
    }
    await sleep(400);
  }
  // 人工节奏留白：给 React 完成 systemPrompt 提交与重渲染，再触发发送点击
  await sleep(800);
  // 最终兜底：点发送前再重新取一次按钮（避免中间态拿到的 btn 引用失效）
  const sendScope = ta.closest('div[class*="chatInput"]') || ta.parentElement || document;
  const sendBtns = sendScope.querySelectorAll('button.ant-btn-primary');
  let sendBtn = null;
  for (const b of sendBtns) {
    if (!b.disabled && /发送/.test(b.textContent || '')) { sendBtn = b; break; }
  }
  markStep('4-send', '点击发送');
  if (sendBtn) sendBtn.click();
  else ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
  console.log('[QC v4.17.23] ✅ prompt 已发送（模拟人工粘贴 + 点击发送）');
  markStep('5-sent', '发送完成，等待回复轮询');

  // 发送完成即返回；回复轮询交给 background 的 pollAssistantReply（不受后台页签定时器节流）
  return { ok: true, sent: true, skillDebug };
}

// ══════════════════════════════════════════
// 模式C：评测集生成（整合 qc-review-to-evalset 能力）
//  复刻 generate_evalset.py 的 schema 与取值逻辑，但复用扩展在浏览器内已登录的
//  页面会话（hook.js 主动查询 + 被动捕获），彻底去掉 cookie/ctoken/starpoint 手工管理。
//  产出 xlsx 由扩展内置的 store-ZIP + OOXML 写出器生成，不依赖外部库。
// ══════════════════════════════════════════

const QUALITY_POINT_ORDER = [
  "EOS01", "EOS02", "ES01",
  "C01", "C02", "C03", "CO01",
  "G01", "G02", "G03", "G04", "G05", "G06", "G07", "G08", "G09", "G10",
  "G11", "G12", "G13", "G14", "G15", "G16", "G17", "G18", "G19", "G20",
  "G21", "F22", "G23", "G24", "G25", "G26"
];
const FIXED_COLUMNS = [
  "case_type", "source_type", "biz_id", "service_record_id", "user_id",
  "busniess_line", "channel", "recore_detail", "mock_data"
];
const CHANNEL_MAP = { HOTLINE: "热线", INLINE: "在线", MAIL: "邮件" };
const EVAL_CELL_MAX = 32000;

// ---- 纯逻辑（复刻 generate_evalset.py）----
function evalTryPaths(obj, paths) {
  for (const path of paths) {
    let r = obj, found = true;
    for (const key of path) {
      if (r && typeof r === 'object' && key in r) r = r[key];
      else { found = false; break; }
    }
    if (found && r !== null && r !== undefined) return r;
  }
  return null;
}
function evalParseScore(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v).trim());
  return isNaN(n) ? null : n;
}
function evalRoot(resp) {
  return (resp && resp.data && typeof resp.data === 'object') ? resp.data : {};
}
function evalExtractQualityPointCode(title) {
  if (!title) return null;
  const m = /^(EOS\d+|ES\d+|CO\d+|F\d+|G\d+|C\d+)/i.exec(String(title).trim());
  return m ? m[1].toUpperCase() : null;
}
function evalExtractQualityPoints(sectionList) {
  const qpMap = {};
  if (!Array.isArray(sectionList)) return qpMap;
  for (const section of sectionList) {
    if (!section || typeof section !== 'object') continue;
    const itemList = Array.isArray(section.itemList) ? section.itemList : [];
    for (const item of itemList) {
      if (!item || typeof item !== 'object') continue;
      const code = evalExtractQualityPointCode(item.title);
      if (!code) continue;
      let ext_info = item.extInfo;
      if (typeof ext_info === 'string') { try { ext_info = JSON.parse(ext_info); } catch (e) { ext_info = null; } }
      let ai_answer_accepted = true, manual_review_passed = null;
      if (ext_info && typeof ext_info === 'object') {
        ai_answer_accepted = ext_info.aiAnswerAccepted !== false;
        if ('manualReviewPassed' in ext_info) manual_review_passed = ext_info.manualReviewPassed;
      }
      const passed_val = item.passed;
      let value = null;
      if (ai_answer_accepted === false) {
        if (passed_val != null && [0, 1].includes(Number(passed_val))) value = 1 - Number(passed_val);
        else if (manual_review_passed != null && [0, 1].includes(Number(manual_review_passed))) value = 1 - Number(manual_review_passed);
        else value = passed_val != null ? passed_val : manual_review_passed;
      } else if (manual_review_passed != null) value = manual_review_passed;
      else if (passed_val != null) value = passed_val;
      qpMap[code] = value;
    }
  }
  return qpMap;
}
function evalFormatDateTime(val) {
  if (val == null || val === '') return '';
  let d = null;
  if (typeof val === 'number') d = new Date(val);
  else {
    const s = String(val).trim();
    if (/^\d+$/.test(s)) d = new Date(parseInt(s, 10));
    else d = new Date(s);
  }
  if (!d || isNaN(d.getTime())) return String(val);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function evalStripHtml(html) {
  let t = String(html || '').replace(/<[^>]+>/g, '');
  return t.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
}
function evalCleanEmailHtml(html) {
  if (!html) return html;
  let h = String(html);
  h = h.replace(/<!--[\s\S]*?-->/g, '');
  h = h.replace(/<div[^>]*?id="ntes-pcmac-signature"[^>]*?>[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/gi, '');
  h = h.replace(/<span[^>]*?class="mailTask"[^>]*?>[\s\S]*?<\/span>/gi, '');
  h = h.replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  h = h.replace(/<\/?(?:span|font|html|head|body|article)\b[^>]*>/gi, '');
  h = h.replace(/<(table|tr|td|th|tbody|thead|tfoot)\b[^>]*>/gi, '<$1>');
  h = h.replace(/<\/(table|tr|td|th|tbody|thead|tfoot)>/gi, '</$1>');
  h = h.replace(/<(p|div)\b[^>]*>/gi, '<$1>');
  h = h.replace(/<img\b([^>]*?)>/gi, (m, g) => {
    const s = (g || '').match(/src=["']?([^"'\s>]+)/i);
    return s ? '<img src="' + s[1].replace(/"/g, '&quot;') + '" />' : '';
  });
  h = h.replace(/<a\b([^>]*?)>/gi, (m, g) => {
    const href = (g || '').match(/href=["']?([^"'\s>]+)/i);
    return href ? '<a href="' + href[1].replace(/"/g, '&quot;') + '">' : '<a>';
  });
  h = h.replace(/<br\b[^>]*>/gi, '<br />');
  h = h.replace(/<hr\b[^>]*>/gi, '<hr />');
  h = h.replace(/<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, '<$1>');
  h = h.replace(/<\/([a-zA-Z][a-zA-Z0-9]*)\s*>/g, '</$1>');
  h = h.replace(/(<p>\s*<br\s*\/?>\s*<\/p>\s*){2,}/g, '<p><br /></p>');
  h = h.replace(/<p>\s*<\/p>/g, '');
  for (let i = 0; i < 3; i++) h = h.replace(/<div>\s*<\/div>/g, '');
  h = h.replace(/<table>\s*<tbody>\s*<\/tbody>\s*<\/table>/g, '');
  h = h.replace(/<tr>\s*<\/tr>/g, '');
  h = h.replace(/<td>\s*<\/td>/g, '');
  h = h.replace(/<a[^>]*>\s*<\/a>/g, '');
  h = h.replace(/\n{3,}/g, '\n');
  return h.trim();
}
function evalProcessEmailChat(emailData) {
  if (!emailData || typeof emailData !== 'object') return {};
  const result = {};
  const mailList = Array.isArray(emailData.mailTaskRecordList) ? emailData.mailTaskRecordList : [];
  result['邮件往来记录'] = [];
  for (const item of mailList) {
    result['邮件往来记录'].push({
      '邮件标题': item.title || '',
      '抄送邮箱列表': Array.isArray(item.ccEmail) ? item.ccEmail : [],
      '密送邮箱列表': Array.isArray(item.bccEmail) ? item.bccEmail : [],
      '附件URL列表': Array.isArray(item.attachmentUrls) ? item.attachmentUrls : [],
      '邮件内容': evalCleanEmailHtml(item.content || ''),
      '工单ID': String(item.taskId != null ? item.taskId : ''),
      '邮件发送时间': evalFormatDateTime(item.emailSendDate),
      '代发件地址': item.receiptEmail || '',
      '服务记录ID': String(item.recordId != null ? item.recordId : ''),
      '修改时间': evalFormatDateTime(item.gmtModified),
      '创建时间': evalFormatDateTime(item.gmtCreate),
      '收件邮箱列表': Array.isArray(item.toEmail) ? item.toEmail : [],
      '发件邮箱': item.fromEmail || '',
      '发件人类型': item.fromType || '',
      '收件箱地址': ''
    });
  }
  result['业务子类型名称'] = emailData.categorySubName || '';
  result['回复是否携带历史信息'] = emailData.historyEditor === 'YES' ? '是' : (emailData.historyEditor === 'NO' ? '否' : (emailData.historyEditor || ''));
  result['工单ID'] = String(emailData.taskId != null ? emailData.taskId : '');
  result['工单状态'] = emailData.status || '';
  result['操作人'] = emailData.operator || '';
  result['业务类型名称'] = emailData.categoryName || '';
  result['业务类型ID'] = String(emailData.categoryId != null ? emailData.categoryId : '');
  result['操作人ID'] = String(emailData.operatorId != null ? emailData.operatorId : '');
  result['修改时间'] = evalFormatDateTime(emailData.gmtModified);
  result['商户ID'] = String(emailData.account != null ? emailData.account : '');
  result['创建时间'] = evalFormatDateTime(emailData.gmtCreate);
  result['业务子类型ID'] = String(emailData.categorySubId != null ? emailData.categorySubId : '');
  return result;
}
async function evalBuildEmailRecoreDetail(tabId, bizId) {
  if (!bizId) return null;
  const resp = await evalActiveGet(tabId, 'email', bizId, '__qcQueryEmail');
  const emailData = (resp && resp.data && typeof resp.data === 'object') ? resp.data : null;
  if (!emailData) return null;
  const emailHistory = evalProcessEmailChat(emailData);
  if (!emailHistory || !emailHistory['邮件往来记录']) return null;
  const recore = { manualChatHistory: [], robotChatHistory: [], emailHistory };
  let result = JSON.stringify(recore);
  if (result.length > EVAL_CELL_MAX) {
    for (const rec of emailHistory['邮件往来记录']) rec['邮件内容'] = evalStripHtml(rec['邮件内容'] || '');
    result = JSON.stringify(recore);
  }
  if (result.length > EVAL_CELL_MAX) {
    const records = emailHistory['邮件往来记录'];
    for (let i = records.length - 1; i >= 0; i--) {
      const c = records[i]['邮件内容'] || '';
      if (c.length > 2000) {
        records[i]['邮件内容'] = c.slice(0, 2000) + '...(内容超长已截断)';
        result = JSON.stringify(recore);
        if (result.length <= EVAL_CELL_MAX) break;
      }
    }
  }
  return result;
}

// ---- 主动查询（读缓存优先，否则驱动页面 MAIN 主动请求）----
const EVAL_ACTIVE_TIMEOUT = 15000;
async function evalReadCacheSingle(tabId, kind, key) {
  const res = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (k, key) => {
      const c = k === 'scoring' ? window.__QC_SCORING_CACHE__
        : k === 'detail' ? window.__QC_DETAIL_CACHE__ : window.__QC_EMAIL_CACHE__;
      const e = c && c[String(key)];
      return (e && e.time) ? e.data : null;
    },
    args: [kind, key]
  });
  return res && res[0] && res[0].result ? res[0].result : null;
}
async function evalActiveGet(tabId, kind, key, fnName) {
  try {
    const v = await evalReadCacheSingle(tabId, kind, key);
    if (v) return v;
  } catch (e) { /* 忽略 */ }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (fn, a) => { if (typeof window[fn] === 'function') window[fn](a); },
      args: [fnName, key]
    });
  } catch (e) { /* 落空则轮询等待捕获 */ }
  const start = Date.now();
  for (;;) {
    try {
      const v = await evalReadCacheSingle(tabId, kind, key);
      if (v) return v;
    } catch (e) { /* 忽略 */ }
    if (Date.now() - start > EVAL_ACTIVE_TIMEOUT) return null;
    await sleep(1200);
  }
}

async function processSingleTaskEvalset(tabId, taskId) {
  const scoringResp = await evalActiveGet(tabId, 'scoring', taskId, '__qcQueryScoring');
  if (!scoringResp) return null;
  const root = evalRoot(scoringResp);
  const serviceRecordId = evalTryPaths(root, [
    ['qcTask', 'serviceRecordId'], ['serviceRecordId'],
    ['qcTask', 'extInfo', 'serviceRecordId'], ['qcScoring', 'serviceRecordId']
  ]);
  if (!serviceRecordId) return null;
  const channelRaw = evalTryPaths(root, [
    ['qcTask', 'serviceChannel'], ['qcTask', 'channel'], ['channel'], ['qcTask', 'channelCode'],
    ['qcTask', 'extInfo', 'channelCode'], ['qcScoring', 'channel'], ['qcScoring', 'serviceChannel']
  ]);
  const channel = CHANNEL_MAP[channelRaw] || channelRaw || '';
  const bizLine = evalTryPaths(root, [
    ['qcTask', 'bizLine'], ['bizLine'], ['qcTask', 'extInfo', 'businessLine'],
    ['qcTask', 'businessLine'], ['qcScoring', 'bizLine']
  ]) || '';
  const latestScore = evalParseScore(evalTryPaths(root, [
    ['qcTask', 'latestScore'], ['latestScore'], ['qcTask', 'score'], ['qcTask', 'extInfo', 'latestScore'],
    ['qcScoring', 'latestScore'], ['qcTask', 'aiScore']
  ]));
  const sectionList = evalTryPaths(root, [
    ['qcTask', 'sectionList'], ['sectionList'], ['qcScoring', 'sectionList'], ['qcTask', 'extInfo', 'sectionList']
  ]);
  const qualityPoints = evalExtractQualityPoints(sectionList);

  const detailResp = await evalActiveGet(tabId, 'detail', String(serviceRecordId), '__qcQueryDetail');
  let bizId = '', srId = '', userId = '';
  if (detailResp) {
    const dRoot = evalRoot(detailResp) || {};
    bizId = dRoot.bizId || '';
    srId = dRoot.id || '';
    userId = dRoot.userId || '';
  }
  const caseType = latestScore != null ? (latestScore >= 80 ? 'positive' : 'negative') : 'negative';
  let recoreDetail = null;
  if (channel === '邮件' && bizId) recoreDetail = await evalBuildEmailRecoreDetail(tabId, bizId);
  return {
    case_type: caseType, source_type: 'real', biz_id: bizId, service_record_id: srId,
    user_id: userId, busniess_line: bizLine, channel, recore_detail: recoreDetail,
    mock_data: null, quality_points: qualityPoints
  };
}

function evalQpSorted(allQp) {
  const sorted = QUALITY_POINT_ORDER.filter((c) => allQp.has(c));
  const extra = [...allQp].filter((c) => !QUALITY_POINT_ORDER.includes(c)).sort();
  return sorted.concat(extra);
}

async function handleEvalset(msg, sourceUrl) {
  const raw = String(msg.taskIds || '');
  const taskIds = raw.split(/[,，;；\s]+/).map((s) => s.trim()).filter(Boolean);
  if (!taskIds.length) return { ok: false, error: 'no-task-ids' };
  const tab = await getRuleTab(sourceUrl);
  await sleep(400);

  const rows = [], failed = [], channels = new Set(), allQp = new Set();
  for (const tid of taskIds) {
    let row = null;
    try { row = await processSingleTaskEvalset(tab.id, tid); } catch (e) { row = null; }
    if (!row) { failed.push(tid); continue; }
    rows.push(row);
    channels.add(row.channel);
    Object.keys(row.quality_points || {}).forEach((c) => allQp.add(c));
  }
  if (!rows.length) return { ok: false, error: 'all-failed', failed };
  if (channels.size > 1) {
    return { ok: false, error: 'channel-mismatch', channels: [...channels], failed,
      detail: '检测到渠道不一致，无法同时生成不同渠道的评测集（' + [...channels].join(' / ') + '），请仅保留同一渠道的任务ID。' };
  }
  const channel = [...channels][0] || '';
  const qpCodes = evalQpSorted(allQp);
  try {
    const u8 = evalBuildXlsx(rows, qpCodes);
    const fname = '复核任务回放评测集_' + taskIds.join('_') + '.xlsx';
    return { ok: true, rows, failed, channel, qpCodes, base64: bytesToBase64(u8),
      fileName: fname, colCount: FIXED_COLUMNS.length + qpCodes.length, rowCount: rows.length };
  } catch (e) {
    return { ok: false, error: 'xlsx-failed:' + String(e && e.message || e), rows, failed };
  }
}

// ══════════════════════════════════════════
// 自包含 store-ZIP + 最小 OOXML XLSX 写出器
// ══════════════════════════════════════════
function colName(i) {
  let n = i, s = '';
  while (n >= 0) { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; }
  return s;
}
function cellRef(col, row) { return colName(col) + (row + 1); }
function xmlEsc(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function textCell(col, row, val) {
  return '<c r="' + cellRef(col, row) + '" t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(val) + '</t></is></c>';
}
function numCell(col, row, val) {
  return '<c r="' + cellRef(col, row) + '"><v>' + val + '</v></c>';
}

function evalBuildSheetXml(rows, qpCodes) {
  const allColumns = FIXED_COLUMNS.concat(qpCodes.map((c) => 'quality_point_' + c));
  const header = allColumns.map((c, i) => textCell(i, 0, c)).join('');
  let sheet = '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">' + header + '</row>';
  rows.forEach((row, ri) => {
    const cells = [];
    cells.push(textCell(0, ri + 1, row.case_type));
    cells.push(textCell(1, ri + 1, row.source_type));
    cells.push(textCell(2, ri + 1, row.biz_id));
    cells.push(textCell(3, ri + 1, row.service_record_id));
    cells.push(textCell(4, ri + 1, row.user_id));
    cells.push(textCell(5, ri + 1, row.busniess_line));
    cells.push(textCell(6, ri + 1, row.channel));
    cells.push(textCell(7, ri + 1, row.recore_detail));
    // col 8 = mock_data 留空
    qpCodes.forEach((code, qi) => {
      const val = (row.quality_points || {})[code];
      if (val != null) {
        if (typeof val === 'number') cells.push(numCell(9 + qi, ri + 1, val));
        else cells.push(textCell(9 + qi, ri + 1, val));
      }
    });
    sheet += '<row r="' + (ri + 2) + '">' + cells.join('') + '</row>';
  });
  sheet += '</sheetData></worksheet>';
  return sheet;
}

function evalBuildXlsx(rows, qpCodes) {
  const typesXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>';
  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';
  const workbookXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="评测数据" sheetId="1" r:id="rId1"/></sheets></workbook>';
  const wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>';
  const stylesXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="1"><font><sz val="11"/><name val="微软雅黑"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
    '</styleSheet>';
  const sheetXml = evalBuildSheetXml(rows, qpCodes);

  const files = [
    { name: '[Content_Types].xml', data: strToBytes(typesXml) },
    { name: '_rels/.rels', data: strToBytes(rootRels) },
    { name: 'xl/workbook.xml', data: strToBytes(workbookXml) },
    { name: 'xl/_rels/workbook.xml.rels', data: strToBytes(wbRels) },
    { name: 'xl/styles.xml', data: strToBytes(stylesXml) },
    { name: 'xl/worksheets/sheet1.xml', data: strToBytes(sheetXml) }
  ];
  return buildZip(files);
}

function strToBytes(s) { return new TextEncoder().encode(s); }

const _CRC_TABLE = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = _CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function pushU16(arr, v) { arr.push(v & 255, (v >>> 8) & 255); }
function pushU32(arr, v) { arr.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255); }

function buildZip(fileEntries) {
  const chunks = [], central = [];
  let offset = 0;
  for (const fe of fileEntries) {
    const nameBytes = strToBytes(fe.name);
    const data = fe.data;
    const crc = crc32(data);
    const lh = [];
    pushU32(lh, 0x04034b50);
    pushU16(lh, 20); pushU16(lh, 0); pushU16(lh, 0);
    pushU16(lh, 0); pushU16(lh, 0);
    pushU32(lh, crc);
    pushU32(lh, data.length);
    pushU32(lh, data.length);
    pushU16(lh, nameBytes.length);
    pushU16(lh, 0);
    for (const b of nameBytes) lh.push(b);
    chunks.push(new Uint8Array(lh), data);

    const ch = [];
    pushU32(ch, 0x02014b50);
    pushU16(ch, 20); pushU16(ch, 20);
    pushU16(ch, 0); pushU16(ch, 0);
    pushU16(ch, 0); pushU16(ch, 0);
    pushU32(ch, crc);
    pushU32(ch, data.length);
    pushU32(ch, data.length);
    pushU16(ch, nameBytes.length);
    pushU16(ch, 0); pushU16(ch, 0); pushU16(ch, 0); pushU16(ch, 0);
    pushU32(ch, 0); pushU32(ch, offset);
    for (const b of nameBytes) ch.push(b);
    central.push(new Uint8Array(ch));
    offset += lh.length + data.length;
  }
  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const eocd = [];
  pushU32(eocd, 0x06054b50);
  pushU16(eocd, 0); pushU16(eocd, 0);
  pushU16(eocd, central.length); pushU16(eocd, central.length);
  pushU32(eocd, centralSize);
  pushU32(eocd, offset);
  pushU16(eocd, 0);

  const parts = chunks.concat(central).concat([new Uint8Array(eocd)]);
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(binary);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
