/**
 * 予約投稿の画面部品。server.js が index.html に自動で差し込みます。
 * 画像を選び、キャプションを整えたあと、「予約する」で日付と時間帯を指定します。
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const actions = document.querySelector(".actions");
  const main = document.querySelector("main");
  if (!actions || !main) return;

  // ---------- 見た目 ----------
  const style = document.createElement("style");
  style.textContent = `
    .sch-box { margin-top: 28px; padding: 18px; border: 1px solid var(--line, #d9d4c6); border-radius: 8px; background: #fbfaf6; }
    .sch-box h3 { margin: 0 0 6px; font-size: 16px; }
    .sch-box p.sch-hint { margin: 0 0 14px; font-size: 13px; color: #6b7568; line-height: 1.6; }
    .sch-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
    .sch-row input, .sch-row select { padding: 10px 12px; border: 1px solid var(--line, #d9d4c6); border-radius: 6px; font-size: 15px; background: white; font-family: inherit; }
    .sch-list { margin-top: 36px; }
    .sch-list h2 { font-size: 17px; margin: 0 0 10px; display: flex; justify-content: space-between; align-items: center; }
    .sch-item { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px; padding: 12px 14px; border: 1px solid var(--line, #d9d4c6); border-radius: 6px; background: white; margin-bottom: 8px; font-size: 14px; }
    .sch-item .when { font-weight: bold; }
    .sch-item .meta { color: #6b7568; font-size: 13px; }
    .sch-item .tag { display: inline-block; font-size: 12px; padding: 2px 8px; border-radius: 10px; margin-right: 8px; color: white; background: #35603f; }
    .sch-item .tag.posting { background: #b5892b; }
    .sch-item .tag.done { background: #6b7568; }
    .sch-item .tag.failed, .sch-item .tag.unknown { background: #a3402f; }
    .sch-item .tag.missed { background: #8a8a8a; }
    .sch-item .err { color: #a3402f; font-size: 13px; width: 100%; }
    .sch-empty { color: #6b7568; font-size: 14px; }
    .sch-small { padding: 6px 12px; font-size: 13px; }
  `;
  document.head.appendChild(style);

  // ---------- 予約ボックス（「この内容で投稿する」の下に追加） ----------
  const box = document.createElement("div");
  box.className = "sch-box";
  box.innerHTML = `
    <h3>予約投稿</h3>
    <p class="sch-hint">選んだ画像とキャプションを、指定した日の時間帯に自動で投稿します。予約後はこの画面を閉じても、パソコンやスマホの電源を切っても大丈夫です（日本時間）。投稿は時間帯が始まってから最大5分ほどで行われます。</p>
    <div class="sch-row">
      <input type="date" id="schDate" />
      <select id="schTime"></select>
      <button id="scheduleBtn">この内容で予約する</button>
    </div>
    <div class="error" id="schError"></div>
    <div class="success-banner" id="schOk"></div>
  `;
  actions.insertAdjacentElement("afterend", box);

  // 時間帯の選択肢（30分刻み。初期値は19:00）
  const pad2 = (n) => String(n).padStart(2, "0");
  const timeSel = $("schTime");
  for (let m = 6 * 60; m <= 22 * 60 + 30; m += 30) {
    const start = `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
    const e = m + 30;
    const end = `${pad2(Math.floor(e / 60))}:${pad2(e % 60)}`;
    const opt = document.createElement("option");
    opt.value = start;
    opt.textContent = `${start}〜${end}`;
    if (start === "19:00") opt.selected = true;
    timeSel.appendChild(opt);
  }

  // 初期の日付: 日本時間で19:00前なら今日、過ぎていれば明日
  function jstParts(offsetDays) {
    const d = new Date(Date.now() + 9 * 3600 * 1000 + (offsetDays || 0) * 86400000);
    return { date: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
  }
  $("schDate").value = jstParts(jstParts(0).minutes < 19 * 60 ? 0 : 1).date;
  $("schDate").min = jstParts(0).date;

  // ---------- 予約一覧（ページの一番下） ----------
  const listWrap = document.createElement("section");
  listWrap.className = "sch-list";
  listWrap.innerHTML = `
    <h2>予約の一覧 <button class="secondary sch-small" id="schReload">更新</button></h2>
    <div class="error" id="schListError"></div>
    <div id="schItems"><p class="sch-empty">読み込み中...</p></div>
  `;
  main.appendChild(listWrap);

  function showMsg(el, message) {
    el.textContent = message || "";
    el.classList.toggle("visible", Boolean(message));
  }

  const fmt = (ms) =>
    new Date(ms).toLocaleString("ja-JP", {
      timeZone: "Asia/Tokyo",
      month: "numeric",
      day: "numeric",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  const fmtTime = (ms) =>
    new Date(ms).toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" });

  const STATUS = {
    pending: "予約中",
    posting: "投稿中",
    done: "投稿済み",
    failed: "失敗",
    missed: "見送り",
    unknown: "要確認",
  };

  async function api(url, options) {
    const res = await fetch(url, options);
    let data = {};
    try {
      data = await res.json();
    } catch (e) {
      /* 空の返事 */
    }
    if (!res.ok) throw new Error(data.error || `エラーが発生しました (HTTP ${res.status})`);
    return data;
  }

  async function loadList() {
    const wrap = $("schItems");
    showMsg($("schListError"), "");
    try {
      const { items } = await api("/api/schedule");
      wrap.innerHTML = "";
      if (!items.length) {
        wrap.innerHTML = '<p class="sch-empty">予約はありません。</p>';
        return;
      }
      items.forEach((it) => {
        const row = document.createElement("div");
        row.className = "sch-item";

        const left = document.createElement("div");
        const tag = document.createElement("span");
        tag.className = "tag " + it.status;
        tag.textContent = STATUS[it.status] || it.status;
        const when = document.createElement("span");
        when.className = "when";
        when.textContent = `${fmt(it.startAt)}〜${fmtTime(it.endAt)}`;
        const meta = document.createElement("div");
        meta.className = "meta";
        meta.textContent = `${it.label || "（名称なし）"} ・ 画像${it.imageCount}枚` + (it.mediaId ? ` ・ media_id: ${it.mediaId}` : "");
        left.append(tag, when, meta);
        row.appendChild(left);

        if (it.status !== "posting") {
          const btn = document.createElement("button");
          btn.className = "secondary sch-small";
          btn.textContent = it.status === "pending" ? "取り消す" : "履歴から消す";
          btn.addEventListener("click", async () => {
            if (it.status === "pending" && !confirm("この予約を取り消します。よろしいですか？")) return;
            try {
              await api(`/api/schedule/${it.id}`, { method: "DELETE" });
              loadList();
            } catch (err) {
              showMsg($("schListError"), err.message);
            }
          });
          row.appendChild(btn);
        }

        if (it.error) {
          const err = document.createElement("div");
          err.className = "err";
          err.textContent = it.error;
          row.appendChild(err);
        }
        wrap.appendChild(row);
      });
    } catch (err) {
      wrap.innerHTML = "";
      showMsg($("schListError"), err.message);
    }
  }

  // ---------- 予約する ----------
  $("scheduleBtn").addEventListener("click", async () => {
    showMsg($("schError"), "");
    $("schOk").classList.remove("visible");

    const images = typeof selectedOrder !== "undefined" ? selectedOrder.slice() : [];
    const caption = $("caption") ? $("caption").value : "";
    const date = $("schDate").value;
    const time = $("schTime").value;
    const title = $("propTitle") ? $("propTitle").textContent : "";

    if (images.length < 2) return showMsg($("schError"), "画像を2枚以上選んでください。");
    if (!caption.trim()) return showMsg($("schError"), "キャプションを入力してください。");
    if (!date) return showMsg($("schError"), "日付を選んでください。");

    const start = new Date(`${date}T${time}:00+09:00`).getTime();
    const label = `${fmt(start)}〜${fmtTime(start + 30 * 60 * 1000)}`;
    if (!confirm(`画像${images.length}枚を、${label} の間にInstagramへ自動投稿します。よろしいですか？`)) return;

    const btn = $("scheduleBtn");
    btn.disabled = true;
    btn.textContent = "予約中...";
    try {
      await api("/api/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images, caption, date, time, label: title }),
      });
      $("schOk").textContent = `予約しました: ${label}`;
      $("schOk").classList.add("visible");
      loadList();
    } catch (err) {
      showMsg($("schError"), err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "この内容で予約する";
    }
  });

  $("schReload").addEventListener("click", loadList);
  loadList();
})();
