// make-admin.js — Promeut (ou rétrograde) un compte existant au rôle administrateur.
//
// Usage :
//   node server/make-admin.js quelqu-un@example.com          → promeut cette personne administrateur
//   node server/make-admin.js quelqu-un@example.com --revoke → repasse cette personne en utilisateur simple
//
// C'est la façon normale de créer votre premier administrateur en production :
// 1) créez un compte normal sur le site (inscription classique)
// 2) lancez cette commande sur le serveur avec l'email de ce compte
import { db } from './db.js';

const email = (process.argv[2] || '').toLowerCase().trim();
const revoke = process.argv.includes('--revoke');

if (!email) {
  console.error('Usage : node server/make-admin.js email@example.com [--revoke]');
  process.exit(1);
}

const user = db.prepare('SELECT id, name, email, role FROM users WHERE email = ?').get(email);
if (!user) {
  console.error(`Aucun compte trouvé avec l'email "${email}". La personne doit d'abord s'inscrire sur le site.`);
  process.exit(1);
}

if (!revoke) {
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
  console.log(`✔ ${user.name} (${user.email}) est maintenant administrateur·rice.`);
} else {
  const adminCount = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get().c;
  if (adminCount <= 1 && user.role === 'admin') {
    console.error("Impossible : c'est le dernier compte administrateur du site. Promouvez quelqu'un d'autre avant de le rétrograder.");
    process.exit(1);
  }
  db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(user.id);
  console.log(`✔ ${user.name} (${user.email}) n'est plus administrateur·rice.`);
}
