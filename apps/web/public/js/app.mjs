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
  return tr
}

const STATUS_FR = { filled: 'settled', cancelled: 'cancelled', expired: 'expired' }

function buyCell(o, v, mine, live) {
  if (!live) return o.txHash
    ? `<a class="seller" href="https://devnet.xrpl.org/transactions/${o.txHash}" target="_blank" rel="noopener" onclick="event.stopPropagation()">proof ↗</a>`
    : ''
  if (mine) return `<button class="btn btn-mine btn-sm" data-cancel>Withdraw</button>`
  return `<button class="btn btn-ghost btn-sm" data-buy>Buy back</button>`
}

/** liquidité ou détresse — la question centrale de l'analyste. */
function readingOf(v, discount) {
  if (v.rating.tone === 'bad' || (v.rating.tone === 'warn' && discount >= 0.12))
    return { cls: 'distress', label: 'distress discount' }
  if (discount >= 0.005)
    return { cls: 'liquidity', label: 'liquidity discount' }
  return { cls: '', label: 'at par' }
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
      <label>Ask price</label>
      <input id="s-price" type="number" min="0" step="any" placeholder="0.00" value="${t.price}">
      <div class="hint" id="s-price-hint"></div>
    </div>
    <div class="m-preview" id="s-preview" hidden></div>
    <div class="t-grow"></div>
    <button class="btn btn-primary" data-s-post disabled>Post offer</button>
  `

  const $v = box.querySelector('#s-vault')
  const $sh = box.querySelector('#s-shares')
  const $pr = box.querySelector('#s-price')
  const $post = box.querySelector('[data-s-post]')

  const current = () => holdings.find(h => h.vault.key === $v.value)

  function refresh() {
    t.vault = $v.value
    t.shares = $sh.value
    t.price = $pr.value
    const h = current()
    const v = h.vault
    $('#s-shares-hint').textContent = `available: ${fmtShares(h.shares)} shares`
    const shares = Number($sh.value)
    const priceUi = Number($pr.value)
    const price = v.isXrp ? Math.round(priceUi * 1_000_000) : priceUi
    const nav = shares * v.navPerShare
    const okShares = shares > 0 && shares <= h.shares
    const okPrice = price > 0
    $('#s-shares-hint').classList.toggle('error', $sh.value !== '' && !okShares)
    $('#s-price-hint').textContent = v.isXrp ? 'in XRP — converted to drops' : `in ${v.asset}`
    const prev = box.querySelector('#s-preview')
    if (okShares && okPrice) {
      const d = 1 - price / nav
      prev.hidden = false
      prev.innerHTML = `
        <span class="big">${fmtShares(shares)} shares for ${fmtAsset(price, v)}</span>
        <span>NAV value ${fmtAsset(nav, v)} · ${d >= 0 ? 'discount' : 'premium'} ${Math.abs(d * 100).toFixed(1)} %</span>
        <span>expires in 1 h — cancellable via sequence bump</span>
      `
    } else prev.hidden = true
    $post.disabled = !(okShares && okPrice)
  }

  ;[$v, $sh, $pr].forEach(i => i.addEventListener('input', refresh))
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
  if (preselect) state.ticket.vault = preselect
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
