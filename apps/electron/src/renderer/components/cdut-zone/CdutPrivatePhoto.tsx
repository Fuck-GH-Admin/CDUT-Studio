/**
 * CdutPrivatePhoto — 特区账户真实照片隐私蒙版
 *
 * 默认在本人真实照片上覆盖一层模糊透明蒙版（朦胧效果，保护隐私）；
 * 单击去除蒙版显示原图，再次单击恢复蒙版。
 */

import * as React from 'react'

interface CdutPrivatePhotoProps {
  src: string
  alt: string
}

export function CdutPrivatePhoto({ src, alt }: CdutPrivatePhotoProps): React.ReactElement {
  const [masked, setMasked] = React.useState(true)
  const [loaded, setLoaded] = React.useState(false)

  return (
    <button
      type="button"
      onClick={() => setMasked((prev) => !prev)}
      aria-label={masked ? '点击查看原图' : '点击遮挡照片'}
      className="relative block size-full overflow-hidden cursor-pointer bg-muted/40"
    >
      {!loaded && (
        <span
          aria-hidden="true"
          className="absolute inset-0 animate-pulse bg-gradient-to-r from-muted/40 via-muted/80 to-muted/40"
        />
      )}
      <img
        src={src}
        alt={alt}
        onLoad={() => setLoaded(true)}
        className={`size-full object-cover transition-opacity duration-300 ${loaded ? 'opacity-100' : 'opacity-0'}`}
        draggable={false}
      />
      {loaded && masked ? (
        <span
          aria-hidden="true"
          className="absolute inset-0 bg-card/30 backdrop-blur-[3px]"
        />
      ) : null}
    </button>
  )
}
