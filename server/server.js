// server.js — FretConnect, serveur HTTP natif (node:http), sans Express
// ni dépendance tierce, cohérent avec le choix technique de QuickAtlas.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mainDb as db } from './db.js';
import { sendEmail, verificationEmailContent, passwordResetEmailContent } from './mailer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads', 'vehicles');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Décode une image envoyée en base64 (data URL) et l'enregistre sur
// disque, en retournant son chemin public — évite de stocker des
// chaînes base64 volumineuses directement en base de données.
// Accepte uniquement jpeg/png/webp, et limite la taille à 5 Mo par
// image pour éviter tout abus.
function saveBase64Image(dataUrl) {
  const match = /^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/.exec(dataUrl || '');
  if (!match) throw new Error('Format d\u2019image invalide — jpeg, png ou webp attendu.');
  const [, ext, base64Data] = match;
  const buffer = Buffer.from(base64Data, 'base64');
  if (buffer.length > 5 * 1024 * 1024) throw new Error('Image trop volumineuse (5 Mo maximum).');
  const filename = `${crypto.randomBytes(12).toString('hex')}.${ext === 'jpg' ? 'jpeg' : ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer);
  return `/uploads/vehicles/${filename}`;
}
function serveStatic(req, res, pathname) {
  const filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Interdit'); }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Route côté client inconnue (ex. /some/app/route) — on retombe
      // sur index.html plutôt qu'un 404, pour une future navigation
      // interne sans rechargement complet de page.
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, indexData) => {
        if (err2) { res.writeHead(404); return res.end('Introuvable'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(indexData);
      });
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const PORT = process.env.PORT || 3001;
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-a-changer-en-production';

// ---------------------------------------------------------------------------
// Utilitaires mot de passe — scrypt, comme documenté pour QuickAtlas.
// ---------------------------------------------------------------------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}
function verifyPassword(password, hash, salt) {
  const candidate = crypto.scryptSync(password, salt, 64).toString('hex');
  // Comparaison à temps constant — évite qu'un attaquant ne déduise le
  // mot de passe correct en mesurant le temps de réponse.
  return crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(hash, 'hex'));
}

// ---------------------------------------------------------------------------
// Jetons de session — signés (HMAC), sans bibliothèque JWT externe.
// Format : base64(payload).signature
// ---------------------------------------------------------------------------
function createSessionToken(userId) {
  const payload = JSON.stringify({ userId, issuedAt: Date.now() });
  const payloadB64 = Buffer.from(payload).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest('base64url');
  return `${payloadB64}.${signature}`;
}
function verifySessionToken(token) {
  if (!token || !token.includes('.')) return null;
  const [payloadB64, signature] = token.split('.');
  const expectedSignature = crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest('base64url');
  if (signature !== expectedSignature) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    return payload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Aides HTTP
// ---------------------------------------------------------------------------
function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}
function getAuthenticatedUser(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const payload = verifySessionToken(token);
  if (!payload) return null;
  return db.prepare('SELECT id, account_type, name, first_name, last_name, address, email, phone, country_id, city_id, is_transporter, email_verified FROM users WHERE id = ?').get(payload.userId);
}
function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ---------------------------------------------------------------------------
// Serveur
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const method = req.method;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (!pathname.startsWith('/api/')) {
    return serveStatic(req, res, pathname);
  }

  try {
    // ------------------------------------------------------------------
    // Inscription — expéditeur (particulier ou société)
    // ------------------------------------------------------------------
    if (pathname === '/api/auth/register' && method === 'POST') {
      const body = await readBody(req);
      const accountType = body.account_type;
      const wantsTransporter = Boolean(body.is_transporter);
      const name = (body.name || '').trim();
      const email = (body.email || '').trim().toLowerCase();
      const password = body.password || '';
      const phone = (body.phone || '').trim();

      if (!['individual', 'company'].includes(accountType)) {
        return sendJSON(res, 400, { error: 'Type de compte invalide — "individual" ou "company" attendu.' });
      }
      // Le statut (expéditeur ou transporteur) se choisit définitivement
      // à l'inscription — règle métier centrale : seul un compte
      // particulier peut être transporteur, jamais une société.
      if (wantsTransporter && accountType !== 'individual') {
        return sendJSON(res, 403, { error: 'Seul un compte particulier peut s\u2019inscrire comme transporteur — pas une société.' });
      }
      if (!name || name.length < 2) return sendJSON(res, 400, { error: 'Nom requis (2 caractères minimum).' });
      if (!isValidEmail(email)) return sendJSON(res, 400, { error: 'Adresse email invalide.' });
      if (password.length < 8) return sendJSON(res, 400, { error: 'Le mot de passe doit contenir au moins 8 caractères.' });
      if (!phone) return sendJSON(res, 400, { error: 'Numéro de téléphone requis.' });

      const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
      if (existing) return sendJSON(res, 409, { error: 'Cette adresse email est déjà utilisée.' });

      const { hash, salt } = hashPassword(password);
      const emailVerificationToken = crypto.randomBytes(32).toString('hex');
      const emailVerificationExpiresAt = new Date(Date.now() + 48 * 3600 * 1000).toISOString();

      const result = db.prepare(`
        INSERT INTO users (account_type, name, email, password_hash, password_salt, phone, country_id, city_id, is_transporter, email_verification_token, email_verification_expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(accountType, name, email, hash, salt, phone, body.country_id ?? null, body.city_id ?? null, wantsTransporter ? 1 : 0, emailVerificationToken, emailVerificationExpiresAt);

      // L'échec d'envoi de l'email ne doit jamais bloquer l'inscription
      // elle-même — sendEmail() ne lève pas d'exception, mais on
      // sécurise quand même avec un await simple, sans bloquer la
      // réponse en cas de lenteur (envoi en tâche de fond).
      const { subject, text, html } = verificationEmailContent(name, emailVerificationToken);
      sendEmail(email, subject, text, html);

      const token = createSessionToken(result.lastInsertRowid);
      return sendJSON(res, 201, {
        ok: true,
        token,
        user: { id: result.lastInsertRowid, account_type: accountType, name, email, phone, is_transporter: wantsTransporter ? 1 : 0, email_verified: 0 },
      });
    }

    // ------------------------------------------------------------------
    // Connexion
    // ------------------------------------------------------------------
    if (pathname === '/api/auth/login' && method === 'POST') {
      const body = await readBody(req);
      const email = (body.email || '').trim().toLowerCase();
      const password = body.password || '';

      const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
      if (!user) return sendJSON(res, 401, { error: 'Email ou mot de passe incorrect.' });

      // Blocage temporaire après plusieurs échecs — comme documenté pour
      // QuickAtlas (5 échecs → 15 minutes de blocage).
      if (user.locked_until && new Date(user.locked_until) > new Date()) {
        return sendJSON(res, 423, { error: 'Compte temporairement bloqué suite à plusieurs tentatives échouées. Réessayez dans quelques minutes.' });
      }

      const passwordOk = verifyPassword(password, user.password_hash, user.password_salt);
      if (!passwordOk) {
        const newFailedCount = user.failed_login_count + 1;
        const lockedUntil = newFailedCount >= 5 ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null;
        db.prepare('UPDATE users SET failed_login_count = ?, locked_until = ? WHERE id = ?').run(newFailedCount, lockedUntil, user.id);
        return sendJSON(res, 401, { error: 'Email ou mot de passe incorrect.' });
      }

      db.prepare('UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = ?').run(user.id);
      const token = createSessionToken(user.id);
      return sendJSON(res, 200, {
        ok: true,
        token,
        user: {
          id: user.id, account_type: user.account_type, name: user.name, email: user.email,
          phone: user.phone, is_transporter: user.is_transporter, email_verified: user.email_verified,
        },
      });
    }

    // ------------------------------------------------------------------
    // Utilisateur courant
    // ------------------------------------------------------------------
    if (pathname === '/api/auth/me' && method === 'GET') {
      const user = getAuthenticatedUser(req);
      if (!user) return sendJSON(res, 401, { error: 'Non connecté.' });
      return sendJSON(res, 200, { user });
    }

    // ------------------------------------------------------------------
    // Véhicules — réservé aux comptes transporteur (is_transporter = 1).
    // ------------------------------------------------------------------
    if (pathname === '/api/vehicles' && method === 'POST') {
      const user = getAuthenticatedUser(req);
      if (!user) return sendJSON(res, 401, { error: 'Connexion requise.' });
      if (!user.is_transporter) return sendJSON(res, 403, { error: 'Réservé aux comptes transporteur.' });

      const body = await readBody(req);
      const vehicleType = (body.vehicle_type || '').trim();
      if (!vehicleType) return sendJSON(res, 400, { error: 'Le type de véhicule est requis (ex. fourgon, camion, pick-up).' });
      const weightCapacity = body.weight_capacity_kg != null ? Number(body.weight_capacity_kg) : null;
      if (weightCapacity != null && (isNaN(weightCapacity) || weightCapacity <= 0)) {
        return sendJSON(res, 400, { error: 'La capacité en poids doit être un nombre positif.' });
      }

      // Les photos arrivent en base64 (data URL) depuis le formulaire —
      // on les enregistre sur disque plutôt que de stocker le texte
      // brut, volumineux, directement en base de données.
      let photoUrls = [];
      try {
        photoUrls = (body.photos || []).map(saveBase64Image);
      } catch (err) {
        return sendJSON(res, 400, { error: err.message });
      }

      const result = db.prepare(`
        INSERT INTO vehicles (user_id, vehicle_type, brand, model, license_plate, weight_capacity_kg, volume_capacity_m3, length_cm, width_cm, height_cm, photos_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        user.id, vehicleType, body.brand ?? null, body.model ?? null, body.license_plate ?? null,
        weightCapacity, body.volume_capacity_m3 ?? null, body.length_cm ?? null, body.width_cm ?? null, body.height_cm ?? null,
        JSON.stringify(photoUrls)
      );
      const vehicle = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(result.lastInsertRowid);
      return sendJSON(res, 201, { ok: true, vehicle });
    }

    if (pathname === '/api/vehicles/mine' && method === 'GET') {
      const user = getAuthenticatedUser(req);
      if (!user) return sendJSON(res, 401, { error: 'Connexion requise.' });
      const vehicles = db.prepare('SELECT * FROM vehicles WHERE user_id = ? AND is_active = 1 ORDER BY created_at DESC').all(user.id);
      return sendJSON(res, 200, { vehicles });
    }

    {
      const vehicleMatch = pathname.match(/^\/api\/vehicles\/(\d+)$/);
      if (vehicleMatch && (method === 'PUT' || method === 'DELETE')) {
        const user = getAuthenticatedUser(req);
        if (!user) return sendJSON(res, 401, { error: 'Connexion requise.' });
        const vehicleId = Number(vehicleMatch[1]);
        const vehicle = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(vehicleId);
        if (!vehicle) return sendJSON(res, 404, { error: 'Véhicule introuvable.' });
        if (vehicle.user_id !== user.id) return sendJSON(res, 403, { error: "Ce véhicule ne vous appartient pas." });

        if (method === 'DELETE') {
          // Désactivation plutôt que suppression — garde l'historique des
          // trajets/offres déjà associés à ce véhicule intact.
          db.prepare('UPDATE vehicles SET is_active = 0 WHERE id = ?').run(vehicleId);
          return sendJSON(res, 200, { ok: true });
        }

        const body = await readBody(req);
        const fields = ['vehicle_type', 'brand', 'model', 'license_plate', 'weight_capacity_kg', 'volume_capacity_m3', 'length_cm', 'width_cm', 'height_cm'];
        const updates = [];
        const values = [];
        for (const field of fields) {
          if (body[field] !== undefined) { updates.push(`${field} = ?`); values.push(body[field]); }
        }
        if (body.photos !== undefined) { updates.push('photos_json = ?'); values.push(JSON.stringify(body.photos)); }
        if (updates.length === 0) return sendJSON(res, 400, { error: 'Aucun champ à mettre à jour.' });
        values.push(vehicleId);
        db.prepare(`UPDATE vehicles SET ${updates.join(', ')} WHERE id = ?`).run(...values);
        const updated = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(vehicleId);
        return sendJSON(res, 200, { ok: true, vehicle: updated });
      }
    }

    // ------------------------------------------------------------------
    // Vérification du transporteur — un seul enregistrement par
    // transporteur (upsert). Statut de vérification lui-même
    // (identity_verified, etc.) réservé à un futur panneau
    // d'administration — non modifiable par le transporteur lui-même ici.
    // ------------------------------------------------------------------
    if (pathname === '/api/transporter/verification' && method === 'POST') {
      const user = getAuthenticatedUser(req);
      if (!user) return sendJSON(res, 401, { error: 'Connexion requise.' });
      if (!user.is_transporter) return sendJSON(res, 403, { error: 'Réservé aux comptes transporteur.' });

      const body = await readBody(req);
      const existing = db.prepare('SELECT id FROM transporter_verifications WHERE user_id = ?').get(user.id);
      if (existing) {
        db.prepare(`
          UPDATE transporter_verifications SET
            identity_document_url = COALESCE(?, identity_document_url),
            license_category = COALESCE(?, license_category),
            license_document_url = COALESCE(?, license_document_url),
            license_expiry_date = COALESCE(?, license_expiry_date),
            insurance_company = COALESCE(?, insurance_company),
            insurance_policy_number = COALESCE(?, insurance_policy_number),
            insurance_coverage_type = COALESCE(?, insurance_coverage_type),
            insurance_expiry_date = COALESCE(?, insurance_expiry_date),
            insurance_document_url = COALESCE(?, insurance_document_url),
            updated_at = datetime('now')
          WHERE user_id = ?
        `).run(
          body.identity_document_url ?? null, body.license_category ?? null, body.license_document_url ?? null, body.license_expiry_date ?? null,
          body.insurance_company ?? null, body.insurance_policy_number ?? null, body.insurance_coverage_type ?? null, body.insurance_expiry_date ?? null, body.insurance_document_url ?? null,
          user.id
        );
      } else {
        db.prepare(`
          INSERT INTO transporter_verifications (user_id, identity_document_url, license_category, license_document_url, license_expiry_date, insurance_company, insurance_policy_number, insurance_coverage_type, insurance_expiry_date, insurance_document_url)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          user.id, body.identity_document_url ?? null, body.license_category ?? null, body.license_document_url ?? null, body.license_expiry_date ?? null,
          body.insurance_company ?? null, body.insurance_policy_number ?? null, body.insurance_coverage_type ?? null, body.insurance_expiry_date ?? null, body.insurance_document_url ?? null
        );
      }
      const verification = db.prepare('SELECT * FROM transporter_verifications WHERE user_id = ?').get(user.id);
      return sendJSON(res, 200, { ok: true, verification });
    }

    if (pathname === '/api/transporter/verification' && method === 'GET') {
      const user = getAuthenticatedUser(req);
      if (!user) return sendJSON(res, 401, { error: 'Connexion requise.' });
      const verification = db.prepare('SELECT * FROM transporter_verifications WHERE user_id = ?').get(user.id);
      return sendJSON(res, 200, { verification: verification || null });
    }

    // ------------------------------------------------------------------
    // Équipe de manutention — un seul enregistrement par transporteur
    // (upsert), optionnel.
    // ------------------------------------------------------------------
    if (pathname === '/api/transporter/handling-team' && method === 'POST') {
      const user = getAuthenticatedUser(req);
      if (!user) return sendJSON(res, 401, { error: 'Connexion requise.' });
      if (!user.is_transporter) return sendJSON(res, 403, { error: 'Réservé aux comptes transporteur.' });

      const body = await readBody(req);
      const teamSize = body.team_size;
      if (!['solo', 'plus_1', 'plus_2', 'plus_3_or_more'].includes(teamSize)) {
        return sendJSON(res, 400, { error: 'team_size invalide — attendu : solo, plus_1, plus_2 ou plus_3_or_more.' });
      }
      const existing = db.prepare('SELECT id FROM handling_teams WHERE user_id = ?').get(user.id);
      if (existing) {
        db.prepare('UPDATE handling_teams SET team_size = ?, helpers_count = ?, price_notes = ?, equipment_available = ?, max_floors_accepted = ?, notes = ? WHERE user_id = ?')
          .run(teamSize, body.helpers_count ?? null, body.price_notes ?? null, body.equipment_available ?? null, body.max_floors_accepted ?? null, body.notes ?? null, user.id);
      } else {
        db.prepare('INSERT INTO handling_teams (user_id, team_size, helpers_count, price_notes, equipment_available, max_floors_accepted, notes) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(user.id, teamSize, body.helpers_count ?? null, body.price_notes ?? null, body.equipment_available ?? null, body.max_floors_accepted ?? null, body.notes ?? null);
      }
      const team = db.prepare('SELECT * FROM handling_teams WHERE user_id = ?').get(user.id);
      return sendJSON(res, 200, { ok: true, handling_team: team });
    }

    // ------------------------------------------------------------------
    // Profil transporteur complet — résumé pratique combinant
    // véhicules, vérification et équipe de manutention en un seul appel.
    // ------------------------------------------------------------------
    if (pathname === '/api/transporter/profile' && method === 'GET') {
      const user = getAuthenticatedUser(req);
      if (!user) return sendJSON(res, 401, { error: 'Connexion requise.' });
      if (!user.is_transporter) return sendJSON(res, 403, { error: 'Réservé aux comptes transporteur.' });

      const vehicles = db.prepare('SELECT * FROM vehicles WHERE user_id = ? AND is_active = 1').all(user.id);
      const verification = db.prepare('SELECT * FROM transporter_verifications WHERE user_id = ?').get(user.id) || null;
      const handlingTeam = db.prepare('SELECT * FROM handling_teams WHERE user_id = ?').get(user.id) || null;
      return sendJSON(res, 200, { user, vehicles, verification, handling_team: handlingTeam });
    }

    // ------------------------------------------------------------------
    // Demandes de transport (marchandises) — n'importe quel compte
    // (particulier ou société) peut publier une demande, y compris un
    // compte transporteur agissant ponctuellement comme expéditeur.
    // ------------------------------------------------------------------
    if (pathname === '/api/shipments' && method === 'POST') {
      const user = getAuthenticatedUser(req);
      if (!user) return sendJSON(res, 401, { error: 'Connexion requise.' });

      const body = await readBody(req);
      const title = (body.title || '').trim();
      const pickupAddress = (body.pickup_address || '').trim();
      const dropoffAddress = (body.dropoff_address || '').trim();
      if (!title) return sendJSON(res, 400, { error: 'Un titre est requis pour décrire la marchandise.' });
      if (!pickupAddress) return sendJSON(res, 400, { error: "L'adresse d'enlèvement est requise." });
      if (!dropoffAddress) return sendJSON(res, 400, { error: "L'adresse de livraison est requise." });

      const result = db.prepare(`
        INSERT INTO shipment_requests (
          shipper_id, title, description, cargo_type, weight_kg, volume_m3, length_cm, width_cm, height_cm, photos_json, fragile,
          pickup_address, pickup_city_id, pickup_lat, pickup_lng, pickup_floor, pickup_has_elevator, pickup_access_notes, pickup_helpers_available,
          dropoff_address, dropoff_city_id, dropoff_lat, dropoff_lng, dropoff_floor, dropoff_has_elevator, dropoff_access_notes, dropoff_helpers_available,
          pickup_date, pickup_time_start, pickup_time_end, delivery_date, suggested_price, suggested_price_currency
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        user.id, title, body.description ?? null, body.cargo_type ?? null, body.weight_kg ?? null, body.volume_m3 ?? null,
        body.length_cm ?? null, body.width_cm ?? null, body.height_cm ?? null, JSON.stringify(body.photos || []), body.fragile ? 1 : 0,
        pickupAddress, body.pickup_city_id ?? null, body.pickup_lat ?? null, body.pickup_lng ?? null, body.pickup_floor ?? null,
        body.pickup_has_elevator ? 1 : 0, body.pickup_access_notes ?? null, body.pickup_helpers_available ?? null,
        dropoffAddress, body.dropoff_city_id ?? null, body.dropoff_lat ?? null, body.dropoff_lng ?? null, body.dropoff_floor ?? null,
        body.dropoff_has_elevator ? 1 : 0, body.dropoff_access_notes ?? null, body.dropoff_helpers_available ?? null,
        body.pickup_date ?? null, body.pickup_time_start ?? null, body.pickup_time_end ?? null, body.delivery_date ?? null,
        body.suggested_price ?? null, body.suggested_price_currency || 'MAD'
      );
      const shipment = db.prepare('SELECT * FROM shipment_requests WHERE id = ?').get(result.lastInsertRowid);
      return sendJSON(res, 201, { ok: true, shipment });
    }

    // Liste des demandes ouvertes — le "tableau de bord" que les
    // transporteurs consultent pour trouver du fret (section 4 : "voir
    // les marchandises disponibles").
    if (pathname === '/api/shipments' && method === 'GET') {
      const shipments = db.prepare("SELECT * FROM shipment_requests WHERE status = 'open' ORDER BY created_at DESC LIMIT 100").all();
      return sendJSON(res, 200, { shipments });
    }

    if (pathname === '/api/shipments/mine' && method === 'GET') {
      const user = getAuthenticatedUser(req);
      if (!user) return sendJSON(res, 401, { error: 'Connexion requise.' });
      const shipments = db.prepare('SELECT * FROM shipment_requests WHERE shipper_id = ? ORDER BY created_at DESC').all(user.id);
      return sendJSON(res, 200, { shipments });
    }

    {
      const shipmentMatch = pathname.match(/^\/api\/shipments\/(\d+)$/);
      if (shipmentMatch && method === 'GET') {
        const shipment = db.prepare('SELECT * FROM shipment_requests WHERE id = ?').get(Number(shipmentMatch[1]));
        if (!shipment) return sendJSON(res, 404, { error: 'Demande introuvable.' });
        return sendJSON(res, 200, { shipment });
      }
    }

    // ------------------------------------------------------------------
    // Offres — un transporteur propose un prix sur une demande ouverte.
    // ------------------------------------------------------------------
    {
      const offerMatch = pathname.match(/^\/api\/shipments\/(\d+)\/offers$/);
      if (offerMatch && method === 'POST') {
        const user = getAuthenticatedUser(req);
        if (!user) return sendJSON(res, 401, { error: 'Connexion requise.' });
        if (!user.is_transporter) return sendJSON(res, 403, { error: 'Seul un transporteur peut faire une offre.' });

        const shipmentId = Number(offerMatch[1]);
        const shipment = db.prepare('SELECT * FROM shipment_requests WHERE id = ?').get(shipmentId);
        if (!shipment) return sendJSON(res, 404, { error: 'Demande introuvable.' });
        if (shipment.status !== 'open') return sendJSON(res, 400, { error: "Cette demande n'est plus ouverte aux offres." });

        const body = await readBody(req);
        const price = Number(body.proposed_price);
        if (isNaN(price) || price <= 0) return sendJSON(res, 400, { error: 'Le prix proposé doit être un nombre positif.' });

        const result = db.prepare(`
          INSERT INTO offers (shipment_request_id, transporter_id, proposed_price, currency, proposed_by, message)
          VALUES (?, ?, ?, ?, 'transporter', ?)
        `).run(shipmentId, user.id, price, body.currency || shipment.suggested_price_currency || 'MAD', body.message ?? null);
        const offer = db.prepare('SELECT * FROM offers WHERE id = ?').get(result.lastInsertRowid);
        return sendJSON(res, 201, { ok: true, offer });
      }

      if (offerMatch && method === 'GET') {
        const user = getAuthenticatedUser(req);
        if (!user) return sendJSON(res, 401, { error: 'Connexion requise.' });
        const shipmentId = Number(offerMatch[1]);
        const shipment = db.prepare('SELECT * FROM shipment_requests WHERE id = ?').get(shipmentId);
        if (!shipment) return sendJSON(res, 404, { error: 'Demande introuvable.' });

        // L'expéditeur voit toutes les offres reçues ; un transporteur ne
        // voit que la sienne — jamais les offres concurrentes des autres.
        const offers = shipment.shipper_id === user.id
          ? db.prepare('SELECT * FROM offers WHERE shipment_request_id = ? ORDER BY created_at DESC').all(shipmentId)
          : db.prepare('SELECT * FROM offers WHERE shipment_request_id = ? AND transporter_id = ? ORDER BY created_at DESC').all(shipmentId, user.id);
        return sendJSON(res, 200, { offers });
      }
    }

    {
      const counterMatch = pathname.match(/^\/api\/offers\/(\d+)\/counter$/);
      if (counterMatch && method === 'POST') {
        const user = getAuthenticatedUser(req);
        if (!user) return sendJSON(res, 401, { error: 'Connexion requise.' });
        const offerId = Number(counterMatch[1]);
        const offer = db.prepare('SELECT * FROM offers WHERE id = ?').get(offerId);
        if (!offer) return sendJSON(res, 404, { error: 'Offre introuvable.' });
        const shipment = db.prepare('SELECT * FROM shipment_requests WHERE id = ?').get(offer.shipment_request_id);

        const isShipper = shipment.shipper_id === user.id;
        const isTransporter = offer.transporter_id === user.id;
        if (!isShipper && !isTransporter) return sendJSON(res, 403, { error: "Vous n'êtes pas partie à cette négociation." });

        const body = await readBody(req);
        const price = Number(body.proposed_price);
        if (isNaN(price) || price <= 0) return sendJSON(res, 400, { error: 'Le prix proposé doit être un nombre positif.' });

        db.prepare("UPDATE offers SET status = 'countered' WHERE id = ?").run(offerId);
        const result = db.prepare(`
          INSERT INTO offers (shipment_request_id, transporter_id, proposed_price, currency, proposed_by, parent_offer_id, message)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(offer.shipment_request_id, offer.transporter_id, price, offer.currency, isShipper ? 'shipper' : 'transporter', offerId, body.message ?? null);
        const newOffer = db.prepare('SELECT * FROM offers WHERE id = ?').get(result.lastInsertRowid);
        return sendJSON(res, 201, { ok: true, offer: newOffer });
      }
    }

    {
      const acceptMatch = pathname.match(/^\/api\/offers\/(\d+)\/accept$/);
      if (acceptMatch && method === 'POST') {
        const user = getAuthenticatedUser(req);
        if (!user) return sendJSON(res, 401, { error: 'Connexion requise.' });
        const offerId = Number(acceptMatch[1]);
        const offer = db.prepare('SELECT * FROM offers WHERE id = ?').get(offerId);
        if (!offer) return sendJSON(res, 404, { error: 'Offre introuvable.' });
        const shipment = db.prepare('SELECT * FROM shipment_requests WHERE id = ?').get(offer.shipment_request_id);

        // Seule la partie qui N'A PAS fait la dernière proposition peut
        // l'accepter — on n'accepte pas sa propre offre.
        const isShipper = shipment.shipper_id === user.id;
        const isTransporter = offer.transporter_id === user.id;
        if (!isShipper && !isTransporter) return sendJSON(res, 403, { error: "Vous n'êtes pas partie à cette négociation." });
        if ((offer.proposed_by === 'shipper' && !isTransporter) || (offer.proposed_by === 'transporter' && !isShipper)) {
          return sendJSON(res, 400, { error: 'Vous ne pouvez pas accepter votre propre proposition.' });
        }
        if (offer.status !== 'pending') return sendJSON(res, 400, { error: 'Cette offre n\u2019est plus en attente (déjà traitée).' });

        db.prepare("UPDATE offers SET status = 'accepted' WHERE id = ?").run(offerId);
        // Toute autre offre en attente sur cette même demande devient
        // caduque — un seul transporteur peut être retenu.
        db.prepare("UPDATE offers SET status = 'rejected' WHERE shipment_request_id = ? AND id != ? AND status = 'pending'").run(offer.shipment_request_id, offerId);
        db.prepare("UPDATE shipment_requests SET status = 'matched', accepted_offer_id = ? WHERE id = ?").run(offerId, offer.shipment_request_id);

        const updatedShipment = db.prepare('SELECT * FROM shipment_requests WHERE id = ?').get(offer.shipment_request_id);
        return sendJSON(res, 200, { ok: true, shipment: updatedShipment });
      }
    }

    {
      const rejectMatch = pathname.match(/^\/api\/offers\/(\d+)\/reject$/);
      if (rejectMatch && method === 'POST') {
        const user = getAuthenticatedUser(req);
        if (!user) return sendJSON(res, 401, { error: 'Connexion requise.' });
        const offerId = Number(rejectMatch[1]);
        const offer = db.prepare('SELECT * FROM offers WHERE id = ?').get(offerId);
        if (!offer) return sendJSON(res, 404, { error: 'Offre introuvable.' });
        const shipment = db.prepare('SELECT * FROM shipment_requests WHERE id = ?').get(offer.shipment_request_id);

        const isShipper = shipment.shipper_id === user.id;
        const isTransporter = offer.transporter_id === user.id;
        if (!isShipper && !isTransporter) return sendJSON(res, 403, { error: "Vous n'êtes pas partie à cette négociation." });
        if (offer.status !== 'pending') return sendJSON(res, 400, { error: 'Cette offre n\u2019est plus en attente.' });

        db.prepare("UPDATE offers SET status = 'rejected' WHERE id = ?").run(offerId);
        return sendJSON(res, 200, { ok: true });
      }
    }

    // ------------------------------------------------------------------
    // Géographie — routes publiques (pas d'authentification requise),
    // utilisées par la carte interactive pour peupler la navigation.
    // ------------------------------------------------------------------
    if (pathname === '/api/countries' && method === 'GET') {
      const countries = db.prepare('SELECT * FROM countries ORDER BY name').all();
      return sendJSON(res, 200, { countries });
    }

    {
      const citiesMatch = pathname.match(/^\/api\/countries\/(\d+)\/cities$/);
      if (citiesMatch && method === 'GET') {
        const countryId = Number(citiesMatch[1]);
        const country = db.prepare('SELECT * FROM countries WHERE id = ?').get(countryId);
        if (!country) return sendJSON(res, 404, { error: 'Pays introuvable.' });
        const cities = db.prepare('SELECT * FROM cities WHERE country_id = ? ORDER BY name').all(countryId);
        return sendJSON(res, 200, { country, cities });
      }
    }

    // ------------------------------------------------------------------
    // Vérification d'email
    // ------------------------------------------------------------------
    if (pathname === '/api/auth/verify-email' && method === 'POST') {
      const body = await readBody(req);
      const providedToken = body.token;
      if (!providedToken) return sendJSON(res, 400, { error: 'Jeton de vérification manquant.' });

      const user = db.prepare('SELECT * FROM users WHERE email_verification_token = ?').get(providedToken);
      if (!user) return sendJSON(res, 400, { error: 'Lien de vérification invalide.' });
      if (user.email_verified) return sendJSON(res, 200, { ok: true, already_verified: true });
      if (new Date(user.email_verification_expires_at) < new Date()) {
        return sendJSON(res, 400, { error: 'Ce lien de vérification a expiré — demandez-en un nouveau.' });
      }

      // Le jeton est volontairement conservé (pas remis à NULL) — si
      // l'utilisateur clique une seconde fois sur le même lien, la
      // branche "already_verified" ci-dessus le détecte proprement,
      // plutôt que de répondre à tort "lien invalide".
      db.prepare('UPDATE users SET email_verified = 1, email_verification_expires_at = NULL WHERE id = ?').run(user.id);
      return sendJSON(res, 200, { ok: true });
    }

    if (pathname === '/api/auth/resend-verification' && method === 'POST') {
      const user = getAuthenticatedUser(req);
      if (!user) return sendJSON(res, 401, { error: 'Connexion requise.' });
      if (user.email_verified) return sendJSON(res, 400, { error: 'Cette adresse est déjà vérifiée.' });

      const newToken = crypto.randomBytes(32).toString('hex');
      const newExpiry = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
      db.prepare('UPDATE users SET email_verification_token = ?, email_verification_expires_at = ? WHERE id = ?').run(newToken, newExpiry, user.id);

      const { subject, text, html } = verificationEmailContent(user.name, newToken);
      sendEmail(user.email, subject, text, html);
      return sendJSON(res, 200, { ok: true });
    }

    // ------------------------------------------------------------------
    // Mot de passe oublié / réinitialisation — jeton à usage unique,
    // valable 1h, comme documenté pour QuickAtlas.
    // ------------------------------------------------------------------
    if (pathname === '/api/auth/forgot-password' && method === 'POST') {
      const body = await readBody(req);
      const email = (body.email || '').trim().toLowerCase();
      const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

      // Toujours répondre pareil, que l'email existe ou non — évite de
      // révéler à un tiers quelles adresses sont inscrites sur le site.
      if (user) {
        const resetToken = crypto.randomBytes(32).toString('hex');
        const resetExpiry = new Date(Date.now() + 3600 * 1000).toISOString();
        db.prepare('UPDATE users SET password_reset_token = ?, password_reset_expires_at = ? WHERE id = ?').run(resetToken, resetExpiry, user.id);
        const { subject, text, html } = passwordResetEmailContent(user.name, resetToken);
        sendEmail(user.email, subject, text, html);
      }
      return sendJSON(res, 200, { ok: true, message: 'Si cette adresse existe, un email de réinitialisation vient de lui être envoyé.' });
    }

    if (pathname === '/api/auth/reset-password' && method === 'POST') {
      const body = await readBody(req);
      const providedToken = body.token;
      const newPassword = body.new_password || '';
      if (!providedToken) return sendJSON(res, 400, { error: 'Jeton de réinitialisation manquant.' });
      if (newPassword.length < 8) return sendJSON(res, 400, { error: 'Le nouveau mot de passe doit contenir au moins 8 caractères.' });

      const user = db.prepare('SELECT * FROM users WHERE password_reset_token = ?').get(providedToken);
      if (!user) return sendJSON(res, 400, { error: 'Lien de réinitialisation invalide.' });
      if (new Date(user.password_reset_expires_at) < new Date()) {
        return sendJSON(res, 400, { error: 'Ce lien de réinitialisation a expiré — refaites une demande.' });
      }

      const { hash, salt } = hashPassword(newPassword);
      // Jeton à usage unique — vidé immédiatement après utilisation, et
      // le compte est débloqué au passage (cas où trop d'échecs de
      // connexion l'auraient temporairement verrouillé).
      db.prepare('UPDATE users SET password_hash = ?, password_salt = ?, password_reset_token = NULL, password_reset_expires_at = NULL, failed_login_count = 0, locked_until = NULL WHERE id = ?').run(hash, salt, user.id);
      return sendJSON(res, 200, { ok: true });
    }

    // ------------------------------------------------------------------
    // Mes offres (transporteur) — toutes les offres faites par
    // l'utilisateur, tous chantiers confondus, avec le contexte de la
    // demande associée. Utile pour le tableau de bord transporteur.
    // ------------------------------------------------------------------
    if (pathname === '/api/offers/mine' && method === 'GET') {
      const user = getAuthenticatedUser(req);
      if (!user) return sendJSON(res, 401, { error: 'Connexion requise.' });
      const offers = db.prepare(`
        SELECT o.*, s.title AS shipment_title, s.pickup_address, s.dropoff_address, s.status AS shipment_status
        FROM offers o
        JOIN shipment_requests s ON s.id = o.shipment_request_id
        WHERE o.transporter_id = ?
        ORDER BY o.created_at DESC
      `).all(user.id);
      return sendJSON(res, 200, { offers });
    }

    // ------------------------------------------------------------------
    // Profil complet — prénom, nom, adresse principale, etc. Pensé pour
    // être rempli une seule fois puis réutilisé (ex. adresse
    // d'enlèvement par défaut lors de la publication d'une demande).
    // ------------------------------------------------------------------
    if (pathname === '/api/profile' && method === 'PUT') {
      const user = getAuthenticatedUser(req);
      if (!user) return sendJSON(res, 401, { error: 'Connexion requise.' });

      const body = await readBody(req);
      const fields = ['first_name', 'last_name', 'address', 'phone', 'country_id', 'city_id'];
      const updates = [];
      const values = [];
      for (const field of fields) {
        if (body[field] !== undefined) { updates.push(`${field} = ?`); values.push(body[field] || null); }
      }
      // Le nom d'affichage général reste synchronisé avec prénom + nom,
      // pour un compte particulier — une société garde son nom tel quel.
      if (user.account_type === 'individual' && (body.first_name !== undefined || body.last_name !== undefined)) {
        const firstName = body.first_name !== undefined ? body.first_name : user.first_name;
        const lastName = body.last_name !== undefined ? body.last_name : user.last_name;
        const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();
        if (fullName) { updates.push('name = ?'); values.push(fullName); }
      }
      if (updates.length === 0) return sendJSON(res, 400, { error: 'Aucun champ à mettre à jour.' });
      values.push(user.id);
      db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);

      const updated = db.prepare('SELECT id, account_type, name, first_name, last_name, address, email, phone, country_id, city_id, is_transporter, email_verified FROM users WHERE id = ?').get(user.id);
      return sendJSON(res, 200, { ok: true, user: updated });
    }

    // ------------------------------------------------------------------
    // Valider une demande (brouillon → ouverte) — c'est seulement à ce
    // moment-là qu'elle devient visible des transporteurs dans
    // "Demandes disponibles". Réservé au propriétaire de la demande.
    // ------------------------------------------------------------------
    {
      const validateMatch = pathname.match(/^\/api\/shipments\/(\d+)\/validate$/);
      if (validateMatch && method === 'POST') {
        const user = getAuthenticatedUser(req);
        if (!user) return sendJSON(res, 401, { error: 'Connexion requise.' });
        const shipmentId = Number(validateMatch[1]);
        const shipment = db.prepare('SELECT * FROM shipment_requests WHERE id = ?').get(shipmentId);
        if (!shipment) return sendJSON(res, 404, { error: 'Demande introuvable.' });
        if (shipment.shipper_id !== user.id) return sendJSON(res, 403, { error: 'Cette demande ne vous appartient pas.' });
        if (shipment.status !== 'draft') return sendJSON(res, 400, { error: 'Cette demande a déjà été validée ou n\u2019est plus modifiable.' });

        db.prepare("UPDATE shipment_requests SET status = 'open' WHERE id = ?").run(shipmentId);
        const updated = db.prepare('SELECT * FROM shipment_requests WHERE id = ?').get(shipmentId);
        return sendJSON(res, 200, { ok: true, shipment: updated });
      }
    }

    return sendJSON(res, 404, { error: 'Route introuvable.' });
  } catch (err) {
    console.error(err);
    return sendJSON(res, 500, { error: 'Erreur serveur.' });
  }
});

server.listen(PORT, () => {
  console.log(`FretConnect — serveur démarré sur http://localhost:${PORT}`);
  console.log(`📁 Fichiers statiques servis depuis : ${PUBLIC_DIR}`);
});
