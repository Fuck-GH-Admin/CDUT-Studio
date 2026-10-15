/**
 * AiClassCognitionButton — AI 速课堂「认知底座」右上角快捷入口胶囊
 *
 * 常驻于速课堂中间对话区域右上角，点击唤起场景化配置弹窗。
 * 挂载时从主进程 settings.json 水合当前双引擎选择，保证胶囊徽标与设置页实时一致。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Brain } from 'lucide-react'
import {
  cognitionModalOpenAtom,
  memoryRetrievalEngineAtom,
  studyRetrievalEngineAtom,
} from '@/atoms/study-retrieval-atoms'
import { cn } from '@/lib/utils'

export function AiClassCognitionButton(): React.ReactElement {
  const setModalOpen = useSetAtom(cognitionModalOpenAtom)
  const setStudyEngine = useSetAtom(studyRetrievalEngineAtom)
  const setMemoryEngine = useSetAtom(memoryRetrievalEngineAtom)
  const studyEngine = useAtomValue(studyRetrievalEngineAtom)
  const memoryEngine = useAtomValue(memoryRetrievalEngineAtom)
  const isEnhanced = studyEngine === 'graphrag' || memoryEngine === 'hipporag'

  // 挂载时从主进程设置水合当前引擎选择，保证多条入口状态同步
  React.useEffect(() => {
    let alive = true
    window.electronAPI
      .getSettings()
      .then((settings) => {
        if (!alive) return
        setStudyEngine(settings.studyRetrievalEngine === 'graphrag' ? 'graphrag' : 'classic')
        setMemoryEngine(settings.memoryRetrievalEngine === 'hipporag' ? 'hipporag' : 'classic')
      })
      .catch(() => {
        // 读取失败保持默认经典实现，不影响胶囊使用
      })
    return () => {
      alive = false
    }
  }, [setStudyEngine, setMemoryEngine])

  return (
    <button
      type="button"
      onClick={() => setModalOpen(true)}
      title="认知底座设置：调整课堂知识检索与跨课联想记忆引擎"
      className="group absolute right-4 top-3 z-20 inline-flex items-center gap-2 rounded-full border border-primary/40 bg-gradient-to-r from-primary/15 via-card/90 to-card/90 px-3.5 py-1.5 text-xs font-semibold text-foreground shadow-md shadow-primary/10 backdrop-blur-md transition-all hover:border-primary/60 hover:shadow-lg hover:shadow-primary/20 active:scale-95"
    >
      {/* 高亮信标点：提示当前引擎配置入口 */}
      <span className="relative flex size-2 shrink-0">
        <span
          className={cn(
            'absolute inline-flex size-full animate-ping rounded-full opacity-60',
            isEnhanced ? 'bg-violet-500' : 'bg-sky-500',
          )}
        />
        <span
          className={cn(
            'relative inline-flex size-2 rounded-full',
            isEnhanced ? 'bg-violet-500' : 'bg-sky-500',
          )}
        />
      </span>
      <Brain size={14} className="text-primary transition-transform group-hover:scale-110" />
      <span>认知底座</span>
      <span
        className={cn(
          'rounded-full px-2 py-0.5 text-[10px] font-semibold',
          isEnhanced ? 'bg-violet-500/15 text-violet-600 dark:text-violet-400' : 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
        )}
      >
        {isEnhanced ? '宏观演进+联想' : '经典精准'}
      </span>
    </button>
  )
}
