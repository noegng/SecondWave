/**
 * Pictogrammes SecondWave — un seul trait, même poids que le logo.
 * `label` renseigne aria ; sinon l'icône est décorative.
 */
const PATHS = {
  liquidity: '<path d="M12 3s6 7.2 6 11.2A6 6 0 1 1 6 14.2C6 10.2 12 3 12 3z"/>',
  distress: '<path d="M12 4 21 19H3L12 4z"/><path d="M12 10v5M12 17.5v.5"/>',
  par: '<path d="M5 10h14M5 14h14"/>',
  premium: '<path d="M12 19V6M6 11l6-6 6 6"/>',
  vault: '<rect x="4" y="7" width="16" height="13" rx="2"/><circle cx="12" cy="13.5" r="2.4"/>',
  wallet: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M16 12h4v4h-4a2 2 0 0 1 0-4z"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.2-5.5"/><path d="M20 4v5h-5"/>',
  sell: '<path d="M7 17 17 7M9 7h8v8"/>',
  buy: '<path d="M7 7l10 10M17 9v8H9"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="1.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  claw: '<path d="M5 19c4-1 6-6 6-10M11 9c1-3 4-5 8-5M16 4l3-1-1 3"/>',
  chain: '<rect x="3" y="8" width="8" height="8" rx="1.5"/><rect x="13" y="8" width="8" height="8" rx="1.5"/><path d="M11 12h2"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>',
  equal: '<path d="M5 9h14M5 15h14"/>',
  book: '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 0-3 3V4z"/><path d="M8 4v16"/>',
  shield: '<path d="M12 3 5 6v6c0 5 3.2 7.6 7 9 3.8-1.4 7-4 7-9V6l-7-3z"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  file: '<path d="M7 3h8l5 5v13H7z"/><path d="M15 3v5h5"/>',
  exit: '<path d="M10 4H5v16h5M13 12h8M17 8l4 4-4 4"/>',
  check: '<path d="M5 13l4 4 10-10"/>',
  crossed: '<circle cx="12" cy="12" r="9"/><path d="M8 8l8 8M16 8l-8 8"/>',
}

const SCENARIO = {
  sain: 'shield', predateur: 'crossed', deprecie: 'down',
  iou: 'file', verrouille: 'lock', redemption: 'exit', solde: 'check',
}

export function icon(name, { label = '', size = 16 } = {}) {
  const body = PATHS[name] ?? PATHS.vault
  const aria = label
    ? `role="img" aria-label="${label}"`
    : 'aria-hidden="true"'
  return `<svg class="ico ico-${name}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ${aria}>${body}</svg>`
}

export function scenarioIcon(key, opts = {}) {
  return icon(SCENARIO[key] ?? 'vault', opts)
}

export const reduceMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
