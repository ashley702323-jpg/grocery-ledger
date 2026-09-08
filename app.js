(function () {
  "use strict";

  // ---------- unit price helpers (100g / 100ml / per-unit) ----------
  var UNIT_LABEL = { g: "g", kg: "kg", ml: "ml", l: "L", ea: "개" };

  function qtyDisplay(amount, unit) {
    if (!amount || !isFinite(amount)) return "";
    return amount + (UNIT_LABEL[unit] || "");
  }

  // best-effort: pull an amount+unit out of free text, e.g. a receipt-parsed
  // item name like "곱창전골 400g" or a legacy qty string like "500g" / "2개".
  function parseQtyToken(str) {
    if (!str) return null;
    var m = String(str).match(/(\d+(?:\.\d+)?)\s*(kg|g|ml|l|그램|킬로그램|리터|개|입|팩|봉|모|장|병|캔)/i);
    if (!m) return null;
    var amount = Number(m[1]);
    if (!isFinite(amount) || amount <= 0) return null;
    var raw = m[2].toLowerCase();
    var unit;
    if (raw === "kg" || raw === "킬로그램") unit = "kg";
    else if (raw === "g" || raw === "그램") unit = "g";
    else if (raw === "ml") unit = "ml";
    else if (raw === "l" || raw === "리터") unit = "l";
    else unit = "ea";
    return { amount: amount, unit: unit };
  }

  // { label: "100g당" | "100ml당" | "개당", value: number } or null when there
  // isn't enough information (falls back to parsing qty text / item name for
  // records saved before this field existed, or from receipt OCR).
  function unitPriceInfo(r) {
    var amount = r.qtyAmount, unit = r.qtyUnit;
    if (!(isFinite(amount) && amount > 0 && unit)) {
      var parsed = parseQtyToken(r.qty) || parseQtyToken(r.itemName);
      if (parsed) { amount = parsed.amount; unit = parsed.unit; }
    }
    if (!(isFinite(amount) && amount > 0 && unit) || !isFinite(r.price)) return null;
    if (unit === "g") return { label: "100g당", value: (r.price / amount) * 100, basis: "weight" };
    if (unit === "kg") return { label: "100g당", value: (r.price / (amount * 1000)) * 100, basis: "weight" };
    if (unit === "ml") return { label: "100ml당", value: (r.price / amount) * 100, basis: "volume" };
    if (unit === "l") return { label: "100ml당", value: (r.price / (amount * 1000)) * 100, basis: "volume" };
    return { label: "개당", value: r.price / amount, basis: "ea" };
  }

  // ---------- quick search links (쿠팡/지마켓/네이버) ----------
  // Deep-links to each site's own search results — this app has no server,
  // so it can't fetch prices from these sites itself (their search APIs
  // either don't exist publicly or block browser-side calls with CORS).
  function searchUrls(q) {
    var enc = encodeURIComponent(q);
    return {
      coupang: "https://www.coupang.com/np/search?q=" + enc,
      gmarket: "https://browse.gmarket.co.kr/search?keyword=" + enc,
      naver: "https://search.shopping.naver.com/search/all?query=" + enc,
    };
  }

  function wireQuickSearch(containerId, prefix, getQuery) {
    var container = document.getElementById(containerId);
    var coupangEl = document.getElementById(prefix + "-coupang");
    var gmarketEl = document.getElementById(prefix + "-gmarket");
    var naverEl = document.getElementById(prefix + "-naver");
    return function () {
      var q = (getQuery() || "").trim();
      if (!q) { container.style.display = "none"; return; }
      var urls = searchUrls(q);
      coupangEl.href = urls.coupang;
      gmarketEl.href = urls.gmarket;
      naverEl.href = urls.naver;
      container.style.display = "flex";
    };
  }

  // ---------- photo thumbnails ----------
  // Stored separately from the purchase records (keyed by id) so several
  // records saved from the same receipt photo share one copy instead of
  // duplicating the image data per item — localStorage has a small quota.
  var PHOTOS_KEY = "grocery-ledger-photos-v1";
  function loadPhotos() {
    try { return JSON.parse(localStorage.getItem(PHOTOS_KEY) || "{}"); } catch (e) { return {}; }
  }
  function savePhotos(map) {
    try { localStorage.setItem(PHOTOS_KEY, JSON.stringify(map)); } catch (e) { console.warn("photo save failed", e); }
  }
  function storePhotoDataUrl(dataUrl) {
    var id = uid();
    var map = loadPhotos();
    map[id] = dataUrl;
    savePhotos(map);
    return id;
  }
  function getPhotoUrl(photoId) {
    if (!photoId) return null;
    return loadPhotos()[photoId] || null;
  }
  // drop any stored photo no purchase record points to any more
  function gcPhotos() {
    var used = {};
    loadLocal().forEach(function (r) { if (r.photoId) used[r.photoId] = true; });
    var photos = loadPhotos();
    var changed = false;
    Object.keys(photos).forEach(function (id) { if (!used[id]) { delete photos[id]; changed = true; } });
    if (changed) savePhotos(photos);
  }

  // resize+compress an image file client-side before it ever touches
  // storage — a raw phone photo is several MB, a 240px JPEG thumbnail is a
  // few tens of KB, which is what keeps this workable inside localStorage.
  function fileToThumbnailDataUrl(file, maxDim, quality) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        var w = Math.max(1, Math.round(img.width * scale));
        var h = Math.max(1, Math.round(img.height * scale));
        var canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL("image/jpeg", quality || 0.7));
      };
      img.onerror = function (e) { URL.revokeObjectURL(url); reject(e); };
      img.src = url;
    });
  }

  // ---------- service worker (offline caching) ----------
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function (e) { console.warn("sw register failed", e); });
    });
  }

  // ---------- local storage backend ----------
  var LOCAL_KEY = "grocery-ledger-purchases-v1";
  var state = { purchases: [] };

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  function loadLocal() {
    try {
      var raw = localStorage.getItem(LOCAL_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }
  function saveLocal(list) {
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify(list)); } catch (e) { console.warn("save failed", e); }
  }
  function sortPurchases(list) {
    return list.slice().sort(function (a, b) {
      return (b.date || "").localeCompare(a.date || "") || (b.createdAt || 0) - (a.createdAt || 0);
    });
  }

  function renderAll() {
    renderDatalists();
    renderRecords();
    renderCompare();
  }

  function addPurchase(rec) {
    rec.id = uid();
    rec.createdAt = Date.now();
    var list = loadLocal();
    list.push(rec);
    saveLocal(list);
    state.purchases = sortPurchases(list);
    renderAll();
  }

  function deletePurchase(id) {
    var list = loadLocal().filter(function (r) { return r.id !== id; });
    saveLocal(list);
    state.purchases = sortPurchases(list);
    gcPhotos();
    renderAll();
  }

  function updatePurchase(id, patch) {
    var list = loadLocal();
    var idx = list.findIndex(function (r) { return r.id === id; });
    if (idx === -1) return;
    Object.assign(list[idx], patch);
    saveLocal(list);
    state.purchases = sortPurchases(list);
    gcPhotos();
    renderAll();
  }

  function bulkSetStore(ids, store) {
    var idSet = {};
    ids.forEach(function (id) { idSet[id] = true; });
    var list = loadLocal();
    list.forEach(function (r) { if (idSet[r.id]) r.store = store; });
    saveLocal(list);
    state.purchases = sortPurchases(list);
    renderAll();
  }

  state.purchases = sortPurchases(loadLocal());

  // ---------- export / import ----------
  document.getElementById("export-btn").addEventListener("click", function () {
    var blob = new Blob([JSON.stringify(state.purchases, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    var today = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = "grocery-ledger-" + today + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  });

  var importFile = document.getElementById("import-file");
  document.getElementById("import-btn").addEventListener("click", function () { importFile.click(); });
  importFile.addEventListener("change", function () {
    var f = importFile.files && importFile.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var incoming = JSON.parse(reader.result);
        if (!Array.isArray(incoming)) throw new Error("not an array");
        var existing = loadLocal();
        var existingIds = new Set(existing.map(function (r) { return r.id; }));
        var merged = existing.slice();
        incoming.forEach(function (r) {
          if (!r || typeof r !== "object") return;
          if (!r.id || existingIds.has(r.id)) r.id = uid();
          if (!r.itemName || !isFinite(r.price)) return;
          merged.push(r);
        });
        saveLocal(merged);
        state.purchases = sortPurchases(merged);
        renderAll();
        alert("가져오기를 완료했어요 (" + incoming.length + "건 시도).");
      } catch (e) {
        alert("파일을 읽을 수 없어요. 이 앱에서 내보낸 JSON 파일인지 확인해주세요.");
      }
      importFile.value = "";
    };
    reader.readAsText(f);
  });

  // ---------- tabs ----------
  var tabBtns = document.querySelectorAll(".tabbtn");
  var panels = { add: "panel-add", records: "panel-records", compare: "panel-compare" };
  tabBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      tabBtns.forEach(function (b) { b.classList.remove("active"); b.setAttribute("aria-selected", "false"); });
      btn.classList.add("active"); btn.setAttribute("aria-selected", "true");
      Object.values(panels).forEach(function (id) { document.getElementById(id).classList.remove("active"); });
      document.getElementById(panels[btn.dataset.tab]).classList.add("active");
    });
  });

  // ---------- manual form ----------
  var manualForm = document.getElementById("manual-form");
  document.getElementById("f-date").value = new Date().toISOString().slice(0, 10);

  var fNameInput = document.getElementById("f-name");
  var updateAddQuickSearch = wireQuickSearch("add-quick-search", "add-qs", function () { return fNameInput.value; });
  fNameInput.addEventListener("input", updateAddQuickSearch);

  var qtyAmountInput = document.getElementById("f-qty-amount");
  var qtyUnitSelect = document.getElementById("f-qty-unit");
  var unitPricePreview = document.getElementById("unit-price-preview");

  function updateUnitPricePreview() {
    var amount = Number(qtyAmountInput.value);
    var unit = qtyUnitSelect.value;
    var price = Number(document.getElementById("f-price").value);
    if (!(isFinite(amount) && amount > 0 && unit) || !isFinite(price) || price <= 0) {
      unitPricePreview.textContent = "";
      return;
    }
    var info = unitPriceInfo({ price: price, qtyAmount: amount, qtyUnit: unit });
    unitPricePreview.textContent = info ? "≈ " + info.label + " " + fmtWon(Math.round(info.value)) : "";
  }
  [qtyAmountInput, qtyUnitSelect, document.getElementById("f-price")].forEach(function (el) {
    el.addEventListener("input", updateUnitPricePreview);
  });

  var addPhotoInput = document.getElementById("f-photo");
  var addPhotoPreview = document.getElementById("add-photo-preview");
  var addPhotoCopy = document.getElementById("add-photo-copy");
  var addPhotoDrop = document.getElementById("add-photo-drop");
  var addPhotoRemoveBtn = document.getElementById("add-photo-remove-btn");
  var pendingPhotoDataUrl = null;

  function resetAddPhoto() {
    pendingPhotoDataUrl = null;
    addPhotoInput.value = "";
    addPhotoPreview.style.display = "none";
    addPhotoCopy.style.display = "";
    addPhotoDrop.classList.remove("has-file");
    addPhotoRemoveBtn.style.display = "none";
  }
  addPhotoInput.addEventListener("change", async function () {
    var f = addPhotoInput.files && addPhotoInput.files[0];
    if (!f) return;
    try {
      pendingPhotoDataUrl = await fileToThumbnailDataUrl(f, 480, 0.75);
    } catch (e) {
      console.warn("photo resize failed", e);
      pendingPhotoDataUrl = null;
      return;
    }
    addPhotoPreview.src = pendingPhotoDataUrl;
    addPhotoPreview.style.display = "block";
    addPhotoCopy.style.display = "none";
    addPhotoDrop.classList.add("has-file");
    addPhotoRemoveBtn.style.display = "";
  });
  addPhotoRemoveBtn.addEventListener("click", resetAddPhoto);

  manualForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var name = document.getElementById("f-name").value.trim();
    var store = document.getElementById("f-store").value.trim();
    var price = Number(document.getElementById("f-price").value);
    var date = document.getElementById("f-date").value;
    var qtyAmount = qtyAmountInput.value ? Number(qtyAmountInput.value) : null;
    var qtyUnit = qtyUnitSelect.value || null;
    var note = document.getElementById("f-note").value.trim();
    if (!name || !store || !isFinite(price)) return;

    var photoId = pendingPhotoDataUrl ? storePhotoDataUrl(pendingPhotoDataUrl) : null;
    addPurchase({
      itemName: name, store: store, price: price, date: date,
      qty: qtyDisplay(qtyAmount, qtyUnit), qtyAmount: qtyAmount, qtyUnit: qtyUnit,
      note: note, source: "manual", photoId: photoId,
    });
    manualForm.reset();
    document.getElementById("f-date").value = new Date().toISOString().slice(0, 10);
    unitPricePreview.textContent = "";
    resetAddPhoto();
    updateAddQuickSearch();
  });

  // ---------- mode toggle ----------
  var modeManualBtn = document.getElementById("mode-manual");
  var modeReceiptBtn = document.getElementById("mode-receipt");
  modeManualBtn.addEventListener("click", function () {
    modeManualBtn.classList.add("active"); modeReceiptBtn.classList.remove("active");
    manualForm.style.display = ""; document.getElementById("receipt-form").style.display = "none";
  });
  modeReceiptBtn.addEventListener("click", function () {
    modeReceiptBtn.classList.add("active"); modeManualBtn.classList.remove("active");
    manualForm.style.display = "none"; document.getElementById("receipt-form").style.display = "";
  });

  // ---------- receipt OCR (Tesseract.js, fully on-device) ----------
  var receiptFileCamera = document.getElementById("receipt-file-camera");
  var receiptFileGallery = document.getElementById("receipt-file-gallery");
  var pickCameraBtn = document.getElementById("pick-camera-btn");
  var pickGalleryBtn = document.getElementById("pick-gallery-btn");
  var receiptPreview = document.getElementById("receipt-preview");
  var dropCopy = document.getElementById("drop-copy");
  var dropZone = document.getElementById("drop-zone");
  var analyzeBtn = document.getElementById("analyze-btn");
  var statusEl = document.getElementById("receipt-status");
  var resultEl = document.getElementById("receipt-result");
  var currentFile = null;

  if (typeof Tesseract === "undefined") {
    modeReceiptBtn.disabled = true;
    modeReceiptBtn.title = "인식 엔진을 불러오지 못했어요 (오프라인 상태일 수 있어요)";
  }

  pickCameraBtn.addEventListener("click", function () { receiptFileCamera.click(); });
  pickGalleryBtn.addEventListener("click", function () { receiptFileGallery.click(); });

  function handleFileChosen(f) {
    if (!f) return;
    currentFile = f;
    var url = URL.createObjectURL(f);
    receiptPreview.src = url;
    receiptPreview.style.display = "block";
    dropCopy.style.display = "none";
    dropZone.classList.add("has-file");
    analyzeBtn.disabled = false;
    resultEl.innerHTML = "";
    statusEl.innerHTML = "";
  }
  receiptFileCamera.addEventListener("change", function () {
    handleFileChosen(receiptFileCamera.files && receiptFileCamera.files[0]);
  });
  receiptFileGallery.addEventListener("change", function () {
    handleFileChosen(receiptFileGallery.files && receiptFileGallery.files[0]);
  });

  // grayscale + local adaptive threshold (Bradley-Roth style) before OCR.
  // A hand-held photo of a curled receipt usually has a lighting gradient
  // across it (brighter on one side, shadowed on the other) — a single
  // global brightness cutoff turns part of it solid black or white and
  // destroys the text there, so this compares each pixel to the AVERAGE
  // of its own neighborhood instead, which holds up under uneven light.
  // Also keeps resolution high (thermal-receipt dot-matrix text is tiny —
  // downscaling too far is what was blurring it into noise before).
  function preprocessForOcr(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var maxDim = 2200;
        var scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        var w = Math.max(1, Math.round(img.width * scale));
        var h = Math.max(1, Math.round(img.height * scale));
        var canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        var ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        try {
          var imgData = ctx.getImageData(0, 0, w, h);
          var d = imgData.data;
          var n = w * h;
          var gray = new Float64Array(n);
          for (var i = 0, p = 0; p < n; i += 4, p++) {
            gray[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          }

          // integral image of grayscale values for O(1) windowed averages
          var stride = w + 1;
          var integral = new Float64Array(stride * (h + 1));
          for (var y = 0; y < h; y++) {
            var rowSum = 0;
            for (var x = 0; x < w; x++) {
              rowSum += gray[y * w + x];
              integral[(y + 1) * stride + (x + 1)] = integral[y * stride + (x + 1)] + rowSum;
            }
          }

          var radius = Math.max(12, Math.round(Math.min(w, h) / 14));
          var bias = 0.90; // pixel counts as "ink" when below 90% of its neighborhood's average
          for (var yy = 0; yy < h; yy++) {
            var y0 = Math.max(0, yy - radius), y1 = Math.min(h - 1, yy + radius);
            for (var xx = 0; xx < w; xx++) {
              var x0 = Math.max(0, xx - radius), x1 = Math.min(w - 1, xx + radius);
              var sum = integral[(y1 + 1) * stride + (x1 + 1)] - integral[y0 * stride + (x1 + 1)] -
                integral[(y1 + 1) * stride + x0] + integral[y0 * stride + x0];
              var count = (x1 - x0 + 1) * (y1 - y0 + 1);
              var localMean = sum / count;
              var idx = (yy * w + xx) * 4;
              var v = gray[yy * w + xx] < localMean * bias ? 0 : 255;
              d[idx] = d[idx + 1] = d[idx + 2] = v;
            }
          }
          ctx.putImageData(imgData, 0, 0);
        } catch (e) {
          console.warn("preprocess skipped", e);
        }
        canvas.toBlob(function (blob) {
          blob ? resolve(blob) : reject(new Error("toBlob failed"));
        }, "image/png");
      };
      img.onerror = function (e) { URL.revokeObjectURL(url); reject(e); };
      img.src = url;
    });
  }

  analyzeBtn.addEventListener("click", async function () {
    if (!currentFile || typeof Tesseract === "undefined") return;
    analyzeBtn.disabled = true;
    resultEl.innerHTML = "";
    statusEl.innerHTML =
      '<div class="status-line"><span class="spinner"></span><span id="ocr-status-text">사진을 다듬는 중...</span></div>' +
      '<div class="progress"><div class="progress-fill" id="ocr-progress"></div></div>';
    var progressFill = document.getElementById("ocr-progress");
    var statusText = document.getElementById("ocr-status-text");

    var STAGE_LABEL = {
      "loading tesseract core": "엔진 불러오는 중",
      "initializing tesseract": "엔진 초기화 중",
      "loading language traineddata": "언어 데이터 내려받는 중",
      "initializing api": "준비 중",
      "recognizing text": "글자 인식 중",
    };

    var worker = null;
    try {
      var processed = await preprocessForOcr(currentFile);
      // "best" (higher-accuracy, larger) Korean model instead of the default
      // "fast" one — meaningfully better on small/noisy receipt text. Korean
      // alone (no "eng") on purpose: its charset already covers digits/punct,
      // which is most of what a price line needs, and dropping "eng" removes
      // a source of glyph-shape confusion between the two models.
      worker = await Tesseract.createWorker(["kor"], 1, {
        langPath: "https://cdn.jsdelivr.net/npm/@tesseract.js-data/kor@1.0.0/4.0.0_best_int",
        logger: function (m) {
          if (m.progress != null) progressFill.style.width = Math.round(m.progress * 100) + "%";
          if (m.status) statusText.textContent = (STAGE_LABEL[m.status] || m.status) + "...";
        },
      });
      // PSM 6 (uniform block of text) reads a receipt's stacked lines more
      // reliably than the default "auto page layout" mode.
      var psm = (typeof Tesseract.PSM !== "undefined" && Tesseract.PSM.SINGLE_BLOCK) || "6";
      await worker.setParameters({ tessedit_pageseg_mode: psm });
      var result = await worker.recognize(processed);
      var text = (result && result.data && result.data.text) || "";
      statusEl.innerHTML = "";
      renderParsedResult(text);
    } catch (err) {
      console.warn("ocr failed", err);
      statusEl.innerHTML = '<div class="banner warn">인식에 실패했어요. 네트워크 상태를 확인하거나 다른 사진으로 시도해주세요.</div>';
    } finally {
      if (worker) { try { await worker.terminate(); } catch (e) { /* ignore */ } }
      analyzeBtn.disabled = false;
    }
  });

  // heuristic Korean/English receipt line parser: best-effort, meant to be
  // confirmed/edited by the person before saving, not to be perfectly accurate.
  // Handles two common layouts, tolerant of column count/order so it isn't
  // tied to one store's exact receipt format:
  //  1) "품목명 ......... 가격" on one line (paper POS receipts)
  //  2) "01  품목명"  then a separate numbers-only line (바코드/단가/수량/금액
  //     in any order) whose last plausible price is taken as the amount —
  //     common on mobile/e-receipts, e.g. 이마트/SSG 모바일 영수증
  var EXCLUDE_RE = /(합계|소계|과세|면세|부가세|VAT|카드|현금|거스름|잔액|받은금액|승인|가맹점|사업자|대표자|전화|TEL|영수증|감사합니다|고객|매장|주소|매출|품명|단가|수량|금액|포인트|적립|할인율|결제|바코드|No\.|사업자등록번호|봉투|일시불|할부|POS)/i;
  var MASK_RE = /\*{2,}/; // masked card numbers etc., e.g. 97101500**000*
  // trailing single letter tolerates a tax-code flag some POS receipts print
  // right after the amount, e.g. "3,690S" (taxable) / "1,990N" (non-taxable)
  var PRICE_RE = /([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{3,})\s*원?\s*[A-Z]?\s*$/;
  var QTY_RE = /(?:^|\s)([0-9]+)\s*[xX×]\s*/;
  // when 수량 and 단가 sit as their own columns before the final 금액 on a
  // "이름 수량 단가 금액" line, strip them too so they don't leak into the name
  var TRAILING_QTY_UNITPRICE_RE = /\s+[0-9]+\s+[0-9]{1,3}(?:,[0-9]{3})*\s*$/;
  var ITEM_HEAD_RE = /^(\d{1,3})\*?\s+(.+)$/; // "01  품목명" / "05* 품목명"
  // a line made up of only digits/commas/dots/dashes/spaces (barcode + price
  // columns, in ANY order/count) — not tied to one store's exact column layout
  var NUMERIC_LINE_RE = /^[0-9,.\-\s]+$/;

  function isExcludedLine(line) {
    return EXCLUDE_RE.test(line.replace(/\s+/g, "")) || MASK_RE.test(line);
  }

  function parseReceiptText(text) {
    var lines = text.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
    var items = [];
    var consumed = {};

    for (var i = 0; i < lines.length; i++) {
      if (consumed[i]) continue;
      var line = lines[i];
      if (isExcludedLine(line)) continue;

      var head = line.match(ITEM_HEAD_RE);
      if (head) {
        var headName = head[2].trim();
        var inline = headName.match(PRICE_RE);
        if (inline) {
          var inlinePrice = Number(inline[1].replace(/,/g, ""));
          var inlineName = headName.slice(0, inline.index).trim();
          if (isFinite(inlinePrice) && inlinePrice >= 100 && inlineName) {
            items.push({ name: inlineName, price: inlinePrice, qty: "" });
            continue;
          }
        }
        var next = lines[i + 1];
        if (next && !isExcludedLine(next) && NUMERIC_LINE_RE.test(next)) {
          var nm = next.match(PRICE_RE);
          if (nm) {
            var amount = Number(nm[1].replace(/,/g, ""));
            if (isFinite(amount) && amount >= 100) {
              items.push({ name: headName, price: amount, qty: "" });
              consumed[i + 1] = true;
              continue;
            }
          }
        }
        continue; // numbered line but no price found nearby — skip rather than guess
      }

      if (NUMERIC_LINE_RE.test(line)) continue; // stray barcode/qty-only line not attached to a name
      var m = line.match(PRICE_RE);
      if (!m) continue;
      var price = Number(m[1].replace(/,/g, ""));
      if (!isFinite(price) || price < 100) continue;
      var namePart = line.slice(0, m.index).trim();
      var qty = "";
      var qm = namePart.match(QTY_RE);
      if (qm) { qty = qm[1] + "개"; namePart = namePart.replace(QTY_RE, " ").trim(); }
      // "이름  수량  단가" left over before the 금액 we already matched — drop it
      namePart = namePart.replace(TRAILING_QTY_UNITPRICE_RE, "").trim();
      namePart = namePart.replace(/[\-*.]{2,}$/, "").replace(/^\d+\s+/, "").replace(/^[#*=]\s*/, "").trim();
      if (!namePart || /^[0-9\s,.\-]+$/.test(namePart)) continue;
      items.push({ name: namePart, price: price, qty: qty });
    }

    // guess a date if one appears anywhere in the receipt
    var dateMatch = text.match(/(20\d{2})[.\-\/년]\s?(\d{1,2})[.\-\/월]\s?(\d{1,2})/);
    var date = dateMatch
      ? dateMatch[1] + "-" + String(dateMatch[2]).padStart(2, "0") + "-" + String(dateMatch[3]).padStart(2, "0")
      : new Date().toISOString().slice(0, 10);
    return { items: items, date: date };
  }

  function renderParsedResult(rawText) {
    var parsed = parseReceiptText(rawText);
    var items = parsed.items;
    var date = parsed.date;

    var html = "";
    html += '<div class="banner">글자 인식 결과에서 품목 ' + items.length + '개를 찾았어요. 잘못 읽힌 항목은 아래에서 고치거나 지워주세요. 원문 텍스트를 보고 직접 추가할 수도 있어요.</div>';
    html += '<div class="parsed-meta">';
    html += '<div class="field"><label>구매처</label><input type="text" id="p-store" list="dl-stores" placeholder="구매처 입력"/></div>';
    html += '<div class="field"><label>날짜</label><input type="date" id="p-date" value="' + escAttr(date) + '"/></div>';
    html += '</div>';
    html += '<div class="parsed-rows-head"><span>품목명</span><span>가격</span><span>수량</span><span></span></div>';
    html += '<div id="parsed-rows"></div>';
    html += '<button type="button" class="add-row-btn" id="add-parsed-row">+ 품목 추가</button>';
    html += '<button type="button" class="raw-toggle" id="toggle-raw">원본 인식 텍스트 보기</button>';
    html += '<div class="raw-text" id="raw-text" style="display:none;">' + escHtml(rawText || "(인식된 텍스트 없음)") + '</div>';
    html += '<button type="button" class="btn btn-primary" id="save-parsed" style="margin-top:14px;">' +
      (items.length ? items.length + "개 품목 저장" : "저장할 품목 없음") + '</button>';
    resultEl.innerHTML = html;

    document.getElementById("toggle-raw").addEventListener("click", function () {
      var el = document.getElementById("raw-text");
      el.style.display = el.style.display === "none" ? "block" : "none";
    });

    var rowsEl = document.getElementById("parsed-rows");
    function addRow(item) {
      var row = document.createElement("div");
      row.className = "parsed-row";
      row.innerHTML =
        '<input type="text" class="pr-name" placeholder="품목명" value="' + escAttr(item && item.name || "") + '"/>' +
        '<input type="number" class="pr-price" placeholder="가격" value="' + (item && isFinite(item.price) ? item.price : "") + '"/>' +
        '<input type="text" class="pr-qty" placeholder="수량" value="' + escAttr(item && item.qty || "") + '"/>' +
        '<button type="button" class="rm" aria-label="삭제">×</button>';
      row.querySelector(".rm").addEventListener("click", function () { row.remove(); updateSaveCount(); });
      rowsEl.appendChild(row);
    }
    items.forEach(addRow);
    document.getElementById("add-parsed-row").addEventListener("click", function () { addRow({}); updateSaveCount(); });

    function updateSaveCount() {
      var n = rowsEl.querySelectorAll(".parsed-row").length;
      var btn = document.getElementById("save-parsed");
      btn.textContent = n ? n + "개 품목 저장" : "저장할 품목 없음";
      btn.disabled = n === 0;
    }
    updateSaveCount();

    document.getElementById("save-parsed").addEventListener("click", function () {
      var storeVal = document.getElementById("p-store").value.trim() || "미지정";
      var dateVal = document.getElementById("p-date").value || new Date().toISOString().slice(0, 10);
      var rows = Array.prototype.slice.call(rowsEl.querySelectorAll(".parsed-row"));
      var toSave = rows.map(function (r) {
        var name = r.querySelector(".pr-name").value.trim();
        var qtyText = r.querySelector(".pr-qty").value.trim();
        // best-effort: "돼지 앞다리 500g" or a qty field like "300g" tells us
        // enough to compute a 100g/100ml unit price automatically later.
        var detected = parseQtyToken(qtyText) || parseQtyToken(name);
        return {
          itemName: name,
          price: Number(r.querySelector(".pr-price").value),
          qty: qtyText || (detected ? qtyDisplay(detected.amount, detected.unit) : ""),
          qtyAmount: detected ? detected.amount : null,
          qtyUnit: detected ? detected.unit : null,
          store: storeVal, date: dateVal, note: "", source: "receipt",
        };
      }).filter(function (r) { return r.itemName && isFinite(r.price); });

      if (!toSave.length) return;
      toSave.forEach(addPurchase);
      resultEl.innerHTML = '<div class="banner">' + toSave.length + '개 품목을 저장했어요.</div>';
      currentFile = null;
      receiptPreview.style.display = "none";
      dropCopy.style.display = "";
      dropZone.classList.remove("has-file");
      receiptFileCamera.value = "";
      receiptFileGallery.value = "";
      analyzeBtn.disabled = true;
    });
  }

  function escAttr(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }
  function escHtml(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // ---------- records list ----------
  var searchInput = document.getElementById("search-records");
  searchInput.addEventListener("input", renderRecords);

  var selectModeBtn = document.getElementById("select-mode-btn");
  var bulkBar = document.getElementById("bulk-bar");
  var bulkCount = document.getElementById("bulk-count");
  var bulkStoreInput = document.getElementById("bulk-store");
  var recordsHint = document.getElementById("records-hint");
  var selectMode = false;
  var selectedIds = {};
  var editingId = null;

  function selectedCount() { return Object.keys(selectedIds).filter(function (k) { return selectedIds[k]; }).length; }

  function setSelectMode(on) {
    selectMode = on;
    editingId = null;
    if (!on) selectedIds = {};
    selectModeBtn.textContent = on ? "선택 취소" : "선택";
    bulkBar.style.display = on ? "flex" : "none";
    recordsHint.style.display = on ? "none" : "";
    renderRecords();
  }
  selectModeBtn.addEventListener("click", function () { setSelectMode(!selectMode); });
  document.getElementById("bulk-cancel-btn").addEventListener("click", function () { setSelectMode(false); });
  document.getElementById("bulk-apply-btn").addEventListener("click", function () {
    var store = bulkStoreInput.value.trim();
    var ids = Object.keys(selectedIds).filter(function (k) { return selectedIds[k]; });
    if (!store || !ids.length) return;
    bulkSetStore(ids, store);
    setSelectMode(false);
  });

  function fmtWon(n) { return Number(n || 0).toLocaleString("ko-KR") + "원"; }
  function fmtDateShort(d) {
    if (!d) return "";
    var parts = d.split("-");
    return parts.length === 3 ? parts[1] + "." + parts[2] : d;
  }

  function renderEditRow(r) {
    var amount = r.qtyAmount, unit = r.qtyUnit;
    if (!(isFinite(amount) && amount > 0 && unit)) {
      var detected = parseQtyToken(r.qty) || parseQtyToken(r.itemName);
      if (detected) { amount = detected.amount; unit = detected.unit; }
    }
    var unitOptions = ["", "g", "kg", "ml", "l", "ea"].map(function (u) {
      var label = u === "" ? "단위 없음" : (u === "ea" ? "개" : u);
      return '<option value="' + u + '"' + (u === (unit || "") ? " selected" : "") + ">" + label + "</option>";
    }).join("");
    var photoUrl = getPhotoUrl(r.photoId);
    return '<div class="rec-edit" data-id="' + escAttr(r.id) + '">' +
      '<div class="field"><label>상품명</label><input type="text" class="ed-name" value="' + escAttr(r.itemName) + '"/></div>' +
      '<div class="row2">' +
      '<div class="field"><label>구매처</label><input type="text" class="ed-store" list="dl-stores" value="' + escAttr(r.store) + '"/></div>' +
      '<div class="field"><label>날짜</label><input type="date" class="ed-date" value="' + escAttr(r.date) + '"/></div>' +
      "</div>" +
      '<div class="field"><label>가격 (원)</label><input type="number" class="ed-price price-input" value="' + (isFinite(r.price) ? r.price : "") + '"/></div>' +
      '<div class="row2">' +
      '<div class="field"><label>수량</label><input type="number" class="ed-qty-amount price-input" min="0" step="any" value="' + (amount || "") + '"/></div>' +
      '<div class="field"><label>단위</label><select class="ed-qty-unit">' + unitOptions + "</select></div>" +
      "</div>" +
      '<p class="hint ed-unit-preview" style="margin:-6px 0 10px;"></p>' +
      '<div class="field"><label>사진</label>' +
      (photoUrl ? '<img class="ed-photo-preview" src="' + escAttr(photoUrl) + '"/>' : "") +
      '<input type="file" accept="image/*" class="ed-photo-input"/>' +
      '<button type="button" class="btn btn-ghost ed-photo-remove" style="margin-top:8px;' + (photoUrl ? "" : "display:none;") + '">사진 제거</button>' +
      "</div>" +
      '<div class="actions">' +
      '<button type="button" class="btn btn-primary ed-save">저장</button>' +
      '<button type="button" class="btn btn-ghost ed-cancel">취소</button>' +
      '<button type="button" class="btn btn-ghost ed-delete" style="color:var(--warn);">삭제</button>' +
      "</div>" +
      "</div>";
  }

  function renderRecords() {
    var listEl = document.getElementById("records-list");
    var q = (searchInput.value || "").trim().toLowerCase();
    var items = state.purchases.filter(function (r) {
      if (!q) return true;
      return (r.itemName || "").toLowerCase().indexOf(q) >= 0 || (r.store || "").toLowerCase().indexOf(q) >= 0;
    });

    if (!items.length) {
      listEl.innerHTML = '<div class="empty"><div class="glyph">🧺</div>' +
        (state.purchases.length ? "검색 결과가 없어요" : "아직 기록이 없어요.<br>'추가' 탭에서 첫 구매를 기록해보세요.") +
        "</div>";
      return;
    }

    if (selectMode) bulkCount.textContent = selectedCount() + "개 선택";

    var byDate = {};
    var order = [];
    items.forEach(function (r) {
      var d = r.date || "날짜 미상";
      if (!byDate[d]) { byDate[d] = []; order.push(d); }
      byDate[d].push(r);
    });
    order.sort().reverse();

    var html = "";
    order.forEach(function (d) {
      html += '<div class="day-group"><h3>' + escAttr(d) + "</h3>";
      byDate[d].forEach(function (r) {
        if (editingId === r.id) {
          html += renderEditRow(r);
          return;
        }
        var checked = selectMode && selectedIds[r.id] ? " checked" : "";
        var unitInfo = unitPriceInfo(r);
        var unitBit = unitInfo ? " · " + unitInfo.label + " " + fmtWon(Math.round(unitInfo.value)) : "";
        var photoUrl = getPhotoUrl(r.photoId);
        html += '<div class="rec" data-id="' + escAttr(r.id) + '">' +
          (selectMode ? '<input type="checkbox" class="rec-check"' + checked + ' data-id="' + escAttr(r.id) + '"/>' : "") +
          (photoUrl ? '<img class="rec-thumb" src="' + escAttr(photoUrl) + '" alt=""/>' : "") +
          '<div class="rec-main" data-id="' + escAttr(r.id) + '" style="cursor:pointer;">' +
          '<p class="rec-name">' + escAttr(r.itemName) + "</p>" +
          '<p class="rec-sub">' + escAttr(r.store) + (r.qty ? " · " + escAttr(r.qty) : "") + escHtml(unitBit) + "</p>" +
          "</div>" +
          '<div style="display:flex;align-items:center;gap:10px;">' +
          '<span class="rec-price">' + fmtWon(r.price) + "</span>" +
          (selectMode ? "" : '<button class="rec-del" aria-label="삭제" data-id="' + escAttr(r.id) + '">×</button>') +
          "</div>" +
          "</div>";
      });
      html += "</div>";
    });
    listEl.innerHTML = html;

    listEl.querySelectorAll(".rec-del").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.dataset.id;
        if (confirm("이 기록을 삭제할까요?")) deletePurchase(id);
      });
    });

    listEl.querySelectorAll(".rec-check").forEach(function (cb) {
      cb.addEventListener("change", function () {
        selectedIds[cb.dataset.id] = cb.checked;
        bulkCount.textContent = selectedCount() + "개 선택";
      });
    });

    listEl.querySelectorAll(".rec-main").forEach(function (el) {
      el.addEventListener("click", function () {
        if (selectMode) {
          var cb = el.parentElement.querySelector(".rec-check");
          if (cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event("change")); }
          return;
        }
        editingId = el.dataset.id;
        renderRecords();
      });
    });

    listEl.querySelectorAll(".rec-edit").forEach(function (row) {
      var id = row.dataset.id;
      var edAmount = row.querySelector(".ed-qty-amount");
      var edUnit = row.querySelector(".ed-qty-unit");
      var edPreview = row.querySelector(".ed-unit-preview");
      function updateEdPreview() {
        var amount = Number(edAmount.value);
        var unit = edUnit.value;
        var price = Number(row.querySelector(".ed-price").value);
        if (!(isFinite(amount) && amount > 0 && unit) || !isFinite(price) || price <= 0) {
          edPreview.textContent = "";
          return;
        }
        var info = unitPriceInfo({ price: price, qtyAmount: amount, qtyUnit: unit });
        edPreview.textContent = info ? "≈ " + info.label + " " + fmtWon(Math.round(info.value)) : "";
      }
      [edAmount, edUnit, row.querySelector(".ed-price")].forEach(function (el) {
        el.addEventListener("input", updateEdPreview);
      });
      updateEdPreview();

      var record = state.purchases.find(function (p) { return p.id === id; });
      var currentPhotoId = record ? record.photoId : null;
      var pendingPhoto = { changed: false, dataUrl: null }; // changed+dataUrl=null means "removed"
      var edPhotoInput = row.querySelector(".ed-photo-input");
      var edPhotoRemove = row.querySelector(".ed-photo-remove");
      var photoField = edPhotoInput.parentElement;

      edPhotoInput.addEventListener("change", async function () {
        var f = edPhotoInput.files && edPhotoInput.files[0];
        if (!f) return;
        var dataUrl;
        try { dataUrl = await fileToThumbnailDataUrl(f, 480, 0.75); } catch (e) { console.warn("photo resize failed", e); return; }
        pendingPhoto = { changed: true, dataUrl: dataUrl };
        var img = photoField.querySelector(".ed-photo-preview");
        if (!img) {
          img = document.createElement("img");
          img.className = "ed-photo-preview";
          photoField.insertBefore(img, edPhotoInput);
        }
        img.src = dataUrl;
        edPhotoRemove.style.display = "";
      });
      edPhotoRemove.addEventListener("click", function () {
        pendingPhoto = { changed: true, dataUrl: null };
        var img = photoField.querySelector(".ed-photo-preview");
        if (img) img.remove();
        edPhotoInput.value = "";
        edPhotoRemove.style.display = "none";
      });

      row.querySelector(".ed-cancel").addEventListener("click", function () { editingId = null; renderRecords(); });
      row.querySelector(".ed-delete").addEventListener("click", function () {
        if (confirm("이 기록을 삭제할까요?")) { editingId = null; deletePurchase(id); }
      });
      row.querySelector(".ed-save").addEventListener("click", function () {
        var name = row.querySelector(".ed-name").value.trim();
        var store = row.querySelector(".ed-store").value.trim();
        var price = Number(row.querySelector(".ed-price").value);
        var date = row.querySelector(".ed-date").value;
        var qtyAmount = edAmount.value ? Number(edAmount.value) : null;
        var qtyUnit = edUnit.value || null;
        if (!name || !store || !isFinite(price)) return;
        var photoId = pendingPhoto.changed
          ? (pendingPhoto.dataUrl ? storePhotoDataUrl(pendingPhoto.dataUrl) : null)
          : currentPhotoId;
        editingId = null;
        updatePurchase(id, {
          itemName: name, store: store, price: price, date: date,
          qty: qtyDisplay(qtyAmount, qtyUnit), qtyAmount: qtyAmount, qtyUnit: qtyUnit,
          photoId: photoId,
        });
      });
    });
  }

  // ---------- compare ----------
  var cmpInput = document.getElementById("cmp-select");
  var updateCmpQuickSearch = wireQuickSearch("cmp-quick-search", "cmp-qs", function () { return cmpInput.value; });
  cmpInput.addEventListener("input", function () { renderCompare(); updateCmpQuickSearch(); });

  function renderCompare() {
    var resultEl2 = document.getElementById("compare-result");
    var q = (cmpInput.value || "").trim().toLowerCase();
    if (!q) {
      resultEl2.innerHTML = '<div class="empty"><div class="glyph">⚖️</div>비교할 상품명을 입력해보세요</div>';
      return;
    }
    var matches = state.purchases.filter(function (r) { return (r.itemName || "").toLowerCase().indexOf(q) >= 0; });
    if (!matches.length) {
      resultEl2.innerHTML = '<div class="empty"><div class="glyph">⚖️</div>‘' + escAttr(cmpInput.value) + '’ 기록이 아직 없어요</div>';
      return;
    }

    var byStore = {};
    matches.forEach(function (r) {
      var key = r.store || "미지정";
      if (!byStore[key] || (r.date || "") > (byStore[key].date || "")) byStore[key] = r;
    });
    var rows = Object.keys(byStore).map(function (k) { return byStore[k]; });

    // if every row has a per-100g/100ml unit price and they're all the same
    // basis (weight vs. volume), that's the fairer comparison across
    // different pack sizes — rank by that instead of the raw price.
    var rowInfos = rows.map(function (r) { return { r: r, info: unitPriceInfo(r) }; });
    var basisSet = {};
    rowInfos.forEach(function (x) { if (x.info) basisSet[x.info.basis] = true; });
    var basisKeys = Object.keys(basisSet);
    var useUnitBasis = rowInfos.every(function (x) { return x.info; }) &&
      basisKeys.length === 1 && (basisKeys[0] === "weight" || basisKeys[0] === "volume");

    if (useUnitBasis) {
      rows.sort(function (a, b) { return unitPriceInfo(a).value - unitPriceInfo(b).value; });
    } else {
      rows.sort(function (a, b) { return a.price - b.price; });
    }

    var prices = matches.map(function (r) { return r.price; });
    var min = Math.min.apply(null, prices);
    var max = Math.max.apply(null, prices);
    var avg = Math.round(prices.reduce(function (a, b) { return a + b; }, 0) / prices.length);

    var html = "";
    if (useUnitBasis) {
      html += '<div class="banner">팩 크기가 서로 달라서 ' + rowInfos[0].info.label + ' 가격 기준으로 비교했어요.</div>';
    }
    html += '<div class="stat-row">' +
      '<div class="stat-tile best"><div class="k">최저가</div><div class="v">' + fmtWon(min) + "</div></div>" +
      '<div class="stat-tile"><div class="k">평균가</div><div class="v">' + fmtWon(avg) + "</div></div>" +
      '<div class="stat-tile"><div class="k">최고가</div><div class="v">' + fmtWon(max) + "</div></div>" +
      "</div>";

    rows.forEach(function (r, i) {
      var info = unitPriceInfo(r);
      var unitBit = info ? " · " + info.label + " " + fmtWon(Math.round(info.value)) : "";
      html += '<div class="cmp-row' + (i === 0 ? " best" : "") + '">' +
        '<div><span class="cmp-store">' + escAttr(r.store) + "</span>" +
        (i === 0 ? '<span class="badge">' + (useUnitBasis ? info.label + " 최저" : "최저가") + "</span>" : "") +
        '<div class="cmp-date">' + fmtDateShort(r.date) + (r.qty ? " · " + escAttr(r.qty) : "") + escHtml(unitBit) + "</div></div>" +
        '<span class="cmp-price">' + fmtWon(r.price) + "</span>" +
        "</div>";
    });
    resultEl2.innerHTML = html;
  }

  // ---------- datalists ----------
  function renderDatalists() {
    var items = Array.from(new Set(state.purchases.map(function (r) { return r.itemName; }).filter(Boolean)));
    var stores = Array.from(new Set(state.purchases.map(function (r) { return r.store; }).filter(Boolean)));
    var dlItems = document.getElementById("dl-items");
    var dlItemsCmp = document.getElementById("dl-items-cmp");
    var dlStores = document.getElementById("dl-stores");
    dlItems.innerHTML = items.map(function (i) { return '<option value="' + escAttr(i) + '">'; }).join("");
    dlItemsCmp.innerHTML = dlItems.innerHTML;
    dlStores.innerHTML = stores.map(function (s) { return '<option value="' + escAttr(s) + '">'; }).join("");
  }

  renderAll();
})();
