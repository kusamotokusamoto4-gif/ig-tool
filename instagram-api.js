/**
 * Instagram Graph API とのやり取りをまとめたモジュール。
 * post-property.js（CLI）と server.js（Web画面）の両方から使う。
 */

require("dotenv").config();

const GRAPH_API_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.instagram.com/${GRAPH_API_VERSION}`;

function getCredentials() {
  const IG_USER_ID = process.env.IG_USER_ID;
  const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;
  if (!IG_USER_ID || !IG_ACCESS_TOKEN) {
    throw new Error("環境変数 IG_USER_ID / IG_ACCESS_TOKEN を設定してください（.env推奨）。");
  }
  return { IG_USER_ID, IG_ACCESS_TOKEN };
}

/** 1枚の画像から「子コンテナ」を作る（カルーセルの構成要素） */
async function createChildContainer(imageUrl) {
  const { IG_USER_ID, IG_ACCESS_TOKEN } = getCredentials();
  const params = new URLSearchParams({
    image_url: imageUrl,
    is_carousel_item: "true",
    access_token: IG_ACCESS_TOKEN,
  });

  const res = await fetch(`${GRAPH_BASE}/${IG_USER_ID}/media`, {
    method: "POST",
    body: params,
  });
  const data = await res.json();

  if (data.error) {
    throw new Error(`子コンテナ作成失敗 (${imageUrl}): ${JSON.stringify(data.error)}`);
  }
  return data.id; // creation_id
}

/** 子コンテナ群から親カルーセルコンテナを作る */
async function createCarouselContainer(childIds, caption) {
  const { IG_USER_ID, IG_ACCESS_TOKEN } = getCredentials();
  const params = new URLSearchParams({
    media_type: "CAROUSEL",
    children: childIds.join(","),
    caption,
    access_token: IG_ACCESS_TOKEN,
  });

  const res = await fetch(`${GRAPH_BASE}/${IG_USER_ID}/media`, {
    method: "POST",
    body: params,
  });
  const data = await res.json();

  if (data.error) {
    throw new Error(`カルーセルコンテナ作成失敗: ${JSON.stringify(data.error)}`);
  }
  return data.id; // creation_id
}

/** カルーセルコンテナの処理が完了する(FINISHED)まで待つ */
async function waitUntilReady(creationId, onProgress, maxWaitSeconds = 60) {
  const { IG_ACCESS_TOKEN } = getCredentials();
  const started = Date.now();
  while (Date.now() - started < maxWaitSeconds * 1000) {
    const params = new URLSearchParams({
      fields: "status_code",
      access_token: IG_ACCESS_TOKEN,
    });
    const res = await fetch(`${GRAPH_BASE}/${creationId}?${params}`);
    const data = await res.json();

    if (data.status_code === "FINISHED") return;
    if (data.status_code === "ERROR") {
      throw new Error("Instagram側でのメディア処理がエラーになりました。");
    }
    if (onProgress) onProgress(data.status_code || "不明");
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("処理完了を60秒待ちましたが、まだ準備できていません。");
}

/** カルーセルコンテナを公開する */
async function publishContainer(creationId) {
  const { IG_USER_ID, IG_ACCESS_TOKEN } = getCredentials();
  const params = new URLSearchParams({
    creation_id: creationId,
    access_token: IG_ACCESS_TOKEN,
  });

  const res = await fetch(`${GRAPH_BASE}/${IG_USER_ID}/media_publish`, {
    method: "POST",
    body: params,
  });
  const data = await res.json();

  if (data.error) {
    throw new Error(`公開失敗: ${JSON.stringify(data.error)}`);
  }
  return data.id; // 公開された投稿のID
}

/**
 * 選ばれた画像とキャプションから、カルーセル投稿を最後まで実行する。
 * @param {string[]} imageUrls 2〜10枚
 * @param {string} caption
 * @param {(msg: string) => void} [onProgress] 進捗ログ用のコールバック
 */
async function publishCarousel(imageUrls, caption, onProgress = () => {}) {
  if (imageUrls.length < 2) {
    throw new Error("カルーセル投稿には画像が2枚以上必要です。");
  }
  if (imageUrls.length > 10) {
    throw new Error("カルーセル投稿は画像10枚までです（Instagramの仕様）。");
  }

  onProgress("子コンテナを作成中...");
  const childIds = [];
  const skipped = [];
  for (const url of imageUrls) {
    try {
      const id = await createChildContainer(url);
      childIds.push(id);
      onProgress(`  ✓ 画像コンテナ作成: ${id}`);
    } catch (err) {
      skipped.push({ url, reason: err.message });
      onProgress(`  ⏭️ スキップ: ${url.split("/").pop()}`);
      onProgress(`      理由: ${err.message}`);
    }
  }

  if (skipped.length > 0) {
    onProgress(
      `⚠️ ${skipped.length}枚をスキップしました（アスペクト比が対応範囲(0.8〜1.91)外の画像は使えません）。`
    );
  }

  if (childIds.length < 2) {
    throw new Error(
      `使える画像が${childIds.length}枚しかありません。カルーセル投稿には2枚以上必要です。` +
        `別の画像を選び直してください。`
    );
  }

  onProgress("カルーセルコンテナを作成中...");
  const carouselId = await createCarouselContainer(childIds, caption);
  onProgress(`  ✓ carousel creation_id = ${carouselId}`);

  onProgress("Instagram側の処理完了を待っています...");
  await waitUntilReady(carouselId, (status) => onProgress(`  ...処理待ち (status: ${status})`));

  onProgress("公開中...");
  const mediaId = await publishContainer(carouselId);
  onProgress(`✅ 投稿完了！ media_id = ${mediaId}`);

  return mediaId;
}

module.exports = {
  createChildContainer,
  createCarouselContainer,
  waitUntilReady,
  publishContainer,
  publishCarousel,
};
