/**
 * CdutLogo / CdutMark — 成都理工大学品牌标识的统一入口。
 *
 * 校徽锁版（PNG）与矢量标识（SVG）在深色背景下都需要反白版本：
 * - CdutLogo：浅色用深墨绿原版，深色用白版（同尺寸裁切，几何完全重合）；
 * - CdutMark：浅色用墨黑描边版，深色用白色描边版。
 */

import * as React from 'react'

import cdutCeColor from '@assets/CDUT/CDUT-CE.png'
import cdutCeWhite from '@assets/CDUT/CDUT-CE-white.png'
import cdutMarkColor from '@/assets/cdut-logo.svg'
import cdutMarkDark from '@/assets/cdut-logo-dark.svg'
import { useIsDarkTheme } from '@/hooks/use-is-dark-theme'
import { cn } from '@/lib/utils'

interface BrandLogoProps {
  className?: string
  alt?: string
}

/** 校徽 + 中英文校名组合（PNG 锁版） */
export function CdutLogo({ className, alt = '成都理工大学校徽' }: BrandLogoProps): React.ReactElement {
  const isDark = useIsDarkTheme()
  return (
    <img
      src={isDark ? cdutCeWhite : cdutCeColor}
      alt={alt}
      draggable={false}
      className={cn('object-contain', className)}
    />
  )
}

/** 侧边栏 / 速课堂使用的矢量标识 */
export function CdutMark({ className, alt = 'CDUT Studio' }: BrandLogoProps): React.ReactElement {
  const isDark = useIsDarkTheme()
  return (
    <img
      src={isDark ? cdutMarkDark : cdutMarkColor}
      alt={alt}
      draggable={false}
      className={cn('object-contain', className)}
    />
  )
}
