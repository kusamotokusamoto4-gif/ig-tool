/**
 * かんたん投稿画面（Webサーバー）。
 *
 * ローカルでの使い方:
 *   npm start
 *   ブラウザで http://localhost:3000 を開く
 *
 * Renderにデプロイした場合は、発行されたURL（例: https://xxxx.onrender.com）に
 * どの端末からでもアクセスできる。
 *
 * できること:
 *   ・物件番号を入力すると、HPに載っている画像を「全部」表示
 *   ・比率がInstagramの対応範囲外の画像は、自動で白い余白を足したプレビューを表示
 *     （余白を足した部分が分かるよう、点線の目印をつけて表示）
 *   ・好きな画像を選んで（最大10枚）投稿できる
 *   ・キャプションもその場で編集できる
 */

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { extractProperty, buildCaption } = require("./extract-property");
const { publishCarousel } = require("./instagram-api");
const { padToValidRatio } = require("./image-processing");

const app = express();
const PORT = process.env.PORT || 3000;

// 画像URL(元)ごとに、加工結果をメモリ上に一時保存しておくキャッシュ。
const imageCache = new Map();
// プレビュー配信用の短いID → 元の画像URL
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

  // このアプリ自身の公開URL（Renderにデプロイ済みなら、そのままInstagramから見える）
  const publicBase = `${req.protocol}://${req.get("host")}`;

  try {
    const finalUrls = [];
    for (const url of images) {
      const entry = imageCache.get(url);
      if (entry && entry.padded) {
        if (!entry.publicUrl) {
          const hash = hashFor(url);
          hashToUrl.set(hash, url);
          entry.publicUrl = `${publicBase}/preview/${hash}`;
        }
        finalUrls.push(entry.publicUrl);
      } else {
        finalUrls.push(url);
      }
    }

    const mediaId = await publishCarousel(finalUrls, caption, send);
    res.write(`data: ${JSON.stringify({ done: true, mediaId })}\n\n`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
  } finally {
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`✅ 投稿画面を起動しました: http://localhost:${PORT}`);
});

/**
 * トークン自動更新エンドポイント。
 * 外部の定期実行サービス（例: cron-job.org）から、
 *   GET /api/internal/refresh-token?secret=(REFRESH_SECRETの値)
 * を定期的に呼んでもらうことで、Instagramの長期アクセストークンを更新し、
 * Renderのサービス環境変数（IG_ACCESS_TOKEN）にも自動で書き込み直す。
 *
 * 必要な環境変数:
 *   REFRESH_SECRET     このURLを呼べる人を制限するための合言葉（自分で決める）
 *   RENDER_API_KEY      Renderのアカウント設定で発行するAPIキー
 *   RENDER_SERVICE_ID   このWebサービスのID（RenderのURLに含まれる "srv-..." の部分）
 */
app.get("/api/internal/refresh-token", async (req, res) => {
  if (!process.env.REFRESH_SECRET || req.query.secret !== process.env.REFRESH_SECRET) {
    return res.status(403).json({ error: "許可されていません。" });
  }

  try {
    const currentToken = process.env.IG_ACCESS_TOKEN;
    if (!currentToken) throw new Error("IG_ACCESS_TOKENが設定されていません。");

    const igParams = new URLSearchParams({
      grant_type: "ig_refresh_token",
      access_token: currentToken,
    });
    const igRes = await fetch(`https://graph.instagram.com/refresh_access_token?${igParams}`);
    const igData = await igRes.json();

    if (igData.error) {
      throw new Error(`Instagramトークン更新に失敗しました: ${JSON.stringify(igData.error)}`);
    }

    const newToken = igData.access_token;
    process.env.IG_ACCESS_TOKEN = newToken; // このプロセス内では即反映

    if (!process.env.RENDER_API_KEY || !process.env.RENDER_SERVICE_ID) {
      throw new Error(
        "トークン自体の更新は成功しましたが、RENDER_API_KEY / RENDER_SERVICE_ID が" +
          "未設定のため、次回の再起動で元に戻ってしまいます。環境変数を設定してください。"
      );
    }

    const renderRes = await fetch(
      `https://api.render.com/v1/services/${process.env.RENDER_SERVICE_ID}/env-vars/IG_ACCESS_TOKEN`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${process.env.RENDER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ value: newToken }),
      }
    );

    if (!renderRes.ok) {
      const errText = await renderRes.text();
      throw new Error(`Renderの環境変数の更新に失敗しました: ${errText}`);
    }

    const days = Math.round(igData.expires_in / 86400);
    res.json({ success: true, message: `トークンを更新しました（有効期限: 約${days}日後）` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
