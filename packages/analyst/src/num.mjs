const EPSILON = 1e-12

export function num(value, fallback = 0) {
  if (value == null || value === '') return fallback
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

export function safeDiv(numeral, denominator) {
  const d = num(denominator)
  if (Math.abs(d) < EPSILON) return 0
  return num(numeral) / d
}

export function clamp01(value) {
  return Math.min(1, Math.max(0, num(value)))
}

export function clamp100(value) {
  return Math.min(100, Math.max(0, num(value)))
}

export { EPSILON }
