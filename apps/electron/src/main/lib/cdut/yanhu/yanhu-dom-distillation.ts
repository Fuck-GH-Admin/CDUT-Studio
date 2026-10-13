/**
 * 智联万站 · 无视感知（Vision-Less）DOM 蒸馏引擎（YanhuDomDistillationEngine）
 *
 * 依据《The Architecture of Vision-Less Web Perception》研究成果，落地四级工业级算法流水线：
 *   第一级：AXTree / DOM 语义降噪——跳过排版容器、脚本文档与装饰性资源，仅保留语义元素；
 *   第二级：动态布局与可视性剪枝——剔除 0 面积、display:none、visibility:hidden、aria-hidden；
 *   第三级：Z-Index 遮罩穿透校验——中心点 elementFromPoint 命中判定，标注 [Occluded]；
 *   第四级：层次化功能区解构（Region4Web 风格）——把页面切分为导航栏 / 业务表单 / 数据表格等语义块。
 *
 * 随后通过双射动态 ID（BIDs）把交互候选集映射为 [1], [2]... 的整数编号，投递极简紧凑 Prompt（1k~1.8k Tokens），
 * 并保留内存映射供 `resolveBid(bid)` 毫秒级反查，彻底消灭 CSS 选择器 / XPath 幻觉。
 *
 * 设计约束：本模块的纯函数部分不依赖 Electron，可在单测中直接消费；类实例仅做缓存与编排。
 */

import type { YanhuBidNode, YanhuDistilledPage } from '@profer/shared'

/** 单个可交互节点的 BID 标定记录（含反查与确定性分派所需的全部字段） */
export interface BidNodeRecord extends YanhuBidNode {
  /** CDP backendNodeId（若可获取，供精确定位） */
  backendNodeId?: number
  /** 稳定的 CSS 选择器回退路径（仅在 CDP 反查失败时兜底） */
  selector: string
  /** 该记录来自历史回退池（当前索引已因 markDirty 失效），定位时需放宽判定 */
  stale?: boolean
}

/** 页面采集脚本回传的原始元素（未经蒸馏） */
export interface YanhuRawElement {
  tag: string
  role: string
  name: string
  value?: string
  description?: string
  bounds: { x: number; y: number; width: number; height: number }
  /** 计算样式判定为可见（display/visibility/opacity） */
  visible: boolean
  ariaHidden: boolean
  /** 中心点被上层元素遮挡 */
  occluded: boolean
  /** 所属语义区域标签 */
  region: string
  /** 是否具备交互能力 */
  actionable: boolean
  /** 是否处于折叠 / 后台隐藏容器内（display:none / 零高宽 / 未激活 tab-pane 等） */
  collapsed?: boolean
  /** 框架路径（嵌套 frame/iframe 标识，如 leftFrame, mainFrame） */
  framePath?: string
  options?: Array<{ value: string; text: string; selected: boolean }>
}

/** 页面采集脚本的完整回传结构 */
export interface YanhuCollectedPage {
  url: string
  title: string
  elements: YanhuRawElement[]
  /** 全框架穿透直提的结构化业务数据表格（成绩/课表/考务/选课等）的 Markdown 快照（采集端已内置上限收敛） */
  dataTables?: string[]
  /** 全框架可见渲染文本的归一化哈希（URL / 框架不变时唯一可观测的「内容变化」信号） */
  textDigest?: string
  /** 渲染文本摘要（有界截断），随 PageDigest 投递给模型 */
  textSample?: string
}

/** 单次采集硬上限（防止超大页面拖垮主进程与大模型上下文，深层全景探测扩容至 1000） */
const MAX_COLLECTED_ELEMENTS = 1000
/**
 * 导航 / 辅助框架（leftFrame、menu、nav、topHeader 等）的独立配额上限。
 *
 * 多层 frameset 遍历顺序为 top -> left -> main，若沿用单一全局配额，前置导航树会吃光额度
 * 并「饿死」排在后面的核心业务框架 mainFrame。此处为导航框架设立收敛阈值，绝不侵占主业务
 * 框架的宝贵额度，从根源杜绝页面靠后深层业务元素被丢弃。
 */
const MAX_NAV_FRAME_ELEMENTS = 120
/** 折叠/后台隐藏元素的独立采集上限（仅采集「有名称且可交互」者，避免 Token 与候选集膨胀） */
const MAX_COLLAPSED_ELEMENTS = 80
/** 元素名称最大字符数 */
const MAX_NAME_CHARS = 80

/**
 * 采集端与定位端**共用**的可访问名推导脚本片段（W3C AccName 四阶关联 + 向上回溯）。
 *
 * 历史缺陷：采集端（computeName）与定位端（buildFinderPrelude 内的 text 推导）使用了
 * 不同的优先级链（采集端含 aria-labelledby / alt / submit 的 value），导致靠这些属性命名
 * 的控件在点击时名称恒不匹配，进而退化为「坐标最近者」而静默点错控件。
 * 此处抽出唯一权威实现，两端同时注入，从根源保证 BID 语义与定位完全一致。
 *
 * 本轮升级（CI4A / GUI-AIMA 语义 Grounding）：
 *   1. ARIA 权威声明优先（aria-label / aria-labelledby）；
 *   2. 表单元素 W3C 原生标签关联（labels / label[for] / 祖先 <label> / 同级兄弟与紧邻容器文本），
 *      修复金智 EMAP / Vue 单选组「<input type="radio"> 无内联文本、Label 结构性解耦」导致
 *      控件名恒为空、模型盲试的经典瓶颈；
 *   3. 按钮类 value 与 title / placeholder / alt；
 *   4. 内联文本与通用回退。
 */
export const YANHU_ACCESSIBLE_NAME_SNIPPET = `
      const __yanhuCleanName = (raw) => {
        const t = (raw || '').replace(/\\s+/g, ' ').trim();
        return t.length > ${MAX_NAME_CHARS} ? t.slice(0, ${MAX_NAME_CHARS}) + '…' : t;
      };
      const __yanhuDeriveName = (el, doc) => {
        const attrOf = (n) => (el.getAttribute ? (el.getAttribute(n) || '') : '');
        const tag = (el.tagName || '').toLowerCase();
        const type = attrOf('type').toLowerCase();
        const role = attrOf('role').toLowerCase();

        // 1. ARIA 权威声明优先
        const aria = attrOf('aria-label');
        if (aria) return __yanhuCleanName(aria);
        const labelled = attrOf('aria-labelledby');
        if (labelled && doc && doc.getElementById) {
          const target = doc.getElementById(labelled);
          if (target && target.textContent) return __yanhuCleanName(target.textContent);
        }

        // 2. 表单元素原生标签关联（W3C AccName 规范核心）
        if (tag === 'input' || tag === 'select' || tag === 'textarea' || role === 'radio' || role === 'checkbox') {
          // 2a. HTMLInputElement.labels
          if (el.labels && el.labels.length > 0) {
            for (let i = 0; i < el.labels.length; i++) {
              const lt = (el.labels[i].textContent || '').trim();
              if (lt) return __yanhuCleanName(lt);
            }
          }
          // 2b. 外部 <label for="id">
          if (el.id && doc && doc.querySelector) {
            try {
              const forLabel = doc.querySelector('label[for="' + CSS.escape(el.id) + '"]');
              if (forLabel && forLabel.textContent) {
                const lt = forLabel.textContent.trim();
                if (lt) return __yanhuCleanName(lt);
              }
            } catch (e) {}
          }
          // 2c. 向上追溯祖先 <label>（Vue / Element / EMAP 封装常见）
          const parentLabel = el.closest ? el.closest('label') : null;
          if (parentLabel && parentLabel.textContent) {
            const lt = parentLabel.textContent.trim();
            if (lt) return __yanhuCleanName(lt);
          }
          // 2d. 单选 / 复选同级兄弟文本节点与紧邻容器文本
          if (type === 'radio' || type === 'checkbox' || role === 'radio' || role === 'checkbox') {
            let sib = el.nextElementSibling;
            while (sib) {
              const st = (sib.textContent || '').trim();
              if (st && st.length <= 40) return __yanhuCleanName(st);
              sib = sib.nextElementSibling;
            }
            const parent = el.parentElement;
            if (parent) {
              const pt = (parent.textContent || '').trim();
              if (pt && pt.length <= 40) return __yanhuCleanName(pt);
            }
          }
        }

        // 3. 按钮类 value 与 title / placeholder / alt
        if (tag === 'input' && (type === 'submit' || type === 'button' || type === 'reset')) {
          const v = el.value || attrOf('value');
          if (v) return __yanhuCleanName(v);
        }
        const title = attrOf('title');
        const placeholder = attrOf('placeholder');
        const alt = attrOf('alt');

        // 4. 内联文本与通用回退
        const text = el.innerText || el.textContent || '';
        return __yanhuCleanName(text || title || placeholder || alt || '');
      };
    `
/** 键值最大字符数 */
const MAX_VALUE_CHARS = 60

/**
 * 「可点击容器」直接子项拆分时，单个子项文本的最大字符数。
 *
 * 仅把「短文本子项」（菜单项 / 标签页等）拆为独立可交互项；长文本（卡片正文段落）不拆，
 * 避免把一个卡片炸成多条噪声 BID。24 字符足以覆盖中文菜单项，同时排除正文描述。
 */
export const CLICKABLE_CONTAINER_SPLIT_MAX_ITEM_CHARS = 24
/** 静态导航菜单折叠阈值：单区域导航项超过该数量即折叠为一行（削减重复常驻菜单的 Token） */
export const NAV_REGION_FOLD_THRESHOLD = 15
/** 导航菜单超阈值时的行内紧凑排版：每行承载的菜单项数量（100% 保留 BID 双射，压制 Token） */
export const NAV_INLINE_ITEMS_PER_LINE = 4
/** 通用数据表格 Markdown 快照最大数量（防多表噪声） */
const MAX_DATA_TABLES = 4
/** 通用数据表格 Markdown 最大行数 / 列数 / 单元格字符数（硬熔断） */
const MAX_DATA_ROWS = 40
const MAX_DATA_COLS = 10
const MAX_DATA_CELL_CHARS = 30
/** Git-Diff 局部增量输出：单次最多展示的新展开项数量（超过则退回全量 PageDigest） */
export const DIFF_MAX_ADDED_ITEMS = 8
/** 渲染内容摘要（textSample）随 PageDigest 投递的最大字符数 */
export const MAX_TEXT_SAMPLE_CHARS = 480

/**
 * 生成注入页面主上下文运行的采集脚本。
 *
 * 该脚本在页面内完成第一 ~ 第四级的原始数据采集（语义降噪 / 布局可视性 / 遮挡校验 / 区域解构），
 * 以纯 JSON 结构回传，交由主进程纯函数做标定与序列化，保证算法可测试、可审计。
 */
export function buildYanhuCollectorScript(): string {
  return `(() => {
    try {
      const MAX = ${MAX_COLLECTED_ELEMENTS};
      const MAX_NAV = ${MAX_NAV_FRAME_ELEMENTS};
      const MAX_COLLAPSED = ${MAX_COLLAPSED_ELEMENTS};
      const emit = [];
      const dataTables = [];
      let collapsedCount = 0;
      // 分框架配额倾斜：判定当前框架是否属于导航 / 辅助框架（其采集量受 MAX_NAV 收敛）
      const isNavFramePath = (fp) => /(left|menu|nav|top|header|bottom|footer)/i.test(fp || '');

      const ACTIONABLE_TAGS = new Set(['button','a','input','select','textarea','option','summary']);
      const ACTIONABLE_ROLES = new Set(['button','link','checkbox','radio','tab','menuitem','option','switch','textbox','searchbox','combobox','slider','spinbutton']);

      const tagOf = (el) => (el.tagName || '').toLowerCase();
      const attr = (el, name) => (el.getAttribute ? (el.getAttribute(name) || '') : '');

      // 通用「穿透 Shadow DOM」查询：现代 Web Components（Shoelace / 自研企业组件）把真实控件
      // 关进 shadowRoot，普通 querySelectorAll('*') 完全不可见。此处对每层 shadowRoot 递归下钻
      // （含嵌套影子树），把影子树内匹配元素一并展平返回；访问 shadowRoot 对 closed 模式安全返回 null。
      const queryAllDeep = (root, selector) => {
        const out = [];
        if (!root || !root.querySelectorAll) return out;
        let list = [];
        try { list = Array.from(root.querySelectorAll(selector)); } catch (e) { list = []; }
        for (let i = 0; i < list.length; i++) out.push(list[i]);
        const dive = (nodes) => {
          for (let i = 0; i < nodes.length; i++) {
            const sr = nodes[i] && nodes[i].shadowRoot;
            if (!sr || !sr.querySelectorAll) continue;
            let inner = [];
            try { inner = Array.from(sr.querySelectorAll(selector)); } catch (e) { inner = []; }
            for (let j = 0; j < inner.length; j++) out.push(inner[j]);
            dive(inner);
          }
        };
        dive(list);
        return out;
      };

      // 组合树（Composed Tree）包含判定：shadow 边界会让 Node.contains 返回 false，导致影子树内
      // 控件经 elementFromPoint 命中其宿主时被误判为「被遮挡」。此处自 el 向上逐层经
      // getRootNode().host 穿越 shadow 边界做双向包含校验，从根源消除影子控件的遮挡误报。
      const __composedContains = (ancestor, node) => {
        if (!ancestor || !node) return false;
        if (ancestor === node) return true;
        try { if (ancestor.contains && ancestor.contains(node)) return true; } catch (e) {}
        return false;
      };
      const __inComposedChain = (el, hit) => {
        if (!hit) return true;
        if (__composedContains(el, hit) || __composedContains(hit, el)) return true;
        let node = el, guard = 0;
        while (node && guard < 30) {
          let root = null;
          try { root = node.getRootNode ? node.getRootNode() : null; } catch (e) {}
          const host = root && root.host;
          if (!host) break;
          if (host === hit || __composedContains(host, hit) || __composedContains(hit, host)) return true;
          node = host;
          guard += 1;
        }
        return false;
      };

      const computeRole = (el, tag) => {
        const explicit = attr(el, 'role').trim();
        if (explicit) return explicit;
        if (tag === 'a') return attr(el, 'href') ? 'link' : 'generic';
        if (tag === 'button') return 'button';
        if (tag === 'select') return 'combobox';
        if (tag === 'textarea') return 'textbox';
        if (tag === 'option') return 'option';
        if (tag === 'summary') return 'button';
        if (tag === 'input') {
          const type = (attr(el, 'type') || 'text').toLowerCase();
          if (type === 'checkbox') return 'checkbox';
          if (type === 'radio') return 'radio';
          if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button';
          if (type === 'search') return 'searchbox';
          if (type === 'range') return 'slider';
          if (type !== 'text' && type !== 'hidden' && type !== 'password') return 'input-' + type;
          return 'textbox';
        }
        return 'generic';
      };

      const cleanText = (raw) => {
        const t = (raw || '').replace(/\\s+/g, ' ').trim();
        return t.length > ${MAX_NAME_CHARS} ? t.slice(0, ${MAX_NAME_CHARS}) + '…' : t;
      };

      const clip = (raw) => {
        const t = (raw || '').replace(/\\s+/g, ' ').trim();
        return t.length > ${MAX_VALUE_CHARS} ? t.slice(0, ${MAX_VALUE_CHARS}) + '…' : t;
      };

${YANHU_ACCESSIBLE_NAME_SNIPPET}
      const computeName = (el, _tag, doc) => __yanhuDeriveName(el, doc);

      // ===== 空间近邻投影（Spatial Nearest-Neighbor Projection，结构化约束版）=====
      // 历史缺陷：纯按几何距离（Δx + 3×Δy）在整篇文档内检索最近短文本，在 CSS Grid / 多列 Flex
      // 布局中会把相邻列的标签错配到本控件（如「开始日期」抢到「结束日期」的标签），令模型自信填错。
      // 现改为先确定控件的「结构化字段作用域」（最近的表单行 / 网格单元 / flex 行 / td 等），
      // 仅在**同一作用域内**投影最近文本，从根源杜绝跨列、跨单元串扰。
      const __yanhuFieldScopeOf = (node, view) => {
        let n = node && node.parentElement;
        let depth = 0;
        while (n && n.nodeType === 1 && depth < 8) {
          const ntag = tagOf(n);
          const cls = (n.className && typeof n.className === 'string') ? n.className : '';
          const id = n.id || '';
          const hay = (cls + ' ' + id).toLowerCase();
          if (/form-item|form-group|field|control-group|ant-form-item|el-form-item|bh-form-item|weui-cell/.test(hay)) return n;
          if (ntag === 'td' || ntag === 'th' || ntag === 'li' || ntag === 'fieldset') return n;
          let display = '';
          try { display = (view && view.getComputedStyle) ? view.getComputedStyle(n).display : ''; } catch (e) {}
          if (display === 'flex' || display === 'inline-flex' || display === 'grid' || display === 'inline-grid') return n;
          n = n.parentElement;
          depth += 1;
        }
        return node && node.parentElement ? node.parentElement : null;
      };
      // 当表单控件经 W3C AccName 推导后仍无名称（框架封装导致 Label 结构性解耦、单选框无内联文本）时，
      // 在同一结构化字段作用域内（Y 轴 Δy ≤ 20px）检索几何距离最近的短文本节点，
      // 以加权空间距离 D = Δx + 3×Δy 择优选最近者，自动投影绑定为控件名。
      const __yanhuSpatialName = (el, doc, rect) => {
        try {
          if (!rect || rect.width <= 0 || rect.height <= 0) return '';
          const view = (doc && doc.defaultView) || null;
          // 结构化作用域：优先最近的字段容器 / 网格单元 / flex 行
          const scope = __yanhuFieldScopeOf(el, view);
          const root = scope || (doc && (doc.body || doc.documentElement));
          if (!root || !root.querySelectorAll) return '';
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          let cands = [];
          try { cands = Array.from(root.querySelectorAll('label,span,div,p,td,th,b,strong,em,i,font')); } catch (e) { return ''; }
          let best = '', bestD = Infinity;
          const limit = Math.min(cands.length, 4000);
          for (let i = 0; i < limit; i++) {
            const c = cands[i];
            if (!c || c === el) continue;
            if (c.contains && c.contains(el)) continue;
            // 仅取叶子文本节点，避免聚合容器的合并名称形成误导
            if (c.children && c.children.length > 0) continue;
            const t = (c.textContent || '').replace(/\\s+/g, ' ').trim();
            if (!t || t.length > 24) continue;
            // 结构化一致性校验：候选文本必须与控件同处一个字段作用域，杜绝跨列 / 跨单元串扰
            if (scope && __yanhuFieldScopeOf(c, view) !== scope) continue;
            let r = null;
            try { r = c.getBoundingClientRect ? c.getBoundingClientRect() : null; } catch (e) { r = null; }
            if (!r || r.width <= 0 || r.height <= 0) continue;
            const dy = Math.abs((r.top + r.height / 2) - cy);
            if (dy > 20) continue;
            const dx = Math.abs((r.left + r.width / 2) - cx);
            const d = dx + 3 * dy;
            if (d < bestD) { bestD = d; best = t; }
          }
          return best;
        } catch (e) { return ''; }
      };

      const REGION_TAGS = new Set(['header','nav','main','aside','footer','section','form','table']);
      const REGION_ROLES = new Set(['navigation','main','banner','contentinfo','complementary','region','search','form','tabpanel','dialog']);
      // Region4Web 增强：成理旧版教务网多用 div.nav / div.menu / div.content 等类名表达语义，
      // 仅依赖 HTML5 语义标签会导致 90% 节点退化为「主要内容」，此处以类名 / ID 线索补齐解构精度。
      const REGION_CLASS_HINTS = [
        [/nav|menu|sidebar/, '导航菜单'],
        [/table|list|grid/, '数据表格'],
        [/form|search|filter|query/, '业务表单'],
        [/header|banner|(^|[^a-z])top([^a-z]|$)/, '顶栏区'],
        [/footer|bottom|copyright/, '底栏区'],
      ];
      const deriveRegionLabel = (node, fallback) => {
        const label = node.getAttribute ? (node.getAttribute('aria-label') || '') : '';
        if (label) return cleanText(label);
        const heading = node.querySelector ? node.querySelector('h1,h2,h3,h4,h5,h6,legend,caption,th,.card-title') : null;
        if (heading && heading.textContent) return cleanText(heading.textContent);
        return fallback;
      };
      const classHintLabel = (node) => {
        const cls = node.className && typeof node.className === 'string' ? node.className : '';
        const id = node.id || '';
        const hay = (cls + ' ' + id).toLowerCase();
        if (!hay.trim()) return '';
        for (let i = 0; i < REGION_CLASS_HINTS.length; i++) {
          if (REGION_CLASS_HINTS[i][0].test(hay)) return REGION_CLASS_HINTS[i][1];
        }
        return '';
      };
      const computeRegion = (el, framePath) => {
        let node = el;
        let depth = 0;
        while (node && node.nodeType === 1 && depth < 8) {
          const tag = tagOf(node);
          const role = (node.getAttribute ? (node.getAttribute('role') || '') : '').toLowerCase();
          if (REGION_TAGS.has(tag) || REGION_ROLES.has(role)) {
            if (tag === 'nav' || role === 'navigation') return deriveRegionLabel(node, '导航栏');
            if (tag === 'form' || role === 'form' || role === 'search') return deriveRegionLabel(node, '表单区');
            if (tag === 'table') return deriveRegionLabel(node, '数据表格');
            if (tag === 'header' || role === 'banner') return deriveRegionLabel(node, '页头');
            if (tag === 'footer' || role === 'contentinfo') return deriveRegionLabel(node, '页脚');
            if (tag === 'aside' || role === 'complementary') return deriveRegionLabel(node, '侧栏');
            return deriveRegionLabel(node, '主要内容');
          }
          const hint = classHintLabel(node);
          if (hint) return deriveRegionLabel(node, hint);
          node = node.parentElement;
          depth += 1;
        }
        if (framePath) {
          const fp = framePath.toLowerCase();
          if (fp.includes('left') || fp.includes('menu') || fp.includes('nav')) return '导航菜单';
          if (fp.includes('main') || fp.includes('content') || fp.includes('body')) return '核心业务区';
          if (fp.includes('top') || fp.includes('header')) return '顶栏';
          if (fp.includes('bottom') || fp.includes('footer')) return '底栏';
          return framePath;
        }
        return '主要内容';
      };

      const collectOptions = (el) => {
        if (tagOf(el) !== 'select') return undefined;
        const out = [];
        const opts = el.options || [];
        for (let i = 0; i < opts.length; i++) {
          const opt = opts[i];
          out.push({ value: String(opt.value), text: cleanText(opt.textContent || ''), selected: !!opt.selected });
          if (out.length >= 40) break;
        }
        return out;
      };

      // ===== 「可点击容器」直接子项拆分（根除菜单项漏采与聚合名称误导） =====
      // 典型场景：<div class="menu" style="cursor:pointer"><span>学生管理</span><span>成长计划</span></div>
      // 容器因 cursor:pointer 被判定可交互，但点击容器中心往往无响应（事件委托在子项上），
      // 且其聚合 innerText 会形成「学生管理 成长计划」这类误导性合并名称，导致子项永久拿不到 BID。
      // 策略：把这类容器的「非自交互、短文本」直接子项拆出为独立可交互项，并跳过容器本身。
      const NON_SPLIT_TAGS = new Set(['a','button','input','select','textarea','option','summary','table','tr','tbody','thead','tfoot','ul','ol','dl','form','nav']);
      const NON_SPLIT_ROLES = new Set(['row','grid','table','treegrid','listbox','menu','menubar','navigation']);
      const __hasOwnText = (node) => {
        try {
          const kids = node.childNodes || [];
          for (let i = 0; i < kids.length; i++) {
            const k = kids[i];
            if (k && k.nodeType === 3 && (k.nodeValue || '').replace(/\\s+/g, '') !== '') return true;
          }
        } catch (e) {}
        return false;
      };
      const __selfActionable = (node, ntag, nstyle) => {
        if (ACTIONABLE_TAGS.has(ntag)) return true;
        if (ACTIONABLE_ROLES.has(computeRole(node, ntag))) return true;
        if (node.onclick || attr(node, 'onclick')) return true;
        const ti = attr(node, 'tabindex');
        if (ti !== '' && Number(ti) >= 0) return true;
        if (nstyle && nstyle.cursor === 'pointer') return true;
        return false;
      };
      const isSplitContainer = (el, tag, role, actionable) => {
        if (!actionable) return false;
        if (NON_SPLIT_TAGS.has(tag)) return false;
        if (NON_SPLIT_ROLES.has((role || '').toLowerCase())) return false;
        return true;
      };
      const splitContainerItems = (el, framePath, offset, win) => {
        const out = [];
        let kids = [];
        try { kids = Array.from(el.children || []); } catch (e) { return out; }
        if (kids.length < 2 || kids.length > 12) return out;
        for (let i = 0; i < kids.length; i++) {
          const c = kids[i];
          const ctag = tagOf(c);
          if (!ctag || ctag === 'script' || ctag === 'style' || ctag === 'svg' || ctag === 'path') continue;
          let cstyle = null;
          try { cstyle = win.getComputedStyle ? win.getComputedStyle(c) : null; } catch (e) { continue; }
          const cvisible = !cstyle || (cstyle.display !== 'none' && cstyle.visibility !== 'hidden' && parseFloat(cstyle.opacity || '1') > 0);
          if (!cvisible) continue;
          let crect = { left: 0, top: 0, width: 0, height: 0 };
          try { crect = c.getBoundingClientRect(); } catch (e) {}
          if (crect.width <= 0 || crect.height <= 0) continue;
          if (!__hasOwnText(c)) continue;
          // 自交互子项（链接 / 按钮 / 自带 pointer）会被常规采集流程独立收录，此处跳过避免重复
          if (__selfActionable(c, ctag, cstyle)) continue;
          const cname = computeName(c, ctag, c.ownerDocument || el.ownerDocument || document);
          if (!cname) continue;
          if (cname.length > ${CLICKABLE_CONTAINER_SPLIT_MAX_ITEM_CHARS}) continue;
          out.push({
            tag: ctag,
            role: 'button',
            name: cname,
            value: undefined,
            bounds: {
              x: Math.round(offset.x + crect.left),
              y: Math.round(offset.y + crect.top),
              width: Math.round(crect.width),
              height: Math.round(crect.height),
            },
            visible: true,
            ariaHidden: false,
            occluded: false,
            region: computeRegion(c, framePath),
            framePath: framePath || undefined,
            actionable: true,
            options: collectOptions(c),
          });
        }
        return out;
      };

      // 深层 iframe 通用业务数据表格穿透直提：主动探测全框架内的业务表格
      // （课表 table.kbtable / 含「星期一…星期日」的排课表 / 含 th 表头或多行多列 td 的成绩表、
      //  考务安排表、选课结果表、空闲教室表等），一步提取为精简 Markdown，
      //  彻底省去多回合反复滚动猜测与放大 maxTokens。
      const WEEKDAY_RE = /星期[一二三四五六日天]/g;
      const cellText = (node) => ((node && node.textContent) || '').replace(/\\s+/g, ' ').trim().slice(0, ${MAX_DATA_CELL_CHARS}).replace(/\\|/g, '/');
      const extractDataTables = (doc) => {
        if (dataTables.length >= ${MAX_DATA_TABLES}) return;
        let tables = [];
        try {
          tables = queryAllDeep(doc, 'table');
        } catch (e) { return; }
        for (let ti = 0; ti < tables.length; ti++) {
          if (dataTables.length >= ${MAX_DATA_TABLES}) return;
          const t = tables[ti];
          // 跳过包裹型外层表（内部还嵌套子表），仅提取叶子业务表，避免表格内容重复膨胀
          try { if (t.querySelector && t.querySelector('table')) continue; } catch (e) {}
          let cls = '';
          try {
            cls = ((t.className && typeof t.className === 'string' ? t.className : '') + ' ' + (t.id || '')).toLowerCase();
          } catch (e) {}
          let txt = '';
          try { txt = t.textContent || ''; } catch (e) {}
          const weekdayMatches = (txt.match(WEEKDAY_RE) || []).length;
          const isKbClass = cls.indexOf('kbtable') >= 0;

          let rows = [];
          try { rows = Array.from(t.querySelectorAll('tr')); } catch (e) { continue; }
          if (rows.length < 2) continue;

          let thCount = 0, tdCount = 0;
          try { thCount = t.querySelectorAll('th').length; } catch (e) {}
          try { tdCount = t.querySelectorAll('td').length; } catch (e) {}
          const isSchedule = isKbClass || weekdayMatches >= 3;
          // 业务数据表判定（收紧）：排除纯展示表；表头型要求多行多列（避免 1 行布局表被误提），
          // 无表头的纯 td 数据网格仍沿用「多行且格子数足够」的旧判据（兼容成绩 / 考务类网格）。
          let maxCols = 0;
          try {
            for (let ri = 0; ri < rows.length; ri++) {
              const cellCount = rows[ri].querySelectorAll('th,td').length;
              if (cellCount > maxCols) maxCols = cellCount;
            }
          } catch (e) {}
          const isPresentationTable = ((t.getAttribute && t.getAttribute('role')) || '') === 'presentation';
          const isBusinessTable = !isPresentationTable && maxCols >= 2 && (
            (thCount >= 1 && rows.length >= 2)
            || (rows.length >= 3 && thCount + tdCount >= 6)
          );
          if (!isSchedule && !isBusinessTable) continue;

          const grid = [];
          for (let ri = 0; ri < rows.length && grid.length < ${MAX_DATA_ROWS}; ri++) {
            let cells = [];
            try { cells = Array.from(rows[ri].querySelectorAll('th,td')); } catch (e) {}
            if (cells.length === 0) continue;
            const vals = [];
            for (let ci = 0; ci < cells.length && ci < ${MAX_DATA_COLS}; ci++) vals.push(cellText(cells[ci]));
            grid.push(vals);
          }
          if (grid.length === 0) continue;

          const width = grid.reduce((m, r) => Math.max(m, r.length), 0);
          const lines = [];
          const header = grid[0].slice();
          while (header.length < width) header.push('');
          lines.push('| ' + header.join(' | ') + ' |');
          lines.push('| ' + header.map(() => '---').join(' | ') + ' |');
          for (let ri = 1; ri < grid.length; ri++) {
            const row = grid[ri].slice();
            while (row.length < width) row.push('');
            lines.push('| ' + row.join(' | ') + ' |');
          }
          dataTables.push(lines.join('\\n'));
        }
      };

      const visitedDocs = new Set();

      const collectFromDoc = (doc, framePath, offset, depth) => {
        if (!doc || depth > 6) return;
        if (visitedDocs.has(doc)) return;
        visitedDocs.add(doc);

        // 通用数据表格穿透直提（在本层文档内独立探测，不受元素采集上限影响）
        try { extractDataTables(doc); } catch (e) {}

        const root = doc.body || doc.documentElement;
        if (!root) return;

        const win = doc.defaultView || window;
        const viewW = win.innerWidth || 1280;
        const viewH = win.innerHeight || 800;

        // 1. 采集当前文档中的可交互与语义元素（支持超长网页全景探测 + Shadow DOM 穿透）
        const nodes = queryAllDeep(root, '*');
        const total = nodes.length;
        // 分框架配额倾斜：导航 / 辅助框架受 MAX_NAV 收敛，主业务框架享有剩余全部全局配额
        const isNav = isNavFramePath(framePath);
        let navCount = 0;
        for (let i = 0; i < total; i++) {
          if (emit.length >= MAX) break;
          if (isNav && navCount >= MAX_NAV) break;
          const el = nodes[i];
          const tag = tagOf(el);
          if (!tag || tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'svg' || tag === 'path' || tag === 'frame' || tag === 'iframe') continue;

          let style;
          try {
            style = win.getComputedStyle ? win.getComputedStyle(el) : null;
          } catch {
            continue;
          }
          const visible = !style || (style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity || '1') > 0);

          let rect = { left: 0, top: 0, width: 0, height: 0 };
          try {
            rect = el.getBoundingClientRect();
          } catch {}

          const role = computeRole(el, tag);
          const inlineOnclick = !!(el.onclick || attr(el, 'onclick'));
          const tabindex = attr(el, 'tabindex');
          const hasTabindex = tabindex !== '' && Number(tabindex) >= 0;
          // 交互能力感知扩展：现代前端与 jQuery 委托大量使用 cursor:pointer 表达的软交互元素
          // （卡片 / 表格行 / 自定义控件），补齐后可显著提升 CDUT 教务与办事大厅的交互召回率。
          const pointerCursor = !!(style && style.cursor === 'pointer');
          const actionable = ACTIONABLE_TAGS.has(tag) || ACTIONABLE_ROLES.has(role) || inlineOnclick || hasTabindex || pointerCursor;

          let name = computeName(el, tag, doc);
          // 空间几何兜底命名：仅对无名的表单控件生效（单选框 / 下拉 / 输入框），
          // 以同行几何最近文本投影绑定，根除「无名控件 → 模型盲试」。
          if (!name && (tag === 'input' || tag === 'select' || tag === 'textarea')) {
            name = __yanhuSpatialName(el, doc, rect);
          }
          // Prune4Web 动态剪枝：无业务名称的 generic / none 装饰节点 100% 剔除，绝不分配 BID。
          // 从根本上消除诱导大模型盲试空名控件的噪音（模型永远不会看到 [61] generic ""）。
          if ((role === 'generic' || role === 'none') && !name) continue;
          if (!actionable && !name) continue;
          if (!actionable && (role === 'generic' || role === 'none')) continue;

          const isVisibleAndSized = visible && rect.width > 0 && rect.height > 0;
          if (!isVisibleAndSized) {
            // 折叠路径：限量采集「有名称且可交互」的后台 / 折叠隐藏元素（display:none、零高宽、
            // 未激活 tab-pane 等），赋予 BID 并标注 [Collapsed]，使模型可感知屏幕外/未展开入口。
            // 装饰性（aria-hidden=true）与无名称元素一律剔除，避免 Token 与候选集膨胀。
            if (collapsedCount >= MAX_COLLAPSED) continue;
            if (!actionable || !name || attr(el, 'aria-hidden') === 'true') continue;
            collapsedCount += 1;
            emit.push({
              tag,
              role,
              name,
              value: undefined,
              bounds: { x: 0, y: 0, width: 0, height: 0 },
              visible: false,
              ariaHidden: false,
              occluded: false,
              region: computeRegion(el, framePath),
              framePath: framePath || undefined,
              actionable,
              collapsed: true,
              options: collectOptions(el),
            });
            if (isNav) navCount += 1;
            continue;
          }

          // 「可点击容器」直接子项拆分：命中则跳过容器本身，改由其直接子项承载可点击性，
          // 从而把「学生管理 / 成长计划」拆为两个独立 BID，消除聚合名称误导与子项漏采。
          if (isSplitContainer(el, tag, role, actionable)) {
            const splitItems = splitContainerItems(el, framePath, offset, win);
            if (splitItems.length >= 2) {
              for (let si = 0; si < splitItems.length; si++) {
                if (emit.length >= MAX) break;
                emit.push(splitItems[si]);
                if (isNav) navCount += 1;
              }
              continue;
            }
          }

          // 第三级：Z-Index 遮罩穿透校验（首屏内校验真实遮挡，首屏外视作未遮挡且保留全景探测）
          let occluded = false;
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          if (cx >= 0 && cy >= 0 && cx <= viewW && cy <= viewH) {
            try {
              if (doc.elementFromPoint) {
                const hit = doc.elementFromPoint(cx, cy);
                // 组合树包含判定：影子树内控件的命中结果为其宿主，需穿越 shadow 边界后再判遮挡
                if (!__inComposedChain(el, hit)) occluded = true;
              }
            } catch {}
          }

          // radio / checkbox 的 el.value 恒为 "on"，无法反映勾选状态：改写入状态标记，
          // 使页面指纹与 PageDigest 能感知「勾选态变化」，根除 read_page 误判「页面无变化」。
          let value;
          if (tag === 'input') {
            const __inputType = ((el.getAttribute && el.getAttribute('type')) || '').toLowerCase();
            value = __inputType === 'radio' || __inputType === 'checkbox'
              ? (el.checked ? '已勾选' : '未勾选')
              : clip(el.value != null ? String(el.value) : '');
          } else if (tag === 'textarea' || tag === 'select') {
            value = clip(el.value != null ? String(el.value) : '');
          } else if (role === 'radio' || role === 'checkbox') {
            const __ariaChecked = attr(el, 'aria-checked');
            value = __ariaChecked === 'true' ? '已勾选' : (__ariaChecked === 'false' ? '未勾选' : undefined);
          } else {
            value = undefined;
          }

          emit.push({
            tag,
            role,
            name,
            value,
            bounds: {
              x: Math.round(offset.x + rect.left),
              y: Math.round(offset.y + rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
            visible,
            ariaHidden: attr(el, 'aria-hidden') === 'true',
            occluded,
            region: computeRegion(el, framePath),
            framePath: framePath || undefined,
            actionable,
            options: collectOptions(el),
          });
          if (isNav) navCount += 1;
        }

        // 2. 递归穿透所有子 frame 与 iframe（同样穿透 Shadow DOM 内的框架）
        let frameEls = [];
        try {
          frameEls = queryAllDeep(doc, 'frame, iframe');
        } catch {}

        for (let i = 0; i < frameEls.length && emit.length < MAX; i++) {
          const f = frameEls[i];
          let fr = { left: 0, top: 0, width: 0, height: 0 };
          try {
            fr = f.getBoundingClientRect();
          } catch {}
          const fName = attr(f, 'name') || attr(f, 'id') || ('frame_' + i);
          const nextFramePath = framePath ? (framePath + '/' + fName) : fName;
          const nextOffset = {
            x: offset.x + (fr.left || 0),
            y: offset.y + (fr.top || 0),
          };
          try {
            // 三级鲁棒穿透：contentDocument -> contentWindow.document -> win.frames[name | i].document。
            // 兼容无 name 的匿名 <frameset> 子框架（旧版教务网常见），确保全景无盲区。
            const frameWin = f.contentWindow;
            const subDoc =
              f.contentDocument ||
              (frameWin && frameWin.document) ||
              (win.frames && ((win.frames[fName] && win.frames[fName].document) || (win.frames[i] && win.frames[i].document)));
            if (subDoc) {
              collectFromDoc(subDoc, nextFramePath, nextOffset, depth + 1);
            }
          } catch (e) {}
        }
      };

      collectFromDoc(document, '', { x: 0, y: 0 }, 0);

      // ===== 渲染内容指纹：URL / 框架不变、仅「被渲染出来的内容」变化时的唯一可观测信号 =====
      // innerText 天然剔除 display:none / script / style，即「用户实际看得见的文本」。
      const hashText = (s) => {
        let h = 0x811c9dc5;
        for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
        return (h >>> 0).toString(36);
      };
      const textParts = [];
      const collectVisibleText = (doc, depth) => {
        if (!doc || depth > 6) return;
        try {
          const root = doc.body || doc.documentElement;
          if (root && typeof root.innerText === 'string') {
            const t = root.innerText.replace(/\\s+/g, ' ').trim();
            if (t) textParts.push(t);
          }
        } catch (e) {}
        let frames = [];
        try { frames = queryAllDeep(doc, 'frame, iframe'); } catch (e) { frames = []; }
        for (let i = 0; i < frames.length; i++) {
          try {
            const sub = frames[i].contentDocument || (frames[i].contentWindow && frames[i].contentWindow.document);
            if (sub) collectVisibleText(sub, depth + 1);
          } catch (e) {}
        }
      };
      try { collectVisibleText(document, 0); } catch (e) {}
      const fullText = textParts.join(' \\u0001 ');
      const textDigest = hashText(fullText);
      const textSample = fullText.slice(0, ${MAX_TEXT_SAMPLE_CHARS});

      return {
        url: location.href,
        title: document.title || '',
        elements: emit,
        dataTables: dataTables,
        textDigest: textDigest,
        textSample: textSample,
      };
    } catch (err) {
      return { url: '', title: '', elements: [], dataTables: [], error: String(err && err.message ? err.message : err) };
    }
  })()`
}

/**
 * 第二级：布局与可视性剪枝 + 交互候选集过滤（定义 1）。
 *
 * 绝对剔除条件：width ≤ 0 ∨ height ≤ 0 ∨ !visible ∨ aria-hidden。
 * 仅保留具备交互能力的元素作为 BID 候选。
 */
export function filterActionableElements(elements: readonly YanhuRawElement[]): YanhuRawElement[] {
  return elements.filter((el) => {
    if (!el.actionable || el.ariaHidden) return false
    // 折叠元素：放宽可见性与面积要求（折叠态尺寸为 0），仅要求具备名称（已由采集端限量收敛）
    if (el.collapsed) return el.name.length > 0
    return el.visible && el.bounds.width > 0 && el.bounds.height > 0
  })
}

/**
 * 定义 2：双射编号映射 f: I -> {1,2,...,|I|}。
 * 依文档前序遍历（采集脚本按 `body *` 顺序即为前序）递增标定，保证单射（无重复）与满射（连续）。
 */
export function assignBids(elements: readonly YanhuRawElement[]): BidNodeRecord[] {
  return elements.map((el, index) => ({
    bid: index + 1,
    role: el.role,
    name: el.name,
    tag: el.tag,
    value: el.value,
    description: el.description,
    bounds: el.bounds,
    isOccluded: el.occluded || undefined,
    collapsed: el.collapsed || undefined,
    parentRegion: el.region,
    framePath: el.framePath,
    options: el.options,
    selector: buildFallbackSelector(el),
  }))
}

/** 构造稳定的 CSS 选择器回退路径（仅在 CDP 反查失败时兜底，绝不投递给大模型） */
function buildFallbackSelector(el: YanhuRawElement): string {
  const namePart = el.name ? `[aria-label="${el.name.replace(/"/g, '\\"')}"]` : ''
  if (namePart) return `${el.tag}${namePart}`
  return el.tag
}

/**
 * 第一级补充：用 AXTree 语义增强 DOM 采集结果。
 *
 * 当 DOM 侧计算出的 role 为 generic 且元素名称为空时，若 AX 树中存在同名且 role 更明确的唯一节点，
 * 则采纳其 role，降低纯视觉节点的语义歧义。多义或缺失时保持原值，绝不臆造。
 */
export function enrichRolesFromAx(
  records: BidNodeRecord[],
  axNodes: readonly unknown[],
): BidNodeRecord[] {
  const byName = new Map<string, string>()
  const ambiguous = new Set<string>()
  for (const raw of axNodes) {
    if (!raw || typeof raw !== 'object') continue
    const node = raw as { role?: { value?: unknown }; name?: { value?: unknown }; ignored?: unknown }
    if (node.ignored === true) continue
    const role = typeof node.role?.value === 'string' ? node.role.value : ''
    const name = typeof node.name?.value === 'string' ? node.name.value.trim() : ''
    if (!role || !name) continue
    if (role === 'generic' || role === 'none' || role === 'InlineTextBox' || role === 'StaticText') continue
    if (byName.has(name)) {
      if (byName.get(name) !== role) ambiguous.add(name)
      continue
    }
    byName.set(name, role)
  }
  return records.map((record) => {
    if (record.role && (record.role.startsWith('input-') || (record.role !== 'generic' && record.role !== 'textbox' && record.role !== 'element'))) return record
    if (!record.name) return record
    const axRole = byName.get(record.name)
    if (!axRole || ambiguous.has(record.name)) return record
    return { ...record, role: axRole }
  })
}

/** 压缩序列化上下文 */
export interface SerializeDigestInput {
  url: string
  title: string
  records: readonly BidNodeRecord[]
  /** AX 树节点总量（用于置信度标注） */
  axNodeCount?: number
  /** 全框架穿透直提的结构化业务数据表格 Markdown 快照（优先于交互节点流式输出，供模型一步读取） */
  dataTables?: readonly string[]
  /** 渲染内容摘要（可见文本，有界截断）：让「URL / 框架不变、仅内容变」的变化对模型可见 */
  textSample?: string
}

/** 判定区域是否属于可折叠的静态导航菜单 */
function isNavRegionLabel(region: string): boolean {
  return /导航|菜单/.test(region)
}

/**
 * 判定某分组是否属于导航菜单体系（区域语义或框架路径线索）。
 *
 * 青果教务旧版 frameset 常把菜单树放在 `leftFrame`，部分页面区域名未必含「导航/菜单」，
 * 故以框架路径线索兜底识别，确保导航菜单被正确行内紧凑编码而非丢弃。
 */
function isNavigationRegion(region: string, framePath?: string): boolean {
  return isNavRegionLabel(region) || /left|menu|nav/i.test(framePath ?? '')
}

/** 导航菜单行内紧凑项文本：保留 BID 与可读名称，折叠 / 遮挡附极短标记 */
function formatInlineBid(record: YanhuBidNode): string {
  const markers = `${record.collapsed ? 'C' : ''}${record.isOccluded ? 'O' : ''}`
  const suffix = markers ? `[${markers}]` : ''
  return `[${record.bid}] ${record.name}${suffix}`
}

/**
 * 第四级：层次化功能区解构与极简序列化。
 *
 * 按 `parentRegion` 与 `framePath` 分块输出，表格 / 列表保持列名与行元数据的扁平内联关联。
 * 对项数庞大的静态导航菜单自动折叠为一行；课表等结构化快照优先全量前置输出。
 */
export function serializePageDigest(input: SerializeDigestInput): string {
  const lines: string[] = []
  lines.push(`=== [PageDigest: ${input.title || '无标题页面'}] ===`)
  // 紧凑元信息：标题已内联于上方摘要，避免重复；URL / BID / AX 合并为单行，压缩上下文 Token 消耗。
  const meta = [`URL: ${input.url}`, `BIDs: ${input.records.length}`]
  if (typeof input.axNodeCount === 'number') meta.push(`AX: ${input.axNodeCount}`)
  lines.push(meta.join(' | '))
  lines.push('')

  // 通用业务数据表格穿透直提：结构化 Markdown 优先输出，模型无需滚动 / 猜测即可一步读取
  if (input.dataTables && input.dataTables.length > 0) {
    lines.push('[结构化数据表格（全框架穿透直提）]')
    for (const table of input.dataTables) lines.push(table)
    lines.push('')
  }

  // 渲染内容摘要：URL 与框架常常都不变，只有被渲染出来的内容变了——此处让内容变化「看得见」
  if (input.textSample && input.textSample.trim()) {
    lines.push('[渲染内容摘要（可见文本，已截断）]')
    lines.push(input.textSample.trim())
    lines.push('')
  }

  const groups: Array<{ framePath?: string; region: string; records: BidNodeRecord[] }> = []
  const groupIndex = new Map<string, number>()
  for (const record of input.records) {
    const region = record.parentRegion || '主要内容'
    const key = record.framePath ? `${record.framePath}::${region}` : `__no_frame__::${region}`
    const at = groupIndex.get(key)
    if (at !== undefined) {
      groups[at]!.records.push(record)
    } else {
      groupIndex.set(key, groups.length)
      groups.push({ framePath: record.framePath, region, records: [record] })
    }
  }

  // 核心操作区优先排序：数据表格 / 业务表单排在头部，常驻静态导航菜单紧随其后。即便触及
  // Token 预算截断，被截断的也仅是冗余菜单说明文本，核心业务交互项永远完整交付。
  const ordered = groups.slice().sort((a, b) => {
    const an = isNavigationRegion(a.region, a.framePath) ? 1 : 0
    const bn = isNavigationRegion(b.region, b.framePath) ? 1 : 0
    return an - bn
  })

  for (const { framePath, region, records } of ordered) {
    if (framePath) {
      lines.push(`[Frame: ${framePath} | ${region}]`)
    } else {
      lines.push(`[Region: ${region}]`)
    }
    // 静态导航树行内紧凑编码：菜单项超过阈值时改为多列紧凑行，100% 保留 BID 双射，
    // 彻底根除「粗暴折叠导致菜单 [BID] 全部消失、模型盲视」的致命瓶颈。
    if (isNavigationRegion(region, framePath) && records.length > NAV_REGION_FOLD_THRESHOLD) {
      for (let i = 0; i < records.length; i += NAV_INLINE_ITEMS_PER_LINE) {
        const row = records
          .slice(i, i + NAV_INLINE_ITEMS_PER_LINE)
          .map(formatInlineBid)
          .join(' | ')
        lines.push(`- ${row}`)
      }
      lines.push('')
      continue
    }
    for (const record of records) {
      lines.push(`- ${formatBidLine(record)}`)
    }
    lines.push('')
  }
  if (input.records.length === 0) {
    lines.push('（当前页面暂无可交互控件，或页面仍在加载中）')
  }
  return lines.join('\n').trimEnd()
}

/** 单条 BID 的紧凑文本表达（兼容 BidNodeRecord 与 YanhuBidNode） */
function formatBidLine(record: YanhuBidNode): string {
  const parts: string[] = [`[BID: ${record.bid}]`, record.role || 'element']
  if (record.name) parts.push(`"${record.name}"`)
  if (record.value) parts.push(`value="${record.value}"`)
  if (record.options && record.options.length > 0) {
    const opts = record.options
      .slice(0, 12)
      .map((o) => (o.selected ? `*"${o.text}"` : `"${o.text}"`))
      .join(', ')
    const current = record.options.find((o) => o.selected)
    parts.push(`(options: [${opts}]${current ? `, current: "${current.text}"` : ''})`)
  }
  if (record.collapsed) parts.push('[Collapsed]')
  if (record.isOccluded) parts.push('[Occluded]')
  return parts.join(' ')
}

/** 快速 32 位 FNV-1a 哈希（base36 字符串），用于页面结构指纹比对 */
function quickHash(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

/** 节点稳定身份键（跨采集保持一致的语义标识，用于增量比对） */
function nodeIdentity(node: YanhuBidNode): string {
  return `${node.role}|${node.name}|${node.value ?? ''}|${node.parentRegion ?? ''}|${node.framePath ?? ''}`
}

/**
 * 计算页面全要素结构指纹（Multi-Factor Fingerprint Hash）。
 *
 * 基于页面 URL、全部 BID 节点的「角色 + 名称 + 值」结构序列（勾选 / 选中态已并入 value），
 * 以及全框架穿透直提的数据表格 Markdown 内容共同计算快速哈希。
 *
 * 之所以纳入表格内容：成绩查询 / 考务等场景下，表格渲染在页面上但单元格内无 BID 控件，
 * 若仅对可交互节点取哈希，点击「查询」后表格更新仍会被误判为「页面无变化」而阻断。
 * 多要素指纹确保表格一旦更新，指纹立刻改变，彻底根除假「无变化」。
 */
export function computePageFingerprint(page: YanhuDistilledPage): string {
  const raw = page.nodes.map((node) => `${node.role}:${node.name}:${node.value ?? ''}`).join('|')
  const tables = (page.dataTables ?? []).join('||')
  // 渲染文本摘要哈希：URL / 框架不变、仅内容变（纯文本重渲染、状态提示更新等）时指纹必须随之改变
  const text = page.textDigest ?? ''
  return quickHash(`${page.url}#${raw}#${tables}#${text}`)
}

/**
 * 环境状态字符串归一化（WebRollback 范式）。
 *
 * 剥离 Vue / EMAP / BH-UI 等框架生成的挥发性随机属性（动态 id / data-v-* / 随机 CSS class），
 * 使表单重绘后「相同语义状态」能够生成完全一致的状态指纹，供 DeadlockGuard 判定
 * 「环境是否被反复拉回相同」——从而精准识别乒乓振荡，同时避免对正常状态推进误判。
 */
export function normalizeStateString(raw: string): string {
  return raw
    .replace(/\b(?:id|name)="[^"]*(?:vue|emap|bh|[0-9a-f]{6,})[^"]*"/gi, 'id="STRIPPED"')
    .replace(/\bdata-v-[a-zA-Z0-9_-]+/g, 'data-v-STRIPPED')
    .replace(/\bclass="[^"]*(?:css-[0-9a-z]+|vue-[0-9a-z]+)[^"]*"/gi, 'class="STRIPPED"')
}

interface CachedDistillation {
  page: YanhuDistilledPage
  index: Map<number, BidNodeRecord>
}

/** 最近一次成功投递给模型的页面快照（用于「无变化」短路与 Git-Diff 增量比对） */
interface DeliveredSnapshot {
  url: string
  /** 可见 BID 节点的稳定身份键集合 */
  nodeKeys: Set<string>
  /** 数据表格 Markdown 快照 */
  dataTables: string[]
}

/**
 * 蒸馏引擎单例：缓存当前活跃标签的 BID 映射，支持导航 / DOM 突变后的 Dirty 重建。
 */
export class YanhuDomDistillationEngine {
  private readonly cache = new Map<string, CachedDistillation>()
  /** 各标签的 BID 历史回退池：markDirty 后仍可反查上一轮标定，杜绝「BID 失效」冗余重读 */
  private readonly lastValidIndex = new Map<string, Map<number, BidNodeRecord>>()
  /** 各标签最近一次「已投递给模型」的页面结构指纹（用于无变化短路与防死循环） */
  private readonly deliveredFingerprints = new Map<string, string>()
  /** 各标签最近一次投递页面的快照（用于 Git-Diff 局部增量输出） */
  private readonly deliveredSnapshots = new Map<string, DeliveredSnapshot>()

  /**
   * 由原始采集结果构建蒸馏页并缓存 BID 映射。
   */
  public distill(
    tabId: string,
    collected: YanhuCollectedPage,
    axNodes: readonly unknown[] = [],
  ): YanhuDistilledPage {
    const candidates = filterActionableElements(collected.elements)
    const records = enrichRolesFromAx(assignBids(candidates), axNodes)
    const dataTables = Array.isArray(collected.dataTables) ? collected.dataTables.slice() : undefined
    const digestText = serializePageDigest({
      url: collected.url,
      title: collected.title,
      records,
      axNodeCount: axNodes.length,
      dataTables,
      textSample: typeof collected.textSample === 'string' ? collected.textSample : undefined,
    })
    const nodes: YanhuBidNode[] = records.map((record) => ({
      bid: record.bid,
      role: record.role,
      name: record.name,
      tag: record.tag,
      value: record.value,
      description: record.description,
      bounds: record.bounds,
      isOccluded: record.isOccluded,
      collapsed: record.collapsed,
      parentRegion: record.parentRegion,
      framePath: record.framePath,
      options: record.options,
    }))
    const page: YanhuDistilledPage = {
      url: collected.url,
      title: collected.title,
      digestText,
      bidCount: records.length,
      nodes,
      dataTables,
      textDigest: typeof collected.textDigest === 'string' ? collected.textDigest : undefined,
      textSample: typeof collected.textSample === 'string' ? collected.textSample : undefined,
      timestamp: Date.now(),
    }
    const index = new Map<number, BidNodeRecord>()
    for (const record of records) index.set(record.bid, record)
    // 原子替换：新采集完成后再更新当前索引，同时刷新历史回退池，保证连续调用时的 BID 稳定性
    this.cache.set(tabId, { page, index })
    this.lastValidIndex.set(tabId, index)
    return page
  }

  /** 读取已缓存的蒸馏页（无缓存返回 null） */
  public getCached(tabId: string): YanhuDistilledPage | null {
    return this.cache.get(tabId)?.page ?? null
  }

  /**
   * 读取最近一次**已投递给模型**的页面全要素指纹（从未投递过返回 null）。
   *
   * 供「重复点击护栏」判定：若同一控件再次被点击时，模型所见的页面内容自上次点击起完全没变
   * （URL / 框架常常都不变，只有渲染内容变），则重复点击没有意义，直接拦截而非放任空转。
   */
  public getDeliveredFingerprint(tabId: string): string | null {
    return this.deliveredFingerprints.get(tabId) ?? null
  }

  /** 双射反查：按 BID 取得标定记录 */
  public resolveBid(tabId: string, bid: number): BidNodeRecord | null {
    return this.cache.get(tabId)?.index.get(bid) ?? null
  }

  /**
   * 带回退的双射反查：当前索引缺失时自动检索历史回退池。
   *
   * markDirty 会把上一轮索引原子转入 lastValidIndex，因此点击后立即对另一 BID 操作时，
   * 即便当前索引尚未重建，也能命中历史标定并直接执行，无需模型再花两轮回读页面。
   * 命中历史记录时标注 stale=true，调用方据此在定位阶段放宽判定。
   */
  public resolveBidWithFallback(tabId: string, bid: number): BidNodeRecord | null {
    const current = this.cache.get(tabId)?.index.get(bid)
    if (current) return current
    const history = this.lastValidIndex.get(tabId)?.get(bid)
    return history ? { ...history, stale: true } : null
  }

  /**
   * 列出当前（或历史回退池）的全部标定记录，按 BID 升序。
   *
   * 供「未知 BID」时向模型回传可用台账，避免其在看不到清单时反复盲猜 BID 空转。
   */
  public listBidsWithFallback(tabId: string): BidNodeRecord[] {
    const index = this.cache.get(tabId)?.index ?? this.lastValidIndex.get(tabId)
    if (!index) return []
    return [...index.values()].sort((a, b) => a.bid - b.bid)
  }

  /**
   * 标记缓存失效（导航 / 大面积 DOM 突变时调用）。
   *
   * 不直接清空内存索引：先将当前索引转入历史回退池，再摘除页面缓存。
   * 这样在下一轮采集完成前，已投递给模型的 BID 仍可被 `resolveBidWithFallback` 反查到，
   * 从而消除「点击 -> BID 失效 -> 重读 -> 再点击」的固定冗余交互。
   */
  public markDirty(tabId: string): void {
    const current = this.cache.get(tabId)
    if (current) this.lastValidIndex.set(tabId, current.index)
    this.cache.delete(tabId)
  }

  /**
   * 记录本次投递给模型的页面，并给出比对结论。
   *
   * 返回值：
   * - `unchanged`：与上次指纹一致（页面完全无变化），调用方短路回传「页面无变化」；
   * - `diffText`：页面主要结构未变、仅局部新增少量可用项时的 Git-Diff 紧凑增量文本（否则为 null）。
   *
   * 首次投递（无历史）恒返回 `{ unchanged: false, diffText: null }`。
   */
  public recordDelivery(
    tabId: string,
    page: YanhuDistilledPage,
  ): { unchanged: boolean; diffText: string | null } {
    const fingerprint = computePageFingerprint(page)
    const previousFingerprint = this.deliveredFingerprints.get(tabId)
    const previous = this.deliveredSnapshots.get(tabId)
    const unchanged = previousFingerprint !== undefined && previousFingerprint === fingerprint

    const nodeKeys = new Set(page.nodes.map((node) => nodeIdentity(node)))
    const dataTables = page.dataTables ?? []
    let diffText: string | null = null
    if (!unchanged && previous) {
      diffText = buildDiffOnlyText(previous, page, nodeKeys, dataTables)
    }

    this.deliveredFingerprints.set(tabId, fingerprint)
    this.deliveredSnapshots.set(tabId, { url: page.url, nodeKeys, dataTables })
    return { unchanged, diffText }
  }

  /** 释放标签缓存 */
  public release(tabId: string): void {
    this.cache.delete(tabId)
    this.lastValidIndex.delete(tabId)
    this.deliveredFingerprints.delete(tabId)
    this.deliveredSnapshots.delete(tabId)
  }
}

/**
 * Git-Diff 风格的局部增量输出。
 *
 * 当页面 URL 与数据表格均未变化、且仅新增少量（1~{@link DIFF_MAX_ADDED_ITEMS}）可见 BID、无删除项时，
 * 直接输出紧凑增量，避免动辄 1500+ Tokens 的全量 PageDigest 冲击；否则返回 null 由调用方全量输出。
 */
function buildDiffOnlyText(
  previous: DeliveredSnapshot,
  page: YanhuDistilledPage,
  nodeKeys: Set<string>,
  dataTables: readonly string[],
): string | null {
  if (previous.url !== page.url) return null
  if (JSON.stringify(dataTables) !== JSON.stringify(previous.dataTables)) return null

  const seen = new Set<string>()
  const added: YanhuBidNode[] = []
  for (const node of page.nodes) {
    const key = nodeIdentity(node)
    if (previous.nodeKeys.has(key) || seen.has(key)) {
      seen.add(key)
      continue
    }
    seen.add(key)
    added.push(node)
  }
  if (added.length < 1 || added.length > DIFF_MAX_ADDED_ITEMS) return null
  for (const key of previous.nodeKeys) {
    if (!nodeKeys.has(key)) return null
  }

  const lines = ['=== [PageDigest: 局部更新] ===', `[新展开 ${added.length} 个可用项]`]
  for (const node of added) lines.push(`- ${formatBidLine(node)}`)
  return lines.join('\n')
}

/** 全局单例 */
export const yanhuDomDistillationEngine = new YanhuDomDistillationEngine()
