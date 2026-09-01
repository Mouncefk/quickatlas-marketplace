// mailer.js — Envoi d'email en SMTP minimal (aucune dépendance externe),
// avec repli automatique : si aucun serveur SMTP n'est configuré (ou si
// l'envoi échoue), l'email est simplement consigné dans la table
// `email_outbox`, consultable depuis le panneau Administration → Emails.
//
// Réseau multi-site : sendMail() accepte un paramètre optionnel smtpConfig
// { host, port, user, pass, mailFrom, fromName } — quand un site a
// configuré ses propres identifiants email (voir getSiteMailConfig() dans
// server.js), ils sont utilisés à la place des variables d'environnement
// globales. Sans smtpConfig fourni, comportement inchangé : lecture des
// variables d'environnement globales (SMTP_HOST, SMTP_PORT, SMTP_USER,
// SMTP_PASS, MAIL_FROM), exactement comme avant l'existence du réseau
// multi-site — c'est ce qui alimente le site principal.
//
// Important : ce client SMTP est volontairement simple (connexion TLS
// directe, type "SMTPS" sur le port 465, comme Gmail/la plupart des
// fournisseurs). Il n'a pas pu être testé contre un vrai serveur dans cet
// environnement de développement (pas d'accès réseau sortant) : vérifiez
// qu'un email arrive bien chez vous après configuration, et signalez tout
// souci — un remplacement par un paquet comme `nodemailer` reste possible
// si besoin.
import tls from 'node:tls';
import crypto from 'node:crypto';
import { db } from './db.js';

function b64(str) {
  return Buffer.from(str, 'utf8').toString('base64');
}

function smtpCommand(socket, command, expectedCodes = ['2', '3']) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      // Une réponse SMTP complète se termine par "CODE ceci\r\n" (espace, pas tiret)
      const lines = buffer.split('\r\n').filter(Boolean);
      const last = lines[lines.length - 1] || '';
      if (/^\d{3} /.test(last)) {
        socket.removeListener('data', onData);
        const code = buffer.slice(0, 1);
        if (expectedCodes.includes(code)) resolve(buffer);
        else reject(new Error(`Réponse SMTP inattendue : ${buffer.trim()}`));
      }
    };
    socket.on('data', onData);
    if (command !== null) socket.write(command + '\r\n');
  });
}

/** Échappe les lignes commençant par un point seul (règle SMTP dite du
 * "dot-stuffing"), sans quoi une ligne ainsi formée serait interprétée à
 * tort comme la fin du message par le serveur. */
function dotStuff(body) {
  return body.split('\r\n').map((line) => (line.startsWith('.') ? '.' + line : line)).join('\r\n');
}

/** Construit le corps MIME complet du message — texte simple si aucune
 * pièce jointe, ou multipart/mixed (texte + pièces jointes en base64)
 * sinon. `attachments` : [{ filename, mimeType, content (Buffer) }].
 * `fromName` : nom affiché dans l'en-tête From (le nom de marque du site
 * qui envoie, plutôt que "QuickAtlas" en dur — chaque site du réseau
 * envoie sous son propre nom). */
function buildMimeMessage({ from, fromName, to, subject, text, html, attachments, unsubscribeMailto }) {
  // Ces trois en-têtes sont attendus par pratiquement tous les clients
  // email et filtres anti-spam — leur absence est elle-même un signal
  // suspect, indépendamment du contenu. Message-ID unique par email
  // (jamais réutilisé), format standard <horodatage.aléatoire@domaine>.
  const messageId = `<${Date.now()}.${crypto.randomBytes(8).toString('hex')}@${(from.split('@')[1] || 'quickatlas.net')}>`;
  const headersCommon = [
    `From: ${fromName} <${from}>`,
    `To: <${to}>`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
  ];
  // Lien de désinscription en en-tête — norme attendue par Gmail/Yahoo
  // pour tout envoi groupé depuis 2024 ; son absence pénalise
  // directement la délivrabilité, même avec un contenu par ailleurs
  // irréprochable. En mailto faute de gestion d'abonnement dédiée pour
  // l'instant — reste conforme, un désabonnement par simple réponse
  // email fonctionne très bien pour ce volume.
  if (unsubscribeMailto) {
    headersCommon.push(`List-Unsubscribe: <mailto:${unsubscribeMailto}>`, 'List-Unsubscribe-Post: List-Unsubscribe=One-Click');
  }
  if (!attachments || attachments.length === 0) {
    if (!html) {
      return [...headersCommon, 'Content-Type: text/plain; charset=utf-8', '', text].join('\r\n');
    }
    // multipart/alternative : le client email choisit lui-même la version
    // HTML (avec pixel de suivi) ou texte brut (repli), jamais les deux
    // affichées à la fois — norme email standard.
    const altBoundary = `----quickatlas-alt-${crypto.randomBytes(12).toString('hex')}`;
    const altParts = [
      `--${altBoundary}`, 'Content-Type: text/plain; charset=utf-8', '', text, '',
      `--${altBoundary}`, 'Content-Type: text/html; charset=utf-8', '', html, '',
      `--${altBoundary}--`,
    ];
    return [...headersCommon, `Content-Type: multipart/alternative; boundary="${altBoundary}"`, '', ...altParts].join('\r\n');
  }
  const boundary = `----quickatlas-${crypto.randomBytes(12).toString('hex')}`;
  const parts = [];
  if (html) {
    const altBoundary = `----quickatlas-alt-${crypto.randomBytes(12).toString('hex')}`;
    parts.push(
      `--${boundary}`,
      `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
      '',
      `--${altBoundary}`, 'Content-Type: text/plain; charset=utf-8', '', text, '',
      `--${altBoundary}`, 'Content-Type: text/html; charset=utf-8', '', html, '',
      `--${altBoundary}--`,
      ''
    );
  } else {
    parts.push(`--${boundary}`, 'Content-Type: text/plain; charset=utf-8', '', text, '');
  }
  for (const att of attachments) {
    const base64Content = att.content.toString('base64');
    // Découpe en lignes de 76 caractères, comme l'exige la norme MIME.
    const wrapped = base64Content.replace(/(.{76})/g, '$1\r\n');
    parts.push(
      `--${boundary}`,
      `Content-Type: ${att.mimeType || 'application/octet-stream'}; name="${att.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${att.filename}"`,
      '',
      wrapped,
      ''
    );
  }
  parts.push(`--${boundary}--`);
  return [...headersCommon, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', ...parts].join('\r\n');
}

async function sendViaSmtp({ to, subject, text, html, attachments, host, port, user, pass, from, fromName, unsubscribeMailto }) {
  const socket = tls.connect({ host, port: Number(port) || 465, servername: host });
  await new Promise((resolve, reject) => {
    socket.once('secureConnect', resolve);
    socket.once('error', reject);
  });

  try {
    await smtpCommand(socket, null); // bannière du serveur
    await smtpCommand(socket, `EHLO atlas.local`);
    await smtpCommand(socket, 'AUTH LOGIN');
    await smtpCommand(socket, b64(user));
    await smtpCommand(socket, b64(pass));
    await smtpCommand(socket, `MAIL FROM:<${from}>`);
    await smtpCommand(socket, `RCPT TO:<${to}>`);
    await smtpCommand(socket, 'DATA', ['3']);
    const message = dotStuff(buildMimeMessage({ from, fromName, to, subject, text, html, attachments, unsubscribeMailto })) + '\r\n.';
    await smtpCommand(socket, message);
    await smtpCommand(socket, 'QUIT', ['2', '3', '5']);
  } finally {
    socket.end();
  }
}

/**
 * Envoie un email et consigne systématiquement une trace dans email_outbox,
 * que l'envoi réel ait réussi ou non (permet à un administrateur de relayer
 * manuellement un lien tant que le SMTP n'est pas configuré/vérifié).
 *
 * `attachments` (optionnel) : [{ filename, mimeType, content: Buffer }]
 * `smtpConfig` (optionnel) : { host, port, user, pass, mailFrom, fromName }
 *   — identifiants propres à un site du réseau multi-site. Sans cet
 *   argument, repli sur les variables d'environnement globales
 *   (comportement du site principal, inchangé).
 */
export async function sendMail({ to, subject, text, html, link, purpose, attachments, smtpConfig, unsubscribeMailto }) {
  const host = smtpConfig?.host || process.env.SMTP_HOST;
  const port = smtpConfig?.port || process.env.SMTP_PORT;
  const user = smtpConfig?.user || process.env.SMTP_USER;
  const pass = smtpConfig?.pass || process.env.SMTP_PASS;
  const from = smtpConfig?.mailFrom || process.env.MAIL_FROM || user;
  const fromName = smtpConfig?.fromName || 'QuickAtlas';
  const configured = !!(host && user && pass);
  let sentOk = 0;
  let sendError = null;

  if (configured) {
    try {
      await sendViaSmtp({ to, subject, text, html, attachments, host, port, user, pass, from, fromName, unsubscribeMailto: unsubscribeMailto || from });
      sentOk = 1;
    } catch (err) {
      sendError = err.message;
      console.error('[mailer] Échec envoi SMTP :', err.message);
    }
  } else {
    sendError = 'SMTP non configuré (identifiants absents pour ce site)';
  }

  db.prepare(
    'INSERT INTO email_outbox (to_email, purpose, subject, body, link, sent_ok, send_error) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(to, purpose || 'other', subject, text, link || null, sentOk, sendError);

  if (!sentOk) {
    console.log(`[mailer] Email simulé (non envoyé réellement) → ${to} : ${subject}\n${text}`);
  }

  return { sentOk: !!sentOk };
}
