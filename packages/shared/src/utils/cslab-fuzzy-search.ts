/**
 * CSLab 实验室多字段模糊搜索
 *
 * 红线：不引入第三方拼音词库。这里使用紧凑的「首字母 -> 常用汉字」分组表，
 * 让 `dqwlj` 能命中「地球物理学院」，同时保留原文子串与跳字匹配。
 */

import type { CsLabLab } from '../types/cslab'

/** 常用科研 / 高校词汇汉字的首字母分组表（重复字以先出现者为准）。 */
const PINYIN_INITIAL_GROUPS: Record<string, string> = {
  a: '阿啊哎哀爱安按暗岸案昂奥澳',
  b: '八巴吧白百北被本比笔必毕闭边变便标表别宾冰病波玻博不布步部补半导薄报备',
  c: '才材采彩参残测层查差产长常场超朝沉陈成城程池持尺充冲崇初储传床创吹纯词次从粗催存错瓷催化储',
  d: '大代带单但当党导到道得的地灯等低迪底地第电调跌定东动都度端短段队对多度档滴递第点调碟顶洞督独读断堆',
  e: '俄额恶儿二',
  f: '发法帆反范方防房放飞非菲分粉丰风封峰否夫服福府腐复副傅富附负赋',
  g: '该改概干甘刚钢高告哥格隔个给根跟更工公功共构估古谷骨固故顾关观管光广归规轨贵国果过',
  h: '哈海含汉航好号合何和河核黑很红宏后候呼湖互户化华划话怀环还换黄回汇会绘混活火或货合',
  i: '',
  j: '击机基激及吉级极即急集几计记技既济继加夹家甲价架尖坚间检减简见件建健江将讲交角脚教接街节结解界借金今紧进近京经晶精井景净静境究九久酒旧居局举巨句具据聚卷决绝军均',
  k: '卡开凯看康抗考科可克刻客课肯空孔控口库快宽矿况困扩',
  l: '拉来蓝览劳老乐雷类冷离李里理力历立利例连联脸练良量两亮了料列林临磷零领令流留六龙楼路录陆铝旅律率绿略轮论罗络落',
  m: '麻马码买麦满慢忙毛么没每美门锰米密面民敏名明模膜末莫某母木目',
  n: '拿哪那纳乃耐男南难脑内能尼你年粘念鸟您宁凝牛农浓女暖',
  o: '欧偶',
  p: '怕排派判旁跑培配喷朋批皮篇片品平评凭屏坡破普谱',
  q: '七期其奇骑企启起气汽器千前浅强墙桥切亲轻清情请庆穷球区取全权缺却群',
  r: '然燃染让热人认任日容溶熔如软',
  s: '三色森杀沙山闪善商上少设社射申深神审甚生声省圣师失石时实识史使始示世市式事势试视是收手守首受书叔属术树数刷帅双水顺说硕司丝思四送苏素速塑算随碎孙所索扫色砂射涉室',
  t: '他它她台太态谈碳汤唐糖陶讨特疼提题体天田调铁听停通同统透图土团推退',
  u: '',
  v: '',
  w: '挖外完晚万王网往望危微为围维伟委卫未位温文稳问我无五午武舞物务误',
  x: '西吸希析息悉洗系细下先纤显现限线相香详项象像消小效校些协写谢心新信星行形性雄修需许序续宣选学雪寻迅',
  y: '压呀亚烟严研盐颜眼演验央阳样药要也业叶页液一医依仪已以义艺议引应英营影映硬拥永用优油有又于余与宇语育预域元员园原源远院约月越云允运韵',
  z: '杂再在早造责增扎展张章找照折者这针真诊阵振镇争整正证政之支知直值职止只纸指至志制质治中终钟重周轴珠主助住注专转装状追准资子字自总走组钻最左作坐',
}

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/
const ASCII_ALNUM_RE = /[a-z0-9]/i

const CHAR_TO_INITIAL = new Map<string, string>()
for (const [initial, chars] of Object.entries(PINYIN_INITIAL_GROUPS)) {
  for (const char of chars) {
    if (!CHAR_TO_INITIAL.has(char)) CHAR_TO_INITIAL.set(char, initial)
  }
}

/** 取文本的拼音首字母串；ASCII 字母数字保留并小写，标点与空白忽略。 */
export function getPinyinInitials(text: string): string {
  let output = ''
  for (const char of text) {
    if (/\s/.test(char)) continue
    if (ASCII_ALNUM_RE.test(char)) {
      output += char.toLowerCase()
      continue
    }
    if (CJK_RE.test(char)) {
      output += CHAR_TO_INITIAL.get(char) ?? char
    }
  }
  return output
}

/** 判断 needle 是否为 haystack 的子序列（允许跳字）。 */
function isSubsequence(needle: string, haystack: string): boolean {
  if (!needle) return true
  let index = 0
  for (const char of haystack) {
    if (char === needle[index]) index += 1
    if (index === needle.length) return true
  }
  return false
}

/** 单字段匹配分值：原文 > 首字母 > 子序列。 */
function matchField(field: string, query: string): number {
  if (!field) return 0
  const raw = field.toLowerCase()
  const rawIndex = raw.indexOf(query)
  if (rawIndex === 0) return 60
  if (rawIndex > 0) return 48

  const initials = getPinyinInitials(field)
  if (!initials) return 0
  const initialIndex = initials.indexOf(query)
  if (initialIndex === 0) return 44
  if (initialIndex > 0) return 34

  if (isSubsequence(query, initials) || isSubsequence(query, raw)) return 18
  return 0
}

export interface CsLabFuzzyMatchResult {
  matched: boolean
  score: number
}

/**
 * 多字段模糊匹配：名称 100 > 编号 70 > 标签 55 > 描述 35。
 * 空查询始终命中且不加权；置顶项仅在已命中结果中获得小幅加分。
 *
 * 查询按空白切分为多个 token，采用 AND 语义：每个 token 都必须至少命中一个字段。
 * 这样「固态 电池」这类带空格的复合查询不会因为空格字符无法参与子序列匹配而整体失效。
 */
export function matchLabFuzzy(lab: CsLabLab, rawQuery: string): CsLabFuzzyMatchResult {
  const query = rawQuery.trim().toLowerCase()
  if (!query) return { matched: true, score: 0 }

  const tokens = query.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return { matched: true, score: 0 }

  const fields: Array<{ text: string; weight: number }> = [
    { text: lab.name ?? '', weight: 100 },
    { text: lab.code ?? '', weight: 70 },
    { text: lab.tags?.join(' ') ?? '', weight: 55 },
    { text: lab.description ?? '', weight: 35 },
  ]

  let total = 0
  for (const token of tokens) {
    let best = 0
    for (const field of fields) {
      const fieldScore = matchField(field.text, token)
      if (fieldScore > 0) best = Math.max(best, field.weight + fieldScore)
    }
    if (best === 0) return { matched: false, score: 0 }
    total += best
  }

  return { matched: true, score: total + (lab.pinned ? 5 : 0) }
}
