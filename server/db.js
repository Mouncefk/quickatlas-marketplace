// db.js — Couche base de données, basée sur le module natif node:sqlite (Node >= 22.5).
// Aucune dépendance externe n'est nécessaire : tout tourne avec Node seul.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'atlas.db'));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
    terms_accepted_at TEXT,
    email_verified_at TEXT,
    ai_provider TEXT CHECK (ai_provider IN ('anthropic','openai') OR ai_provider IS NULL),
    ai_api_key_encrypted TEXT,
    phone TEXT,
    referral_code TEXT UNIQUE,
    referred_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    free_boost_credits INTEGER NOT NULL DEFAULT 0,
    google_sub TEXT UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS countries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    iso2 TEXT NOT NULL UNIQUE,
    iso_numeric TEXT NOT NULL UNIQUE,
    currency TEXT NOT NULL DEFAULT 'USD',
    is_federal INTEGER NOT NULL DEFAULT 0,
    capital TEXT,
    population_millions REAL,
    languages TEXT,
    continent TEXT
  );

  CREATE TABLE IF NOT EXISTS states (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    country_id INTEGER NOT NULL REFERENCES countries(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    code TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    country_id INTEGER NOT NULL REFERENCES countries(id) ON DELETE CASCADE,
    state_id INTEGER REFERENCES states(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'UTC'
  );

  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    icon TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS subcategories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    UNIQUE(category_id, slug)
  );

  CREATE TABLE IF NOT EXISTS listings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    city_id INTEGER NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    subcategory_id INTEGER REFERENCES subcategories(id),
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    listing_type TEXT NOT NULL CHECK (listing_type IN ('vente','location','achat','offre_emploi','demande_emploi')),
    price REAL,
    currency TEXT NOT NULL DEFAULT 'EUR',
    images_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'active',
    view_count INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL DEFAULT (datetime('now', '+60 days')),
    expiry_reminder_sent INTEGER NOT NULL DEFAULT 0,
    expired_notice_sent INTEGER NOT NULL DEFAULT 0,
    open_to_trade INTEGER NOT NULL DEFAULT 0,
    trade_description TEXT,
    boosted_until TEXT,
    fraud_risk_score INTEGER NOT NULL DEFAULT 0,
    fraud_risk_reasons TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS offers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    buyer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'argent' CHECK (kind IN ('argent','echange')),
    amount REAL,
    currency TEXT NOT NULL DEFAULT 'EUR',
    trade_description TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    responded_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_offers_conversation ON offers(conversation_id);

  CREATE TABLE IF NOT EXISTS favorites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, listing_id)
  );

  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reviewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(reviewer_id, listing_id)
  );

  CREATE TABLE IF NOT EXISTS saved_searches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    country_id INTEGER REFERENCES countries(id) ON DELETE CASCADE,
    city_id INTEGER REFERENCES cities(id) ON DELETE CASCADE,
    category_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
    subcategory_id INTEGER REFERENCES subcategories(id) ON DELETE CASCADE,
    listing_type TEXT,
    keyword TEXT,
    email_alerts INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS saved_search_matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    saved_search_id INTEGER NOT NULL REFERENCES saved_searches(id) ON DELETE CASCADE,
    listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    seen INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(saved_search_id, listing_id)
  );

  CREATE INDEX IF NOT EXISTS idx_reviews_seller ON reviews(seller_id);
  CREATE INDEX IF NOT EXISTS idx_saved_searches_user ON saved_searches(user_id);
  CREATE INDEX IF NOT EXISTS idx_saved_search_matches_search ON saved_search_matches(saved_search_id);
  CREATE INDEX IF NOT EXISTS idx_listings_city ON listings(city_id);
  CREATE INDEX IF NOT EXISTS idx_listings_category ON listings(category_id);
  CREATE INDEX IF NOT EXISTS idx_listings_subcategory ON listings(subcategory_id);
  CREATE INDEX IF NOT EXISTS idx_cities_country ON cities(country_id);
  CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id);
  CREATE INDEX IF NOT EXISTS idx_favorites_listing ON favorites(listing_id);
  CREATE INDEX IF NOT EXISTS idx_cities_state ON cities(state_id);
  CREATE TABLE IF NOT EXISTS auth_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL CHECK (purpose IN ('verify_email','reset_password')),
    token_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS email_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    to_email TEXT NOT NULL,
    purpose TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    link TEXT,
    sent_ok INTEGER NOT NULL DEFAULT 0,
    send_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS country_profiles (
    country_id INTEGER PRIMARY KEY REFERENCES countries(id) ON DELETE CASCADE,
    business_climate TEXT,
    culture TEXT,
    gastronomy TEXT,
    practical_tips TEXT,
    holidays TEXT
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    buyer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    seller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(listing_id, buyer_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    read_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_states_country ON states(country_id);
  CREATE INDEX IF NOT EXISTS idx_conversations_buyer ON conversations(buyer_id);
  CREATE INDEX IF NOT EXISTS idx_conversations_seller ON conversations(seller_id);
  CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id);
  CREATE INDEX IF NOT EXISTS idx_reports_listing ON reports(listing_id);
`);

export default db;
