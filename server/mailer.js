// mailer.js — Envoi d'email en SMTP minimal (aucune dépendance externe),
// avec repli automatique : si aucun serveur SMTP n'est configuré (ou si
// l'envoi échoue), l'email est simplement consigné dans la table
// `email_outbox`, consultable depuis le panneau Administration → Emails.
//
// Configuration (variables d'environnement, toutes optionnelles) :
//   SMTP_HOST, SMTP_PORT (défaut 465), SMTP_USER, SMTP_PASS, MAIL_FROM
//
// Important : ce client SMTP est volontairement simple (connexion TLS
// directe, type "SMTPS" sur le port 465, comme Gmail/la plupart des
// fournisseurs). Il n'a pas pu être testé contre un vrai serveur dans cet
// environnement de développement (pas d'accès réseau sortant) : vérifiez
// qu'un email arrive bien chez vous après configuration, et signalez tout
// souci — un remplacement par un paquet comme `nodemailer` reste possible
// si besoin.
import tls from 'node:tls';
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

async function sendViaSmtp({ to, subject, text }) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM } = process.env;
  const from = MAIL_FROM || SMTP_USER;

  const socket = tls.connect({ host: SMTP_HOST, port: Number(SMTP_PORT) || 465, servername: SMTP_HOST });
  await new Promise((resolve, reject) => {
    socket.once('secureConnect', resolve);
    socket.once('error', reject);
  });

  try {
    await smtpCommand(socket, null); // bannière du serveur
    await smtpCommand(socket, `EHLO atlas.local`);
    await smtpCommand(socket, 'AUTH LOGIN');
    await smtpCommand(socket, b64(SMTP_USER));
    await smtpCommand(socket, b64(SMTP_PASS));
    await smtpCommand(socket, `MAIL FROM:<${from}>`);
    await smtpCommand(socket, `RCPT TO:<${to}>`);
    await smtpCommand(socket, 'DATA', ['3']);
    const message = [
      `From: QuickAtlas <${from}>`,
      `To: <${to}>`,
      `Subject: ${subject}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      text,
      '.',
    ].join('\r\n');
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
 */
export async function sendMail({ to, subject, text, link, purpose }) {
  const configured = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
  let sentOk = 0;
  let sendError = null;

  if (configured) {
    try {
      await sendViaSmtp({ to, subject, text });
      sentOk = 1;
    } catch (err) {
      sendError = err.message;
      console.error('[mailer] Échec envoi SMTP :', err.message);
    }
  } else {
    sendError = 'SMTP non configuré (variables SMTP_HOST/SMTP_USER/SMTP_PASS absentes)';
  }

  db.prepare(
    'INSERT INTO email_outbox (to_email, purpose, subject, body, link, sent_ok, send_error) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(to, purpose || 'other', subject, text, link || null, sentOk, sendError);

  if (!sentOk) {
    console.log(`[mailer] Email simulé (non envoyé réellement) → ${to} : ${subject}\n${text}`);
  }

  return { sentOk: !!sentOk };
}
