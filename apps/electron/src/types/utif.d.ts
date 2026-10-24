declare module 'utif' {
  export interface UtifDecoder {
    decode(buffer: Uint8Array | ArrayBuffer): Array<Record<string, unknown>>
    decodeImage(buffer: Uint8Array | ArrayBuffer, ifd: Record<string, unknown>): void
    toRGBA8(ifd: Record<string, unknown>): Uint8Array
  }
  const UTIF: UtifDecoder
  export default UTIF
}
