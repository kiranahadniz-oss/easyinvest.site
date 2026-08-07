-- init.sql: create tables and seed packages

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fullname TEXT,
  username TEXT UNIQUE,
  email TEXT UNIQUE,
  phone TEXT UNIQUE,
  password TEXT,
  wallet INTEGER DEFAULT 0,
  ref_code TEXT UNIQUE,
  parent_ref TEXT,
  is_admin INTEGER DEFAULT 0,
  created_at INTEGER,
  last_profile_update INTEGER
);

CREATE TABLE IF NOT EXISTS packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  price INTEGER
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  package_id INTEGER,
  price INTEGER,
  started_at INTEGER,
  last_payout_at INTEGER,
  active INTEGER DEFAULT 1,
  refund_requested INTEGER DEFAULT 0,
  refund_requested_at INTEGER
);

CREATE TABLE IF NOT EXISTS deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  method TEXT,
  account TEXT,
  transaction_id TEXT,
  amount INTEGER,
  slip TEXT,
  status TEXT,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS withdraws (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  amount INTEGER,
  account TEXT,
  status TEXT,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  type TEXT,
  amount INTEGER,
  note TEXT,
  created_at INTEGER
);

-- seed packages if empty
INSERT INTO packages (price)
SELECT p FROM (VALUES (500),(2000),(5000),(8000),(14000),(25000),(38000),(75000),(135000),(300000)) AS t(p)
WHERE NOT EXISTS (SELECT 1 FROM packages LIMIT 1);
