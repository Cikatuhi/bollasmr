import { describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import { adminCredentialsMatch } from './admin-auth.mjs'

const hashPassword = (password, salt) => new Promise((resolve, reject) => {
  crypto.scrypt(password, salt, 64, (error, key) => error ? reject(error) : resolve(`${salt}:${key.toString('hex')}`))
})

describe('adminCredentialsMatch', () => {
  it('preserves the existing environment-based admin login', async () => {
    const env = { ADMIN_USERNAME: 'old-admin', ADMIN_PASSWORD: 'old-password' }
    await expect(adminCredentialsMatch('old-admin', 'old-password', env)).resolves.toBe(true)
    await expect(adminCredentialsMatch('old-admin', 'wrong-password', env)).resolves.toBe(false)
  })

  it('accepts an additional admin configured with a scrypt password hash', async () => {
    const passwordHash = await hashPassword('new-password', '0123456789abcdef0123456789abcdef')
    const env = { ADMIN_USERNAME: 'old-admin', ADMIN_PASSWORD: 'old-password', ADMIN_USERS: JSON.stringify([{ username: 'new-admin', passwordHash }]) }
    await expect(adminCredentialsMatch('new-admin', 'new-password', env)).resolves.toBe(true)
    await expect(adminCredentialsMatch('new-admin', 'wrong-password', env)).resolves.toBe(false)
    await expect(adminCredentialsMatch('other-admin', 'new-password', env)).resolves.toBe(false)
  })

  it('ignores malformed additional-admin configuration without breaking the legacy login', async () => {
    const env = { ADMIN_USERNAME: 'old-admin', ADMIN_PASSWORD: 'old-password', ADMIN_USERS: '{broken' }
    await expect(adminCredentialsMatch('old-admin', 'old-password', env)).resolves.toBe(true)
    await expect(adminCredentialsMatch('new-admin', 'new-password', env)).resolves.toBe(false)
  })
})
