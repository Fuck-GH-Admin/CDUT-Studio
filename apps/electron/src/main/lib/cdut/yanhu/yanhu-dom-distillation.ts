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
  /** 闭合 Shadow DOM 宿主标签集合（脚本端探测打标，主进程可经 CDP 深度补漏解析） */
  closedShadowHosts?: string[]
  /** 未被渲染的可交互元素统计（折叠菜单 / 隐藏面板 / 未激活标签页等，不分配 BID） */
  unrendered?: { count: number; regions: string[] }
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
      // 企业级表单封装的「标签载体」属性：金智 EMAP / 自研组件把中文标签挂在容器的 data-caption 上，
      // 而控件自身（input / div）没有任何 ARIA / label / title / placeholder。
      const __yanhuCaptionAttrs = ['data-caption', 'data-label', 'data-field-label'];
      const __yanhuCaptionOf = (el) => {
        let node = el, depth = 0;
        while (node && node.nodeType === 1 && depth < 6) {
          for (let i = 0; i < __yanhuCaptionAttrs.length; i++) {
            const v = node.getAttribute ? (node.getAttribute(__yanhuCaptionAttrs[i]) || '') : '';
            if (v) return v;
          }
          node = node.parentElement;
          depth += 1;
        }
        return '';
      };
      /** 元素「自身直接文本」（只拼接直接子文本节点，不含子孙文本） */
      const __yanhuOwnText = (el) => {
        let out = '';
        try {
          const nodes = el.childNodes || [];
          for (let i = 0; i < nodes.length; i++) {
            const n = nodes[i];
            if (n && n.nodeType === 3) out += (n.nodeValue || '') + ' ';
          }
        } catch (e) {}
        return out.replace(/\\s+/g, ' ').trim();
      };
      /** 首个「带文本的叶子后代」文本（自身无直接文本时的回退，长度有界） */
      const __yanhuFirstLeafText = (el, maxChars) => {
        try {
          const all = el.querySelectorAll ? el.querySelectorAll('*') : [];
          for (let i = 0; i < all.length; i++) {
            const node = all[i];
            if (node.children && node.children.length > 0) continue;
            const t = (node.textContent || '').replace(/\\s+/g, ' ').trim();
            if (!t) continue;
            return t.length > maxChars ? t.slice(0, maxChars) + '…' : t;
          }
        } catch (e) {}
        return '';
      };
      /**
       * 控件的「当前显示文本」——自身直接文本优先，为空时回退首个叶子后代文本。
       *
       * 这是本轮两条修复共用的核心口径：
       *   ① 命名（#3）：聚合容器的名字此前是**全部子孙文本拼接**（如「请选择... 香港特别行政区
       *      吉林省 贵州省 …」），语义不明，模型要花大量推理去猜它到底是什么；
       *   ② 取值（#1）：非输入型控件（自定义下拉 / 树选择 / 日期控件）的 value 此前恒为空，
       *      模型因此无法核对「选区到底写进去没有」，只能反复试、最后撞熔断。
       * 两者都改用同一份「自身直接文本 → 首个叶子后代」的短文本口径。
       */
      const __yanhuDisplayText = (el) => {
        const own = __yanhuOwnText(el);
        if (own) return own;
        const leaf = __yanhuFirstLeafText(el, 40);
        if (leaf) return leaf;
        // 走到这里意味着「自身与后代都没有文本节点」。真实 DOM 中此时 innerText / textContent
        // 必然也为空，故本行等价于返回空串——它只会在结构信息不自洽的极简宿主（测试桩）上取到文本，
        // 因此不会复活「名字=子孙拼接」的老问题。
        return (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
      };
      /**
       * 通用占位提示词（未选择 / 未进入填写状态的提示），**不配作为控件名称**。
       *
       * 金智 EMAP 表单里十几个未填写的下拉 / 树选择，显示文本全是「请选择...」；
       * 若放任它占用名字，模型只会看到十几个一模一样的控件、被迫盲猜 [BID]（历史事故）。
       * 注意：只匹配「请选择 / 点击选择 / select / choose」这类**完整的占位语义**，
       * 不匹配「选择时间」这种本身有意义的按钮名，避免误改真实控件文本。
       */
      const __yanhuPlaceholderPattern = /^(请选择|请选取|点击选择|select|choose|please select)/i;
      const __yanhuIsPlaceholderText = (raw) => {
        const text = (raw || '').replace(/\\s+/g, ' ').trim();
        if (!text) return false;
        // 「...」/「…」结尾的短文本（请选择...、Select...）一律视为占位
        if (text.indexOf('...') >= 0 || text.indexOf('…') >= 0) {
          return text.replace(/[.。\u2026\\s]+$/g, '').length <= 8;
        }
        return __yanhuPlaceholderPattern.test(text) && text.length <= 12;
      };
      /**
       * 是否为**泛化占位提示**——去掉提示前缀与省略号后不剩任何字段信息（「请选择...」）。
       *
       * 与「请选择日期」这种含具体名词的 placeholder 严格区分：后者本身就能标识字段，必须保留；
       * 只有泛化提示才允许让位给权威业务标签（data-caption / label）。
       */
      const __yanhuIsGenericPlaceholder = (raw) => {
        const text = (raw || '').replace(/\\s+/g, ' ').trim();
        if (!text || !__yanhuPlaceholderPattern.test(text)) return false;
        const rest = text.replace(__yanhuPlaceholderPattern, '').replace(/[.。\u2026\s]+/g, '');
        return rest.length === 0;
      };
      /** 表单元素的原生标签关联（W3C AccName 核心路径）；不适用时返回空串 */
      const __yanhuNativeLabelOf = (el, doc) => {
        try {
          if (el.labels && el.labels.length > 0) {
            for (let i = 0; i < el.labels.length; i++) {
              const lt = (el.labels[i].textContent || '').trim();
              if (lt) return lt;
            }
          }
          if (el.id && doc && doc.querySelector) {
            const forLabel = doc.querySelector('label[for="' + CSS.escape(el.id) + '"]');
            if (forLabel && forLabel.textContent) {
              const lt = forLabel.textContent.trim();
              if (lt) return lt;
            }
          }
          const parentLabel = el.closest ? el.closest('label') : null;
          if (parentLabel && parentLabel.textContent) {
            const lt = parentLabel.textContent.trim();
            if (lt) return lt;
          }
        } catch (e) {}
        return '';
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
          const nativeLabel = __yanhuNativeLabelOf(el, doc);
          if (nativeLabel) return __yanhuCleanName(nativeLabel);
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

        // 4. 显示文本与通用回退（自身直接文本优先，为空则取首个叶子后代文本）
        //
        // 历史缺陷：此处原为 el.innerText || el.textContent —— 对**容器**而言那是「全部子孙文本
        // 的拼接」，于是树形/级联选择器的容器名会变成「请选择... 香港特别行政区 吉林省 贵州省 …」
        // 这种语义不明的长串，模型只能靠猜。改用短文本口径后，名字稳定收敛为一个短词。
        const text = __yanhuDisplayText(el);
        const direct = text || title || placeholder || alt || '';
        if (direct) {
          // 占位符不配当控件名：若拿到的只是「请选择...」这类**泛化提示**，而该控件又具备权威业务标签
          // （data-caption / label），则**提升标签为控件名**，让占位符退化为「当前值」。
          // 这样模型看到的是 [BID: 24] combobox "出校去向"，而不是第 10 个「请选择...」。
          // 注意仅限泛化提示：placeholder 为「请选择日期」这类含字段名词者仍然保留。
          if (__yanhuIsGenericPlaceholder(direct)) {
            return __yanhuCleanName(__yanhuCaptionOf(el) || __yanhuNativeLabelOf(el, doc) || direct);
          }
          return __yanhuCleanName(direct);
        }

        // 5. 最终回退：企业级表单封装的容器级标签（data-caption 等）。
        //
        // 历史缺陷（致命）：EMAP「请假开始时间 / 请假结束时间」这类日期时间控件，其 <input> 自身
        // 无 ARIA / label / title / placeholder，中文标签挂在祖先 div 的 data-caption 上。
        // 采集端靠「空间近邻猜测」拿到了名字，而**定位端没有空间猜测能力**，只能推导出空名 →
        // 名称恒不匹配 → 点击与填写双双报「未能在页面中定位」，模型被迫转去猜像素坐标。
        // 把这条权威标签载体纳入两端共用的推导链后，采集与定位得到完全一致的名称，从根上消除。
        // 仅在控件自身确实没有任何文本时启用，绝不覆盖按钮 / 链接的内联文本。
        return __yanhuCleanName(__yanhuCaptionOf(el));
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
 * 浮动面板（下拉 / 选择器 / 浮层）根节点选择器。
 *
 * **单一真源**：采集端「浮层内叶子选项纳管」与主进程侧「面板内点选选项」必须用同一份清单，
 * 否则两端判定漂移（历史上正是这类漂移导致「选择器能点到、采集端看不到」的诡异组合）。
 */
export const YANHU_POPUP_SELECTORS = [
  '.bh-pull-down-list',
  '.bh-select-dropdown',
  '.bh-dropdown-menu',
  // jqx / EMAP 的浮动面板容器（实测：出校去向的树面板是 .jqx-dropdownbutton-popup）
  '.jqx-dropdownbutton-popup',
  '.jqx-dropdownlist-popup',
  // 树形选择器面板内的树容器（实测：#tree_xxx.dropdown-tree）
  '[class*="dropdown-tree"]',
  '[class*="popper"]',
  '[class*="popover"]',
  '[class*="picker"]',
  '[role="listbox"]',
  '[id*="innerListBox"]',
  '[id*="listBoxContent"]',
  '.jqx-listbox',
]

/** 单次采集中，浮层内叶子选项的纳管上限（防止带浮层的页面把台账撑爆） */
const MAX_COLLECTED_POPUP_OPTIONS = 60
/** 浮层内叶子选项的文本长度上限（超过即视为正文而非选项） */
const MAX_POPUP_OPTION_CHARS = 40

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
      const emit = [];
      const dataTables = [];
      const closedShadowHosts = [];
      // 未渲染元素的统计口径（仅计数与区域归属，绝不分配 BID）
      let unrenderedCount = 0;
      const unrenderedRegions = [];
      /** 已分配 BID 的 DOM 节点（供浮层叶子选项纳管去重，避免同一元素重复编号） */
      const emittedNodes = [];
      // 分框架配额倾斜：判定当前框架是否属于导航 / 辅助框架（其采集量受 MAX_NAV 收敛）
      const isNavFramePath = (fp) => /(left|menu|nav|top|header|bottom|footer)/i.test(fp || '');

      // ===== 第一道防线：原型方法安全隔离（根除 DOM Clobbering 与方法覆盖破坏）=====
      // 某些高校老旧页面或恶意构造页面会用 <input name="title">、<form id="location"> 等
      // 命名元素污染 document / window 上的命名属性，致使原生 document.title / location.href
      // 返回 HTML 元素而非字符串，采集脚本在页面内抛 TypeError 进而全景失明。
      // 此处前置声明不可篡改的原型方法脱敏切片，并以 Reflect.apply 显式绑定原生实现，
      // 所有属性读取一律走 safe* 包装（内部 try/catch 兜底），从根源消除异常与污染。
      const _Object = Object;
      const _Reflect = Reflect;
      const _hasElement = typeof Element !== 'undefined' && typeof Node !== 'undefined';
      const _getAttr = _hasElement ? Element.prototype.getAttribute : null;
      const _docTitleGetter = (typeof Document !== 'undefined')
        ? _Object.getOwnPropertyDescriptor(Document.prototype, 'title') && _Object.getOwnPropertyDescriptor(Document.prototype, 'title').get
        : null;
      const _locHrefGetter = (typeof Location !== 'undefined')
        ? _Object.getOwnPropertyDescriptor(Location.prototype, 'href') && _Object.getOwnPropertyDescriptor(Location.prototype, 'href').get
        : null;

      const safeGetAttr = (el, name) => {
        try {
          if (_getAttr) {
            const v = _Reflect.apply(_getAttr, el, [name]);
            return typeof v === 'string' ? v : '';
          }
          const raw = (el && el.getAttribute) ? el.getAttribute(name) : '';
          return typeof raw === 'string' ? raw : '';
        } catch (e) { return ''; }
      };
      const safeTitle = (doc) => {
        try {
          if (_docTitleGetter) {
            const t = _Reflect.apply(_docTitleGetter, doc, []);
            if (typeof t === 'string') return t;
          }
        } catch (e) {}
        try {
          const t = doc && doc.title;
          return typeof t === 'string' ? t : '';
        } catch (e) { return ''; }
      };
      const safeHref = (loc) => {
        try {
          if (_locHrefGetter) {
            const v = _Reflect.apply(_locHrefGetter, loc, []);
            if (typeof v === 'string' && v) return v;
          }
        } catch (e) {}
        try {
          const h = loc && loc.href;
          return typeof h === 'string' ? h : '';
        } catch (e) { return ''; }
      };

      const ACTIONABLE_TAGS = new Set(['button','a','input','select','textarea','option','summary']);
      const ACTIONABLE_ROLES = new Set(['button','link','checkbox','radio','tab','menuitem','option','switch','textbox','searchbox','combobox','slider','spinbutton']);

      const tagOf = (el) => (el.tagName || '').toLowerCase();
      const attr = (el, name) => safeGetAttr(el, name);

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
            const host = nodes[i];
            const sr = host && host.shadowRoot;
            if (!sr || !sr.querySelectorAll) {
              // 闭合 Shadow DOM 宿主探测：自定义元素（含连字符标签）且原生支持 attachShadow，
              // 却拿不到 shadowRoot 时，判定其为闭合影子树宿主并打标；主进程收集后经
              // CDP DOM.getDocument(depth:-1, pierce:true) 深度补漏解析。
              try {
                const ht = (host && host.tagName) ? String(host.tagName).toLowerCase() : '';
                if (ht && ht.indexOf('-') >= 0 && typeof host.attachShadow === 'function' && closedShadowHosts.length < 40) {
                  closedShadowHosts.push(ht);
                }
              } catch (e) {}
              continue;
            }
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

      /**
       * 渲染判定（决定该元素能否进入 BID 台账的唯一权威口径）。
       *
       * 计算样式三道闸门（display / visibility / opacity）之外，额外要求：
       *   1. content-visibility 不得为 hidden —— 其子树不渲染，但后代自身的计算样式完全正常，
       *      单看 display 会「看得见调不到」；
       *   2. 必须存在真实布局盒（getClientRects 非空）—— 这是覆盖「display:contents」「未挂载子树」
       *      「content-visibility:hidden 后代」等一切未渲染形态的最可靠判据。
       * 拿不到布局信息的宿主（单测桩 / 老旧内核）按可见处理，绝不因探测能力缺失而误杀。
       */
      const isRenderedElement = (el, style, rect) => {
        if (style) {
          if (style.display === 'none') return false;
          if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
          if (parseFloat(style.opacity || '1') <= 0) return false;
          if (style.contentVisibility === 'hidden') return false;
        }
        if (!rect || rect.width <= 0 || rect.height <= 0) return false;
        try {
          if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) return false;
        } catch (e) {}
        return true;
      };

      // 控件尺度上限：「磁吸」与「可见代理重绑定」只在小尺度控件上成立，
      // 绝不把面板 / 表单级大容器当成控件（否则会把点击拖到容器中心，落点完全跑偏）。
      const MAX_CONTROL_SIDE = 480;
      const MAX_CONTROL_HEIGHT = 140;

      /**
       * 找出隐藏控件的「可见代理」——真正承载视觉与交互的那个已渲染节点。
       *
       * 自定义单选 / 复选（layui / EMAP / Element 等）会把原生 input 元素视觉隐藏成 0×0 或
       * opacity:0，用户与鼠标实际作用的对象是外层 label 或小尺度可点击包裹。若只按
       * 「未渲染」把它丢弃，模型在整个 [BID] 台账里就再也找不到「因私请假 / 是否出校」这类选项，
       * 只能退化成猜像素坐标——这正是「仅凭 DOM 解析也点不上单选」的根因。
       */
      const __yanhuRenderedProxyOf = (el, doc) => {
        const withinControlScale = (node) => {
          let r = null;
          try { r = node.getBoundingClientRect(); } catch (e) {}
          if (!r || r.width <= 0 || r.height <= 0) return false;
          if (r.width > MAX_CONTROL_SIDE || r.height > MAX_CONTROL_HEIGHT) return false;
          const text = (node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim();
          return text.length > 0 && text.length <= 40;
        };
        // 1. 关联 <label>：原生语义保证点击 label 即切换其控件
        let label = null;
        try { label = el.closest ? el.closest('label') : null; } catch (e) {}
        if (!label && el.id && doc && doc.querySelector) {
          try { label = doc.querySelector('label[for="' + CSS.escape(el.id) + '"]'); } catch (e) {}
        }
        if (label && withinControlScale(label)) return label;
        // 2. 最近的「控件尺度」祖先包裹（自定义控件形态：<span class="radio"><i></i>因私请假</span>）
        let node = el.parentElement;
        let depth = 0;
        while (node && node.nodeType === 1 && depth < 4) {
          if (withinControlScale(node)) return node;
          node = node.parentElement;
          depth += 1;
        }
        return null;
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
        // 「数据表格」的 list / grid 必须带词尾边界：listBox / gridCell 这类**表单控件内部命名**
        // 若被裸子串命中，会把下拉框、表格布局的表单项误标成「数据表格」，
        // 诱使模型把它们当成列表筛选器而不敢操作（历史故障：模型据此怀疑「这些 BID 可能是
        // 我的请假 tab 的筛选器」）。table 保留裸匹配——命中 table 的表就是表格，无误判风险。
        [/table|list(?![a-z])|grid(?![a-z])/, '数据表格'],
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

      /** 判定为「可输入控件」的 input type 白名单（用于区分布局表格与数据表格） */
      const LAYOUT_ENTRY_INPUT_TYPES = new Set([
        'text','search','password','email','tel','url','number',
        'date','datetime-local','month','week','time','',
      ]);

      /**
       * 判定 table 元素是「布局表格」还是「数据表格」。
       *
       * 企业级表单（金智 EMAP / 旧版教务）惯用 table 做栅格布局，表内承载的是输入控件；
       * 真正的数据表格里只有文本与链接。不加区分会把表单字段整体标成「数据表格」，
       * 模型据此误判为列表筛选器而不敢下手。
       *
       * 金智 EMAP 的栅格表格里往往只有 div 包装的自定义组件与 input[type=hidden]，
       * 因此除原生控件外还必须识别 EMAP / JQWidgets 的组件线索。
       */
      const LAYOUT_TABLE_COMPONENT_CLUES = [
        '[data-caption]', '[data-name]', '[xtype]',
        '[role="combobox"]', '[role="tree"]', '[role="radio"]', '[role="checkbox"]',
        '.bh-form-group', '.jqx-widget',
      ];
      const isLayoutTable = (table) => {
        try {
          if (!table.querySelectorAll) return false;
          const fields = table.querySelectorAll('input, select, textarea');
          for (let i = 0; i < fields.length; i++) {
            const field = fields[i];
            const ftag = tagOf(field);
            if (ftag === 'select' || ftag === 'textarea') return true;
            const ftype = (field.getAttribute ? (field.getAttribute('type') || '') : '').toLowerCase();
            if (LAYOUT_ENTRY_INPUT_TYPES.has(ftype)) return true;
          }
          const clue = table.querySelector ? table.querySelector(LAYOUT_TABLE_COMPONENT_CLUES.join(',')) : null;
          if (clue) return true;
        } catch (e) {}
        return false;
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
            // 表格布局的表单 → 归入「表单区」，避免表单字段被误读成列表筛选器
            if (tag === 'table') return deriveRegionLabel(node, isLayoutTable(node) ? '表单区' : '数据表格');
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
        // 第三道防线：单次表格提取 30ms 软熔断，超时立即退出并保留已提取内容，
        // 绝不因超大 / 病态表格（嵌套量词回溯）阻塞渲染主线程卡死页面。
        const __tableStart = Date.now();
        let tables = [];
        try {
          tables = queryAllDeep(doc, 'table');
        } catch (e) { return; }
        for (let ti = 0; ti < tables.length; ti++) {
          if (dataTables.length >= ${MAX_DATA_TABLES}) return;
          if (Date.now() - __tableStart > 30) return;
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
            if (Date.now() - __tableStart > 30) break;
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

      // 循环引用熔断：以 WeakSet 记录已遍历的 Document 引用（WeakSet 不阻碍 GC），
      // 配合硬性递归深度上限 6，彻底阻断利用 src="about:blank" 或恶意 iframe 互相嵌套
      // 导致的调用栈溢出（Maximum call stack size exceeded）。
      const visitedDocs = new WeakSet();

      // ===== 浮层（下拉 / 树选择 / 级联 / 日期面板）统一纳管 =====
      //
      // 为什么必须由浮层统一纳管，而不是让主遍历顺手采掉：
      //   1. **身份突变**：jqxTree 选中一个节点后会给它加 tabindex="0" / class*="selected"，
      //      下一次采集时它会以 actionable generic 的身份在主遍历里提前拿到 [BID]，随后被
      //      去重挡在浮层纳管之外 —— 选项在台账里凭空蒸发，模型误判「已生效」（5 轮死锁原点）；
      //   2. **双胞胎**：外层弹窗容器（.jqx-dropdownlist-popup）与内层列表容器
      //      （[id*=innerListBox]）会各自命中一次浮层选择器，同一份省份被采集两遍，
      //      第二份还会撞上限被腰斩，诱导模型误以为是「两级级联」。
      // 因此：浮层内的元素一律不在主遍历阶段采集，统一由 emitPopupOptions 以 role=option 输出。
      // 关键约束：**两端必须共用同一判定函数**（isPopupOwned），否则元素会两头落空而丢失 [BID]。
      const POPUP_SELECTORS = ${JSON.stringify(YANHU_POPUP_SELECTORS)};
      const topWin = document.defaultView || window;
      const __popupIsFloatingScale = (node) => {
        let r = null;
        try { r = node.getBoundingClientRect(); } catch (e) {}
        if (!r || r.width <= 0 || r.height <= 0) return false;
        const vw = topWin.innerWidth || 1200;
        const vh = topWin.innerHeight || 800;
        // 占满整页的常规容器不算浮层，否则会把页面主体整体吞掉
        return r.width < vw * 0.9 && r.height < vh * 0.8;
      };
      const popupRootOf = (el) => {
        let node = el;
        let depth = 0;
        while (node && node.nodeType === 1 && depth < 8) {
          let hit = false;
          try { hit = node.matches ? node.matches(POPUP_SELECTORS.join(',')) : false; } catch (e) { hit = false; }
          if (hit && __popupIsFloatingScale(node)) return node;
          node = node.parentElement;
          depth += 1;
        }
        return null;
      };
      const MAX_POPUP_CHARS = ${MAX_POPUP_OPTION_CHARS};
      /**
       * 元素是否**由浮层纳管**（改由 emitPopupOptions 以 role=option 输出）。
       *
       * 两条硬约束，缺一不可：
       *   1. **必须是浮层根的严格后代**（root !== el）。历史事故：jqx-dropdownlist-state-normal
       *      这类控件自身类名就含 dropdown，会让触发器自己成为「浮层根」，而浮层端只发后代不发根
       *      → 整个触发器凭空失去 [BID]（出校去向 / 请假类型 / 冲突课程集体消失，台账腰斩）。
       *   2. **必须能取到自身的短文本**（且非占位提示）。这是"无损"保证：主遍历跳过的每一个元素，
       *      浮层端都必然以同一段 own 文本重新编号；反之若放行无文本元素（如图标按钮），
       *      它会两头落空而丢失 [BID]。
       */
      const isPopupOwned = (el, style, rect) => {
        const root = popupRootOf(el);
        if (!root || root === el) return false;
        if (!isRenderedElement(el, style, rect)) return false;
        const own = __yanhuOwnText(el);
        if (!own || own.length > MAX_POPUP_CHARS) return false;
        return !__yanhuIsPlaceholderText(own);
      };

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

          if (!isRenderedElement(el, style, rect)) {
            // ===== 可见代理重绑定：隐藏的原生控件改绑到它的可见载体上 =====
            // 自定义单选 / 复选把原生 input 隐藏，真正的点击目标（<label> 或小尺度包裹）是渲染中的。
            // 此时把 BID 绑到代理上：渲染红线不破（几何与可见性均取代理），
            // 且原生 label 语义保证点击该 [BID] 即切换选项。
            const inputType = (tag === 'input') ? (attr(el, 'type') || '').toLowerCase() : '';
            if (actionable && inputType !== 'hidden' && (tag === 'input' || tag === 'select' || tag === 'textarea')) {
              const proxy = __yanhuRenderedProxyOf(el, doc);
              if (proxy) {
                const proxyText = __yanhuCleanName(proxy.innerText || proxy.textContent || '');
                const effectiveName = name || proxyText;
                if (effectiveName) {
                  let pr = { left: 0, top: 0, width: 0, height: 0 };
                  try { pr = proxy.getBoundingClientRect(); } catch (e) {}
                  // 勾选状态必须随代理一起投递：radio / checkbox 常被视觉隐藏（0×0）而以 label 承载，
                  // 若 value 恒空，模型就无法核对「是否出校 = 是」这类点击是否真的生效（历史事故）。
                  const __inputType = ((el.getAttribute && el.getAttribute('type')) || '').toLowerCase();
                  const __proxyValue =
                    __inputType === 'radio' || __inputType === 'checkbox'
                      ? (el.checked ? '已勾选' : '未勾选')
                      : clip(el.value != null ? String(el.value) : '')
                  emit.push({
                    tag: tagOf(proxy),
                    role,
                    name: effectiveName,
                    value: __proxyValue || undefined,
                    bounds: {
                      x: Math.round(offset.x + pr.left),
                      y: Math.round(offset.y + pr.top),
                      width: Math.round(pr.width),
                      height: Math.round(pr.height),
                    },
                    visible: true,
                    ariaHidden: false,
                    occluded: false,
                    region: computeRegion(proxy, framePath),
                    framePath: framePath || undefined,
                    actionable: true,
                    options: collectOptions(el),
                  });
                  emittedNodes.push(proxy);
                  if (isNav) navCount += 1;
                  continue;
                }
              }
            }

            // 渲染红线：其余未被渲染的元素绝不分配 BID。
            //
            // 历史缺陷：这类元素曾被标为 [Collapsed] 并投递给模型，但它们的边界盒恒为 0×0，
            // 点击必然被网页驳回（No-Op），逐层「解封」还会强行把 display 改回 '' 而打乱真实页面
            // 状态；模型因此反复重试、反复重读页面，既烧 Token 又烧时间。
            // 现在只做计数与区域归属统计，用于在摘要末尾给出一行提示，引导模型先点击可见入口展开。
            if (actionable && name && attr(el, 'aria-hidden') !== 'true') {
              unrenderedCount += 1;
              const uRegion = computeRegion(el, framePath);
              if (uRegion && unrenderedRegions.indexOf(uRegion) < 0 && unrenderedRegions.length < 6) {
                unrenderedRegions.push(uRegion);
              }
            }
            continue;
          }

          // 浮层内的元素统一交由 emitPopupOptions 以 role=option 输出：
          // 判定函数与浮层纳管端完全一致（isPopupOwned），杜绝「两头落空丢 BID」与「重复编号」。
          if (!isNav && isPopupOwned(el, style, rect)) continue;

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
            // 非输入型控件（自定义下拉 / 树选择 / 日期控件 / 按钮）的「当前显示值」此前恒为空，
            // 模型因此**无法核对选区是否写入**（历史事故：出校去向选了香港，模型却无从证实，
            // 只能反复试、最后撞熔断）。这里补上显示文本；与解析出的 name 完全相同时不再重复投递，
            // 以免给台账添冗余噪音。
            const __displayValue = __yanhuDisplayText(el);
            value = __displayValue && __displayValue !== name ? clip(__displayValue) : undefined;
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
          emittedNodes.push(el);
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

      // ===== 浮层选项统一纳管（emitPopupOptions）=====
      //
      // 由 isPopupOwned 判定（与主遍历共用同一函数）的元素在此以 role=option 规范输出：
      //   - 事件委托型的树节点 / 选项行自身没有交互标记，主遍历会把它剪掉；
      //   - 被 jqxTree 附加 tabindex 的选中节点则相反，会"身份突变"成 generic —— 由主遍历让位解决。
      // 两道去重：
      //   ① 嵌套浮层包含去重：外层弹窗已处理过，内层列表容器不再重复采集
      //      （历史上同一份省份被采集两遍，第二份还撞上限腰斩，诱导模型以为是「两级级联」）；
      //   ② 已编号节点去重（emittedNodes）：同一 DOM 节点绝不重复编号。
      // 新编号一律**追加在台账末尾**，保证既有元素的 BID 编号完全不变（不破坏已跑通的流程）。
      const MAX_POPUP_OPTIONS = ${MAX_COLLECTED_POPUP_OPTIONS};
      let popupOptionCount = 0;
      const processedPopups = [];
      const emitPopupOptions = (doc, framePath, offset, depth) => {
        if (!doc || depth > 6) return;
        let popups = [];
        try { popups = Array.from(doc.querySelectorAll(POPUP_SELECTORS.join(','))); } catch (e) { popups = []; }
        for (let pi = 0; pi < popups.length; pi++) {
          if (emit.length >= MAX || popupOptionCount >= MAX_POPUP_OPTIONS) return;
          const popup = popups[pi];
          if (!__popupIsFloatingScale(popup)) continue;
          // ① 已被外层浮层覆盖：跳过，避免同一份选项被采集两遍
          let covered = false;
          for (let qi = 0; qi < processedPopups.length; qi++) {
            const outer = processedPopups[qi];
            if (outer !== popup && outer.contains && outer.contains(popup)) { covered = true; break; }
          }
          if (covered) continue;
          processedPopups.push(popup);
          let items = [];
          try { items = Array.from(popup.querySelectorAll('*')); } catch (e) { items = []; }
          for (let ii = 0; ii < items.length; ii++) {
            if (emit.length >= MAX || popupOptionCount >= MAX_POPUP_OPTIONS) break;
            const item = items[ii];
            // ② 已编号节点去重
            if (emittedNodes.indexOf(item) >= 0) continue;
            let istyle = null;
            try { istyle = topWin.getComputedStyle ? topWin.getComputedStyle(item) : null; } catch (e) { continue; }
            let irect = { left: 0, top: 0, width: 0, height: 0 };
            try { irect = item.getBoundingClientRect(); } catch (e) {}
            if (!isPopupOwned(item, istyle, irect)) continue;
            const own = __yanhuOwnText(item);
            const label = own || __yanhuFirstLeafText(item, MAX_POPUP_CHARS) || '';
            if (!label) continue;
            popupOptionCount += 1;
            emittedNodes.push(item);
            emit.push({
              tag: tagOf(item),
              role: 'option',
              name: __yanhuCleanName(label),
              value: undefined,
              bounds: {
                x: Math.round(offset.x + irect.left),
                y: Math.round(offset.y + irect.top),
                width: Math.round(irect.width),
                height: Math.round(irect.height),
              },
              visible: true,
              ariaHidden: false,
              occluded: false,
              region: computeRegion(item, framePath),
              framePath: framePath || undefined,
              actionable: true,
            });
          }
        }
        let frames = [];
        try { frames = doc.querySelectorAll ? Array.from(doc.querySelectorAll('frame, iframe')) : []; } catch (e) { frames = []; }
        for (let fi = 0; fi < frames.length; fi++) {
          try {
            const f = frames[fi];
            let fr = { left: 0, top: 0 };
            try { fr = f.getBoundingClientRect(); } catch (e) {}
            const fName = attr(f, 'name') || attr(f, 'id') || ('frame_' + fi);
            const nextPath = framePath ? (framePath + '/' + fName) : fName;
            const sub = f.contentDocument || (f.contentWindow && f.contentWindow.document);
            if (sub) {
              emitPopupOptions(sub, nextPath, { x: offset.x + (fr.left || 0), y: offset.y + (fr.top || 0) }, depth + 1);
            }
          } catch (e) {}
        }
      };
      try { emitPopupOptions(document, '', { x: 0, y: 0 }, 0); } catch (e) {}

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
        url: safeHref(location),
        title: safeTitle(document) || '',
        elements: emit,
        dataTables: dataTables,
        closedShadowHosts: closedShadowHosts,
        textDigest: textDigest,
        textSample: textSample,
        unrendered: { count: unrenderedCount, regions: unrenderedRegions },
      };
    } catch (err) {
      return { url: '', title: '', elements: [], dataTables: [], error: String(err && err.message ? err.message : err) };
    }
  })()`
}

/**
 * 第二级：布局与可视性剪枝 + 交互候选集过滤（定义 1）。
 *
 * **渲染红线**：只有当前真实渲染在页面上的元素才可能进入 BID 台账。
 * 未渲染元素（display:none / visibility:hidden / opacity:0 / content-visibility:hidden / 零尺寸 /
 * 无布局盒）一律剔除——它们的点击必然被网页驳回，且会污染 BID 双射、抬高 Token 与定位歧义。
 * 这类元素的存在由 `unrendered` 汇总在 PageDigest 末尾以纯文本提示（不含 BID）。
 */
export function filterActionableElements(elements: readonly YanhuRawElement[]): YanhuRawElement[] {
  return elements.filter((el) => {
    if (!el.actionable || el.ariaHidden) return false
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

/** 归一化「未渲染元素」统计（防御非法结构，空统计归零） */
function normalizeUnrendered(raw: unknown): { count: number; regions: string[] } | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const candidate = raw as { count?: unknown; regions?: unknown }
  const count = typeof candidate.count === 'number' && candidate.count > 0 ? Math.trunc(candidate.count) : 0
  if (count === 0) return undefined
  const regions = Array.isArray(candidate.regions)
    ? candidate.regions.filter((r): r is string => typeof r === 'string' && r.length > 0).slice(0, 6)
    : []
  return { count, regions }
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
  /** 闭合 Shadow DOM 宿主标签集合（非空时在 PageDigest 中标注，提示已交 CDP 深度补漏） */
  closedShadowHosts?: readonly string[]
  /** 未被渲染的可交互元素统计（不分配 BID，仅汇总提示） */
  unrendered?: { count: number; regions: string[] }
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
  // 未渲染元素汇总：只在存在时输出，且紧贴头部（避免被 Token 预算截断而丢失最关键的一条线索）。
  // 不给 BID——未渲染控件点击必被网页驳回；只提示「先点可见入口展开，再重新读取」。
  if (input.unrendered && input.unrendered.count > 0) {
    const where = input.unrendered.regions.length > 0 ? `，主要位于：${input.unrendered.regions.join('、')}` : ''
    lines.push(
      `[未渲染元素 ${input.unrendered.count} 个${where}（折叠菜单 / 隐藏面板 / 未激活标签页）——未分配 [BID]：请先点击其可见入口展开，再 yanhu_read_page 获取新 [BID]]`,
    )
  }
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

  // 闭合 Shadow DOM 宿主提示：普通 querySelectorAll 无法穿透闭合影子树，
  // 此处显式标注已探测到的宿主，提示其内容由 CDP DOM.getDocument(pierce) 深度补漏解析。
  if (input.closedShadowHosts && input.closedShadowHosts.length > 0) {
    const uniq = Array.from(new Set(input.closedShadowHosts)).slice(0, 8)
    lines.push(`[闭合 Shadow DOM 宿主 ${uniq.length} 个：${uniq.join(', ')}（已交 CDP 深度补漏解析）]`)
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
export function formatBidLine(record: YanhuBidNode): string {
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
      closedShadowHosts: Array.isArray(collected.closedShadowHosts) ? collected.closedShadowHosts : undefined,
      unrendered: normalizeUnrendered(collected.unrendered),
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
      unrendered: normalizeUnrendered(collected.unrendered),
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
