import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const { Pool } = pg
const root = path.dirname(fileURLToPath(import.meta.url))
const databaseUrl = process.env.DATABASE_URL || `postgresql://${encodeURIComponent(process.env.DB_USER || '')}:${encodeURIComponent(process.env.DB_PASSWORD || '')}@${process.env.DB_HOST || '127.0.0.1'}:${process.env.DB_PORT || '5432'}/${process.env.DB_NAME || 'default_db'}`
const pool = new Pool({ connectionString: databaseUrl, ssl: process.env.DATABASE_SSL === 'require' ? { rejectUnauthorized: false } : undefined })
const port = Number(process.env.API_PORT || 3001)
const cookieName = 'ballplay_session'
const adminCookieName = 'ballplay_admin_session'
const adminSessions = new Map()
const adminLoginAttempts = new Map()
const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
const tokenHash = (token) => crypto.createHash('sha256').update(token).digest('hex')
const passwordHash = async (password, salt = crypto.randomBytes(16).toString('hex')) => new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (error, key) => error ? reject(error) : resolve(`${salt}:${key.toString('hex')}`)))
const passwordMatches = async (password, encoded) => { const [salt, expected] = encoded.split(':'); const actual = await passwordHash(password, salt); return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(`${salt}:${expected}`)) }
const body = async (req) => { let data = ''; for await (const chunk of req) data += chunk; if (data.length > 16_384) throw new Error('payload too large'); return JSON.parse(data || '{}') }
const sessionUser = async (req) => { const match = req.headers.cookie?.match(new RegExp(`${cookieName}=([^;]+)`)); if (!match) return null; const result = await pool.query('SELECT u.id, u.email, s.expires_at, COALESCE(sub.status, \'inactive\') AS subscription_status FROM sessions s JOIN users u ON u.id=s.user_id LEFT JOIN subscriptions sub ON sub.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at > now()', [tokenHash(match[1])]); return result.rows[0] || null }
const safeEqual = (left, right) => { const a = Buffer.from(String(left)); const b = Buffer.from(String(right)); return a.length === b.length && crypto.timingSafeEqual(a, b) }
const adminSession = (req) => { const match = req.headers.cookie?.match(new RegExp(`${adminCookieName}=([^;]+)`)); if (!match) return false; const key = tokenHash(match[1]); const expiresAt = adminSessions.get(key); if (!expiresAt || expiresAt <= Date.now()) { adminSessions.delete(key); return false } return true }
const setAdminSession = (res) => { const token = crypto.randomBytes(32).toString('base64url'); adminSessions.set(tokenHash(token), Date.now() + 8 * 60 * 60 * 1000); res.setHeader('set-cookie', `${adminCookieName}=${token}; Path=/api/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=28800`) }
const setSession = async (res, userId) => { const token = crypto.randomBytes(32).toString('base64url'); await pool.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval \'30 days\')', [tokenHash(token), userId]); res.setHeader('set-cookie', `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`) }
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': process.env.PUBLIC_ORIGIN || '*', 'access-control-allow-credentials': 'true', 'access-control-allow-headers': 'content-type' }); return res.end() }
    if (req.url === '/api/health') return json(res, 200, { ok: true })
    if (req.url === '/api/admin/login' && req.method === 'POST') {
      if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) return json(res, 503, { error: 'Администратор не настроен на сервере.' })
      const ip = req.socket.remoteAddress || 'unknown'; const now = Date.now(); const recent = (adminLoginAttempts.get(ip) || []).filter((time) => now - time < 15 * 60 * 1000)
      if (recent.length >= 8) return json(res, 429, { error: 'Слишком много попыток. Попробуйте позже.' })
      recent.push(now); adminLoginAttempts.set(ip, recent)
      const input = await body(req)
      if (!safeEqual(input.username || '', process.env.ADMIN_USERNAME) || !safeEqual(input.password || '', process.env.ADMIN_PASSWORD)) return json(res, 401, { error: 'Неверный логин или пароль.' })
      adminLoginAttempts.delete(ip); setAdminSession(res); return json(res, 200, { ok: true })
    }
    if (req.url === '/api/admin/logout' && req.method === 'POST') { const match = req.headers.cookie?.match(new RegExp(`${adminCookieName}=([^;]+)`)); if (match) adminSessions.delete(tokenHash(match[1])); res.setHeader('set-cookie', `${adminCookieName}=; Path=/api/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0`); return json(res, 200, { ok: true }) }
    if (req.url === '/api/admin/me' && req.method === 'GET') return adminSession(req) ? json(res, 200, { ok: true }) : json(res, 401, { error: 'Не авторизован.' })
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
    if (req.url === '/api/auth/register' && req.method === 'POST') { const input = await body(req); const email = String(input.email || '').trim().toLowerCase(); const password = String(input.password || ''); if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 8) return json(res, 400, { error: 'Введите корректный e-mail и пароль не короче 8 символов.' }); const id = crypto.randomUUID(); const hash = await passwordHash(password); try { await pool.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [id, email, hash]); await pool.query('INSERT INTO subscriptions(user_id) VALUES($1)', [id]); await setSession(res, id); return json(res, 201, { user: { id, email }, subscriptionStatus: 'inactive' }) } catch (error) { if (error.code === '23505') return json(res, 409, { error: 'Такой e-mail уже зарегистрирован.' }); throw error } }
    if (req.url === '/api/auth/login' && req.method === 'POST') { const input = await body(req); const email = String(input.email || '').trim().toLowerCase(); const result = await pool.query('SELECT id,email,password_hash FROM users WHERE email=$1', [email]); if (!result.rows[0] || !(await passwordMatches(String(input.password || ''), result.rows[0].password_hash))) return json(res, 401, { error: 'Неверный e-mail или пароль.' }); await setSession(res, result.rows[0].id); const subscription = await pool.query('SELECT COALESCE(status, \'inactive\') AS status FROM subscriptions WHERE user_id=$1', [result.rows[0].id]); return json(res, 200, { user: { id: result.rows[0].id, email }, subscriptionStatus: subscription.rows[0]?.status || 'inactive' }) }
    if (req.url === '/api/auth/me' && req.method === 'GET') { const user = await sessionUser(req); return user ? json(res, 200, { user: { id: user.id, email: user.email }, subscriptionStatus: user.subscription_status }) : json(res, 401, { error: 'Не авторизован.' }) }
    if (req.url === '/api/payment/webhook' && req.method === 'POST') return json(res, 501, { error: 'Платёжный провайдер ещё не подключён.' })
    if (req.url === '/api/schema.sql' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(await fs.readFile(path.join(root, 'schema.sql'), 'utf8')) }
    return json(res, 404, { error: 'Not found' })
  } catch (error) { console.error(error); return json(res, 500, { error: 'Внутренняя ошибка сервера.' }) }
})
server.listen(port, '127.0.0.1', () => console.log(`BallPlay API listening on 127.0.0.1:${port}`))
