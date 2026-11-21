// Zero-dependency Node server: serves the app and provides accounts + sync.
// Run: npm start  ->  http://localhost:3000
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, '..');
const DB_FILE = path.join(__dirname, 'db.json');
const CURRENCIES = ['₦', '$', '€', '£'];
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.md': 'text/plain; charset=utf-8' };

let db = { secret: crypto.randomBytes(32).toString('hex'), users: {} };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) {}
const persist = () => fs.writeFileSync(DB_FILE, JSON.stringify(db));
persist();

const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const mac = (b) => crypto.createHmac('sha256', db.secret).update(b).digest('base64url');
const makeToken = (email) => { const b = Buffer.from(JSON.stringify({ email, exp: Date.now() + 7 * 864e5 })).toString('base64url'); return b + '.' + mac(b); };
function readToken(t) {
  const [b, s] = (t || '').split('.');
  if (!b || !s) return null;
  const e = mac(b);
  if (s.length !== e.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(e))) return null;
  try { const p = JSON.parse(Buffer.from(b, 'base64url')); return p.exp > Date.now() ? p : null; } catch (e) { return null; }
}

const hits = new Map(); // simple per-IP limit on login/register
function limited(ip) {
  const now = Date.now(), list = (hits.get(ip) || []).filter(t => now - t < 60000);
  list.push(now); hits.set(ip, list);
  return list.length > 10;
}

function send(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type || 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(type ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 1e6) { reject(new Error('Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch (e) { reject(new Error('Invalid JSON')); } });
  });
}
function clean(d) {
  if (!d || !Array.isArray(d.expenses) || d.expenses.length > 5000) throw new Error('Invalid data');
  const dc = CURRENCIES.includes(d.currency) ? d.currency : '₦';
  const expenses = d.expenses.map(e => {
    if (!e || typeof e.desc !== 'string' || typeof e.cat !== 'string' || !Number.isFinite(e.amount) || e.amount <= 0 ||
        !Number.isFinite(e.id) || !/^\d{4}-\d{2}-\d{2}$/.test(e.date)) throw new Error('Invalid expense');
    return { id: e.id, desc: e.desc.slice(0, 60), amount: e.amount, cat: e.cat.slice(0, 20), date: e.date, cur: CURRENCIES.includes(e.cur) ? e.cur : dc };
  });
  const budgets = {}, budgetCurs = {};
  Object.entries(d.budgets || {}).forEach(([k, v]) => {
    if (/^\d{4}-\d{2}$/.test(k) && Number.isFinite(v) && v >= 0) { budgets[k] = v; const c = (d.budgetCurs || {})[k]; budgetCurs[k] = CURRENCIES.includes(c) ? c : dc; }
  });
  return { expenses, budgets, budgetCurs, currency: dc };
}

async function api(req, res, route) {
  if (route === '/register' || route === '/login') {
    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
    if (limited(req.socket.remoteAddress)) return send(res, 429, { error: 'Too many attempts. Wait a minute.' });
    const { email, password } = await readBody(req);
    const em = String(email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em) || em.length > 120) return send(res, 400, { error: 'Enter a valid email.' });
    if (route === '/register') {
      if (typeof password !== 'string' || password.length < 8 || password.length > 200) return send(res, 400, { error: 'Password must be 8 or more characters.' });
      if (Object.prototype.hasOwnProperty.call(db.users, em)) return send(res, 409, { error: 'That email already has an account. Log in instead.' });
      const salt = crypto.randomBytes(16).toString('hex');
      db.users[em] = { salt, hash: hashPw(password, salt), data: { expenses: [], budgets: {}, budgetCurs: {}, currency: '₦' } };
      persist();
      return send(res, 201, { token: makeToken(em), email: em });
    }
    const u = Object.prototype.hasOwnProperty.call(db.users, em) ? db.users[em] : null;
    const ok = u && typeof password === 'string' && crypto.timingSafeEqual(Buffer.from(hashPw(password, u.salt)), Buffer.from(u.hash));
    if (!ok) return send(res, 401, { error: 'Wrong email or password.' });
    return send(res, 200, { token: makeToken(em), email: em });
  }
  if (route === '/data') {
    const t = readToken((req.headers.authorization || '').replace(/^Bearer /, ''));
    if (!t || !db.users[t.email]) return send(res, 401, { error: 'Session expired. Sign in again.' });
    if (req.method === 'GET') return send(res, 200, db.users[t.email].data);
    if (req.method === 'PUT') { db.users[t.email].data = clean(await readBody(req)); persist(); return send(res, 200, { ok: true }); }
    return send(res, 405, { error: 'Method not allowed' });
  }
  send(res, 404, { error: 'Not found' });
}

function serveStatic(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  const rel = path.relative(ROOT, file);
  if (!(rel === 'index.html' || /^(css|js)[\\/]/.test(rel))) return send(res, 404, 'Not found', 'text/plain');
  fs.readFile(file, (err, data) => err ? send(res, 404, 'Not found', 'text/plain') : send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream'));
}

http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '', 'text/plain');
    if (req.url.startsWith('/api/')) return await api(req, res, req.url.slice(4).split('?')[0]);
    serveStatic(req, res);
  } catch (e) { send(res, 400, { error: e.message || 'Bad request' }); }
}).listen(PORT, () => console.log('Expense Tracker running at http://localhost:' + PORT));
