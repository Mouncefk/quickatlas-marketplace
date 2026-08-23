// server.js — Serveur HTTP natif (aucune dépendance externe : pas d'Express).
// Sert le front-end statique et expose une API REST JSON sous /api.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, DATA_DIR } from './db.js';
import { hashPassword, verifyPassword, signToken, verifyToken, generateRawToken, hashRawToken, passwordIssues, encryptApiKey, decryptApiKey } from './auth.js';
import { sendMail } from './mailer.js';
import { translateListing, draftListing, analyzeFraudRisk, translateText } from './ai.js';
import { translateListingFree } from './free-translate.js';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = process.env.PORT || 3000;
const SITE_URL = process.env.SITE_URL || `http://localhost:${PORT}`;
const PLATFORM_AI_PROVIDER = process.env.PLATFORM_AI_PROVIDER || 'anthropic';
const PLATFORM_AI_API_KEY = process.env.PLATFORM_AI_API_KEY || null;
function slugify(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
let indexHtmlCache = null;
function getIndexHtmlTemplate() {
  if (!indexHtmlCache) indexHtmlCache = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  return indexHtmlCache;
}
function renderHtmlWithMeta({ title, description, canonicalPath, image, jsonLd }) {
  let html = getIndexHtmlTemplate();
  const canonicalUrl = `${SITE_URL}${canonicalPath || '/'}`;
  const safeTitle = title.replace(/</g, '&lt;');
  const safeDesc = description.replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const img = image || `${SITE_URL}/icons/icon-512.png`;
  html = html.replace(/<title>.*?<\/title>/, `<title>${safeTitle}</title>`);
  html = html.replace(/<meta name="description" content=".*?" \/>/, `<meta name="description" content="${safeDesc}" />`);
  // Données structurées schema.org — aident Google à afficher des extraits
  // enrichis (prix, fil d'Ariane) directement dans les résultats de
  // recherche. `jsonLd` est un tableau d'objets, sérialisé un par un dans
  // sa propre balise <script>, pour rester lisible et facile à déboguer.
  const jsonLdTags = (jsonLd || [])
    .map((obj) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`)
    .join('\n');
  const extraTags = `
<link rel="canonical" href="${canonicalUrl}" />
<meta property="og:type" content="website" />
<meta property="og:title" content="${safeTitle}" />
<meta property="og:description" content="${safeDesc}" />
<meta property="og:url" content="${canonicalUrl}" />
<meta property="og:image" content="${img}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${safeTitle}" />
<meta name="twitter:description" content="${safeDesc}" />
${jsonLdTags}
`;
  html = html.replace('</head>', `${extraTags}</head>`);
  return html;
}
/** Construit un fil d'Ariane structuré (BreadcrumbList) à partir d'une
 * liste ordonnée de { name, path } — réutilisé par les pages pays, ville
 * et catégorie. Le dernier élément n'a pas de lien (c'est la page actuelle). */
function breadcrumbJsonLd(items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      item: item.path ? `${SITE_URL}${item.path}` : undefined,
    })),
  };
}
function sendHtml(res, html) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
  res.end(html);
}
const loginAttempts = new Map();
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 8_000_000) {
        reject(new Error('Corps de requête trop volumineux'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('JSON invalide'));
      }
    });
    req.on('error', reject);
  });
}
function getAuthUser(req) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const payload = verifyToken(token);
  if (!payload) return null;
  return db.prepare('SELECT id, name, email, role, email_verified_at, phone, referral_code, free_boost_credits, is_professional, company_name, company_logo_url, company_website, pro_tier, created_at FROM users WHERE id = ?').get(payload.sub) || null;
}
function requireAuth(req, res) {
  const user = getAuthUser(req);
  if (!user) {
    sendJSON(res, 401, { error: 'Authentification requise' });
    return null;
  }
  return user;
}
function requireAdmin(req, res) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (user.role !== 'admin') {
    sendJSON(res, 403, { error: 'Réservé aux administrateurs.' });
    return null;
  }
  return user;
}
function requireVerifiedEmail(user, res) {
  if (!user.email_verified_at) {
    sendJSON(res, 403, { error: 'EMAIL_NOT_VERIFIED' });
    return false;
  }
  return true;
}
const WORLD_BANK_INDICATORS = {
  gdp: 'NY.GDP.MKTP.CD',
  gdp_per_capita: 'NY.GDP.PCAP.CD',
  gdp_growth: 'NY.GDP.MKTP.KD.ZG',
  unemployment: 'SL.UEM.TOTL.ZS',
  inflation: 'FP.CPI.TOTL.ZG',
};
async function fetchWorldBankIndicator(iso2, indicatorCode) {
  const url = `https://api.worldbank.org/v2/country/${iso2}/indicator/${indicatorCode}?format=json&mrnev=1`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const json = await res.json();
    const point = json?.[1]?.[0];
    if (!point || point.value === null || point.value === undefined) return null;
    return { value: point.value, year: Number(point.date) };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
async function refreshEconomicStats(countryId, iso2) {
  const results = {};
  for (const [key, code] of Object.entries(WORLD_BANK_INDICATORS)) {
    results[key] = await fetchWorldBankIndicator(iso2, code);
  }
  const anySuccess = Object.values(results).some((r) => r !== null);
  db.prepare(
    `INSERT INTO country_economic_stats
       (country_id, gdp_usd, gdp_year, gdp_per_capita_usd, gdp_per_capita_year, gdp_growth_pct, gdp_growth_year,
        unemployment_pct, unemployment_year, inflation_pct, inflation_year, fetch_status, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(country_id) DO UPDATE SET
       gdp_usd = excluded.gdp_usd, gdp_year = excluded.gdp_year,
       gdp_per_capita_usd = excluded.gdp_per_capita_usd, gdp_per_capita_year = excluded.gdp_per_capita_year,
       gdp_growth_pct = excluded.gdp_growth_pct, gdp_growth_year = excluded.gdp_growth_year,
       unemployment_pct = excluded.unemployment_pct, unemployment_year = excluded.unemployment_year,
       inflation_pct = excluded.inflation_pct, inflation_year = excluded.inflation_year,
       fetch_status = excluded.fetch_status, fetched_at = excluded.fetched_at`
  ).run(
    countryId,
    results.gdp?.value ?? null, results.gdp?.year ?? null,
    results.gdp_per_capita?.value ?? null, results.gdp_per_capita?.year ?? null,
    results.gdp_growth?.value ?? null, results.gdp_growth?.year ?? null,
    results.unemployment?.value ?? null, results.unemployment?.year ?? null,
    results.inflation?.value ?? null, results.inflation?.year ?? null,
    anySuccess ? 'ok' : 'error'
  );
  return db.prepare('SELECT * FROM country_economic_stats WHERE country_id = ?').get(countryId);
}
const ECONOMIC_STATS_MAX_AGE_DAYS = 30;
async function getEconomicStats(countryId, iso2) {
  const cached = db.prepare('SELECT * FROM country_economic_stats WHERE country_id = ?').get(countryId);
  const isStale = !cached || !cached.fetched_at || (Date.now() - new Date(cached.fetched_at + 'Z').getTime()) / 86400000 > ECONOMIC_STATS_MAX_AGE_DAYS;
  if (!isStale) return cached;
  try {
    return await refreshEconomicStats(countryId, iso2);
  } catch {
    return cached || { fetch_status: 'error' };
  }
}
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
};
function serveStatic(req, res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Interdit');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, indexData) => {
        if (err2) {
          res.writeHead(404);
          return res.end('Introuvable');
        }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(indexData);
      });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}
function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function generateReferralCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}
const PRO_TIERS = [
  { key: 'expert', threshold: 30 },
  { key: 'confirme', threshold: 15 },
  { key: 'actif', threshold: 5 },
  { key: 'nouveau', threshold: 0 },
];
const TIER_ORDER = { nouveau: 0, actif: 1, confirme: 2, expert: 3 };
function computeProTier(listingCount) {
  for (const t of PRO_TIERS) {
    if (listingCount >= t.threshold) return t.key;
  }
  return 'nouveau';
}
function isDomainVerified(email, website) {
  if (!website || !email) return false;
  try {
    const emailDomain = email.split('@')[1]?.toLowerCase();
    const websiteDomain = new URL(website.startsWith('http') ? website : `https://${website}`).hostname.replace(/^www\./, '').toLowerCase();
    return !!emailDomain && emailDomain === websiteDomain;
  } catch {
    return false;
  }
}
function checkAndAwardTierBonus(userId) {
  const user = db.prepare('SELECT pro_tier, is_professional FROM users WHERE id = ?').get(userId);
  if (!user || !user.is_professional) return null;
  const listingCount = db.prepare('SELECT COUNT(*) AS c FROM listings WHERE user_id = ?').get(userId).c;
  const newTier = computeProTier(listingCount);
  if (TIER_ORDER[newTier] > TIER_ORDER[user.pro_tier]) {
    db.prepare('UPDATE users SET pro_tier = ?, free_boost_credits = free_boost_credits + 1 WHERE id = ?').run(newTier, userId);
    return newTier;
  }
  return null;
}
function sortClause(sort) {
  const boostFirst = "(l.boosted_until IS NOT NULL AND l.boosted_until > datetime('now')) DESC";
  switch (sort) {
    case 'price_asc': return `${boostFirst}, l.price ASC`;
    case 'price_desc': return `${boostFirst}, l.price DESC`;
    case 'oldest': return `${boostFirst}, l.created_at ASC`;
    default: return `${boostFirst}, l.created_at DESC`;
  }
}
// Mots-clés distinctifs par catégorie (français uniquement pour l'instant),
// utilisés pour repérer une annonce dont le titre/la description évoque
// clairement une autre catégorie que celle sélectionnée par l'auteur —
// signe fréquent d'une erreur de saisie ou d'une annonce trompeuse.
const CATEGORY_KEYWORDS_FR = {
  immobilier: ['appartement', 'studio', 'duplex', 'villa', 'chambre à louer', 'mètres carrés', 'loyer', 'copropriété', 'terrain constructible', 'lotissement'],
  vehicules: ['voiture', 'véhicule', 'kilométrage', 'boîte automatique', 'carte grise', 'chevaux fiscaux', 'moto', 'scooter', '4x4', 'camion', 'essence', 'diesel'],
  mode: ['robe', 'chaussures', 'sac à main', 'maroquinerie', 'bijoux', 'montre', 'vêtement', 'pointure'],
  'maison-jardin': ['canapé', 'réfrigérateur', 'machine à laver', 'tondeuse', 'électroménager', 'meuble', 'jardin'],
  multimedia: ['iphone', 'smartphone', 'ordinateur portable', 'playstation', 'xbox', 'tablette', 'appareil photo', 'écran'],
  famille: ['poussette', 'biberon', 'berceau', 'siège auto enfant', 'jouet'],
  loisirs: ['guitare', 'piano', 'vélo', 'tente de camping', 'canne à pêche', 'instrument de musique'],
  'materiel-pro': ['machine industrielle', 'échafaudage', 'tracteur', 'mobilier de bureau', 'matériel professionnel'],
  services: ['prestation', 'cours particuliers', 'dépannage', 'déménagement'],
  emploi: ['recrute', 'cdi', 'cdd', 'salaire mensuel', 'poste à pourvoir', 'expérience requise'],
  'opportunites-affaires': ['investisseur', 'franchise', 'partenaire commercial', "appel d'offres", "cession d'entreprise"],
};
const CATEGORY_LABELS_FR = {
  immobilier: 'Immobilier', vehicules: 'Véhicules', mode: 'Mode & Accessoires',
  'maison-jardin': 'Maison & Jardin', multimedia: 'Multimédia & Électronique',
  famille: 'Famille & Enfants', loisirs: 'Loisirs & Sport',
  'materiel-pro': 'Matériel professionnel', services: 'Services',
  emploi: 'Emploi', 'opportunites-affaires': "Opportunités d'affaires",
};
/** Renvoie le slug de la catégorie la plus probable selon les mots-clés
 * trouvés dans le texte, seulement si ce n'est pas la catégorie choisie
 * et qu'aucun mot-clé de la catégorie choisie n'apparaît — pour éviter
 * les faux positifs sur les annonces à cheval sur deux catégories. */
function detectCategoryMismatch(title, description, categorySlug) {
  const text = `${title} ${description || ''}`.toLowerCase();
  let bestMatch = null;
  let bestCount = 0;
  for (const [slug, keywords] of Object.entries(CATEGORY_KEYWORDS_FR)) {
    if (slug === categorySlug) continue;
    const count = keywords.filter((kw) => text.includes(kw)).length;
    if (count > bestCount) { bestCount = count; bestMatch = slug; }
  }
  const ownCount = (CATEGORY_KEYWORDS_FR[categorySlug] || []).filter((kw) => text.includes(kw)).length;
  if (bestMatch && bestCount >= 1 && ownCount === 0) return bestMatch;
  return null;
}
function computeFraudRisk({ price, currency, description, images, subcategoryId, userId, title, categorySlug }) {
  let score = 0;
  const reasons = [];
  if (!description || description.length < 20) {
    score += 2;
    reasons.push('Description très courte ou absente');
  }
  if (!Array.isArray(images) || images.filter(Boolean).length === 0) {
    score += 2;
    reasons.push('Aucune photo');
  }
  if (title && categorySlug) {
    const mismatch = detectCategoryMismatch(title, description, categorySlug);
    if (mismatch) {
      score += 2;
      reasons.push(`Titre incohérent avec la catégorie (ressemble plutôt à « ${CATEGORY_LABELS_FR[mismatch] || mismatch} »)`);
    }
  }
  if (price !== null && price !== undefined && subcategoryId) {
    const comparable = db
      .prepare(
        `SELECT price FROM listings WHERE subcategory_id = ? AND currency = ? AND price IS NOT NULL AND price > 0`
      )
      .all(subcategoryId, currency);
    if (comparable.length >= 3) {
      const sorted = comparable.map((r) => r.price).sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      if (median > 0 && price < median * 0.15) {
        score += 3;
        reasons.push('Prix très inférieur aux annonces comparables');
      }
    }
  }
  const user = db.prepare('SELECT created_at, email_verified_at FROM users WHERE id = ?').get(userId);
  if (user && !user.email_verified_at) {
    score += 1;
    reasons.push('Email du vendeur non vérifié');
  }
  if (user) {
    const accountAgeMinutes = (Date.now() - new Date(user.created_at + 'Z').getTime()) / 60000;
    if (accountAgeMinutes < 10) {
      score += 1;
      reasons.push('Compte créé il y a moins de 10 minutes');
    }
  }
  return { score, reasons };
}
/** Normalise un nom de ville pour comparaison (minuscules, accents
 * retirés) — le nom saisi par le demandeur ("Fes") et le nom réel en
 * base ("Fès") peuvent différer légèrement sans que ce soit un problème. */
function normalizeCityName(str) {
  return (str || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}
/** Vérifie, pour chaque demande de ville en attente, si une ville
 * correspondante existe désormais dans le même pays — auquel cas
 * l'email de notification part automatiquement, sans action admin.
 * Fonctionne quelle que soit la façon dont la ville a été ajoutée
 * (interface admin ou script direct en base). */
/** Synchronise la boîte de réception admin depuis Gmail via IMAP — ne
 * récupère que les emails plus récents que le dernier UID déjà connu
 * (mémorisé dans site_settings), pour ne jamais retraiter deux fois le
 * même message. Reste silencieuse si SMTP_USER/SMTP_PASS ne sont pas
 * configurées (site fonctionne alors sans boîte de réception admin).
 */
async function checkInboxEmails() {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return;
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    logger: false,
  });
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const lastUidRow = db.prepare("SELECT value FROM site_settings WHERE key = 'inbox_last_uid'").get();
      const lastUid = lastUidRow ? Number(lastUidRow.value) : 0;
      const range = lastUid > 0 ? `${lastUid + 1}:*` : '1:*';
      let maxUid = lastUid;
      for await (const message of client.fetch(range, { uid: true, source: true }, { uid: true })) {
        if (message.uid <= lastUid) continue;
        if (message.uid > maxUid) maxUid = message.uid;
        const existing = db.prepare('SELECT id FROM inbox_emails WHERE uid = ?').get(message.uid);
        if (existing) continue;
        const parsed = await simpleParser(message.source);
        const fromEntry = (parsed.from && parsed.from.value && parsed.from.value[0]) || {};
        db.prepare(
          'INSERT INTO inbox_emails (uid, from_address, from_name, subject, body_text, body_html, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(
          message.uid,
          (fromEntry.address || '').toLowerCase(),
          fromEntry.name || null,
          parsed.subject || '(sans objet)',
          (parsed.text || '').slice(0, 5000),
          parsed.html ? parsed.html.slice(0, 100000) : null,
          (parsed.date || new Date()).toISOString()
        );
      }
      if (maxUid > lastUid) {
        db.prepare(
          "INSERT INTO site_settings (key, value) VALUES ('inbox_last_uid', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        ).run(String(maxUid));
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}
async function checkCityRequestFulfillments() {
  const pending = db.prepare('SELECT * FROM city_requests WHERE status = ?').all('pending');
  for (const reqRow of pending) {
    // Si la demande précise un État, on ne compare qu'aux villes de cet
    // État — sinon (pays non fédéral, ou État non précisé), on compare à
    // toutes les villes du pays comme avant.
    const citiesToCheck = reqRow.state_id
      ? db.prepare('SELECT name FROM cities WHERE state_id = ?').all(reqRow.state_id)
      : db.prepare('SELECT name FROM cities WHERE country_id = ?').all(reqRow.country_id);
    const normalizedRequested = normalizeCityName(reqRow.city_name);
    const match = citiesToCheck.some((c) => normalizeCityName(c.name) === normalizedRequested);
    if (!match) continue;
    db.prepare("UPDATE city_requests SET status = 'fulfilled', notified_at = datetime('now') WHERE id = ?").run(reqRow.id);
    try {
      await sendMail({
        to: reqRow.email,
        purpose: 'city_request_fulfilled',
        subject: `${reqRow.city_name} est maintenant disponible sur QuickAtlas`,
        text: `Bonjour,\n\nVous nous aviez signalé l'absence de ${reqRow.city_name}. Bonne nouvelle : cette ville est désormais disponible sur QuickAtlas !\n\nÀ bientôt,\nL'équipe QuickAtlas`,
        link: SITE_URL,
      });
    } catch (err) {
      console.error('[city-request] échec de l\'envoi de l\'email :', err.message);
    }
  }
}
async function checkListingExpirations() {
  const soon = db
    .prepare(
      `SELECT l.id, l.title, l.expires_at, u.email, u.name
       FROM listings l JOIN users u ON u.id = l.user_id
       WHERE l.status = 'active' AND l.expiry_reminder_sent = 0
         AND l.expires_at > datetime('now') AND l.expires_at <= datetime('now', '+3 days')`
    )
    .all();
  for (const l of soon) {
    const link = `${SITE_URL}/?listing=${l.id}`;
    await sendMail({
      to: l.email,
      purpose: 'expiry_reminder',
      subject: `Votre annonce « ${l.title} » expire bientôt`,
      text: `Bonjour ${l.name},\n\nVotre annonce « ${l.title} » expirera le ${l.expires_at} (heure serveur).\n\nPour qu'elle reste visible, renouvelez-la depuis « Mes annonces » sur QuickAtlas, ou directement ici :\n${link}\n\nSans renouvellement, elle sera automatiquement masquée des résultats.`,
      link,
    });
    db.prepare('UPDATE listings SET expiry_reminder_sent = 1 WHERE id = ?').run(l.id);
  }
  const expired = db
    .prepare(
      `SELECT l.id, l.title, u.email, u.name
       FROM listings l JOIN users u ON u.id = l.user_id
       WHERE l.expired_notice_sent = 0 AND l.expires_at <= datetime('now')`
    )
    .all();
  for (const l of expired) {
    const link = `${SITE_URL}/?listing=${l.id}`;
    await sendMail({
      to: l.email,
      purpose: 'expired_notice',
      subject: `Votre annonce « ${l.title} » a expiré`,
      text: `Bonjour ${l.name},\n\nVotre annonce « ${l.title} » a expiré et n'est plus visible dans les résultats.\n\nVous pouvez la renouveler à tout moment depuis « Mes annonces » sur QuickAtlas, ou directement ici :\n${link}`,
      link,
    });
    db.prepare('UPDATE listings SET expired_notice_sent = 1 WHERE id = ?').run(l.id);
  }
  if (soon.length || expired.length) {
    console.log(`[expiration] ${soon.length} rappel(s) « expire bientôt », ${expired.length} avis « expirée » envoyés.`);
  }
}
async function notifySavedSearchMatches(listing) {
  const cityRow = db.prepare('SELECT country_id FROM cities WHERE id = ?').get(listing.city_id);
  const countryId = cityRow ? cityRow.country_id : null;
  const searches = db
    .prepare(
      `SELECT ss.*, u.email AS user_email, u.name AS user_name
       FROM saved_searches ss
       JOIN users u ON u.id = ss.user_id
       WHERE ss.user_id != ?
         AND (ss.country_id IS NULL OR ss.country_id = ?)
         AND (ss.city_id IS NULL OR ss.city_id = ?)
         AND (ss.category_id IS NULL OR ss.category_id = ?)
         AND (ss.subcategory_id IS NULL OR ss.subcategory_id = ?)
         AND (ss.listing_type IS NULL OR ss.listing_type = ?)`
    )
    .all(listing.user_id, countryId, listing.city_id, listing.category_id, listing.subcategory_id, listing.listing_type);
  for (const search of searches) {
    if (search.keyword) {
      const kw = search.keyword.toLowerCase();
      const hay = `${listing.title} ${listing.description}`.toLowerCase();
      if (!hay.includes(kw)) continue;
    }
    try {
      db.prepare('INSERT INTO saved_search_matches (saved_search_id, listing_id) VALUES (?, ?)').run(search.id, listing.id);
    } catch {
      continue;
    }
    if (search.email_alerts) {
      const link = `${SITE_URL}/?listing=${listing.id}`;
      await sendMail({
        to: search.user_email,
        purpose: 'saved_search_alert',
        subject: `Nouvelle annonce pour votre alerte « ${search.label} »`,
        text: `Bonjour ${search.user_name},\n\nUne nouvelle annonce correspond à votre alerte « ${search.label} » :\n\n${listing.title}\n\nVoir l'annonce : ${link}\n\nVous recevez cet email car vous avez enregistré cette recherche sur QuickAtlas. Vous pouvez la gérer ou la supprimer depuis « Mes alertes ».`,
        link,
      });
    }
  }
}
/** Email de bienvenue nominatif, envoyé une seule fois à l'inscription —
 * distinct de l'email de vérification, qui a un rôle purement technique.
 * Explique brièvement les fonctionnalités principales du site. */
const WELCOME_EMAIL_TEMPLATES = {
  fr: {
    subject: (name) => `Bienvenue sur QuickAtlas, ${name} !`,
    text: (name) => `Bonjour ${name},

Bienvenue sur QuickAtlas ! Votre compte est créé, voici un guide complet pour bien démarrer :

🗺️ EXPLORER
Cliquez un pays sur la carte du monde, puis une ville, pour découvrir les annonces locales. La recherche globale et l'onglet "Toutes les annonces" permettent aussi de chercher dans le monde entier sans passer par la carte. Ajoutez vos destinations favorites en un clic pour y revenir directement depuis l'accueil.

📝 PUBLIER
Depuis "Publier une annonce", décrivez ce que vous vendez, louez ou recherchez (immobilier, véhicules, emploi, tourisme, et bien d'autres catégories). C'est gratuit, sans limite de publication, et visible dans 195 pays. Vos annonces restent actives 60 jours et se renouvellent en un clic.

💬 ÉCHANGER
Contactez directement un vendeur depuis sa fiche annonce (messagerie interne, ou WhatsApp s'il a renseigné son numéro). Vous pouvez faire une offre chiffrée, proposer un échange, ou comparer plusieurs annonces côte à côte avant de vous décider.

🔔 ÊTRE ALERTÉ
Enregistrez une recherche pour recevoir un email automatique dès qu'une nouvelle annonce correspondante est publiée.

🛂 PASSEPORT & PARRAINAGE
Retrouvez vos tampons de pays et votre lien de parrainage personnel dans "Passeport" — chaque personne inscrite via ce lien vous fait gagner un crédit de mise en avant gratuit.

✅ TRANSACTION CONCLUE
Marquez votre annonce comme "Vendue" ou "Louée" depuis "Mes annonces" — un cachet apparaîtra sur votre fiche pour informer les autres visiteurs.

Besoin d'aide ? Le bouton "🧭 Mode d'emploi" en haut de chaque page reprend toutes ces explications à tout moment.

Bonne exploration !
L'équipe QuickAtlas`,
  },
  en: {
    subject: (name) => `Welcome to QuickAtlas, ${name}!`,
    text: (name) => `Hello ${name},

Welcome to QuickAtlas! Your account is ready — here is a full guide to get you started:

🗺️ EXPLORE
Click a country on the world map, then a city, to discover local listings. The global search and the "All listings" tab also let you search the whole world without using the map. Add your favorite destinations with one click to access them directly from the home page.

📝 PUBLISH
From "Post a listing", describe what you are selling, renting or looking for (real estate, vehicles, jobs, travel, and many other categories). It's free, with no publishing limit, and visible in 195 countries. Your listings stay active for 60 days and renew in one click.

💬 CONNECT
Contact a seller directly from their listing (internal messaging, or WhatsApp if they provided a number). You can make a priced offer, propose a trade, or compare several listings side by side before deciding.

🔔 GET ALERTED
Save a search to receive an automatic email as soon as a matching listing is published.

🛂 PASSPORT & REFERRAL
Find your country stamps and your personal referral link in "Passport" — anyone who signs up through your link earns you a free boost credit.

✅ DEAL COMPLETED
Mark your listing as "Sold" or "Rented" from "My listings" — a stamp will appear on your listing to inform other visitors.

Need help? The "🧭 Guide" button at the top of every page has all these explanations at any time.

Happy exploring!
The QuickAtlas team`,
  },
  it: {
    subject: (name) => `Benvenuto/a su QuickAtlas, ${name}!`,
    text: (name) => `Ciao ${name},

Benvenuto/a su QuickAtlas! Il tuo account è pronto, ecco una guida completa per iniziare:

🗺️ ESPLORA
Clicca su un paese sulla mappa del mondo, poi su una città, per scoprire gli annunci locali. La ricerca globale e la scheda "Tutti gli annunci" permettono anche di cercare in tutto il mondo senza passare dalla mappa. Aggiungi le tue destinazioni preferite con un clic per ritrovarle direttamente dalla home.

📝 PUBBLICA
Da "Pubblica un annuncio", descrivi cosa vendi, affitti o cerchi (immobili, veicoli, lavoro, turismo e molte altre categorie). È gratuito, senza limiti di pubblicazione, e visibile in 195 paesi. I tuoi annunci restano attivi 60 giorni e si rinnovano con un clic.

💬 COMUNICA
Contatta direttamente un venditore dal suo annuncio (messaggistica interna, o WhatsApp se ha indicato un numero). Puoi fare un'offerta in cifre, proporre uno scambio, o confrontare più annunci fianco a fianco prima di decidere.

🔔 RICEVI AVVISI
Salva una ricerca per ricevere un'email automatica non appena viene pubblicato un annuncio corrispondente.

🛂 PASSAPORTO E INVITI
Trova i tuoi timbri dei paesi e il tuo link di invito personale in "Passaporto" — ogni persona che si iscrive tramite questo link ti fa guadagnare un credito di visibilità gratuito.

✅ TRANSAZIONE CONCLUSA
Segna il tuo annuncio come "Venduto" o "Affittato" da "I miei annunci" — un timbro apparirà sul tuo annuncio per informare gli altri visitatori.

Hai bisogno di aiuto? Il pulsante "🧭 Guida" in alto in ogni pagina riprende tutte queste spiegazioni in qualsiasi momento.

Buona esplorazione!
Il team QuickAtlas`,
  },
  ar: {
    subject: (name) => `مرحبًا بك في QuickAtlas يا ${name}!`,
    text: (name) => `مرحبًا ${name}،

مرحبًا بك في QuickAtlas! تم إنشاء حسابك، إليك دليل كامل للبدء:

🗺️ الاستكشاف
انقر على بلد في خريطة العالم، ثم على مدينة، لاكتشاف الإعلانات المحلية. يتيح لك البحث الشامل وتبويب "جميع الإعلانات" أيضًا البحث في العالم كله دون المرور بالخريطة. أضف وجهاتك المفضلة بنقرة واحدة للوصول إليها مباشرة من الصفحة الرئيسية.

📝 النشر
من "نشر إعلان"، صف ما تبيعه أو تؤجره أو تبحث عنه (عقارات، مركبات، وظائف، سياحة، وفئات أخرى كثيرة). الخدمة مجانية، دون حد للنشر، ومرئية في 195 دولة. تبقى إعلاناتك نشطة لمدة 60 يومًا وتتجدد بنقرة واحدة.

💬 التواصل
تواصل مباشرة مع بائع من صفحة إعلانه (المراسلة الداخلية، أو واتساب إذا قدّم رقمه). يمكنك تقديم عرض بسعر محدد، أو اقتراح مقايضة، أو مقارنة عدة إعلانات جنبًا إلى جنب قبل اتخاذ القرار.

🔔 التنبيهات
احفظ عملية بحث لتلقي بريد إلكتروني تلقائي فور نشر إعلان مطابق.

🛂 جواز السفر والإحالة
اعثر على أختام بلدانك ورابط الإحالة الخاص بك في "جواز السفر" — كل شخص يسجل عبر رابطك يمنحك رصيدًا مجانيًا للإبراز.

✅ إتمام الصفقة
ضع علامة على إعلانك كـ"مُباع" أو "مُؤجَّر" من "إعلاناتي" — سيظهر ختم على إعلانك لإعلام الزوار الآخرين.

بحاجة إلى مساعدة؟ زر "🧭 دليل الاستخدام" أعلى كل صفحة يعرض كل هذه الشروحات في أي وقت.

استكشافًا سعيدًا!
فريق QuickAtlas`,
  },
  es: {
    subject: (name) => `¡Bienvenido/a a QuickAtlas, ${name}!`,
    text: (name) => `Hola ${name},

¡Bienvenido/a a QuickAtlas! Su cuenta está creada, aquí tiene una guía completa para empezar:

🗺️ EXPLORAR
Haga clic en un país en el mapa del mundo, luego en una ciudad, para descubrir los anuncios locales. La búsqueda global y la pestaña "Todos los anuncios" también permiten buscar en todo el mundo sin pasar por el mapa. Añada sus destinos favoritos con un clic para volver a ellos directamente desde el inicio.

📝 PUBLICAR
Desde "Publicar anuncio", describa lo que vende, alquila o busca (inmuebles, vehículos, empleo, turismo y muchas otras categorías). Es gratis, sin límite de publicación, y visible en 195 países. Sus anuncios permanecen activos 60 días y se renuevan con un clic.

💬 COMUNICARSE
Contacte directamente con un vendedor desde su anuncio (mensajería interna, o WhatsApp si indicó un número). Puede hacer una oferta con precio, proponer un intercambio, o comparar varios anuncios lado a lado antes de decidir.

🔔 RECIBIR ALERTAS
Guarde una búsqueda para recibir un correo automático en cuanto se publique un anuncio coincidente.

🛂 PASAPORTE Y REFERIDOS
Encuentre sus sellos de países y su enlace de referido personal en "Pasaporte" — cada persona que se registre a través de su enlace le otorga un crédito de destaque gratuito.

✅ TRANSACCIÓN CONCLUIDA
Marque su anuncio como "Vendido" o "Alquilado" desde "Mis anuncios" — aparecerá un sello en su anuncio para informar a otros visitantes.

¿Necesita ayuda? El botón "🧭 Guía" en la parte superior de cada página recoge todas estas explicaciones en cualquier momento.

¡Feliz exploración!
El equipo de QuickAtlas`,
  },
  pt: {
    subject: (name) => `Bem-vindo(a) ao QuickAtlas, ${name}!`,
    text: (name) => `Olá ${name},

Bem-vindo(a) ao QuickAtlas! A sua conta está criada, aqui tem um guia completo para começar:

🗺️ EXPLORAR
Clique num país no mapa-múndi, depois numa cidade, para descobrir os anúncios locais. A pesquisa global e o separador "Todos os anúncios" também permitem pesquisar no mundo inteiro sem passar pelo mapa. Adicione os seus destinos favoritos com um clique para voltar a eles diretamente a partir do início.

📝 PUBLICAR
A partir de "Publicar anúncio", descreva o que vende, aluga ou procura (imóveis, veículos, emprego, turismo e muitas outras categorias). É gratuito, sem limite de publicação, e visível em 195 países. Os seus anúncios permanecem ativos 60 dias e renovam-se com um clique.

💬 COMUNICAR
Contacte diretamente um vendedor a partir do seu anúncio (mensagens internas, ou WhatsApp se tiver indicado um número). Pode fazer uma oferta com preço, propor uma troca, ou comparar vários anúncios lado a lado antes de decidir.

🔔 RECEBER ALERTAS
Guarde uma pesquisa para receber um email automático assim que for publicado um anúncio correspondente.

🛂 PASSAPORTE E REFERENCIAÇÃO
Encontre os seus carimbos de países e o seu link de referenciação pessoal em "Passaporte" — cada pessoa que se inscreva através do seu link concede-lhe um crédito de destaque gratuito.

✅ TRANSAÇÃO CONCLUÍDA
Marque o seu anúncio como "Vendido" ou "Alugado" a partir de "Meus anúncios" — um carimbo aparecerá no seu anúncio para informar outros visitantes.

Precisa de ajuda? O botão "🧭 Guia" no topo de cada página reúne todas estas explicações a qualquer momento.

Boas explorações!
A equipa QuickAtlas`,
  },
  de: {
    subject: (name) => `Willkommen bei QuickAtlas, ${name}!`,
    text: (name) => `Hallo ${name},

Willkommen bei QuickAtlas! Ihr Konto ist erstellt, hier ist ein vollständiger Leitfaden für den Einstieg:

🗺️ ENTDECKEN
Klicken Sie auf ein Land auf der Weltkarte, dann auf eine Stadt, um lokale Anzeigen zu entdecken. Die globale Suche und der Reiter "Alle Anzeigen" ermöglichen es auch, weltweit zu suchen, ohne die Karte zu nutzen. Fügen Sie Ihre Lieblingsziele mit einem Klick hinzu, um direkt von der Startseite aus darauf zuzugreifen.

📝 VERÖFFENTLICHEN
Beschreiben Sie unter "Anzeige aufgeben", was Sie verkaufen, vermieten oder suchen (Immobilien, Fahrzeuge, Jobs, Reisen und viele weitere Kategorien). Es ist kostenlos, ohne Veröffentlichungslimit, und in 195 Ländern sichtbar. Ihre Anzeigen bleiben 60 Tage aktiv und werden mit einem Klick verlängert.

💬 KONTAKTIEREN
Kontaktieren Sie einen Verkäufer direkt über seine Anzeige (interne Nachrichten oder WhatsApp, falls eine Nummer angegeben wurde). Sie können ein bepreistes Angebot machen, einen Tausch vorschlagen oder mehrere Anzeigen vor der Entscheidung nebeneinander vergleichen.

🔔 BENACHRICHTIGT WERDEN
Speichern Sie eine Suche, um automatisch eine E-Mail zu erhalten, sobald eine passende Anzeige veröffentlicht wird.

🛂 PASS & EMPFEHLUNG
Finden Sie Ihre Länderstempel und Ihren persönlichen Empfehlungslink unter "Reisepass" — jede Person, die sich über Ihren Link registriert, bringt Ihnen ein kostenloses Hervorhebungsguthaben ein.

✅ GESCHÄFT ABGESCHLOSSEN
Markieren Sie Ihre Anzeige unter "Meine Anzeigen" als "Verkauft" oder "Vermietet" — ein Stempel erscheint auf Ihrer Anzeige, um andere Besucher zu informieren.

Brauchen Sie Hilfe? Die Schaltfläche "🧭 Anleitung" oben auf jeder Seite enthält all diese Erklärungen jederzeit.

Viel Spaß beim Entdecken!
Das QuickAtlas-Team`,
  },
};
async function sendWelcomeEmail(name, email, language) {
  const template = WELCOME_EMAIL_TEMPLATES[language] || WELCOME_EMAIL_TEMPLATES.fr;
  await sendMail({
    to: email,
    purpose: 'welcome',
    subject: template.subject(name),
    text: template.text(name),
    link: SITE_URL,
  });
}
async function sendVerificationEmail(userId, name, email) {
  const raw = generateRawToken();
  db.prepare(
    "INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at) VALUES (?, 'verify_email', ?, datetime('now', '+48 hours'))"
  ).run(userId, hashRawToken(raw));
  const link = `${SITE_URL}/?verify=${raw}`;
  await sendMail({
    to: email,
    purpose: 'verify_email',
    subject: 'Vérifiez votre adresse email — QuickAtlas',
    text: `Bonjour ${name},\n\nMerci de confirmer votre adresse email en cliquant sur ce lien (valable 48 heures) :\n${link}\n\nTant que votre email n'est pas vérifié, vous ne pouvez pas publier d'annonce ni contacter d'autres utilisateurs.`,
    link,
  });
}
function consumeAuthToken(rawToken, purpose) {
  if (!rawToken) return null;
  const hash = hashRawToken(rawToken);
  const row = db
    .prepare(
      "SELECT * FROM auth_tokens WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > datetime('now')"
    )
    .get(hash, purpose);
  if (!row) return null;
  db.prepare("UPDATE auth_tokens SET used_at = datetime('now') WHERE id = ?").run(row.id);
  return row;
}
function isValidUploadedImagePath(imageUrl) {
  return typeof imageUrl === 'string' && /^\/uploads\/[a-zA-Z0-9_.-]+$/.test(imageUrl);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;
  const method = req.method;
  if (!pathname.startsWith('/api/')) {
    let m;
    if (pathname.startsWith('/uploads/')) {
      const filename = path.basename(pathname);
      const filePath = path.join(DATA_DIR, 'uploads', filename);
      return fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); return res.end('Image introuvable'); }
        const ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000, immutable' });
        res.end(data);
      });
    }
    if (pathname === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(`User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${SITE_URL}/sitemap.xml\n`);
    }
    if (pathname === '/sitemap.xml') {
      const countries = db.prepare('SELECT id, name FROM countries').all();
      const categories = db.prepare('SELECT slug FROM categories').all();
      const listings = db
        .prepare("SELECT id, updated_at FROM listings WHERE status = 'active' AND expires_at > datetime('now')")
        .all();
      const cities = db
        .prepare(
          `SELECT ci.name AS city_name, co.iso2 AS country_iso2, co.name AS country_name
           FROM cities ci JOIN countries co ON co.id = ci.country_id
           WHERE EXISTS (SELECT 1 FROM listings l WHERE l.city_id = ci.id AND l.status = 'active' AND l.expires_at > datetime('now'))`
        )
        .all();
      const urls = [
        { loc: '/', priority: '1.0' },
        ...countries.map((c) => ({ loc: `/pays/${slugify(c.name)}`, priority: '0.8' })),
        ...categories.map((c) => ({ loc: `/categorie/${c.slug}`, priority: '0.7' })),
        ...cities.map((c) => ({ loc: `/pays/${slugify(c.country_name)}/${slugify(c.city_name)}`, priority: '0.7' })),
        ...listings.map((l) => ({ loc: `/annonce/${l.id}`, priority: '0.6', lastmod: (l.updated_at || '').slice(0, 10) })),
      ];
      const xml =
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        urls.map((u) => `  <url><loc>${SITE_URL}${u.loc}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}<priority>${u.priority}</priority></url>`).join('\n') +
        `\n</urlset>`;
      res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
      return res.end(xml);
    }
    if ((m = pathname.match(/^\/pays\/([a-z0-9-]+)$/))) {
      const countries = db.prepare('SELECT id, name FROM countries').all();
      const country = countries.find((c) => slugify(c.name) === m[1]);
      if (country) {
        const stats = db
          .prepare(
            `SELECT COUNT(DISTINCT ci.id) AS cities, COUNT(l.id) AS listings
             FROM cities ci LEFT JOIN listings l ON l.city_id = ci.id AND l.status = 'active' AND l.expires_at > datetime('now')
             WHERE ci.country_id = ?`
          )
          .get(country.id);
        return sendHtml(
          res,
          renderHtmlWithMeta({
            title: `Achetez, vendez, louez au ${country.name} — QuickAtlas`,
            description: `Parcourez ${stats.listings || 0} annonce(s) au ${country.name} sur QuickAtlas : immobilier, véhicules, emploi et objets, ville par ville.`,
            canonicalPath: `/pays/${m[1]}`,
            jsonLd: [breadcrumbJsonLd([
              { name: 'Accueil', path: '/' },
              { name: country.name },
            ])],
          })
        );
      }
    }
    if ((m = pathname.match(/^\/pays\/([a-z0-9-]+)\/([a-z0-9-]+)$/))) {
      const countries = db.prepare('SELECT id, name FROM countries').all();
      const country = countries.find((c) => slugify(c.name) === m[1]);
      if (country) {
        const cities = db.prepare('SELECT id, name FROM cities WHERE country_id = ?').all(country.id);
        const city = cities.find((c) => slugify(c.name) === m[2]);
        if (city) {
          const cityStats = db
            .prepare(
              `SELECT COUNT(*) AS listings FROM listings
               WHERE city_id = ? AND status = 'active' AND expires_at > datetime('now')`
            )
            .get(city.id);
          return sendHtml(
            res,
            renderHtmlWithMeta({
              title: `Annonces à ${city.name}, ${country.name} — QuickAtlas`,
              description: `Parcourez ${cityStats.listings || 0} annonce(s) à ${city.name}, ${country.name} sur QuickAtlas : immobilier, véhicules, emploi et objets à vendre, louer ou pourvoir.`,
              canonicalPath: `/pays/${m[1]}/${m[2]}`,
              jsonLd: [breadcrumbJsonLd([
                { name: 'Accueil', path: '/' },
                { name: country.name, path: `/pays/${m[1]}` },
                { name: city.name },
              ])],
            })
          );
        }
      }
    }
    if ((m = pathname.match(/^\/categorie\/([a-z0-9-]+)$/))) {
      const category = db.prepare('SELECT slug, name FROM categories WHERE slug = ?').get(m[1]);
      if (category) {
        return sendHtml(
          res,
          renderHtmlWithMeta({
            title: `${category.name} — Annonces dans le monde entier | QuickAtlas`,
            description: `Découvrez toutes les annonces "${category.name}" sur QuickAtlas, la place de marché mondiale — achat, vente, location, ville par ville.`,
            canonicalPath: `/categorie/${m[1]}`,
            jsonLd: [breadcrumbJsonLd([
              { name: 'Accueil', path: '/' },
              { name: category.name },
            ])],
          })
        );
      }
    }
    if ((m = pathname.match(/^\/annonce\/(\d+)(?:-[a-z0-9-]*)?$/))) {
      const listing = db
        .prepare(
          `SELECT l.title, l.description, l.price, l.currency, l.images_json, ci.name AS city_name, co.iso2 AS country_iso2, co.name AS country_name
           FROM listings l JOIN cities ci ON ci.id = l.city_id JOIN countries co ON co.id = ci.country_id
           WHERE l.id = ? AND l.status = 'active'`
        )
        .get(Number(m[1]));
      if (listing) {
        const images = JSON.parse(listing.images_json || '[]');
        const priceText = listing.price ? `${listing.price} ${listing.currency}` : 'Prix sur demande';
        const listingJsonLd = [
          breadcrumbJsonLd([
            { name: 'Accueil', path: '/' },
            { name: listing.country_name, path: `/pays/${slugify(listing.country_name)}` },
            { name: listing.title },
          ]),
        ];
        if (listing.price) {
          listingJsonLd.push({
            '@context': 'https://schema.org',
            '@type': 'Product',
            name: listing.title,
            description: (listing.description || listing.title).slice(0, 500),
            image: images[0] ? [images[0]] : undefined,
            offers: {
              '@type': 'Offer',
              price: listing.price,
              priceCurrency: listing.currency,
              availability: 'https://schema.org/InStock',
              url: `${SITE_URL}/annonce/${m[1]}-${slugify(listing.title)}`,
            },
          });
        }
        return sendHtml(
          res,
          renderHtmlWithMeta({
            title: `${listing.title} — ${listing.city_name}, ${listing.country_name} | QuickAtlas`,
            description: (listing.description || `${listing.title} à ${listing.city_name}, ${listing.country_name}.`).slice(0, 155),
            canonicalPath: `/annonce/${m[1]}-${slugify(listing.title)}`,
            image: images[0] || null,
            jsonLd: listingJsonLd,
          })
        );
      }
    }
    return serveStatic(req, res, pathname);
  }
  try {
    if (pathname === '/api/auth/register' && method === 'POST') {
      const { name, email, password, terms_accepted, referral_code, is_professional, company_name, company_website, language } = await readBody(req);
      if (!name || !isValidEmail(email)) {
        return sendJSON(res, 400, { error: 'Nom et email valide requis.' });
      }
      const pwIssues = passwordIssues(password);
      if (pwIssues.length) {
        return sendJSON(res, 400, { error: 'Mot de passe trop faible : 8 caractères minimum, avec au moins une lettre et un chiffre.' });
      }
      if (!terms_accepted) {
        return sendJSON(res, 400, { error: "Vous devez accepter la charte de la communauté et les conditions d'utilisation." });
      }
      if (is_professional && (!company_name || !company_name.trim())) {
        return sendJSON(res, 400, { error: "Le nom de l'entreprise est requis pour un compte professionnel." });
      }
      const SUPPORTED_EMAIL_LANGUAGES = ['fr', 'en', 'it', 'ar', 'es', 'pt', 'de'];
      const userLanguage = SUPPORTED_EMAIL_LANGUAGES.includes(language) ? language : 'fr';
      const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
      if (existing) return sendJSON(res, 409, { error: 'Un compte existe déjà avec cet email.' });
      const { salt, hash } = hashPassword(password);
      const myReferralCode = generateReferralCode();
      let referrer = null;
      if (referral_code) referrer = db.prepare('SELECT id FROM users WHERE referral_code = ?').get(referral_code.trim().toUpperCase());
      const id = db
        .prepare(
          `INSERT INTO users (name, email, password_hash, password_salt, terms_accepted_at, referral_code, referred_by_user_id, is_professional, company_name, company_website, language)
           VALUES (?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?)`
        )
        .run(
          name.trim(), email.toLowerCase(), hash, salt, myReferralCode, referrer ? referrer.id : null,
          is_professional ? 1 : 0, is_professional ? company_name.trim() : null, is_professional ? (company_website || '').trim() || null : null, userLanguage
        ).lastInsertRowid;
      if (referrer) {
        db.prepare('UPDATE users SET free_boost_credits = free_boost_credits + 1 WHERE id = ?').run(referrer.id);
      }
      const token = signToken({ sub: id });
      await sendVerificationEmail(id, name.trim(), email.toLowerCase());
      sendWelcomeEmail(name.trim(), email.toLowerCase(), userLanguage).catch((err) => console.error('[welcome-email] échec :', err.message));
      return sendJSON(res, 201, { token, user: { id, name, email: email.toLowerCase(), role: 'user', email_verified: false, referral_code: myReferralCode, free_boost_credits: 0, phone: null, is_professional: !!is_professional, company_name: is_professional ? company_name.trim() : null } });
    }
    if (pathname === '/api/auth/login' && method === 'POST') {
      const { email, password } = await readBody(req);
      const emailKey = (email || '').toLowerCase();
      const attempt = loginAttempts.get(emailKey);
      if (attempt && attempt.lockedUntil && attempt.lockedUntil > Date.now()) {
        const waitMin = Math.ceil((attempt.lockedUntil - Date.now()) / 60000);
        return sendJSON(res, 429, { error: `Trop de tentatives échouées. Réessayez dans ${waitMin} minute(s).` });
      }
      const user = db.prepare('SELECT * FROM users WHERE email = ?').get(emailKey);
      if (!user || !verifyPassword(password || '', user.password_salt, user.password_hash)) {
        const prev = loginAttempts.get(emailKey) || { count: 0 };
        const count = prev.count + 1;
        const lockedUntil = count >= MAX_LOGIN_ATTEMPTS ? Date.now() + LOCKOUT_MS : null;
        loginAttempts.set(emailKey, { count, lockedUntil });
        if (lockedUntil) {
          return sendJSON(res, 429, { error: `Trop de tentatives échouées. Compte temporairement bloqué 15 minutes.` });
        }
        return sendJSON(res, 401, { error: 'Email ou mot de passe incorrect.' });
      }
      loginAttempts.delete(emailKey);
      const token = signToken({ sub: user.id });
      return sendJSON(res, 200, {
        token,
        user: {
          id: user.id, name: user.name, email: user.email, role: user.role, email_verified: !!user.email_verified_at,
          phone: user.phone, referral_code: user.referral_code, free_boost_credits: user.free_boost_credits,
          is_professional: !!user.is_professional, company_name: user.company_name, company_logo_url: user.company_logo_url,
          company_website: user.company_website, pro_tier: user.pro_tier, domain_verified: isDomainVerified(user.email, user.company_website),
        },
      });
    }
    if (pathname === '/api/auth/me' && method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      return sendJSON(res, 200, { user: { ...user, email_verified: !!user.email_verified_at, domain_verified: isDomainVerified(user.email, user.company_website) } });
    }
    if (pathname === '/api/me/professional-profile' && method === 'PUT') {
      const user = requireAuth(req, res);
      if (!user) return;
      const { is_professional, company_name, company_website, company_logo_url } = await readBody(req);
      if (is_professional && (!company_name || !company_name.trim())) {
        return sendJSON(res, 400, { error: "Le nom de l'entreprise est requis." });
      }
      db.prepare(
        `UPDATE users SET is_professional = ?, company_name = ?, company_website = ?, company_logo_url = ? WHERE id = ?`
      ).run(
        is_professional ? 1 : 0,
        is_professional ? company_name.trim() : null,
        is_professional ? (company_website || '').trim() || null : null,
        is_professional ? (company_logo_url || user.company_logo_url || null) : null,
        user.id
      );
      return sendJSON(res, 200, { ok: true });
    }
    if (pathname === '/api/me/phone' && method === 'PUT') {
      const user = requireAuth(req, res);
      if (!user) return;
      const { phone } = await readBody(req);
      const cleaned = (phone || '').replace(/[^\d+]/g, '').trim();
      if (cleaned && !/^\+?\d{6,15}$/.test(cleaned)) {
        return sendJSON(res, 400, { error: 'Numéro invalide. Utilisez le format international, ex. +212612345678.' });
      }
      db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(cleaned || null, user.id);
      return sendJSON(res, 200, { phone: cleaned || null });
    }
    if (pathname === '/api/auth/resend-verification' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      if (user.email_verified_at) return sendJSON(res, 400, { error: 'Cet email est déjà vérifié.' });
      await sendVerificationEmail(user.id, user.name, user.email);
      return sendJSON(res, 200, { ok: true });
    }
    if (pathname === '/api/auth/verify-email' && method === 'POST') {
      const { token } = await readBody(req);
      const consumed = consumeAuthToken(token, 'verify_email');
      if (!consumed) {
        const hash = hashRawToken(token || '');
        const already = db
          .prepare(
            `SELECT u.email_verified_at FROM auth_tokens t
             JOIN users u ON u.id = t.user_id
             WHERE t.token_hash = ? AND t.purpose = 'verify_email'`
          )
          .get(hash);
        if (already && already.email_verified_at) {
          return sendJSON(res, 200, { ok: true, already_verified: true });
        }
        return sendJSON(res, 400, { error: 'Lien de vérification invalide ou expiré.' });
      }
      db.prepare("UPDATE users SET email_verified_at = datetime('now') WHERE id = ?").run(consumed.user_id);
      return sendJSON(res, 200, { ok: true });
    }
    if (pathname === '/api/auth/google' && method === 'POST') {
      if (!process.env.GOOGLE_CLIENT_ID) return sendJSON(res, 400, { error: 'GOOGLE_NOT_CONFIGURED' });
      const { id_token, terms_accepted } = await readBody(req);
      if (!id_token) return sendJSON(res, 400, { error: 'Jeton Google manquant.' });
      let payload;
      try {
        const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(id_token)}`);
        payload = await verifyRes.json();
        if (!verifyRes.ok || payload.aud !== process.env.GOOGLE_CLIENT_ID) throw new Error('audience mismatch');
      } catch {
        return sendJSON(res, 401, { error: 'Jeton Google invalide ou expiré.' });
      }
      const email = (payload.email || '').toLowerCase();
      if (!email) return sendJSON(res, 400, { error: 'Impossible de récupérer votre email Google.' });
      let user = db.prepare('SELECT * FROM users WHERE google_sub = ? OR email = ?').get(payload.sub, email);
      if (!user) {
        if (!terms_accepted) return sendJSON(res, 400, { error: "Vous devez accepter la charte de la communauté et les conditions d'utilisation." });
        const { salt, hash } = hashPassword(crypto.randomBytes(24).toString('hex'));
        const myReferralCode = generateReferralCode();
        const id = db
          .prepare(
            "INSERT INTO users (name, email, password_hash, password_salt, terms_accepted_at, email_verified_at, google_sub, referral_code) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'), ?, ?)"
          )
          .run(payload.name || email.split('@')[0], email, hash, salt, payload.sub, myReferralCode).lastInsertRowid;
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      } else if (!user.google_sub) {
        db.prepare("UPDATE users SET google_sub = ?, email_verified_at = COALESCE(email_verified_at, datetime('now')) WHERE id = ?").run(payload.sub, user.id);
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
      }
      const token = signToken({ sub: user.id });
      return sendJSON(res, 200, {
        token,
        user: { id: user.id, name: user.name, email: user.email, role: user.role, email_verified: true, referral_code: user.referral_code, free_boost_credits: user.free_boost_credits, phone: user.phone },
      });
    }
    if (pathname === '/api/auth/forgot-password' && method === 'POST') {
      const { email } = await readBody(req);
      const user = db.prepare('SELECT * FROM users WHERE email = ?').get((email || '').toLowerCase());
      if (user) {
        const raw = generateRawToken();
        db.prepare(
          "INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at) VALUES (?, 'reset_password', ?, datetime('now', '+1 hour'))"
        ).run(user.id, hashRawToken(raw));
        const link = `${SITE_URL}/?reset=${raw}`;
        await sendMail({
          to: user.email,
          purpose: 'reset_password',
          subject: 'Réinitialisez votre mot de passe QuickAtlas',
          text: `Bonjour ${user.name},\n\nPour réinitialiser votre mot de passe, cliquez sur ce lien (valable 1 heure) :\n${link}\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez cet email.`,
          link,
        });
      }
      return sendJSON(res, 200, { ok: true });
    }
    if (pathname === '/api/auth/reset-password' && method === 'POST') {
      const { token, password } = await readBody(req);
      const pwIssues = passwordIssues(password);
      if (pwIssues.length) {
        return sendJSON(res, 400, { error: 'Mot de passe trop faible : 8 caractères minimum, avec au moins une lettre et un chiffre.' });
      }
      const consumed = consumeAuthToken(token, 'reset_password');
      if (!consumed) return sendJSON(res, 400, { error: 'Lien de réinitialisation invalide ou expiré.' });
      const { salt, hash } = hashPassword(password);
      db.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').run(hash, salt, consumed.user_id);
      loginAttempts.clear();
      return sendJSON(res, 200, { ok: true });
    }
    if (pathname === '/api/track-visit' && method === 'POST') {
      db.prepare('INSERT INTO site_visits DEFAULT VALUES').run();
      return sendJSON(res, 201, { ok: true });
    }
    if (pathname === '/api/config' && method === 'GET') {
      return sendJSON(res, 200, { google_client_id: process.env.GOOGLE_CLIENT_ID || null });
    }
    if (pathname === '/api/categories' && method === 'GET') {
      const cats = db.prepare('SELECT id, slug, name, icon FROM categories WHERE is_active = 1 ORDER BY id').all();
      const subs = db.prepare('SELECT id, category_id, slug, name FROM subcategories ORDER BY id').all();
      const rows = cats.map((c) => ({ ...c, subcategories: subs.filter((s) => s.category_id === c.id) }));
      return sendJSON(res, 200, rows);
    }
    // Vue admin : renvoie TOUTES les catégories (actives et en pause), pour
    // que l'écran de gestion puisse afficher et rebasculer chacune.
    if (pathname === '/api/admin/categories' && method === 'GET') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const cats = db
        .prepare(
          `SELECT c.id, c.slug, c.name, c.icon, c.is_active,
                  COUNT(l.id) AS listing_count
           FROM categories c
           LEFT JOIN listings l ON l.category_id = c.id AND l.status = 'active' AND l.expires_at > datetime('now')
           GROUP BY c.id
           ORDER BY c.id`
        )
        .all();
      return sendJSON(res, 200, cats.map((c) => ({ ...c, is_active: !!c.is_active })));
    }
    // Filet de sécurité : réactive toutes les catégories globalement en un
    // clic, au cas où l'une d'elles aurait été désactivée par erreur (par
    // exemple pendant des tests) sans qu'on s'en aperçoive immédiatement —
    // les exclusions par pays, elles, ne sont pas touchées par cette route.
    if (pathname === '/api/admin/categories/reactivate-all' && method === 'POST') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const result = db.prepare('UPDATE categories SET is_active = 1 WHERE is_active = 0').run();
      return sendJSON(res, 200, { reactivated: result.changes });
    }
    // Bascule activer/désactiver une catégorie — les annonces déjà publiées
    // dessus ne sont jamais touchées, seule sa disponibilité pour de
    // nouvelles publications et son apparition dans les filtres changent.
    const categoryToggleMatch = pathname.match(/^\/api\/admin\/categories\/(\d+)\/toggle$/);
    if (categoryToggleMatch && method === 'PUT') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const categoryId = Number(categoryToggleMatch[1]);
      const category = db.prepare('SELECT id, is_active FROM categories WHERE id = ?').get(categoryId);
      if (!category) return sendJSON(res, 404, { error: 'Catégorie introuvable.' });
      const newValue = category.is_active ? 0 : 1;
      db.prepare('UPDATE categories SET is_active = ? WHERE id = ?').run(newValue, categoryId);
      return sendJSON(res, 200, { id: categoryId, is_active: !!newValue });
    }
    // Catégories désactivées pour un pays donné — utilisé côté client pour
    // filtrer les menus de catégorie lors de la navigation ou de la
    // publication dans ce pays. Léger : ne renvoie que les exceptions.
    const countryExclusionsMatch = pathname.match(/^\/api\/countries\/(\d+)\/category-exclusions$/);
    if (countryExclusionsMatch && method === 'GET') {
      const rows = db.prepare('SELECT category_id FROM category_country_exclusions WHERE country_id = ?').all(Number(countryExclusionsMatch[1]));
      return sendJSON(res, 200, rows.map((r) => r.category_id));
    }
    // Vue admin : pour un pays donné, la liste complète des catégories avec
    // un indicateur booléen précisant si chacune y est désactivée.
    const adminCountryExclusionsMatch = pathname.match(/^\/api\/admin\/countries\/(\d+)\/category-exclusions$/);
    if (adminCountryExclusionsMatch && method === 'GET') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const countryId = Number(adminCountryExclusionsMatch[1]);
      const excluded = new Set(db.prepare('SELECT category_id FROM category_country_exclusions WHERE country_id = ?').all(countryId).map((r) => r.category_id));
      const cats = db.prepare('SELECT id, slug, name, icon FROM categories ORDER BY id').all();
      return sendJSON(res, 200, cats.map((c) => ({ ...c, excluded: excluded.has(c.id) })));
    }
    // Bascule une exception catégorie/pays (ajoute ou retire la ligne).
    if (pathname === '/api/admin/category-country-exclusions/toggle' && method === 'POST') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const body = await readBody(req);
      const categoryId = Number(body.category_id);
      const countryId = Number(body.country_id);
      if (!categoryId || !countryId) return sendJSON(res, 400, { error: 'Paramètres invalides.' });
      const existing = db.prepare('SELECT 1 FROM category_country_exclusions WHERE category_id = ? AND country_id = ?').get(categoryId, countryId);
      if (existing) {
        db.prepare('DELETE FROM category_country_exclusions WHERE category_id = ? AND country_id = ?').run(categoryId, countryId);
        return sendJSON(res, 200, { excluded: false });
      }
      db.prepare('INSERT INTO category_country_exclusions (category_id, country_id) VALUES (?, ?)').run(categoryId, countryId);
      return sendJSON(res, 200, { excluded: true });
    }
    if (pathname === '/api/countries' && method === 'GET') {
      const rows = db
        .prepare(
          `SELECT c.id, c.name, c.iso2, c.iso_numeric, c.currency, c.is_federal,
                  c.capital, c.population_millions, c.languages, c.continent,
                  COUNT(DISTINCT ci.id) AS city_count,
                  COUNT(DISTINCT l.id) AS listing_count
           FROM countries c
           LEFT JOIN cities ci ON ci.country_id = c.id
           LEFT JOIN listings l ON l.city_id = ci.id AND l.status = 'active' AND l.expires_at > datetime('now')
           GROUP BY c.id
           ORDER BY c.name`
        )
        .all();
      return sendJSON(res, 200, rows.map((r) => ({ ...r, is_federal: !!r.is_federal })));
    }
    let m;
    if ((m = pathname.match(/^\/api\/countries\/(\d+)\/cities$/)) && method === 'GET') {
      const countryId = Number(m[1]);
      const rows = db
        .prepare(
          `SELECT ci.id, ci.name, ci.timezone,
                  COUNT(l.id) AS listing_count
           FROM cities ci
           LEFT JOIN listings l ON l.city_id = ci.id AND l.status = 'active' AND l.expires_at > datetime('now')
           WHERE ci.country_id = ? AND ci.state_id IS NULL
           GROUP BY ci.id
           ORDER BY ci.name`
        )
        .all(countryId);
      return sendJSON(res, 200, rows);
    }
    if ((m = pathname.match(/^\/api\/countries\/(\d+)\/states$/)) && method === 'GET') {
      const countryId = Number(m[1]);
      const rows = db
        .prepare(
          `SELECT s.id, s.name, s.code,
                  COUNT(DISTINCT ci.id) AS city_count,
                  COUNT(DISTINCT l.id) AS listing_count
           FROM states s
           LEFT JOIN cities ci ON ci.state_id = s.id
           LEFT JOIN listings l ON l.city_id = ci.id AND l.status = 'active' AND l.expires_at > datetime('now')
           WHERE s.country_id = ?
           GROUP BY s.id
           ORDER BY s.name`
        )
        .all(countryId);
      return sendJSON(res, 200, rows);
    }
    if ((m = pathname.match(/^\/api\/states\/(\d+)\/cities$/)) && method === 'GET') {
      const stateId = Number(m[1]);
      const rows = db
        .prepare(
          `SELECT ci.id, ci.name, ci.timezone,
                  COUNT(l.id) AS listing_count
           FROM cities ci
           LEFT JOIN listings l ON l.city_id = ci.id AND l.status = 'active' AND l.expires_at > datetime('now')
           WHERE ci.state_id = ?
           GROUP BY ci.id
           ORDER BY ci.name`
        )
        .all(stateId);
      return sendJSON(res, 200, rows);
    }
    if ((m = pathname.match(/^\/api\/countries\/iso\/(\d+)$/)) && method === 'GET') {
      const isoNumeric = m[1];
      const row = db.prepare('SELECT * FROM countries WHERE iso_numeric = ?').get(isoNumeric);
      if (!row) return sendJSON(res, 404, { error: 'Pays non référencé' });
      return sendJSON(res, 200, row);
    }
    // Mode exploration façon roulette du globe : une annonce active tirée
    // au sort n'importe où sur le site, avec les infos de son pays pour
    // l'effet "roulette" côté client (centrer la carte dessus, etc).
    if (pathname === '/api/listings/random-explore' && method === 'GET') {
      const row = db
        .prepare(
          'SELECT l.id, l.title, l.listing_type, l.price, l.currency, l.images_json, cat.icon AS category_icon, cat.slug AS category_slug, cat.name AS category_name, ci.name AS city_name, co.iso2 AS country_iso2, co.name AS country_name, co.iso_numeric FROM listings l JOIN categories cat ON cat.id = l.category_id JOIN cities ci ON ci.id = l.city_id JOIN countries co ON co.id = ci.country_id WHERE l.status = \'active\' AND l.expires_at > datetime(\'now\') ORDER BY RANDOM() LIMIT 1'
        )
        .get();
      if (!row) return sendJSON(res, 404, { error: 'Aucune annonce disponible' });
      return sendJSON(res, 200, { ...row, images: JSON.parse(row.images_json) });
    }
    if (pathname === '/api/listings/featured' && method === 'GET') {
      const limit = Math.min(Number(url.searchParams.get('limit')) || 8, 24);
      const countryId = url.searchParams.get('country_id');
      const baseQuery = (withCountry) => `
        SELECT l.id, l.title, l.listing_type, l.price, l.currency, l.images_json, l.boosted_until, l.created_at,
               cat.slug AS category_slug, cat.name AS category_name, cat.icon AS category_icon,
               sub.slug AS subcategory_slug, sub.name AS subcategory_name,
               ci.name AS city_name, ci.timezone AS city_timezone, co.iso2 AS country_iso2, co.name AS country_name, co.currency AS country_currency, l.is_secondhand, l.date_start, l.date_end, l.price_promo, l.price_type, l.capacity_guests, l.bedrooms, l.bathrooms, l.amenities_json, l.vehicle_brand, l.vehicle_model, l.vehicle_year, l.vehicle_mileage, l.vehicle_condition, l.vehicle_transmission, l.vehicle_fuel_type, l.is_demo, l.transaction_completed, l.created_at, l.expires_at
        FROM listings l
        JOIN categories cat ON cat.id = l.category_id
        LEFT JOIN subcategories sub ON sub.id = l.subcategory_id
        JOIN cities ci ON ci.id = l.city_id
        JOIN countries co ON co.id = ci.country_id
        WHERE l.status = 'active' AND l.expires_at > datetime('now') ${withCountry ? 'AND co.id = ?' : ''}
        ORDER BY (l.boosted_until IS NOT NULL AND l.boosted_until > datetime('now')) DESC, RANDOM()
        LIMIT ?`;
      let rows = [];
      if (countryId) {
        rows = db.prepare(baseQuery(true)).all(countryId, limit);
      }
      if (rows.length === 0) {
        rows = db.prepare(baseQuery(false)).all(limit);
      }
      return sendJSON(res, 200, rows.map((r) => ({ ...r, images: JSON.parse(r.images_json) })));
    }
    if (pathname === '/api/listings/promo' && method === 'GET') {
      const row = db
        .prepare(
          `SELECT l.id, l.title, l.listing_type, l.price, l.currency, l.images_json, l.boosted_until, l.view_count, l.is_secondhand, l.date_start, l.date_end, l.price_promo, l.price_type, l.capacity_guests, l.bedrooms, l.bathrooms, l.amenities_json, l.vehicle_brand, l.vehicle_model, l.vehicle_year, l.vehicle_mileage, l.vehicle_condition, l.vehicle_transmission, l.vehicle_fuel_type, l.is_demo, l.transaction_completed, l.created_at, l.expires_at,
                  cat.slug AS category_slug, cat.name AS category_name, cat.icon AS category_icon,
                  ci.name AS city_name, co.iso2 AS country_iso2, co.name AS country_name
           FROM listings l
           JOIN categories cat ON cat.id = l.category_id
           JOIN cities ci ON ci.id = l.city_id
           JOIN countries co ON co.id = ci.country_id
           WHERE l.status = 'active' AND l.expires_at > datetime('now')
           ORDER BY l.view_count DESC, l.created_at DESC
           LIMIT 1`
        )
        .get();
      if (!row) return sendJSON(res, 200, null);
      row.images = JSON.parse(row.images_json);
      return sendJSON(res, 200, row);
    }
    if (pathname === '/api/activity-feed' && method === 'GET') {
      const rows = db
        .prepare(
          `SELECT l.id, l.title, l.listing_type, l.created_at,
                  cat.icon AS category_icon, ci.name AS city_name, co.name AS country_name, co.iso2 AS country_iso2, co.iso_numeric AS country_iso_numeric
           FROM listings l
           JOIN categories cat ON cat.id = l.category_id
           JOIN cities ci ON ci.id = l.city_id
           JOIN countries co ON co.id = ci.country_id
           WHERE l.status = 'active'
           ORDER BY l.created_at DESC
           LIMIT 20`
        )
        .all();
      return sendJSON(res, 200, rows);
    }
    if (pathname === '/api/demand-signals' && method === 'GET') {
      const cityId = url.searchParams.get('city_id');
      const categoryId = url.searchParams.get('category_id');
      if (!cityId && !categoryId) return sendJSON(res, 200, { count: 0 });
      const row = db
        .prepare(
          `SELECT COUNT(*) AS count FROM saved_searches ss
           WHERE (ss.city_id IS NULL OR ss.city_id = ?)
             AND (ss.category_id IS NULL OR ss.category_id = ?)
             AND (ss.city_id IS NOT NULL OR ss.category_id IS NOT NULL)`
        )
        .get(cityId || null, categoryId || null);
      return sendJSON(res, 200, { count: row.count });
    }
    if ((m = pathname.match(/^\/api\/users\/(\d+)\/passport$/)) && method === 'GET') {
      const targetUserId = Number(m[1]);
      const targetUser = db.prepare('SELECT id, name, created_at FROM users WHERE id = ?').get(targetUserId);
      if (!targetUser) return sendJSON(res, 404, { error: 'Utilisateur introuvable.' });
      const countriesSold = db
        .prepare(
          `SELECT DISTINCT co.id, co.name, co.iso2, MIN(l.created_at) AS first_at
           FROM listings l JOIN cities ci ON ci.id = l.city_id JOIN countries co ON co.id = ci.country_id
           WHERE l.user_id = ? GROUP BY co.id ORDER BY first_at ASC`
        )
        .all(targetUserId);
      const countriesBought = db
        .prepare(
          `SELECT DISTINCT co.id, co.name, co.iso2, MIN(o.created_at) AS first_at
           FROM offers o
           JOIN listings l ON l.id = o.listing_id
           JOIN cities ci ON ci.id = l.city_id
           JOIN countries co ON co.id = ci.country_id
           WHERE o.buyer_id = ? AND o.status = 'accepted'
           GROUP BY co.id ORDER BY first_at ASC`
        )
        .all(targetUserId);
      const reviewStats = db.prepare('SELECT COUNT(*) AS c, ROUND(AVG(rating), 1) AS avg FROM reviews WHERE seller_id = ?').get(targetUserId);
      return sendJSON(res, 200, {
        name: targetUser.name,
        member_since: targetUser.created_at,
        countries_sold: countriesSold,
        countries_bought: countriesBought,
        review_count: reviewStats.c,
        avg_rating: reviewStats.avg,
      });
    }
    if (pathname === '/api/listings/search' && method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim();
      const category = url.searchParams.get('category');
      const type = url.searchParams.get('type');
      const browseAll = url.searchParams.get('browse_all') === '1';
      if (!q && !category && !type && !browseAll) return sendJSON(res, 200, []);
      let sql = `
        SELECT l.id, l.title, l.description, l.listing_type, l.price, l.currency, l.images_json, l.created_at, l.boosted_until,
               cat.slug AS category_slug, cat.name AS category_name, cat.icon AS category_icon,
               sub.slug AS subcategory_slug, sub.name AS subcategory_name,
               ci.name AS city_name, ci.timezone AS city_timezone, co.iso2 AS country_iso2, co.name AS country_name, co.currency AS country_currency, l.is_secondhand, l.date_start, l.date_end, l.price_promo, l.price_type, l.capacity_guests, l.bedrooms, l.bathrooms, l.amenities_json, l.vehicle_brand, l.vehicle_model, l.vehicle_year, l.vehicle_mileage, l.vehicle_condition, l.vehicle_transmission, l.vehicle_fuel_type, l.is_demo, l.transaction_completed, l.created_at, l.expires_at,
               u.is_professional, u.company_name, u.company_logo_url, u.pro_tier
        FROM listings l
        JOIN categories cat ON cat.id = l.category_id
        LEFT JOIN subcategories sub ON sub.id = l.subcategory_id
        JOIN cities ci ON ci.id = l.city_id
        JOIN countries co ON co.id = ci.country_id
        JOIN users u ON u.id = l.user_id
        WHERE l.status = 'active' AND l.expires_at > datetime('now')
      `;
      const params = [];
      if (q) {
        sql += ' AND (l.title LIKE ? OR l.description LIKE ? OR ci.name LIKE ? OR co.name LIKE ?)';
        params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
      }
      if (category) {
        sql += ' AND cat.slug = ?';
        params.push(category);
      }
      if (type) {
        sql += ' AND l.listing_type = ?';
        params.push(type);
      }
      const subcategory = url.searchParams.get('subcategory');
      if (subcategory) {
        sql += ' AND sub.slug = ?';
        params.push(subcategory);
      }
      if (url.searchParams.get('secondhand') === '1') {
        sql += ' AND l.is_secondhand = 1';
      }
      sql += ` ORDER BY ${sortClause(url.searchParams.get('sort'))} LIMIT 60`;
      const rows = db.prepare(sql).all(...params).map((r) => ({ ...r, images: JSON.parse(r.images_json) }));
      return sendJSON(res, 200, rows);
    }
    if ((m = pathname.match(/^\/api\/cities\/(\d+)\/listings$/)) && method === 'GET') {
      const cityId = Number(m[1]);
      const category = url.searchParams.get('category');
      const subcategory = url.searchParams.get('subcategory');
      const type = url.searchParams.get('type');
      const q = url.searchParams.get('q');
      let sql = `
        SELECT l.id, l.title, l.description, l.listing_type, l.price, l.currency, l.images_json, l.created_at, l.boosted_until,
               cat.slug AS category_slug, cat.name AS category_name, cat.icon AS category_icon,
               sub.slug AS subcategory_slug, sub.name AS subcategory_name,
               ci.name AS city_name, ci.timezone AS city_timezone, co.iso2 AS country_iso2, co.name AS country_name, co.currency AS country_currency, l.is_secondhand, l.date_start, l.date_end, l.price_promo, l.price_type, l.capacity_guests, l.bedrooms, l.bathrooms, l.amenities_json, l.vehicle_brand, l.vehicle_model, l.vehicle_year, l.vehicle_mileage, l.vehicle_condition, l.vehicle_transmission, l.vehicle_fuel_type, l.is_demo, l.transaction_completed, l.created_at, l.expires_at,
               u.is_professional, u.company_name, u.company_logo_url, u.pro_tier
        FROM listings l
        JOIN categories cat ON cat.id = l.category_id
        LEFT JOIN subcategories sub ON sub.id = l.subcategory_id
        JOIN cities ci ON ci.id = l.city_id
        JOIN countries co ON co.id = ci.country_id
        JOIN users u ON u.id = l.user_id
        WHERE l.city_id = ? AND l.status = 'active' AND l.expires_at > datetime('now')
      `;
      const params = [cityId];
      if (category) {
        sql += ' AND cat.slug = ?';
        params.push(category);
      }
      if (subcategory) {
        sql += ' AND sub.slug = ?';
        params.push(subcategory);
      }
      if (type) {
        sql += ' AND l.listing_type = ?';
        params.push(type);
      }
      if (q) {
        sql += ' AND (l.title LIKE ? OR l.description LIKE ?)';
        params.push(`%${q}%`, `%${q}%`);
      }
      if (url.searchParams.get('secondhand') === '1') {
        sql += ' AND l.is_secondhand = 1';
      }
      sql += ` ORDER BY ${sortClause(url.searchParams.get('sort'))}`;
      const rows = db.prepare(sql).all(...params).map((r) => ({ ...r, images: JSON.parse(r.images_json) }));
      return sendJSON(res, 200, rows);
    }
    if (pathname === '/api/listings' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      if (!requireVerifiedEmail(user, res)) return;
      const body = await readBody(req);
      const { title, description, listing_type, price, currency, city_id, category_id, subcategory_id, images, open_to_trade, trade_description, language, is_secondhand, date_start, date_end, price_promo, price_type, capacity_guests, bedrooms, bathrooms, amenities, vehicle_brand, vehicle_model, vehicle_year, vehicle_mileage, vehicle_condition, vehicle_transmission, vehicle_fuel_type } = body;
      const VALID_TYPES = ['vente', 'location', 'achat', 'offre_emploi', 'demande_emploi'];
      if (!title || !listing_type || !VALID_TYPES.includes(listing_type)) {
        return sendJSON(res, 400, { error: "Titre et type d'annonce valide requis." });
      }
      const priceOptional = ['offre_emploi', 'demande_emploi', 'achat'].includes(listing_type);
      if (!priceOptional && (!price || Number(price) <= 0)) {
        return sendJSON(res, 400, { error: 'Prix invalide.' });
      }
      if (priceOptional && price !== null && price !== undefined && price !== '' && Number(price) < 0) {
        return sendJSON(res, 400, { error: 'Le montant ne peut pas être négatif.' });
      }
      const finalPrice = (price === null || price === undefined || price === '') ? null : Number(price);
      const city = db.prepare('SELECT id, country_id FROM cities WHERE id = ?').get(city_id);
      if (!city) return sendJSON(res, 400, { error: 'Ville invalide.' });
      const category = db.prepare('SELECT id, slug FROM categories WHERE id = ?').get(category_id);
      if (!category) return sendJSON(res, 400, { error: 'Catégorie invalide.' });
      const isExcluded = db.prepare('SELECT 1 FROM category_country_exclusions WHERE category_id = ? AND country_id = ?').get(category_id, city.country_id);
      if (isExcluded) return sendJSON(res, 400, { error: "Cette catégorie n'est pas disponible pour le pays sélectionné." });
      let subcategoryId = null;
      if (subcategory_id) {
        const sub = db.prepare('SELECT id FROM subcategories WHERE id = ? AND category_id = ?').get(subcategory_id, category_id);
        if (!sub) return sendJSON(res, 400, { error: 'Sous-catégorie invalide pour cette catégorie.' });
        subcategoryId = sub.id;
      } else {
        return sendJSON(res, 400, { error: 'Merci de préciser la nature exacte de l\'annonce (sous-catégorie).' });
      }
      const imagesJson = JSON.stringify(Array.isArray(images) ? images.filter(Boolean).slice(0, 6) : []);
      const listingLang = ['fr', 'en', 'ar', 'es', 'pt', 'it'].includes(language) ? language : 'fr';
      const id = db
        .prepare(
          `INSERT INTO listings (user_id, city_id, category_id, subcategory_id, title, description, listing_type, price, currency, images_json, open_to_trade, trade_description, language, is_secondhand, date_start, date_end, price_promo, price_type, capacity_guests, bedrooms, bathrooms, amenities_json, vehicle_brand, vehicle_model, vehicle_year, vehicle_mileage, vehicle_condition, vehicle_transmission, vehicle_fuel_type)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(user.id, city_id, category_id, subcategoryId, title.trim(), (description || '').trim(), listing_type, finalPrice, currency || 'EUR', imagesJson, open_to_trade ? 1 : 0, open_to_trade ? (trade_description || '').trim() || null : null, listingLang, is_secondhand ? 1 : 0, (date_start || '').trim() || null, (date_end || '').trim() || null, price_promo === null || price_promo === undefined || price_promo === '' ? null : Number(price_promo), (price_type || '').trim() || null, capacity_guests === null || capacity_guests === undefined || capacity_guests === '' ? null : Number(capacity_guests), bedrooms === null || bedrooms === undefined || bedrooms === '' ? null : Number(bedrooms), bathrooms === null || bathrooms === undefined || bathrooms === '' ? null : Number(bathrooms), Array.isArray(amenities) && amenities.length ? JSON.stringify(amenities) : null, (vehicle_brand || '').trim() || null, (vehicle_model || '').trim() || null, vehicle_year === null || vehicle_year === undefined || vehicle_year === '' ? null : Number(vehicle_year), vehicle_mileage === null || vehicle_mileage === undefined || vehicle_mileage === '' ? null : Number(vehicle_mileage), (vehicle_condition || '').trim() || null, (vehicle_transmission || '').trim() || null, (vehicle_fuel_type || '').trim() || null)
        .lastInsertRowid;
      const risk = computeFraudRisk({ price: finalPrice, currency: currency || 'EUR', description: (description || '').trim(), images, subcategoryId, userId: user.id, title: title.trim(), categorySlug: category.slug });
      if (risk.score > 0) {
        db.prepare('UPDATE listings SET fraud_risk_score = ?, fraud_risk_reasons = ? WHERE id = ?').run(risk.score, risk.reasons.join(' · '), id);
      }
      notifySavedSearchMatches({ id, title: title.trim(), description: (description || '').trim(), city_id: Number(city_id), category_id: Number(category_id), subcategory_id: subcategoryId, listing_type, user_id: user.id }).catch((err) =>
        console.error('[alertes] échec de la notification des recherches sauvegardées :', err.message)
      );
      const tierUp = checkAndAwardTierBonus(user.id);
      return sendJSON(res, 201, { id, tier_up: tierUp });
    }
    if ((m = pathname.match(/^\/api\/listings\/(\d+)$/)) && method === 'GET') {
      const row = db
        .prepare(
          `SELECT l.*, cat.slug AS category_slug, cat.name AS category_name, cat.icon AS category_icon,
                  sub.slug AS subcategory_slug, sub.name AS subcategory_name,
                  ci.name AS city_name, ci.timezone AS city_timezone, co.iso2 AS country_iso2, co.name AS country_name, co.currency AS country_currency, l.is_secondhand, l.date_start, l.date_end, l.price_promo, l.price_type, l.capacity_guests, l.bedrooms, l.bathrooms, l.amenities_json, l.vehicle_brand, l.vehicle_model, l.vehicle_year, l.vehicle_mileage, l.vehicle_condition, l.vehicle_transmission, l.vehicle_fuel_type, l.is_demo, l.transaction_completed, l.created_at, l.expires_at,
                  u.name AS owner_name, u.email_verified_at AS owner_verified_at, u.phone AS owner_phone,
                  u.is_professional AS owner_is_professional, u.company_name AS owner_company_name,
                  u.company_logo_url AS owner_company_logo_url, u.company_website AS owner_company_website,
                  u.pro_tier AS owner_pro_tier, u.email AS owner_email,
                  (SELECT ROUND(AVG(r.rating), 1) FROM reviews r WHERE r.seller_id = l.user_id) AS owner_avg_rating,
                  (SELECT COUNT(*) FROM reviews r WHERE r.seller_id = l.user_id) AS owner_review_count
           FROM listings l
           JOIN categories cat ON cat.id = l.category_id
           LEFT JOIN subcategories sub ON sub.id = l.subcategory_id
           JOIN cities ci ON ci.id = l.city_id
           JOIN countries co ON co.id = ci.country_id
           JOIN users u ON u.id = l.user_id
           WHERE l.id = ?`
        )
        .get(Number(m[1]));
      if (!row) return sendJSON(res, 404, { error: 'Annonce introuvable' });
      db.prepare('UPDATE listings SET view_count = view_count + 1 WHERE id = ?').run(row.id);
      row.view_count = row.view_count + 1;
      row.images = JSON.parse(row.images_json);
      row.owner_verified = !!row.owner_verified_at;
      row.owner_domain_verified = isDomainVerified(row.owner_email, row.owner_company_website);
      delete row.owner_email;
      const currentUser = getAuthUser(req);
      row.is_favorited = currentUser
        ? !!db.prepare('SELECT 1 FROM favorites WHERE user_id = ? AND listing_id = ?').get(currentUser.id, row.id)
        : false;
      return sendJSON(res, 200, row);
    }
    if ((m = pathname.match(/^\/api\/listings\/(\d+)\/translation$/)) && method === 'GET') {
      const listingId = Number(m[1]);
      const targetLang = url.searchParams.get('lang');
      const validLangs = ['fr', 'en', 'ar', 'es', 'pt', 'it'];
      if (!validLangs.includes(targetLang)) return sendJSON(res, 400, { error: 'Langue cible invalide.' });
      const listing = db.prepare('SELECT title, description, language FROM listings WHERE id = ?').get(listingId);
      if (!listing) return sendJSON(res, 404, { error: 'Annonce introuvable.' });
      if (listing.language === targetLang) {
        return sendJSON(res, 200, { title: listing.title, description: listing.description, cached: true, same_language: true });
      }
      const cached = db.prepare('SELECT title, description FROM listing_translations WHERE listing_id = ? AND lang_code = ?').get(listingId, targetLang);
      if (cached) return sendJSON(res, 200, { ...cached, cached: true, same_language: false });
      let result = null;
      let source = null;
      if (PLATFORM_AI_API_KEY) {
        try {
          result = await translateListing({
            provider: PLATFORM_AI_PROVIDER,
            apiKey: PLATFORM_AI_API_KEY,
            title: listing.title,
            description: listing.description,
            targetLangCode: targetLang,
          });
          source = 'ai';
        } catch (err) {
          console.error('[traduction IA]', err.message);
        }
      }
      if (!result) {
        result = await translateListingFree({
          title: listing.title,
          description: listing.description,
          sourceLangCode: listing.language,
          targetLangCode: targetLang,
        });
        source = result ? 'free' : null;
      }
      if (!result) return sendJSON(res, 200, { unavailable: true });
      db.prepare('INSERT OR REPLACE INTO listing_translations (listing_id, lang_code, title, description) VALUES (?, ?, ?, ?)').run(listingId, targetLang, result.title, result.description);
      return sendJSON(res, 200, { ...result, cached: false, same_language: false, source });
    }
    if ((m = pathname.match(/^\/api\/listings\/(\d+)\/similar$/)) && method === 'GET') {
      const listingId = Number(m[1]);
      const listing = db.prepare('SELECT category_id, subcategory_id, city_id, user_id FROM listings WHERE id = ?').get(listingId);
      if (!listing) return sendJSON(res, 404, { error: 'Annonce introuvable' });
      const rows = db
        .prepare(
          `SELECT l.id, l.title, l.listing_type, l.price, l.currency, l.images_json, l.boosted_until, l.is_secondhand, l.date_start, l.date_end, l.price_promo, l.price_type, l.capacity_guests, l.bedrooms, l.bathrooms, l.amenities_json, l.vehicle_brand, l.vehicle_model, l.vehicle_year, l.vehicle_mileage, l.vehicle_condition, l.vehicle_transmission, l.vehicle_fuel_type, l.is_demo, l.transaction_completed, l.created_at, l.expires_at,
                  cat.slug AS category_slug, cat.name AS category_name, cat.icon AS category_icon,
                  sub.slug AS subcategory_slug, sub.name AS subcategory_name, ci.name AS city_name, co.iso2 AS country_iso2, co.name AS country_name
           FROM listings l
           JOIN categories cat ON cat.id = l.category_id
           LEFT JOIN subcategories sub ON sub.id = l.subcategory_id
           JOIN cities ci ON ci.id = l.city_id
           JOIN countries co ON co.id = ci.country_id
           WHERE l.category_id = ? AND l.id != ? AND l.status = 'active' AND l.expires_at > datetime('now')
           ORDER BY (l.city_id = ?) DESC, (l.subcategory_id = ?) DESC, l.created_at DESC
           LIMIT 4`
        )
        .all(listing.category_id, listingId, listing.city_id, listing.subcategory_id)
        .map((r) => ({ ...r, images: JSON.parse(r.images_json) }));
      return sendJSON(res, 200, rows);
    }
    // "Sur le chemin" — annonces de même catégorie dans d'autres villes du
    // même pays. Faute de coordonnées GPS par ville, la proximité
    // géographique réelle n'est pas calculée : on utilise le pays comme
    // proxy raisonnable (même pays = plausiblement "sur la route").
    if ((m = pathname.match(/^\/api\/listings\/(\d+)\/on-the-path$/)) && method === 'GET') {
      const listingId = Number(m[1]);
      const listing = db
        .prepare(
          `SELECT l.category_id, l.city_id, ci.country_id
           FROM listings l JOIN cities ci ON ci.id = l.city_id
           WHERE l.id = ?`
        )
        .get(listingId);
      if (!listing) return sendJSON(res, 404, { error: 'Annonce introuvable' });
      const rows = db
        .prepare(
          `SELECT l.id, l.title, l.listing_type, l.price, l.currency, l.images_json, l.boosted_until, l.is_secondhand, l.date_start, l.date_end, l.price_promo, l.price_type,
                  cat.slug AS category_slug, cat.name AS category_name, cat.icon AS category_icon,
                  sub.slug AS subcategory_slug, sub.name AS subcategory_name, ci.name AS city_name, co.iso2 AS country_iso2, co.name AS country_name
           FROM listings l
           JOIN categories cat ON cat.id = l.category_id
           LEFT JOIN subcategories sub ON sub.id = l.subcategory_id
           JOIN cities ci ON ci.id = l.city_id
           JOIN countries co ON co.id = ci.country_id
           WHERE l.category_id = ? AND l.id != ? AND ci.country_id = ? AND l.city_id != ? AND l.status = 'active' AND l.expires_at > datetime('now')
           GROUP BY l.city_id
           ORDER BY RANDOM()
           LIMIT 3`
        )
        .all(listing.category_id, listingId, listing.country_id, listing.city_id)
        .map((r) => ({ ...r, images: JSON.parse(r.images_json) }));
      return sendJSON(res, 200, rows);
    }
    if (pathname === '/api/reviews' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      const { listing_id, rating, comment } = await readBody(req);
      const ratingNum = Number(rating);
      if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
        return sendJSON(res, 400, { error: 'La note doit être un entier entre 1 et 5.' });
      }
      const listing = db.prepare('SELECT user_id FROM listings WHERE id = ?').get(listing_id);
      if (!listing) return sendJSON(res, 404, { error: 'Annonce introuvable.' });
      if (listing.user_id === user.id) return sendJSON(res, 400, { error: 'Vous ne pouvez pas vous noter vous-même.' });
      try {
        db.prepare('INSERT INTO reviews (seller_id, reviewer_id, listing_id, rating, comment) VALUES (?, ?, ?, ?, ?)')
          .run(listing.user_id, user.id, listing_id, ratingNum, (comment || '').trim());
      } catch {
        return sendJSON(res, 409, { error: 'Vous avez déjà laissé un avis pour cette annonce.' });
      }
      return sendJSON(res, 201, { ok: true });
    }
    if ((m = pathname.match(/^\/api\/users\/(\d+)\/reviews$/)) && method === 'GET') {
      const rows = db
        .prepare(
          `SELECT r.rating, r.comment, r.created_at, u.name AS reviewer_name, l.title AS listing_title
           FROM reviews r
           JOIN users u ON u.id = r.reviewer_id
           JOIN listings l ON l.id = r.listing_id
           WHERE r.seller_id = ?
           ORDER BY r.created_at DESC
           LIMIT 50`
        )
        .all(Number(m[1]));
      return sendJSON(res, 200, rows);
    }
    if ((m = pathname.match(/^\/api\/listings\/(\d+)$/)) && (method === 'PUT' || method === 'DELETE')) {
      const user = requireAuth(req, res);
      if (!user) return;
      const listingId = Number(m[1]);
      const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(listingId);
      if (!listing) return sendJSON(res, 404, { error: 'Annonce introuvable' });
      if (listing.user_id !== user.id && user.role !== 'admin') return sendJSON(res, 403, { error: "Vous n'êtes pas propriétaire de cette annonce." });
      if (method === 'DELETE') {
        db.prepare('DELETE FROM listings WHERE id = ?').run(listingId);
        return sendJSON(res, 200, { ok: true });
      }
      const body = await readBody(req);
      const fields = ['title', 'description', 'listing_type', 'price', 'currency', 'city_id', 'category_id', 'subcategory_id', 'status'];
      const updates = [];
      const params = [];
      for (const f of fields) {
        if (body[f] !== undefined) {
          updates.push(`${f} = ?`);
          params.push(f === 'images' ? JSON.stringify(body[f]) : body[f]);
        }
      }
      if (body.images !== undefined) {
        updates.push('images_json = ?');
        params.push(JSON.stringify(Array.isArray(body.images) ? body.images.filter(Boolean).slice(0, 6) : []));
      }
      updates.push("updated_at = datetime('now')");
      if (updates.length) {
        params.push(listingId);
        db.prepare(`UPDATE listings SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      }
      return sendJSON(res, 200, { ok: true });
    }
    if ((m = pathname.match(/^\/api\/listings\/(\d+)\/renew$/)) && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      const listing = db.prepare('SELECT user_id FROM listings WHERE id = ?').get(Number(m[1]));
      if (!listing) return sendJSON(res, 404, { error: 'Annonce introuvable.' });
      if (listing.user_id !== user.id && user.role !== 'admin') return sendJSON(res, 403, { error: "Vous n'êtes pas propriétaire de cette annonce." });
      db.prepare("UPDATE listings SET expires_at = datetime('now', '+60 days'), status = 'active', expiry_reminder_sent = 0, expired_notice_sent = 0 WHERE id = ?").run(Number(m[1]));
      return sendJSON(res, 200, { ok: true });
    }
    // Cachet "Vendu" / "Loué" — actionnable uniquement par le propriétaire
    // (ou un admin), n'affecte pas le statut d'expiration de l'annonce.
    if ((m = pathname.match(/^\/api\/listings\/(\d+)\/mark-completed$/)) && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      const listing = db.prepare('SELECT user_id, transaction_completed FROM listings WHERE id = ?').get(Number(m[1]));
      if (!listing) return sendJSON(res, 404, { error: 'Annonce introuvable.' });
      if (listing.user_id !== user.id && user.role !== 'admin') return sendJSON(res, 403, { error: "Vous n'êtes pas propriétaire de cette annonce." });
      const newValue = listing.transaction_completed ? 0 : 1;
      db.prepare('UPDATE listings SET transaction_completed = ? WHERE id = ?').run(newValue, Number(m[1]));
      return sendJSON(res, 200, { transaction_completed: !!newValue });
    }
    if ((m = pathname.match(/^\/api\/listings\/(\d+)\/boost$/)) && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      const listing = db.prepare('SELECT user_id FROM listings WHERE id = ?').get(Number(m[1]));
      if (!listing) return sendJSON(res, 404, { error: 'Annonce introuvable.' });
      if (listing.user_id !== user.id && user.role !== 'admin') return sendJSON(res, 403, { error: "Vous n'êtes pas propriétaire de cette annonce." });
      const freshUser = db.prepare('SELECT free_boost_credits FROM users WHERE id = ?').get(user.id);
      const usedCredit = freshUser.free_boost_credits > 0;
      if (usedCredit) db.prepare('UPDATE users SET free_boost_credits = free_boost_credits - 1 WHERE id = ?').run(user.id);
      db.prepare("UPDATE listings SET boosted_until = datetime('now', '+7 days') WHERE id = ?").run(Number(m[1]));
      return sendJSON(res, 200, { ok: true, demo: !usedCredit, used_credit: usedCredit });
    }
    if (pathname === '/api/me/stats' && method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      const totals = db
        .prepare(
          `SELECT
             COUNT(*) AS total_listings,
             SUM(CASE WHEN status = 'active' AND expires_at > datetime('now') THEN 1 ELSE 0 END) AS active_listings,
             SUM(CASE WHEN expires_at <= datetime('now') THEN 1 ELSE 0 END) AS expired_listings,
             COALESCE(SUM(view_count), 0) AS total_views
           FROM listings WHERE user_id = ?`
        )
        .get(user.id);
      const favCount = db
        .prepare(`SELECT COUNT(*) AS c FROM favorites f JOIN listings l ON l.id = f.listing_id WHERE l.user_id = ?`)
        .get(user.id).c;
      const reviewStats = db
        .prepare(`SELECT COUNT(*) AS c, ROUND(AVG(rating), 1) AS avg FROM reviews WHERE seller_id = ?`)
        .get(user.id);
      const topListings = db
        .prepare(
          `SELECT id, title, view_count, (SELECT COUNT(*) FROM favorites f WHERE f.listing_id = listings.id) AS fav_count
           FROM listings WHERE user_id = ? ORDER BY view_count DESC LIMIT 5`
        )
        .all(user.id);
      return sendJSON(res, 200, {
        total_listings: totals.total_listings,
        active_listings: totals.active_listings,
        expired_listings: totals.expired_listings,
        total_views: totals.total_views,
        total_favorites_received: favCount,
        review_count: reviewStats.c,
        avg_rating: reviewStats.avg,
        top_listings: topListings,
      });
    }
    if (pathname === '/api/me/listings' && method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      const rows = db
        .prepare(
          `SELECT l.id, l.title, l.listing_type, l.price, l.currency, l.status, l.images_json, l.created_at,
                  l.expires_at, l.boosted_until, l.view_count, l.is_secondhand, l.date_start, l.date_end, l.price_promo, l.price_type, l.capacity_guests, l.bedrooms, l.bathrooms, l.amenities_json, l.vehicle_brand, l.vehicle_model, l.vehicle_year, l.vehicle_mileage, l.vehicle_condition, l.vehicle_transmission, l.vehicle_fuel_type, l.is_demo, l.transaction_completed, l.created_at,
                  ci.name AS city_name, co.iso2 AS country_iso2, co.name AS country_name, cat.slug AS category_slug, cat.name AS category_name,
                  sub.slug AS subcategory_slug, sub.name AS subcategory_name,
                  (SELECT COUNT(*) FROM favorites f WHERE f.listing_id = l.id) AS favorite_count
           FROM listings l
           JOIN cities ci ON ci.id = l.city_id
           JOIN countries co ON co.id = ci.country_id
           JOIN categories cat ON cat.id = l.category_id
           LEFT JOIN subcategories sub ON sub.id = l.subcategory_id
           WHERE l.user_id = ?
           ORDER BY l.created_at DESC`
        )
        .all(user.id)
        .map((r) => ({ ...r, images: JSON.parse(r.images_json) }));
      return sendJSON(res, 200, rows);
    }
    if (pathname === '/api/admin/users' && method === 'GET') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const rows = db
        .prepare(
          `SELECT u.id, u.name, u.email, u.role, u.created_at,
                  COUNT(l.id) AS listing_count
           FROM users u
           LEFT JOIN listings l ON l.user_id = u.id
           GROUP BY u.id
           ORDER BY u.created_at DESC`
        )
        .all();
      return sendJSON(res, 200, rows);
    }
    if ((m = pathname.match(/^\/api\/admin\/users\/(\d+)\/role$/)) && method === 'PUT') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const targetId = Number(m[1]);
      const { role } = await readBody(req);
      if (!['user', 'admin'].includes(role)) return sendJSON(res, 400, { error: 'Rôle invalide.' });
      const target = db.prepare('SELECT id, role FROM users WHERE id = ?').get(targetId);
      if (!target) return sendJSON(res, 404, { error: 'Utilisateur introuvable.' });
      if (target.role === 'admin' && role === 'user') {
        const adminCount = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get().c;
        if (adminCount <= 1) return sendJSON(res, 400, { error: "Impossible : c'est le dernier compte administrateur." });
      }
      db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, targetId);
      return sendJSON(res, 200, { ok: true });
    }
    if ((m = pathname.match(/^\/api\/admin\/users\/(\d+)$/)) && method === 'DELETE') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const targetId = Number(m[1]);
      const target = db.prepare('SELECT id, role FROM users WHERE id = ?').get(targetId);
      if (!target) return sendJSON(res, 404, { error: 'Utilisateur introuvable.' });
      if (targetId === admin.id) return sendJSON(res, 400, { error: 'Vous ne pouvez pas supprimer votre propre compte depuis ce panneau.' });
      if (target.role === 'admin') {
        const adminCount = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get().c;
        if (adminCount <= 1) return sendJSON(res, 400, { error: "Impossible : c'est le dernier compte administrateur." });
      }
      db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
      return sendJSON(res, 200, { ok: true });
    }
    if (pathname === '/api/admin/listings' && method === 'GET') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const rows = db
        .prepare(
          `SELECT l.id, l.title, l.listing_type, l.price, l.currency, l.status, l.created_at, l.is_secondhand, l.date_start, l.date_end, l.price_promo, l.price_type, l.capacity_guests, l.bedrooms, l.bathrooms, l.amenities_json, l.vehicle_brand, l.vehicle_model, l.vehicle_year, l.vehicle_mileage, l.vehicle_condition, l.vehicle_transmission, l.vehicle_fuel_type, l.is_demo, l.transaction_completed, l.expires_at,
                  l.fraud_risk_score, l.fraud_risk_reasons,
                  cat.name AS category_name, ci.name AS city_name, co.iso2 AS country_iso2, co.name AS country_name,
                  u.name AS owner_name, u.email AS owner_email
           FROM listings l
           JOIN categories cat ON cat.id = l.category_id
           JOIN cities ci ON ci.id = l.city_id
           JOIN countries co ON co.id = ci.country_id
           JOIN users u ON u.id = l.user_id
           ORDER BY l.fraud_risk_score DESC, l.created_at DESC`
        )
        .all();
      return sendJSON(res, 200, rows);
    }
    if (pathname === '/api/admin/stats' && method === 'GET') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const totalUsers = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
      const totalAdmins = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get().c;
      const totalListings = db.prepare('SELECT COUNT(*) AS c FROM listings').get().c;
      const activeListings = db.prepare("SELECT COUNT(*) AS c FROM listings WHERE status = 'active'").get().c;
      const suspendedListings = totalListings - activeListings;
      const newListings7d = db.prepare("SELECT COUNT(*) AS c FROM listings WHERE created_at >= datetime('now', '-7 days')").get().c;
      const newUsers7d = db.prepare("SELECT COUNT(*) AS c FROM users WHERE created_at >= datetime('now', '-7 days')").get().c;
      const totalVisits = db.prepare('SELECT COUNT(*) AS c FROM site_visits').get().c;
      const visits7d = db.prepare("SELECT COUNT(*) AS c FROM site_visits WHERE created_at >= datetime('now', '-7 days')").get().c;
      const countriesWithListings = db
        .prepare(
          `SELECT COUNT(DISTINCT co.id) AS c
           FROM countries co JOIN cities ci ON ci.country_id = co.id
           JOIN listings l ON l.city_id = ci.id AND l.status = 'active' AND l.expires_at > datetime('now')`
        )
        .get().c;
      const byCategory = db
        .prepare(
          `SELECT cat.slug, cat.name, cat.icon, COUNT(l.id) AS count
           FROM categories cat
           LEFT JOIN listings l ON l.category_id = cat.id AND l.status = 'active' AND l.expires_at > datetime('now')
           GROUP BY cat.id ORDER BY count DESC`
        )
        .all();
      const byType = db
        .prepare(
          `SELECT listing_type, COUNT(*) AS count FROM listings WHERE status = 'active' GROUP BY listing_type`
        )
        .all();
      const byCountry = db
        .prepare(
          `SELECT co.name, COUNT(l.id) AS count
           FROM countries co
           JOIN cities ci ON ci.country_id = co.id
           JOIN listings l ON l.city_id = ci.id AND l.status = 'active' AND l.expires_at > datetime('now')
           GROUP BY co.id ORDER BY count DESC LIMIT 8`
        )
        .all();
      const dailyRows = db
        .prepare(
          `SELECT date(created_at) AS day, COUNT(*) AS count
           FROM listings
           WHERE created_at >= datetime('now', '-29 days')
           GROUP BY day ORDER BY day`
        )
        .all();
      const dailyMap = Object.fromEntries(dailyRows.map((r) => [r.day, r.count]));
      const daily = [];
      for (let i = 29; i >= 0; i--) {
        const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
        daily.push({ day: d, count: dailyMap[d] || 0 });
      }
      const dailyVisitRows = db
        .prepare(
          `SELECT date(created_at) AS day, COUNT(*) AS count
           FROM site_visits
           WHERE created_at >= datetime('now', '-29 days')
           GROUP BY day ORDER BY day`
        )
        .all();
      const dailyVisitMap = Object.fromEntries(dailyVisitRows.map((r) => [r.day, r.count]));
      const dailyVisits = [];
      for (let i = 29; i >= 0; i--) {
        const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
        dailyVisits.push({ day: d, count: dailyVisitMap[d] || 0 });
      }
      return sendJSON(res, 200, {
        totalUsers, totalAdmins, totalListings, activeListings, suspendedListings,
        newListings7d, newUsers7d, countriesWithListings, totalVisits, visits7d,
        byCategory, byType, byCountry, daily, dailyVisits,
      });
    }
    if (pathname === '/api/conversations' && method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      const rows = db
        .prepare(
          `SELECT c.id, c.listing_id, l.title AS listing_title, l.images_json,
                  c.buyer_id, c.seller_id, ub.name AS buyer_name, us.name AS seller_name,
                  (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,
                  (SELECT created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message_at,
                  (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.sender_id != ? AND m.read_at IS NULL) AS unread_count
           FROM conversations c
           JOIN listings l ON l.id = c.listing_id
           JOIN users ub ON ub.id = c.buyer_id
           JOIN users us ON us.id = c.seller_id
           WHERE c.buyer_id = ? OR c.seller_id = ?
           ORDER BY last_message_at DESC`
        )
        .all(user.id, user.id, user.id)
        .map((r) => ({
          id: r.id,
          listing_id: r.listing_id,
          listing_title: r.listing_title,
          listing_image: (JSON.parse(r.images_json || '[]')[0]) || null,
          other_user_name: r.buyer_id === user.id ? r.seller_name : r.buyer_name,
          last_message: r.last_message,
          last_message_at: r.last_message_at,
          unread_count: r.unread_count,
        }));
      return sendJSON(res, 200, rows);
    }
    if (pathname === '/api/conversations/unread-count' && method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      const row = db
        .prepare(
          `SELECT COUNT(*) AS c FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
           WHERE (c.buyer_id = ? OR c.seller_id = ?) AND m.sender_id != ? AND m.read_at IS NULL`
        )
        .get(user.id, user.id, user.id);
      return sendJSON(res, 200, { count: row.c });
    }
    if (pathname === '/api/conversations' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      if (!requireVerifiedEmail(user, res)) return;
      const { listing_id, body, image_url } = await readBody(req);
      if ((!body || !body.trim()) && !image_url) return sendJSON(res, 400, { error: 'Le message ne peut pas être vide.' });
      if (image_url && !isValidUploadedImagePath(image_url)) return sendJSON(res, 400, { error: 'Image jointe invalide.' });
      const listing = db.prepare('SELECT id, user_id FROM listings WHERE id = ?').get(listing_id);
      if (!listing) return sendJSON(res, 404, { error: 'Annonce introuvable.' });
      if (listing.user_id === user.id) return sendJSON(res, 400, { error: 'Vous ne pouvez pas vous contacter vous-même.' });
      let conversation = db.prepare('SELECT * FROM conversations WHERE listing_id = ? AND buyer_id = ?').get(listing_id, user.id);
      if (!conversation) {
        const convId = db
          .prepare('INSERT INTO conversations (listing_id, buyer_id, seller_id) VALUES (?, ?, ?)')
          .run(listing_id, user.id, listing.user_id).lastInsertRowid;
        conversation = { id: convId };
      }
      db.prepare('INSERT INTO messages (conversation_id, sender_id, body, image_url) VALUES (?, ?, ?, ?)').run(conversation.id, user.id, (body || '').trim(), image_url || null);
      return sendJSON(res, 201, { conversation_id: conversation.id });
    }
    if ((m = pathname.match(/^\/api\/conversations\/(\d+)\/messages$/)) && method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      const convId = Number(m[1]);
      const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId);
      if (!conversation || (conversation.buyer_id !== user.id && conversation.seller_id !== user.id)) {
        return sendJSON(res, 404, { error: 'Conversation introuvable.' });
      }
      db.prepare(
        "UPDATE messages SET read_at = datetime('now') WHERE conversation_id = ? AND sender_id != ? AND read_at IS NULL"
      ).run(convId, user.id);
      const messages = db
        .prepare('SELECT id, sender_id, body, image_url, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC')
        .all(convId);
      const offers = db
        .prepare('SELECT id, buyer_id, kind, amount, currency, trade_description, status, created_at, responded_at FROM offers WHERE conversation_id = ? ORDER BY created_at ASC')
        .all(convId);
      const listing = db.prepare('SELECT id, title, images_json FROM listings WHERE id = ?').get(conversation.listing_id);
      const otherUserId = conversation.buyer_id === user.id ? conversation.seller_id : conversation.buyer_id;
      const otherUser = db.prepare('SELECT id, name FROM users WHERE id = ?').get(otherUserId);
      return sendJSON(res, 200, {
        id: conversation.id,
        listing: listing ? { id: listing.id, title: listing.title, image: JSON.parse(listing.images_json || '[]')[0] || null } : null,
        other_user: otherUser,
        other_user_is_seller: conversation.seller_id === otherUserId,
        is_seller: conversation.seller_id === user.id,
        messages,
        offers,
      });
    }
    if ((m = pathname.match(/^\/api\/conversations\/(\d+)\/messages$/)) && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      if (!requireVerifiedEmail(user, res)) return;
      const convId = Number(m[1]);
      const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId);
      if (!conversation || (conversation.buyer_id !== user.id && conversation.seller_id !== user.id)) {
        return sendJSON(res, 404, { error: 'Conversation introuvable.' });
      }
      const { body, image_url } = await readBody(req);
      if ((!body || !body.trim()) && !image_url) return sendJSON(res, 400, { error: 'Le message ne peut pas être vide.' });
      if (image_url && !isValidUploadedImagePath(image_url)) return sendJSON(res, 400, { error: 'Image jointe invalide.' });
      const id = db
        .prepare('INSERT INTO messages (conversation_id, sender_id, body, image_url) VALUES (?, ?, ?, ?)')
        .run(convId, user.id, (body || '').trim(), image_url || null).lastInsertRowid;
      return sendJSON(res, 201, { id });
    }
    if ((m = pathname.match(/^\/api\/conversations\/(\d+)\/offers$/)) && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      if (!requireVerifiedEmail(user, res)) return;
      const convId = Number(m[1]);
      const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId);
      if (!conversation || conversation.buyer_id !== user.id) {
        return sendJSON(res, 404, { error: 'Conversation introuvable.' });
      }
      const { amount, kind, trade_description } = await readBody(req);
      const offerKind = kind === 'echange' ? 'echange' : 'argent';
      const listing = db.prepare('SELECT currency FROM listings WHERE id = ?').get(conversation.listing_id);
      if (offerKind === 'argent') {
        const amountNum = Number(amount);
        if (!amountNum || amountNum <= 0) return sendJSON(res, 400, { error: 'Montant invalide.' });
        const id = db
          .prepare('INSERT INTO offers (conversation_id, listing_id, buyer_id, kind, amount, currency) VALUES (?, ?, ?, ?, ?, ?)')
          .run(convId, conversation.listing_id, user.id, 'argent', amountNum, listing ? listing.currency : 'EUR').lastInsertRowid;
        return sendJSON(res, 201, { id });
      }
      if (!trade_description || !trade_description.trim()) {
        return sendJSON(res, 400, { error: 'Merci de décrire ce que vous proposez en échange.' });
      }
      const id = db
        .prepare('INSERT INTO offers (conversation_id, listing_id, buyer_id, kind, trade_description, currency) VALUES (?, ?, ?, ?, ?, ?)')
        .run(convId, conversation.listing_id, user.id, 'echange', trade_description.trim(), listing ? listing.currency : 'EUR').lastInsertRowid;
      return sendJSON(res, 201, { id });
    }
    if ((m = pathname.match(/^\/api\/offers\/(\d+)$/)) && method === 'PUT') {
      const user = requireAuth(req, res);
      if (!user) return;
      const offer = db.prepare('SELECT o.*, c.seller_id FROM offers o JOIN conversations c ON c.id = o.conversation_id WHERE o.id = ?').get(Number(m[1]));
      if (!offer) return sendJSON(res, 404, { error: 'Offre introuvable.' });
      if (offer.seller_id !== user.id) return sendJSON(res, 403, { error: 'Seul le vendeur peut répondre à cette offre.' });
      const { status } = await readBody(req);
      if (!['accepted', 'rejected'].includes(status)) return sendJSON(res, 400, { error: 'Statut invalide.' });
      db.prepare("UPDATE offers SET status = ?, responded_at = datetime('now') WHERE id = ?").run(status, offer.id);
      return sendJSON(res, 200, { ok: true });
    }
    if (pathname === '/api/events' && method === 'GET') {
      const countryId = url.searchParams.get('country_id');
      if (!countryId) return sendJSON(res, 400, { error: 'country_id requis.' });
      const rows = db
        .prepare(
          `SELECT e.id, e.title, e.description, e.event_date, e.end_date, e.location_name, e.external_link,
                  ci.name AS city_name, u.name AS organizer_name
           FROM events e
           LEFT JOIN cities ci ON ci.id = e.city_id
           JOIN users u ON u.id = e.user_id
           WHERE e.country_id = ? AND e.status = 'active' AND (e.end_date IS NOT NULL AND e.end_date >= date('now') OR e.end_date IS NULL AND e.event_date >= date('now'))
           ORDER BY e.event_date ASC
           LIMIT 20`
        )
        .all(countryId);
      return sendJSON(res, 200, rows);
    }
    if (pathname === '/api/events' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      if (!requireVerifiedEmail(user, res)) return;
      const { country_id, city_id, title, description, event_date, end_date, location_name, external_link } = await readBody(req);
      if (!country_id || !title || !title.trim() || !event_date) {
        return sendJSON(res, 400, { error: 'Pays, titre et date sont obligatoires.' });
      }
      const id = db
        .prepare(
          `INSERT INTO events (user_id, country_id, city_id, title, description, event_date, end_date, location_name, external_link)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(user.id, country_id, city_id || null, title.trim(), (description || '').trim(), event_date, end_date || null, location_name || null, external_link || null)
        .lastInsertRowid;
      return sendJSON(res, 201, { id });
    }
    if ((m = pathname.match(/^\/api\/events\/(\d+)$/)) && method === 'DELETE') {
      const user = requireAuth(req, res);
      if (!user) return;
      const event = db.prepare('SELECT user_id FROM events WHERE id = ?').get(Number(m[1]));
      if (!event) return sendJSON(res, 404, { error: 'Événement introuvable.' });
      if (event.user_id !== user.id && user.role !== 'admin') return sendJSON(res, 403, { error: "Vous n'êtes pas l'organisateur de cet événement." });
      db.prepare('DELETE FROM events WHERE id = ?').run(Number(m[1]));
      return sendJSON(res, 200, { ok: true });
    }
    if (pathname === '/api/business-opportunities' && method === 'GET') {
      const countryId = url.searchParams.get('country_id');
      if (!countryId) return sendJSON(res, 400, { error: 'country_id requis.' });
      const listings = db
        .prepare(
          `SELECT l.id, l.title, l.listing_type, l.price, l.currency, l.images_json, l.is_secondhand, l.date_start, l.date_end, l.price_promo, l.price_type, l.capacity_guests, l.bedrooms, l.bathrooms, l.amenities_json, l.vehicle_brand, l.vehicle_model, l.vehicle_year, l.vehicle_mileage, l.vehicle_condition, l.vehicle_transmission, l.vehicle_fuel_type, l.is_demo, l.transaction_completed, l.created_at, l.expires_at,
                  sub.slug AS subcategory_slug, sub.name AS subcategory_name,
                  ci.name AS city_name, co.iso2 AS country_iso2, co.name AS country_name
           FROM listings l
           JOIN categories cat ON cat.id = l.category_id
           LEFT JOIN subcategories sub ON sub.id = l.subcategory_id
           JOIN cities ci ON ci.id = l.city_id
           JOIN countries co ON co.id = ci.country_id
           WHERE cat.slug = 'opportunites-affaires' AND co.id = ? AND l.status = 'active' AND l.expires_at > datetime('now')
           ORDER BY l.created_at DESC LIMIT 12`
        )
        .all(countryId)
        .map(({ images_json, ...r }) => ({ ...r, images: JSON.parse(images_json) }));
      const events = db
        .prepare(
          `SELECT e.id, e.title, e.event_date, e.end_date, e.location_name, e.external_link, ci.name AS city_name
           FROM events e LEFT JOIN cities ci ON ci.id = e.city_id
           WHERE e.country_id = ? AND e.status = 'active'
             AND (e.end_date IS NOT NULL AND e.end_date >= date('now') OR e.end_date IS NULL AND e.event_date >= date('now'))
           ORDER BY e.event_date ASC LIMIT 8`
        )
        .all(countryId);
      const jobCount = db
        .prepare(
          `SELECT COUNT(*) AS c FROM listings l
           JOIN categories cat ON cat.id = l.category_id
           JOIN cities ci ON ci.id = l.city_id
           WHERE cat.slug = 'emploi' AND l.listing_type = 'offre_emploi' AND ci.country_id = ? AND l.status = 'active' AND l.expires_at > datetime('now')`
        )
        .get(countryId).c;
      return sendJSON(res, 200, { listings, events, job_offers_count: jobCount });
    }
    if (pathname === '/api/reports' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      const { listing_id, reason, details } = await readBody(req);
      if (!reason) return sendJSON(res, 400, { error: 'Merci de préciser un motif de signalement.' });
      const listing = db.prepare('SELECT id FROM listings WHERE id = ?').get(listing_id);
      if (!listing) return sendJSON(res, 404, { error: 'Annonce introuvable.' });
      db.prepare('INSERT INTO reports (listing_id, reporter_id, reason, details) VALUES (?, ?, ?, ?)')
        .run(listing_id, user.id, reason, (details || '').trim());
      return sendJSON(res, 201, { ok: true });
    }
    if (pathname === '/api/admin/reports' && method === 'GET') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const rows = db
        .prepare(
          `SELECT r.id, r.reason, r.details, r.status, r.created_at,
                  r.listing_id, l.title AS listing_title, l.status AS listing_status,
                  u.name AS reporter_name, u.email AS reporter_email
           FROM reports r
           JOIN listings l ON l.id = r.listing_id
           JOIN users u ON u.id = r.reporter_id
           ORDER BY r.created_at DESC`
        )
        .all();
      return sendJSON(res, 200, rows);
    }
    if ((m = pathname.match(/^\/api\/admin\/reports\/(\d+)$/)) && method === 'PUT') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const { status } = await readBody(req);
      if (!['open', 'resolved', 'dismissed'].includes(status)) return sendJSON(res, 400, { error: 'Statut invalide.' });
      db.prepare('UPDATE reports SET status = ? WHERE id = ?').run(status, Number(m[1]));
      return sendJSON(res, 200, { ok: true });
    }
    if (pathname === '/api/admin/emails' && method === 'GET') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const rows = db.prepare('SELECT * FROM email_outbox ORDER BY created_at DESC LIMIT 200').all();
      return sendJSON(res, 200, rows);
    }
    if (pathname === '/api/uploads' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      const { data, mime } = await readBody(req);
      const allowed = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
      const ext = allowed[mime];
      if (!ext || !data) return sendJSON(res, 400, { error: 'Image invalide (formats acceptés : JPEG, PNG, WEBP, GIF).' });
      const buffer = Buffer.from(data, 'base64');
      if (buffer.length > 5_000_000) return sendJSON(res, 400, { error: 'Image trop volumineuse (5 Mo maximum).' });
      const uploadsDir = path.join(DATA_DIR, 'uploads');
      if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
      // Compression + conversion en WebP (taille et poids réduits, sans perte
      // visible) — avec repli honnête sur le fichier d'origine si jamais la
      // compression échouait pour une image particulière (jamais un échec
      // bloquant pour l'utilisateur).
      try {
        const compressed = await sharp(buffer)
          .rotate()
          .resize({ width: 1600, withoutEnlargement: true })
          .webp({ quality: 82 })
          .toBuffer();
        const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.webp`;
        fs.writeFileSync(path.join(uploadsDir, filename), compressed);
        return sendJSON(res, 201, { url: `/uploads/${filename}` });
      } catch (err) {
        console.error('[upload] échec de la compression, sauvegarde du fichier original :', err.message);
        const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
        fs.writeFileSync(path.join(uploadsDir, filename), buffer);
        return sendJSON(res, 201, { url: `/uploads/${filename}` });
      }
    }
    if (pathname === '/api/geo-guess' && method === 'GET') {
      const tz = url.searchParams.get('tz');
      const locale = url.searchParams.get('locale');
      let country = null;
      if (tz) {
        country = db
          .prepare(
            `SELECT co.* FROM countries co
             JOIN cities ci ON ci.country_id = co.id
             WHERE ci.timezone = ? LIMIT 1`
          )
          .get(tz);
      }
      if (!country && locale) {
        const region = locale.split(/[-_]/).pop().toUpperCase();
        country = db.prepare('SELECT * FROM countries WHERE iso2 = ?').get(region);
      }
      return sendJSON(res, 200, { country: country ? { id: country.id, name: country.name } : null });
    }
    if (pathname === '/api/me/ai-settings' && method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      const row = db.prepare('SELECT ai_provider, ai_api_key_encrypted FROM users WHERE id = ?').get(user.id);
      return sendJSON(res, 200, { provider: row.ai_provider || null, has_key: !!row.ai_api_key_encrypted });
    }
    if (pathname === '/api/me/ai-settings' && method === 'PUT') {
      const user = requireAuth(req, res);
      if (!user) return;
      const { provider, api_key } = await readBody(req);
      if (!api_key) {
        db.prepare('UPDATE users SET ai_provider = NULL, ai_api_key_encrypted = NULL WHERE id = ?').run(user.id);
        return sendJSON(res, 200, { provider: null, has_key: false });
      }
      if (!['anthropic', 'openai'].includes(provider)) return sendJSON(res, 400, { error: 'Fournisseur invalide.' });
      const encrypted = encryptApiKey(api_key.trim());
      db.prepare('UPDATE users SET ai_provider = ?, ai_api_key_encrypted = ? WHERE id = ?').run(provider, encrypted, user.id);
      return sendJSON(res, 200, { provider, has_key: true });
    }
    if (pathname === '/api/ai/translate-country-profile' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      const account = db.prepare('SELECT ai_provider, ai_api_key_encrypted FROM users WHERE id = ?').get(user.id);
      if (!account.ai_api_key_encrypted) {
        return sendJSON(res, 400, { error: 'AI_NOT_CONFIGURED' });
      }
      const { country_id, field, target_lang } = await readBody(req);
      const allowedFields = ['business_climate', 'culture', 'gastronomy', 'practical_tips', 'holidays'];
      if (!allowedFields.includes(field)) {
        return sendJSON(res, 400, { error: 'Rubrique invalide.' });
      }
      const profile = db.prepare(`SELECT ${field} AS text FROM country_profiles WHERE country_id = ?`).get(country_id);
      if (!profile || !profile.text) return sendJSON(res, 404, { error: 'Rubrique introuvable pour ce pays.' });
      try {
        const apiKey = decryptApiKey(account.ai_api_key_encrypted);
        const translated = await translateText({
          provider: account.ai_provider,
          apiKey,
          text: profile.text,
          targetLangCode: target_lang,
        });
        return sendJSON(res, 200, { text: translated });
      } catch (err) {
        return sendJSON(res, 502, { error: `La traduction a échoué : ${err.message}` });
      }
    }
    if (pathname === '/api/ai/translate-listing' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      const account = db.prepare('SELECT ai_provider, ai_api_key_encrypted FROM users WHERE id = ?').get(user.id);
      if (!account.ai_api_key_encrypted) {
        return sendJSON(res, 400, { error: 'AI_NOT_CONFIGURED' });
      }
      const { listing_id, target_lang } = await readBody(req);
      const listing = db.prepare('SELECT title, description FROM listings WHERE id = ?').get(listing_id);
      if (!listing) return sendJSON(res, 404, { error: 'Annonce introuvable.' });
      try {
        const apiKey = decryptApiKey(account.ai_api_key_encrypted);
        const result = await translateListing({
          provider: account.ai_provider,
          apiKey,
          title: listing.title,
          description: listing.description,
          targetLangCode: target_lang,
        });
        return sendJSON(res, 200, result);
      } catch (err) {
        return sendJSON(res, 502, { error: `La traduction a échoué : ${err.message}` });
      }
    }
    if (pathname === '/api/ai/draft-listing' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      const account = db.prepare('SELECT ai_provider, ai_api_key_encrypted FROM users WHERE id = ?').get(user.id);
      if (!account.ai_api_key_encrypted) {
        return sendJSON(res, 400, { error: 'AI_NOT_CONFIGURED' });
      }
      const { category_id, subcategory_id, listing_type, notes } = await readBody(req);
      if (!notes || !notes.trim()) return sendJSON(res, 400, { error: 'Merci de décrire brièvement le bien.' });
      const category = db.prepare('SELECT name FROM categories WHERE id = ?').get(category_id);
      const subcategory = subcategory_id ? db.prepare('SELECT name FROM subcategories WHERE id = ?').get(subcategory_id) : null;
      try {
        const apiKey = decryptApiKey(account.ai_api_key_encrypted);
        const result = await draftListing({
          provider: account.ai_provider,
          apiKey,
          categoryName: category ? category.name : '',
          subcategoryName: subcategory ? subcategory.name : '',
          listingType: listing_type,
          notes: notes.trim(),
        });
        return sendJSON(res, 200, result);
      } catch (err) {
        return sendJSON(res, 502, { error: `La génération a échoué : ${err.message}` });
      }
    }
    if (pathname === '/api/ai/analyze-fraud' && method === 'POST') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const account = db.prepare('SELECT ai_provider, ai_api_key_encrypted FROM users WHERE id = ?').get(admin.id);
      if (!account.ai_api_key_encrypted) {
        return sendJSON(res, 400, { error: 'AI_NOT_CONFIGURED' });
      }
      const { listing_id } = await readBody(req);
      const listing = db
        .prepare(
          `SELECT l.title, l.description, l.price, l.currency, l.fraud_risk_reasons, cat.name AS category_name
           FROM listings l JOIN categories cat ON cat.id = l.category_id WHERE l.id = ?`
        )
        .get(listing_id);
      if (!listing) return sendJSON(res, 404, { error: 'Annonce introuvable.' });
      try {
        const apiKey = decryptApiKey(account.ai_api_key_encrypted);
        const result = await analyzeFraudRisk({
          provider: account.ai_provider,
          apiKey,
          title: listing.title,
          description: listing.description,
          price: listing.price,
          currency: listing.currency,
          categoryName: listing.category_name,
          riskReasons: listing.fraud_risk_reasons ? listing.fraud_risk_reasons.split(' · ') : [],
        });
        return sendJSON(res, 200, result);
      } catch (err) {
        return sendJSON(res, 502, { error: `L'analyse a échoué : ${err.message}` });
      }
    }
    if (pathname === '/api/favorites' && method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      const rows = db
        .prepare(
          `SELECT l.id, l.title, l.listing_type, l.price, l.currency, l.images_json, l.boosted_until, l.created_at, l.view_count, l.is_secondhand, l.date_start, l.date_end, l.price_promo, l.price_type, l.capacity_guests, l.bedrooms, l.bathrooms, l.amenities_json, l.vehicle_brand, l.vehicle_model, l.vehicle_year, l.vehicle_mileage, l.vehicle_condition, l.vehicle_transmission, l.vehicle_fuel_type, l.is_demo, l.transaction_completed, l.expires_at,
                  cat.slug AS category_slug, cat.name AS category_name, cat.icon AS category_icon,
                  sub.slug AS subcategory_slug, sub.name AS subcategory_name,
                  ci.name AS city_name, co.iso2 AS country_iso2, co.name AS country_name
           FROM favorites f
           JOIN listings l ON l.id = f.listing_id
           JOIN categories cat ON cat.id = l.category_id
           LEFT JOIN subcategories sub ON sub.id = l.subcategory_id
           JOIN cities ci ON ci.id = l.city_id
           JOIN countries co ON co.id = ci.country_id
           WHERE f.user_id = ? AND l.status = 'active' AND l.expires_at > datetime('now')
           ORDER BY f.created_at DESC`
        )
        .all(user.id)
        .map((r) => ({ ...r, images: JSON.parse(r.images_json) }));
      return sendJSON(res, 200, rows);
    }
    if (pathname === '/api/favorites/ids' && method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      const rows = db.prepare('SELECT listing_id FROM favorites WHERE user_id = ?').all(user.id);
      return sendJSON(res, 200, rows.map((r) => r.listing_id));
    }
    if (pathname === '/api/favorites' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      const { listing_id } = await readBody(req);
      const listing = db.prepare('SELECT id FROM listings WHERE id = ?').get(listing_id);
      if (!listing) return sendJSON(res, 404, { error: 'Annonce introuvable.' });
      try {
        db.prepare('INSERT INTO favorites (user_id, listing_id) VALUES (?, ?)').run(user.id, listing_id);
      } catch { /* déjà en favoris : ignoré silencieusement */ }
      return sendJSON(res, 201, { ok: true });
    }
    if ((m = pathname.match(/^\/api\/favorites\/(\d+)$/)) && method === 'DELETE') {
      const user = requireAuth(req, res);
      if (!user) return;
      db.prepare('DELETE FROM favorites WHERE user_id = ? AND listing_id = ?').run(user.id, Number(m[1]));
      return sendJSON(res, 200, { ok: true });
    }
    // Favoris pays/villes — accès direct depuis l'accueil, en plus du
    // parcours pays -> ville déjà en place (ne le remplace pas).
    if (pathname === '/api/me/favorite-destinations' && method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      const countries = db
        .prepare(
          `SELECT co.id, co.iso2, co.name, co.iso_numeric
           FROM favorite_countries fc JOIN countries co ON co.id = fc.country_id
           WHERE fc.user_id = ? ORDER BY fc.created_at DESC`
        )
        .all(user.id);
      const cities = db
        .prepare(
          `SELECT ci.id, ci.name, co.iso2 AS country_iso2, co.name AS country_name, ci.country_id
           FROM favorite_cities fcy JOIN cities ci ON ci.id = fcy.city_id JOIN countries co ON co.id = ci.country_id
           WHERE fcy.user_id = ? ORDER BY fcy.created_at DESC`
        )
        .all(user.id);
      return sendJSON(res, 200, { countries, cities });
    }
    // Signalement d'une ville manquante — accessible sans connexion (juste
    // un email), permet d'être notifié quand la ville est réellement ajoutée.
    // Ajout direct d'une ville depuis l'administration — évite de passer
    // par un script en base à chaque fois. La vérification/notification
    // automatique des demandes en attente (checkCityRequestFulfillments)
    // détectera cette nouvelle ville lors de son prochain passage horaire,
    // sans action supplémentaire nécessaire.
    // Logo personnalisé — lecture publique (affiché à tous les visiteurs),
    // modification et réinitialisation réservées à l'administration.
    if (pathname === '/api/settings/logo' && method === 'GET') {
      const row = db.prepare("SELECT value FROM site_settings WHERE key = 'logo_url'").get();
      return sendJSON(res, 200, { url: row ? row.value : null });
    }
    if (pathname === '/api/admin/settings/logo' && method === 'POST') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const body = await readBody(req);
      const logoUrl = (body.url || '').trim();
      if (!logoUrl) return sendJSON(res, 400, { error: 'URL de logo requise.' });
      db.prepare("INSERT INTO site_settings (key, value) VALUES ('logo_url', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(logoUrl);
      return sendJSON(res, 200, { url: logoUrl });
    }
    if (pathname === '/api/admin/settings/logo' && method === 'DELETE') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      db.prepare("DELETE FROM site_settings WHERE key = 'logo_url'").run();
      return sendJSON(res, 200, { ok: true });
    }
    // Boîte de réception admin — liste, lecture (marque comme lu) et
    // réponse (via le même mécanisme d'envoi que le reste du site).
    // Composition libre — envoie un nouvel email à n'importe quelle
    // adresse, sans être rattaché à un message reçu (contrairement à
    // /reply). Utilise le même mécanisme d'envoi que le reste du site.
    if (pathname === '/api/admin/inbox/compose' && method === 'POST') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const body = await readBody(req);
      const to = (body.to || '').trim();
      const subject = (body.subject || '').trim();
      const text = (body.text || '').trim();
      if (!to || !subject || !text) {
        return sendJSON(res, 400, { error: 'Destinataire, sujet et message sont requis.' });
      }
      await sendMail({ to, purpose: 'admin_compose', subject, text, link: SITE_URL });
      db.prepare(
        "INSERT INTO inbox_emails (uid, from_address, to_address, subject, body_text, received_at, direction, is_read) VALUES (?, ?, ?, ?, ?, ?, 'sent', 1)"
      ).run(-Date.now() - Math.floor(Math.random() * 1000), admin.email || 'contact@quickatlas.net', to, subject, text, new Date().toISOString());
      return sendJSON(res, 200, { ok: true });
    }
    if (pathname === '/api/admin/inbox' && method === 'GET') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const view = url.searchParams.get('view') === 'sent' ? 'sent' : 'received';
      const rows = db
        .prepare('SELECT id, from_address, from_name, to_address, subject, received_at, is_read, replied, direction FROM inbox_emails WHERE direction = ? ORDER BY received_at DESC LIMIT 200')
        .all(view);
      return sendJSON(res, 200, rows);
    }
    if ((m = pathname.match(/^\/api\/admin\/inbox\/(\d+)$/)) && method === 'GET') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const email = db.prepare('SELECT * FROM inbox_emails WHERE id = ?').get(Number(m[1]));
      if (!email) return sendJSON(res, 404, { error: 'Email introuvable.' });
      db.prepare('UPDATE inbox_emails SET is_read = 1 WHERE id = ?').run(email.id);
      const sentReplies = db.prepare('SELECT * FROM inbox_emails WHERE in_reply_to_id = ? ORDER BY received_at ASC').all(email.id);
      return sendJSON(res, 200, { ...email, sent_replies: sentReplies });
    }
    if ((m = pathname.match(/^\/api\/admin\/inbox\/(\d+)\/reply$/)) && method === 'POST') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const email = db.prepare('SELECT * FROM inbox_emails WHERE id = ?').get(Number(m[1]));
      if (!email) return sendJSON(res, 404, { error: 'Email introuvable.' });
      const body = await readBody(req);
      const replyText = (body.text || '').trim();
      if (!replyText) return sendJSON(res, 400, { error: 'Message vide.' });
      await sendMail({
        to: email.from_address,
        purpose: 'admin_reply',
        subject: email.subject && email.subject.startsWith('Re:') ? email.subject : `Re: ${email.subject || ''}`,
        text: replyText,
        link: SITE_URL,
      });
      db.prepare('UPDATE inbox_emails SET replied = 1 WHERE id = ?').run(email.id);
      db.prepare(
        "INSERT INTO inbox_emails (uid, from_address, to_address, subject, body_text, received_at, direction, is_read, in_reply_to_id) VALUES (?, ?, ?, ?, ?, ?, 'sent', 1, ?)"
      ).run(
        -Date.now() - Math.floor(Math.random() * 1000),
        admin.email || 'contact@quickatlas.net',
        email.from_address,
        email.subject && email.subject.startsWith('Re:') ? email.subject : `Re: ${email.subject || ''}`,
        replyText,
        new Date().toISOString(),
        email.id
      );
      return sendJSON(res, 200, { ok: true });
    }
    if (pathname === '/api/admin/cities' && method === 'POST') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const body = await readBody(req);
      const countryId = Number(body.country_id);
      const stateId = body.state_id ? Number(body.state_id) : null;
      const name = (body.name || '').trim();
      const timezone = (body.timezone || '').trim();
      if (!countryId || !name || !timezone) {
        return sendJSON(res, 400, { error: 'Pays, nom de ville et fuseau horaire sont requis.' });
      }
      const country = db.prepare('SELECT is_federal FROM countries WHERE id = ?').get(countryId);
      if (country && country.is_federal && !stateId) {
        return sendJSON(res, 400, { error: 'Ce pays est fédéral : sélectionnez un État avant de continuer.' });
      }
      const existing = stateId
        ? db.prepare('SELECT id FROM cities WHERE state_id = ? AND name = ?').get(stateId, name)
        : db.prepare('SELECT id FROM cities WHERE country_id = ? AND name = ? AND state_id IS NULL').get(countryId, name);
      if (existing) return sendJSON(res, 409, { error: 'Cette ville existe déjà.' });
      const cityId = db.prepare('INSERT INTO cities (country_id, state_id, name, timezone) VALUES (?, ?, ?, ?)').run(countryId, stateId, name, timezone).lastInsertRowid;
      return sendJSON(res, 201, { id: cityId, name, timezone });
    }
    if (pathname === '/api/city-requests' && method === 'POST') {
      const body = await readBody(req);
      const countryId = Number(body.country_id);
      const stateId = body.state_id ? Number(body.state_id) : null;
      const cityName = (body.city_name || '').trim();
      const email = (body.email || '').trim();
      const message = (body.message || '').trim();
      if (!countryId || !cityName || !email) {
        return sendJSON(res, 400, { error: 'Pays, nom de ville et email sont requis.' });
      }
      db.prepare('INSERT INTO city_requests (country_id, state_id, city_name, email, message) VALUES (?, ?, ?, ?, ?)').run(countryId, stateId, cityName, email, message || null);
      return sendJSON(res, 201, { ok: true });
    }
    if (pathname === '/api/admin/city-requests' && method === 'GET') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const rows = db
        .prepare(
          `SELECT cr.id, cr.city_name, cr.email, cr.message, cr.status, cr.created_at, cr.country_id, cr.state_id, co.name AS country_name, co.iso2 AS country_iso2, st.name AS state_name
           FROM city_requests cr JOIN countries co ON co.id = cr.country_id
           LEFT JOIN states st ON st.id = cr.state_id
           ORDER BY cr.status ASC, cr.created_at DESC`
        )
        .all();
      return sendJSON(res, 200, rows);
    }
    // Marque une demande comme traitée et envoie un email de notification au
    // demandeur — à utiliser une fois la ville effectivement ajoutée en base.
    if ((m = pathname.match(/^\/api\/admin\/city-requests\/(\d+)\/fulfill$/)) && method === 'POST') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const requestId = Number(m[1]);
      const reqRow = db.prepare('SELECT * FROM city_requests WHERE id = ?').get(requestId);
      if (!reqRow) return sendJSON(res, 404, { error: 'Demande introuvable' });
      db.prepare("UPDATE city_requests SET status = 'fulfilled', notified_at = datetime('now') WHERE id = ?").run(requestId);
      try {
        await sendMail({
          to: reqRow.email,
          purpose: 'city_request_fulfilled',
          subject: `${reqRow.city_name} est maintenant disponible sur QuickAtlas`,
          text: `Bonjour,\n\nVous nous aviez signalé l'absence de ${reqRow.city_name}. Bonne nouvelle : cette ville est désormais disponible sur QuickAtlas !\n\nÀ bientôt,\nL'équipe QuickAtlas`,
          link: SITE_URL,
        });
      } catch { /* la demande reste marquée traitée même si l'email échoue */ }
      return sendJSON(res, 200, { ok: true });
    }
    if (pathname === '/api/favorite-countries' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      const { country_id } = await readBody(req);
      try {
        db.prepare('INSERT INTO favorite_countries (user_id, country_id) VALUES (?, ?)').run(user.id, country_id);
      } catch { /* déjà en favoris */ }
      return sendJSON(res, 201, { ok: true });
    }
    if ((m = pathname.match(/^\/api\/favorite-countries\/(\d+)$/)) && method === 'DELETE') {
      const user = requireAuth(req, res);
      if (!user) return;
      db.prepare('DELETE FROM favorite_countries WHERE user_id = ? AND country_id = ?').run(user.id, Number(m[1]));
      return sendJSON(res, 200, { ok: true });
    }
    if (pathname === '/api/favorite-cities' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      const { city_id } = await readBody(req);
      try {
        db.prepare('INSERT INTO favorite_cities (user_id, city_id) VALUES (?, ?)').run(user.id, city_id);
      } catch { /* déjà en favoris */ }
      return sendJSON(res, 201, { ok: true });
    }
    if ((m = pathname.match(/^\/api\/favorite-cities\/(\d+)$/)) && method === 'DELETE') {
      const user = requireAuth(req, res);
      if (!user) return;
      db.prepare('DELETE FROM favorite_cities WHERE user_id = ? AND city_id = ?').run(user.id, Number(m[1]));
      return sendJSON(res, 200, { ok: true });
    }
    if ((m = pathname.match(/^\/api\/countries\/(\d+)\/profile$/)) && method === 'GET') {
      const profile = db.prepare('SELECT * FROM country_profiles WHERE country_id = ?').get(Number(m[1]));
      return sendJSON(res, 200, profile || null);
    }
    if ((m = pathname.match(/^\/api\/countries\/(\d+)\/economic-stats$/)) && method === 'GET') {
      const countryId = Number(m[1]);
      const country = db.prepare('SELECT iso2 FROM countries WHERE id = ?').get(countryId);
      if (!country) return sendJSON(res, 404, { error: 'Pays introuvable.' });
      const stats = await getEconomicStats(countryId, country.iso2);
      return sendJSON(res, 200, {
        gdp_usd: stats.gdp_usd, gdp_year: stats.gdp_year,
        gdp_per_capita_usd: stats.gdp_per_capita_usd, gdp_per_capita_year: stats.gdp_per_capita_year,
        gdp_growth_pct: stats.gdp_growth_pct, gdp_growth_year: stats.gdp_growth_year,
        unemployment_pct: stats.unemployment_pct, unemployment_year: stats.unemployment_year,
        inflation_pct: stats.inflation_pct, inflation_year: stats.inflation_year,
        status: stats.fetch_status,
        source: 'Banque mondiale (api.worldbank.org)',
      });
    }
    if (pathname === '/api/saved-searches' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      const { label, country_id, city_id, category_id, subcategory_id, listing_type, keyword, email_alerts } = await readBody(req);
      if (!label || !label.trim()) return sendJSON(res, 400, { error: "Merci de donner un nom à cette alerte." });
      const id = db
        .prepare(
          `INSERT INTO saved_searches (user_id, label, country_id, city_id, category_id, subcategory_id, listing_type, keyword, email_alerts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(user.id, label.trim(), country_id || null, city_id || null, category_id || null, subcategory_id || null, listing_type || null, (keyword || '').trim() || null, email_alerts === false ? 0 : 1)
        .lastInsertRowid;
      return sendJSON(res, 201, { id });
    }
    if (pathname === '/api/saved-searches' && method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      const rows = db
        .prepare(
          `SELECT ss.*, co.iso2 AS country_iso2, co.name AS country_name, ci.name AS city_name, cat.slug AS category_slug, cat.name AS category_name, sub.slug AS subcategory_slug, sub.name AS subcategory_name,
                  (SELECT COUNT(*) FROM saved_search_matches m WHERE m.saved_search_id = ss.id AND m.seen = 0) AS unseen_count
           FROM saved_searches ss
           LEFT JOIN countries co ON co.id = ss.country_id
           LEFT JOIN cities ci ON ci.id = ss.city_id
           LEFT JOIN categories cat ON cat.id = ss.category_id
           LEFT JOIN subcategories sub ON sub.id = ss.subcategory_id
           WHERE ss.user_id = ?
           ORDER BY ss.created_at DESC`
        )
        .all(user.id);
      return sendJSON(res, 200, rows);
    }
    if (pathname === '/api/saved-searches/unread-count' && method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      const row = db
        .prepare(
          `SELECT COUNT(*) AS count FROM saved_search_matches m
           JOIN saved_searches ss ON ss.id = m.saved_search_id
           WHERE ss.user_id = ? AND m.seen = 0`
        )
        .get(user.id);
      return sendJSON(res, 200, { count: row.count });
    }
    if ((m = pathname.match(/^\/api\/saved-searches\/(\d+)$/)) && method === 'DELETE') {
      const user = requireAuth(req, res);
      if (!user) return;
      db.prepare('DELETE FROM saved_searches WHERE id = ? AND user_id = ?').run(Number(m[1]), user.id);
      return sendJSON(res, 200, { ok: true });
    }
    if ((m = pathname.match(/^\/api\/saved-searches\/(\d+)\/matches$/)) && method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      const search = db.prepare('SELECT id FROM saved_searches WHERE id = ? AND user_id = ?').get(Number(m[1]), user.id);
      if (!search) return sendJSON(res, 404, { error: 'Alerte introuvable.' });
      const rows = db
        .prepare(
          `SELECT l.id, l.title, l.listing_type, l.price, l.currency, l.images_json, l.boosted_until, l.is_secondhand, l.date_start, l.date_end, l.price_promo, l.price_type, l.capacity_guests, l.bedrooms, l.bathrooms, l.amenities_json, l.vehicle_brand, l.vehicle_model, l.vehicle_year, l.vehicle_mileage, l.vehicle_condition, l.vehicle_transmission, l.vehicle_fuel_type, l.is_demo, l.transaction_completed, l.created_at, l.expires_at,
                  cat.slug AS category_slug, cat.name AS category_name, cat.icon AS category_icon,
                  sub.slug AS subcategory_slug, sub.name AS subcategory_name, ci.name AS city_name, co.iso2 AS country_iso2, co.name AS country_name
           FROM saved_search_matches m
           JOIN listings l ON l.id = m.listing_id
           JOIN categories cat ON cat.id = l.category_id
           LEFT JOIN subcategories sub ON sub.id = l.subcategory_id
           JOIN cities ci ON ci.id = l.city_id
           JOIN countries co ON co.id = ci.country_id
           WHERE m.saved_search_id = ? AND l.status = 'active' AND l.expires_at > datetime('now')
           ORDER BY m.created_at DESC`
        )
        .all(search.id)
        .map((r) => ({ ...r, images: JSON.parse(r.images_json) }));
      db.prepare('UPDATE saved_search_matches SET seen = 1 WHERE saved_search_id = ?').run(search.id);
      return sendJSON(res, 200, rows);
    }
    return sendJSON(res, 404, { error: 'Route API inconnue' });
  } catch (err) {
    console.error(err);
    return sendJSON(res, 500, { error: 'Erreur serveur interne' });
  }
});
server.listen(PORT, () => {
  console.log(`QuickAtlas Marketplace en écoute sur http://localhost:${PORT}`);
  checkListingExpirations().catch((err) => console.error('[expiration] échec de la vérification initiale :', err.message));
  setInterval(() => {
    checkListingExpirations().catch((err) => console.error('[expiration] échec de la vérification périodique :', err.message));
  }, 60 * 60 * 1000);
  checkCityRequestFulfillments().catch((err) => console.error('[city-request] échec de la vérification initiale :', err.message));
  setInterval(() => {
    checkCityRequestFulfillments().catch((err) => console.error('[city-request] échec de la vérification périodique :', err.message));
  }, 60 * 60 * 1000);
  checkInboxEmails().catch((err) => console.error('[inbox] échec de la synchronisation initiale :', err.message));
  setInterval(() => {
    checkInboxEmails().catch((err) => console.error('[inbox] échec de la synchronisation périodique :', err.message));
  }, 10 * 60 * 1000);
});
