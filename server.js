require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { db, getSettings, DEFAULT_SETTINGS, DATA_DIR } = require('./db');

const PROD = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 3000;
let SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET.length < 24) {
  if (PROD) { console.error('JWT_SECRET مطلوب (24 حرفًا على الأقل) في وضع الإنتاج'); process.exit(1); }
  SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('تنبيه: JWT_SECRET غير محدد، تم توليد مفتاح مؤقت (ستنتهي الجلسات عند إعادة التشغيل).');
}

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(DATA_DIR, 'uploads');
for (const d of ['audio', 'covers', 'avatars']) fs.mkdirSync(path.join(UPLOAD_DIR, d), { recursive: true });

const app = express();
if (PROD) app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'script-src': ["'self'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'data:', 'blob:'],
      'media-src': ["'self'", 'blob:'],
      'upgrade-insecure-requests': null,
    },
  },
}));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use('/api', rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false }));
const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });

const now = () => Date.now();
const DAY = 86_400_000;
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (res, code, msg) => res.status(code).json({ error: msg });

// ---------- Auth ----------
function setSession(res, uid) {
  const token = jwt.sign({ uid }, SECRET, { expiresIn: '30d' });
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 30 * DAY });
}
function loadUser(req, _res, next) {
  req.user = null;
  const t = req.cookies.token;
  if (t) {
    try {
      const { uid } = jwt.verify(t, SECRET);
      const u = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
      if (u && !u.banned) req.user = u;
    } catch { /* رمز غير صالح */ }
  }
  next();
}
const requireAuth = (req, res, next) => req.user ? next() : fail(res, 401, 'يجب تسجيل الدخول');
const requireAdmin = (req, res, next) => req.user && req.user.role === 'admin' ? next() : fail(res, 403, 'غير مصرح');
app.use(loadUser);

const publicUser = u => ({
  id: u.id, username: u.username, display_name: u.display_name, bio: u.bio,
  avatar: u.avatar_path ? `/media/avatars/${u.avatar_path}` : null, role: u.role,
});

function createUser({ username, email, password, role = 'user' }) {
  const hash = bcrypt.hashSync(password, 12);
  return db.transaction(() => {
    const r = db.prepare(
      'INSERT INTO users(username,email,password_hash,display_name,role,created_at) VALUES (?,?,?,?,?,?)'
    ).run(username, email, hash, username, role, now());
    db.prepare('INSERT INTO wallets(user_id) VALUES (?)').run(r.lastInsertRowid);
    return r.lastInsertRowid;
  })();
}

// مدير التطبيق الأول من متغيرات البيئة
if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
  const ex = db.prepare('SELECT id FROM users WHERE email=?').get(process.env.ADMIN_EMAIL);
  if (!ex) {
    createUser({ username: 'admin', email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD, role: 'admin' });
    console.log('تم إنشاء حساب المدير:', process.env.ADMIN_EMAIL);
  }
}

function notify(userId, title, body = '') {
  db.prepare('INSERT INTO notifications(user_id,title,body,created_at) VALUES (?,?,?,?)').run(userId, title, body, now());
}

app.post('/api/auth/register', authLimiter, wrap((req, res) => {
  const { username, email, password } = req.body || {};
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username || '')) return fail(res, 400, 'اسم المستخدم 3-20 حرفًا إنجليزيًا أو أرقامًا أو _');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) return fail(res, 400, 'بريد إلكتروني غير صالح');
  if (typeof password !== 'string' || password.length < 8) return fail(res, 400, 'كلمة المرور 8 أحرف على الأقل');
  if (db.prepare('SELECT 1 FROM users WHERE username=? OR email=?').get(username, email)) return fail(res, 409, 'اسم المستخدم أو البريد مستخدم مسبقًا');
  const id = createUser({ username, email, password });
  setSession(res, id);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id)) });
}));

app.post('/api/auth/login', authLimiter, wrap((req, res) => {
  const { login, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username=? OR email=?').get(login || '', login || '');
  if (!u || !bcrypt.compareSync(String(password || ''), u.password_hash)) return fail(res, 401, 'بيانات الدخول غير صحيحة');
  if (u.banned) return fail(res, 403, 'هذا الحساب محظور');
  setSession(res, u.id);
  res.json({ user: publicUser(u) });
}));

app.post('/api/auth/logout', (_req, res) => { res.clearCookie('token'); res.json({ ok: true }); });

app.get('/api/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  const unread = db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND is_read=0').get(req.user.id).c;
  res.json({ user: publicUser(req.user), unread });
});

// ---------- Uploads ----------
const AUDIO_TYPES = { 'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/aac': '.aac' };
const IMAGE_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, file, cb) => cb(null, path.join(UPLOAD_DIR, file.fieldname === 'audio' ? 'audio' : file.fieldname === 'cover' ? 'covers' : 'avatars')),
    filename: (_req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + (AUDIO_TYPES[file.mimetype] || IMAGE_TYPES[file.mimetype] || '')),
  }),
  limits: { fileSize: 40 * 1024 * 1024, files: 2 },
  fileFilter: (_req, file, cb) => {
    const ok = file.fieldname === 'audio' ? AUDIO_TYPES[file.mimetype] : IMAGE_TYPES[file.mimetype];
    cb(ok ? null : new Error('نوع الملف غير مدعوم'), !!ok);
  },
});
const cleanup = files => Object.values(files || {}).flat().forEach(f => fs.unlink(f.path, () => {}));

app.use('/media', express.static(UPLOAD_DIR, { fallthrough: false, index: false, maxAge: '7d', setHeaders: res => res.setHeader('X-Content-Type-Options', 'nosniff') }));

// ---------- Songs ----------
const songSelect = `
  SELECT s.id, s.title, s.artist_name, s.description, s.plays, s.created_at, s.user_id,
         s.audio_path, s.cover_path, u.username, u.display_name,
         EXISTS(SELECT 1 FROM likes l WHERE l.song_id=s.id AND l.user_id=@me) AS liked,
         (SELECT COUNT(*) FROM likes l WHERE l.song_id=s.id) AS likes
  FROM songs s JOIN users u ON u.id=s.user_id`;
const shapeSong = s => ({
  id: s.id, title: s.title, artist_name: s.artist_name, description: s.description, plays: s.plays,
  created_at: s.created_at, username: s.username, display_name: s.display_name, user_id: s.user_id,
  audio: `/media/audio/${s.audio_path}`, cover: s.cover_path ? `/media/covers/${s.cover_path}` : null,
  liked: !!s.liked, likes: s.likes,
});
const meId = req => req.user ? req.user.id : 0;

app.get('/api/songs', wrap((req, res) => {
  const sort = req.query.sort || 'new';
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const order = {
    new: 's.created_at DESC',
    top: 's.plays DESC, s.created_at DESC',
    random: 'RANDOM()',
    trending: `(SELECT COUNT(*) FROM listens x WHERE x.song_id=s.id AND x.created_at > @since) DESC, s.plays DESC`,
  }[sort] || 's.created_at DESC';
  const rows = db.prepare(`${songSelect} WHERE s.status='published' ORDER BY ${order} LIMIT @limit`)
    .all({ me: meId(req), since: now() - 7 * DAY, limit });
  res.json({ songs: rows.map(shapeSong) });
}));

app.get('/api/songs/:id', wrap((req, res) => {
  const s = db.prepare(`${songSelect} WHERE s.id=@id AND s.status='published'`).get({ me: meId(req), id: req.params.id });
  if (!s) return fail(res, 404, 'الأغنية غير موجودة');
  res.json({ song: shapeSong(s) });
}));

app.post('/api/songs', requireAuth, (req, res, next) => {
  upload.fields([{ name: 'audio', maxCount: 1 }, { name: 'cover', maxCount: 1 }])(req, res, err => {
    if (err) return fail(res, 400, err.code === 'LIMIT_FILE_SIZE' ? 'حجم الملف أكبر من 40MB' : err.message);
    try {
      const f = req.files || {};
      const { title, artist_name, description, rights } = req.body;
      if (!f.audio) { cleanup(f); return fail(res, 400, 'ملف الأغنية مطلوب'); }
      if (!title || title.trim().length < 1 || title.length > 100) { cleanup(f); return fail(res, 400, 'عنوان الأغنية مطلوب (حتى 100 حرف)'); }
      if (rights !== 'yes') { cleanup(f); return fail(res, 400, 'يجب الإقرار بأنك تملك حقوق هذه الأغنية'); }
      const r = db.prepare(
        'INSERT INTO songs(user_id,title,artist_name,description,audio_path,cover_path,created_at) VALUES (?,?,?,?,?,?,?)'
      ).run(req.user.id, title.trim(), (artist_name || req.user.display_name).trim().slice(0, 80),
        (description || '').slice(0, 1000), f.audio[0].filename, f.cover ? f.cover[0].filename : null, now());
      res.json({ id: r.lastInsertRowid });
    } catch (e) { next(e); }
  });
});

app.delete('/api/songs/:id', requireAuth, wrap((req, res) => {
  const s = db.prepare('SELECT * FROM songs WHERE id=?').get(req.params.id);
  if (!s) return fail(res, 404, 'غير موجودة');
  if (s.user_id !== req.user.id && req.user.role !== 'admin') return fail(res, 403, 'غير مصرح');
  db.prepare("UPDATE songs SET status='removed' WHERE id=?").run(s.id);
  res.json({ ok: true });
}));

app.post('/api/songs/:id/like', requireAuth, wrap((req, res) => {
  const s = db.prepare("SELECT id FROM songs WHERE id=? AND status='published'").get(req.params.id);
  if (!s) return fail(res, 404, 'غير موجودة');
  const del = db.prepare('DELETE FROM likes WHERE user_id=? AND song_id=?').run(req.user.id, s.id);
  if (!del.changes) db.prepare('INSERT INTO likes(user_id,song_id,created_at) VALUES (?,?,?)').run(req.user.id, s.id, now());
  res.json({ liked: !del.changes });
}));

app.get('/api/me/likes', requireAuth, wrap((req, res) => {
  const rows = db.prepare(`${songSelect} JOIN likes lk ON lk.song_id=s.id AND lk.user_id=@me
    WHERE s.status='published' ORDER BY lk.created_at DESC`).all({ me: req.user.id });
  res.json({ songs: rows.map(shapeSong) });
}));

// ---------- Search & artists ----------
const likeEsc = q => '%' + q.replace(/[\\%_]/g, c => '\\' + c) + '%';
app.get('/api/search', wrap((req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 60);
  if (!q) return res.json({ songs: [], artists: [] });
  const p = likeEsc(q);
  const songs = db.prepare(`${songSelect} WHERE s.status='published' AND (s.title LIKE @p ESCAPE '\\' OR s.artist_name LIKE @p ESCAPE '\\')
    ORDER BY s.plays DESC LIMIT 20`).all({ me: meId(req), p });
  const artists = db.prepare(`SELECT u.id,u.username,u.display_name,u.avatar_path,
      (SELECT COUNT(*) FROM songs s WHERE s.user_id=u.id AND s.status='published') AS songs
    FROM users u WHERE u.banned=0 AND (u.username LIKE @p ESCAPE '\\' OR u.display_name LIKE @p ESCAPE '\\')
    AND EXISTS(SELECT 1 FROM songs s WHERE s.user_id=u.id AND s.status='published') LIMIT 10`).all({ p });
  res.json({
    songs: songs.map(shapeSong),
    artists: artists.map(a => ({ username: a.username, display_name: a.display_name, songs: a.songs, avatar: a.avatar_path ? `/media/avatars/${a.avatar_path}` : null })),
  });
}));

app.get('/api/artists/:username', wrap((req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE username=? AND banned=0').get(req.params.username);
  if (!u) return fail(res, 404, 'الفنان غير موجود');
  const songs = db.prepare(`${songSelect} WHERE s.user_id=@uid AND s.status='published' ORDER BY s.created_at DESC`)
    .all({ me: meId(req), uid: u.id });
  const out = { artist: publicUser(u), songs: songs.map(shapeSong), total_plays: songs.reduce((a, s) => a + s.plays, 0) };
  // الأرباح تظهر لصاحب الحساب والمدير فقط
  if (req.user && (req.user.id === u.id || req.user.role === 'admin')) {
    out.total_earned = db.prepare('SELECT total_earned FROM wallets WHERE user_id=?').get(u.id).total_earned;
    const per = db.prepare('SELECT song_id, SUM(amount) a FROM earnings WHERE user_id=? GROUP BY song_id').all(u.id);
    const map = Object.fromEntries(per.map(r => [r.song_id, r.a]));
    out.songs.forEach(s => { s.earned = map[s.id] || 0; });
  }
  res.json(out);
}));

app.put('/api/me', requireAuth, (req, res, next) => {
  upload.fields([{ name: 'avatar', maxCount: 1 }])(req, res, err => {
    if (err) return fail(res, 400, err.message);
    try {
      const name = String(req.body.display_name || req.user.display_name).trim().slice(0, 50) || req.user.username;
      const bio = String(req.body.bio ?? req.user.bio).slice(0, 500);
      const avatar = req.files && req.files.avatar ? req.files.avatar[0].filename : req.user.avatar_path;
      db.prepare('UPDATE users SET display_name=?, bio=?, avatar_path=? WHERE id=?').run(name, bio, avatar, req.user.id);
      res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)) });
    } catch (e) { next(e); }
  });
});

// ---------- Listens & earnings ----------
// الخطوة 1: عند بدء التشغيل يصدر الخادم رمزًا موقّعًا فيه وقت البدء
app.post('/api/songs/:id/play-start', requireAuth, wrap((req, res) => {
  const s = db.prepare("SELECT id FROM songs WHERE id=? AND status='published'").get(req.params.id);
  if (!s) return fail(res, 404, 'غير موجودة');
  const jti = crypto.randomBytes(12).toString('hex');
  const token = jwt.sign({ jti, sid: s.id, uid: req.user.id, t: now() }, SECRET, { expiresIn: '15m' });
  res.json({ token });
}));

// الخطوة 2: بعد مدة استماع كافية يؤكد العميل، والخادم يتحقق من الزمن الفعلي ومن قواعد منع الاحتيال
app.post('/api/listen', requireAuth, wrap((req, res) => {
  const cfg = getSettings();
  let p;
  try { p = jwt.verify(String(req.body.token || ''), SECRET); } catch { return fail(res, 400, 'رمز غير صالح'); }
  if (p.uid !== req.user.id) return fail(res, 403, 'رمز لا يخص هذا الحساب');
  if (now() - p.t < (cfg.min_listen_seconds - 2) * 1000) return fail(res, 400, 'مدة الاستماع غير كافية');
  const song = db.prepare("SELECT * FROM songs WHERE id=? AND status='published'").get(p.sid);
  if (!song) return fail(res, 404, 'غير موجودة');
  const ip = req.ip;

  const result = db.transaction(() => {
    let reason = null;
    const since = now() - DAY;
    if (song.user_id === req.user.id) reason = 'own_song';
    else if (db.prepare('SELECT COUNT(*) c FROM listens WHERE listener_id=? AND song_id=? AND paid_amount>0 AND created_at>?').get(req.user.id, song.id, since).c >= cfg.max_paid_per_song_day) reason = 'song_daily_limit';
    else if (db.prepare('SELECT COUNT(*) c FROM listens WHERE listener_id=? AND paid_amount>0 AND created_at>?').get(req.user.id, since).c >= cfg.max_paid_per_user_day) reason = 'user_daily_limit';
    else if (db.prepare('SELECT COUNT(*) c FROM listens WHERE ip=? AND song_id=? AND paid_amount>0 AND created_at>?').get(ip, song.id, since).c >= cfg.max_paid_per_song_day * 3) reason = 'ip_limit';

    const amount = Math.floor(cfg.rate_per_1000 / 1000);
    if (!reason) {
      const d = new Date(); const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
      const spent = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM earnings WHERE created_at>=?').get(monthStart).s;
      if (spent + amount > cfg.monthly_budget) reason = 'budget_exhausted';
    }
    const paid = reason ? 0 : amount;
    let lr;
    try {
      lr = db.prepare('INSERT INTO listens(song_id,listener_id,ip,token_id,paid_amount,reason,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(song.id, req.user.id, ip, p.jti, paid, reason, now());
    } catch (e) {
      if (String(e.code).startsWith('SQLITE_CONSTRAINT')) return { duplicate: true };
      throw e;
    }
    db.prepare('UPDATE songs SET plays=plays+1, qualified_plays=qualified_plays+? WHERE id=?').run(paid ? 1 : 0, song.id);
    if (paid) {
      db.prepare('INSERT INTO earnings(user_id,song_id,listen_id,amount,release_at,created_at) VALUES (?,?,?,?,?,?)')
        .run(song.user_id, song.id, lr.lastInsertRowid, paid, now() + cfg.hold_days * DAY, now());
      db.prepare('UPDATE wallets SET pending=pending+?, total_earned=total_earned+? WHERE user_id=?').run(paid, paid, song.user_id);
    }
    return { counted: true, paid: !!paid };
  })();

  if (result.duplicate) return fail(res, 409, 'تم احتساب هذا الاستماع مسبقًا');
  res.json(result);
}));

// تحويل الأرباح المعلقة إلى رصيد متاح بعد انتهاء مدة التعليق
function releaseEarnings() {
  const t = now();
  const users = db.prepare('SELECT DISTINCT user_id FROM earnings WHERE released=0 AND release_at<=?').all(t);
  for (const { user_id } of users) {
    db.transaction(() => {
      const total = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM earnings WHERE user_id=? AND released=0 AND release_at<=?').get(user_id, t).s;
      if (!total) return;
      db.prepare('UPDATE earnings SET released=1 WHERE user_id=? AND released=0 AND release_at<=?').run(user_id, t);
      db.prepare('UPDATE wallets SET pending=pending-?, available=available+? WHERE user_id=?').run(total, total, user_id);
      db.prepare('INSERT INTO transactions(user_id,type,amount,note,created_at) VALUES (?,?,?,?,?)')
        .run(user_id, 'earning', total, 'أرباح استماعات أصبحت متاحة', now());
      notify(user_id, 'أرباح جديدة', `تمت إضافة ${(total / 1e6).toFixed(4)}$ إلى رصيدك المتاح`);
    })();
  }
}
setInterval(() => { try { releaseEarnings(); } catch (e) { console.error('release error', e); } }, 30_000);

// ---------- Wallet & withdrawals ----------
app.get('/api/wallet', requireAuth, wrap((req, res) => {
  const w = db.prepare('SELECT * FROM wallets WHERE user_id=?').get(req.user.id);
  const cfg = getSettings();
  res.json({
    wallet: w,
    settings: { min_withdraw: cfg.min_withdraw, rate_per_1000: cfg.rate_per_1000, hold_days: cfg.hold_days, methods: cfg.withdraw_methods.split(',').map(s => s.trim()).filter(Boolean) },
  });
}));

app.get('/api/wallet/transactions', requireAuth, wrap((req, res) => {
  res.json({ transactions: db.prepare('SELECT * FROM transactions WHERE user_id=? ORDER BY id DESC LIMIT 200').all(req.user.id) });
}));

app.get('/api/withdrawals', requireAuth, wrap((req, res) => {
  res.json({ withdrawals: db.prepare('SELECT * FROM withdrawals WHERE user_id=? ORDER BY id DESC LIMIT 100').all(req.user.id) });
}));

app.post('/api/withdrawals', requireAuth, wrap((req, res) => {
  const cfg = getSettings();
  const methods = cfg.withdraw_methods.split(',').map(s => s.trim());
  const { method, details, idem_key } = req.body || {};
  const amount = Math.round(Number(req.body.amount_usd) * 1e6);
  if (!methods.includes(method)) return fail(res, 400, 'وسيلة سحب غير متاحة');
  if (!details || String(details).trim().length < 4 || String(details).length > 300) return fail(res, 400, 'أدخل بيانات استلام صحيحة');
  if (!Number.isFinite(amount) || amount <= 0) return fail(res, 400, 'مبلغ غير صالح');
  if (amount < cfg.min_withdraw) return fail(res, 400, `الحد الأدنى للسحب ${(cfg.min_withdraw / 1e6).toFixed(2)}$`);
  const key = idem_key ? String(idem_key).slice(0, 64) : null;
  try {
    const id = db.transaction(() => {
      // الخصم ذري: ينجح فقط إذا كان الرصيد كافيًا لحظة التنفيذ، فلا يمكن سحب نفس المال مرتين
      const upd = db.prepare('UPDATE wallets SET available=available-? WHERE user_id=? AND available>=?').run(amount, req.user.id, amount);
      if (upd.changes !== 1) throw Object.assign(new Error('INSUFFICIENT'), { code: 'INSUFFICIENT' });
      const r = db.prepare('INSERT INTO withdrawals(user_id,amount,method,details,idem_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
        .run(req.user.id, amount, method, String(details).trim(), key, now(), now());
      db.prepare('INSERT INTO transactions(user_id,type,amount,note,ref_id,created_at) VALUES (?,?,?,?,?,?)')
        .run(req.user.id, 'withdrawal', -amount, `طلب سحب #${r.lastInsertRowid} عبر ${method}`, r.lastInsertRowid, now());
      notify(req.user.id, 'تم استلام طلب السحب', `طلبك رقم ${r.lastInsertRowid} قيد المراجعة`);
      return r.lastInsertRowid;
    })();
    res.json({ id });
  } catch (e) {
    if (e.code === 'INSUFFICIENT') return fail(res, 400, 'الرصيد المتاح غير كافٍ');
    if (String(e.code).startsWith('SQLITE_CONSTRAINT')) return fail(res, 409, 'طلب مكرر');
    throw e;
  }
}));

// ---------- Notifications ----------
app.get('/api/notifications', requireAuth, wrap((req, res) => {
  res.json({ notifications: db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 100').all(req.user.id) });
}));
app.post('/api/notifications/read', requireAuth, wrap((req, res) => {
  db.prepare('UPDATE notifications SET is_read=1 WHERE user_id=?').run(req.user.id);
  res.json({ ok: true });
}));

// ---------- Admin ----------
const admin = express.Router();
admin.use(requireAuth, requireAdmin);

admin.get('/stats', wrap((_req, res) => {
  const c = sql => db.prepare(sql).get();
  res.json({
    users: c('SELECT COUNT(*) n FROM users').n,
    songs: c("SELECT COUNT(*) n FROM songs WHERE status='published'").n,
    listens: c('SELECT COUNT(*) n FROM listens').n,
    paid_listens: c('SELECT COUNT(*) n FROM listens WHERE paid_amount>0').n,
    total_earned: c('SELECT COALESCE(SUM(amount),0) n FROM earnings').n,
    wallets_available: c('SELECT COALESCE(SUM(available),0) n FROM wallets').n,
    wallets_pending: c('SELECT COALESCE(SUM(pending),0) n FROM wallets').n,
    pending_withdrawals: c("SELECT COUNT(*) n FROM withdrawals WHERE status IN ('review','approved')").n,
  });
}));

admin.get('/users', wrap((_req, res) => {
  res.json({ users: db.prepare(`SELECT u.id,u.username,u.email,u.role,u.banned,u.created_at,
      w.available,w.pending,w.total_earned,
      (SELECT COUNT(*) FROM songs s WHERE s.user_id=u.id AND s.status='published') songs
    FROM users u LEFT JOIN wallets w ON w.user_id=u.id ORDER BY u.id DESC LIMIT 200`).all() });
}));
admin.post('/users/:id/ban', wrap((req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u || u.role === 'admin') return fail(res, 400, 'لا يمكن تنفيذ الإجراء');
  db.prepare('UPDATE users SET banned=? WHERE id=?').run(u.banned ? 0 : 1, u.id);
  res.json({ banned: !u.banned });
}));

admin.get('/songs', wrap((_req, res) => {
  res.json({ songs: db.prepare(`SELECT s.id,s.title,s.artist_name,s.plays,s.qualified_plays,s.status,s.created_at,u.username
    FROM songs s JOIN users u ON u.id=s.user_id ORDER BY s.id DESC LIMIT 200`).all() });
}));
admin.post('/songs/:id/toggle', wrap((req, res) => {
  const s = db.prepare('SELECT * FROM songs WHERE id=?').get(req.params.id);
  if (!s) return fail(res, 404, 'غير موجودة');
  const st = s.status === 'published' ? 'removed' : 'published';
  db.prepare('UPDATE songs SET status=? WHERE id=?').run(st, s.id);
  res.json({ status: st });
}));

admin.get('/listens', wrap((_req, res) => {
  res.json({ listens: db.prepare(`SELECT l.id,l.ip,l.paid_amount,l.reason,l.created_at,s.title,u.username listener
    FROM listens l JOIN songs s ON s.id=l.song_id JOIN users u ON u.id=l.listener_id ORDER BY l.id DESC LIMIT 200`).all() });
}));

admin.get('/transactions', wrap((_req, res) => {
  res.json({ transactions: db.prepare(`SELECT t.*,u.username FROM transactions t JOIN users u ON u.id=t.user_id ORDER BY t.id DESC LIMIT 300`).all() });
}));

admin.get('/withdrawals', wrap((_req, res) => {
  res.json({ withdrawals: db.prepare(`SELECT w.*,u.username,u.email FROM withdrawals w JOIN users u ON u.id=w.user_id ORDER BY w.id DESC LIMIT 200`).all() });
}));

const TRANSITIONS = { review: ['approved', 'rejected'], approved: ['completed', 'rejected'] };
const STATUS_AR = { approved: 'تمت الموافقة على طلبك', rejected: 'تم رفض طلبك وإرجاع المبلغ إلى رصيدك', completed: 'تم تحويل المبلغ إليك' };
admin.post('/withdrawals/:id/status', wrap((req, res) => {
  const { status, note } = req.body || {};
  const out = db.transaction(() => {
    const w = db.prepare('SELECT * FROM withdrawals WHERE id=?').get(req.params.id);
    if (!w) return { code: 404, msg: 'غير موجود' };
    if (!(TRANSITIONS[w.status] || []).includes(status)) return { code: 400, msg: 'انتقال غير مسموح من الحالة الحالية' };
    // التحديث مشروط بالحالة الحالية لمنع التنفيذ المزدوج (مثل رفض مرتين وإرجاع المبلغ مرتين)
    const upd = db.prepare('UPDATE withdrawals SET status=?, admin_note=?, updated_at=? WHERE id=? AND status=?')
      .run(status, String(note || '').slice(0, 300), now(), w.id, w.status);
    if (upd.changes !== 1) return { code: 409, msg: 'تم تغيير الحالة مسبقًا' };
    if (status === 'rejected') {
      db.prepare('UPDATE wallets SET available=available+? WHERE user_id=?').run(w.amount, w.user_id);
      db.prepare('INSERT INTO transactions(user_id,type,amount,note,ref_id,created_at) VALUES (?,?,?,?,?,?)')
        .run(w.user_id, 'refund', w.amount, `إرجاع مبلغ طلب السحب #${w.id}`, w.id, now());
    }
    notify(w.user_id, `طلب السحب #${w.id}`, STATUS_AR[status] + (note ? ` — ${note}` : ''));
    return { ok: true };
  })();
  if (out.code) return fail(res, out.code, out.msg);
  res.json(out);
}));

admin.get('/settings', (_req, res) => res.json({ settings: getSettings() }));
admin.put('/settings', wrap((req, res) => {
  const body = req.body || {};
  const up = db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  db.transaction(() => {
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (!(k in body)) continue;
      if (k === 'withdraw_methods') { up.run(k, String(body[k]).slice(0, 500)); continue; }
      const n = Number(body[k]);
      if (!Number.isFinite(n) || n < 0) throw Object.assign(new Error('قيمة غير صالحة: ' + k), { status: 400 });
      up.run(k, String(Math.round(n)));
    }
  })();
  res.json({ settings: getSettings() });
}));

admin.post('/adjust', wrap((req, res) => {
  const amount = Math.round(Number(req.body.amount_usd) * 1e6);
  const uid = Number(req.body.user_id);
  if (!Number.isFinite(amount) || amount === 0 || !uid) return fail(res, 400, 'بيانات غير صالحة');
  try {
    db.transaction(() => {
      const u = db.prepare('UPDATE wallets SET available=available+? WHERE user_id=?').run(amount, uid);
      if (!u.changes) throw Object.assign(new Error('مستخدم غير موجود'), { status: 404 });
      db.prepare('INSERT INTO transactions(user_id,type,amount,note,created_at) VALUES (?,?,?,?,?)')
        .run(uid, amount > 0 ? 'deposit' : 'adjustment', amount, String(req.body.note || 'تعديل من الإدارة').slice(0, 200), now());
      notify(uid, 'تعديل على المحفظة', `${amount > 0 ? 'إضافة' : 'خصم'} ${(Math.abs(amount) / 1e6).toFixed(2)}$`);
    })();
  } catch (e) {
    if (e.status) throw e;
    return fail(res, 400, 'لا يمكن تنفيذ الخصم (الرصيد غير كافٍ)');
  }
  res.json({ ok: true });
}));
app.use('/api/admin', admin);

// ---------- Static & errors ----------
app.use('/api', (_req, res) => fail(res, 404, 'غير موجود'));
const STATIC_FILES = new Set(['index.html', 'style.css', 'app.js', 'logo.svg', 'manifest.webmanifest', 'sw.js', 'icon-192.png', 'icon-512.png', 'maskable-512.png', 'apple-touch-icon.png']);
app.get('/:file', (req, res, next) => (STATIC_FILES.has(req.params.file) ? res.sendFile(path.join(__dirname, req.params.file), { maxAge: PROD ? 3600000 : 0 }) : next()));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.use((err, _req, res, _next) => {
  if (err.status && err.status < 500) return fail(res, err.status, err.message);
  console.error(err);
  fail(res, 500, 'خطأ في الخادم');
});

if (require.main === module) {
  releaseEarnings();
  app.listen(PORT, () => console.log(`M Song يعمل على http://localhost:${PORT}`));
}
module.exports = { app, releaseEarnings };
