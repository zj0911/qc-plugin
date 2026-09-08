// reporter.js — 质检助手埋点上报模块（Service Worker 环境）
// 通过 background.js 顶部的 importScripts('reporter.js') 加载，运行于后台 Service Worker。
//
// ⚠️ MV3 关键约束：Service Worker 空闲会被销毁，setTimeout/setInterval 不保证执行，
// 因此这里【事件一到就立即 POST】（不依赖定时器），每条事件一次请求、字段平铺在根，
// 最贴合钉钉连接器"字段映射到 AI 表格列"的配置。
//
// 字段按「埋点明细表」平铺，与连接器已配置的字段名保持一致。

(() => {
  'use strict';

  const WEBHOOK_URL = 'https://connector.dingtalk.com/webhook/flow/103b48cd91a30b5d1990000l';
  const MAX_RETRY = 2;         // 单条最大重试次数

  let pluginVersion = '';
  try { pluginVersion = chrome.runtime.getManifest().version; } catch (e) { /* ignore */ }

  // ── 时间戳：YYYY-MM-DD HH:mm:ss ──
  function nowStr() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  // ── 去 PII 脱敏 ──
  function sanitize(v) {
    if (typeof v !== 'string') return (v == null ? '' : v);
    return v
      .replace(/ctoken=[^&\s]+/gi, 'ctoken=***')
      .replace(/access_token=[^&\s]+/gi, 'access_token=***')
      .replace(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/gi, '***@***')
      .slice(0, 500);
  }

  // ── 展平为明细表的一行（字段平铺在根）──
  function buildRow(eventName, props) {
    const p = props || {};
    return {
      event_name: sanitize(eventName),
      event_time: nowStr(),
      plugin_version: String(p.plugin_version || pluginVersion),  // 已有 manifest 兜底
      env: sanitize(p.env || ''),   
      session_id: sanitize(p.session_id || ''),
      user_id_hash: sanitize(p.user_id_hash || ''),
      biz: sanitize(p.biz || ''),
      qp: sanitize(p.qp || ''),
      mode: sanitize(p.mode || ''),
      method: sanitize(p.method || ''),
      via: sanitize(p.via || ''),
      step: sanitize(p.step || ''),
      reason: sanitize(p.reason || ''),
      error_code: sanitize(p.error_code || ''),
      result: sanitize(p.result || ''),
      reply_len: (p.reply_len != null) ? Number(p.reply_len) : 0,
      problems_count: (p.problems_count != null) ? Number(p.problems_count) : 0,
      duration_ms: (p.duration_ms != null) ? Number(p.duration_ms) : 0,
      stream_turns: (p.stream_turns != null) ? Number(p.stream_turns) : 0,
      retry_count: (p.retry_count != null) ? Number(p.retry_count) : 0,
      task_count: (p.task_count != null) ? Number(p.task_count) : 0  // ✅ 新增
    };
  }


  // ── 立即逐条上报（不依赖定时器）──
  async function sendOne(row) {
    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
      try {
        const resp = await fetch(WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(row),       // 字段平铺在根
          keepalive: true
        });
        if (resp.ok) {
          console.log('[QC Reporter] ✅ 上报成功:', row.event_name);
          return true;
        }
        console.warn('[QC Reporter] ⚠️ HTTP ' + resp.status + ' | event=' + row.event_name + ' | retry=' + attempt);
      } catch (e) {
        console.warn('[QC Reporter] ⚠️ fetch err: ' + (e && e.message || e) + ' | retry=' + attempt);
      }
      // 简单退避重试
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
    console.error('[QC Reporter] ❌ 最终失败:', row.event_name);
    return false;
  }

  // ── 对外 API：track 立即组装并发送 ──
  function track(eventName, props) {
    try {
      const row = buildRow(eventName, props);
      console.log('[QC Reporter] track:', row.event_name, JSON.stringify(row).slice(0, 300));
      sendOne(row); // fire-and-forget
    } catch (e) { /* 埋点不影响主流程 */ }
  }

  // 暴露给 background.js / content.js
  globalThis.QCReporter = { track, sanitize };
})();
