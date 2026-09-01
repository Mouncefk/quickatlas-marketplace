// db.js — Couche base de données, basée sur le module natif node:sqlite (Node >= 22.5).
// Aucune dépendance externe n'est nécessaire : tout tourne avec Node seul.
//
// Architecture multi-site (réseau white-label) : la fonction
// initializeDatabase() ci-dessous crée/ouvre UNE base de données complète
// (schéma + migrations) — appelée une fois pour le site principal au
// démarrage, et de nouveau à chaque création d'un nouveau site client par
// le Super Administrateur. Chaque site a sa PROPRE base, totalement
// indépendante des autres (aucune donnée partagée entre sites, à
// l'exception du code lui-même). Voir tenantContext plus bas pour le
// mécanisme qui redirige automatiquement chaque requête vers la bonne
// base, sans toucher au reste du code existant.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
/** Copie les données de référence (pays, régions, villes, catégories,
 * sous-catégories) depuis une base source vers une base cible neuve —
 * utilisée à la création de chaque nouveau site du réseau, pour qu'il
 * démarre avec la même géographie et les mêmes catégories que le site
 * principal, plutôt qu'une base vide et inutilisable. Respecte l'ordre
 * des dépendances (pays avant régions/villes, catégories avant
 * sous-catégories) ; entièrement encadrée par une transaction — en cas
 * d'échec, rien n'est copié plutôt qu'une copie partielle incohérente.
 * Les identifiants sont préservés à l'identique (la base cible étant
 * neuve, aucun risque de collision). */
export function copyReferenceData(sourceDb, targetDb) {
  const tablesInOrder = ['countries', 'states', 'cities', 'categories', 'subcategories'];
  targetDb.exec('BEGIN IMMEDIATE');
  try {
    for (const table of tablesInOrder) {
      const columns = sourceDb.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      const columnList = columns.join(', ');
      const rows = sourceDb.prepare(`SELECT ${columnList} FROM ${table}`).all();
      if (rows.length === 0) continue;
      const placeholders = columns.map(() => '?').join(', ');
      const insertStmt = targetDb.prepare(`INSERT INTO ${table} (${columnList}) VALUES (${placeholders})`);
      for (const row of rows) {
        insertStmt.run(...columns.map((c) => row[c]));
      }
    }
    targetDb.exec('COMMIT');
  } catch (err) {
    targetDb.exec('ROLLBACK');
    throw err;
  }
}
export function initializeDatabase(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin','super_admin')),
    terms_accepted_at TEXT,
    email_verified_at TEXT,
    ai_provider TEXT CHECK (ai_provider IN ('anthropic','openai') OR ai_provider IS NULL),
    ai_api_key_encrypted TEXT,
    phone TEXT,
    referral_code TEXT UNIQUE,
    referred_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    free_boost_credits INTEGER NOT NULL DEFAULT 0,
    google_sub TEXT UNIQUE,
    is_professional INTEGER NOT NULL DEFAULT 0,
    company_name TEXT,
    company_logo_url TEXT,
    company_website TEXT,
    pro_tier TEXT NOT NULL DEFAULT 'nouveau' CHECK (pro_tier IN ('nouveau','actif','confirme','expert')),
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
    language TEXT NOT NULL DEFAULT 'fr',
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
  CREATE TABLE IF NOT EXISTS listing_translations (
    listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    lang_code TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (listing_id, lang_code)
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
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    country_id INTEGER NOT NULL REFERENCES countries(id) ON DELETE CASCADE,
    city_id INTEGER REFERENCES cities(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    event_date TEXT NOT NULL,
    end_date TEXT,
    location_name TEXT,
    external_link TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_events_country ON events(country_id, event_date);
  CREATE TABLE IF NOT EXISTS country_economic_stats (
    country_id INTEGER PRIMARY KEY REFERENCES countries(id) ON DELETE CASCADE,
    gdp_usd REAL,
    gdp_year INTEGER,
    gdp_per_capita_usd REAL,
    gdp_per_capita_year INTEGER,
    gdp_growth_pct REAL,
    gdp_growth_year INTEGER,
    unemployment_pct REAL,
    unemployment_year INTEGER,
    inflation_pct REAL,
    inflation_year INTEGER,
    fetch_status TEXT NOT NULL DEFAULT 'pending' CHECK (fetch_status IN ('pending','ok','error')),
    fetched_at TEXT
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
db.exec(`
  CREATE TABLE IF NOT EXISTS site_visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_site_visits_created ON site_visits(created_at);
`);
// Suivi de prospects (mini-CRM) — chaque conversation initiée par un
// acheteur au sujet d'une annonce devient automatiquement une fiche
// prospect suivie par le vendeur (voir la route POST /api/conversations
// dans server.js pour la création automatique). Permet aussi l'ajout
// manuel d'un prospect contacté hors plateforme (buyer_id alors NULL).
db.exec(`
  CREATE TABLE IF NOT EXISTS listing_leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    seller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    buyer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    contact_name TEXT,
    contact_phone TEXT,
    contact_email TEXT,
    source TEXT NOT NULL DEFAULT 'message' CHECK (source IN ('message','manual')),
    status TEXT NOT NULL DEFAULT 'nouveau' CHECK (status IN ('nouveau','contacte','visite_programmee','offre_faite','conclu','perdu')),
    notes TEXT,
    next_reminder_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_listing_leads_seller ON listing_leads(seller_id);
  CREATE INDEX IF NOT EXISTS idx_listing_leads_listing ON listing_leads(listing_id);
`);
// Migration : liens réseaux sociaux d'un compte professionnel (WhatsApp,
// Instagram, Facebook) — configurés par le professionnel lui-même dans
// ses réglages, jamais par l'administrateur du site à sa place. Servent
// à afficher des icônes cliquables sur son profil public et à enrichir
// la carte de partage générée pour ses annonces.
{
  const userColumns2 = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  const socialColumns = [
    ['social_whatsapp', 'TEXT'],
    ['social_instagram', 'TEXT'],
    ['social_facebook', 'TEXT'],
    ['social_tiktok', 'TEXT'],
    ['social_linkedin', 'TEXT'],
  ];
  for (const [name, type] of socialColumns) {
    if (!userColumns2.includes(name)) {
      db.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
    }
  }
}
// Migration : ajout de la colonne image_url à la table messages, pour
// permettre de joindre une photo à un message (façon Vinted/Avito).
// ALTER TABLE ne peut pas être conditionné par IF NOT EXISTS en SQLite —
// on vérifie donc d'abord via PRAGMA table_info si la colonne existe déjà,
// pour que cette migration reste sans danger à chaque redémarrage du
// serveur, y compris sur la base déjà en production.
{
  const messageColumns = db.prepare("PRAGMA table_info(messages)").all();
  if (!messageColumns.some((c) => c.name === 'image_url')) {
    db.exec('ALTER TABLE messages ADD COLUMN image_url TEXT');
  }
}
// Migration : ajout de la colonne is_secondhand à la table listings, pour
// distinguer un article d'occasion / de seconde main — filtre et badge
// affichés côté front, mais donnée stockée ici comme un simple booléen
// (même esprit que open_to_trade, déjà en place).
{
  const listingColumns = db.prepare("PRAGMA table_info(listings)").all();
  if (!listingColumns.some((c) => c.name === 'is_secondhand')) {
    db.exec('ALTER TABLE listings ADD COLUMN is_secondhand INTEGER NOT NULL DEFAULT 0');
  }
}
// Migration : ajout de date_start / date_end à la table listings — utilisées
// par la catégorie Tourisme & Voyages (dates d'un séjour, d'une excursion,
// d'une croisière...), mais le champ reste générique et pourrait servir à
// d'autres catégories à l'avenir. Stocké en texte au format ISO (AAAA-MM-JJ),
// nullable : la grande majorité des annonces n'en a pas besoin.
{
  const listingColumns = db.prepare("PRAGMA table_info(listings)").all();
  if (!listingColumns.some((c) => c.name === 'date_start')) {
    db.exec('ALTER TABLE listings ADD COLUMN date_start TEXT');
  }
  if (!listingColumns.some((c) => c.name === 'date_end')) {
    db.exec('ALTER TABLE listings ADD COLUMN date_end TEXT');
  }
}
// Migration : ajout de is_active à la table categories, pour permettre à
// l'administrateur de mettre une catégorie "en pause" (masquée du
// formulaire de publication et des filtres) sans la supprimer ni toucher
// aux annonces déjà publiées dessus, qui restent normalement visibles.
{
  const categoryColumns = db.prepare("PRAGMA table_info(categories)").all();
  if (!categoryColumns.some((c) => c.name === 'is_active')) {
    db.exec('ALTER TABLE categories ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1');
  }
}
// Migration : ajout de price_promo / price_type à la table listings — champs
// communs à toutes les sous-catégories Tourisme & Voyages (prix barré et
// unité de tarification : par nuit, par personne, par jour...). Nullable :
// n'importe quelle autre catégorie continue de fonctionner sans y toucher.
{
  const listingColumns = db.prepare("PRAGMA table_info(listings)").all();
  if (!listingColumns.some((c) => c.name === 'price_promo')) {
    db.exec('ALTER TABLE listings ADD COLUMN price_promo REAL');
  }
  if (!listingColumns.some((c) => c.name === 'price_type')) {
    db.exec('ALTER TABLE listings ADD COLUMN price_type TEXT');
  }
}
// Migration : table des exceptions catégorie/pays — une ligne présente
// signifie "cette catégorie est désactivée pour ce pays" (absence = active,
// comportement par défaut). Ne stocke que les exceptions, pas toutes les
// combinaisons possibles, pour rester léger même avec 196 pays.
db.exec(`
  CREATE TABLE IF NOT EXISTS category_country_exclusions (
    category_id INTEGER NOT NULL,
    country_id INTEGER NOT NULL,
    PRIMARY KEY (category_id, country_id)
  )
`);
// Migration : champs Hébergement (Tourisme & Voyages, Phase C1) — capacité
// voyageurs, chambres, salles de bain, équipements. Concernent uniquement
// les sous-catégories locations-vacances et hotellerie-insolite ; nullable
// pour toutes les autres annonces, qui n'y touchent jamais.
{
  const listingColumns = db.prepare("PRAGMA table_info(listings)").all();
  if (!listingColumns.some((c) => c.name === 'capacity_guests')) {
    db.exec('ALTER TABLE listings ADD COLUMN capacity_guests INTEGER');
  }
  if (!listingColumns.some((c) => c.name === 'bedrooms')) {
    db.exec('ALTER TABLE listings ADD COLUMN bedrooms INTEGER');
  }
  if (!listingColumns.some((c) => c.name === 'bathrooms')) {
    db.exec('ALTER TABLE listings ADD COLUMN bathrooms INTEGER');
  }
  if (!listingColumns.some((c) => c.name === 'amenities_json')) {
    db.exec('ALTER TABLE listings ADD COLUMN amenities_json TEXT');
  }
}
// Migration : affinage Tourisme (comparaison avec Airbnb/Booking/
// GetYourGuide/Viator) — répartition voyageurs plus précise pour
// l'hébergement (enfants distincts des adultes), et nouveaux champs
// dédiés aux activités/excursions, un pan du Tourisme jusqu'ici absent
// (visites guidées, excursions, cours...), distinct de l'hébergement.
// Toutes ces colonnes restent nullable, sans effet sur les autres
// catégories.
{
  const tourismColumns2 = db.prepare("PRAGMA table_info(listings)").all();
  const newTourismColumns = [
    ['capacity_children', 'INTEGER'],
    ['activity_duration', 'TEXT'],
    ['activity_group_size_min', 'INTEGER'],
    ['activity_group_size_max', 'INTEGER'],
    ['activity_languages', 'TEXT'],
    ['activity_meeting_point', 'TEXT'],
    ['activity_difficulty', 'TEXT'],
    ['activity_min_age', 'INTEGER'],
  ];
  for (const [name, type] of newTourismColumns) {
    if (!tourismColumns2.some((c) => c.name === name)) {
      db.exec(`ALTER TABLE listings ADD COLUMN ${name} ${type}`);
    }
  }
  // Nouvelle sous-catégorie "Activités & Excursions", au même titre que
  // locations-vacances et hotellerie-insolite déjà existantes.
  const tourismCategory = db.prepare("SELECT id FROM categories WHERE slug = 'tourisme-voyages'").get();
  if (tourismCategory) {
    db.prepare('INSERT OR IGNORE INTO subcategories (category_id, slug, name) VALUES (?, ?, ?)')
      .run(tourismCategory.id, 'activites-excursions', 'Activités & Excursions');
  }
}
// Migration : deuxième vague d'affinage Tourisme (comparaison
// approfondie avec Airbnb/Expedia/GetYourGuide) — type de logement et
// nombre de lits pour l'hébergement, inclus/non-inclus et prise en
// charge pour les activités, politique d'annulation partagée par les
// deux (même concept, un seul champ). Toutes nullable.
{
  const tourismColumns3 = db.prepare("PRAGMA table_info(listings)").all();
  const newTourismColumns2 = [
    ['property_room_type', 'TEXT'],
    ['num_beds', 'INTEGER'],
    ['cancellation_policy', 'TEXT'],
    ['activity_included', 'TEXT'],
    ['activity_excluded', 'TEXT'],
    ['activity_pickup_included', 'INTEGER'],
  ];
  for (const [name, type] of newTourismColumns2) {
    if (!tourismColumns3.some((c) => c.name === name)) {
      db.exec(`ALTER TABLE listings ADD COLUMN ${name} ${type}`);
    }
  }
}
// Migration : favoris pays et villes — permet un accès direct depuis
// l'accueil sans repasser par la carte, en plus (pas à la place) du
// parcours pays → ville déjà en place.
db.exec(`
  CREATE TABLE IF NOT EXISTS favorite_countries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    country_id INTEGER NOT NULL REFERENCES countries(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, country_id)
  );
  CREATE TABLE IF NOT EXISTS favorite_cities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    city_id INTEGER NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, city_id)
  );
`);
// Migration : is_demo signale une annonce fictive injectée à des fins de
// démonstration — jamais mélangée aux vraies annonces sans un indicateur
// visuel clair (filigrane sur la carte et la fiche).
{
  const listingColumns = db.prepare("PRAGMA table_info(listings)").all();
  if (!listingColumns.some((c) => c.name === 'is_demo')) {
    db.exec('ALTER TABLE listings ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0');
  }
}
// Migration : demandes de villes manquantes — un visiteur signale une ville
// absente de la liste ; l'admin peut la marquer "activée" une fois la ville
// réellement ajoutée, ce qui déclenche un email de notification.
db.exec(`
  CREATE TABLE IF NOT EXISTS city_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    country_id INTEGER NOT NULL REFERENCES countries(id) ON DELETE CASCADE,
    city_name TEXT NOT NULL,
    email TEXT NOT NULL,
    message TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    notified_at TEXT
  );
`);
// Migration : state_id sur city_requests, pour les pays fédéraux — la table
// existait déjà avant cet ajout, d'où l'ALTER séparé (idempotent) plutôt
// que d'ajouter la colonne directement dans le CREATE TABLE ci-dessus.
{
  const cityRequestColumns = db.prepare("PRAGMA table_info(city_requests)").all();
  if (!cityRequestColumns.some((c) => c.name === 'state_id')) {
    db.exec('ALTER TABLE city_requests ADD COLUMN state_id INTEGER REFERENCES states(id)');
  }
}
// Migration : cachet "Vendu" / "Loué" — le propriétaire de l'annonce peut
// marquer sa transaction comme aboutie, sans que ça affecte le statut
// d'expiration normal de l'annonce (une annonce vendue reste visible avec
// son cachet, jusqu'à son expiration naturelle ou sa suppression manuelle).
{
  const listingColumns = db.prepare("PRAGMA table_info(listings)").all();
  if (!listingColumns.some((c) => c.name === 'transaction_completed')) {
    db.exec('ALTER TABLE listings ADD COLUMN transaction_completed INTEGER NOT NULL DEFAULT 0');
  }
}
// Migration : langue préférée de l'utilisateur, capturée à l'inscription
// (parmi les langues pleinement actives sur le site) — utilisée pour
// personnaliser les emails automatiques, à commencer par l'email de
// bienvenue.
{
  const userColumns = db.prepare("PRAGMA table_info(users)").all();
  if (!userColumns.some((c) => c.name === 'language')) {
    db.exec("ALTER TABLE users ADD COLUMN language TEXT NOT NULL DEFAULT 'fr'");
  }
}
// Réglages généraux du site, sous forme clé/valeur — commence avec le logo
// personnalisé, réutilisable plus tard pour d'autres réglages globaux sans
// nouvelle migration de schéma à chaque fois.
db.exec(`
  CREATE TABLE IF NOT EXISTS site_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);
// Migration : champs spécifiques à la catégorie Véhicules (marque, modèle,
// année, kilométrage, état, transmission, carburant) — première étape d'un
// effort progressif pour détailler chaque catégorie, comme ça avait déjà
// été fait pour le Tourisme (Hébergement).
{
  const listingColumns2 = db.prepare("PRAGMA table_info(listings)").all();
  const vehicleColumns = [
    ['vehicle_brand', 'TEXT'],
    ['vehicle_model', 'TEXT'],
    ['vehicle_year', 'INTEGER'],
    ['vehicle_mileage', 'INTEGER'],
    ['vehicle_condition', 'TEXT'],
    ['vehicle_transmission', 'TEXT'],
    ['vehicle_fuel_type', 'TEXT'],
  ];
  for (const [name, type] of vehicleColumns) {
    if (!listingColumns2.some((c) => c.name === name)) {
      db.exec(`ALTER TABLE listings ADD COLUMN ${name} ${type}`);
    }
  }
}
// Boîte de réception admin — emails reçus sur contact@quickatlas.net,
// synchronisés périodiquement via IMAP (voir checkInboxEmails côté
// serveur). uid = identifiant IMAP du message, utilisé pour éviter les
// doublons d'une synchronisation à l'autre.
db.exec(`
  CREATE TABLE IF NOT EXISTS inbox_emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid INTEGER UNIQUE NOT NULL,
    from_address TEXT NOT NULL,
    from_name TEXT,
    subject TEXT,
    body_text TEXT,
    received_at TEXT NOT NULL,
    is_read INTEGER NOT NULL DEFAULT 0,
    replied INTEGER NOT NULL DEFAULT 0
  );
`);
// Migration : version HTML du corps de l'email — les emails automatiques
// (notifications de réseaux sociaux, newsletters) ont souvent une version
// texte brut illisible (pleine de liens de suivi), alors que la version
// HTML s'affiche normalement comme dans une vraie messagerie.
{
  const inboxColumns = db.prepare("PRAGMA table_info(inbox_emails)").all();
  if (!inboxColumns.some((c) => c.name === 'body_html')) {
    db.exec('ALTER TABLE inbox_emails ADD COLUMN body_html TEXT');
  }
}
// Migration : marque les emails récupérés depuis le dossier Spam plutôt
// que la boîte de réception normale — pour ne rien manquer (un vrai
// prospect peut y atterrir par erreur), tout en gardant la distinction
// visible côté admin. Leur uid est stocké en négatif (voir
// checkInboxEmails) pour ne jamais entrer en collision avec un uid réel
// de la boîte de réception, la colonne uid étant UNIQUE.
{
  const spamColumns = db.prepare("PRAGMA table_info(inbox_emails)").all();
  if (!spamColumns.some((c) => c.name === 'from_spam')) {
    db.exec('ALTER TABLE inbox_emails ADD COLUMN from_spam INTEGER NOT NULL DEFAULT 0');
  }
}
// Migration : traçabilité des messages envoyés depuis l'admin (réponses et
// compositions libres) — jusqu'ici, un message envoyé disparaissait de
// l'écran sans laisser de trace. direction distingue reçu/envoyé,
// to_address est le destinataire d'un message envoyé, in_reply_to_id relie
// une réponse à l'email reçu d'origine (pour afficher un vrai fil).
{
  const inboxColumns2 = db.prepare("PRAGMA table_info(inbox_emails)").all();
  const sentTrackingColumns = [
    ['direction', "TEXT NOT NULL DEFAULT 'received'"],
    ['to_address', 'TEXT'],
    ['in_reply_to_id', 'INTEGER REFERENCES inbox_emails(id)'],
  ];
  for (const [name, def] of sentTrackingColumns) {
    if (!inboxColumns2.some((c) => c.name === name)) {
      db.exec(`ALTER TABLE inbox_emails ADD COLUMN ${name} ${def}`);
    }
  }
  // uid est NOT NULL en base, mais les messages envoyés n'ont pas d'UID
  // IMAP réel — on en génère un négatif unique pour respecter la
  // contrainte sans jamais entrer en conflit avec un vrai UID (toujours
  // positif).
}
// Migration : préférence de visibilité publique du numéro de téléphone —
// activée par défaut pour ne rien changer au comportement des comptes
// existants (le numéro était jusqu'ici toujours visible dès qu'il était
// renseigné). L'utilisateur peut la désactiver à tout moment depuis son
// profil, sans jamais perdre le numéro lui-même.
{
  const userColumns = db.prepare("PRAGMA table_info(users)").all();
  if (!userColumns.some((c) => c.name === 'show_phone_publicly')) {
    db.exec('ALTER TABLE users ADD COLUMN show_phone_publicly INTEGER NOT NULL DEFAULT 1');
  }
}
// Migration : champs spécifiques à la catégorie Immobilier (type de bien,
// surface, pièces, étage, meublé, année de construction) — tous optionnels,
// même principe que Véhicules.
{
  const listingColumns3 = db.prepare("PRAGMA table_info(listings)").all();
  const realEstateColumns = [
    ['surface_m2', 'REAL'],
    ['num_rooms', 'INTEGER'],
    ['floor_number', 'TEXT'],
    ['furnished', 'TEXT'],
    ['construction_year', 'INTEGER'],
  ];
  for (const [name, type] of realEstateColumns) {
    if (!listingColumns3.some((c) => c.name === name)) {
      db.exec(`ALTER TABLE listings ADD COLUMN ${name} ${type}`);
    }
  }
}
// Migration : champs spécifiques à la catégorie Emploi (type de contrat,
// télétravail, expérience et niveau d'études requis/recherchés, secteur
// d'activité) — communs aux offres et demandes d'emploi. job_cv_url ne
// concerne que les demandes d'emploi (CV du candidat joint à l'annonce).
{
  const listingColumns4 = db.prepare("PRAGMA table_info(listings)").all();
  const jobColumns = [
    ['job_contract_type', 'TEXT'],
    ['job_remote_type', 'TEXT'],
    ['job_experience_level', 'TEXT'],
    ['job_education_level', 'TEXT'],
    ['job_sector', 'TEXT'],
    ['job_cv_url', 'TEXT'],
  ];
  for (const [name, type] of jobColumns) {
    if (!listingColumns4.some((c) => c.name === name)) {
      db.exec(`ALTER TABLE listings ADD COLUMN ${name} ${type}`);
    }
  }
}
// Migration : autorise le rôle 'super_admin' (réseau multi-site) sur la
// table users. SQLite ne permet pas de modifier une contrainte CHECK
// directement — la seule méthode sûre est de reconstruire la table avec
// le nouveau schéma, copier les données telles quelles (mêmes id, donc
// aucune clé étrangère d'aucune autre table n'est affectée), puis
// basculer. Opération protégée : ne s'exécute que si la contrainte
// actuelle ne mentionne pas encore 'super_admin', et entièrement
// encadrée par une transaction — en cas d'échec à n'importe quelle
// étape, la table users d'origine reste intacte.
{
  const usersTableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
  if (usersTableSql && !usersTableSql.sql.includes('super_admin')) {
    const usersColumns = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
    const columnList = usersColumns.join(', ');
    const newUsersSql = usersTableSql.sql
      .replace(/CHECK\s*\(role IN \('user','admin'\)\)/, "CHECK (role IN ('user','admin','super_admin'))")
      .replace(/CREATE TABLE users/, 'CREATE TABLE users_rebuild');
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(newUsersSql);
      db.exec(`INSERT INTO users_rebuild (${columnList}) SELECT ${columnList} FROM users`);
      const oldCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
      const newCount = db.prepare('SELECT COUNT(*) AS c FROM users_rebuild').get().c;
      if (oldCount !== newCount) {
        throw new Error(`Migration users_rebuild : nombre de lignes différent (${oldCount} avant, ${newCount} après) — annulation.`);
      }
      db.exec('DROP TABLE users');
      db.exec('ALTER TABLE users_rebuild RENAME TO users');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      console.error('[db] Échec de la migration super_admin sur users, table d\'origine conservée intacte :', err.message);
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
}
// Géolocalisation des vues — table dédiée pour tracer l'origine
// géographique (pays/ville uniquement, jamais l'adresse IP elle-même,
// par souci de vie privée) de chaque consultation d'annonce. Alimente le
// tableau de bord professionnel (répartition géographique des visiteurs).
db.exec(`
  CREATE TABLE IF NOT EXISTS listing_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id INTEGER NOT NULL,
    country TEXT,
    city TEXT,
    viewed_at TEXT NOT NULL,
    FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_listing_views_listing ON listing_views(listing_id);`);
// Migration : origine d'une visite (vue d'annonce ou visite du site) —
// permet de distinguer une visite venue d'un lien de partage tracé
// (réseaux sociaux) du trafic normal. NULL = origine inconnue/normale,
// 'share' = venue d'un lien copié via le bouton de partage tracé.
// Placée ici (après la création de listing_views et site_visits toutes
// deux définies plus haut) — une erreur de positionnement précédente la
// faisait s'exécuter avant que listing_views existe, cassant la
// création de tout nouveau site.
{
  const listingViewsColumns = db.prepare("PRAGMA table_info(listing_views)").all().map((c) => c.name);
  if (!listingViewsColumns.includes('source')) {
    db.exec('ALTER TABLE listing_views ADD COLUMN source TEXT');
  }
  const siteVisitsColumns = db.prepare("PRAGMA table_info(site_visits)").all().map((c) => c.name);
  if (!siteVisitsColumns.includes('source')) {
    db.exec('ALTER TABLE site_visits ADD COLUMN source TEXT');
  }
}
  // Journal des actions administrateur sensibles (changement de rôle,
  // suppression d'utilisateur...) — trace qui a fait quoi et quand, utile
  // en cas de problème pour comprendre ce qui s'est passé. Alimenté via
  // logAdminAction() dans server.js, uniquement sur les actions les plus
  // sensibles pour l'instant.
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_user_id INTEGER,
      admin_email TEXT,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // Catégories DÉSACTIVÉES pour ce site (réseau multisite) — une table
  // vide signifie "tout activé", le filet de sécurité voulu : un
  // nouveau site fonctionne pleinement tant que le Super Admin n'a pas
  // volontairement restreint son périmètre selon l'accord commercial
  // passé avec le loueur. Gérée exclusivement depuis le panneau Super
  // Admin (voir server.js) — jamais modifiable par l'administrateur du
  // site lui-même, puisque le périmètre activé correspond à ce que le
  // client paie, pas à une préférence d'affichage.
  db.exec(`
    CREATE TABLE IF NOT EXISTS disabled_categories (
      category_id INTEGER PRIMARY KEY REFERENCES categories(id) ON DELETE CASCADE
    );
  `);
  // Même principe que disabled_categories ci-dessus, appliqué cette fois
  // aux pays — permet de restreindre un site à une zone géographique
  // précise (ex. "véhicules, uniquement au Maroc"), selon exactement la
  // même logique : table vide = tout activé, gestion exclusivement
  // réservée au Super Admin.
  db.exec(`
    CREATE TABLE IF NOT EXISTS disabled_countries (
      country_id INTEGER PRIMARY KEY REFERENCES countries(id) ON DELETE CASCADE
    );
  `);
  // Migration : nouvelles sous-catégories immobilier (retour utilisateurs
  // de l'entourage du propriétaire — plus de détail que la liste
  // d'origine). INSERT OR IGNORE s'appuie sur la contrainte
  // UNIQUE(category_id, slug) pour rester idempotent : sans effet si déjà
  // présentes (site déjà migré, ou nouveau site les recevant directement
  // via copyReferenceData).
  {
    const immoCategory = db.prepare("SELECT id FROM categories WHERE slug = 'immobilier'").get();
    if (immoCategory) {
      const newSubcategories = [
        ['studio', 'Studio'],
        ['riad', 'Riad'],
        ['terrain-agricole', 'Terrain agricole'],
      ];
      const insertSub = db.prepare('INSERT OR IGNORE INTO subcategories (category_id, slug, name) VALUES (?, ?, ?)');
      for (const [slug, name] of newSubcategories) {
        insertSub.run(immoCategory.id, slug, name);
      }
    }
  }
  // Migration : visibilité multi-ville d'une annonce — un utilisateur
  // renseigne d'abord la ville réelle du bien (city_id, toujours
  // obligatoire, inchangé), puis peut choisir d'étendre la visibilité de
  // son annonce à des villes supplémentaires de son choix
  // (listing_extra_cities), ou à toutes les villes du même pays
  // (visible_all_cities).
  //
  // listing_visible_cities est une table CALCULÉE (pas saisie
  // directement) : elle liste, pour chaque annonce, l'ensemble des
  // villes où elle doit apparaître (ville réelle + villes
  // supplémentaires + toutes les villes du pays si activé), reconstruite
  // à chaque publication/modification via syncListingVisibleCities()
  // dans server.js. Toutes les recherches/parcours par ville
  // s'appuient sur CETTE table plutôt que de reproduire cette logique
  // (ville réelle OU ville supplémentaire OU pays entier) dans chacune
  // des nombreuses requêtes existantes — un simple JOIN, plus rapide et
  // bien plus simple à maintenir que de dupliquer cette condition
  // partout.
  {
    const listingColumns5 = db.prepare("PRAGMA table_info(listings)").all();
    if (!listingColumns5.some((c) => c.name === 'visible_all_cities')) {
      db.exec('ALTER TABLE listings ADD COLUMN visible_all_cities INTEGER NOT NULL DEFAULT 0');
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS listing_extra_cities (
      listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
      city_id INTEGER NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
      PRIMARY KEY (listing_id, city_id)
    );
    CREATE TABLE IF NOT EXISTS listing_visible_cities (
      listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
      city_id INTEGER NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
      PRIMARY KEY (listing_id, city_id)
    );
    CREATE INDEX IF NOT EXISTS idx_listing_visible_cities_city ON listing_visible_cities(city_id);
  `);
  // Pays supplémentaires entiers — spécifique au Tourisme, transfrontalier
  // par nature (un circuit ou une agence peut viser plusieurs pays à la
  // fois). Sélectionner un pays ici rend l'annonce visible dans TOUTES
  // ses villes, sans restriction au pays réel du bien (contrairement aux
  // villes/pays supplémentaires des autres catégories). Pris en compte
  // par syncListingVisibleCities() au même titre que le reste.
  db.exec(`
    CREATE TABLE IF NOT EXISTS listing_extra_countries (
      listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
      country_id INTEGER NOT NULL REFERENCES countries(id) ON DELETE CASCADE,
      PRIMARY KEY (listing_id, country_id)
    );
  `);
  return db;
}

// ---------- Registre central des sites (réseau multi-site) ----------
// Petite base séparée, indépendante des bases de contenu (une par site),
// qui liste tous les sites existants : leur(s) domaine(s), le fichier de
// base associé, leur statut. C'est elle qui permet de savoir, pour un
// domaine visité donné, quelle base de contenu activer.
export const masterDb = initializeMasterDatabase(path.join(DATA_DIR, 'master.db'));
function initializeMasterDatabase(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS sites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      subdomain TEXT UNIQUE,
      custom_domain TEXT UNIQUE,
      db_filename TEXT NOT NULL UNIQUE,
      brand_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
      owner_email TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      billing_status TEXT NOT NULL DEFAULT 'trial' CHECK (billing_status IN ('trial','active','overdue','cancelled')),
      billing_plan_label TEXT,
      billing_notes TEXT,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      plan_id INTEGER REFERENCES plans(id),
      grace_period_ends_at TEXT,
      -- Site de démonstration auto-provisionné depuis une réservation
      -- pré-lancement (voir site_reservations) — NULL pour un site
      -- normal. Supprimé automatiquement à l'échéance par la tâche
      -- quotidienne checkDemoExpirations(), sauf prolongation manuelle
      -- depuis le panneau Réservations.
      demo_expires_at TEXT
    );
    CREATE TABLE IF NOT EXISTS plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      price_amount REAL,
      price_currency TEXT NOT NULL DEFAULT 'EUR',
      billing_interval TEXT NOT NULL DEFAULT 'monthly' CHECK (billing_interval IN ('monthly','yearly')),
      max_categories INTEGER,
      description TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_user_id INTEGER,
      admin_email TEXT,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS daily_site_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      user_count INTEGER NOT NULL,
      listing_count INTEGER NOT NULL,
      active_listing_count INTEGER NOT NULL,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(site_id, date)
    );
  `);
  // Migration : ajoute les colonnes de suivi de facturation (statut,
  // formule, notes, identifiants Stripe réservés pour une intégration
  // future) sur un registre déjà existant — CREATE TABLE IF NOT EXISTS
  // ne les ajoute qu'aux tout nouveaux registres, pas à celui déjà en
  // place. Simples colonnes nullables ajoutées une par une, sans risque
  // pour les données déjà présentes.
  {
    const sitesColumns = db.prepare("PRAGMA table_info(sites)").all().map((c) => c.name);
    const billingColumns = [
      ["billing_status", "TEXT NOT NULL DEFAULT 'trial'"],
      ['billing_plan_label', 'TEXT'],
      ['billing_notes', 'TEXT'],
      ['stripe_customer_id', 'TEXT'],
      ['stripe_subscription_id', 'TEXT'],
      ['plan_id', 'INTEGER'],
      ['grace_period_ends_at', 'TEXT'],
      ['demo_expires_at', 'TEXT'],
    ];
    for (const [name, type] of billingColumns) {
      if (!sitesColumns.includes(name)) {
        db.exec(`ALTER TABLE sites ADD COLUMN ${name} ${type}`);
      }
    }
    // La table plans elle-même (CREATE TABLE IF NOT EXISTS ci-dessus ne
    // s'applique qu'à un registre tout neuf) — même logique de migration
    // que pour les colonnes.
    db.exec(`
      CREATE TABLE IF NOT EXISTS plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        price_amount REAL,
        price_currency TEXT NOT NULL DEFAULT 'EUR',
        billing_interval TEXT NOT NULL DEFAULT 'monthly' CHECK (billing_interval IN ('monthly','yearly')),
        max_categories INTEGER,
        description TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    // Réservations de sous-domaine avant lancement officiel — gratuites,
    // sans engagement : juste une demande enregistrée, sans compte ni
    // base de données créée. Convertie plus tard en vrai site via le
    // formulaire habituel de création, pré-rempli à partir de ces
    // informations.
    db.exec(`
      CREATE TABLE IF NOT EXISTS site_reservations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subdomain TEXT NOT NULL UNIQUE,
        business_name TEXT NOT NULL,
        sector TEXT,
        contact_email TEXT NOT NULL,
        contact_phone TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','converted','declined')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    // Campagnes d'emailing intégrées, avec traçabilité — solution
    // interne plutôt qu'un service externe (Listmonk/Mautic), cohérente
    // avec le reste du réseau. Une campagne cible un ensemble de
    // réservations (par statut) ; chaque destinataire a son propre
    // jeton de suivi, permettant de savoir individuellement qui a
    // ouvert l'email et cliqué sur le lien, sans dépendre d'un tiers.
    db.exec(`
      CREATE TABLE IF NOT EXISTS email_campaigns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject TEXT NOT NULL,
        message TEXT NOT NULL,
        cta_label TEXT,
        cta_url TEXT,
        audience_filter TEXT NOT NULL DEFAULT 'pending',
        recipient_count INTEGER NOT NULL DEFAULT 0,
        sent_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS email_campaign_recipients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL REFERENCES email_campaigns(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        tracking_token TEXT NOT NULL UNIQUE,
        open_count INTEGER NOT NULL DEFAULT 0,
        first_opened_at TEXT,
        click_count INTEGER NOT NULL DEFAULT 0,
        first_clicked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_campaign_recipients_campaign ON email_campaign_recipients(campaign_id);
      CREATE INDEX IF NOT EXISTS idx_campaign_recipients_token ON email_campaign_recipients(tracking_token);
    `);
  }
  // Le site principal (celui déjà en place) figure lui-même comme
  // première entrée du registre, avec quickatlas.net comme domaine
  // personnalisé — ainsi, le mécanisme de résolution par domaine (voir
  // server.js) fonctionne de façon uniforme pour tous les sites, y
  // compris le site principal, sans cas particulier dans le code.
  const mainSiteExists = db.prepare('SELECT id FROM sites WHERE slug = ?').get('main');
  if (!mainSiteExists) {
    db.prepare(
      `INSERT INTO sites (slug, custom_domain, db_filename, brand_name, status) VALUES (?, ?, ?, ?, 'active')`
    ).run('main', 'quickatlas.net', 'atlas.db', 'QuickAtlas');
  }
  return db;
}

// ---------- Routage multi-site (AsyncLocalStorage) ----------
// Cache en mémoire des connexions déjà ouvertes, pour ne jamais rouvrir
// une base déjà utilisée — un fichier SQLite par site, ouvert une seule
// fois puis réutilisé pour toutes les requêtes suivantes de ce site.
const openTenantDatabases = new Map();
export function getTenantDatabase(dbFilename) {
  if (openTenantDatabases.has(dbFilename)) return openTenantDatabases.get(dbFilename);
  const opened = initializeDatabase(path.join(DATA_DIR, dbFilename));
  openTenantDatabases.set(dbFilename, opened);
  return opened;
}
/** Ferme proprement la connexion à la base d'un site et la retire du
 * cache — étape indispensable avant de supprimer le fichier physique
 * (suppression définitive d'un site), pour éviter toute connexion
 * orpheline vers un fichier qui n'existe plus. Sans effet si la base
 * n'était pas ouverte (site jamais visité depuis le démarrage). */
export function closeTenantDatabase(dbFilename) {
  const opened = openTenantDatabases.get(dbFilename);
  if (opened) {
    opened.close();
    openTenantDatabases.delete(dbFilename);
  }
}
/** Contexte actif pour la durée d'une requête HTTP : quelle base de
 * données (quel site) est concernée. Rempli tout au début du traitement
 * de chaque requête, dans server.js — voir resolveSiteForRequest(). */
export const tenantContext = new AsyncLocalStorage();
/** Contexte séparé retenant, pour la durée d'une requête, quel site
 * (au sens du registre — slug, domaine, statut) est concerné — utile
 * pour restreindre certaines routes (comme le panneau Super
 * Administrateur) au seul site principal, indépendamment de quelle
 * base de données est active. */
export const siteInfoContext = new AsyncLocalStorage();
/** Proxy transparent : chaque appel db.prepare(...), db.exec(...), etc.
 * utilisé dans le reste du code (des centaines d'endroits dans
 * server.js) est automatiquement redirigé vers la base du site actif de
 * la requête en cours — aucune des requêtes SQL existantes n'a besoin
 * d'être modifiée pour devenir compatible multi-site. */
export const db = new Proxy({}, {
  get(target, prop) {
    const current = tenantContext.getStore();
    if (!current) {
      throw new Error(
        `[db] Aucune base de données active pour cette requête (propriété demandée : ${String(prop)}). ` +
        'Le contexte multi-site (tenantContext.run) doit être défini avant tout accès à "db".'
      );
    }
    const value = current[prop];
    return typeof value === 'function' ? value.bind(current) : value;
  },
});
// Base du site principal — ouverte une fois au démarrage, comme avant.
// Sert aussi de filet de sécurité : si un domaine visité n'est reconnu
// par aucun site du registre, on retombe automatiquement sur cette base
// plutôt que de faire échouer la requête.
export const mainDb = getTenantDatabase('atlas.db');
