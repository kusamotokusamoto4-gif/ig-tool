/**
 * 物件番号を渡すと、
 *   1) HPから画像(先頭10枚)と物件情報を抽出
 *   2) 箇条書きキャプションを生成
 *   3) Instagram Graph APIでカルーセル投稿を作成・公開
 * まで行うCLIスクリプト。
 *
 * 画像を自分で選びたい場合や、20枚以上の中から選びたい場合は、
 * 代わりに `npm start` でWeb投稿画面を使ってください（server.js）。
 *
 * 使い方:
 *   node post-property.js 2-0135
 *   node post-property.js 2-0135 --dry-run
 */

const {
  extractProperty,
  buildCaption,
  selectImagesForSinglePost,
  IG_CAROUSEL_MAX,
} = require("./extract-property");
const { publishCarousel } = require("./instagram-api");

async function main() {
  const propertyId = process.argv[2];
  const dryRun = process.argv.includes("--dry-run");

  if (!propertyId) {
    console.error("使い方: node post-property.js 2-0135 [--dry-run]");
    process.exit(1);
  }

  console.log(`▶ ${propertyId} のページを取得中...`);
  const property = await extractProperty(propertyId);

  const images = selectImagesForSinglePost(property.images, IG_CAROUSEL_MAX);
  if (property.images.length > IG_CAROUSEL_MAX) {
    console.log(
      `⚠️ 元画像は${property.images.length}枚。先頭${IG_CAROUSEL_MAX}枚のみ使用します。` +
        `（すべての画像から選びたい場合は Web投稿画面 [npm start] を使ってください）`
    );
  }

  const caption = buildCaption(property);

  console.log("\n=== 投稿プレビュー ===");
  console.log(`画像枚数: ${images.length}枚`);
  console.log("--- キャプション ---");
  console.log(caption);
  console.log("---------------------\n");

  if (dryRun) {
    console.log("（--dry-run のため、ここで停止します。実際の投稿は行いません）");
    return;
  }

  // ここで人間の最終確認を挟むのが望ましい（法令・誇大広告チェック）。
  await publishCarousel(images, caption, (msg) => console.log(msg));
}

main().catch((err) => {
  console.error("❌ エラー:", err.message);
  process.exit(1);
});
