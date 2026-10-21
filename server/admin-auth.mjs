import crypto from 'node:crypto'

const safeEqual = (left, right) => {
  if (typeof right !== 'string') return false
  const a = Buffer.from(String(left))
  const b = Buffer.from(right)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

const passwordMatchesHash = async (password, encoded) => {
  if (typeof encoded !== 'string') return false
  const [salt, expected, ...extra] = encoded.split(':')
  if (extra.length || !/^[a-f\d]{32}$/i.test(salt || '') || !/^[a-f\d]{128}$/i.test(expected || '')) return false
  const actual = await new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (error, key) => error ? reject(error) : resolve(key)))
  return crypto.timingSafeEqual(actual, Buffer.from(expected, 'hex'))
}

const configuredAdminUsers = (raw) => {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((user) => user && typeof user.username === 'string' && typeof user.passwordHash === 'string') : []
  } catch {
    return []
  }
}

export const adminCredentialsMatch = async (username, password, env = process.env) => {
  const legacyMatch = safeEqual(username, env.ADMIN_USERNAME) && safeEqual(password, env.ADMIN_PASSWORD)
  if (legacyMatch) return true

  const matches = configuredAdminUsers(env.ADMIN_USERS).filter((user) => safeEqual(username, user.username))
  for (const user of matches) {
    if (await passwordMatchesHash(password, user.passwordHash)) return true
  }
  return false
}
