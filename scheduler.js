/**
 * 予約投稿機能。
 *
 * 使い方の流れ:
 *   1. 画面で画像とキャプションを決め、「予約する」を押す（日付と時間帯を選ぶ。初期値は 19:00〜19:30）
 *   2. 予約は Render の環境変数 SCHEDULE_DATA に保存される（Render API 経由）。
 *      → サーバーが眠っても、再起動しても消えない
 *   3. 外部の定期呼び出し（cron-job.org）が5分おきに /api/internal/tick を呼ぶ
 *   4. 呼ばれるたびに「時間帯に入った予約」があれば、その場で投稿する
 *
 * 必要な環境変数（すでにRenderに設定済みのもの）:
 *   RENDER_API_KEY / RENDER_SERVICE_ID / REFRESH_SECRET
 */

const crypto = require("crypto");

const RENDER_API = "https://api.render.com/v1";
const STORE_KEY = "SCHEDULE_DATA"; // 予約データを入れるRender環境変数の名前
const WINDOW_MS = 30 * 60 * 1000; // 投稿の時間帯の長さ（30分）
const GRACE_MS = 60 * 60 * 1000; // 時間帯を過ぎても、この時間内なら遅れて投稿する
const POSTING_STALE_MS = 15 * 60 * 1000; // 「投稿中」のまま15分たったら要確認扱い
const MAX_PENDING = 10; // 同時に持てる予約の数
const KEEP_FINISHED = 10; // 履歴として残す完了済みの数

// ---------- Render環境変数への保存・読み込み ----------

function renderConfig() {
  const { RENDER_API_KEY, RENDER_SERVICE_ID } = process.env;
  if (!RENDER_API_KEY || !RENDER_SERVICE_ID) {
    throw new Error("予約の保存には、Renderの環境変数 RENDER_API_KEY と RENDER_SERVICE_ID が必要です。");
  }
  return {
    base: `${RENDER_API}/services/${RENDER_SERVICE_ID}/env-vars`,
    headers: {
      Authorization: `Bearer ${RENDER_API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  };
}

async function loadSchedule() {
  const { base, headers } = renderConfig();
  const res = await fetch(`${base}?limit=100`, { headers });
  if (!res.ok) throw new Error(`Renderから予約を読み込めませんでした (HTTP ${res.status})`);
  const arr = await res.json();
  const found = (Array.isArray(arr) ? arr : []).map((x) => x.envVar || x).find((v) => v.key === STORE_KEY);
  if (!found || !found.value) return [];
  try {
    const data = JSON.parse(found.value);
    return Array.isArray(data) ? data : [];
  } catch {
    throw new Error(`予約データ(${STORE_KEY})が壊れています。Renderの環境変数から ${STORE_KEY} を削除してください。`);
  }
}

async function saveSchedule(list) {
  const { base, headers } = renderConfig();
  const res = await fetch(`${base}/${STORE_KEY}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ value: JSON.stringify(list) }),
  });
  if (!res.ok) throw new Error(`Renderへ予約を保存できませんでした (HTTP ${res.status}) ${await res.text()}`);
}

// 予約データの読み書きが同時に走って上書きし合わないよう、順番待ちにする
let lockChain = Promise.resolve();
function withLock(fn) {
  const run = lockChain.then(fn, fn);
  lockChain = run.catch(() => {});
  return run;
}

// ---------- 予約データの整理 ----------

/** 終わった予約は、画像URLやキャプションを消して小さくする（環境変数の容量対策） */
function strip(item) {
  delete item.images;
  delete item.caption;
  return item;
}

function prune(list) {
  const active = list.filter((i) => i.status === "pending" || i.status === "posting");
  const finished = list
    .filter((i) => i.status !== "pending" && i.status !== "posting")
    .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0))
    .slice(0, KEEP_FINISHED);
  return [...active, ...finished];
}

function toView(item) {
  return {
    id: item.id,
    status: item.status,
    label: item.label || "",
    startAt: item.startAt,
    endAt: item.endAt,
    imageCount: item.imageCount,
    mediaId: item.mediaId || null,
    error: item.error || null,
  };
}

function sortedView(list) {
  const active = list
    .filter((i) => i.status === "pending" || i.status === "posting")
    .sort((a, b) => a.startAt - b.startAt);
  const finished = list
    .filter((i) => i.status !== "pending" && i.status !== "posting")
    .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
  return [...active, ...finished].map(toView);
}

function friendlyError(message) {
  return /"code":\s*190/.test(message || "")
    ? "Instagramのトークンが期限切れです。再発行してRenderのIG_ACCESS_TOKENを差し替えてください。"
    : message;
}

// ---------- ルート登録 ----------

function registerSchedule(app, deps) {
  const { imageCache, hashToUrl, hashFor, padToValidRatio, publishCarousel } = deps;
  let processing = false;

  /** 余白付き画像は、投稿の直前に作り直してRender自身のURLで公開する */
  async function buildFinalUrls(images, publicBase) {
    const base = publicBase.replace(/\/$/, "");
    const urls = [];
    for (const url of images) {
      let entry = imageCache.get(url);
      if (!entry || entry.error) {
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
        urls.push(`${base}/preview/${hash}`);
      } else {
        urls.push(url);
      }
    }
    return urls;
  }

  /** 時間帯に入った予約を1件だけ取り出して投稿する */
  async function processDue(publicBase) {
    if (processing) return;
    processing = true;
    try {
      const now = Date.now();

      // 1) 投稿する予約を1件選び、先に「投稿中」の印をつける（二重投稿を防ぐため）
      const claimed = await withLock(async () => {
        const list = await loadSchedule();
        let changed = false;
        for (const it of list) {
          if (it.status === "pending" && now > it.endAt + GRACE_MS) {
            it.status = "missed";
            it.finishedAt = now;
            it.error = "投稿の時間帯を過ぎたため見送りました。";
            strip(it);
            changed = true;
          } else if (it.status === "posting" && now - (it.postingAt || 0) > POSTING_STALE_MS) {
            it.status = "unknown";
            it.finishedAt = now;
            it.error = "投稿の途中で止まった可能性があります。Instagramで投稿されているか確認してください（自動でのやり直しはしません）。";
            strip(it);
            changed = true;
          }
        }
        const due = list
          .filter((i) => i.status === "pending" && now >= i.startAt)
          .sort((a, b) => a.startAt - b.startAt)[0];
        if (due) {
          due.status = "posting";
          due.postingAt = now;
          changed = true;
        }
        if (changed) await saveSchedule(prune(list));
        return due ? { ...due } : null;
      });
      if (!claimed) return;

      // 2) 実際に投稿する
      let result;
      try {
        const urls = await buildFinalUrls(claimed.images, publicBase);
        const mediaId = await publishCarousel(urls, claimed.caption, () => {});
        result = { status: "done", mediaId };
        console.log(`✅ 予約投稿が完了しました (${claimed.id}) media_id=${mediaId}`);
      } catch (err) {
        result = { status: "failed", error: friendlyError(err.message) };
        console.error(`❌ 予約投稿に失敗しました (${claimed.id}):`, err.message);
      }

      // 3) 結果を記録する
      await withLock(async () => {
        const list = await loadSchedule();
        const it = list.find((x) => x.id === claimed.id);
        if (it) {
          Object.assign(it, result, { finishedAt: Date.now() });
          strip(it);
          await saveSchedule(prune(list));
        }
      });
    } finally {
      processing = false;
    }
  }

  // 予約の一覧
  app.get("/api/schedule", async (req, res) => {
    try {
      res.json({ items: sortedView(await loadSchedule()) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 予約を追加
  app.post("/api/schedule", async (req, res) => {
    try {
      const { images, caption, date, time, label } = req.body || {};
      if (!Array.isArray(images) || images.length < 2) throw new Error("画像は2枚以上選んでください。");
      if (images.length > 10) throw new Error("画像は10枚以内で選んでください。");
      if (!caption || !String(caption).trim()) throw new Error("キャプションを入力してください。");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !/^\d{2}:\d{2}$/.test(time || "")) {
        throw new Error("日付と時間を指定してください。");
      }

      const startAt = new Date(`${date}T${time}:00+09:00`).getTime(); // 日本時間として扱う
      if (Number.isNaN(startAt)) throw new Error("日付または時間の形式が正しくありません。");
      const endAt = startAt + WINDOW_MS;
      if (endAt <= Date.now()) throw new Error("過去の時間帯は指定できません。");

      const item = await withLock(async () => {
        const list = await loadSchedule();
        const pending = list.filter((i) => i.status === "pending" || i.status === "posting");
        if (pending.length >= MAX_PENDING) throw new Error(`予約は同時に${MAX_PENDING}件までです。`);
        const newItem = {
          id: crypto.randomBytes(6).toString("hex"),
          status: "pending",
          label: String(label || "").slice(0, 60),
          startAt,
          endAt,
          images: images.map(String),
          imageCount: images.length,
          caption: String(caption),
          createdAt: Date.now(),
        };
        list.push(newItem);
        await saveSchedule(prune(list));
        return newItem;
      });
      res.json({ ok: true, item: toView(item) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // 予約の取り消し（完了済みの履歴の削除にも使う）
  app.delete("/api/schedule/:id", async (req, res) => {
    try {
      await withLock(async () => {
        const list = await loadSchedule();
        const it = list.find((x) => x.id === req.params.id);
        if (!it) throw new Error("その予約は見つかりません。");
        if (it.status === "posting") throw new Error("投稿中のため取り消せません。");
        await saveSchedule(list.filter((x) => x.id !== req.params.id));
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // 外部の定期呼び出し用（cron-job.org から5分おきに呼ぶ）
  app.get("/api/internal/tick", (req, res) => {
    if (!process.env.REFRESH_SECRET || req.query.secret !== process.env.REFRESH_SECRET) {
      return res.status(403).json({ error: "許可されていません。" });
    }
    // 呼び出し元を待たせないよう、先に返事をしてから処理する
    res.json({ ok: true });
    const publicBase = process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get("host")}`;
    processDue(publicBase).catch((err) => console.error("tick処理でエラー:", err.message));
  });

  return { processDue }; // テスト用
}

module.exports = { registerSchedule };
