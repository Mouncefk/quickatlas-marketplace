// server.js — Serveur HTTP natif (aucune dépendance externe : pas d'Express).
// Sert le front-end statique et expose une API REST JSON sous /api.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, DATA_DIR, masterDb, mainDb, getTenantDatabase, closeTenantDatabase, tenantContext, siteInfoContext, initializeDatabase, copyReferenceData } from './db.js';
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
// Limitation par adresse IP, en complément de la limitation par email
// déjà existante (const loginAttempts ci-dessus) — celle-ci protège un
// compte précis contre le bourrage de mots de passe, mais pas contre un
// attaquant qui teste rapidement de nombreuses adresses email
// différentes depuis une même IP. Seuil plus généreux qu'au niveau
// email, puisqu'une même IP peut légitimement représenter plusieurs
// utilisateurs (réseau d'entreprise, opérateur mobile...).
const loginAttemptsByIp = new Map();
const MAX_LOGIN_ATTEMPTS_PER_IP = 20;
const IP_LOCKOUT_MS = 15 * 60 * 1000;
function getClientIp(req) {
  const forwarded = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || '';
}
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
  return db.prepare('SELECT id, name, email, role, email_verified_at, phone, referral_code, free_boost_credits, is_professional, company_name, company_logo_url, company_website, social_whatsapp, social_instagram, social_facebook, social_tiktok, social_linkedin, pro_tier, created_at FROM users WHERE id = ?').get(payload.sub) || null;
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
  if (user.role !== 'admin' && user.role !== 'super_admin') {
    sendJSON(res, 403, { error: 'Réservé aux administrateurs.' });
    return null;
  }
  return user;
}
/** Réserve une route au Super Administrateur — double condition : le
 * rôle de l'utilisateur ET le fait d'être actuellement sur le site
 * principal (le panneau Super Admin n'a pas de sens depuis un site
 * client, même si un utilisateur y avait par erreur ce rôle). */
/** Nom de marque du site actuellement concerné par la requête en cours
 * (via siteInfoContext, déjà rempli au tout début de chaque requête —
 * voir resolveSiteForRequest) — utilisé dans les emails automatiques et
 * les balises SEO, pour qu'un site du réseau affiche bien SA propre
 * marque plutôt que "QuickAtlas" partout. Retombe sur "QuickAtlas" par
 * défaut si l'information n'est pour une raison quelconque pas
 * disponible (ne devrait jamais arriver en pratique). */
function currentSiteName() {
  const site = siteInfoContext.getStore();
  return (site && site.brand_name) || 'QuickAtlas';
}
/** Une catégorie est-elle désactivée pour le site actuel (voir la table
 * disabled_categories, gérée exclusivement depuis le panneau Super
 * Admin) ? Mécanisme distinct du champ categories.is_active existant,
 * qui lui reste sous le contrôle de l'administrateur du site lui-même
 * pour une pause temporaire — les deux ne doivent jamais être confondus,
 * au risque qu'un administrateur de site puisse annuler une restriction
 * commerciale décidée par le Super Admin. */
function isCategoryDisabled(categoryId) {
  if (!categoryId) return false;
  return !!db.prepare('SELECT 1 FROM disabled_categories WHERE category_id = ?').get(categoryId);
}
/** Même principe qu'isCategoryDisabled ci-dessus, pour un pays. */
function isCountryDisabled(countryId) {
  if (!countryId) return false;
  return !!db.prepare('SELECT 1 FROM disabled_countries WHERE country_id = ?').get(countryId);
}
/** Recalcule intégralement l'ensemble des villes où une annonce doit
 * apparaître (ville réelle + villes supplémentaires choisies + toutes
 * les villes du pays si activé), et le stocke dans
 * listing_visible_cities — table que toutes les recherches/parcours par
 * ville consultent, plutôt que de reproduire cette logique dans chacune
 * d'elles. À appeler après toute création ou modification d'annonce
 * touchant la ville, les villes supplémentaires ou l'option "toutes les
 * villes du pays". */
function syncListingVisibleCities(listingId) {
  const listing = db.prepare('SELECT city_id, visible_all_cities FROM listings WHERE id = ?').get(listingId);
  if (!listing) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM listing_visible_cities WHERE listing_id = ?').run(listingId);
    const insertStmt = db.prepare('INSERT OR IGNORE INTO listing_visible_cities (listing_id, city_id) VALUES (?, ?)');
    insertStmt.run(listingId, listing.city_id);
    const extraCities = db.prepare('SELECT city_id FROM listing_extra_cities WHERE listing_id = ?').all(listingId);
    for (const row of extraCities) insertStmt.run(listingId, row.city_id);
    if (listing.visible_all_cities) {
      const countryCities = db
        .prepare('SELECT id FROM cities WHERE country_id = (SELECT country_id FROM cities WHERE id = ?)')
        .all(listing.city_id);
      for (const row of countryCities) insertStmt.run(listingId, row.id);
    }
    // Pays supplémentaires entiers (Tourisme) — rend l'annonce visible
    // dans TOUTES les villes de chaque pays choisi, au-delà du pays réel
    // du bien.
    const extraCountries = db.prepare('SELECT country_id FROM listing_extra_countries WHERE listing_id = ?').all(listingId);
    for (const country of extraCountries) {
      const citiesInCountry = db.prepare('SELECT id FROM cities WHERE country_id = ?').all(country.country_id);
      for (const row of citiesInCountry) insertStmt.run(listingId, row.id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
/** Lit la configuration email propre au site actuellement concerné par
 * la requête en cours (identifiants SMTP/IMAP saisis par l'administrateur
 * de CE site précis, dans Administration → Apparence → Email) — retourne
 * null si ce site n'a rien configuré, auquel cas sendMail() et
 * checkInboxEmails() retombent sur les variables d'environnement globales
 * (site principal) ou, pour la boîte de réception, ignorent simplement ce
 * site. Jamais de repli d'un site vers les identifiants d'un AUTRE site —
 * cela mélangerait les emails de plusieurs clients entre eux. */
function getSiteMailConfig() {
  const rows = db
    .prepare("SELECT key, value FROM site_settings WHERE key IN ('smtp_host','smtp_port','smtp_user','smtp_pass_encrypted','mail_from')")
    .all();
  const settings = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  if (!settings.smtp_host || !settings.smtp_user || !settings.smtp_pass_encrypted) return null;
  let pass;
  try {
    pass = decryptApiKey(settings.smtp_pass_encrypted);
  } catch (err) {
    console.error('[mail-config] échec du déchiffrement du mot de passe SMTP :', err.message);
    return null;
  }
  return {
    host: settings.smtp_host,
    port: settings.smtp_port || null,
    user: settings.smtp_user,
    pass,
    mailFrom: settings.mail_from || null,
    fromName: currentSiteName(),
  };
}
function requireSuperAdmin(req, res) {
  const user = requireAuth(req, res);
  if (!user) return null;
  const currentSite = siteInfoContext.getStore();
  if (user.role !== 'super_admin' || !currentSite || currentSite.slug !== 'main') {
    sendJSON(res, 403, { error: 'Réservé au super administrateur, depuis le site principal.' });
    return null;
  }
  return user;
}
/** Consigne une action administrateur sensible dans le journal d'audit
 * (table admin_audit_log) de la base indiquée — targetDb est
 * explicitement passée plutôt que d'utiliser le proxy `db` ambiant, pour
 * pouvoir journaliser aussi bien dans la base d'un site (actions admin
 * classiques) que dans le registre central masterDb (actions Super
 * Admin sur les sites eux-mêmes). N'interrompt jamais l'action en cours
 * en cas d'échec d'écriture du journal — une trace manquante ne doit
 * jamais bloquer une action légitime. */
function logAdminAction(targetDb, adminUser, action, targetType, targetId, details) {
  try {
    targetDb
      .prepare(
        'INSERT INTO admin_audit_log (admin_user_id, admin_email, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(adminUser.id, adminUser.email, action, targetType || null, targetId ? String(targetId) : null, details ? JSON.stringify(details) : null);
  } catch (err) {
    console.error('[audit] échec de l\'écriture du journal :', err.message);
  }
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
/** Synchronise un dossier IMAP donné vers la table inbox_emails. Pour la
 * boîte de réception normale, les uid sont stockés tels quels (positifs).
 * Pour le dossier Spam, ils sont stockés en négatif — les uid IMAP ne sont
 * uniques qu'au sein d'un même dossier, alors que la colonne uid de la
 * base est UNIQUE globalement ; cela garantit qu'un message du spam ne
 * peut jamais entrer en collision avec un message de la boîte normale. */
async function syncImapFolder(client, { mailboxPath, settingsKey, fromSpam }) {
  const lock = await client.getMailboxLock(mailboxPath);
  try {
    const lastUidRow = db.prepare('SELECT value FROM site_settings WHERE key = ?').get(settingsKey);
    const lastUid = lastUidRow ? Number(lastUidRow.value) : 0;
    const range = lastUid > 0 ? `${lastUid + 1}:*` : '1:*';
    let maxUid = lastUid;
    let inserted = 0;
    for await (const message of client.fetch(range, { uid: true, source: true }, { uid: true })) {
      if (message.uid <= lastUid) continue;
      if (message.uid > maxUid) maxUid = message.uid;
      const storedUid = fromSpam ? -message.uid : message.uid;
      const existing = db.prepare('SELECT id FROM inbox_emails WHERE uid = ?').get(storedUid);
      if (existing) continue;
      const parsed = await simpleParser(message.source);
      const fromEntry = (parsed.from && parsed.from.value && parsed.from.value[0]) || {};
      db.prepare(
        'INSERT INTO inbox_emails (uid, from_address, from_name, subject, body_text, body_html, received_at, from_spam) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        storedUid,
        (fromEntry.address || '').toLowerCase(),
        fromEntry.name || null,
        parsed.subject || '(sans objet)',
        (parsed.text || '').slice(0, 5000),
        parsed.html ? parsed.html.slice(0, 100000) : null,
        (parsed.date || new Date()).toISOString(),
        fromSpam ? 1 : 0
      );
      inserted++;
    }
    if (maxUid > lastUid) {
      db.prepare(
        "INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).run(settingsKey, String(maxUid));
    }
    console.log(`[inbox] ${mailboxPath} : dernier uid connu = ${lastUid}, plage interrogée = ${range}, ${inserted} nouveau(x) email(s) inséré(s), nouveau dernier uid = ${maxUid}`);
    return inserted;
  } finally {
    lock.release();
  }
}
async function checkInboxEmails() {
  // Utilise la configuration propre au site actuel si elle existe (voir
  // getSiteMailConfig). Le repli sur les variables d'environnement
  // globales est réservé au SEUL site principal — un site client sans
  // configuration propre est simplement ignoré pour ce cycle, plutôt que
  // de lire par erreur la boîte du site principal et de mélanger les
  // emails de deux sites différents (ce serait une vraie fuite de
  // données entre clients).
  const siteMailConfig = getSiteMailConfig();
  const isMainSite = siteInfoContext.getStore()?.slug === 'main';
  const imapUser = siteMailConfig?.user || (isMainSite ? process.env.SMTP_USER : null);
  const imapPass = siteMailConfig?.pass || (isMainSite ? process.env.SMTP_PASS : null);
  if (!imapUser || !imapPass) {
    console.log(`[inbox] synchronisation ignorée pour ${currentSiteName()} : aucun identifiant email configuré pour ce site.`);
    return;
  }
  console.log(`[inbox] début de synchronisation (site : ${currentSiteName()}, compte : ${imapUser})`);
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: imapUser, pass: imapPass },
    logger: false,
  });
  // Essentiel : sans ce gestionnaire, une simple coupure réseau avec Gmail
  // (délai de connexion dépassé, connexion réinitialisée...) fait planter
  // tout le processus serveur — en Node.js, un événement 'error' non
  // écouté sur un flux/socket provoque un arrêt brutal du programme,
  // pas seulement de la fonction en cours.
  client.on('error', (err) => {
    console.error('[inbox] erreur de connexion IMAP (non fatale, capturée) :', err.message);
  });
  try {
    await client.connect();
  } catch (err) {
    console.error('[inbox] échec de connexion IMAP, synchronisation annulée pour ce cycle :', err.message);
    return;
  }
  try {
    await syncImapFolder(client, { mailboxPath: 'INBOX', settingsKey: 'inbox_last_uid', fromSpam: false });
    try {
      await syncImapFolder(client, { mailboxPath: '[Gmail]/Spam', settingsKey: 'inbox_spam_last_uid', fromSpam: true });
    } catch (err) {
      // Le nom exact du dossier Spam peut varier selon la langue du
      // compte Gmail — on ne fait jamais échouer toute la synchronisation
      // pour ça, la boîte de réception normale reste à jour dans tous les cas.
      console.error('[inbox] échec de la synchronisation du dossier Spam :', err.message);
    }
    console.log('[inbox] synchronisation terminée avec succès.');
  } catch (err) {
    console.error('[inbox] échec en cours de synchronisation (non fatal, capturé) :', err.message);
  } finally {
    try {
      await client.logout();
    } catch {
      // La connexion peut déjà être coupée à ce stade (c'est justement le
      // scénario qu'on vient de gérer) — on ignore silencieusement.
    }
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
        smtpConfig: getSiteMailConfig(),
        to: reqRow.email,
        purpose: 'city_request_fulfilled',
        subject: `${reqRow.city_name} est maintenant disponible sur ${currentSiteName()}`,
        text: `Bonjour,\n\nVous nous aviez signalé l'absence de ${reqRow.city_name}. Bonne nouvelle : cette ville est désormais disponible sur ${currentSiteName()} !\n\nÀ bientôt,\nL'équipe ${currentSiteName()}`,
        link: SITE_URL,
      });
    } catch (err) {
      console.error('[city-request] échec de l\'envoi de l\'email :', err.message);
    }
  }
}
/** Résout le pays et la ville approximative d'une adresse IP visiteur,
 * via un service de géolocalisation gratuit — sans jamais conserver
 * l'adresse IP elle-même en base (seuls pays/ville sont stockés).
 * Reste totalement silencieuse en cas d'échec : la vue est comptée
 * normalement même si la géolocalisation échoue. */
async function geolocateIp(ip) {
  if (!ip || ip === '::1' || ip === '127.0.0.1' || ip.startsWith('192.168.') || ip.startsWith('10.')) return null;
  try {
    const response = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,city`);
    const data = await response.json();
    if (data.status !== 'success') return null;
    return { country: data.country || null, city: data.city || null };
  } catch {
    return null;
  }
}
/** Enregistre une vue géolocalisée pour une annonce, en tâche de fond
 * (n'attend jamais cette fonction — ne doit jamais ralentir l'affichage
 * de la fiche annonce pour le visiteur). */
function logListingViewAsync(listingId, req, source) {
  const forwarded = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = forwarded || req.socket.remoteAddress || '';
  geolocateIp(ip)
    .then((geo) => {
      db.prepare('INSERT INTO listing_views (listing_id, country, city, viewed_at, source) VALUES (?, ?, ?, datetime(\'now\'), ?)').run(
        listingId,
        geo?.country || null,
        geo?.city || null,
        source || null
      );
    })
    .catch((err) => console.error('[géolocalisation] échec silencieux :', err.message));
}
/** Lit un fichier joint précédemment téléversé (via /api/admin/uploads/attachment)
 * à partir de son URL relative, pour le transmettre à sendMail(). Retourne
 * null si l'URL est absente ou invalide, plutôt que de faire échouer tout
 * l'envoi pour une pièce jointe manquante. */
function readAttachmentFromUrl(attachmentUrl, attachmentFilename, attachmentMime) {
  if (!attachmentUrl || !attachmentUrl.startsWith('/attachments/')) return null;
  try {
    const filePath = path.join(DATA_DIR, 'attachments', path.basename(attachmentUrl));
    const content = fs.readFileSync(filePath);
    return [{ filename: attachmentFilename || path.basename(attachmentUrl), mimeType: attachmentMime || 'application/octet-stream', content }];
  } catch {
    return null;
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
        smtpConfig: getSiteMailConfig(),
      to: l.email,
      purpose: 'expiry_reminder',
      subject: `Votre annonce « ${l.title} » expire bientôt`,
      text: `Bonjour ${l.name},\n\nVotre annonce « ${l.title} » expirera le ${l.expires_at} (heure serveur).\n\nPour qu'elle reste visible, renouvelez-la depuis « Mes annonces » sur ${currentSiteName()}, ou directement ici :\n${link}\n\nSans renouvellement, elle sera automatiquement masquée des résultats.`,
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
        smtpConfig: getSiteMailConfig(),
      to: l.email,
      purpose: 'expired_notice',
      subject: `Votre annonce « ${l.title} » a expiré`,
      text: `Bonjour ${l.name},\n\nVotre annonce « ${l.title} » a expiré et n'est plus visible dans les résultats.\n\nVous pouvez la renouveler à tout moment depuis « Mes annonces » sur ${currentSiteName()}, ou directement ici :\n${link}`,
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
        smtpConfig: getSiteMailConfig(),
        to: search.user_email,
        purpose: 'saved_search_alert',
        subject: `Nouvelle annonce pour votre alerte « ${search.label} »`,
        text: `Bonjour ${search.user_name},\n\nUne nouvelle annonce correspond à votre alerte « ${search.label} » :\n\n${listing.title}\n\nVoir l'annonce : ${link}\n\nVous recevez cet email car vous avez enregistré cette recherche sur ${currentSiteName()}. Vous pouvez la gérer ou la supprimer depuis « Mes alertes ».`,
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
    subject: (name) => `Bienvenue sur ${currentSiteName()}, ${name} !`,
    text: (name) => `Bonjour ${name},

Bienvenue sur ${currentSiteName()} ! Votre compte est créé, voici un guide complet pour bien démarrer :

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
L'équipe ${currentSiteName()}`,
  },
  en: {
    subject: (name) => `Welcome to ${currentSiteName()}, ${name}!`,
    text: (name) => `Hello ${name},

Welcome to ${currentSiteName()}! Your account is ready — here is a full guide to get you started:

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
The ${currentSiteName()} team`,
  },
  it: {
    subject: (name) => `Benvenuto/a su ${currentSiteName()}, ${name}!`,
    text: (name) => `Ciao ${name},

Benvenuto/a su ${currentSiteName()}! Il tuo account è pronto, ecco una guida completa per iniziare:

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
Il team ${currentSiteName()}`,
  },
  ar: {
    subject: (name) => `مرحبًا بك في ${currentSiteName()} يا ${name}!`,
    text: (name) => `مرحبًا ${name}،

مرحبًا بك في ${currentSiteName()}! تم إنشاء حسابك، إليك دليل كامل للبدء:

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
فريق ${currentSiteName()}`,
  },
  es: {
    subject: (name) => `¡Bienvenido/a a ${currentSiteName()}, ${name}!`,
    text: (name) => `Hola ${name},

¡Bienvenido/a a ${currentSiteName()}! Su cuenta está creada, aquí tiene una guía completa para empezar:

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
El equipo de ${currentSiteName()}`,
  },
  pt: {
    subject: (name) => `Bem-vindo(a) ao ${currentSiteName()}, ${name}!`,
    text: (name) => `Olá ${name},

Bem-vindo(a) ao ${currentSiteName()}! A sua conta está criada, aqui tem um guia completo para começar:

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
A equipa ${currentSiteName()}`,
  },
  de: {
    subject: (name) => `Willkommen bei ${currentSiteName()}, ${name}!`,
    text: (name) => `Hallo ${name},

Willkommen bei ${currentSiteName()}! Ihr Konto ist erstellt, hier ist ein vollständiger Leitfaden für den Einstieg:

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
Das ${currentSiteName()}-Team`,
  },
};
async function sendWelcomeEmail(name, email, language) {
  const template = WELCOME_EMAIL_TEMPLATES[language] || WELCOME_EMAIL_TEMPLATES.fr;
  await sendMail({
        smtpConfig: getSiteMailConfig(),
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
        smtpConfig: getSiteMailConfig(),
    to: email,
    purpose: 'verify_email',
    subject: `Vérifiez votre adresse email — ${currentSiteName()}`,
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

/** Détermine, à partir du domaine visité (en-tête Host de la requête),
 * quel site est concerné et quelle base de données activer. Filet de
 * sécurité : si le domaine n'est reconnu par aucun site du registre
 * (ex. l'URL Render par défaut, un accès en local, ou tout simplement
 * un site pas encore enregistré), on retombe systématiquement sur le
 * site principal — aucune requête ne peut jamais échouer à cause de ce
 * mécanisme. Retourne aussi le statut du site, pour bloquer proprement
 * l'accès à un site suspendu. */
function resolveSiteForRequest(req) {
  const hostHeader = (req.headers.host || '').split(':')[0].toLowerCase().trim();
  if (hostHeader) {
    const site = masterDb
      .prepare('SELECT * FROM sites WHERE subdomain = ? OR custom_domain = ?')
      .get(hostHeader, hostHeader);
    if (site) {
      return { site, activeDb: getTenantDatabase(site.db_filename) };
    }
  }
  // Domaine non reconnu — filet de sécurité, on sert le site principal.
  const mainSite = masterDb.prepare("SELECT * FROM sites WHERE slug = 'main'").get();
  return { site: mainSite, activeDb: mainDb };
}

const server = http.createServer(async (req, res) => {
  const { site, activeDb } = resolveSiteForRequest(req);
  if (site && site.status === 'suspended') {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Ce site est temporairement indisponible.');
  }
  return tenantContext.run(activeDb, () => siteInfoContext.run(site, () => handleRequest(req, res)));
});
async function handleRequest(req, res) {
  // ---------- En-têtes de sécurité HTTP, appliqués à toutes les réponses ----------
  // Politique de sécurité du contenu (CSP) construite à partir d'un
  // inventaire exact des ressources externes réellement utilisées par le
  // site (police Google Fonts, D3.js et données géographiques via
  // jsdelivr, connexion Google, taux de change) — aucune autorisation
  // superflue au-delà de ce qui est effectivement chargé. Si un nouvel
  // ajout futur charge une ressource externe non listée ici, le
  // navigateur la bloquera silencieusement : vérifier la console du
  // navigateur (erreur explicite "Content-Security-Policy") en cas de
  // fonctionnalité qui semble ne plus marcher après ce déploiement.
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' https://cdn.jsdelivr.net https://accounts.google.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https:",
    "connect-src 'self' https://cdn.jsdelivr.net https://open.er-api.com https://accounts.google.com",
    "frame-src https://accounts.google.com",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; '));
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
    // Pièces jointes des emails envoyés depuis l'Administration — accès
    // volontairement non authentifié (comme /uploads/) car ces fichiers ont
    // vocation à transiter par email ; le nom de fichier aléatoire fait
    // office de protection suffisante pour ce cas d'usage.
    if (pathname.startsWith('/attachments/')) {
      const filename = path.basename(pathname);
      const filePath = path.join(DATA_DIR, 'attachments', filename);
      return fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); return res.end('Fichier introuvable'); }
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
      const categories = db.prepare('SELECT slug FROM categories WHERE id NOT IN (SELECT category_id FROM disabled_categories)').all();
      const listings = db
        .prepare("SELECT id, updated_at FROM listings WHERE status = 'active' AND expires_at > datetime('now') AND category_id NOT IN (SELECT category_id FROM disabled_categories) AND city_id NOT IN (SELECT id FROM cities WHERE country_id IN (SELECT country_id FROM disabled_countries))")
        .all();
      const cities = db
        .prepare(
          `SELECT ci.name AS city_name, co.iso2 AS country_iso2, co.name AS country_name
           FROM cities ci JOIN countries co ON co.id = ci.country_id
           WHERE EXISTS (SELECT 1 FROM listing_visible_cities lvc JOIN listings l ON l.id = lvc.listing_id WHERE lvc.city_id = ci.id AND l.status = 'active' AND l.expires_at > datetime('now'))`
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
             FROM cities ci LEFT JOIN listing_visible_cities lvc ON lvc.city_id = ci.id LEFT JOIN listings l ON l.id = lvc.listing_id AND l.status = 'active' AND l.expires_at > datetime('now') AND l.category_id NOT IN (SELECT category_id FROM disabled_categories)
             WHERE ci.country_id = ? AND ci.country_id NOT IN (SELECT country_id FROM disabled_countries)`
          )
          .get(country.id);
        return sendHtml(
          res,
          renderHtmlWithMeta({
            title: `Achetez, vendez, louez au ${country.name} — ${currentSiteName()}`,
            description: `Parcourez ${stats.listings || 0} annonce(s) au ${country.name} sur ${currentSiteName()} : immobilier, véhicules, emploi et objets, ville par ville.`,
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
              title: `Annonces à ${city.name}, ${country.name} — ${currentSiteName()}`,
              description: `Parcourez ${cityStats.listings || 0} annonce(s) à ${city.name}, ${country.name} sur ${currentSiteName()} : immobilier, véhicules, emploi et objets à vendre, louer ou pourvoir.`,
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
            title: `${category.name} — Annonces dans le monde entier | ${currentSiteName()}`,
            description: `Découvrez toutes les annonces "${category.name}" sur ${currentSiteName()}, la place de marché mondiale — achat, vente, location, ville par ville.`,
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
           WHERE l.id = ? AND l.status = 'active' AND l.category_id NOT IN (SELECT category_id FROM disabled_categories) AND co.id NOT IN (SELECT country_id FROM disabled_countries)`
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
            title: `${listing.title} — ${listing.city_name}, ${listing.country_name} | ${currentSiteName()}`,
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
      const clientIp = getClientIp(req);
      const ipAttempt = loginAttemptsByIp.get(clientIp);
      if (ipAttempt && ipAttempt.lockedUntil && ipAttempt.lockedUntil > Date.now()) {
        const waitMin = Math.ceil((ipAttempt.lockedUntil - Date.now()) / 60000);
        return sendJSON(res, 429, { error: `Trop de tentatives échouées depuis cette connexion. Réessayez dans ${waitMin} minute(s).` });
      }
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
        const prevIp = loginAttemptsByIp.get(clientIp) || { count: 0 };
        const ipCount = prevIp.count + 1;
        const ipLockedUntil = ipCount >= MAX_LOGIN_ATTEMPTS_PER_IP ? Date.now() + IP_LOCKOUT_MS : null;
        loginAttemptsByIp.set(clientIp, { count: ipCount, lockedUntil: ipLockedUntil });
        if (ipLockedUntil) {
          return sendJSON(res, 429, { error: `Trop de tentatives échouées depuis cette connexion. Réessayez dans 15 minutes.` });
        }
        if (lockedUntil) {
          return sendJSON(res, 429, { error: `Trop de tentatives échouées. Compte temporairement bloqué 15 minutes.` });
        }
        return sendJSON(res, 401, { error: 'Email ou mot de passe incorrect.' });
      }
      loginAttempts.delete(emailKey);
      loginAttemptsByIp.delete(clientIp);
      const token = signToken({ sub: user.id });
      return sendJSON(res, 200, {
        token,
        user: {
          id: user.id, name: user.name, email: user.email, role: user.role, email_verified: !!user.email_verified_at,
          phone: user.phone, referral_code: user.referral_code, free_boost_credits: user.free_boost_credits,
          is_professional: !!user.is_professional, company_name: user.company_name, company_logo_url: user.company_logo_url,
          company_website: user.company_website, social_whatsapp: user.social_whatsapp, social_instagram: user.social_instagram, social_facebook: user.social_facebook,
          social_tiktok: user.social_tiktok, social_linkedin: user.social_linkedin,
          pro_tier: user.pro_tier, domain_verified: isDomainVerified(user.email, user.company_website),
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
      const { is_professional, company_name, company_website, company_logo_url, social_whatsapp, social_instagram, social_facebook, social_tiktok, social_linkedin } = await readBody(req);
      if (is_professional && (!company_name || !company_name.trim())) {
        return sendJSON(res, 400, { error: "Le nom de l'entreprise est requis." });
      }
      db.prepare(
        `UPDATE users SET is_professional = ?, company_name = ?, company_website = ?, company_logo_url = ?, social_whatsapp = ?, social_instagram = ?, social_facebook = ?, social_tiktok = ?, social_linkedin = ? WHERE id = ?`
      ).run(
        is_professional ? 1 : 0,
        is_professional ? company_name.trim() : null,
        is_professional ? (company_website || '').trim() || null : null,
        is_professional ? (company_logo_url || user.company_logo_url || null) : null,
        is_professional ? (social_whatsapp || '').trim() || null : null,
        is_professional ? (social_instagram || '').trim() || null : null,
        is_professional ? (social_facebook || '').trim() || null : null,
        is_professional ? (social_tiktok || '').trim() || null : null,
        is_professional ? (social_linkedin || '').trim() || null : null,
        user.id
      );
      return sendJSON(res, 200, { ok: true });
    }
    if (pathname === '/api/me/phone' && method === 'PUT') {
      const user = requireAuth(req, res);
      if (!user) return;
      const { phone, show_phone_publicly } = await readBody(req);
      const cleaned = (phone || '').replace(/[^\d+]/g, '').trim();
      if (cleaned && !/^\+?\d{6,15}$/.test(cleaned)) {
        return sendJSON(res, 400, { error: 'Numéro invalide. Utilisez le format international, ex. +212612345678.' });
      }
      db.prepare('UPDATE users SET phone = ?, show_phone_publicly = ? WHERE id = ?').run(cleaned || null, show_phone_publicly === false ? 0 : 1, user.id);
      return sendJSON(res, 200, { phone: cleaned || null, show_phone_publicly: show_phone_publicly === false ? false : true });
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
        smtpConfig: getSiteMailConfig(),
          to: user.email,
          purpose: 'reset_password',
          subject: `Réinitialisez votre mot de passe ${currentSiteName()}`,
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
      const body = await readBody(req).catch(() => ({}));
      db.prepare('INSERT INTO site_visits (source) VALUES (?)').run((body && body.source) || null);
      return sendJSON(res, 201, { ok: true });
    }
    if (pathname === '/api/config' && method === 'GET') {
      return sendJSON(res, 200, { google_client_id: process.env.GOOGLE_CLIENT_ID || null });
    }
    if (pathname === '/api/categories' && method === 'GET') {
      const cats = db.prepare('SELECT id, slug, name, icon FROM categories WHERE is_active = 1 AND id NOT IN (SELECT category_id FROM disabled_categories) ORDER BY id').all();
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
           LEFT JOIN listing_visible_cities lvc ON lvc.city_id = ci.id LEFT JOIN listings l ON l.id = lvc.listing_id AND l.status = 'active' AND l.expires_at > datetime('now') AND l.category_id NOT IN (SELECT category_id FROM disabled_categories)
           WHERE c.id NOT IN (SELECT country_id FROM disabled_countries)
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
           LEFT JOIN listing_visible_cities lvc ON lvc.city_id = ci.id LEFT JOIN listings l ON l.id = lvc.listing_id AND l.status = 'active' AND l.expires_at > datetime('now') AND l.category_id NOT IN (SELECT category_id FROM disabled_categories)
           WHERE ci.country_id = ? AND ci.state_id IS NULL AND ci.country_id NOT IN (SELECT country_id FROM disabled_countries)
           GROUP BY ci.id
           ORDER BY ci.name`
        )
        .all(countryId);
      return sendJSON(res, 200, rows);
    }
    // Toutes les villes d'un pays, États fédéraux compris — contrairement
    // à la route ci-dessus (qui exclut volontairement les villes
    // rattachées à un État, pour la sélection de la ville RÉELLE d'une
    // annonce, faite via le sélecteur d'État approprié). Sert
    // spécifiquement au choix des villes SUPPLÉMENTAIRES à la
    // publication, où l'on veut au contraire proposer l'ensemble du pays
    // sans distinction d'État.
    if ((m = pathname.match(/^\/api\/countries\/(\d+)\/all-cities$/)) && method === 'GET') {
      const countryId = Number(m[1]);
      const rows = db
        .prepare('SELECT id, name FROM cities WHERE country_id = ? AND country_id NOT IN (SELECT country_id FROM disabled_countries) ORDER BY name')
        .all(countryId);
      return sendJSON(res, 200, rows);
    }
    // Recherche de villes à travers TOUS les pays — contrairement à la
    // route ci-dessus (scopée à un seul pays), sert spécifiquement au
    // Tourisme, transfrontalier par nature : plutôt qu'une liste
    // complète (des dizaines de milliers de villes potentielles), une
    // recherche par nom, limitée à 30 résultats.
    if (pathname === '/api/cities/search-global' && method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim();
      if (q.length < 2) return sendJSON(res, 200, []);
      const rows = db
        .prepare(
          `SELECT ci.id, ci.name, co.name AS country_name
           FROM cities ci JOIN countries co ON co.id = ci.country_id
           WHERE ci.name LIKE ? AND ci.country_id NOT IN (SELECT country_id FROM disabled_countries)
           ORDER BY ci.name LIMIT 30`
        )
        .all(`%${q}%`);
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
           LEFT JOIN listing_visible_cities lvc ON lvc.city_id = ci.id LEFT JOIN listings l ON l.id = lvc.listing_id AND l.status = 'active' AND l.expires_at > datetime('now') AND l.category_id NOT IN (SELECT category_id FROM disabled_categories)
           WHERE s.country_id = ? AND s.country_id NOT IN (SELECT country_id FROM disabled_countries)
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
           LEFT JOIN listing_visible_cities lvc ON lvc.city_id = ci.id LEFT JOIN listings l ON l.id = lvc.listing_id AND l.status = 'active' AND l.expires_at > datetime('now') AND l.category_id NOT IN (SELECT category_id FROM disabled_categories)
           WHERE ci.state_id = ? AND ci.country_id NOT IN (SELECT country_id FROM disabled_countries)
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
          'SELECT l.id, l.title, l.listing_type, l.price, l.currency, l.images_json, cat.icon AS category_icon, cat.slug AS category_slug, cat.name AS category_name, ci.name AS city_name, co.iso2 AS country_iso2, co.name AS country_name, co.iso_numeric FROM listings l JOIN categories cat ON cat.id = l.category_id JOIN cities ci ON ci.id = l.city_id JOIN countries co ON co.id = ci.country_id WHERE l.status = \'active\' AND l.expires_at > datetime(\'now\') AND l.category_id NOT IN (SELECT category_id FROM disabled_categories) AND co.id NOT IN (SELECT country_id FROM disabled_countries) ORDER BY RANDOM() LIMIT 1'
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
               ci.name AS city_name, ci.timezone AS city_timezone, co.iso2 AS country_iso2, co.name AS country_name, co.currency AS country_currency, l.is_secondhand, l.date_start, l.date_end, l.price_promo, l.price_type, l.capacity_guests, l.capacity_children, l.bedrooms, l.bathrooms, l.amenities_json, l.activity_duration, l.activity_group_size_min, l.activity_group_size_max, l.activity_languages, l.activity_meeting_point, l.activity_difficulty, l.activity_min_age, l.property_room_type, l.num_beds, l.cancellation_policy, l.activity_included, l.activity_excluded, l.activity_pickup_included, l.vehicle_brand, l.vehicle_model, l.vehicle_year, l.vehicle_mileage, l.vehicle_condition, l.vehicle_transmission, l.vehicle_fuel_type, l.surface_m2, l.num_rooms, l.floor_number, l.furnished, l.construction_year, l.job_contract_type, l.job_remote_type, l.job_experience_level, l.job_education_level, l.job_sector, l.job_cv_url, l.is_demo, l.transaction_completed, l.created_at, l.expires_at
        FROM listings l
        JOIN categories cat ON cat.id = l.category_id
        LEFT JOIN subcategories sub ON sub.id = l.subcategory_id
        JOIN cities ci ON ci.id = l.city_id
        JOIN countries co ON co.id = ci.country_id
        WHERE l.status = 'active' AND l.expires_at > datetime('now') AND l.category_id NOT IN (SELECT category_id FROM disabled_categories) AND co.id NOT IN (SELECT country_id FROM disabled_countries) ${withCountry ? 'AND co.id = ?' : ''}
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
          `SELECT l.id, l.title, l.listing_type, l.price, l.currency, l.images_json, l.boosted_until, l.view_count, l.is_secondhand, l.date_start, l.date_end, l.price_promo, l.price_type, l.capacity_guests, l.capacity_children, l.bedrooms, l.bathrooms, l.amenities_json, l.activity_duration, l.activity_group_size_min, l.activity_group_size_max, l.activity_languages, l.activity_meeting_point, l.activity_difficulty, l.activity_min_age, l.property_room_type, l.num_beds, l.cancellation_policy, l.activity_included, l.activity_excluded, l.activity_pickup_included, l.vehicle_brand, l.vehicle_model, l.vehicle_year, l.vehicle_mileage, l.vehicle_condition, l.vehicle_transmission, l.vehicle_fuel_type, l.surface_m2, l.num_rooms, l.floor_number, l.furnished, l.construction_year, l.job_contract_type, l.job_remote_type, l.job_experience_level, l.job_education_level, l.job_sector, l.job_cv_url, l.is_demo, l.transaction_completed, l.created_at, l.expires_at,
                  cat.slug AS category_slug, cat.name AS category_name, cat.icon AS category_icon,
                  ci.name AS city_name, co.iso2 AS country_iso2, co.name AS country_name
           FROM listings l
           JOIN categories cat ON cat.id = l.category_id
           JOIN cities ci ON ci.id = l.city_id
           JOIN countries co ON co.id = ci.country_id
           WHERE l.status = 'active' AND l.expires_at > datetime('now') AND l.category_id NOT IN (SELECT category_id FROM disabled_categories) AND co.id NOT IN (SELECT country_id FROM disabled_countries)
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
           WHERE l.status = 'active' AND l.category_id NOT IN (SELECT category_id FROM disabled_categories) AND co.id NOT IN (SELECT country_id FROM disabled_countries)
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
               ci.name AS city_name, ci.timezone AS city_timezone, co.iso2 AS country_iso2, co.name AS country_name, co.currency AS country_currency, l.is_secondhand, l.date_start, l.date_end, l.price_promo, l.price_type, l.capacity_guests, l.capacity_children, l.bedrooms, l.bathrooms, l.amenities_json, l.activity_duration, l.activity_group_size_min, l.activity_group_size_max, l.activity_languages, l.activity_meeting_point, l.activity_difficulty, l.activity_min_age, l.property_room_type, l.num_beds, l.cancellation_policy, l.activity_included, l.activity_excluded, l.activity_pickup_included, l.vehicle_brand, l.vehicle_model, l.vehicle_year, l.vehicle_mileage, l.vehicle_condition, l.vehicle_transmission, l.vehicle_fuel_type, l.surface_m2, l.num_rooms, l.floor_number, l.furnished, l.construction_year, l.job_contract_type, l.job_remote_type, l.job_experience_level, l.job_education_level, l.job_sector, l.job_cv_url, l.is_demo, l.transaction_completed, l.created_at, l.expires_at,
               u.is_professional, u.company_name, u.company_logo_url, u.pro_tier
        FROM listings l
        JOIN categories cat ON cat.id = l.category_id
        LEFT JOIN subcategories sub ON sub.id = l.subcategory_id
        JOIN cities ci ON ci.id = l.city_id
        JOIN countries co ON co.id = ci.country_id
        JOIN users u ON u.id = l.user_id
        WHERE l.status = 'active' AND l.expires_at > datetime('now') AND l.category_id NOT IN (SELECT category_id FROM disabled_categories) AND co.id NOT IN (SELECT country_id FROM disabled_countries)
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
               ci.name AS city_name, ci.timezone AS city_timezone, co.iso2 AS country_iso2, co.name AS country_name, co.currency AS country_currency, l.is_secondhand, l.date_start, l.date_end, l.price_promo, l.price_type, l.capacity_guests, l.capacity_children, l.bedrooms, l.bathrooms, l.amenities_json, l.activity_duration, l.activity_group_size_min, l.activity_group_size_max, l.activity_languages, l.activity_meeting_point, l.activity_difficulty, l.activity_min_age, l.property_room_type, l.num_beds, l.cancellation_policy, l.activity_included, l.activity_excluded, l.activity_pickup_included, l.vehicle_brand, l.vehicle_model, l.vehicle_year, l.vehicle_mileage, l.vehicle_condition, l.vehicle_transmission, l.vehicle_fuel_type, l.surface_m2, l.num_rooms, l.floor_number, l.furnished, l.construction_year, l.job_contract_type, l.job_remote_type, l.job_experience_level, l.job_education_level, l.job_sector, l.job_cv_url, l.is_demo, l.transaction_completed, l.created_at, l.expires_at,
               u.is_professional, u.company_name, u.company_logo_url, u.pro_tier
        FROM listings l
        JOIN categories cat ON cat.id = l.category_id
        LEFT JOIN subcategories sub ON sub.id = l.subcategory_id
        JOIN cities ci ON ci.id = l.city_id
        JOIN countries co ON co.id = ci.country_id
        JOIN users u ON u.id = l.user_id
        WHERE l.id IN (SELECT listing_id FROM listing_visible_cities WHERE city_id = ?) AND l.status = 'active' AND l.expires_at > datetime('now') AND l.category_id NOT IN (SELECT category_id FROM disabled_categories) AND co.id NOT IN (SELECT country_id FROM disabled_countries)
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
      const { title, description, listing_type, price, currency, city_id, category_id, subcategory_id, images, open_to_trade, trade_description, language, is_secondhand, date_start, date_end, price_promo, price_type, capacity_guests, capacity_children, bedrooms, bathrooms, amenities, vehicle_brand, vehicle_model, vehicle_year, vehicle_mileage, vehicle_condition, vehicle_transmission, vehicle_fuel_type, surface_m2, num_rooms, floor_number, furnished, construction_year, job_contract_type, job_remote_type, job_experience_level, job_education_level, job_sector, job_cv_url, activity_duration, activity_group_size_min, activity_group_size_max, activity_languages, activity_meeting_point, activity_difficulty, activity_min_age, property_room_type, num_beds, cancellation_policy, activity_included, activity_excluded, activity_pickup_included, extra_city_ids, visible_all_cities } = body;
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
      if (isCountryDisabled(city.country_id)) {
        return sendJSON(res, 400, { error: "Ce pays n'est pas disponible sur ce site." });
      }
      const category = db.prepare('SELECT id, slug FROM categories WHERE id = ?').get(category_id);
      if (!category) return sendJSON(res, 400, { error: 'Catégorie invalide.' });
      if (isCategoryDisabled(category_id)) {
        return sendJSON(res, 400, { error: "Cette catégorie n'est pas disponible sur ce site." });
      }
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
          `INSERT INTO listings (user_id, city_id, category_id, subcategory_id, title, description, listing_type, price, currency, images_json, open_to_trade, trade_description, language, is_secondhand, date_start, date_end, price_promo, price_type, capacity_guests, capacity_children, bedrooms, bathrooms, amenities_json, vehicle_brand, vehicle_model, vehicle_year, vehicle_mileage, vehicle_condition, vehicle_transmission, vehicle_fuel_type, surface_m2, num_rooms, floor_number, furnished, construction_year, job_contract_type, job_remote_type, job_experience_level, job_education_level, job_sector, job_cv_url, activity_duration, activity_group_size_min, activity_group_size_max, activity_languages, activity_meeting_point, activity_difficulty, activity_min_age, property_room_type, num_beds, cancellation_policy, activity_included, activity_excluded, activity_pickup_included, visible_all_cities)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(user.id, city_id, category_id, subcategoryId, title.trim(), (description || '').trim(), listing_type, finalPrice, currency || 'EUR', imagesJson, open_to_trade ? 1 : 0, open_to_trade ? (trade_description || '').trim() || null : null, listingLang, is_secondhand ? 1 : 0, (date_start || '').trim() || null, (date_end || '').trim() || null, price_promo === null || price_promo === undefined || price_promo === '' ? null : Number(price_promo), (price_type || '').trim() || null, capacity_guests === null || capacity_guests === undefined || capacity_guests === '' ? null : Number(capacity_guests), capacity_children === null || capacity_children === undefined || capacity_children === '' ? null : Number(capacity_children), bedrooms === null || bedrooms === undefined || bedrooms === '' ? null : Number(bedrooms), bathrooms === null || bathrooms === undefined || bathrooms === '' ? null : Number(bathrooms), Array.isArray(amenities) && amenities.length ? JSON.stringify(amenities) : null, (vehicle_brand || '').trim() || null, (vehicle_model || '').trim() || null, vehicle_year === null || vehicle_year === undefined || vehicle_year === '' ? null : Number(vehicle_year), vehicle_mileage === null || vehicle_mileage === undefined || vehicle_mileage === '' ? null : Number(vehicle_mileage), (vehicle_condition || '').trim() || null, (vehicle_transmission || '').trim() || null, (vehicle_fuel_type || '').trim() || null, surface_m2 === null || surface_m2 === undefined || surface_m2 === '' ? null : Number(surface_m2), num_rooms === null || num_rooms === undefined || num_rooms === '' ? null : Number(num_rooms), (floor_number || '').trim() || null, (furnished || '').trim() || null, construction_year === null || construction_year === undefined || construction_year === '' ? null : Number(construction_year), (job_contract_type || '').trim() || null, (job_remote_type || '').trim() || null, (job_experience_level || '').trim() || null, (job_education_level || '').trim() || null, (job_sector || '').trim() || null, (job_cv_url || '').trim() || null, (activity_duration || '').trim() || null, activity_group_size_min === null || activity_group_size_min === undefined || activity_group_size_min === '' ? null : Number(activity_group_size_min), activity_group_size_max === null || activity_group_size_max === undefined || activity_group_size_max === '' ? null : Number(activity_group_size_max), (activity_languages || '').trim() || null, (activity_meeting_point || '').trim() || null, (activity_difficulty || '').trim() || null, activity_min_age === null || activity_min_age === undefined || activity_min_age === '' ? null : Number(activity_min_age), (property_room_type || '').trim() || null, num_beds === null || num_beds === undefined || num_beds === '' ? null : Number(num_beds), (cancellation_policy || '').trim() || null, (activity_included || '').trim() || null, (activity_excluded || '').trim() || null, activity_pickup_included ? 1 : 0, visible_all_cities ? 1 : 0)
        .lastInsertRowid;
      // Villes supplémentaires choisies — restreintes au même pays que la
      // ville réelle du bien pour la plupart des catégories (pas de sens
      // à cross-lister une voiture au Maroc vers une ville française),
      // sauf le Tourisme, transfrontalier par nature.
      const isTourism = category.slug === 'tourisme-voyages';
      if (Array.isArray(extra_city_ids) && extra_city_ids.length) {
        const insertExtraCity = db.prepare('INSERT OR IGNORE INTO listing_extra_cities (listing_id, city_id) VALUES (?, ?)');
        for (const extraCityId of extra_city_ids) {
          const extraCity = isTourism
            ? db.prepare('SELECT id FROM cities WHERE id = ?').get(Number(extraCityId))
            : db.prepare('SELECT id FROM cities WHERE id = ? AND country_id = ?').get(Number(extraCityId), city.country_id);
          if (extraCity) insertExtraCity.run(id, extraCity.id);
        }
      }
      // Pays supplémentaires entiers — Tourisme uniquement.
      if (isTourism && Array.isArray(body.extra_country_ids) && body.extra_country_ids.length) {
        const insertExtraCountry = db.prepare('INSERT OR IGNORE INTO listing_extra_countries (listing_id, country_id) VALUES (?, ?)');
        for (const extraCountryId of body.extra_country_ids) {
          const extraCountry = db.prepare('SELECT id FROM countries WHERE id = ?').get(Number(extraCountryId));
          if (extraCountry) insertExtraCountry.run(id, extraCountry.id);
        }
      }
      syncListingVisibleCities(id);
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
                  ci.name AS city_name, ci.timezone AS city_timezone, co.id AS listing_country_id, co.iso2 AS country_iso2, co.name AS country_name, co.currency AS country_currency, l.is_secondhand, l.date_start, l.date_end, l.price_promo, l.price_type, l.capacity_guests, l.capacity_children, l.bedrooms, l.bathrooms, l.amenities_json, l.activity_duration, l.activity_group_size_min, l.activity_group_size_max, l.activity_languages, l.activity_meeting_point, l.activity_difficulty, l.activity_min_age, l.property_room_type, l.num_beds, l.cancellation_policy, l.activity_included, l.activity_excluded, l.activity_pickup_included, l.vehicle_brand, l.vehicle_model, l.vehicle_year, l.vehicle_mileage, l.vehicle_condition, l.vehicle_transmission, l.vehicle_fuel_type, l.surface_m2, l.num_rooms, l.floor_number, l.furnished, l.construction_year, l.job_contract_type, l.job_remote_type, l.job_experience_level, l.job_education_level, l.job_sector, l.job_cv_url, l.is_demo, l.transaction_completed, l.created_at, l.expires_at,
                  u.name AS owner_name, u.email_verified_at AS owner_verified_at, CASE WHEN u.show_phone_publicly = 1 THEN u.phone ELSE NULL END AS owner_phone,
                  u.is_professional AS owner_is_professional, u.company_name AS owner_company_name,
                  u.company_logo_url AS owner_company_logo_url, u.company_website AS owner_company_website,
                  u.social_whatsapp AS owner_social_whatsapp, u.social_instagram AS owner_social_instagram, u.social_facebook AS owner_social_facebook,
                  u.social_tiktok AS owner_social_tiktok, u.social_linkedin AS owner_social_linkedin,
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
      const currentUser = getAuthUser(req);
      // Catégorie désactivée pour ce site : l'annonce reste consultable
      // par son propriétaire (et un admin) pour qu'il garde la main sur
      // sa gestion, mais devient invisible pour le grand public — traité
      // comme introuvable plutôt que de révéler son existence.
      if ((isCategoryDisabled(row.category_id) || isCountryDisabled(row.listing_country_id)) && (!currentUser || (currentUser.id !== row.user_id && currentUser.role !== 'admin'))) {
        return sendJSON(res, 404, { error: 'Annonce introuvable' });
      }
      db.prepare('UPDATE listings SET view_count = view_count + 1 WHERE id = ?').run(row.id);
      logListingViewAsync(row.id, req, url.searchParams.get('src'));
      row.view_count = row.view_count + 1;
      row.images = JSON.parse(row.images_json);
      row.owner_verified = !!row.owner_verified_at;
      row.owner_domain_verified = isDomainVerified(row.owner_email, row.owner_company_website);
      delete row.owner_email;
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
          `SELECT l.id, l.title, l.listing_type, l.price, l.currency, l.images_json, l.boosted_until, l.is_secondhand, l.date_start, l.date_end, l.price_promo, l.price_type, l.capacity_guests, l.capacity_children, l.bedrooms, l.bathrooms, l.amenities_json, l.activity_duration, l.activity_group_size_min, l.activity_group_size_max, l.activity_languages, l.activity_meeting_point, l.activity_difficulty, l.activity_min_age, l.property_room_type, l.num_beds, l.cancellation_policy, l.activity_included, l.activity_excluded, l.activity_pickup_included, l.vehicle_brand, l.vehicle_model, l.vehicle_year, l.vehicle_mileage, l.vehicle_condition, l.vehicle_transmission, l.vehicle_fuel_type, l.surface_m2, l.num_rooms, l.floor_number, l.furnished, l.construction_year, l.job_contract_type, l.job_remote_type, l.job_experience_level, l.job_education_level, l.job_sector, l.job_cv_url, l.is_demo, l.transaction_completed, l.created_at, l.expires_at,
                  cat.slug AS category_slug, cat.name AS category_name, cat.icon AS category_icon,
                  sub.slug AS subcategory_slug, sub.name AS subcategory_name, ci.name AS city_name, co.iso2 AS country_iso2, co.name AS country_name
           FROM listings l
           JOIN categories cat ON cat.id = l.category_id
           LEFT JOIN subcategories sub ON sub.id = l.subcategory_id
           JOIN cities ci ON ci.id = l.city_id
           JOIN countries co ON co.id = ci.country_id
           WHERE l.category_id = ? AND l.id != ? AND l.status = 'active' AND l.expires_at > datetime('now') AND l.category_id NOT IN (SELECT category_id FROM disabled_categories) AND co.id NOT IN (SELECT country_id FROM disabled_countries)
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
           WHERE l.category_id = ? AND l.id != ? AND ci.country_id = ? AND l.city_id != ? AND l.status = 'active' AND l.expires_at > datetime('now') AND l.category_id NOT IN (SELECT category_id FROM disabled_categories) AND ci.country_id NOT IN (SELECT country_id FROM disabled_countries)
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
      // Catégorie désactivée pour ce site : le propriétaire garde la main
      // sur sa gestion (modifier le texte, changer de photo, supprimer...),
      // mais ne peut pas la remettre active/publique tant que la
      // catégorie reste désactivée — sans quoi la restriction commerciale
      // décidée par le Super Admin serait contournable.
      if (body.status === 'active') {
        const targetCategoryId = body.category_id !== undefined ? body.category_id : listing.category_id;
        if (isCategoryDisabled(targetCategoryId)) {
          return sendJSON(res, 400, { error: "Cette catégorie n'est actuellement pas disponible sur ce site — impossible de republier cette annonce." });
        }
        const targetCityId = body.city_id !== undefined ? body.city_id : listing.city_id;
        const targetCity = db.prepare('SELECT country_id FROM cities WHERE id = ?').get(targetCityId);
        if (targetCity && isCountryDisabled(targetCity.country_id)) {
          return sendJSON(res, 400, { error: "Ce pays n'est actuellement pas disponible sur ce site — impossible de republier cette annonce." });
        }
      }
      const fields = ['title', 'description', 'listing_type', 'price', 'currency', 'city_id', 'category_id', 'subcategory_id', 'status', 'visible_all_cities', 'capacity_guests', 'capacity_children', 'bedrooms', 'bathrooms', 'activity_duration', 'activity_group_size_min', 'activity_group_size_max', 'activity_languages', 'activity_meeting_point', 'activity_difficulty', 'activity_min_age', 'property_room_type', 'num_beds', 'cancellation_policy', 'activity_included', 'activity_excluded', 'activity_pickup_included'];
      const updates = [];
      const params = [];
      for (const f of fields) {
        if (body[f] !== undefined) {
          updates.push(`${f} = ?`);
          params.push(f === 'visible_all_cities' || f === 'activity_pickup_included' ? (body[f] ? 1 : 0) : body[f]);
        }
      }
      if (body.images !== undefined) {
        updates.push('images_json = ?');
        params.push(JSON.stringify(Array.isArray(body.images) ? body.images.filter(Boolean).slice(0, 6) : []));
      }
      if (body.amenities !== undefined) {
        updates.push('amenities_json = ?');
        params.push(Array.isArray(body.amenities) && body.amenities.length ? JSON.stringify(body.amenities) : null);
      }
      updates.push("updated_at = datetime('now')");
      if (updates.length) {
        params.push(listingId);
        db.prepare(`UPDATE listings SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      }
      // Villes supplémentaires : remplacées intégralement si transmises
      // (tableau vide = les retirer toutes), restreintes au même pays que
      // la ville réelle — sauf Tourisme, transfrontalier par nature. Puis
      // resynchronisation de listing_visible_cities si l'un des éléments
      // qui la déterminent a été touché (ville, villes/pays
      // supplémentaires, ou portée "tout le pays").
      let visibilityTouched = body.city_id !== undefined || body.visible_all_cities !== undefined;
      const finalCategoryId = body.category_id !== undefined ? body.category_id : listing.category_id;
      const finalCategory = db.prepare('SELECT slug FROM categories WHERE id = ?').get(finalCategoryId);
      const isTourismUpdate = finalCategory?.slug === 'tourisme-voyages';
      if (Array.isArray(body.extra_city_ids)) {
        const finalCityId = body.city_id !== undefined ? body.city_id : listing.city_id;
        const finalCity = db.prepare('SELECT country_id FROM cities WHERE id = ?').get(finalCityId);
        db.prepare('DELETE FROM listing_extra_cities WHERE listing_id = ?').run(listingId);
        if (finalCity) {
          const insertExtraCity = db.prepare('INSERT OR IGNORE INTO listing_extra_cities (listing_id, city_id) VALUES (?, ?)');
          for (const extraCityId of body.extra_city_ids) {
            const extraCity = isTourismUpdate
              ? db.prepare('SELECT id FROM cities WHERE id = ?').get(Number(extraCityId))
              : db.prepare('SELECT id FROM cities WHERE id = ? AND country_id = ?').get(Number(extraCityId), finalCity.country_id);
            if (extraCity) insertExtraCity.run(listingId, extraCity.id);
          }
        }
        visibilityTouched = true;
      }
      // Pays supplémentaires entiers — Tourisme uniquement, remplacés
      // intégralement si transmis.
      if (isTourismUpdate && Array.isArray(body.extra_country_ids)) {
        db.prepare('DELETE FROM listing_extra_countries WHERE listing_id = ?').run(listingId);
        const insertExtraCountry = db.prepare('INSERT OR IGNORE INTO listing_extra_countries (listing_id, country_id) VALUES (?, ?)');
        for (const extraCountryId of body.extra_country_ids) {
          const extraCountry = db.prepare('SELECT id FROM countries WHERE id = ?').get(Number(extraCountryId));
          if (extraCountry) insertExtraCountry.run(listingId, extraCountry.id);
        }
        visibilityTouched = true;
      }
      if (visibilityTouched) syncListingVisibleCities(listingId);
      return sendJSON(res, 200, { ok: true });
    }
    if ((m = pathname.match(/^\/api\/listings\/(\d+)\/renew$/)) && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      const listing = db.prepare('SELECT user_id, category_id, city_id FROM listings WHERE id = ?').get(Number(m[1]));
      if (!listing) return sendJSON(res, 404, { error: 'Annonce introuvable.' });
      if (listing.user_id !== user.id && user.role !== 'admin') return sendJSON(res, 403, { error: "Vous n'êtes pas propriétaire de cette annonce." });
      if (isCategoryDisabled(listing.category_id)) {
        return sendJSON(res, 400, { error: "Cette catégorie n'est actuellement pas disponible sur ce site — impossible de renouveler cette annonce." });
      }
      const listingCity = db.prepare('SELECT country_id FROM cities WHERE id = ?').get(listing.city_id);
      if (listingCity && isCountryDisabled(listingCity.country_id)) {
        return sendJSON(res, 400, { error: "Ce pays n'est actuellement pas disponible sur ce site — impossible de renouveler cette annonce." });
      }
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
    // Tableau de bord détaillé — toutes les annonces du vendeur (pas
    // seulement le top 5), avec vues et favoris par annonce, pour un vrai
    // suivi de performance.
    if (pathname === '/api/me/listings-stats' && method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      if (!user.is_professional) return sendJSON(res, 403, { error: 'Réservé aux comptes professionnels.' });
      const rows = db
        .prepare(
          `SELECT l.id, l.title, l.view_count, l.status, l.created_at, l.expires_at,
                  (SELECT COUNT(*) FROM favorites f WHERE f.listing_id = l.id) AS fav_count,
                  (SELECT COUNT(*) FROM listing_views lv WHERE lv.listing_id = l.id AND lv.source = 'share') AS share_view_count
           FROM listings l WHERE l.user_id = ? ORDER BY l.created_at DESC`
        )
        .all(user.id);
      return sendJSON(res, 200, rows);
    }
    // Répartition géographique des visiteurs — pays d'origine des vues,
    // toutes annonces confondues ou par annonce, pour le tableau de bord
    // professionnel.
    if (pathname === '/api/me/listings-geo' && method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      if (!user.is_professional) return sendJSON(res, 403, { error: 'Réservé aux comptes professionnels.' });
      const rows = db
        .prepare(
          `SELECT lv.country, COUNT(*) AS view_count
           FROM listing_views lv
           JOIN listings l ON l.id = lv.listing_id
           WHERE l.user_id = ? AND lv.country IS NOT NULL
           GROUP BY lv.country
           ORDER BY view_count DESC
           LIMIT 15`
        )
        .all(user.id);
      return sendJSON(res, 200, rows);
    }
    // Suivi de prospects (mini-CRM) — liste tous les prospects du
    // vendeur connecté, tous statuts confondus, avec les infos de
    // l'annonce et de l'acheteur (si contact enregistré via message).
    if (pathname === '/api/me/leads' && method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      if (!user.is_professional) return sendJSON(res, 403, { error: 'Réservé aux comptes professionnels.' });
      const rows = db
        .prepare(
          `SELECT ll.id, ll.listing_id, l.title AS listing_title, ll.buyer_id, u.name AS buyer_name, u.email AS buyer_email,
                  ll.contact_name, ll.contact_phone, ll.contact_email, ll.source, ll.status, ll.notes, ll.next_reminder_at, ll.created_at, ll.updated_at
           FROM listing_leads ll
           JOIN listings l ON l.id = ll.listing_id
           LEFT JOIN users u ON u.id = ll.buyer_id
           WHERE ll.seller_id = ?
           ORDER BY ll.updated_at DESC`
        )
        .all(user.id);
      return sendJSON(res, 200, rows);
    }
    // Ajout manuel d'un prospect contacté hors plateforme (visite
    // spontanée, appel téléphonique direct...) — buyer_id reste NULL,
    // les coordonnées sont saisies librement par le vendeur.
    if (pathname === '/api/me/leads' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      if (!user.is_professional) return sendJSON(res, 403, { error: 'Réservé aux comptes professionnels.' });
      const body = await readBody(req);
      const listing = db.prepare('SELECT id FROM listings WHERE id = ? AND user_id = ?').get(Number(body.listing_id), user.id);
      if (!listing) return sendJSON(res, 404, { error: 'Annonce introuvable.' });
      const contactName = (body.contact_name || '').trim();
      if (!contactName) return sendJSON(res, 400, { error: 'Le nom du prospect est requis.' });
      const result = db
        .prepare('INSERT INTO listing_leads (listing_id, seller_id, contact_name, contact_phone, contact_email, source, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(listing.id, user.id, contactName, (body.contact_phone || '').trim() || null, (body.contact_email || '').trim() || null, 'manual', 'nouveau');
      return sendJSON(res, 201, { ok: true, id: result.lastInsertRowid });
    }
    // Mise à jour d'un prospect : statut, notes, rappel — jamais les
    // coordonnées d'un prospect issu d'une conversation (buyer_id),
    // puisqu'elles proviennent alors du compte utilisateur lui-même.
    if ((m = pathname.match(/^\/api\/me\/leads\/(\d+)$/)) && method === 'PUT') {
      const user = requireAuth(req, res);
      if (!user) return;
      const lead = db.prepare('SELECT id FROM listing_leads WHERE id = ? AND seller_id = ?').get(Number(m[1]), user.id);
      if (!lead) return sendJSON(res, 404, { error: 'Prospect introuvable.' });
      const body = await readBody(req);
      const validStatuses = ['nouveau', 'contacte', 'visite_programmee', 'offre_faite', 'conclu', 'perdu'];
      const updates = [];
      const params = [];
      if (body.status !== undefined) {
        if (!validStatuses.includes(body.status)) return sendJSON(res, 400, { error: 'Statut invalide.' });
        updates.push('status = ?');
        params.push(body.status);
      }
      if (body.notes !== undefined) {
        updates.push('notes = ?');
        params.push((body.notes || '').trim() || null);
      }
      if (body.next_reminder_at !== undefined) {
        updates.push('next_reminder_at = ?');
        params.push((body.next_reminder_at || '').trim() || null);
      }
      if (!updates.length) return sendJSON(res, 400, { error: 'Aucune modification transmise.' });
      updates.push("updated_at = datetime('now')");
      params.push(Number(m[1]));
      db.prepare(`UPDATE listing_leads SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      return sendJSON(res, 200, { ok: true });
    }
    if ((m = pathname.match(/^\/api\/me\/leads\/(\d+)$/)) && method === 'DELETE') {
      const user = requireAuth(req, res);
      if (!user) return;
      const lead = db.prepare('SELECT id FROM listing_leads WHERE id = ? AND seller_id = ?').get(Number(m[1]), user.id);
      if (!lead) return sendJSON(res, 404, { error: 'Prospect introuvable.' });
      db.prepare('DELETE FROM listing_leads WHERE id = ?').run(Number(m[1]));
      return sendJSON(res, 200, { ok: true });
    }
    // Clients intéressés — utilisateurs ayant mis en favori au moins une
    // annonce du vendeur connecté, avec le détail de quelle(s) annonce(s).
    // Sert de base au ciblage "avant-première" ci-dessous.
    if (pathname === '/api/me/interested-clients' && method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      if (!user.is_professional) return sendJSON(res, 403, { error: 'Réservé aux comptes professionnels.' });
      const rows = db
        .prepare(
          `SELECT u.id AS user_id, u.name AS user_name, l.id AS listing_id, l.title AS listing_title, f.created_at AS favorited_at
           FROM favorites f
           JOIN listings l ON l.id = f.listing_id
           JOIN users u ON u.id = f.user_id
           WHERE l.user_id = ?
           ORDER BY f.created_at DESC`
        )
        .all(user.id);
      const clientsMap = new Map();
      for (const row of rows) {
        if (!clientsMap.has(row.user_id)) {
          clientsMap.set(row.user_id, { user_id: row.user_id, user_name: row.user_name, listings: [] });
        }
        clientsMap.get(row.user_id).listings.push({ listing_id: row.listing_id, listing_title: row.listing_title, favorited_at: row.favorited_at });
      }
      return sendJSON(res, 200, Array.from(clientsMap.values()));
    }
    // Avant-première — prévient, via la messagerie interne, tous les
    // clients ayant déjà mis en favori une autre annonce du même vendeur,
    // qu'une nouvelle annonce vient d'être publiée. Réutilise le système
    // de conversations existant (une conversation par annonce/acheteur).
    if ((m = pathname.match(/^\/api\/listings\/(\d+)\/notify-clients$/)) && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      if (!user.is_professional) return sendJSON(res, 403, { error: 'Réservé aux comptes professionnels.' });
      const listing = db.prepare('SELECT id, title, user_id FROM listings WHERE id = ?').get(Number(m[1]));
      if (!listing) return sendJSON(res, 404, { error: 'Annonce introuvable.' });
      if (listing.user_id !== user.id && user.role !== 'admin') {
        return sendJSON(res, 403, { error: "Vous n'êtes pas propriétaire de cette annonce." });
      }
      const interestedUserIds = db
        .prepare(
          `SELECT DISTINCT f.user_id
           FROM favorites f JOIN listings l ON l.id = f.listing_id
           WHERE l.user_id = ? AND l.id != ?`
        )
        .all(listing.user_id, listing.id)
        .map((r) => r.user_id);
      let notified = 0;
      const messageBody = `Bonjour, je vous préviens en avant-première d'une nouvelle annonce qui pourrait vous intéresser : "${listing.title}". N'hésitez pas à y jeter un œil !`;
      for (const buyerId of interestedUserIds) {
        if (buyerId === listing.user_id) continue;
        let conversation = db
          .prepare('SELECT id FROM conversations WHERE listing_id = ? AND buyer_id = ?')
          .get(listing.id, buyerId);
        let conversationId;
        if (conversation) {
          conversationId = conversation.id;
        } else {
          conversationId = db
            .prepare('INSERT INTO conversations (listing_id, buyer_id, seller_id) VALUES (?, ?, ?)')
            .run(listing.id, buyerId, listing.user_id).lastInsertRowid;
        }
        db.prepare('INSERT INTO messages (conversation_id, sender_id, body) VALUES (?, ?, ?)').run(conversationId, listing.user_id, messageBody);
        notified++;
      }
      return sendJSON(res, 200, { ok: true, notified });
    }
    if (pathname === '/api/me/listings' && method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      const rows = db
        .prepare(
          `SELECT l.id, l.title, l.listing_type, l.price, l.currency, l.status, l.images_json, l.created_at,
                  l.expires_at, l.boosted_until, l.view_count, l.is_secondhand, l.date_start, l.date_end, l.price_promo, l.price_type, l.capacity_guests, l.capacity_children, l.bedrooms, l.bathrooms, l.amenities_json, l.activity_duration, l.activity_group_size_min, l.activity_group_size_max, l.activity_languages, l.activity_meeting_point, l.activity_difficulty, l.activity_min_age, l.property_room_type, l.num_beds, l.cancellation_policy, l.activity_included, l.activity_excluded, l.activity_pickup_included, l.vehicle_brand, l.vehicle_model, l.vehicle_year, l.vehicle_mileage, l.vehicle_condition, l.vehicle_transmission, l.vehicle_fuel_type, l.surface_m2, l.num_rooms, l.floor_number, l.furnished, l.construction_year, l.job_contract_type, l.job_remote_type, l.job_experience_level, l.job_education_level, l.job_sector, l.job_cv_url, l.is_demo, l.transaction_completed, l.created_at,
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
      logAdminAction(db, admin, 'user_role_changed', 'user', targetId, { from: target.role, to: role });
      return sendJSON(res, 200, { ok: true });
    }
    if ((m = pathname.match(/^\/api\/admin\/users\/(\d+)$/)) && method === 'DELETE') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const targetId = Number(m[1]);
      const target = db.prepare('SELECT id, role, email FROM users WHERE id = ?').get(targetId);
      if (!target) return sendJSON(res, 404, { error: 'Utilisateur introuvable.' });
      if (targetId === admin.id) return sendJSON(res, 400, { error: 'Vous ne pouvez pas supprimer votre propre compte depuis ce panneau.' });
      if (target.role === 'admin') {
        const adminCount = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get().c;
        if (adminCount <= 1) return sendJSON(res, 400, { error: "Impossible : c'est le dernier compte administrateur." });
      }
      db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
      logAdminAction(db, admin, 'user_deleted', 'user', targetId, { email: target.email });
      return sendJSON(res, 200, { ok: true });
    }
    if (pathname === '/api/admin/listings' && method === 'GET') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const rows = db
        .prepare(
          `SELECT l.id, l.title, l.listing_type, l.price, l.currency, l.status, l.created_at, l.is_secondhand, l.date_start, l.date_end, l.price_promo, l.price_type, l.capacity_guests, l.capacity_children, l.bedrooms, l.bathrooms, l.amenities_json, l.activity_duration, l.activity_group_size_min, l.activity_group_size_max, l.activity_languages, l.activity_meeting_point, l.activity_difficulty, l.activity_min_age, l.property_room_type, l.num_beds, l.cancellation_policy, l.activity_included, l.activity_excluded, l.activity_pickup_included, l.vehicle_brand, l.vehicle_model, l.vehicle_year, l.vehicle_mileage, l.vehicle_condition, l.vehicle_transmission, l.vehicle_fuel_type, l.surface_m2, l.num_rooms, l.floor_number, l.furnished, l.construction_year, l.job_contract_type, l.job_remote_type, l.job_experience_level, l.job_education_level, l.job_sector, l.job_cv_url, l.is_demo, l.transaction_completed, l.expires_at,
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
    // ---------- Super Administrateur (réseau multi-site) ----------
    if (pathname === '/api/super-admin/sites' && method === 'GET') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      const sites = masterDb
        .prepare(`
          SELECT s.id, s.slug, s.subdomain, s.custom_domain, s.brand_name, s.status, s.owner_email, s.created_at,
                 s.billing_status, s.billing_plan_label, s.billing_notes, s.plan_id, s.grace_period_ends_at, s.demo_expires_at,
                 p.name AS plan_name
          FROM sites s LEFT JOIN plans p ON p.id = s.plan_id
          ORDER BY s.created_at DESC
        `)
        .all();
      return sendJSON(res, 200, sites);
    }
    // Met à jour le suivi de facturation d'un site (statut, formule,
    // notes) — suivi manuel pour l'instant, indépendant de tout
    // prestataire de paiement. N'affecte jamais automatiquement
    // l'accessibilité du site (status actif/suspendu reste une décision
    // séparée, volontaire, via la route dédiée) — un statut de
    // facturation "en retard" est une information, pas une sanction
    // automatique.
    if ((m = pathname.match(/^\/api\/super-admin\/sites\/(\d+)\/billing$/)) && method === 'PUT') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      const body = await readBody(req);
      const billingStatus = body.billing_status;
      if (!['trial', 'active', 'overdue', 'cancelled'].includes(billingStatus)) {
        return sendJSON(res, 400, { error: 'Statut de facturation invalide.' });
      }
      const targetSite = masterDb.prepare('SELECT id, slug FROM sites WHERE id = ?').get(Number(m[1]));
      if (!targetSite) return sendJSON(res, 404, { error: 'Site introuvable.' });
      const planId = body.plan_id !== undefined && body.plan_id !== '' ? Number(body.plan_id) : null;
      masterDb
        .prepare('UPDATE sites SET billing_status = ?, billing_plan_label = ?, billing_notes = ?, plan_id = ? WHERE id = ?')
        .run(billingStatus, (body.billing_plan_label || '').trim() || null, (body.billing_notes || '').trim() || null, planId, Number(m[1]));
      logAdminAction(masterDb, admin, 'site_billing_updated', 'site', targetSite.slug, { billing_status: billingStatus });
      return sendJSON(res, 200, { ok: true });
    }
    // Journal d'audit des actions Super Admin (création/suspension/
    // réactivation/suppression de site) — les 100 entrées les plus
    // récentes, les plus anciennes n'étant généralement plus pertinentes
    // à consulter au quotidien.
    if (pathname === '/api/super-admin/audit-log' && method === 'GET') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      const entries = masterDb
        .prepare('SELECT * FROM admin_audit_log ORDER BY created_at DESC LIMIT 100')
        .all();
      return sendJSON(res, 200, entries);
    }
    // Statistiques agrégées sur l'ensemble du réseau — un aperçu global
    // que le super administrateur ne peut obtenir autrement, chaque site
    // ayant sa propre base isolée. Ouvre (ou réutilise depuis le cache)
    // la base de chaque site actif pour y compter utilisateurs et
    // annonces — un aller-retour disque par site, acceptable pour un
    // réseau de taille raisonnable (dizaines de sites) ; à revoir avec
    // une mise en cache si le réseau grandissait considérablement.
    /** Calcule les compteurs (utilisateurs, annonces) d'un site précis —
 * factorisé pour être utilisé à la fois par la route de statistiques
 * globales et par l'enregistrement quotidien de l'historique (voir
 * recordDailySiteStats). Retourne null si la base du site est
 * inaccessible, plutôt que de faire échouer tout l'appelant. */
function computeSiteStats(site) {
  let siteDb;
  try {
    siteDb = getTenantDatabase(site.db_filename);
  } catch {
    return null;
  }
  return {
    userCount: siteDb.prepare('SELECT COUNT(*) AS c FROM users').get().c,
    listingCount: siteDb.prepare('SELECT COUNT(*) AS c FROM listings').get().c,
    activeListingCount: siteDb.prepare("SELECT COUNT(*) AS c FROM listings WHERE status = 'active'").get().c,
  };
}
/** Enregistre, une fois par jour, un instantané des compteurs de chaque
 * site actif — la table daily_site_stats accumule ainsi un historique
 * dans le temps, que le panneau Super Admin n'exploite pas encore
 * aujourd'hui (seul l'instantané du jour même est actuellement affiché),
 * mais qui existera déjà le jour où un tableau de bord avec graphiques
 * d'évolution sera construit. La contrainte UNIQUE(site_id, date) rend
 * l'opération idempotente : un redémarrage du serveur plusieurs fois
 * dans la même journée met à jour la ligne du jour plutôt que d'en créer
 * une nouvelle. */
function recordDailySiteStats() {
  const today = new Date().toISOString().slice(0, 10);
  const sites = masterDb.prepare('SELECT * FROM sites').all();
  for (const site of sites) {
    const stats = computeSiteStats(site);
    if (!stats) continue;
    masterDb
      .prepare(
        `INSERT INTO daily_site_stats (site_id, date, user_count, listing_count, active_listing_count)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(site_id, date) DO UPDATE SET
           user_count = excluded.user_count,
           listing_count = excluded.listing_count,
           active_listing_count = excluded.active_listing_count,
           recorded_at = datetime('now')`
      )
      .run(site.id, today, stats.userCount, stats.listingCount, stats.activeListingCount);
  }
  console.log(`[daily-stats] instantané enregistré pour ${sites.length} site(s), date ${today}.`);
}
/** Fait automatiquement basculer un site de "essai" à "en retard" une
 * fois sa période de grâce écoulée — jamais au-delà : contrairement à
 * la suspension effective (champ status), qui reste une décision
 * volontaire du Super Admin (voir requireSuperAdmin/route PUT status),
 * cette tâche ne fait QUE mettre à jour l'étiquette informative
 * billing_status. Elle ne bloque jamais l'accès au site elle-même —
 * exactement le principe retenu lors de la conception du suivi de
 * facturation : un statut "en retard" est une information, pas une
 * sanction automatique. */
function checkGracePeriodExpirations() {
  const expiredTrials = masterDb
    .prepare("SELECT id, slug FROM sites WHERE billing_status = 'trial' AND grace_period_ends_at IS NOT NULL AND grace_period_ends_at < datetime('now')")
    .all();
  for (const site of expiredTrials) {
    masterDb.prepare("UPDATE sites SET billing_status = 'overdue' WHERE id = ?").run(site.id);
    logAdminAction(masterDb, { id: null, email: 'tâche automatique' }, 'site_billing_updated', 'site', site.slug, { billing_status: 'overdue', reason: 'grace_period_expired' });
  }
  if (expiredTrials.length > 0) {
    console.log(`[grace-period] ${expiredTrials.length} site(s) passé(s) de "essai" à "en retard" (période de grâce écoulée).`);
  }
}
/** Supprime automatiquement les sites de démonstration (auto-provisionnés
 * depuis une réservation pré-lancement) une fois leur échéance dépassée
 * — même mécanisme exact que la suppression manuelle d'un site depuis le
 * Super Admin (fermeture de la connexion, suppression du fichier et de
 * ses annexes WAL, retrait du registre). Un Super Admin peut repousser
 * cette échéance au cas par cas (voir route extend-demo) pour un dossier
 * en discussion active, sans quoi ce nettoyage s'applique sans exception. */
function checkDemoExpirations() {
  const expiredDemos = masterDb
    .prepare("SELECT id, slug, db_filename, brand_name FROM sites WHERE demo_expires_at IS NOT NULL AND demo_expires_at < datetime('now')")
    .all();
  for (const site of expiredDemos) {
    closeTenantDatabase(site.db_filename);
    try {
      fs.unlinkSync(path.join(DATA_DIR, site.db_filename));
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('[demo-expiration] échec de la suppression du fichier de base :', err.message);
    }
    for (const suffix of ['-wal', '-shm']) {
      try {
        fs.unlinkSync(path.join(DATA_DIR, site.db_filename + suffix));
      } catch {
        // Absence normale la plupart du temps — rien à signaler.
      }
    }
    masterDb.prepare('DELETE FROM sites WHERE id = ?').run(site.id);
    logAdminAction(masterDb, { id: null, email: 'tâche automatique' }, 'site_deleted', 'site', site.slug, { brand_name: site.brand_name, reason: 'demo_expired' });
  }
  if (expiredDemos.length > 0) {
    console.log(`[demo-expiration] ${expiredDemos.length} site(s) de démonstration supprimé(s) (échéance dépassée).`);
  }
}
// Catégories activées/désactivées pour un site précis du réseau — la
// liste catégories elle-même (partagée, copiée à la création du site)
// est lue depuis SA PROPRE base, tandis que disabled_categories
// détermine lesquelles sont effectivement disponibles. Gestion
// exclusivement réservée au Super Admin (voir en-tête de
// disabled_categories dans db.js pour le raisonnement).
if ((m = pathname.match(/^\/api\/super-admin\/sites\/(\d+)\/categories$/)) && method === 'GET') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      const targetSite = masterDb.prepare('SELECT id, slug, db_filename FROM sites WHERE id = ?').get(Number(m[1]));
      if (!targetSite) return sendJSON(res, 404, { error: 'Site introuvable.' });
      const targetDb = getTenantDatabase(targetSite.db_filename);
      const categories = targetDb.prepare('SELECT id, slug, name, icon FROM categories ORDER BY id').all();
      const disabledIds = new Set(targetDb.prepare('SELECT category_id FROM disabled_categories').all().map((r) => r.category_id));
      return sendJSON(res, 200, categories.map((c) => ({ ...c, enabled: !disabledIds.has(c.id) })));
    }
    if ((m = pathname.match(/^\/api\/super-admin\/sites\/(\d+)\/categories$/)) && method === 'PUT') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      const targetSite = masterDb.prepare('SELECT id, slug, db_filename FROM sites WHERE id = ?').get(Number(m[1]));
      if (!targetSite) return sendJSON(res, 404, { error: 'Site introuvable.' });
      const body = await readBody(req);
      const disabledIds = Array.isArray(body.disabled_category_ids) ? body.disabled_category_ids.map(Number).filter(Boolean) : [];
      const targetDb = getTenantDatabase(targetSite.db_filename);
      targetDb.exec('BEGIN IMMEDIATE');
      try {
        targetDb.prepare('DELETE FROM disabled_categories').run();
        const insertStmt = targetDb.prepare('INSERT INTO disabled_categories (category_id) VALUES (?)');
        for (const id of disabledIds) insertStmt.run(id);
        targetDb.exec('COMMIT');
      } catch (err) {
        targetDb.exec('ROLLBACK');
        throw err;
      }
      logAdminAction(masterDb, admin, 'site_categories_updated', 'site', targetSite.slug, { disabled_category_ids: disabledIds });
      return sendJSON(res, 200, { ok: true });
    }
    // Même principe que les routes catégories ci-dessus, pour les pays.
    if ((m = pathname.match(/^\/api\/super-admin\/sites\/(\d+)\/countries$/)) && method === 'GET') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      const targetSite = masterDb.prepare('SELECT id, slug, db_filename FROM sites WHERE id = ?').get(Number(m[1]));
      if (!targetSite) return sendJSON(res, 404, { error: 'Site introuvable.' });
      const targetDb = getTenantDatabase(targetSite.db_filename);
      const countries = targetDb.prepare('SELECT id, name, iso2, continent FROM countries ORDER BY name').all();
      const disabledIds = new Set(targetDb.prepare('SELECT country_id FROM disabled_countries').all().map((r) => r.country_id));
      return sendJSON(res, 200, countries.map((c) => ({ ...c, enabled: !disabledIds.has(c.id) })));
    }
    if ((m = pathname.match(/^\/api\/super-admin\/sites\/(\d+)\/countries$/)) && method === 'PUT') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      const targetSite = masterDb.prepare('SELECT id, slug, db_filename FROM sites WHERE id = ?').get(Number(m[1]));
      if (!targetSite) return sendJSON(res, 404, { error: 'Site introuvable.' });
      const body = await readBody(req);
      const disabledIds = Array.isArray(body.disabled_country_ids) ? body.disabled_country_ids.map(Number).filter(Boolean) : [];
      const targetDb = getTenantDatabase(targetSite.db_filename);
      targetDb.exec('BEGIN IMMEDIATE');
      try {
        targetDb.prepare('DELETE FROM disabled_countries').run();
        const insertStmt = targetDb.prepare('INSERT INTO disabled_countries (country_id) VALUES (?)');
        for (const id of disabledIds) insertStmt.run(id);
        targetDb.exec('COMMIT');
      } catch (err) {
        targetDb.exec('ROLLBACK');
        throw err;
      }
      logAdminAction(masterDb, admin, 'site_countries_updated', 'site', targetSite.slug, { disabled_country_ids: disabledIds });
      return sendJSON(res, 200, { ok: true });
    }
    // Gestion des formules d'abonnement (plans) — briques du système
// «Site → Plan → Catégories → Tarif» évoqué par le document de vision.
// Pas de suppression définitive : un plan déjà associé à un site
// existant doit rester consultable pour l'historique — on le retire
// simplement de la liste proposée pour un NOUVEAU site (is_active).
// Réservation de sous-domaine avant lancement officiel — publique,
// gratuite, sans engagement (voir table site_reservations dans db.js).
if (pathname === '/api/reservations/check-subdomain' && method === 'GET') {
      const subdomainRaw = (url.searchParams.get('subdomain') || '').trim().toLowerCase();
      if (!subdomainRaw || !/^[a-z0-9-]{3,40}$/.test(subdomainRaw)) {
        return sendJSON(res, 200, { available: false, reason: 'invalid' });
      }
      const existingSite = masterDb.prepare('SELECT id FROM sites WHERE slug = ? OR subdomain LIKE ?').get(subdomainRaw, `${subdomainRaw}.%`);
      const existingReservation = masterDb.prepare("SELECT id FROM site_reservations WHERE subdomain = ? AND status = 'pending'").get(subdomainRaw);
      return sendJSON(res, 200, { available: !existingSite && !existingReservation });
    }
    if (pathname === '/api/reservations' && method === 'POST') {
      const body = await readBody(req);
      const subdomain = (body.subdomain || '').trim().toLowerCase();
      const businessName = (body.business_name || '').trim();
      const contactEmail = (body.contact_email || '').trim().toLowerCase();
      if (!/^[a-z0-9-]{3,40}$/.test(subdomain)) {
        return sendJSON(res, 400, { error: 'Sous-domaine invalide (lettres, chiffres, tirets, 3 à 40 caractères).' });
      }
      if (!businessName) return sendJSON(res, 400, { error: "Le nom de l'entreprise est requis." });
      if (!contactEmail || !contactEmail.includes('@')) return sendJSON(res, 400, { error: 'Adresse email invalide.' });
      const existingSite = masterDb.prepare('SELECT id FROM sites WHERE slug = ? OR subdomain LIKE ?').get(subdomain, `${subdomain}.%`);
      const existingReservation = masterDb.prepare("SELECT id FROM site_reservations WHERE subdomain = ? AND status = 'pending'").get(subdomain);
      if (existingSite || existingReservation) {
        return sendJSON(res, 409, { error: 'Ce sous-domaine est déjà pris ou réservé.' });
      }
      masterDb
        .prepare('INSERT INTO site_reservations (subdomain, business_name, sector, contact_email, contact_phone) VALUES (?, ?, ?, ?, ?)')
        .run(subdomain, businessName, (body.sector || '').trim() || null, contactEmail, (body.contact_phone || '').trim() || null);
      // Provisionnement immédiat d'un vrai site en mode essai — même
      // mécanisme que la création manuelle depuis le Super Admin, mais
      // déclenché automatiquement dès la réservation, pour que le
      // professionnel puisse tout de suite naviguer et publier une
      // annonce test sur SON sous-domaine. Aucun mot de passe n'étant
      // collecté sur ce formulaire public, un mot de passe aléatoire
      // inconnaissable est généré, puis un jeton de réinitialisation
      // (même mécanisme que "mot de passe oublié") est envoyé par email
      // pour qu'il en choisisse un lui-même.
      let provisionedSiteUrl = null;
      let setupLink = null;
      try {
        const dbFilename = `site_${subdomain}.db`;
        const newSiteDb = initializeDatabase(path.join(DATA_DIR, dbFilename));
        copyReferenceData(mainDb, newSiteDb);
        const randomPassword = crypto.randomBytes(24).toString('hex');
        const { salt, hash } = hashPassword(randomPassword);
        const ownerResult = newSiteDb
          .prepare(
            "INSERT INTO users (name, email, password_hash, password_salt, role, email_verified_at, terms_accepted_at) VALUES (?, ?, ?, ?, 'admin', datetime('now'), datetime('now'))"
          )
          .run(businessName, contactEmail, hash, salt);
        masterDb
          .prepare(
            `INSERT INTO sites (slug, subdomain, db_filename, brand_name, owner_email, status, grace_period_ends_at, demo_expires_at) VALUES (?, ?, ?, ?, ?, 'active', datetime('now', '+14 days'), datetime('now', '+30 days'))`
          )
          .run(subdomain, subdomain, dbFilename, businessName, contactEmail);
        masterDb.prepare("UPDATE site_reservations SET status = 'converted' WHERE subdomain = ?").run(subdomain);
        const raw = generateRawToken();
        newSiteDb
          .prepare("INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at) VALUES (?, 'reset_password', ?, datetime('now', '+7 days'))")
          .run(ownerResult.lastInsertRowid, hashRawToken(raw));
        provisionedSiteUrl = `https://${subdomain}.quickatlas.net`;
        setupLink = `${provisionedSiteUrl}/?reset=${raw}`;
      } catch (err) {
        console.error('[reservation] échec du provisionnement automatique du site :', err.message);
      }
      sendMail({
        smtpConfig: getSiteMailConfig(),
        to: contactEmail,
        purpose: 'reservation',
        subject: `Votre marketplace ${subdomain}.quickatlas.net est prête à découvrir !`,
        text: provisionedSiteUrl
          ? `Bonjour,\n\nVotre réservation pour ${subdomain}.quickatlas.net (${businessName}) est enregistrée — gratuite et sans engagement.\n\nVotre marketplace est déjà prête à explorer, en mode essai pendant 30 jours : choisissez votre mot de passe pour y accéder et publier votre première annonce test :\n${setupLink}\n\nCe lien de connexion est valable 7 jours. Votre période d'essai gratuite, elle, court sur 30 jours à partir d'aujourd'hui. Nous vous recontacterons personnellement avant son terme pour finaliser la mise en route si l'expérience vous convainc.\n\nÀ très bientôt,\nL'équipe QuickAtlas`
          : `Bonjour,\n\nVotre réservation pour ${subdomain}.quickatlas.net (${businessName}) est bien enregistrée — gratuite et sans engagement.\n\nNous vous recontacterons personnellement à l'approche du lancement officiel pour finaliser la mise en route de votre marketplace.\n\nÀ très bientôt,\nL'équipe QuickAtlas`,
        link: provisionedSiteUrl || SITE_URL,
      }).catch((err) => console.error('[reservation] échec envoi email confirmation :', err.message));
      // Notifie chaque super admin, pour ne pas dépendre d'une visite
      // manuelle régulière du panneau Réservations — la liste des
      // destinataires reste à jour automatiquement si un super admin est
      // ajouté ou retiré plus tard, sans adresse à coder en dur.
      const superAdmins = db.prepare("SELECT email FROM users WHERE role = 'super_admin'").all();
      for (const admin of superAdmins) {
        sendMail({
          smtpConfig: getSiteMailConfig(),
          to: admin.email,
          purpose: 'reservation_notification',
          subject: `Nouvelle réservation : ${subdomain}.quickatlas.net`,
          text: `Nouvelle réservation de sous-domaine reçue.\n\nEntreprise : ${businessName}\nSecteur : ${(body.sector || '').trim() || 'non précisé'}\nSous-domaine souhaité : ${subdomain}.quickatlas.net\nContact : ${contactEmail}${(body.contact_phone || '').trim() ? ` / ${(body.contact_phone || '').trim()}` : ''}\n\nÀ consulter et traiter depuis 🌐 Réseau de sites → Réservations.`,
          link: SITE_URL,
        }).catch((err) => console.error('[reservation] échec notification super admin :', err.message));
      }
      return sendJSON(res, 201, { ok: true });
    }
    if (pathname === '/api/super-admin/reservations' && method === 'GET') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      const rows = masterDb.prepare('SELECT * FROM site_reservations ORDER BY created_at DESC').all();
      return sendJSON(res, 200, rows);
    }
    // Campagnes d'emailing intégrées, avec traçabilité individuelle —
    // remplace le simple envoi groupé précédent. Un jeton unique par
    // destinataire permet de savoir qui a ouvert et cliqué, sans
    // dépendre d'un service tiers (Listmonk/Mautic).
    if (pathname === '/api/super-admin/campaigns' && method === 'POST') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      const body = await readBody(req);
      const subject = (body.subject || '').trim();
      const message = (body.message || '').trim();
      if (!subject || !message) return sendJSON(res, 400, { error: 'Objet et message requis.' });
      const ctaLabel = (body.cta_label || '').trim() || null;
      const ctaUrl = (body.cta_url || '').trim() || null;
      const statusFilter = ['pending', 'converted', 'declined'].includes(body.status_filter) ? body.status_filter : 'pending';
      const recipients = masterDb.prepare('SELECT contact_email FROM site_reservations WHERE status = ?').all(statusFilter);
      const campaignId = masterDb
        .prepare('INSERT INTO email_campaigns (subject, message, cta_label, cta_url, audience_filter, recipient_count) VALUES (?, ?, ?, ?, ?, ?)')
        .run(subject, message, ctaLabel, ctaUrl, statusFilter, recipients.length).lastInsertRowid;
      const escapedMessage = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
      for (const r of recipients) {
        const token = crypto.randomBytes(24).toString('hex');
        masterDb.prepare('INSERT INTO email_campaign_recipients (campaign_id, email, tracking_token) VALUES (?, ?, ?)').run(campaignId, r.contact_email, token);
        const ctaHtml = ctaUrl
          ? `<p style="text-align:center;margin:24px 0;"><a href="${SITE_URL}/api/campaigns/track-click/${token}" style="background:#C6A15B;color:#0E1B2E;padding:12px 28px;text-decoration:none;border-radius:6px;display:inline-block;font-weight:bold;">${ctaLabel || 'En savoir plus'}</a></p>`
          : '';
        const html = `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#0E1B2E;line-height:1.5;"><p>${escapedMessage}</p>${ctaHtml}<img src="${SITE_URL}/api/campaigns/track-open/${token}" width="1" height="1" style="display:none;" alt="" /></div>`;
        sendMail({
          smtpConfig: getSiteMailConfig(),
          to: r.contact_email,
          purpose: 'campaign',
          subject,
          text: message + (ctaUrl ? `\n\n${ctaLabel || 'En savoir plus'} : ${ctaUrl}` : ''),
          html,
          link: SITE_URL,
        }).catch((err) => console.error('[campaign] échec envoi à', r.contact_email, ':', err.message));
      }
      logAdminAction(masterDb, admin, 'campaign_sent', 'campaign', String(campaignId), { subject, status_filter: statusFilter, recipient_count: recipients.length });
      return sendJSON(res, 200, { ok: true, sent: recipients.length });
    }
    if (pathname === '/api/super-admin/campaigns' && method === 'GET') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      const rows = masterDb
        .prepare(
          `SELECT c.id, c.subject, c.audience_filter, c.recipient_count, c.sent_at,
                  COUNT(DISTINCT CASE WHEN r.open_count > 0 THEN r.id END) AS opened_count,
                  COUNT(DISTINCT CASE WHEN r.click_count > 0 THEN r.id END) AS clicked_count
           FROM email_campaigns c
           LEFT JOIN email_campaign_recipients r ON r.campaign_id = c.id
           GROUP BY c.id
           ORDER BY c.sent_at DESC`
        )
        .all();
      return sendJSON(res, 200, rows);
    }
    // Contacts unifiés — fusionne réservations et loueurs actifs (sites
    // réels) en une seule liste, dédupliquée par email : un loueur
    // converti apparaît comme "loueur actif", pas en double avec sa
    // réservation d'origine.
    if (pathname === '/api/super-admin/contacts' && method === 'GET') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      const rows = masterDb
        .prepare(
          `SELECT 'site' AS source, brand_name AS name, owner_email AS email, NULL AS phone, NULL AS sector, 'active_tenant' AS status, created_at
           FROM sites WHERE slug != 'main' AND owner_email IS NOT NULL
           UNION ALL
           SELECT 'reservation' AS source, business_name AS name, contact_email AS email, contact_phone AS phone, sector, status, created_at
           FROM site_reservations sr
           WHERE NOT EXISTS (SELECT 1 FROM sites s WHERE s.owner_email = sr.contact_email AND s.slug != 'main')
           UNION ALL
           SELECT 'cold_prospect' AS source, business_name AS name, email, phone, sector, 'cold_prospect' AS status, created_at
           FROM cold_prospects cp
           WHERE NOT EXISTS (SELECT 1 FROM sites s WHERE s.owner_email = cp.email AND s.slug != 'main')
             AND NOT EXISTS (SELECT 1 FROM site_reservations sr WHERE sr.contact_email = cp.email)
           ORDER BY created_at DESC`
        )
        .all();
      return sendJSON(res, 200, rows);
    }
    // Ajout groupé de prospects froids — pensé pour coller directement
    // un lot copié depuis un annuaire d'entreprises (Kerix, Charika...),
    // une ligne par prospect, plutôt qu'une saisie un par un. Le secteur
    // et la source sont communs à tout le lot collé en une fois.
    if (pathname === '/api/super-admin/prospects/bulk-add' && method === 'POST') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      const body = await readBody(req);
      const rawLines = (body.raw || '').split('\n').map((l) => l.trim()).filter(Boolean);
      if (rawLines.length === 0) return sendJSON(res, 400, { error: 'Aucune ligne à traiter.' });
      const sector = (body.sector || '').trim() || null;
      const source = (body.source || '').trim() || null;
      const insertStmt = masterDb.prepare('INSERT INTO cold_prospects (business_name, email, phone, sector, source) VALUES (?, ?, ?, ?, ?)');
      let added = 0;
      let skipped = 0;
      for (const line of rawLines) {
        const parts = line.split(',').map((p) => p.trim());
        const emailPart = parts.find((p) => p.includes('@'));
        if (!emailPart) { skipped++; continue; }
        const businessName = parts.find((p) => p !== emailPart) || emailPart;
        const phonePart = parts.find((p) => p !== emailPart && p !== businessName && /\d{6,}/.test(p)) || null;
        insertStmt.run(businessName, emailPart, phonePart, sector, source);
        added++;
      }
      logAdminAction(masterDb, admin, 'prospects_bulk_added', 'cold_prospect', null, { added, skipped, sector });
      return sendJSON(res, 200, { ok: true, added, skipped });
    }
    // Historique des emails reçus par un contact précis (campagnes
    // groupées ET envois individuels confondus — les deux utilisent la
    // même table de suivi, seule la campagne d'origine diffère).
    if (pathname === '/api/super-admin/contacts/history' && method === 'GET') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      const email = (url.searchParams.get('email') || '').trim();
      if (!email) return sendJSON(res, 400, { error: 'Email requis.' });
      const campaignRows = masterDb
        .prepare(
          `SELECT 'campaign' AS source, c.subject, c.sent_at, r.open_count, r.first_opened_at, r.click_count, r.first_clicked_at, NULL AS direction
           FROM email_campaign_recipients r
           JOIN email_campaigns c ON c.id = r.campaign_id
           WHERE r.email = ?`
        )
        .all(email);
      // Correspondance avec la boîte de réception du site principal —
      // dans les deux sens (ce que la personne nous a écrit, et ce
      // qu'on lui a envoyé depuis "Administration"), pour une vraie
      // vue unifiée de la relation, pas seulement les campagnes.
      const inboxRows = db
        .prepare(
          `SELECT 'inbox' AS source, subject, received_at AS sent_at, open_count, first_opened_at, NULL AS click_count, NULL AS first_clicked_at, direction
           FROM inbox_emails
           WHERE from_address = ? OR to_address = ?`
        )
        .all(email, email);
      const rows = [...campaignRows, ...inboxRows].sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at));
      return sendJSON(res, 200, rows);
    }
    // Email individuel tracé — réutilise exactement le même mécanisme
    // que les campagnes groupées (une campagne à un seul destinataire),
    // pour ne pas dupliquer la logique de suivi. Le CCI, lui, n'entre
    // jamais dans cette logique de suivi : c'est une copie simple, sans
    // jeton propre.
    if (pathname === '/api/super-admin/contacts/send' && method === 'POST') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      const body = await readBody(req);
      const to = (body.to || '').trim();
      const subject = (body.subject || '').trim();
      const message = (body.message || '').trim();
      if (!to || !subject || !message) return sendJSON(res, 400, { error: 'Destinataire, objet et message requis.' });
      const bcc = (body.bcc || '').trim();
      const campaignId = masterDb
        .prepare("INSERT INTO email_campaigns (subject, message, audience_filter, recipient_count) VALUES (?, ?, 'individual', 1)")
        .run(subject, message).lastInsertRowid;
      const token = crypto.randomBytes(24).toString('hex');
      masterDb.prepare('INSERT INTO email_campaign_recipients (campaign_id, email, tracking_token) VALUES (?, ?, ?)').run(campaignId, to, token);
      const escapedMessage = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
      const html = `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#0E1B2E;line-height:1.5;"><p>${escapedMessage}</p><img src="${SITE_URL}/api/campaigns/track-open/${token}" width="1" height="1" style="display:none;" alt="" /></div>`;
      await sendMail({
        smtpConfig: getSiteMailConfig(),
        to,
        bcc: bcc ? [bcc] : [],
        purpose: 'individual',
        subject,
        text: message,
        html,
        link: SITE_URL,
      });
      logAdminAction(masterDb, admin, 'individual_email_sent', 'contact', to, { subject });
      return sendJSON(res, 200, { ok: true });
    }
    // Pixel de suivi d'ouverture — route publique (chargée directement
    // par le client email, sans authentification possible), renvoie
    // toujours une image valide même si le jeton est invalide/déjà
    // traité, pour ne jamais casser l'affichage de l'email chez le
    // destinataire.
    if ((m = pathname.match(/^\/api\/campaigns\/track-open\/([a-f0-9]+)$/)) && method === 'GET') {
      const recipient = masterDb.prepare('SELECT id FROM email_campaign_recipients WHERE tracking_token = ?').get(m[1]);
      if (recipient) {
        masterDb.prepare("UPDATE email_campaign_recipients SET open_count = open_count + 1, first_opened_at = COALESCE(first_opened_at, datetime('now')) WHERE id = ?").run(recipient.id);
      }
      const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7', 'base64');
      res.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': pixel.length, 'Cache-Control': 'no-store' });
      return res.end(pixel);
    }
    // Même principe, pour un email envoyé (composé ou en réponse) depuis
    // la boîte de réception d'un site — accusé de lecture "informel" :
    // sait si le destinataire a ouvert l'email, sans notification
    // formelle envoyée à qui que ce soit.
    if ((m = pathname.match(/^\/api\/inbox\/track-open\/([a-f0-9]+)$/)) && method === 'GET') {
      const email = db.prepare('SELECT id FROM inbox_emails WHERE tracking_token = ?').get(m[1]);
      if (email) {
        db.prepare("UPDATE inbox_emails SET open_count = open_count + 1, first_opened_at = COALESCE(first_opened_at, datetime('now')) WHERE id = ?").run(email.id);
      }
      const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7', 'base64');
      res.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': pixel.length, 'Cache-Control': 'no-store' });
      return res.end(pixel);
    }
    // Redirection avec suivi de clic — même logique de tolérance : un
    // jeton invalide redirige simplement vers le site plutôt que
    // d'afficher une erreur au destinataire.
    if ((m = pathname.match(/^\/api\/campaigns\/track-click\/([a-f0-9]+)$/)) && method === 'GET') {
      const recipient = masterDb.prepare('SELECT r.id, c.cta_url FROM email_campaign_recipients r JOIN email_campaigns c ON c.id = r.campaign_id WHERE r.tracking_token = ?').get(m[1]);
      if (recipient) {
        masterDb.prepare("UPDATE email_campaign_recipients SET click_count = click_count + 1, first_clicked_at = COALESCE(first_clicked_at, datetime('now')) WHERE id = ?").run(recipient.id);
      }
      res.writeHead(302, { Location: recipient?.cta_url || SITE_URL });
      return res.end();
    }
    if ((m = pathname.match(/^\/api\/super-admin\/reservations\/(\d+)$/)) && method === 'PUT') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      const body = await readBody(req);
      if (!['pending', 'converted', 'declined'].includes(body.status)) return sendJSON(res, 400, { error: 'Statut invalide.' });
      masterDb.prepare('UPDATE site_reservations SET status = ? WHERE id = ?').run(body.status, Number(m[1]));
      return sendJSON(res, 200, { ok: true });
    }
if (pathname === '/api/super-admin/plans' && method === 'GET') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      const plans = masterDb.prepare('SELECT * FROM plans ORDER BY price_amount ASC').all();
      return sendJSON(res, 200, plans);
    }
    if (pathname === '/api/super-admin/plans' && method === 'POST') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      const body = await readBody(req);
      const name = (body.name || '').trim();
      if (!name) return sendJSON(res, 400, { error: 'Le nom de la formule est requis.' });
      const priceAmount = body.price_amount !== undefined && body.price_amount !== '' ? Number(body.price_amount) : null;
      const maxCategories = body.max_categories !== undefined && body.max_categories !== '' ? Number(body.max_categories) : null;
      const billingInterval = ['monthly', 'yearly'].includes(body.billing_interval) ? body.billing_interval : 'monthly';
      const result = masterDb
        .prepare('INSERT INTO plans (name, price_amount, price_currency, billing_interval, max_categories, description) VALUES (?, ?, ?, ?, ?, ?)')
        .run(name, priceAmount, (body.price_currency || 'EUR').trim(), billingInterval, maxCategories, (body.description || '').trim() || null);
      logAdminAction(masterDb, admin, 'plan_created', 'plan', name, { price_amount: priceAmount, max_categories: maxCategories });
      return sendJSON(res, 201, { ok: true, id: result.lastInsertRowid });
    }
    if ((m = pathname.match(/^\/api\/super-admin\/plans\/(\d+)$/)) && method === 'PUT') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      const plan = masterDb.prepare('SELECT id, name FROM plans WHERE id = ?').get(Number(m[1]));
      if (!plan) return sendJSON(res, 404, { error: 'Formule introuvable.' });
      const body = await readBody(req);
      const name = (body.name || '').trim();
      if (!name) return sendJSON(res, 400, { error: 'Le nom de la formule est requis.' });
      const priceAmount = body.price_amount !== undefined && body.price_amount !== '' ? Number(body.price_amount) : null;
      const maxCategories = body.max_categories !== undefined && body.max_categories !== '' ? Number(body.max_categories) : null;
      const billingInterval = ['monthly', 'yearly'].includes(body.billing_interval) ? body.billing_interval : 'monthly';
      masterDb
        .prepare('UPDATE plans SET name = ?, price_amount = ?, price_currency = ?, billing_interval = ?, max_categories = ?, description = ?, is_active = ? WHERE id = ?')
        .run(name, priceAmount, (body.price_currency || 'EUR').trim(), billingInterval, maxCategories, (body.description || '').trim() || null, body.is_active ? 1 : 0, Number(m[1]));
      logAdminAction(masterDb, admin, 'plan_updated', 'plan', name, { price_amount: priceAmount, max_categories: maxCategories });
      return sendJSON(res, 200, { ok: true });
    }
    if (pathname === '/api/super-admin/global-stats' && method === 'GET') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      const sites = masterDb.prepare('SELECT * FROM sites ORDER BY created_at ASC').all();
      const perSite = [];
      let totalUsers = 0;
      let totalListings = 0;
      let totalActiveListings = 0;
      for (const site of sites) {
        const stats = computeSiteStats(site);
        if (!stats) {
          perSite.push({ slug: site.slug, brand_name: site.brand_name, status: site.status, error: true });
          continue;
        }
        totalUsers += stats.userCount;
        totalListings += stats.listingCount;
        totalActiveListings += stats.activeListingCount;
        perSite.push({
          slug: site.slug,
          brand_name: site.brand_name,
          status: site.status,
          billing_status: site.billing_status,
          user_count: stats.userCount,
          listing_count: stats.listingCount,
          active_listing_count: stats.activeListingCount,
        });
      }
      return sendJSON(res, 200, {
        totals: {
          site_count: sites.length,
          active_site_count: sites.filter((s) => s.status === 'active').length,
          user_count: totalUsers,
          listing_count: totalListings,
          active_listing_count: totalActiveListings,
        },
        sites: perSite,
      });
    }
    if (pathname === '/api/super-admin/sites' && method === 'POST') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      const body = await readBody(req);
      const slug = (body.slug || '').trim().toLowerCase();
      const brandName = (body.brand_name || '').trim();
      const subdomain = (body.subdomain || '').trim().toLowerCase() || null;
      const customDomain = (body.custom_domain || '').trim().toLowerCase() || null;
      const ownerName = (body.owner_name || '').trim();
      const ownerEmail = (body.owner_email || '').trim().toLowerCase();
      const ownerPassword = body.owner_password || '';
      const planId = body.plan_id !== undefined && body.plan_id !== '' ? Number(body.plan_id) : null;
      // Période de grâce : nombre de jours configurable au moment de la
      // création (14 par défaut) — le Super Admin ajuste selon l'accord
      // passé avec ce loueur précis, cohérent avec le principe "les
      // catégories sont activées selon le besoin du loueur et de
      // l'accord passé" déjà retenu pour les catégories.
      const gracePeriodDays = body.grace_period_days !== undefined && body.grace_period_days !== '' ? Number(body.grace_period_days) : 14;
      if (!/^[a-z0-9-]{2,40}$/.test(slug)) {
        return sendJSON(res, 400, { error: 'Identifiant de site invalide (lettres minuscules, chiffres et tirets uniquement, 2 à 40 caractères).' });
      }
      if (!brandName) return sendJSON(res, 400, { error: 'Le nom de la marque est requis.' });
      if (!subdomain && !customDomain) {
        return sendJSON(res, 400, { error: 'Au moins un sous-domaine ou un domaine personnalisé est requis.' });
      }
      if (!ownerName || !isValidEmail(ownerEmail)) {
        return sendJSON(res, 400, { error: "Nom et email valide de l'administrateur du site sont requis." });
      }
      const pwIssues = passwordIssues(ownerPassword);
      if (pwIssues.length) {
        return sendJSON(res, 400, { error: 'Mot de passe trop faible : 8 caractères minimum, avec au moins une lettre et un chiffre.' });
      }
      const existing = masterDb
        .prepare('SELECT id FROM sites WHERE slug = ? OR (subdomain IS NOT NULL AND subdomain = ?) OR (custom_domain IS NOT NULL AND custom_domain = ?)')
        .get(slug, subdomain, customDomain);
      if (existing) return sendJSON(res, 409, { error: 'Un site avec ce slug ou ce domaine existe déjà.' });
      const dbFilename = `site_${slug}.db`;
      let newSiteDb;
      try {
        newSiteDb = initializeDatabase(path.join(DATA_DIR, dbFilename));
        // Copie la géographie (pays, régions, villes) et les catégories du
        // site principal — sans ça, un nouveau site démarrerait avec une
        // carte vide et aucune catégorie utilisable.
        copyReferenceData(mainDb, newSiteDb);
      } catch (err) {
        return sendJSON(res, 500, { error: 'Échec de la création de la base du nouveau site : ' + err.message });
      }
      const { salt, hash } = hashPassword(ownerPassword);
      newSiteDb
        .prepare(
          "INSERT INTO users (name, email, password_hash, password_salt, role, email_verified_at, terms_accepted_at) VALUES (?, ?, ?, ?, 'admin', datetime('now'), datetime('now'))"
        )
        .run(ownerName, ownerEmail, hash, salt);
      masterDb
        .prepare(
          `INSERT INTO sites (slug, subdomain, custom_domain, db_filename, brand_name, owner_email, status, plan_id, grace_period_ends_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, datetime('now', ?))`
        )
        .run(slug, subdomain, customDomain, dbFilename, brandName, ownerEmail, planId, `+${gracePeriodDays} days`);
      logAdminAction(masterDb, admin, 'site_created', 'site', slug, { brand_name: brandName, subdomain, custom_domain: customDomain, owner_email: ownerEmail, plan_id: planId, grace_period_days: gracePeriodDays });
      // Si ce sous-domaine correspondait à une réservation en attente,
      // elle est marquée convertie — sans effet si aucune réservation
      // ne correspond (création directe, sans passer par la réservation).
      masterDb.prepare("UPDATE site_reservations SET status = 'converted' WHERE subdomain = ? AND status = 'pending'").run(slug);
      return sendJSON(res, 201, { ok: true, slug, db_filename: dbFilename });
    }
    if ((m = pathname.match(/^\/api\/super-admin\/sites\/(\d+)$/)) && method === 'PUT') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      const body = await readBody(req);
      const status = body.status;
      if (!['active', 'suspended'].includes(status)) return sendJSON(res, 400, { error: 'Statut invalide.' });
      const targetSite = masterDb.prepare('SELECT id, slug FROM sites WHERE id = ?').get(Number(m[1]));
      if (!targetSite) return sendJSON(res, 404, { error: 'Site introuvable.' });
      if (targetSite.slug === 'main') return sendJSON(res, 400, { error: 'Impossible de suspendre le site principal.' });
      masterDb.prepare('UPDATE sites SET status = ? WHERE id = ?').run(status, Number(m[1]));
      logAdminAction(masterDb, admin, status === 'suspended' ? 'site_suspended' : 'site_reactivated', 'site', targetSite.slug, null);
      return sendJSON(res, 200, { ok: true });
    }
    // Prolonge l'échéance d'un site de démonstration — repousse de 30
    // jours supplémentaires à partir de maintenant, pour un dossier en
    // discussion active. Sans effet visible sur un site qui n'est pas
    // une démonstration (demo_expires_at déjà NULL).
    if ((m = pathname.match(/^\/api\/super-admin\/sites\/(\d+)\/extend-demo$/)) && method === 'PUT') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      const targetSite = masterDb.prepare('SELECT id, slug, demo_expires_at FROM sites WHERE id = ?').get(Number(m[1]));
      if (!targetSite) return sendJSON(res, 404, { error: 'Site introuvable.' });
      if (!targetSite.demo_expires_at) return sendJSON(res, 400, { error: "Ce site n'est pas un site de démonstration." });
      masterDb.prepare("UPDATE sites SET demo_expires_at = datetime('now', '+30 days') WHERE id = ?").run(Number(m[1]));
      logAdminAction(masterDb, admin, 'site_demo_extended', 'site', targetSite.slug, null);
      return sendJSON(res, 200, { ok: true });
    }
    // Suppression définitive d'un site — action irréversible (base de
    // données entière, avec tous ses utilisateurs et annonces, effacée).
    // Exige de retaper l'identifiant technique exact du site en
    // confirmation, en plus du verbe DELETE lui-même — double
    // protection contre une suppression accidentelle.
    if ((m = pathname.match(/^\/api\/super-admin\/sites\/(\d+)$/)) && method === 'DELETE') {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      const body = await readBody(req);
      const targetSite = masterDb.prepare('SELECT id, slug, db_filename, brand_name FROM sites WHERE id = ?').get(Number(m[1]));
      if (!targetSite) return sendJSON(res, 404, { error: 'Site introuvable.' });
      if (targetSite.slug === 'main') return sendJSON(res, 400, { error: 'Impossible de supprimer le site principal.' });
      if ((body.confirm_slug || '').trim().toLowerCase() !== targetSite.slug) {
        return sendJSON(res, 400, { error: "L'identifiant technique saisi ne correspond pas — suppression annulée." });
      }
      closeTenantDatabase(targetSite.db_filename);
      try {
        fs.unlinkSync(path.join(DATA_DIR, targetSite.db_filename));
      } catch (err) {
        if (err.code !== 'ENOENT') console.error('[super-admin] échec de la suppression du fichier de base :', err.message);
      }
      // Les fichiers annexes de node:sqlite (mode WAL) — supprimés eux
      // aussi si présents, sans faire échouer l'opération s'ils sont
      // absents (mode non-WAL, ou déjà nettoyés automatiquement).
      for (const suffix of ['-wal', '-shm']) {
        try {
          fs.unlinkSync(path.join(DATA_DIR, targetSite.db_filename + suffix));
        } catch {
          // Absence normale la plupart du temps — rien à signaler.
        }
      }
      masterDb.prepare('DELETE FROM sites WHERE id = ?').run(Number(m[1]));
      logAdminAction(masterDb, admin, 'site_deleted', 'site', targetSite.slug, { brand_name: targetSite.brand_name });
      return sendJSON(res, 200, { ok: true });
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
      const shareVisits = db.prepare("SELECT COUNT(*) AS c FROM site_visits WHERE source = 'share'").get().c;
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
           WHERE cat.id NOT IN (SELECT category_id FROM disabled_categories)
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
        newListings7d, newUsers7d, countriesWithListings, totalVisits, visits7d, shareVisits,
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
        // Nouvelle conversation = nouveau prospect suivi automatiquement
        // pour le vendeur (voir listing_leads) — un contact qui écrit
        // pour la première fois au sujet d'une annonce est un signal
        // d'intérêt fort, contrairement à un simple favori.
        db.prepare('INSERT INTO listing_leads (listing_id, seller_id, buyer_id, source, status) VALUES (?, ?, ?, ?, ?)')
          .run(listing_id, listing.user_id, user.id, 'message', 'nouveau');
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
          `SELECT l.id, l.title, l.listing_type, l.price, l.currency, l.images_json, l.is_secondhand, l.date_start, l.date_end, l.price_promo, l.price_type, l.capacity_guests, l.capacity_children, l.bedrooms, l.bathrooms, l.amenities_json, l.activity_duration, l.activity_group_size_min, l.activity_group_size_max, l.activity_languages, l.activity_meeting_point, l.activity_difficulty, l.activity_min_age, l.property_room_type, l.num_beds, l.cancellation_policy, l.activity_included, l.activity_excluded, l.activity_pickup_included, l.vehicle_brand, l.vehicle_model, l.vehicle_year, l.vehicle_mileage, l.vehicle_condition, l.vehicle_transmission, l.vehicle_fuel_type, l.surface_m2, l.num_rooms, l.floor_number, l.furnished, l.construction_year, l.job_contract_type, l.job_remote_type, l.job_experience_level, l.job_education_level, l.job_sector, l.job_cv_url, l.is_demo, l.transaction_completed, l.created_at, l.expires_at,
                  sub.slug AS subcategory_slug, sub.name AS subcategory_name,
                  ci.name AS city_name, co.iso2 AS country_iso2, co.name AS country_name
           FROM listings l
           JOIN categories cat ON cat.id = l.category_id
           LEFT JOIN subcategories sub ON sub.id = l.subcategory_id
           JOIN cities ci ON ci.id = l.city_id
           JOIN countries co ON co.id = ci.country_id
           WHERE cat.slug = 'opportunites-affaires' AND co.id = ? AND l.status = 'active' AND l.expires_at > datetime('now') AND l.category_id NOT IN (SELECT category_id FROM disabled_categories) AND co.id NOT IN (SELECT country_id FROM disabled_countries)
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
           WHERE cat.slug = 'emploi' AND l.listing_type = 'offre_emploi' AND ci.country_id = ? AND l.status = 'active' AND l.expires_at > datetime('now') AND l.category_id NOT IN (SELECT category_id FROM disabled_categories) AND ci.country_id NOT IN (SELECT country_id FROM disabled_countries)`
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
    // Upload générique (n'importe quel type de fichier, pas seulement des
    // images) — réservé aux administrateurs, pour joindre des pièces
    // jointes aux emails envoyés depuis la boîte de réception du site.
    if (pathname === '/api/admin/uploads/attachment' && method === 'POST') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const { data, mime, filename: originalName } = await readBody(req);
      if (!data || !originalName) return sendJSON(res, 400, { error: 'Fichier invalide.' });
      const buffer = Buffer.from(data, 'base64');
      if (buffer.length > 10_000_000) return sendJSON(res, 400, { error: 'Fichier trop volumineux (10 Mo maximum).' });
      const attachmentsDir = path.join(DATA_DIR, 'attachments');
      if (!fs.existsSync(attachmentsDir)) fs.mkdirSync(attachmentsDir, { recursive: true });
      const safeExt = (originalName.split('.').pop() || 'bin').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10);
      const storedFilename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${safeExt}`;
      fs.writeFileSync(path.join(attachmentsDir, storedFilename), buffer);
      return sendJSON(res, 201, {
        url: `/attachments/${storedFilename}`,
        filename: originalName,
        mime: mime || 'application/octet-stream',
      });
    }
    // Upload de CV — accessible à tout utilisateur connecté (pas réservé à
    // l'admin, contrairement à /admin/uploads/attachment), pour joindre un
    // CV à une annonce de type "demande d'emploi". Restreint aux formats
    // usuels d'un CV (PDF, Word), taille plus limitée qu'une pièce jointe
    // d'email classique.
    if (pathname === '/api/uploads/cv' && method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      const { data, mime, filename: originalName } = await readBody(req);
      if (!data || !originalName) return sendJSON(res, 400, { error: 'Fichier invalide.' });
      const allowedExt = ['pdf', 'doc', 'docx'];
      const ext = (originalName.split('.').pop() || '').toLowerCase();
      if (!allowedExt.includes(ext)) {
        return sendJSON(res, 400, { error: 'Format non autorisé — utilisez un PDF ou un document Word (.pdf, .doc, .docx).' });
      }
      const buffer = Buffer.from(data, 'base64');
      if (buffer.length > 5_000_000) return sendJSON(res, 400, { error: 'Fichier trop volumineux (5 Mo maximum).' });
      const cvDir = path.join(DATA_DIR, 'attachments');
      if (!fs.existsSync(cvDir)) fs.mkdirSync(cvDir, { recursive: true });
      const storedFilename = `cv-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
      fs.writeFileSync(path.join(cvDir, storedFilename), buffer);
      return sendJSON(res, 201, { url: `/attachments/${storedFilename}`, filename: originalName });
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
      // N'exploite le repli par langue QUE si la locale précise
      // effectivement une région (ex. "fr-MA", "en-US") — une locale
      // "nue" comme "fr" ou "en" est un code de LANGUE, pas de pays : le
      // confondre avec un code pays a précédemment fait deviner "France"
      // à des visiteurs marocains, algériens, belges... dont le
      // navigateur ne précise pas de région (bug réel, corrigé ici).
      if (!country && locale && /[-_]/.test(locale)) {
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
          `SELECT l.id, l.title, l.listing_type, l.price, l.currency, l.images_json, l.boosted_until, l.created_at, l.view_count, l.is_secondhand, l.date_start, l.date_end, l.price_promo, l.price_type, l.capacity_guests, l.capacity_children, l.bedrooms, l.bathrooms, l.amenities_json, l.activity_duration, l.activity_group_size_min, l.activity_group_size_max, l.activity_languages, l.activity_meeting_point, l.activity_difficulty, l.activity_min_age, l.property_room_type, l.num_beds, l.cancellation_policy, l.activity_included, l.activity_excluded, l.activity_pickup_included, l.vehicle_brand, l.vehicle_model, l.vehicle_year, l.vehicle_mileage, l.vehicle_condition, l.vehicle_transmission, l.vehicle_fuel_type, l.surface_m2, l.num_rooms, l.floor_number, l.furnished, l.construction_year, l.job_contract_type, l.job_remote_type, l.job_experience_level, l.job_education_level, l.job_sector, l.job_cv_url, l.is_demo, l.transaction_completed, l.expires_at,
                  cat.slug AS category_slug, cat.name AS category_name, cat.icon AS category_icon,
                  sub.slug AS subcategory_slug, sub.name AS subcategory_name,
                  ci.name AS city_name, co.iso2 AS country_iso2, co.name AS country_name
           FROM favorites f
           JOIN listings l ON l.id = f.listing_id
           JOIN categories cat ON cat.id = l.category_id
           LEFT JOIN subcategories sub ON sub.id = l.subcategory_id
           JOIN cities ci ON ci.id = l.city_id
           JOIN countries co ON co.id = ci.country_id
           WHERE f.user_id = ? AND l.status = 'active' AND l.expires_at > datetime('now') AND l.category_id NOT IN (SELECT category_id FROM disabled_categories) AND co.id NOT IN (SELECT country_id FROM disabled_countries)
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
    // Configuration email propre à ce site (identifiants SMTP/IMAP —
    // généralement un compte Gmail avec mot de passe d'application,
    // exactement comme pour le site principal). Permet à un site du
    // réseau d'envoyer et de recevoir ses emails sous sa propre identité,
    // plutôt que de dépendre du compte du site principal. Le mot de passe
    // n'est jamais renvoyé au navigateur, ni en clair ni chiffré — seule
    // sa présence (has_password) est indiquée.
    if (pathname === '/api/admin/settings/email' && method === 'GET') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const rows = db
        .prepare("SELECT key, value FROM site_settings WHERE key IN ('smtp_host','smtp_port','smtp_user','smtp_pass_encrypted','mail_from')")
        .all();
      const settings = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      return sendJSON(res, 200, {
        smtp_host: settings.smtp_host || '',
        smtp_port: settings.smtp_port || '',
        smtp_user: settings.smtp_user || '',
        mail_from: settings.mail_from || '',
        has_password: !!settings.smtp_pass_encrypted,
      });
    }
    if (pathname === '/api/admin/settings/email' && method === 'PUT') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const body = await readBody(req);
      const smtpHost = (body.smtp_host || '').trim();
      const smtpPort = (body.smtp_port || '').trim();
      const smtpUser = (body.smtp_user || '').trim();
      const mailFrom = (body.mail_from || '').trim();
      const smtpPass = (body.smtp_pass || '').trim();
      if (!smtpHost || !smtpUser) {
        return sendJSON(res, 400, { error: 'Serveur SMTP et nom d\'utilisateur sont requis.' });
      }
      const upsert = (key, value) => {
        if (value) {
          db.prepare("INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
        } else {
          db.prepare('DELETE FROM site_settings WHERE key = ?').run(key);
        }
      };
      upsert('smtp_host', smtpHost);
      upsert('smtp_port', smtpPort);
      upsert('smtp_user', smtpUser);
      upsert('mail_from', mailFrom);
      // Le mot de passe n'est mis à jour QUE si un nouveau a été saisi —
      // laisser le champ vide dans le formulaire permet de modifier les
      // autres réglages (serveur, port...) sans avoir à ressaisir un mot
      // de passe déjà enregistré.
      if (smtpPass) {
        db.prepare("INSERT INTO site_settings (key, value) VALUES ('smtp_pass_encrypted', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(encryptApiKey(smtpPass));
      }
      return sendJSON(res, 200, { ok: true });
    }
    if (pathname === '/api/admin/settings/email' && method === 'DELETE') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      db.prepare("DELETE FROM site_settings WHERE key IN ('smtp_host','smtp_port','smtp_user','smtp_pass_encrypted','mail_from')").run();
      return sendJSON(res, 200, { ok: true });
    }
    // Activation/désactivation de la carte du monde sur l'accueil — utile
    // pour masquer temporairement le concept lors d'une présentation, sans
    // toucher au reste de la page (titre, recherche restent visibles).
    // Activée par défaut si jamais réglée (absence de ligne = activée).
    // Informations de marque du site actuellement visité (nom, logo) —
    // route publique (aucune authentification requise), puisqu'elle sert
    // à afficher le bon nom dès le tout premier chargement de la page,
    // avant même qu'un visiteur ne se connecte. Le nom de marque provient
    // du registre central (siteInfoContext), pas de la base du site
    // elle-même, puisque c'est une information de configuration du
    // réseau multi-site, pas une donnée métier du site.
    if (pathname === '/api/site-info' && method === 'GET') {
      const currentSite = siteInfoContext.getStore();
      const logoRow = db.prepare("SELECT value FROM site_settings WHERE key = 'logo_url'").get();
      return sendJSON(res, 200, {
        brand_name: (currentSite && currentSite.brand_name) || 'QuickAtlas',
        logo_url: logoRow ? logoRow.value : null,
      });
    }
    if (pathname === '/api/settings/map-enabled' && method === 'GET') {
      const row = db.prepare("SELECT value FROM site_settings WHERE key = 'map_enabled'").get();
      return sendJSON(res, 200, { enabled: row ? row.value === 'true' : true });
    }
    if (pathname === '/api/admin/settings/map-enabled' && method === 'POST') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const body = await readBody(req);
      const enabled = body.enabled !== false;
      db.prepare("INSERT INTO site_settings (key, value) VALUES ('map_enabled', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(enabled ? 'true' : 'false');
      return sendJSON(res, 200, { enabled });
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
      const bcc = Array.isArray(body.bcc) ? body.bcc.map((addr) => (addr || '').trim()).filter(Boolean) : [];
      const to = (body.to || '').trim() || (bcc.length ? admin.email : '');
      const subject = (body.subject || '').trim();
      const text = (body.text || '').trim();
      if ((!to && bcc.length === 0) || !subject || !text) {
        return sendJSON(res, 400, { error: 'Un destinataire (À ou CCI), un sujet et un message sont requis.' });
      }
      const attachments = readAttachmentFromUrl(body.attachment_url, body.attachment_filename, body.attachment_mime);
      const composeToken = crypto.randomBytes(24).toString('hex');
      const composeHtml = `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#0E1B2E;line-height:1.5;"><p>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p><img src="${SITE_URL}/api/inbox/track-open/${composeToken}" width="1" height="1" style="display:none;" alt="" /></div>`;
      await sendMail({
        smtpConfig: getSiteMailConfig(), to, bcc, purpose: 'admin_compose', subject, text, html: composeHtml, link: SITE_URL, attachments });
      const recordedTo = bcc.length ? `${to}${bcc.length ? ` (CCI: ${bcc.length})` : ''}` : to;
      db.prepare(
        "INSERT INTO inbox_emails (uid, from_address, to_address, subject, body_text, received_at, direction, is_read, tracking_token) VALUES (?, ?, ?, ?, ?, ?, 'sent', 1, ?)"
      ).run(-Date.now() - Math.floor(Math.random() * 1000), admin.email || 'contact@quickatlas.net', recordedTo, subject, text, new Date().toISOString(), composeToken);
      return sendJSON(res, 200, { ok: true });
    }
    if (pathname === '/api/admin/inbox' && method === 'GET') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const view = url.searchParams.get('view') === 'sent' ? 'sent' : 'received';
      const rows = db
        .prepare('SELECT id, from_address, from_name, to_address, subject, received_at, is_read, replied, direction, from_spam, open_count, first_opened_at FROM inbox_emails WHERE direction = ? ORDER BY received_at DESC LIMIT 200')
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
    // Suppression d'un email de la boîte de réception — retire aussi les
    // réponses envoyées qui lui sont liées. Sans danger vis-à-vis de la
    // synchronisation IMAP : celle-ci ne revisite jamais les UID déjà vus
    // (voir checkInboxEmails), donc l'email ne réapparaîtra pas au
    // prochain cycle.
    if ((m = pathname.match(/^\/api\/admin\/inbox\/(\d+)$/)) && method === 'DELETE') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const email = db.prepare('SELECT id FROM inbox_emails WHERE id = ?').get(Number(m[1]));
      if (!email) return sendJSON(res, 404, { error: 'Email introuvable.' });
      db.prepare('DELETE FROM inbox_emails WHERE in_reply_to_id = ?').run(email.id);
      db.prepare('DELETE FROM inbox_emails WHERE id = ?').run(email.id);
      return sendJSON(res, 200, { ok: true });
    }
    // Suppression groupée — accepte soit une liste précise d'identifiants,
    // soit { all: true, view: 'received'|'sent' } pour tout vider d'un
    // coup (utilisé par le bouton "Sélectionner tout").
    if (pathname === '/api/admin/inbox/bulk-delete' && method === 'POST') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const body = await readBody(req);
      let ids = [];
      if (body.all) {
        const view = body.view === 'sent' ? 'sent' : 'received';
        ids = db.prepare('SELECT id FROM inbox_emails WHERE direction = ?').all(view).map((r) => r.id);
      } else if (Array.isArray(body.ids)) {
        ids = body.ids.map(Number).filter((n) => Number.isInteger(n));
      }
      if (ids.length === 0) return sendJSON(res, 200, { ok: true, deleted: 0 });
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(`DELETE FROM inbox_emails WHERE in_reply_to_id IN (${placeholders})`).run(...ids);
      db.prepare(`DELETE FROM inbox_emails WHERE id IN (${placeholders})`).run(...ids);
      return sendJSON(res, 200, { ok: true, deleted: ids.length });
    }
    if ((m = pathname.match(/^\/api\/admin\/inbox\/(\d+)\/reply$/)) && method === 'POST') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const email = db.prepare('SELECT * FROM inbox_emails WHERE id = ?').get(Number(m[1]));
      if (!email) return sendJSON(res, 404, { error: 'Email introuvable.' });
      const body = await readBody(req);
      const replyText = (body.text || '').trim();
      if (!replyText) return sendJSON(res, 400, { error: 'Message vide.' });
      const attachments = readAttachmentFromUrl(body.attachment_url, body.attachment_filename, body.attachment_mime);
      const replyToken = crypto.randomBytes(24).toString('hex');
      const replySubject = email.subject && email.subject.startsWith('Re:') ? email.subject : `Re: ${email.subject || ''}`;
      const replyHtml = `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#0E1B2E;line-height:1.5;"><p>${replyText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p><img src="${SITE_URL}/api/inbox/track-open/${replyToken}" width="1" height="1" style="display:none;" alt="" /></div>`;
      await sendMail({
        smtpConfig: getSiteMailConfig(),
        to: email.from_address,
        purpose: 'admin_reply',
        subject: replySubject,
        text: replyText,
        html: replyHtml,
        link: SITE_URL,
        attachments,
      });
      db.prepare('UPDATE inbox_emails SET replied = 1 WHERE id = ?').run(email.id);
      db.prepare(
        "INSERT INTO inbox_emails (uid, from_address, to_address, subject, body_text, received_at, direction, is_read, in_reply_to_id, tracking_token) VALUES (?, ?, ?, ?, ?, ?, 'sent', 1, ?, ?)"
      ).run(
        -Date.now() - Math.floor(Math.random() * 1000),
        admin.email || 'contact@quickatlas.net',
        email.from_address,
        replySubject,
        replyText,
        new Date().toISOString(),
        email.id,
        replyToken
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
        smtpConfig: getSiteMailConfig(),
          to: reqRow.email,
          purpose: 'city_request_fulfilled',
          subject: `${reqRow.city_name} est maintenant disponible sur ${currentSiteName()}`,
          text: `Bonjour,\n\nVous nous aviez signalé l'absence de ${reqRow.city_name}. Bonne nouvelle : cette ville est désormais disponible sur ${currentSiteName()} !\n\nÀ bientôt,\nL'équipe ${currentSiteName()}`,
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
          `SELECT l.id, l.title, l.listing_type, l.price, l.currency, l.images_json, l.boosted_until, l.is_secondhand, l.date_start, l.date_end, l.price_promo, l.price_type, l.capacity_guests, l.capacity_children, l.bedrooms, l.bathrooms, l.amenities_json, l.activity_duration, l.activity_group_size_min, l.activity_group_size_max, l.activity_languages, l.activity_meeting_point, l.activity_difficulty, l.activity_min_age, l.property_room_type, l.num_beds, l.cancellation_policy, l.activity_included, l.activity_excluded, l.activity_pickup_included, l.vehicle_brand, l.vehicle_model, l.vehicle_year, l.vehicle_mileage, l.vehicle_condition, l.vehicle_transmission, l.vehicle_fuel_type, l.surface_m2, l.num_rooms, l.floor_number, l.furnished, l.construction_year, l.job_contract_type, l.job_remote_type, l.job_experience_level, l.job_education_level, l.job_sector, l.job_cv_url, l.is_demo, l.transaction_completed, l.created_at, l.expires_at,
                  cat.slug AS category_slug, cat.name AS category_name, cat.icon AS category_icon,
                  sub.slug AS subcategory_slug, sub.name AS subcategory_name, ci.name AS city_name, co.iso2 AS country_iso2, co.name AS country_name
           FROM saved_search_matches m
           JOIN listings l ON l.id = m.listing_id
           JOIN categories cat ON cat.id = l.category_id
           LEFT JOIN subcategories sub ON sub.id = l.subcategory_id
           JOIN cities ci ON ci.id = l.city_id
           JOIN countries co ON co.id = ci.country_id
           WHERE m.saved_search_id = ? AND l.status = 'active' AND l.expires_at > datetime('now') AND l.category_id NOT IN (SELECT category_id FROM disabled_categories) AND co.id NOT IN (SELECT country_id FROM disabled_countries)
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
}
server.listen(PORT, () => {
  console.log(`QuickAtlas Marketplace en écoute sur http://localhost:${PORT}`);
  // Les tâches périodiques tournent en dehors du cycle de requête HTTP —
  // elles n'ont donc aucun contexte de site actif par défaut. Exécutées
  // pour CHAQUE site actif du réseau (pas seulement le principal), l'une
  // après l'autre, chacune dans le contexte de sa propre base.
  function runOnAllActiveSites(taskFn) {
    const activeSites = masterDb.prepare("SELECT * FROM sites WHERE status = 'active'").all();
    for (const site of activeSites) {
      tenantContext.run(getTenantDatabase(site.db_filename), () => siteInfoContext.run(site, taskFn));
    }
  }
  runOnAllActiveSites(() => checkListingExpirations().catch((err) => console.error('[expiration] échec de la vérification initiale :', err.message)));
  setInterval(() => {
    runOnAllActiveSites(() => checkListingExpirations().catch((err) => console.error('[expiration] échec de la vérification périodique :', err.message)));
  }, 60 * 60 * 1000);
  runOnAllActiveSites(() => checkCityRequestFulfillments().catch((err) => console.error('[city-request] échec de la vérification initiale :', err.message)));
  setInterval(() => {
    runOnAllActiveSites(() => checkCityRequestFulfillments().catch((err) => console.error('[city-request] échec de la vérification périodique :', err.message)));
  }, 60 * 60 * 1000);
  // La boîte de réception est différente : elle ne tourne que pour les
  // sites ayant configuré LEURS PROPRES identifiants email (voir
  // getSiteMailConfig) — jamais de repli sur les identifiants d'un autre
  // site, ce qui mélangerait les emails de plusieurs clients entre eux.
  runOnAllActiveSites(() => checkInboxEmails().catch((err) => console.error('[inbox] échec de la synchronisation initiale :', err.message)));
  setInterval(() => {
    runOnAllActiveSites(() => checkInboxEmails().catch((err) => console.error('[inbox] échec de la synchronisation périodique :', err.message)));
  }, 10 * 60 * 1000);
  // Instantané quotidien des statistiques — n'a besoin d'aucun contexte
  // de site actif (computeSiteStats ouvre directement chaque base par
  // son nom de fichier), donc appelé sans passer par runOnAllActiveSites.
  try {
    recordDailySiteStats();
  } catch (err) {
    console.error('[daily-stats] échec de l\'enregistrement initial :', err.message);
  }
  setInterval(() => {
    try {
      recordDailySiteStats();
    } catch (err) {
      console.error('[daily-stats] échec de l\'enregistrement périodique :', err.message);
    }
  }, 24 * 60 * 60 * 1000);
  // Vérification quotidienne des périodes de grâce expirées — même
  // cadence que les statistiques, aucun contexte de site actif requis.
  try {
    checkGracePeriodExpirations();
  } catch (err) {
    console.error('[grace-period] échec de la vérification initiale :', err.message);
  }
  setInterval(() => {
    try {
      checkGracePeriodExpirations();
    } catch (err) {
      console.error('[grace-period] échec de la vérification périodique :', err.message);
    }
  }, 24 * 60 * 60 * 1000);
  // Vérification quotidienne des sites de démonstration expirés — même
  // cadence que le reste des tâches automatiques.
  try {
    checkDemoExpirations();
  } catch (err) {
    console.error('[demo-expiration] échec de la vérification initiale :', err.message);
  }
  setInterval(() => {
    try {
      checkDemoExpirations();
    } catch (err) {
      console.error('[demo-expiration] échec de la vérification périodique :', err.message);
    }
  }, 24 * 60 * 60 * 1000);
});
