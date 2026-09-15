/**
 * Instagramの長期アクセストークンを自動更新し、
 * 今動いているRenderサービスに反映するモジュール。
 *
 * server.js の /api/refresh-token エンドポイントから呼ばれる想定。
 *
 * 必要な環境変数（Renderのダッシュボードで設定）:
 *   IG_ACCESS_TOKEN    現在のトークン（すでに設定済みのはず）
 *   RENDER_API_KEY      Render のAPIキー（Account Settings → API Keys）
 *   RENDER_SERVICE_ID   このサービスのID（srv- で始まる文字列）
 */

const GRAPH_BASE = "https://graph.instagram.com";
const RENDER_API_BASE = "https://api.render.com/v1";

/** Instagramに新しいトークンをリクエストする */
async function requestNewToken(currentToken) {
  const params = new URLSearchParams({
    grant_type: "ig_refresh_token",
    access_token: currentToken,
  });

  const res = await fetch(`${GRAPH_BASE}/refresh_access_token?${params}`);
  const data = await res.json();

  if (data.error) {
    throw new Error(
      `Instagram側のトークン更新に失敗しました: ${JSON.stringify(data.error)}\n` +
        `→ 現在のトークンがすでに期限切れ、または無効になっている可能性があります。`
    );
  }

  return data; // { access_token, token_type, expires_in }
}

/** 新しいトークンをRenderの環境変数として保存する（このENV変数のみ更新、他は変更しない） */
async function persistToRender(newToken) {
  const apiKey = process.env.RENDER_API_KEY;
  const serviceId = process.env.RENDER_SERVICE_ID;

  if (!apiKey || !serviceId) {
    console.warn(
      "⚠️ RENDER_API_KEY / RENDER_SERVICE_ID が未設定のため、Render側には保存されませんでした。" +
        "今のプロセスが再起動すると古いトークンに戻ってしまいます。"
    );
    return { persisted: false };
  }

  const res = await fetch(
    `${RENDER_API_BASE}/services/${serviceId}/env-vars/IG_ACCESS_TOKEN`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ value: newToken }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Render環境変数の更新に失敗しました (status ${res.status}): ${text}`);
  }

  return { persisted: true };
}

/**
 * トークンを更新し、メモリ上と（できれば）Render環境変数の両方に反映する。
 * @returns {Promise<{ expiresInDays: number, persisted: boolean }>}
 */
async function refreshAndPersistToken() {
  const current = process.env.IG_ACCESS_TOKEN;
  if (!current) {
    throw new Error("環境変数 IG_ACCESS_TOKEN が設定されていません。");
  }

  const result = await requestNewToken(current);

  // 1. 今動いているプロセスのメモリを即座に更新 → すぐに投稿に使える
  process.env.IG_ACCESS_TOKEN = result.access_token;

  // 2. Renderの環境変数にも保存 → 次回の再起動・スリープ復帰後も新トークンが使われる
  const { persisted } = await persistToRender(result.access_token);

  return {
    expiresInDays: Math.round(result.expires_in / 86400),
    persisted,
  };
}

module.exports = { refreshAndPersistToken };
