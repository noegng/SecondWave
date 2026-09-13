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
import { icon, scenarioIcon } from './icons.mjs'

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
}

const DATA = await loadWorld()
state.vaults = DATA.vaults
state.offers = DATA.offers

// le sas : le coffre s'ouvre avant le marché, et le logo le rappelle.
// À chaque entrée, on relit la session posée dans le coffre.
initLock(DATA.world, () => {
  state.session = loadSession()
  render()
  refreshHoldings()
})
$('#brand-home').addEventListener('click', reopenLock)

/* ============ onglets ============ */

const tabs = [...document.querySelectorAll('.tab')]

function activateTab(tab, { focusTab = false } = {}) {
  state.tab = tab.dataset.tab
  tabs.forEach(t => {
    const on = t === tab
    t.classList.toggle('is-active', on)
    t.setAttribute('aria-selected', String(on))
    t.tabIndex = on ? 0 : -1
  })
  document.querySelectorAll('.view').forEach(v => {
    const on = v.id === `view-${state.tab}`
    v.classList.toggle('is-active', on)
    v.hidden = !on
  })
  if (focusTab) tab.focus()
  render()
}

for (const tab of tabs) {
  tab.addEventListener('click', () => activateTab(tab))
}
document.querySelector('.tabs')?.addEventListener('keydown', e => {
  const i = tabs.indexOf(document.activeElement)
  if (i < 0) return
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault()
    const dir = e.key === 'ArrowRight' ? 1 : -1
    activateTab(tabs[(i + dir + tabs.length) % tabs.length], { focusTab: true })
  } else if (e.key === 'Home') { e.preventDefault(); activateTab(tabs[0], { focusTab: true }) }
  else if (e.key === 'End') { e.preventDefault(); activateTab(tabs[tabs.length - 1], { focusTab: true }) }
})

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
  const live = o.status === 'open' && o.expiry > rippleNow()
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

  tr.tabIndex = 0
  tr.setAttribute('aria-label', `Offer ${o.id}, ${v.short}, ${reading.label}`)
  tr.innerHTML = `
    <td><span class="oid">${o.id}</span>${mine ? '<span class="tag-mine">you</span>' : ''}</td>
    <td>
      <div class="vault-cell">
        ${gradeMark(v)}
        <div>
          <div class="v-name">${v.short}</div>
          <div class="v-asset">${v.asset}</div>
        </div>
      </div>
    </td>
    <td class="num">${fmtNum(Number(o.shares), true)}</td>
    <td class="num price-cell">${fmtAsset(Number(o.price), v)}</td>
    <td class="num"><span class="discount ${deep ? 'deep' : ''}">−${(d * 100).toFixed(1)} %</span></td>
    <td>${live ? readingPill(reading) : status}</td>
    <td class="num">${buyCell(o, v, mine, live)}</td>
  `
  const open = () => openDrawer(o, v)
  tr.addEventListener('click', e => {
    if (e.target.closest('button, a')) return
    open()
  })
  tr.addEventListener('keydown', e => {
    if (e.target !== tr) return
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() }
  })
  const buyBtn = tr.querySelector('[data-buy]')
  if (buyBtn) buyBtn.addEventListener('click', () => buyFlow(o, v))
  const cancelBtn = tr.querySelector('[data-cancel]')
  if (cancelBtn) cancelBtn.addEventListener('click', () => cancelOffer(o))
  return tr
}

const STATUS_FR = { filled: 'settled', cancelled: 'cancelled', expired: 'expired' }

function buyCell(o, v, mine, live) {
  if (!live) return o.txHash
    ? `<a class="seller" href="https://devnet.xrpl.org/transactions/${o.txHash}" target="_blank" rel="noopener" onclick="event.stopPropagation()">proof ↗</a>`
    : ''
  if (mine) return `<button class="btn btn-mine btn-sm" data-cancel aria-label="Withdraw offer ${o.id}">${icon('exit', { size: 13 })} Withdraw</button>`
  return `<button class="btn btn-ghost btn-sm" data-buy aria-label="Buy ${fmtNum(Number(o.shares), true)} shares of ${v.short}">${icon('buy', { size: 13 })} Buy</button>`
}

/** liquidité ou détresse — la question centrale de l'analyste. */
function readingOf(v, discount) {
  if (v.rating.tone === 'bad' || (v.rating.tone === 'warn' && discount >= 0.12))
    return { cls: 'distress', label: 'distress discount', icon: 'distress' }
  if (discount >= 0.005)
    return { cls: 'liquidity', label: 'liquidity discount', icon: 'liquidity' }
  return { cls: '', label: 'at par', icon: 'par' }
}

function readingPill(reading) {
  return `<span class="reading ${reading.cls}">${icon(reading.icon || 'par', { size: 13 })}<span>${reading.label}</span></span>`
}

function gradeMark(v) {
  return `<span class="grade-wrap">
    <span class="grade tone-${v.rating.tone}">${v.rating.grade}</span>
    ${scenarioIcon(v.key, { label: v.short, size: 15 })}
  </span>`
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
    o.vaultId === vaultId && o.status === 'open' && o.expiry > now && Number(o.shares) > 0)
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
      reading: { cls: 'premium', label: 'premium', icon: 'premium' },
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

function renderBook() {
  const body = $('#book-body')
  body.innerHTML = ''
  const now = rippleNow()
  const visible = state.offers.filter(o => {
    if (state.filter === 'mine') return state.session && o.seller === state.session.account
    if (state.filter === 'open') return o.status === 'open' && o.expiry > now
    return true
  })
  // les vivantes d'abord, par fraîcheur ; puis l'historique
  visible.sort((a, b) => {
    const la = a.status === 'open' && a.expiry > now ? 0 : 1
    const lb = b.status === 'open' && b.expiry > now ? 0 : 1
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
        ${gradeMark(v)}
        <span class="v-name">${v.short}</span>
        ${v.clawbackArmed ? `<span class="badge-claw">${icon('claw', { size: 11 })} clawback</span>` : ''}
        ${v.transferable ? '' : `<span class="badge-phase">${icon('lock', { size: 11 })} locked</span>`}
        <span class="badge-phase">${v.phase}</span>
      </div>
      <div class="vc-why">${v.rating.why}</div>
      <div class="vc-hero">
        <div class="vc-stat"><div class="k">NAV / share</div><div class="v big">${fmtNav(v.navPerShare)}</div></div>
        <div class="vc-stat"><div class="k">Your position</div><div class="v big">${mine ? `${fmtNum(mine.shares, true)} · ${fmtAsset(mine.value, v, { compact: true })}` : '—'}</div></div>
      </div>
      <details class="vc-more">
        <summary>Details</summary>
        <div class="vc-stats">
          <div class="vc-stat"><div class="k">Total NAV</div><div class="v">${fmtAsset(v.assetsTotal, v, { compact: true })}</div></div>
          <div class="vc-stat"><div class="k">Available</div><div class="v">${fmtAsset(v.assetsAvailable, v, { compact: true })}</div></div>
          <div class="vc-stat"><div class="k">Shares issued</div><div class="v">${fmtNum(v.outstanding, true)}</div></div>
          <div class="vc-stat"><div class="k">Total term</div><div class="v">${fmtDuration(v.redemptionDate - v.subscriptionDate)}</div></div>
          <div class="vc-stat"><div class="k">To maturity</div><div class="v">${v.redemptionDate > rippleNow() ? fmtDuration(v.redemptionDate - rippleNow()) : 'matured'}</div></div>
        </div>
      </details>
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
    if (!refresh.dataset.iconed) {
      refresh.innerHTML = `${icon('refresh', { size: 13 })} Refresh`
      refresh.dataset.iconed = '1'
    }
  }
  if (!state.session) {
    sub.textContent = 'Connect a wallet to see your positions.'
    const b = el('button', 'btn btn-primary', 'Connect a wallet')
    b.addEventListener('click', connectFlow)
    box.appendChild(b)
    return
  }
  const holdings = sessionHoldings()
  const myOffers = state.offers.filter(o => o.seller === state.session.account && o.status === 'open' && o.expiry > rippleNow())
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
    <div class="ws-item"><div class="k">Source</div><div class="v shares-status ${sourceClass()}">${icon('chain', { size: 13 })} ${src}</div></div>
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
      ${gradeMark(h.vault)}
      <div class="grow">
        <div class="v-name">${h.vault.short}</div>
        <div class="k">${h.vault.phase}${h.vault.transferable ? '' : ` · ${icon('lock', { size: 11 })} locked`}</div>
      </div>
      <div>
        <div class="k">Shares</div>
        <div class="hold-val">${fmtNum(h.shares, true)}</div>
      </div>
      <div>
        <div class="k">NAV value</div>
        <div class="hold-val">${fmtAsset(h.value, h.vault, { compact: true })}</div>
      </div>
      <div>
        <div class="k">Listed</div>
        <div class="hold-val">${inBook ? fmtNum(inBook, true) : '—'}</div>
      </div>
      ${h.vault.transferable ? `<button class="btn btn-ghost btn-sm" data-sell aria-label="Sell shares of ${h.vault.short}">${icon('sell', { size: 13 })} Sell</button>` : ''}
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
      <div class="kv"><span class="k">Expires</span><span class="v">${timeLeft(o).label}</span></div>
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
      ${readingPill(reading)}
      <strong>${reading.label === 'at par' ? 'At par.' : reading.label === 'liquidity discount' ? 'Liquidity discount.' : 'Distress discount.'}</strong>
      ${v.rating.why}.
      ${reading.cls === 'distress'
        ? 'Two offers at the same price can be a bargain and a trap — this one leans the wrong way.'
        : reading.cls === 'liquidity'
          ? 'The fund holds: the seller pays for their exit, the buyer pockets the spread.'
          : ''}
    </div>

    <div class="d-actions">
      ${o.status === 'open' && o.expiry > rippleNow()
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
  lastFocus = document.activeElement
  $('#drawer-close').focus()
}

function closeDrawer() {
  $('#drawer').classList.remove('is-open')
  $('#drawer').setAttribute('aria-hidden', 'true')
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus()
}
$('#drawer-close').addEventListener('click', closeDrawer)
$('#drawer').addEventListener('click', e => { if (e.target === $('#drawer')) closeDrawer() })

/* ============ modales ============ */

let lastFocus = null
const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

function trapFocus(root, e) {
  if (e.key !== 'Tab') return
  const nodes = [...root.querySelectorAll(FOCUSABLE)].filter(n => !n.disabled && n.offsetParent !== null)
  if (!nodes.length) return
  const first = nodes[0], last = nodes[nodes.length - 1]
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
}

function openModal(html) {
  lastFocus = document.activeElement
  $('#modal-box').innerHTML = html
  $('#modal-root').hidden = false
  const box = $('#modal-box')
  box.querySelector(FOCUSABLE)?.focus()
  return box
}
function closeModal() {
  $('#modal-root').hidden = true
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus()
}
document.querySelector('.modal-backdrop').addEventListener('click', closeModal)
$('#modal-box').addEventListener('keydown', e => trapFocus($('#modal-box'), e))
$('#drawer .drawer-panel')?.addEventListener('keydown', e => trapFocus($('#drawer .drawer-panel'), e))
window.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return
  if (!$('#modal-root').hidden) closeModal()
  else closeDrawer()
})

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
        <button type="button" class="t-anchor" data-ask="suggest" id="s-ask-suggest">${icon('target', { size: 12 })} Suggested</button>
        <button type="button" class="t-anchor" data-ask="nav">${icon('equal', { size: 12 })} At NAV</button>
        <button type="button" class="t-anchor" data-ask="book" id="s-ask-book" hidden>${icon('book', { size: 12 })} Book</button>
      </div>
      <div class="hint" id="s-price-hint"></div>
    </div>
    <div class="t-reading" id="s-reading" hidden></div>
    <div class="t-grow"></div>
    <button class="btn btn-primary" data-s-post disabled>${icon('sell', { size: 14 })} Post offer</button>
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
    $('#s-shares-hint').textContent = `available: ${fmtShares(h.shares)} shares`
    $('#s-price-unit').textContent = v.isXrp ? 'XRP' : v.asset
    const shares = Number($sh.value)
    const nav = shares * v.navPerShare
    const okShares = shares > 0 && shares <= h.shares
    if (okShares && $pr.value === '') $pr.value = fmtUi(toUi(nav * (1 - suggest), v), v)
    const priceUi = Number($pr.value)
    const price = toNative(priceUi, v)
    const okPrice = price > 0 && nav > 0
    $('#s-shares-hint').classList.toggle('error', $sh.value !== '' && !okShares)

    $sl.setAttribute('aria-label', 'Ask price versus NAV')
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

    box.querySelector('#s-ask-suggest').innerHTML = `${icon('target', { size: 12 })} Suggested −${(suggest * 100).toFixed(0)} %`
    const book = okShares ? bookMedianNative(v.vaultId, shares) : null
    if (book && nav > 0) {
      const bd = 1 - book / nav
      $book.hidden = false
      $book.innerHTML = `${icon('book', { size: 12 })} Book ${bd >= 0 ? '−' : '+'}${(Math.abs(bd) * 100).toFixed(1)} %`
    } else $book.hidden = true

    if (okShares && okPrice) {
      const d = 1 - price / nav
      const advice = askAdvice(v, d)
      $read.hidden = false
      $read.className = `t-reading ${advice.reading.cls}`
      $read.innerHTML = `
        <div class="t-read-top">
          ${readingPill(advice.reading)}
          <span class="t-read-pct">${advice.headline}</span>
        </div>
        <p>${advice.body}</p>
        <div class="t-read-nav">${fmtShares(shares)} shares · NAV ${fmtAsset(nav, v)} → ${fmtAsset(price, v)}</div>
      `
      $sl.setAttribute('aria-valuetext', advice.headline)
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

  $post.addEventListener('click', () => {
    const h = current()
    const v = h.vault
    const shares = Number($sh.value)
    const price = v.isXrp ? Math.round(Number($pr.value) * 1_000_000) : Number($pr.value)
    const now = rippleNow()
    state.offers.push({
      id: `o${String(state.offers.length + 1).padStart(3, '0')}`,
      vaultId: v.vaultId,
      seller: state.session.account,
      shares: String(shares),
      price: String(price),
      postedAt: now,
      expiry: now + 3600,
      status: 'open',
      txHash: null,
      demo: false,
      local: true,
    })
    state.ticket = { vault: v.key, shares: '', price: '' }
    render()
    toast('Offer posted to the book — highlighted, it\'s yours', true)
  })
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

function cancelOffer(o) {
  o.status = 'cancelled'
  render()
  toast(`Offer ${o.id} withdrawn from the book`)
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
    for (let i = 0; i < rows.length; i++) {
      rows[i].classList.add('is-active')
      await new Promise(r => setTimeout(r, 650 + Math.random() * 450))
      rows[i].classList.remove('is-active')
      rows[i].classList.add('is-done')
      rows[i].querySelector('.s-ico').textContent = '✓'
    }
    o.status = 'filled'
    o.filledAt = rippleNow()
    closeModal()
    render()
    toast(`Settlement simulated — ${o.id} settled. The real Batch is signed in the CLI.`)
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
    chip.setAttribute('aria-label', `Wallet ${shortAddr(state.session.account)}`)
    label.innerHTML = `${icon('wallet', { size: 14 })}<span class="addr">${shortAddr(state.session.account)}</span>`
  } else {
    chip.classList.remove('is-connected')
    chip.setAttribute('aria-label', 'Connect a wallet')
    label.innerHTML = `${icon('wallet', { size: 14 })} Connect`
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
