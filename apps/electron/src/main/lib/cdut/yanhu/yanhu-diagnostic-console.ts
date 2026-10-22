/**
/**
 * 智联万站 · 最底层实时运行诊断控制台（YanhuDiagnosticConsole）
 *
 * 聚合方案：
 *   - 方法 2：捕获 WebContents 原生控制台（console.log / warn / error）、子框架加载失败（did-fail-load）、
 *             渲染进程状态（render-process-gone）与导航生命周期；
 *   - 方法 4：实时网络报文链路流（webRequest 请求/响应/状态码/请求头/Cookie/报错）+ Chromium NetLog 落盘；
 *   - 单一新窗口呈现：在独立的原生控制台窗口中实时合并流式渲染，支持过滤、搜索、清空与一键复制。
 */

import { BrowserWindow, shell, type Session, type WebContents } from 'electron'
import { join } from 'node:path'
import { getConfigDir } from '../../config-paths'

export interface DiagnosticLogEntry {
  id: string
  time: string
  category: 'console' | 'network' | 'frame' | 'system'
  level: 'info' | 'warn' | 'error' | 'debug'
  badge: string
  badgeClass: string
  title: string
  details?: string
  url?: string
}

/**
 * NetLog 单文件上限（64MB）：仅在诊断控制台开启期间采集，且防止无界膨胀。
 */
const NETLOG_MAX_FILE_SIZE = 64 * 1024 * 1024

class YanhuDiagnosticConsoleManager {
  private window: BrowserWindow | null = null
  private readonly logs: DiagnosticLogEntry[] = []
  private readonly MAX_LOGS = 3000
  private attachedWebContents = new Set<number>()
  private attachedSessions = new Set<Session>()
  private netLogActive = false
  private netLogSession: Session | null = null
  private netLogFilePath = ''

  /** 获取 NetLog 文件保存绝对路径 */
  public getNetLogPath(): string {
    if (!this.netLogFilePath) {
      this.netLogFilePath = join(getConfigDir(), 'yanhu-express', 'chromium-netlog.json')
    }
    return this.netLogFilePath
  }

  /** 打开或唤起独立的诊断控制台窗口 */
  public open(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) {
      this.window.show()
      this.window.focus()
      return this.window
    }

    const win = new BrowserWindow({
      width: 1040,
      height: 680,
      minWidth: 800,
      minHeight: 480,
      title: '【智联万站 · 实时底层诊断控制台 (Console & Network)】',
      backgroundColor: '#0b0f19',
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    })

    const htmlContent = this.buildConsoleHtml()
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`)

    win.on('closed', () => {
      this.window = null
      this.stopNetLog()
    })

    this.window = win
    // NetLog 仅在诊断控制台开启期间采集，关闭即停止（杜绝无界磁盘占用）
    this.startNetLog()

    // 加载就绪后批量补发已有历史日志
    win.webContents.once('did-finish-load', () => {
      this.flushHistoryToWindow()
    })

    return win
  }

  /** 追加一条日志并实时推送到控制台窗口 */
  public log(entry: Omit<DiagnosticLogEntry, 'id' | 'time'>): void {
    const now = new Date()
    const time = now.toTimeString().slice(0, 8) + '.' + String(now.getMilliseconds()).padStart(3, '0')
    const fullEntry: DiagnosticLogEntry = {
      ...entry,
      id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      time,
    }

    this.logs.push(fullEntry)
    if (this.logs.length > this.MAX_LOGS) {
      this.logs.shift()
    }

    // 终端标准输出备份（开发环境终端可见）。
    // 仅 warn / error 落终端：info 级（含每条网络请求）在繁忙页面上会刷屏并拖慢主进程。
    const prefix = `[智联万站诊断·${fullEntry.badge}]`
    if (fullEntry.level === 'error') {
      console.error(prefix, fullEntry.title, fullEntry.details ?? '')
    } else if (fullEntry.level === 'warn') {
      console.warn(prefix, fullEntry.title, fullEntry.details ?? '')
    }

    if (this.window && !this.window.isDestroyed()) {
      const code = `if (window.__appendDiagnosticLog) { window.__appendDiagnosticLog(${JSON.stringify(fullEntry)}); }`
      void this.window.webContents.executeJavaScript(code).catch(() => {})
    }
  }

  /** 关联 WebContents（方法 2：捕获页面控制台、框架加载与崩溃） */
  public attachWebContents(wc: WebContents): void {
    if (wc.isDestroyed() || this.attachedWebContents.has(wc.id)) return
    this.attachedWebContents.add(wc.id)

    this.log({
      category: 'system',
      level: 'info',
      badge: 'ATTACH',
      badgeClass: 'badge-system',
      title: `已关联网页视图 WebContents #${wc.id}`,
    })

    // 1. 捕获网页内部控制台（主框架与所有子 iframe/frameset）
    wc.on('console-message', (_event, level, message, line, sourceId) => {
      let badge = 'CONSOLE.LOG'
      let badgeClass = 'badge-console-log'
      let logLevel: DiagnosticLogEntry['level'] = 'info'

      if (level >= 3) {
        badge = 'CONSOLE.ERROR'
        badgeClass = 'badge-console-error'
        logLevel = 'error'
      } else if (level === 2) {
        badge = 'CONSOLE.WARN'
        badgeClass = 'badge-console-warn'
        logLevel = 'warn'
      }

      this.log({
        category: 'console',
        level: logLevel,
        badge,
        badgeClass,
        title: message,
        details: sourceId ? `来源: ${sourceId}:${line}` : undefined,
      })
    })

    // 2. 捕获导航开始
    wc.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
      this.log({
        category: 'frame',
        level: 'info',
        badge: isMainFrame ? 'NAV.MAIN' : 'NAV.SUB',
        badgeClass: 'badge-frame-nav',
        title: `开始导航 -> ${url}`,
        details: `主框架: ${isMainFrame} | 页内导航: ${isInPlace}`,
        url,
      })
    })

    // 3. 捕获框架加载失败（最直接暴露白屏原因）
    wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      this.log({
        category: 'frame',
        level: errorCode === -3 ? 'warn' : 'error',
        badge: isMainFrame ? 'FAIL.MAIN' : 'FAIL.SUB',
        badgeClass: 'badge-frame-fail',
        title: `框架加载失败 [错误码 ${errorCode}]: ${errorDescription}`,
        details: `目标 URL: ${validatedURL}\n是否主框架: ${isMainFrame}\n常见说明: -3 为用户中断; -105 为域名解析失败; -102 为服务器拒绝连接; -200 为证书错误`,
        url: validatedURL,
      })
    })

    // 4. 捕获页面完成加载
    wc.on('did-finish-load', () => {
      this.log({
        category: 'frame',
        level: 'info',
        badge: 'LOAD.DONE',
        badgeClass: 'badge-net-ok',
        title: `DOM与基础资源加载完毕: ${wc.getURL()}`,
      })
    })

    // 5. 捕获渲染进程意外崩溃
    wc.on('render-process-gone', (_event, details) => {
      this.log({
        category: 'system',
        level: 'error',
        badge: 'CRASH',
        badgeClass: 'badge-frame-fail',
        title: `渲染进程崩溃退出! 原因: ${details.reason} (exitCode: ${details.exitCode})`,
      })
    })

    // 6. 捕获 SSL/证书异常
    // 只读审计：诊断控制台是观察者，严禁消费一次性 callback（重复调用会抛
    // "One-time callback was called more than once" 并卡死主进程）。
    // 证书放行/拒绝决策统一由 app 级安全策略与会话 verifyProc 承担。
    wc.on('certificate-error', (_event, url, error, certificate) => {
      this.log({
        category: 'network',
        level: 'warn',
        badge: 'SSL.WARN',
        badgeClass: 'badge-console-warn',
        title: `SSL 证书异常: ${error}`,
        details: `颁发者: ${certificate?.issuerName || '未知'}\n域名: ${url}`,
        url,
      })
    })
  }

  /** 关联网络会话（方法 4：捕获实时网络报文链路 + 启动 NetLog） */
  public attachSession(session: Session): void {
    if (this.attachedSessions.has(session)) return
    this.attachedSessions.add(session)

    // NetLog 不再随会话常驻开启：仅在诊断控制台窗口打开期间采集（见 open / stopNetLog），
    // 避免「只要打开过智联万站就无界写盘」。

    // 实时网络事件监听（非阻塞监听，零业务入侵）
    try {
      session.webRequest.onSendHeaders({ urls: ['*://*/*'] }, (details) => {
        // 诊断窗口未打开时直接丢弃采集，避免常驻开销
        if (!this.window || this.window.isDestroyed()) return
        // 过滤常见的本地 hot-reload 与静态小图标，降低视觉噪音
        if (details.url.includes('/@vite/') || details.url.includes('/__vite_ping')) return

        const headersSummary = Object.entries(details.requestHeaders || {})
          .map(([k, v]) => `  ${k}: ${v}`)
          .join('\n')

        this.log({
          category: 'network',
          level: 'info',
          badge: `NET.${details.method}`,
          badgeClass: 'badge-net-req',
          title: `[请求发出] ${details.method} ${details.url}`,
          details: `请求头:\n${headersSummary}`,
          url: details.url,
        })
      })

      session.webRequest.onResponseStarted({ urls: ['*://*/*'] }, (details) => {
        if (!this.window || this.window.isDestroyed()) return
        if (details.url.includes('/@vite/') || details.url.includes('/__vite_ping')) return

        const code = details.statusCode
        let badge = `HTTP.${code}`
        let badgeClass = 'badge-net-ok'
        let level: DiagnosticLogEntry['level'] = 'info'

        if (code >= 400) {
          badgeClass = 'badge-net-fail'
          level = 'error'
        } else if (code >= 300) {
          badgeClass = 'badge-net-redirect'
          level = 'warn'
        }

        const headersSummary = Object.entries(details.responseHeaders || {})
          .map(([k, v]) => `  ${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
          .join('\n')

        this.log({
          category: 'network',
          level,
          badge,
          badgeClass,
          title: `[收到响应 ${code}] ${details.statusLine} -> ${details.url}`,
          details: `响应头:\n${headersSummary}`,
          url: details.url,
        })
      })

      session.webRequest.onErrorOccurred({ urls: ['*://*/*'] }, (details) => {
        if (!this.window || this.window.isDestroyed()) return
        if (details.url.includes('/@vite/') || details.url.includes('/__vite_ping')) return

        this.log({
          category: 'network',
          level: details.error === 'net::ERR_ABORTED' ? 'warn' : 'error',
          badge: 'NET.ERR',
          badgeClass: 'badge-net-fail',
          title: `[网络连接失败] ${details.error} -> ${details.url}`,
          details: `资源类型: ${details.resourceType} | 方法: ${details.method}`,
          url: details.url,
        })
      })
    } catch (err) {
      console.warn('[诊断控制台] 挂载 webRequest 监听失败:', err)
    }
  }

  /** 启动 Chromium 底层 NetLog 抓包（仅在诊断控制台开启期间） */
  private startNetLog(): void {
    if (this.netLogActive) return
    const session = this.attachedSessions.values().next().value as Session | undefined
    if (!session) return
    try {
      const netLogPath = this.getNetLogPath()
      this.netLogSession = session
      void session.netLog.startLogging(netLogPath, {
        captureMode: 'default',
        maxFileSize: NETLOG_MAX_FILE_SIZE,
      }).then(() => {
        this.netLogActive = true
        this.log({
          category: 'system',
          level: 'info',
          badge: 'NETLOG',
          badgeClass: 'badge-system',
          title: `Chromium NetLog 底层抓包已激活（仅控制台开启期间采集），转储文件: ${netLogPath}`,
        })
      }).catch((err) => {
        console.warn('[诊断控制台] 启动 NetLog 失败:', err)
      })
    } catch (err) {
      console.warn('[诊断控制台] 初始化 NetLog 异常:', err)
    }
  }

  /** 停止 NetLog 抓包并复位状态（控制台关闭时调用） */
  private stopNetLog(): void {
    const session = this.netLogSession
    this.netLogSession = null
    if (!this.netLogActive || !session) {
      this.netLogActive = false
      return
    }
    try {
      void session.netLog.stopLogging().catch(() => {})
    } catch {
      // 会话可能已销毁，忽略
    }
    this.netLogActive = false
  }

  /** 将内存中的历史日志一次性推送到新打开的控制台窗口 */
  private flushHistoryToWindow(): void {
    if (!this.window || this.window.isDestroyed()) return
    const code = `if (window.__loadInitialLogs) { window.__loadInitialLogs(${JSON.stringify(this.logs)}); }`
    void this.window.webContents.executeJavaScript(code).catch(() => {})
  }

  /** 构建单文件内联诊断控制台 HTML/CSS/JS */
  private buildConsoleHtml(): string {
    // 该路径插入 HTML 文本节点，仅需 HTML 转义（此前误用 JS 反斜杠转义，导致显示成双反斜杠）
    const netLogPath = this.getNetLogPath().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>智联万站 · 实时底层诊断控制台</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #080c14; color: #cbd5e1; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Courier New", monospace; font-size: 12px; display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
    .header { background: #0f172a; border-bottom: 1px solid #1e293b; padding: 10px 16px; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .title-box { display: flex; align-items: center; gap: 10px; }
    .pulse { width: 10px; height: 10px; border-radius: 50%; background: #10b981; box-shadow: 0 0 10px #10b981; animation: breathe 2s infinite ease-in-out; }
    @keyframes breathe { 0%,100% { opacity: 0.5; transform: scale(0.9); } 50% { opacity: 1; transform: scale(1.1); } }
    .title { font-weight: 700; font-size: 13px; color: #f8fafc; letter-spacing: 0.5px; }
    .toolbar { display: flex; align-items: center; gap: 8px; }
    .filter-btn { background: #1e293b; color: #94a3b8; border: 1px solid #334155; padding: 4px 10px; border-radius: 6px; cursor: pointer; font-size: 11px; transition: all .15s; user-select: none; }
    .filter-btn:hover { background: #334155; color: #f8fafc; }
    .filter-btn.active { background: #2563eb; color: #fff; border-color: #2563eb; }
    .search-input { background: #080c14; border: 1px solid #334155; color: #f8fafc; padding: 4px 10px; border-radius: 6px; font-size: 11px; width: 220px; outline: none; }
    .search-input:focus { border-color: #3b82f6; }
    .action-btn { background: #1e293b; color: #cbd5e1; border: 1px solid #334155; padding: 4px 10px; border-radius: 6px; cursor: pointer; font-size: 11px; user-select: none; }
    .action-btn:hover { background: #334155; color: #fff; }
    .info-bar { background: #0b1120; padding: 6px 16px; border-bottom: 1px solid #1e293b; font-size: 11px; color: #64748b; display: flex; justify-content: space-between; align-items: center; }
    .log-container { flex: 1; overflow-y: auto; padding: 8px 12px; display: flex; flex-direction: column; gap: 4px; }
    .log-row { padding: 5px 8px; border-radius: 4px; display: flex; flex-direction: column; gap: 3px; border-left: 3px solid transparent; background: rgba(30, 41, 59, 0.25); }
    .log-row:hover { background: rgba(30, 41, 59, 0.55); }
    .log-row.level-error { border-left-color: #ef4444; background: rgba(239, 68, 68, 0.08); }
    .log-row.level-warn { border-left-color: #f59e0b; background: rgba(245, 158, 11, 0.08); }
    .log-row.level-info { border-left-color: #3b82f6; }
    .log-row.level-debug { border-left-color: #8b5cf6; }
    .log-header { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
    .log-time { color: #64748b; font-size: 11px; min-width: 80px; }
    .badge { font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 4px; text-transform: uppercase; }
    .badge-console-log { background: #0284c7; color: #e0f2fe; }
    .badge-console-warn { background: #d97706; color: #fef3c7; }
    .badge-console-error { background: #dc2626; color: #fee2e2; }
    .badge-net-req { background: #4f46e5; color: #e0e7ff; }
    .badge-net-ok { background: #16a34a; color: #dcfce7; }
    .badge-net-redirect { background: #ea580c; color: #ffedd5; }
    .badge-net-fail { background: #b91c1c; color: #fef2f2; }
    .badge-frame-fail { background: #be123c; color: #ffe4e6; }
    .badge-frame-nav { background: #0d9488; color: #ccfbf1; }
    .badge-system { background: #475569; color: #f1f5f9; }
    .log-title { color: #f1f5f9; word-break: break-all; flex: 1; line-height: 1.4; }
    .details-toggle { font-size: 10px; color: #60a5fa; cursor: pointer; text-decoration: underline; margin-left: 6px; user-select: none; }
    .log-details { color: #94a3b8; font-size: 11px; white-space: pre-wrap; word-break: break-all; background: rgba(0,0,0,0.4); padding: 6px 8px; border-radius: 4px; margin-top: 3px; display: none; line-height: 1.35; border: 1px solid #1e293b; }
    .log-details.show { display: block; }
    .empty-tip { color: #475569; text-align: center; margin-top: 40px; font-size: 13px; }
  </style>
</head>
<body>
  <div class="header">
    <div class="title-box">
      <div class="pulse"></div>
      <div class="title">智联万站 · 实时底层诊断控制台 (Console & Network Monitor)</div>
    </div>
    <div class="toolbar">
      <button class="filter-btn active" data-filter="all">全部 (All)</button>
      <button class="filter-btn" data-filter="console">网页Console</button>
      <button class="filter-btn" data-filter="network">网络请求</button>
      <button class="filter-btn" data-filter="error">仅错误 (Error)</button>
      <input type="text" id="searchInput" class="search-input" placeholder="搜索 URL / 错误 / 关键字..." />
      <button class="action-btn" id="btnClear">清空</button>
      <button class="action-btn" id="btnCopy">复制日志</button>
      <button class="action-btn" id="btnAutoScroll">自动滚屏: 开</button>
    </div>
  </div>
  <div class="info-bar">
    <span id="statText">日志统计: 0 条</span>
    <span>Chromium NetLog 文件: <code id="netLogPathText">${netLogPath}</code> (仅控制台开启期间采集；可在 Chrome 访问 chrome://net-export 导入分析)</span>
  </div>
  <div class="log-container" id="logContainer">
    <div class="empty-tip" id="emptyTip">正在等待网页加载并捕获底层事件...</div>
  </div>

  <script>
    let currentFilter = 'all';
    let searchQuery = '';
    let autoScroll = true;
    const allLogs = [];

    const container = document.getElementById('logContainer');
    const emptyTip = document.getElementById('emptyTip');
    const statText = document.getElementById('statText');
    const searchInput = document.getElementById('searchInput');
    const btnAutoScroll = document.getElementById('btnAutoScroll');

    function renderLogItem(item) {
      const row = document.createElement('div');
      row.className = 'log-row level-' + item.level;
      row.dataset.category = item.category;
      row.dataset.level = item.level;
      row.dataset.text = (item.title + ' ' + (item.details || '') + ' ' + (item.url || '')).toLowerCase();

      let detailsHtml = '';
      if (item.details) {
        detailsHtml = '<span class="details-toggle" onclick="toggleDetails(this)">[展开详情]</span>' +
                      '<div class="log-details">' + escapeHtml(item.details) + '</div>';
      }

      row.innerHTML =
        '<div class="log-header">' +
          '<span class="log-time">' + item.time + '</span>' +
          '<span class="badge ' + (item.badgeClass || 'badge-system') + '">' + item.badge + '</span>' +
          '<span class="log-title">' + escapeHtml(item.title) + detailsHtml + '</span>' +
        '</div>';

      applyFilterToRow(row);
      container.appendChild(row);

      if (autoScroll) {
        container.scrollTop = container.scrollHeight;
      }
    }

    function toggleDetails(btn) {
      const details = btn.nextElementSibling;
      if (details) {
        const isShow = details.classList.toggle('show');
        btn.textContent = isShow ? '[收起详情]' : '[展开详情]';
      }
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function applyFilterToRow(row) {
      let matchCat = true;
      if (currentFilter === 'console') matchCat = (row.dataset.category === 'console');
      else if (currentFilter === 'network') matchCat = (row.dataset.category === 'network');
      else if (currentFilter === 'error') matchCat = (row.dataset.level === 'error');

      let matchSearch = true;
      if (searchQuery) {
        matchSearch = row.dataset.text.includes(searchQuery);
      }

      row.style.display = (matchCat && matchSearch) ? 'flex' : 'none';
    }

    function updateStats() {
      statText.textContent = '总日志: ' + allLogs.length + ' 条 (当前视图显示: ' +
        container.querySelectorAll('.log-row[style*="display: flex"]').length + ' 条)';
      if (emptyTip) {
        emptyTip.style.display = allLogs.length === 0 ? 'block' : 'none';
      }
    }

    window.__appendDiagnosticLog = function(item) {
      allLogs.push(item);
      renderLogItem(item);
      updateStats();
    };

    window.__loadInitialLogs = function(items) {
      if (!Array.isArray(items)) return;
      container.innerHTML = '';
      items.forEach(it => {
        allLogs.push(it);
        renderLogItem(it);
      });
      updateStats();
    };

    // 筛选切换
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilter = btn.dataset.filter;
        container.querySelectorAll('.log-row').forEach(applyFilterToRow);
        updateStats();
      });
    });

    // 搜索输入
    searchInput.addEventListener('input', (e) => {
      searchQuery = e.target.value.trim().toLowerCase();
      container.querySelectorAll('.log-row').forEach(applyFilterToRow);
      updateStats();
    });

    // 清空
    document.getElementById('btnClear').addEventListener('click', () => {
      allLogs.length = 0;
      container.innerHTML = '<div class="empty-tip">已清空日志记录。</div>';
      updateStats();
    });

    // 自动滚屏开关
    btnAutoScroll.addEventListener('click', () => {
      autoScroll = !autoScroll;
      btnAutoScroll.textContent = '自动滚屏: ' + (autoScroll ? '开' : '关');
      btnAutoScroll.style.background = autoScroll ? '#1e293b' : '#334155';
    });

    // 复制全部日志
    document.getElementById('btnCopy').addEventListener('click', () => {
      const text = allLogs.map(l => '[' + l.time + '] [' + l.badge + '] ' + l.title + (l.details ? ' \\n' + l.details : '')).join('\\n\\n');
      navigator.clipboard.writeText(text).then(() => {
        alert('已成功复制 ' + allLogs.length + ' 条完整诊断日志到剪贴板！');
      }).catch(() => {
        alert('复制失败，请重试');
      });
    });
  </script>
</body>
</html>`
  }
}

export const yanhuDiagnosticConsole = new YanhuDiagnosticConsoleManager()
