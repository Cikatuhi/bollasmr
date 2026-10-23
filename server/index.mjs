import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { createTokenCharge, verifyCloudPaymentsSignature } from './cloudpayments.mjs'
import { adminCredentialsMatch } from './admin-auth.mjs'

const { Pool } = pg
const root = path.dirname(fileURLToPath(import.meta.url))
const databaseUrl = process.env.DATABASE_URL || `postgresql://${encodeURIComponent(process.env.DB_USER || '')}:${encodeURIComponent(process.env.DB_PASSWORD || '')}@${process.env.DB_HOST || '127.0.0.1'}:${process.env.DB_PORT || '5432'}/${process.env.DB_NAME || 'default_db'}`
const pool = new Pool({ connectionString: databaseUrl, ssl: process.env.DATABASE_SSL === 'require' ? { rejectUnauthorized: false } : undefined })
const port = Number(process.env.API_PORT || 3001)
const cookieName = 'ballplay_session'
const adminCookieName = 'ballplay_admin_session'
const adminSessions = new Map()
const adminLoginAttempts = new Map()
let settingsTableReady
let paymentColumnsReady
let homepageViewsTableReady
let referralTablesReady
const ensurePaymentColumns = () => {
  if (!paymentColumnsReady) {
    paymentColumnsReady = (async () => {
      await Promise.all([
        pool.query('ALTER TABLE payments ADD COLUMN IF NOT EXISTS plan_code TEXT'),
        pool.query("ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_kind TEXT NOT NULL DEFAULT 'initial'"),
        pool.query('ALTER TABLE payments ADD COLUMN IF NOT EXISTS account_id TEXT'),
        pool.query('ALTER TABLE payments ADD COLUMN IF NOT EXISTS card_token TEXT'),
        pool.query('ALTER TABLE payments ADD COLUMN IF NOT EXISTS consent_data JSONB'),
        pool.query('ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS plan_code TEXT'),
        pool.query('ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS card_token TEXT'),
        pool.query('ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS next_charge_at TIMESTAMPTZ'),
        pool.query('ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS charge_attempt_at TIMESTAMPTZ'),
      ])
      await pool.query('ALTER TABLE payments ALTER COLUMN user_id DROP NOT NULL')
      await pool.query('CREATE INDEX IF NOT EXISTS subscriptions_due_idx ON subscriptions (next_charge_at) WHERE card_token IS NOT NULL')
    })().catch((error) => {
      paymentColumnsReady = undefined
      throw error
    })
  }
  return paymentColumnsReady
}
const ensureSettingsTable = () => settingsTableReady ||= pool.query(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`)
const ensureHomepageViewsTable = () => {
  if (!homepageViewsTableReady) {
    homepageViewsTableReady = pool.query(`CREATE TABLE IF NOT EXISTS homepage_daily_views (view_date DATE PRIMARY KEY, views BIGINT NOT NULL DEFAULT 0)`).catch((error) => {
      homepageViewsTableReady = undefined
      throw error
    })
  }
  return homepageViewsTableReady
}
const ensureReferralTables = () => {
  if (!referralTablesReady) {
    referralTablesReady = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS referral_partners (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL, referral_code TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`)
      await pool.query(`CREATE TABLE IF NOT EXISTS referral_visitors (
        visitor_hash TEXT PRIMARY KEY, partner_id UUID NOT NULL REFERENCES referral_partners(id),
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL
      )`)
      await pool.query(`CREATE TABLE IF NOT EXISTS referral_visit_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), visitor_hash TEXT NOT NULL,
        partner_id UUID NOT NULL REFERENCES referral_partners(id), clicked_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`)
      await pool.query(`CREATE TABLE IF NOT EXISTS referral_attributions (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        partner_id UUID NOT NULL REFERENCES referral_partners(id), attached_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`)
      await pool.query(`CREATE TABLE IF NOT EXISTS referral_commissions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), partner_id UUID NOT NULL REFERENCES referral_partners(id),
        user_id UUID NOT NULL REFERENCES users(id), payment_id UUID NOT NULL UNIQUE REFERENCES payments(id),
        gross_minor INTEGER NOT NULL CHECK (gross_minor >= 0), commission_minor INTEGER NOT NULL CHECK (commission_minor >= 0),
        payout_id UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`)
      await pool.query(`CREATE TABLE IF NOT EXISTS referral_payouts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), partner_id UUID NOT NULL REFERENCES referral_partners(id),
        amount_minor INTEGER NOT NULL CHECK (amount_minor > 0), paid_at TIMESTAMPTZ NOT NULL DEFAULT now(), note TEXT
      )`)
      await pool.query('CREATE INDEX IF NOT EXISTS referral_visitors_expiry_idx ON referral_visitors (expires_at)')
      await pool.query('CREATE INDEX IF NOT EXISTS referral_visit_events_partner_idx ON referral_visit_events (partner_id, clicked_at)')
      await pool.query('CREATE INDEX IF NOT EXISTS referral_commissions_partner_idx ON referral_commissions (partner_id, created_at)')
    })().catch((error) => { referralTablesReady = undefined; throw error })
  }
  return referralTablesReady
}
const getConsentPopupSetting = async () => {
  await ensureSettingsTable()
  const result = await pool.query(`SELECT value FROM app_settings WHERE key='consent_popup_enabled'`)
  return result.rows[0]?.value ?? true
}
const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
const tokenHash = (token) => crypto.createHash('sha256').update(token).digest('hex')
const passwordHash = async (password, salt = crypto.randomBytes(16).toString('hex')) => new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (error, key) => error ? reject(error) : resolve(`${salt}:${key.toString('hex')}`)))
const passwordMatches = async (password, encoded) => { const [salt, expected] = encoded.split(':'); const actual = await passwordHash(password, salt); return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(`${salt}:${expected}`)) }
const rawBody = async (req) => { const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > 16_384) throw new Error('payload too large'); chunks.push(chunk) } return Buffer.concat(chunks) }
const parseBody = (raw, contentType = '') => contentType.includes('application/x-www-form-urlencoded') ? Object.fromEntries(new URLSearchParams(raw.toString('utf8'))) : JSON.parse(raw.toString('utf8') || '{}')
const body = async (req) => parseBody(await rawBody(req), req.headers['content-type'] || '')
const paymentPlans = {
  week: { period: 7, amount: 699 },
  threeDays: { period: 3, amount: 299 },
  day: { period: 1, amount: 99 },
}
const sessionUser = async (req) => { const match = req.headers.cookie?.match(new RegExp(`${cookieName}=([^;]+)`)); if (!match) return null; const result = await pool.query("SELECT u.id, u.email, s.expires_at, CASE WHEN sub.status='active' AND (sub.ends_at IS NULL OR sub.ends_at > now()) THEN 'active' WHEN sub.status='active' THEN 'expired' ELSE COALESCE(sub.status, 'inactive') END AS subscription_status FROM sessions s JOIN users u ON u.id=s.user_id LEFT JOIN subscriptions sub ON sub.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at > now()", [tokenHash(match[1])]); return result.rows[0] || null }
const safeEqual = (left, right) => { const a = Buffer.from(String(left)); const b = Buffer.from(String(right)); return a.length === b.length && crypto.timingSafeEqual(a, b) }
const adminPrincipal = (req) => { const match = req.headers.cookie?.match(new RegExp(`${adminCookieName}=([^;]+)`)); if (!match) return null; const key = tokenHash(match[1]); const session = adminSessions.get(key); if (!session || session.expiresAt <= Date.now()) { adminSessions.delete(key); return null } return session.principal }
const isOwner = (req) => adminPrincipal(req)?.role === 'owner'
const adminSession = (req) => isOwner(req)
const setAdminSession = (res, principal) => { const token = crypto.randomBytes(32).toString('base64url'); adminSessions.set(tokenHash(token), { expiresAt: Date.now() + 8 * 60 * 60 * 1000, principal }); res.setHeader('set-cookie', `${adminCookieName}=${token}; Path=/api/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=28800`) }
const setSession = async (res, userId) => { const token = crypto.randomBytes(32).toString('base64url'); await pool.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval \'30 days\')', [tokenHash(token), userId]); res.setHeader('set-cookie', `${cookieName}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`) }
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': process.env.PUBLIC_ORIGIN || '*', 'access-control-allow-credentials': 'true', 'access-control-allow-headers': 'content-type' }); return res.end() }
    if (req.url === '/api/health') return json(res, 200, { ok: true })
    if (req.url === '/api/referral/visit' && req.method === 'POST') {
      const input = await body(req)
      const code = String(input.code || '').trim()
      if (!/^[a-f0-9]{12}$/i.test(code)) return json(res, 400, { error: 'Некорректная реферальная ссылка.' })
      await ensureReferralTables()
      const partner = await pool.query('SELECT id FROM referral_partners WHERE referral_code=$1 AND active=TRUE', [code])
      if (!partner.rows[0]) return json(res, 404, { error: 'Реферальная ссылка не найдена.' })
      const match = req.headers.cookie?.match(/(?:^|;\s*)ballplay_referral=([^;]+)/)
      const visitorToken = match?.[1] || crypto.randomBytes(32).toString('base64url')
      const visitorHash = tokenHash(visitorToken)
      await pool.query(`WITH counted AS (
        INSERT INTO referral_visitors(visitor_hash,partner_id,expires_at) VALUES($1,$2,now()+interval '30 days')
        ON CONFLICT(visitor_hash) DO UPDATE SET partner_id=EXCLUDED.partner_id,first_seen_at=now(),expires_at=EXCLUDED.expires_at
        WHERE referral_visitors.expires_at <= now() RETURNING visitor_hash,partner_id
      ) INSERT INTO referral_visit_events(visitor_hash,partner_id) SELECT visitor_hash,partner_id FROM counted`, [visitorHash, partner.rows[0].id])
      if (!match) res.setHeader('set-cookie', `ballplay_referral=${visitorToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`)
      return json(res, 202, { ok: true })
    }
    if (req.url === '/api/analytics/homepage' && req.method === 'POST') {
      await ensureHomepageViewsTable()
      await pool.query(`INSERT INTO homepage_daily_views(view_date,views) VALUES(CURRENT_DATE,1) ON CONFLICT(view_date) DO UPDATE SET views=homepage_daily_views.views+1`)
      return json(res, 202, { ok: true })
    }
    if (req.url === '/api/public/settings' && req.method === 'GET') return json(res, 200, { consentPopupEnabled: await getConsentPopupSetting() })
    if (req.url === '/api/public/payment-config' && req.method === 'GET') return json(res, 200, { publicId: process.env.CLOUDPAYMENTS_PUBLIC_ID || '', enabled: Boolean(process.env.CLOUDPAYMENTS_PUBLIC_ID && process.env.CLOUDPAYMENTS_API_SECRET) })
    if (req.url === '/api/admin/login' && req.method === 'POST') {
      const ip = req.socket.remoteAddress || 'unknown'; const now = Date.now(); const recent = (adminLoginAttempts.get(ip) || []).filter((time) => now - time < 15 * 60 * 1000)
      if (recent.length >= 8) return json(res, 429, { error: 'Слишком много попыток. Попробуйте позже.' })
      recent.push(now); adminLoginAttempts.set(ip, recent)
      const input = await body(req)
      if (await adminCredentialsMatch(input.username || '', input.password || '', process.env)) {
        adminLoginAttempts.delete(ip); setAdminSession(res, { role: 'owner' }); return json(res, 200, { ok: true, role: 'owner' })
      }
      await ensureReferralTables()
      const partner = await pool.query('SELECT id,username,display_name,password_hash FROM referral_partners WHERE username=$1 AND active=TRUE', [String(input.username || '')])
      if (partner.rows[0] && await passwordMatches(String(input.password || ''), partner.rows[0].password_hash)) {
        adminLoginAttempts.delete(ip)
        setAdminSession(res, { role: 'partner', partnerId: partner.rows[0].id, username: partner.rows[0].username, displayName: partner.rows[0].display_name })
        return json(res, 200, { ok: true, role: 'partner', displayName: partner.rows[0].display_name })
      }
      if ((!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) && !process.env.ADMIN_USERS) return json(res, 503, { error: 'Администратор не настроен на сервере.' })
      return json(res, 401, { error: 'Неверный логин или пароль.' })
    }
    if (req.url === '/api/admin/logout' && req.method === 'POST') { const match = req.headers.cookie?.match(new RegExp(`${adminCookieName}=([^;]+)`)); if (match) adminSessions.delete(tokenHash(match[1])); res.setHeader('set-cookie', `${adminCookieName}=; Path=/api/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0`); return json(res, 200, { ok: true }) }
    if (req.url === '/api/admin/me' && req.method === 'GET') { const principal = adminPrincipal(req); return principal ? json(res, 200, { ok: true, role: principal.role, displayName: principal.displayName }) : json(res, 401, { error: 'Не авторизован.' }) }
    if (req.url === '/api/admin/referral/dashboard' && req.method === 'GET') {
      const principal = adminPrincipal(req)
      if (!principal) return json(res, 401, { error: 'Не авторизован.' })
      if (principal.role !== 'partner') return json(res, 403, { error: 'Этот раздел предназначен для партнёров.' })
      await ensureReferralTables()
      const result = await pool.query(`SELECT rp.display_name,rp.referral_code,
        (SELECT COUNT(*)::bigint FROM referral_visit_events rv WHERE rv.partner_id=rp.id) AS visits,
        (SELECT COUNT(*)::bigint FROM referral_attributions ra WHERE ra.partner_id=rp.id) AS registrations,
        COUNT(rc.id)::bigint AS renewals,(SELECT COUNT(DISTINCT ra.user_id)::bigint FROM referral_attributions ra JOIN payments p ON p.user_id=ra.user_id AND p.status='paid' WHERE ra.partner_id=rp.id) AS paying_customers, COALESCE(SUM(rc.gross_minor),0)::bigint AS gross_minor,
        COALESCE(SUM(rc.commission_minor),0)::bigint AS earned_minor,
        COALESCE(SUM(rc.commission_minor) FILTER (WHERE rc.payout_id IS NOT NULL),0)::bigint AS paid_minor,
        COALESCE(SUM(rc.commission_minor) FILTER (WHERE rc.payout_id IS NULL),0)::bigint AS due_minor
        FROM referral_partners rp LEFT JOIN referral_commissions rc ON rc.partner_id=rp.id
        WHERE rp.id=$1 AND rp.active=TRUE GROUP BY rp.id`, [principal.partnerId])
      if (!result.rows[0]) return json(res, 404, { error: 'Партнёр не найден.' })
      const base = (process.env.PUBLIC_ORIGIN || 'https://ballplay.ru').replace(/\/$/, '')
      return json(res, 200, { ...result.rows[0], referralUrl: `${base}/?ref=${encodeURIComponent(result.rows[0].referral_code)}` })
    }
    if (req.url === '/api/admin/referrals' && req.method === 'GET') {
      if (!adminSession(req)) return json(res, 401, { error: 'Не авторизован.' })
      await ensureReferralTables()
      const result = await pool.query(`SELECT rp.id,rp.username,rp.display_name,rp.referral_code,rp.active,rp.created_at,
        (SELECT COUNT(*)::bigint FROM referral_visit_events rv WHERE rv.partner_id=rp.id) AS visits,
        (SELECT COUNT(*)::bigint FROM referral_attributions ra WHERE ra.partner_id=rp.id) AS registrations,
        COUNT(rc.id)::bigint AS renewals,(SELECT COUNT(DISTINCT ra.user_id)::bigint FROM referral_attributions ra JOIN payments p ON p.user_id=ra.user_id AND p.status='paid' WHERE ra.partner_id=rp.id) AS paying_customers,COALESCE(SUM(rc.commission_minor),0)::bigint AS earned_minor,
        COALESCE(SUM(rc.commission_minor) FILTER (WHERE rc.payout_id IS NOT NULL),0)::bigint AS paid_minor,
        COALESCE(SUM(rc.commission_minor) FILTER (WHERE rc.payout_id IS NULL),0)::bigint AS due_minor
        FROM referral_partners rp LEFT JOIN referral_commissions rc ON rc.partner_id=rp.id GROUP BY rp.id ORDER BY rp.created_at DESC`)
      return json(res, 200, { partners: result.rows })
    }
    if (req.url === '/api/admin/referrals' && req.method === 'POST') {
      if (!adminSession(req)) return json(res, 401, { error: 'Не авторизован.' })
      await ensureReferralTables()
      const input = await body(req)
      const username = String(input.username || '').trim()
      const displayName = String(input.displayName || '').trim()
      const password = String(input.password || '')
      if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(username) || displayName.length < 2 || password.length < 12) return json(res, 400, { error: 'Укажите логин (3–40 символов), имя и пароль не короче 12 символов.' })
      const referralCode = crypto.randomBytes(6).toString('hex')
      try {
        const result = await pool.query('INSERT INTO referral_partners(id,username,password_hash,referral_code,display_name) VALUES($1,$2,$3,$4,$5) RETURNING id,username,display_name,referral_code,active,created_at', [crypto.randomUUID(), username, await passwordHash(password), referralCode, displayName])
        return json(res, 201, { partner: result.rows[0] })
      } catch (error) { if (error.code === '23505') return json(res, 409, { error: 'Такой логин уже существует.' }); throw error }
    }
    const referralToggleMatch = req.url?.match(/^\/api\/admin\/referrals\/([0-9a-f-]+)$/i)
    if (referralToggleMatch && req.method === 'PATCH') {
      if (!adminSession(req)) return json(res, 401, { error: 'Не авторизован.' })
      await ensureReferralTables()
      const input = await body(req)
      if (typeof input.active !== 'boolean') return json(res, 400, { error: 'Ожидалось логическое значение active.' })
      const result = await pool.query('UPDATE referral_partners SET active=$2 WHERE id=$1 RETURNING active', [referralToggleMatch[1], input.active])
      return result.rowCount ? json(res, 200, { active: result.rows[0].active }) : json(res, 404, { error: 'Партнёр не найден.' })
    }
    const referralPayoutMatch = req.url?.match(/^\/api\/admin\/referrals\/([0-9a-f-]+)\/payout$/i)
    if (referralPayoutMatch && req.method === 'POST') {
      if (!adminSession(req)) return json(res, 401, { error: 'Не авторизован.' })
      await ensureReferralTables()
      const input = await body(req)
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const pending = await client.query('SELECT id,commission_minor FROM referral_commissions WHERE partner_id=$1 AND payout_id IS NULL FOR UPDATE', [referralPayoutMatch[1]])
        const amountMinor = pending.rows.reduce((sum, row) => sum + Number(row.commission_minor), 0)
        if (amountMinor <= 0) { await client.query('ROLLBACK'); return json(res, 400, { error: 'Нет начислений к выплате.' }) }
        const payout = await client.query('INSERT INTO referral_payouts(partner_id,amount_minor,note) VALUES($1,$2,$3) RETURNING id,amount_minor,paid_at', [referralPayoutMatch[1], amountMinor, String(input.note || '').slice(0, 500)])
        await client.query('UPDATE referral_commissions SET payout_id=$2 WHERE partner_id=$1 AND payout_id IS NULL', [referralPayoutMatch[1], payout.rows[0].id])
        await client.query('COMMIT')
        return json(res, 200, { payout: payout.rows[0] })
      } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error } finally { client.release() }
    }
    if (req.url === '/api/admin/analytics/homepage' && req.method === 'GET') {
      if (!adminSession(req)) return json(res, 401, { error: 'Не авторизован.' })
      await ensureHomepageViewsTable()
      const [total, days] = await Promise.all([
        pool.query('SELECT COALESCE(SUM(views),0)::bigint AS total FROM homepage_daily_views'),
        pool.query(`SELECT to_char(dates.view_date::date,'YYYY-MM-DD') AS date, COALESCE(views.views,0)::bigint AS views FROM generate_series(CURRENT_DATE-29,CURRENT_DATE,interval '1 day') AS dates(view_date) LEFT JOIN homepage_daily_views AS views ON views.view_date=dates.view_date ORDER BY dates.view_date`),
      ])
      return json(res, 200, { total: Number(total.rows[0].total), days: days.rows.map((row) => ({ date: row.date, views: Number(row.views) })) })
    }
    if (req.url === '/api/admin/settings' && req.method === 'GET') {
      if (!adminSession(req)) return json(res, 401, { error: 'Не авторизован.' })
      return json(res, 200, { consentPopupEnabled: await getConsentPopupSetting() })
    }
    if (req.url === '/api/admin/settings' && req.method === 'PATCH') {
      if (!adminSession(req)) return json(res, 401, { error: 'Не авторизован.' })
      const input = await body(req)
      if (typeof input.consentPopupEnabled !== 'boolean') return json(res, 400, { error: 'Ожидалось логическое значение consentPopupEnabled.' })
      await ensureSettingsTable()
      await pool.query(`INSERT INTO app_settings(key,value,updated_at) VALUES('consent_popup_enabled',$1::jsonb,now()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [JSON.stringify(input.consentPopupEnabled)])
      return json(res, 200, { consentPopupEnabled: input.consentPopupEnabled })
    }
    if (req.url === '/api/admin/users' && req.method === 'GET') {
      if (!adminSession(req)) return json(res, 401, { error: 'Не авторизован.' })
      const result = await pool.query(`SELECT u.id, u.email, u.created_at, COALESCE(s.status, 'inactive') AS subscription_status, s.starts_at, s.ends_at, (SELECT p.status FROM payments p WHERE p.user_id=u.id ORDER BY p.created_at DESC LIMIT 1) AS last_payment_status FROM users u LEFT JOIN subscriptions s ON s.user_id=u.id ORDER BY u.created_at DESC LIMIT 500`)
      return json(res, 200, { users: result.rows })
    }
    const subscriptionMatch = req.url?.match(/^\/api\/admin\/users\/([0-9a-f-]+)\/subscription$/i)
    if (subscriptionMatch && req.method === 'PATCH') {
      if (!adminSession(req)) return json(res, 401, { error: 'Не авторизован.' })
      const input = await body(req); const status = String(input.status || '')
      if (!['active', 'inactive', 'expired', 'cancelled'].includes(status)) return json(res, 400, { error: 'Недопустимый статус подписки.' })
      const result = await pool.query(`INSERT INTO subscriptions(user_id,status,starts_at,ends_at,updated_at) VALUES($1,$2,CASE WHEN $2='active' THEN now() ELSE NULL END,NULL,now()) ON CONFLICT(user_id) DO UPDATE SET status=EXCLUDED.status, starts_at=CASE WHEN EXCLUDED.status='active' THEN COALESCE(subscriptions.starts_at,now()) ELSE subscriptions.starts_at END, updated_at=now() RETURNING status`, [subscriptionMatch[1], status])
      return result.rowCount ? json(res, 200, { status: result.rows[0].status }) : json(res, 404, { error: 'Пользователь не найден.' })
    }
    const claimInitialPayment = async (userId, invoiceId) => {
      if (!invoiceId) return false
      await ensurePaymentColumns()
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await client.query(`SELECT id,user_id,plan_code,payment_kind,status,card_token,paid_at FROM payments WHERE id=$1 AND provider='cloudpayments' FOR UPDATE`, [String(invoiceId)])
        const payment = result.rows[0]
        if (!payment || payment.payment_kind !== 'initial' || payment.status !== 'paid' || payment.user_id || !payment.card_token) { await client.query('ROLLBACK'); return false }
        const plan = paymentPlans[payment.plan_code]
        if (!plan) { await client.query('ROLLBACK'); return false }
        await client.query('UPDATE payments SET user_id=$2 WHERE id=$1 AND user_id IS NULL', [payment.id, userId])
        await client.query(`INSERT INTO subscriptions(user_id,status,provider,provider_subscription_id,plan_code,card_token,starts_at,ends_at,next_charge_at,charge_attempt_at,updated_at) VALUES($1,'active','cloudpayments',NULL,$2,$3,COALESCE($4,now()),COALESCE($4,now())+interval '1 day',COALESCE($4,now())+interval '1 day',NULL,now()) ON CONFLICT(user_id) DO UPDATE SET status='active',provider='cloudpayments',provider_subscription_id=NULL,plan_code=EXCLUDED.plan_code,card_token=EXCLUDED.card_token,starts_at=EXCLUDED.starts_at,ends_at=EXCLUDED.ends_at,next_charge_at=EXCLUDED.next_charge_at,charge_attempt_at=NULL,updated_at=now()`, [userId, payment.plan_code, payment.card_token, payment.paid_at])
        await client.query('COMMIT')
        return true
      } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error } finally { client.release() }
    }
    if (req.url === '/api/auth/register' && req.method === 'POST') {
      const input = await body(req)
      const email = String(input.email || '').trim().toLowerCase()
      const password = String(input.password || '')
      if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 8) return json(res, 400, { error: 'Введите корректный e-mail и пароль не короче 8 символов.' })
      const id = crypto.randomUUID()
      const hash = await passwordHash(password)
      try {
        await ensureReferralTables()
        await pool.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [id, email, hash])
        await pool.query('INSERT INTO subscriptions(user_id) VALUES($1)', [id])
        const referralCookie = req.headers.cookie?.match(/(?:^|;\s*)ballplay_referral=([^;]+)/)?.[1]
        if (referralCookie) await pool.query(`INSERT INTO referral_attributions(user_id,partner_id) SELECT $1,partner_id FROM referral_visitors WHERE visitor_hash=$2 AND expires_at > now() LIMIT 1 ON CONFLICT(user_id) DO NOTHING`, [id, tokenHash(referralCookie)])
        const claimed = await claimInitialPayment(id, input.invoiceId)
        await setSession(res, id)
        if (referralCookie) res.setHeader('set-cookie', [res.getHeader('set-cookie'), 'ballplay_referral=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'])
        return json(res, 201, { user: { id, email }, subscriptionStatus: claimed ? 'active' : 'inactive' })
      } catch (error) { if (error.code === '23505') return json(res, 409, { error: 'Такой e-mail уже зарегистрирован.' }); throw error }
    }
    if (req.url === '/api/auth/login' && req.method === 'POST') { const input = await body(req); const email = String(input.email || '').trim().toLowerCase(); const result = await pool.query('SELECT id,email,password_hash FROM users WHERE email=$1', [email]); if (!result.rows[0] || !(await passwordMatches(String(input.password || ''), result.rows[0].password_hash))) return json(res, 401, { error: 'Неверный e-mail или пароль.' }); await claimInitialPayment(result.rows[0].id, input.invoiceId); await setSession(res, result.rows[0].id); const subscription = await pool.query('SELECT COALESCE(status, \'inactive\') AS status FROM subscriptions WHERE user_id=$1', [result.rows[0].id]); return json(res, 200, { user: { id: result.rows[0].id, email }, subscriptionStatus: subscription.rows[0]?.status || 'inactive' }) }
    if (req.url === '/api/auth/me' && req.method === 'GET') { const user = await sessionUser(req); return user ? json(res, 200, { user: { id: user.id, email: user.email }, subscriptionStatus: user.subscription_status }) : json(res, 401, { error: 'Не авторизован.' }) }
    if (req.url === '/api/payment/intent' && req.method === 'POST') {
      if (!process.env.CLOUDPAYMENTS_PUBLIC_ID || !process.env.CLOUDPAYMENTS_API_SECRET) return json(res, 503, { error: 'Платёжная система ещё не настроена.' })
      const input = await body(req); const plan = paymentPlans[String(input.plan || '')]
      if (!plan) return json(res, 400, { error: 'Выберите тариф.' })
      if (input.consents?.terms !== true || input.consents?.personalData !== true || input.consents?.recurring !== true) return json(res, 400, { error: 'Для перехода к оплате подтвердите условия использования, обработку персональных данных и условия подписки.' })
      await ensurePaymentColumns()
      const id = crypto.randomUUID()
      const email = String(input.email || '').trim().toLowerCase()
      if (email && !/^\S+@\S+\.\S+$/.test(email)) return json(res, 400, { error: 'Введите корректный e-mail.' })
      const consentData = {
        terms: true,
        personalData: true,
        recurring: true,
        acceptedAt: new Date().toISOString(),
        termsVersion: '2026-10-21',
        privacyVersion: '2026-10-21',
        recurringOfferVersion: '2026-10-21',
        introductoryAmount: 1,
        introductoryPeriodDays: 1,
        recurringAmount: plan.amount,
        recurringPeriodDays: plan.period,
        planCode: String(input.plan),
      }
      await pool.query(`INSERT INTO payments(id,user_id,account_id,provider,amount_minor,currency,status,plan_code,payment_kind,consent_data) VALUES($1::uuid,NULL,$1::text,'cloudpayments',100,'RUB','pending',$2,'initial',$3::jsonb)`, [id, String(input.plan), JSON.stringify(consentData)])
      return json(res, 201, { invoiceId: id, accountId: id, email, publicId: process.env.CLOUDPAYMENTS_PUBLIC_ID, amount: 1, plan: { period: plan.period, amount: plan.amount } })
    }
    const paymentStatusMatch = req.url?.match(/^\/api\/payment\/status\/([0-9a-f-]+)$/i)
    if (paymentStatusMatch && req.method === 'GET') {
      const result = await pool.query(`SELECT status FROM payments WHERE id=$1 AND provider='cloudpayments' AND payment_kind='initial'`, [paymentStatusMatch[1]])
      return result.rows[0] ? json(res, 200, { status: result.rows[0].status }) : json(res, 404, { error: 'Платёж не найден.' })
    }
    if (req.url === '/api/payment/check' && req.method === 'POST') {
      const raw = await rawBody(req)
      if (!verifyCloudPaymentsSignature(raw, req.headers, process.env.CLOUDPAYMENTS_API_SECRET)) return json(res, 401, { code: 13 })
      const input = parseBody(raw, req.headers['content-type'] || '')
      if (String(input.OperationType || '').toLowerCase() !== 'payment' || String(input.Currency || '').toUpperCase() !== 'RUB') return json(res, 200, { code: 13 })
      const invoiceId = String(input.InvoiceId || '')
      const accountId = String(input.AccountId || '')
      await ensurePaymentColumns()
      const result = invoiceId
        ? await pool.query(`SELECT user_id,amount_minor,currency,status,payment_kind FROM payments WHERE id=$1 AND provider='cloudpayments'`, [invoiceId])
        : await pool.query(`SELECT user_id,amount_minor,currency,status,payment_kind FROM payments WHERE user_id=$1 AND provider='cloudpayments' AND payment_kind='initial' AND amount_minor=100 AND status='pending' ORDER BY created_at DESC LIMIT 1`, [accountId])
      const payment = result.rows[0]
      if (!payment) return json(res, 200, { code: 10 })
      if ((payment.user_id || invoiceId) !== accountId) return json(res, 200, { code: 11 })
      if (payment.payment_kind !== 'initial' || payment.amount_minor !== Math.round(Number(input.Amount) * 100) || payment.currency !== String(input.Currency).toUpperCase()) return json(res, 200, { code: 12 })
      if (payment.status !== 'pending') return json(res, 200, { code: 13 })
      return json(res, 200, { code: 0 })
    }
    if (req.url === '/api/payment/webhook' && req.method === 'POST') {
      const raw = await rawBody(req)
      if (!verifyCloudPaymentsSignature(raw, req.headers, process.env.CLOUDPAYMENTS_API_SECRET)) return json(res, 401, { code: 13, message: 'Invalid signature' })
      const input = parseBody(raw, req.headers['content-type'] || '')
      if (String(input.OperationType || '').toLowerCase() !== 'payment' || String(input.Currency || '').toUpperCase() !== 'RUB') return json(res, 400, { code: 13, message: 'Unexpected operation or currency' })
      const invoiceId = String(input.InvoiceId || '')
      const accountId = String(input.AccountId || '')
      const providerPaymentId = String(input.TransactionId || '')
      const amount = Number(input.Amount)
      if (!accountId || !providerPaymentId || !Number.isFinite(amount)) return json(res, 400, { code: 13, message: 'Missing payment fields' })
      await ensurePaymentColumns()
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const duplicate = await client.query(`SELECT 1 FROM payments WHERE provider_payment_id=$1`, [providerPaymentId])
        if (duplicate.rowCount) { await client.query('COMMIT'); return json(res, 200, { code: 0 }) }
        const result = invoiceId
          ? await client.query(`SELECT id,user_id,account_id,amount_minor,plan_code,payment_kind,status FROM payments WHERE id=$1 AND provider='cloudpayments' FOR UPDATE`, [invoiceId])
          : await client.query(`SELECT id,user_id,amount_minor,plan_code,payment_kind,status FROM payments WHERE user_id=$1 AND provider='cloudpayments' AND payment_kind='initial' AND amount_minor=100 AND status='pending' AND created_at > now()-interval '30 minutes' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [accountId])
        const payment = result.rows[0]
        const duplicateAfterLock = await client.query(`SELECT 1 FROM payments WHERE provider_payment_id=$1`, [providerPaymentId])
        if (duplicateAfterLock.rowCount) { await client.query('COMMIT'); return json(res, 200, { code: 0 }) }
        if (!payment || (payment.user_id || payment.account_id || payment.id) !== accountId || payment.status !== 'pending' || payment.amount_minor !== Math.round(amount * 100)) {
          await client.query('ROLLBACK'); return json(res, 400, { code: 13, message: 'Payment does not match invoice' })
        }
        const plan = paymentPlans[payment.plan_code]
        if (!plan) { await client.query('ROLLBACK'); return json(res, 400, { code: 13, message: 'Unknown plan' }) }
        const paymentStatus = String(input.Status || '').toLowerCase()
        const completed = paymentStatus === 'completed'
        if (!completed) {
          if (!['declined', 'failed', 'cancelled'].includes(paymentStatus)) {
            await client.query('COMMIT')
            return json(res, 200, { code: 0 })
          }
          await client.query(`UPDATE payments SET status='failed',provider_payment_id=$2 WHERE id=$1`, [payment.id, providerPaymentId])
          if (payment.payment_kind === 'recurring') await client.query(`UPDATE subscriptions SET next_charge_at=now()+interval '1 day',charge_attempt_at=NULL,updated_at=now() WHERE user_id=$1 AND status <> 'cancelled'`, [accountId])
          await client.query('COMMIT')
          return json(res, 200, { code: 0 })
        }
        await client.query(`UPDATE payments SET status='paid',provider_payment_id=$2,paid_at=now(),card_token=$3 WHERE id=$1`, [payment.id, providerPaymentId, String(input.Token || '') || null])
        if (payment.payment_kind === 'initial') {
          const cardToken = String(input.Token || '')
          if (payment.amount_minor !== 100 || !cardToken) {
            await client.query('ROLLBACK'); return json(res, 400, { code: 13, message: 'Initial payment must be 1 RUB and include a tokenized card' })
          }
          if (payment.user_id) await client.query(`INSERT INTO subscriptions(user_id,status,provider,provider_subscription_id,plan_code,card_token,starts_at,ends_at,next_charge_at,charge_attempt_at,updated_at) VALUES($1,'active','cloudpayments',NULL,$2,$3,now(),now()+interval '1 day',now()+interval '1 day',NULL,now()) ON CONFLICT(user_id) DO UPDATE SET status='active',provider='cloudpayments',provider_subscription_id=NULL,plan_code=EXCLUDED.plan_code,card_token=EXCLUDED.card_token,starts_at=now(),ends_at=now()+interval '1 day',next_charge_at=now()+interval '1 day',charge_attempt_at=NULL,updated_at=now()`, [accountId, payment.plan_code, cardToken])
        } else {
          const subscriptionResult = await client.query(`SELECT plan_code,status FROM subscriptions WHERE user_id=$1 FOR UPDATE`, [accountId])
          const subscription = subscriptionResult.rows[0]
          if (!subscription || subscription.status === 'cancelled' || subscription.plan_code !== payment.plan_code || payment.amount_minor !== plan.amount * 100) {
            await client.query('ROLLBACK'); return json(res, 400, { code: 13, message: 'Recurring payment does not match active plan' })
          }
          await client.query(`UPDATE subscriptions SET status='active',ends_at=GREATEST(COALESCE(ends_at,now()),now())+($2 * interval '1 day'),next_charge_at=GREATEST(COALESCE(ends_at,now()),now())+($2 * interval '1 day'),charge_attempt_at=NULL,updated_at=now() WHERE user_id=$1`, [accountId, plan.period])
          await ensureReferralTables()
          await client.query(`INSERT INTO referral_commissions(partner_id,user_id,payment_id,gross_minor,commission_minor)
            SELECT partner_id,$1,$2,$3,ROUND($3 * 0.5)::integer FROM referral_attributions
            WHERE user_id=$1 AND $3 > 0 ON CONFLICT(payment_id) DO NOTHING`, [accountId, payment.id, payment.amount_minor])
        }
        await client.query('COMMIT')
        return json(res, 200, { code: 0 })
      } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error } finally { client.release() }
    }
    if (req.url === '/api/schema.sql' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(await fs.readFile(path.join(root, 'schema.sql'), 'utf8')) }
    return json(res, 404, { error: 'Not found' })
  } catch (error) { console.error(error); return json(res, 500, { error: 'Внутренняя ошибка сервера.' }) }
})
server.listen(port, '127.0.0.1', () => console.log(`BallPlay API listening on 127.0.0.1:${port}`))

let recurringSweepRunning = false
const runRecurringChargeSweep = async () => {
  if (recurringSweepRunning || !process.env.CLOUDPAYMENTS_PUBLIC_ID || !process.env.CLOUDPAYMENTS_API_SECRET) return
  recurringSweepRunning = true
  try {
    await ensurePaymentColumns()
    const client = await pool.connect()
    let due = []
    try {
      await client.query('BEGIN')
      const result = await client.query(`SELECT s.user_id,s.card_token,s.plan_code FROM subscriptions s WHERE s.status='active' AND s.card_token IS NOT NULL AND s.next_charge_at <= now() AND (s.charge_attempt_at IS NULL OR s.charge_attempt_at < now()-interval '48 hours') AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.user_id=s.user_id AND p.payment_kind='recurring' AND p.status='pending') ORDER BY s.next_charge_at FOR UPDATE OF s SKIP LOCKED LIMIT 20`)
      due = result.rows
      for (const subscription of due) {
        const plan = paymentPlans[subscription.plan_code]
        if (!plan) continue
        const invoiceId = crypto.randomUUID()
        await client.query(`INSERT INTO payments(id,user_id,provider,amount_minor,currency,status,plan_code,payment_kind) VALUES($1,$2,'cloudpayments',$3,'RUB','pending',$4,'recurring')`, [invoiceId, subscription.user_id, plan.amount * 100, subscription.plan_code])
        subscription.invoice_id = invoiceId
        subscription.amount_minor = plan.amount * 100
        await client.query(`UPDATE subscriptions SET next_charge_at=now()+interval '48 hours',charge_attempt_at=now(),updated_at=now() WHERE user_id=$1`, [subscription.user_id])
      }
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error } finally { client.release() }

    for (const subscription of due) {
      if (!subscription.invoice_id) continue
      try {
        const result = await createTokenCharge({ token: subscription.card_token, accountId: subscription.user_id, invoiceId: subscription.invoice_id, amountMinor: subscription.amount_minor, publicId: process.env.CLOUDPAYMENTS_PUBLIC_ID, apiSecret: process.env.CLOUDPAYMENTS_API_SECRET })
        if (result.success || result.retryable) continue
        await pool.query(`UPDATE payments SET status='failed' WHERE id=$1 AND status='pending'`, [subscription.invoice_id])
        await pool.query(`UPDATE subscriptions SET next_charge_at=now()+interval '1 day',charge_attempt_at=NULL,updated_at=now() WHERE user_id=$1 AND status <> 'cancelled'`, [subscription.user_id])
        console.warn(`CloudPayments token charge declined for subscription ${subscription.user_id}: ${result.message || 'declined'}`)
      } catch (error) {
        // A timeout is ambiguous: leave the pending invoice/lease in place to avoid a duplicate charge.
        console.error('CloudPayments token charge request failed; keeping its invoice pending', error)
      }
    }
  } catch (error) {
    console.error('Recurring charge sweep failed', error)
  } finally { recurringSweepRunning = false }
}

setInterval(() => { void runRecurringChargeSweep() }, 60_000)
