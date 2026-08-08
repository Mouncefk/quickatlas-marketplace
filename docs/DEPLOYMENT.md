# Déploiement — QuickAtlas

## Local

```bash
npm run seed     # crée data/atlas.db et le peuple (195 pays, 620 villes, 12 catégories, annonces de démo)
npm start        # démarre le serveur (port 3000 par défaut, ou $PORT)
```
Node ≥ 22.5.0 requis (`node:sqlite` natif). Compte de démonstration créé
par `npm run seed` : `demo@atlas.test` / `demo1234`.

## Variables d'environnement (`.env`, jamais versionné)

| Variable | Requis | Rôle |
|---|---|---|
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | Non | Envoi d'email réel (sinon simulé, visible dans `email_outbox`) |
| `MAIL_FROM` | Non | Adresse d'expédition des emails |
| `SITE_URL` | Non | Utilisée dans les liens envoyés par email et le sitemap |
| `PORT` | Non | Port d'écoute (Render le fournit automatiquement) |
| `GOOGLE_CLIENT_ID` | Non | Active le bouton de connexion Google |
| `PLATFORM_AI_PROVIDER`, `PLATFORM_AI_API_KEY` | Non | Traduction automatique par IA (sinon repli gratuit MyMemory) |

Voir `.env.example` pour le modèle complet et commenté.

## Hébergement (Render, ou tout hébergeur Node similaire)

1. Déployer le dépôt (build : aucune étape nécessaire, `npm install`
   suffit — zéro dépendance)
2. Commande de démarrage : `npm start`
3. **Configurer un disque persistant monté sur `data/`** — c'est le seul
   dossier à conserver entre deux déploiements (base de données +
   images uploadées, voir DATABASE.md)
4. Renseigner les variables d'environnement nécessaires (voir tableau
   ci-dessus)

## Passer en production (vider le contenu de démonstration)

```bash
npm run go-live
```
Supprime toutes les annonces et tous les comptes (y compris les
comptes administrateur existants), conserve les données de référence
(pays, villes, catégories, fiches pays enrichies). Après cette
commande : s'inscrire normalement sur le site, puis :
```bash
npm run make-admin -- votre@email.com
```

⚠️ **Point de vigilance observé en conditions réelles** : sur certains
hébergeurs, un redémarrage du service juste après une écriture en base
(SQLite en mode WAL) peut perdre les toutes dernières écritures si le
disque n'a pas eu le temps de synchroniser. En cas de doute après un
redémarrage, vérifier directement le contenu de la base avant de
conclure à un bug applicatif.
