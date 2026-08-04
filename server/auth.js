// auth.js — Hachage de mot de passe (scrypt) et tokens signés type JWT,
// entièrement basés sur le module natif node:crypto.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRET_PATH = path.join(__dirname, '..', 'data', '.secret');

function getSecret() {
  if (!fs.existsSync(SECRET_PATH)) {
    const secret = crypto.randomBytes(48).toString('hex');
    fs.mkdirSync(path.dirname(SECRET_PATH), { recursive: true });
    fs.writeFileSync(SECRET_PATH, secret, { mode: 0o600 });
    return secret;
  }
  return fs.readFileSync(SECRET_PATH, 'utf8');
}

const SECRET = getSecret();

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, salt, hash) {
  const attempt = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(attempt, 'hex'), Buffer.from(hash, 'hex'));
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

export function signToken(payload, expiresInSeconds = 60 * 60 * 24 * 7) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + expiresInSeconds };
  const headerPart = base64url(JSON.stringify(header));
  const bodyPart = base64url(JSON.stringify(body));
  const signature = crypto
    .createHmac('sha256', SECRET)
    .update(`${headerPart}.${bodyPart}`)
    .digest('base64url');
  return `${headerPart}.${bodyPart}.${signature}`;
}

export function verifyToken(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerPart, bodyPart, signature] = parts;
  const expected = crypto
    .createHmac('sha256', SECRET)
    .update(`${headerPart}.${bodyPart}`)
    .digest('base64url');
  if (signature !== expected) return null;
  try {
    const payload = JSON.parse(Buffer.from(bodyPart, 'base64url').toString('utf8'));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---------- Tokens à usage unique (vérification email, réinitialisation mot de passe) ----------
// On génère un token aléatoire envoyé par email ; seul son hash est stocké en base,
// pour qu'une fuite de la base de données ne permette pas de rejouer les liens.

export function generateRawToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashRawToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

// ---------- Chiffrement des clés API personnelles (IA) ----------
// Contrairement aux mots de passe (hachage à sens unique), une clé API doit
// pouvoir être relue par le serveur pour appeler le fournisseur d'IA au nom
// de l'utilisateur : on utilise donc un chiffrement réversible (AES-256-GCM),
// avec une clé dérivée du même secret que celui qui signe les sessions
// (data/.secret), jamais stockée en clair dans la base de données.

const AI_KEY_ENCRYPTION_KEY = crypto.scryptSync(SECRET, 'atlas-ai-key-encryption', 32);

export function encryptApiKey(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', AI_KEY_ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

export function decryptApiKey(encoded) {
  const data = Buffer.from(encoded, 'base64');
  const iv = data.subarray(0, 12);
  const authTag = data.subarray(12, 28);
  const encrypted = data.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', AI_KEY_ENCRYPTION_KEY, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

// ---------- Solidité du mot de passe ----------
// Règles minimales : au moins 8 caractères, une lettre et un chiffre.
export function passwordIssues(password) {
  const issues = [];
  if (!password || password.length < 8) issues.push('length');
  if (!/[a-zA-ZÀ-ÿ]/.test(password || '')) issues.push('letter');
  if (!/[0-9]/.test(password || '')) issues.push('digit');
  return issues;
}

export function passwordStrengthScore(password) {
  if (!password) return 0;
  let score = 0;
  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
  if (/[0-9]/.test(password)) score++;
  if (/[^a-zA-Z0-9]/.test(password)) score++;
  return Math.min(score, 4); // 0 à 4
}
