// Generate the extension icons: a bold white "P" on a dark rounded square,
// with a mint accent bar. Run once after changing the design; the PNGs are
// copied into extension-slim/ by scripts/build-slim.mjs.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { chromium } from 'playwright';

const SIZES = [16, 32, 48, 128];
const target = path.resolve('ui/icon');

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><body></body></html>');
  const icons = await page.evaluate((sizes) => {
    const out = {};
    for (const size of sizes) {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const g = canvas.getContext('2d');

      const radius = size * 0.24;
      g.beginPath();
      g.moveTo(radius, 0);
      g.lineTo(size - radius, 0);
      g.quadraticCurveTo(size, 0, size, radius);
      g.lineTo(size, size - radius);
      g.quadraticCurveTo(size, size, size - radius, size);
      g.lineTo(radius, size);
      g.quadraticCurveTo(0, size, 0, size - radius);
      g.lineTo(0, radius);
      g.quadraticCurveTo(0, 0, radius, 0);
      g.closePath();

      const fill = g.createLinearGradient(0, 0, size, size);
      fill.addColorStop(0, '#111827');
      fill.addColorStop(1, '#134e4a');
      g.fillStyle = fill;
      g.fill();

      g.fillStyle = '#f9fafb';
      g.font = `800 ${Math.round(size * 0.64)}px "Segoe UI", Arial, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('P', size / 2, size * 0.51);

      g.fillStyle = '#34d399';
      const barHeight = Math.max(1, Math.round(size * 0.055));
      g.fillRect(size * 0.3, size * 0.79, size * 0.4, barHeight);

      out[size] = canvas.toDataURL('image/png');
    }
    return out;
  }, SIZES);

  await mkdir(target, { recursive: true });
  for (const size of SIZES) {
    const base64 = icons[size].replace(/^data:image\/png;base64,/, '');
    await writeFile(path.join(target, `${size}.png`), Buffer.from(base64, 'base64'));
  }
  console.log(`icons: ${SIZES.map((size) => `${size}.png`).join(', ')} -> ${target}`);
} finally {
  await browser.close();
}
