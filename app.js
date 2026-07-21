/* ==================================================================
   Film Kelime Defteri — vanilla JS
   Modüller: storage · toast · router · tmdb · ai · chat · collect · screens
================================================================== */

/* ---------------- storage ---------------- */
const LS_FILMS = "fkd_films";
const LS_KEYS  = "fkd_keys";
const LS_CHATS = "fkd_chats"; // geçici sohbetler, "Topla" sonrası temizlenir

const storage = {
  getFilms()      { return JSON.parse(localStorage.getItem(LS_FILMS) || "{}"); },
  saveFilms(f)    { localStorage.setItem(LS_FILMS, JSON.stringify(f)); },
  getKeys()       { return JSON.parse(localStorage.getItem(LS_KEYS) || "{}"); },
  saveKeys(k)     { localStorage.setItem(LS_KEYS, JSON.stringify(k)); },
  getChats()      { return JSON.parse(localStorage.getItem(LS_CHATS) || "{}"); },
  saveChats(c)    { localStorage.setItem(LS_CHATS, JSON.stringify(c)); },
  getChat(name)   { return this.getChats()[name] || []; },
  setChat(name, msgs) { const c = this.getChats(); c[name] = msgs; this.saveChats(c); },
  clearChat(name) { const c = this.getChats(); delete c[name]; this.saveChats(c); },
};

/* ---------------- toast ---------------- */
let toastTimer;
function toast(msg, ms = 3000) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), ms);
}

/* ---------------- yardımcılar ---------------- */
const $ = (id) => document.getElementById(id);
function show(id) { $(id).classList.remove("hidden"); }
function hide(id) { $(id).classList.add("hidden"); }
function esc(s) {
  const d = document.createElement("div");
  d.textContent = String(s ?? "");
  return d.innerHTML;
}
// AI cevabından JSON dizisi çıkar (markdown çitleri vs. temizler)
function parseJsonArray(text) {
  if (!text) return null;
  const clean = text.replace(/```json|```/g, "").trim();
  const start = clean.indexOf("[");
  const end = clean.lastIndexOf("]");
  if (start === -1 || end === -1) return null;
  try {
    const arr = JSON.parse(clean.slice(start, end + 1));
    return Array.isArray(arr) ? arr : null;
  } catch { return null; }
}

/* ==================================================================
   AI PROVIDER SİSTEMİ — Groq → Gemini → OpenRouter fallback
================================================================== */
async function openAICompatCall(url, apiKey, model, messages, extraHeaders = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      ...extraHeaders,
    },
    body: JSON.stringify({ model, messages }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Boş cevap");
  return content;
}

const callGroq = (messages) =>
  openAICompatCall(
    "https://api.groq.com/openai/v1/chat/completions",
    storage.getKeys().groq, "llama-3.3-70b-versatile", messages
  );

// Gemini'nin OpenAI-uyumlu endpoint'i
const callGemini = (messages) =>
  openAICompatCall(
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    storage.getKeys().gemini, "gemini-2.5-flash", messages
  );

const callOpenRouter = (messages) =>
  openAICompatCall(
    "https://openrouter.ai/api/v1/chat/completions",
    storage.getKeys().openrouter, "meta-llama/llama-3.3-70b-instruct:free",
    messages, { "HTTP-Referer": location.origin, "X-Title": "Film Kelime Defteri" }
  );

async function callAI(messages) {
  const keys = storage.getKeys();
  const providers = [
    { name: "groq",       key: keys.groq,       fn: callGroq },
    { name: "gemini",     key: keys.gemini,     fn: callGemini },
    { name: "openrouter", key: keys.openrouter, fn: callOpenRouter },
  ].filter(p => p.key); // boş key'ler atlanır

  if (providers.length === 0) {
    throw new Error("NO_KEYS");
  }
  for (const provider of providers) {
    try {
      const result = await provider.fn(messages);
      return { result, usedProvider: provider.name };
    } catch (err) {
      console.warn(`${provider.name} başarısız, sıradakine geçiliyor`, err);
      continue;
    }
  }
  throw new Error("Tüm AI sağlayıcıları başarısız oldu");
}

/* --- Web search destekli çağrı (replikler için) ---
   1) Gemini native API + google_search grounding
   2) Groq compound modeli (yerleşik web araması)
   İkisi de yoksa: null döner → "Replik bulunamadı" gösterilir, uydurulmaz. */
async function callAIWithSearch(prompt) {
  const keys = storage.getKeys();

  if (keys.gemini) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${keys.gemini}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            tools: [{ google_search: {} }],
          }),
        }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const text = (data.candidates?.[0]?.content?.parts || [])
        .map(p => p.text || "").join("\n");
      if (text) return { result: text, usedProvider: "gemini+search" };
    } catch (err) {
      console.warn("Gemini web search başarısız", err);
    }
  }

  if (keys.groq) {
    try {
      const text = await openAICompatCall(
        "https://api.groq.com/openai/v1/chat/completions",
        keys.groq, "groq/compound-mini",
        [{ role: "user", content: prompt }]
      );
      return { result: text, usedProvider: "groq+search" };
    } catch (err) {
      console.warn("Groq compound (search) başarısız", err);
    }
  }

  return null; // web aramalı sağlayıcı yok / hepsi başarısız
}

/* ==================================================================
   TMDb
================================================================== */
const TMDB_IMG = "https://image.tmdb.org/t/p/w342";

async function tmdbSearch(query) {
  const key = storage.getKeys().tmdb;
  if (!key) throw new Error("NO_TMDB_KEY");
  const url = `https://api.themoviedb.org/3/search/multi?api_key=${encodeURIComponent(key)}&query=${encodeURIComponent(query)}&language=tr-TR`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDb HTTP ${res.status}`);
  const data = await res.json();
  return (data.results || [])
    .filter(r => r.media_type === "movie" || r.media_type === "tv")
    .slice(0, 10);
}

/* ==================================================================
   ROUTER — hash tabanlı basit ekran yönetimi
   #/  #/add  #/chat/<film>  #/film/<film>  #/settings
================================================================== */
const screens = ["screen-home", "screen-add", "screen-chat", "screen-detail", "screen-settings"];

function navigate(hash) { location.hash = hash; }

function route() {
  const hash = location.hash || "#/";
  const [, path, param] = hash.match(/^#\/([^/]*)\/?(.*)$/) || [];
  const filmName = param ? decodeURIComponent(param) : null;

  screens.forEach(hide);
  hide("backBtn");
  $("topbarTitle").textContent = "Kelime Defteri";

  if (path === "add") {
    show("screen-add"); show("backBtn");
    $("topbarTitle").textContent = "Film ekle";
    renderAddScreen();
  } else if (path === "chat" && filmName) {
    show("screen-chat"); show("backBtn");
    $("topbarTitle").textContent = filmName;
    renderChatScreen(filmName);
  } else if (path === "film" && filmName) {
    show("screen-detail"); show("backBtn");
    $("topbarTitle").textContent = "";
    renderDetailScreen(filmName);
  } else if (path === "settings") {
    show("screen-settings"); show("backBtn");
    $("topbarTitle").textContent = "Ayarlar";
    renderSettingsScreen();
  } else {
    show("screen-home");
    renderHomeScreen();
  }
}
window.addEventListener("hashchange", route);

/* ==================================================================
   EKRAN: Ana sayfa
================================================================== */
function renderHomeScreen() {
  const films = storage.getFilms();
  const names = Object.keys(films).sort(
    (a, b) => (films[b].createdAt || "").localeCompare(films[a].createdAt || "")
  );
  const grid = $("filmGrid");
  grid.innerHTML = "";

  if (names.length === 0) { show("homeEmpty"); return; }
  hide("homeEmpty");

  for (const name of names) {
    const f = films[name];
    const card = document.createElement("div");
    card.className = "film-card";
    card.innerHTML = `
      <img src="${esc(f.poster || "")}" alt="${esc(name)}" loading="lazy"
           onerror="this.style.visibility='hidden'">
      <div class="film-card-name">${esc(name)}</div>
      <div class="film-card-count">${(f.words || []).length} kelime · ${(f.quotes || []).length} replik</div>`;
    card.addEventListener("click", () => {
      // Kelime toplanmışsa detay, yoksa chat aç
      const hasContent = (f.words || []).length > 0 || (f.quotes || []).length > 0;
      navigate(hasContent ? `#/film/${encodeURIComponent(name)}` : `#/chat/${encodeURIComponent(name)}`);
    });
    grid.appendChild(card);
  }
}

/* ==================================================================
   EKRAN: Film ekle (TMDb)
================================================================== */
function renderAddScreen() {
  $("tmdbResults").innerHTML = "";
  $("tmdbQuery").value = "";
  storage.getKeys().tmdb ? hide("tmdbHint") : show("tmdbHint");
  $("tmdbQuery").focus();
}

async function doTmdbSearch() {
  const q = $("tmdbQuery").value.trim();
  if (!q) return;
  $("tmdbResults").innerHTML = "";
  show("tmdbLoading");
  try {
    const results = await tmdbSearch(q);
    hide("tmdbLoading");
    if (results.length === 0) {
      $("tmdbResults").innerHTML = `<p class="empty-sub">Sonuç bulunamadı. Farklı bir isim dene.</p>`;
      return;
    }
    for (const r of results) {
      const title = r.title || r.name || "İsimsiz";
      const year = (r.release_date || r.first_air_date || "").slice(0, 4);
      const item = document.createElement("div");
      item.className = "tmdb-item";
      item.innerHTML = `
        <img src="${r.poster_path ? TMDB_IMG + r.poster_path : ""}" alt="">
        <div><div class="t">${esc(title)}</div>
        <div class="y">${esc(year || "—")} · ${r.media_type === "tv" ? "Dizi" : "Film"}</div></div>`;
      item.addEventListener("click", () => addFilm(title, r));
      $("tmdbResults").appendChild(item);
    }
  } catch (err) {
    hide("tmdbLoading");
    if (err.message === "NO_TMDB_KEY") {
      toast("TMDb API anahtarı eksik — Ayarlar'dan ekle.");
    } else {
      toast("TMDb'ye ulaşılamadı, tekrar dene.");
    }
  }
}

function addFilm(title, tmdbResult) {
  const films = storage.getFilms();
  if (films[title]) {
    toast("Bu film zaten ekli.");
    navigate(`#/chat/${encodeURIComponent(title)}`);
    return;
  }
  films[title] = {
    poster: tmdbResult.poster_path ? TMDB_IMG + tmdbResult.poster_path : "",
    tmdbId: tmdbResult.id,
    words: [],
    quotes: [],
    createdAt: new Date().toISOString(),
  };
  storage.saveFilms(films);
  toast(`"${title}" eklendi — izlerken kelimeleri sor.`);
  navigate(`#/chat/${encodeURIComponent(title)}`);
}

/* ==================================================================
   EKRAN: Chat
================================================================== */
let currentChatFilm = null;

function chatSystemPrompt(filmName) {
  return {
    role: "system",
    content:
      `Sen bir dil öğrenme asistanısın. Kullanıcı "${filmName}" adlı film/diziyi izlerken ` +
      `bilmediği İngilizce kelime ve ifadeleri soruyor. Her kelime için kısa ve net Türkçe ` +
      `anlam ver, gerekirse filmdeki bağlama uygun kullanım örneği ekle. Kısa cevap ver, gereksiz uzatma.`,
  };
}

function renderChatScreen(filmName) {
  currentChatFilm = filmName;
  const box = $("chatMessages");
  box.innerHTML = "";
  const msgs = storage.getChat(filmName);
  if (msgs.length === 0) {
    box.innerHTML = `<p class="empty-sub">Bilmediğin kelimeyi yaz — ör. "hunch ne demek?"</p>`;
  } else {
    msgs.forEach(m => appendChatBubble(m.role, m.content, m.provider));
  }
  $("chatInput").value = "";
  hide("collectStatus");
  window.scrollTo(0, document.body.scrollHeight);
}

function appendChatBubble(role, content, provider) {
  const box = $("chatMessages");
  const emptyHint = box.querySelector(".empty-sub");
  if (emptyHint) emptyHint.remove();
  const div = document.createElement("div");
  div.className = `msg ${role === "user" ? "msg-user" : "msg-ai"}`;
  div.textContent = content;
  box.appendChild(div);
  if (provider) {
    const p = document.createElement("div");
    p.className = "msg-provider";
    p.textContent = provider;
    box.appendChild(p);
  }
  window.scrollTo(0, document.body.scrollHeight);
}

async function sendChatMessage() {
  const input = $("chatInput");
  const text = input.value.trim();
  if (!text || !currentChatFilm) return;
  input.value = "";

  const msgs = storage.getChat(currentChatFilm);
  msgs.push({ role: "user", content: text });
  storage.setChat(currentChatFilm, msgs);
  appendChatBubble("user", text);

  show("chatLoading");
  $("chatSendBtn").disabled = true;
  try {
    const apiMessages = [chatSystemPrompt(currentChatFilm), ...msgs.map(m => ({ role: m.role, content: m.content }))];
    const { result, usedProvider } = await callAI(apiMessages);
    msgs.push({ role: "assistant", content: result, provider: usedProvider });
    storage.setChat(currentChatFilm, msgs);
    appendChatBubble("assistant", result, usedProvider);
  } catch (err) {
    if (err.message === "NO_KEYS") {
      toast("Hiç AI anahtarı yok — Ayarlar'dan en az birini ekle.");
    } else {
      toast("AI şu an cevap veremiyor, tekrar dene.");
    }
    // Cevapsız kalan kullanıcı mesajını geri al ki geçmiş tutarlı kalsın
    msgs.pop();
    storage.setChat(currentChatFilm, msgs);
  } finally {
    hide("chatLoading");
    $("chatSendBtn").disabled = false;
  }
}

/* ==================================================================
   "TOPLA" — kelimeleri derle + replikleri web search ile bul
================================================================== */
async function collectFromChat() {
  const filmName = currentChatFilm;
  if (!filmName) return;
  const msgs = storage.getChat(filmName);
  if (msgs.length === 0) { toast("Sohbet boş — önce birkaç kelime sor."); return; }

  const statusEl = $("collectStatus");
  statusEl.innerHTML = `<span class="spinner"></span> Kelimeler derleniyor…`;
  show("collectStatus");
  $("collectBtn").disabled = true;

  const films = storage.getFilms();
  const film = films[filmName];

  try {
    /* --- 1. çağrı: kelimeler (web search gerekmez) --- */
    const transcript = msgs.map(m => `${m.role === "user" ? "Kullanıcı" : "AI"}: ${m.content}`).join("\n");
    const wordsPrompt = [
      { role: "user", content:
        `Aşağıdaki sohbette sorulan tüm kelime/ifadeleri ve anlamlarını JSON formatında listele.\n` +
        `SADECE JSON döndür, başka hiçbir açıklama/markdown ekleme:\n` +
        `[{"word": "...", "meaning": "..."}]\n\nSOHBET:\n${transcript}` },
    ];
    const { result: wordsRaw } = await callAI(wordsPrompt);
    const words = parseJsonArray(wordsRaw);
    if (words) {
      // Var olanlarla birleştir, aynı kelimeyi tekrarlama
      const existing = new Set((film.words || []).map(w => w.word.toLowerCase()));
      for (const w of words) {
        if (w.word && w.meaning && !existing.has(w.word.toLowerCase())) {
          film.words.push({ word: w.word, meaning: w.meaning });
        }
      }
    }

    /* --- 2. çağrı: replikler (web search ZORUNLU, yoksa atla) --- */
    statusEl.innerHTML = `<span class="spinner"></span> Popüler replikler aranıyor…`;
    const quotesPrompt =
      `"${filmName}" filminden/dizisinden bilinen ve popüler 3-5 replik bul, internetten doğrula. ` +
      `Her replik için kimin söylediğini / hangi sahnede geçtiğini kısaca belirt. ` +
      `SADECE JSON döndür, başka açıklama ekleme:\n[{"line": "...", "context": "..."}]`;
    const searchRes = await callAIWithSearch(quotesPrompt);
    if (searchRes) {
      const quotes = parseJsonArray(searchRes.result);
      if (quotes) {
        const existingLines = new Set((film.quotes || []).map(q => q.line));
        for (const q of quotes) {
          if (q.line && !existingLines.has(q.line)) {
            film.quotes.push({ line: q.line, context: q.context || "" });
          }
        }
      }
    }
    // searchRes null ise: web aramalı sağlayıcı yok → replik eklenmez, uydurulmaz

    storage.saveFilms(films);
    storage.clearChat(filmName); // chat geçici — topla sonrası silinir
    toast("Deftere kaydedildi.");
    navigate(`#/film/${encodeURIComponent(filmName)}`);
  } catch (err) {
    if (err.message === "NO_KEYS") {
      toast("Hiç AI anahtarı yok — Ayarlar'dan ekle.");
    } else {
      toast("Toplama başarısız oldu, tekrar dene.");
    }
  } finally {
    hide("collectStatus");
    $("collectBtn").disabled = false;
  }
}

/* ==================================================================
   EKRAN: Film detay
================================================================== */
function renderDetailScreen(filmName) {
  const film = storage.getFilms()[filmName];
  if (!film) { navigate("#/"); return; }

  $("detailPoster").src = film.poster || "";
  $("detailTitle").textContent = filmName;
  const date = film.createdAt ? new Date(film.createdAt).toLocaleDateString("tr-TR") : "";
  $("detailMeta").textContent = `${date} · ${(film.words || []).length} kelime`;

  const wordList = $("wordList");
  wordList.innerHTML = "";
  if ((film.words || []).length === 0) show("wordsEmpty"); else hide("wordsEmpty");
  for (const w of film.words || []) {
    const div = document.createElement("div");
    div.className = "word-item";
    div.innerHTML = `<b>${esc(w.word)}</b><div class="m">${esc(w.meaning)}</div>`;
    wordList.appendChild(div);
  }

  const quoteList = $("quoteList");
  quoteList.innerHTML = "";
  if ((film.quotes || []).length === 0) show("quotesEmpty"); else hide("quotesEmpty");
  for (const q of film.quotes || []) {
    const div = document.createElement("div");
    div.className = "quote-item";
    div.innerHTML = `<div class="line">${esc(q.line)}</div><div class="ctx">${esc(q.context)}</div>`;
    quoteList.appendChild(div);
  }

  $("reopenChatBtn").onclick = () => navigate(`#/chat/${encodeURIComponent(filmName)}`);
  $("deleteFilmBtn").onclick = () => {
    if (!confirm(`"${filmName}" ve tüm kelimeleri silinsin mi?`)) return;
    const films = storage.getFilms();
    delete films[filmName];
    storage.saveFilms(films);
    storage.clearChat(filmName);
    navigate("#/");
  };
}

/* ==================================================================
   EKRAN: Ayarlar
================================================================== */
function renderSettingsScreen() {
  const keys = storage.getKeys();
  $("keyGroq").value = keys.groq || "";
  $("keyGemini").value = keys.gemini || "";
  $("keyOpenrouter").value = keys.openrouter || "";
  $("keyTmdb").value = keys.tmdb || "";
}

function saveSettings() {
  storage.saveKeys({
    groq: $("keyGroq").value.trim(),
    gemini: $("keyGemini").value.trim(),
    openrouter: $("keyOpenrouter").value.trim(),
    tmdb: $("keyTmdb").value.trim(),
  });
  toast("Anahtarlar kaydedildi.");
  history.back();
}

/* ==================================================================
   EVENT BAĞLANTILARI & BAŞLATMA
================================================================== */
function init() {
  $("backBtn").addEventListener("click", () => history.back());
  $("settingsBtn").addEventListener("click", () => navigate("#/settings"));
  $("addFilmFab").addEventListener("click", () => navigate("#/add"));

  $("tmdbSearchBtn").addEventListener("click", doTmdbSearch);
  $("tmdbQuery").addEventListener("keydown", e => { if (e.key === "Enter") doTmdbSearch(); });

  $("chatSendBtn").addEventListener("click", sendChatMessage);
  $("chatInput").addEventListener("keydown", e => { if (e.key === "Enter") sendChatMessage(); });
  $("collectBtn").addEventListener("click", collectFromChat);

  $("saveKeysBtn").addEventListener("click", saveSettings);

  route();
}
document.addEventListener("DOMContentLoaded", init);
