/**
 * CdutWatermarkBackground — CDUT 专区左下角校宠立绘艺术环境水印
 *
 * 以非阻断式（pointer-events-none）方式将校宠立绘吉祥物柔和融入内容区左下方底纹：
 * - 浅色模式：沿用白底 JPEG + multiply 混合滤除白底，径向渐变遮罩羽化边缘；
 * - 深色模式：改用原生 RGBA 真透明立绘（与桌宠「砚小龙」同源），直读自然色彩，
 *   不再使用 invert / hue-rotate / screen 等破坏明度的反相滤镜，并恢复羽化遮罩。
 *
 * 两种模式各自只渲染一张图，绝不遮挡任何交互与文字。
 */

import * as React from 'react'
import lightMascotImg from '@assets/IP/IP_1.jpg'
import darkMascotImg from '@assets/IP/Cute_IP/Breathing.png'

export function CdutWatermarkBackground(): React.ReactElement {
  return (
    <div
      className="pointer-events-none absolute bottom-0 left-0 z-0 select-none"
      aria-hidden="true"
    >
      {/* 浅色模式：保持原有白底 JPEG 与 multiply 融合效果 */}
      <img
        src={lightMascotImg}
        alt=""
        draggable={false}
        className="w-[260px] max-w-[42vw] object-contain opacity-30 mix-blend-multiply [mask-image:radial-gradient(circle_at_bottom_left,black_50%,transparent_95%)] sm:w-[320px] dark:hidden"
      />
      {/* 深色模式：真透明立绘，避免反相导致的面部变黑与瞳孔发白 */}
      <img
        src={darkMascotImg}
        alt=""
        draggable={false}
        className="hidden w-[260px] max-w-[42vw] object-contain opacity-20 [mask-image:radial-gradient(circle_at_bottom_left,black_45%,transparent_90%)] sm:w-[320px] dark:block"
      />
    </div>
  )
}
