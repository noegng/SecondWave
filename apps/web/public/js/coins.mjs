/**
 * Les jetons XRP / Ripple — deux couches.
 *
 * `startCoinsBackground(#bg)`  : quelques jetons argentés qui tournent
 *   lentement, très discrets, sur la paroi du fond derrière le carnet.
 * `startCoinsForeground(#coins-fg)` : au PREMIER PLAN, en bas à droite,
 *   dans l'angle du coffre (là où il n'y a pas de données), deux piles de
 *   pièces avec, adossés, un jeton XRP et un jeton Ripple montrant leur logo.
 *
 * Rendu argent réaliste (bevel + spéculaire), logos vectoriels fidèles,
 * Canvas 2D, sans dépendance.
 */

const TAU = Math.PI * 2

/* ---------- logos vectoriels (Path2D, boîte -1..1) ---------- */

// XRP : le tracé OFFICIEL du XRP Ledger (deux chevrons courbes), viewBox 512×424.
const XRP_PATH = new Path2D(
  'M437,0h74L357,152.48c-55.77,55.19-146.19,55.19-202,0L.94,0H75L192,115.83a91.11,91.11,0,0,0,127.91,0Z' +
  'M74.05,424H0L155,270.58c55.77-55.19,146.19-55.19,202,0L512,424H438L320,307.23a91.11,91.11,0,0,0-127.91,0Z',
)

/** Logo XRP centré, mis à l'échelle pour un jeton de rayon `r`. */
function drawXrp(ctx, r, ink) {
  const scale = (r * 1.16) / 512      // largeur ≈ 1.16 r, hauteur ≈ 0.96 r
  ctx.save()
  ctx.scale(scale, scale)
  ctx.translate(-256, -212)           // centre du viewBox
  ctx.fillStyle = ink
  ctx.fill(XRP_PATH)
  ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(248,248,250,0.5)'
  ctx.stroke(XRP_PATH)
  ctx.restore()
}

// Ripple : le tracé OFFICIEL (SVG fourni), viewBox 1850×2000, centre ~(1000,1000).
const RIPPLE_PATH = new Path2D(
  'M1297.93 53.81c-131.41 77.2-209.22 216.61-209.22 363.62 0 77.2 31 155 69.81 224.41 31 62 46.2 170.21-62 224.41-77.21 46.2-178.22 15.4-224.42-62-46.21-62-100.41-124-170.22-170.21-131.41-77.2-286.43-77.2-417.85 0S75 851 75 998.05s77.21 286.41 209 363.82c131.41 77.2 286.43 77.2 417.85 0 69.81-38.8 124-100.4 162.42-170.21 31-54.2 116.21-124 224.42-62 77.21 46.2 100.41 147.21 62 224.41-38.8 69.8-62 147.21-62 224.41 0 147.21 77.21 286.41 209.22 363.62 131.41 77.2 286.43 77.2 417.85 0S1925 1725.49 1925 1578.48s-77.41-286.41-209.22-363.82c-69.81-38.8-147.22-54.2-232.23-54.2-69.81 0-162.42-46.2-162.42-162.41 0-93 69.81-162.41 162.42-162.41 77.21 0 162.42-15.4 232.23-54.2C1847.19 704.24 1925 564.83 1925 417.83s-77.41-286.41-209.22-363.62c-62-38.8-139.22-54.2-209-54.2-69.41-.4-147.22 15.4-208.82 53.8Z',
)

/** Logo Ripple centré, mis à l'échelle pour un jeton de rayon `r`. */
function drawRipple(ctx, r, ink) {
  const scale = (r * 1.5) / 2000      // hauteur ≈ 1.5 r, largeur ≈ 1.39 r
  ctx.save()
  ctx.scale(scale, scale)
  ctx.translate(-1000, -1000)         // centre du viewBox
  ctx.fillStyle = ink
  ctx.fill(RIPPLE_PATH)
  ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(248,248,250,0.45)'
  ctx.stroke(RIPPLE_PATH)
  ctx.restore()
}

/* ---------- le disque métallique, réaliste ---------- */

function metalDisc(ctx, r) {
  // corps : dégradé radial décalé (source de lumière haut-gauche)
  const g = ctx.createRadialGradient(-r * 0.34, -r * 0.4, r * 0.05, r * 0.15, r * 0.2, r * 1.15)
  g.addColorStop(0, '#ffffff')
  g.addColorStop(0.22, '#e9e9ee')
  g.addColorStop(0.5, '#c2c2c8')
  g.addColorStop(0.74, '#9a9aa1')
  g.addColorStop(0.9, '#78787f')
  g.addColorStop(1, '#54545b')
  ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fillStyle = g; ctx.fill()

  // bevel : anneau extérieur sombre puis clair (rebord biseauté)
  ctx.lineWidth = r * 0.06
  ctx.strokeStyle = 'rgba(40,40,45,0.55)'
  ctx.beginPath(); ctx.arc(0, 0, r * 0.97, 0, TAU); ctx.stroke()
  ctx.lineWidth = r * 0.03
  ctx.strokeStyle = 'rgba(255,255,255,0.45)'
  ctx.beginPath(); ctx.arc(0, 0, r * 0.9, 0, TAU); ctx.stroke()

  // cannelures fines du listel
  ctx.save()
  ctx.lineWidth = 1
  for (let i = 0; i < 90; i++) {
    const a = (i / 90) * TAU
    ctx.strokeStyle = i % 2 ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.10)'
    ctx.beginPath()
    ctx.moveTo(Math.cos(a) * r * 0.9, Math.sin(a) * r * 0.9)
    ctx.lineTo(Math.cos(a) * r * 0.97, Math.sin(a) * r * 0.97)
    ctx.stroke()
  }
  ctx.restore()

  // couronne intérieure gravée
  ctx.lineWidth = Math.max(1, r * 0.02)
  ctx.strokeStyle = 'rgba(80,80,86,0.5)'
  ctx.beginPath(); ctx.arc(0, 0, r * 0.7, 0, TAU); ctx.stroke()
}

function specular(ctx, r, alpha) {
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.globalCompositeOperation = 'screen'
  const s = ctx.createRadialGradient(-r * 0.4, -r * 0.45, 0, -r * 0.4, -r * 0.45, r * 0.9)
  s.addColorStop(0, 'rgba(255,255,255,0.55)')
  s.addColorStop(0.3, 'rgba(255,255,255,0.12)')
  s.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.beginPath(); ctx.arc(0, 0, r * 0.96, 0, TAU); ctx.fillStyle = s; ctx.fill()
  ctx.restore()
}

/** Jeton vu de face (optionnel : squash horizontal pour la rotation). */
function faceCoin(ctx, cx, cy, r, squash, alpha, kind) {
  const sq = Math.max(0.03, Math.abs(squash))
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.translate(cx, cy)
  ctx.scale(sq, 1)
  metalDisc(ctx, r)
  ctx.restore()
  // logo (non étiré) si le jeton est assez de face
  if (Math.abs(squash) > 0.34) {
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.translate(cx, cy)
    ctx.scale(sq, 1)
    ctx.save(); ctx.scale(1 / sq, 1)
    if (kind === 'xrp') drawXrp(ctx, r * 0.92, 'rgba(48,48,54,0.95)')
    else drawRipple(ctx, r * 0.92, 'rgba(48,48,54,0.95)')
    ctx.restore()
    ctx.restore()
  }
  ctx.save(); ctx.globalAlpha = alpha; ctx.translate(cx, cy); ctx.scale(sq, 1)
  specular(ctx, r, alpha); ctx.restore()
}

/* ============ COUCHE FOND : jetons qui tournent, discrets ============ */

export function startCoinsBackground(canvas) {
  const ctx = canvas.getContext('2d')
  let w = 0, h = 0, dpr = 1, coins = []

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2)
    w = window.innerWidth; h = window.innerHeight
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const R = Math.max(40, Math.min(w, h) * 0.07)
    coins = [
      { x: 0.30, y: 0.30, r: R * 1.5, sp: 0.20, ph: 0.0, kind: 'xrp' },
      { x: 0.71, y: 0.24, r: R * 1.1, sp: -0.15, ph: 1.6, kind: 'ripple' },
      { x: 0.54, y: 0.62, r: R * 1.9, sp: 0.12, ph: 3.0, kind: 'xrp' },
      { x: 0.19, y: 0.66, r: R * 0.95, sp: 0.25, ph: 2.1, kind: 'ripple' },
    ]
  }

  function draw(now) {
    const t = now / 1000
    ctx.clearRect(0, 0, w, h)
    const bg = ctx.createLinearGradient(0, 0, 0, h)
    bg.addColorStop(0, '#0c0c0e'); bg.addColorStop(1, '#08080a')
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h)
    for (const c of coins) {
      const squash = Math.cos(t * c.sp + c.ph)
      faceCoin(ctx, c.x * w, c.y * h, c.r, squash, 0.09, c.kind)
    }
    requestAnimationFrame(draw)
  }
  window.addEventListener('resize', resize)
  resize(); requestAnimationFrame(draw)
}

/* ============ COUCHE PREMIER PLAN : les piles, dans l'angle ============ */

export function startCoinsForeground(canvas) {
  const ctx = canvas.getContext('2d')
  let w = 0, h = 0, dpr = 1

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2)
    w = window.innerWidth; h = window.innerHeight
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  /** Pile vue de côté : tranches empilées avec une ellipse sur le dessus. */
  function stack(cx, baseY, r, n) {
    const th = r * 0.3
    for (let i = 0; i < n; i++) {
      const y = baseY - i * th
      const grad = ctx.createLinearGradient(cx - r, 0, cx + r, 0)
      grad.addColorStop(0, '#45454b')
      grad.addColorStop(0.2, '#f0f0f3')
      grad.addColorStop(0.5, '#a4a4ab')
      grad.addColorStop(0.8, '#f4f4f7')
      grad.addColorStop(1, '#45454b')
      ctx.fillStyle = grad
      ctx.fillRect(cx - r, y - th, r * 2, th)
      ctx.fillStyle = 'rgba(0,0,0,0.16)'
      ctx.fillRect(cx - r, y - th * 0.26, r * 2, th * 0.26)
      ctx.beginPath(); ctx.ellipse(cx, y - th, r, r * 0.24, 0, 0, TAU)
      ctx.fillStyle = '#e0e0e4'; ctx.fill()
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(70,70,76,0.45)'; ctx.stroke()
    }
  }

  /** Jeton adossé (léger 3D : une tranche visible sous le disque de face). */
  function leaner(cx, cy, r, tilt, kind) {
    ctx.save()
    ctx.translate(cx, cy); ctx.rotate(tilt)
    // ombre au sol
    ctx.save(); ctx.globalAlpha = 0.28
    ctx.beginPath(); ctx.ellipse(0, r * 1.02, r * 0.95, r * 0.22, 0, 0, TAU)
    ctx.fillStyle = '#000'; ctx.fill(); ctx.restore()
    // tranche (épaisseur)
    ctx.save(); ctx.translate(0, r * 0.09)
    const edge = ctx.createLinearGradient(-r, 0, r, 0)
    edge.addColorStop(0, '#4a4a50'); edge.addColorStop(0.5, '#c8c8ce'); edge.addColorStop(1, '#4a4a50')
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fillStyle = edge; ctx.fill(); ctx.restore()
    // face
    metalDisc(ctx, r)
    if (kind === 'xrp') drawXrp(ctx, r * 0.92, 'rgba(45,45,51,0.96)')
    else drawRipple(ctx, r * 0.92, 'rgba(45,45,51,0.96)')
    specular(ctx, r, 1)
    ctx.restore()
  }

  function draw() {
    ctx.clearRect(0, 0, w, h)
    // taille modérée, ancrées dans l'angle bas-droit (hors des lignes de données)
    const R = Math.max(26, Math.min(w, h) * 0.04)
    const base = h + R * 0.15
    const gx = w - R * 3.7

    stack(gx, base, R, 8)
    stack(gx + R * 1.95, base, R, 6)
    leaner(gx - R * 1.2, base - R * 1.8, R * 1.05, -0.30, 'xrp')
    leaner(gx + R * 3.15, base - R * 1.3, R * 0.98, 0.28, 'ripple')

    requestAnimationFrame(draw)
  }
  window.addEventListener('resize', resize)
  resize(); requestAnimationFrame(draw)
}
