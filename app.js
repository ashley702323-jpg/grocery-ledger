(function () {
  "use strict";

  // ---------- service worker + install prompt ----------
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function (e) { console.warn("sw register failed", e); });
    });
  }
  var deferredInstallPrompt = null;
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferredInstallPrompt = e;
    document.getElementById("installbar").classList.add("show");
  });
  document.getElementById("install-btn").addEventListener("click", async function () {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    document.getElementById("installbar").classList.remove("show");
  });
  window.addEventListener("appinstalled", function () {
    document.getElementById("installbar").classList.remove("show");
  });

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

  manualForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var name = document.getElementById("f-name").value.trim();
    var store = document.getElementById("f-store").value.trim();
    var price = Number(document.getElementById("f-price").value);
    var date = document.getElementById("f-date").value;
    var qty = document.getElementById("f-qty").value.trim();
    var note = document.getElementById("f-note").value.trim();
    if (!name || !store || !isFinite(price)) return;

    addPurchase({ itemName: name, store: store, price: price, date: date, qty: qty, note: note, source: "manual" });
    manualForm.reset();
    document.getElementById("f-date").value = new Date().toISOString().slice(0, 10);
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

  analyzeBtn.addEventListener("click", async function () {
    if (!currentFile || typeof Tesseract === "undefined") return;
    analyzeBtn.disabled = true;
    resultEl.innerHTML = "";
    statusEl.innerHTML =
      '<div class="status-line"><span class="spinner"></span><span id="ocr-status-text">인식 엔진을 준비하는 중...</span></div>' +
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

    try {
      var result = await Tesseract.recognize(currentFile, "kor+eng", {
        logger: function (m) {
          if (m.progress != null) progressFill.style.width = Math.round(m.progress * 100) + "%";
          if (m.status) statusText.textContent = (STAGE_LABEL[m.status] || m.status) + "...";
        },
      });
      var text = (result && result.data && result.data.text) || "";
      statusEl.innerHTML = "";
      renderParsedResult(text);
    } catch (err) {
      console.warn("ocr failed", err);
      statusEl.innerHTML = '<div class="banner warn">인식에 실패했어요. 네트워크 상태를 확인하거나 다른 사진으로 시도해주세요.</div>';
    } finally {
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
  var PRICE_RE = /([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,})\s*원?\s*$/;
  var QTY_RE = /(?:^|\s)([0-9]+)\s*[xX×]\s*/;
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
      namePart = namePart.replace(/[\-*.]{2,}$/, "").replace(/^\d+\s+/, "").trim();
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
        return {
          itemName: r.querySelector(".pr-name").value.trim(),
          price: Number(r.querySelector(".pr-price").value),
          qty: r.querySelector(".pr-qty").value.trim(),
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

  function fmtWon(n) { return Number(n || 0).toLocaleString("ko-KR") + "원"; }
  function fmtDateShort(d) {
    if (!d) return "";
    var parts = d.split("-");
    return parts.length === 3 ? parts[1] + "." + parts[2] : d;
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
        html += '<div class="rec" data-id="' + escAttr(r.id) + '">' +
          '<div class="rec-main">' +
          '<p class="rec-name">' + escAttr(r.itemName) + "</p>" +
          '<p class="rec-sub">' + escAttr(r.store) + (r.qty ? " · " + escAttr(r.qty) : "") + "</p>" +
          "</div>" +
          '<div style="display:flex;align-items:center;gap:10px;">' +
          '<span class="rec-price">' + fmtWon(r.price) + "</span>" +
          '<button class="rec-del" aria-label="삭제" data-id="' + escAttr(r.id) + '">×</button>' +
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
  }

  // ---------- compare ----------
  var cmpInput = document.getElementById("cmp-select");
  cmpInput.addEventListener("input", renderCompare);

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
    rows.sort(function (a, b) { return a.price - b.price; });

    var prices = matches.map(function (r) { return r.price; });
    var min = Math.min.apply(null, prices);
    var max = Math.max.apply(null, prices);
    var avg = Math.round(prices.reduce(function (a, b) { return a + b; }, 0) / prices.length);

    var html = '<div class="stat-row">' +
      '<div class="stat-tile best"><div class="k">최저가</div><div class="v">' + fmtWon(min) + "</div></div>" +
      '<div class="stat-tile"><div class="k">평균가</div><div class="v">' + fmtWon(avg) + "</div></div>" +
      '<div class="stat-tile"><div class="k">최고가</div><div class="v">' + fmtWon(max) + "</div></div>" +
      "</div>";

    rows.forEach(function (r, i) {
      html += '<div class="cmp-row' + (i === 0 ? " best" : "") + '">' +
        '<div><span class="cmp-store">' + escAttr(r.store) + "</span>" + (i === 0 ? '<span class="badge">최저가</span>' : "") +
        '<div class="cmp-date">' + fmtDateShort(r.date) + (r.qty ? " · " + escAttr(r.qty) : "") + "</div></div>" +
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
