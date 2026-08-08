# SEO — QuickAtlas

## Adresses propres par page

- `/pays/nom-du-pays`
- `/categorie/slug-categorie`
- `/annonce/id-titre-slug`

## Balises méta générées côté serveur

Pour chaque page, avant l'envoi du HTML : titre et méta-description
uniques (basés sur les vraies données — nombre d'annonces, nom du pays,
titre de l'annonce...), balises Open Graph et Twitter Card. Permet des
aperçus enrichis lors du partage (WhatsApp, Facebook...) sans dépendre
de l'exécution du JavaScript côté client.

## Plan de site

`/sitemap.xml` généré dynamiquement à chaque requête : accueil + tous
les pays + toutes les catégories + toutes les annonces actives.

`/robots.txt` : autorise tout, exclut `/api/`, pointe vers le plan de
site.

## Navigation cohérente avec l'URL

Cliquer sur un pays ou une annonce met à jour l'adresse du navigateur
(`pushState`) ; un lien partagé ouvre directement le bon contenu au
chargement (pas juste la page d'accueil).

## Statut d'indexation

Le site a été vérifié et son plan de site soumis sur Google Search
Console (voir historique du dépôt pour la date) — statut d'indexation à
reconfirmer périodiquement, non automatisé.
