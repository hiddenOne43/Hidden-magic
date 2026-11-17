// Hidden Magic — interface cliente (aucune donnée sensible côté client).
'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

let me = null; // utilisateur courant (null si déconnecté)
let currentConvId = null;
let currentListing = null;
let photoDataUrl = null;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* réponse vide */ }
  if (!res.ok) throw new Error((data && data.error) || `Erreur ${res.status}`);
  return data;
}

function flash(message, kind = '') {
  const el = $('#flash');
  el.innerHTML = `<div class="notice ${kind}">${escapeHtml(message)}</div>`;
  window.scrollTo({ top: 0, behavior: 'smooth' });
  setTimeout(() => { el.innerHTML = ''; }, 6000);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function money(cents) {
  return (Number(cents) / 100).toFixed(2).replace('.', ',') + ' $';
}

// Montant en dollars (valeur de marché), format français.
function moneyCad(n) {
  return Number(n).toFixed(2).replace('.', ',') + ' $';
}

function showView(name) {
  $$('.view').forEach((v) => v.classList.remove('active'));
  const el = document.getElementById('view-' + name);
  if (el) el.classList.add('active');
  $$('#mainnav .navbtn').forEach((b) => b.classList.toggle('active', b.dataset.nav === name));
  closeSidebar();
  window.scrollTo({ top: 0 });
}

// ---------------------------------------------------------------------------
// Barre latérale (navigation)
// ---------------------------------------------------------------------------
function openSidebar() {
  document.body.classList.add('sidebar-open');
  const btn = $('#menuBtn');
  if (btn) btn.setAttribute('aria-expanded', 'true');
}
function closeSidebar() {
  document.body.classList.remove('sidebar-open');
  const btn = $('#menuBtn');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}
function toggleSidebar() {
  if (document.body.classList.contains('sidebar-open')) closeSidebar();
  else openSidebar();
}
function initSidebar() {
  $('#menuBtn').addEventListener('click', toggleSidebar);
  $('#sidebarClose').addEventListener('click', closeSidebar);
  $('#sidebarOverlay').addEventListener('click', closeSidebar);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSidebar(); });
}

async function refreshMe() {
  try {
    const data = await api('/api/auth/me');
    me = data.user;
  } catch (_) {
    me = null;
  }
  const accountBtn = $('#accountBtn');
  accountBtn.textContent = me ? me.username : 'Connexion';
  $$('[data-admin]').forEach((b) => { b.style.display = me && me.is_admin ? '' : 'none'; });
  $$('[data-auth]').forEach((b) => { b.style.display = me ? '' : 'none'; });
  $('#authPanel').hidden = !!me;
  $('#profilePanel').hidden = !me;
  if (me) {
    $('#profileInfo').innerHTML =
      `<strong>${escapeHtml(me.username)}</strong> — ${escapeHtml(me.email)}` +
      (me.is_admin ? ' <span class="chip">Administrateur</span>' : '') +
      (me.is_blocked ? ' <span class="chip">Compte bloqué</span>' : '');
  }
  const banner = $('#blockedBanner');
  if (me && me.is_blocked) {
    banner.hidden = false;
    banner.textContent = 'Votre compte est bloqué par l’administrateur : vous ne pouvez plus publier d’annonces ni envoyer de messages. Contactez l’administrateur du site pour régler la situation.';
  } else {
    banner.hidden = true;
  }
  if (me && me.is_admin) updateAdminBadge();
  else $('#adminBadge').hidden = true;
}

async function updateAdminBadge() {
  try {
    const data = await api('/api/admin/reports');
    const badge = $('#adminBadge');
    badge.hidden = data.reports.length === 0;
    badge.textContent = String(data.reports.length);
  } catch (_) { /* l’admin n’est pas connecté */ }
}

// ---------------------------------------------------------------------------
// Marché
// ---------------------------------------------------------------------------
function listingCard(l) {
  const mine = me && me.id === l.user_id;
  const sold = l.status === 'sold';
  return `
  <article class="card">
    ${l.photo
      ? `<img src="${l.photo}" alt="Photo de ${escapeHtml(l.title)}" loading="lazy">`
      : `<div class="nophoto">✦</div>`}
    <div class="card-body">
      <h3>${escapeHtml(l.title)}</h3>
      <div class="edition">${escapeHtml(l.edition)}</div>
      <div class="price">${money(l.price_cents)} CA</div>
      <div class="metaline">
        <span class="chip">${escapeHtml(l.condition)}</span>
        <span class="chip">${l.language === 'EN' ? 'Anglais' : 'Français'}</span>
        ${l.foil ? '<span class="chip">Foil</span>' : ''}
        ${sold ? '<span class="chip sold">Vendu</span>' : ''}
      </div>
      <div class="metaline">Vendeur : ${escapeHtml(l.seller)}</div>
      <div class="card-actions">
        ${!mine && !sold && me ? `<button class="btn small" data-contact="${l.id}">Contacter le vendeur</button>` : ''}
        ${!mine && !sold && !me ? `<button class="btn small secondary" data-goto-account="1">Se connecter pour contacter</button>` : ''}
        ${me ? `<button class="btn secondary small" data-report-listing="${l.id}">Signaler</button>` : ''}
        ${mine && !sold ? `<button class="btn secondary small" data-mark-sold="${l.id}">Marquer vendu</button>` : ''}
        ${mine ? `<button class="btn danger small" data-delete-listing="${l.id}">Supprimer</button>` : ''}
      </div>
    </div>
  </article>`;
}

async function loadMarket() {
  const q = $('#searchQ').value.trim();
  const condition = $('#searchCondition').value;
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (condition) params.set('condition', condition);
  const data = await api('/api/listings?' + params.toString());
  const grid = $('#listingGrid');
  grid.innerHTML = data.listings.map(listingCard).join('');
  $('#marketEmpty').hidden = data.listings.length > 0;
}

async function loadMyListings() {
  if (!me) { $('#myListings').innerHTML = '<p class="meta">Connectez-vous pour voir vos annonces.</p>'; return; }
  const data = await api('/api/listings?mine=1');
  $('#myListings').innerHTML = data.listings.length
    ? `<div class="grid">${data.listings.map(listingCard).join('')}</div>`
    : '<p class="meta">Vous n’avez publié aucune annonce.</p>';
}

// ---------------------------------------------------------------------------
// Échange
// ---------------------------------------------------------------------------
let tradeBinderUserId = null; // null = tous les classeurs, sinon un joueur

function langLabel(lang) {
  if (lang === 'FR' || lang === 'French') return 'Français';
  if (lang === 'EN' || lang === 'English') return 'Anglais';
  return lang || '';
}

function tradeItemCard(t, context = 'trade') {
  const mine = me && me.id === t.user_id;
  const canDelete = mine || (me && me.is_admin);
  const edition = [t.set_name, t.set_code ? `(${t.set_code})` : '', t.collector_number ? `#${t.collector_number}` : '']
    .filter(Boolean).join(' ');
  return `
  <article class="card">
    ${t.scryfall_id
      ? `<a class="trade-img-link" href="https://api.scryfall.com/cards/${encodeURIComponent(t.scryfall_id)}?format=image&version=normal" target="_blank" rel="noopener"><img class="trade-img" src="https://api.scryfall.com/cards/${encodeURIComponent(t.scryfall_id)}?format=image&version=small" alt="${escapeHtml(t.name)}" loading="lazy" onerror="this.remove()"></a>`
      : `<div class="nophoto">⇄</div>`}
    <div class="card-body">
      <h3>${escapeHtml(t.name)}</h3>
      ${edition ? `<div class="edition">${escapeHtml(edition)}</div>` : ''}
      <div class="metaline">
        <span class="chip ${t.kind === 'want' ? 'want' : ''}">${t.kind === 'want' ? 'Recherché' : 'À échanger'}</span>
        ${context === 'collection' && t.kind === 'trade' && t.offered ? '<span class="chip offered">En échange</span>' : ''}
        ${t.condition ? `<span class="chip">${escapeHtml(t.condition)}</span>` : ''}
        ${t.language ? `<span class="chip">${escapeHtml(langLabel(t.language))}</span>` : ''}
        ${t.foil ? '<span class="chip">Foil</span>' : ''}
        <span class="chip">× ${t.quantity}</span>
      </div>
      ${t.market_cad_approx != null ? `<div class="market">Valeur marché : ≈ ${moneyCad(t.market_cad_approx)} CA</div>` : ''}
      ${t.binder_name ? `<div class="metaline">Classeur : ${escapeHtml(t.binder_name)}</div>` : ''}
      <div class="metaline">Joueur : ${escapeHtml(t.seller)}</div>
      <div class="card-actions">
        ${context === 'collection'
          ? (t.kind === 'trade'
            ? `<button class="btn small" data-offer-trade="${t.id}" data-offered="${t.offered ? 0 : 1}">${t.offered ? 'Retirer de l’échange' : 'Proposer en échange'}</button>`
            : '')
          : `${!mine && me ? `<button class="btn small" data-contact-trade="${t.id}">Proposer un échange</button>` : ''}
        ${!mine && !me ? `<button class="btn small secondary" data-goto-account="1">Se connecter pour proposer</button>` : ''}
        ${mine && t.kind === 'trade' && t.offered ? `<button class="btn secondary small" data-offer-trade="${t.id}" data-offered="0">Retirer de l’échange</button>` : ''}`}
        ${canDelete ? `<button class="btn danger small" data-delete-trade="${t.id}">Supprimer</button>` : ''}
      </div>
    </div>
  </article>`;
}

async function loadBinders() {
  const data = await api('/api/trade/binders');
  $('#tradeBinders').innerHTML = data.binders.length
    ? data.binders.map((b) => `
      <button class="conv" data-view-binder="${b.user_id}">
        <strong>${escapeHtml(b.username)}</strong><br>
        <span class="meta">${b.trade_count} à échanger · ${b.want_count} recherchée${b.want_count > 1 ? 's' : ''}</span>
      </button>`).join('')
    : '<p class="meta">Aucun classeur pour le moment.</p>';
}

async function loadTrade() {
  $('#tradeImportPanel').hidden = !me;
  $('#tradeManualPanel').hidden = !me;
  $('#tradeLoginHint').hidden = !!me;
  await loadBinders();
  const q = $('#tradeQ').value.trim().toLowerCase();
  const kind = $('#tradeKind').value;
  let items;
  let binderName = null;
  if (tradeBinderUserId) {
    const data = await api(`/api/trade/user/${tradeBinderUserId}`);
    binderName = data.user.username;
    items = data.items;
  } else {
    const params = new URLSearchParams();
    if ($('#tradeQ').value.trim()) params.set('q', $('#tradeQ').value.trim());
    if (kind) params.set('kind', kind);
    const data = await api('/api/trade?' + params.toString());
    items = data.items;
  }
  if (tradeBinderUserId) {
    // Filtres appliqués côté client sur le classeur d'un joueur.
    items = items.filter((t) =>
      (!kind || t.kind === kind) &&
      (!q || t.name.toLowerCase().includes(q) || (t.set_name || '').toLowerCase().includes(q) || t.seller.toLowerCase().includes(q)));
  }
  const bar = $('#tradeBinderBar');
  if (tradeBinderUserId) {
    bar.hidden = false;
    bar.innerHTML = `Classeur de <strong>${escapeHtml(binderName || '')}</strong> — <button class="btn secondary small" data-trade-all>Voir tous les échanges</button>`;
  } else {
    bar.hidden = true;
  }
  $('#tradeGrid').innerHTML = items.map((t) => tradeItemCard(t, 'trade')).join('');
  $('#tradeEmpty').hidden = items.length > 0;
}

async function loadCollection() {
  if (!me) { $('#collectionGrid').innerHTML = ''; $('#collectionEmpty').hidden = false; return; }
  const params = new URLSearchParams();
  if ($('#collectionQ').value.trim()) params.set('q', $('#collectionQ').value.trim());
  const data = await api('/api/collection?' + params.toString());
  $('#collectionGrid').innerHTML = data.items.map((t) => tradeItemCard(t, 'collection')).join('');
  $('#collectionEmpty').hidden = data.items.length > 0;
}

async function importTradeCsv() {
  const file = $('#tradeCsvFile').files[0];
  if (!file) { flash('Choisissez un fichier CSV ManaBox.', 'danger'); return; }
  const btn = $('#tradeImportBtn');
  btn.disabled = true;
  btn.textContent = 'Import en cours…';
  try {
    const csv = await file.text();
    const data = await api('/api/trade/import', { method: 'POST', body: JSON.stringify({ csv }) });
    $('#tradeImportResult').textContent =
      `${data.imported} carte(s) importée(s) : ${data.trade} dans votre Collection, ${data.want} recherchée(s). ${data.skipped} ligne(s) ignorée(s). Les cartes de la Collection ne sont proposées en échange que si vous les sélectionnez.${data.offered ? ` ${data.offered} carte(s) restent proposée(s) en échange.` : ''}`;
    flash(`Import terminé : ${data.imported} carte(s) importée(s).`, 'ok');
    await loadTrade();
  } catch (e) {
    flash(e.message, 'danger');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Importer ma collection ManaBox';
  }
}

function initTrade() {
  $('#tradeImportBtn').addEventListener('click', importTradeCsv);
  $('#tradeSearchBtn').addEventListener('click', loadTrade);
  $('#tradeQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadTrade(); });
  $('#tradeKind').addEventListener('change', loadTrade);
  $('#collectionSearchBtn').addEventListener('click', loadCollection);
  $('#collectionQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadCollection(); });
  $('#tradeManualForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = await api('/api/trade', {
        method: 'POST',
        body: JSON.stringify({
          name: $('#tName').value.trim(),
          set_name: $('#tSetName').value.trim(),
          set_code: $('#tSetCode').value.trim(),
          collector_number: $('#tCollector').value.trim(),
          quantity: $('#tQuantity').value,
          condition: $('#tCondition').value,
          language: $('#tLang').value,
          kind: $('#tKind').value,
          foil: $('#tFoil').value === '1',
        }),
      });
      flash(`« ${data.item.name} » ajouté à l’échange.`, 'ok');
      e.target.reset();
      $('#tQuantity').value = '1';
      await loadTrade();
    } catch (err) {
      flash(err.message, 'danger');
    }
  });
}

// ---------------------------------------------------------------------------
// Signalement (boîte de dialogue simple)
// ---------------------------------------------------------------------------
function askReason(title) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:50;padding:1rem;';
    overlay.innerHTML = `
      <div class="panel" style="width:100%;max-width:420px;margin:0">
        <h2>${escapeHtml(title)}</h2>
        <label for="reportReason">Motif (facultatif)</label>
        <textarea id="reportReason" rows="3" placeholder="Ex. : prix trompeur, fausse carte, comportement inapproprié…"></textarea>
        <div class="row" style="margin-top:.8rem">
          <button class="btn" id="reportOk">Envoyer le signalement</button>
          <button class="btn secondary" id="reportCancel">Annuler</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = (v) => { overlay.remove(); resolve(v); };
    overlay.querySelector('#reportCancel').onclick = () => close(null);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    overlay.querySelector('#reportOk').onclick = () => close(overlay.querySelector('#reportReason').value.trim());
  });
}

async function report(targetType, targetId, label) {
  const reason = await askReason(`Signaler ${label}`);
  if (reason === null) return;
  try {
    const data = await api('/api/reports', {
      method: 'POST',
      body: JSON.stringify({ target_type: targetType, target_id: targetId, reason }),
    });
    flash(data.message || 'Signalement envoyé.', 'ok');
  } catch (e) {
    flash(e.message, 'danger');
  }
}

// ---------------------------------------------------------------------------
// Publication (photo redimensionnée côté client, puis base64 en base)
// ---------------------------------------------------------------------------
function resizePhoto(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Impossible de lire la photo.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Fichier image invalide.'));
      img.onload = () => {
        const max = 900;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.75));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function initPublish() {
  $('#fPhoto').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    photoDataUrl = null;
    $('#photoPreview').hidden = true;
    if (!file) return;
    try {
      photoDataUrl = await resizePhoto(file);
      const prev = $('#photoPreview');
      prev.src = photoDataUrl;
      prev.hidden = false;
    } catch (err) {
      flash(err.message, 'danger');
    }
  });
  $('#publishForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = await api('/api/listings', {
        method: 'POST',
        body: JSON.stringify({
          title: $('#fTitle').value.trim(),
          edition: $('#fEdition').value.trim(),
          condition: $('#fCondition').value,
          price: $('#fPrice').value.trim(),
          language: $('#fLang').value,
          foil: $('#fFoil').value === '1',
          photo: photoDataUrl,
        }),
      });
      flash(`Annonce « ${data.listing.title} » publiée !`, 'ok');
      e.target.reset();
      photoDataUrl = null;
      $('#photoPreview').hidden = true;
      await loadMyListings();
      showView('market');
      await loadMarket();
    } catch (err) {
      flash(err.message, 'danger');
    }
  });
}

// ---------------------------------------------------------------------------
// Messagerie
// ---------------------------------------------------------------------------
async function loadConversations() {
  if (!me) { $('#convList').innerHTML = '<p class="meta">Connectez-vous pour voir vos messages.</p>'; return; }
  const data = await api('/api/conversations');
  $('#convList').innerHTML = data.conversations.length
    ? data.conversations.map((c) => `
      <button class="conv" data-open-conv="${c.id}">
        ${c.kind === 'trade'
          ? `<strong>Échange : ${escapeHtml(c.trade_name || 'carte')}</strong> <span class="chip">Échange</span>`
          : `<strong>${escapeHtml(c.listing_title)}</strong>${c.listing_price != null ? ` — ${String(c.listing_price).replace('.', ',')} $ CA` : ''}`}
        ${c.kind === 'listing' && c.listing_status === 'sold' ? '<span class="chip sold">Vendu</span>' : ''}<br>
        <span class="meta">Avec ${escapeHtml(c.other_name)}</span><br>
        <span class="last">${escapeHtml(c.last_body || 'Aucun message pour le moment.')}</span>
      </button>`).join('')
    : '<p class="meta">Aucune conversation pour le moment.</p>';
}

async function openConversation(id) {
  currentConvId = id;
  const data = await api(`/api/conversations/${id}/messages`);
  const c = data.conversation;
  currentListing = c;
  const isTrade = c.kind === 'trade';
  $('#threadTitle').textContent = isTrade ? `Échange : ${c.trade_name || 'carte'}` : c.listing_title;
  $('#threadContext').innerHTML = isTrade
    ? `Échange : <strong>${escapeHtml(c.trade_name || 'carte')}</strong>${c.trade_kind === 'want' ? ' <span class="chip">Recherché</span>' : ''} · Avec ${escapeHtml(c.other_name)} ` +
      `<button class="btn secondary small" data-report-user="${c.other_id}">Signaler cet utilisateur</button>`
    : `Annonce : <strong>${escapeHtml(c.listing_title)}</strong>${c.listing_price != null ? ` — ${String(c.listing_price).replace('.', ',')} $ CA` : ''}` +
      (c.listing_status === 'sold' ? ' <span class="chip sold">Vendu</span>' : '') +
      ` · Avec ${escapeHtml(c.other_name)} ` +
      `<button class="btn secondary small" data-report-user="${c.other_id}">Signaler cet utilisateur</button>`;
  $('#threadBox').innerHTML = data.messages.length
    ? data.messages.map((m) => `
      <div class="msg ${m.sender_id === me.id ? 'mine' : ''}">
        <div class="who">${escapeHtml(m.sender_name)}</div>
        <div>${escapeHtml(m.body)}</div>
        <div class="when">${new Date(m.created_at).toLocaleString('fr-CA')}</div>
        ${m.sender_id !== me.id ? `<button class="report-link" data-report-message="${m.id}">Signaler ce message</button>` : ''}
      </div>`).join('')
    : '<p class="meta">Aucun message pour le moment. Écrivez le premier !</p>';
  showView('thread');
  $('#threadBox').scrollTop = $('#threadBox').scrollHeight;
}

async function sendMessage(e) {
  e.preventDefault();
  const input = $('#messageInput');
  const body = input.value.trim();
  if (!body || !currentConvId) return;
  try {
    await api(`/api/conversations/${currentConvId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
    input.value = '';
    await openConversation(currentConvId);
  } catch (err) {
    flash(err.message, 'danger');
  }
}

// ---------------------------------------------------------------------------
// Administration
// ---------------------------------------------------------------------------
async function loadAdmin() {
  if (!me || !me.is_admin) return;
  const [reports, listings, users] = await Promise.all([
    api('/api/admin/reports'),
    api('/api/admin/listings'),
    api('/api/admin/users'),
  ]);
  $('#reportQueue').innerHTML = reports.reports.length
    ? reports.reports.map((r) => `
      <div class="report">
        <div><strong>${r.target_type === 'listing' ? 'Annonce' : r.target_type === 'message' ? 'Message' : 'Utilisateur'}</strong> signalé par ${escapeHtml(r.reporter_name)} — ${new Date(r.created_at).toLocaleString('fr-CA')}</div>
        <div>« ${escapeHtml(r.target_label)} » ${r.target_owner_name ? `(par ${escapeHtml(r.target_owner_name)})` : ''}</div>
        ${r.reason ? `<div class="meta">Motif : ${escapeHtml(r.reason)}</div>` : ''}
        ${r.listing_report_count > 1 ? `<div><span class="chip reported">${r.listing_report_count} signalements sur cette annonce</span></div>` : ''}
        <div class="card-actions">
          <button class="btn secondary small" data-dismiss-report="${r.id}">Rejeter</button>
          ${r.target_type !== 'user' ? `<button class="btn danger small" data-delete-target="${r.id}">Supprimer l’élément</button>` : ''}
          <button class="btn danger small" data-block-report="${r.id}">Bloquer l’utilisateur</button>
        </div>
      </div>`).join('')
    : '<p class="meta">Aucun signalement en attente. Tout est calme dans le royaume.</p>';
  $('#adminListings').innerHTML = listings.listings.length
    ? `<table><thead><tr><th>Annonce</th><th>Vendeur</th><th>Prix</th><th>État</th><th></th></tr></thead><tbody>` +
      listings.listings.map((l) => `
        <tr>
          <td>${escapeHtml(l.title)}<br><span class="meta">${escapeHtml(l.edition)}</span>
            ${l.report_count ? `<br><span class="chip reported">${l.report_count} signalement${l.report_count > 1 ? 's' : ''}</span>` : ''}</td>
          <td>${escapeHtml(l.seller)}</td>
          <td>${money(l.price_cents)}</td>
          <td>${l.status === 'sold' ? 'Vendu' : 'Active'}</td>
          <td><button class="btn danger small" data-delete-listing="${l.id}">Supprimer</button></td>
        </tr>`).join('') + '</tbody></table>'
    : '<p class="meta">Aucune annonce.</p>';
  $('#adminUsers').innerHTML = `<table><thead><tr><th>Membre</th><th>Annonces</th><th>Signalements</th><th>Statut</th><th></th></tr></thead><tbody>` +
    users.users.map((u) => `
      <tr>
        <td>${escapeHtml(u.username)}<br><span class="meta">${escapeHtml(u.email)}</span>
          ${u.is_admin ? ' <span class="chip">Admin</span>' : ''}</td>
        <td>${u.listings_count}</td>
        <td>${u.report_count ? `<span class="chip reported">${u.report_count}</span>` : '0'}</td>
        <td>${u.is_blocked ? '<span class="chip reported">Bloqué</span>' : 'Actif'}</td>
        <td>${u.is_admin ? '' : u.is_blocked
          ? `<button class="btn secondary small" data-unblock-user="${u.id}">Débloquer</button>`
          : `<button class="btn danger small" data-block-user="${u.id}">Bloquer</button>`}</td>
      </tr>`).join('') + '</tbody></table>';
  updateAdminBadge();
}

async function adminAction(path, okMessage) {
  try {
    await api(path, { method: 'POST' });
    flash(okMessage, 'ok');
    await loadAdmin();
  } catch (e) {
    flash(e.message, 'danger');
  }
}

// ---------------------------------------------------------------------------
// Authentification (formulaires)
// ---------------------------------------------------------------------------
function initAuth() {
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ login: $('#loginId').value.trim(), password: $('#loginPass').value }),
      });
      me = data.user;
      flash(`Bienvenue, ${me.username} !`, 'ok');
      await refreshMe();
      showView('market');
      await loadMarket();
    } catch (err) {
      flash(err.message, 'danger');
    }
  });
  $('#registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = await api('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          username: $('#regUser').value.trim(),
          email: $('#regEmail').value.trim(),
          password: $('#regPass').value,
        }),
      });
      me = data.user;
      flash(data.is_admin
        ? 'Compte créé ! Vous êtes le premier membre : vous êtes administrateur du site.'
        : 'Compte créé ! Bienvenue sur Hidden Magic.', 'ok');
      await refreshMe();
      showView('market');
      await loadMarket();
    } catch (err) {
      flash(err.message, 'danger');
    }
  });
  $('#logoutBtn').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    me = null;
    await refreshMe();
    showView('market');
    await loadMarket();
  });
}

// ---------------------------------------------------------------------------
// Navigation et actions déléguées
// ---------------------------------------------------------------------------
document.addEventListener('click', async (e) => {
  const nav = e.target.closest('[data-nav]');
  if (nav) {
    e.preventDefault();
    const view = nav.dataset.nav;
    if ((view === 'publish' || view === 'messages' || view === 'admin' || view === 'collection') && !me) {
      flash('Connectez-vous d’abord.', 'danger');
      showView('account');
      return;
    }
    if (view === 'messages') await loadConversations();
    if (view === 'publish') await loadMyListings();
    if (view === 'admin') await loadAdmin();
    if (view === 'trade') await loadTrade();
    if (view === 'collection') await loadCollection();
    showView(view);
    return;
  }
  const contactTrade = e.target.closest('[data-contact-trade]');
  if (contactTrade) {
    try {
      const data = await api(`/api/trade/${contactTrade.dataset.contactTrade}/contact`, { method: 'POST' });
      await openConversation(data.conversation_id);
    } catch (err) {
      flash(err.message, 'danger');
    }
    return;
  }
  const delTrade = e.target.closest('[data-delete-trade]');
  if (delTrade) {
    if (!window.confirm('Supprimer cette carte de l’échange ?')) return;
    try {
      await api(`/api/trade/${delTrade.dataset.deleteTrade}`, { method: 'DELETE' });
      flash('Carte supprimée de l’échange.', 'ok');
      if (document.getElementById('view-collection').classList.contains('active')) await loadCollection();
      else await loadTrade();
    } catch (err) { flash(err.message, 'danger'); }
    return;
  }
  const offerTrade = e.target.closest('[data-offer-trade]');
  if (offerTrade) {
    try {
      await api(`/api/trade/${offerTrade.dataset.offerTrade}/offer`, {
        method: 'POST',
        body: JSON.stringify({ offered: Number(offerTrade.dataset.offered) }),
      });
      flash(offerTrade.dataset.offered === '1' ? 'Carte proposée en échange.' : 'Carte retirée de l’échange.', 'ok');
      if (document.getElementById('view-collection').classList.contains('active')) await loadCollection();
      else await loadTrade();
    } catch (err) { flash(err.message, 'danger'); }
    return;
  }
  const viewBinder = e.target.closest('[data-view-binder]');
  if (viewBinder) {
    tradeBinderUserId = Number(viewBinder.dataset.viewBinder);
    await loadTrade();
    return;
  }
  const tradeAll = e.target.closest('[data-trade-all]');
  if (tradeAll) {
    tradeBinderUserId = null;
    await loadTrade();
    return;
  }
  const contact = e.target.closest('[data-contact]');
  if (contact) {
    try {
      const data = await api('/api/conversations', {
        method: 'POST',
        body: JSON.stringify({ listing_id: Number(contact.dataset.contact) }),
      });
      await openConversation(data.conversation_id);
    } catch (err) {
      flash(err.message, 'danger');
    }
    return;
  }
  const gotoAccount = e.target.closest('[data-goto-account]');
  if (gotoAccount) { showView('account'); return; }
  const reportListing = e.target.closest('[data-report-listing]');
  if (reportListing) { await report('listing', Number(reportListing.dataset.reportListing), 'cette annonce'); return; }
  const reportMessage = e.target.closest('[data-report-message]');
  if (reportMessage) { await report('message', Number(reportMessage.dataset.reportMessage), 'ce message'); return; }
  const reportUser = e.target.closest('[data-report-user]');
  if (reportUser) { await report('user', Number(reportUser.dataset.reportUser), 'cet utilisateur'); return; }
  const markSold = e.target.closest('[data-mark-sold]');
  if (markSold) {
    try {
      await api(`/api/listings/${markSold.dataset.markSold}/sold`, { method: 'PATCH', body: JSON.stringify({ status: 'sold' }) });
      flash('Annonce marquée vendue.', 'ok');
      await loadMyListings();
      await loadMarket();
    } catch (err) { flash(err.message, 'danger'); }
    return;
  }
  const delListing = e.target.closest('[data-delete-listing]');
  if (delListing) {
    if (!window.confirm('Supprimer cette annonce ?')) return;
    try {
      await api(`/api/listings/${delListing.dataset.deleteListing}`, { method: 'DELETE' });
      flash('Annonce supprimée.', 'ok');
      await loadMyListings();
      await loadMarket();
      if (me && me.is_admin) await loadAdmin();
    } catch (err) { flash(err.message, 'danger'); }
    return;
  }
  const openConv = e.target.closest('[data-open-conv]');
  if (openConv) { await openConversation(Number(openConv.dataset.openConv)); return; }
  const dismiss = e.target.closest('[data-dismiss-report]');
  if (dismiss) { await adminAction(`/api/admin/reports/${dismiss.dataset.dismissReport}/dismiss`, 'Signalement rejeté.'); return; }
  const delTarget = e.target.closest('[data-delete-target]');
  if (delTarget) { await adminAction(`/api/admin/reports/${delTarget.dataset.deleteTarget}/delete-target`, 'Élément supprimé.'); return; }
  const blockReport = e.target.closest('[data-block-report]');
  if (blockReport) { await adminAction(`/api/admin/reports/${blockReport.dataset.blockReport}/block-user`, 'Utilisateur bloqué.'); return; }
  const blockUser = e.target.closest('[data-block-user]');
  if (blockUser) { await adminAction(`/api/admin/users/${blockUser.dataset.blockUser}/block`, 'Utilisateur bloqué.'); return; }
  const unblockUser = e.target.closest('[data-unblock-user]');
  if (unblockUser) { await adminAction(`/api/admin/users/${unblockUser.dataset.unblockUser}/unblock`, 'Utilisateur débloqué.'); return; }
});

$('#searchBtn').addEventListener('click', loadMarket);
$('#searchQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadMarket(); });
$('#searchCondition').addEventListener('change', loadMarket);
$('#messageForm').addEventListener('submit', sendMessage);

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------
(async () => {
  initSidebar();
  initAuth();
  await initPublish();
  initTrade();
  await refreshMe();
  await loadMarket();
})();
