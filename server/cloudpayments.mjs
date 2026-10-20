import crypto from 'node:crypto'

const safeEqual = (left, right) => {
  const a = Buffer.from(String(left).trim())
  const b = Buffer.from(String(right).trim())
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

const signatureFor = (body, secret) => crypto.createHmac('sha256', secret).update(body).digest('base64')

const decodeUrlEncodedBody = (raw) => {
  try {
    return Buffer.from(decodeURIComponent(raw.toString('utf8').replace(/\+/g, ' ')), 'utf8')
  } catch {
    return null
  }
}

export const verifyCloudPaymentsSignature = (raw, headers, secret) => {
  if (!secret) return false
  const contentHmac = headers['content-hmac']
  const decodedHmac = headers['x-content-hmac']
  const contentType = String(headers['content-type'] || '')

  if (typeof contentHmac === 'string' && safeEqual(contentHmac, signatureFor(raw, secret))) return true
  if (typeof decodedHmac !== 'string') return false

  const decodedBody = contentType.includes('application/x-www-form-urlencoded') ? decodeUrlEncodedBody(raw) : raw
  return Boolean(decodedBody && safeEqual(decodedHmac, signatureFor(decodedBody, secret)))
}

export const recurringStartDate = (now = new Date()) => new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()
