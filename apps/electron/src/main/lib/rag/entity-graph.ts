/**
 * 轻量跨文档二分实体图（Bipartite Entity Graph & Relational Linker）
 *
 * 职责：
 *   在纯内存中抽取工作区文档切片中的高基数键（学号/工号、寝室号、班级名），
 *   建立「实体 → 切片」倒排索引；当一次提问的种子切片分属不同文档、且通过
 *   共享标识符（如两文档都出现的学号）建立联系时，执行跨文档关系 Join，
 *   把另一份文档中的关联切片一并召回，解决「A 文档有班级无角色、B 文档有角色无班级」
 *   导致传统向量/关键词 RAG 完全失效的实体孤岛问题。
 *
 * 严格红线：纯本地、零数据库、零磁盘写；仅基于已落盘的文档切片内存计算。
 */

/** 实体类别：高基数键用于跨文档 Join，班级名用于过滤维度 */
export type EntityKind = 'id' | 'room' | 'class'

/** 单个实体在切片中的一次出现 */
export interface EntityMention {
  kind: EntityKind
  /** 规范化后的实体值（Join 键） */
  value: string
  /** 带类别前缀的实体键（如 `id:202519110211`） */
  key: string
}

/** 跨文档实体倒排索引 */
export interface EntityIndex {
  /** 实体键 → 命中切片下标集合 */
  readonly mentions: Map<string, Set<number>>
  /** 切片下标 → 该切片包含的实体键集合 */
  readonly chunkEntities: ReadonlySet<string>[]
  /** 实体键 → 展示用原始值 */
  readonly canonical: Map<string, string>
}

/** 跨文档关系 Join 结果 */
export interface RelationalBridgeResult {
  /** 与种子切片共享高基数键、且位于其它切片的桥接切片下标 */
  bridgeIndices: number[]
  /** 触发桥接的共享标识符（规范值，用于证据注释） */
  sharedKeys: string[]
}

/** 参与跨文档 Join 的高基数实体类别（班级名基数太低，不参与 Join，仅作过滤维度） */
const JOIN_KINDS: ReadonlySet<EntityKind> = new Set<EntityKind>(['id', 'room'])

const ID_PATTERN = /(?<!\d)\d{10,12}(?!\d)/g
const ROOM_PATTERN = /\b[A-Za-z]{1,2}\d{1,3}\s?[-–—]\s?\d{1,4}\b/g
const CLASS_PATTERN = /[\u4e00-\u9fa5]{1,12}\d{1,4}(?:[-–—]\d{1,2})?\s*班/g

/** 统一破折号与空白，得到稳定的 Join 键 */
function normalizeEntityValue(raw: string): string {
  return raw.replace(/[\s\u3000]+/g, '').replace(/[–—]/g, '-').toLowerCase()
}

/** 从一段文本中抽取全部实体出现（去重到 (kind, value) 粒度） */
export function extractEntityMentions(text: string): EntityMention[] {
  if (!text) return []
  const seen = new Set<string>()
  const mentions: EntityMention[] = []
  const push = (kind: EntityKind, raw: string): void => {
    const value = normalizeEntityValue(raw)
    if (!value) return
    const key = `${kind}:${value}`
    if (seen.has(key)) return
    seen.add(key)
    mentions.push({ kind, value, key })
  }

  for (const match of text.matchAll(ID_PATTERN)) push('id', match[0])
  for (const match of text.matchAll(ROOM_PATTERN)) push('room', match[0])
  for (const match of text.matchAll(CLASS_PATTERN)) push('class', match[0])
  return mentions
}

/** 为全部切片正文构建实体倒排索引 */
export function buildEntityIndex(chunkTexts: readonly string[]): EntityIndex {
  const mentions = new Map<string, Set<number>>()
  const chunkEntities: Set<string>[] = []
  const canonical = new Map<string, string>()

  chunkTexts.forEach((text, chunkIndex) => {
    const entities = new Set<string>()
    for (const mention of extractEntityMentions(text)) {
      entities.add(mention.key)
      if (!mentions.has(mention.key)) mentions.set(mention.key, new Set())
      mentions.get(mention.key)!.add(chunkIndex)
      if (!canonical.has(mention.key)) canonical.set(mention.key, mention.value)
    }
    chunkEntities.push(entities)
  })

  return { mentions, chunkEntities, canonical }
}

/**
 * 跨文档关系 Join：以种子切片中的高基数键为桥，召回位于**其它文档**的关联切片。
 *
 * 这是「关系型跨文档实体孤岛」的核心解法：只要两份文档共享一个学号/寝室号，
 * 就能把它们的证据在 Turn 前联合注入，无需模型自己写脚本 Join。
 */
export function findRelationalBridges(
  index: EntityIndex,
  seedIndices: readonly number[],
  documentKeyOf: (chunkIndex: number) => string,
  options: { maxBridges?: number } = {},
): RelationalBridgeResult {
  const maxBridges = options.maxBridges ?? 3
  const seedSet = new Set(seedIndices)
  const bridgeIndices: number[] = []
  const bridgeSeen = new Set<number>()
  const sharedKeys = new Set<string>()

  // 收集种子切片携带的高基数键，以及拥有该键的种子文档集合
  const keyToSeedDocs = new Map<string, Set<string>>()
  for (const seedIndex of seedIndices) {
    for (const entityKey of index.chunkEntities[seedIndex] ?? []) {
      const kind = entityKey.split(':')[0] as EntityKind
      if (!JOIN_KINDS.has(kind)) continue
      if (!keyToSeedDocs.has(entityKey)) keyToSeedDocs.set(entityKey, new Set())
      keyToSeedDocs.get(entityKey)!.add(documentKeyOf(seedIndex))
    }
  }

  for (const [entityKey, seedDocs] of keyToSeedDocs) {
    for (const candidateIndex of index.mentions.get(entityKey) ?? []) {
      if (seedSet.has(candidateIndex) || bridgeSeen.has(candidateIndex)) continue
      // 仅桥接「其它文档」的切片：同文档内已有种子覆盖，跨文档才是 Join 价值所在
      if (seedDocs.has(documentKeyOf(candidateIndex))) continue
      bridgeSeen.add(candidateIndex)
      bridgeIndices.push(candidateIndex)
      sharedKeys.add(index.canonical.get(entityKey) ?? entityKey.split(':')[1] ?? entityKey)
      if (bridgeIndices.length >= maxBridges) {
        return { bridgeIndices, sharedKeys: [...sharedKeys] }
      }
    }
  }

  return { bridgeIndices, sharedKeys: [...sharedKeys] }
}
