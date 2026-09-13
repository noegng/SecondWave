/**
 * WalletConnect v2 — la connexion réelle au XRPL Dev Wallet.
 *
 * L'extension ne s'injecte pas dans la page (aucun content script) : elle
 * dialogue uniquement par WalletConnect. Côté dApp, on génère donc un URI
 * d'appairage — affiché en QR + texte copiable — que l'on colle dans le
 * popup de l'extension. Elle demande le mot de passe, approuve la session,
 * et `approval()` nous rend l'adresse.
 *
 * Paramètres tirés du dépôt de l'extension (branche upgrade-lending-1.1) :
 *   · projectId de repli : 545f3b40384efe9b93401c1dd8d0ceb0
 *   · chaînes : xrpl:0 mainnet · xrpl:1 testnet · xrpl:2 devnet
 *   · méthodes : xrpl_signTransaction, xrpl_signTransactionFor
 *
 * Les libs sont importées à la demande depuis esm.sh (aucun build ici).
 */

const PROJECT_ID = '545f3b40384efe9b93401c1dd8d0ceb0'
const CHAIN = 'xrpl:2'   // SecondWave tourne sur le Devnet
const METHODS = ['xrpl_signTransaction', 'xrpl_signTransactionFor']

let client
let lastTopic = null

async function getClient() {
  if (client) return client
  const { SignClient } = await import('https://esm.sh/@walletconnect/sign-client@2.17.0')
  client = await SignClient.init({
    projectId: PROJECT_ID,
    metadata: {
      name: 'SecondWave',
      description: 'Marché secondaire de positions de vault verrouillées — XRPL Devnet',
      url: location.origin,
      icons: [],
    },
  })
  return client
}

/** Rend le QR dans le canvas fourni (best-effort). */
async function drawQr(canvas, uri) {
  try {
    const QR = (await import('https://esm.sh/qrcode@1.5.4')).default
    await QR.toCanvas(canvas, uri, { width: 200, margin: 1,
      color: { dark: '#000000', light: '#ffffff' } })
  } catch { /* le texte copiable suffit si le QR échoue */ }
}

/**
 * Ouvre une session WalletConnect.
 * @param onUri   reçoit (uri, canvas→dessine le QR) dès qu'il est prêt
 * @returns { account, via, topic }
 */
export async function wcConnect(onUri) {
  const c = await getClient()
  const { uri, approval } = await c.connect({
    requiredNamespaces: {
      xrpl: { chains: [CHAIN], methods: METHODS, events: [] },
    },
  })
  if (uri) onUri?.(uri, canvas => drawQr(canvas, uri))

  const session = await approval()          // se résout quand l'extension approuve
  lastTopic = session.topic
  const acct = session.namespaces?.xrpl?.accounts?.[0] ?? ''
  const account = acct.split(':')[2] || null
  if (!account) throw new Error('WalletConnect : aucune adresse dans la session')
  return { account, via: 'walletconnect', topic: session.topic }
}

export async function wcDisconnect() {
  if (!client || !lastTopic) return
  try {
    const { getSdkError } = await import('https://esm.sh/@walletconnect/utils@2.17.0')
    await client.disconnect({ topic: lastTopic, reason: getSdkError('USER_DISCONNECTED') })
  } catch { /* session déjà close */ }
  lastTopic = null
}
