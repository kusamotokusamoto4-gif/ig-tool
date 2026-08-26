const MAX_IMAGES = 10;

const propertyIdInput = document.getElementById("propertyId");
const loadBtn = document.getElementById("loadBtn");
const loadError = document.getElementById("loadError");
const panel = document.getElementById("panel");
const propTitle = document.getElementById("propTitle");
const countBadge = document.getElementById("countBadge");
const grid = document.getElementById("grid");
const captionField = document.getElementById("caption");
const publishBtn = document.getElementById("publishBtn");
const resetBtn = document.getElementById("resetBtn");
const publishError = document.getElementById("publishError");
const successBanner = document.getElementById("successBanner");
const logBox = document.getElementById("log");

let allImages = []; // { url, previewUrl, padded, padding? }
let selectedOrder = []; // 選ばれた画像URL(元URL)を、選んだ順に保持

// Instagramのカルーセル画像として使えるアスペクト比の範囲
const MIN_RATIO = 0.8; // 4:5（縦長の上限）
const MAX_RATIO = 1.91; // 1.91:1（横長の上限）

function showError(el, message) {
  el.textContent = message;
  el.classList.toggle("visible", Boolean(message));
}

async function loadProperty() {
  const propertyId = propertyIdInput.value.trim();
  showError(loadError, "");
  if (!propertyId) {
    showError(loadError, "物件番号を入力してください。");
    return;
  }

  loadBtn.disabled = true;
  loadBtn.textContent = "読み込み中...";

  try {
    const res = await fetch(`/api/extract/${encodeURIComponent(propertyId)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "読み込みに失敗しました。");

    allImages = data.images;
    selectedOrder = [];
    propTitle.textContent = data.title || propertyId;
    countBadge.textContent = `全${allImages.length}枚`;
    captionField.value = data.caption;
    renderGrid();
    panel.classList.add("visible");
    successBanner.classList.remove("visible");
    showError(publishError, "");
    logBox.classList.remove("visible");
    logBox.textContent = "";
  } catch (err) {
    showError(loadError, err.message);
    panel.classList.remove("visible");
  } finally {
    loadBtn.disabled = false;
    loadBtn.textContent = "読み込む";
  }
}

function renderGrid() {
  grid.innerHTML = "";
  allImages.forEach((item) => {
    const div = document.createElement("div");
    div.className = "thumb" + (item.padded ? " padded" : "");
    div.innerHTML = `<img src="${item.previewUrl}" loading="lazy" /><span class="badge"></span>`;

    if (item.padded) {
      const p = item.padding;
      div.innerHTML += `
        <span class="padded-tag">余白あり</span>
        <span class="padding-guide" style="
          top:${p.top}%; bottom:${p.bottom}%; left:${p.left}%; right:${p.right}%;
        "></span>`;
    }

    div.addEventListener("click", () => toggleImage(item.url, div));
    grid.appendChild(div);
  });
}

function toggleImage(url, el) {
  const idx = selectedOrder.indexOf(url);
  if (idx >= 0) {
    selectedOrder.splice(idx, 1);
  } else {
    if (selectedOrder.length >= MAX_IMAGES) {
      showError(publishError, `画像は${MAX_IMAGES}枚まで選べます。`);
      return;
    }
    selectedOrder.push(url);
  }
  showError(publishError, "");
  updateBadges();
}

function updateBadges() {
  const thumbs = grid.querySelectorAll(".thumb");
  thumbs.forEach((thumb, i) => {
    const url = allImages[i].url;
    const order = selectedOrder.indexOf(url);
    thumb.classList.toggle("selected", order >= 0);
    thumb.querySelector(".badge").textContent = order >= 0 ? String(order + 1) : "";
  });
}

function resetSelection() {
  selectedOrder = [];
  updateBadges();
  showError(publishError, "");
  successBanner.classList.remove("visible");
}

async function publish() {
  showError(publishError, "");
  successBanner.classList.remove("visible");

  if (selectedOrder.length < 2) {
    showError(publishError, "画像を2枚以上選んでください。");
    return;
  }
  if (!captionField.value.trim()) {
    showError(publishError, "キャプションを入力してください。");
    return;
  }

  const confirmed = confirm(
    `画像${selectedOrder.length}枚でInstagramに実際に投稿します。よろしいですか？`
  );
  if (!confirmed) return;

  publishBtn.disabled = true;
  publishBtn.textContent = "投稿中...";
  logBox.classList.add("visible");
  logBox.textContent = "";

  try {
    const res = await fetch("/api/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ images: selectedOrder, caption: captionField.value }),
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split("\n\n");
      buffer = parts.pop();
      for (const part of parts) {
        if (!part.startsWith("data: ")) continue;
        const payload = JSON.parse(part.slice(6));
        if (payload.msg) {
          logBox.textContent += payload.msg + "\n";
          logBox.scrollTop = logBox.scrollHeight;
        }
        if (payload.error) {
          showError(publishError, payload.error);
        }
        if (payload.done) {
          successBanner.textContent = `投稿が完了しました（media_id: ${payload.mediaId}）`;
          successBanner.classList.add("visible");
        }
      }
    }
  } catch (err) {
    showError(publishError, err.message);
  } finally {
    publishBtn.disabled = false;
    publishBtn.textContent = "この内容で投稿する";
  }
}

loadBtn.addEventListener("click", loadProperty);
propertyIdInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") loadProperty();
});
resetBtn.addEventListener("click", resetSelection);
publishBtn.addEventListener("click", publish);
