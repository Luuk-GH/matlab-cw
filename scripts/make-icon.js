// media/icon.png is this SVG rendered at 256 px (e.g. with @resvg/resvg-js, not a dependency of this project).
// Generates media/icon.svg: an original "surface plot" (MATLAB-style orange peaks) with a small LP record.
// Deliberately not the MathWorks membrane logo. Usage: node scripts/make-icon.js media/icon.svg
const fs = require('fs');
const out = process.argv[2];

const g = (x, z, cx, cz, sx, sz) => Math.exp(-((x - cx) ** 2 / sx + (z - cz) ** 2 / sz));
const f = (x, z) => 1.0 * g(x, z, 0.33, 0.55, 0.018, 0.07)
  + 0.55 * g(x, z, 0.68, 0.42, 0.014, 0.05)
  - 0.22 * g(x, z, 0.52, 0.75, 0.012, 0.05);
// Oblique projection: x to the right, depth z up-right, height up.
const P = (x, z, h) => [12 + x * 82 + z * 20, 100 - z * 34 - h * 52];

// A shaded mesh surface (like surf(peaks)): quads drawn back to front, coloured by height, lit from the upper left.
const NX = 26, NZ = 16;
const H = (i, j) => f(i / NX, j / NZ);
const colormap = t => {   // dark red -> orange -> yellow
  const stops = [[0, [122, 20, 6]], [0.3, [214, 64, 12]], [0.6, [255, 140, 26]], [1, [255, 226, 122]]];
  t = Math.max(0, Math.min(1, t));
  let k = 0; while (k < stops.length - 2 && t > stops[k + 1][0]) { k++; }
  const [t0, c0] = stops[k], [t1, c1] = stops[k + 1];
  const u = (t - t0) / (t1 - t0);
  return c0.map((c, n) => c + (c1[n] - c) * u);
};
const slices = [];
for (let j = NZ - 1; j >= 0; j--) {            // back to front
  for (let i = 0; i < NX; i++) {
    const h = [H(i, j), H(i + 1, j), H(i + 1, j + 1), H(i, j + 1)];
    const quad = [P(i / NX, j / NZ, h[0]), P((i + 1) / NX, j / NZ, h[1]), P((i + 1) / NX, (j + 1) / NZ, h[2]), P(i / NX, (j + 1) / NZ, h[3])];
    const mean = (h[0] + h[1] + h[2] + h[3]) / 4;
    const slopeX = (h[1] + h[2] - h[0] - h[3]) / 2, slopeZ = (h[2] + h[3] - h[0] - h[1]) / 2;
    const light = Math.max(0.55, Math.min(1.25, 1 - slopeX * 2.2 + slopeZ * 1.2));
    const [r, gg, b] = colormap(0.12 + mean * 0.95).map(c => Math.round(Math.min(255, c * light)));
    const pts = quad.map(([a, c]) => `${a.toFixed(1)},${c.toFixed(1)}`).join(' ');
    slices.push(`<polygon points="${pts}" fill="rgb(${r},${gg},${b})" stroke="#5a1404" stroke-opacity="0.35" stroke-width="0.35"/>`);
  }
}

const cx = 99, cy = 99, R = 21;
const grooves = [19, 16.8, 14.6, 12.4, 10.4].map(r =>
  `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#3a3f47" stroke-width="0.7"/>`).join('');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1b4a72"/><stop offset="1" stop-color="#0b2239"/>
    </linearGradient>
    <linearGradient id="heat" gradientUnits="userSpaceOnUse" x1="0" y1="18" x2="0" y2="104">
      <stop offset="0" stop-color="#ffe27a"/><stop offset="0.35" stop-color="#ff9a1f"/>
      <stop offset="0.7" stop-color="#e2470f"/><stop offset="1" stop-color="#8f1a06"/>
    </linearGradient>
    <radialGradient id="vinyl" cx="0.38" cy="0.32" r="0.8">
      <stop offset="0" stop-color="#2b3037"/><stop offset="1" stop-color="#0c0e11"/>
    </radialGradient>
  </defs>
  <rect x="2" y="2" width="124" height="124" rx="24" fill="url(#bg)"/>
  ${slices.join('\n  ')}
  <circle cx="${cx}" cy="${cy}" r="${R + 2.5}" fill="#0b2239"/>
  <circle cx="${cx}" cy="${cy}" r="${R}" fill="url(#vinyl)"/>
  ${grooves}
  <path d="M ${cx - 14.5} ${cy - 8.5} A 17 17 0 0 1 ${cx - 5} ${cy - 16}" fill="none" stroke="#ffffff" stroke-opacity="0.35" stroke-width="1.6" stroke-linecap="round"/>
  <circle cx="${cx}" cy="${cy}" r="7.2" fill="#ff8c1a"/>
  <circle cx="${cx}" cy="${cy}" r="7.2" fill="none" stroke="#c2410c" stroke-width="0.8"/>
  <circle cx="${cx}" cy="${cy}" r="1.8" fill="#0b2239"/>
</svg>
`;
fs.writeFileSync(out, svg);
console.log('wrote', out);
