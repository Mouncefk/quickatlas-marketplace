# API — QuickAtlas

Toutes les routes vivent dans `server/server.js` (voir ARCHITECTURE.md
pour le projet de découpage). Authentification par en-tête
`Authorization: Bearer <jeton>`.

## Authentification & compte
| Route | Méthode | Rôle |
|---|---|---|
| `/api/auth/register` | POST | Inscription (particulier ou professionnel) |
| `/api/auth/login` | POST | Connexion |
| `/api/auth/google` | POST | Connexion via Google (si configuré) |
| `/api/auth/verify-email` | POST | Vérification d'email |
| `/api/auth/resend-verification` | POST | Renvoi du lien de vérification |
| `/api/auth/forgot-password` / `reset-password` | POST | Réinitialisation de mot de passe |
| `/api/auth/me` | GET | Profil du compte connecté |
| `/api/me` | DELETE | **Suppression définitive du compte** (mot de passe + confirmation requis) |
| `/api/me/phone` | PUT | Numéro WhatsApp |
| `/api/me/professional-profile` | PUT | Profil professionnel (nom, site, logo) |
| `/api/me/ai-settings` | GET/PUT | Clé IA personnelle (traduction/rédaction) |
| `/api/me/stats` | GET | Statistiques du tableau de bord vendeur |
| `/api/me/listings` | GET | Mes annonces |

## Annonces
| Route | Méthode | Rôle |
|---|---|---|
| `/api/listings` | GET/POST | Liste / création |
| `/api/listings/:id` | GET/PUT/DELETE | Détail / modification / suppression |
| `/api/listings/search` | GET | Recherche, **paginée** (`offset`, page de 60) |
| `/api/listings/featured` | GET | Annonces à la une |
| `/api/listings/promo` | GET | Bandeau promotionnel |
| `/api/listings/:id/translation` | GET | Traduction automatique (cache + gratuite + IA optionnelle) |
| `/api/cities/:id/listings` | GET | Annonces d'une ville |

## Messagerie & transactions
| Route | Méthode | Rôle |
|---|---|---|
| `/api/conversations` | GET/POST | Fils de discussion |
| `/api/conversations/:id/messages` | GET/POST | Messages |
| `/api/conversations/unread-count` | GET | Badge non-lus |
| `/api/offers` | POST | Faire une offre (argent ou échange) |
| `/api/reviews` | POST | Laisser un avis |
| `/api/favorites`, `/api/favorites/ids`, `/api/favorites/:id` | — | Favoris |
| `/api/reports`, `/api/reports/:id` | — | Signalement d'annonce |

## Recherche, alertes, géographie
| Route | Méthode | Rôle |
|---|---|---|
| `/api/saved-searches` | GET/POST/DELETE | Recherches sauvegardées (alertes email) |
| `/api/saved-searches/unread-count` | GET | Badge alertes |
| `/api/countries`, `/api/countries/:id` | GET | Pays |
| `/api/countries/:id/economic-stats` | GET | Statistiques Banque mondiale (cache 30j) |
| `/api/states/:countryId` | GET | États/provinces |
| `/api/cities/:countryId` | GET | Villes d'un pays |
| `/api/categories` | GET | Catégories/sous-catégories |
| `/api/geo-guess` | GET | Devine le pays depuis le fuseau horaire du visiteur |
| `/api/activity-feed`, `/api/demand-signals` | GET | Fil d'activité, tendances |
| `/api/business-opportunities` | GET | Opportunités d'affaires par pays |
| `/api/events` | GET/POST | Événements professionnels |

## IA (optionnelle, à la charge de l'utilisateur ou de la plateforme)
| Route | Méthode | Rôle |
|---|---|---|
| `/api/ai/translate-listing` | POST | Traduction via la clé IA personnelle du compte |
| `/api/ai/draft-listing` | POST | Aide à la rédaction |
| `/api/ai/analyze-fraud` | POST | Analyse anti-fraude (admin) |

## Administration (rôle `admin` requis)
| Route | Méthode | Rôle |
|---|---|---|
| `/api/admin/stats` | GET | Tableau de bord |
| `/api/admin/users`, `/api/admin/users/:id` | — | Gestion des comptes |
| `/api/admin/listings`, `/api/admin/listings/:id` | — | Gestion des annonces |
| `/api/admin/reports` | GET | Signalements |
| `/api/admin/emails` | GET | Historique des emails |

## Autres
| Route | Méthode | Rôle |
|---|---|---|
| `/api/uploads` | POST | Upload d'image (5 Mo max, JPEG/PNG/WEBP/GIF) |
| `/api/config` | GET | Configuration publique (langues, devises...) |
| `/robots.txt`, `/sitemap.xml` | GET | SEO (voir SEO.md) |
