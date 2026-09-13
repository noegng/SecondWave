/**
 * Le sas — le coffre encre, manipulable, façon ink-object.
 *
 * À l'arrivée : un caisson 3D noir et blanc, plus large que haut, qu'on
 * fait tourner à la souris dans tous les sens (inertie comprise) ; il
 * dérive lentement tout seul quand on le laisse.
 *
 * L'ordre d'accès reproduit celui du monde réel :
 *   1. « Se connecter » (haut à gauche) — ouvre l'extension du navigateur
 *      (Crossmark / GemWallet), qui demande le mot de passe ; à défaut,
 *      une identité du monde de test. Tant qu'aucun wallet n'est lié, le
 *      pavé refuse le code.
 *   2. une fois le wallet lié, on compose le code sur la porte (pavé ou
 *      clavier) puis OK / Entrée — pure cinématique.
 *
 * À la validation : le coffre se recentre quelle que soit sa position,
 * les contrôles XLS-70 (credential) et XLS-80 (domaine) défilent, la
 * porte pivote, et la caméra plonge à l'intérieur.
 *
 * Le logo en haut à gauche rappelle ce sas à tout moment (reopenLock).
 */
import { reduceMotion } from './icons.mjs'
import { loadSession, saveSession, connectExternal } from './wallet.mjs'
import { wcConnect } from './walletconnect.mjs'

const short = a => (a ? `${a.slice(0, 8)}…${a.slice(-6)}` : '—')

let reopen = null
/** Rappelle le coffre par-dessus le marché (clic sur le logo). */
export function reopenLock() { reopen?.() }

export function initLock(world, onEnter) {
  const lock = document.getElementById('lock')
  const box = document.getElementById('ink-box')
  const led = document.getElementById('led')
  const ledCode = document.getElementById('led-code')
  const status = document.getElementById('mod-status')
  const checks = document.getElementById('lock-checks')
  const keypad = document.getElementById('keypad')
  const idPanel = document.getElementById('id-panel')
  const connectBtn = document.getElementById('ink-connect')
  const hint = document.querySelector('.ink-hint')

  /* ---------- rotation libre, avec inertie et dérive ---------- */
  const RX0 = -14
  let rx = RX0, ry = 24
  let scale = 1
  let vx = 0, vy = 0
  let dragging = false
  let entering = false
  let last = null
  let raf = null

  const apply = () => { box.style.transform = `rotateX(${rx}deg) rotateY(${ry}deg) scale(${scale})` }

  function tick() {
    if (!entering && !dragging) {
      ry += vy + (reduceMotion() ? 0 : 0.05)
      rx += vx + (RX0 - rx) * 0.015
      vx *= 0.94; vy *= 0.94
      rx = Math.max(-45, Math.min(45, rx))
      apply()
    }
    raf = requestAnimationFrame(tick)
  }
  const startTick = () => { if (!raf) raf = requestAnimationFrame(tick) }
  const stopTick = () => { cancelAnimationFrame(raf); raf = null }

  lock.addEventListener('pointerdown', e => {
    if (entering) return
    if (e.target.closest('.ink-topleft, .key, .ink-hint')) return
    dragging = true
    lock.classList.add('dragging')
    last = { x: e.clientX, y: e.clientY }
    vx = vy = 0
    try { lock.setPointerCapture(e.pointerId) } catch {}
  })
  lock.addEventListener('pointermove', e => {
    if (!dragging || entering) return
    const dx = e.clientX - last.x
    const dy = e.clientY - last.y
    ry += dx * 0.3
    rx = Math.max(-45, Math.min(45, rx - dy * 0.3))
    vy = dx * 0.09
    vx = -dy * 0.09
    last = { x: e.clientX, y: e.clientY }
    apply()
  })
  const release = () => { dragging = false; lock.classList.remove('dragging') }
  lock.addEventListener('pointerup', release)
  lock.addEventListener('pointercancel', release)

  /* ---------- code sur la porte + état de connexion ---------- */
  let code = ''
  let sealed = false

  const isConnected = () => !!loadSession()

  const renderLed = () => {
    ledCode.textContent = Array.from({ length: 6 }, (_, i) => code[i] ?? '−').join('')
  }

  function refreshStatus() {
    const s = loadSession()
    if (s) {
      status.textContent = `● ${short(s.account)}`
      status.classList.add('on')
      connectBtn.textContent = 'Wallet linked — change'
      hint.innerHTML = 'Key in your code then <kbd>Enter</kbd> to go in'
    } else {
      status.textContent = '○ NOT CONNECTED'
      status.classList.remove('on')
      connectBtn.textContent = 'Connect'
      hint.innerHTML = 'Connect a wallet top-left, then key in your code'
    }
  }

  const domain = world?.domainId ? `${world.domainId.slice(0, 4)}…${world.domainId.slice(-4)}` : '——'

  const show = (i, html) => new Promise(r => {
    const div = document.createElement('div')
    div.className = 'chk'
    div.innerHTML = html
    checks.appendChild(div)
    requestAnimationFrame(() => div.classList.add('show'))
    setTimeout(r, 500 + i * 40)
  })

  // recentre le coffre face caméra ET l'agrandit pour qu'il remplisse l'écran
  function recenterAndFill() {
    ry = ((ry % 360) + 360) % 360
    if (ry > 180) ry -= 360
    const fill = Math.max(window.innerWidth / 680, window.innerHeight / 400) * 0.86
    box.style.transition = 'transform 1.1s cubic-bezier(.5,.05,.25,1)'
    rx = 0; ry = 0; scale = fill
    apply()
    return new Promise(r => setTimeout(r, 1150))
  }

  async function enter() {
    if (sealed) return
    sealed = true
    entering = true
    idPanel.hidden = true
    led.classList.add('ok')
    // Pas de transition : la porte s'ouvre et on est directement sur le marché.
    document.body.classList.add('inside')            // parois + jetons du coffre
    lock.classList.add('open')                       // la porte pivote
    onEnter?.()                                      // le marché est prêt en dessous
    stopTick()
    window.removeEventListener('keydown', onKey)
    setTimeout(() => lock.classList.add('done'), 350)   // fondu du sas pendant l'ouverture
    setTimeout(() => { lock.hidden = true }, 950)       // retiré une fois le fondu terminé
  }

  function validateCode() {
    if (sealed) return
    if (!isConnected()) {
      // pas de wallet lié : le coffre refuse le code
      status.textContent = '○ CONNECT A WALLET FIRST'
      status.classList.remove('on')
      led.classList.add('err')
      setTimeout(() => { led.classList.remove('err'); refreshStatus() }, 1200)
      return
    }
    if (code.length < 4) {
      led.classList.add('err')
      setTimeout(() => led.classList.remove('err'), 350)
      return
    }
    enter()
  }

  function press(k) {
    if (sealed) return
    if (k >= '0' && k <= '9') { if (code.length < 6) { code += k; renderLed() } }
    else if (k === 'C') { code = ''; renderLed() }
    else if (k === 'OK') validateCode()
  }

  function onKey(e) {
    if (sealed) return
    if (e.key >= '0' && e.key <= '9') press(e.key)
    else if (e.key === 'Backspace') { code = code.slice(0, -1); renderLed() }
    else if (e.key === 'Escape') { code = ''; renderLed(); idPanel.hidden = true }
    else if (e.key === 'Enter') validateCode()
  }

  keypad.addEventListener('click', e => {
    const key = e.target.closest('.key')
    if (key) press(key.dataset.k)
  })

  /* ---------- connexion, en haut à gauche ----------
     Par défaut on passe par le XRPL Dev Wallet (WalletConnect) : le clic
     ouvre directement l'appairage, l'extension demandera confirmation.
     Un lien discret permet de retomber sur une identité de test. */
  connectBtn.addEventListener('click', () => {
    if (sealed) return
    if (!idPanel.hidden) { idPanel.hidden = true; return }
    startWalletConnect()
    idPanel.hidden = false
  })

  function linkWallet(session) {
    saveSession(session)
    idPanel.hidden = true
    refreshStatus()
  }

  /** L'appairage WalletConnect : QR + URI copiable, attente d'approbation. */
  async function startWalletConnect() {
    idPanel.innerHTML = `
      <div class="wc-pair">
        <div class="wc-title">Pair XRPL Dev Wallet</div>
        <canvas class="wc-qr" width="200" height="200"></canvas>
        <div class="wc-status" id="wc-status">generating the URI…</div>
        <textarea class="wc-uri" id="wc-uri" readonly rows="3" hidden></textarea>
        <div class="wc-row">
          <button class="id-item wc-copy" id="wc-copy" hidden>Copy URI</button>
        </div>
        <div class="wc-hint">Open the extension → WalletConnect → paste the URI (or scan the QR), then confirm.</div>
        <button class="wc-alt" id="wc-alt">use a test identity instead</button>
      </div>`
    const qr = idPanel.querySelector('.wc-qr')
    const status = idPanel.querySelector('#wc-status')
    const uriBox = idPanel.querySelector('#wc-uri')
    const copy = idPanel.querySelector('#wc-copy')
    idPanel.querySelector('#wc-alt').addEventListener('click', () => buildIdPanel())

    try {
      const res = await wcConnect((uri, paint) => {
        paint(qr)
        uriBox.value = uri
        uriBox.hidden = false
        copy.hidden = false
        status.textContent = 'waiting for approval in the extension…'
        copy.addEventListener('click', () => {
          navigator.clipboard?.writeText(uri)
          copy.textContent = 'URI copied ✓'
        })
      })
      linkWallet(res)
    } catch (err) {
      if (status) status.textContent = `failed: ${err.message}`
    }
  }

  function buildIdPanel() {
    idPanel.innerHTML = ''

    // 1) XRPL Dev Wallet — via WalletConnect (URI d'appairage)
    const wc = document.createElement('button')
    wc.className = 'id-item'
    wc.innerHTML = `<span>⛓ XRPL Dev Wallet</span><span class="desc">WalletConnect — pair the extension</span>`
    wc.addEventListener('click', () => startWalletConnect())
    idPanel.appendChild(wc)

    // 2) provider injecté, si jamais une extension en expose un
    const ext = document.createElement('button')
    ext.className = 'id-item'
    ext.innerHTML = `<span>⌘ Injected extension</span><span class="desc">Crossmark / GemWallet, if present</span>`
    ext.addEventListener('click', async () => {
      ext.querySelector('.desc').textContent = 'opening the extension…'
      try {
        const { account, via } = await connectExternal()
        linkWallet({ account, via })
      } catch (err) {
        ext.querySelector('.desc').textContent = err.message
      }
    })
    idPanel.appendChild(ext)

    const sep = document.createElement('div')
    sep.className = 'id-sep'
    sep.textContent = 'or a test-world identity'
    idPanel.appendChild(sep)

    const holders = new Map()
    for (const v of world?.vaults ?? []) {
      if (v.key === 'verrouille') continue
      for (const h of v.holders ?? []) {
        if (!holders.has(h.account)) holders.set(h.account, [])
        holders.get(h.account).push(`${v.key} · ${(Number(h.shares) / 1e6).toFixed(0)} M`)
      }
    }
    for (const [account, parts] of holders) {
      const b = document.createElement('button')
      b.className = 'id-item'
      b.innerHTML = `<span>${short(account)}</span><span class="desc">${parts.join(' — ')}</span>`
      b.addEventListener('click', () => linkWallet({ account }))
      idPanel.appendChild(b)
    }
  }

  /* ---------- ouverture / réouverture du sas ---------- */
  function present() {
    sealed = false
    entering = false
    code = ''
    rx = RX0; ry = 24; scale = 1
    box.style.transition = ''
    idPanel.hidden = true
    checks.innerHTML = ''
    led.classList.remove('ok', 'err')
    lock.classList.remove('open', 'plunge', 'done', 'dragging')
    lock.hidden = false
    document.body.classList.remove('inside')
    renderLed()
    refreshStatus()
    apply()
    window.removeEventListener('keydown', onKey)
    window.addEventListener('keydown', onKey)
    startTick()
  }

  reopen = present

  // à l'arrivée, on présente toujours le coffre (plus de saut d'accueil)
  present()
}
