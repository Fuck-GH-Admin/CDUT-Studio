/**
 * CdutWatermarkBackground — CDUT 专区左下角校宠立绘艺术环境水印
 *
 * 以非阻断式（pointer-events-none）方式将校宠立绘吉祥物柔和融入内容区左下方底纹：
 * - 浅色模式：multiply 混合 + 适当透明度，白色底自然滤除；
 * - 深色模式：反相 + hue-rotate + screen 发光，适配暗色背景；
 * - 结合径向渐变遮罩羽化边缘，绝不遮挡任何交互与文字。
 *
 * 红线：深色模式不得恢复 mask-image。带蒙版的元素会形成隔离合成群组，
 * 阻断 mix-blend-screen 与宿主背景的滤色计算，反相黑底会变成半透明灰斑。
 */

import * as React from 'react'
import mascotImg from '@assets/IP/IP_1.jpg'

export function CdutWatermarkBackground(): React.ReactElement {
  return (
    <div
      className="pointer-events-none absolute bottom-0 left-0 z-0 select-none"
      aria-hidden="true"
    >
      <img
        src={mascotImg}
        alt=""
        draggable={false}
        className="w-[260px] max-w-[42vw] object-contain opacity-30 mix-blend-multiply [mask-image:radial-gradient(circle_at_bottom_left,black_50%,transparent_95%)] sm:w-[320px] dark:opacity-20 dark:invert dark:hue-rotate-180 dark:mix-blend-screen dark:[mask-image:none]"
      />
    </div>
  )
}
