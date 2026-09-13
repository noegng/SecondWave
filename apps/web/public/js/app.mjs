/**
 * SecondWave — l'interface du marché secondaire.
 *
 * Lecture seule sur les données du dépôt (snapshot / world / orderbook) ;
 * les actions — vendre, racheter — restent locales à la session : le vrai
 * règlement se joue dans le CLI, où vivent les seeds. L'interface montre
 * le carnet exactement comme le verrait un membre du domaine.
 */
import { startCoinsForeground } from './coins.mjs'
import { initLock, reopenLock } from './lockscreen.mjs'
import {
  loadWorld, vaultById, discountOf, timeLeft, rippleNow,
  fmtAsset, fmtDuration, fmtNav, fmtNum, fmtShares, shortAddr,
} from './data.mjs'
import { loadSession, saveSession, candidates, holdingsOf, fetchLiveHoldings, connectExternal } from './wallet.mjs'

startCoinsForeground(document.getElementById('coins-fg'))

const $ = s => document.querySelector(s)
const el = (tag, cls, html) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (html != null) n.innerHTML = html
  return n
}

const state = {
  vaults: {},
  offers: [],
  session: loadSession(),   // { account } | null
  filter: 'open',
  tab: 'book',
  ticket: { vault: '', shares: '', price: '' },   // le formulaire de vente, persistant
  chain: { account: null, holdings: null, status: 'idle', error: null },
  pending: [],       // les offres qui attendent MA confirmation de vendeur
  commitments: [],   // les offres où JE suis l'acheteur engagé
  canSign: false,    // state.json présent côté serveur
  apiLive: false,    // un backend répond (npm run web). Faux sur un déploiement statique.
}

const DATA = await loadWorld()
state.vaults = DATA.vaults
state.offers = DATA.offers

// Le carnet vient du serveur, pas du snapshot : la CLI écrit le même fichier,
// donc une offre posée en terminal apparaît ici, et réciproquement.
// `repaint: false` — le premier rendu est celui du sas, pas celui-ci.
try { await reloadOffers({ repaint: false }) } catch { /* serveur muet : on garde le snapshot */ }

// le sas : le coffre s'ouvre avant le marché, et le logo le rappelle.
// À chaque entrée, on relit la session posée dans le coffre.
initLock(DATA.world, () => {
  state.session = loadSession()
  render()
  refreshHoldings()
})
$('#brand-home').addEventListener('click', reopenLock)

/* ============ onglets ============ */

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    state.tab = tab.dataset.tab
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('is-active', t === tab))
    document.querySelectorAll('.view').forEach(v =>
      v.classList.toggle('is-active', v.id === `view-${state.tab}`))
    render()
  })
}

/* ============ filtres carnet ============ */

$('#book-filters').addEventListener('click', e => {
  const chip = e.target.closest('.chip')
  if (!chip) return
  state.filter = chip.dataset.filter
  document.querySelectorAll('#book-filters .chip').forEach(c => c.classList.toggle('is-active', c === chip))
  renderBook()
})

/* ============ le carnet ============ */

function offerRow(o) {
  const v = vaultById(state.vaults, o.vaultId)
  if (!v) return null
  const mine = state.session && o.seller === state.session.account
  // ⚠️ `expiry` vaut null sur une offre durable : `null > now` est faux, et
  //    l'offre s'affichait comme périmée. Et une offre engagée reste vivante —
  //    elle n'est simplement plus à prendre.
  const live = ['open', 'matched', 'armed'].includes(o.status) && !isExpired(o)
  const d = discountOf(o, v)
  const deep = d >= 0.15
  const reading = readingOf(v, d)

  const tr = el('tr', [
    mine ? 'is-mine' : '',
    !live ? 'is-stale' : '',
  ].join(' ').trim())
  tr.dataset.id = o.id

  const status = o.status !== 'open'
    ? `<span class="status-pill status-${o.status}">${STATUS_FR[o.status] ?? o.status}</span>`
    : ''

  const left = timeLeft(o)

  tr.innerHTML = `
    <td><span class="oid">${o.id}</span>${mine ? '<span class="tag-mine">you</span>' : ''}</td>
    <td>
      <div class="vault-cell">
        <span class="grade tone-${v.rating.tone}">${v.rating.grade}</span>
        <div>
          <div class="v-name">${v.short}</div>
          <div class="v-asset">${v.asset}</div>
        </div>
      </div>
    </td>
    <td class="num">${fmtNum(Number(o.shares), true)}</td>
    <td class="num">${fmtAsset(Number(o.price), v)}</td>
    <td class="num"><span class="discount ${deep ? 'deep' : ''}">−${(d * 100).toFixed(1)} %</span></td>
    <td>${live ? `<span class="reading ${reading.cls}">${reading.label}</span>` : status}</td>
    <td><span class="seller">${shortAddr(o.seller)}</span></td>
    <td class="num">${live ? left.label : '—'}</td>
    <td class="num">${buyCell(o, v, mine, live)}</td>
  `
  tr.addEventListener('click', e => {
    if (e.target.closest('button')) return
    openDrawer(o, v)
  })
  const buyBtn = tr.querySelector('[data-buy]')
  if (buyBtn) buyBtn.addEventListener('click', () => buyFlow(o, v))
  const cancelBtn = tr.querySelector('[data-cancel]')
  if (cancelBtn) cancelBtn.addEventListener('click', () => cancelOffer(o))
  const confirmBtn = tr.querySelector('[data-confirm]')
  if (confirmBtn) confirmBtn.addEventListener('click', () => confirmFlow(o, v))
  const withdrawBtn = tr.querySelector('[data-withdraw]')
  if (withdrawBtn) withdrawBtn.addEventListener('click', () => withdrawFlow(o, v))
  return tr
}

const STATUS_FR = {
  filled: 'settled', cancelled: 'cancelled', expired: 'expired',
  matched: 'committed', armed: 'settling',
}

function buyCell(o, v, mine, live) {
  // Déploiement statique : le carnet se lit, il ne se règle pas. Un bouton qui
  // ne peut qu'échouer vaut moins qu'une étiquette qui dit pourquoi.
  if (live && !state.apiLive) return `<span class="pill pill-preview">preview</span>`
  if (!live) return o.txHash
    ? `<a class="seller" href="https://devnet.xrpl.org/transactions/${o.txHash}" target="_blank" rel="noopener" onclick="event.stopPropagation()">proof ↗</a>`
    : ''
  // Une offre engagée n'est plus à prendre : l'acheteur a signé, seul le
  // vendeur peut encore trancher. On montre l'état plutôt qu'un bouton mort.
  if (o.status === 'matched') {
    if (mine) return `<button class="btn btn-primary btn-sm" data-confirm>Confirm</button>`
    // Mon propre engagement : je vois depuis quand j'attends, et je peux sortir.
    if (o.buyer === state.session?.account)
      return `<button class="btn btn-mine btn-sm" data-withdraw>Withdraw · ${depuis(o.matchedAt)}</button>`
    return `<span class="pill pill-wait">awaiting seller</span>`
  }
  if (o.status === 'armed') return `<span class="pill pill-wait">settling…</span>`
  if (mine) return `<button class="btn btn-mine btn-sm" data-cancel>Withdraw</button>`
  return `<button class="btn btn-ghost btn-sm" data-buy>Buy back</button>`
}

/** liquidité ou détresse — la question centrale de l'analyste. */
/** Une offre sans `expiry` ne périme jamais — c'est le principe du rail durable. */
function isExpired(o) { return o.expiry != null && o.expiry <= rippleNow() }

function readingOf(v, discount) {
  if (v.rating.tone === 'bad' || (v.rating.tone === 'warn' && discount >= 0.12))
    return { cls: 'distress', label: 'distress discount' }
  if (discount >= 0.005)
    return { cls: 'liquidity', label: 'liquidity discount' }
  return { cls: '', label: 'at par' }
}

/** Décote que la note du vault peut justifier — l'ancre « Suggested ». */
function suggestedDiscount(v) {
  if (v.rating.tone === 'bad') return 0.22
  if (v.rating.tone === 'warn') return 0.10
  return 0.031
}

function toUi(native, v) { return v.isXrp ? native / 1_000_000 : native }
function toNative(ui, v) { return v.isXrp ? Math.round(ui * 1_000_000) : ui }
function fmtUi(ui, v) {
  if (!Number.isFinite(ui) || ui <= 0) return ''
  return v.isXrp ? ui.toFixed(4) : String(Math.round(ui * 100) / 100)
}

/** Médiane du carnet ouvert, ramenée à la taille de l'ordre. */
function bookMedianNative(vaultId, shares) {
  const now = rippleNow()
  const open = state.offers.filter(o =>
    o.vaultId === vaultId && o.status === 'open' && !isExpired(o) && Number(o.shares) > 0)
  if (!open.length) return null
  const pers = open.map(o => Number(o.price) / Number(o.shares)).sort((a, b) => a - b)
  return pers[Math.floor(pers.length / 2)] * shares
}

/** Le texte que le slider doit faire bouger : nature de la décote vs NAV. */
function askAdvice(v, discount) {
  const reading = readingOf(v, discount)
  const pct = Math.abs(discount * 100).toFixed(1)
  const suggestPct = (suggestedDiscount(v) * 100).toFixed(0)
  if (discount < -0.005) {
    return {
      reading: { cls: 'premium', label: 'premium' },
      headline: `Premium +${pct} %`,
      body: 'Above NAV. A buyer only pays this if they need this exact vault — expect a thin book.',
    }
  }
  if (reading.cls === 'distress') {
    return {
      reading,
      headline: `Distress −${pct} %`,
      body: v.rating.tone === 'bad'
        ? `${v.rating.why}. The discount does not make this cheap — the grade already reads the vault as a trap.`
        : `${v.rating.why}. Past ~12 % the book reads this as distress, not an exit fee.`,
    }
  }
  if (reading.cls === 'liquidity') {
    const delta = discount - suggestedDiscount(v)
    return {
      reading,
      headline: `Liquidity −${pct} %`,
      body: Math.abs(delta) < 0.015
        ? `${v.rating.why}. Around −${suggestPct} % is the exit fee this grade can justify — you pay for cash, the buyer takes the spread.`
        : delta > 0
          ? `Deeper than the −${suggestPct} % this grade can justify. Still a liquidity read, but you leave money on the table.`
          : `Tighter than −${suggestPct} %. Faster to post, slower to fill — buyers compare this to NAV.`,
    }
  }
  return {
    reading,
    headline: 'At par',
    body: `${v.rating.why}. Asking NAV means the buyer funds your exit for free. A small liquidity discount is what fills.`,
  }
}

/**
 * Le bandeau du mode consultation.
 *
 * Le déploiement Vercel est statique : `apps/web/build.mjs` copie `public/` et
 * les trois JSON, rien d'autre. Les routes `/api/*` vivent dans
 * `apps/web/server.mjs`, qui ne tourne pas là-bas — et c'est voulu, puisque le
 * règlement signe avec les seeds de `state.json`, qui est gitignoré.
 */
function renderPreviewBanner(box) {
  const deja = box.querySelector(':scope > .preview-banner')
  // `renderBook()` tourne à chaque rendu : sans ça, les bandeaux s'empileraient.
  if (state.apiLive) { deja?.remove(); return }
  if (deja) return
  const b = el('div', 'preview-banner')
  b.innerHTML = `<strong>Read-only preview.</strong> The book, the ratings and the
    on-chain proofs are live. Posting, buying, confirming and withdrawing need the
    local server — <code>npm run web</code> — because settlement signs with seeds
    that never leave the machine.`
  box.prepend(b)
}

function renderBook() {
  renderPreviewBanner($('#view-book') ?? document.body)
  const body = $('#book-body')
  body.innerHTML = ''
  const now = rippleNow()
  const visible = state.offers.filter(o => {
    if (state.filter === 'mine') return state.session && o.seller === state.session.account
    if (state.filter === 'open') return o.status === 'open' && !isExpired(o)
    return true
  })
  // les vivantes d'abord, par fraîcheur ; puis l'historique
  visible.sort((a, b) => {
    const la = a.status === 'open' && !isExpired(a) ? 0 : 1
    const lb = b.status === 'open' && !isExpired(b) ? 0 : 1
    return la - lb || b.postedAt - a.postedAt
  })
  for (const o of visible) {
    const row = offerRow(o)
    if (row) body.appendChild(row)
  }
  $('#book-empty').hidden = visible.length > 0
}

/* ============ vaults ============ */

function renderVaults() {
  const grid = $('#vault-grid')
  grid.innerHTML = ''
  const mineByKey = new Map(sessionHoldings().map(h => [h.vault.key, h]))
  for (const v of Object.values(state.vaults)) {
    const mine = mineByKey.get(v.key)
    const card = el('div', ['vault-card', v.transferable ? '' : 'is-locked', mine ? 'has-mine' : ''].filter(Boolean).join(' '))
    card.innerHTML = `
      <div class="vc-head">
        <span class="grade tone-${v.rating.tone}">${v.rating.grade}</span>
        <span class="v-name">${v.short}</span>
        ${v.clawbackArmed ? '<span class="badge-claw">clawback armed</span>' : ''}
        <span class="badge-phase">${v.phase}</span>
      </div>
      <div class="vc-why">${v.rating.why}</div>
      <div class="vc-stats">
        <div class="vc-stat"><div class="k">Total NAV</div><div class="v">${fmtAsset(v.assetsTotal, v, { compact: true })}</div></div>
        <div class="vc-stat"><div class="k">Available</div><div class="v">${fmtAsset(v.assetsAvailable, v, { compact: true })}</div></div>
        <div class="vc-stat"><div class="k">Shares issued</div><div class="v">${fmtNum(v.outstanding, true)}</div></div>
        <div class="vc-stat"><div class="k">NAV / share</div><div class="v">${fmtNav(v.navPerShare)}</div></div>
        <div class="vc-stat"><div class="k">Total term</div><div class="v">${fmtDuration(v.redemptionDate - v.subscriptionDate)}</div></div>
        <div class="vc-stat"><div class="k">To maturity</div><div class="v">${v.redemptionDate > rippleNow() ? fmtDuration(v.redemptionDate - rippleNow()) : 'matured'}</div></div>
      </div>
      ${mine
        ? `<div class="vc-you has">You hold <strong>${fmtNum(mine.shares, true)}</strong> shares · ${fmtAsset(mine.value, v, { compact: true })}</div>`
        : state.session
          ? '<div class="vc-you">No shares on this wallet</div>'
          : ''}
    `
    grid.appendChild(card)
  }
}

/* ============ mes parts ============ */

function renderShares() {
  const box = $('#shares-content')
  const sub = $('#shares-sub')
  const refresh = $('#btn-refresh-shares')
  box.innerHTML = ''
  if (refresh) {
    refresh.hidden = !state.session
    refresh.disabled = state.chain.status === 'loading'
  }
  if (!state.session) {
    sub.textContent = 'Connect a wallet to see your positions.'
    const b = el('button', 'btn btn-primary', 'Connect a wallet')
    b.addEventListener('click', connectFlow)
    box.appendChild(b)
    return
  }
  const holdings = sessionHoldings()
  renderPending(box)
  renderCommitments(box)
  const myOffers = state.offers.filter(o =>
    o.seller === state.session.account && o.status === 'open' && !isExpired(o))
  const locked = new Map()
  for (const o of myOffers) {
    const v = vaultById(state.vaults, o.vaultId)
    if (v) locked.set(v.key, (locked.get(v.key) ?? 0) + Number(o.shares))
  }
  const totalXrp = holdings.filter(h => h.vault.isXrp).reduce((s, h) => s + h.value, 0)
  const src = holdingsSourceLabel()

  sub.textContent = `Positions of ${shortAddr(state.session.account)} — ${src}.`

  const summary = el('div', 'wallet-summary')
  summary.innerHTML = `
    <div class="ws-item"><div class="k">Vaults</div><div class="v">${holdings.length}</div></div>
    <div class="ws-item"><div class="k">NAV value (XRP vaults)</div><div class="v">${fmtAsset(totalXrp, { isXrp: true })}</div></div>
    <div class="ws-item"><div class="k">Open offers</div><div class="v">${myOffers.length}</div></div>
    <div class="ws-item"><div class="k">Source</div><div class="v shares-status ${sourceClass()}">${src}</div></div>
  `
  box.appendChild(summary)

  if (state.chain.status === 'loading' && !holdings.length) {
    box.appendChild(el('p', 'holdings-empty', 'Reading MPToken balances on Devnet…'))
    return
  }
  if (!holdings.length) {
    const empty = el('p', 'holdings-empty')
    empty.innerHTML = state.chain.status === 'error'
      ? `Could not read the ledger (${state.chain.error ?? 'unreachable'}). This address is not in the snapshot either.`
      : `This wallet holds no share MPTokens of the listed vaults.<br>Offers on the book come from the test world — your position is read live via <span class="mono">account_objects</span>.`
    box.appendChild(empty)
    return
  }

  const list = el('div', 'holdings')
  for (const h of holdings) {
    const inBook = locked.get(h.vault.key) ?? 0
    const row = el('div', 'holding-row')
    row.innerHTML = `
      <span class="grade tone-${h.vault.rating.tone}">${h.vault.rating.grade}</span>
      <div class="grow">
        <div class="v-name">${h.vault.short}</div>
        <div class="k">${h.vault.phase}${h.vault.transferable ? '' : ' · non-transferable'}</div>
      </div>
      <div>
        <div class="k">Shares</div>
        <div class="mono">${fmtNum(h.shares, true)}</div>
      </div>
      <div>
        <div class="k">NAV value</div>
        <div class="mono">${fmtAsset(h.value, h.vault, { compact: true })}</div>
      </div>
      <div>
        <div class="k">Listed</div>
        <div class="mono">${inBook ? fmtNum(inBook, true) : '—'}</div>
      </div>
      ${h.vault.transferable ? '<button class="btn btn-ghost btn-sm" data-sell>Sell</button>' : ''}
    `
    row.querySelector('[data-sell]')?.addEventListener('click', () => focusTicket(h.vault.key))
    list.appendChild(row)
  }
  box.appendChild(list)
}

/* ============ drawer détail ============ */

function openDrawer(o, v) {
  const d = discountOf(o, v)
  const nav = Number(o.shares) * v.navPerShare
  const mine = state.session && o.seller === state.session.account
  const reading = readingOf(v, d)
  $('#drawer-content').innerHTML = `
    <div class="d-title">Offer ${o.id}${mine ? '<span class="tag-mine">you</span>' : ''}</div>
    <div class="d-sub">${o.vaultId}</div>

    <div class="d-section">
      <h3>Terms</h3>
      <div class="kv"><span class="k">Shares</span><span class="v">${fmtShares(o.shares)}</span></div>
      <div class="kv"><span class="k">Ask price</span><span class="v ${mine ? 'mine' : ''}">${fmtAsset(Number(o.price), v)}</span></div>
      <div class="kv"><span class="k">NAV value</span><span class="v">${fmtAsset(nav, v)}</span></div>
      <div class="kv"><span class="k">Discount</span><span class="v">−${(d * 100).toFixed(2)} %</span></div>
      <div class="kv"><span class="k">Seller</span><span class="v">${shortAddr(o.seller)}</span></div>
    </div>

    <div class="d-section">
      <h3>The vault</h3>
      <div class="kv"><span class="k">Scenario</span><span class="v">${v.short}</span></div>
      <div class="kv"><span class="k">Analyst grade</span><span class="v">${v.rating.grade}</span></div>
      <div class="kv"><span class="k">Phase</span><span class="v">${v.phase}</span></div>
      <div class="kv"><span class="k">Total NAV</span><span class="v">${fmtAsset(v.assetsTotal, v, { compact: true })}</span></div>
      <div class="kv"><span class="k">Total term</span><span class="v">${fmtDuration(v.redemptionDate - v.subscriptionDate)}</span></div>
      <div class="kv"><span class="k">To maturity</span><span class="v">${v.redemptionDate > rippleNow() ? fmtDuration(v.redemptionDate - rippleNow()) : 'matured'}</span></div>
      <div class="kv"><span class="k">Clawback</span><span class="v">${v.clawbackArmed ? 'armed ⚠' : 'no'}</span></div>
    </div>

    <div class="d-verdict">
      <strong>${reading.label === 'at par' ? 'At par.' : reading.label === 'liquidity discount' ? 'Liquidity discount.' : 'Distress discount.'}</strong>
      ${v.rating.why}.
      ${reading.cls === 'distress'
        ? 'Two offers at the same price can be a bargain and a trap — this one leans the wrong way.'
        : reading.cls === 'liquidity'
          ? 'The fund holds: the seller pays for their exit, the buyer pockets the spread.'
          : ''}
    </div>

    <div class="d-actions">
      ${o.status === 'open' && !isExpired(o)
        ? mine
          ? '<button class="btn btn-mine" data-d-cancel>Withdraw offer</button>'
          : '<button class="btn btn-primary" data-d-buy>Buy back this position</button>'
        : o.txHash
          ? `<a class="btn btn-ghost" href="https://devnet.xrpl.org/transactions/${o.txHash}" target="_blank" rel="noopener">On-chain proof ↗</a>`
          : ''}
    </div>
  `
  $('#drawer-content').querySelector('[data-d-buy]')?.addEventListener('click', () => { closeDrawer(); buyFlow(o, v) })
  $('#drawer-content').querySelector('[data-d-cancel]')?.addEventListener('click', () => { closeDrawer(); cancelOffer(o) })
  $('#drawer').classList.add('is-open')
  $('#drawer').setAttribute('aria-hidden', 'false')
}

function closeDrawer() {
  $('#drawer').classList.remove('is-open')
  $('#drawer').setAttribute('aria-hidden', 'true')
}
$('#drawer-close').addEventListener('click', closeDrawer)
$('#drawer').addEventListener('click', e => { if (e.target === $('#drawer')) closeDrawer() })

/* ============ modales ============ */

function openModal(html) {
  $('#modal-box').innerHTML = html
  $('#modal-root').hidden = false
  return $('#modal-box')
}
function closeModal() { $('#modal-root').hidden = true }
document.querySelector('.modal-backdrop').addEventListener('click', closeModal)
window.addEventListener('keydown', e => { if (e.key === 'Escape') { closeModal(); closeDrawer() } })

/* ============ connexion wallet ============ */

function connectFlow() {
  if (state.session) {
    const box = openModal(`
      <h2>Wallet connected</h2>
      <p class="m-sub">${state.session.account}</p>
      <div class="m-actions">
        <button class="btn btn-ghost" data-x-disconnect>Disconnect</button>
        <button class="btn btn-primary" data-x-close>Close</button>
      </div>
    `)
    box.querySelector('[data-x-close]').addEventListener('click', closeModal)
    box.querySelector('[data-x-disconnect]').addEventListener('click', () => {
      state.session = null
      state.chain = { account: null, holdings: null, status: 'idle', error: null }
      saveSession(null)
      closeModal(); render()
      toast('Wallet disconnected')
    })
    return
  }

  const ids = candidates(state.vaults)
  const box = openModal(`
    <h2>Connect a wallet</h2>
    <p class="m-sub">Via the browser extension, or with a test-world identity —
      a share holder, member of the permissioned domain (their seeds stay in the CLI).</p>
    <button class="identity" id="ext-connect">
      <span class="avatar">⌘</span>
      <span class="who">
        <span class="addr">Browser extension</span><br>
        <span class="desc">XRPL Dev Wallet / Crossmark / GemWallet — opens the extension to sign</span>
      </span>
    </button>
    <div id="id-list"></div>
  `)
  box.querySelector('#ext-connect').addEventListener('click', async () => {
    try {
      const { account, via } = await connectExternal()
      state.session = { account, via }
      saveSession(state.session)
      closeModal(); render()
      refreshHoldings()
      toast(`Connected via ${via} — ${shortAddr(account)}`)
    } catch (err) {
      toast(err.message)
    }
  })
  const list = box.querySelector('#id-list')
  for (const c of ids) {
    const desc = c.holdings.map(h => `${state.vaults[h.vault].short} · ${fmtNum(h.shares, true)} shares`).join(' — ')
    const b = el('button', 'identity')
    b.innerHTML = `
      <span class="avatar">${c.account.slice(1, 3)}</span>
      <span class="who">
        <span class="addr">${shortAddr(c.account)}</span><br>
        <span class="desc">${desc}</span>
      </span>
    `
    b.addEventListener('click', () => {
      state.session = { account: c.account }
      saveSession(state.session)
      closeModal(); render()
      refreshHoldings()
      toast(`Connected — ${shortAddr(c.account)}`)
    })
    list.appendChild(b)
  }
}

$('#btn-wallet').addEventListener('click', connectFlow)

/* ============ vendre ============ */

/**
 * Le ticket — le formulaire de vente, en fenêtre permanente à droite
 * du carnet, comme sur une vraie interface de marché.
 */
function renderTicket() {
  const box = $('#ticket')
  const t = state.ticket

  if (!state.session) {
    box.innerHTML = `
      <div class="t-head">Sell shares</div>
      <div class="t-sub">posted to the book · Batch all-or-nothing settlement</div>
      <p class="t-empty">Connect a wallet to post an offer: the book only
        accepts holders who are domain members.</p>
      <div class="t-grow"></div>
      <button class="btn btn-primary" data-t-connect>Connect a wallet</button>
    `
    box.querySelector('[data-t-connect]').addEventListener('click', connectFlow)
    return
  }

  const holdings = sessionHoldings().filter(h => h.vault.transferable)
  if (!holdings.length) {
    const waiting = state.chain.status === 'loading'
    box.innerHTML = `
      <div class="t-head">Sell shares</div>
      <div class="t-sub">${shortAddr(state.session.account)}</div>
      <p class="t-empty">${waiting
        ? 'Reading share balances on Devnet…'
        : 'No transferable shares on this account.'}</p>
    `
    return
  }

  if (!holdings.some(h => h.vault.key === t.vault)) t.vault = holdings[0].vault.key

  const opts = holdings.map(h =>
    `<option value="${h.vault.key}" ${h.vault.key === t.vault ? 'selected' : ''}>${h.vault.short} — ${fmtNum(h.shares, true)} shares</option>`).join('')

  box.innerHTML = `
    <div class="t-head">Sell shares</div>
    <div class="t-sub">${shortAddr(state.session.account)} · Batch tfAllOrNothing</div>
    <div class="field">
      <label>Vault</label>
      <select id="s-vault">${opts}</select>
    </div>
    <div class="field">
      <label>Shares to sell</label>
      <input id="s-shares" type="number" min="1" placeholder="0" value="${t.shares}">
      <div class="hint" id="s-shares-hint"></div>
    </div>
    <div class="field">
      <label>Ask price <span class="t-ask-unit" id="s-price-unit"></span></label>
      <input id="s-price" type="number" min="0" step="any" placeholder="0.00" value="${t.price}">
      <input id="s-price-slider" class="t-slider" type="range" min="0" max="1" step="any" disabled>
      <div class="t-slider-scale">
        <span>−50%</span>
        <span class="nav">NAV</span>
        <span>+10%</span>
      </div>
      <div class="t-anchors">
        <button type="button" class="t-anchor" data-ask="suggest" id="s-ask-suggest">Suggested</button>
        <button type="button" class="t-anchor" data-ask="nav">At NAV</button>
        <button type="button" class="t-anchor" data-ask="book" id="s-ask-book" hidden>Book</button>
      </div>
      <div class="hint" id="s-price-hint"></div>
    </div>
    <div class="t-reading" id="s-reading" hidden></div>
    <div class="t-grow"></div>
    <button class="btn btn-primary" data-s-post disabled>Post offer</button>
  `

  const $v = box.querySelector('#s-vault')
  const $sh = box.querySelector('#s-shares')
  const $pr = box.querySelector('#s-price')
  const $sl = box.querySelector('#s-price-slider')
  const $post = box.querySelector('[data-s-post]')
  const $read = box.querySelector('#s-reading')
  const $book = box.querySelector('#s-ask-book')

  const current = () => holdings.find(h => h.vault.key === $v.value)

  function setAsk(native, v) {
    $pr.value = fmtUi(toUi(native, v), v)
    refresh()
  }

  function refresh() {
    t.vault = $v.value
    t.shares = $sh.value
    t.price = $pr.value
    const h = current()
    const v = h.vault
    const suggest = suggestedDiscount(v)
    // ⭐ Le plafond n'est pas le solde : c'est le solde MOINS ce qui est déjà
    //    promis sur d'autres offres en cours. Sans ça, 25 M de parts
    //    autorisent deux annonces de 25 M, et la seconde meurt au règlement.
    const promis = engagedOn(v.vaultId)
    const libre = Math.max(0, h.shares - promis)
    $sh.max = String(libre)
    $('#s-shares-hint').textContent = promis > 0
      ? `${fmtShares(libre)} free — ${fmtShares(promis)} already promised on other offers`
      : `available: ${fmtShares(h.shares)} shares`
    $('#s-price-unit').textContent = v.isXrp ? 'XRP' : v.asset
    const shares = Number($sh.value)
    const nav = shares * v.navPerShare
    const okShares = shares > 0 && shares <= libre
    if (okShares && $pr.value === '') $pr.value = fmtUi(toUi(nav * (1 - suggest), v), v)
    const priceUi = Number($pr.value)
    const price = toNative(priceUi, v)
    const okPrice = price > 0 && nav > 0
    $('#s-shares-hint').classList.toggle('error', $sh.value !== '' && !okShares)
    if (!state.apiLive) {
      $post.disabled = true
      $post.title = 'Read-only preview — run npm run web to post offers'
    }

    const navUi = toUi(nav, v)
    if (okShares && navUi > 0) {
      $sl.min = String(navUi * 0.50)
      $sl.max = String(navUi * 1.10)
      $sl.step = v.isXrp ? '0.0001' : '1'
      $sl.disabled = false
      if (priceUi > 0) $sl.value = String(Math.min(navUi * 1.10, Math.max(navUi * 0.50, priceUi)))
    } else {
      $sl.disabled = true
    }

    box.querySelector('#s-ask-suggest').textContent = `Suggested −${(suggest * 100).toFixed(0)} %`
    const book = okShares ? bookMedianNative(v.vaultId, shares) : null
    if (book && nav > 0) {
      const bd = 1 - book / nav
      $book.hidden = false
      $book.textContent = `Book ${bd >= 0 ? '−' : '+'}${(Math.abs(bd) * 100).toFixed(1)} %`
    } else $book.hidden = true

    if (okShares && okPrice) {
      const d = 1 - price / nav
      const advice = askAdvice(v, d)
      $read.hidden = false
      $read.className = `t-reading ${advice.reading.cls}`
      $read.innerHTML = `
        <div class="t-read-top">
          <span class="reading ${advice.reading.cls}">${advice.reading.label}</span>
          <span class="t-read-pct">${advice.headline}</span>
        </div>
        <p>${advice.body}</p>
        <div class="t-read-nav">${fmtShares(shares)} shares · NAV ${fmtAsset(nav, v)} → ${fmtAsset(price, v)}</div>
      `
      $('#s-price-hint').textContent = 'slider is the ask — 50 % of NAV to +10 %'
    } else {
      $read.hidden = true
      $('#s-price-hint').textContent = okShares
        ? 'drag the slider against NAV'
        : (v.isXrp ? 'in XRP — set a size first' : `in ${v.asset} — set a size first`)
    }
    t.price = $pr.value
    $post.disabled = !(okShares && okPrice)
  }

  $v.addEventListener('input', () => { t.price = ''; $pr.value = ''; refresh() })
  $sh.addEventListener('input', () => {
    const v = current().vault
    const prevShares = Number(t.shares)
    const prevPrice = Number($pr.value)
    const nextShares = Number($sh.value)
    if (prevShares > 0 && nextShares > 0 && prevPrice > 0) {
      const prevNav = toUi(prevShares * v.navPerShare, v)
      if (prevNav > 0) {
        const d = 1 - prevPrice / prevNav
        $pr.value = fmtUi(toUi(nextShares * v.navPerShare * (1 - d), v), v)
      }
    }
    refresh()
  })
  $pr.addEventListener('input', refresh)
  $sl.addEventListener('input', () => {
    const v = current().vault
    $pr.value = fmtUi(Number($sl.value), v)
    refresh()
  })
  box.querySelectorAll('[data-ask]').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = current().vault
      const shares = Number($sh.value)
      if (!(shares > 0)) return
      const nav = shares * v.navPerShare
      const native = btn.dataset.ask === 'nav' ? nav
        : btn.dataset.ask === 'suggest' ? nav * (1 - suggestedDiscount(v))
        : bookMedianNative(v.vaultId, shares)
      if (native) setAsk(native, v)
    })
  })
  refresh()

  $post.addEventListener('click', async () => {
    const h = current()
    const v = h.vault
    const shares = Number($sh.value)
    const price = v.isXrp ? Math.round(Number($pr.value) * 1_000_000) : Number($pr.value)
    if (!(shares > 0) || !(price > 0)) return

    $post.disabled = true
    const ancien = $post.textContent
    $post.textContent = 'Reserving tickets…'
    try {
      // Publier ne signe RIEN. Le serveur réserve deux Tickets au vendeur :
      // c'est ce qui rendra l'offre durable, et annulable, plus tard.
      const r = await api('offers', {
        seller: state.session.account, vaultId: v.vaultId,
        shares: String(shares), price: String(price),
      })
      state.ticket = { vault: v.key, shares: '', price: '' }
      await reloadOffers()
      toast(r.ticketsCreated
        ? `Offer ${r.offer.id} posted — ${r.ticketsCreated} ticket(s) reserved, no expiry`
        : `Offer ${r.offer.id} posted — no expiry, nothing signed yet`, true)
    } catch (e) {
      toast(e.message)
    } finally {
      $post.disabled = false
      $post.textContent = ancien
    }
  })
}

/* ============ le rail durable, côté interface ============ */

/**
 * Un appel au serveur. Les refus métier (offre déjà prise, pas de seed locale)
 * arrivent en 409 avec un message lisible : on le remonte tel quel plutôt que
 * de le traduire en « something went wrong ».
 */
async function api(route, body = null) {
  let r
  try {
    r = await fetch(`/api/${route}`, body
      ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : {})
  } catch {
    throw new Error(HORS_LIGNE)
  }
  // Un déploiement statique (Vercel) renvoie la page d'erreur, pas du JSON :
  // le distinguer d'un refus métier évite d'afficher « erreur 404 » à l'écran.
  const data = await r.json().catch(() => null)
  if (data == null) throw new Error(HORS_LIGNE)
  if (!r.ok) throw new Error(data.error ?? `erreur ${r.status}`)
  return data
}

const HORS_LIGNE = 'Read-only preview — settlement runs against a local server (npm run web).'

/** Relit le carnet depuis le serveur — la CLI écrit le même fichier. */
async function reloadOffers({ repaint = true } = {}) {
  const account = state.session?.account
  const r = await api(`offers${account ? `?account=${account}` : ''}`)
  state.offers = r.offers
  state.pending = r.pending
  state.commitments = r.commitments ?? []
  state.canSign = r.canSign
  state.apiLive = true
  if (repaint) render()
  return r
}

/** Amène le ticket sous les yeux, éventuellement pré-rempli sur un vault. */
function focusTicket(preselect) {
  if (!state.session) return connectFlow()
  if (preselect) {
    state.ticket.vault = preselect
    const held = sessionHoldings().find(h => h.vault.key === preselect)
    if (held && !state.ticket.shares) state.ticket.shares = String(held.shares)
  }
  if (state.tab !== 'book') document.querySelector('.tab[data-tab="book"]').click()
  else renderTicket()
  const box = $('#ticket')
  box.classList.remove('flash')
  requestAnimationFrame(() => box.classList.add('flash'))
  box.querySelector('#s-shares')?.focus()
}

/**
 * ⭐ ANNULER — un clic, et l'offre devient insoumettable.
 *
 * Le serveur consomme le Ticket qui porte l'enveloppe. Tout Batch signé sur ce
 * ticket meurt (`tefNO_TICKET`), y compris un Batch que l'acheteur a déjà signé
 * et qui circule. C'est la seule annulation que le ledger fait respecter :
 * retirer une ligne d'un fichier n'a jamais empêché personne de rejouer.
 */
async function cancelOffer(o) {
  const box = openModal(`
    <h2>Withdraw ${o.id}</h2>
    <p class="m-sub">${fmtShares(o.shares)} shares · ${o.status === 'matched'
      ? 'a buyer has already signed — withdrawing still works'
      : 'no one has taken it yet'}</p>
    <p class="m-note">This burns the Ticket carrying the offer. Any signed Batch
      becomes unsubmittable — <code>tefNO_TICKET</code>. Cost: 1 drop.</p>
    <div class="m-actions">
      <button class="btn btn-ghost" data-c-cancel>Keep it</button>
      <button class="btn btn-primary" data-c-go>Withdraw</button>
    </div>
  `)
  box.querySelector('[data-c-cancel]').addEventListener('click', closeModal)
  box.querySelector('[data-c-go]').addEventListener('click', async e => {
    e.target.disabled = true
    e.target.textContent = 'Burning ticket…'
    try {
      const r = await api(`offers/${o.id}/cancel`, { seller: o.seller })
      closeModal()
      await reloadOffers()
      toast(r.onChain
        ? `Offer ${o.id} withdrawn — ticket ${r.ticket} burned on-chain`
        : `Offer ${o.id} withdrawn from the book`)
    } catch (err) {
      e.target.disabled = false
      e.target.textContent = 'Withdraw'
      toast(err.message)
    }
  })
}

/* ============ racheter ============ */

function buyFlow(o, v) {
  if (!state.session) return connectFlow()
  const steps = [
    ['①', 'Analyst — nature of the discount'],
    ['②', 'Preflight — is the offer still honourable?'],
    ['③', 'Batch tfAllOrNothing — shares against price'],
    ['④', 'Balance reconciliation'],
  ]
  const box = openModal(`
    <h2>Buy back ${o.id}</h2>
    <p class="m-sub">${fmtShares(o.shares)} shares of “${v.short}” for ${fmtAsset(Number(o.price), v)}</p>
    <div class="steps">
      ${steps.map(([n, label], i) => `
        <div class="step" data-step="${i}">
          <span class="s-ico">${n}</span><span>${label}</span>
        </div>`).join('')}
    </div>
    <div class="m-actions">
      <button class="btn btn-ghost" data-b-cancel>Cancel</button>
      <button class="btn btn-primary" data-b-go>Run settlement</button>
    </div>
  `)
  box.querySelector('[data-b-cancel]').addEventListener('click', closeModal)
  box.querySelector('[data-b-go]').addEventListener('click', async e => {
    e.target.disabled = true
    box.querySelector('[data-b-cancel]').disabled = true
    const rows = box.querySelectorAll('.step')
    const avance = i => {
      rows[i].classList.remove('is-active'); rows[i].classList.add('is-done')
      rows[i].querySelector('.s-ico').textContent = '✓'
    }
    rows[0].classList.add('is-active')
    try {
      // L'acheteur pose ses BatchSigners. C'est un engagement réel : à partir
      // d'ici, il ne peut plus se dédire — seul le vendeur garde la main.
      const r = await api(`offers/${o.id}/take`, { buyer: state.session.account })
      avance(0)
      rows[1].classList.add('is-active'); avance(1)
      rows[2].classList.add('is-active'); avance(2)
      closeModal()
      await reloadOffers()
      toast(`Committed to ${o.id}${r.needsAuthorize ? ' (MPT authorisation included)' : ''}`
        + ' — waiting for the seller. No deadline.', true)
    } catch (err) {
      closeModal()
      toast(err.message)
    }
  })
}

/**
 * Les parts que je promets déjà sur ce vault — offres engagées comprises.
 *
 * Une offre `matched` a disparu du carnet mais promet toujours ses parts : ne
 * compter que les `open` rouvrirait exactement la survente qu'on ferme ici.
 */
function engagedOn(vaultId) {
  const me = state.session?.account
  if (!me) return 0
  return state.offers
    .filter(o => o.seller === me && o.vaultId === vaultId
      && ['open', 'matched', 'armed'].includes(o.status))
    .reduce((s, o) => s + Number(o.shares), 0)
}

/** Depuis combien de temps, en clair. Aucune échéance : on mesure l'attente. */
function depuis(rippleTs) {
  if (!rippleTs) return 'just now'
  const s = Math.max(0, rippleNow() - rippleTs)
  if (s < 90) return `${s}s`
  if (s < 5400) return `${Math.round(s / 60)} min`
  if (s < 172800) return `${Math.round(s / 3600)} h`
  return `${Math.round(s / 86400)} d`
}

/**
 * Mes engagements d'acheteur.
 *
 * Il n'y a PAS de compte à rebours à afficher : l'offre est portée par des
 * Tickets, pas par des séquences, et l'enveloppe n'a pas de
 * `LastLedgerSequence`. Le vendeur peut confirmer dans dix minutes ou jamais.
 * Ce qu'on montre à l'acheteur, c'est donc son temps d'attente — et la seule
 * chose qui le protège vraiment : le bouton pour se retirer.
 */
function renderCommitments(box) {
  const list = state.commitments ?? []
  if (!list.length) return
  const panel = el('div', 'pending-panel commit-panel')
  panel.innerHTML = `<div class="pending-head">
      <span class="pending-dot"></span>
      ${list.length} commitment${list.length > 1 ? 's' : ''} awaiting the seller
      <span class="pending-note">no deadline — you can withdraw at any time</span>
    </div>`
  for (const o of list) {
    const v = vaultById(state.vaults, o.vaultId)
    const row = el('div', 'pending-row')
    row.innerHTML = `
      <div class="grow">
        <div class="pending-title">${o.id} · ${fmtShares(o.shares)} shares of
          “${v?.short ?? o.vaultId.slice(0, 8)}”</div>
        <div class="pending-sub">signed ${depuis(o.matchedAt)} ago ·
          seller <span class="mono">${shortAddr(o.seller)}</span> has not confirmed</div>
      </div>
      <button class="btn btn-mine btn-sm" data-w-go>Withdraw commitment</button>
    `
    row.querySelector('[data-w-go]').addEventListener('click', () => withdrawFlow(o, v))
    panel.appendChild(row)
  }
  box.appendChild(panel)
}

/**
 * L'acheteur se retire. Il brûle l'un de SES tickets : le Batch devient
 * insoumettable, l'offre repasse au carnet, le vendeur n'a rien dépensé.
 */
function withdrawFlow(o, v) {
  const box = openModal(`
    <h2>Withdraw from ${o.id}</h2>
    <p class="m-sub">${fmtShares(o.shares)} shares · waiting ${depuis(o.matchedAt)}</p>
    <p class="m-note">This burns your own Ticket. The signed Batch becomes
      unsubmittable — the seller can no longer settle it, even if they confirm.
      The offer goes back on the book. Cost: 1 drop.</p>
    <div class="m-actions">
      <button class="btn btn-ghost" data-w-cancel>Keep waiting</button>
      <button class="btn btn-primary" data-w-ok>Withdraw</button>
    </div>
  `)
  box.querySelector('[data-w-cancel]').addEventListener('click', closeModal)
  box.querySelector('[data-w-ok]').addEventListener('click', async e => {
    e.target.disabled = true
    e.target.textContent = 'Burning ticket…'
    try {
      await api(`offers/${o.id}/unmatch`, { buyer: o.buyer })
      closeModal()
      await reloadOffers()
      toast(`Withdrawn from ${o.id} — the offer is back on the book`)
    } catch (err) {
      e.target.disabled = false
      e.target.textContent = 'Withdraw'
      toast(err.message)
    }
  })
}

/**
 * La file d'attente du vendeur — l'équivalent de la notification.
 *
 * Une offre `matched` ne périme pas : l'acheteur s'est engagé sur des Tickets,
 * pas sur des séquences. Le vendeur peut répondre dans une heure, demain, ou
 * retirer son offre. Le panneau le dit explicitement, parce que c'est
 * exactement le contraire de ce qu'on attend d'un règlement on-chain.
 */
function renderPending(box) {
  const list = state.pending ?? []
  if (!list.length) return
  const panel = el('div', 'pending-panel')
  panel.innerHTML = `<div class="pending-head">
      <span class="pending-dot"></span>
      ${list.length} offer${list.length > 1 ? 's' : ''} waiting for your confirmation
      <span class="pending-note">no deadline — the offer is carried by Tickets</span>
    </div>`
  for (const o of list) {
    const v = vaultById(state.vaults, o.vaultId)
    const row = el('div', 'pending-row')
    row.innerHTML = `
      <div class="grow">
        <div class="pending-title">${o.id} · ${fmtShares(o.shares)} shares of
          “${v?.short ?? o.vaultId.slice(0, 8)}”</div>
        <div class="pending-sub">buyer <span class="mono">${shortAddr(o.buyer)}</span> · signed, waiting</div>
      </div>
      <button class="btn btn-ghost btn-sm" data-p-withdraw>Withdraw</button>
      <button class="btn btn-primary btn-sm" data-p-confirm>Confirm</button>
    `
    row.querySelector('[data-p-confirm]').addEventListener('click', () => confirmFlow(o, v))
    row.querySelector('[data-p-withdraw]').addEventListener('click', () => cancelOffer(o))
    panel.appendChild(row)
  }
  box.appendChild(panel)
}

/* ============ la confirmation du vendeur ============ */

/**
 * ⭐ LE GESTE QUI RÈGLE.
 *
 * Tout le reste était gratuit : publier ne signe rien, s'engager ne dépense
 * rien. Ici le vendeur signe l'enveloppe et le Batch part. C'est aussi le
 * dernier moment où il peut dire non — d'où les deux boutons côte à côte.
 */
function confirmFlow(o, v) {
  const steps = [
    ['①', 'Seller signature — the envelope'],
    ['②', 'Batch tfAllOrNothing — shares against price'],
    ['③', 'Legs rebuilt from the ledger (the missing BatchExecutions)'],
    ['④', 'Balance reconciliation'],
  ]
  const box = openModal(`
    <h2>Someone wants to buy ${o.id}</h2>
    <p class="m-sub">${fmtShares(o.shares)} shares of “${v?.short ?? o.vaultId.slice(0, 8)}”
      for ${v ? fmtAsset(Number(o.price), v) : `${Number(o.price) / 1e6} XRP`}</p>
    <p class="m-note">Buyer <code>${shortAddr(o.buyer)}</code> has already signed.
      Nothing has moved yet, and nothing will until you confirm.</p>
    <div class="steps">
      ${steps.map(([n, label], i) => `
        <div class="step" data-step="${i}"><span class="s-ico">${n}</span><span>${label}</span></div>`).join('')}
    </div>
    <div class="m-actions">
      <button class="btn btn-ghost" data-k-withdraw>Withdraw instead</button>
      <button class="btn btn-primary" data-k-go>Confirm and settle</button>
    </div>
  `)
  box.querySelector('[data-k-withdraw]').addEventListener('click', () => { closeModal(); cancelOffer(o) })
  box.querySelector('[data-k-go]').addEventListener('click', async e => {
    e.target.disabled = true
    box.querySelector('[data-k-withdraw]').disabled = true
    const rows = box.querySelectorAll('.step')
    rows[0].classList.add('is-active')
    try {
      const r = await api(`offers/${o.id}/confirm`, { seller: o.seller })
      rows.forEach(row => {
        row.classList.remove('is-active'); row.classList.add('is-done')
        row.querySelector('.s-ico').textContent = '✓'
      })
      closeModal()
      await reloadOffers()
      toast(r.settled
        ? `${o.id} settled — ${r.legs.length} legs confirmed in the ledger`
        : `Not settled: ${r.message ?? r.stage}`, r.settled)
    } catch (err) {
      closeModal()
      await reloadOffers()
      toast(err.message)
    }
  })
}

/* ============ toast ============ */

let toastTimer
function toast(msg, mine = false) {
  const t = $('#toast')
  t.textContent = msg
  t.className = `toast ${mine ? 'mine' : ''}`
  t.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { t.hidden = true }, 3600)
}

/* ============ rendu global ============ */

function renderWalletChip() {
  const chip = $('#btn-wallet')
  const label = $('#wallet-label')
  if (state.session) {
    chip.classList.add('is-connected')
    label.innerHTML = `<span class="addr">${shortAddr(state.session.account)}</span>`
  } else {
    chip.classList.remove('is-connected')
    label.textContent = 'Connect'
  }
}

/* ============ le cadre du coffre épouse les panneaux ============ */

function updateVaultFrame() {
  const svg = document.getElementById('vault-frame')
  if (!svg || !document.body.classList.contains('inside')) return
  const active = document.querySelector('.view.is-active')
  const box = active?.querySelector('.book-layout, .vault-grid, #shares-content') ?? active
  if (!box) return
  const r = box.getBoundingClientRect()
  if (r.width < 40) return
  const W = window.innerWidth, H = window.innerHeight
  const L = Math.max(2, r.left / W * 100 - 0.6)
  const R = Math.min(98, r.right / W * 100 + 0.6)
  const T = Math.max(3, r.top / H * 100 - 1.2)
  const B = Math.min(97, r.bottom / H * 100 + 1.2)

  const polys = svg.querySelectorAll('polygon')          // top, bottom, left, right
  polys[0]?.setAttribute('points', `0,0 100,0 ${R},${T} ${L},${T}`)
  polys[1]?.setAttribute('points', `0,100 100,100 ${R},${B} ${L},${B}`)
  polys[2]?.setAttribute('points', `0,0 ${L},${T} ${L},${B} 0,100`)
  polys[3]?.setAttribute('points', `100,0 ${R},${T} ${R},${B} 100,100`)
  svg.querySelector('path')?.setAttribute('d',
    `M0,0 L${L},${T} M100,0 L${R},${T} M0,100 L${L},${B} M100,100 L${R},${B}`)
  const rect = svg.querySelector('rect')
  if (rect) {
    rect.setAttribute('x', L); rect.setAttribute('y', T)
    rect.setAttribute('width', R - L); rect.setAttribute('height', B - T)
  }
}

function sessionHoldings() {
  if (!state.session) return []
  if (state.chain.account === state.session.account && Array.isArray(state.chain.holdings))
    return state.chain.holdings
  return holdingsOf(state.vaults, state.session.account)
}

function holdingsSourceLabel() {
  if (state.chain.status === 'loading') return 'reading Devnet'
  if (state.chain.status === 'live') return 'on-chain · Devnet'
  if (state.chain.status === 'snapshot') return 'snapshot (ledger unreachable)'
  if (state.chain.status === 'error') return state.chain.error ?? 'ledger error'
  return 'snapshot'
}

function sourceClass() {
  if (state.chain.status === 'live') return 'is-live'
  if (state.chain.status === 'error') return 'is-error'
  return ''
}

let holdingsReq = 0
async function refreshHoldings() {
  const account = state.session?.account
  if (!account) {
    state.chain = { account: null, holdings: null, status: 'idle', error: null }
    return
  }
  const req = ++holdingsReq
  state.chain = { ...state.chain, account, status: 'loading', error: null }
  render()
  try {
    const rows = await fetchLiveHoldings(state.vaults, account)
    if (req !== holdingsReq) return
    state.chain = { account, holdings: rows, status: 'live', error: null }
  } catch (e) {
    if (req !== holdingsReq) return
    const fallback = holdingsOf(state.vaults, account)
    state.chain = {
      account,
      holdings: fallback,
      status: fallback.length ? 'snapshot' : 'error',
      error: e.message,
    }
  }
  render()
}

function render() {
  renderWalletChip()
  renderBook()
  renderTicket()
  renderVaults()
  renderShares()
  requestAnimationFrame(updateVaultFrame)
}

$('#btn-refresh-shares')?.addEventListener('click', () => refreshHoldings())

render()
if (state.session) refreshHoldings()
window.addEventListener('resize', () => requestAnimationFrame(updateVaultFrame))

// le compte à rebours des expirations vit
setInterval(renderBook, 30_000)
