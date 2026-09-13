/**
 * Fond animé — le mécanisme d'un coffre-fort, en niveaux de gris.
 *
 * Un grand cadran gradué tourne lentement derrière l'interface ; son anneau
 * intérieur avance par crans, comme un barillet qu'on compose. Une poignée
 * trois branches, des goujons de verrouillage, une poussière métallique en
 * dérive lente et un balayage lumineux discret complètent la scène.
 *
 * Tout est dessiné en Canvas 2D, sans dépendance, et reste volontairement
 * sous ~12 % d'opacité pour que le carnet demeure parfaitement lisible.
 */

const TAU = Math.PI * 2

export function startVaultBackground(canvas) {
  const ctx = canvas.getContext('2d')
  let w = 0, h = 0, dpr = 1
  let grain = null

  const mouse = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5 }

  // Le barillet : avance d'un cran (30°) toutes les ~4 s, avec un léger rebond.
  const tumbler = {
    angle: 0, from: 0, to: 0,
    start: 0, dur: 900, next: 2500,
    dir: 1, clicks: 0,
  }

  const dust = Array.from({ length: 70 }, (_, i) => ({
    x: Math.random(), y: Math.random(),
    r: 0.6 + Math.random() * 1.6,
    vx: (Math.random() - 0.5) * 0.012,
    vy: -0.004 - Math.random() * 0.010,
    a: 0.04 + Math.random() * 0.10,
    ph: Math.random() * TAU,
  }))

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2)
    w = canvas.clientWidth
    h = canvas.clientHeight
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    grain = makeGrain()
  }

  function makeGrain() {
    const g = document.createElement('canvas')
    const size = 160
    g.width = size; g.height = size
    const gctx = g.getContext('2d')
    const img = gctx.createImageData(size, size)
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 112 + Math.random() * 24
      img.data[i] = v; img.data[i + 1] = v + 4; img.data[i + 2] = v + 14
      img.data[i + 3] = Math.random() * 14
    }
    gctx.putImageData(img, 0, 0)
    return g
  }

  const easeOutBack = t => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2)

  function stepTumbler(now) {
    if (now >= tumbler.next) {
      tumbler.from = tumbler.to
      // parfois le cadran repart en sens inverse, comme une vraie combinaison
      if (tumbler.clicks > 0 && Math.random() < 0.3) tumbler.dir *= -1
      tumbler.to = tumbler.from + tumbler.dir * (TAU / 12)
      tumbler.start = now
      tumbler.next = now + tumbler.dur + 2600 + Math.random() * 2400
      tumbler.clicks++
    }
    const t = Math.min(1, (now - tumbler.start) / tumbler.dur)
    tumbler.angle = tumbler.from + (tumbler.to - tumbler.from) * easeOutBack(t)
    return t
  }

  /** Anneau de graduations façon cadran de combinaison. */
  function dialRing(r, ticks, base, { major = 10, len = 10, majorLen = 18, width = 1 } = {}) {
    ctx.save()
    ctx.rotate(base)
    for (let i = 0; i < ticks; i++) {
      const isMajor = i % major === 0
      const L = isMajor ? majorLen : len
      ctx.beginPath()
      ctx.moveTo(r, 0)
      ctx.lineTo(r - L, 0)
      ctx.lineWidth = isMajor ? width * 1.6 : width
      ctx.strokeStyle = isMajor ? 'rgba(214,222,238,0.55)' : 'rgba(180,192,214,0.32)'
      ctx.stroke()
      ctx.rotate(TAU / ticks)
    }
    ctx.restore()
  }

  function ring(r, color, width = 1) {
    ctx.beginPath()
    ctx.arc(0, 0, r, 0, TAU)
    ctx.strokeStyle = color
    ctx.lineWidth = width
    ctx.stroke()
  }

  /** Les goujons — les pênes cylindriques qui verrouillent la porte. */
  function bolts(r, n, base, radius) {
    ctx.save()
    ctx.rotate(base)
    for (let i = 0; i < n; i++) {
      ctx.beginPath()
      ctx.arc(r, 0, radius, 0, TAU)
      const g = ctx.createRadialGradient(-radius * 0.3, -radius * 0.3, 0, 0, 0, radius)
      g.addColorStop(0, 'rgba(222,230,244,0.5)')
      g.addColorStop(1, 'rgba(114,124,146,0.15)')
      ctx.save()
      ctx.translate(r, 0)
      ctx.fillStyle = g
      ctx.fill()
      ctx.restore()
      ctx.rotate(TAU / n)
    }
    ctx.restore()
  }

  /** La poignée trois branches au centre. */
  function handle(r, angle) {
    ctx.save()
    ctx.rotate(angle)
    for (let i = 0; i < 3; i++) {
      ctx.beginPath()
      ctx.roundRect(-r, -4.5, 2 * r, 9, 5)
      ctx.fillStyle = 'rgba(190,200,220,0.30)'
      ctx.fill()
      // renflement à chaque extrémité de branche
      for (const s of [-1, 1]) {
        ctx.beginPath()
        ctx.arc(s * r, 0, 9, 0, TAU)
        ctx.fillStyle = 'rgba(206,216,234,0.38)'
        ctx.fill()
      }
      ctx.rotate(TAU / 6)
    }
    ctx.beginPath()
    ctx.arc(0, 0, 16, 0, TAU)
    const g = ctx.createRadialGradient(-5, -5, 0, 0, 0, 16)
    g.addColorStop(0, 'rgba(228,235,248,0.55)')
    g.addColorStop(1, 'rgba(86,96,118,0.25)')
    ctx.fillStyle = g
    ctx.fill()
    ctx.restore()
  }

  function drawDial(cx, cy, R, t, clickPulse) {
    ctx.save()
    ctx.translate(cx, cy)

    // halo métallique doux derrière le mécanisme
    const halo = ctx.createRadialGradient(0, 0, R * 0.1, 0, 0, R * 1.25)
    halo.addColorStop(0, 'rgba(255,255,255,0.045)')
    halo.addColorStop(0.6, 'rgba(255,255,255,0.018)')
    halo.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = halo
    ctx.beginPath()
    ctx.arc(0, 0, R * 1.25, 0, TAU)
    ctx.fill()

    ctx.globalAlpha = 0.16 + clickPulse * 0.05

    // couronne extérieure — rotation continue, très lente
    ring(R, 'rgba(190,200,220,0.35)', 1.2)
    ring(R * 0.985, 'rgba(132,144,168,0.20)', 0.7)
    dialRing(R * 0.96, 120, t * 0.018, { major: 10, len: 9, majorLen: 17, width: 1 })
    ring(R * 0.86, 'rgba(160,172,196,0.28)', 1)

    // anneau du barillet — avance par crans
    dialRing(R * 0.83, 60, tumbler.angle, { major: 5, len: 8, majorLen: 15, width: 1.1 })
    ring(R * 0.72, 'rgba(142,154,178,0.25)', 0.8)

    // goujons de verrouillage, contre-rotation lente
    bolts(R * 0.62, 8, -t * 0.028, 7)
    ring(R * 0.52, 'rgba(152,164,188,0.25)', 1)

    // graduations fines internes
    dialRing(R * 0.50, 90, -t * 0.045, { major: 15, len: 5, majorLen: 11, width: 0.8 })

    // poignée
    handle(R * 0.34, t * 0.06 + tumbler.angle * 0.2)

    ctx.restore()
  }

  function draw(now) {
    const t = now / 1000
    const clickT = stepTumbler(now)
    const clickPulse = clickT < 1 ? Math.max(0, 1 - clickT * 1.8) : 0

    // parallaxe souris, amortie
    mouse.x += (mouse.tx - mouse.x) * 0.04
    mouse.y += (mouse.ty - mouse.y) * 0.04

    ctx.clearRect(0, 0, w, h)

    // fond : anthracite profond avec un dégradé vertical à peine perceptible
    const bg = ctx.createLinearGradient(0, 0, 0, h)
    bg.addColorStop(0, '#0b1120')
    bg.addColorStop(0.55, '#080d18')
    bg.addColorStop(1, '#060a12')
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, w, h)

    const px = (mouse.x - 0.5) * 26
    const py = (mouse.y - 0.5) * 18

    // le grand mécanisme, ancré au tiers droit
    const R = Math.max(w, h) * 0.52
    drawDial(w * 0.78 + px, h * 0.42 + py, R, t, clickPulse)

    // un second cadran, petit, en bas à gauche — profondeur
    ctx.save()
    ctx.globalAlpha = 0.5
    drawDial(w * 0.06 + px * 1.6, h * 0.94 + py * 1.6, Math.max(w, h) * 0.18, -t * 1.4, 0)
    ctx.restore()

    // balayage lumineux : un rayon doux qui parcourt l'écran
    const sweepA = (t * 0.05) % TAU
    ctx.save()
    ctx.translate(w * 0.78 + px, h * 0.42 + py)
    ctx.rotate(sweepA)
    const sweep = ctx.createLinearGradient(0, 0, R * 1.3, 0)
    sweep.addColorStop(0, 'rgba(255,255,255,0.028)')
    sweep.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = sweep
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.arc(0, 0, R * 1.3, -0.16, 0.16)
    ctx.closePath()
    ctx.fill()
    ctx.restore()

    // poussière métallique
    for (const p of dust) {
      p.x += p.vx / 100
      p.y += p.vy / 100
      if (p.y < -0.02) { p.y = 1.02; p.x = Math.random() }
      if (p.x < -0.02) p.x = 1.02
      if (p.x > 1.02) p.x = -0.02
      const tw = 0.6 + 0.4 * Math.sin(t * 0.8 + p.ph)
      ctx.beginPath()
      ctx.arc(p.x * w, p.y * h, p.r, 0, TAU)
      ctx.fillStyle = `rgba(200,210,230,${(p.a * tw).toFixed(3)})`
      ctx.fill()
    }

    // grain métallique
    if (grain) {
      ctx.save()
      ctx.globalAlpha = 0.5
      ctx.fillStyle = ctx.createPattern(grain, 'repeat')
      ctx.fillRect(0, 0, w, h)
      ctx.restore()
    }

    // vignettage
    const vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75)
    vg.addColorStop(0, 'rgba(0,0,0,0)')
    vg.addColorStop(1, 'rgba(0,0,0,0.42)')
    ctx.fillStyle = vg
    ctx.fillRect(0, 0, w, h)

    requestAnimationFrame(draw)
  }

  window.addEventListener('resize', resize)
  window.addEventListener('pointermove', e => {
    mouse.tx = e.clientX / Math.max(1, w)
    mouse.ty = e.clientY / Math.max(1, h)
  })

  resize()
  requestAnimationFrame(draw)
}
