// =====================================================================
// バッファロー法人向けNASの仕様を公式サイトから取得して
// data/buffalo-products.json を更新するスクリプト
//
// 使い方（PowerShell）:  node scripts/scrape-buffalo.mjs
//   調査用に取得したHTMLも保存したい場合:  node scripts/scrape-buffalo.mjs --save-html
//
// 方針（NASセレクターと同じ）
//  ・外部ライブラリなし（Node.js 18以降の fetch のみ）
//  ・1件ずつ、2秒間隔でアクセス。専用User-Agentを名乗る
//  ・取得に失敗した項目は、前回のデータの値をそのまま使う（項目単位で引き継ぎ）
//  ・取れたシリーズ数が前回より大きく減った場合などは、本番ファイルを上書きせず失敗終了する
// =====================================================================
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const BASE = "https://www.buffalo.jp";
const OUT = "data/buffalo-products.json";
const FAILED_OUT = "data/buffalo-products.failed.json";
const UA = "NasSelectorBot/1.0 (internal comparison tool)";
const WAIT_MS = 2000;
const SAVE_HTML = process.argv.includes("--save-html");

// 対応検索の一覧（サーバー側で描画されたHTML）。新しいTeraStationシリーズの発見に使う
const DISCOVERY_URLS = Array.from({ length: 10 }, (_, i) => `${BASE}/taiou/product/search/?type=163&page=${i + 1}`);

const sleep = ms => new Promise(r => setTimeout(r, ms));
let lastFetch = 0;
async function getHtml(url) {
  const wait = lastFetch + WAIT_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastFetch = Date.now();
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "ja" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.text();
}

// ---------------------------------------------------------------------
// HTMLの文字列処理
// ---------------------------------------------------------------------
function decode(s) {
  return s
    .replace(/&nbsp;/g, " ").replace(/&times;/g, "×").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}
function text(html) {
  return decode(html.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

// 仕様表を「項目名 → 値」の配列に変換する。
// 親見出しが rowspan で複数行にまたがる表（例：LAN端子 → 10GBASE-T / 1000BASE-T）にも対応する。
export function parseSpecRows(html) {
  const rows = [];
  const carry = []; // { label, remaining }
  for (const tr of html.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const cells = [...tr.matchAll(/<(th|td)([^>]*)>([\s\S]*?)<\/\1>/gi)].map(m => ({
      tag: m[1].toLowerCase(), rowspan: +(m[2].match(/rowspan="?(\d+)/i)?.[1] || 1), text: text(m[3]),
    }));
    if (!cells.length) continue;
    const ths = cells.filter(c => c.tag === "th");
    const tds = cells.filter(c => c.tag === "td");
    const parents = carry.filter(c => c.remaining > 0).map(c => c.label);
    carry.forEach(c => c.remaining--);
    // 先頭の th が rowspan を持つ場合は、次の行以降にも親見出しとして引き継ぐ
    ths.forEach(th => { if (th.rowspan > 1) carry.push({ label: th.text, remaining: th.rowspan - 1 }); });
    if (!tds.length) continue;
    const key = [...parents, ...ths.map(t => t.text)].filter(Boolean).join(" ");
    rows.push({ key, value: tds.map(t => t.text).join(" ／ ") });
  }
  return rows;
}
const find = (rows, re) => rows.find(r => re.test(r.key))?.value ?? null;
const findAll = (rows, re) => rows.filter(r => re.test(r.key));

// ---------------------------------------------------------------------
// 型番（SKU）の分解： シリーズ名 と 容量
//   TS5420DN0804  → シリーズ TS5420DN,   容量 08TB（末尾2桁はドライブ数）
//   WS5420DN08W5  → シリーズ WS5420DNW5, 容量 08TB（末尾はOSエディション）
//   LS220DN0402B  → シリーズ LS220DNB,   容量 04TB
// ---------------------------------------------------------------------
export function parseSku(sku) {
  const s = sku.toUpperCase();
  let m = s.match(/^(WSH?\d{4}[A-Z]{2})(\d{2,3})([WS]\d)$/);
  if (m) return { sku: s, series: m[1] + m[3], capacityTB: parseInt(m[2], 10) };
  m = s.match(/^((?:TS|LS)\d{3,5}[A-Z]{2})(\d{3,6})([A-Z]?)$/);
  if (m) {
    const capStr = m[2].slice(0, -2);
    const cap = capStr.startsWith("00") ? parseInt(capStr, 10) / 10 : parseInt(capStr, 10);
    return { sku: s, series: m[1] + m[3], capacityTB: cap };
  }
  return null;
}

// ---------------------------------------------------------------------
// 1シリーズ分の取得（印刷用ページは仕様表とラインナップ表が1ページにまとまっている）
// ---------------------------------------------------------------------
const FEATURE_KEYS = [
  ["クラウドストレージ連携", /クラウドストレージ連携/],
  ["Time Machine", /Time\s?Machine/i],
  ["リモート監視（キキNavi）", /キキNavi(?!.*クラウドバックアップ)/],
  ["クラウドバックアップ（キキNavi）", /クラウドバックアップ/],
  ["Active Directory連携", /Active Directory/],
  ["iSCSIターゲット", /^iSCSIターゲット|iSCSIターゲット$/],
  ["スナップショット", /^スナップショット/],
  ["不変スナップショット", /不変スナップショット/],
  ["ドライブ暗号化", /暗号化/],
  ["ホットスワップ", /ホットスワップ/],
  ["ホットスペア", /ホットスペア/],
  ["SSDキャッシュ", /SSDキャッシュ/],
  ["データ重複除去", /重複除去/],
  ["レプリケーション", /レプリケーション/],
  ["フェイルオーバー", /フェイルオーバー/],
  ["Webアクセス", /Webアクセス/],
  ["ウイルスチェック", /ウイルスチェック/],
  ["異常ファイル操作検知", /異常ファイル/],
  ["メタデータ二重化", /メタデータ二重化/],
];
function supported(v) {
  if (!v) return null;
  if (/^(非対応|なし|×|－|-)/.test(v)) return false;
  if (/対応|あり|○/.test(v)) return true;
  return null;
}

// 「6/5/10/0（出荷時はRAID 6）」「RAID 1/0」などの表記からRAIDレベルを取り出す
export function parseRaid(t) {
  const main = t.replace(/[（(][^）)]*[）)]/g, " ");
  const levels = [...main.matchAll(/(?<![\d.])(0|1|5|6|10|50|60)(?![\d.])/g)].map(m => `RAID ${m[1]}`);
  return [...new Set(levels)];
}

function lanFrom(rows) {
  const parts = [];
  for (const r of findAll(rows, /LAN/)) {
    const speed = r.key.match(/(10GBASE-T|10GbE|SFP\+|5GBASE-T|2\.5GBASE-T|1000BASE-T)/)?.[1];
    if (!speed || /なし/.test(r.value)) continue;
    const n = r.value.match(/(\d+)/)?.[1];
    if (n) parts.push(`${speed}×${n}`);
  }
  const textLan = parts.join("、") || null;
  const tiers = [[/10GBASE-T|10GbE|SFP\+/, "10G"], [/(?<![\d.])5GBASE-T/, "5G"], [/2\.5GBASE-T/, "2.5G"], [/1000BASE-T/, "1G"]];
  for (const [re, label] of tiers) {
    const p = parts.find(x => re.test(x));
    if (p) return { lanText: textLan, lanSpeedMax: label, lanMaxPorts: parseInt(p.split("×")[1], 10) };
  }
  return { lanText: textLan, lanSpeedMax: null, lanMaxPorts: null };
}

async function scrapeSeries(seriesId, sampleSku) {
  const url = `${BASE}/product/detail/print/${sampleSku.toLowerCase()}.html`;
  const html = await getHtml(url);
  if (SAVE_HTML) { await mkdir("debug", { recursive: true }); await writeFile(`debug/${sampleSku}.html`, html); }
  const rows = parseSpecRows(html);
  const pageText = text(html);

  const os = find(rows, /搭載OS/);
  const raidText = find(rows, /対応RAID/) || "";
  const baysText = find(rows, /ベイ数|搭載ドライブ数/) || "";
  const warrantyText = find(rows, /保証期間/);

  const features = {};
  for (const [label, re] of FEATURE_KEYS) {
    const r = rows.find(x => re.test(x.key));
    if (r) features[label] = { value: r.value, supported: supported(r.value) };
  }

  // 同じシリーズの容量違い（ラインナップ表のリンク）
  const variants = new Map();
  for (const m of html.matchAll(/\/product\/detail\/(?:print\/)?([a-z0-9_]+)\.html/gi)) {
    const v = parseSku(m[1]);
    if (v && v.series === seriesId && !variants.has(v.sku))
      variants.set(v.sku, { sku: v.sku, capacityTB: v.capacityTB, url: `${BASE}/product/detail/${v.sku.toLowerCase()}.html`, jan: null });
  }
  const self = parseSku(sampleSku);
  if (self && !variants.has(self.sku)) variants.set(self.sku, { sku: self.sku, capacityTB: self.capacityTB, url: `${BASE}/product/detail/${self.sku.toLowerCase()}.html`, jan: null });

  const install = find(rows, /筐体/);
  const cpu = find(rows, /^CPU/);
  const clock = find(rows, /クロック/);
  return {
    osType: os ? (/Windows/.test(os) ? "Windows" : "Linux") : null,
    osEdition: os,
    windowsEdition: /Standard/.test(os || "") ? "Standard" : /Workgroup/.test(os || "") ? "Workgroup" : null,
    install: install ? (/ラック/.test(install) ? "ラックマウントタイプ" : "BOXタイプ") : null,
    bays: parseInt(baysText.match(/(\d+)\s*$/)?.[1] || baysText.match(/(\d+)/)?.[1], 10) || null,
    cpu: cpu ? [cpu, clock].filter(Boolean).join(" ") : null,
    memory: find(rows, /^メモリー|^メモリ/),
    ...lanFrom(rows),
    raidModes: parseRaid(raidText),
    raidType: find(rows, /RAID方式/),
    redundantPower: supported(find(rows, /リダンダント電源|冗長電源/)),
    warrantyYears: parseInt(warrantyText?.match(/(\d+)年/)?.[1], 10) || null,
    warrantyText,
    features,
    releaseDate: pageText.match(/発売時期\s*[:：]\s*(\d{4}年\d{1,2}月)/)?.[1] || null,
    status: /在庫を限定|在庫限り/.test(pageText) ? "在庫限り" : /生産終了|販売終了/.test(pageText) ? "生産終了" : "現行",
    variants: [...variants.values()].sort((a, b) => a.capacityTB - b.capacityTB),
    sourceUrl: `${BASE}/product/detail/${sampleSku.toLowerCase()}.html`,
    _rowCount: rows.length,
  };
}

// ---------------------------------------------------------------------
// メイン
// ---------------------------------------------------------------------
async function main() {
  const prev = JSON.parse(await readFile(OUT, "utf8"));
  const prevById = new Map(prev.products.map(p => [p.series, p]));

  // 1) 取得対象：前回のシリーズ ＋ 一覧ページで新しく見つかったTeraStation
  const targets = new Map(prev.products.map(p => [p.series, p.sourceUrl.match(/([a-z0-9]+)\.html$/)[1].toUpperCase()]));
  for (const url of DISCOVERY_URLS) {
    try {
      const t = text(await getHtml(url));
      const found = [...t.matchAll(/\b(TS\d{4,5}[A-Z]{2}\d{3,6})\b/g)].map(m => parseSku(m[1])).filter(Boolean);
      if (!found.length) break;
      for (const f of found) if (!targets.has(f.series)) { targets.set(f.series, f.sku); console.log(`新しいシリーズを発見: ${f.series}（${f.sku}）`); }
    } catch (e) { console.warn(`一覧ページの取得に失敗（スキップ）: ${e.message}`); break; }
  }

  // 2) 各シリーズを取得
  const products = [];
  const problems = [];
  for (const [series, sku] of targets) {
    const before = prevById.get(series);
    process.stdout.write(`${series} (${sku}) ... `);
    let got;
    try { got = await scrapeSeries(series, sku); }
    catch (e) {
      console.log(`失敗: ${e.message}`);
      if (/HTTP 404/.test(e.message) && before) products.push({ ...before, status: "生産終了", statusNote: "商品ページが見つかりません（404）" });
      else if (before) { products.push(before); problems.push(`${series}: 取得失敗のため前回データを使用`); }
      continue;
    }
    // 取れなかった項目は前回の値を引き継ぐ
    const merged = { ...(before || {}) };
    const fallback = [];
    for (const [k, v] of Object.entries(got)) {
      if (k.startsWith("_")) continue;
      const empty = v == null || (Array.isArray(v) && !v.length) || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length);
      if (empty && before?.[k] != null) fallback.push(k);
      else merged[k] = v;
    }
    // JANは前回データにしかないので、型番が一致するものは引き継ぐ
    if (before) for (const v of merged.variants) v.jan = v.jan || before.variants.find(b => b.sku === v.sku)?.jan || null;
    const family = series.startsWith("LS") ? "LinkStation" : "TeraStation";
    Object.assign(merged, {
      id: series.toLowerCase(), maker: "BUFFALO", series, family,
      name: `${family}（${series}シリーズ）`,
      statusNote: merged.status === "現行" ? null : (merged.statusNote || null),
      collectedBy: "scraper", lastCheckedAt: new Date().toISOString(),
      fallbackFields: fallback,
    });
    products.push(merged);
    console.log(`OK（仕様表 ${got._rowCount}行${fallback.length ? `、前回値を使用: ${fallback.join(",")}` : ""}）`);
    if (got._rowCount < 10) problems.push(`${series}: 仕様表がほとんど読めていません（${got._rowCount}行）`);
  }

  // 3) 健全性チェック
  const ok = products.filter(p => p.collectedBy === "scraper" && p.osType && p.bays && p.fallbackFields.length <= 3).length;
  const healthy = products.length >= prev.products.length * 0.9 && ok >= products.length * 0.8;
  const out = { updatedAt: new Date().toISOString(), source: prev.source, products };
  if (!healthy) {
    await writeFile(FAILED_OUT, JSON.stringify(out, null, 1));
    console.error(`\n健全性チェックNG：正常に読めたシリーズ ${ok}/${products.length}件（前回 ${prev.products.length}件）`);
    console.error(`本番ファイルは更新していません。結果は ${FAILED_OUT} に保存しました。`);
    problems.forEach(p => console.error(" - " + p));
    process.exit(1);
  }
  await writeFile(OUT, JSON.stringify(out, null, 1));
  console.log(`\n完了：${products.length}シリーズを ${OUT} に保存しました（正常 ${ok}件）`);
  problems.forEach(p => console.warn(" - " + p));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
