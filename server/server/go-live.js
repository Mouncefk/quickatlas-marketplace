// go-live.js — Bascule le site en mode production : supprime TOUTES les
// annonces, tous les comptes (y compris le compte de démo) et toutes les
// données liées (messages, avis, favoris, alertes...), tout en
// conservant intactes les données de référence (pays, villes, états,
// catégories, fiches pays enrichies) — celles-ci ne sont jamais du
// contenu de démonstration, ce sont les fondations du site.
//
// ⚠️ Irréversible. À exécuter UNE SEULE FOIS, quand vous êtes prêt·e à
// ouvrir le site au public. Ensuite, inscrivez-vous normalement sur le
// site puis lancez `npm run make-admin -- votre@email.com` pour devenir
// administrateur·rice.
import { db } from './db.js';

const listingsCount = db.prepare('SELECT COUNT(*) AS c FROM listings').get().c;
const usersCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;

if (listingsCount === 0 && usersCount === 0) {
  console.log('Déjà vide : aucune annonce ni aucun compte à supprimer.');
  process.exit(0);
}

console.log(`Suppression de ${listingsCount} annonce(s) et ${usersCount} compte(s)...`);

const tablesToClear = [
  'messages', 'conversations', 'offers', 'favorites', 'reviews',
  'saved_search_matches', 'saved_searches', 'reports', 'events',
  'email_outbox', 'auth_tokens', 'listings', 'users',
];

for (const table of tablesToClear) {
  db.prepare(`DELETE FROM ${table}`).run();
}
// Repart de zéro sur les identifiants auto-incrémentés (cosmétique,
// évite juste des IDs qui recommencent à des grands nombres).
db.prepare(`DELETE FROM sqlite_sequence WHERE name IN (${tablesToClear.map(() => '?').join(',')})`).run(...tablesToClear);

console.log('Site vidé de tout contenu de démonstration.');
console.log('Données conservées : pays, villes, états/provinces, catégories, fiches pays enrichies.');
console.log("Prochaine étape : inscrivez-vous normalement sur le site, puis lancez :");
console.log('  npm run make-admin -- votre@email.com');
