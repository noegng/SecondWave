/**
 * Wallet — jointure volontairement fine.
 *
 * Le vrai signataire du projet est le CLI (les seeds vivent dans state.json,
 * jamais dans le navigateur). Ici, « se connecter » veut dire : choisir une
 * identité du monde de test — un détenteur de parts, membre du domaine — et
 * l'interface se met à voir le carnet comme lui : ses parts, ses offres.
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

/** Parts détenues par le compte connecté, vault par vault. */
export function holdingsOf(vaults, account) {
  const out = []
  for (const v of Object.values(vaults)) {
    const h = v.holders.find(x => x.account === account)
    if (h) out.push({ vault: v, shares: Number(h.shares), value: Number(h.shares) * v.navPerShare })
  }
  return out
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
