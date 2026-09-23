// docs/verify.mjs — numeric verification for shipped SVGs (replaces visual
// inspection when image reading is unavailable).
//
// Checks, per figure:
//   1. every centered <text> line fits its container: real resvg text width
//      (not the 0.55 estimate) vs [box_left+12, box_right-12];
//   2. every arrowhead tip lands exactly on a rect edge midpoint
//      (side-edge center or top/bottom-edge center) — the resvg
//      rotated-marker class of defect, checked in pixels;
//   3. every shaft line meets its arrowhead base exactly (14px shaft);
//   4. dashed loop paths start/end at rect edge centers;
//   5. all rects/polygons/labels stay inside the canvas;
//   6. no two rects overlap.
//
// Usage: node docs/verify.mjs 01-loop 02-verdict
import { Resvg } from "@resvg/resvg-js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FONT = "'Noto Sans CJK SC','Noto Sans',sans-serif";

function measure(text, size, bold = false) {
	const safe = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="200"><text x="10" y="100" font-family="${FONT}" font-size="${size}"${bold ? ' font-weight="bold"' : ""}>${safe}</text></svg>`;
	const r = new Resvg(svg, { background: "#ffffff", fonts: { loadSystemFonts: true } });
	const bb = r.innerBBox();
	return bb ? bb.width : 0;
}

const reRect = /<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g;
const rePoly = /<polygon points="([\d.,\s]+)"/g;
const reLine = /<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"/g;
const rePath = /<path d="M ([\d., L]+)"/g;
const reText = /<text x="([\d.]+)" y="([\d.]+)"[^>]*font-size="([\d.]+)"([^>]*)>([^<]*)<\/text>/g;

// The arrowhead tip: the vertex that shares neither its y (horizontal arrow)
// nor its x (vertical arrow) with the two base vertices.
function tipOf(p1, p2, p3) {
	if (p1[1] === p2[1]) return p3;
	if (p1[1] === p3[1]) return p2;
	if (p2[1] === p3[1]) return p1;
	if (p1[0] === p2[0]) return p3;
	if (p1[0] === p3[0]) return p2;
	return p1;
}

let failures = 0;
function check(name, ok, detail) {
	if (!ok) {
		failures++;
		console.error(`  FAIL ${name} — ${detail}`);
	}
}

function verify(name) {
	console.log(`\n=== ${name} ===`);
	const svg = readFileSync(join("docs/src", `${name}.svg`), "utf-8");

	// canvas
	const vb = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
	const CW = Number(vb[1]);
	const CH = Number(vb[2]);

	// parse rects (skip the background rect)
	const rects = [...svg.matchAll(reRect)]
		.map((m) => ({ x: +m[1], y: +m[2], w: +m[3], h: +m[4] }))
		.filter((r) => !(r.x === 0 && r.y === 0 && r.w === CW && r.h === CH));

	// canvas bounds for rects
	for (const r of rects) {
		check("rect-in-canvas", r.x >= 0 && r.y >= 0 && r.x + r.w <= CW && r.y + r.h <= CH, JSON.stringify(r));
	}

	// rect overlap
	for (let i = 0; i < rects.length; i++) {
		for (let j = i + 1; j < rects.length; j++) {
			const a = rects[i];
			const b = rects[j];
			const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
			const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
			check("rects-dont-overlap", ox <= 0 || oy <= 0, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
		}
	}

	// polygons: tip must sit on a rect edge midpoint
	const polys = [...svg.matchAll(rePoly)].map((m) => {
		const [x1, y1, x2, y2, x3, y3] = m[1].split(/[\s,]+/).map(Number);
		return [[x1, y1], [x2, y2], [x3, y3]];
	});
	for (const [p1, p2, p3] of polys) {
		const [tx, ty] = tipOf(p1, p2, p3);
		const onEdge = rects.find((r) => {
			const left = tx === r.x && ty === r.y + r.h / 2;
			const right = tx === r.x + r.w && ty === r.y + r.h / 2;
			const top = ty === r.y && tx === r.x + r.w / 2;
			const bottom = ty === r.y + r.h && tx === r.x + r.w / 2;
			return left || right || top || bottom;
		});
		check("arrow-tip-on-edge-midpoint", !!onEdge, `tip (${tx},${ty})`);
		for (const [px, py] of [p1, p2, p3]) {
			check("arrow-in-canvas", px >= 0 && py >= 0 && px <= CW && py <= CH, `vertex (${px},${py})`);
		}
	}

	// lines: each shaft must meet its polygon base (tip back 14px)
	const lines = [...svg.matchAll(reLine)].map((m) => ({
		x1: +m[1],
		y1: +m[2],
		x2: +m[3],
		y2: +m[4],
	}));
	for (const L of lines) {
		if (L.x1 === L.x2) {
			const dir = L.y2 >= L.y1 ? 1 : -1;
			const baseY = L.y2;
			const found = polys.some(([a, b, c]) => {
				const tips = [a, b, c].filter((p) => Math.abs(p[1] - baseY) > 0.01);
				const bases = [a, b, c].filter((p) => Math.abs(p[1] - baseY) < 0.01);
				return tips.length === 1 && bases.length === 2 &&
					Math.abs(tips[0][0] - L.x1) < 0.01 &&
					Math.abs(tips[0][1] - (baseY + 14 * dir)) < 0.01 &&
					Math.abs(bases[0][0] - bases[1][0]) < 16.01;
			});
			check("vertical-shaft-meets-head", found, JSON.stringify(L));
		} else if (L.y1 === L.y2) {
			const dir = L.x2 >= L.x1 ? 1 : -1;
			const baseX = L.x2;
			const found = polys.some(([a, b, c]) => {
				const tips = [a, b, c].filter((p) => Math.abs(p[0] - baseX) > 0.01);
				const bases = [a, b, c].filter((p) => Math.abs(p[0] - baseX) < 0.01);
				return tips.length === 1 && bases.length === 2 &&
					Math.abs(tips[0][1] - L.y1) < 0.01 &&
					Math.abs(tips[0][0] - (baseX + 14 * dir)) < 0.01 &&
					Math.abs(bases[0][1] - bases[1][1]) < 16.01;
			});
			check("horizontal-shaft-meets-head", found, JSON.stringify(L));
		} else {
			check("shaft-is-axis-aligned", false, JSON.stringify(L));
		}
	}

	// dashed loop paths: endpoints at rect edge centers
	for (const pm of svg.matchAll(rePath)) {
		const coords = pm[1].split(/[\s,]+/).map(Number);
		const start = [coords[0], coords[1]];
		const end = [coords[coords.length - 2], coords[coords.length - 1]];
		for (const [px, py] of [start, end]) {
			const atEdge = rects.some((r) => {
				const top = py === r.y && px === r.x + r.w / 2;
				const bottom = py === r.y + r.h && px === r.x + r.w / 2;
				const left = px === r.x && py === r.y + r.h / 2;
				const right = px === r.x + r.w && py === r.y + r.h / 2;
				return top || bottom || left || right;
			});
			// The path END may be an arrow base: 14px before the edge center,
			// with a polygon tip exactly 14px beyond it on the same axis.
			const atHeadBase = !atEdge && polys.some(([a, b, c]) => {
				const t = tipOf(a, b, c);
				return (
					(Math.abs(t[0] - px) === 14 && t[1] === py || Math.abs(t[1] - py) === 14 && t[0] === px)
					&& rects.some((r) =>
						(t[1] === r.y && t[0] === r.x + r.w / 2) ||
						(t[1] === r.y + r.h && t[0] === r.x + r.w / 2) ||
						(t[0] === r.x && t[1] === r.y + r.h / 2) ||
						(t[0] === r.x + r.w && t[1] === r.y + r.h / 2))
				);
			});
			check("loop-endpoint-on-edge-center", atEdge || atHeadBase, `(${px},${py})`);
		}
	}

	// text: fit inside its container + canvas
	for (const tm of svg.matchAll(reText)) {
		const cx = +tm[1];
		const baseline = +tm[2];
		const size = Number(tm[3]);
		const bold = /font-weight="bold"/.test(tm[4]);
		const content = tm[5];
		const w = measure(content, size, bold);
		const half = w / 2;
		// container = the smallest rect that horizontally contains cx
		const container = rects
			.filter((r) => cx >= r.x && cx <= r.x + r.w && baseline > r.y && baseline <= r.y + r.h + 8)
			.sort((a, b) => (a.w * a.h) - (b.w * b.h))[0];
		if (container) {
			check(
				"text-fits-box",
				cx - half >= container.x + 10 && cx + half <= container.x + container.w - 10 &&
					baseline + 0.3 * size <= container.y + container.h - 4,
				`"${content}" w=${w.toFixed(1)} half=${half.toFixed(1)} box=${JSON.stringify(container)} cx=${cx}`
			);
		} else {
			// free text (titles/subtitles/captions/labels): canvas bounds
			check("free-text-in-canvas", cx - half >= 0 && cx + half <= CW && baseline <= CH - 4, `"${content}" w=${w.toFixed(1)}`);
		}
	}

	// free-text horizontal collisions between labels near arrows:
	// any two texts whose rendered boxes intersect horizontally+vertically
	const texts = [...svg.matchAll(reText)].map((tm) => {
		const size = Number(tm[3]);
		const w = measure(tm[5], size, /font-weight="bold"/.test(tm[4]));
		return { cx: +tm[1], y: +tm[2], w, t: tm[5] };
	});
	for (let i = 0; i < texts.length; i++) {
		for (let j = i + 1; j < texts.length; j++) {
			const a = texts[i];
			const b = texts[j];
			const xOverlap = Math.abs(a.cx - b.cx) < (a.w + b.w) / 2 - 2;
			const yOverlap = Math.abs(a.y - b.y) < 14;
			check("texts-dont-collide", !(xOverlap && yOverlap), `"${a.t}" vs "${b.t}"`);
		}
	}
}

for (const name of process.argv.slice(2)) verify(name);
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
