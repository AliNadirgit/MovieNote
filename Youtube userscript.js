// ==UserScript==
// @name         Film Kelime Defteri — YouTube Altyazı Asistanı
// @namespace    fkd-youtube
// @version      1.0
// @description  YouTube altyazısında kelimeye tıkla → çeviri gör → ⭐ ile kaydet → JSON olarak Kelime Defteri'ne aktar
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @connect      api.groq.com
// @connect      generativelanguage.googleapis.com
// @connect      www.youtube.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  /* ================================================================
     Depolama anahtarları (GM storage — youtube.com origin'inde)
     Export şeması PWA'daki LS_FILMS ile birebir aynı:
     { "Film Adı": { words: [{word,meaning}], quotes: [{line,context}] } }
  ================================================================ */
  const GM_EXPORT = "fkd_export";
  const GM_KEYS = "fkd_keys";
  const gmFilmKey = (videoId) => `fkd_film_${videoId}`; // video → film adı eşlemesi

  const HAS_HOVER = window.matchMedia("(hover: hover)").matches; // PC mi mobil mi

  /* ================================================================
     AI çeviri — Groq → Gemini fallback (GM_xmlhttpRequest ile, CORS yok)
  ================================================================ */
  function gmFetchJson(opts) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST",
        url: opts.url,
        headers: opts.headers,
        data: JSON.stringify(opts.body),
        onload: (res) => {
          if (res.status < 200 || res.status >= 300) {
            reject(new Error(`HTTP ${res.status}`));
            return;
          }
          try { resolve(JSON.parse(res.responseText)); }
          catch (e) { reject(e); }
        },
        onerror: () => reject(new Error("Ağ hatası")),
        ontimeout: () => reject(new Error("Zaman aşımı")),
        timeout: 20000,
      });
    });
  }

  const translationCache = new Map(); // aynı kelimeyi tekrar sormamak için

  async function translate(text) {
    if (translationCache.has(text)) return translationCache.get(text);
    const keys = GM_getValue(GM_KEYS, {});
    const prompt = `Şu kelimeyi/cümleyi Türkçeye çevir, sadece çeviriyi döndür, başka açıklama ekleme: ${text}`;

    const providers = [];
    if (keys.groq) {
      providers.push(async () => {
        const data = await gmFetchJson({
          url: "https://api.groq.com/openai/v1/chat/completions",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${keys.groq}` },
          body: { model: "llama-3.3-70b-versatile", messages: [{ role: "user", content: prompt }] },
        });
        return data.choices?.[0]?.message?.content?.trim();
      });
    }
    if (keys.gemini) {
      providers.push(async () => {
        const data = await gmFetchJson({
          url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${keys.gemini}` },
          body: { model: "gemini-2.5-flash", messages: [{ role: "user", content: prompt }] },
        });
        return data.choices?.[0]?.message?.content?.trim();
      });
    }
    if (providers.length === 0) throw new Error("NO_KEYS");

    for (const fn of providers) {
      try {
        const result = await fn();
        if (result) { translationCache.set(text, result); return result; }
      } catch (err) { console.warn("[FKD] sağlayıcı başarısız, sıradaki deneniyor", err); }
    }
    throw new Error("Tüm sağlayıcılar başarısız");
  }

  /* ================================================================
     Altyazı track'ini çekme
     1) movie_player.getPlayerResponse() (varsa)
     2) unsafeWindow.ytInitialPlayerResponse
     3) watch sayfası HTML'inden regex ile
  ================================================================ */
  function getVideoId() {
    return new URLSearchParams(location.search).get("v");
  }

  async function getPlayerResponse() {
    const player = document.getElementById("movie_player");
    try {
      const pr = player?.getPlayerResponse?.() || player?.wrappedJSObject?.getPlayerResponse?.();
      if (pr?.captions) return pr;
    } catch (_) {}
    try {
      const w = (typeof unsafeWindow !== "undefined" ? unsafeWindow : window);
      const pr = w.ytInitialPlayerResponse;
      if (pr?.videoDetails?.videoId === getVideoId() && pr?.captions) return pr;
    } catch (_) {}
    // Son çare: sayfayı yeniden çek ve parse et
    const res = await fetch(location.href, { credentials: "same-origin" });
    const html = await res.text();
    const m = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});(?:\s*var\s|\s*<\/script>)/s);
    if (m) { try { return JSON.parse(m[1]); } catch (_) {} }
    return null;
  }

  async function fetchCaptionTrack() {
    const pr = await getPlayerResponse();
    const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks || tracks.length === 0) return null;
    // Otomatik (asr) olmayan track'i tercih et, yoksa ilkini al
    const track = tracks.find(t => t.kind !== "asr") || tracks[0];
    const url = track.baseUrl + "&fmt=json3";
    const res = await fetch(url, { credentials: "same-origin" });
    if (!res.ok) return null;
    const data = await res.json();
    // json3: events[{tStartMs, dDurMs, segs:[{utf8}]}] → sadeleştir
    return (data.events || [])
      .filter(e => e.segs && e.segs.some(s => (s.utf8 || "").trim()))
      .map(e => ({
        start: e.tStartMs,
        end: e.tStartMs + (e.dDurMs || 3000),
        text: e.segs.map(s => s.utf8 || "").join("").replace(/\n/g, " ").trim(),
      }))
      .filter(e => e.text);
  }

  /* ================================================================
     UI — stiller
  ================================================================ */
  const css = document.createElement("style");
  css.textContent = `
    .fkd-overlay {
      position: absolute; left: 50%; bottom: 60px; transform: translateX(-50%);
      max-width: 88%; z-index: 60; text-align: center;
      background: rgba(0,0,0,.75); border-radius: 8px; padding: 6px 12px;
      font-size: clamp(16px, 2.4vw, 24px); line-height: 1.5; color: #f4f2ec;
      font-family: "YouTube Noto", Roboto, sans-serif; cursor: default;
    }
    .fkd-word { cursor: pointer; border-radius: 4px; padding: 0 1px; }
    .fkd-word:hover { background: rgba(232,180,74,.35); }
    .fkd-popup {
      position: absolute; left: 50%; bottom: 130px; transform: translateX(-50%);
      z-index: 61; background: #17171d; color: #edeae4;
      border: 1px solid #2a2a33; border-radius: 12px; padding: 12px 16px;
      max-width: 80%; font-size: 15px; font-family: Roboto, sans-serif;
      box-shadow: 0 8px 24px rgba(0,0,0,.6); text-align: left;
    }
    .fkd-popup .fkd-src { color: #e8b44a; font-weight: 600; margin-bottom: 4px; }
    .fkd-popup .fkd-row { display: flex; align-items: center; gap: 10px; }
    .fkd-star {
      cursor: pointer; font-size: 20px; background: none; border: none;
      filter: grayscale(1); transition: filter .15s;
    }
    .fkd-star:hover, .fkd-star.saved { filter: none; }
    .fkd-close { position: absolute; top: 4px; right: 8px; cursor: pointer; color: #8f8f9a; background: none; border: none; font-size: 14px; }
    .fkd-panel {
      position: fixed; right: 12px; bottom: 12px; z-index: 9999;
      background: #17171d; color: #edeae4; border: 1px solid #2a2a33;
      border-radius: 12px; padding: 10px 14px; font-size: 13px;
      font-family: Roboto, sans-serif; box-shadow: 0 8px 24px rgba(0,0,0,.5);
    }
    .fkd-panel button {
      background: #e8b44a; color: #1a1305; border: none; border-radius: 8px;
      padding: 5px 10px; margin: 6px 6px 0 0; font-size: 12px; font-weight: 600; cursor: pointer;
    }
    .fkd-panel .fkd-panel-close { background: none; color: #8f8f9a; padding: 0 4px; position: absolute; top: 6px; right: 6px; margin: 0; }
    .fkd-toast {
      position: fixed; left: 50%; bottom: 80px; transform: translateX(-50%);
      z-index: 10000; background: #1f1f27; color: #edeae4;
      border: 1px solid #2a2a33; border-radius: 999px; padding: 8px 18px;
      font-size: 14px; font-family: Roboto, sans-serif;
    }
    /* YouTube'un kendi altyazısını gizle (bizimki aktifken) */
    .fkd-active .ytp-caption-window-container { display: none !important; }
  `;
  document.documentElement.appendChild(css);

  let toastTimer;
  function toast(msg, ms = 2200) {
    document.querySelector(".fkd-toast")?.remove();
    const el = document.createElement("div");
    el.className = "fkd-toast";
    el.textContent = msg;
    document.body.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), ms);
  }

  /* ================================================================
     Kaydetme — LS_FILMS şemasıyla aynı yapıda GM export deposu
  ================================================================ */
  function getFilmNameForVideo() {
    const videoId = getVideoId();
    let name = GM_getValue(gmFilmKey(videoId), "");
    if (!name) {
      name = prompt("Bu videoda hangi filmi/diziyi izliyorsun? (Kelime Defteri'ndeki isimle aynı yaz)");
      if (!name) return null;
      name = name.trim();
      GM_setValue(gmFilmKey(videoId), name);
    }
    return name;
  }

  function saveEntry(originalText, translation) {
    const filmName = getFilmNameForVideo();
    if (!filmName) return false;
    const store = GM_getValue(GM_EXPORT, {});
    if (!store[filmName]) store[filmName] = { words: [], quotes: [] };
    const film = store[filmName];

    const isSingleWord = !/\s/.test(originalText.trim());
    if (isSingleWord) {
      if (!film.words.some(w => w.word.toLowerCase() === originalText.toLowerCase())) {
        film.words.push({ word: originalText, meaning: translation });
      }
    } else {
      const videoTitle = document.title.replace(/ - YouTube$/, "");
      if (!film.quotes.some(q => q.line === originalText)) {
        film.quotes.push({ line: originalText, context: `YouTube — ${videoTitle} · ${translation}` });
      }
    }
    GM_setValue(GM_EXPORT, store);
    updatePanel();
    return true;
  }

  /* ================================================================
     Popup (çeviri + yıldız)
  ================================================================ */
  function showPopup(playerEl, originalText) {
    playerEl.querySelector(".fkd-popup")?.remove();
    const pop = document.createElement("div");
    pop.className = "fkd-popup";
    pop.innerHTML = `
      <button class="fkd-close">✕</button>
      <div class="fkd-src"></div>
      <div class="fkd-row"><span class="fkd-meaning">Çevriliyor…</span>
      <button class="fkd-star" title="Deftere kaydet">⭐</button></div>`;
    pop.querySelector(".fkd-src").textContent = originalText;
    playerEl.appendChild(pop);

    pop.querySelector(".fkd-close").addEventListener("click", () => pop.remove());

    translate(originalText).then(tr => {
      pop.querySelector(".fkd-meaning").textContent = tr;
      const star = pop.querySelector(".fkd-star");
      star.addEventListener("click", () => {
        if (saveEntry(originalText, tr)) {
          star.classList.add("saved");
          toast("Kaydedildi ⭐");
        }
      });
    }).catch(err => {
      pop.querySelector(".fkd-meaning").textContent =
        err.message === "NO_KEYS"
          ? "API anahtarı yok — Tampermonkey menüsünden ekle."
          : "Çeviri alınamadı, tekrar dene.";
    });
  }

  /* ================================================================
     Altyazı overlay'i
  ================================================================ */
  let captions = null;
  let currentVideoId = null;
  let overlayEl = null;
  let lastLineText = "";

  function buildOverlay(playerEl) {
    overlayEl?.remove();
    overlayEl = document.createElement("div");
    overlayEl.className = "fkd-overlay";
    overlayEl.style.display = "none";
    playerEl.appendChild(overlayEl);

    // Satırın tamamının çevirisi: PC'de çift tık, mobilde satır boşluğuna tek tık
    const lineHandler = () => {
      const video = playerEl.querySelector("video");
      video?.pause();
      if (lastLineText) showPopup(playerEl, lastLineText);
    };
    if (HAS_HOVER) overlayEl.addEventListener("dblclick", lineHandler);
    else overlayEl.addEventListener("click", (e) => {
      if (e.target === overlayEl) lineHandler(); // kelime span'ı değil, boşluk
    });
  }

  function renderLine(playerEl, text) {
    if (text === lastLineText) return;
    lastLineText = text;
    overlayEl.innerHTML = "";
    if (!text) { overlayEl.style.display = "none"; return; }
    overlayEl.style.display = "block";

    for (const token of text.split(/\s+/)) {
      const span = document.createElement("span");
      span.className = "fkd-word";
      span.textContent = token;
      const wordHandler = (e) => {
        e.stopPropagation();
        playerEl.querySelector("video")?.pause();
        // Noktalama işaretlerini temizleyip çevir
        const clean = token.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "");
        if (clean) showPopup(playerEl, clean);
      };
      if (HAS_HOVER) span.addEventListener("mouseenter", wordHandler);
      else span.addEventListener("click", wordHandler);
      overlayEl.appendChild(span);
      overlayEl.appendChild(document.createTextNode(" "));
    }
  }

  function tick() {
    const playerEl = document.getElementById("movie_player");
    const video = playerEl?.querySelector("video");
    if (!playerEl || !video || !captions || !overlayEl) return;
    const tMs = video.currentTime * 1000;
    const ev = captions.find(e => tMs >= e.start && tMs < e.end);
    renderLine(playerEl, ev ? ev.text : "");
  }

  /* ================================================================
     Export paneli
  ================================================================ */
  let panelEl = null;

  function countStore() {
    const store = GM_getValue(GM_EXPORT, {});
    let words = 0, quotes = 0;
    for (const f of Object.values(store)) {
      words += (f.words || []).length;
      quotes += (f.quotes || []).length;
    }
    return { words, quotes };
  }

  function updatePanel() {
    if (!panelEl) return;
    const { words, quotes } = countStore();
    panelEl.querySelector(".fkd-panel-count").textContent =
      `Toplanan: ${words} kelime, ${quotes} replik`;
  }

  function showPanel() {
    panelEl?.remove();
    panelEl = document.createElement("div");
    panelEl.className = "fkd-panel";
    panelEl.innerHTML = `
      <button class="fkd-panel-close">✕</button>
      <div class="fkd-panel-count"></div>
      <button class="fkd-copy">Kopyala</button>
      <button class="fkd-clear">Temizle</button>`;
    document.body.appendChild(panelEl);
    updatePanel();

    panelEl.querySelector(".fkd-panel-close").addEventListener("click", () => panelEl.remove());
    panelEl.querySelector(".fkd-copy").addEventListener("click", () => {
      const store = GM_getValue(GM_EXPORT, {});
      if (Object.keys(store).length === 0) { toast("Kopyalanacak veri yok."); return; }
      GM_setClipboard(JSON.stringify(store, null, 2));
      toast("JSON panoya kopyalandı — Kelime Defteri > Ayarlar > İçe Aktar'a yapıştır.");
    });
    panelEl.querySelector(".fkd-clear").addEventListener("click", () => {
      if (!confirm("Toplanan tüm veriler silinsin mi? (Önce PWA'ya aktardığından emin ol)")) return;
      GM_setValue(GM_EXPORT, {});
      updatePanel();
      toast("Temizlendi.");
    });
  }

  /* ================================================================
     Menü komutları
  ================================================================ */
  GM_registerMenuCommand("API Anahtarlarını Ayarla", () => {
    const keys = GM_getValue(GM_KEYS, {});
    const groq = prompt("Groq API Key (boş bırakılabilir):", keys.groq || "");
    if (groq === null) return;
    const gemini = prompt("Gemini API Key (boş bırakılabilir):", keys.gemini || "");
    if (gemini === null) return;
    GM_setValue(GM_KEYS, { groq: groq.trim(), gemini: gemini.trim() });
    toast("Anahtarlar kaydedildi.");
  });
  GM_registerMenuCommand("Paneli Göster", showPanel);
  GM_registerMenuCommand("Bu videonun film adını değiştir", () => {
    const videoId = getVideoId();
    if (!videoId) { toast("Video sayfasında değilsin."); return; }
    const name = prompt("Film/dizi adı:", GM_getValue(gmFilmKey(videoId), ""));
    if (name !== null) GM_setValue(gmFilmKey(videoId), name.trim());
  });

  /* ================================================================
     Başlatma & SPA navigasyon takibi
  ================================================================ */
  async function initForVideo() {
    const videoId = getVideoId();
    if (!videoId || videoId === currentVideoId) return;
    currentVideoId = videoId;
    captions = null;
    lastLineText = "";
    document.documentElement.classList.remove("fkd-active");

    const playerEl = document.getElementById("movie_player");
    if (!playerEl) return;

    captions = await fetchCaptionTrack();
    if (!captions || captions.length === 0) {
      console.warn("[FKD] Bu videoda altyazı track'i bulunamadı.");
      return;
    }
    buildOverlay(playerEl);
    document.documentElement.classList.add("fkd-active"); // YouTube altyazısını gizle
    toast("Kelime Defteri altyazısı aktif — kelimeye " + (HAS_HOVER ? "gel" : "dokun") + ".");
  }

  // YouTube SPA — sayfa değişimini yakala
  window.addEventListener("yt-navigate-finish", () => setTimeout(initForVideo, 800));
  setInterval(tick, 200);          // altyazı senkronu
  setTimeout(initForVideo, 1500);  // ilk yükleme
  showPanel();                      // panel başta açık, ✕ ile kapatılabilir
})();