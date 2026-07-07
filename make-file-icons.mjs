// Crops the oversized file-type icons (resources/{PDF,MD,IMG}.png) to their
// center region and downscales to 128px for the attachment list chips.
// Run: node make-file-icons.mjs
import { createCanvas, loadImage } from 'canvas'
import { writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_SIZE = 128
const CROP = 0.62   // keep the middle 62% -- the artwork sits centered with wide margins

const jobs = [
  ['PDF.png', 'file-pdf.png'],
  ['MD.png',  'file-md.png'],
  ['IMG.png', 'file-img.png'],
]

for (const [src, dst] of jobs) {
  const img = await loadImage(join(__dirname, 'resources', src))
  const cw = img.width * CROP
  const ch = img.height * CROP
  const cx = (img.width - cw) / 2
  const cy = (img.height - ch) / 2

  const canvas = createCanvas(OUT_SIZE, OUT_SIZE)
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, cx, cy, cw, ch, 0, 0, OUT_SIZE, OUT_SIZE)

  const out = join(__dirname, 'src', 'renderer', 'src', 'assets', dst)
  writeFileSync(out, canvas.toBuffer('image/png'))
  console.log(`${dst} written`)
}
