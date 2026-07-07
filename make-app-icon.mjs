// Generates resources/icon.ico (multi-size, PNG-compressed entries)
// from Veridian.png. Run: node make-app-icon.mjs
import { createCanvas, loadImage } from 'canvas'
import { writeFileSync, mkdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SIZES = [16, 24, 32, 48, 64, 128, 256]

const src = await loadImage(join(__dirname, 'Veridian.png'))

const pngs = SIZES.map((size) => {
  const canvas = createCanvas(size, size)
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(src, 0, 0, size, size)
  return { size, buf: canvas.toBuffer('image/png') }
})

// ICO container: ICONDIR + ICONDIRENTRY[] + PNG blobs (Vista+ supports PNG entries)
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)            // reserved
header.writeUInt16LE(1, 2)            // type: icon
header.writeUInt16LE(pngs.length, 4)  // count

const entries = []
let offset = 6 + 16 * pngs.length
for (const { size, buf } of pngs) {
  const e = Buffer.alloc(16)
  e.writeUInt8(size === 256 ? 0 : size, 0)  // width (0 = 256)
  e.writeUInt8(size === 256 ? 0 : size, 1)  // height
  e.writeUInt8(0, 2)                        // palette colors
  e.writeUInt8(0, 3)                        // reserved
  e.writeUInt16LE(1, 4)                     // planes
  e.writeUInt16LE(32, 6)                    // bpp
  e.writeUInt32LE(buf.length, 8)            // data size
  e.writeUInt32LE(offset, 12)               // data offset
  entries.push(e)
  offset += buf.length
}

mkdirSync(join(__dirname, 'resources'), { recursive: true })
const ico = Buffer.concat([header, ...entries, ...pngs.map((p) => p.buf)])
writeFileSync(join(__dirname, 'resources', 'icon.ico'), ico)

// Also refresh the base PNG used by Linux builds
const png512 = createCanvas(512, 512)
const c = png512.getContext('2d')
c.imageSmoothingEnabled = true
c.imageSmoothingQuality = 'high'
c.drawImage(src, 0, 0, 512, 512)
writeFileSync(join(__dirname, 'resources', 'icon.png'), png512.toBuffer('image/png'))

console.log(`icon.ico written (${ico.length} bytes, ${pngs.length} sizes) + icon.png`)
