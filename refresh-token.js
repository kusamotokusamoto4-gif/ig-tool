/**
 * Instagramの長期アクセストークンを自動更新するスクリプト。
 *
 * 仕組み:
 *   Instagramの長期アクセストークンは60日間有効。
 *   「発行から24時間以上経過していて、まだ期限切れになっていない」トークンは、
 *   graph.instagram.com/refresh_access_token を呼ぶだけで
 *   新しい60日間有効なトークンに更新できる（client_secret等は不要）。
 *
 * このスクリプトがやること:
 *   1. .env から現在のIG_ACCESS_TOKENを読み込む
 *   2. Instagramの更新APIを呼んで新しいトークンを取得
 *   3. .env の中身を新しいトークンで書き換える（IG_USER_IDはそのまま）
 *
 * 使い方:
 *   node refresh-token.js
 *
 * 運用方法（おすすめ）:
 *   Windowsのタスクスケジューラで「毎週1回」など定期実行するように登録すれば、
 *   人の手を介さず自動でトークンが更新され続けます（60日ルールに対して
 *   十分すぎる余裕を持てます）。詳しい登録手順は説明します。
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");

const ENV_PATH = path.join(__dirname, ".env");
const GRAPH_BASE = "https://graph.instagram.com";

const CURRENT_TOKEN = process.env.IG_ACCESS_TOKEN;

if (!CURRENT_TOKEN) {
  console.error("❌ .env に IG_ACCESS_TOKEN が見つかりません。");
  process.exit(1);
}

async function refreshToken(currentToken) {
  const params = new URLSearchParams({
    grant_type: "ig_refresh_token",
    access_token: currentToken,
  });

  const res = await fetch(`${GRAPH_BASE}/refresh_access_token?${params}`);
  const data = await res.json();

  if (data.error) {
    throw new Error(
      `トークン更新に失敗しました: ${JSON.stringify(data.error)}\n` +
        `→ 現在のトークンがすでに期限切れ、または無効になっている可能性があります。\n` +
        `　その場合は「トークン更新の流れ.docx」の手順で手動での再取得が必要です。`
    );
  }

  return data; // { access_token, token_type, expires_in }
}

function updateEnvFile(newToken) {
  let content = fs.readFileSync(ENV_PATH, "utf-8");

  if (/^IG_ACCESS_TOKEN=.*$/m.test(content)) {
    content = content.replace(/^IG_ACCESS_TOKEN=.*$/m, `IG_ACCESS_TOKEN=${newToken}`);
  } else {
    content += `\nIG_ACCESS_TOKEN=${newToken}\n`;
  }

  fs.writeFileSync(ENV_PATH, content, "utf-8");
}

async function main() {
  console.log("▶ トークンを更新中...");
  const result = await refreshToken(CURRENT_TOKEN);

  updateEnvFile(result.access_token);

  const days = Math.round(result.expires_in / 86400);
  console.log("✅ トークンを更新しました。");
  console.log(`   有効期限：約${days}日後まで`);
  console.log(`   .env を自動で書き換えました。`);
}

main().catch((err) => {
  console.error("❌ エラー:", err.message);
  process.exit(1);
});
