import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { recurringStartDate, verifyCloudPaymentsSignature } from './cloudpayments.mjs'

const hmac = (body, secret = 'test-secret') => crypto.createHmac('sha256', secret).update(body).digest('base64')

describe('CloudPayments webhook signatures', () => {
  it('verifies Content-HMAC against the exact raw payload', () => {
    const raw = Buffer.from('Amount=1.00&Description=BallPlay')
    expect(verifyCloudPaymentsSignature(raw, { 'content-hmac': hmac(raw) }, 'test-secret')).toBe(true)
  })

  it('verifies X-Content-HMAC against URL-decoded form payload', () => {
    const raw = Buffer.from('Description=BallPlay%20premium&Amount=1.00')
    const decoded = Buffer.from('Description=BallPlay premium&Amount=1.00')
    expect(verifyCloudPaymentsSignature(raw, {
      'content-type': 'application/x-www-form-urlencoded',
      'x-content-hmac': hmac(decoded),
    }, 'test-secret')).toBe(true)
  })

  it('rejects tampered payloads and missing secrets', () => {
    const raw = Buffer.from('{"Amount":1}')
    expect(verifyCloudPaymentsSignature(raw, { 'content-hmac': hmac(raw) }, '')).toBe(false)
    expect(verifyCloudPaymentsSignature(raw, { 'content-hmac': hmac('{"Amount":2}') }, 'test-secret')).toBe(false)
  })
})

describe('recurring start date', () => {
  it('schedules the first recurring charge 24 hours after the payment intent is created', () => {
    expect(recurringStartDate(new Date('2026-10-20T10:00:00.000Z'))).toBe('2026-10-21T10:00:00.000Z')
  })
})
