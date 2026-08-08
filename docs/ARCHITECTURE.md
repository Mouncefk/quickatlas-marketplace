# Architecture — QuickAtlas

État réel du code au moment de la rédaction (voir date du dernier commit
pour la fraîcheur de ce document). Ce fichier documente ce qui existe,
pas ce qui est prévu — sauf la section « Architecture cible », clairement
marquée comme non exécutée.

## Vue d'ensemble

QuickAtlas est un monolithe volontairement simple :
- **Backend** : Node.js natif (`node:http`, `node:sqlite`, `node:crypto`)
  — aucune dépendance npm en production
- **Frontend** : HTML/CSS/JS vanilla, sans framework, sans étape de
  build — les fichiers de `public/` sont servis tels quels
- **Base de données** : SQLite, un seul fichier (`data/atlas.db`)

## Taille réelle des fichiers principaux

| Fichier | Lignes | Rôle |
|---|---|---|
| `server/server.js` | ~2 260 | Toutes les routes API, logique métier, gestion des requêtes HTTP |
| `public/js/app.js` | ~3 260 | Toute la logique d'interface : rendu DOM, navigation, appels API, formulaires |
| `public/js/i18n.js` | ~1 850 | Catalogue de 54 langues, 6 intégralement traduites |

## Structure actuelle du dossier `server/`

```
server/
├── server.js            # toutes les routes API (voir API.md)
├── db.js                # schéma SQLite (voir DATABASE.md)
├── auth.js              # hachage de mot de passe, jetons signés
├── mailer.js            # envoi d'email (SMTP ou simulation)
├── ai.js                # intégration IA optionnelle (traduction, rédaction, anti-fraude)
├── free-translate.js    # traduction gratuite (API MyMemory, sans clé)
├── country-info.js      # capitale/population/langues pour 195 pays
├── country-profiles.js  # fiches enrichies pour 60 pays
├── seed.js               # données de démonstration
├── go-live.js            # purge du contenu de démonstration
└── make-admin.js         # promotion d'un compte en administrateur
```

`server.js` concentre aujourd'hui **toutes** les routes API dans un seul
fichier — fonctionnel et testé, mais qui grossit à chaque nouvelle
fonctionnalité.

## Architecture cible (proposée, non exécutée)

Suite à un audit externe (voir historique du dépôt), une séparation
progressive de `server/server.js` est envisagée :

```
server/
├── server.js         # point d'entrée : démarrage HTTP, montage des routes
├── routes/            # une route (ou groupe de routes) par fichier
│   ├── auth.routes.js
│   ├── listings.routes.js
│   ├── messages.routes.js
│   └── ...
├── services/           # logique métier réutilisable, indépendante du HTTP
│   ├── translation.service.js
│   ├── pro-tier.service.js
│   └── ...
└── db/
    ├── schema.js        # ce qui est aujourd'hui db.js
    └── queries/         # requêtes SQL groupées par domaine
```

**Ce découpage n'a pas été exécuté.** Une réorganisation de ~2 260 lignes
comporte un vrai risque de régression sur un site déjà en production —
elle doit se faire progressivement, fonctionnalité par fonctionnalité,
avec test complet à chaque étape, plutôt qu'en un seul passage. Prochaine
fonctionnalité à construire = bon moment pour extraire son domaine dans
`routes/` + `services/`, plutôt que de l'ajouter de plus à `server.js`.

## Frontend — `public/js/app.js`

Responsabilités actuelles, toutes dans un seul fichier :
- Construction du DOM (assistant `el()`, sans framework)
- Navigation entre les "vues" (accueil, recherche, fiche annonce, compte...)
- Appels à l'API (fonction `api()` centralisée)
- Rendu de la carte interactive (D3.js, chargé depuis un CDN)
- Formulaires (publication, inscription, profil professionnel...)
- Messagerie, favoris, alertes, comptes professionnels, suppression de
  compte — chaque fonctionnalité ajoutée a été ajoutée ici

Comme pour le backend, **aucune modularisation n'a été faite** — l'audit
frontend dédié (à venir) décidera si/comment le découper.
