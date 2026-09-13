/**
 * Wallet — jointure volontairement fine.
 *
 * Le vrai signataire du projet est le CLI (les seeds vivent dans state.json,
 * jamais dans le navigateur). Ici, « se connecter » veut dire : lier une
 * adresse — extension, WalletConnect, ou identité du monde de test — puis
 * lire ses MPToken de parts on-chain (`account_objects`). Le snapshot ne
 * sert que de repli si le Devnet est injoignable.
 *
 * Le point d'accroche pour un vrai wallet (GemWallet, Crossmark, Xaman) est
 * `connectExternal()` : même contrat, une adresse en sortie.
 */

const KEY = 'secondwave.wallet'

export function loadSession() {
  try { return JSON.parse(localStorage.getItem(KEY)) ?? null } catch { return null }
}

export function saveSession(session) {
  if (session) localStorage.setItem(KEY, JSON.stringify(session))
  else localStorage.removeItem(KEY)
}

/** Les identités proposées : chaque détenteur de parts du monde de test. */
export function candidates(vaults) {
  const byAccount = new Map()
  for (const v of Object.values(vaults)) {
    if (!v.transferable) continue
    for (const h of v.holders) {
      if (!byAccount.has(h.account)) byAccount.set(h.account, { account: h.account, holdings: [] })
      byAccount.get(h.account).holdings.push({ vault: v.key, shares: Number(h.shares) })
    }
  }
  return [...byAccount.values()]
}

/** Parts détenues par le compte connecté, vault par vault — lecture snapshot. */
export function holdingsOf(vaults, account) {
  const out = []
  for (const v of Object.values(vaults)) {
    const h = (v.holders ?? []).find(x => x.account === account)
    if (h) out.push({ vault: v, shares: Number(h.shares), value: Number(h.shares) * v.navPerShare, live: false })
  }
  return out
}

const ADDR_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/
const DEVNET_WSS = 'wss://s.devnet.rippletest.net:51233'

/** Relie des objets MPToken on-chain aux vaults du monde. */
export function matchHoldings(vaults, mpts) {
  const byId = new Map((mpts ?? []).map(o => [o.MPTokenIssuanceID, o]))
  const out = []
  for (const v of Object.values(vaults)) {
    if (!v.shareMptId) continue
    const o = byId.get(v.shareMptId)
    const shares = Number(o?.MPTAmount ?? 0)
    if (!o || !(shares > 0)) continue
    out.push({ vault: v, shares, value: shares * v.navPerShare, live: true })
  }
  return out
}

function hydratePositions(vaults, positions) {
  const out = []
  for (const p of positions ?? []) {
    const vault = vaults[p.key] ?? Object.values(vaults).find(v => v.vaultId === p.vaultId)
    const shares = Number(p.shares)
    if (!vault || !(shares > 0)) continue
    out.push({ vault, shares, value: shares * vault.navPerShare, live: true })
  }
  return out
}

/** Un aller-retour WebSocket : `account_objects` type `mptoken`. */
function accountMpts(account, url = DEVNET_WSS) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const timer = setTimeout(() => {
      try { ws.close() } catch { /* déjà fermé */ }
      reject(new Error('Devnet timeout'))
    }, 12_000)
    const done = (fn, arg) => {
      clearTimeout(timer)
      try { ws.close() } catch { /* déjà fermé */ }
      fn(arg)
    }
    ws.onopen = () => {
      ws.send(JSON.stringify({
        id: 1,
        command: 'account_objects',
        account,
        type: 'mptoken',
        ledger_index: 'validated',
      }))
    }
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data)
      if (msg.id !== 1) return
      if (msg.status === 'error') {
        if (msg.error === 'actNotFound' || msg.error === 'actMalformed') return done(resolve, [])
        return done(reject, new Error(msg.error_message || msg.error || 'ledger error'))
      }
      done(resolve, msg.result?.account_objects ?? [])
    }
    ws.onerror = () => done(reject, new Error('Cannot reach Devnet'))
  })
}

/**
 * Parts réellement détenues par l'adresse, lues on-chain.
 * 1) `/api/holdings` (serveur local, même primitive que le CLI)
 * 2) WebSocket Devnet depuis le navigateur (build statique / Vercel)
 */
export async function fetchLiveHoldings(vaults, account) {
  if (!ADDR_RE.test(account ?? '')) throw new Error('Invalid address')

  const fromApi = await fetch(`/api/holdings?account=${encodeURIComponent(account)}`)
    .then(r => (r.ok ? r.json() : null))
    .catch(() => null)
  if (fromApi?.positions) return hydratePositions(vaults, fromApi.positions)

  return matchHoldings(vaults, await accountMpts(account))
}

/**
 * Connexion à un wallet d'extension navigateur.
 *
 * Essaie ce qui est réellement injecté dans la page :
 *   · Crossmark  → window.crossmark (signInAndWait)
 *   · GemWallet  → window.gemWallet (drapeau ; l'API passe par postMessage)
 * Retourne { account, via } ; jette une erreur lisible sinon.
 */
export async function connectExternal() {
  const xm = window.crossmark
  if (xm?.methods?.signInAndWait) {
    const res = await xm.methods.signInAndWait()
    const account = res?.response?.data?.address
    if (!account) throw new Error('Crossmark : connexion refusée')
    return { account, via: 'crossmark' }
  }
  // sondes défensives : si un jour une extension injecte un provider XRPL
  const inj = window.xrpl || window.xrplWallet || window.xrplDevWallet || window.xrpll
  if (inj?.request) {
    const account = await inj.request({ method: 'xrpl_getAddress' }).then(r => r?.address ?? r).catch(() => null)
    if (account) return { account, via: 'extension' }
  }
  if (window.gemWallet) {
    // GemWallet dialogue par postMessage : demande d'adresse minimale.
    const account = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('GemWallet : pas de réponse')), 8000)
      const onMsg = e => {
        const d = e.data
        if (d?.app === 'gem' && (d?.type === 'RECEIVE_GET_ADDRESS' || d?.type === 'RECEIVE_ADDRESS')) {
          clearTimeout(to)
          window.removeEventListener('message', onMsg)
          resolve(d?.payload?.result?.address ?? d?.payload?.publicAddress ?? null)
        }
      }
      window.addEventListener('message', onMsg)
      window.postMessage({ app: 'gem', type: 'REQUEST_GET_ADDRESS/V3', source: 'GEM_WALLET_MSG_REQUEST', payload: {} }, '*')
    })
    if (!account) throw new Error('GemWallet : connexion refusée')
    return { account, via: 'gemwallet' }
  }
  throw new Error('Wallet non injecté — XRPL Dev Wallet passe par WalletConnect (à câbler)')
}
