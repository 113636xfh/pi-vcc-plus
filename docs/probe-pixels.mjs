// docs/probe-pixels.mjs — sample rendered pixel colors at expected element
// centers; guards against elements silently missing from the render.
// Used in place of visual inspection (image reading unavailable):
//   * box fills and the dashed loop / red rail must show their color;
//   * every planned text line must have real ink near its first glyph —
//     a glyph missing from the system font renders as nothing.
// Rendered image is 1px per viewBox unit (no scale), so (x,y) maps directly
// into the RGBA buffer.
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

const cache = new Map();
function image(name) {
	if (!cache.has(name)) {
		const svg = readFileSync(join("docs/src", `${name}.svg`), "utf-8");
		cache.set(name, new Resvg(svg, { background: "#ffffff", fonts: { loadSystemFonts: true } }).render());
	}
	return cache.get(name);
}

function rawPixels(name, x, y, r = 2) {
	const img = image(name);
	const W = img.width;
	const d = img.pixels;
	const px = [];
	for (let dy = -r; dy <= r; dy++) {
		for (let dx = -r; dx <= r; dx++) {
			const i = ((Math.round(y) + dy) * W + Math.round(x) + dx) * 4;
			if (i >= 0 && i + 3 < d.length) px.push([d[i], d[i + 1], d[i + 2]]);
		}
	}
	return px;
}

function sample(name, x, y, r = 2) {
	const px = rawPixels(name, x, y, r);
	const counts = new Map();
	for (const [cr, cg, cb] of px) {
		const key = `${cr},${cg},${cb}`;
		counts.set(key, (counts.get(key) || 0) + 1);
	}
	const modal = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
	const [er, eg, eb] = modal.split(",").map(Number);
	const n = px.filter((p) => Math.abs(p[0] - er) + Math.abs(p[1] - eg) + Math.abs(p[2] - eb) <= 24).length;
	return { modal, coverage: `${n}/${px.length}` };
}

let failed = false;
function expect(name, x, y, hex, label, opts = {}) {
	const solid = opts.solid !== false;
	const s = sample(name, x, y);
	const target = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
	const [mr, mg, mb] = s.modal.split(",").map(Number);
	const colorOk = Math.abs(mr - target[0]) + Math.abs(mg - target[1]) + Math.abs(mb - target[2]) <= 24;
	const [n, total] = s.coverage.split("/").map(Number);
	const solidOk = !solid || n / total >= 0.6;
	const ok = colorOk && solidOk;
	if (!ok) failed = true;
	console.log(`${ok ? "ok  " : "FAIL"} ${label} @(${x},${y}) expect ${hex} got modal ${s.modal} cov ${s.coverage}`);
}

// Text-ink probe: near the first glyph of a centered line there must be a
// clearly dark pixel (text) — a missing glyph leaves only the fill color.
// CJK glyphs have side bearings, so scan a few offsets inside the first glyph
// cell instead of one fixed point; a missing glyph still yields zero ink.
function ink(name, text, cx, baseline, size, bold = false) {
	const w = measure(text, size, bold);
	const base = cx - w / 2;
	const y = Math.round(baseline - size * 0.35);
	const offsets = [Math.max(2, size * 0.15), Math.max(3, size * 0.4), Math.max(4, size * 0.65)];
	let best = 0;
	let where = 0;
	for (const off of offsets) {
		const x = Math.round(base + off);
		const px = rawPixels(name, x, y, 2);
		const dark = px.filter((p) => 765 - (p[0] + p[1] + p[2]) > 150).length;
		if (dark > best) {
			best = dark;
			where = x;
		}
	}
	const ok = best >= 2;
	if (!ok) failed = true;
	console.log(`${ok ? "ok  " : "FAIL"} ink "${text.slice(0, 24)}" @(${where},${y}) dark ${best}/25`);
}

// Per-figure specs: shared geometry (zh/en), language-specific text for ink.
const FLOW_INK = (name, texts) => {
	ink(name, texts.title, 640, 52, 26, true);
	ink(name, texts.b1t, 160, 170, 20, true);
	ink(name, texts.b1s, 160, 198, 15);
	ink(name, texts.b2t, 480, 170, 20, true);
	ink(name, texts.b2s, 480, 198, 15);
	ink(name, texts.b3t, 800, 170, 20, true);
	ink(name, texts.b3s, 800, 198, 15);
	ink(name, texts.b4t, 1120, 170, 20, true);
	ink(name, texts.b4s, 1120, 198, 15);
	ink(name, texts.loop, 640, 330, 15);
};
const REQUEST_INK = (name, texts) => {
	ink(name, texts.title, 640, 52, 26, true);
	ink(name, texts.sub, 640, 86, 15);
	ink(name, texts.gt, 330, 176, 20, true);
	ink(name, texts.gs, 330, 208, 15);
	ink(name, texts.bt, 770, 176, 20, true);
	ink(name, texts.bs, 770, 208, 15);
	ink(name, texts.ot, 1080, 176, 20, true);
	ink(name, texts.os, 1080, 208, 15);
	ink(name, texts.c1, 640, 300, 15);
	ink(name, texts.c2, 640, 328, 15);
	ink(name, texts.c3, 640, 356, 15);
};
const FAIL_INK = (name, texts) => {
	ink(name, texts.title, 640, 52, 26, true);
	ink(name, texts.chip, 480, 150, 20, true);
	ink(name, texts.gate, 480, 216, 20, true);
	ink(name, texts.gateS, 480, 244, 15);
	ink(name, texts.ok, 480, 320, 20, true);
	ink(name, texts.okS, 480, 344, 15);
	ink(name, texts.fail, 980, 220, 20, true);
	ink(name, texts.failS, 980, 244, 15);
	ink(name, texts.caption, 640, 416, 15);
};

const SPECS = {
	"01-flow": {
		fills: [[160, 184, "#f7f9fb"], [480, 184, "#eefaf3"], [800, 184, "#fdeacc"], [1120, 184, "#eef3fb"], [20, 20, "#ffffff"]],
		dash: { y: 300, xs: Array.from({ length: 53 }, (_, i) => 482 + i * 6), hex: "#94a3b8", min: 3 },
		ink: () => FLOW_INK("01-flow", {
			title: "压缩接管全流程", b1t: "VCC 机械草稿", b1s: "本地抽取 · 零模型调用",
			b2t: "组装检查请求", b2s: "前缀复用 + 尾部指令", b3t: "模型打补丁循环",
			b3s: "vcc_patch · vcc_done", b4t: "定稿写入会话", b4s: "摘要 + 尾部原样保留",
			loop: "直到 vcc_done 或护栏触发，再多一轮",
		}),
	},
	"01-flow-en": {
		fills: [[160, 184, "#f7f9fb"], [480, 184, "#eefaf3"], [800, 184, "#fdeacc"], [1120, 184, "#eef3fb"], [20, 20, "#ffffff"]],
		dash: { y: 300, xs: Array.from({ length: 53 }, (_, i) => 482 + i * 6), hex: "#94a3b8", min: 3 },
		ink: () => FLOW_INK("01-flow-en", {
			title: "The compaction takeover flow", b1t: "VCC draft", b1s: "local, zero model calls",
			b2t: "check request", b2s: "prefix reused + tail instruction", b3t: "model patch loop",
			b3s: "vcc_patch · vcc_done", b4t: "write the session", b4s: "summary + verbatim tail",
			loop: "one more round until vcc_done or a guard trips",
		}),
	},
	"02-request": {
		fills: [[330, 190, "#eefaf3"], [770, 190, "#eef3fb"], [1080, 190, "#fdeacc"], [20, 20, "#ffffff"]],
		ink: () => REQUEST_INK("02-request", {
			title: "检查请求的构成",
			sub: "只有橙色段是新内容：绿色与蓝色段服务端已经算过，KV 缓存直接复用",
			gt: "前缀（逐字节复用）", gs: "system + tools + messages（上一次真实请求的原文）",
			bt: "上一轮回复", bs: "服务端已生成并缓存",
			ot: "尾部指令", os: "草稿 + 预算 + 补丁规则",
			c1: "三段拼起来与上一次请求严格连续 → 服务端按前缀命中，不再全量 prefill",
			c2: "请求级参数（chat_template_kwargs / max_tokens）也沿用上一次请求：它们决定模板渲染与缓存键",
			c3: "命中按块对齐（vLLM 16 token / FastLLM 2048 token），不足一块的尾部照常 prefill",
		}),
	},
	"02-request-en": {
		fills: [[330, 190, "#eefaf3"], [770, 190, "#eef3fb"], [1080, 190, "#fdeacc"], [20, 20, "#ffffff"]],
		ink: () => REQUEST_INK("02-request-en", {
			title: "What the check request looks like",
			sub: "only the orange segment is new: the server already computed the green and blue parts",
			gt: "reused prefix", gs: "system + tools + messages (verbatim)",
			bt: "the last reply", bs: "already in the server KV",
			ot: "tail instruction", os: "draft + budget + patch rules",
			c1: "the three segments are a strict continuation of the last request, so the server reuses its KV",
			c2: "request-level parameters (chat_template_kwargs / max_tokens) come from that request too: they drive template rendering and the cache key",
			c3: "reuse is block-aligned (vLLM 16 tok / FastLLM 2048 tok); the tail remainder is prefilled as usual",
		}),
	},
	"03-failclosed": {
		fills: [[390, 136, "#f7f9fb"], [480, 224, "#eefaf3"], [480, 324, "#eefaf3"], [980, 224, "#f7f9fb"], [20, 20, "#ffffff"]],
		red: [[730, 224, "#d64545"]],
		ink: () => FAIL_INK("03-failclosed", {
			title: "失败处理：fail-closed", chip: "草稿就绪", gate: "全部校验通过？",
			gateS: "快照 · 工具 · 补丁 · 预算", ok: "定稿写入会话", okS: "摘要替换切点前的历史",
			fail: "fail-closed", failS: "取消压缩并通知",
			caption: "会话原样保留：未校验的草稿永远不会成为定稿",
		}),
	},
	"03-failclosed-en": {
		fills: [[390, 136, "#f7f9fb"], [480, 224, "#eefaf3"], [480, 324, "#eefaf3"], [980, 224, "#f7f9fb"], [20, 20, "#ffffff"]],
		red: [[730, 224, "#d64545"]],
		ink: () => FAIL_INK("03-failclosed-en", {
			title: "Failure handling: fail-closed", chip: "draft ready", gate: "all checks pass?",
			gateS: "snapshot · tools · patch · budget", ok: "write the session", okS: "summary replaces earlier history",
			fail: "fail-closed", failS: "cancel + notify",
			caption: "the session is untouched; an unchecked draft never becomes the summary",
		}),
	},
};

for (const name of process.argv.slice(2)) {
	const spec = SPECS[name];
	if (!spec) {
		console.error(`no spec for figure "${name}" (available: ${Object.keys(SPECS).join(", ")})`);
		process.exit(1);
	}
	console.log(`\n=== ${name} ===`);
	for (const [x, y, hex] of spec.fills) expect(name, x, y, hex, "fill");
	for (const [x, y, hex] of spec.red ?? []) expect(name, x, y, hex, "red rail", { solid: false });
	if (spec.dash) {
		const [dr, dg, db] = [
		(parseInt(spec.dash.hex.slice(1, 3), 16)),
			(parseInt(spec.dash.hex.slice(3, 5), 16)),
			(parseInt(spec.dash.hex.slice(5, 7), 16)),
		];
		let hits = 0;
		for (const x of spec.dash.xs) {
			const s = sample(name, x, spec.dash.y, 1);
			const [r, g, b] = s.modal.split(",").map(Number);
			if (Math.abs(r - dr) + Math.abs(g - dg) + Math.abs(b - db) <= 24) hits++;
		}
		const ok = hits >= spec.dash.min;
		if (!ok) failed = true;
		console.log(`${ok ? "ok  " : "FAIL"} loop dash presence: ${hits}/${spec.dash.xs.length} (need ${spec.dash.min})`);
	}
	spec.ink();
}
console.log(failed ? "PIXEL PROBE FAILED" : "PIXEL PROBE PASSED");
process.exit(failed ? 1 : 0);
