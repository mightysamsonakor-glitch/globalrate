require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');

const app = express();
app.set('trust proxy', 1); // behind Render's proxy, so req.ip is the real visitor
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'db.json');

app.use(express.static('public'));
// Uploaded item photos live here (put it on a persistent disk in production via UPLOADS_DIR)
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(path.dirname(process.env.DB_PATH || path.join(__dirname, 'data', 'db.json')), 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '7d' }));
app.use('/api/admin/import', express.json({ limit: '120mb' }));
app.use(express.json({ limit: '15mb' }));

// --- Email setup: sends through Zoho Mail (globalrate.space), with Gmail as a fallback ---
let mailer = null;
let mailFromAddress = null;

if (process.env.SMTP_USER && process.env.SMTP_PASSWORD) {
  const smtpHost = process.env.SMTP_HOST || 'smtppro.zoho.eu';
  const smtpPort = Number(process.env.SMTP_PORT) || 465;
  mailer = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
  });
  mailFromAddress = process.env.SMTP_USER;
  console.log(`Email sending is configured (${smtpHost}).`);
} else if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
  mailer = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
  });
  mailFromAddress = process.env.GMAIL_USER;
  console.log('Email sending is configured (Gmail).');
} else {
  console.log('No email credentials found in .env — welcome emails will be skipped.');
}

// Test the login right at startup so any problem shows up immediately
if (mailer) {
  mailer.verify()
    .then(() => console.log('Mail server login OK.'))
    .catch(err => console.log('Mail server login FAILED:', err.message));
}

async function sendWelcomeEmail(user) {
  if (!mailer) return;
  const safeName = String(user.name).replace(/[<>&]/g, '');
  const site = process.env.BASE_URL ? process.env.BASE_URL.replace(/\/+$/, '') : 'https://www.globalrate.space';
  try {
    await mailer.sendMail({
      from: `"GlobalRate" <${mailFromAddress}>`,
      to: user.email,
      subject: 'Welcome to GlobalRate!',
      text: `Hi ${user.name},\n\nYour GlobalRate account is ready. You can now:\n\n- Check live currency rates and compare remittance agents\n- Post and manage listings in the Local Currency Marketplace\n- Offer or find vehicle, taxi and e-bike rentals\n- Sell items and gadgets with photos\n- List a room or flat-share, or find one near you\n- Chat directly with other users about any listing\n\nGet started: ${site}\n\nForgot your password one day? Use the "Forgot your password?" link on the sign-in box.\n\n— The GlobalRate team`,
      html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#1e293b">
        <h2 style="color:#6d28d9">Welcome to GlobalRate, ${safeName}! 🎉</h2>
        <p>Your account is ready. You can now:</p>
        <ul style="line-height:1.8">
          <li>💱 Check live currency rates and compare remittance agents</li>
          <li>🏙️ Post and manage listings in the Local Currency Marketplace</li>
          <li>🚗 Offer or find vehicle, taxi and e-bike rentals</li>
          <li>📦 Sell items and gadgets with photos</li>
          <li>🏠 List a room or flat-share, or find one near you</li>
          <li>💬 Chat directly with other users about any listing</li>
        </ul>
        <p style="margin:24px 0"><a href="${site}" style="background:#7c3aed;color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:bold">Open GlobalRate</a></p>
        <p style="font-size:13px;color:#64748b">Forgot your password one day? Use the "Forgot your password?" link on the sign-in box.</p>
        <p>— The GlobalRate team</p></div>`
    });
    console.log(`Welcome email sent to ${user.email}`);
  } catch (err) {
    console.log('Could not send welcome email:', err.message);
  }
}

// --- Simple JSON-file database (persists across restarts) ---
function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const initial = { users: [], marketplace: [], rentals: [], items: [], rooms: [], messages: [], activity: [], stats: { visits: {} } };
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }
  const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  // Fill in any new sections for databases created before this update
  data.users = data.users || [];
  data.marketplace = data.marketplace || [];
  data.rentals = data.rentals || [];
  data.items = data.items || [];
  data.rooms = data.rooms || [];
  data.activity = data.activity || [];
  data.stats = data.stats || { visits: {} };
  data.stats.visits = data.stats.visits || {};
  data.messages = data.messages || [];
  return data;
}
function saveDB() {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}
let db = loadDB();

// --- Sessions ---------------------------------------------------------------
// Regular users stay signed in until they have been idle for SESSION_IDLE_DAYS (default 30, sliding —
// every visit extends it), like most marketplaces and social apps. Admin powers are stricter: they lock
// again after ADMIN_IDLE_MINUTES (default 30) without admin activity, and must be unlocked with the key.
// Sessions are saved to a small file next to the database so deploys/restarts don't sign everyone out.
const SESSION_IDLE_MS = (Number(process.env.SESSION_IDLE_DAYS) || 30) * 24 * 3600 * 1000;
const ADMIN_IDLE_MS = (Number(process.env.ADMIN_IDLE_MINUTES) || 30) * 60 * 1000;
const SESSIONS_PATH = process.env.SESSIONS_PATH || path.join(path.dirname(DB_PATH), 'sessions.json');
let sessions = {};      // token -> userId
const sessionSeen = {}; // token -> last time it was used
const adminSeen = {};   // token -> last admin activity
let sessionSaveTimer = null;
function persistSessions() {
  if (sessionSaveTimer) return;
  sessionSaveTimer = setTimeout(() => {
    sessionSaveTimer = null;
    try {
      const out = {};
      Object.keys(sessions).forEach(t => { out[t] = { u: sessions[t], s: sessionSeen[t] || Date.now() }; });
      fs.writeFileSync(SESSIONS_PATH, JSON.stringify(out), { mode: 0o600 });
    } catch (e) { console.error('Could not save sessions:', e.message); }
  }, 3000);
}
(function loadSessions() {
  try {
    const saved = JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8'));
    const now = Date.now();
    Object.keys(saved).forEach(t => {
      const r = saved[t];
      if (r && r.u && now - r.s < SESSION_IDLE_MS && db.users.some(u => u.id === r.u)) { sessions[t] = r.u; sessionSeen[t] = r.s; }
    });
  } catch (e) { /* no saved sessions yet */ }
})();
function startSession(token, userId) { sessions[token] = userId; sessionSeen[token] = Date.now(); persistSessions(); }
function endSession(token) { delete sessions[token]; delete sessionSeen[token]; delete adminSeen[token]; adminTokens.delete(token); persistSessions(); }
// Returns the user id for a token if it is still valid (and slides the idle timer), else null.
function liveSession(token) {
  const userId = sessions[token];
  if (!userId) return null;
  const now = Date.now();
  if (now - (sessionSeen[token] || 0) > SESSION_IDLE_MS) { endSession(token); return null; }
  if (now - (sessionSeen[token] || 0) > 10 * 60 * 1000) { sessionSeen[token] = now; persistSessions(); } // refresh at most every 10 min
  return userId;
}
setInterval(() => { Object.keys(sessions).forEach(t => { if (Date.now() - (sessionSeen[t] || 0) > SESSION_IDLE_MS) endSession(t); }); }, 3600 * 1000).unref();

function authMiddleware(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const userId = liveSession(token);
  const user = userId && db.users.find(u => u.id === userId);
  if (!user) return res.status(401).json({ error: 'Please log in to continue' });
  req.user = user;
  next();
}


const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const adminTokens = new Set();          // login tokens that have been unlocked with the admin key
const adminFailures = {};               // userId -> { count, until }
const startedAt = Date.now();

function tokenOf(req) { return (req.headers.authorization || '').replace('Bearer ', ''); }
function canAdmin(user) { return !!user && ADMIN_EMAILS.includes(user.email.toLowerCase()); }
function isAdminReq(req) {
  const t = tokenOf(req);
  if (!canAdmin(req.user) || !adminTokens.has(t)) return false;
  if (Date.now() - (adminSeen[t] || 0) > ADMIN_IDLE_MS) { adminTokens.delete(t); return false; } // admin lock after idle
  return true;
}
function publicUser(user, req) {
  return { id: user.id, name: user.name, phone: user.phone, email: user.email,
           canAdmin: canAdmin(user), isAdmin: req ? isAdminReq(req) : false };
}
function adminMiddleware(req, res, next) {
  authMiddleware(req, res, () => {
    if (!isAdminReq(req)) return res.status(403).json({ error: 'Admin access required' });
    adminSeen[tokenOf(req)] = Date.now();
    next();
  });
}

// Activity log (kept to the last 1000 events) — this is what you monitor in the admin panel
function logEvent(type, detail, user) {
  db.activity.unshift({
    at: new Date().toISOString(), type, detail: detail || '',
    userId: user ? user.id : null, userName: user ? user.name : null
  });
  if (db.activity.length > 1000) db.activity.length = 1000;
}

// Count daily page visits (in memory, flushed to disk every few minutes)
let statsDirty = false;
app.use((req, res, next) => {
  if (req.method === 'GET' && (req.path === '/' || req.path === '/index.html')) {
    const day = new Date().toISOString().slice(0, 10);
    db.stats.visits[day] = (db.stats.visits[day] || 0) + 1;
    statsDirty = true;
  }
  next();
});
setInterval(() => { if (statsDirty) { statsDirty = false; saveDB(); } }, 5 * 60 * 1000);

// --- Historical NGN official vs parallel rates ---
let rates = [
  { date: '2026-09-20', official: 1325, parallel: 1385 },
  { date: '2026-09-21', official: 1326, parallel: 1387 },
  { date: '2026-09-22', official: 1327, parallel: 1388 },
  { date: '2026-09-23', official: 1328, parallel: 1389 },
  { date: '2026-09-24', official: 1328, parallel: 1390 },
  { date: '2026-09-25', official: 1329, parallel: 1390 },
  { date: '2026-09-26', official: 1329.44, parallel: 1390 }
];

let providers = [
  { name: 'LemFi', rate: 1345, fee: 'No transfer fee', notes: 'Popular for UK/US to Nigeria transfers', region: 'Nigeria', url: 'https://lemfi.com', submitted: false },
  { name: 'Nala', rate: 1340, fee: 'Low fixed fee', notes: 'Strong for Europe to East Africa transfers', region: 'Kenya', url: 'https://www.nala.com', submitted: false },
  { name: 'Chipper Cash', rate: 1335, fee: 'Free for small amounts', notes: 'Good for cross-border transfers within Africa', region: 'Africa', url: 'https://chippercash.com', submitted: false },
  { name: 'Wise', rate: 1330, fee: 'Small % fee', notes: 'Transparent fee breakdown, widely trusted worldwide', region: 'Global', url: 'https://wise.com', submitted: false },
  { name: 'Sendwave', rate: 1338, fee: 'No fee', notes: 'Fast delivery, mobile-first, strong in West & East Africa', region: 'Africa', url: 'https://www.sendwave.com', submitted: false },
  { name: 'WorldRemit', rate: 1332, fee: 'Varies by corridor', notes: 'Covers 130+ countries including Cameroon, Bangladesh, Pakistan', region: 'Global', url: 'https://www.worldremit.com', submitted: false },
  { name: 'MoneyGram', rate: 1310, fee: 'Cash pickup fee applies', notes: 'One of the largest physical agent networks worldwide', region: 'Global', url: 'https://www.moneygram.com', submitted: false },
  { name: 'Western Union', rate: 1305, fee: 'Fee varies by method', notes: 'Extensive cash pickup coverage across Africa and Asia', region: 'Global', url: 'https://www.westernunion.com', submitted: false },
  { name: 'Remitly', rate: 1336, fee: 'Fee varies by speed', notes: 'Popular for South Asia (Pakistan, Bangladesh) corridors', region: 'Pakistan', url: 'https://www.remitly.com', submitted: false },
  { name: 'Xoom (PayPal)', rate: 1328, fee: 'Small fixed fee', notes: 'Fast digital transfers, strong presence in South Asia', region: 'Bangladesh', url: 'https://www.xoom.com', submitted: false },
  { name: 'Taptap Send', rate: 1342, fee: 'Low fixed fee', notes: 'Focused corridors into Cameroon, Ghana, and Bangladesh', region: 'Cameroon', url: 'https://www.taptapsend.com', submitted: false },
  { name: 'Ria Money Transfer', rate: 1315, fee: 'Varies by destination', notes: 'Large pickup network across Algeria and Morocco', region: 'Morocco', url: 'https://www.riamoneytransfer.com', submitted: false },
  { name: 'Small World', rate: 1320, fee: 'Varies by corridor', notes: 'Specializes in remittances to Algeria, Morocco, and South Asia', region: 'Algeria', url: 'https://www.smallworldfs.com', submitted: false }
];

const CORE = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CNY'];
const ASIA_EXTRA = ['JPY', 'INR', 'KRW', 'SGD', 'AED', 'BDT', 'PKR', 'TRY'];
const AFRICA_EXTRA = ['GHS', 'KES', 'ZAR', 'EGP', 'XAF', 'DZD', 'MAD'];
const TRACKED = [...CORE, ...ASIA_EXTRA, ...AFRICA_EXTRA, 'NGN'];

let liveCurrencies = { updated: null };

async function fetchLiveRates() {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD');
    const data = await res.json();
    if (data.rates) {
      const snapshot = { updated: new Date().toISOString() };
      TRACKED.forEach(code => {
        if (data.rates[code] !== undefined) snapshot[code] = data.rates[code];
      });
      liveCurrencies = snapshot;

      const today = new Date().toISOString().split('T')[0];
      const todayEntry = rates.find(r => r.date === today);
      if (todayEntry) {
        todayEntry.official = data.rates.NGN;
      } else {
        const lastParallel = rates[rates.length - 1].parallel;
        rates.push({ date: today, official: data.rates.NGN, parallel: lastParallel });
      }
      console.log(`Updated live rates: 1 USD = ${data.rates.NGN} NGN`);
    }
  } catch (err) {
    console.log('Could not fetch live rates, keeping last known values:', err.message);
  }
}
fetchLiveRates();
setInterval(fetchLiveRates, 30 * 60 * 1000);

app.get('/api/rates', (req, res) => res.json(rates));
app.get('/api/currencies', (req, res) => res.json(liveCurrencies));
app.get('/api/providers', (req, res) => res.json(providers));

app.post('/api/providers', (req, res) => {
  const { name, rate, fee, notes, region, url } = req.body;
  if (!name || !rate) return res.status(400).json({ error: 'Name and rate are required' });
  const cleanUrl = /^https?:\/\/[^\s<>"']{3,200}$/i.test(String(url || '').trim()) ? String(url).trim() : '';
  const newEntry = {
    name: name.trim(),
    rate: Number(rate),
    fee: fee ? fee.trim() : 'Not specified',
    notes: notes ? notes.trim() : 'User submitted',
    region: region ? region.trim() : 'Global',
    url: cleanUrl,
    submitted: true
  };
  providers.push(newEntry);
  res.status(201).json(newEntry);
});

// --- Accounts ---
app.post('/api/register', async (req, res) => {
  const { name, email, phone, password } = req.body;
  if (!name || !email || !phone || !password) {
    return res.status(400).json({ error: 'Name, email, phone, and password are required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  if (db.users.find(u => u.email.toLowerCase() === email.trim().toLowerCase())) {
    return res.status(409).json({ error: 'An account with that email already exists' });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const user = {
    id: Date.now().toString(),
    name: name.trim(),
    email: email.trim().toLowerCase(),
    phone: phone.trim(),
    passwordHash,
    createdAt: new Date().toISOString()
  };
  db.users.push(user);
  saveDB();
  sendWelcomeEmail(user);

  const token = crypto.randomBytes(24).toString('hex');
  startSession(token, user.id);
  logEvent('register', user.email, user);
  saveDB();
  res.status(201).json({ token, user: publicUser(user) });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const user = db.users.find(u => u.email.toLowerCase() === (email || '').trim().toLowerCase());
  if (!user) { logEvent('login_failed', 'unknown email: ' + String(email || '').slice(0, 60)); return res.status(401).json({ error: 'Invalid email or password' }); }
  const match = await bcrypt.compare(password || '', user.passwordHash);
  if (!match) { logEvent('login_failed', 'wrong password: ' + user.email, user); return res.status(401).json({ error: 'Invalid email or password' }); }

  const token = crypto.randomBytes(24).toString('hex');
  startSession(token, user.id);
  logEvent('login', user.email, user);
  saveDB();
  res.json({ token, user: publicUser(user) });
});

// --- Forgotten password: emailed one-time link (valid 1 hour) ---
const RESET_MINUTES = 60;
const resetAttempts = {}; // simple in-memory rate limit: key -> [timestamps]
function tooMany(key, max, windowMs) {
  const now = Date.now();
  const list = (resetAttempts[key] || []).filter(t => now - t < windowMs);
  list.push(now);
  resetAttempts[key] = list;
  return list.length > max;
}
function hashToken(t) { return crypto.createHash('sha256').update(String(t)).digest('hex'); }
function siteBase(req) {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/+$/, '');
  const host = String(req.headers.host || '');
  if (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return 'http://' + host;
  return 'https://www.globalrate.space';
}
function issueResetToken(user) {
  const token = crypto.randomBytes(32).toString('hex');
  user.resetTokenHash = hashToken(token);
  user.resetExpires = Date.now() + RESET_MINUTES * 60 * 1000;
  saveDB();
  return token;
}
async function sendResetEmail(user, link) {
  if (!mailer) { console.log('Password reset requested but email is not configured. Link for', user.email, ':', link); return; }
  try {
    await mailer.sendMail({
      from: `"GlobalRate" <${mailFromAddress}>`,
      to: user.email,
      subject: 'Reset your GlobalRate password',
      text: `Hi ${user.name},\n\nSomeone (hopefully you) asked to reset your GlobalRate password. Open this link within ${RESET_MINUTES} minutes to choose a new one:\n\n${link}\n\nIf you did not ask for this, you can ignore this email — your password stays the same.\n\n— The GlobalRate team`,
      html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#1e293b">
        <h2 style="color:#6d28d9">Reset your password</h2>
        <p>Hi ${String(user.name).replace(/[<>&]/g, '')},</p>
        <p>Someone (hopefully you) asked to reset your GlobalRate password. The button below works for ${RESET_MINUTES} minutes.</p>
        <p style="margin:24px 0"><a href="${link}" style="background:#7c3aed;color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:bold">Choose a new password</a></p>
        <p style="font-size:13px;color:#64748b">Or paste this link into your browser:<br>${link}</p>
        <p style="font-size:13px;color:#64748b">If you did not ask for this, ignore this email — your password stays the same.</p></div>`
    });
    console.log('Password reset email sent to', user.email);
  } catch (err) {
    console.log('Could not send reset email:', err.message);
  }
}

app.post('/api/forgot-password', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const generic = { ok: true, message: 'If an account exists for that email, a reset link is on its way. Check your inbox and spam folder.' };
  if (!email) return res.status(400).json({ error: 'Please enter your email' });
  if (tooMany('ip:' + req.ip, 20, 3600000) || tooMany('em:' + email, 5, 3600000)) {
    return res.status(429).json({ error: 'Too many requests. Please try again in a little while.' });
  }
  const user = db.users.find(u => u.email.toLowerCase() === email);
  logEvent('password_reset_requested', user ? email : 'unknown email', user || null);
  if (user) {
    const token = issueResetToken(user);
    sendResetEmail(user, siteBase(req) + '/?reset=' + token);
  }
  res.json(generic);
});

app.post('/api/reset-password', async (req, res) => {
  const { token, password } = req.body || {};
  if (tooMany('rp:' + req.ip, 30, 3600000)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  if (!token || !password) return res.status(400).json({ error: 'Link and new password are required' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const h = hashToken(token);
  const user = db.users.find(u => u.resetTokenHash && u.resetTokenHash === h && u.resetExpires > Date.now());
  if (!user) return res.status(400).json({ error: 'This reset link has expired or was already used. Please request a new one.' });
  user.passwordHash = await bcrypt.hash(String(password), 10);
  delete user.resetTokenHash; delete user.resetExpires;
  Object.keys(sessions).forEach(t => { if (sessions[t] === user.id) endSession(t); });
  const session = crypto.randomBytes(24).toString('hex');
  startSession(session, user.id);
  logEvent('password_reset_done', user.email, user);
  saveDB();
  res.json({ token: session, user: publicUser(user) });
});

app.get('/api/me', authMiddleware, (req, res) => {
  res.json(publicUser(req.user, req));
});

app.post('/api/logout', authMiddleware, (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  endSession(token);
  res.status(204).end();
});

// --- Local currency marketplace (posting requires login; browsing is open) ---
// Hide lister phone numbers until the viewer is signed in
const maskPhones = (list, req) => {
  if (liveSession(tokenOf(req))) return list;
  return list.map(x => ({ ...x, phone: '', phoneHidden: !!x.phone }));
};
app.get('/api/marketplace', (req, res) => res.json(maskPhones(db.marketplace, req)));

app.post('/api/marketplace', authMiddleware, (req, res) => {
  const { haveCurrency, haveAmount, wantCurrency, location, notes } = req.body;
  if (!haveCurrency || !haveAmount || !wantCurrency || !location) {
    return res.status(400).json({ error: 'Currencies, amount, and location are required' });
  }
  const listing = {
    id: Date.now().toString(),
    ownerId: req.user.id,
    posterName: req.user.name,
    phone: req.user.phone,
    haveCurrency: haveCurrency.trim().toUpperCase(),
    haveAmount: Number(haveAmount),
    wantCurrency: wantCurrency.trim().toUpperCase(),
    location: location.trim(),
    notes: notes ? notes.trim() : '',
    status: 'available',
    postedAt: new Date().toISOString()
  };
  db.marketplace.unshift(listing);
  logEvent('marketplace_posted', `${listing.haveAmount} ${listing.haveCurrency} → ${listing.wantCurrency} (${listing.location})`, req.user);
  saveDB();
  res.status(201).json(listing);
});

app.patch('/api/marketplace/:id', authMiddleware, (req, res) => {
  const listing = db.marketplace.find(l => l.id === req.params.id);
  if (!listing) return res.status(404).json({ error: 'Listing not found' });
  if (listing.ownerId !== req.user.id) return res.status(403).json({ error: 'You can only update your own listings' });
  const { status } = req.body;
  if (!['available', 'taken', 'sold'].includes(status)) {
    return res.status(400).json({ error: 'Status must be available, taken, or sold' });
  }
  listing.status = status;
  saveDB();
  res.json(listing);
});

app.delete('/api/marketplace/:id', authMiddleware, (req, res) => {
  const idx = db.marketplace.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Listing not found' });
  if (db.marketplace[idx].ownerId !== req.user.id && !isAdminReq(req)) return res.status(403).json({ error: 'You can only remove your own listings' });
  logEvent('marketplace_deleted', db.marketplace[idx].title || db.marketplace[idx].description || db.marketplace[idx].haveCurrency || '', req.user);
  db.marketplace.splice(idx, 1);
  saveDB();
  res.status(204).end();
});

// --- Vehicle & bike rentals marketplace (same pattern as currency marketplace) ---
app.get('/api/rentals', (req, res) => res.json(maskPhones(db.rentals, req)));

app.post('/api/rentals', authMiddleware, (req, res) => {
  const { vehicleType, description, pricePerDay, location, notes } = req.body;
  if (!vehicleType || !description || !pricePerDay || !location) {
    return res.status(400).json({ error: 'Vehicle type, description, price, and location are required' });
  }
  const listing = {
    id: Date.now().toString(),
    ownerId: req.user.id,
    posterName: req.user.name,
    phone: req.user.phone,
    vehicleType: vehicleType.trim(),
    description: description.trim(),
    pricePerDay: Number(pricePerDay),
    location: location.trim(),
    notes: notes ? notes.trim() : '',
    status: 'available',
    postedAt: new Date().toISOString()
  };
  db.rentals.unshift(listing);
  logEvent('rentals_posted', `${listing.vehicleType}: ${listing.description} (${listing.location})`, req.user);
  saveDB();
  res.status(201).json(listing);
});

app.patch('/api/rentals/:id', authMiddleware, (req, res) => {
  const listing = db.rentals.find(l => l.id === req.params.id);
  if (!listing) return res.status(404).json({ error: 'Listing not found' });
  if (listing.ownerId !== req.user.id) return res.status(403).json({ error: 'You can only update your own listings' });
  const { status } = req.body;
  if (!['available', 'rented'].includes(status)) {
    return res.status(400).json({ error: 'Status must be available or rented' });
  }
  listing.status = status;
  saveDB();
  res.json(listing);
});

app.delete('/api/rentals/:id', authMiddleware, (req, res) => {
  const idx = db.rentals.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Listing not found' });
  if (db.rentals[idx].ownerId !== req.user.id && !isAdminReq(req)) return res.status(403).json({ error: 'You can only remove your own listings' });
  logEvent('rentals_deleted', db.rentals[idx].title || db.rentals[idx].description || db.rentals[idx].haveCurrency || '', req.user);
  db.rentals.splice(idx, 1);
  saveDB();
  res.status(204).end();
});

// --- Items & gadgets for sale (with photos) ---
const ITEM_CATEGORIES = ['Phones & tablets', 'Laptops & computers', 'Gaming & consoles', 'Audio & headphones', 'Cameras', 'TVs & appliances', 'Furniture & home', 'Clothing & shoes', 'Books & study', 'Sports & bikes', 'Other'];
const MAX_PHOTOS = 4;

function savePhoto(dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 2 * 1024 * 1024) return null;
  const name = crypto.randomBytes(12).toString('hex') + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
  fs.writeFileSync(path.join(UPLOADS_DIR, name), buf);
  return '/uploads/' + name;
}

function saveItemPhotos(photos) {
  const urls = [];
  for (const dataUrl of (Array.isArray(photos) ? photos : []).slice(0, MAX_PHOTOS)) {
    const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
    if (!m) continue;
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 2 * 1024 * 1024) continue; // 2 MB max per photo (browser already shrinks them)
    const name = crypto.randomBytes(12).toString('hex') + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
    fs.writeFileSync(path.join(UPLOADS_DIR, name), buf);
    urls.push('/uploads/' + name);
  }
  return urls;
}
function deletePhotoFiles(urls) {
  (urls || []).forEach(u => {
    const file = path.join(UPLOADS_DIR, path.basename(u));
    fs.unlink(file, () => {});
  });
}

app.get('/api/items', (req, res) => res.json(maskPhones(db.items, req)));

app.post('/api/items', authMiddleware, (req, res) => {
  const { title, category, price, condition, location, description, photos } = req.body;
  if (!title || !price || !location) {
    return res.status(400).json({ error: 'Title, price and location are required' });
  }
  if (!(Number(price) >= 0)) return res.status(400).json({ error: 'Price must be a number' });
  const listing = {
    id: Date.now().toString(),
    ownerId: req.user.id,
    posterName: req.user.name,
    phone: req.user.phone,
    title: String(title).trim().slice(0, 100),
    category: ITEM_CATEGORIES.includes(category) ? category : 'Other',
    price: Number(price),
    condition: ['New', 'Like new', 'Good', 'Used'].includes(condition) ? condition : 'Used',
    location: String(location).trim().slice(0, 100),
    description: description ? String(description).trim().slice(0, 600) : '',
    photos: saveItemPhotos(photos),
    status: 'available',
    postedAt: new Date().toISOString()
  };
  db.items.unshift(listing);
  logEvent('items_posted', `${listing.title} — €${listing.price} (${listing.photos.length} photos)`, req.user);
  saveDB();
  res.status(201).json(listing);
});

app.patch('/api/items/:id', authMiddleware, (req, res) => {
  const listing = db.items.find(l => l.id === req.params.id);
  if (!listing) return res.status(404).json({ error: 'Listing not found' });
  if (listing.ownerId !== req.user.id) return res.status(403).json({ error: 'You can only update your own listings' });
  if (!['available', 'sold'].includes(req.body.status)) {
    return res.status(400).json({ error: 'Status must be available or sold' });
  }
  listing.status = req.body.status;
  saveDB();
  res.json(listing);
});

app.delete('/api/items/:id', authMiddleware, (req, res) => {
  const idx = db.items.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Listing not found' });
  if (db.items[idx].ownerId !== req.user.id && !isAdminReq(req)) return res.status(403).json({ error: 'You can only remove your own listings' });
  logEvent('items_deleted', db.items[idx].title || db.items[idx].description || db.items[idx].haveCurrency || '', req.user);
  deletePhotoFiles(db.items[idx].photos);
  db.items.splice(idx, 1);
  saveDB();
  res.status(204).end();
});


// --- Rooms to let / flat-sharing (with labelled photo slots) ---
const ROOM_TYPES = ['Room in shared apartment', 'Private room', 'Studio', 'Whole apartment', 'Bed in dorm'];
const ROOM_PHOTO_SLOTS = ['Cover photo', 'Bedroom', 'Kitchen', 'Bathroom', 'Living area'];
const ROOM_AMENITIES = ['WiFi', 'Washing machine', 'Dishwasher', 'Heating', 'Air conditioning', 'Balcony', 'Elevator', 'Parking', 'Desk / study space', 'Near public transport'];
const ROOM_RULES = ['Students welcome', 'Couples OK', 'Pets OK', 'Smoking OK'];
const ROOM_GENDER = ['Anyone', 'Female only', 'Male only'];
const ROOM_BILLS = ['Not included', 'Included', 'Partly included'];

function roomForViewer(room, signedIn) {
  const out = { ...room };
  if (!signedIn) { out.address = ''; out.addressHidden = !!room.address; out.phone = ''; out.phoneHidden = !!room.phone; }
  return out;
}

app.get('/api/rooms', (req, res) => {
  const signedIn = !!liveSession(tokenOf(req));
  res.json(db.rooms.map(r => roomForViewer(r, signedIn)));
});

app.post('/api/rooms', authMiddleware, (req, res) => {
  const b = req.body || {};
  const clean = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  const title = clean(b.title, 100), city = clean(b.city, 60), area = clean(b.area || b.location, 80), address = clean(b.address, 140);
  if (!title || !b.price || !city || !address) {
    return res.status(400).json({ error: 'Title, monthly rent, city and street address are required' });
  }
  if (!(Number(b.price) >= 0)) return res.status(400).json({ error: 'Rent must be a number' });
  const num = (v, max) => (v !== undefined && v !== null && v !== '' && Number(v) >= 0) ? Math.min(Number(v), max) : null;
  const slots = (Array.isArray(b.photoSlots) ? b.photoSlots : []).slice(0, ROOM_PHOTO_SLOTS.length);
  const photos = [], photoLabels = [];
  for (const sl of slots) {
    const url = savePhoto(sl && sl.data);
    if (!url) continue;
    photos.push(url);
    photoLabels.push(ROOM_PHOTO_SLOTS.includes(sl.label) ? sl.label : 'Photo');
  }
  const pick = (list, v, d) => list.includes(v) ? v : d;
  const listing = {
    id: Date.now().toString(),
    ownerId: req.user.id,
    posterName: req.user.name,
    phone: req.user.phone,
    title,
    roomType: pick(ROOM_TYPES, b.roomType, ROOM_TYPES[0]),
    price: Number(b.price),
    deposit: num(b.deposit, 100000),
    bills: pick(ROOM_BILLS, b.bills, 'Not included'),
    availableFrom: b.availableFrom ? String(b.availableFrom).slice(0, 10) : '',
    minStay: num(b.minStay, 60),
    city, area, address,
    roomSize: num(b.roomSize, 500),
    furnished: b.furnished === false || b.furnished === 'no' ? false : true,
    flatmates: num(b.flatmates, 12),
    genderPref: pick(ROOM_GENDER, b.genderPref, 'Anyone'),
    amenities: (Array.isArray(b.amenities) ? b.amenities : []).filter(x => ROOM_AMENITIES.includes(x)),
    rules: (Array.isArray(b.rules) ? b.rules : []).filter(x => ROOM_RULES.includes(x)),
    description: clean(b.description, 1000),
    photos, photoLabels,
    status: 'available',
    postedAt: new Date().toISOString()
  };
  db.rooms.unshift(listing);
  logEvent('rooms_posted', `${listing.title} — €${listing.price}/month, ${listing.city} (${listing.photos.length} photos)`, req.user);
  saveDB();
  res.status(201).json(listing);
});

app.patch('/api/rooms/:id', authMiddleware, (req, res) => {
  const listing = db.rooms.find(l => l.id === req.params.id);
  if (!listing) return res.status(404).json({ error: 'Listing not found' });
  if (listing.ownerId !== req.user.id) return res.status(403).json({ error: 'You can only update your own listings' });
  if (!['available', 'rented'].includes(req.body.status)) {
    return res.status(400).json({ error: 'Status must be available or rented' });
  }
  listing.status = req.body.status;
  saveDB();
  res.json(listing);
});

app.delete('/api/rooms/:id', authMiddleware, (req, res) => {
  const idx = db.rooms.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Listing not found' });
  if (db.rooms[idx].ownerId !== req.user.id && !isAdminReq(req)) return res.status(403).json({ error: 'You can only remove your own listings' });
  logEvent('rooms_deleted', db.rooms[idx].title || '', req.user);
  deletePhotoFiles(db.rooms[idx].photos);
  db.rooms.splice(idx, 1);
  saveDB();
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Admin API (all routes need a logged-in admin who has entered ADMIN_KEY)
// ---------------------------------------------------------------------------
const LISTING_TYPES = { currency: 'marketplace', rental: 'rentals', item: 'items', room: 'rooms' };

app.post('/api/admin/unlock', authMiddleware, (req, res) => {
  if (!canAdmin(req.user) || !ADMIN_KEY) {
    return res.status(403).json({ error: 'This account is not an admin (check ADMIN_EMAILS and ADMIN_KEY on the server).' });
  }
  const f = adminFailures[req.user.id] || { count: 0, until: 0 };
  if (f.until > Date.now()) return res.status(429).json({ error: 'Too many wrong attempts. Try again in a few minutes.' });
  const given = Buffer.from(String(req.body.key || ''));
  const real = Buffer.from(ADMIN_KEY);
  const ok = given.length === real.length && crypto.timingSafeEqual(given, real);
  if (!ok) {
    f.count += 1;
    if (f.count >= 5) { f.until = Date.now() + 15 * 60 * 1000; f.count = 0; }
    adminFailures[req.user.id] = f;
    logEvent('admin_unlock_failed', req.user.email, req.user);
    return res.status(401).json({ error: 'Wrong admin key' });
  }
  delete adminFailures[req.user.id];
  adminTokens.add(tokenOf(req)); adminSeen[tokenOf(req)] = Date.now();
  logEvent('admin_unlocked', req.user.email, req.user);
  saveDB();
  res.json({ ok: true });
});

app.get('/api/admin/overview', adminMiddleware, (req, res) => {
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    days.push({
      day: d,
      signups: db.users.filter(u => (u.createdAt || '').slice(0, 10) === d).length,
      visits: db.stats.visits[d] || 0
    });
  }
  const count = (arr, st) => arr.filter(l => l.status === st).length;
  let uploadFiles = 0;
  try { uploadFiles = fs.readdirSync(UPLOADS_DIR).length; } catch (e) {}
  let dbBytes = 0;
  try { dbBytes = fs.statSync(DB_PATH).size; } catch (e) {}
  res.json({
    totals: {
      users: db.users.length,
      currencyListings: db.marketplace.length,
      rentalListings: db.rentals.length,
      itemListings: db.items.length,
      roomListings: db.rooms.length,
      messages: db.messages.length,
      photos: uploadFiles,
      activeSessions: Object.keys(sessions).length
    },
    status: {
      currencyAvailable: count(db.marketplace, 'available'),
      rentalsAvailable: count(db.rentals, 'available'),
      itemsAvailable: count(db.items, 'available'),
      itemsSold: count(db.items, 'sold'),
      roomsAvailable: count(db.rooms, 'available'),
      roomsRented: count(db.rooms, 'rented')
    },
    days,
    server: {
      uptimeMinutes: Math.round((Date.now() - startedAt) / 60000),
      startedAt: new Date(startedAt).toISOString(),
      emailConfigured: !!mailer,
      databasePath: DB_PATH,
      databaseKB: Math.round(dbBytes / 1024),
      uploadsPath: UPLOADS_DIR,
      node: process.version,
      persistentStorageHint: DB_PATH.startsWith('/var/data') || !!process.env.DB_PATH
    },
    activity: db.activity.slice(0, 150)
  });
});

app.get('/api/admin/users', adminMiddleware, (req, res) => {
  res.json(db.users.map(u => ({
    id: u.id, name: u.name, email: u.email, phone: u.phone, createdAt: u.createdAt,
    isAdmin: ADMIN_EMAILS.includes(u.email.toLowerCase()),
    listings: db.marketplace.filter(l => l.ownerId === u.id).length +
              db.rentals.filter(l => l.ownerId === u.id).length +
              db.items.filter(l => l.ownerId === u.id).length +
              db.rooms.filter(l => l.ownerId === u.id).length
  })));
});

app.delete('/api/admin/users/:id', adminMiddleware, (req, res) => {
  const user = db.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (ADMIN_EMAILS.includes(user.email.toLowerCase())) return res.status(400).json({ error: 'Admin accounts cannot be deleted here' });
  db.items.filter(l => l.ownerId === user.id).forEach(l => deletePhotoFiles(l.photos));
  db.rooms.filter(l => l.ownerId === user.id).forEach(l => deletePhotoFiles(l.photos));
  db.marketplace = db.marketplace.filter(l => l.ownerId !== user.id);
  db.rentals = db.rentals.filter(l => l.ownerId !== user.id);
  db.items = db.items.filter(l => l.ownerId !== user.id);
  db.rooms = db.rooms.filter(l => l.ownerId !== user.id);
  db.messages = db.messages.filter(m => m.fromUserId !== user.id && m.toUserId !== user.id);
  db.users = db.users.filter(u => u.id !== user.id);
  Object.keys(sessions).forEach(t => { if (sessions[t] === user.id) endSession(t); });
  logEvent('user_deleted_by_admin', user.email, req.user);
  saveDB();
  res.status(204).end();
});

app.post('/api/admin/users/:id/reset-link', adminMiddleware, (req, res) => {
  const user = db.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const token = issueResetToken(user);
  logEvent('reset_link_by_admin', user.email, req.user);
  res.json({ link: siteBase(req) + '/?reset=' + token, expiresMinutes: RESET_MINUTES });
});

app.get('/api/admin/listings', adminMiddleware, (req, res) => {
  const tag = (arr, type) => arr.map(l => ({ ...l, type }));
  const all = [...tag(db.marketplace, 'currency'), ...tag(db.rentals, 'rental'), ...tag(db.items, 'item'), ...tag(db.rooms, 'room')]
    .sort((a, b) => new Date(b.postedAt) - new Date(a.postedAt));
  res.json(all);
});

app.delete('/api/admin/listings/:type/:id', adminMiddleware, (req, res) => {
  const coll = LISTING_TYPES[req.params.type];
  if (!coll) return res.status(400).json({ error: 'Unknown listing type' });
  const idx = db[coll].findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Listing not found' });
  const l = db[coll][idx];
  deletePhotoFiles(l.photos);
  db[coll].splice(idx, 1);
  logEvent('listing_removed_by_admin', `${req.params.type}: ${l.title || l.description || l.haveCurrency || l.id} (by ${l.posterName})`, req.user);
  saveDB();
  res.status(204).end();
});

// Backup: download everything (database + photos) as one JSON file
app.get('/api/admin/export', adminMiddleware, (req, res) => {
  const photos = {};
  try {
    fs.readdirSync(UPLOADS_DIR).forEach(f => {
      const ext = path.extname(f).slice(1).replace('jpg', 'jpeg');
      photos[f] = `data:image/${ext};base64,` + fs.readFileSync(path.join(UPLOADS_DIR, f)).toString('base64');
    });
  } catch (e) {}
  logEvent('backup_downloaded', '', req.user);
  saveDB();
  res.setHeader('Content-Disposition', `attachment; filename="globalrate-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({ format: 'globalrate-backup-v1', exportedAt: new Date().toISOString(), db, photos });
});

// Restore: upload a backup file to bring everything back after a reset
app.post('/api/admin/import', adminMiddleware, (req, res) => {
  const b = req.body;
  if (!b || b.format !== 'globalrate-backup-v1' || !b.db || !Array.isArray(b.db.users)) {
    return res.status(400).json({ error: 'That is not a GlobalRate backup file' });
  }
  const keepUser = req.user;
  db = {
    users: b.db.users, marketplace: b.db.marketplace || [], rentals: b.db.rentals || [],
    items: b.db.items || [], rooms: b.db.rooms || [], messages: b.db.messages || [], activity: b.db.activity || [],
    stats: b.db.stats || { visits: {} }
  };
  db.stats.visits = db.stats.visits || {};
  let restoredPhotos = 0;
  Object.entries(b.photos || {}).forEach(([name, dataUrl]) => {
    if (!/^[a-f0-9]{24}\.(jpg|png|webp)$/.test(name)) return;
    const m = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
    if (!m) return;
    fs.writeFileSync(path.join(UPLOADS_DIR, name), Buffer.from(m[1], 'base64'));
    restoredPhotos++;
  });
  // keep the admin logged in if their account exists in the restored data
  const same = db.users.find(u => u.email.toLowerCase() === keepUser.email.toLowerCase());
  const token = tokenOf(req);
  if (same) startSession(token, same.id); else endSession(token);
  logEvent('backup_restored', `${db.users.length} users, ${restoredPhotos} photos`, same || null);
  saveDB();
  res.json({ ok: true, users: db.users.length, photos: restoredPhotos });
});

// --- Direct messaging between logged-in users, tied to a specific listing ---
app.post('/api/messages', authMiddleware, (req, res) => {
  const { listingType, listingId, listingSummary, toUserId, text } = req.body;
  if (!listingType || !listingId || !toUserId || !text) {
    return res.status(400).json({ error: 'listingType, listingId, toUserId, and text are required' });
  }
  if (!['currency', 'rental', 'item', 'room'].includes(listingType)) {
    return res.status(400).json({ error: 'listingType must be currency, rental, item or room' });
  }
  const toUser = db.users.find(u => u.id === toUserId);
  if (!toUser) return res.status(404).json({ error: 'Recipient not found' });

  const message = {
    id: Date.now().toString() + Math.random().toString(36).slice(2, 7),
    listingType,
    listingId,
    listingSummary: listingSummary || '',
    fromUserId: req.user.id,
    fromName: req.user.name,
    toUserId: toUser.id,
    toName: toUser.name,
    text: text.trim(),
    read: false,
    sentAt: new Date().toISOString()
  };
  db.messages.push(message);
  logEvent('message', `${listingType}: ${req.user.name} → ${toUser.name}`, req.user);
  saveDB();
  res.status(201).json(message);
});

// Get the message thread for one listing between the current user and one other user
app.get('/api/messages/thread', authMiddleware, (req, res) => {
  const { listingType, listingId, otherUserId } = req.query;
  if (!listingType || !listingId || !otherUserId) {
    return res.status(400).json({ error: 'listingType, listingId, and otherUserId are required' });
  }
  const thread = db.messages
    .filter(m => m.listingType === listingType && m.listingId === listingId &&
      ((m.fromUserId === req.user.id && m.toUserId === otherUserId) ||
       (m.fromUserId === otherUserId && m.toUserId === req.user.id)))
    .sort((a, b) => new Date(a.sentAt) - new Date(b.sentAt));
  // opening the thread marks the other person's messages to me as read
  let changed = false;
  thread.forEach(m => { if (m.toUserId === req.user.id && m.read === false) { m.read = true; changed = true; } });
  if (changed) saveDB();
  res.json(thread);
});

// Public numbers for the hero section (available listings per category)
app.get('/api/stats', (req, res) => {
  const avail = arr => arr.filter(l => (l.status || 'available') === 'available').length;
  res.json({
    exchange: avail(db.marketplace), rentals: avail(db.rentals), items: avail(db.items), rooms: avail(db.rooms),
    members: db.users.length
  });
});

// The signed-in user's message numbers (unread = messages sent to me that I have not opened yet)
app.get('/api/my-summary', authMiddleware, (req, res) => {
  const mine = db.messages.filter(m => m.fromUserId === req.user.id || m.toUserId === req.user.id);
  const convos = new Set(mine.map(m => `${m.listingType}:${m.listingId}:${m.fromUserId === req.user.id ? m.toUserId : m.fromUserId}`));
  res.json({
    unread: db.messages.filter(m => m.toUserId === req.user.id && m.read === false).length,
    conversations: convos.size
  });
});

// List all conversations the current user is part of, most recent first
app.get('/api/conversations', authMiddleware, (req, res) => {
  const mine = db.messages.filter(m => m.fromUserId === req.user.id || m.toUserId === req.user.id);
  const map = new Map();
  mine.forEach(m => {
    const otherId = m.fromUserId === req.user.id ? m.toUserId : m.fromUserId;
    const otherName = m.fromUserId === req.user.id ? m.toName : m.fromName;
    const key = `${m.listingType}:${m.listingId}:${otherId}`;
    const existing = map.get(key);
    if (!existing || new Date(m.sentAt) > new Date(existing.lastSentAt)) {
      map.set(key, {
        listingType: m.listingType,
        listingId: m.listingId,
        listingSummary: m.listingSummary,
        otherUserId: otherId,
        otherName,
        lastText: m.text,
        lastSentAt: m.sentAt
      });
    }
  });
  const conversations = Array.from(map.values()).sort((a, b) => new Date(b.lastSentAt) - new Date(a.lastSentAt));
  res.json(conversations);
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Database file: ${DB_PATH}`);
});
