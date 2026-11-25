// Libby Library — CrossPoint plugin.
// Pair with the Libby app via a setup code, search your library's catalogue,
// borrow an EPUB (Adobe) loan, and save the resulting .acsm into the folder the
// File Manager is showing. Then use the "Protected Content" plugin's
// "Fetch selected book" to fulfill it onto the SD card.
//
// Uses only generic device APIs: api.relay (outbound HTTP) and api.writeFile.
// Libby's endpoints are unofficial; every request is shown in the debug log
// (secrets redacted) so a changed endpoint is easy to spot and fix.

CrossPoint.registerPlugin(async (container, api) => {
  const SENTRY = 'https://sentry.libbyapp.com';
  const SENTRY_READ = 'https://sentry-read.svc.overdrive.com';
  const THUNDER = 'https://thunder.api.overdrive.com/v2';
  const FORMAT = 'ebook-epub-adobe';
  const STATE_PATH = api.dir ? api.dir + '/libby.json' : '/.crosspoint/libby.json';
  const currentFolder = new URLSearchParams(window.location.search).get('path') || '/';

  let state = null;   // { identity, chip, cards:[{cardId, library, name}], cardIndex }
  let results = [];

  // ---- helpers ----------------------------------------------------------- //
  const te = new TextEncoder();
  function bytesToB64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function utf8ToB64(v) { return bytesToB64(te.encode(v)); }
  function esc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  const $ = (id) => document.getElementById(id);
  function status(m) { $('lb-status').textContent = m; }
  function log(m) {
    const el = $('lb-log');
    el.textContent += m + '\n';
    el.scrollTop = el.scrollHeight;
  }
  function redact(s) {
    return String(s).replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '<jwt>').replace(/"code"\s*:\s*"\d+"/g, '"code":"<code>"');
  }

  async function relay(method, url, body, extraHeaders) {
    const headers = Object.assign({ 'Accept': 'application/json' }, extraHeaders || {});
    if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json';
    if (state && state.identity && url.startsWith('https://sentry')) {
      headers['Authorization'] = 'Bearer ' + state.identity;
    }
    const r = await api.relay(method, url, headers, body == null ? '' : JSON.stringify(body));
    if (r.error) throw new Error('relay: ' + r.error);
    log(method + ' ' + url.replace(/\?.*/, '') + ' -> ' + r.status);
    return r;
  }
  function json(r) { try { return JSON.parse(r.body); } catch (e) { return null; } }
  function ok(r) { return r.status >= 200 && r.status < 300; }
  function fail(r, what) {
    const j = json(r);
    const msg = (j && (j.message || j.error || j.result)) || String(r.body || '').slice(0, 160);
    return new Error(what + ' failed (HTTP ' + r.status + (msg ? ': ' + msg : '') + ')');
  }

  // ---- persisted state (SD card) ----------------------------------------- //
  async function loadState() {
    const dir = STATE_PATH.slice(0, STATE_PATH.lastIndexOf('/')) || '/';
    const listing = await fetch('/api/files?path=' + encodeURIComponent(dir));
    if (!listing.ok) return null;
    const entries = await listing.json();
    const name = STATE_PATH.slice(STATE_PATH.lastIndexOf('/') + 1);
    if (!entries.some((e) => !e.isDirectory && e.name === name)) return null;
    const r = await fetch('/download?path=' + encodeURIComponent(STATE_PATH));
    if (!r.ok) return null;
    try { return JSON.parse(await r.text()); } catch (e) { return null; }
  }
  async function saveState() {
    const w = await api.writeFile(STATE_PATH, utf8ToB64(JSON.stringify(state)));
    if (!w.ok) throw new Error('could not save ' + STATE_PATH);
  }

  // ---- Libby: identity, pairing, sync ------------------------------------ //
  async function newIdentity() {
    const r = await relay('POST', SENTRY + '/chip?client=dewey', null);
    if (!ok(r)) throw fail(r, 'identity');
    const j = json(r);
    if (!j || !j.identity) throw new Error('identity reply had no token');
    state = { identity: j.identity, chip: j.chip, cards: [], cardIndex: 0 };
  }

  async function pair(code) {
    status('Creating a device identity…');
    await newIdentity();
    status('Pairing with Libby…');
    const r = await relay('POST', SENTRY + '/chip/clone/code', { code });
    if (!ok(r)) { state = null; throw fail(r, 'pairing (is the code current? it expires quickly)'); }
    const j = json(r);
    if (j && j.identity) state.identity = j.identity;
    await sync();
    await saveState();
  }

  async function sync() {
    const r = await relay('GET', SENTRY + '/chip/sync', null);
    if (!ok(r)) throw fail(r, 'sync');
    const j = json(r) || {};
    if (j.identity) state.identity = j.identity;
    state.cards = (j.cards || []).map((c) => ({
      cardId: c.cardId,
      library: c.advantageKey || (c.library && (c.library.preferredKey || c.library.websiteId)) || '',
      name: c.cardName || (c.library && c.library.name) || c.advantageKey || 'card',
    })).filter((c) => c.cardId && c.library);
    state.loans = j.loans || [];
    if (state.cardIndex >= state.cards.length) state.cardIndex = 0;
    if (!state.cards.length) throw new Error('paired, but no library cards found in Libby');
    return j;
  }
  const card = () => state.cards[state.cardIndex];

  // ---- search ------------------------------------------------------------ //
  async function search(query) {
    const url = THUNDER + '/libraries/' + encodeURIComponent(card().library) +
      '/media?query=' + encodeURIComponent(query) + '&format=' + FORMAT +
      '&perPage=12&page=1';
    // The catalogue reply is 60-140 KB (mostly filter data), too big for
    // /api/relay, so download it to the SD card and read it back from there.
    const dest = (api.dir || '/.crosspoint') + '/search.json';
    let dl;
    try { dl = await api.fetchToSd(url, dest, {}); }
    catch (e) { throw new Error('search download failed: ' + e.message); }
    log('GET thunder/media -> ' + (dl.status || '?') + ' ' + (dl.bytes || 0) + 'B');
    if (dl.error || (dl.status && (dl.status < 200 || dl.status >= 300))) {
      throw new Error('search failed (' + (dl.status || dl.error) + ')');
    }
    const resp = await fetch('/download?path=' + encodeURIComponent(dest));
    if (!resp.ok) throw new Error('could not read search results (HTTP ' + resp.status + ')');
    let j;
    try { j = JSON.parse(await resp.text()); } catch (e) { throw new Error('search reply was not valid JSON'); }
    fetch('/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'path=' + encodeURIComponent(dest),
    }).catch(() => {});
    return (j.items || []).map((it) => ({
      id: it.id,
      title: it.title,
      author: it.firstCreatorName || '',
      available: !!it.isAvailable,
      copies: it.availableCopies,
      waitDays: it.estimatedWaitDays,
    }));
  }

  // ---- borrow + get the .acsm ------------------------------------------- //
  function isAcsm(r) { return ok(r) && /<\s*fulfillmentToken/.test(r.body || ''); }

  async function findLoan(id) {
    const j = await sync();
    return (j.loans || []).find((l) => String(l.id) === String(id));
  }

  async function borrow(item) {
    const c = card();
    let loan = await findLoan(item.id);
    if (!loan) {
      status('Borrowing “' + item.title + '”…');
      const r = await relay('POST', SENTRY_READ + '/card/' + c.cardId + '/loan/' + item.id,
        { period: 14, units: 'days', lucky_day: null, title_format: FORMAT });
      if (!ok(r)) throw fail(r, 'borrow');
      loan = await findLoan(item.id);
    }
    if (!loan) throw new Error('borrow seemed to succeed, but the loan is not in your Libby shelf');
    log('loan keys: ' + Object.keys(loan).join(','));
    status('Requesting the .acsm…');
    const acsm = await getAcsm(c, item, loan);
    return acsm;
  }

  async function getAcsm(c, item, loan) {
    const candidates = [];
    const fmt = (loan.formats || []).find((f) => f.id === FORMAT);
    if (fmt) {
      log('format keys: ' + Object.keys(fmt).join(','));
      const links = fmt.links || {};
      for (const k of Object.keys(links)) {
        if (links[k] && links[k].href) candidates.push(['GET', links[k].href]);
      }
    }
    const base = SENTRY_READ + '/card/' + c.cardId + '/loan/' + item.id;
    candidates.push(['GET', base + '/fulfill/' + FORMAT], ['POST', base + '/fulfill/' + FORMAT]);
    for (const [method, url] of candidates) {
      try {
        const r = await relay(method, url, method === 'POST' ? {} : null,
          { 'Accept': '*/*' });
        if (isAcsm(r)) return r.body;
        log('  not an .acsm: ' + redact(String(r.body || '').slice(0, 200)));
      } catch (e) { log('  ' + e.message); }
    }
    throw new Error('could not get an .acsm for this loan — see the debug log; the endpoint may need adjusting');
  }

  async function saveAcsm(title, acsm) {
    const safe = title.replace(/[\/\\:*?"<>|\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ')
      .trim().replace(/^\.+|\.+$/g, '').slice(0, 60) || 'book';
    const path = (currentFolder === '/' ? '' : currentFolder.replace(/\/+$/, '')) + '/' + safe + '.acsm';
    const w = await api.writeFile(path, utf8ToB64(acsm));
    if (!w.ok) throw new Error('could not write ' + path);
    return path;
  }

  // ---- UI ---------------------------------------------------------------- //
  container.innerHTML =
    '<h2>Libby Library</h2>' +
    '<p style="color:var(--label-color);font-size:0.9em;margin:0 0 12px;padding:8px 10px;' +
    'border:1px solid var(--border-color,#ddd);border-radius:4px;">' +
    '<strong>Network required:</strong> start File Transfer in <strong>Join Network</strong> mode. ' +
    'Borrowed books are saved as <strong>.acsm</strong> in <strong>' + esc(currentFolder) + '</strong>; ' +
    'then open <em>Protected Content</em> and tap “Fetch selected book”.</p>' +
    '<div id="lb-account" style="margin-bottom:12px;color:var(--label-color);font-size:0.9em;white-space:pre-line;">Checking the SD card…</div>' +
    '<div id="lb-pair">' +
    '<div class="setting-row"><label class="setting-name" for="lb-code">Libby setup code</label>' +
    '<span class="setting-control"><input id="lb-code" type="text" inputmode="numeric" maxlength="8" placeholder="8 digits"></span></div>' +
    '<p style="color:var(--label-color);font-size:0.85em;margin:4px 0 8px;">In the Libby app: Settings → Copy To Another Device → “I have a code… / Get a setup code”.</p>' +
    '<div style="text-align:center;"><button type="button" class="btn-small" id="lb-pairgo">Pair with Libby</button></div></div>' +
    '<div id="lb-main" style="display:none;">' +
    '<div class="setting-row"><label class="setting-name" for="lb-card">Library card</label>' +
    '<span class="setting-control"><select id="lb-card"></select></span></div>' +
    '<div class="setting-row"><label class="setting-name" for="lb-q">Search</label>' +
    '<span class="setting-control"><input id="lb-q" type="text" placeholder="title or author"></span></div>' +
    '<div style="margin:8px 0;text-align:center;"><button type="button" class="btn-small" id="lb-search">Search</button> ' +
    '<button type="button" class="btn-small" id="lb-unpair">Forget Libby</button></div>' +
    '<div id="lb-results"></div></div>' +
    '<div id="lb-status" style="margin-top:12px;color:var(--label-color);font-size:0.9em;white-space:pre-line;"></div>' +
    '<details style="margin-top:12px;"><summary style="font-size:0.85em;color:var(--label-color);">Debug log</summary>' +
    '<pre id="lb-log" style="max-height:200px;overflow:auto;font-size:0.75em;white-space:pre-wrap;"></pre></details>';

  function showMain(on) {
    $('lb-pair').style.display = on ? 'none' : '';
    $('lb-main').style.display = on ? '' : 'none';
    if (on) {
      $('lb-card').innerHTML = state.cards.map((c, i) =>
        '<option value="' + i + '"' + (i === state.cardIndex ? ' selected' : '') + '>' + esc(c.name) + '</option>').join('');
      $('lb-account').textContent = 'Connected to Libby — ' + state.cards.length + ' card' + (state.cards.length === 1 ? '' : 's') + '.';
    }
  }

  function renderResults() {
    const box = $('lb-results');
    if (!results.length) { box.innerHTML = '<p style="color:var(--label-color);">No EPUB results.</p>'; return; }
    box.innerHTML = results.map((it, i) =>
      '<div class="setting-row" style="align-items:center;">' +
      '<span class="setting-name" style="flex:1;"><strong>' + esc(it.title) + '</strong><br>' +
      '<small>' + esc(it.author) + ' · ' +
      (it.available ? 'available' : 'waitlist' + (it.waitDays ? ' ~' + esc(it.waitDays) + 'd' : '')) + '</small></span>' +
      '<button type="button" class="btn-small btn-add" data-i="' + i + '"' + (it.available ? '' : ' disabled') + '>Borrow</button></div>').join('');
    box.querySelectorAll('button[data-i]').forEach((b) => {
      b.onclick = async () => {
        const item = results[Number(b.dataset.i)];
        b.disabled = true;
        try {
          const acsm = await borrow(item);
          const path = await saveAcsm(item.title, acsm);
          status('Saved ' + path + '\nNow open Protected Content and tap “Fetch selected book”.');
        } catch (e) { status('Error: ' + e.message); b.disabled = false; }
      };
    });
  }

  $('lb-pairgo').onclick = async () => {
    const code = $('lb-code').value.replace(/\D/g, '');
    if (code.length !== 8) { status('Enter the 8-digit setup code.'); return; }
    $('lb-pairgo').disabled = true;
    try { await pair(code); showMain(true); status('Paired. Search for a book.'); }
    catch (e) { status('Error: ' + e.message); }
    $('lb-pairgo').disabled = false;
  };
  $('lb-card').onchange = async () => { state.cardIndex = Number($('lb-card').value) || 0; await saveState(); };
  $('lb-search').onclick = async () => {
    const q = $('lb-q').value.trim();
    if (!q) return;
    $('lb-search').disabled = true;
    try { status('Searching…'); results = await search(q); renderResults(); status(results.length + ' result(s).'); }
    catch (e) { status('Error: ' + e.message); }
    $('lb-search').disabled = false;
  };
  $('lb-q').onkeydown = (e) => { if (e.key === 'Enter') $('lb-search').click(); };
  $('lb-unpair').onclick = async () => {
    state = null;
    await api.writeFile(STATE_PATH, utf8ToB64('{}'));
    results = [];
    $('lb-results').innerHTML = '';
    $('lb-account').textContent = 'Not paired.';
    showMain(false);
    status('Forgot this Libby pairing (also remove the device in the Libby app if you like).');
  };

  try {
    const saved = await loadState();
    if (saved && saved.identity) {
      state = saved;
      try { await sync(); await saveState(); } catch (e) { log('resync: ' + e.message); }
      if (state.cards && state.cards.length) { showMain(true); status('Ready.'); }
      else { state = null; $('lb-account').textContent = 'Not paired.'; }
    } else {
      $('lb-account').textContent = 'Not paired.';
    }
  } catch (e) {
    $('lb-account').textContent = 'Could not read SD state: ' + e.message;
  }
});
