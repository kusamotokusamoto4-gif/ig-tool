/**
 * kusamoto.co.jp の物件ページから
 *   1) 画像URL一覧
 *   2) 物件情報（表データ）
 *   3) Instagram用の箇条書きキャプション
 * を抽出するモジュール。
 *
 * 使い方:
 *   node extract-property.js 2-0135
 *
 * 必要パッケージ:
 *   npm install node-fetch cheerio
 */

const cheerio = require("cheerio");

const BASE_URL = "https://kusamoto.co.jp/info/";

// Instagramカルーセルの上限（API仕様）
const IG_CAROUSEL_MAX = 10;

/**
 * 物件番号からページを取得し、画像・情報を抽出する
 * @param {string} propertyId 例: "2-0135"
 */
async function extractProperty(propertyId) {
  const url = `${BASE_URL}${propertyId}/`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; KusamotoIGBot/1.0)" },
  });

  if (!res.ok) {
    throw new Error(`ページ取得に失敗しました: ${url} (status: ${res.status})`);
  }

  const html = await res.text();
  const $ = cheerio.load(html);

    const title = $("h1")
    .filter((_, el) => $(el).text().trim() !== "")
    .first()
    .text()
    .trim();
  const images = extractGalleryImages($);
  const fields = extractTableFields($);
  const description = $('meta[property="og:description"]').attr("content") || "";

  return { propertyId, url, title, images, fields, description };
}

function extractGalleryImages($) {
  const urls = new Set();

  $("img").each((_, el) => {
    const src = $(el).attr("src") || $(el).attr("data-src");
    if (!src) return;
    if (!src.includes("/wp-content/uploads/")) return;
    if (/\/logo[-.]/i.test(src)) return; // サイトロゴを除外
    if (/foot_icon|foot_link/i.test(src)) return; // フッター系アイコン除外
        urls.add(encodeURI(src));
  });

  return Array.from(urls);
}

function extractTableFields($) {
  const fields = {};

  $("table").each((_, table) => {
    $(table)
      .find("tr")
      .each((_, tr) => {
        const cells = $(tr).find("th, td");
        for (let i = 0; i < cells.length - 1; i += 2) {
          const key = $(cells[i]).text().trim();
          const val = $(cells[i + 1]).text().trim();
          if (key && val) fields[key] = val;
        }
      });
  });

  return fields;
}

// 投稿末尾に毎回入れる固定パーツ
const CTA_TEXT = "物件詳細・お問合せはプロフィールのHPリンクからどうぞ。";

const HASHTAGS = [
  "#田舎暮らし", "#地方移住", "#移住", "#セカンドライフ", "#FIRE",
  "#リモートワーク", "#古民家", "#DIY", "#海", "#海水浴",
  "#サーフィン", "#キャンプ", "#温泉", "#花火", "#不動産",
  "#売家", "#別荘", "#ルームツアー", "#京都", "#京丹後市",
  "#クサモト", "#網野町", "#丹後町", "#久美浜町", "#峰山町",
  "#弥栄町", "#大宮町", "#宮津市", "#伊根町", "#城崎温泉",
];

const PRIORITY_FIELDS = [
  ["住所", "📍所在地"],
  ["所在地", "📍所在地"],
  ["価格", "💰価格"],
  ["賃料", "💰賃料"],
  ["土地面積", "🗺️土地面積"],
  ["建物面積", "🏠建物面積"],
  ["建物構造", "🏗️構造"],
  ["築年数", "📅築年数"],
  ["間取り", "🚪間取り"],
  ["交通", "🚃交通"],
  ["取引形態", "📋取引形態"],
  ["特記事項", "⚠️特記事項"],
  ["備考", "📝備考"],
];

function buildCaption({ title, fields, description, propertyId }) {
  const lines = [];
  lines.push(title);
  lines.push("");
  if (description) lines.push(description);
  lines.push("");

  for (const [srcKey, label] of PRIORITY_FIELDS) {
    if (fields[srcKey]) {
      lines.push(`${label}：${fields[srcKey]}`);
    }
  }

  lines.push("");
  lines.push(`物件番号：${propertyId}`);
  lines.push(CTA_TEXT);
  lines.push("");
  lines.push(HASHTAGS.join(" "));

  return lines.join("\n");
}

function selectImagesForSinglePost(images, max = IG_CAROUSEL_MAX) {
  return images.slice(0, max);
}

function chunkForCarousels(images, size = IG_CAROUSEL_MAX) {
  const chunks = [];
  for (let i = 0; i < images.length; i += size) {
    chunks.push(images.slice(i, i + size));
  }
  return chunks;
}

// --- CLI実行用 ---
if (require.main === module) {
  const propertyId = process.argv[2];
  if (!propertyId) {
    console.error("使い方: node extract-property.js 2-0135");
    process.exit(1);
  }

  extractProperty(propertyId)
    .then((data) => {
      console.log("=== タイトル ===");
      console.log(data.title);

      console.log(`\n=== 画像 (${data.images.length}枚) ===`);
      data.images.forEach((u, i) => console.log(`${i + 1}: ${u}`));
      if (data.images.length > IG_CAROUSEL_MAX) {
        console.log(
          `\n⚠️ IGカルーセル上限(${IG_CAROUSEL_MAX}枚)を超えています。方針を決める必要があります。`
        );
      }

      console.log("\n=== 抽出フィールド ===");
      console.log(data.fields);

      console.log("\n=== 生成キャプション ===");
      console.log(buildCaption(data));
    })
    .catch((err) => {
      console.error("エラー:", err.message);
      process.exit(1);
    });
}

module.exports = {
  extractProperty,
  extractGalleryImages,
  extractTableFields,
  buildCaption,
  selectImagesForSinglePost,
  chunkForCarousels,
  IG_CAROUSEL_MAX,
};
