// hook.js — MAIN world，注入到质检平台质检点详情页(ruleManage)
// 职责：在页面自身的 queryRuleByPage 请求真实发生时，把响应 JSON 捕获到
//       window.__QC_RULES_CACHE__，供后台读取后做本地模糊匹配。
//       —— 复用页面自身的会话与动态防重放签名(starpoint-data2)，不伪造、不硬编码任何凭据。
(() => {
  'use strict';
  if (window.__QC_HOOK_INSTALLED__) return; // 防重复注入
  window.__QC_HOOK_INSTALLED__ = true;
  console.log('[QC Hook] v4.17.23 hook.js 已安装于', location.href);
  // 双环境（正式/预发）自适应 API 域名：host 含 "-pre.alipay.com" 走预发接口，否则走正式接口
  const QC_API_HOST = /-pre\.alipay\.com/i.test(location.hostname) ? 'https://ics-api-pre.alipay.com' : 'https://ics-api.alipay.com';
  window.__QC_RULES_CACHE__ = [];
  // 历史版本专用缓存：key = qcRuleId，value = { url, time, data }
  window.__QC_VERSION_HISTORY_CACHE__ = {};
  // 评测集生成（模式C）专用缓存：key 分别为 复核taskId / serviceRecordId / 邮件工单taskId()
  window.__QC_SCORING_CACHE__ = {};  // key = 复核任务 taskId
  window.__QC_DETAIL_CACHE__ = {};   // key = serviceRecordId
  window.__QC_EMAIL_CACHE__ = {};    // key = 邮件工单 bizId(taskId)

  const MATCH = /queryRuleByPage/;
  const MATCH_VH = /getRuleVersionHistory/;
  // 复核评分 / 服务记录详情 接口（供 ReviewAutoFill 读取业务线 title 与质检点）
  const MATCH_SCORE = /queryQcScoringByTaskId/;
  const MATCH_DETAIL = /serviceRecord\/detail/;
  // 邮件工单详情接口（评测集模式C：邮件渠道 recore_detail 组装）
  const MATCH_EMAIL = /emailTaskDetails/;

  // 从 URL 查询串取出指定参数值
  function qParam(url, key) {
    try {
      const u = new URL(String(url), location.href);
      const v = u.searchParams.get(key);
      return v == null ? '' : String(v);
    } catch (e) { /* */ return ''; }
  }

  // 向 content script（ISOLATED world）广播 hook 数据。
  // content.js 的 ReviewAutoFill.startHookListener 通过 window message 接收。
  function emit(type, data) {
    try {
      window.postMessage({ source: 'qc-hook', type: type, payload: data }, '*');
    } catch (e) { /* 忽略 */ }
  }

  function captureHistory(url, data) {
    try {
      const m = String(url).match(/qcRuleId=([^&]+)/);
      const qid = m ? decodeURIComponent(m[1]) : '';
      if (!qid) return;
      window.__QC_VERSION_HISTORY_CACHE__[qid] = { url, time: Date.now(), data };
    } catch (e) { /* 忽略 */ }
  }

  function capture(url, data) {
    try {
      window.__QC_RULES_CACHE__.push({ url, time: Date.now(), data, len: JSON.stringify(data).length });
      if (window.__QC_RULES_CACHE__.length > 10) window.__QC_RULES_CACHE__.shift();
    } catch (e) { /* 忽略 */ }
  }

  // 评测集（模式C）：按 key 参数把响应写入对应命名缓存
  function captureNamed(kind, url, data, param) {
    try {
      const key = qParam(url, param);
      if (!key) return;
      const cache = kind === 'scoring' ? window.__QC_SCORING_CACHE__
        : kind === 'detail' ? window.__QC_DETAIL_CACHE__ : window.__QC_EMAIL_CACHE__;
      cache[key] = { url, time: Date.now(), data, len: JSON.stringify(data).length };
    } catch (e) { /* 忽略 */ }
  }

  // ── Agent SSE 流「伪造结束」包装（方案A：解页面卡死「生成中」）──
  // 背景：预发服务端保持长连接，SSE 流永不 close（entry.done 恒 false），页面 React 因此
  //   永远停在「生成中」（停止按钮常驻、输入框 disabled）；而实测：内容输出后再点「停止」
  //   会触发 systemPrompt.content 崩溃，reload 又会丢插件面板数据。
  // 做法：把交给页面的响应体换成我们可控的 ReadableStream——正常转发字节（同时解码累积进
  //   entry.raw 供后台捕获），一旦「已见答案段 + 数据停滞超阈值」就主动 controller.close()，
  //   页面 reader 收到正常的「流结束」信号 → React 自然收尾 → 输入框恢复、停止按钮消失。
  //   全程不点停止、不 reload、不丢数据。仅影响 qa/chat 流式响应，其余请求原样透传。
  const CHAT_STALL_CLOSE_MS = 8000; // 答案出现后，数据停滞多久判定「已出完」并伪造结束
  const DEAD_STREAM_CLOSE_MS = 20000; // 未见答案段时的「死流兜底」：零字节持续多久强制解卡
  function wrapChatStream(r, url) {
    try {
      // 无流式 body（错误响应/空响应/非流式）→ 原样返回，不改变页面既有行为
      if (!r || !r.body || !r.body.getReader) return r;
      const entry = { url: String(url).slice(0, 200), start: Date.now(), raw: '', done: false, err: '', chunks: 0 };
      // 多条流并存：一次 RCA 会有多条 chat.json（工具调用轮 + 最终答案轮），
      // 新流追加到数组末尾，旧轮保留，background 取「最后一条含答案段的流」
      if (!Array.isArray(window.__QC_AGENT_STREAMS__) || window.__QC_AGENT_STREAMS__.length >= 10) {
        window.__QC_AGENT_STREAMS__ = [];
      }
      window.__QC_AGENT_STREAMS__.push(entry);
      window.__QC_AGENT_STREAM__ = entry;

      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let closed = false;
      let sawAnswer = false;         // 是否已收到「答案段」（type 非 think/tool）——只在正式回复开始后才允许关流
      let lastChunkAt = Date.now();  // 最近一次收到字节的时间（停滞判定基准）
      let wd = null;                 // 看门狗定时器句柄

      const stream = new ReadableStream({
        start(controller) {
          const finish = () => {
            if (closed) return;
            closed = true;
            if (wd) { clearInterval(wd); wd = null; }
            try { controller.close(); } catch (e) { /* 已关闭 */ }
            entry.done = true; // 同步告知后台：本流已结束（后台 complete 判定会用到）
          };
          (function pump() {
            reader.read().then((cr) => {
              if (closed) return;
              if (cr.done) { finish(); return; }
              lastChunkAt = Date.now();
              try {
                const txt = decoder.decode(cr.value, { stream: true });
                entry.raw += txt; entry.chunks++;
                if (entry.raw.length > 2000000) entry.raw = entry.raw.slice(-1500000); // 上限保护
                // 答案段探测：SSE JSON 里出现 "type":"<非 think/tool 开头>" 即视为已产出正式回复
                // （与 background.extractStreamText 的 noise 判定一致：think/tool 为思考与工具轮）
                if (!sawAnswer && /"type"\s*:\s*"(?!think|tool)[^"]+"/i.test(entry.raw)) sawAnswer = true;
              } catch (e) { /* 解码失败不影响转发 */ }
              try { controller.enqueue(cr.value); } catch (e) { finish(); return; }
              pump();
            }).catch((e) => { entry.err = String(e && e.message || e); finish(); });
          })();
          // 看门狗：数据停滞时伪造结束，解页面卡死「生成中」。
          //  - 已见答案段：停滞 CHAT_STALL_CLOSE_MS 即关（正常路径，答案已出完）；
          //  - 未见答案段：需停滞更久（DEAD_STREAM_CLOSE_MS）才关，作「死流兜底」——
          //    思考阶段数据是持续流动的（lastChunkAt 不断刷新）不会误关；只有真正长时间
          //    零字节（流已死）才强制解卡，避免答案段探测失败时页面永久停在「生成中」。
          wd = setInterval(() => {
            if (closed) { clearInterval(wd); wd = null; return; }
            const stalled = Date.now() - lastChunkAt;
            const threshold = sawAnswer ? CHAT_STALL_CLOSE_MS : DEAD_STREAM_CLOSE_MS;
            if (stalled >= threshold) {
              try { reader.cancel(); } catch (e) { /* */ }
              finish();
            }
          }, 1000);
        }
      });
      // 用原响应的 status/statusText/headers 重建，页面侧读到的字节与原流一致，仅结束时机由我们控制
      return new Response(stream, { status: r.status, statusText: r.statusText, headers: r.headers });
    } catch (e) { return r; } // 任何异常都退回原始响应，绝不阻断页面
  }

  // ── 钩子 1：window.fetch ──
  try {
    const origFetch = window.fetch;
    if (origFetch && typeof origFetch === 'function') {
      window.fetch = function () {
        let url = '';
        try {
          const input = arguments[0];
          url = typeof input === 'string' ? input : (input && input.url) || '';
        } catch (e) { /* */ }
        const p = origFetch.apply(this, arguments);
        try {
          if (MATCH.test(url)) {
            p.then((r) => {
              try { r.clone().json().then((j) => capture(url, j)).catch(() => {}); } catch (e) { /* */ }
            }).catch(() => { /* */ });
          } else if (MATCH_VH.test(url)) {
            // 历史版本接口：页面自身触发(如用户点击「历史版本」)时被动捕获。
            // 复用页面的签名链路，不主动伪造任何 header。
            p.then((r) => {
              try { r.clone().json().then((j) => captureHistory(url, j)).catch(() => {}); } catch (e) { /* */ }
            }).catch(() => { /* */ });
          } else if (MATCH_SCORE.test(url)) {
            // 复核评分接口：捕获并广播给 content script（业务线兜底 / 任务信息）
            p.then((r) => {
              try { r.clone().json().then((j) => { emit('qc-scoring', j); captureNamed('scoring', url, j, 'taskId'); }).catch(() => {}); } catch (e) { /* */ }
            }).catch(() => { /* */ });
          } else if (MATCH_DETAIL.test(url)) {
            // 服务记录详情接口：捕获并广播（业务线 title = "B-WF-Trade > 账号服务…"）
            p.then((r) => {
              try { r.clone().json().then((j) => { emit('qc-detail', j); captureNamed('detail', url, j, 'id'); }).catch(() => {}); } catch (e) { /* */ }
            }).catch(() => { /* */ });
          } else if (MATCH_EMAIL.test(url)) {
            // 邮件工单详情接口：捕获进缓存（评测集模式C 邮件渠道）
            p.then((r) => {
              try { r.clone().json().then((j) => captureNamed('email', url, j, 'taskId')).catch(() => {}); } catch (e) { /* */ }
            }).catch(() => { /* */ });
          }
          // Agent 回复流（SSE）网络层直捕 + 「伪造流结束」解卡（方案A）：
          // 网络回调不受后台页签定时器节流影响，页签在后台时数据照样逐块到达，供 background 读取。
          // 预发服务端保持长连接、SSE 永不 close，页面 React 因此永停「生成中」；而内容输出后
          // 再点「停止」会触发 systemPrompt.content 崩溃。故把交给页面的响应体换成 wrapChatStream
          // 包装的可控流：数据停滞后主动 close()，页面收到自然结束信号 → React 收尾 → 输入框恢复。
          if (/qa\/chat/i.test(url)) {
            // 记下发送时的请求体/请求头作模板：供后台「API 直连」模式复刻请求，
            // 不碰页面 UI（后台节流不影响网络请求）
            try {
              const opts = arguments[1] || {};
              window.__QC_CHAT_REQ__ = {
                url: String(url),
                method: opts.method || 'POST',
                body: typeof opts.body === 'string' ? opts.body.slice(0, 50000) : null,
                headers: opts.headers ? JSON.parse(JSON.stringify(opts.headers)) : null,
                time: Date.now()
              };
            } catch (e) { /* */ }
            // 关键：返回「包装后的响应」给页面（而非原始 p），body 由 wrapChatStream 转发并可在停滞后关闭
            return p.then((r) => wrapChatStream(r, url));
          }
        } catch (e) { /* */ }
        return p;
      };
    }
  } catch (e) { /* */ }

  // ── 钩子 2：XMLHttpRequest（部分实现走 XHR）──
  try {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__qcUrl = String(url);
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      const self = this;
      if (MATCH.test(self.__qcUrl || '')) {
        this.addEventListener('load', function () {
          try {
            const raw = self.responseText;
            if (raw) { try { capture(self.__qcUrl, JSON.parse(raw)); } catch (e) { /* */ } }
          } catch (e) { /* */ }
        });
      } else if (MATCH_VH.test(self.__qcUrl || '')) {
        this.addEventListener('load', function () {
          try {
            const raw = self.responseText;
            if (raw) { try { captureHistory(self.__qcUrl, JSON.parse(raw)); } catch (e) { /* */ } }
          } catch (e) { /* */ }
        });
      } else if (MATCH_SCORE.test(self.__qcUrl || '')) {
        this.addEventListener('load', function () {
          try {
            const raw = self.responseText;
            if (raw) { try { emit('qc-scoring', JSON.parse(raw)); } catch (e) { /* */ } }
          } catch (e) { /* */ }
        });
      } else if (MATCH_DETAIL.test(self.__qcUrl || '')) {
        this.addEventListener('load', function () {
          try {
            const raw = self.responseText;
            if (raw) { try { emit('qc-detail', JSON.parse(raw)); } catch (e) { /* */ } }
          } catch (e) { /* */ }
        });
      }
      return origSend.apply(this, arguments);
    };
  } catch (e) { /* */ }

  // ── 主动抓取历史版本（供后台/插件侧按 qcRuleId 调用）──
  // 策略：在页面 MAIN 上下文内发起请求并复用页面既有 fetch 拦截层，使
  //       动态签名(starpoint-data2)/会话凭据由页面的真实请求链路自动附加，
  //       插件本身不内嵌任何 cookie/token。ctoken 从页面自身 cookie 读取。
  // 注意：接口是否会因 starpoint-data2 校验拒绝，取决于页面拦截层是否作用于
  //       我们发起的 window.fetch —— 该点需以真实运行结果为准 [待确认]。
  //       被动捕获分支仍会兜底：若用户手动打开页面的「历史版本」UI，同样会被
  //       MATCH_VH 捕获并写入缓存，后台再次读取即可命中。
  try {
    window.__qcQueryVersionHistory = function (qcRuleId) {
      return new Promise(function (resolve) {
        try {
          let ctoken = '';
          try {
            const m = document.cookie.match(/(?:^|;\s*)ctoken=([^;]+)/);
            if (m) ctoken = decodeURIComponent(m[1]);
          } catch (e) { /* */ }
          const url = QC_API_HOST + '/ics-quality/api/icscheck/qc/getRuleVersionHistory.json' +
            '?ctoken=' + encodeURIComponent(ctoken) + '&qcRuleId=' + encodeURIComponent(String(qcRuleId));
          window.fetch(url, { method: 'GET', credentials: 'include' })
            .then((r) => r.json())
            .then((j) => {
              try { window.__QC_VERSION_HISTORY_CACHE__[String(qcRuleId)] = { url, time: Date.now(), data: j, _fired: true }; } catch (e) { /* */ }
              resolve({ ok: true, data: j });
            })
            .catch((err) => resolve({ ok: false, error: String(err && err.message || err) }));
        } catch (e) {
          resolve({ ok: false, error: String(e && e.message || e) });
        }
      });
    };
  } catch (e) { /* */ }

  // ── 评测集生成（模式C）主动查询 ──
  // 复用页面自身登录取证：ctoken 从页面 cookie 读取，window.fetch 复刻页面拦截层
  // （starpoint-data2 动态签名/cookie 自动附加）。与 __qcQueryVersionHistory 同策略，
  // 是否被签名校验拒绝以真实运行结果为准 —— 被动捕获分支仍会兑底。
  // 每次调用把结果同时写入对应命名缓存（供后台读取），并 Promise resolve 回完整 data。
  try {
    function __qcActiveGet(kind, apiPath, keyParam, key) {
      return new Promise(function (resolve) {
        try {
          let ctoken = '';
          try {
            const m = document.cookie.match(/(?:^|;\s*)ctoken=([^;]+)/);
            if (m) ctoken = decodeURIComponent(m[1]);
          } catch (e) { /* */ }
          const url = apiPath + '?ctoken=' + encodeURIComponent(ctoken) +
            '&' + keyParam + '=' + encodeURIComponent(String(key));
          window.fetch(url, { method: 'GET', credentials: 'include' })
            .then((r) => r.json())
            .then((j) => {
              try {
                const cache = kind === 'scoring' ? window.__QC_SCORING_CACHE__
                  : kind === 'detail' ? window.__QC_DETAIL_CACHE__ : window.__QC_EMAIL_CACHE__;
                cache[String(key)] = { url, time: Date.now(), data: j, _fired: true };
              } catch (e) { /* */ }
              resolve({ ok: true, data: j });
            })
            .catch((err) => resolve({ ok: false, error: String(err && err.message || err) }));
        } catch (e) {
          resolve({ ok: false, error: String(e && e.message || e) });
        }
      });
    }
    window.__qcQueryScoring = function (taskId) {
      return __qcActiveGet('scoring', QC_API_HOST + '/ics-quality/api/icscheck/qc/queryQcScoringByTaskId.json', 'taskId', taskId);
    };
    window.__qcQueryDetail = function (serviceRecordId) {
      return __qcActiveGet('detail', QC_API_HOST + '/icsworkbench/console/serviceRecord/detail.json', 'id', serviceRecordId);
    };
    window.__qcQueryEmail = function (bizId) {
      return __qcActiveGet('email', QC_API_HOST + '/api/mail/task/query/emailTaskDetails.json', 'taskId', bizId);
    };
  } catch (e) { /* */ }
})();
