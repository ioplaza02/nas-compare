// =====================================================================
// NAS 他社比較ツール（社内営業用）
//  ① I-O DATA商品一覧
//  ② I-O DATAの型番 → 他社（現在はバッファロー）の近い機種
//  ③ 他社の型番 → I-O DATAの候補
// =====================================================================

// I-O DATAのデータは、既存のNASセレクター（毎日自動更新）のものをそのまま読み込む。
// 同じ ioplaza02.github.io 上にあるので追加の設定は不要。
// 読めなかった場合（ローカル確認時など）は、同梱のコピーを使う。
const IO_DATA_URLS = ["../nas-selector/data/products.json", "data/iodata-products.json"];

// 他社メーカーの定義。ready:false のメーカーは「準備中」として選べないようにしておく。
const MAKERS = [
  { id: "buffalo", label: "バッファロー", dataUrl: "data/buffalo-products.json", ready: true },
  { id: "synology", label: "Synology", dataUrl: null, ready: false },
  { id: "qnap", label: "QNAP", dataUrl: null, ready: false },
];

const STALE_DAYS = 40;
const state = { io: [], others: {}, updated: {} };

// ---------------------------------------------------------------------
// 小さな道具
// ---------------------------------------------------------------------
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
// 全角→半角、記号・空白を除いて大文字に（型番の表記ゆれ吸収用）
function normKey(str) {
  return String(str ?? "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}
function fmtTB(tb) {
  if (tb == null) return "—";
  return tb < 1 ? `${Math.round(tb * 1000)}GB` : `${tb}TB`;
}
function capRange(p) {
  const caps = p.variants.map(v => v.capacityTB).filter(v => v != null);
  if (!caps.length) return "—";
  const min = Math.min(...caps), max = Math.max(...caps);
  return min === max ? fmtTB(min) : `${fmtTB(min)}〜${fmtTB(max)}`;
}
const LAN_RANK = { "1G": 1, "2.5G": 2, "5G": 3, "10G": 4, "25G": 5 };
function lanLabel(p) {
  if (!p.lanSpeedMax) return "—";
  const speed = p.lanSpeedMax.replace("G", "GbE");
  return p.lanMaxPorts ? `${speed} ×${p.lanMaxPorts}` : speed;
}
function osLabel(p) {
  if (p.osType === "Windows") return `Windows系（${p.windowsEdition || "エディション不明"}）`;
  return "独自OS（Linux系）";
}
function makerLabel(p) { return p.maker === "I-O DATA" ? "I-O DATA" : (MAKERS.find(m => m.id === p.makerId)?.label || p.maker); }
function daysSince(iso) { return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000); }

// ---------------------------------------------------------------------
// データの読み込みと「比較しやすい形」への変換
// ---------------------------------------------------------------------
async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

function editionOf(text) {
  if (/Standard/i.test(text || "")) return "Standard";
  if (/Workgroup/i.test(text || "")) return "Workgroup";
  return null;
}

function normalizeIO(p) {
  const sd = p.specDetails || {};
  const isWin = /Windows/.test(p.os || "");
  const mem = sd.memoryCapacity && /\d\s*[GM]B/.test(sd.memoryCapacity) ? sd.memoryCapacity : null;
  return {
    maker: "I-O DATA", makerId: "iodata",
    id: p.id,
    code: p.id.toUpperCase(),
    name: p.name,
    series: p.series,
    osType: isWin ? "Windows" : "Linux",
    osEdition: sd.osEdition || p.os,
    windowsEdition: isWin ? editionOf(sd.osEdition) : null,
    install: p.install,
    bays: p.bay ? parseInt(p.bay, 10) : null,
    cpu: sd.cpu || null,
    memory: mem,
    lanText: sd.lanPort ? sd.lanPort.replace(/&times;/g, "×") : null,
    lanSpeedMax: p.lanSpeedMax || null,
    lanMaxPorts: p.lanMaxPorts || null,
    raidModes: p.raidSupport || [],
    warrantyYears: p.warrantyYears ?? null,
    officeSize: p.officeSize || null,
    featureList: p.features || [],
    variants: (p.variants || []).map(v => ({ sku: v.sku, capacityTB: v.capacityTB, status: v.status, url: p.sourceUrl })),
    status: p.status,
    imageUrl: p.imageUrl,
    sourceUrl: p.sourceUrl,
  };
}

function normalizeOther(p, makerId) {
  return { ...p, makerId, code: p.series };
}

async function loadData() {
  let ioJson = null;
  for (const url of IO_DATA_URLS) {
    try { ioJson = await fetchJson(url); break; } catch (e) { console.warn("I-O DATAデータ読み込み失敗:", e.message); }
  }
  if (!ioJson) throw new Error("I-O DATAの商品データを読み込めませんでした");
  state.io = ioJson.products.map(normalizeIO);
  state.updated.iodata = ioJson.updatedAt;

  for (const m of MAKERS.filter(m => m.ready)) {
    const json = await fetchJson(m.dataUrl);
    state.others[m.id] = json.products.map(p => normalizeOther(p, m.id));
    state.updated[m.id] = json.updatedAt;
  }
}

function renderUpdatedAt() {
  const parts = [];
  const fmt = iso => {
    const d = new Date(iso);
    const s = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
    return daysSince(iso) >= STALE_DAYS ? `<span class="warn">${s}（${daysSince(iso)}日更新なし・要確認）</span>` : s;
  };
  if (state.updated.iodata) parts.push(`I-O DATA：${fmt(state.updated.iodata)}`);
  for (const m of MAKERS.filter(m => m.ready && state.updated[m.id])) parts.push(`${m.label}：${fmt(state.updated[m.id])}`);
  document.getElementById("updated-at").innerHTML = "データ最終更新　" + parts.join("　／　");
}

// ---------------------------------------------------------------------
// 似ている度合い（一致度）の計算
//   OSの系統 30 / Windowsのエディション 5 / ベイ数 25 / 設置形態 15
//   LAN速度 15 / 容量 10 / 販売状況 5   … 合計105点を100点満点に換算
// ---------------------------------------------------------------------
function scorePair(src, cand, capTB) {
  let s = 0;
  if (src.osType === cand.osType) {
    s += 30;
    if (src.osType === "Linux" || (src.windowsEdition && src.windowsEdition === cand.windowsEdition)) s += 5;
  }
  if (src.bays && cand.bays) {
    const d = Math.abs(src.bays - cand.bays);
    s += 25 * Math.max(0, 1 - d / 4);
  }
  if (src.install && src.install === cand.install) s += 15;
  const r1 = LAN_RANK[src.lanSpeedMax], r2 = LAN_RANK[cand.lanSpeedMax];
  if (r1 && r2) s += r1 === r2 ? 15 : Math.abs(r1 - r2) === 1 ? 8 : 0;

  const caps = cand.variants.map(v => v.capacityTB).filter(c => c != null);
  if (caps.length) {
    if (capTB != null) {
      const nearest = caps.reduce((a, b) => Math.abs(b - capTB) < Math.abs(a - capTB) ? b : a);
      const ratio = Math.min(nearest, capTB) / Math.max(nearest, capTB);
      s += 10 * ratio;
    } else {
      const srcCaps = src.variants.map(v => v.capacityTB).filter(c => c != null);
      if (srcCaps.length) {
        const lo = Math.max(Math.min(...srcCaps), Math.min(...caps));
        const hi = Math.min(Math.max(...srcCaps), Math.max(...caps));
        s += hi >= lo ? 10 : 3;
      }
    }
  }
  if (cand.status === "現行") s += 5;
  return Math.round((s / 105) * 100);
}

function nearestVariant(p, capTB) {
  if (capTB == null || !p.variants.length) return null;
  return p.variants.reduce((a, b) => Math.abs(b.capacityTB - capTB) < Math.abs(a.capacityTB - capTB) ? b : a);
}

// ---------------------------------------------------------------------
// 機能の対応状況を、両社で同じ物差しにそろえる
//   true=対応 / false=非対応 / null=データ上の記載なし（不明）
// ---------------------------------------------------------------------
const FEATURE_ROWS = [
  {
    label: "リモート監視サービス",
    get: p => p.maker === "I-O DATA"
      ? (p.featureList.includes("NarSuS") ? { v: true, t: "NarSuS" } : { v: null })
      : featOther(p, "リモート監視（キキNavi）", "キキNavi"),
  },
  {
    label: "クラウドストレージ連携",
    get: p => p.maker === "I-O DATA"
      ? (p.featureList.includes("クラウドストレージ連携") ? { v: true, t: "対応" } : { v: null })
      : featOther(p, "クラウドストレージ連携", "対応"),
  },
  {
    label: "Time Machine（Mac）",
    get: p => p.maker === "I-O DATA"
      ? (p.featureList.includes("Time Machine") ? { v: true, t: "対応" } : { v: null })
      : featOther(p, "Time Machine", "対応"),
  },
];
function featOther(p, key, okText) {
  const f = p.features?.[key];
  if (!f) return { v: null };
  if (f.supported === true) return { v: true, t: okText };
  if (f.supported === false) return { v: false, t: "非対応" };
  return { v: null, t: f.value };
}
function featText(r) {
  if (r.v === true) return esc(r.t || "対応");
  if (r.v === false) return esc(r.t || "非対応");
  return `<span class="muted">${esc(r.t || "記載なし")}</span>`;
}
// 一覧表で比較に使わなかった「その他の特徴」
const IO_MAPPED = new Set(["NarSuS", "クラウドストレージ連携", "Time Machine", "10GbE"]);
const OTHER_MAPPED = new Set(["リモート監視（キキNavi）", "クラウドストレージ連携", "Time Machine"]);
function extraFeatures(p) {
  if (p.maker === "I-O DATA") return p.featureList.filter(f => !IO_MAPPED.has(f));
  return Object.entries(p.features || {})
    .filter(([k, f]) => f.supported === true && !OTHER_MAPPED.has(k))
    .map(([k]) => k);
}

// ---------------------------------------------------------------------
// 解説文（テンプレート方式）
//   事実（スペックの差）だけから文章を組み立てるので、内容がずれない
// ---------------------------------------------------------------------
function explain(src, cand, capTB) {
  const A = makerLabel(src), B = makerLabel(cand);
  const same = [], diff = [], memo = [];

  // OS
  if (src.osType === cand.osType) {
    if (src.osType === "Windows") {
      if (src.windowsEdition && src.windowsEdition === cand.windowsEdition) same.push(`OSが同じ（Windows Server IoT ${src.windowsEdition}）`);
      else { same.push("どちらもWindows系のOS"); diff.push(`Windowsのエディションが異なる（${A}：${src.windowsEdition || "不明"}／${B}：${cand.windowsEdition || "不明"}）`); }
    } else same.push("どちらも独自OS（Linux系）");
  } else {
    diff.push(`OSの系統が異なる（${A}：${osLabel(src)}／${B}：${osLabel(cand)}）`);
    memo.push("Windows系か独自OS系かで、管理画面や運用方法が変わります。お客様の現在の運用（Active Directoryの有無など）を確認しておくと安心です。");
  }
  // ベイ・設置
  if (src.bays && cand.bays) {
    if (src.bays === cand.bays) same.push(`ベイ数が同じ（${src.bays}ベイ）`);
    else diff.push(`ベイ数が異なる（${A}：${src.bays}ベイ／${B}：${cand.bays}ベイ）`);
  }
  if (src.install === cand.install) same.push(`設置形態が同じ（${src.install}）`);
  else diff.push(`設置形態が異なる（${A}：${src.install}／${B}：${cand.install}）`);
  // LAN
  const r1 = LAN_RANK[src.lanSpeedMax], r2 = LAN_RANK[cand.lanSpeedMax];
  if (r1 && r2) {
    if (r1 === r2) {
      if (src.lanMaxPorts && cand.lanMaxPorts && src.lanMaxPorts !== cand.lanMaxPorts)
        diff.push(`最大速度は同じ${lanLabel(src).split(" ")[0]}だが、ポート数が異なる（${A}：${src.lanMaxPorts}ポート／${B}：${cand.lanMaxPorts}ポート）`);
      else same.push(`LANの最大速度が同じ（${lanLabel(src)}）`);
    } else {
      diff.push(`LANの最大速度が異なる（${A}：${lanLabel(src)}／${B}：${lanLabel(cand)}）`);
    }
  }
  // 容量
  if (capTB != null) {
    const hit = cand.variants.find(v => v.capacityTB === capTB);
    if (hit) same.push(`同じ${fmtTB(capTB)}の型番がある（${hit.sku}）`);
    else {
      const nv = nearestVariant(cand, capTB);
      if (nv) diff.push(`${fmtTB(capTB)}の型番はなし。近いのは ${nv.sku}（${fmtTB(nv.capacityTB)}）`);
    }
  }
  const capS = src.variants.map(v => v.capacityTB), capC = cand.variants.map(v => v.capacityTB);
  if (capS.length && capC.length) {
    const maxS = Math.max(...capS), maxC = Math.max(...capC);
    if (maxS !== maxC) diff.push(`容量ラインナップの上限が異なる（${A}：最大${fmtTB(maxS)}／${B}：最大${fmtTB(maxC)}）`);
  }
  // RAID
  const rs = new Set(src.raidModes), rc = new Set(cand.raidModes);
  const onlyS = [...rs].filter(x => !rc.has(x)), onlyC = [...rc].filter(x => !rs.has(x));
  if (rs.size && rc.size) {
    if (!onlyS.length && !onlyC.length) same.push(`対応RAIDが同じ（${[...rs].join("・")}）`);
    else {
      if (onlyS.length) diff.push(`${A}のみ記載のRAID：${onlyS.join("・")}`);
      if (onlyC.length) diff.push(`${B}のみ記載のRAID：${onlyC.join("・")}`);
    }
  }
  if (src.raidModes.includes("RAIDeX") || cand.raidModes.includes("RAIDeX"))
    memo.push("RAIDeXはI-O DATA独自のRAID方式です。");
  if (cand.raidType === "ハードウェアRAID" || src.raidType === "ハードウェアRAID")
    memo.push(`${src.raidType === "ハードウェアRAID" ? A : B}の機種はハードウェアRAID搭載です（仕様表記載）。`);
  // 保証
  if (src.warrantyYears && cand.warrantyYears) {
    if (src.warrantyYears === cand.warrantyYears) same.push(`保証期間が同じ（${src.warrantyYears}年）`);
    else {
      diff.push(`保証期間が異なる（${A}：${src.warrantyYears}年／${B}：${cand.warrantyYears}年）`);
      const longer = src.warrantyYears > cand.warrantyYears ? A : B;
      memo.push(`保証期間は${longer}の方が長い設定です。保証の範囲（本体のみ／HDD含む）も出典ページで確認してください。`);
    }
  }
  // 冗長電源
  if (cand.redundantPower === true) memo.push(`${B}の機種は冗長電源（リダンダント電源）搭載です。`);
  if (src.redundantPower === true) memo.push(`${A}の機種は冗長電源（リダンダント電源）搭載です。`);
  // 販売状況
  if (cand.status !== "現行") memo.push(`${B}の機種は「${cand.status}」です。後継機の有無を確認してください。`);

  // 要約
  const key = [];
  if (src.osType === cand.osType) key.push("OS系統");
  if (src.bays === cand.bays) key.push("ベイ数");
  if (src.install === cand.install) key.push("設置形態");
  if (r1 && r1 === r2) key.push("LAN速度");
  const summary = key.length
    ? `${key.join("・")}が一致${diff.length ? `。違いは${diff.length}点あります` : "。主な仕様はほぼ同等です"}。`
    : `近い仕様の機種が見つからないため、最も条件の近い機種を表示しています。`;

  return { summary, same, diff, memo };
}

// ---------------------------------------------------------------------
// 比較表と候補カード
// ---------------------------------------------------------------------
function variantsCell(p, capTB) {
  const list = [...p.variants].sort((a, b) => a.capacityTB - b.capacityTB);
  if (!list.length) return "—";
  return list.map(v => {
    const label = `${esc(v.sku)}（${fmtTB(v.capacityTB)}）`;
    return capTB != null && v.capacityTB === capTB ? `<span class="hit">${label}</span>` : label;
  }).join("<br>");
}

function compareTable(src, cand, capTB) {
  const rows = [
    ["OS", osLabel(src), osLabel(cand), src.osType === cand.osType && (src.osType === "Linux" || src.windowsEdition === cand.windowsEdition)],
    ["搭載OS（詳細）", esc(src.osEdition || "—"), esc(cand.osEdition || "—"), null],
    ["設置形態", esc(src.install), esc(cand.install), src.install === cand.install],
    ["ベイ数", src.bays ? `${src.bays}ベイ` : "—", cand.bays ? `${cand.bays}ベイ` : "—", src.bays === cand.bays],
    ["容量ラインナップ", variantsCell(src, capTB), variantsCell(cand, capTB), null],
    ["LAN（最大速度）", lanLabel(src), lanLabel(cand), src.lanSpeedMax === cand.lanSpeedMax && src.lanMaxPorts === cand.lanMaxPorts],
    ["LAN（詳細）", esc(src.lanText || "—"), esc(cand.lanText || "—"), null],
    ["CPU", esc(src.cpu || "—"), esc(cand.cpu || "—"), null],
    ["メモリー", esc(src.memory || "—"), esc(cand.memory || "—"), null],
    ["対応RAID", esc(src.raidModes.join("・") || "—"), esc(cand.raidModes.join("・") || "—"), src.raidModes.slice().sort().join() === cand.raidModes.slice().sort().join()],
    ["保証期間", src.warrantyYears ? `${src.warrantyYears}年` : "—", cand.warrantyYears ? `${cand.warrantyYears}年` : "—", src.warrantyYears === cand.warrantyYears],
  ];
  for (const f of FEATURE_ROWS) {
    const a = f.get(src), b = f.get(cand);
    rows.push([f.label, featText(a), featText(b), a.v === b.v]);
  }
  const ex = [extraFeatures(src), extraFeatures(cand)];
  rows.push(["その他の特徴<br><small>（データ上確認できたもの）</small>", esc(ex[0].join("、") || "—"), esc(ex[1].join("、") || "—"), null]);
  rows.push(["販売状況", esc(src.status), esc(cand.status) + (cand.statusNote ? `<br><small class="muted">${esc(cand.statusNote)}</small>` : ""), null]);
  rows.push(["出典", src.sourceUrl ? `<a href="${esc(src.sourceUrl)}" target="_blank" rel="noopener">公式ページ</a>` : "—",
    cand.sourceUrl ? `<a href="${esc(cand.sourceUrl)}" target="_blank" rel="noopener">公式ページ</a>` : "—", null]);

  const cls = p => p.maker === "I-O DATA" ? "io" : "bf";
  return `<div class="cmp-wrap"><table class="cmp">
    <thead><tr><th></th>
      <th class="${cls(src)}">${esc(makerLabel(src))}：${esc(src.name)}</th>
      <th class="${cls(cand)}">${esc(makerLabel(cand))}：${esc(cand.name)}</th></tr></thead>
    <tbody>${rows.map(([k, a, b, same]) =>
      `<tr class="${same === false ? "is-diff" : ""}"><th>${k}</th><td>${a}</td><td>${b}</td></tr>`).join("")}</tbody>
  </table></div>`;
}

function candidateCard(src, cand, rank, capTB) {
  const score = scorePair(src, cand, capTB);
  const ex = explain(src, cand, capTB);
  const nv = nearestVariant(cand, capTB);
  const list = (items, empty) => items.length ? `<ul>${items.map(t => `<li>${esc(t)}</li>`).join("")}</ul>` : `<p class="muted" style="font-size:13px;margin:0">${empty}</p>`;
  return `<article class="cand">
    <div class="cand__head">
      <span class="cand__rank">${rank}</span>
      <div>
        <p class="cand__name">${esc(makerLabel(cand))}　${esc(cand.name)}</p>
        <span class="cand__sku">${nv ? `近い容量の型番：<strong>${esc(nv.sku)}</strong>（${fmtTB(nv.capacityTB)}）` : `容量：${capRange(cand)}`}</span>
      </div>
      <div class="score">
        <div class="score__label">一致度 ${score}%</div>
        <div class="score__bar"><div class="score__fill" style="width:${score}%"></div></div>
      </div>
    </div>
    <p class="cand__summary">${esc(ex.summary)}</p>
    ${compareTable(src, cand, capTB)}
    <div class="explain">
      <div class="explain__box explain__box--same"><h4>✓ 共通点</h4>${list(ex.same, "特になし")}</div>
      <div class="explain__box explain__box--diff"><h4>△ 違い</h4>${list(ex.diff, "主な仕様に違いはありません")}</div>
      <div class="explain__box explain__box--memo"><h4>💡 営業メモ</h4>${list(ex.memo, "特記事項なし")}</div>
    </div>
  </article>`;
}

function rankCandidates(src, pool, capTB, n) {
  return pool
    .map(c => ({ c, s: scorePair(src, c, capTB) }))
    .sort((a, b) => b.s - a.s || (a.c.status === "現行" ? -1 : 1))
    .slice(0, n)
    .map(x => x.c);
}

// ---------------------------------------------------------------------
// 型番の解決（入力文字列 → 商品＋容量）
// ---------------------------------------------------------------------
function resolve(input, products) {
  const key = normKey(input);
  if (!key) return { error: "型番を入力してください" };
  // 1) 容量違いの型番（SKU）に完全一致
  for (const p of products) for (const v of p.variants)
    if (normKey(v.sku) === key) return { product: p, variant: v };
  // 2) シリーズに完全一致
  const bySeries = products.filter(p => normKey(p.code) === key || normKey(p.id) === key);
  if (bySeries.length) return { product: bySeries[0], variant: null, alternatives: bySeries.slice(1) };
  // 3) 入力がシリーズ名から始まる（例：TS5420DN08 のような途中まで）／シリーズ名が入力から始まる
  const prefix = products
    .filter(p => key.startsWith(normKey(p.code)) || normKey(p.code).startsWith(key))
    .sort((a, b) => normKey(b.code).length - normKey(a.code).length);
  if (prefix.length === 1) return { product: prefix[0], variant: null };
  // 4) 見つからない → 似ている型番を提案
  const scored = [];
  for (const p of products) {
    const cands = [p.code, ...p.variants.map(v => v.sku)];
    let best = 0, bestLabel = p.code;
    for (const c of cands) {
      const s = similarity(key, normKey(c));
      if (s > best) { best = s; bestLabel = c; }
    }
    scored.push({ label: bestLabel, s: best });
  }
  const suggestions = [...new Map(scored.sort((a, b) => b.s - a.s).map(x => [x.label, x])).values()].slice(0, 6).map(x => x.label);
  if (prefix.length > 1) return { error: "複数のシリーズが該当します。どれか選んでください。", suggestions: prefix.map(p => p.code).slice(0, 8) };
  return { error: "登録データに一致する型番が見つかりませんでした。似ている型番：", suggestions };
}
function similarity(a, b) {
  // 先頭からの一致を重視しつつ、レーベンシュタイン距離で補正
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  const dist = dp[a.length][b.length];
  return pre * 2 + Math.max(0, 10 - dist);
}

function showError(el, res, inputEl, runFn) {
  el.hidden = false;
  el.innerHTML = esc(res.error) + (res.suggestions?.length
    ? `<br>${res.suggestions.map(s => `<button type="button" data-sugg="${esc(s)}">${esc(s)}</button>`).join("")}` : "");
  el.querySelectorAll("[data-sugg]").forEach(b => b.addEventListener("click", () => {
    inputEl.value = b.dataset.sugg; runFn();
  }));
}

// ---------------------------------------------------------------------
// ① I-O DATA商品一覧
// ---------------------------------------------------------------------
function renderList() {
  const q = normKey(document.getElementById("list-search").value);
  const os = document.getElementById("list-os").value;
  const inst = document.getElementById("list-install").value;
  const showOld = document.getElementById("list-discontinued").checked;
  const items = state.io.filter(p =>
    (showOld || p.status === "現行") &&
    (!os || p.osType === os) &&
    (!inst || p.install === inst) &&
    (!q || normKey(p.code + p.name + p.series + p.variants.map(v => v.sku).join("")).includes(q)));
  document.getElementById("list-count").textContent = `${items.length}件`;
  document.getElementById("list-grid").innerHTML = items.map(p => `
    <div class="io-card">
      ${p.imageUrl ? `<img class="io-card__img" src="${esc(p.imageUrl)}" alt="" loading="lazy">` : ""}
      <p class="io-card__name">${esc(p.name)}</p>
      <div>
        <span class="badge ${p.osType === "Windows" ? "badge--win" : "badge--linux"}">${p.osType === "Windows" ? "Windows" : "独自OS"}</span>
        ${p.status !== "現行" ? `<span class="badge badge--stock">${esc(p.status)}</span>` : ""}
      </div>
      <ul class="io-card__specs">
        <li>${esc(p.install)}／${p.bays ? p.bays + "ベイ" : "—"}</li>
        <li>LAN：${lanLabel(p)}</li>
        <li>容量：${capRange(p)}</li>
        <li>保証：${p.warrantyYears ? p.warrantyYears + "年" : "—"}${p.officeSize ? "／" + esc(p.officeSize) : ""}</li>
      </ul>
      <button type="button" class="io-card__btn" data-compare="${esc(p.id)}">他社の近い機種を探す →</button>
    </div>`).join("") || `<p class="empty">条件に合う商品がありません。</p>`;
  document.querySelectorAll("[data-compare]").forEach(b => b.addEventListener("click", () => {
    const p = state.io.find(x => x.id === b.dataset.compare);
    document.getElementById("io-input").value = p.code;
    switchTab("io2other");
    runIo2Other();
  }));
}

// ---------------------------------------------------------------------
// ② I-O DATA → 他社
// ---------------------------------------------------------------------
function runIo2Other() {
  const inputEl = document.getElementById("io-input");
  const errEl = document.getElementById("io2other-error");
  const out = document.getElementById("io2other-result");
  errEl.hidden = true;
  const res = resolve(inputEl.value, state.io);
  if (res.error) { out.innerHTML = ""; return showError(errEl, res, inputEl, runIo2Other); }
  const makers = [...document.querySelectorAll("#maker-checks input:checked")].map(i => i.value);
  if (!makers.length) { errEl.hidden = false; errEl.textContent = "比べたいメーカーを1つ以上選んでください"; out.innerHTML = ""; return; }
  const includeOld = document.getElementById("io2other-discontinued").checked;
  const src = res.product, capTB = res.variant?.capacityTB ?? null;

  let html = `<div class="source-head">
    <h2>${esc(src.name)}${res.variant ? `　<small>${esc(res.variant.sku)}（${fmtTB(capTB)}）</small>` : ""}</h2>
    <p>${osLabel(src)}／${esc(src.install)}／${src.bays ? src.bays + "ベイ" : "—"}／LAN ${lanLabel(src)}／容量 ${capRange(src)}／保証 ${src.warrantyYears ?? "—"}年</p>
    ${!res.variant ? `<p>※容量まで指定すると（例：${esc(src.variants[0]?.sku || "")}）、同じ容量の型番も探します。</p>` : ""}
  </div>`;
  for (const mid of makers) {
    const m = MAKERS.find(x => x.id === mid);
    const pool = (state.others[mid] || []).filter(p => includeOld || p.status === "現行");
    const top = rankCandidates(src, pool, capTB, 3);
    html += `<section class="maker-section"><h3>${esc(m.label)} の近い機種（上位${top.length}件）</h3>
      ${top.length ? top.map((c, i) => candidateCard(src, c, i + 1, capTB)).join("") : `<p class="empty">候補がありません。</p>`}</section>`;
  }
  out.innerHTML = html;
  out.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------------------------------------------------------------------
// ③ 他社 → I-O DATA
// ---------------------------------------------------------------------
function runOther2Io() {
  const inputEl = document.getElementById("other-input");
  const errEl = document.getElementById("other2io-error");
  const out = document.getElementById("other2io-result");
  errEl.hidden = true;
  const all = Object.values(state.others).flat();
  const res = resolve(inputEl.value, all);
  if (res.error) { out.innerHTML = ""; return showError(errEl, res, inputEl, runOther2Io); }
  const includeOld = document.getElementById("other2io-discontinued").checked;
  const src = res.product, capTB = res.variant?.capacityTB ?? null;
  const pool = state.io.filter(p => includeOld || p.status === "現行");
  const top = rankCandidates(src, pool, capTB, 4);

  out.innerHTML = `<div class="source-head source-head--bf">
      <h2>${esc(makerLabel(src))}　${esc(src.name)}${res.variant ? `　<small>${esc(res.variant.sku)}（${fmtTB(capTB)}）</small>` : ""}</h2>
      <p>${osLabel(src)}／${esc(src.install)}／${src.bays ? src.bays + "ベイ" : "—"}／LAN ${lanLabel(src)}／容量 ${capRange(src)}／保証 ${src.warrantyYears ?? "—"}年
       ／<a href="${esc(src.sourceUrl)}" target="_blank" rel="noopener">出典</a></p>
      ${res.alternatives?.length ? `<p>※同じシリーズ名で別エディションもあります：${res.alternatives.map(a => esc(a.code)).join("、")}</p>` : ""}
    </div>
    <section class="maker-section"><h3>I-O DATA の候補（上位${top.length}件）</h3>
      ${top.map((c, i) => candidateCard(src, c, i + 1, capTB)).join("")}
    </section>`;
  out.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------------------------------------------------------------------
// 画面の組み立て
// ---------------------------------------------------------------------
function switchTab(name) {
  document.querySelectorAll(".tabs__btn").forEach(b => b.classList.toggle("is-active", b.dataset.tab === name));
  for (const t of ["list", "io2other", "other2io"]) document.getElementById("panel-" + t).hidden = t !== name;
}

function setupInputs() {
  // ②の候補リスト（シリーズ＋各容量の型番）
  const ioOpts = [];
  for (const p of state.io) {
    ioOpts.push(`<option value="${esc(p.code)}">${esc(p.name)}</option>`);
    for (const v of p.variants) ioOpts.push(`<option value="${esc(v.sku)}">${esc(p.name)} ${fmtTB(v.capacityTB)}</option>`);
  }
  document.getElementById("io-datalist").innerHTML = ioOpts.join("");

  const otherOpts = [];
  for (const p of Object.values(state.others).flat()) {
    otherOpts.push(`<option value="${esc(p.code)}">${esc(makerLabel(p))} ${esc(p.name)}</option>`);
    for (const v of p.variants) otherOpts.push(`<option value="${esc(v.sku)}">${esc(makerLabel(p))} ${fmtTB(v.capacityTB)}</option>`);
  }
  document.getElementById("other-datalist").innerHTML = otherOpts.join("");

  document.getElementById("maker-checks").innerHTML = MAKERS.map(m => m.ready
    ? `<label class="check"><input type="checkbox" value="${m.id}" checked> ${esc(m.label)}</label>`
    : `<label class="check check--disabled"><input type="checkbox" value="${m.id}" disabled> ${esc(m.label)}（準備中）</label>`).join("");

  document.querySelectorAll(".tabs__btn").forEach(b => b.addEventListener("click", () => switchTab(b.dataset.tab)));
  for (const id of ["list-search", "list-os", "list-install", "list-discontinued"])
    document.getElementById(id).addEventListener("input", renderList);
  document.getElementById("io2other-run").addEventListener("click", runIo2Other);
  document.getElementById("other2io-run").addEventListener("click", runOther2Io);
  document.getElementById("io-input").addEventListener("keydown", e => { if (e.key === "Enter") runIo2Other(); });
  document.getElementById("other-input").addEventListener("keydown", e => { if (e.key === "Enter") runOther2Io(); });
}

async function init() {
  try {
    await loadData();
  } catch (e) {
    document.querySelector(".main").innerHTML = `<p class="empty">データの読み込みに失敗しました：${esc(e.message)}</p>`;
    return;
  }
  renderUpdatedAt();
  setupInputs();
  renderList();
}

// ---------------------------------------------------------------------
// 簡易パスワードゲート（GitHub Pagesは静的配信のため、簡易的な鍵です）
// ---------------------------------------------------------------------
const SITE_PASSWORD = "landisk2026";
const UNLOCK_KEY = "nas-compare-unlocked";

function normalizePassword(str) {
  return str.trim().replace(/[Ａ-Ｚａ-ｚ０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
}
function showApp() {
  document.getElementById("password-gate").hidden = true;
  document.getElementById("app-root").hidden = false;
  init();
}
let alreadyUnlocked = false;
try { alreadyUnlocked = sessionStorage.getItem(UNLOCK_KEY) === "1"; } catch (e) { /* 使えない環境では毎回入力 */ }

if (alreadyUnlocked) {
  showApp();
} else {
  const pw = document.getElementById("password-input");
  const toggle = document.getElementById("password-toggle");
  toggle.addEventListener("click", () => {
    const showing = pw.type === "text";
    pw.type = showing ? "password" : "text";
    toggle.textContent = showing ? "👁" : "🙈";
  });
  document.getElementById("password-form").addEventListener("submit", e => {
    e.preventDefault();
    if (normalizePassword(pw.value) === SITE_PASSWORD) {
      try { sessionStorage.setItem(UNLOCK_KEY, "1"); } catch (err) { /* 表示は続行 */ }
      showApp();
    } else {
      const err = document.getElementById("password-error");
      err.textContent = "パスワードが違います";
      err.hidden = false;
    }
  });
}
