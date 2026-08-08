# Base de données — QuickAtlas

SQLite, un seul fichier : `data/atlas.db` (créé automatiquement au
premier démarrage par `server/db.js`).

## ⚠️ Découverte importante : les clés étrangères ne sont pas actives

Le schéma (`server/db.js`) utilise des déclarations `REFERENCES ... ON
DELETE CASCADE` un peu partout — mais **`PRAGMA foreign_keys` n'est
jamais activé** sur la connexion. En SQLite, les contraintes de clé
étrangère sont **désactivées par défaut** tant que ce PRAGMA n'est pas
explicitement mis à `ON`. Conséquence concrète, vérifiée : supprimer une
ligne parente (ex. un compte utilisateur) **ne supprime pas** ses lignes
liées (annonces, messages, favoris...) — elles restent orphelines.

**Où ça compte aujourd'hui** : la route de suppression de compte
(`DELETE /api/me`) contourne ce problème en supprimant explicitement,
table par table, dans le bon ordre — testé exhaustivement (voir
README.md, section correctifs de sécurité).

**Ailleurs dans le code**, ce problème reste présent et non corrigé :
toute autre suppression (ex. suppression d'annonce, modération admin)
devrait être vérifiée au cas par cas pour savoir si elle laisse des
données orphelines.

**Option pour une vraie correction globale** : ajouter
`db.exec('PRAGMA foreign_keys = ON')` juste après l'ouverture de la
connexion dans `db.js`. Non fait pour l'instant — activer ce PRAGMA
peut faire apparaître des erreurs sur des chemins d'écriture existants
qui violaient silencieusement ces contraintes jusqu'ici ; ça mérite un
passage de test complet dédié plutôt qu'un changement improvisé.

## Tables (21 au total)

| Table | Rôle |
|---|---|
| `users` | Comptes (particuliers et professionnels) |
| `countries` | 195 pays de référence |
| `states` | États/provinces (8 pays fédéraux, 60 au total) |
| `cities` | 620 villes |
| `categories` | 12 catégories |
| `subcategories` | Sous-catégories par catégorie |
| `listings` | Annonces |
| `listing_translations` | Cache des traductions automatiques d'annonces |
| `offers` | Offres (argent ou échange) sur une conversation |
| `favorites` | Annonces mises en favori |
| `reviews` | Avis vendeur·se |
| `saved_searches` | Recherches sauvegardées (alertes email) |
| `saved_search_matches` | Annonces qui correspondent à une alerte |
| `auth_tokens` | Jetons de vérification email / réinitialisation mot de passe |
| `reports` | Signalements d'annonces |
| `events` | Événements professionnels (salons, conférences) |
| `country_economic_stats` | Cache des statistiques Banque mondiale (30 jours) |
| `country_profiles` | *(voir note)* |
| `email_outbox` | Historique des emails envoyés (ou simulés) |
| `conversations` | Fils de messagerie acheteur·se ↔ vendeur·se |
| `messages` | Messages individuels |

*Note : les fiches pays enrichies (climat des affaires, culture...)
vivent en réalité dans `server/country-profiles.js` (fichier JS statique,
pas une table peuplée dynamiquement) — `country_profiles` en base sert à
un autre usage ponctuel, à vérifier au cas par cas avant de s'y fier.*

## Emplacement des fichiers de données

```
data/
├── atlas.db          # base SQLite
├── atlas.db-wal       # fichier d'écriture temporaire SQLite (WAL)
├── atlas.db-shm       # fichier partagé SQLite
└── uploads/           # images uploadées par les utilisateurs (annonces, logos)
```

Ce dossier `data/` doit être **persistant** sur l'hébergeur (disque
persistant sur Render, par exemple) — voir DEPLOYMENT.md.
