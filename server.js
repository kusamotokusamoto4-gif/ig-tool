/**
 * かんたん投稿画面（Render対応版Webサーバー）。
 */

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { extractProperty, buildCaption } = require("./extract-property");
const { publishCarousel } = require("./instagram-api");
const { padToValidRatio } = require("./image-processing");
const { refreshAndPersistToken } = require("./token-refresh");

const app = express();
const PORT = process.env.PORT || 3000;

// 画像URL(元)ごとに、加工結果をメモリ上に一時保存しておくキャッシュ
const imageCache = new Map();
const hashToUrl = new Map();

function hashFor(url) {
  return crypto.createHash("sha1").update(url).digest("hex").slice(0, 16);
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function paddingAsPercent(entry) {
  const { padding, finalWidth, finalHeight } = entry;
  return {
    top: (padding.top / finalHeight) * 100,
    bottom: (padding.bottom / finalHeight) * 100,
    left: (padding.left / finalWidth) * 100,
    right: (padding.right / finalWidth) * 100,
  };
}

app.get("/api/extract/:propertyId", async (req, res) => {
  try {
    const property = await extractProperty(req.params.propertyId);
    const caption = buildCaption(property);

    const images = [];
    for (const url of property.images) {
      let entry = imageCache.get(url);
      if (!entry) {
        try {
          entry = await padToValidRatio(url);
        } catch (err) {
          entry = { padded: false, error: err.message };
        }
        imageCache.set(url, entry);
      }

      if (entry.padded) {
        const hash = hashFor(url);
        hashToUrl.set(hash, url);
        images.push({
          url,
          previewUrl: `/preview/${hash}`,
          padded: true,
          padding: paddingAsPercent(entry),
        });
      } else {
        images.push({ url, previewUrl: url, padded: false });
      }
    }

    res.json({
      propertyId: property.propertyId,
      title: property.title,
      images,
      caption,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/preview/:hash", (req, res) => {
  const url = hashToUrl.get(req.params.hash);
  const entry = url && imageCache.get(url);
  if (!entry || !entry.padded) {
    return res.status(404).end();
  }
  res.set("Content-Type", "image/jpeg");
  res.send(entry.buffer);
});

app.post("/api/publish", async (req, res) => {
  const { images, caption } = req.body;

  if (!Array.isArray(images) || images.length < 2) {
    return res.status(400).json({ error: "画像は2枚以上選んでください。" });
  }
  if (images.length > 10) {
    return res.status(400).json({ error: "画像は10枚以内で選んでください（Instagramの上限）。" });
  }
  if (!caption || !caption.trim()) {
    return res.status(400).json({ error: "キャプションを入力してください。" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  const send = (msg) => res.write(`data: ${JSON.stringify({ msg })}\n\n`);

  try {
    // Render自身の公開ベースURLを取得（リクエストヘッダーから自動判定、または環境変数）
    const host = req.headers["x-forwarded-host"] || req.get("host");
    const protocol = req.headers["x-forwarded-proto"] || "https";
    const publicBaseUrl = `${protocol}://${host}`;

    const finalUrls = [];
    for (const url of images) {
      const entry = imageCache.get(url);
      if (entry && entry.padded) {
        // 白い余白を足した画像の場合、Render自身のURLを使った公開リンクをInstagramに教える
        const hash = hashFor(url);
        hashToUrl.set(hash, url);
        const publicUrl = `${publicBaseUrl}/preview/${hash}`;
        finalUrls.push(publicUrl);
      } else {
        finalUrls.push(url);
      }
    }

    send("Instagramへ投稿を作成中...");
    const mediaId = await publishCarousel(finalUrls, caption, send);
    res.write(`data: ${JSON.stringify({ done: true, mediaId })}\n\n`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
  } finally {
    res.end();
  }
});

// GitHub Actions等の外部スケジューラから定期的に叩かれる、トークン自動更新用エンドポイント。
// ?secret=... がRenderに設定したREFRESH_SECRETと一致しないと実行されない。
app.post("/api/refresh-token", async (req, res) => {
  const expected = process.env.REFRESH_SECRET;
  const provided = req.query.secret;

  if (!expected || provided !== expected) {
    return res.status(403).json({ error: "許可されていません。" });
  }

  try {
    const result = await refreshAndPersistToken();
    console.log(
      `✅ トークン更新完了（有効期限: 約${result.expiresInDays}日後 / Render保存: ${
        result.persisted ? "成功" : "未設定のためスキップ"
      }）`
    );
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("❌ トークン自動更新エラー:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ サーバーをポート ${PORT} で起動しました`);
});
