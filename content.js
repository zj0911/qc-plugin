(function () {
  'use strict';
  console.log('[QC Panel] v5.4.8-keephl content.js loaded');

  // 仅允许在质检平台域名下运行（双击/工具栏可能在非目标网页就地注入 content.js）。
  // 非目标域名直接退出，不创建悬浮按钮、不启动 4 秒自愈、不注册任何监听，避免与域名限制冲突。
  if (!/^https:\/\/(?:ics\.alipay\.com|ics-site-pre\.alipay\.com)([:/]|$)/i.test(location.href)) {
    console.log('[QC Panel] 非目标域名，跳过注入');
    return;
  }

  // ── 埋点辅助：content 侧把事件转发给 background（由 reporter 统一上报）──
  // enrich = 公共字段（env/session/匿名 user hash 等），由本模块推导注入
  function qcTrack(eventName, props) {
  try {
    const enrich = {
      env: /-pre\.alipay\.com/i.test(location.hostname || '') ? 'pre' : 'formal'
    };
    chrome.runtime.sendMessage({
      type: 'qc-track',
      eventName: eventName,
      props: Object.assign({}, enrich, props || {})
    });
  } catch (e) { /* 埋点失败不影响主流程 */ }
}

  // ── 全局状态 ──
  let panelEl = null;          // 侧边栏根节点
  let lastExtracted = '';      // 模式 A：最新提取的原始结果文本
  let lastProblems = [];       // 模式 A：结构化问题条目
  let userDismissed = false;   // 手动关闭后不再自动弹窗
  let highlightCleanup = null; // 清除上一次高亮的回调
  let panelCollapsed = false;  // 侧边栏是否收起
  let chatStatus = '';         // 模式 A：Agent 对话状态提示（跨面板重渲染保留）
  let chatStatusCls = '';      // 状态提示样式类（ok/warn/err/info）
  let chatForm = { biz: '', qp: '', tasks: '', dir: '', mode: 'tasks', ver: 'release' }; // 对话框输入项回显（重渲染不丢已填内容；dir=优化方向；mode=优化类型下拉，默认 tasks；ver=规则版本单选，release=发布版本/draft=草稿版，默认 release）
  let lastRcaText = '';        // task id 链路第一步生成的 RCA 分析（面板内展示，重渲染保留）
  let rcaAwaitingReview = false; // RCA 已生成、等待用户确认发送优化请求（60 秒倒计时结束自动发送）
  let rcaReviewDeadline = 0;     // 确认倒计时截止时间戳（面板重渲染后恢复倒计时用）
  let panelMode = 'A';            // 面板模式：A=对话优化 | C=评测集生成
  let evalsetForm = { taskIds: '' }; // 评测集模式输入回显（重渲染不丢已填内容）
  // ── 原文对比（左侧扩展区）状态 ──
  let compareOpen = false;        // 对比区是否展开
  const cmp = {                   // 对比区 DOM/数据引用（面板重建后由 buildCompareWrap 重新填充）
    wrap: null, origTa: null, modTa: null, mirror: null, origMirror: null,
    hl: null, origHl: null,       // 高亮覆盖层（Range 量测矩形绝对定位，不参与文本流）
    status: null, fetchBtn: null,
    qpInput: null, bizSel: null, verSel: null,
    original: '',                 // 已获取的规则原文
    autoKey: '',                  // 已成功获取过的条件（自动获取去重，避免重复请求）
    mergedMarks: [],              // 修改后文本中「被替换进来的修改方式」区间 [{start,end,p}]
    origMarks: [],                // 原文文本中被替换掉的区间 [{start,end,p}]
    lastMerged: '',               // 最近一次合并产出的文本（判断用户是否手动改过修改后）
    lastModText: '',              // 标记对应的修改后文本快照（编辑增量平移的基准）
    repaintTimer: null, syncLock: false
  };
  // 「修改后」工具条状态：一键复制 / 编辑(→保存·取消) / 格式优化
  let cmpEditMode = false;   // 修改后是否处于编辑态（默认只读，点「编辑」解锁）
  let cmpEditBackup = null;  // 进入编辑前快照 {text, mergedMarks, lastMerged, lastModText}，取消时回滚

  // 标记兼容 1~4 级标题：Agent 输出偶尔用「# 优化结果」单井号变体
  const MARKER_PATTERN = /#{1,4}\s*优化结果/;
  const MARKER_CLEAN = '## 优化结果';

  // ── 样式常量 ──
  const FONT = 'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
  
  // ══════════════════════════════════════════
  // 1. 浮动按钮
  // ══════════════════════════════════════════
  let qcFloatBtnPos = null; // 拖拽后的位置记忆（插件自愈重建按钮时恢复）
  function createFloatButton() {
    // 先移除旧按钮（若存在），保证重建不叠加
    const oldBtn = document.getElementById('qc-extract-btn');
    if (oldBtn) oldBtn.remove();
    const btn = document.createElement('div');
    btn.id = 'qc-extract-btn';
    btn.innerHTML = '🤖 质检助手';
    btn.title = '打开质检助手：提取「优化结果」/ 与质检规则 Agent 对话；或按 Ctrl+Shift+E ┃ 插件每 4 秒自愈，点主按钮即可重新提取';
    Object.assign(btn.style, {
      position: 'fixed', bottom: '24px', right: '24px', zIndex: '99998',
      padding: '10px 18px', background: '#1a77e8ff', color: '#fff',
      borderRadius: '8px', cursor: 'grab',
      fontSize: '14px', fontWeight: '600',
      boxShadow: '0 2px 12px rgba(0,0,0,0.18)',
      transition: 'opacity 0.3s, transform 0.2s', userSelect: 'none', touchAction: 'none'
    });
    // 拖拽改变位置：移动距离 >4px 视为拖拽（不触发打开），否则视为点击打开面板；
    // 拖拽中实时钳制在可视区内（left/top 定位，覆盖默认的 right/bottom）
    let dragState = null;
    let justDragged = false;
    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const rect = btn.getBoundingClientRect();
      dragState = { startX: e.clientX, startY: e.clientY, origLeft: rect.left, origTop: rect.top, moved: false };
      try { btn.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    });
    btn.addEventListener('pointermove', (e) => {
      if (!dragState) return;
      const dx = e.clientX - dragState.startX, dy = e.clientY - dragState.startY;
      if (!dragState.moved && Math.hypot(dx, dy) < 4) return; // 小幅抖动不算拖拽
      dragState.moved = true;
      btn.style.cursor = 'grabbing';
      const left = Math.min(Math.max(0, dragState.origLeft + dx), Math.max(0, window.innerWidth - btn.offsetWidth));
      const top = Math.min(Math.max(0, dragState.origTop + dy), Math.max(0, window.innerHeight - btn.offsetHeight));
      btn.style.left = left + 'px';
      btn.style.top = top + 'px';
      btn.style.right = 'auto';
      btn.style.bottom = 'auto';
    });
    const endDrag = () => {
      if (!dragState) return;
      justDragged = dragState.moved;
      dragState = null;
      btn.style.cursor = 'grab';
      // 记住拖拽后的位置，自愈/重建按钮时恢复
      if (justDragged) {
        const r = btn.getBoundingClientRect();
        qcFloatBtnPos = { left: r.left, top: r.top };
      }
    };
    btn.addEventListener('pointerup', endDrag);
    btn.addEventListener('pointercancel', endDrag);
    btn.addEventListener('click', (e) => {
      if (justDragged) { justDragged = false; e.preventDefault(); return; } // 拖拽后不打开
      extractAndShow();
    });
    btn.addEventListener('mouseenter', () => { btn.style.transform = 'translateY(-2px)'; btn.style.opacity = '1'; });
    btn.addEventListener('mouseleave', () => { btn.style.transform = 'translateY(0)'; btn.style.opacity = '0.75'; });
    btn.style.opacity = '0.75';
    document.body.appendChild(btn);
    // 恢复上次拖拽位置（须在挂载后钳制，否则 offsetWidth 为 0；防窗口缩小后按钮跑到屏外）
    if (qcFloatBtnPos) {
      btn.style.left = Math.min(qcFloatBtnPos.left, Math.max(0, window.innerWidth - btn.offsetWidth)) + 'px';
      btn.style.top = Math.min(qcFloatBtnPos.top, Math.max(0, window.innerHeight - btn.offsetHeight)) + 'px';
      btn.style.right = 'auto';
      btn.style.bottom = 'auto';
    }
  }

  // ══════════════════════════════════════════
  // 2. 提取原始结果文本（保留原有归一化逻辑）
  // ══════════════════════════════════════════
  // 收集 Agent 聊天区的「用户消息行」整体（气泡 + 外层用户名/账户标签）：
  // 用户消息含提示词（可能原样带「## 优化结果」误命中）与用户账户信息，
  // 提取与原文定位统一排除（排除整行而非仅气泡，以覆盖气泡外的账户信息）
  function collectChatUserRows() {
    const set = new Set();
    document.querySelectorAll('[class*="messagesArea"]').forEach((area) => {
      area.querySelectorAll('[class*="messageBubbleUser"]').forEach((bub) => {
        // 从气泡向上取直接挂在 messagesArea 下的行节点，整行排除
        let row = bub;
        while (row.parentElement && row.parentElement !== area && row.parentElement !== document.body) {
          row = row.parentElement;
        }
        set.add(row);
      });
    });
    return set;
  }
  // 节点是否属于排除源：用户消息行/输入区/聊天头部（Skill 下拉选项与「昵称/ID/租户」
  // 账户信息都在 chatHeader 区）/插件自身 UI（面板是上次提取结果，悬浮按钮/toast 是自注入文本）
  function inExcludedSource(node, userRows) {
    let p = node.parentElement;
    while (p) {
      const cls = p.className;
      if (typeof cls === 'string' &&
          (cls.indexOf('inputArea') !== -1 || cls.indexOf('chatHeader') !== -1)) return true;
      if (p.id === 'qc-panel' || p.id === 'qc-extract-btn' || p.id === 'qc-toast' ||
          (userRows && userRows.has(p))) return true;
      p = p.parentElement;
    }
    return false;
  }

  // 「## 优化结果」标记的最后一次出现位置：页面上可能残留上一轮回复气泡（旧结果块），
  // 从第一次出现处切会把旧结果 + 中间的欢迎语/思考过程全部拼进来；
  // 取最后一次 = 最新一轮的结果块
  function lastMarkerIndex(text) {
    let idx = -1, probe = 0, found;
    while ((found = text.slice(probe).match(MARKER_PATTERN))) {
      idx = probe + found.index;
      probe = idx + found[0].length;
    }
    return idx;
  }
  // 「## 优化结果」标记的第一次出现位置：从第一个结果块开始,合并所有轮次的块, zj新增函数可放在 lastMarkerIndex之后
  // 避免 lastMarkerIndex 只保留最后一轮导致"只识别最后一条"
  function firstMarkerIndex(text) {
    const found = text.match(MARKER_PATTERN);
    return found ? found.index : -1;
  }

  function extractResult() {
    const userRows = collectChatUserRows();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => inExcludedSource(node, userRows) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    });
    let text = '';
    while (walker.nextNode()) text += walker.currentNode.textContent;

    text = normalizeExtractText(text);

    const idx = firstMarkerIndex(text); //zj 把:const idx = lastMarkerIndex(text);改成:const idx = firstMarkerIndex(text);
    if (idx < 0) return null;
    return sliceResultText(text.slice(idx));
  }

  // 原始文本归一化：修复标题粘连、列表符换行丢失、标点粘连等排版问题
  // （整页提取与模式 A 对话回复共用——Agent 回复同样可能出现 "###第 1条"、"XXX- 修改条数" 这类粘连）
  function normalizeExtractText(text) {
    text = text.replace(/\t+/g, ' | ');
    text = text.replace(/^(#{1,3})\s+([^|\n]+)\s*\|(.+)$/gm, '$1 $2\n\n| $3');
    text = text.replace(/^质检点/gm, '# 质检点');
    text = text.replace(/^质检规则/gm, '# 质检规则');
    text = text.replace(/#{1,4}(优化 | 术语 | 数据 | 渠道 | 判定 | 扣分 | 得分 | 常见 | 修改 | 第 | 绝对 | 天猫 | 服务 | 邮件 | 小记 | 特殊 | 客户 | 备注)/g, (m, kw) => {
      const level = (m.match(/#/g) || []).length;
      return '#'.repeat(level) + ' ' + kw;
    });
    text = text.replace(/###(第一步 | 第二步 | 第三步 | 第四步 | 第五步 | 第六步 | 第七步 | 第八步)/g, '### $1');
    text = text.replace(/(#{1,4})(\d)/g, '$1 $2');
    text = text.replace(/(#{1,4})(Step)/g, '$1 $2');
    text = text.replace(/-([^\s\n])/g, '- $1');
    text = text.replace(/(\d+)\.([^\s\n])/g, '$1. $2');
    text = text.replace(/(#{1,4}\s[^\n]+)\n\n([a-zA-Z 一-龥])/g, '$1$2');

    text = text.replace(/\|\|/g, '|\n|');
    text = text.replace(/\n\|\n/g, '\n');
    text = text.replace(/^- -- (?=[^\n|\-])/gm, '');
    text = text.replace(/([^\n])(#{0,3}\s*第\s*\d+\s*条\s*[：:])/g, '$1\n\n$2');
    text = text.replace(/([；。])([^\n])/g, '$1\n$2');
    text = text.replace(/([）\)])([^\n\s])/g, '$1\n$2');
    text = text.replace(/→\s*得分/g, '→ 得分\n');
    text = text.replace(/→\s*扣分/g, '→ 扣分\n');
    text = text.replace(/→默认得分/g, '→ 默认得分\n');
    text = text.replace(/([^\n])(#{1,3}\s)/g, '$1\n\n$2');
    text = text.replace(/([^\n])(---)/g, '$1\n\n$2');
    text = text.replace(/(---)([^\n])/g, '$1\n\n$2');
    text = text.replace(/([^\n-])(-\s)/g, '$1\n$2');
    text = text.replace(/([^\n])(\d+\.\s)/g, '$1\n$2');
    text = text.replace(/\n{3,}/g, '\n\n');
    return text;
  }

  // 「## 优化结果」块的后处理：标题归一化 + 尾部噪音截断 + 占位符/长度校验
  // （整页提取与模式 A 对话框回复的格式优化共用）
  // minLen：整页提取默认 500（防页面垃圾文本）；对话回复是 Agent 定向输出，可放宽
  // 截断标记的上下文守卫：防误伤合法正文——
  //   '已完成' 仅在短窗口内接「规则」时截（结论句「已完成规则G24…」/「已完成 G12 规则优化分析」，
  //   中间可能夹空格与质检点编号）；
  //   'ID：' 仅在前面不是「规则」时截（账户信息「ID：9277547」要截，「规则 ID：815」是合法头部字段）
  const CUT_GUARDS = {
    '已完成': (result, i) => {
      const pre = result.slice(Math.max(0, i - 8), i).replace(/[\s\n\r]+$/, '');
      if (pre.endsWith('得分') || pre.endsWith('"') || pre.endsWith('"')) return false;
      return /^[\sA-Za-z0-9]{0,8}规则/.test(result.slice(i + 3, i + 15));
    },
    // 「规则 ID：815」中「规则」与「ID：」之间可能有空格，取 4 字符窗口再去尾空格判断
    'ID：': (result, i) => !result.slice(Math.max(0, i - 4), i).replace(/\s+$/, '').endsWith('规则')
  };
  function sliceResultText(result, minLen) {
    result = result.replace(/^#{1,4}\s*优化结果/, MARKER_CLEAN);

    const cutMarkers = [
      '\n用户没有提出新的问题', '\n现在我需要询问用户', '\n等待用户的反馈', '\n现在等待用户反馈',
      '\nSkill 已加载成功', '\n## 步骤 7：', '\n## 可用 Tool', '\n## 关键约束',
      '\n#### 补丁式输出强制定义', '\n#### ⛔ 输出纯净化强制约束',
      '\n| 禁止泄露的标记类型', '\n| 层 | 操作 | 说明', '| 语义层 | RELEASE',
      '\n质检规则 Agent', '\n质检 Agent', '\n评测分析 Agnet', '\nCOCKPIT', '\nQWEN', '\n📋 提取结果', '\n🛠️ 质检助手',
      // 无空格变体与账户信息兑底：页面拼接可能无换行，头部 Skill 下拉/昵称/ID/租户
      // 一旦被扫进来就从这里截断（提取器已在源头排除 chatHeader，此处为双保险）
      '质检规则Agent', '质检Agent', '评测分析Agnet', '质检平台对话Agent', '昵称：', 'ID：', '租户：',
      '采纳该规则', '评测此规则', // 回复下方的快捷操作按钮文案
      // Agent 回复末尾的总结性结论（如「已完成规则G24的逻辑诊断与优化定位。共发现…如需保存修改到平台，请告知」），
      // 不属于「## 优化结果」正文，从结论开头处截断；
      // 「如需保存修改」用短前缀兼容变体（「如需保存修改后的规则到平台」）
      '已完成', '逻辑诊断与优化定位', '规则优化分析', '如需保存修改',
      // 聊天页的欢迎语/推荐入口/思考过程块（关闭面板后重新提取时可能被拼进来）
      '你好！我是质检规则助手', '你可以用自然语言', '你可以尝试', '思考过程'
    ];
    // 取所有命中标记中位置最靠前的截断点（而非列表顺序第一个命中的），
    // 保证切在最早的噪音处，不会因标记列表顺序漏切更早的噪音
    let cutAt = -1;
    for (const cut of cutMarkers) {
      let cutIdx = result.lastIndexOf(cut); //zj
      // 带守卫的标记：跳过不满足上下文的位置，继续找下一个出现处
      while (cutIdx > 100 && CUT_GUARDS[cut] && !CUT_GUARDS[cut](result, cutIdx)) {
        const next = result.indexOf(cut, cutIdx + cut.length);
        if (next === -1) { cutIdx = -1; break; }
        cutIdx = next;
      }
      if (cutIdx > 100 && (cutAt === -1 || cutIdx < cutAt)) cutAt = cutIdx; //zj
    }
    if (cutAt !== -1) result = result.slice(0, cutAt);

    const shortPlaceholders = result.match(/\{[^}]{1,6}\}/g);
    if (shortPlaceholders && shortPlaceholders.length >= 3) return null;
    if (result.length < (minLen == null ? 500 : minLen)) return null;
    return result.trim();
  }

  // ══════════════════════════════════════════
  // 3. 结构化解析：将杂乱结果拆分为「问题条目列表」
  //    每个条目抓取：标题 / 类型 / 原文定位 / 问题描述 / 修改方式
  // ══════════════════════════════════════════
  const FIELD_LABELS = ['原文定位', '问题描述', '修改方式'];

  function findLabel(str, label) {
    for (let i = 0; i < str.length; i++) {
      if (str.startsWith(label, i)) {
        const after = str[i + label.length];
        if (after === '：' || after === ':') return i;
      }
    }
    return -1;
  }

  // 在 block 中取出某个字段的内容（到下一个字段标签为止），并清洗 markdown
  function extractField(block, label) {
    const idx = findLabel(block, label);
    if (idx < 0) return '';
    let rest = block.slice(idx).replace(/^(原文定位|问题描述|修改方式)\s*[：:]/, '');
    let end = rest.length;
    for (const l of FIELD_LABELS) {
      if (l === label) continue;
      const p = findLabel(rest, l);
      if (p !== -1 && p < end) end = p;
    }
    return cleanField(rest.slice(0, end));
  }

  // 清洗字段内容：去掉 blockquote 的>、多余空白，保留列表结构
  function cleanField(field) {
    return field
      .split('\n')
      .map(l => l.replace(/>/g, '').replace(/^\s+/, '').replace(/\s+$/, ''))
      .filter(l => l.trim() !== '')
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function structureProblems(content, promptCtx) {
    // 关键：让字段标签单独成行，避免与标题/前文粘连（空格宽容：兼容页面拼接与 Agent 干净输出两种形态）
    let t = content.replace(/(原文定位|问题描述|修改方式)\s*[：:]/g, '\n$1：');

    // 拆出所有「第 N 条」标题的位置（兼容 1~6 级标题：Agent 偶尔输出「## 第 1 条」变体；
    // 也兼容无 # 前缀的纯文本「第 1 条：」——部分 Agent 回复不带 markdown 标题符号）。
    // 行首锚定（m 标志）：避免正文里"参见第 1 条"这类引用被误判为标题而把条目拦腰截断。
    const titleRe = /^#{0,6}\s*第\s*\d+\s*条/gm;
    const titles = [];
    let m;
    while ((m = titleRe.exec(t))) titles.push(m.index);
    if (titles.length === 0) return [];

    // 质检点引用与业务线（整个结果块共用）：优先从「用户输入的提示词」识别——
    // 提示词里带质检规则原文，质检点编码/业务线一定存在；Agent 回复是优化结果，
    // 不一定复述编码/业务线，只作兜底补充（不覆盖提示词识别结果）。
    const ctx = promptCtx ? String(promptCtx) : '';
    let qcRefs = ctx ? extractQcRefs(ctx) : [];
    let qcBizLine = ctx ? extractQcBizLine(ctx) : null;
    if (!qcRefs.length) qcRefs = extractQcRefs(t);
    if (!qcBizLine) qcBizLine = extractQcBizLine(t);

    const problems = [];
    const seen = new Set(); // 指纹去重：同一条目在页面上重复出现（新旧气泡残留/双份结果块）时只保留第一份
    for (let i = 0; i < titles.length; i++) {
      const start = titles[i];
      const end = (i + 1 < titles.length) ? titles[i + 1] : t.length;
      const block = t.slice(start, end);

      const firstLine = block.trim().split('\n')[0].trim();
      const title = firstLine.replace(/^#+\s*/, '').trim();

      // 类型：取标题最后「：」后的词，如「逻辑问题」「格式问题」
      let type = '';
      const cm = title.match(/[：:]\s*([^：:]+?)\s*$/);
      if (cm) type = cm[1].trim();

      const locate = extractField(block, '原文定位');
      const desc = extractField(block, '问题描述');
      const fix = extractField(block, '修改方式');

      if (desc || locate || fix) {
        const fp = (locate + '|' + desc + '|' + fix).replace(/\s+/g, '');
        if (seen.has(fp)) continue;
        seen.add(fp);
        problems.push({ title, type, locate, desc, fix, qcRefs, qcBizLine });
      }
    }
    return problems;
  }

  // 提取结果块里的质检点引用，供「🎯 跳转质检点」在页面上定位：
  // ① 正文中出现的质检点编码（G / E / C 前缀 + CO / EO 双字母写法，
  //    兼容 G17 / G-17 / G 17 / E01 / CO01 等）；
  // ② 「规则 ID：814」头部字段的纯数字 ID 兜底。
  function extractQcRefs(content) {
    const refs = [];
    const push = (v) => { if (v && !refs.includes(v)) refs.push(v); };
    const s = String(content);
    for (const gm of s.matchAll(qcRefRegex('g'))) {
      push(gm[0].replace(/[\s-]/g, '').toUpperCase());
    }
    const im = s.match(/规则\s*ID\s*[：:]\s*([A-Za-z]*\d+)/i);
    if (im && !/^[A-Za-z]/.test(im[1])) push(im[1]); // 带字母前缀的已在上一步收过，这里只补纯数字 ID
    return refs;
  }

  // 质检点引用匹配正则（模式 A 跳转用）：G / E / C + 可选 O（CO / EO 双字母前缀）+ 1-4 位数字。
  // 左边界「前面不能紧邻字母」防止 ECO12 / XCO12 误摘出 CO12；
  // 右边界「后面不能紧跟数字」防止 G17 命中 G170。
  function qcRefRegex(flags) {
    return new RegExp('(?<![A-Za-z])[GCE]O?S?\\s?-?\\s?\\d{1,4}(?![0-9])', flags || '');
  }

  // 提取结果块里提到的业务线（规则页左侧树按业务线折叠，跳转前需先展开对应业务线）。
  // ① 全名直接出现在正文（如「Antom AGH-天猫飞猪」「CN Trade」）→ 取最长命中；
  // ② 别名/特征词（S天猫国际、B-WF-EC 等）→ 走 resolveTargetBizLine 确定性映射。
  function extractQcBizLine(content) {
    const c = _norm(content);
    let best = null, bestLen = -1;
    for (const line of QC_BIZ_LINES) {
      const nn = _norm(line.name);
      if (nn && nn.length > bestLen && c.indexOf(nn) !== -1) { best = line.name; bestLen = nn.length; }
    }
    if (best) return best;
    const hit = resolveTargetBizLine(String(content));
    return hit ? hit.name : null;
  }

  // ══════════════════════════════════════════
  // 4. 原文高亮定位（页面在侧栏左侧可见，无需关窗）
  // ══════════════════════════════════════════
  // 长度保持归一化：把 md 符号/空白族统一替换为单个空格（保留长度，便于偏移回溯到 DOM）
  // 页面是 md 渲染后的文本，原文定位字段是 md 源码 → 归一化后两者可精确匹配
  function normKeepLen(s) {
    return (s || '')
      .replace(/ /g, ' ')
      .replace(/[\t\r\n]+/g, ' ')
      .replace(/[`*_~#><|\\{}\[\]\-+]/g, ' ')
      .replace(/\s+/g, ' ')
      .toLowerCase();
  }

  // ───── 内容化 (剥离符号法) ─────
  // 只保留汉字/字母/数字，彻底去掉 # > ` 空格等所有 md 符号与空白。
  // 返回 { text: 内容串，map: text[i] 对应的原文本偏移 }，供 1:1 映射回原文。
  // 编辑模式下 (规则原文在 textarea 源码)，原文定位字段的 > 与源码的 # 全被消除，两侧内容层收敛一致 → 匹配最稳。
  function toChars(s) {
    const text = []; const map = [];
    const src = String(s || '');
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (/[0-9A-Za-z 一-龥]/.test(ch)) { text.push(ch.toLowerCase()); map.push(i); }
    }
    return { text: text.join(''), map };
  }

  // 在内容串上做滑动窗口模糊定位，返回 {start,end}(内容偏移，半开区间)
  // 三段式：粗扫（step 步长 dice 找高分区域）→ 精扫（step=1 钉准起点，修复粗扫步长偏移导致的定位不准）
  // → 长度精修（按目标长短自适应放宽，覆盖原文截断/增长差异）
  function locateWindow(target, concat) {
    const tlen = target.length;
    if (tlen < 4) return null;
    const tg = gramSet(target);
    const L = concat.length;
    if (L < tlen) return null;
    let bestPos = -1, bestDice = 0;
    const step = Math.max(1, Math.floor(tlen / 3));
    for (let i = 0; i + tlen <= L; i += step) {
      const wg = gramSet(concat.slice(i, i + tlen));
      let common = 0; for (const g of tg) if (wg.has(g)) common++;
      const dice = (tg.size + wg.size) ? 2 * common / (tg.size + wg.size) : 0;
      if (dice > bestDice) { bestDice = dice; bestPos = i; }
    }
    if (bestPos < 0 || bestDice < 0.4) return null;
    // 精扫：在粗扫最优位附近 step=1 逐位打分，钉准起点
    const spread = Math.max(step, Math.ceil(tlen / 4));
    const lo = Math.max(0, bestPos - spread);
    const hi = Math.min(L - tlen, bestPos + spread);
    let finePos = bestPos, fineScore = -1;
    for (let i = lo; i <= hi; i++) {
      const s = blockScore(target, concat.slice(i, i + tlen));
      if (s > fineScore) { fineScore = s; finePos = i; }
    }
    // 长度精修：短文本容差 ±3，长文本按比例放宽到 ±10%（上限 8），避免枚举量过大卡顿
    const dLen = tlen <= 24 ? 3 : Math.min(8, Math.max(3, Math.floor(tlen * 0.1)));
    let fb = null;
    const rlo = Math.max(0, finePos - dLen);
    const rhi = Math.min(L, finePos + tlen + dLen + 1);
    for (let wl = Math.max(2, tlen - dLen); wl <= tlen + dLen; wl++) {
      for (let i = rlo; i + wl <= rhi; i++) {
        const s = blockScore(target, concat.slice(i, i + wl));
        if (!fb || s > fb.score) fb = { start: i, end: i + wl, score: s };
      }
    }
    if (!fb || fb.score < 0.55) return null;
    return fb;
  }

  // 锚点窗口定位：用 target 最长的几个「整行内容」作锚点在 concat 中精确搜索，
  // 每个命中处按锚点在 target 内的偏移回推目标起点，再以整体 blockScore 校验。
  // 对含重复高频短句（如多行「→ 得分」）的长文本远比纯滑窗准确——
  // 纯滑窗会被另一段 bigram 同样密集的相似文本骗走，而锚点要求整行完全一致
  function anchorLocate(targetText, lines, concat) {
    const anchors = lines.filter((l) => l.length >= 8).sort((a, b) => b.length - a.length).slice(0, 4);
    let best = null;
    for (const a of anchors) {
      const aOff = targetText.indexOf(a);
      if (aOff === -1) continue;
      let idx = concat.indexOf(a);
      let guard = 0;
      while (idx !== -1 && guard++ < 20) {
        const s = Math.max(0, Math.min(idx - aOff, Math.max(0, concat.length - 1)));
        const wl = Math.min(targetText.length, concat.length - s);
        const score = blockScore(targetText, concat.slice(s, s + wl));
        if (!best || score > best.score) best = { start: s, end: s + wl, score };
        idx = concat.indexOf(a, idx + 1);
      }
      if (best && best.score >= 0.75) break; // 高置信命中，无需再试其他锚点
    }
    return best;
  }

  // 定位"编辑模式"下的规则原文 textarea(隐藏 measure 框会被内容条件排除)
  function findEditTextarea() {
    let ta = document.querySelector('textarea.editorTextareaInput, textarea[class*="editorTextarea"]');
    if (ta) return ta;
    for (const el of document.querySelectorAll('textarea')) {
      if (el.closest('#qc-panel')) continue;
      const v = el.value || '';
      if (v.length > 60 && /(^|\n)\s*#{1,6}\s/.test(v)) return el;
    }
    return null;
  }

  // 滚动 textarea 使 start 偏移所在行进入可视区 (原生选区做高亮)
  function scrollTextareaToRange(ta, start) {
    try {
      const lh = parseFloat(getComputedStyle(ta).lineHeight) || 20;
      const line = (ta.value.slice(0, start).match(/\n/g) || []).length;
      ta.scrollTop = Math.max(0, line * lh - ta.clientHeight * 0.4);
    } catch (e) { /* ignore */ }
  }

  // 编辑模式定位：匹配 textarea.value → 原生 setSelectionRange 选中 (即高亮)
  function locateInTextarea(ta, locateField) {
    const val = ta.value || '';
    const target = toChars(locateField).text;
    if (target.length < 2) { showToast('⚠️ 原文内容太短，无法定位'); return; }
    const src = toChars(val);
    let startC = src.text.indexOf(target);
    let endC = startC + target.length;
    let mode = 'EXACT';
    if (startC === -1) {
      // 短文本 bigram 样本太少不可靠，仅长文本允许模糊定位
      if (target.length < 4) { showToast('⚠️ 原文内容太短，无法模糊定位'); return; }
      // 锚点优先（整行精确命中回推起点），滑窗兑底；门槛 0.55 防止定位到相似但错误的段落
      const field = String(locateField || '').replace(/\\n/g, '\n');
      const lines = field.split(/\n+/).map((l) => toChars(l).text);
      let fb = anchorLocate(target, lines, src.text);
      if (!fb || fb.score < 0.55) {
        const fw = locateWindow(target, src.text);
        if (fw && (!fb || fw.score > fb.score)) fb = fw;
      }
      if (!fb || fb.score < 0.55) { showToast('⚠️ 未找到足够相似的原文 (编辑框)'); return; }
      mode = 'FUZZY'; startC = fb.start; endC = fb.end;
    }
    const origStart = src.map[startC];
    const origEnd = src.map[endC - 1] + 1;
    ta.focus();
    try { ta.setSelectionRange(origStart, origEnd); } catch (e) { /* ignore */ }
    try { ta.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { /* ignore */ }
    setTimeout(() => scrollTextareaToRange(ta, origStart), 300);
    showToast(mode === 'FUZZY' ? '✅ 已在编辑框内选中最相似的原文' : '✅ 已在编辑框内选中并高亮原文');
  }

  // 全页面内容流拍平 (DOM 文本节点 → 内容串 + 每字符 {node,local} 映射)，
  // 排除聊天区用户消息行/输入区与插件面板（与提取同口径，避免定位进气泡/账户信息）
  function contentFlatten() {
    const text = []; const marks = [];
    const userRows = collectChatUserRows();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.textContent || !node.textContent.trim()) return NodeFilter.FILTER_REJECT;
        if (inExcludedSource(node, userRows)) return NodeFilter.FILTER_REJECT;
        const t = node.parentElement && node.parentElement.tagName;
        if (t === 'SCRIPT' || t === 'STYLE' || t === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const raw = node.textContent;
      for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (/[0-9A-Za-z 一-龥]/.test(ch)) { text.push(ch.toLowerCase()); marks.push({ node, local: i }); }
      }
    }
    return { text: text.join(''), marks };
  }

  // 求值 (渲染) 模式下基于内容流的窗口定位 → 返回跨节点 Range 边界。
  // 关键：target 先内容化（toChars）再与内容流比对——否则含空格/标点的 target
  // 与纯内容流字符集不一致，bigram 打分被稀释，导致匹配失败或定位偏移；
  // 模糊层锚点优先 + 门槛 0.55，宁可报未找到也不定位到相似但错误的段落
  function fuzzyLocateConcat(locateField) {
    const field = String(locateField || '').replace(/\\n/g, '\n');
    const t = toChars(field).text;
    if (t.length < 2) return null;
    const { text, marks } = contentFlatten();
    if (!marks.length) return null;
    let startC = text.indexOf(t);
    let endC = startC + t.length;
    if (startC === -1) {
      const lines = field.split(/\n+/).map((l) => toChars(l).text);
      let fb = anchorLocate(t, lines, text);
      if (!fb || fb.score < 0.55) {
        if (t.length >= 4) {
          const fw = locateWindow(t, text);
          if (fw && (!fb || fw.score > fb.score)) fb = fw;
        }
      }
      if (!fb || fb.score < 0.55) return null;
      startC = fb.start; endC = fb.end;
    }
    const sMark = marks[startC];
    const eMark = marks[endC - 1];
    return { startNode: sMark.node, startLocal: sMark.local, endNode: eMark.node, endLocal: eMark.local + 1 };
  }

  function highlightOnPage(locateField) {
    if (highlightCleanup) { highlightCleanup(); highlightCleanup = null; }

    // 兼容字段里存的是字面量 \n \t \r（先转成空格）；再对 target 做 trim()，
    // 去掉 md 符号 (#/>)剥离后残留的首尾空格——否则符号后残留的空格永远匹配不到，导致 indexOf 失败
    const target = normKeepLen(locateField.replace(/\\[nrt]/g, ' ')).trim();
    // 长度门槛改用内容化字符数（去掉空格/标点/md 符号后的实质字数），短原文也有机会走精确匹配
    if (toChars(target).text.length < 2) { showToast('⚠️ 原文内容太短，无法定位'); return; }

    // ★ 编辑模式优先：规则原文在 textarea 源码中，走原生选区高亮
    const editTa = findEditTextarea();
    if (editTa) { locateInTextarea(editTa, locateField); return; }

    // 1) 把所有文本节点拍平成一条连续串，并用"累计偏移"记录每个节点的区间
    //    （排除聊天区用户消息行/输入区与插件面板，避免定位进气泡/账户信息）
    const nodes = [];
    const userRows = collectChatUserRows();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.textContent || !node.textContent.trim()) return NodeFilter.FILTER_REJECT;
        if (inExcludedSource(node, userRows)) return NodeFilter.FILTER_REJECT;
        const t = node.parentElement && node.parentElement.tagName;
        if (t === 'SCRIPT' || t === 'STYLE' || t === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let concat = '';
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const n = normKeepLen(node.textContent);
      if (n.length < 2) continue;
      nodes.push({ node, n, start: concat.length });
      concat += n + ' '; // 节点间用一个空格连接
    }
    if (!nodes.length) { showToast('⚠️ 未在页面中找到匹配的原文'); return; }

    // 2) 在连续串里做精确子串匹配（md 源码已归一化为与渲染文本一致的形式）
    let p = concat.indexOf(target);
    if (p === -1) {
      // 精确匹配不到 → 改用"内容流 (剥离符号)+锚点/窗口模糊"定位，保证渲染下也能覆盖到全部条目
      const fc = fuzzyLocateConcat(locateField);
      if (!fc) { showToast('⚠️ 未找到足够相似的原文'); return; }
      try {
        const r = document.createRange();
        r.setStart(fc.startNode, Math.max(0, fc.startLocal));
        r.setEnd(fc.endNode, Math.max(0, fc.endLocal));
        const baseEl = fc.startNode.parentElement;
        if (baseEl && baseEl.scrollIntoView && document.contains(baseEl)) {
          try { baseEl.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { /* ignore */ }
        }
        setTimeout(() => {
          if (highlightCleanup) { highlightCleanup(); highlightCleanup = null; }
          try { paintRange(r); } catch (e) { showToast('✅ 已滚动到原文'); }
        }, 400);
        showToast('✅ 已定位到相似原文并高亮');
      } catch (e) { showToast('✅ 已滚动到原文'); }
      return;
    }
    const end = p + target.length;

    // 3) 用累计偏移把 [p, end) 映射回起始/结束 DOM 文本节点（跨节点也成立）
    let startNode = null, startLocal = -1;
    let endNode = null, endLocal = -1;
    for (const c of nodes) {
      const segEnd = c.start + c.n.length + 1; // 含 join 空格
      if (!startNode && c.start <= p && p < segEnd) { startNode = c.node; startLocal = p - c.start; }
      if (!endNode && c.start <= end && end <= segEnd) { endNode = c.node; endLocal = end - c.start; }
      if (startNode && endNode) break;
    }
    if (!startNode) { startNode = nodes[0].node; startLocal = 0; }
    if (!endNode) { endNode = nodes[nodes.length - 1].node; endLocal = nodes[nodes.length - 1].n.length; }

    // 4) 滚动到原文块并居中（scrollIntoView 适配任意嵌套滚动容器）
    const baseEl = startNode.parentElement;
    if (baseEl && baseEl.scrollIntoView && document.contains(baseEl)) {
      try { baseEl.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { /* ignore */ }
    }

    // 5) 平滑滚动稳定后，用跨节点 Range 精确定位并叠加矩形覆盖（不再整段高亮父元素）
    setTimeout(() => {
      if (highlightCleanup) { highlightCleanup(); highlightCleanup = null; }
      try {
        const range = document.createRange();
        range.setStart(startNode, Math.max(0, startLocal));
        range.setEnd(endNode, Math.max(0, endLocal));
        paintRange(range);
      } catch (e) { showToast('✅ 已滚动到原文'); }
    }, 400);

    showToast('✅ 已滚动到原文并高亮');
  }

  // 精确高亮：position:fixed + 视口坐标，滚动后不受滚动容器/定位上下文影响
  function paintRange(range) {
    const markers = [];
    const rects = range.getClientRects();
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      if (!r.width || !r.height) continue;
      const mk = document.createElement('div');
      mk.style.cssText = [
        'position:fixed', 'left:' + r.left + 'px', 'top:' + r.top + 'px',
        'width:' + r.width + 'px', 'height:' + r.height + 'px',
        'background:linear-gradient(180deg, rgba(255,235,59,0.60), rgba(255,152,0,0.40))',
        'border:2px solid #f57c00', 'border-radius:3px', 'zIndex:99997',
        'pointerEvents:none', 'boxShadow:0 0 10px rgba(255,152,0,0.45)',
        'animation:qcPulse 0.8s ease-in-out 4'
      ].join(';');
      document.body.appendChild(mk);
      markers.push(mk);
    }
    highlightCleanup = () => markers.forEach(m => m.remove());
    setTimeout(() => { if (highlightCleanup) { highlightCleanup(); highlightCleanup = null; } }, 6000);
  }

  // ───────── 模糊定位：高亮相似度最高的模块 ─────────
  // 字符二元组集合
  function gramSet(s) {
    const set = new Set();
    for (let i = 0; i + 1 < s.length; i++) set.add(s.slice(i, i + 2));
    return set;
  }
  // bigram Jaccard 相似度 + 长度比综合打分（对小增删改、格式差异稳健）
  function blockScore(target, nt) {
    if (!target.length || !nt.length) return 0;
    const A = gramSet(target), B = gramSet(nt);
    let inter = 0;
    for (const g of A) if (B.has(g)) inter++;
    const union = A.size + B.size - inter;
    const gramSim = union ? inter / union : 0;
    const lenRatio = 1 - Math.abs(target.length - nt.length) / Math.max(target.length, nt.length);
    return 0.7 * gramSim + 0.3 * lenRatio;
  }

  const FUZZY_BLOCK_TAGS = 'p,div,li,td,th,h1,h2,h3,h4,h5,h6,blockquote,section,article,dd,dt';

  // 全页面收集候选块，返回得分最高者
  function fuzzyBestBlock(target) {
    const all = document.querySelectorAll(FUZZY_BLOCK_TAGS);
    let best = null;
    for (const el of all) {
      if (el.closest('#qc-panel') || el.closest('script,style,noscript')) continue;
      const raw = (el.textContent || '').replace(/\\[nrt]/g, ' ');
      const nt = normKeepLen(raw).trim();
      if (nt.length < 4) continue;
      const s = blockScore(target, nt);
      if (!best || s > best.score) best = { el, score: s, nt };
    }
    return best;
  }

  // 在最佳块内向可匹配的更小子块收缩，得到最小、最贴合的模块
  function fuzzyShrink(target, best) {
    let cur = best, curScore = best.score;
    for (;;) {
      const kids = cur.el.querySelectorAll(FUZZY_BLOCK_TAGS);
      let nxt = null, ns = 0;
      for (const k of kids) {
        const nt = normKeepLen((k.textContent || '').replace(/\\[nrt]/g, ' ')).trim();
        if (nt.length < 4) continue;
        const s = blockScore(target, nt);
        if (s >= curScore - 0.10 && s > 0 && (!nxt || s > ns)) { nxt = k; ns = s; }
      }
      if (!nxt) break;
      cur = { el: nxt, score: ns, nt: nxt.textContent || '' };
      curScore = ns;
    }
    return cur.el;
  }

  // 模块级高亮：整块描边 + 半透明底，滚动到视口居中
  function fuzzyHighlight(target) {
    const best = fuzzyBestBlock(target);
    if (!best || best.score < 0.28) { showToast('⚠️ 未找到相似度足够的原文模块'); return; }
    const el = fuzzyShrink(target, best);
    try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { /* ignore */ }
    setTimeout(() => {
      if (highlightCleanup) { highlightCleanup(); highlightCleanup = null; }
      try {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) { showToast('✅ 已定位到相似原文模块'); return; }
        const mk = document.createElement('div');
        mk.style.cssText = [
          'position:fixed', 'left:' + r.left + 'px', 'top:' + r.top + 'px',
          'width:' + r.width + 'px', 'height:' + r.height + 'px',
          'border:2px solid #f57c00', 'border-radius:6px',
          'background:rgba(255,235,59,0.16)', 'zIndex:99996', 'pointerEvents:none',
          'boxShadow:0 0 12px rgba(255,152,0,0.5)',
          'animation:qcPulse 0.8s ease-in-out 4'
        ].join(';');
        document.body.appendChild(mk);
        highlightCleanup = () => mk.remove();
        setTimeout(() => { if (highlightCleanup) { highlightCleanup(); highlightCleanup = null; } }, 6000);
        showToast('✅ 已定位到相似原文模块');
      } catch (e) { showToast('✅ 已定位到相似原文模块'); }
    }, 400);
  }

  // ══════════════════════════════════════════
  // 5. 渲染：问题卡片（模式 A）
  // ══════════════════════════════════════════
  function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function multilineToHtml(text) {
    // 简单把多行文本渲染为带换行的块（保留列表符号）
    return text.split('\n').map(l => esc(l)).join('<br>');
  }

  // ── 修改方式 vs 原文定位的差异加粗 ──
  // 行级匹配（每行在原文中找最相似行）+ 段级 LCS diff（改动部分加粗）
  function diffLcs(a, b) {
    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const ops = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { ops.push({ s: '=', v: a[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ s: '+', v: b[j] }); j++; }
      else { ops.push({ s: '-', v: a[i] }); i++; }
    }
    while (j < m) ops.push({ s: '+', v: b[j++] });
    return ops;
  }
  // 相邻同类 op 合并为段，删除段（原文独有）不展示，仅保留相同/新增
  function diffSegments(a, b) {
    const ops = diffLcs(a, b);
    const segs = [];
    for (const op of ops) {
      if (op.s === '-') continue;
      const last = segs[segs.length - 1];
      if (last && last.changed === (op.s === '+')) last.text += op.v;
      else segs.push({ text: op.v, changed: op.s === '+' });
    }
    return segs;
  }
  // 修改方式渲染：与原文定位逐行比对，新增/改动文字 <b> 加粗；
  // 找不到相似行（纯新增行）整行加粗；无原文可对比时退化为普通多行渲染
  function diffBoldHtml(fix, locate) {
    const fLines = String(fix || '').split('\n');
    if (!String(locate || '').trim()) return multilineToHtml(fix);
    const lLines = String(locate).split('\n');
    const used = new Set();
    const lineSim = (x, y) => {
      if (!x.length || !y.length) return 0;
      const gx = gramSet(x), gy = gramSet(y);
      let c = 0; for (const g of gx) if (gy.has(g)) c++;
      return 2 * c / (gx.size + gy.size);
    };
    const html = fLines.map((fl) => {
      const ft = fl.trim();
      if (!ft) return '';
      let bi = -1, bs = 0;
      lLines.forEach((ll, i) => {
        if (used.has(i)) return;
        const s = lineSim(ft, ll.trim());
        if (s > bs) { bs = s; bi = i; }
      });
      if (bi === -1 || bs < 0.45) return '<b>' + esc(fl) + '</b>'; // 纯新增行整行加粗
      used.add(bi);
      if (bs >= 0.999) return esc(fl); // 完全一致不加粗
      return diffSegments(lLines[bi].trim(), ft).map((seg) =>
        seg.changed ? '<b>' + esc(seg.text) + '</b>' : esc(seg.text)).join('');
    });
    return html.join('<br>');
  }

  function buildCard(p, index) {
    const card = document.createElement('div');
    card.className = 'qc-card';

    // const typeClass = p.type === '格式问题' ? 'qc-badge-fmt' : (p.type === '逻辑问题' ? 'qc-badge-logic' : 'qc-badge-other');

    const head = document.createElement('div');
    head.className = 'qc-card-head';
    head.innerHTML = '<span class="qc-card-title">' + esc(p.title) + '</span>' +
      (p.type ? '<span class="qc-badge qc-badge-other">' + esc(p.type) + '</span>' : '');

    // 跳转质检点：按解析出的 G 编码/规则 ID 在页面上定位对应位置（如差异表的质检点行）
    if (p.qcRefs && p.qcRefs.length) {
      const jumpBtn = document.createElement('button');
      jumpBtn.type = 'button';
      jumpBtn.className = 'qc-jump-btn';
      jumpBtn.textContent = '🎯 质检点';
      jumpBtn.title = '跳转到页面上的质检点（' + (p.qcBizLine ? p.qcBizLine + ' · ' : '') + p.qcRefs.join(' / ') + '）';
      jumpBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        jumpToQcPoint(p.qcRefs, p.qcBizLine);
      });
      head.appendChild(jumpBtn);
    }

    card.appendChild(head);

    // 问题描述 — 独立成行
    if (p.desc) {
      const desc = document.createElement('div');
      desc.className = 'qc-desc';
      desc.innerHTML = '<div class="qc-desc-label">📝 问题描述</div>' +
        '<div class="qc-desc-body">' + multilineToHtml(p.desc) + '</div>';
      card.appendChild(desc);
    }

    // 原文定位 + 修改方式 — 列表
    const list = document.createElement('div');
    list.className = 'qc-detail-list';

    if (p.locate) {
      const row = document.createElement('div');
      row.className = 'qc-detail-row qc-locate-row';
      row.innerHTML =
        '<div class="qc-detail-label">📌 原文定位</div>' +
        '<div class="qc-detail-body">' + multilineToHtml(p.locate) + '</div>' +
        '<button class="qc-locate-btn" type="button" data-locate="' + esc(encodeURIComponent(p.locate)) + '">📍 定位原文</button>';
      list.appendChild(row);
    }

    if (p.fix) {
      const row = document.createElement('div');
      row.className = 'qc-detail-row qc-fix-row';
      row.innerHTML =
        '<div class="qc-detail-label">✏️ 修改方式</div>' +
        // 与原文定位的差异部分加粗展示（复制仍用原始纯文本 p.fix）
        '<div class="qc-detail-body">' + diffBoldHtml(p.fix, p.locate) + '</div>';
      const bodyEl = row.querySelector('.qc-detail-body');
      // 每条修改方式右上角的复制按钮：只复制本条修改方式文本
      const copyFixBtn = document.createElement('button');
      copyFixBtn.type = 'button';
      copyFixBtn.className = 'qc-fix-copy-btn';
      copyFixBtn.textContent = '📋 复制';
      copyFixBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(p.fix).then(() => {
          copyFixBtn.textContent = '✅ 已复制';
          setTimeout(() => (copyFixBtn.textContent = '📋 复制'), 1500);
          qcTrack('优化结果复制', { result: 'success', reply_len: (p.fix || '').length, biz: p.qcBizLine || '', qp: (p.qcRefs && p.qcRefs[0]) || '' });
        }).catch(() => { showToast('❌ 复制失败'); qcTrack('优化结果复制', { result: 'fail', error_code: 'clipboard', biz: p.qcBizLine || '', qp: (p.qcRefs && p.qcRefs[0]) || '' }); });
      });
      // 编辑按钮：就地微调修改方式文本；保存后 p.fix 更新，复制/重渲染都用新内容
      const editFixBtn = document.createElement('button');
      editFixBtn.type = 'button';
      editFixBtn.className = 'qc-fix-edit-btn';
      editFixBtn.textContent = '✏️ 编辑';
      editFixBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openFixEditor(row, bodyEl, p, copyFixBtn, editFixBtn);
      });
      row.appendChild(copyFixBtn);
      row.appendChild(editFixBtn);
      list.appendChild(row);
    }

    card.appendChild(list);
    return card;
  }

  // 修改方式就地编辑：正文切换为 textarea + 保存/取消；
  // 保存后直接改写 p.fix（lastProblems 里的对象引用），复制按钮与后续重渲染同步生效
  function openFixEditor(row, bodyEl, p, copyBtn, editBtn) {
    if (row.classList.contains('qc-fix-editing')) return;
    row.classList.add('qc-fix-editing');
    copyBtn.style.display = 'none';
    editBtn.style.display = 'none';

    const ta = document.createElement('textarea');
    ta.className = 'qc-fix-edit-ta';
    ta.value = p.fix || '';
    const bar = document.createElement('div');
    bar.className = 'qc-fix-edit-bar';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'qc-fix-edit-save';
    saveBtn.textContent = '💾 保存';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'qc-fix-edit-cancel';
    cancelBtn.textContent = '取消';
    bar.appendChild(saveBtn);
    bar.appendChild(cancelBtn);

    bodyEl.innerHTML = '';
    bodyEl.appendChild(ta);
    bodyEl.appendChild(bar);
    ta.focus();

    const close = () => {
      row.classList.remove('qc-fix-editing');
      copyBtn.style.display = '';
      editBtn.style.display = '';
      // 与卡片初始渲染一致：差异部分加粗展示
      bodyEl.innerHTML = diffBoldHtml(p.fix, p.locate);
    };
    saveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const v = ta.value.trim();
      if (v) p.fix = v;
      cmpSyncFixChange(); // 修改后文本 = 原文+修改方式 的合并产物，重算合并即同步
      close();
      showToast('✅ 修改方式已更新');
      qcTrack('优化规则编辑', { result: 'success', biz: p.qcBizLine || '', qp: (p.qcRefs && p.qcRefs[0]) || '' });
    });
    cancelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      close();
      qcTrack('优化规则编辑', { result: 'fail', reason: 'cancel', biz: p.qcBizLine || '', qp: (p.qcRefs && p.qcRefs[0]) || '' });
    });
  }

  function bindLocateButtons(root) {
    root.querySelectorAll('.qc-locate-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const card = btn.closest('.qc-card');
        const labelEl = card && card.querySelector('.qc-card-head .qc-card-title');
        const title = labelEl ? labelEl.textContent.trim() : '';
        const p = lastProblems.find(x => x.title === title);
        const biz = (p && p.qcBizLine) || '';
        const qp = (p && p.qcRefs && p.qcRefs[0]) || '';
        const enc = btn.getAttribute('data-locate');
        const t0 = Date.now();
        let located = false;
        if (enc) {
          try {
            // 仅定位到插件左侧对比区的「原文」textarea（选中+滚动+高亮），
            // 不再做页面高亮；对比区收起时自动展开让结果可见
            if (cmp.origTa && cmp.origTa.value && !compareOpen) setCompareOpen(true);
            located = locateInCompare(decodeURIComponent(enc), p);
          } catch (e) { /* 定位失败 */ }
        }
        qcTrack('原文定位', { result: located ? 'success' : 'fail', duration_ms: Date.now() - t0, biz, qp });
      });
    });
  }

  // 跳转到页面上对应的质检点：按卡片解析出的引用（G 编码优先、数字规则 ID 兜底）
  // 在页面文本中精确匹配（前后不能紧邻字母数字，避免 G17 命中 G178）。
  // 规则管理页：主路线是先把质检点打进左侧「搜索规则…」搜索框过滤树，再在过滤结果里
  // 点击对应业务线行展开定位（树折叠态直搜经常找不到，搜索过滤更可靠）；
  // 无搜索框（其它页面）才直接全页文本匹配。
  let qcJumpCleanup = null;
  async function jumpToQcPoint(refs, bizLine) {
    if (!refs || !refs.length) { showToast('⚠️ 该条目未解析出质检点信息'); return; }
    const qpCode = (parseQcCode(refs[0]) && parseQcCode(refs[0]).core) || refs[0];
    let found = false;
    const tree = document.querySelector('[class*="leftTree"]');
    const searchInput = document.querySelector('[class*="leftSearchWrap"] input:not([type="search"])') ||
      document.querySelector('input[placeholder*="搜索规则"]');
    if (tree && searchInput) {
      // 规则页：先搜索框过滤，再在结果里锁定业务线点击展开
      const searchFound = await searchAndExpandBizLine(tree, searchInput, refs, bizLine);
      if (searchFound) {
        qcTrack('定位质检点', { result: 'success', qp: qpCode, biz: bizLine || '' });
        return;
      }
    } else if (tree) {
      // 无搜索框：树内已展开部分直搜
      for (const ref of refs) {
        const el = findQcPointEl(ref, tree);
        if (el) { flashQcTarget(el, ref); qcTrack('定位质检点', { result: 'success', qp: qpCode, biz: bizLine || '' }); return; }
      }
    }
    // 通用页面（复核页差异表等）或规则页兜底
    for (const ref of refs) {
      const el = findQcPointEl(ref);
      if (el) { flashQcTarget(el, ref); qcTrack('定位质检点', { result: 'success', qp: qpCode, biz: bizLine || '' }); return; }
    }
    showToast('⚠️ 页面上未找到质检点：' + refs.join(' / '));
    qcTrack('定位质检点', { result: 'fail', qp: qpCode, biz: bizLine || '' });
  }

  // 滚动居中 + 高亮闪烁 + 点击目标（表格行/树内规则行尽量整行高亮）
  // 点击走最内层命中元素（事件冒泡到行组件的 onClick）：规则页点击条目打开中间面板规则详情
  function flashQcTarget(el, ref) {
    const target = el.closest('tr') || el.closest('[class*="ruleItem"]') || el.closest('[class*="ruleRow"]') || el;
    try { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { target.scrollIntoView(); }
    if (qcJumpCleanup) { qcJumpCleanup(); qcJumpCleanup = null; }
    target.classList.add('qc-jump-flash');
    qcJumpCleanup = () => target.classList.remove('qc-jump-flash');
    setTimeout(() => { if (qcJumpCleanup) { qcJumpCleanup(); qcJumpCleanup = null; } }, 3200);
    // 稍等滚动就位后点击；点击可能触发 React 重渲染，若目标行还在则补回高亮
    setTimeout(() => {
      try { el.click(); } catch (e) { try { target.click(); } catch (e2) { /* ignore */ } }
      try { if (target.isConnected && !target.classList.contains('qc-jump-flash')) target.classList.add('qc-jump-flash'); } catch (e) { /* ignore */ }
    }, 350);
    showToast('🎯 已定位并点击质检点 ' + ref);
  }

  // 规则页左侧树跳转主路线：① 先把质检点编码打进左侧「搜索规则…」搜索框过滤树，
  // 过滤后先试直接命中（部分页面搜索后会自动展开结果）；
  // ② 未命中再点击过滤结果里的业务线行展开定位——解析出业务线时只点那一行
  // （锁定，不逐个展开其它业务线），未解析出业务线才逐行兜底。
  // 定位成功后自动清空搜索框恢复全量树；失败路径也会清空，不停留在过滤态。
  async function searchAndExpandBizLine(tree, searchInput, refs, bizLine) {
    const clearSearch = () => { try { setInputValue(searchInput, ''); } catch (e) { /* ignore */ } };
    showToast('🔍 正在搜索质检点 ' + refs[0] + ' …');
    // React 受控输入框：原生 setter + input 事件同步框架状态
    setInputValue(searchInput, refs[0]);
    // ① 过滤后直接命中（搜索可能是防抖/异步的，轮询等待）
    let el = await waitForResult(() => findRefsInTree(tree, refs), 2500, 200);
    if (el) { finishFound(searchInput, el); return true; }
    // ② 点击过滤结果中的业务线行展开
    let rows = Array.from(tree.querySelectorAll('[class*="bizLineRow"]'));
    if (!rows.length) { clearSearch(); return false; }
    const nb = bizLine ? _norm(bizLine) : '';
    const matchScore = (rw) => {
      if (!nb) return 1;
      const nameEl = rw.querySelector('[class*="bizLineName"]');
      const n = _norm((nameEl && nameEl.textContent) || '');
      if (!n) return 0;
      if (n === nb) return 3;
      if (n.indexOf(nb) !== -1 || nb.indexOf(n) !== -1) return 2;
      return 0;
    };
    rows = rows
      .map(rw => ({ rw, s: matchScore(rw) }))
      .sort((a, b) => b.s - a.s)
      .map(x => x.rw);
    if (bizLine) showToast('🔍 正在展开业务线「' + bizLine + '」…');
    for (const row of rows) {
      // 锁定了业务线时只尝试命中的行，不再点开其它业务线
      if (nb && matchScore(row) < 2) continue;
      // 已展开的行（箭头朝下）搜索过滤阶段已覆盖，直接跳过
      if (!row.querySelector('.anticon-right')) continue;
      const clickEl = row.querySelector('[class*="bizLineLeft"]') || row;
      try { clickEl.click(); } catch (e) { /* ignore */ }
      // 等子规则渲染出来后在树内重搜（最长 2.5s）
      el = await waitForResult(() => findRefsInTree(tree, refs), 2500, 200);
      if (el) { finishFound(searchInput, el); return true; }
    }
    clearSearch();
    return false;
  }

  // 在树内查找质检点引用（命中返回 {hit, ref}）
  function findRefsInTree(tree, refs) {
    for (const ref of refs) {
      const hit = findQcPointEl(ref, tree);
      if (hit) return { hit, ref };
    }
    return null;
  }

  // 命中：闪烁高亮；等闪烁结束后清空搜索框恢复全量树
  // （延迟清空是避免过滤态提前解除导致目标行被 React 重渲染回收、高亮丢失）
  function finishFound(searchInput, el) {
    flashQcTarget(el.hit, el.ref);
    if (searchInput) {
      setTimeout(() => { try { setInputValue(searchInput, ''); } catch (e) { /* ignore */ } }, 3400);
    }
  }

  // React 受控输入框赋值：原生 setter + input 事件，确保框架状态同步
  function setInputValue(input, value) {
    const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    const setter = desc && desc.set;
    if (setter) setter.call(input, value); else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // 简易轮询等待：fn 返回真值即 resolve，超时返回 null
  function waitForResult(fn, timeout, interval) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        let v = null;
        try { v = fn(); } catch (e) { /* ignore */ }
        if (v) return resolve(v);
        if (Date.now() - t0 >= timeout) return resolve(null);
        setTimeout(tick, interval || 200);
      };
      tick();
    });
  }

  function findQcPointEl(ref, root) {
    // 质检点编码（G/E/C/CO/EO + 数字）→ 宽松正则：字母间允许空格/连字符、前导零可选、
    // 左边界不紧邻字母（防 ECO12 误摘 CO12）、右边界不紧跟数字（防 G17 命中 G170）
    const code = parseQcCode(ref);
    let re;
    if (code) {
      const letters = code.prefix.toUpperCase().split('').map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('\\s*[-—–]?\\s*');
      re = new RegExp('(?<![A-Za-z])' + letters + '\\s*[-—–]?\\s*0*' + code.digits + '(?![0-9])', 'i');
    } else {
      // 纯数字规则 ID 等非编码引用：沿用精确串匹配（前后不紧邻字母数字）
      const esc = String(ref).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      re = new RegExp('(?<![A-Za-z0-9])' + esc + '(?![A-Za-z0-9])');
    }
    const walker = document.createTreeWalker(root || document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const p = node.parentElement;
      if (!p) continue;
      if (p.closest('#qc-panel, #qc-float-btn, #qc-toast, script, style, textarea, input')) continue;
      // 规则页右侧聊天区（messagesArea/inputArea）里的提示词/回复也含 G 编码，不参与跳转匹配
      if (p.closest('[class*="messagesArea"], [class*="inputArea"]')) continue;
      if (re.test(node.nodeValue || '')) return p;
    }
    return null;
  }

  // ══════════════════════════════════════════
  // 6. 右侧停靠侧边栏（非模态，页面保持可见）
  // ══════════════════════════════════════════
  function showToast(msg) {
    let toast = document.getElementById('qc-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'qc-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.cssText = 'position:fixed;bottom:80px;right:160px;zIndex:100000;padding:10px 18px;' +
      'background:#333;color:#fff;border-radius:8px;font-family:' + FONT + ';font-size:13px;' +
      'boxShadow:0 4px 12px rgba(0,0,0,0.2);opacity:1;transition:opacity 0.3s;max-width:60vw';
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 2200);
  }

  function setPanelCollapsed(collapsed, collapseBtn) {
    panelCollapsed = collapsed;
    const panel = panelEl;
    if (!panel) return;
    const body = panel.querySelector('#qc-panel-body');
    const title = panel.querySelector('#qc-panel-title');
    const actions = panel.querySelector('#qc-panel-actions');
    const closeBtn = panel.querySelector('.qc-close-btn');
    const hint = panel.querySelector('#qc-panel-hint');
    const modeBar = panel.querySelector('#qc-mode-bar');
    const cmpWrap = panel.querySelector('#qc-compare-wrap');
    const cmpTab = panel.querySelector('#qc-compare-tab');
    if (collapsed) {
      panel.style.width = '56px';
      if (body) body.style.display = 'none';
      if (title) title.style.display = 'none';
      if (closeBtn) closeBtn.style.display = 'none';
      if (hint) hint.style.display = 'none';
      if (modeBar) modeBar.style.display = 'none';
      if (cmpWrap) cmpWrap.style.display = 'none'; // 收起侧栏时一并隐藏对比区（展开状态保留，展开侧栏后恢复）
      if (cmpTab) cmpTab.style.display = 'none';
      if (actions) actions.style.display = 'flex';
      if (collapseBtn) {
        collapseBtn.style.display = 'block';
        collapseBtn.style.margin = '2px auto';
        collapseBtn.textContent = '◀';
        collapseBtn.title = '展开侧栏';
      }
    } else {
      panel.style.width = panel._w || 'min(560px, 72vw)';
      if (body) body.style.display = 'block';
      if (title) title.style.display = '';
      if (closeBtn) closeBtn.style.display = '';
      if (hint) hint.style.display = '';
      if (modeBar) modeBar.style.display = 'flex';
      if (cmpWrap) cmpWrap.style.display = compareOpen ? 'flex' : 'none';
      if (cmpTab) cmpTab.style.display = '';
      if (actions) actions.style.display = 'flex';
      if (collapseBtn) {
        collapseBtn.style.margin = '';
        collapseBtn.textContent = '▶';
        collapseBtn.title = '收起/展开';
      }
    }
  }

  // 模式 A：顶部 Agent 对话输入 + 下方问题卡片列表
  // 卡片挂在独立容器 #qc-card-list 上，供「修改后 textarea 编辑同步」局部刷新（不重建对话框）
  function renderExtractBody(body) {
    body.innerHTML = '';
    body.appendChild(buildChatBox());
    const list = document.createElement('div');
    list.id = 'qc-card-list';
    body.appendChild(list);
    renderCardsInto(list);
  }

  function renderCardsInto(list) {
    list.innerHTML = '';
    const problems = lastProblems;
    if (problems.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:#888;text-align:center;padding:30px 20px;font-size:14px';
      empty.textContent = chatStatus
        ? '' // 对话进行中/刚完成时不再显示占位提示
        : '未解析到问题条目，请在上方输入提示词，或确认当前页面包含「### 第 N 条」的质检结果。';
      if (empty.textContent) list.appendChild(empty);
    } else {
      problems.forEach((p, i) => list.appendChild(buildCard(p, i)));
      bindLocateButtons(list);
    }
  }

  // 仅刷新卡片列表（对比区编辑同步用）：不动对话框/状态条，避免抢焦点
  function rerenderCardsOnly() {
    if (!panelEl) return;
    const list = panelEl.querySelector('#qc-card-list');
    if (list) renderCardsInto(list);
  }

  // ── 模式分派：A 对话优化 / C 评测集生成 ──
  function renderBody(_bodyEl) {
    _bodyEl.innerHTML = '';
    if (panelMode === 'C') renderEvalsetBody(_bodyEl);
    else renderExtractBody(_bodyEl);
  }
  function switchPanelMode(name) {
    if (panelMode === name) return;
    const from = panelMode;
    panelMode = name;
    const modeBar = panelEl && panelEl.querySelector('#qc-mode-bar');
    if (modeBar) {
      const tabs = modeBar.querySelectorAll('.qc-mode-tab');
      tabs[0].classList.toggle('active', name === 'A');
      tabs[1].classList.toggle('active', name === 'C');
    }
    const bodyEl = panelEl && panelEl.querySelector('#qc-panel-body');
    if (bodyEl) renderBody(bodyEl);
  }

  // ── 模式 C：评测集生成 ──
  function renderEvalsetBody(body) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:12px';

    const head = document.createElement('div');
    head.style.cssText = 'font-weight:700;font-size:14.5px;color:#1a73e8';
    head.textContent = '🎯 评测集生成';
    wrap.appendChild(head);

    const tip = document.createElement('div');
    tip.style.cssText = 'color:#888;font-size:12px;line-height:1.7';
    tip.textContent = '输入一个或多个「复核任务 ID」（逗号/空格分隔）。自动抓取评分、服务记录与质检点并生成评测集 Excel。要求所有任务渠道一致；邮件渠道会额外拼装 recore_detail。';
    wrap.appendChild(tip);

    const ta = document.createElement('textarea');
    ta.placeholder = 'task id，多个用逗号或空格分隔';
    ta.value = evalsetForm.taskIds;
    ta.rows = 3;
    ta.style.cssText = 'width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #d0d7e2;border-radius:8px;font-size:13px;font-family:' + FONT + ';resize:vertical;background:#fff';
    wrap.appendChild(ta);

    const btn = document.createElement('button');
    btn.textContent = '生成评测集';
    btn.style.cssText = 'background:linear-gradient(135deg,#1a73e8,#1557b0);color:#fff;border:none;padding:9px 18px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;align-self:flex-start';
    wrap.appendChild(btn);

    const status = document.createElement('div');
    status.style.cssText = 'font-size:12.5px;line-height:1.6;color:#5f6368;word-break:break-all';
    wrap.appendChild(status);

    const result = document.createElement('div');
    result.style.cssText = 'margin-top:4px;display:flex;flex-direction:column;gap:8px';
    wrap.appendChild(result);

    body.appendChild(wrap);

    btn.addEventListener('click', async () => {
      const ids = (ta.value || '').trim();
      evalsetForm.taskIds = ids;
      if (!ids) { status.style.color = '#c5221f'; status.textContent = '请先输入任务 ID'; return; }
      btn.disabled = true;
      btn.style.opacity = '0.6';
      status.style.color = '#1a73e8';
      status.textContent = '正在抓取并生成评测集，请保持质检平台页面标签页打开…';
      result.innerHTML = '';
      try {
        const resp = await chrome.runtime.sendMessage({ type: 'qc-evalset', taskIds: ids });
        renderEvalsetResult(resp, result, status);
        // ✅ 评测集生成成功埋点
        qcTrack('评测集生成', { result: 'success', task_count: ids.split(/[,，;\s]+/).filter(Boolean).length });
      } catch (e) {
        status.style.color = '#c5221f';
        status.textContent = '发生异常：' + (e && e.message || e);
        // ✅ 评测集生成失败埋点
        qcTrack('评测集生成', { result: 'fail', task_count: ids.split(/[,，;\s]+/).filter(Boolean).length, error: String(e && e.message || e) });
      } finally {
        btn.disabled = false;
        btn.style.opacity = '1';
      }
    });
  }

  function renderEvalsetResult(resp, container, status) {
    if (!resp || !resp.ok) {
      status.style.color = '#c5221f';
      status.textContent = '生成失败：' + ((resp && resp.error) || '未知错误');
      if (resp && resp.detail) {
        const d = document.createElement('div');
        d.style.cssText = 'font-size:12px;color:#b26a00;line-height:1.6';
        d.textContent = resp.detail;
        container.appendChild(d);
      }
      return;
    }
    const hasFailed = resp.failed && resp.failed.length;
    status.style.color = hasFailed ? '#b26a00' : '#188038';
    status.textContent = '生成成功:共 ' + resp.rowCount + ' 行 · 渠道「' + resp.channel + '」 · ' +
      resp.qpCodes.length + ' 个质检点' + (hasFailed ? ' · 失败任务: ' + resp.failed.join(', ') : '');

    const dl = document.createElement('a');
    dl.textContent = '⬇ 下载 ' + resp.fileName;
    dl.style.cssText = 'display:inline-block;background:#34a853;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer';
    dl.addEventListener('click', () => {
      const bin = atob(resp.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = resp.fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    });
    container.appendChild(dl);

    if (hasFailed) {
      const f = document.createElement('div');
      f.style.cssText = 'font-size:12px;color:#b26a00;line-height:1.6';
      f.textContent = '以下任务未取到评分数据，已跳过：' + resp.failed.join(', ');
      container.appendChild(f);
    }
    const codes = document.createElement('div');
    codes.style.cssText = 'font-size:12px;color:#5f6368;line-height:1.7;word-break:break-all';
    codes.textContent = '质检点列：' + resp.qpCodes.join(', ');
    container.appendChild(codes);
  }

  // ── 模式 A：Agent 对话输入（置顶）──
  // 三个输入项：业务线（必填）/ 质检点（必填）/ task id（复核 id，选填，支持多个）。
  // 两条链路（都走 qc-rca-agent 通道，每次发送自动清空会话）：
  //   ① 无 task id → 发「帮我优化 {业务线} {质检点}」→ Agent 输出结束后格式化成卡片；
  //   ② 有 task id → 先发 RCA 提示词（带 task id）→ 读取回复气泡中的 RCA 分析并展示在插件中（确认态：
  //      只读正文 + 60 秒倒计时 + 「编辑」/「直接发送」；编辑态提供「保存」/「取消」，保存后回到确认态）→
  //      点「直接发送」或 60 秒无操作自动发送 → 自动清会话后发「帮我优化keyword：{业务线} / rule_code：{质检点} /
  //      RCA分析：{RCA}」→ 输出结束后格式化成卡片。
  function buildChatBox() {
    const box = document.createElement('div');
    box.className = 'qc-chat-box';
  
    const head = document.createElement('div');
    head.className = 'qc-chat-head';
    head.textContent = '💬 与质检规则 Agent 对话';
    box.appendChild(head);
  
    const mkLabel = (text) => {
      const lb = document.createElement('span');
      lb.style.cssText = 'display:block;font-size:12px;color:#555;margin-bottom:2px';
      lb.textContent = text;
      return lb;
    };
    const mkInput = (placeholder) => {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.placeholder = placeholder;
      inp.style.cssText = 'width:100%;padding:6px 8px;border:1px solid #d0d7e2;border-radius:6px;' +
        'font-size:12px;font-family:' + FONT + ';box-sizing:border-box';
      return inp;
    };
    // 每行：标签在上、控件占满整行宽度（所有行控件右边缘天然对齐）
    const mkRow = (labelText, inp) => {
      const rw = document.createElement('div');
      rw.style.cssText = 'margin-bottom:8px';
      rw.appendChild(mkLabel(labelText));
      rw.appendChild(inp);
      return rw;
    };
  
    // 业务线固定下拉（必填）：首项为占位项，未选时提交走原有必填校验；
    // 若回显值不在列表内（历史已填），动态补一项避免丢已选内容
    const BIZ_OPTIONS = ['Antom AGH-天猫飞猪', 'Antom AGH-AB', 'Bettr HK', 'CN EC', 'CN Trade',
      'GBA', 'WF EMEA', 'WFANZ', 'WFLT', 'WFSEA'];
    const bizInput = document.createElement('select');
    bizInput.style.cssText = 'width:100%;padding:6px 8px;border:1px solid #d0d7e2;border-radius:6px;' +
      'font-size:12px;font-family:' + FONT + ';box-sizing:border-box;background:#fff;cursor:pointer';
    const phOpt = document.createElement('option');
    phOpt.value = '';
    phOpt.textContent = '请选择业务线';
    bizInput.appendChild(phOpt);
    BIZ_OPTIONS.forEach((name) => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      bizInput.appendChild(opt);
    });
    if (chatForm.biz && !BIZ_OPTIONS.includes(chatForm.biz)) {
      const extra = document.createElement('option');
      extra.value = chatForm.biz;
      extra.textContent = chatForm.biz;
      bizInput.appendChild(extra);
    }
    bizInput.value = chatForm.biz || '';
    const qpInput = mkInput('质检点（必填，如 G21）');
    qpInput.value = chatForm.qp;
    // 优化类型下拉（二选一，默认 Task ID）：Task ID 走 RCA 链路，优化方向走直发链路附加一行
    const modeSelect = document.createElement('select');
    modeSelect.style.cssText = 'width:100%;padding:6px 8px;border:1px solid #d0d7e2;border-radius:6px;' +
      'font-size:12px;font-family:' + FONT + ';box-sizing:border-box;background:#fff;cursor:pointer';
    [['tasks', 'Task ID（复核差异分析 → RCA 链路）'], ['dir', '优化方向（直接描述优化诉求）']].forEach((it) => {
      const opt = document.createElement('option');
      opt.value = it[0];
      opt.textContent = it[1];
      modeSelect.appendChild(opt);
    });
    modeSelect.value = chatForm.mode === 'dir' ? 'dir' : 'tasks';

    // 规则版本单选（二选一，默认发布版本）：草稿版 → 发送时质检点后写「草稿版」；发布版本 → 写「正式版」
    const verRow = document.createElement('div');
    verRow.style.cssText = 'margin-bottom:8px';
    const verLabel = mkLabel('规则版本');
    verRow.appendChild(verLabel);
    const verChoices = document.createElement('div');
    verChoices.style.cssText = 'display:flex;gap:16px;align-items:center;padding:4px 2px';
    [['release', '发布版本'], ['draft', '草稿版']].forEach((it) => {
      const wrap = document.createElement('label');
      wrap.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:12px;color:#333;cursor:pointer;font-family:' + FONT;
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'qc-rule-version';
      radio.value = it[0];
      radio.checked = (chatForm.ver || 'release') === it[0];
      radio.addEventListener('change', () => { if (radio.checked) chatForm.ver = it[0]; });
      const txt = document.createElement('span');
      txt.textContent = it[1];
      wrap.appendChild(radio);
      wrap.appendChild(txt);
      verChoices.appendChild(wrap);
    });
    verRow.appendChild(verChoices);

    // Task ID 与优化方向统一为 textarea（rows=1 起始高度与单行输入框一致，行距统一；可向下拖拽变高）
    const taskInput = document.createElement('textarea');
    taskInput.placeholder = 'task id / 复核 id，可多个（逗号/空格分隔，选填）';
    taskInput.value = chatForm.tasks;
    taskInput.rows = 1;
    taskInput.style.cssText = 'width:100%;padding:6px 8px;border:1px solid #d0d7e2;border-radius:6px;' +
      'font-size:12px;font-family:' + FONT + ';box-sizing:border-box;resize:vertical;max-height:160px;display:block';
    const dirInput = document.createElement('textarea');
    dirInput.placeholder = '优化方向，如：强化「实质性回应」判定逻辑';
    dirInput.value = chatForm.dir;
    dirInput.rows = 1;
    dirInput.style.cssText = 'width:100%;padding:6px 8px;border:1px solid #d0d7e2;border-radius:6px;' +
      'font-size:12px;font-family:' + FONT + ';box-sizing:border-box;resize:vertical;max-height:160px;display:block';

    // 下拉切换时只显示对应输入行（两项内容分别保留在 chatForm，切换不丢已填内容）
    const taskRow = mkRow('Task ID', taskInput);
    const dirRow = mkRow('优化方向', dirInput);
    const applyMode = () => {
      const isTask = modeSelect.value === 'tasks';
      taskRow.style.display = isTask ? '' : 'none';
      dirRow.style.display = isTask ? 'none' : '';
    };
    modeSelect.addEventListener('change', applyMode);
    applyMode();

    box.appendChild(mkRow('业务线 *', bizInput));
    box.appendChild(mkRow('质检点 *', qpInput));
    box.appendChild(verRow);
    box.appendChild(mkRow('优化类型', modeSelect));
    box.appendChild(taskRow);
    box.appendChild(dirRow);
  
    const sendRow = document.createElement('div');
    sendRow.className = 'qc-chat-row';
    const send = document.createElement('button');
    send.className = 'qc-chat-send';
    send.textContent = '发送';
    sendRow.appendChild(send);
    box.appendChild(sendRow);
  
    const statusRow = document.createElement('div');
    statusRow.style.cssText = 'display:flex;align-items:flex-start;gap:8px';
    const status = document.createElement('div');
    status.className = 'qc-chat-status ' + chatStatusCls;
    status.style.cssText = 'flex:1;min-width:0';
    status.textContent = chatStatus || '';
    if (!chatStatus) status.style.display = 'none';
    statusRow.appendChild(status);
    // 重载格式：Agent 输出可能没加载全导致格式化不完整，点此重新从页面提取并格式化
    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'qc-chat-refresh';
    refreshBtn.textContent = '🔄 重载格式';
    refreshBtn.title = '重新从页面提取「## 优化结果」并格式化（Agent 输出未加载全、格式不完整时点此重试）';
    refreshBtn.style.cssText = 'flex-shrink:0;margin-top:8px;padding:3px 10px;font-size:12px;color:#1a73e8;' +
      'background:#fff;border:1px solid #c7d7f5;border-radius:6px;cursor:pointer;font-family:' + FONT;
    // 注意：必须显式传 false。若直接传 refreshFormat，点击事件对象会被当成 silent=true，
    // 导致失败时静默（不弹 toast、不更新状态条）、成功时误显示「自动重新加载格式」，
    // 在预发环境（点击停止后页面气泡可能未渲染完整「## 优化结果」）下表现为「按钮点了没反应」。
    refreshBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const res = refreshFormat(false);
      if (res === 'success') {
        qcTrack('重载格式按钮', { result: 'success', biz: chatForm.biz, qp: chatForm.qp, problems_count: lastProblems.length });
      } else {
        qcTrack('重载格式按钮', { result: 'fail', biz: chatForm.biz, qp: chatForm.qp, reason: res });
      }
    });
    statusRow.appendChild(refreshBtn);
    box.appendChild(statusRow);
  
    // RCA 分析展示区（仅 task id 链路生成；重渲染时从 lastRcaText 回显，
    // 确认期内恢复为可编辑态并继续倒计时）
    const rcaBox = document.createElement('div');
    rcaBox.className = 'qc-rca-box';
    const inReview = rcaAwaitingReview && Date.now() < rcaReviewDeadline;
    if (lastRcaText) {
      renderRcaBox(rcaBox, lastRcaText, inReview ? 'confirm' : 'plain');
      if (inReview) startRcaReviewCountdown();
    } else rcaBox.style.display = 'none';
    box.appendChild(rcaBox);
  
    const submit = async () => {
      const biz = bizInput.value.trim();
      const qp = qpInput.value.trim();
      // 优化类型下拉二选一：仅当前模式的输入生效（默认 Task ID），另一项不参与发送
      const mode = modeSelect.value === 'dir' ? 'dir' : 'tasks';
      const ver = chatForm.ver === 'draft' ? 'draft' : 'release';
      // 规则版本标记：草稿版 → 「（草稿版）」，发布版本 → 「（正式版）」，追加在质检点取值之后
      const verTag = ver === 'draft' ? '（草稿版）' : '（正式版）';
      const tasksRaw = mode === 'tasks' ? taskInput.value.trim() : '';
      const dir = mode === 'dir' ? dirInput.value.trim() : '';
      chatForm = { biz, qp, tasks: tasksRaw, dir, mode, ver }; // 回显持久化，重渲染不丢已填内容
      if (!biz || !qp) { setChatStatus('⚠️ 业务线与质检点为必填项', 'warn'); return; }
      if (send.disabled) return;
      const tasks = parseTaskIds(tasksRaw);
      // 新一轮开始：先清掉上一轮旧数据（格式化卡片 + RCA 残留），再重渲染，
      // 避免新旧两轮结果混在同一面板里（须在重渲染前清，否则刚重建的对话框会被丢弃）

      // ── 记录当前链路类型（用于后续根据实际结果触发埋点）──
      let trackEvent = '';
      let trackParams = { biz, qp };
      if (tasks.length) {
        trackEvent = 'Task ID优化模式';
        trackParams.task_count = tasks.length;
      } else if (mode === 'dir' && dir && dir.length > 0) {
        trackEvent = '指定优化方向模式';
        trackParams.dir_length = dir.length;
      } else {
        trackEvent = '逻辑自检优化模式';
      }

      lastProblems = [];
      lastExtracted = '';
      lastRcaText = '';
      rcaReviewDeadline = 0;
      cmpResetContent(); // 新一轮开始：清空对比区（上一轮原文/修改后不串场）
      // 取消上一轮遗留的自动刷新定时器，避免新一轮等待期间拿旧内容重渲染
      if (autoRefreshTimer) { clearTimeout(autoRefreshTimer); autoRefreshTimer = null; }
      // 先停计时器再清标志，避免旧倒计时 tick 在间隙里误触发上一轮的自动发送
      stopRcaReviewCountdown();
      rcaAwaitingReview = false;
      rerenderExtractBody();
      const newBox = panelEl && panelEl.querySelector('.qc-chat-box');
      const newSend = newBox && newBox.querySelector('.qc-chat-send');
      const newRca = newBox && newBox.querySelector('.qc-rca-box');
      if (newRca) { newRca.style.display = 'none'; newRca.innerHTML = ''; }
      send.disabled = true;
      send.textContent = '⏳';
      if (newSend && newSend !== send) { newSend.disabled = true; newSend.textContent = '⏳'; }
      try {
        let rcaText = '';
        if (tasks.length) {
          // 链路②第一步：生成 RCA（后台自动清会话后发送，返回的即气泡中的 RCA 分析）
          setChatStatus('⏳ ① 正在生成 RCA 分析（' + tasks.length + ' 个 task id）…', 'info');
          const rcaPrompt = '请对以下复核任务进行根因分析（RCA）。\n业务线：' + biz +
            '\n质检点：' + qp + verTag + '\ntask id（复核 id）：' + tasks.join('、');
          rcaText = await sendAgentPrompt(rcaPrompt, { newSession: true });
          lastRcaText = rcaText;
          // 进入确认态：只读展示 + 60 秒倒计时，可点「编辑」修改（保存/取消），
          // 也可点「直接发送」立即发送；60 秒无任何操作则自动直接发送
          rcaAwaitingReview = true;
          rcaReviewDeadline = Date.now() + 120000;
          const boxNow = panelEl && panelEl.querySelector('.qc-rca-box');
          if (boxNow) renderRcaBox(boxNow, rcaText, 'confirm');
          setChatStatus('⏳ ② RCA 已生成（120 秒后自动发送）：可点「编辑」修改并保存，或点「直接发送」', 'info');
          startRcaReviewCountdown();
          // ✅ 提交成功埋点
          qcTrack(trackEvent, Object.assign({ result: 'success' }, trackParams));
          // 后续优化发送由 sendOptimizeWithRca 驱动（按钮/倒计时触发），本轮 submit 到此结束
          return;
        }
        // 无 task id 链路：直接发优化提示词并格式化（旧 RCA 残留已在上面统一清除）
        // 填了优化方向时追加独立一行「优化方向：…」
        const optPrompt = '帮我优化\n业务线（keyword）： ' + biz + '\n质检点（rule_code）： ' + qp + verTag +
          (dir ? '\n优化方向：' + dir : '');
        setChatStatus('⏳ 已发送，等待 Agent 输出结束…', 'info');
        const reply = await sendAgentPrompt(optPrompt, { newSession: true });
        formatAgentReply(reply, optPrompt);
        // ✅ 提交成功埋点
        qcTrack(trackEvent, Object.assign({ result: 'success' }, trackParams));
      } catch (err) {
        setChatStatus('❌ ' + String(err && err.message || err), 'err');
        // ✅ 提交失败埋点
        qcTrack(trackEvent, Object.assign({ result: 'fail' }, trackParams));
      } finally {
        // 重渲染后旧 send 按钮可能已不在 DOM，优先恢复新面板上的按钮
        const btnNow = (panelEl && panelEl.querySelector('.qc-chat-send')) || send;
        btnNow.disabled = false;
        btnNow.textContent = '发送';
      }
    };
    send.addEventListener('click', submit);
    // Task ID 与优化方向均为 textarea：回车换行不提交；业务线为下拉，不绑定；故仅质检点保留回车提交
    [qpInput].forEach((inp) => {
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    });
  
    return box;
  }
  
  // 发送提示词给 Agent：qc-rca-agent 通道（输入→发送→等输出结束），返回回复全文；失败抛错。
  // newSession=true（含缺省）：发送前新建会话（预发/正式均清会话后再发），避免上一轮
  // 流式输出未收尾导致页面渲染崩溃（TypeError: reading 'content'）。
  // newSession=false：仅历史兼容，当前已无调用方使用（预发 RCA 直发也改为新建会话）。
  function sendAgentPrompt(prompt, opts) {
    // 环境防御：内容脚本在正规 MV3 注入下必有 chrome.runtime。若执行上下文拿不到
    // （如 script 以非内容脚本方式运行/被塞进无扩展 API 的 sandbox iframe），
    // 直接把 Chrome 的原生报错转换成可定位的中文诊断，并暴露当前真实运行环境。
    const rt = (typeof chrome !== 'undefined') ? chrome.runtime : undefined;
    if (!rt || typeof rt.sendMessage !== 'function') {
      let inFrame = 'unknown';
      try { inFrame = window.self !== window.top ? 'yes' : 'no'; } catch (e) { /* 跨域 iframe 访问 top 会抛错 */ }
      throw new Error(
        '插件运行环境异常：当前上下文拿不到 chrome.runtime，未以正规内容脚本运行。' +
        '环境诊断=' + JSON.stringify({
          href: location.href,
          typeofChrome: typeof chrome,
          hasChromeRuntime: !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage),
          inIframe: inFrame
        })
      );
    }
    return rt.sendMessage({
      type: 'qc-rca-agent', prompt, newSession: !(opts && opts.newSession === false)
    }).then((resp) => {
      const reply = (resp && resp.ok) ? String(resp.text || '').trim() : '';
      if (!reply) throw new Error(String((resp && resp.error) || 'Agent 未返回内容'));
      return reply;
    });
  }
  
  // task id 解析：支持多个（逗号/分号/空格分隔），去重保序
  function parseTaskIds(raw) {
    return String(raw || '').split(/[,，;；\s]+/).map(s => s.trim()).filter(Boolean)
      .filter((v, i, arr) => arr.indexOf(v) === i);
  }
  
  // RCA 分析展示区渲染。mode：
  //   'confirm' 确认态：只读正文 + 倒计时展示 + 「编辑」/「直接发送」按钮；
  //   'edit'    编辑态：textarea + 「保存」/「取消」按钮（保存更新 RCA，取消丢弃编辑回到确认态）；
  //   'plain'   只读展示（标题 + 一键复制 + 正文，发送完成后用）
  function renderRcaBox(container, text, mode) {
    container.style.display = '';
    container.style.marginTop = '8px';
    container.innerHTML = '';

    // 编辑态先建 textarea（保存以它的实时内容为准）
    let ta = null;
    if (mode === 'edit') {
      ta = document.createElement('textarea');
      ta.className = 'qc-rca-edit';
      ta.value = text;
      ta.style.cssText = 'width:100%;min-height:120px;max-height:260px;box-sizing:border-box;padding:8px;' +
        'border:1px solid #d0d7e2;border-radius:6px;font-size:12px;line-height:1.6;resize:vertical;' +
        'font-family:' + FONT;
    }

    // 标题行：标题 + 倒计时（确认/编辑态醒目展示） + 一键复制
    const hd = document.createElement('div');
    hd.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:4px';
    const left = document.createElement('span');
    left.style.cssText = 'display:flex;align-items:center;gap:8px;min-width:0';
    const ttl = document.createElement('span');
    ttl.style.cssText = 'font-size:12px;font-weight:600;color:#555';
    ttl.textContent = '📝 RCA 分析（' + text.length + ' 字' + (mode === 'edit' ? '，编辑中' : '') + '）';
    left.appendChild(ttl);
    if (mode !== 'plain') {
      const cd = document.createElement('span');
      cd.className = 'qc-rca-countdown';
      cd.style.cssText = 'font-size:12px;font-weight:700;color:#e37400;white-space:nowrap';
      cd.textContent = '⏱ ' + Math.max(0, Math.ceil((rcaReviewDeadline - Date.now()) / 1000)) + 's';
      left.appendChild(cd);
    }
    hd.appendChild(left);
    const copyBtn = document.createElement('button');
    copyBtn.className = 'qc-rca-copy';
    copyBtn.textContent = '一键复制';
    copyBtn.addEventListener('click', () => {
      const content = ta ? ta.value : text;
      navigator.clipboard.writeText(content).then(() => {
        copyBtn.textContent = '✅ 已复制';
        setTimeout(() => { copyBtn.textContent = '一键复制'; }, 1500);
      });
    });
    hd.appendChild(copyBtn);
    container.appendChild(hd);

    // 正文：编辑态为 textarea，其余为只读 pre
    if (ta) {
      container.appendChild(ta);
    } else {
      const pre = document.createElement('pre');
      pre.className = 'qc-rca-output';
      pre.style.maxHeight = '160px';
      pre.style.overflow = 'auto';
      pre.textContent = text;
      container.appendChild(pre);
    }
    if (mode === 'plain') return;

    // 按钮行：确认态 → 编辑/直接发送；编辑态 → 保存/取消
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;margin-top:8px';
    const mkBtn = (label, title, primary, onClick) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.style.cssText = 'flex:1;padding:8px 12px;border-radius:8px;font-size:12.5px;cursor:pointer;' +
        (primary
          ? 'background:linear-gradient(135deg,#1a73e8,#1557b0);color:#fff;border:none'
          : 'background:#fff;color:#1a73e8;border:1px solid #1a73e8');
      b.addEventListener('click', onClick);
      return b;
    };
    if (mode === 'edit') {
      btnRow.appendChild(mkBtn('💾 保存', '保存编辑内容并回到确认态', true, () => {
        const v = ta.value.trim();
        if (v) lastRcaText = v; // 空内容不覆盖，保留上一版
        renderRcaBox(container, lastRcaText, 'confirm');
        qcTrack('RCA编辑按钮-点击保存', { result: 'success', biz: chatForm.biz, qp: chatForm.qp });
      }));
      btnRow.appendChild(mkBtn('✖ 取消', '丢弃本次编辑，回到确认态', false, () => {
        renderRcaBox(container, lastRcaText, 'confirm');
      }));
    } else {
      btnRow.appendChild(mkBtn('✏️ 编辑', '修改 RCA 内容（保存后生效）', false, () => {
        renderRcaBox(container, lastRcaText, 'edit');
        qcTrack('RCA编辑按钮-点击编辑', { result: 'success', biz: chatForm.biz, qp: chatForm.qp });
      }));
      btnRow.appendChild(mkBtn('🚀 直接发送', '以当前 RCA 立即发送优化请求', true, () => {
        sendOptimizeWithRca('manual');
      }));
    }
    container.appendChild(btnRow);
  }

  // RCA 确认倒计时：每秒刷新 RCA 区内倒计时展示与状态提示，
  // 60 秒无任何操作 → 自动「直接发送」（以当前已保存的 RCA）。重复调用安全（先清旧定时器）
  let rcaCountdownTimer = null;
  function startRcaReviewCountdown() {
    stopRcaReviewCountdown();
    rcaCountdownTimer = setInterval(() => {
      if (!rcaAwaitingReview) { stopRcaReviewCountdown(); return; }
      const remain = Math.max(0, Math.ceil((rcaReviewDeadline - Date.now()) / 1000));
      const cdEl = panelEl && panelEl.querySelector('.qc-rca-countdown');
      if (cdEl) cdEl.textContent = '⏱ ' + remain + 's';
      if (remain <= 0) {
        sendOptimizeWithRca('auto'); // 倒计时结束：自动直接发送
        return;
      }
      setChatStatus('⏳ ② RCA 已生成，' + remain + ' 秒后自动发送：可点「编辑」修改并保存，或点「直接发送」', 'info');
    }, 1000);
  }
  function stopRcaReviewCountdown() {
    if (rcaCountdownTimer) { clearInterval(rcaCountdownTimer); rcaCountdownTimer = null; }
  }

  // 确认态发送优化请求（「直接发送」按钮/60 秒倒计时到期共用），
  // 以当前已保存的 RCA（lastRcaText）为准。
  // 注：本轮「直接发送」不清会话（newSession=false）——RCA 生成轮可能刚结束流式输出，
  // handleDrive → waitForReady 已点停止并等输入框恢复，直接在当前会话模拟人工粘贴发送即可；
  // 此处再清会话会触发删除/新建会话操作叠加 React 渲染，易引发页面崩溃。
  function sendOptimizeWithRca(triggerMode) {
    if (!rcaAwaitingReview) return; // 防重复触发（按钮 + 倒计时竞争）
    rcaAwaitingReview = false;
    stopRcaReviewCountdown();
    const rcaFinal = String(lastRcaText || '').trim();
    const biz = chatForm.biz, qp = chatForm.qp;
    const verTag = chatForm.ver === 'draft' ? '（草稿版）' : '（正式版）'; // 规则版本标记（与 submit 提交时一致）
    const dir = String(chatForm.dir || '').trim(); // 优化方向（选填）
    (async () => {
      const sendBtn = panelEl && panelEl.querySelector('.qc-chat-send');
      if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = '⏳'; }
      try {
        // RCA 区切回只读展示（去掉倒计时与按钮，以最终发送的内容为准）
        const rcaBoxEl = panelEl && panelEl.querySelector('.qc-rca-box');
        if (rcaBoxEl && rcaFinal) renderRcaBox(rcaBoxEl, rcaFinal, 'plain');
        const optPrompt = '帮我优化质检点\n业务线（keyword）：' + biz + '\n质检点（rule_code）：' + qp + verTag +
          (dir ? '\n优化方向：' + dir : '') +
          (rcaFinal ? '\n' + rcaFinal : '');
        setChatStatus('⏳ ③ 已发送，等待 Agent 输出结束…', 'info');
        const reply = await sendAgentPrompt(optPrompt, { newSession: false });
        formatAgentReply(reply, optPrompt);
        // ✅ 直接发送成功埋点
        qcTrack('RCA直接发送', { result: 'success', biz: biz, qp: qp, trigger: triggerMode || 'unknown' });
      } catch (err) {
        setChatStatus('❌ ' + String(err && err.message || err), 'err');
        // ✅ 直接发送失败埋点
        qcTrack('RCA直接发送', { result: 'fail', biz: biz, qp: qp, trigger: triggerMode || 'unknown' });
      } finally {
        if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = '发送'; }
      }
    })();
  }
  
  // Agent 输出结束 → 自动执行格式化。
  // 改用 extractResult() 从页面 DOM 提取（与 refreshFormat 一致），比直接解析 Agent 回复文本更可靠。
  // promptCtx = 本轮发送的优化提示词（含业务线+质检点）→ 质检点/业务线识别的权威来源。
  function formatAgentReply(reply, promptCtx, skipTrack = false) {
    // 优先走页面提取路径（与 refreshFormat 完全一致）
    const result = extractResult();
    if (result) {
      const problems = structureProblems(result, promptCtx);
      if (problems.length) {
        lastExtracted = result;
        lastProblems = problems;
        setChatStatus('✅ 格式化完成', 'ok');
        rerenderExtractBody();
        scheduleAutoRefresh();
        if (!skipTrack) {
          qcTrack('格式化', { result: 'success', reply_len: reply ? reply.length : 0, problems_count: problems.length });
        }
        return true;
      }
    }

    // 页面提取失败，退化到 Agent 回复文本解析
    const scrubbed = (reply || '')
      .replace(/[​‌‍﻿­]/g, '')
      .replace(/＃/g, '#')
      .replace(/[0-9]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      .replace(/\*\*([^*\n]+)\*\*/g, '$1')
      .replace(/(?<=[一-龥])[ \t]+(?=[一-龥])/g, '');
    const norm = normalizeExtractText(scrubbed);
    const markerIdx = firstMarkerIndex(norm);
    const refined = markerIdx >= 0 ? sliceResultText(norm.slice(markerIdx), 60) : null;
    let problems = refined ? structureProblems(refined, promptCtx) : [];
    if (!problems.length) problems = structureProblems(norm, promptCtx);

    if (problems.length) {
      lastExtracted = refined || norm;
      lastProblems = problems;
      setChatStatus('✅ 格式化完成', 'ok');
      rerenderExtractBody();
      scheduleAutoRefresh();
      if (!skipTrack) {
        qcTrack('格式化', { result: 'success', reply_len: reply ? reply.length : 0, problems_count: problems.length });
      }
      return true;
    }

    // 格式化失败诊断
    const hasMarker = MARKER_PATTERN.test(norm);
    const hasTitles = /#{1,6}\s*第\s*\d+\s*条/.test(norm);
    const previewStart = markerIdx >= 0 ? markerIdx : 0;
    console.warn('[QC 提取器] 对话回复格式化失败 | 长度:' + (reply ? reply.length : 0) +
      ' | 含「## 优化结果」:' + hasMarker + ' | 含「第 N 条」:' + hasTitles +
      ' | 标记后正文预览:', norm.slice(previewStart, previewStart + 500));

    if (!skipTrack) {
      qcTrack('格式化', { result: 'fail', reply_len: reply ? reply.length : 0, error_code: hasMarker ? 'no-titles' : 'no-marker' });
    }
    setChatStatus('⚠️ 无法格式化（回复 ' + (reply ? reply.length : 0) + ' 字' +
      (hasMarker ? '' : '，未见「## 优化结果」标记') +
      (hasTitles ? '' : '，未见「### 第 N 条」条目') + '），详情见控制台', 'warn');
    return false;
  }
  
  function setChatStatus(text, cls) {
    chatStatus = text;
    chatStatusCls = cls || '';
    const el = panelEl && panelEl.querySelector('.qc-chat-status');
    if (el) {
      el.textContent = text;
      el.className = 'qc-chat-status ' + chatStatusCls;
      el.style.display = text ? '' : 'none';
    }
  }

  // 格式化完成后刷新正文（卡片区），对话框与状态提示随重渲染保留
  function rerenderExtractBody() {
    if (!panelEl) return;
    const body = panelEl.querySelector('#qc-panel-body');
    if (body) renderExtractBody(body);
    if (compareOpen) cmpRefreshFromState(); // 对比区展开时同步最新格式化内容到「修改后」
    // 格式化结果就绪后自动带参（对话框填写的质检点/业务线/版本状态）获取规则原文，
    // 对比区收起时也会预取，展开即可直接看到原文，无需用户重复填写
    if (lastExtracted && lastProblems.length && panelEl.querySelector('#qc-compare-wrap')) {
      cmpAutoFetch();
    }
  }

  // 重载格式：Agent 输出有时未加载全导致格式化不完整（卡片缺失/字段不全），
  // 此时页面气泡里已是完整回复——重新走整页提取管线（最后一次「## 优化结果」标记 +
  // 截断/去重）重新解析并刷新卡片区。
  // silent=true：自动刷新路线——失败不打扰（不弹 toast），内容与上次一致时静默跳过
  let autoRefreshTimer = null; // 格式化完成 5 秒后的一次性自动刷新（仍有问题由人工点按钮兜底）
  function scheduleAutoRefresh() {
    if (autoRefreshTimer) clearTimeout(autoRefreshTimer);
    autoRefreshTimer = setTimeout(() => {
      autoRefreshTimer = null;
      if (!panelEl) return; // 面板已关闭则无需刷新
      refreshFormat(true);
    }, 5000);
  }
  function refreshFormat(silent) {
    if (autoRefreshTimer) { clearTimeout(autoRefreshTimer); autoRefreshTimer = null; } // 手动/新一轮触发后取消待执行的自动刷新
    try {
      const result = extractResult();
      if (!result) {
        if (!silent) showToast('⚠️ 当前页面未检测到「## 优化结果」');
        return 'no_result';
      }
      const problems = structureProblems(result, lastUserBubbleText());
      if (!problems.length) {
        if (!silent) showToast('⚠️ 提取到内容但未解析出条目，请等 Agent 输出结束后重试');
        return 'no_problems';
      }
      // 静默路线：页面内容与上次一致说明没有新的完整回复，不动状态也不重渲染
      if (silent && result === lastExtracted) return 'unchanged';
      lastExtracted = result;
      lastProblems = problems;
      setChatStatus('✅ ' + (silent ? '自动' : '已') + '重新加载格式（' + problems.length + ' 条）', 'ok');
      rerenderExtractBody();
      return 'success';
    } catch (err) {
      console.warn('[QC Panel] 重载格式失败:', err);
      if (!silent) showToast('❌ 重载格式失败：' + String(err && err.message || err));
      return 'error';
    }
  }

  // ── 全量业务线清单（用户提供，确定性硬匹配；杜绝「其他业务线」混入）──
  // name：业务线全名；keys：用于从输入关键词识别该业务线的特征词（越长越优先）
  const QC_BIZ_LINES = [
    { name: 'Antom AGH-天猫飞猪', keys: ['S天猫国际'] },
    { name: 'Antom AGH-AB',       keys: ['B速卖通 '] },
    { name: 'Bettr HK',           keys: ['L-倍易贷', 'L-ALG美金贷WF'] },
    { name: 'CN EC',              keys: ['B-WF-EC', 'CNEC'] },
    { name: 'CN Trade',           keys: ['CN Trade', 'CNTRADE'] },
    { name: 'GBA',                keys: ['GBA'] },
    { name: 'WFANZ',              keys: ['WFANZ', 'ANZ'] },
    { name: 'WFLT',               keys: ['WFLT'] },
    { name: 'WFSEA',              keys: ['WFSEA', 'SEA'] }
  ];
  const _norm = (s) => String(s == null ? '' : s).toUpperCase().replace(/[\s\-–—/_ ]/g, '');
  // 由输入关键词 确定性 解析目标业务线（取命中最长特征词的那条，精确不模糊）
  function resolveTargetBizLine(keyword) {
    const k = _norm(keyword);
    let best = null, bestLen = -1;
    for (const line of QC_BIZ_LINES) {
      for (const key of line.keys) {
        const nk = _norm(key);
        if (nk && k.indexOf(nk) !== -1 && nk.length > bestLen) {
          best = line; bestLen = nk.length;
        }
      }
    }
    return best;
  }

  // 解析质检点编码 → { prefix, digits, core }：G17 / G017 / G-17 → {G, 17, G17}；
  // CO01 → {CO, 1, CO1}。无法解析（无字母或无数字）返回 null。
  function parseQcCode(code) {
    const s = String(code || '').toUpperCase().replace(/[\s\-—–_:：]/g, '');
    const m = s.match(/^([A-Z]{1,3}?)0*(\d{1,4})[A-Z]*$/);
    if (!m || !m[1]) return null;
    const digits = (m[2] || '').replace(/^0+(?=\d)/, '');
    if (!digits) return null;
    return { prefix: m[1], digits, core: m[1] + digits };
  }


  // ══════════════════════════════════════════
  // 5.5 原文对比（左侧扩展区）
  //   左列：规则原文（只读，页面接口抓取）｜右列：修改后（默认只读，「编辑」解锁，与原文差异高亮）
  //   原文滚动 → 修改后按比例同步滚动；卡片「定位原文」在两个 textarea 内选中定位；
  //   修改后编辑 → 防抖重解析同步到卡片；卡片修改方式编辑 → 反向同步进 textarea
  // ══════════════════════════════════════════

  // 「修改后」列工具条：一键复制 / 编辑(→保存·取消) / 格式优化
  // 编辑交互参照卡片「修改方式」就地编辑（openFixEditor）：编辑时隐藏其余按钮，只留 保存/取消
  // 面板重建会重新调用 → 在此复位编辑态，避免旧态残留把新 textarea 锁死
  function buildModToolbar() {
    cmpEditMode = false;
    cmpEditBackup = null;
    const bar = document.createElement('div');
    bar.className = 'qc-cmp-tools';
    const mkBtn = (label, title, cls) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.textContent = label;
      b.title = title;
      return b;
    };
    cmp.btnCopy = mkBtn('📋 一键复制', '复制「修改后」全文', 'qc-cmp-tool-btn');
    cmp.btnCopy.addEventListener('click', () => {
      const v = cmp.modTa ? cmp.modTa.value : '';
      if (!v) { showToast('⚠️ 修改后暂无内容'); return; }
      navigator.clipboard.writeText(v).then(() => {
        cmp.btnCopy.textContent = '✅ 已复制';
        setTimeout(() => { if (cmp.btnCopy) cmp.btnCopy.textContent = '📋 一键复制'; }, 1500);
        qcTrack('对比区复制', { result: 'success', len: v.length });
      }).catch(() => { showToast('❌ 复制失败'); qcTrack('对比区复制', { result: 'fail', error_code: 'clipboard' }); });
    });
    cmp.btnEdit = mkBtn('✏️ 编辑', '进入编辑：修改「修改后」内容（保存后生效，可取消回滚）', 'qc-cmp-tool-btn qc-cmp-tool-edit');
    cmp.btnEdit.addEventListener('click', () => cmpSetEditMode(true));
    cmp.btnFmt = mkBtn('⚡ 格式优化', '按 Markdown 规范优化「修改后」格式（标题/列表/表格/脏符号，高亮保留）', 'qc-cmp-tool-btn qc-cmp-tool-fmt');
    cmp.btnFmt.addEventListener('click', () => cmpFormatOptimize());
    cmp.btnSave = mkBtn('💾 保存', '保存编辑内容并回到只读态', 'qc-cmp-tool-save');
    cmp.btnSave.addEventListener('click', () => cmpSaveEdit());
    cmp.btnCancel = mkBtn('✖ 取消', '丢弃本次编辑，恢复到编辑前内容', 'qc-cmp-tool-cancel');
    cmp.btnCancel.addEventListener('click', () => cmpCancelEdit());
    cmp.btnSave.style.display = 'none';
    cmp.btnCancel.style.display = 'none';
    bar.appendChild(cmp.btnCopy);
    bar.appendChild(cmp.btnEdit);
    bar.appendChild(cmp.btnFmt);
    bar.appendChild(cmp.btnSave);
    bar.appendChild(cmp.btnCancel);
    return bar;
  }

  // 左侧扩展区整体（头部筛选 + 双列 textarea），由 createPanel 挂载
  function buildCompareWrap() {
    const wrap = document.createElement('div');
    wrap.id = 'qc-compare-wrap';

    // ── 头部：质检点 / 业务线 / 版本状态 + 获取原文按钮 ──
    const head = document.createElement('div');
    head.className = 'qc-cmp-head';
    const mkLbl = (t) => {
      const s = document.createElement('span');
      s.className = 'qc-cmp-field-label';
      s.textContent = t;
      return s;
    };

    cmp.qpInput = document.createElement('input');
    cmp.qpInput.className = 'qc-cmp-input';
    cmp.qpInput.placeholder = '如 G21';
    cmp.qpInput.title = '质检点编码';
    cmp.qpInput.value = chatForm.qp || '';

    cmp.bizSel = document.createElement('select');
    cmp.bizSel.className = 'qc-cmp-input';
    cmp.bizSel.title = '业务线（可选，提升匹配精度）';
    const phOpt = document.createElement('option');
    phOpt.value = '';
    phOpt.textContent = '业务线(可选)';
    cmp.bizSel.appendChild(phOpt);
    const BIZ_OPTIONS = ['Antom AGH-天猫飞猪', 'Antom AGH-AB', 'Bettr HK', 'CN EC', 'CN Trade',
      'GBA', 'WF EMEA', 'WFANZ', 'WFLT', 'WFSEA'];
    BIZ_OPTIONS.forEach((name) => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      cmp.bizSel.appendChild(opt);
    });
    if (chatForm.biz && BIZ_OPTIONS.includes(chatForm.biz)) cmp.bizSel.value = chatForm.biz;

    cmp.verSel = document.createElement('select');
    cmp.verSel.className = 'qc-cmp-input';
    cmp.verSel.title = '版本状态：发布版本走 getRuleVersionHistory 历史发布版；当前最新走 queryRuleByPage';
    [['release', '发布版本'], ['latest', '当前最新(草稿)']].forEach((it) => {
      const opt = document.createElement('option');
      opt.value = it[0];
      opt.textContent = it[1];
      cmp.verSel.appendChild(opt);
    });
    cmp.verSel.value = chatForm.ver === 'draft' ? 'latest' : 'release';

    cmp.fetchBtn = document.createElement('button');
    cmp.fetchBtn.type = 'button';
    cmp.fetchBtn.className = 'qc-cmp-fetch';
    cmp.fetchBtn.textContent = '⇩ 获取原文';
    cmp.fetchBtn.addEventListener('click', cmpFetchOriginal);

    cmp.status = document.createElement('div');
    cmp.status.className = 'qc-cmp-status';
    cmp.status.textContent = '格式化完成后自动按对话框填写的质检点/业务线/版本状态获取原文；右列默认只读，点「编辑」修改，支持一键复制/格式优化（高亮保留）。';

    head.appendChild(mkLbl('质检点'));
    head.appendChild(cmp.qpInput);
    head.appendChild(cmp.bizSel);
    head.appendChild(cmp.verSel);
    head.appendChild(cmp.fetchBtn);
    head.appendChild(cmp.status);
    wrap.appendChild(head);

    // ── 双列：原文（只读，被替换区间高亮） / 修改后（原文+修改方式合并结果，可编辑） ──
    const cols = document.createElement('div');
    cols.className = 'qc-cmp-cols';

    // 左列：规则原文（只读）+ 镜像层（画出被修改方式替换掉的区间）
    const colO = document.createElement('div');
    colO.className = 'qc-cmp-col';
    const lblO = document.createElement('div');
    lblO.className = 'qc-cmp-label';
    lblO.textContent = '📄 规则原文（只读）';
    const stackO = document.createElement('div');
    stackO.className = 'qc-cmp-stack';
    cmp.origMirror = document.createElement('div');
    cmp.origMirror.className = 'qc-cmp-mirror qc-mirror-orig';
    // 高亮覆盖层：不在文本流里插 <mark>（元素边界会改变折行导致漂移），
    // 而是用 Range 量测标记的真实渲染矩形后绝对定位画上去
    cmp.origHl = document.createElement('div');
    cmp.origHl.className = 'qc-cmp-hl qc-hl-orig';
    cmp.origTa = document.createElement('textarea');
    cmp.origTa.className = 'qc-cmp-mod';
    cmp.origTa.readOnly = true;
    cmp.origTa.spellcheck = false;
    cmp.origTa.placeholder = '自动获取规则原文中…';
    cmp.origTa.addEventListener('scroll', () => {
      if (cmp.origMirror) cmp.origMirror.scrollTop = cmp.origTa.scrollTop;
      if (cmp.origHl) cmp.origHl.scrollTop = cmp.origTa.scrollTop;
      // 滚动同步自检（与修改后列同逻辑）
      if (cmp.origHl && Math.abs(cmp.origHl.scrollTop - cmp.origTa.scrollTop) > 3) {
        const now = Date.now();
        if (!cmp._syncWarnAtOrig || now - cmp._syncWarnAtOrig > 2000) { // 2 秒节流
          cmp._syncWarnAtOrig = now;
          console.warn('[QC 滚动同步诊断] 原文高亮层 scrollTop 追不上 textarea：', {
            hl: cmp.origHl.scrollTop, ta: cmp.origTa.scrollTop,
            hlMax: cmp.origHl.scrollHeight - cmp.origHl.clientHeight,
            taMax: cmp.origTa.scrollHeight - cmp.origTa.clientHeight
          });
        }
      }
      cmpSyncScrollFromOrig(); // 原文滚动 → 修改后按比例同步
    });
    stackO.appendChild(cmp.origMirror);
    stackO.appendChild(cmp.origHl);
    stackO.appendChild(cmp.origTa);
    colO.appendChild(lblO);
    colO.appendChild(stackO);

    // 右列：修改后（原文+修改方式合并，可编辑）+ 高亮覆盖层（替换进来的内容）
    const colM = document.createElement('div');
    colM.className = 'qc-cmp-col';
    const lblM = document.createElement('div');
    lblM.className = 'qc-cmp-label';
    lblM.textContent = '✏️ 修改后（点「编辑」修改）';
    cmp.modLbl = lblM; // 编辑态切换时更新列头提示
    const stack = document.createElement('div');
    stack.className = 'qc-cmp-stack';
    cmp.mirror = document.createElement('div');
    cmp.mirror.className = 'qc-cmp-mirror';
    cmp.hl = document.createElement('div');
    cmp.hl.className = 'qc-cmp-hl';
    cmp.modTa = document.createElement('textarea');
    cmp.modTa.className = 'qc-cmp-mod';
    cmp.modTa.spellcheck = false;
    cmp.modTa.readOnly = true; // 默认只读：点「编辑」解锁（编辑需显式触发）
    cmp.modTa.placeholder = '获取原文后自动按「原文定位 → 修改方式替换」合并生成';
    cmp.modTa.addEventListener('scroll', () => {
      if (cmp.mirror) cmp.mirror.scrollTop = cmp.modTa.scrollTop;
      if (cmp.hl) cmp.hl.scrollTop = cmp.modTa.scrollTop;
      // 滚动同步自检：高亮层因滚动上限被钳制而追不上 textarea 时告警
      //（两侧布局一致时不会触发；触发即说明高亮层可用滚动范围不足，高亮会随滚动整体错位）
      if (cmp.hl && Math.abs(cmp.hl.scrollTop - cmp.modTa.scrollTop) > 3) {
        const now = Date.now();
        if (!cmp._syncWarnAt || now - cmp._syncWarnAt > 2000) { // 2 秒节流，避免滚动过程刷屏
          cmp._syncWarnAt = now;
          console.warn('[QC 滚动同步诊断] 高亮层 scrollTop 追不上 textarea：', {
            hl: cmp.hl.scrollTop, ta: cmp.modTa.scrollTop,
            hlMax: cmp.hl.scrollHeight - cmp.hl.clientHeight,
            taMax: cmp.modTa.scrollHeight - cmp.modTa.clientHeight
          });
        }
      }
    });
    cmp.modTa.addEventListener('input', cmpOnModInput);
    stack.appendChild(cmp.mirror);
    stack.appendChild(cmp.hl);
    stack.appendChild(cmp.modTa);
    colM.appendChild(lblM);
    colM.appendChild(buildModToolbar());
    colM.appendChild(stack);

    cols.appendChild(colO);
    cols.appendChild(colM);
    wrap.appendChild(cols);
    return wrap;
  }

  // 展开/收起对比区：对比区绝对定位挂在面板左缘向外扩展，面板本身宽度不变
  function setCompareOpen(open) {
    compareOpen = open;
    if (!panelEl) return;
    const wrap = panelEl.querySelector('#qc-compare-wrap');
    if (wrap) wrap.style.display = open ? 'flex' : 'none';
    const tab = panelEl.querySelector('#qc-compare-tab');
    if (tab) {
      tab.textContent = open ? '⇥ 收起对比' : '⇤ 原文对比';
      tab.title = open ? '收起原文对比区' : '展开原文对比区（规则原文 vs 修改后）';
    }
    if (open) {
      cmpRefreshFromState();
      // 格式化结果已就绪时自动带参获取原文（用户无需重复填写质检点/业务线/版本状态）
      if (lastExtracted && lastProblems.length) cmpAutoFetch();
    }
  }

  // 用最新状态刷新对比区：有原文 → 重新执行「原文定位 → 修改方式替换」合并；
  // 无原文 → 修改后退化为展示格式化内容
  function cmpRefreshFromState() {
    if (!cmp.modTa) return;
    cmpRebuildMerged();
  }

  // 新一轮对话开始时清空对比区（原文与修改后一并清，避免上一轮内容串场）；
  // 同时重置自动获取去重键与合并状态，新一轮格式化完成后会按新条件重新获取
  function cmpResetContent() {
    cmpSetEditMode(false); // 新一轮开始：退出编辑态，避免清空后仍停留在编辑中
    cmp.original = '';
    cmp.autoKey = '';
    cmp.mergedMarks = [];
    cmp.origMarks = [];
    cmp.lastMerged = '';
    cmp.lastModText = '';
    if (cmp.origTa) cmp.origTa.value = '';
    if (cmp.modTa) cmp.modTa.value = '';
    cmpRepaintOrigMirror();
    cmpRepaintModMirror();
  }

  function cmpSetStatus(text, cls) {
    if (!cmp.status) return;
    cmp.status.textContent = text;
    cmp.status.className = 'qc-cmp-status' + (cls ? ' ' + cls : '');
  }

  // 自动带参获取原文：从对话框已填写的 质检点/业务线/规则版本（chatForm）取值，
  // 缺失时兜底用格式化卡片解析出的质检点编码/业务线；同一条件只自动取一次，
  // 用户可随时改头部输入后手动重取
  function cmpAutoFetch() {
    if (!cmp.qpInput) return;
    const p0 = lastProblems[0] || {};
    const qp = chatForm.qp || (p0.qcRefs && p0.qcRefs[0]) || '';
    const biz = chatForm.biz || p0.qcBizLine || '';
    const ver = chatForm.ver === 'draft' ? 'latest' : 'release';
    if (!qp) return; // 连兜底都解析不出编码，不发起请求
    // 回填到头部输入框（业务线选项不存在时跳过回填，避免造出非法 option）
    cmp.qpInput.value = qp;
    if (biz) {
      const has = Array.from(cmp.bizSel.options).some((o) => o.value === biz);
      if (has) cmp.bizSel.value = biz;
    }
    cmp.verSel.value = ver;
    const key = qp + '|' + (cmp.bizSel.value || '') + '|' + ver;
    if (key === cmp.autoKey && cmp.original) return; // 同条件已取过，不重复请求
    cmpFetchOriginal();
  }

  // 富文本原文 → 纯文本（在坐标系源头处理：剥后文本同时作为 textarea 值、标记偏移、合并基准，
  // 三者天然同源，不再出现 origMarks 偏在标签起点、选区把 <p> 字面量包进来的问题）。
  // 块级闭合标签转换行防段落粘连，实体还原成字符；纯文本输入不受影响（幂等）
  function cmpRichToPlain(s) {
    return String(s || '')
      .replace(/\r\n?/g, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr|blockquote)>/gi, '\n')
      .replace(/<[^>]{0,400}>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
      .replace(/&#(\d{1,5});/g, (m, d) => { try { return String.fromCodePoint(+d); } catch (e) { return m; } })
      .replace(/&#x([0-9a-fA-F]{1,5});/g, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return m; } })
      .replace(/&amp;/gi, '&') // &amp; 最后解码，避免 &amp;lt; 二次解码
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // 获取原文：按当前选择的 质检点/业务线/版本状态 走后台页面接口链路
  async function cmpFetchOriginal() {
    if (cmp.fetchBtn && cmp.fetchBtn.disabled) return; // 请求进行中：自动/手动触发不并发
    const qp = (cmp.qpInput.value || '').trim();
    const biz = cmp.bizSel.value || '';
    const ver = cmp.verSel.value || 'release';
    chatForm.qp = qp;
    if (biz) chatForm.biz = biz;
    chatForm.ver = ver === 'latest' ? 'draft' : 'release';
    if (!qp) { cmpSetStatus('⚠️ 请先填写质检点编码（如 G21）', 'err'); return; }
    if (cmp.fetchBtn) { cmp.fetchBtn.disabled = true; cmp.fetchBtn.textContent = '⏳ 获取中…'; }
    cmpSetStatus('⏳ 正在通过页面接口获取原文（首次可能需加载规则管理页，请稍候）…', 'info');
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'qc-fetch-rule-original', qp, biz, ver });
      if (resp && resp.ok && resp.original) {
        // 富文本剥离 + 归一化换行：textarea 赋值时会把 \r\n 折叠成 \n，且富文本原文
        //（<p>、&nbsp; 等）若不剥掉，标记偏移会指在标签起点、选区把标签字面量包进来；
        // 在源头剥成纯文本后，偏移坐标系全程一致（cmpRichToPlain 内已做 \r\n 归一化）
        cmp.original = cmpRichToPlain(resp.original);
        cmp.autoKey = qp + '|' + biz + '|' + ver; // 记录已成功获取的条件（自动获取去重用）
        // 核心合并：把各条目的「修改方式」按「原文定位」替换进原文，生成修改后全文
        const m = cmpRebuildMerged();
        cmpSetStatus('✅ 原文已加载', 'ok');
        qcTrack('原文对比获取', { result: 'success', qp, biz, ver, len: cmp.original.length, merged: m ? m.applied : 0 });
      } else {
        cmpSetStatus('❌ ' + ((resp && resp.hint) || (resp && resp.error) || '获取失败'), 'err');
        qcTrack('原文对比获取', { result: 'fail', qp, biz, ver, error_code: String((resp && resp.error) || 'unknown') });
      }
    } catch (e) {
      cmpSetStatus('❌ 获取异常：' + String(e && e.message || e), 'err');
      qcTrack('原文对比获取', { result: 'fail', qp, biz, ver, error_code: 'exception' });
    } finally {
      if (cmp.fetchBtn) { cmp.fetchBtn.disabled = false; cmp.fetchBtn.textContent = '⇩ 获取原文'; }
    }
  }

  // ── 原文滚动 → 修改后按比例同步（对比看）──
  function cmpSyncScrollFromOrig() {
    if (!cmp.origTa || !cmp.modTa || cmp.syncLock) return;
    cmp.syncLock = true;
    try {
      const o = cmp.origTa, m = cmp.modTa;
      const maxO = o.scrollHeight - o.clientHeight;
      const maxM = m.scrollHeight - m.clientHeight;
      m.scrollTop = maxO > 0 ? Math.round((o.scrollTop / maxO) * maxM) : 0;
      if (cmp.mirror) cmp.mirror.scrollTop = m.scrollTop;
      if (cmp.hl) cmp.hl.scrollTop = m.scrollTop; // 黄色高亮层同步，避免原文联动滚动时高亮掉队
    } catch (e) { /* 忽略 */ }
    cmp.syncLock = false;
  }

  // 对比区差异子段计算：对「被替换的原文段」与「修改方式」做字符级 LCS diff，
  // 产出 added（修改方式新增段 → 修改后列高亮）与 removed（原文被删段 → 原文列高亮）。
  // 与卡片 diffBoldHtml 同源思路——卡片用加粗标差异，textarea 内无法加粗
  //（也不允许：镜像层必须纯文本，内联样式会破坏逐像素折行对齐），故用多个高亮矩形替代。
  // 超长段降级：面积超限返回 fallback=true，调用方退回整段高亮，避免 O(n·m) 卡顿
  function cmpDiffSegMarks(origSeg, fix) {
    const out = { added: [], removed: [], fallback: false };
    const n = origSeg.length, mLen = fix.length;
    if (n * mLen > 1500000 || n > 3000 || mLen > 3000) { out.fallback = true; return out; }
    const ops = diffLcs(origSeg, fix); // {s:'='|'+'|'-', v} 字符级操作序列
    let ia = 0, ib = 0;                // ia: 原文段游标，ib: 修改方式游标
    let aS = -1, aE = -1, rS = -1, rE = -1;
    const flush = () => {
      if (aE > aS) out.added.push({ start: aS, end: aE });
      if (rE > rS) out.removed.push({ start: rS, end: rE });
      aS = aE = rS = rE = -1;
    };
    for (const op of ops) {
      if (op.s === '=') { flush(); ia++; ib++; }
      else if (op.s === '+') { if (aS < 0) aS = ib; aE = ib + 1; ib++; }
      else { if (rS < 0) rS = ia; rE = ia + 1; ia++; }
    }
    flush();
    return out;
  }

  // 取某条问题在标记列表中的整体区间：细粒度化后同一条目有多个子标记，
  // 取最早起点到最晚终点，供「定位原文」选中整块
  function cmpProblemMarkRange(marks, p) {
    let s = -1, e = -1;
    for (const x of marks) {
      if (x.p !== p) continue;
      if (s < 0 || x.start < s) s = x.start;
      if (x.end > e) e = x.end;
    }
    return e > s ? { start: s, end: e } : null;
  }

  // ══════════ 核心合并：原文定位 → 修改方式替换 ══════════
  // 把每条问题的「修改方式」按其「原文定位」在原文中找到位置并替换，
  // 产出修改后全文 + 两侧高亮区间（差异细粒度：只标真正变化的子段，等价卡片差异加粗）：
  //   mergedMarks：修改后文本中新增的变化子段（黄色高亮，一条修改可对应多个子段）
  //   origMarks  ：原文文本中被删除/替换的变化子段（橙色高亮）
  // 未定位到原文位置的条目跳过（不强行拼接），数量由调用方在状态条提示
  function cmpBuildMerged() {
    const orig = cmp.original || '';
    const probs = lastProblems.filter((p) => p.locate && p.fix);
    const hits = [];
    for (const p of probs) {
      const r = cmpFindRange(orig, p.locate);
      // 只采纳高置信命中（≥0.5）做自动替换；低分候选留给「定位原文」滚动提示，
      // 避免把修改方式替换到错误位置
      if (r && r.end > r.start && r.score >= 0.5) hits.push({ start: r.start, end: r.end, p });
    }
    // 按起点排序并剔除重叠区间（保留先命中的，避免替换错位）
    hits.sort((a, b) => a.start - b.start || b.end - a.end);
    const clean = [];
    let lastEnd = -1;
    for (const h of hits) {
      if (h.start < lastEnd) continue; // 与前一个区间重叠：跳过
      clean.push(h);
      lastEnd = h.end;
    }
    // 从后往前替换，保证文本切片正确。
    // ⚠️ 标记坐标修正（高亮上偏的真正根因，v5.4.4 抽样实锤：首段 ok、4639 起全失配、
    // 失配内容是前一段的尾巴 → 标记指早）：h.start 是「原文坐标」，但更早命中的替换
    // 会改变文本长度（本例 8645→9315，净增 670 字），其后内容的真实位置必须加上
    // 前面所有命中的累计偏移。首条命中前面无替换 → 恰好正确（首段永远准），
    // 越往后累计偏移越大 → 越往后偏得越多。原文列标记用原文坐标查原文文本，天然正确，
    // 这解释了为何只有修改后列错位。
    const prefixDelta = [];
    let acc = 0;
    for (const h of clean) {
      prefixDelta.push(acc);
      acc += h.p.fix.length - (h.end - h.start);
    }
    let text = orig;
    const mergedMarks = [], origMarks = [];
    for (let i = clean.length - 1; i >= 0; i--) {
      const h = clean[i];
      const off = prefixDelta[i]; // 该命中在合并文本中的累计偏移
      text = text.slice(0, h.start) + h.p.fix + text.slice(h.end);
      // 差异细粒度高亮：只标真正变化的子段（等价于卡片里的差异加粗），
      // 未改动的文字不再整段刷色；diff 降级时退回整段高亮，保证替换位置始终有提示
      const d = cmpDiffSegMarks(orig.slice(h.start, h.end), h.p.fix);
      if (d.fallback) {
        mergedMarks.push({ start: h.start + off, end: h.start + off + h.p.fix.length, p: h.p, t: h.p.fix });
        origMarks.push({ start: h.start, end: h.end, p: h.p, t: orig.slice(h.start, h.end) });
      } else {
        // 修改后列：细粒度高亮 added（修改方式相对原文新增的子段）——
        // 用户看修改后列想知道「具体改成了什么」，新增部分高亮即可
        for (const a of d.added) mergedMarks.push({ start: h.start + off + a.start, end: h.start + off + a.end, p: h.p, t: h.p.fix.slice(a.start, a.end) });
        // 原文列：整段高亮 [h.start, h.end)——整段原文都被替换掉了，
        // 用户看原文列想知道「哪段被改了」，整段高亮最清晰。
        // 之前用 d.removed 细粒度：当原文段与修改方式高度相似时 LCS 只匹配出极少被删字符
        //（往往只剩一个标点），造成「一段话只高亮一个标点」的缺失假象
        origMarks.push({ start: h.start, end: h.end, p: h.p, t: orig.slice(h.start, h.end) });
      }
    }
    mergedMarks.sort((a, b) => a.start - b.start);
    origMarks.sort((a, b) => a.start - b.start);
    // 合并抽样自动输出（无需 Console 开关）：核对高亮子段偏移指向的内容——
    // 屏幕高亮盖住的文字若与抽样 content 一致 → 绘制问题；不一致 → 偏移数据问题
    try {
      console.log('[QC 合并抽样] 全文 ' + text.length + ' 字 · 合并 ' + clean.length + '/' + probs.length +
        ' 条 · 高亮子段 ' + mergedMarks.length + ' 个，前 5 段：',
        mergedMarks.slice(0, 5).map((mk) => ({
          start: mk.start, end: mk.end,
          content: text.slice(mk.start, mk.start + 30)
        })));
    } catch (e) { /* 忽略 */ }
    return { text, mergedMarks, origMarks, applied: clean.length, total: probs.length };
  }

  // 重建对比区内容：有原文 → 重新合并；无原文 → 修改后展示格式化内容（兜底）。
  // 用户已在修改后手动编辑过（内容 ≠ 上次合并产出）时不覆盖，保护手工修改。
  // force=true 时跳过手工保护：卡片「修改方式」编辑保存后调用，用最新 fix 重算合并，
  // 覆盖修改后 textarea 的手工改动——用户明确改了 fix，合并产物就该同步
  function cmpRebuildMerged(force) {
    if (!cmp.modTa || !cmp.origTa) return null;
    if (!cmp.original) {
      cmp.origTa.value = '';
      cmp.origMarks = [];
      if (cmp.modTa.value !== (lastExtracted || '')) cmp.modTa.value = lastExtracted || '';
      cmp.mergedMarks = [];
      cmp.lastMerged = cmp.modTa.value;
      // cmp.lastModText 挪到 cmpRepaintModMirror 内赋值：确保绘制完成后才开放增量平移
      cmpRepaintOrigMirror();
      cmpRepaintModMirror();
      return null;
    }
    // 用户手动编辑过修改后：保留手工内容，只刷新高亮（cmp.lastModText 在 cmpRepaintModMirror 内设）
    // force=true（卡片编辑保存触发）时跳过此保护，重算合并覆盖手工改动
    if (!force && cmp.modTa.value !== cmp.lastMerged && cmp.lastMerged) {
      cmpRepaintOrigMirror();
      cmpRepaintModMirror();
      return { applied: new Set(cmp.mergedMarks.map((x) => x.p)).size, total: lastProblems.filter((p) => p.locate && p.fix).length };
    }
    cmp.origTa.value = cmp.original;
    const m = cmpBuildMerged();
    cmp.modTa.value = m.text;
    cmp.mergedMarks = m.mergedMarks;
    cmp.origMarks = m.origMarks;
    cmp.lastMerged = m.text;
    // cmp.lastModText 挪到 cmpRepaintModMirror 内赋值：绘制完成后才开放增量平移，
    // 否则 200ms 防抖窗口内用户敲字会用旧基准计算增量，把标记平移坏（v5.4.2 实锤：5/6 失配）
    cmpRepaintOrigMirror();
    cmpRepaintModMirror();
    return m;
  }

  // ── 高亮渲染：替换完成后一次性整体高亮 ──
  // 镜像层只放纯文本（与 textarea 折行逐像素一致，不再插任何 <mark> 元素——
  // 元素边界会改变折行决策，导致第 2 个标记起累积漂移）。
  // 高亮改用 Range 在纯文本镜像上量测标记的真实渲染矩形（含逐行拆分），
  // 以绝对定位矩形画到覆盖层上——高亮不参与文本流，永不漂移。
  // ⚠️ innerHTML 重建会把 scrollTop 归零：必须先记下滚动位置，重建后恢复，
  // 否则量测坐标系（未滚动）与 textarea 实际滚动窗不一致，高亮整体错位
  function cmpRepaintOrigMirror() {
    if (!cmp.origMirror || !cmp.origTa) return;
    try {
      const st = cmp.origTa.scrollTop;
      cmp.origMirror.innerHTML = esc(cmp.origTa.value); // 纯文本
      cmp.origMirror.scrollTop = st;                    // 重建后恢复滚动
      cmpPaintMarks(cmp.origTa, cmp.origMirror, cmp.origHl, cmp.origMarks);
    } catch (e) { /* 忽略 */ }
  }

  function cmpRepaintModMirror() {
    if (!cmp.mirror || !cmp.modTa) return;
    try {
      const st = cmp.modTa.scrollTop;
      cmp.mirror.innerHTML = esc(cmp.modTa.value); // 纯文本
      cmp.mirror.scrollTop = st;                   // 重建后恢复滚动
      cmpPaintMarks(cmp.modTa, cmp.mirror, cmp.hl, cmp.mergedMarks);
      // 绘制完成后才开放增量平移：cmp.lastModText 必须与已绘制的标记同源，
      // 否则 200ms 防抖窗口内用户敲字会用旧基准计算增量，把标记平移坏（v5.4.2 实锤：5/6 失配）
      cmp.lastModText = cmp.modTa.value;
    } catch (e) { /* 忽略 */ }
  }

  // 用 Range 量测标记区间在镜像纯文本中的真实渲染矩形（自动按视觉行拆分），
  // 画到覆盖层 hl（内容坐标系 = 镜像内容坐标，hl.scrollTop 与 textarea 同步滚动）
  function cmpPaintMarks(ta, mirror, hl, marks) {
    if (!hl) return;
    hl.innerHTML = '';
    const text = ta.value || '';
    // 流内占位【无条件重建】：即使本帧没有任何标记也必须撑出 hl 的 scrollHeight。
    // 之前空标记帧在这里提前 return、把占位一并清掉 → hl 变回不可滚动（hlMax=0），
    // 之后每次滚动 hl 都被钳在 0、高亮整体掉队（console 实锤：hl:0/hlMax:0，
    // 而 textarea 已滚到 ta:2639/taMax:7636）。占位必须在任何提前 return 之前建好
    const spacer = document.createElement('div');
    spacer.style.cssText = 'height:' + mirror.scrollHeight + 'px;width:1px;' +
      'visibility:hidden;pointer-events:none';
    hl.appendChild(spacer);
    hl.scrollTop = mirror.scrollTop; // 空标记帧同样保持与 textarea 的滚动同步
    if (!marks || !marks.length || !text || !mirror.firstChild) return;
    const node = mirror.firstChild;
    if (node.nodeType !== Node.TEXT_NODE) return;
    const base = mirror.getBoundingClientRect();
    // 对齐诊断：高亮坐标全部量自镜像层，镜像与 textarea 的折行布局必须逐像素一致。
    // 若滚动高度/内容宽度分歧，说明两者换行相关属性被宿主页面 CSS 差异化覆盖，
    // 高亮会随文档位置累积漂移（首段准、越往下越偏）——控制台输出具体分歧项
    if (mirror.scrollHeight !== ta.scrollHeight || mirror.clientWidth !== ta.clientWidth) {
      const csM = getComputedStyle(mirror), csT = getComputedStyle(ta);
      console.warn('[QC 高亮对齐诊断] 镜像层与 textarea 布局不一致：', {
        mirrorScrollHeight: mirror.scrollHeight, taScrollHeight: ta.scrollHeight,
        mirrorClientWidth: mirror.clientWidth, taClientWidth: ta.clientWidth,
        mirrorFont: csM.font, taFont: csT.font,
        mirrorWhiteSpace: csM.whiteSpace, taWhiteSpace: csT.whiteSpace,
        mirrorWordBreak: csM.wordBreak, taWordBreak: csT.wordBreak,
        mirrorOverflowWrap: csM.overflowWrap, taOverflowWrap: csT.overflowWrap,
        mirrorLineHeight: csM.lineHeight, taLineHeight: csT.lineHeight,
        mirrorLetterSpacing: csM.letterSpacing, taLetterSpacing: csT.letterSpacing
      });
    }
    // 数据抽样诊断（自动输出 + 2 秒节流，无需 Console 开关——content 脚本运行在
    // 隔离 world，Console 设的 window 变量它看不到，开关方案无效）：
    // 核对抽样 content 是否就是屏幕上高亮盖住的那段文字——
    // 一致 → 绘制路径问题；不一致（指早了）→ 标记偏移数据问题
    if (marks.length) {
      const isMod = ta === cmp.modTa;
      const sKey = isMod ? '_sampleAtMod' : '_sampleAtOrig'; // 两列独立节流：共用一键时先画的列把后画的吃掉
      const now = Date.now();
      if (!cmp[sKey] || now - cmp[sKey] > 2000) {
        cmp[sKey] = now;
        // 内容自检：m.t 为构建时的预期文本，失配 ⇒ 标记偏移/过期（数据层实锤）
        let bad = 0;
        for (const m of marks) if (typeof m.t === 'string' && text.slice(m.start, m.end) !== m.t) bad++;
        console.log('[QC 高亮数据抽样] ' + (isMod ? '修改后列' : '原文列') +
          ' text=' + text.length + ' 字 · 内容失配 ' + bad + '/' + marks.length +
          ' · 镜像SH=' + mirror.scrollHeight + '/taSH=' + ta.scrollHeight +
          ' · st=' + mirror.scrollTop + '/hlSt=' + hl.scrollTop + '：',
          marks.slice(0, 5).map((m) => ({
            start: m.start, end: m.end,
            ok: typeof m.t === 'string' ? text.slice(m.start, m.end) === m.t : '?',
            content: text.slice(m.start, m.start + 30)
          })));
      }
    }
    const frag = document.createDocumentFragment();
    for (const m of marks) {
      if (!(m.end > m.start) || m.start < 0 || m.end > text.length) continue;
      try {
        const r = document.createRange();
        r.setStart(node, m.start);
        r.setEnd(node, m.end);
        const rects = r.getClientRects();
        for (let i = 0; i < rects.length; i++) {
          const rc = rects[i];
          if (rc.width <= 0 || rc.height <= 0) continue;
          const el = document.createElement('i');
          // 内容坐标：视口坐标 − 镜像原点 + 镜像已滚过的距离（hl 用 scrollTop 对齐同一内容窗）
          // position:absolute 内联兜底：正常由 CSS .qc-cmp-hl i 提供，防外部样式覆盖后高亮塌陷
          el.style.cssText = 'position:absolute;left:' + (rc.left - base.left) + 'px;top:' +
            (rc.top - base.top + mirror.scrollTop) + 'px;width:' + rc.width + 'px;height:' + rc.height + 'px';
          frag.appendChild(el);
        }
      } catch (e) { /* 忽略 */ }
    }
    hl.appendChild(frag);
    hl.scrollTop = mirror.scrollTop;
  }

  // 编辑「修改后」的标记维护：与原文列同逻辑——标记位置是确定性的，不做任何模糊重算。
  // 每次 input 事件立即做一次「编辑增量平移」（快速连续编辑各自独立处理，
  // 不会因防抖把两处编辑合并成一次增量导致平移量错误）：
  //   改动点之前的标记不动；之后的整体平移 Δ；直接被改到的标记摘除。
  // 模糊重算会让相同/相似内容的标记吸附漂移（高亮位置偏移的根源），已弃用
  function cmpOnModInput() {
    if (cmp.mirror) cmp.mirror.scrollTop = cmp.modTa.scrollTop;
    cmpApplyEditDelta();
    scheduleCmpRepaint(); // 防抖只负责重绘镜像层（大文本每次键入全量重建 HTML 有开销）
  }

  // 对本次输入做增量平移（同步执行）
  function cmpApplyEditDelta() {
    if (!cmp.modTa) return;
    const oldV = cmp.lastModText;
    const newV = cmp.modTa.value;
    // cmp.lastModText 不在这里更新——要等 cmpRepaintModMirror 绘制完成后才赋值，
    // 否则 200ms 防抖窗口内多次敲字会让基准与绘制状态脱节（v5.4.3 实锤：3/4 失配）
    if (!cmp.mergedMarks.length || oldV == null || oldV === newV) return;
    // 求编辑增量：公共前缀 p + 公共后缀 s → 改动区间 [p, oldEnd) → [p, newEnd)
    let p = 0;
    const minL = Math.min(oldV.length, newV.length);
    while (p < minL && oldV[p] === newV[p]) p++;
    let s = 0;
    while (s < minL - p && oldV[oldV.length - 1 - s] === newV[newV.length - 1 - s]) s++;
    const oldEnd = oldV.length - s;
    const delta = (newV.length - s) - oldEnd;
    if (delta === 0 && oldEnd <= p) return; // 无实际改动
    // 纯插入（oldEnd===p，没有旧字符被删）：跨插入点的标记整体扩展 delta，位置仍准；
    // 有删除/替换（oldEnd>p）碰到标记：保留标记不摘除（v5.4.8：用户要求编辑时高亮不消失），
    // start 不动、end 按 delta 平移；删除过多导致 end≤start 时夹到 start+1，保证至少 1 字高亮。
    // 内容已变，弃用自检基准 t
    const pureInsert = oldEnd <= p;
    cmp.mergedMarks = cmp.mergedMarks
      .map((mk) => {
        if (mk.end <= p) return mk;                                   // 改动点之前：不动
        if (mk.start >= oldEnd) return { start: mk.start + delta, end: mk.end + delta, p: mk.p, t: mk.t }; // 之后：平移（内容不变，保留自检基准）
        if (pureInsert) return { start: mk.start, end: mk.end + delta, p: mk.p, t: undefined }; // 纯插入穿过标记：整体扩展（内容掺入新字符，弃用自检基准）
        // 有删改且碰到标记：保留，end 按 delta 平移；ne≤ns 时夹到 ns+1 保证高亮不消失
        const ns = mk.start;
        const ne = mk.end + delta;
        return { start: ns, end: Math.max(ne, ns + 1), p: mk.p, t: undefined };
      })
      .filter(Boolean)
      .sort((a, b) => a.start - b.start);
  }

  // 重绘镜像层（标记已由 cmpApplyEditDelta 增量维护，这里只做渲染）
  function scheduleCmpRepaint() {
    if (cmp.repaintTimer) clearTimeout(cmp.repaintTimer);
    cmp.repaintTimer = setTimeout(() => {
      cmp.repaintTimer = null;
      if (!cmp.modTa) return;
      cmpRepaintModMirror();
    }, 200);
  }

  // ══════════ 对比区定位算法（抗改写/富文本/换行差异） ══════════

  // 长度保持清洗：HTML 标签/实体 → 等长空格。接口原文常是富文本（<p>、&nbsp; 等），
  // 实体若不处理会变成字母混进内容流污染匹配；等长替换保证字符偏移映射不变
  function cmpLenSafeStrip(s) {
    return String(s || '')
      .replace(/<[^>]{0,400}>/g, (m) => ' '.repeat(m.length))
      .replace(/&(?:nbsp|lt|gt|amp|quot|apos|#\d{1,5}|#x[0-9a-fA-F]{1,5});/g, (m) => ' '.repeat(m.length));
  }

  // 对比区专用内容化：只保留 字母/数字/汉字（空格/标点/md 符号全去掉），
  // 两侧空格、全半角标点、换行差异不再影响匹配；map[i] = 内容第 i 字在原串的偏移
  function cmpToChars(s) {
    const text = [], map = [];
    const src = String(s || '');
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (/[0-9A-Za-z一-龥]/.test(ch)) { text.push(ch.toLowerCase()); map.push(i); }
    }
    return { text: text.join(''), map };
  }

  // 短块探测：把目标内容切成 12 字小块，逐块在原文内容流中找精确出现位置，
  // 按「块出现位置 − 块在目标中的偏移」估计目标起点并聚类，取最密集簇。
  // 局部改写/措辞调整时其余块仍会命中，能定位到"附近"；score ≈ 命中块覆盖率
  function cmpChunkProbe(target, hay) {
    const L = target.length;
    if (L < 14) return null;
    const chunkLen = 12, step = 6;
    const hits = [];
    for (let i = 0; i + chunkLen <= L; i += step) {
      const chunk = target.slice(i, i + chunkLen);
      let idx = hay.indexOf(chunk);
      let guard = 0;
      while (idx !== -1 && guard++ < 60) {
        hits.push(idx - i); // 该块推出的目标起点估计
        idx = hay.indexOf(chunk, idx + 1);
      }
    }
    if (hits.length < 2) return null;
    hits.sort((a, b) => a - b);
    const win = Math.max(30, Math.floor(L / 4));
    let best = null;
    let i = 0;
    while (i < hits.length) {
      let j = i;
      while (j < hits.length && hits[j] - hits[i] <= win) j++;
      const cnt = j - i;
      if (!best || cnt > best.cnt) best = { s: hits[i], cnt };
      i = Math.max(i + 1, j > i + 1 ? j - 1 : i + 1);
    }
    if (!best || best.cnt < 2) return null;
    const start = Math.max(0, best.s);
    const end = Math.min(hay.length, start + L);
    if (end <= start) return null;
    return { start, end, score: Math.min(0.9, (best.cnt * step) / L), mode: 'chunk', chunkHits: best.cnt };
  }

  // 在文本中定位 locateField，返回 {start,end,score,mode}（原始偏移）或 null。
  // 五级候选取最优：整体精确 → 整行锚点 → 整体滑窗 → 逐行滑窗 → 短块聚类。
  // 低分候选也返回（score 字段区分），由调用方决定"合并 adoption"还是"仅滚动提示"
  function cmpFindRange(text, locateField, fromOffset) {
    if (!text || !locateField) return null;
    const hay0 = cmpLenSafeStrip(text);
    const field0 = cmpLenSafeStrip(String(locateField));
    const hay = cmpToChars(hay0);
    const target = cmpToChars(field0).text;
    if (target.length < 2 || hay.text.length < 4) return null;
    // fromOffset：只在该原始偏移之后搜索（多条相同/相似内容按顺序各归各位，不挤到第一处）
    let fromC = 0;
    if (fromOffset > 0) {
      let lo = 0, hi = hay.map.length; // 二分：第一个 map[i] >= fromOffset 的内容下标
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (hay.map[mid] < fromOffset) lo = mid + 1; else hi = mid;
      }
      fromC = lo;
      if (fromC >= hay.text.length) return null;
    }
    // 搜索在 sub（内容流自 fromC 起的截断）上进行，命中后统一 +fromC 还原全局内容下标
    const sub = hay.text.slice(fromC);
    // 行/句切分：换行 + 中文句读，给锚点和逐行定位用
    const lines = field0.split(/\n+|[。；;！？]/)
      .map((l) => cmpToChars(l).text)
      .filter((l) => l.length >= 6);
    const cands = [];
    // ① 整体精确
    const ex = sub.indexOf(target);
    if (ex !== -1) cands.push({ start: ex + fromC, end: ex + target.length + fromC, score: 1, mode: 'exact' });
    // ② 整行锚点（最长的几行整行精确出现后回推起点，对重复短句最稳）
    const ab = anchorLocate(target, lines, sub);
    if (ab) cands.push({ start: ab.start + fromC, end: ab.end + fromC, score: ab.score, mode: 'anchor' });
    // ③ 整体滑窗模糊
    if (target.length >= 4) {
      const fw = locateWindow(target, sub);
      if (fw) cands.push({ start: fw.start + fromC, end: fw.end + fromC, score: fw.score, mode: 'window' });
    }
    // ④ 逐行滑窗：每行独立找最相似位置（行级措辞调整/换行差异时仍命中附近），
    //    取最优行，区间向两侧扩到 ≈ 目标长度（覆盖相邻行）
    let bestLine = null;
    for (const ln of lines) {
      if (ln.length < 8 || ln.length > 400) continue;
      const r = locateWindow(ln, sub);
      if (r && (!bestLine || r.score > bestLine.r.score)) bestLine = { r, ln };
    }
    if (bestLine && bestLine.r.score >= 0.6) {
      const pad = Math.floor((target.length - (bestLine.r.end - bestLine.r.start)) / 2);
      const s2 = Math.max(0, bestLine.r.start - Math.max(0, pad));
      const e2 = Math.min(sub.length, bestLine.r.end + Math.max(0, pad));
      cands.push({ start: s2 + fromC, end: e2 + fromC, score: bestLine.r.score * 0.85, mode: 'line' });
    }
    // ⑤ 短块聚类探测
    const cp = cmpChunkProbe(target, sub);
    if (cp) cands.push({ start: cp.start + fromC, end: cp.end + fromC, score: cp.score, mode: cp.mode });
    if (!cands.length) return null;
    cands.sort((a, b) => b.score - a.score);
    const best = cands[0];
    if (best.start >= hay.map.length) return null;
    const start = hay.map[best.start];
    const endChar = Math.min(best.end, hay.map.length) - 1;
    const end = endChar >= 0 ? hay.map[endChar] + 1 : start;
    if (end <= start) return null;
    return { start, end, score: best.score, mode: best.mode };
  }

  // 对比区定位：卡片「📍 定位原文」→ 主定位在「原文」textarea：选中该原文定位对应内容、
  // 自动滚动到该位置并高亮（原生选区 + 橙色标记区）；同时联动修改后 textarea 滚到
  // 对应替换区间（该条修改方式所在位置），两侧对照看。
  // 低相似度命中也会滚动到最接近位置（toast 提示相似度），不再直接放弃
  function locateInCompare(locateField, problem) {
    if (!cmp.origTa) return false;
    if (!cmp.origTa.value) {
      showToast('⚠️ 原文尚未获取，请先在对比区点「获取原文」');
      return false;
    }
    const o = cmp.origTa, m = cmp.modTa;
    let ok = false;

    // ── 精确滚动工具：镜像层是纯文本（与 textarea 折行逐像素一致），
    //    用 Range 量测偏移处的真实渲染位置（含软换行的视觉行），
    //    取代旧"换行符行数×行高"估算（长段落自动折行时会严重偏小、滚不到位置）
    const scrollToOffset = (ta, mirror, offset) => {
      if (!mirror || !mirror.firstChild) return false;
      try {
        const node = mirror.firstChild;
        if (node.nodeType !== Node.TEXT_NODE) return false;
        const off = Math.min(Math.max(0, offset), node.length);
        if (off >= node.length) return false;
        const r = document.createRange();
        r.setStart(node, off);
        r.setEnd(node, off + 1); // 展开一个字符，确保有渲染盒
        const rect = r.getBoundingClientRect();
        if (!rect || !rect.height) return false;
        const base = mirror.getBoundingClientRect();
        ta.scrollTop = Math.max(0, rect.top - base.top + mirror.scrollTop - ta.clientHeight * 0.4);
        mirror.scrollTop = ta.scrollTop;
        if (cmp.hl && ta === cmp.modTa) cmp.hl.scrollTop = ta.scrollTop;
        if (cmp.origHl && ta === cmp.origTa) cmp.origHl.scrollTop = ta.scrollTop;
        return true;
      } catch (e) { return false; }
    };

    // ① 原文：优先复用合并时已确认准确的标记区间（与橙色高亮完全一致），
    //    细粒度化后一条目对应多个子标记，取整体区间；未合并成功的条目才重新走五级候选匹配
    let rngO = null;
    if (problem) {
      const r = cmpProblemMarkRange(cmp.origMarks, problem);
      if (r) rngO = { start: r.start, end: r.end, score: 1, mode: 'mark' };
    }
    if (!rngO) rngO = cmpFindRange(o.value, locateField);
    if (rngO) {
      o.focus();
      try { o.setSelectionRange(rngO.start, rngO.end); } catch (e) { /* 忽略 */ }
      scrollToOffset(o, cmp.origMirror, rngO.start); // Range 量测精确滚动
      ok = true;
      if (rngO.mode === 'mark' || rngO.score >= 0.5) {
        showToast('✅ 已定位到原文' + (rngO.mode === 'mark' ? '（合并标记位置）' :
          rngO.mode === 'exact' ? '' : '（相似匹配 ' + Math.round(rngO.score * 100) + '%）'));
      } else {
        showToast('⚠️ 相似度较低（' + Math.round(rngO.score * 100) + '%），已滚动到最接近位置，请人工核对');
      }
    } else {
      // 完全无候选：输出诊断（控制台可见原文定位字段与原文开头），方便反馈修复
      showToast('⚠️ 原文中未找到该原文定位内容（诊断已输出到控制台 F12）');
      try {
        console.warn('[QC 对比区定位失败] 原文定位字段(' + String(locateField || '').length + '字):',
          String(locateField || '').slice(0, 300));
        console.warn('[QC 对比区定位失败] 原文(' + (o.value || '').length + '字) 开头500字:', (o.value || '').slice(0, 500));
      } catch (e) { /* 忽略 */ }
    }
    // ② 修改后：同样优先用合并标记（黄色高亮与滚动位置同源）；
    //    手动改过文本导致标记丢失时按 fix 内容重新定位
    if (m) {
      // 细粒度标记：一条目多个子标记，取整体区间做选中与滚动
      const rngMarks = problem ? cmpProblemMarkRange(cmp.mergedMarks, problem) : null;
      // 兜底重定位时带上顺序提示：该条之前的条目标记结束处之后才开始找，
      // 相同内容的修改方式不会都匹配到第一处
      let mHint = 0;
      if (problem && !rngMarks) {
        const pOrder = lastProblems.indexOf(problem);
        for (let i = pOrder - 1; i >= 0; i--) {
          const prev = cmpProblemMarkRange(cmp.mergedMarks, lastProblems[i]);
          if (prev) { mHint = prev.end; break; }
        }
      }
      const rngM = rngMarks || (problem ? cmpFindRange(m.value, problem.fix, mHint) : null);
      if (rngM) {
        try { m.setSelectionRange(rngM.start, rngM.end); } catch (e) { /* 忽略 */ }
        scrollToOffset(m, cmp.mirror, rngM.start); // Range 量测精确滚动
        ok = true;
      } else if (rngO) {
        // 修改后里找不到（可能被手动改掉）：按原文当前位置的滚动比例联动，保持两侧对齐
        const maxO = o.scrollHeight - o.clientHeight;
        const maxM = m.scrollHeight - m.clientHeight;
        m.scrollTop = maxO > 0 ? Math.round((o.scrollTop / maxO) * maxM) : 0;
        if (cmp.mirror) cmp.mirror.scrollTop = m.scrollTop;
        if (cmp.hl) cmp.hl.scrollTop = m.scrollTop;
      }
    }
    return ok;
  }

  // 卡片「修改方式」编辑保存后同步：修改后文本 = 原文 + 各条修改方式 的合并产物，
  // 用 force=true 强制重算（覆盖修改后 textarea 的手工改动）。
  // 不要求 compareOpen：对比区收起时也要把新合并文本写进 textarea，
  // 用户重开对比区即可看到最新结果，不会丢失卡片编辑
  function cmpSyncFixChange() {
    if (!cmp.modTa) return; // 对比区从未构建过：p.fix 已更新，下次打开会重算，这里不强行建
    if (cmpEditMode) cmpSetEditMode(false); // 卡片修改方式已更新：退出编辑态，重算合并覆盖
    cmpRebuildMerged(true);
  }

  // ── 「修改后」编辑态：默认只读，点「编辑」解锁；编辑中仅 保存/取消（参照「修改方式」就地编辑）──
  // 编辑期间标记照常由 cmpApplyEditDelta 增量维护；「取消」整体回滚文本与标记
  function cmpSetEditMode(on) {
    if (!cmp.modTa) return;
    if (on) {
      if (cmpEditMode) return;
      cmpEditBackup = {
        text: cmp.modTa.value,
        mergedMarks: cmp.mergedMarks.map((mk) => ({ start: mk.start, end: mk.end, p: mk.p, t: mk.t })),
        lastMerged: cmp.lastMerged,
        lastModText: cmp.lastModText
      };
      cmpEditMode = true;
      qcTrack('对比区编辑', { result: 'start' });
    } else {
      cmpEditMode = false;
      cmpEditBackup = null;
    }
    cmp.modTa.readOnly = !cmpEditMode;
    if (cmp.btnCopy) cmp.btnCopy.style.display = cmpEditMode ? 'none' : '';
    if (cmp.btnEdit) cmp.btnEdit.style.display = cmpEditMode ? 'none' : '';
    if (cmp.btnFmt) cmp.btnFmt.style.display = cmpEditMode ? 'none' : '';
    if (cmp.btnSave) cmp.btnSave.style.display = cmpEditMode ? '' : 'none';
    if (cmp.btnCancel) cmp.btnCancel.style.display = cmpEditMode ? '' : 'none';
    if (cmp.modLbl) cmp.modLbl.textContent = cmpEditMode
      ? '✏️ 修改后（编辑中：保存后生效，「取消」回滚）'
      : '✏️ 修改后（黄色=替换内容，只读·点「编辑」修改）';
  }

  function cmpSaveEdit() {
    if (!cmpEditMode) return;
    cmpSetEditMode(false);
    cmpSetStatus('✅ 修改后内容已保存', 'ok');
    showToast('✅ 已保存');
    qcTrack('对比区编辑', { result: 'success', len: ((cmp.modTa && cmp.modTa.value) || '').length });
  }

  function cmpCancelEdit() {
    if (!cmpEditMode) return;
    const bk = cmpEditBackup;
    cmpSetEditMode(false);
    if (!bk || !cmp.modTa) return;
    cmp.modTa.value = bk.text;
    cmp.mergedMarks = bk.mergedMarks;
    cmp.lastMerged = bk.lastMerged;
    cmpRepaintModMirror(); // 重绘镜像+高亮，并把 cmp.lastModText 同步为恢复后的文本（增量基准归位）
    showToast('已取消编辑，恢复到编辑前内容');
    qcTrack('对比区编辑', { result: 'cancel' });
  }

  // ══════════════════════════════════════════
  // 「格式优化」：convert.py（Markdown 启发式修复）的 JS 移植
  // ══════════════════════════════════════════
  // 管线与 Python 版一致：repair_markdown → clean_dirty_symbols → fix_markdown
  //   → txt_to_markdown，迭代至稳定（最多 3 轮）。仅调整「修改后」文本格式，
  //   不改语义；黄色高亮（mergedMarks）经 cmpBuildCharMap 行级 LCS 字符映射重映射保留，
  //   原文列（origMarks/原文文本）不受影响。

  function fmtNormalize(t) { return t.replace(/\r\n/g, '\n').replace(/\r/g, '\n'); }
  // JS 的 string.replace 只换第一处，用 split/join 实现 Python 的全量替换
  function fmtReplAll(s, from, to) { return s.split(from).join(to); }
  // 单元格是否为分隔行单元格（空串或仅 - : 组成）
  function fmtIsSepCellStrict(c) { return c === '' || /^[-:]*$/.test(c); }
  function fmtIsSepCellSp(c) { return /^[-: ]*$/.test(c); }
  function fmtIsSepCells(cells) { return cells.every(fmtIsSepCellSp); }

  function fmtLooksLikeHeading(line) {
    const s = line.trim();
    if (!s || s.length > 40) return false;
    if (/^[-*+•·>]/.test(s)) return false;
    if (/^\d/.test(s) && (s.includes('. ') || s.includes('、') || s.includes(') '))) return false;
    const last = s[s.length - 1];
    if ('。.，,；;：:!！?？…·-—()（）"“”{}'.includes(last)) return false;
    if (s.includes(':') && (s.includes('"') || s.endsWith('{') || s.endsWith('}'))) return false;
    for (const mk of ['#', '|', '```', '**', '[', ']']) if (s.includes(mk)) return false;
    return true;
  }

  // 从 lines[i] 起收集连续的 | 行 / \t 行重建表格；返回 { table, next } 或 null
  function fmtToTable(lines, i) {
    let cols = null;
    const rows = [];
    let j = i;
    while (j < lines.length) {
      const ln = lines[j].trim();
      if (!ln) break;
      let cells;
      if (ln.includes('\t')) {
        cells = ln.split('\t').map((c) => c.trim());
      } else if (ln.startsWith('|') && ln.endsWith('|') && (ln.match(/\|/g) || []).length >= 2) {
        cells = ln.slice(1, -1).split('|').map((c) => c.trim());
      } else break;
      if (cells.length && cells.every(fmtIsSepCellStrict)) { j++; continue; }
      if (cols === null) cols = cells.length;
      else if (cells.length !== cols) break;
      rows.push(cells);
      j++;
    }
    if (cols === null || rows.length < 2) return null;
    const out = ['| ' + rows[0].join(' | ') + ' |',
      '| ' + Array(cols).fill('---').join(' | ') + ' |'];
    for (let k = 1; k < rows.length; k++) out.push('| ' + rows[k].join(' | ') + ' |');
    return { table: out.join('\n'), next: j };
  }

  function fmtSepRow(ln) {
    const body = ln.trim();
    if (!(body.startsWith('|') && body.endsWith('|'))) return false;
    const cells = body.slice(1, -1).split('|');
    return cells.length > 0 && cells.every(fmtIsSepCellSp);
  }

  function fmtNormTableRegion(rows) {
    const parsed = rows.map((r) => r.trim().replace(/^\|+/, '').replace(/\|+$/, '')
      .split('|').map((c) => c.trim()));
    const data = parsed.filter((c) => !fmtIsSepCells(c));
    const colmax = data.reduce((m, c) => Math.max(m, c.length), 0);
    if (colmax < 2) return null;
    const sepRow = '| ' + Array(colmax).fill('---').join(' | ') + ' |';
    const out = [];
    let seen = false;
    for (const cells of parsed) {
      if (fmtIsSepCells(cells)) {
        if (seen && (!out.length || out[out.length - 1] !== sepRow)) out.push(sepRow);
        else if (!seen) out.push(sepRow);
        continue;
      }
      const pad = cells.concat(Array(colmax).fill('')).slice(0, colmax);
      out.push('| ' + pad.join(' | ') + ' |');
      seen = true;
    }
    return out;
  }

  function fmtIsCleanTable(region) {
    if (!region || !region.every((r) => r.startsWith('|') && r.endsWith('|'))) return false;
    if (new Set(region.map((r) => (r.match(/\|/g) || []).length)).size !== 1) return false;
    for (const r of region) {
      const cells = r.slice(1, -1).split('|').map((c) => c.trim());
      if (fmtIsSepCells(cells) && !cells.filter((c) => c !== '').every(fmtIsSepCellStrict)) return false;
    }
    return true;
  }

  function fmtLastDataRow(region) {
    for (let idx = region.length - 1; idx >= 0; idx--) {
      if (region[idx].startsWith('|') && !fmtSepRow(region[idx])) return idx;
    }
    return -1;
  }

  function fmtRepairTables(text) {
    const lines = text.split('\n');
    const out = [];
    let i = 0;
    const n = lines.length;
    while (i < n) {
      const s = lines[i].trim();
      if (s.includes('|') && s.startsWith('|')) {
        const region = [];
        let j = i, prevCont = false, blank = false;
        while (j < n) {
          const lj = lines[j].trim();
          if (!lj) { blank = true; j++; continue; }
          if (lj.startsWith('|')) {
            if (blank && !prevCont) break;
            region.push(lj);
            prevCont = fmtIsSepCells(lj.slice(1, -1).split('|').map((c) => c.trim()));
            blank = false; j++; continue;
          }
          if (lj.startsWith('-') && /^[-|: ]*$/.test(lj)) {
            region.push('| --- |'); prevCont = true; blank = false; j++; continue;
          }
          const isCont = (lj.endsWith('|') && !lj.startsWith('|') && !lj.startsWith('- ')
              && !lj.startsWith('* ') && !lj.startsWith('+ ')) || lj.startsWith('、');
          if (isCont) {
            const content = lj.replace(/\|+$/, '').trim();
            const didx = fmtLastDataRow(region);
            if (didx >= 0) region[didx] = region[didx].slice(0, -1).replace(/\s+$/, '') + ' ' + content + ' |';
            else region.push('| ' + content + ' |');
            prevCont = true; blank = false; j++; continue;
          }
          break;
        }
        if (fmtIsCleanTable(region)) { for (const r of region) out.push(r); i = j; continue; }
        const built = fmtNormTableRegion(region);
        if (built && built.length) { for (const r of built) out.push(r); i = j; continue; }
      }
      out.push(lines[i]);
      i++;
    }
    return out.join('\n');
  }

  function fmtRepairMarkdown(text) {
    text = fmtReplAll(fmtReplAll(fmtReplAll(text, '\\n', '\n'), '\\r', '\n'), '\\"', '"');
    text = fmtReplAll(text, '\\t', ' ');
    text = fmtRepairTables(text);
    const cleaned = [];
    for (const ln of text.split('\n')) {
      const s = ln.trim();
      if (/^#{1,6}$/.test(s)) { cleaned.push('---'); continue; }
      if (['-', '|', '- |', '| -', '---', '>'].includes(s)) { cleaned.push('---'); continue; }
      if (s.length >= 2 && fmtIsSepCellSp(s)) { cleaned.push('---'); continue; }
      cleaned.push(ln);
    }
    return cleaned.join('\n');
  }

  function fmtCleanDirty(text) {
    const out = [];
    for (let s of text.split('\n')) {
      s = s.replace(/^(\s*[-*+]\s*)\[[ xX]\]\s*/, '$1');
      s = s.replace(/^」/, '');
      s = fmtReplAll(s, '**」', '**');
      s = s.replace(/^#\s*(\|)/, '$1');
      // □/☐/� 及私用区字符（U+E000-U+F8FF）是 PDF/Word/图标字体复制残留的乱码方块，
      // 按脏数据从行内删除；如只需删 □，把字符类改为 /[□]/g 即可
      s = s.replace(/[\u25a1\u2610\ufffd\uE000-\uF8FF]/g, ''); // 乱码方块/私用区脏字符
      const t = s.trim();
      if (t && /^[；;。，,、：:?？!！…·—・]*$/.test(t)) continue;
      if (s.startsWith('、') && out.length && out[out.length - 1].trim()
          && out[out.length - 1].trim() !== '|') {
        out[out.length - 1] = out[out.length - 1].replace(/\s+$/, '') + s;
        continue;
      }
      out.push(s);
    }
    const result = [];
    for (const ln of out) {
      if (fmtSepRow(ln) && result.length && fmtSepRow(result[result.length - 1])) continue;
      result.push(ln);
    }
    return result.join('\n');
  }

  function fmtFixMarkdown(md) {
    let text = fmtNormalize(md);
    text = text.replace(/^(#{1,6})[ \t]{2,}(?=\S)/gm, '$1 ');
    text = text.replace(/^([ \t]*)(#{1,6})([^\s#])/gm, '$1$2 $3');
    text = text.replace(/^(\s*)[*•·]\s+(?=\S)/gm, '$1- ');
    text = text.replace(/^(\s*)(\d+)\s*[)、(）)][ \t]*(?=\S)/gm, '$1$2. ');
    text = text.replace(/^(\s*)([-+*])(?=[^\s\-+*])/gm, '$1$2 ');
    text = fmtReplAll(fmtReplAll(fmtReplAll(fmtReplAll(fmtReplAll(fmtReplAll(text,
      '** ', '**'), ' **', '**'), '__ ', '__'), ' __', '__'), '**　', '**'), '　**', '**');
    text = text.replace(/\[\s*([^\]\n]+?)\s*\]\s*\(\s*([^)\n]+?)\s*\)/g,
      (m, a, b) => '[' + a.trim() + '](' + b.trim() + ')');
    let fences = 0;
    for (const ln of text.split('\n')) if (ln.trim().startsWith('```')) fences++;
    if (fences % 2 === 1) text = text.replace(/\s+$/, '') + '\n```\n';
    text = text.replace(/^```[ \t]+(?=\S)/gm, '``` ');
    text = text.replace(/\n{3,}/g, '\n\n');
    text = text.split('\n').map((l) => l.replace(/\s+$/, '')).join('\n');
    return text.replace(/^\s+|\s+$/g, '') + '\n';
  }

  function fmtStripLines(text) {
    return fmtNormalize(text).split('\n').map((l) => l.replace(/\s+$/, ''));
  }

  function fmtTxtToMarkdown(text) {
    const lines = fmtStripLines(text);
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const ln = lines[i].trim();
      if (!ln) {
        if (out.length && out[out.length - 1] !== '') out.push('');
        i++; continue;
      }
      if (ln.length >= 3 && /^[-=*_~ ]*$/.test(ln)
          && (ln.match(/-/g) || []).length >= 3 && !ln.startsWith('```')) {
        if (out.length && out[out.length - 1] !== '') out.push('');
        out.push('---'); out.push('');
        i++; continue;
      }
      if (ln.startsWith('|') && ln.endsWith('|') && (ln.match(/\|/g) || []).length >= 2) {
        const region = [];
        let j = i;
        while (j < lines.length) {
          const t = lines[j].trim();
          if (t.startsWith('|') && t.endsWith('|')) { region.push(t); j++; } else break;
        }
        if (region.length >= 2 && fmtIsCleanTable(region)) {
          if (out.length && out[out.length - 1] !== '') out.push('');
          for (const r of region) out.push(r);
          out.push('');
          i = j; continue;
        }
      }
      const tbl = fmtToTable(lines, i);
      if (tbl !== null) {
        if (out.length && out[out.length - 1] !== '') out.push('');
        out.push(tbl.table); out.push('');
        i = tbl.next; continue;
      }
      if (ln.startsWith('```')) { out.push(ln); i++; continue; }
      let m = ln.match(/^(\d{1,3})[.、)）][ \t]*(.+)$/);
      if (m && m[2]) { out.push(m[1] + '. ' + m[2]); i++; continue; }
      m = ln.match(/^(?:[-+•·]|\* )[ \t]*(.+)$/);
      if (m && m[1]) { out.push('- ' + m[1]); i++; continue; }
      m = ln.match(/^([^：:]{1,20})\s*[：:]\s*(.+)$/);
      if (m && m[2] && !/^http/.test(m[1]) && !m[1].startsWith('#')
          && !/[*#[\]`~_|<>!]/.test(m[1])) {
        out.push('**' + m[1] + '**：' + m[2]);
        i++; continue;
      }
      if (fmtLooksLikeHeading(ln)) {
        const prevBlank = (i === 0) || !lines[i - 1].trim();
        const nextBlank = (i === lines.length - 1) || !lines[i + 1].trim();
        if (prevBlank || nextBlank) {
          if (out.length && out[out.length - 1] !== '') out.push('');
          out.push('### ' + ln); out.push('');
          i++; continue;
        }
      }
      out.push(ln);
      i++;
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '') + '\n';
  }

  function fmtRunOnce(text) {
    let t = fmtRepairMarkdown(text);
    t = fmtCleanDirty(t);
    t = fmtFixMarkdown(t);
    t = fmtTxtToMarkdown(t);
    return t.replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '') + '\n';
  }

  // 与 convert.py smart_process 一致：迭代至稳定（最多 3 轮）
  function fmtSmartProcess(text) {
    let result = fmtRunOnce(text);
    for (let k = 0; k < 3; k++) {
      const nxt = fmtRunOnce(result);
      if (nxt === result) break;
      result = nxt;
    }
    return result;
  }

  // ── 高亮保留：行单元（含行尾换行）LCS 对齐 → 旧偏移→新偏移映射（0..oldLen 全覆盖、单调）──
  function cmpLineUnits(t) {
    const ls = t.split('\n');
    return ls.map((l, k) => (k < ls.length - 1 ? l + '\n' : l));
  }

  function cmpBuildCharMap(oldT, newT) {
    const oU = cmpLineUnits(oldT);
    const nU = cmpLineUnits(newT);
    const A = oU.length, B = nU.length;
    const oS = [0], nS = [0];
    for (let k = 0; k < A; k++) oS.push(oS[k] + oU[k].length);
    for (let k = 0; k < B; k++) nS.push(nS[k] + nU[k].length);
    const map = new Array(oldT.length + 1);
    const matches = [];
    if (A * B <= 4000000) {
      const W = B + 1;
      const dp = new Int32Array((A + 1) * W);
      for (let i2 = A - 1; i2 >= 0; i2--) {
        for (let j2 = B - 1; j2 >= 0; j2--) {
          dp[i2 * W + j2] = oU[i2] === nU[j2]
            ? dp[(i2 + 1) * W + j2 + 1] + 1
            : Math.max(dp[(i2 + 1) * W + j2], dp[i2 * W + j2 + 1]);
        }
      }
      let i2 = 0, j2 = 0;
      while (i2 < A && j2 < B) {
        if (oU[i2] === nU[j2]) { matches.push([i2, j2]); i2++; j2++; }
        else if (dp[(i2 + 1) * W + j2] >= dp[i2 * W + j2 + 1]) i2++;
        else j2++;
      }
    }
    // 未匹配行组：整组字符串按公共前缀/后缀对齐，被删内容映射到改动核心起点
    const emitGap = (oFrom, oTo, nFrom, nTo) => {
      if (oFrom >= oTo && nFrom >= nTo) return;
      const go = oldT.slice(oS[oFrom], oS[oTo]);
      const gn = newT.slice(nS[nFrom], nS[nTo]);
      const lo = go.length, lnn = gn.length;
      const minL = Math.min(lo, lnn);
      let p = 0;
      while (p < minL && go[p] === gn[p]) p++;
      let sf = 0;
      while (sf < minL - p && go[lo - 1 - sf] === gn[lnn - 1 - sf]) sf++;
      for (let k = 0; k < p; k++) map[oS[oFrom] + k] = nS[nFrom] + k;
      for (let k = p; k < lo - sf; k++) map[oS[oFrom] + k] = nS[nFrom] + p;
      for (let k = 0; k < sf; k++) map[oS[oFrom] + lo - sf + k] = nS[nFrom] + lnn - sf + k;
      if (oTo <= A) map[oS[oTo]] = nS[nTo];
    };
    let oi = 0, ni = 0;
    for (const pr of matches) {
      if (pr[0] > oi || pr[1] > ni) emitGap(oi, pr[0], ni, pr[1]);
      for (let k = 0; k < oU[pr[0]].length; k++) map[oS[pr[0]] + k] = nS[pr[1]] + k;
      map[oS[pr[0]] + oU[pr[0]].length] = nS[pr[1]] + oU[pr[0]].length;
      oi = pr[0] + 1; ni = pr[1] + 1;
    }
    if (oi < A || ni < B) emitGap(oi, A, ni, B);
    let last = 0;
    for (let k = 0; k <= oldT.length; k++) {
      const v = map[k];
      if (typeof v === 'number' && v >= 0) last = v;
      else map[k] = last;
    }
    for (let k = 1; k <= oldT.length; k++) if (map[k] < map[k - 1]) map[k] = map[k - 1];
    map[oldT.length] = newT.length;
    return map;
  }

  // 区间端点过映射；防退化：原区间非空则至少保留 1 字高亮
  function cmpRemapRange(r, map, newLen) {
    let ns = map[Math.max(0, Math.min(r.s, map.length - 1))];
    let ne = map[Math.max(0, Math.min(r.e, map.length - 1))];
    if (ne < ns) { const tmp = ns; ns = ne; ne = tmp; }
    ns = Math.max(0, Math.min(ns, newLen));
    ne = Math.max(0, Math.min(ne, newLen));
    if (ne <= ns && r.e > r.s) ne = Math.min(newLen, ns + 1);
    return { s: ns, e: ne };
  }

  // ⚡ 格式优化：按 convert.py 规则优化「修改后」格式，重映射黄色高亮（mergedMarks）
  // 原文列（origMarks）坐标在原文文本上，不受修改后格式化影响，无需处理
  function cmpFormatOptimize() {
    if (!cmp.modTa) return;
    const before = cmp.modTa.value;
    if (!before || !before.trim()) { showToast('⚠️ 修改后暂无内容'); return; }
    if (cmpEditMode) { showToast('⚠️ 编辑中请先保存或取消'); return; }
    const after = fmtSmartProcess(before);
    if (after === before) { showToast('✅ 格式已规范，无需优化'); return; }
    const map = cmpBuildCharMap(before, after);
    cmp.mergedMarks = cmp.mergedMarks
      .map((mk) => {
        const nr = cmpRemapRange({ s: mk.start, e: mk.end }, map, after.length);
        // 自检基准 t：映射后内容与原标记内容一致才保留，否则弃用（保证数据抽样自检不误报）
        const nt = after.slice(nr.s, nr.e);
        return { start: nr.s, end: nr.e, p: mk.p,
          t: (typeof mk.t === 'string' && nt === mk.t) ? mk.t : undefined };
      })
      .filter((mk) => mk.end > mk.start);
    cmp.modTa.value = after;
    cmpRepaintModMirror(); // 重绘镜像+高亮，cmp.lastModText 同步为新文本（编辑增量基准）
    cmpSetStatus('⚡ 格式优化完成 · ' + before.length + ' 字 → ' + after.length +
      ' 字（黄色高亮已按新位置保留）', 'ok');
    showToast('⚡ 已按 Markdown 规范优化格式，高亮已保留');
    qcTrack('对比区格式优化', { result: 'success', before: before.length, after: after.length });
  }

  // 面板关闭后重新打开时，输入框里的提示词已不在内存中——
  // 改从 Agent 聊天区读取最后一条「用户发出的气泡」文本（即用户发送的提示词，
  // 含质检规则原文）作为质检点/业务线识别的权威来源
  function lastUserBubbleText() {
    try {
      const bubbles = document.querySelectorAll('[class*="messagesArea"] [class*="messageBubbleUser"]');
      if (!bubbles.length) return '';
      return (bubbles[bubbles.length - 1].textContent || '').trim();
    } catch (e) { return ''; }
  }

  function createPanel(content) {
    if (highlightCleanup) { highlightCleanup(); highlightCleanup = null; }
    if (panelEl) panelEl.remove();

    lastExtracted = content;
    lastProblems = structureProblems(content, lastUserBubbleText());

    const panel = document.createElement('div');
    panel.id = 'qc-panel';
    Object.assign(panel.style, {
      position: 'fixed', top: '0', right: '0', bottom: '0',
      width: 'min(560px, 72vw)',
      background: '#f4f6f9', boxShadow: '-4px 0 24px rgba(0,0,0,0.18)',
      zIndex: '99999', display: 'flex', flexDirection: 'row',
      fontFamily: FONT,
      animation: 'qcSlideLeft 0.25s ease'
    });

    // ── 头部 ──
    const head = document.createElement('div');
    head.style.cssText = 'flex-shrink:0;background:linear-gradient(135deg,#1a73e8,#1557b0);color:#fff;' +
      'padding:12px 14px;border-top-left-radius:10px;box-shadow:0 1px 4px rgba(0,0,0,0.1)';

    const topRow = document.createElement('div');
    topRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px';

    const title = document.createElement('span');
    title.id = 'qc-panel-title';
    title.style.cssText = 'font-weight:700;font-size:15px;color:#fff;flex:1';
    title.textContent = '🤖 质检助手 v5.4.8'; // 版本号入 UI：重载插件后打开面板即可肉眼确认新旧代码

    const actions = document.createElement('div');
    actions.id = 'qc-panel-actions';
    actions.style.cssText = 'display:flex;gap:6px;flex-shrink:0';

    const collapseBtn = document.createElement('button');
    collapseBtn.textContent = '▶';
    collapseBtn.className = 'qc-toolbar-btn';
    collapseBtn.title = '收起/展开（查看完整页面）';
    collapseBtn.addEventListener('click', () => setPanelCollapsed(!panelCollapsed, collapseBtn));

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.className = 'qc-toolbar-btn qc-close-btn';
    closeBtn.title = '关闭';
    closeBtn.addEventListener('click', closePanel);

    actions.appendChild(collapseBtn);
    actions.appendChild(closeBtn);

    // 拖拽抓手（纯视觉，可按住头部任意空白处拖动整个悬浮窗）
    const grip = document.createElement('span');
    grip.textContent = '⠿';
    grip.style.cssText = 'cursor:grab;margin-right:6px;opacity:0.9;flex-shrink:0;font-size:14px';
    grip.title = '按住头部空白处可拖拽移动；拖动右下角可缩放';
    topRow.appendChild(grip);

    topRow.appendChild(title);
    topRow.appendChild(actions);
    head.appendChild(topRow);
    // 按住头部（除按钮/输入框/Tab 外）拖动整个悬浮窗
    head.addEventListener('pointerdown', startPanelDrag);

    // ── 正文 ──
    const body = document.createElement('div');
    body.id = 'qc-panel-body';
    body.style.cssText = 'flex:1;overflow:auto;padding:14px 14px 24px;box-sizing:border-box';

    // ── 左侧原文对比扩展区（默认收起）+ 右侧主列（头/Tab/正文）──
    panel.appendChild(buildCompareWrap());
    const mainCol = document.createElement('div');
    mainCol.id = 'qc-main-col';
    panel.appendChild(mainCol);

    mainCol.appendChild(head);

    // ── 模式切换 Tab 条（A 对话优化 / C 评测集生成）──
    const modeBar = document.createElement('div');
    modeBar.id = 'qc-mode-bar';
    [['A', '💬 规则优化'], ['C', '🎯 评测集生成']].forEach(([name, label]) => {
      const t = document.createElement('button');
      t.className = 'qc-mode-tab' + (panelMode === name ? ' active' : '');
      t.textContent = label;
      t.addEventListener('click', () => switchPanelMode(name));
      modeBar.appendChild(t);
    });
    mainCol.appendChild(modeBar);

    mainCol.appendChild(body);

    // ── 左缘扩展箭头：展开/收起原文对比区 ──
    const cmpTab = document.createElement('button');
    cmpTab.id = 'qc-compare-tab';
    cmpTab.type = 'button';
    cmpTab.textContent = '⇤ 原文对比';
    cmpTab.title = '展开原文对比区（规则原文 vs 修改后）';
    cmpTab.addEventListener('click', () => setCompareOpen(!compareOpen));
    panel.appendChild(cmpTab);

    // ── 右下角缩放手柄：拖拽可调整宽度/高度 ──
    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'qc-resize-handle';
    resizeHandle.style.cssText = 'position:absolute;right:0;bottom:0;width:16px;height:16px;' +
      'cursor:nwse-resize;z-index:3;background:linear-gradient(135deg,transparent 50%,rgba(0,0,0,0.28) 50%);' +
      'border-bottom-right-radius:10px';
    resizeHandle.title = '拖拽缩放';
    resizeHandle.addEventListener('pointerdown', startPanelResize);
    panel.appendChild(resizeHandle);

    document.body.appendChild(panel);
    panelEl = panel;
    panelCollapsed = false;
    compareOpen = false; // 面板重建后对比区默认收起（tab 文案/面板宽度状态保持一致）
    // 清掉上一轮面板残留的标记/快照状态（原文 cmp.original 与 autoKey 保留，
    // 下次展开时按当前 lastProblems 重新合并，避免旧标记配到新 textarea 的内容上造成偏移）
    cmp.mergedMarks = [];
    cmp.origMarks = [];
    cmp.lastMerged = '';
    cmp.lastModText = '';

    const bodyEl = panel.querySelector('#qc-panel-body');
    if (bodyEl) renderBody(bodyEl); // 初始渲染（按当前模式分派）
    document.addEventListener('keydown', escHandler);
  }

  function closePanel() {
    if (highlightCleanup) { highlightCleanup(); highlightCleanup = null; }
    if (panelEl) { panelEl.remove(); panelEl = null; }
    userDismissed = true;
    panelCollapsed = false;
    document.removeEventListener('keydown', escHandler);
  }

  function escHandler(e) { if (e.key === 'Escape') closePanel(); }

  // 首次拖动时把「右侧停靠」的侧栏转换为「自由浮动」定位，之后跟随鼠标移动
  function startPanelDrag(e) {
    const panel = panelEl;
    if (!panel || e.button !== 0) return;
    // 不拦截按钮/输入框/Tab/对比区等交互元素
    if (e.target.closest && e.target.closest('button, input, select, textarea, .qc-mode-tab, #qc-compare-wrap')) return;
    const isFloating = panel.dataset.floatMode === '1';
    if (!isFloating) {
      const r = panel.getBoundingClientRect();
      Object.assign(panel.style, {
        left: r.left + 'px', top: r.top + 'px',
        width: r.width + 'px', height: r.height + 'px',
        right: 'auto', bottom: 'auto'
      });
      panel.dataset.floatMode = '1';
      panel.style.boxShadow = '0 14px 44px rgba(0,0,0,0.35)';
      panel.style.animation = 'none';
    }
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const stRect = panel.getBoundingClientRect();
    const baseL = stRect.left, baseT = stRect.top;
    const vw = window.innerWidth, vh = window.innerHeight;
    function move(ev) {
      const r = panel.getBoundingClientRect();
      const nl = Math.min(Math.max(baseL + (ev.clientX - startX), 0), vw - r.width);
      const nt = Math.min(Math.max(baseT + (ev.clientY - startY), 0), vh - r.height);
      panel.style.left = nl + 'px';
      panel.style.top = nt + 'px';
    }
    function up() {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
    }
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }

  // 缩放：改变宽度，浮动模式下同时改变高度；记住自定义宽度供展开时复用
  function startPanelResize(e) {
    const panel = panelEl;
    if (!panel || e.button !== 0) return;
    const isFloating = panel.dataset.floatMode === '1';
    if (!isFloating) {
      const r = panel.getBoundingClientRect();
      Object.assign(panel.style, {
        left: r.left + 'px', top: r.top + 'px',
        width: r.width + 'px', height: r.height + 'px',
        right: 'auto', bottom: 'auto'
      });
      panel.dataset.floatMode = '1';
    }
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX, startY = e.clientY;
    const r = panel.getBoundingClientRect();
    const startW = r.width, startH = r.height;
    const minW = 300, minH = 200, maxW = window.innerWidth - 24;
    function move(ev) {
      const nw = Math.min(Math.max(startW + (ev.clientX - startX), minW), maxW);
      const nh = Math.max(startH + (ev.clientY - startY), minH);
      panel.style.width = nw + 'px';
      panel._w = nw + 'px';
      if (panel.dataset.floatMode === '1') {
        panel.style.height = nh + 'px';
        panel._h = nh + 'px';
      }
    }
    function up() {
      panel._w = panel.style.width;
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
    }
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }

  function extractAndShow() {
    userDismissed = false;
    const t0 = Date.now();
    const result = extractResult();
    if (!result) {
      // 页面无「## 优化结果」时也打开面板，确保「质检点详情」模式始终可达（不再"打不开"）
      if (!panelEl) createPanel('');
      showToast('当前页面未检测到「## 优化结果」');
      return;
    }
    if (result === lastExtracted && panelEl) return;
    createPanel(result);
    qcTrack('feature/extract', { result: 'success', reply_len: result.length, duration_ms: Date.now() - t0 });
  }

  // ══════════════════════════════════════════
  // 7. 自动检测 + 快捷键 + 启动
  // ══════════════════════════════════════════
  let observerStarted = false; // 防止重复挂载 MutationObserver
  function startObserver() {
    if (observerStarted) return;
    observerStarted = true;
    let debounceTimer = null;
    const observer = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (userDismissed) return;
        const result = extractResult();
        if (!result) return;
        if (!panelEl) createPanel(result);
      }, 3000);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  // 确保悬浮按钮存在（SVG/懒加载/页面重渲染导致丢失时自动重建）。
  // 以「主按钮 qc-extract-btn」为唯一判断依据：丢失即重建（配合每 4 秒自愈）。
  function ensureFloatButton() {
    if (!document.getElementById('qc-extract-btn')) createFloatButton();
    if (!observerStarted) startObserver();
  }

  // 手动重启：悬浮按钮未加载/丢失时，无需刷新页面即重建（保留面板与已提取数据）
  function manualRestart() {
    ensureFloatButton();
    showToast('✅ 质检助手已手动重启');
    console.log('[QC 提取器] 手动重启完成：悬浮按钮 + 自动检测已重建');
  }

  // 全量重置（隐藏快捷键 Ctrl+Shift+F 触发，无悬浮按钮时使用）：无需刷新网页。
  // 重建悬浮按钮/观察器，并用当前 DOM 重新提取、刷新面板，保证拿到最新页面内容且数据不丢。
  function refreshPlugin() {
    if (!document.getElementById('qc-extract-btn')) createFloatButton();
    ensureFloatButton();
    // 用当前 DOM 重新提取并刷新面板
    userDismissed = false;
    const result = extractResult();
    if (result) createPanel(result);
    else if (!panelEl) createPanel('');
    showToast('⟳ 插件已刷新（未刷新网页）');
    console.log('[QC 提取器] 已全量重置：悬浮按钮/自动检测已重建，面板已刷新');
  }

  // 自愈：定时检查，按钮丢失/观察器未挂载时自动重建（用户无需手动刷新）
  let healTimer = null;
  function startSelfHeal() {
    if (healTimer) return;
    healTimer = setInterval(ensureFloatButton, 4000);
  }

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'E') { e.preventDefault(); extractAndShow(); }
    // Ctrl+Shift+F：刷新插件（当按钮未加载出来时使用，避免刷新网页丢失数据）
    if (e.ctrlKey && e.shiftKey && e.key === 'F') { e.preventDefault(); refreshPlugin(); }
  });

  // 工具栏图标（地址栏旁）点击触发的刷新：重建悬浮按钮 + 重新提取，无需刷新网页。
  // 由 background 的 chrome.action.onClicked 发 QC_REFRESH 消息到此页签。
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'QC_REFRESH') {
      try {
        refreshPlugin();
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    }
  });

  // ══════════════════════════════════════════
  // ══════════════════════════════════════════

  function init() {
    // 注入高亮脉冲动画
    if (!document.getElementById('qc-anim-style')) {
      const st = document.createElement('style');
      st.id = 'qc-anim-style';
      st.textContent = '@keyframes qcPulse{0%,100%{opacity:.5}50%{opacity:1}}' +
        '@keyframes qcSlideLeft{from{opacity:0;transform:translateX(40px)}to{opacity:1;transform:translateX(0)}}';
      document.head.appendChild(st);
    }
    ensureFloatButton();
    startSelfHeal();
    console.log('[QC 提取器 v5.4.8-keephl] 已就绪');
  }


  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

