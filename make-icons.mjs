// Generates PNG icons for the browser extension from inline SVG
import { createCanvas } from 'canvas'
import { writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

function drawIcon(size) {
  const canvas = createCanvas(size, size)
  const ctx = canvas.getContext('2d')
  const r = size * 0.22  // corner radius

  // Blue rounded-rect background
  ctx.beginPath()
  ctx.moveTo(r, 0)
  ctx.lineTo(size - r, 0)
  ctx.quadraticCurveTo(size, 0, size, r)
  ctx.lineTo(size, size - r)
  ctx.quadraticCurveTo(size, size, size - r, size)
  ctx.lineTo(r, size)
  ctx.quadraticCurveTo(0, size, 0, size - r)
  ctx.lineTo(0, r)
  ctx.quadraticCurveTo(0, 0, r, 0)
  ctx.closePath()
  ctx.fillStyle = '#007aff'
  ctx.fill()

  // Document lines
  const lx = size * 0.22
  const lh = size * 0.065
  const lRadius = lh / 2
  const gaps = [0.28, 0.42, 0.56, 0.68]
  const widths = [0.56, 0.44, 0.50, 0.34]

  gaps.forEach((top, i) => {
    const lw = size * widths[i]
    const ly = size * top
    ctx.beginPath()
    ctx.moveTo(lx + lRadius, ly)
    ctx.lineTo(lx + lw - lRadius, ly)
    ctx.quadraticCurveTo(lx + lw, ly, lx + lw, ly + lRadius)
    ctx.lineTo(lx + lw, ly + lh - lRadius)
    ctx.quadraticCurveTo(lx + lw, ly + lh, lx + lw - lRadius, ly + lh)
    ctx.lineTo(lx + lRadius, ly + lh)
    ctx.quadraticCurveTo(lx, ly + lh, lx, ly + lh - lRadius)
    ctx.lineTo(lx, ly + lRadius)
    ctx.quadraticCurveTo(lx, ly, lx + lRadius, ly)
    ctx.closePath()
    ctx.fillStyle = `rgba(255,255,255,${i === 0 ? 0.95 : i < 3 ? 0.75 : 0.55})`
    ctx.fill()
  })

  return canvas.toBuffer('image/png')
}

for (const size of [16, 48, 128]) {
  const buf = drawIcon(size)
  const out = join(__dirname, 'browser-extension', 'icons', `icon${size}.png`)
  writeFileSync(out, buf)
  console.log(`✓ icon${size}.png`)
}
