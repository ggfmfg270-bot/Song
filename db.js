const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'msong.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// كل المبالغ تُخزَّن كأعداد صحيحة بوحدة "ميكرو دولار" (1 دولار = 1,000,000) لتجنب أخطاء الكسور.
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  bio TEXT DEFAULT '',
  avatar_path TEXT,
  role TEXT NOT NULL DEFAULT 'user',          -- user | admin
  banned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS songs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  artist_name TEXT NOT NULL,
  description TEXT DEFAULT '',
  audio_path TEXT NOT NULL,
  cover_path TEXT,
  plays INTEGER NOT NULL DEFAULT 0,            -- كل الاستماعات المؤكدة
  qualified_plays INTEGER NOT NULL DEFAULT 0,  -- المؤهلة للربح
  status TEXT NOT NULL DEFAULT 'published',    -- published | removed
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_songs_user ON songs(user_id);
CREATE INDEX IF NOT EXISTS idx_songs_created ON songs(created_at);

CREATE TABLE IF NOT EXISTS likes (
  user_id INTEGER NOT NULL REFERENCES users(id),
  song_id INTEGER NOT NULL REFERENCES songs(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, song_id)
);

CREATE TABLE IF NOT EXISTS listens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  song_id INTEGER NOT NULL REFERENCES songs(id),
  listener_id INTEGER NOT NULL REFERENCES users(id),
  ip TEXT,
  token_id TEXT NOT NULL UNIQUE,               -- يمنع إعادة استخدام نفس الرمز
  paid_amount INTEGER NOT NULL DEFAULT 0,
  reason TEXT,                                 -- سبب عدم التأهل إن وجد
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_listens_lookup ON listens(listener_id, song_id, created_at);
CREATE INDEX IF NOT EXISTS idx_listens_ip ON listens(ip, song_id, created_at);

CREATE TABLE IF NOT EXISTS earnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  song_id INTEGER NOT NULL REFERENCES songs(id),
  listen_id INTEGER NOT NULL REFERENCES listens(id),
  amount INTEGER NOT NULL,
  release_at INTEGER NOT NULL,
  released INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_earn_release ON earnings(released, release_at);

CREATE TABLE IF NOT EXISTS wallets (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  available INTEGER NOT NULL DEFAULT 0 CHECK (available >= 0),
  pending INTEGER NOT NULL DEFAULT 0 CHECK (pending >= 0),
  total_earned INTEGER NOT NULL DEFAULT 0
);

-- سجل مالي لا يُعدَّل ولا يُحذف: كل تغيير في الرصيد له سطر هنا
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,        -- earning | withdrawal | refund | deposit | adjustment
  amount INTEGER NOT NULL,   -- موجب = إضافة للرصيد المتاح، سالب = خصم
  note TEXT DEFAULT '',
  ref_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id, created_at);

CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL,
  details TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'review',   -- review | approved | rejected | completed
  admin_note TEXT DEFAULT '',
  idem_key TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, idem_key)
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  body TEXT DEFAULT '',
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, is_read);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

const DEFAULT_SETTINGS = {
  rate_per_1000: 500000,        // 0.50$ لكل 1000 استماع مؤهل
  min_withdraw: 5000000,        // 5$ حد أدنى للسحب
  hold_days: 7,                 // مدة تعليق الأرباح قبل أن تصبح متاحة
  monthly_budget: 1000000000,   // 1000$ ميزانية الأرباح الشهرية
  min_listen_seconds: 30,       // أقل مدة استماع فعلية ليُحسب الاستماع
  max_paid_per_song_day: 3,     // أقصى استماعات مدفوعة لنفس المستمع لنفس الأغنية يوميًا
  max_paid_per_user_day: 100,   // أقصى استماعات مدفوعة لنفس المستمع يوميًا
  withdraw_methods: 'ZainCash,FastPay,FIB,PayPal,Bank Transfer,USDT (TRC20)',
};
const ins = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, String(v));

function getSettings() {
  const out = {};
  for (const r of db.prepare('SELECT key,value FROM settings').all()) {
    out[r.key] = r.key === 'withdraw_methods' ? r.value : Number(r.value);
  }
  return out;
}

module.exports = { db, getSettings, DEFAULT_SETTINGS, DATA_DIR };
