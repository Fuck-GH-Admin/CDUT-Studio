/**
 * CDUT 专区特区账户认证管理器
 *
 * 职责：
 *   - 在隔离 Session 分区（persist:cdut-auth-zone）内以后台不可见窗口驱动成都理工 CAS 登录；
 *   - 鉴权落点严格收敛至教务主框架（/jsxsd/framework/xsMainV），杜绝 CAS/SSO 中间重定向阶段过早结算；
 *   - 登录成功后双轨抓取画像：主框架顶栏 DOM 直取真实姓名 + 专属 Session 拉取学籍卡片与证件照 Base64；
 *   - 每 10 分钟向青果教务主页静默保活，检测到会话失效则标记 expired；
 *   - 加密持久化特区账户（仅密码字段经 token-crypto 加密）到 ~/.cdutai/cdut-account.json。
 *
 * 范围声明（如实标注，不做过度承诺）：
 *   - 本模块不主动嗅探、不解码 CAS Cookie；网络请求经由专属分区 Session 携带其自身 Cookie；
 *   - 「active」表示最近一次认证成功且保活心跳未检测到失效；
 *   - 暂不处理页面的风控/安全验证分支。
 */

import { BrowserWindow, session } from 'electron'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  CdutAccountProfile,
  CdutLoginInput,
  CdutLoginResult,
  CdutSavedAccountSummary,
} from '@profer/shared'
import { getCdutAccountPath, resolveConfigDir } from '../config-paths'
import { encryptToken, decryptToken } from '../token-crypto'
import { readJsonFileSafe, writeJsonFileAtomic } from '../safe-file'
import {
  fetchJwProfileSummary,
  fetchImageAsBase64,
  stripStaleRuiShuCookies,
  type JwProfileSummary,
} from './cdut-jw-client'
import { cdutDemoService } from './cdut-demo/demo-service'

/** 成都理工统一身份认证（CAS）登录地址：service 绑定青果教务系统在 CAS 登记的官方 SSO 入口 */
const CAS_LOGIN_URL =
  'https://cas.paas.cdut.edu.cn/cas/login?service=http%3A%2F%2Fjw.cdut.edu.cn%2Fsso%2Flogin.jsp%3FtargetUrl%3Dbase64aHR0cDovL2p3LmNkdXQuZWR1LmNuL0xvZ29uLmRvP21ldGhvZD1sb2dvblNTT2NkbGdkeA%3D%3D'

/** 青果教务系统主页地址，用于静默保活探活（不再主动强跳加载） */
const JW_HOME_URL = 'https://jw.cdut.edu.cn/jsxsd/framework/xsMainV.htmlx'

/** 特区账户专属隔离分区，与通用账户、其它业务会话物理隔离 */
export const CDUT_AUTH_PARTITION = 'persist:cdut-auth-zone'

/**
 * 证书安全策略的会话登记标识（与 CDUT_AUTH_PARTITION 一一对应）。
 * 必须与安装 verifyProc 时的 sessionId 完全一致，否则阻断登记的写入端与读取端会错位。
 */
export const CDUT_AUTH_CERT_SESSION_ID = 'cdut-auth-zone'

/** 获取学生证件照离线二进制缓存路径（~/.cdutai/cache/avatars/{studentId}.jpg） */
function getAvatarCachePath(studentId: string): string {
  return join(resolveConfigDir(), 'cache', 'avatars', `${studentId}.jpg`)
}

/** 将 Base64 头像保存为二进制独立图片文件，避免 JSON 膨胀 */
function saveAvatarToCache(studentId: string, avatarDataUrl: string): void {
  if (!studentId || !avatarDataUrl || !avatarDataUrl.startsWith('data:')) return
  try {
    const match = avatarDataUrl.match(/^data:image\/[a-zA-Z+]+;base64,(.+)$/)
    if (match && match[1]) {
      const buf = Buffer.from(match[1], 'base64')
      const dir = join(resolveConfigDir(), 'cache', 'avatars')
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      writeFileSync(getAvatarCachePath(studentId), buf)
    }
  } catch (err) {
    console.warn('[CdutAuthManager] 保存头像缓存失败:', err)
  }
}

/** 从本地二进制缓存恢复 Base64 头像 */
function loadAvatarFromCache(studentId: string): string | undefined {
  if (!studentId) return undefined
  try {
    const p = getAvatarCachePath(studentId)
    if (existsSync(p)) {
      const buf = readFileSync(p)
      if (buf.length > 0) {
        return `data:image/jpeg;base64,${buf.toString('base64')}`
      }
    }
  } catch {
    // 忽略异常
  }
  return undefined
}

/** 心跳保活周期：10 分钟 */
const KEEP_ALIVE_INTERVAL_MS = 10 * 60 * 1000

/** CAS 登录阶段硬超时 */
const LOGIN_TIMEOUT_MS = 25_000

/** 认证成功后画像抓取的宽限时间（不含 CAS 登录阶段） */
const PROFILE_HARVEST_TIMEOUT_MS = 45_000

/** 本地持久化结构（密码字段为密文） */
interface StoredCdutAccount {
  studentId: string
  studentName: string
  avatar?: string
  college?: string
  major?: string
  classCode?: string
  role?: string
  rememberPassword: boolean
  encryptedPassword?: string
  status: 'active' | 'disconnected'
  lastLoginAt: number
  lastActiveAt: number
}

/**
 * 判定导航落点是否为「教务主框架」——认证真正成功的唯一收敛标志。
 *
 * 必须同时满足 hostname 为 jw.cdut.edu.cn，且路径已进入教务应用 /jsxsd/。
 * 这样可彻底杜绝两类历史误判：
 *   1. CAS 入口 `?service=...jw.cdut.edu.cn...` query 参数造成的子串误判；
 *   2. SSO 票据 `sso/login.jsp?ticket=ST-xxx` 尚未向 CAS 验证、Cookie 尚未下发的中间阶段。
 */
function isMainHomeUrl(url: string): boolean {
  if (!url) return false
  try {
    const u = new URL(url)
    if (u.hostname !== 'jw.cdut.edu.cn') return false
    return u.pathname.includes('/jsxsd/framework/xsMainV')
  } catch {
    return false
  }
}

/**
 * 判定是否为 CAS 统一身份认证登录页。
 *
 * 必须严格校验 hostname，杜绝重定向参数中携带 `/cas/login` 子串造成的误判。
 */
function isCasLoginUrl(url: string): boolean {
  if (!url) return false
  try {
    const u = new URL(url)
    return u.hostname === 'cas.paas.cdut.edu.cn' && u.pathname.includes('/cas/login')
  } catch {
    return false
  }
}

/**
 * 注入脚本：兼容 Vue2 + Vant（也回退 Element-UI / 原生）定位表单、写入凭证并提交。
 * 元素由客户端渲染，脚本内部做有限次重试；返回 { submitted: true } 表示已提交。
 * 使用原生 value setter + input/change 事件，确保 v-model 能正确接收值。
 */
function buildVantInjectScript(username: string, password: string): string {
  return `(function () {
    return new Promise((resolve) => {
      let attempts = 0;
      const checkAndFill = () => {
        attempts++;

        // 1. 前置识别 CAS 拦截阻断页（如「未认证授权的服务」），给出明确原因而非晦涩的超时
        const docTitle = document.title || '';
        if (docTitle.includes('未认证授权的服务')) {
          const abnormalText = document.querySelector('.sw-common-window-thick-title, .main p')?.textContent?.trim();
          resolve({ ready: false, blockedReason: abnormalText || 'CAS 提示：访问的目标服务未被认证授权' });
          return;
        }

        // 2. 定位账号输入框
        const userInput =
          document.querySelector('input.sw-input__inner[type="text"]') ||
          document.querySelector('input.van-field__control[type="text"]') ||
          document.querySelector('input.el-input__inner[type="text"]') ||
          document.querySelector('input[placeholder*="学工号"]') ||
          document.querySelector('input[placeholder*="账号"]') ||
          document.querySelector('input[type="text"]');

        // 3. 定位密码输入框
        const passInput =
          document.querySelector('input.sw-input__inner[type="password"]') ||
          document.querySelector('input.van-field__control[type="password"]') ||
          document.querySelector('input.el-input__inner[type="password"]') ||
          document.querySelector('input[placeholder*="密码"]') ||
          document.querySelector('input[type="password"]');

        // 4. 定位登录提交按钮
        const buttons = Array.from(document.querySelectorAll('button, .van-button, .el-button, [role="button"], input[type="submit"]'));
        const submitBtn =
          document.querySelector('.login-btn') ||
          buttons.find(b => b.textContent && b.textContent.trim().replace(/\\s+/g, '').includes('登录')) ||
          document.querySelector('button[type="submit"]') ||
          document.querySelector('.van-button--primary');

        if (!userInput || !passInput || !submitBtn) {
          if (attempts < 25) {
            setTimeout(checkAndFill, 200);
            return;
          }
          resolve({ ready: false, blockedReason: '未能定位内网登录表单元素（页面未在规定时间内渲染出账号密码框）' });
          return;
        }

        const triggerInput = (el, val) => {
          const setter = Object.getOwnPropertyDescriptor(el, 'value')?.set ||
                         Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
          if (setter) setter.call(el, val); else el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
          el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        };

        triggerInput(userInput, ${JSON.stringify(username)});
        triggerInput(passInput, ${JSON.stringify(password)});

        setTimeout(() => {
          submitBtn.click();
          resolve({ ready: true, submitted: true });
        }, 150);
      };
      checkAndFill();
    });
  })()`
}

/** 提取 CAS 页面真实报错文案（兼容 Vant / Element-UI / 原生 #msg 错误容器） */
const EXTRACT_ERROR_SCRIPT = `(function () {
  const el = document.querySelector(
    '.van-toast__text, .van-toast, .van-field__error-message, .van-dialog__message, .el-message__content, .el-form-item__error, .login-error, #msg, #msg.errors, .errors, .auth_error, .sw-common-window-thick-title'
  );
  return el ? (el.textContent || '').trim() : '';
})()`

/**
 * 从教务主框架顶栏直接提取真实中文姓名（双轨提取之一，规避网络延迟导致的画像空档）。
 * 优先命中青果标准结构 `.top li.user + li span`，并保留多重选择器与「欢迎 XXX」兜底。
 */
const EXTRACT_TOP_NAME_SCRIPT = `(function () {
  const selectors = [
    '.top li.user + li span',
    '.top .user ~ li span',
    '.top li.user + li',
    '.top .user-name',
    '.top .username',
    '#userName'
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    const text = el ? (el.textContent || '').trim() : '';
    if (text) return text;
  }
  const bodyText = (document.body && document.body.innerText) || '';
  const m = bodyText.match(/欢迎[您，, ]*([\\u4e00-\\u9fa5]{2,4})/);
  return m ? m[1] : '';
})()`

/**
 * 注入脚本（主轨）：在已通过瑞数 WAF 校验、持有真实安全 Cookie 的 authWindow 上下文内，
 * 以原生 window.fetch + DOMParser 抓取完整学生画像（姓名/学号/学院/专业/班级 + 证件照 Base64）。
 *
 * 之所以不再由主进程 session.fetch 直接请求：青果教务网关的瑞数动态安全防护会对
 * 无 JS 执行环境的底层请求返回 HTTP 412；而窗口上下文具备真实 Chromium JS 引擎，
 * 天然携带动态脚本生成的 Cookie，可彻底规避 412，并原生解决证件照同源带凭证下载。
 */
const EXTRACT_FULL_PROFILE_SCRIPT = `(async function () {
  const clean = (value) => (value || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();

  const pick = (map, keys) => {
    for (const key of Object.keys(map)) {
      const normalized = key.replace(/\\s+/g, '');
      for (const cand of keys) {
        if (normalized.indexOf(cand) !== -1) return map[key] || '';
      }
    }
    return '';
  };

  // 单元格取值：优先读取只读表单控件（input/select/textarea），否则退回纯文本
  const cellValue = (cell) => {
    const ctrl = cell.querySelector('input, select, textarea');
    if (ctrl) {
      if (ctrl.tagName === 'SELECT') {
        const opt = ctrl.selectedIndex >= 0 ? ctrl.options[ctrl.selectedIndex] : null;
        const val = opt ? (opt.text || opt.value) : ctrl.value;
        if (val) return clean(val);
      } else {
        const val = ctrl.value || ctrl.getAttribute('value');
        if (val) return clean(val);
      }
    }
    return clean(cell.textContent);
  };

  const splitLabelValue = (text) => {
    const m = text.match(/^([^:：]{1,16})[:：]\\s*([\\s\\S]*)$/);
    if (!m) return null;
    const label = (m[1] || '').trim();
    if (!label || /^\\d+$/.test(label)) return null;
    return { label: label, value: (m[2] || '').trim() };
  };

  // 解析「标签: 值」型学籍表格为键值映射，兼容同格与分列两种版式
  const parseKeyValue = (doc) => {
    const map = {};
    const register = (key, value) => {
      const k = clean(key).replace(/[:：]\\s*$/, '');
      if (!k || Object.prototype.hasOwnProperty.call(map, k)) return;
      map[k] = clean(value);
    };
    const rows = doc.querySelectorAll('table tr');
    rows.forEach((tr) => {
      const cells = Array.from(tr.querySelectorAll('td, th'));
      const texts = cells.map(cellValue);
      let i = 0;
      while (i < texts.length) {
        const current = texts[i] || '';
        if (!current) { i++; continue; }
        const split = splitLabelValue(current);
        if (split && split.value) { register(split.label, split.value); i++; continue; }
        if (split) {
          const next = texts[i + 1];
          if (next !== undefined && next !== '' && !splitLabelValue(next)) {
            register(split.label, next); i += 2; continue;
          }
          i++; continue;
        }
        register(current, texts[i + 1] || '');
        i += 2;
      }
    });
    return map;
  };

  const isPlaceholder = (src) => /logo|icon|banner|bg|arrow|blank|btn|nophoto|no-photo|no_photo|default|placeholder|qrcode|erweima|loading|spacer|shadow/i.test(src);

  // 提取证件照地址：优先青果证件照容器，兜底全图扫描并排除站点图标
  const extractPhotoUrl = (doc) => {
    const selectors = [
      'img#xjkp', '#xjkp img', 'img[id*="xjkp"]',
      '#xsxxPhoto img', '#xsxxPhoto', '.xsxxPhoto img', '.xsxxPhoto',
      'img#zp', 'img#xszp', 'img#pic', 'img#photo',
      'img[id*="zp"]', 'img[name*="zp"]', 'img[id*="photo"]', 'img[name*="photo"]',
      'img[src*="xjkp"]', 'img[src*="xsxx"]', 'img[src*="grxx"]',
      'img[src*="photo"]', 'img[src*="avatar"]',
      'img[src*="zp"]', 'img[src*="pic"]',
      '.photo-box img', '.photo img', '.zp img', '.avatar img', '.touxiang img',
      'td[rowspan] img', 'th[rowspan] img',
      'table img'
    ];
    for (const sel of selectors) {
      const el = doc.querySelector(sel);
      const src = el ? (el.getAttribute('src') || '') : '';
      if (src && !isPlaceholder(src)) return src;
    }
    let found = '';
    doc.querySelectorAll('img').forEach((img) => {
      if (found) return;
      const src = img.getAttribute('src') || '';
      if (!src || isPlaceholder(src)) return;
      if (/photo|xsxx|grxx|xjkp|avatar|zp|pic|touxiang|head|user/i.test(src)) found = src;
    });
    if (!found) {
      const link = doc.querySelector('a[href*="zp"], a[href*="photo"], a[href*="pic"]');
      if (link) {
        const href = link.getAttribute('href') || '';
        if (href && !isPlaceholder(href)) found = href;
      }
    }
    return found;
  };

  // 清理陈旧的瑞数 P 动态签名 Cookie，防止 window.fetch 触发 HTTP 400
  try {
    const rawPairs = document.cookie.split(';');
    const cookieNames = new Set(rawPairs.map((p) => p.trim().split('=')[0]));
    for (const name of cookieNames) {
      if (name.endsWith('P') && cookieNames.has(name.slice(0, -1) + 'O')) {
        document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/;';
        document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/jsxsd;';
        document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/jsxsd/;';
      }
    }
  } catch (e) {}

  const fetchText = async (path) => {
    try {
      const res = await fetch(path, { credentials: 'include' });
      if (!res.ok) {
        console.warn('[CdutWindowFetch] 请求未成功:', path, 'HTTP', res.status);
        return '';
      }
      return await res.text();
    } catch (err) {
      console.warn('[CdutWindowFetch] 请求异常:', path, err);
      return '';
    }
  };

  // 证件照下载并转 DataURL：窗口上下文原生携带 Cookie，解决同源鉴权问题
  const toDataUrl = async (url) => {
    try {
      const abs = new URL(url, location.href).toString();
      const res = await fetch(abs, { credentials: 'include' });
      if (!res.ok) return '';
      const blob = await res.blob();
      if (blob.size < 100) return '';
      return await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => {
          let resStr = reader.result;
          if (typeof resStr === 'string') {
            if (!resStr.startsWith('data:image/')) {
              resStr = resStr.replace(/^data:[^;]*;/, 'data:image/jpeg;');
            }
            resolve(resStr);
          } else {
            resolve('');
          }
        };
        reader.onerror = () => resolve('');
        reader.readAsDataURL(blob);
      });
    } catch (err) { return ''; }
  };

  const result = { name: '', studentId: '', college: '', major: '', className: '', avatar: '' };
  const endpoints = ['/jsxsd/grxx/xsxx', '/jsxsd/xsxj/xjxxgl.do'];
  let photoUrl = '';
  for (const ep of endpoints) {
    const html = await fetchText(ep);
    if (!html) continue;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const info = parseKeyValue(doc);
    if (!result.name) result.name = pick(info, ['姓名']);
    if (!result.studentId) result.studentId = pick(info, ['学号']);
    if (!result.college) result.college = pick(info, ['学院', '院系', '系所']);
    if (!result.major) result.major = pick(info, ['专业']);
    if (!result.className) result.className = pick(info, ['班级', '行政班']);
    if (!photoUrl) photoUrl = extractPhotoUrl(doc);
    if (result.name && result.studentId && result.college && result.major && photoUrl) break;
  }
  if (photoUrl) result.avatar = await toDataUrl(photoUrl);
  return result;
})()`

/**
 * 注入脚本：在已加载的学籍详情页（/jsxsd/grxx/xsxx 或 /jsxsd/xsxj/xjxxgl.do）DOM 中，
 * 同步提取表格字段（姓名/学号/学院/专业/班级）并提取证件照（Canvas直转 + 窗口内 fetch 双重保障）。
 */
const EXTRACT_PAGE_PROFILE_AND_PHOTO_SCRIPT = `(async function () {
  const clean = (val) => (val || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
  const pick = (map, keys) => {
    for (const k of Object.keys(map)) {
      const norm = k.replace(/\\s+/g, '');
      for (const cand of keys) {
        if (norm.indexOf(cand) !== -1) return map[k] || '';
      }
    }
    return '';
  };
  const cellValue = (cell) => {
    const ctrl = cell.querySelector('input, select, textarea');
    if (ctrl) {
      if (ctrl.tagName === 'SELECT') {
        const opt = ctrl.selectedIndex >= 0 ? ctrl.options[ctrl.selectedIndex] : null;
        const val = opt ? (opt.text || opt.value) : ctrl.value;
        if (val) return clean(val);
      } else {
        const val = ctrl.value || ctrl.getAttribute('value');
        if (val) return clean(val);
      }
    }
    return clean(cell.textContent);
  };
  const splitLabelValue = (text) => {
    const m = text.match(/^([^:：]{1,16})[:：]\\s*([\\s\\S]*)$/);
    if (!m) return null;
    const label = (m[1] || '').trim();
    if (!label || /^\\d+$/.test(label)) return null;
    return { label: label, value: (m[2] || '').trim() };
  };
  const map = {};
  const register = (k, v) => {
    const key = clean(k).replace(/[:：]\\s*$/, '');
    if (!key || Object.prototype.hasOwnProperty.call(map, key)) return;
    map[key] = clean(v);
  };
  document.querySelectorAll('table tr').forEach((tr) => {
    const cells = Array.from(tr.querySelectorAll('td, th'));
    const texts = cells.map(cellValue);
    let i = 0;
    while (i < texts.length) {
      const cur = texts[i] || '';
      if (!cur) { i++; continue; }
      const split = splitLabelValue(cur);
      if (split && split.value) { register(split.label, split.value); i++; continue; }
      if (split) {
        const nxt = texts[i + 1];
        if (nxt !== undefined && nxt !== '' && !splitLabelValue(nxt)) {
          register(split.label, nxt); i += 2; continue;
        }
        i++; continue;
      }
      register(cur, texts[i + 1] || '');
      i += 2;
    }
  });

  const isPlaceholder = (src) => {
    if (!src) return true;
    return /logo|icon|banner|bg|arrow|blank|btn|nophoto|no-photo|no_photo|default|placeholder|qrcode|erweima|loading|spacer|shadow/i.test(src);
  };

  const photoSelectors = [
    'img#xjkp', '#xjkp img', 'img[id*="xjkp" i]',
    '#xsxxPhoto img', '#xsxxPhoto', '.xsxxPhoto img', '.xsxxPhoto',
    'img#zp', 'img#xszp', 'img#pic', 'img#photo',
    'img[id*="zp" i]', 'img[name*="zp" i]', 'img[id*="photo" i]', 'img[name*="photo" i]',
    'img[src*="xjkp" i]', 'img[src*="xsxx" i]', 'img[src*="grxx" i]',
    'img[src*="photo" i]', 'img[src*="avatar" i]',
    'img[src*="zp" i]', 'img[src*="pic" i]',
    '.photo-box img', '.photo img', '.zp img', '.avatar img', '.touxiang img',
    'td[rowspan] img', 'th[rowspan] img',
    'table img'
  ];

  let targetImg = null;
  for (const sel of photoSelectors) {
    const el = document.querySelector(sel);
    if (el && el.tagName === 'IMG') {
      const s = el.getAttribute('src') || el.src || '';
      if (s && !isPlaceholder(s)) {
        targetImg = el;
        break;
      }
    }
  }

  // 兜底扫描全部 img
  if (!targetImg) {
    const allImgs = Array.from(document.querySelectorAll('img'));
    for (const img of allImgs) {
      const s = img.getAttribute('src') || img.src || '';
      if (!s || isPlaceholder(s)) continue;
      if (/photo|xsxx|grxx|xjkp|avatar|zp|pic|touxiang|head|user/i.test(s)) {
        targetImg = img;
        break;
      }
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (h >= w && w >= 40 && h >= 50) {
        targetImg = img;
        break;
      }
    }
  }

  // 检查可能存在的 iframe
  if (!targetImg) {
    const iframes = Array.from(document.querySelectorAll('iframe, frame'));
    for (const f of iframes) {
      try {
        const idoc = f.contentDocument || (f.contentWindow && f.contentWindow.document);
        if (idoc) {
          for (const sel of photoSelectors) {
            const el = idoc.querySelector(sel);
            if (el && el.tagName === 'IMG') {
              const s = el.getAttribute('src') || el.src || '';
              if (s && !isPlaceholder(s)) {
                targetImg = el;
                break;
              }
            }
          }
        }
      } catch (e) {}
      if (targetImg) break;
    }
  }

  let photoUrl = '';
  let avatar = '';

  if (targetImg) {
    const rawSrc = targetImg.getAttribute('src') || targetImg.src || '';
    if (rawSrc) {
      try {
        photoUrl = new URL(rawSrc, location.href).toString();
      } catch (e) {
        photoUrl = rawSrc;
      }
    }

    // 等待图片异步加载完成
    if (!targetImg.complete || !targetImg.naturalWidth) {
      await new Promise((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        targetImg.addEventListener('load', finish, { once: true });
        targetImg.addEventListener('error', finish, { once: true });
        setTimeout(finish, 1800);
      });
    }

    // 优先：利用 Chromium 已解码并保存在内存中的位图，经 Canvas 直转 DataURL
    try {
      const w = targetImg.naturalWidth || targetImg.width || 0;
      const h = targetImg.naturalHeight || targetImg.height || 0;
      if (w > 0 && h > 0) {
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(targetImg, 0, 0, w, h);
          const data = canvas.toDataURL('image/jpeg', 0.92);
          if (data && data.startsWith('data:image/jpeg;base64,') && data.length > 200) {
            avatar = data;
          }
        }
      }
    } catch (canvasErr) {}

    // 次选：Canvas 受限时，窗口内原生 fetch 转 Blob -> DataURL
    if (!avatar && photoUrl) {
      try {
        const res = await fetch(photoUrl, { credentials: 'include' });
        if (res.ok) {
          const blob = await res.blob();
          if (blob.size >= 100) {
            avatar = await new Promise((resolve) => {
              const reader = new FileReader();
              reader.onload = () => {
                let resStr = reader.result;
                if (typeof resStr === 'string') {
                  if (!resStr.startsWith('data:image/')) {
                    resStr = resStr.replace(/^data:[^;]*;/, 'data:image/jpeg;');
                  }
                  resolve(resStr);
                } else {
                  resolve('');
                }
              };
              reader.onerror = () => resolve('');
              reader.readAsDataURL(blob);
            });
          }
        }
      } catch (fetchErr) {}
    }
  } else {
    // 检查页面是否存在照片下载或展示的链接
    const link = document.querySelector('a[href*="zp" i], a[href*="photo" i], a[href*="pic" i]');
    if (link) {
      const href = link.getAttribute('href') || link.href || '';
      if (href && !isPlaceholder(href)) {
        try {
          photoUrl = new URL(href, location.href).toString();
        } catch (e) {
          photoUrl = href;
        }
      }
    }
  }

  return {
    name: pick(map, ['姓名']),
    studentId: pick(map, ['学号']),
    college: pick(map, ['学院', '院系', '系所']),
    major: pick(map, ['专业']),
    className: pick(map, ['班级', '行政班']),
    avatar: avatar || undefined,
    photoUrl: photoUrl || undefined,
  };
})()`

export class CdutAuthManager {
  private profile: CdutAccountProfile = {
    studentId: '',
    studentName: '',
    status: 'disconnected',
  }

  private onStatusChangeCallback?: (profile: CdutAccountProfile) => void

  /** 进行中的后台认证窗口，用于并发守卫与清理 */
  private authWindow: BrowserWindow | null = null

  /** 静默保活定时器 */
  private keepAliveTimer: NodeJS.Timeout | null = null

  constructor(options: { autoLoad?: boolean } = {}) {
    // 客户端每次启动都严格保持未登录，仅加载本地元数据供「一键填充」消费。
    // 绝不自动恢复 active、绝不自动启动保活，避免底层 Cookie 悬挂导致的假在线。
    if (options.autoLoad !== false) {
      this.loadPersistedAccount()
    }
  }

  /** 绑定状态变更回调（主进程向渲染进程广播） */
  public setStatusCallback(cb: (profile: CdutAccountProfile) => void): void {
    this.onStatusChangeCallback = cb
  }

  /** 获取当前特区账户快照 */
  public getProfile(): CdutAccountProfile {
    return { ...this.profile }
  }

  /**
   * 从 ~/.cdutai/cdut-account.json 加载持久化的特区账户元数据。
   * 注意：加载后状态恒为 disconnected，持久化凭据仅供「一键填充」读取，
   * 不代表本次启动已登录（登录必须重新走全新 CAS 通道）。
   */
  public loadPersistedAccount(): void {
    try {
      const filePath = getCdutAccountPath()
      if (!existsSync(filePath)) return

      const data = readJsonFileSafe<StoredCdutAccount>(filePath)
      if (data && data.studentId) {
        const cachedAvatar = loadAvatarFromCache(data.studentId)
        this.profile = {
          studentId: data.studentId,
          studentName: data.studentName || data.studentId,
          avatar: data.avatar || cachedAvatar,
          college: data.college,
          major: data.major,
          classCode: data.classCode,
          role: data.role,
          status: 'disconnected',
          rememberPassword: data.rememberPassword,
          lastLoginAt: data.lastLoginAt,
          lastActiveAt: data.lastActiveAt,
        }
      }
    } catch (err) {
      console.error('[CdutAuthManager] 加载本地特区账户配置失败:', err)
    }
  }

  /**
   * 读取并解密已记住的密码。
   * @returns 记住密码时返回明文，否则返回 null。
   */
  public getRememberedPassword(): string | null {
    try {
      const data = readJsonFileSafe<StoredCdutAccount>(getCdutAccountPath())
      if (!data || !data.rememberPassword || !data.encryptedPassword) return null
      return decryptToken(data.encryptedPassword)
    } catch (err) {
      console.error('[CdutAuthManager] 解密已记住密码失败:', err)
      return null
    }
  }

  /**
   * 读取本地已保存的特区账户摘要，供登录窗「一键填充并登录」引导消费。
   * 不回传 Cookie；密码仅在勾选「记住密码」且可解密时返回明文。
   */
  public getSavedAccount(): CdutSavedAccountSummary {
    try {
      const data = readJsonFileSafe<StoredCdutAccount>(getCdutAccountPath())
      if (!data || !data.studentId) return { hasSaved: false }

      const cachedAvatar = data.studentId ? loadAvatarFromCache(data.studentId) : undefined
      const summary: CdutSavedAccountSummary = {
        hasSaved: true,
        studentId: data.studentId,
        studentName: data.studentName || data.studentId,
        avatar: data.avatar || cachedAvatar,
        rememberPassword: !!data.rememberPassword,
      }
      if (data.rememberPassword && data.encryptedPassword) {
        const plain = decryptToken(data.encryptedPassword)
        if (plain) summary.savedPassword = plain
      }
      return summary
    } catch (err) {
      console.error('[CdutAuthManager] 读取已保存特区账户失败:', err)
      return { hasSaved: false }
    }
  }

  /**
   * 客户端启动治理：复位为未登录并清空专属网络分区 Cookie/Cache。
   * 由主进程在 app ready 后调用，确保每次启动都走全新纯净的 CAS 通道，
   * 彻底规避内网残留 Token 造成的 302 重定向循环或会话串扰。
   */
  public async resetOnStartup(): Promise<void> {
    this.stopKeepAlive()
    this.profile.status = 'disconnected'
    try {
      const authSession = session.fromPartition(CDUT_AUTH_PARTITION)
      await authSession.clearStorageData()
      console.log('[CdutAuthManager] 启动已清空特区账户分区存储，登录态复位为未登录')
    } catch (err) {
      console.warn('[CdutAuthManager] 启动清空认证分区失败:', err)
    }
    this.onStatusChangeCallback?.(this.getProfile())
  }

  /** 启动 10 分钟静默保活心跳（定时器 unref，避免阻塞进程退出） */
  private startKeepAlive(): void {
    this.stopKeepAlive()
    this.keepAliveTimer = setInterval(async () => {
      if (this.profile.status !== 'active') {
        this.stopKeepAlive()
        return
      }
      try {
        const authSession = session.fromPartition(CDUT_AUTH_PARTITION)
        // 探活前先剔除陈旧瑞数 *P 签名，避免携带失效签名触发网关 HTTP 400
        await stripStaleRuiShuCookies(authSession)
        const res = await authSession.fetch(JW_HOME_URL, {
          method: 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(8000),
        })
        // 重定向至 CAS 或返回未授权，判定会话已过期
        const location = res.headers.get('location') || ''
        if (location.includes('/cas/login') || res.status === 401 || res.status === 403) {
          console.warn('[CdutAuthManager] 内网会话已过期')
          this.profile.status = 'expired'
          this.onStatusChangeCallback?.(this.getProfile())
          this.stopKeepAlive()
        } else if (res.status === 200) {
          // 仅 HTTP 200 才代表会话真实可用，如实刷新活跃时间
          this.profile.lastActiveAt = Date.now()
          this.onStatusChangeCallback?.(this.getProfile())
        } else {
          // 400/500/502 等异常不得伪造成保活成功
          console.warn(
            `[CdutAuthManager] 静默保活探测返回异常状态: HTTP ${res.status}，本次不刷新活跃时间`,
          )
        }
      } catch (err) {
        console.warn('[CdutAuthManager] 静默保活请求异常:', err)
      }
    }, KEEP_ALIVE_INTERVAL_MS)
    this.keepAliveTimer.unref()
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer)
      this.keepAliveTimer = null
    }
  }

  /**
   * 执行后台无头 CAS 登录与画像全流程。
   */
  public async login(input: CdutLoginInput): Promise<CdutLoginResult> {
    // 演示账户优先命中：旁路真实 CAS，仅进入内存演示态（不保活、不落盘），供离线产品演示使用
    const demoResult = cdutDemoService.tryLogin(input)
    if (demoResult) {
      if (demoResult.success && demoResult.profile) {
        this.stopKeepAlive()
        this.profile = demoResult.profile
        this.onStatusChangeCallback?.(this.getProfile())
      }
      return demoResult
    }

    const { username, password, rememberPassword = true } = input
    if (!username || !password) {
      return { success: false, error: '学工号和密码不能为空' }
    }
    if (this.authWindow && !this.authWindow.isDestroyed()) {
      return { success: false, error: '正在认证中，请稍候…' }
    }

    return new Promise<CdutLoginResult>((resolve) => {
      let resolved = false
      let submitted = false
      let harvesting = false

      let timer: ReturnType<typeof setTimeout> | null = null

      const finish = (result: CdutLoginResult) => {
        if (resolved) return
        resolved = true
        if (timer) clearTimeout(timer)
        if (this.authWindow && !this.authWindow.isDestroyed()) {
          this.authWindow.destroy()
        }
        this.authWindow = null
        if (result.success && result.profile) {
          this.profile = result.profile
          this.startKeepAlive()
          this.onStatusChangeCallback?.(this.getProfile())
        }
        resolve(result)
      }

      timer = setTimeout(() => {
        finish({ success: false, error: '登录超时，请检查网络是否能访问成都理工大学内网' })
      }, LOGIN_TIMEOUT_MS)

      const authWindow = new BrowserWindow({
        show: false,
        width: 1200,
        height: 800,
        webPreferences: {
          partition: CDUT_AUTH_PARTITION,
          nodeIntegration: false,
          contextIsolation: true,
        },
      })
      this.authWindow = authWindow
      const webContents = authWindow.webContents

      /** 认证已成功但画像不可得时，以学工号保底结算并落盘，绝不返回登录失败。 */
      const settleWithFallbackProfile = (): void => {
        const now = Date.now()
        const fallbackProfile: CdutAccountProfile = {
          studentId: username,
          studentName: username,
          status: 'active',
          rememberPassword,
          lastLoginAt: now,
          lastActiveAt: now,
        }
        this.persistAccount({ ...fallbackProfile, password: rememberPassword ? password : '' })
        finish({ success: true, profile: fallbackProfile })
      }

      // 登录成功落地青果教务系统后，直取学籍画像并完成结算（重入由调用点的 harvesting 同步置位守卫）
      const harvestProfileAndFinish = async () => {
        if (resolved) return

        try {
          console.log('[CdutAuthManager] 已落地教务主框架，开始双轨抓取学生画像…')
          const authSession = session.fromPartition(CDUT_AUTH_PARTITION)

          // 双轨之一：主框架顶栏 DOM 直取真实中文姓名（不依赖任何网络请求，先保底拿到姓名）
          let domName = ''
          try {
            if (!authWindow.isDestroyed()) {
              domName = ((await webContents.executeJavaScript(EXTRACT_TOP_NAME_SCRIPT)) as string) || ''
            }
          } catch (domErr) {
            console.warn('[CdutAuthManager] 顶栏姓名 DOM 提取失败:', domErr)
          }
          if (domName) console.log('[CdutAuthManager] 主框架顶栏姓名:', domName)

          // 双轨之二（主轨）：在已通过瑞数 WAF 校验的 authWindow 上下文内原生抓取完整画像。
          // 该轨拥有真实 Chromium JS 引擎与动态安全 Cookie，可彻底规避 session.fetch 的 HTTP 412。
          let windowProfile: JwProfileSummary | null = null
          try {
            if (!authWindow.isDestroyed()) {
              await stripStaleRuiShuCookies(authSession)
              const raw = (await Promise.race([
                webContents.executeJavaScript(EXTRACT_FULL_PROFILE_SCRIPT),
                new Promise<null>((r) => setTimeout(() => r(null), 12_000)),
              ])) as Partial<JwProfileSummary> | null
              if (raw && typeof raw === 'object') {
                windowProfile = {
                  name: raw.name || '',
                  studentId: raw.studentId || '',
                  college: raw.college || '',
                  major: raw.major || '',
                  className: raw.className || '',
                  avatar: raw.avatar || undefined,
                }
                console.log('[CdutAuthManager] authWindow 窗口上下文画像提取结果:', {
                  name: windowProfile.name,
                  studentId: windowProfile.studentId,
                  college: windowProfile.college,
                  major: windowProfile.major,
                  className: windowProfile.className,
                  hasAvatar: !!windowProfile.avatar,
                })
              } else {
                console.warn('[CdutAuthManager] authWindow 窗口上下文画像提取超时或返回空')
              }
            }
          } catch (winErr) {
            console.warn('[CdutAuthManager] authWindow 窗口上下文画像提取失败，将回退 Node 侧抓取:', winErr)
          }

          // 备用机制：若窗口内 fetch 未拿到学院或专业，驱动 authWindow 直接导航至学籍页渲染
          let windowUsable = !!(windowProfile && (windowProfile.college || windowProfile.major))
          if (!windowUsable && !authWindow.isDestroyed()) {
            try {
              console.log('[CdutAuthManager] 窗口内 fetch 未命中学院/专业，驱动 authWindow 直接导航至学籍页…')
              await stripStaleRuiShuCookies(authSession)
              await authWindow.loadURL('https://jw.cdut.edu.cn/jsxsd/grxx/xsxx')
              await new Promise((r) => setTimeout(r, 800))
              const directDocProfile = (await webContents.executeJavaScript(
                EXTRACT_PAGE_PROFILE_AND_PHOTO_SCRIPT
              )) as (Partial<JwProfileSummary> & { photoUrl?: string }) | null
              if (directDocProfile && (directDocProfile.college || directDocProfile.major || directDocProfile.name)) {
                windowProfile = { ...(windowProfile || {}), ...directDocProfile } as JwProfileSummary
                windowUsable = true
                if (directDocProfile.avatar) {
                  windowProfile.avatar = directDocProfile.avatar
                  console.log('[CdutAuthManager] authWindow 窗口内直接提取头像成功 (Base64 长度:', directDocProfile.avatar.length, ')')
                } else if (directDocProfile.photoUrl) {
                  console.log('[CdutAuthManager] authWindow 窗口内定位到照片地址，启用 Node 侧下载:', directDocProfile.photoUrl)
                  windowProfile.avatar = await fetchImageAsBase64(authSession, directDocProfile.photoUrl, 'https://jw.cdut.edu.cn/jsxsd/grxx/xsxx')
                }
                console.log('[CdutAuthManager] authWindow 直接导航学籍页取得画像:', {
                  college: windowProfile.college,
                  major: windowProfile.major,
                  className: windowProfile.className,
                  hasAvatar: !!windowProfile.avatar,
                })
              }

              // 若学籍卡片页仍未获取到头像，驱动 authWindow 导航至学籍信息管理 /xsxj/xjxxgl.do 尝试抓取头像
              if (!windowProfile?.avatar && !authWindow.isDestroyed()) {
                try {
                  console.log('[CdutAuthManager] /grxx/xsxx 未提取到头像，驱动 authWindow 导航至学籍管理页 /xsxj/xjxxgl.do 尝试抓取头像…')
                  await stripStaleRuiShuCookies(authSession)
                  await authWindow.loadURL('https://jw.cdut.edu.cn/jsxsd/xsxj/xjxxgl.do')
                  await new Promise((r) => setTimeout(r, 800))
                  const xjxxDocProfile = (await webContents.executeJavaScript(
                    EXTRACT_PAGE_PROFILE_AND_PHOTO_SCRIPT
                  )) as (Partial<JwProfileSummary> & { photoUrl?: string }) | null
                  if (xjxxDocProfile?.avatar) {
                    windowProfile = { ...(windowProfile || {}), avatar: xjxxDocProfile.avatar } as JwProfileSummary
                    console.log('[CdutAuthManager] /xsxj/xjxxgl.do 窗口内提取头像成功 (Base64 长度:', xjxxDocProfile.avatar.length, ')')
                  } else if (xjxxDocProfile?.photoUrl) {
                    console.log('[CdutAuthManager] /xsxj/xjxxgl.do 定位到照片地址，启用 Node 侧下载:', xjxxDocProfile.photoUrl)
                    const fetchedAvatar = await fetchImageAsBase64(authSession, xjxxDocProfile.photoUrl, 'https://jw.cdut.edu.cn/jsxsd/xsxj/xjxxgl.do')
                    if (fetchedAvatar) {
                      windowProfile = { ...(windowProfile || {}), avatar: fetchedAvatar } as JwProfileSummary
                    }
                  }
                  if (xjxxDocProfile?.college && (!windowProfile || !windowProfile.college)) {
                    windowProfile = { ...(windowProfile || {}), college: xjxxDocProfile.college } as JwProfileSummary
                  }
                  if (xjxxDocProfile?.major && (!windowProfile || !windowProfile.major)) {
                    windowProfile = { ...(windowProfile || {}), major: xjxxDocProfile.major } as JwProfileSummary
                  }
                } catch (xjxxErr) {
                  console.warn('[CdutAuthManager] /xsxj/xjxxgl.do 导航提取异常:', xjxxErr)
                }
              }
            } catch (navErr) {
              console.warn('[CdutAuthManager] authWindow 导航提取异常:', navErr)
            }
          }

          let summary: JwProfileSummary
          if (windowUsable && windowProfile) {
            summary = windowProfile
            console.log('[CdutAuthManager] 主轨（authWindow 上下文）已取得学院/专业')
            if (!summary.avatar) {
              try {
                console.log('[CdutAuthManager] 主轨未拿到头像，启用 Node 侧 fetchJwProfileSummary 补录头像…')
                await stripStaleRuiShuCookies(authSession)
                const nodeSummary = await fetchJwProfileSummary(authSession)
                if (nodeSummary.avatar) {
                  summary.avatar = nodeSummary.avatar
                  console.log('[CdutAuthManager] Node 侧补录头像成功')
                }
              } catch (nodeErr) {
                console.warn('[CdutAuthManager] Node 侧补录头像异常:', nodeErr)
              }
            }
          } else {
            // 兜底轨：经专属 Session 拉取学籍卡片与证件照 Base64（最长轮询 10 秒）
            console.log('[CdutAuthManager] 主轨未取得学院/专业，启用 Node 侧 fetchJwProfileSummary 兜底…')
            const startPoll = Date.now()
            summary = await fetchJwProfileSummary(authSession)
            let avatarRetries = 0
            while (Date.now() - startPoll < 10_000) {
              const textReady = !!(summary.name || summary.studentId)
              // 文本画像已就绪：不再空转整段时间，仅为尚未拿到的证件照补几次机会
              if (textReady && summary.avatar) break
              if (textReady) {
                if (avatarRetries >= 4) break
                avatarRetries++
              }
              if (resolved || authWindow.isDestroyed()) return
              await new Promise((r) => setTimeout(r, 500))
              summary = await fetchJwProfileSummary(authSession)
            }
            // 主轨已拿到部分字段（如头像/班级）时，与兜底轨做字段级互补合并
            if (windowProfile) {
              summary = {
                name: summary.name || windowProfile.name,
                studentId: summary.studentId || windowProfile.studentId,
                college: summary.college || windowProfile.college,
                major: summary.major || windowProfile.major,
                className: summary.className || windowProfile.className,
                avatar: summary.avatar || windowProfile.avatar,
              }
            }
          }

          const now = Date.now()
          const finalProfile: CdutAccountProfile = {
            studentId: summary.studentId || username,
            // 姓名优先级：主框架顶栏真实姓名 > 学籍卡片姓名 > 学工号占位
            studentName: domName || summary.name || username,
            avatar: summary.avatar || this.profile.avatar || undefined,
            college: summary.college || undefined,
            major: summary.major || undefined,
            classCode: summary.className || undefined,
            role: '学生',
            status: 'active',
            rememberPassword,
            lastLoginAt: now,
            lastActiveAt: now,
          }

          // 细粒度来源日志：明确每个字段取自哪条链路，杜绝空日志排查困难
          console.log('[CdutAuthManager] 青果教务画像聚合完成:', {
            nameSource: domName ? '主框架顶栏DOM' : summary.name ? (windowUsable ? 'authWindow上下文' : 'Node兜底') : '学工号占位',
            name: finalProfile.studentName,
            studentId: finalProfile.studentId,
            college: finalProfile.college,
            major: finalProfile.major,
            classCode: finalProfile.classCode,
            avatarSource: finalProfile.avatar ? (summary.avatar ? (windowUsable ? 'authWindow上下文' : 'Node兜底') : '本地缓存') : '未获取',
            hasAvatar: !!finalProfile.avatar,
          })

          // 登录可能已被硬超时结算或认证窗口被销毁：禁止迟到的画像落盘
          if (resolved) return
          if (authWindow.isDestroyed()) {
            finish({ success: false, error: '认证窗口已关闭' })
            return
          }

          this.persistAccount({ ...finalProfile, password: rememberPassword ? password : '' })
          finish({ success: true, profile: finalProfile })
        } catch (extractErr) {
          // 已结算（如登录硬超时）时严禁把 dummy 画像写成 active；窗口已销毁则结算失败并清理引用
          if (resolved) return
          if (authWindow.isDestroyed()) {
            finish({ success: false, error: '认证窗口已关闭' })
            return
          }
          console.error('[CdutAuthManager] 画像提取异常，进入兜底模式:', extractErr)
          settleWithFallbackProfile()
        }
      }

      // 页面（主框架）加载完成事件：统一在此判定落点并驱动提交流程。
      // 之所以用 did-finish-load 而非 did-navigate：只有页面渲染完成、
      // 瑞数 WAF 脚本执行完毕、Cookie 完全落定后，DOM 顶栏姓名才可靠可读。
      webContents.on('did-finish-load', async () => {
        if (resolved) return
        const currentUrl = webContents.getURL()

        // A) 落点已收敛至教务主框架：认证真正成功，启动双轨画像提取
        if (isMainHomeUrl(currentUrl)) {
          // 认证已真正成功：25s 登录硬超时立即失效，改用独立的画像抓取宽限计时器。
          // 宽限到点也必须以成功结算，绝不能反向否决已完成的 CAS 认证。
          if (!harvesting) {
            // 先同步置位再启动异步流程：同一微任务阶段的重复 did-finish-load 不会重入。
            harvesting = true
            if (timer) clearTimeout(timer)
            timer = setTimeout(() => {
              if (resolved) return
              console.warn('[CdutAuthManager] 画像抓取超出宽限时限，使用学工号保底画像结算')
              settleWithFallbackProfile()
            }, PROFILE_HARVEST_TIMEOUT_MS)
            void harvestProfileAndFinish()
          }
          return
        }

        // B) CAS 登录页：注入凭证并提交表单（提交仅一次）
        if (!submitted && isCasLoginUrl(currentUrl)) {
          try {
            const injectRes = (await webContents.executeJavaScript(
              buildVantInjectScript(username, password)
            )) as { ready?: boolean; submitted?: boolean; blockedReason?: string }

            if (injectRes?.submitted) {
              submitted = true
              console.log('[CdutAuthManager] 已提交 CAS 登录表单，等待 SSO 票据握手与主框架加载…')
              return
            }
            // 明确的 CAS 拦截/异常页（如「未认证授权的服务」）如实报错；
            // 其余「表单未就绪」不做 2.5 秒强判定，交由后续导航或整体硬超时处理
            if (injectRes?.blockedReason && /未认证授权|服务/.test(injectRes.blockedReason)) {
              finish({ success: false, error: injectRes.blockedReason })
              return
            }
            console.warn('[CdutAuthManager] CAS 表单暂未就绪，等待重试:', injectRes?.blockedReason)
          } catch (err) {
            finish({ success: false, error: '注入表单提交失败: ' + (err as Error).message })
          }
          return
        }

        // C) 已提交后仍停留在 CAS 登录页：读取页面真实错误文案，如实报错。
        //    未捕获到错误则不结算，继续等待主框架导航（可能仍在 WAF 握手）。
        if (submitted && isCasLoginUrl(currentUrl)) {
          const errorMsg = (await webContents
            .executeJavaScript(EXTRACT_ERROR_SCRIPT)
            .catch(() => '')) as string
          if (errorMsg) {
            finish({ success: false, error: errorMsg })
          }
        }
      })

      // 加载失败（忽略 -3 ERR_ABORTED，重定向常见）
      webContents.on(
        'did-fail-load',
        (_event, errorCode, errorDescription, _url, isMainFrame) => {
          // 认证已成功并进入画像抓取后，辅助页面（学籍卡片 / xjxxgl.do）的偶发失败
          // 由抓取自身 try/catch 兜底，绝不能反向否决已经成功的整体登录。
          if (!isMainFrame || errorCode === -3 || harvesting) return
          finish({ success: false, error: '无法打开内网认证页: ' + errorDescription })
        }
      )

      authWindow.loadURL(CAS_LOGIN_URL).catch((err: Error) => {
        finish({ success: false, error: '无法打开内网认证页: ' + err.message })
      })
    })
  }

  /**
   * 退出特区账户：停止保活、清理本地持久化凭证与专属分区缓存。
   * 同时清理 .bak / .tmp 残留，避免密文密码被备份文件间接保留。
   */
  public async logout(): Promise<void> {
    this.stopKeepAlive()
    // 复位演示态：确保演示账户登出后工具层立即回落真实门禁
    cdutDemoService.reset()

    // 1) 删除本地持久化凭据（含 .bak / .tmp 残留）与证件照缓存
    try {
      if (this.profile.studentId) {
        const avatarPath = getAvatarCachePath(this.profile.studentId)
        if (existsSync(avatarPath)) {
          try {
            unlinkSync(avatarPath)
          } catch (avatarErr) {
            console.warn('[CdutAuthManager] 删除头像缓存失败:', avatarErr)
          }
        }
      }

      const filePath = getCdutAccountPath()
      for (const candidate of [filePath, filePath + '.bak', filePath + '.tmp']) {
        if (existsSync(candidate)) {
          try {
            unlinkSync(candidate)
          } catch (unlinkErr) {
            console.warn('[CdutAuthManager] 删除本地凭据文件失败:', candidate, unlinkErr)
          }
        }
      }
    } catch (err) {
      console.error('[CdutAuthManager] 清理本地凭据失败:', err)
    }

    // 2) 清空专属 session 分区数据（失败不阻断状态复位）
    try {
      const authSession = session.fromPartition(CDUT_AUTH_PARTITION)
      await authSession.clearStorageData()
    } catch (err) {
      console.warn('[CdutAuthManager] 清理认证分区失败:', err)
    }

    // 3) 复位内存状态并广播
    this.profile = {
      studentId: '',
      studentName: '',
      status: 'disconnected',
    }
    this.onStatusChangeCallback?.(this.getProfile())
  }

  /** 加密落盘保存特区账户（仅密码字段加密） */
  private persistAccount(params: CdutAccountProfile & { password?: string }): void {
    try {
      if (params.studentId && params.avatar) {
        saveAvatarToCache(params.studentId, params.avatar)
      }

      const { password, rememberPassword, ...profileData } = params
      const encryptedPassword = rememberPassword && password ? encryptToken(password) : ''

      const data: StoredCdutAccount = {
        ...profileData,
        studentId: params.studentId,
        studentName: params.studentName,
        rememberPassword: !!rememberPassword,
        encryptedPassword,
        status: 'active',
        lastLoginAt: params.lastLoginAt || Date.now(),
        lastActiveAt: params.lastActiveAt || Date.now(),
      }

      writeJsonFileAtomic(getCdutAccountPath(), data)
    } catch (err) {
      console.error('[CdutAuthManager] 写入本地凭据文件失败:', err)
    }
  }
}

export const cdutAuthManager = new CdutAuthManager()
