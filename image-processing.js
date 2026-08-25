/**
 * Instagramのカルーセル投稿で使えるアスペクト比(0.8〜1.91)に
 * 収まらない画像に、白い余白を足して収める処理。
 *
 * 余白は「上下」または「左右」どちらか一方だけに追加する
 * （元の写真の一部を切り取ったりトリミングしたりはしない）。
 */

const sharp = require("sharp");

const MIN_RATIO = 0.8; // 4:5（縦長側の上限）
const MAX_RATIO = 1.91; // 1.91:1（横長側の上限）
const PAD_COLOR = { r: 255, g: 255, b: 255, alpha: 1 }; // 余白の色（白）

async function fetchImageBuffer(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; KusamotoIGBot/1.0)" },
  });
  if (!res.ok) {
    throw new Error(`画像の取得に失敗しました: ${url} (status: ${res.status})`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * 画像を取得し、比率が対応範囲外なら白い余白を足す。
 * @param {string} url
 * @returns {Promise<object>} 対応済みの場合 { padded: false }
 *   非対応で加工した場合 { padded: true, buffer, padding, originalWidth, originalHeight, finalWidth, finalHeight }
 */
async function padToValidRatio(url) {
  const original = await fetchImageBuffer(url);
  const meta = await sharp(original).metadata();
  const { width, height } = meta;
  const ratio = width / height;

  if (ratio >= MIN_RATIO && ratio <= MAX_RATIO) {
    return { padded: false };
  }

  let finalWidth = width;
  let finalHeight = height;
  let padding = { top: 0, bottom: 0, left: 0, right: 0 };

  if (ratio > MAX_RATIO) {
    // 横長すぎる → 上下に余白を足して縦を伸ばす
    finalHeight = Math.ceil(width / MAX_RATIO);
    const totalPad = finalHeight - height;
    padding.top = Math.floor(totalPad / 2);
    padding.bottom = totalPad - padding.top;
  } else {
    // 縦長すぎる → 左右に余白を足して横を伸ばす
    finalWidth = Math.ceil(height * MIN_RATIO);
    const totalPad = finalWidth - width;
    padding.left = Math.floor(totalPad / 2);
    padding.right = totalPad - padding.left;
  }

  const buffer = await sharp(original)
    .extend({ ...padding, background: PAD_COLOR })
    .jpeg({ quality: 92 })
    .toBuffer();

  return {
    padded: true,
    buffer,
    padding,
    originalWidth: width,
    originalHeight: height,
    finalWidth,
    finalHeight,
  };
}

module.exports = { padToValidRatio, MIN_RATIO, MAX_RATIO };
