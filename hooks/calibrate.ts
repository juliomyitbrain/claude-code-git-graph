// TEMPORARY: drawings that show how a surface sizes and stacks an Svg, to set
// the graph's own sizes by. Removed once the sizes are settled.

const STYLE =
  '<style>:root{color-scheme:light dark}.t{fill:#1f2328}.g{stroke:#8c959f}' +
  '@media (prefers-color-scheme:dark){.t{fill:#e6edf3}}</style>'

// A box of `width` by `height` px with a tick every 50 px down and every 100
// px across, each labelled with its own px, and a bar down its left edge that
// meets the bar of a box stacked on it.
export const ruler = (width: number, height: number, name: string): string => {
  const marks: string[] = []

  for (let y = 50; y < height; y += 50) {
    marks.push(
      `<path class="g" d="M0 ${y}H${width}" stroke="#808080" stroke-width="0.5"/>` +
        `<text x="46" y="${y - 3}" font-size="10" class="t" fill="#808080">y=${y}</text>`,
    )
  }

  for (let x = 100; x < width; x += 100) {
    marks.push(
      `<path class="g" d="M${x} 0V${height}" stroke="#808080" stroke-width="0.5"/>` +
        `<text x="${x + 3}" y="11" font-size="10" class="t" fill="#808080">x=${x}</text>`,
    )
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" ` +
    `font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif" font-size="12">` +
    STYLE +
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="none" stroke="#808080"/>` +
    `<path d="M20 0V${height}" stroke="#3b82f6" stroke-width="2"/>` +
    marks.join('') +
    `<text x="46" y="${Math.min(height - 8, 30)}" class="t" fill="#808080" font-weight="600">${name}: drawn ${width} x ${height}, text at 12 px</text>` +
    '</svg>'
  )
}
