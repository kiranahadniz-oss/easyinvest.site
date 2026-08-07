const express = require('express');
const path = require('path');
const bcrypt = require('bcrypt');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const multer = require('multer');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = path.join(__dirname, 'data', 'easyinvest.db');
if (!fs.existsSync(path.join(__dirname, 'data'))) fs.mkdirSync(path.join(__dirname, 'data'));
const db = new sqlite3.Database(DB_PATH);

// Initialize DB if needed
const initSql = fs.readFileSync(path.join(__dirname, 'db', 'init.sql'), 'utf8');
db.exec(initSql, (err) => {
  if (err) console.error('DB init error (may already be initialized):', err.message);
  else console.log('DB initialized');
});

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/public', express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new SQLiteStore({ db: 'sessions.sqlite' }),
  secret: process.env.SESSION_SECRET || 'easyinvest-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 }
}));

// Multer for slip uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const d = path.join(__dirname, 'public', 'uploads');
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    cb(null, d);
  },
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// Packages list
const PACKAGES = [500,2000,5000,8000,14000,25000,38000,75000,135000,300000];

// Helpers
function query(sql, params=[]) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
  });
}
function run(sql, params=[]) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err){
      if (err) reject(err); else resolve(this);
    });
  });
}

function requireAuth(req, res, next){
  if (!req.session.user) return res.redirect('/');
  next();
}
function requireAdmin(req, res, next){
  if (!req.session.user) return res.redirect('/');
  if (!req.session.user.is_admin) return res.status(403).send('Forbidden');
  next();
}

// Seed default admin if not exists
(async function seedAdmin(){
  try{
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@example.com';
    const adminPass = process.env.ADMIN_PASS || 'TempPass123';
    const rows = await query('SELECT * FROM users WHERE email = ?', [adminEmail]);
    if (!rows.length) {
      const hashed = await bcrypt.hash(adminPass, 10);
      const ref_code = uuidv4().slice(0,8);
      const now = Date.now();
      await run('INSERT INTO users (fullname, username, email, phone, password, wallet, ref_code, parent_ref, is_admin, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', ['Admin User', 'admin', adminEmail, '', hashed, 0, ref_code, null, 1, now]);
      console.log('Seeded admin user:', adminEmail);
    } else {
      // ensure is_admin flag
      await run('UPDATE users SET is_admin = 1 WHERE email = ?', [adminEmail]);
    }
  } catch (e){ console.error('Admin seed error', e); }
})();

// Payout processor function (used by cron and by external trigger)
async function processPayouts(){
  console.log('Processing payouts...');
  const subs = await query('SELECT s.*, u.id as uid FROM subscriptions s JOIN users u ON s.user_id = u.id WHERE s.active = 1');
  const now = Date.now();
  for (const s of subs) {
    const last = s.last_payout_at || s.started_at;
    if (now - last >= 24*60*60*1000) {
      // payout random between 0.2666% and 0.40%
      const pct = 0.002666 + Math.random() * (0.0040 - 0.002666);
      const amount = Math.round(s.price * pct);
      await run('UPDATE users SET wallet = wallet + ? WHERE id = ?', [amount, s.user_id]);
      await run('UPDATE subscriptions SET last_payout_at = ? WHERE id = ?', [now, s.id]);
      await run('INSERT INTO transactions (user_id, type, amount, note, created_at) VALUES (?,?,?,?,?)', [s.user_id, 'earning', amount, 'Daily ROI', now]);
      console.log('Payout for subscription', s.id, 'amount', amount);
    }
  }
}

// Routes
app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login', { error: null });
});

// Signup: allow referral via query param ?ref=CODE
app.get('/signup', (req, res) => {
  res.render('signup', { error: null, ref: req.query.ref || '' });
});

// Referral redirect route: /refer/:code -> /signup?ref=code
app.get('/refer/:code', (req, res) => {
  const code = req.params.code;
  if (!code) return res.redirect('/signup');
  res.redirect('/signup?ref=' + encodeURIComponent(code));
});

app.post('/signup', async (req, res) => {
  const { fullname, username, email, phone, password, password2, ref } = req.body;
  if (!fullname || !username || !email || !password || !password2) return res.render('signup', { error: 'Please fill required fields', ref: ref || '' });
  if (password !== password2) return res.render('signup', { error: 'Passwords do not match', ref: ref || '' });

  // check duplicates
  const dup = await query('SELECT id FROM users WHERE username = ? OR email = ? OR phone = ?', [username, email, phone]);
  if (dup.length) return res.render('signup', { error: 'Username, email or phone already registered', ref: ref || '' });

  const hashed = await bcrypt.hash(password, 10);
  const ref_code = uuidv4().slice(0,8);
  const parent_ref = ref || null;
  const now = Date.now();
  await run('INSERT INTO users (fullname, username, email, phone, password, wallet, ref_code, parent_ref, created_at) VALUES (?,?,?,?,?,?,?,?,?)', [fullname, username, email, phone, hashed, 0, ref_code, parent_ref, now]);
  const userRow = await query('SELECT * FROM users WHERE username = ?', [username]);
  req.session.user = userRow[0];
  res.redirect('/dashboard');
});

app.post('/login', async (req, res) => {
  const { login, password } = req.body; // login can be email/username/phone
  if (!login || !password) return res.render('login', { error: 'Please enter credentials' });
  const rows = await query('SELECT * FROM users WHERE username = ? OR email = ? OR phone = ?', [login, login, login]);
  if (!rows.length) return res.render('login', { error: 'Invalid credentials. Please try again or create an account.' });
  const user = rows[0];
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.render('login', { error: 'Invalid credentials. Please try again or create an account.' });
  req.session.user = user;
  res.redirect('/dashboard');
});

app.get('/logout', (req,res) => { req.session.destroy(()=>res.redirect('/')); });

app.get('/dashboard', requireAuth, async (req, res) => {
  const user = await query('SELECT * FROM users WHERE id = ?', [req.session.user.id]);
  const u = user[0];
  const subs = await query('SELECT s.*, p.price FROM subscriptions s LEFT JOIN packages p ON s.package_id = p.id WHERE s.user_id = ?', [u.id]);
  const deposits = await query('SELECT * FROM deposits WHERE user_id = ? ORDER BY created_at DESC', [u.id]);
  const withdraws = await query('SELECT * FROM withdraws WHERE user_id = ? ORDER BY created_at DESC', [u.id]);
  const referrals = await query('SELECT * FROM users WHERE parent_ref = ?', [u.ref_code]);
  res.render('dashboard', { user: u, subs, deposits, withdraws, referrals, packages: PACKAGES });
});

app.post('/forgot', async (req,res)=>{
  const { email } = req.body;
  if (!email) return res.json({ ok:false, msg:'Provide email' });
  const rows = await query('SELECT * FROM users WHERE email = ?', [email]);
  if (!rows.length) return res.json({ ok:false, msg:'Email not found' });
  res.json({ ok:true, msg:'If that email exists, a reset link has been sent (demo).' });
});

app.post('/deposit', requireAuth, upload.single('slip'), async (req, res) => {
  const { method, account, transaction_id, amount } = req.body;
  if (!method || !amount) return res.redirect('/dashboard');
  const slip = req.file ? '/public/uploads/' + req.file.filename : null;
  await run('INSERT INTO deposits (user_id, method, account, transaction_id, amount, slip, status, created_at) VALUES (?,?,?,?,?,?,?,?)', [req.session.user.id, method, account, transaction_id, amount, slip, 'pending', Date.now()]);
  res.redirect('/dashboard');
});

app.post('/withdraw', requireAuth, async (req,res)=>{
  const { amount, account } = req.body;
  const amt = Number(amount);
  const user = await query('SELECT * FROM users WHERE id = ?', [req.session.user.id]);
  if (amt < 1 || amt > 1000000) return res.render('dashboard', { error:'Withdraw amount must be between RS1 and RS1,000,000' });
  if (user[0].wallet < amt) return res.render('dashboard', { error:'Insufficient balance' });
  await run('INSERT INTO withdraws (user_id, amount, account, status, created_at) VALUES (?,?,?,?,?)', [req.session.user.id, amt, account, 'pending', Date.now()]);
  res.redirect('/dashboard');
});

app.post('/subscribe', requireAuth, async (req,res)=>{
  const packagePrice = Number(req.body.price);
  if (!PACKAGES.includes(packagePrice)) return res.redirect('/dashboard');
  const user = await query('SELECT * FROM users WHERE id = ?', [req.session.user.id]);
  const u = user[0];
  if (u.wallet < packagePrice) return res.render('dashboard', { error: 'Insufficient balance. Redirecting to deposit page...', redirectDeposit: packagePrice });
  const newWallet = u.wallet - packagePrice;
  await run('UPDATE users SET wallet = ? WHERE id = ?', [newWallet, u.id]);
  const immediate = Math.round(packagePrice * 0.20);
  await run('UPDATE users SET wallet = wallet + ? WHERE id = ?', [immediate, u.id]);
  const pkg = await query('SELECT id FROM packages WHERE price = ?', [packagePrice]);
  const package_id = pkg.length ? pkg[0].id : null;
  const now = Date.now();
  await run('INSERT INTO subscriptions (user_id, package_id, price, started_at, last_payout_at, active) VALUES (?,?,?,?,?,?)', [u.id, package_id, packagePrice, now, null, 1]);

  // referral bonuses: level1 12%, level2 3%
  if (u.parent_ref) {
    const parent = await query('SELECT * FROM users WHERE ref_code = ?', [u.parent_ref]);
    if (parent.length) {
      const p = parent[0];
      const bonus1 = Math.round(packagePrice * 0.12);
      await run('UPDATE users SET wallet = wallet + ? WHERE id = ?', [bonus1, p.id]);
      await run('INSERT INTO transactions (user_id, type, amount, note, created_at) VALUES (?,?,?,?,?)', [p.id, 'referral', bonus1, 'Level1 referral bonus', Date.now()]);
      if (p.parent_ref) {
        const parent2 = await query('SELECT * FROM users WHERE ref_code = ?', [p.parent_ref]);
        if (parent2.length) {
          const bonus2 = Math.round(packagePrice * 0.03);
          await run('UPDATE users SET wallet = wallet + ? WHERE id = ?', [bonus2, parent2[0].id]);
          await run('INSERT INTO transactions (user_id, type, amount, note, created_at) VALUES (?,?,?,?,?)', [parent2[0].id, 'referral', bonus2, 'Level2 referral bonus', Date.now()]);
        }
      }
    }
  }

  res.redirect('/dashboard');
});

app.get('/admin', requireAuth, requireAdmin, async (req,res)=>{
  const deposits = await query('SELECT d.*, u.username FROM deposits d JOIN users u ON d.user_id = u.id WHERE d.status = ?', ['pending']);
  const withdraws = await query('SELECT w.*, u.username FROM withdraws w JOIN users u ON w.user_id = u.id WHERE w.status = ?', ['pending']);
  const refunds = await query('SELECT s.*, u.username FROM subscriptions s JOIN users u ON s.user_id = u.id WHERE s.refund_requested = 1 AND s.active = 1');
  res.render('admin', { deposits, withdraws, refunds });
});

app.post('/admin/deposit/approve', requireAuth, requireAdmin, async (req,res)=>{
  const { id } = req.body;
  const drows = await query('SELECT * FROM deposits WHERE id = ?', [id]);
  if (!drows.length) return res.redirect('/admin');
  const d = drows[0];
  await run('UPDATE deposits SET status = ? WHERE id = ?', ['approved', id]);
  await run('UPDATE users SET wallet = wallet + ? WHERE id = ?', [d.amount, d.user_id]);
  res.redirect('/admin');
});

app.post('/admin/withdraw/approve', requireAuth, requireAdmin, async (req,res)=>{
  const { id } = req.body;
  const wrows = await query('SELECT * FROM withdraws WHERE id = ?', [id]);
  if (!wrows.length) return res.redirect('/admin');
  const w = wrows[0];
  await run('UPDATE withdraws SET status = ? WHERE id = ?', ['approved', id]);
  await run('UPDATE users SET wallet = wallet - ? WHERE id = ?', [w.amount, w.user_id]);
  res.redirect('/admin');
});

// Approve refund: apply 5% platform fee, deduct earnings within 30 days, cancel subscription
app.post('/admin/refund/approve', requireAuth, requireAdmin, async (req,res)=>{
  const { id } = req.body; // subscription id
  const srows = await query('SELECT * FROM subscriptions WHERE id = ?', [id]);
  if (!srows.length) return res.redirect('/admin');
  const s = srows[0];
  const user = await query('SELECT * FROM users WHERE id = ?', [s.user_id]);
  if (!user.length) return res.redirect('/admin');
  const u = user[0];
  const now = Date.now();
  const thirtyDaysAgo = now - (30*24*60*60*1000);
  // total earnings within 30 days
  const earningsRows = await query('SELECT SUM(amount) as total FROM transactions WHERE user_id = ? AND type = ? AND created_at >= ?', [u.id, 'earning', thirtyDaysAgo]);
  const earnedWithin30 = earningsRows && earningsRows[0] && earningsRows[0].total ? earningsRows[0].total : 0;
  const price = s.price;
  const platformFee = Math.round(price * 0.05);
  let refundable = price - platformFee - earnedWithin30;
  if (refundable < 0) refundable = 0;
  // deduct earned amount if any from user's wallet (as per rules)
  if (earnedWithin30 > 0) {
    await run('UPDATE users SET wallet = wallet - ? WHERE id = ?', [earnedWithin30, u.id]);
  }
  // credit refundable amount
  if (refundable > 0) await run('UPDATE users SET wallet = wallet + ? WHERE id = ?', [refundable, u.id]);
  // mark subscription inactive and refund processed
  await run('UPDATE subscriptions SET active = 0, refund_requested = 0, refund_requested_at = NULL WHERE id = ?', [s.id]);
  // record transaction
  await run('INSERT INTO transactions (user_id, type, amount, note, created_at) VALUES (?,?,?,?,?)', [u.id, 'refund', refundable, 'Refund processed (fee & deductions applied)', now]);
  res.redirect('/admin');
});

// Simple profile update: username and email only once a month
app.post('/profile/update', requireAuth, async (req,res)=>{
  const { username, email } = req.body;
  const user = await query('SELECT * FROM users WHERE id = ?', [req.session.user.id]);
  const u = user[0];
  const now = Date.now();
  if (u.last_profile_update && now - u.last_profile_update < 30*24*60*60*1000) return res.render('dashboard', { error: 'Profile can be updated only once a month' });
  const dup = await query('SELECT id FROM users WHERE (username = ? OR email = ?) AND id != ?', [username, email, u.id]);
  if (dup.length) return res.render('dashboard', { error: 'Username or email already registered' });
  await run('UPDATE users SET username = ?, email = ?, last_profile_update = ? WHERE id = ?', [username, email, now, u.id]);
  res.redirect('/dashboard');
});

// Password update endpoint: POST /profile/password
app.post('/profile/password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    if (!currentPassword || !newPassword || !confirmPassword) return res.redirect('/profile?msg=' + encodeURIComponent('Please fill all fields'));
    if (newPassword !== confirmPassword) return res.redirect('/profile?msg=' + encodeURIComponent('New passwords do not match'));
    const rows = await query('SELECT * FROM users WHERE id = ?', [req.session.user.id]);
    if (!rows.length) return res.redirect('/profile?msg=' + encodeURIComponent('User not found'));
    const user = rows[0];
    const ok = await bcrypt.compare(currentPassword, user.password);
    if (!ok) return res.redirect('/profile?msg=' + encodeURIComponent('Current password is incorrect'));
    const hashed = await bcrypt.hash(newPassword, 10);
    await run('UPDATE users SET password = ? WHERE id = ?', [hashed, user.id]);
    res.redirect('/profile?msg=' + encodeURIComponent('Password updated successfully'));
  } catch (e) {
    console.error('Password update error', e);
    res.redirect('/profile?msg=' + encodeURIComponent('Error updating password'));
  }
});

// Profile page
app.get('/profile', requireAuth, async (req, res) => {
  const user = await query('SELECT * FROM users WHERE id = ?', [req.session.user.id]);
  const u = user[0];
  res.render('profile', { user: u, msg: req.query.msg || null });
});

// Wallet page
app.get('/wallet', requireAuth, async (req, res) => {
  const user = await query('SELECT * FROM users WHERE id = ?', [req.session.user.id]);
  const deposits = await query('SELECT * FROM deposits WHERE user_id = ? ORDER BY created_at DESC', [req.session.user.id]);
  const withdraws = await query('SELECT * FROM withdraws WHERE user_id = ? ORDER BY created_at DESC', [req.session.user.id]);
  res.render('wallet', { user: user[0], deposits, withdraws });
});

// Packages page
app.get('/packages', requireAuth, async (req, res) => {
  res.render('packages', { user: req.session.user, packages: PACKAGES });
});

// Refund request
app.post('/refund', requireAuth, async (req,res)=>{
  const { subscription_id } = req.body;
  const srows = await query('SELECT * FROM subscriptions WHERE id = ? AND user_id = ?', [subscription_id, req.session.user.id]);
  if (!srows.length) return res.redirect('/dashboard');
  const s = srows[0];
  await run('UPDATE subscriptions SET refund_requested = 1, refund_requested_at = ? WHERE id = ?', [Date.now(), s.id]);
  res.redirect('/dashboard');
});

// Cron job to process payouts every hour (for demo). Keep it; admin can also trigger via endpoint.
cron.schedule('0 * * * *', async () => {
  try{ await processPayouts(); } catch(e){ console.error('Cron payout error', e); }
});

// External cron endpoint: call with ?secret=YOUR_SECRET
app.get('/cron/payout', async (req,res)=>{
  const secret = req.query.secret || process.env.CRON_SECRET || 'easyinvest-cron-secret';
  if (req.query.secret !== secret) return res.status(403).send('Forbidden');
  try{ await processPayouts(); res.send('Payouts processed'); } catch(e){ console.error(e); res.status(500).send('Error'); }
});

// Serve simple assets
app.get('/logo.svg', (req,res)=> res.sendFile(path.join(__dirname, 'public', 'logo.svg')));

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Easy Invest running on port', PORT));
