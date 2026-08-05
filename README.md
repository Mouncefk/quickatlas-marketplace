# QuickAtlas — Marketplace mondial (immobilier, véhicules, objets)

Site complet d'achat / vente / location de biens, navigable via une carte du monde
interactive : on clique un pays → on choisit une ville → on parcourt les annonces.

Comptes utilisateurs, publication d'annonces, tableau de bord "Mes annonces".

## Stack technique — volontairement sans dépendances externes

Pour que le projet tourne **sans `npm install`**, tout est écrit avec les modules
natifs de Node.js :

- **Backend** : `node:http` (serveur HTTP), `node:sqlite` (base de données, module
  natif depuis Node 22.5), `node:crypto` (hachage des mots de passe en scrypt,
  tokens de session signés type JWT). Pas d'Express, pas de bcrypt, pas de driver
  SQLite tiers.
- **Frontend** : HTML/CSS/JS "vanilla", une seule page (`public/index.html`),
  aucun framework, aucune étape de build. La carte du monde est dessinée avec
  **D3.js** (chargé depuis un CDN dans le navigateur de l'utilisateur — ce n'est
  pas une dépendance du serveur).
- **Prérequis : Node.js ≥ 22.5** (pour `node:sqlite`).

## Couverture mondiale

QuickAtlas référence désormais **195 pays** (quasiment tous les États reconnus).
Pour équilibrer largeur et profondeur :
- Les **15 pays d'origine** (France, Maroc, États-Unis, Espagne, Italie,
  Allemagne, Royaume-Uni, Canada, Japon, Brésil, Émirats arabes unis,
  Sénégal, Portugal, Égypte, Mexique) restent les plus détaillés : 6 à 8
  grandes villes chacun, et pour 6 d'entre eux une division par état/province.
- Les **180 pays ajoutés** sont référencés avec leur capitale (et une
  seconde grande ville pour une vingtaine de pays étendus ou multi-fuseaux :
  Russie, Chine, Inde, Indonésie, Australie, Turquie, Pakistan, Argentine,
  Colombie, Corée du Sud, Vietnam, Thaïlande, Arabie saoudite, Israël,
  Kenya, Nigeria, Philippines, Suisse, Nouvelle-Zélande…), chacun avec sa
  devise locale et son fuseau horaire — mais sans détail par état/province
  ni annonces de démonstration.

Ces 180 pays sont pleinement fonctionnels : navigables sur la carte,
recherchables, et n'importe qui peut y publier une annonce dès aujourd'hui.

**Fiabilité des données** : les codes ISO, devises et fuseaux horaires de ces
180 pays ont été renseignés à partir de connaissances générales plutôt que
d'une base de référence consultée en direct. Une erreur ponctuelle (fuseau
horaire, code devise) est possible sur un tel volume — signalez toute
anomalie constatée, elle se corrige en une ligne dans `server/seed.js`.

Pour enrichir un pays particulier (plus de villes, découpage en états),
demandez-le simplement : le seed est conçu pour que ce soit rapide à faire
pays par pays.

## Charte de la communauté & décharge de responsabilité

- Une page **« Charte de la communauté & conditions d'utilisation »**
  (accessible depuis le pied de page) couvre deux volets :
  - **Charte de bonne conduite** : interdiction explicite de tout contenu
    haineux, raciste, xénophobe, discriminatoire, à caractère religieux
    prosélyte ou insultant, à caractère politique partisan, du harcèlement,
    et de tout contenu illégal.
  - **Décharge de responsabilité** : QuickAtlas est présenté comme une simple
    plateforme de mise en relation, non responsable des transactions, de
    l'exactitude des annonces, ni des litiges entre utilisateurs ; la
    modération est effectuée a posteriori.
- **Acceptation obligatoire à l'inscription** : une case à cocher (non
  cochée par défaut) est requise pour créer un compte, avec un lien direct
  vers la charte. Le serveur **refuse l'inscription** si cette case n'est
  pas cochée, même en contournant l'interface (testé directement via l'API).
  La date d'acceptation est enregistrée en base (`terms_accepted_at`).
- **Rappels contextuels** : un message discret avec lien vers la charte
  apparaît juste avant de publier une annonce et juste avant d'envoyer un
  message à un autre utilisateur.

> Ceci reste un texte généraliste, à adapter avec un vrai juriste avant un
> lancement public — voir aussi la section réglementations abordée plus
> haut dans nos échanges.

## Sécurité des comptes et confiance

- **Vérification d'email** : un email de confirmation est envoyé à
  l'inscription (lien valable 48h). Tant que l'email n'est pas vérifié,
  impossible de publier une annonce ou de contacter quelqu'un — une bannière
  le rappelle, avec un bouton pour renvoyer l'email.
- **Récupération de mot de passe** : « Mot de passe oublié ? » sur l'écran de
  connexion envoie un lien de réinitialisation (valable 1h, usage unique).
- **Limitation des tentatives de connexion** : après 5 échecs sur un même
  compte, blocage de 15 minutes.
- **Solidité du mot de passe** : 8 caractères minimum avec au moins une
  lettre et un chiffre, imposé côté serveur (pas seulement côté interface),
  avec un indicateur visuel de robustesse à la saisie.
- **Bouton « Signaler »** sur chaque annonce (sauf les vôtres), avec motif
  (spam, contenu haineux, arnaque, autre) — consultable et traitable dans
  Administration → Signalements.
- **Infobulle de nouveau message** : le site vérifie en tâche de fond
  (toutes les 25 secondes) et affiche un toast dès qu'un nouveau message
  arrive, sans recharger la page.

### À propos de l'envoi d'email réel

Aucune dépendance externe n'a été ajoutée : l'envoi email est un client SMTP
minimal écrit à la main (`server/mailer.js`), activé uniquement si vous
définissez ces variables d'environnement :
```
SMTP_HOST=smtp.exemple.com
SMTP_PORT=465
SMTP_USER=votre-compte@exemple.com
SMTP_PASS=votre-mot-de-passe
MAIL_FROM=no-reply@votre-domaine.com
SITE_URL=https://votre-domaine.com
```
**Important** : ce client SMTP n'a pas pu être testé contre un vrai serveur
dans cet environnement de développement (pas d'accès réseau sortant) —
vérifiez qu'un email arrive bien chez vous une fois configuré. En attendant
(ou si l'envoi échoue), **chaque email est de toute façon consigné** dans
Administration → Emails, avec le lien à copier-coller manuellement si besoin.

## Upload d'images

Le formulaire de publication permet désormais d'envoyer une photo directement
depuis son appareil (JPEG/PNG/WEBP/GIF, 5 Mo max), avec aperçu avant envoi.
Les fichiers sont stockés dans `public/uploads/`. Le champ "image (URL)"
reste disponible en alternative.

## Italien : 6ᵉ langue pleinement traduite

L'italien a rejoint le français, l'anglais, l'arabe, l'espagnol et le
portugais comme **langue complètement traduite** (413 textes traduits,
soit l'intégralité de l'interface). Un visiteur avec un navigateur
configuré en italien voit désormais tout le site directement en italien,
sans passage par l'anglais ni bandeau "traduction bientôt disponible".
Le sarde (`sc`), resté en bêta, se replie maintenant sur l'italien plutôt
que sur l'anglais.

## Parrainage mis en avant

Le parrainage était auparavant en bas de la page Passeport, peu visible.
Il est désormais dans une **carte mise en avant en haut de la page**
Passeport (fond doré, bordure marquée), et un **rappel discret** apparaît
sur "Mes annonces" (juste sous les statistiques), qui renvoie directement
vers cette carte au clic — visible que vous ayez déjà des crédits ou non.

## Prêt pour le déploiement (Render et similaires)

Les images uploadées par les utilisateurs sont désormais stockées dans
`data/uploads/` (au lieu de `public/uploads/`), et servies via une route
dédiée. Ce changement regroupe **tout ce qui doit être conservé durablement**
(base de données + images) sous un seul dossier `data/` — pratique pour
configurer un disque persistant sur un hébergeur comme Render : il suffit
de faire persister ce seul dossier pour ne rien perdre entre deux
déploiements. `PORT` est lu depuis la variable d'environnement fournie par
l'hébergeur (`process.env.PORT`), donc aucune configuration supplémentaire
n'est nécessaire de ce côté.

## Opportunités d'affaires (nouvelle catégorie + nouvel onglet pays)

Nouvelle catégorie **💼 Opportunités d'affaires** (entreprise à vendre,
recherche d'investisseurs, appel d'offres, franchise à reprendre,
recherche de partenaire) — réutilise entièrement l'infrastructure
existante (annonces, messagerie, photos).

Nouveau **type de contenu, distinct des annonces classiques** : les
**événements professionnels** (salons, conférences, forums d'affaires),
avec titre, dates, lieu et lien externe — n'importe quel utilisateur
vérifié peut en proposer un.

Sur chaque fiche pays, une section **"Opportunités d'affaires"** regroupe
automatiquement : les annonces de la nouvelle catégorie pour ce pays, les
événements professionnels à venir, et un lien vers les offres d'emploi
disponibles (réutilise la catégorie Emploi déjà existante) — le tout
sans dupliquer aucune donnée.

## Passer en production : vider le contenu de démonstration

```
npm run go-live
```

**Irréversible, à lancer une seule fois** quand vous êtes prêt·e à ouvrir
le site au public. Supprime toutes les annonces, tous les comptes (dont
le compte de démonstration) et toutes les données liées (messages, avis,
favoris, alertes...). **Conserve intactes** les données de référence :
pays, villes, états/provinces, catégories, fiches pays enrichies — ce ne
sont pas du contenu de démonstration, ce sont les fondations du site.

Ensuite, inscrivez-vous normalement sur le site avec votre vraie adresse,
puis lancez `npm run make-admin -- votre@email.com` pour devenir
administrateur·rice.

La mention "Projet de démonstration" et l'indice de connexion
`demo@atlas.test` ont aussi été retirés du site (testé dans les 6
langues) — plus aucune trace du mode démonstration une fois cette étape
faite.

## Référencement (SEO) : de vraies adresses par page

Jusqu'ici, tout le site n'avait **qu'une seule adresse et un seul titre**
pour Google, quel que soit le pays, la catégorie ou l'annonce consultée —
le frein principal au référencement. Corrigé sans réécrire l'application :

- **De vraies URLs** par page : `/pays/maroc`, `/categorie/immobilier`,
  `/annonce/123-appartement-lumineux-3-pieces`
- **Titre et description uniques**, générés par le serveur à partir des
  vraies données (ex. "Achetez, vendez, louez au Maroc — QuickAtlas",
  avec le nombre réel d'annonces) — lisibles par Google et les réseaux
  sociaux sans avoir besoin d'exécuter le JavaScript
- **Balises Open Graph et Twitter Card** sur chaque page (dont l'accueil)
  — un lien partagé sur WhatsApp/Facebook affiche maintenant un aperçu
  avec titre, description et image, au lieu de rien
- **`sitemap.xml`** généré dynamiquement (267 adresses : accueil + 195
  pays + 12 catégories + toutes les annonces actives), et **`robots.txt`**
  qui l'indique aux moteurs de recherche
- **Navigation cohérente** : cliquer sur un pays ou une annonce met à
  jour l'adresse dans le navigateur (testé), et un **lien partagé
  s'ouvre directement sur le bon contenu** (testé) — pas seulement un
  titre correct, la vraie fiche s'affiche aussi automatiquement

Une fois en ligne, vous pouvez soumettre `https://quickatlas.net/sitemap.xml`
à la Google Search Console pour accélérer l'indexation.

## Statistiques économiques réelles (API Banque mondiale)

PIB, PIB par habitant, croissance du PIB, taux de chômage et inflation —
de **vrais chiffres**, via l'API gratuite et sans clé de la Banque
mondiale (`api.worldbank.org`), affichés sur chaque fiche pays avec
l'année de la donnée et la source citée. Les résultats sont mis en cache
30 jours en base (les données ne changent qu'une fois par an, pas besoin
de réinterroger l'API à chaque visite).

⚠️ **Non testable dans mon environnement de développement (pas d'accès
internet)** — la logique de dégradation propre a été vérifiée à fond : sans
réseau, l'API répond rapidement avec un statut d'erreur, et le site
affiche honnêtement "Données économiques indisponibles" plutôt que de
planter ou d'afficher des valeurs invalides. **À confirmer une fois
déployé en ligne**, où l'accès internet réel permettra les vrais appels.

## Correctif : annonces publiées visibles sans recharger la page

Les réponses de l'API n'indiquaient auparavant aucune consigne de cache au
navigateur, qui pouvait donc parfois réutiliser une ancienne réponse déjà
en mémoire au lieu de redemander les données au serveur — par exemple,
revisiter "Explorer les annonces par ville" après avoir publié une annonce
pouvait montrer une liste obsolète tant que la page n'était pas rechargée.
Toutes les réponses API envoient maintenant `Cache-Control: no-store`
(et le navigateur le respecte côté client aussi) : les données affichées
sont toujours fraîches. Testé de bout en bout : publier une annonce puis
naviguer vers sa ville, sans aucun rechargement de page, l'affiche
immédiatement.

## Villes enrichies pour la quasi-totalité des pays

Après un premier lot de 30 pays, l'enrichissement a été étendu à **tous**
les pays restants (130 de plus, en une seule fois) : chaque pays dispose
désormais de 2 à 6 villes (au lieu d'une seule, la capitale) — total
**431 → 620 villes**. Seuls **12 micro-états** gardent une seule ville
(Vatican, Singapour — cité-État — et de petites nations insulaires du
Pacifique comme Nauru, Tuvalu, Palaos), pour lesquels ajouter des villes
supplémentaires n'aurait pas de sens géographique réel.

L'**Inde** (8 états) et l'**Australie** (7 états/territoires) sont
désormais aussi des pays "fédéraux" avec un niveau état/province dans le
formulaire de publication, comme les États-Unis, le Canada, l'Allemagne, le
Brésil, les Émirats arabes unis et le Mexique déjà couverts. Total : 6 → **8
pays fédéraux**, 45 → **60 états/provinces**.

## Mode d'emploi / guide de navigation

Un **bouton flottant** (🧭, en bas à droite, toujours visible quel que soit
l'endroit du site) ouvre un guide complet organisé en 6 sections dépliables :
premiers pas, publier une annonce, acheter/négocier/échanger, rester
informé, profil & Passeport QuickAtlas, sécurité & confiance. Le guide
s'affiche aussi **automatiquement une seule fois**, à la toute première
visite (avec une case à cocher pour ne plus le voir apparaître seul).

## Emails d'expiration et de renouvellement

Le serveur vérifie automatiquement, **au démarrage puis toutes les heures**
tant qu'il tourne (aucune tâche planifiée externe nécessaire), les annonces
qui expirent bientôt ou qui viennent d'expirer :
- **3 jours avant expiration** : email de rappel avec un lien direct vers
  l'annonce (page « Mes annonces » sur QuickAtlas ou lien direct de l'email).
- **Dès l'expiration** : email confirmant que l'annonce n'est plus visible,
  avec le même lien pour la renouveler en un clic.

Chaque email n'est envoyé **qu'une seule fois** par annonce (grâce à un
indicateur remis à zéro automatiquement à chaque renouvellement) — testé en
redémarrant le serveur plusieurs fois de suite sans recevoir de doublon.

## Tableau de bord vendeur, offres, fraude, expiration, mise en avant, PWA, mini-carte

- **Tableau de bord vendeur** : sur "Mes annonces", cartes de statistiques
  (annonces actives, vues totales, favoris reçus, note moyenne).
- **Faire une offre** : dans la messagerie, l'acheteur peut proposer un prix
  structuré (bulle dédiée dans le fil) ; le vendeur accepte ou refuse en un
  clic. Testé de bout en bout.
- **Détection de fraude** : un système **heuristique** (règles simples,
  toujours actif, sans IA ni clé requise) calcule un score à la publication
  — description trop courte, absence de photo, prix très inférieur à la
  moyenne de la sous-catégorie, compte non vérifié ou très récent. Visible
  dans Administration → Annonces, trié par risque décroissant. Un bouton
  **« Analyser avec l'IA »** optionnel (si l'administrateur a configuré sa
  propre clé) approfondit l'analyse.
- **Expiration & renouvellement** : les annonces expirent après 60 jours
  (filtrage automatique partout), avec un bouton « Renouveler » dès qu'il
  reste 7 jours ou moins.
- **Mise en avant (« Booster »)** : les annonces boostées remontent en tête
  des listes et résultats. **Aucun paiement réel n'est traité** — activation
  gratuite en démonstration, avec une note explicite dans l'interface : un
  vrai processeur de paiement (Stripe ou équivalent) devra être branché
  avant toute mise en production.
- **Site installable (PWA)** : manifeste + service worker (cache l'app
  shell, jamais les données `/api/`) + icônes dédiées. Le navigateur propose
  « Ajouter à l'écran d'accueil » sur mobile comme sur desktop.
- **Mini-carte des annonces dans une ville** : sous les filtres, une
  visualisation avec des repères pour chaque annonce — **volontairement
  présentée comme indicative et non géolocalisée** (aucune adresse précise
  n'est collectée ni affichée, par souci de simplicité technique et de
  respect de la vie privée des vendeurs).

## Alertes de recherche

Depuis l'exploration par ville ou la navigation par catégorie, un bouton
**« 🔔 Enregistrer cette recherche »** permet de sauvegarder les critères
actuels (pays, ville, catégorie, sous-catégorie, type, mot-clé). Dès qu'une
nouvelle annonce correspond, un **email est réellement envoyé** (même
mécanisme que la vérification d'email/réinitialisation de mot de passe —
via `server/mailer.js`, consigné dans Administration → Emails si le SMTP
n'est pas configuré). Un badge sur le lien « Alertes » indique le nombre de
nouvelles correspondances non consultées. Page **« Mes alertes »**
accessible depuis le menu (connexion requise) pour consulter, gérer et
supprimer ses alertes. Testé de bout en bout : un utilisateur publie une
annonce, un autre utilisateur ayant une alerte correspondante reçoit
effectivement l'email et voit le badge apparaître.

## Fonctionnalités « modernes » de place de marché

Ajoutées pour rendre le site plus attractif et donner envie d'y revenir,
sans dénaturer l'identité cartographique du design :

- ❤️ **Favoris** : bouton cœur sur chaque annonce (carte et fiche détail),
  page dédiée « Mes favoris » accessible depuis le menu une fois connecté.
- 🔀 **Tri des annonces** : plus récentes, prix croissant, prix décroissant
  (dans une ville sélectionnée).
- 👁 **Compteur de vues** par annonce (preuve sociale).
- ✓ **Badge « Vendeur vérifié »** sur la fiche détail, relié automatiquement
  à la vérification d'email déjà en place — aucune donnée supplémentaire à
  gérer.
- 🕓 **« Vus récemment »** : bandeau personnalisé en page d'accueil,
  basé sur l'historique de navigation local (aucune donnée envoyée au
  serveur, respecte la vie privée, fonctionne même sans compte).

## Fonctionnalités IA (à la charge de l'utilisateur)

QuickAtlas peut traduire une annonce à la demande, **avec la clé API personnelle
de chaque utilisateur** — jamais celle du site. C'est délibéré : chaque
personne qui active l'IA en assume elle-même le coût (facturé par son
fournisseur, Anthropic ou OpenAI), QuickAtlas ne paie ni ne facture rien.

- Bouton **« IA »** dans le menu (une fois connecté) → explique la
  fonctionnalité, indique comment créer une clé (liens directs vers
  console.anthropic.com et platform.openai.com), et permet de la coller.
- La clé est **chiffrée en base** (AES-256-GCM, dérivée du même secret que
  les sessions) — jamais renvoyée en clair à l'interface après coup, jamais
  visible par les autres utilisateurs ni les administrateurs.
- Sur une fiche annonce, un bouton **« Traduire cette annonce dans ma
  langue »** apparaît dès qu'une clé est configurée. La traduction se fait
  côté serveur (la clé ne transite jamais vers le navigateur), dans la
  langue actuellement choisie sur le site.
- Testé de bout en bout : la requête atteint réellement l'API d'Anthropic
  (erreurs de clé invalide correctement remontées) — il ne manque qu'une
  vraie clé API pour que ça fonctionne en conditions réelles.

Architecture pensée pour ajouter facilement d'autres usages IA plus tard
(aide à la rédaction, détection de fraude, recommandations, chatbot) sur
le même principe : `server/ai.js` centralise les appels aux fournisseurs.

## Recommandations, notation et aide à la rédaction

- **Annonces similaires** : en bas de chaque fiche annonce, jusqu'à 4 annonces
  de la même catégorie s'affichent automatiquement (même ville en priorité,
  puis même sous-catégorie, puis les plus récentes).
- **Notation des vendeurs** : un bouton « Noter ce vendeur » apparaît dans la
  messagerie, côté acheteur uniquement, une fois un premier message envoyé.
  Note de 1 à 5 étoiles + commentaire optionnel. La note moyenne et le nombre
  d'avis s'affichent automatiquement sur toutes les annonces du vendeur noté.
- **Aide à la rédaction par IA** : dans le formulaire de publication, un
  encart « ✨ Besoin d'aide pour rédiger ? » (visible dès qu'une clé API IA
  est configurée) génère un titre et une description à partir de quelques
  notes en vrac — toujours avec la clé personnelle de l'utilisateur, sur le
  même principe que la traduction.

## Fiche pays enrichie — 30 pays couverts

Après les 15 pays phares, un second lot de 15 grandes économies a été ajouté :
Chine, Inde, Russie, Australie, Afrique du Sud, Nigeria, Argentine, Pays-Bas,
Suisse, Belgique, Suède, Turquie, Arabie saoudite, Indonésie, Corée du Sud.
Même structure et même ton factuel que le premier lot (voir plus haut).

## Fiche pays enrichie — 60 pays couverts

Après les 3 premiers lots (45 pays), un 4ᵉ lot de 15 pays a été ajouté :
Ukraine, Roumanie, République tchèque, Hongrie, Autriche, Irlande, Danemark,
Norvège, Finlande, Nouvelle-Zélande, Singapour, Pakistan, Bangladesh,
Éthiopie, Ghana. Détail des 3 premiers lots (45 pays) :
France, Maroc, États-Unis, Espagne, Italie, Allemagne, Royaume-Uni, Canada,
Japon, Brésil, Émirats arabes unis, Sénégal, Portugal, Égypte, Mexique,
Chine, Inde, Russie, Australie, Afrique du Sud, Nigeria, Argentine,
Pays-Bas, Suisse, Belgique, Suède, Turquie, Arabie saoudite, Indonésie,
Corée du Sud, Pologne, Grèce, Israël, Qatar, Vietnam, Thaïlande, Malaisie,
Philippines, Colombie, Chili, Pérou, Kenya, Algérie, Tunisie, Côte d'Ivoire.

## Fiche pays enrichie (15 pays phares)

Pour les 15 pays les plus détaillés d'QuickAtlas, la fiche pays s'ouvre désormais
sur une section « En savoir plus » à onglets :
- 💼 **Climat des affaires** (secteurs économiques, cadre légal — factuel,
  sans notation ni jugement)
- 🤝 **Culture** (usages sociaux et professionnels)
- 🍽️ **Gastronomie**
- 🧭 **Conseils pratiques** pour visiteurs et investisseurs étrangers
- 📅 **Jours fériés** et rythme de travail local

Un avertissement rappelle systématiquement que ces informations sont
générales et non exhaustives — à vérifier auprès d'une source officielle
avant toute décision d'affaires ou de voyage réelle.

Pour les 180 autres pays, un message « Contenu détaillé bientôt disponible »
s'affiche à la place — le contenu est dans `server/country-profiles.js`,
prêt à être étendu pays par pays (structure simple : `business_climate`,
`culture`, `gastronomy`, `practical_tips`, `holidays`).

## Fiche pays

En sélectionnant un pays (sur la carte, via la recherche, ou dans la liste),
une fiche s'affiche avec : drapeau (généré directement à partir du code pays,
aucune image à héberger), capitale, population, langues officielles, devise,
et le nombre de villes/annonces déjà référencées sur QuickAtlas pour ce pays.
Les données (capitale, population, langues) sont dans `server/country-info.js`
pour les 195 pays — au meilleur de nos connaissances, corrections bienvenues.

## Pays d'origine pré-sélectionné

Dans le formulaire de publication, le pays est deviné automatiquement à
partir du fuseau horaire du navigateur (puis, à défaut, de sa langue) et
placé en tête de la liste déroulante, déjà sélectionné — vous pouvez bien
sûr le changer.

## Messagerie entre utilisateurs

Comment les utilisateurs se contactent : via une **messagerie interne**,
comme sur Leboncoin ou Airbnb — jamais d'email ou de téléphone affiché en
clair sur une annonce, pour préserver la vie privée.

- Sur une fiche annonce, toute personne connectée qui n'est pas le
  propriétaire voit un encart **« Contacter l'annonceur »** avec un champ de
  message.
- Le premier message crée une conversation liée à cette annonce, visible
  ensuite dans l'onglet **Messages** (nouveau lien dans le menu, avec un
  badge indiquant le nombre de messages non lus).
- La messagerie est en deux volets : liste des conversations à gauche, fil
  de discussion à droite (empilés verticalement sur mobile).
- Fonctionne dans les deux sens : le propriétaire de l'annonce répond depuis
  son propre onglet Messages.

**Limite connue** : pas de notification par email quand on reçoit un
message (il faut retourner sur le site et consulter l'onglet Messages) —
une vraie messagerie temps réel ou des notifications email seraient une
évolution possible mais demanderaient un service d'envoi d'emails, non
inclus ici pour rester sans dépendance externe.

## Administration

Il existe un rôle **administrateur**, distinct des comptes normaux :
- Accès à un panneau **Administration** (visible uniquement pour les admins,
  lien caché pour tout le monde sinon) avec trois onglets :
  - **Tableau de bord** : chiffres clés (utilisateurs, admins, annonces
    actives/suspendues, nouvelles annonces et nouveaux comptes sur 7 jours,
    pays couverts) et graphiques (répartition par catégorie, par type,
    top pays, activité des 30 derniers jours).
  - **Utilisateurs** : liste de tous les comptes, promotion/rétrogradation
    du rôle administrateur, suppression d'un compte (et de ses annonces).
  - **Annonces** : liste de toutes les annonces du site, tous propriétaires
    confondus, avec possibilité de **suspendre** une annonce (masquée du
    site public mais conservée, réversible) ou de la **retirer**
    définitivement.
- Protections intégrées : impossible de supprimer ou de rétrograder le
  **dernier** compte administrateur (pour éviter de se retrouver sans accès
  admin), et un admin ne peut pas se supprimer lui-même depuis ce panneau.
- Le compte de démonstration (`demo@atlas.test`) est administrateur par défaut.

**Pour désigner votre premier vrai administrateur en production** : créez un
compte normal via le site (inscription classique), puis sur le serveur :
```bash
npm run make-admin -- votre@email.com
```
Pour retirer les droits admin à quelqu'un :
```bash
npm run make-admin -- votre@email.com --revoke
```

## Couverture géographique

QuickAtlas référence désormais **195 pays** (couverture quasi mondiale) :
- Les **15 pays d'origine** restent les plus détaillés : 6 à 8 grandes villes
  chacun, et pour 6 d'entre eux (États-Unis, Canada, Allemagne, Brésil,
  Émirats arabes unis, Mexique) un découpage complet par état/province.
- Les **180 autres pays** sont référencés avec leur capitale (et une ou
  deux grandes villes supplémentaires pour les plus vastes — ex. la Russie
  avec Moscou, Saint-Pétersbourg et Vladivostok sur trois fuseaux horaires
  différents), leur devise locale et le fuseau horaire exact de chaque ville.
  Ils sont cliquables sur la carte, cherchables et utilisables pour publier
  une annonce, mais avec moins de villes détaillées que les 15 premiers.

Cette liste couvre la quasi-totalité des États reconnus par l'ONU. Quelques
territoires contestés ou non dotés d'un code ISO officiel (ex. le Kosovo)
n'ont pas pu être inclus par cette méthode. Les données (codes ISO, devises,
fuseaux horaires) ont été saisies au meilleur de nos connaissances : en cas
d'erreur repérée sur un pays précis, signalez-le et la correction est rapide.
Vous pouvez aussi me demander d'enrichir n'importe quel pays avec davantage
de villes, à tout moment.

## Emploi

Une 5ᵉ catégorie **💼 Emploi** permet de publier des **offres d'emploi** ou des
**demandes d'emploi** (recherche de poste), avec 12 sous-catégories métier
(informatique, BTP, santé, éducation, commerce, hôtellerie-restauration,
transport, industrie, agriculture, artisanat, service à la personne, autre).
Le salaire est optionnel — une annonce peut afficher « Salaire à négocier ».

## Langues

Le site est multilingue. Le sélecteur en haut à droite propose :
- **5 langues intégralement traduites** : Français, English, العربية (avec
  bascule automatique de la mise en page en RTL), Español, Português — ces
  langues couvrent les langues officielles de la grande majorité des pays
  les plus représentés parmi les 195 référencés.
- **Un large éventail d'autres langues et dialectes officiels par pays**
  (tamazight et darija pour le Maroc, wolof pour le Sénégal, catalan/basque/
  galicien pour l'Espagne, gallois/gaélique écossais pour le Royaume-Uni,
  allemand, italien, japonais, náhuatl/maya pour le Mexique, etc.). Tant que
  leur traduction complète n'est pas disponible, le site bascule automatiquement
  vers la langue pleinement traduite la plus proche, **avec un message affiché
  clairement** à l'utilisateur plutôt qu'un changement silencieux.

Architecture : tout le texte traduit vit dans `public/js/i18n.js` (un objet
`T` par langue). Pour ajouter une langue, dupliquez un bloc existant et
traduisez ses clés, puis passez `supported: true` dans `LANGUAGE_CATALOG`.

**Limite connue** : les noms de pays, de villes, de catégories/sous-catégories
et les messages d'erreur renvoyés par le serveur restent en français quelle
que soit la langue choisie (ils sont stockés une seule fois en base de
données). Traduire ce contenu demanderait de stocker plusieurs langues par
enregistrement en base — une évolution possible mais non incluse ici.

## Se démarquer : visuel, fonctionnalités et réseaux sociaux (11 pistes)

- 🌍 **Carte vivante** : ligne jour/nuit calculée (position solaire simplifiée,
  décorative), et une **ondulation animée** apparaît sur la carte à
  l'endroit où une nouvelle annonce vient d'être publiée dans le monde.
- 🛂 **Passeport QuickAtlas** : page profil avec des tampons pour chaque pays où
  l'utilisateur a vendu ou acheté, style passeport/tampon postal.
- 🔄 **Troc / échange** : une annonce peut être marquée "ouverte à
  l'échange" avec une description ; les offres peuvent être en argent ou
  en échange.
- 📊 **Signal de demande réciproque** : endpoint agrégé (anonyme) indiquant
  combien de recherches sauvegardées correspondent à une ville/catégorie.
- 📰 **Ticker d'activité mondiale** : bandeau défilant des dernières
  annonces publiées dans le monde.
- 💬 **Contact WhatsApp** : numéro enregistrable dans "Passeport QuickAtlas",
  bouton de contact direct sur les annonces si le vendeur l'a renseigné.
- 📮 **Partage carte postale** : image générée (canvas) au style QuickAtlas,
  partagée via le partage natif du téléphone ou téléchargée.
- 🎁 **Parrainage** : lien personnel (`?ref=CODE`), crédit de mise en avant
  gratuit gagné à chaque inscription parrainée — utilisé en priorité sur
  l'activation démo lors d'une mise en avant.
- 🔐 **Connexion Google** : infrastructure complète, **à configurer** avec
  vos propres identifiants OAuth (variable d'environnement
  `GOOGLE_CLIENT_ID`) — le bouton reste discrètement masqué tant que ce
  n'est pas fait, aucune interface cassée en attendant.

Deux simplifications assumées et documentées dans le code : les "arcs de
transaction" sont devenus des ondulations (on ne connaît que le pays du
vendeur, pas de l'acheteur), et la ligne jour/nuit est une approximation
décorative, pas un calcul astronomique de précision.

## Rafraîchissement automatique (silencieux, sans recharger la page)

Toutes les 60 secondes, la liste d'annonces actuellement affichée
(annonces d'une ville, résultats par catégorie, annonces à la une) se met
à jour automatiquement en arrière-plan — sans recharger la page, sans
perdre la position de défilement. Ce rafraîchissement est **automatiquement
suspendu** si une fenêtre est ouverte (fiche annonce, formulaire...) ou si
la personne est en train de taper dans un champ, pour ne jamais interrompre
ce qu'elle fait.

## Support mobile (Android et iPhone)

Deux vrais bugs trouvés et corrigés en testant sur simulateurs iPhone et
Android : l'en-tête débordait de l'écran sur mobile (le bouton menu ☰ était
poussé hors du cadre visible par le sélecteur de langue et les boutons de
compte), provoquant un défilement horizontal indésirable. L'en-tête passe
maintenant proprement sur plusieurs lignes sur petit écran. Testé et
confirmé : plus aucun débordement, navigation tactile (tap) fonctionnelle,
menu mobile accessible, sur iPhone 14 et Google Pixel 7.

## Carte en pleine largeur d'écran

La carte du monde occupe maintenant (quasi) toute la largeur de l'écran,
en s'affranchissant de la largeur maximale de contenu (1240px) — testée à
1552px de large sur une fenêtre de 1600px, sans provoquer de défilement
horizontal indésirable, quelle que soit la taille d'écran.

## Détection automatique de la langue du visiteur

À la première visite (aucune langue choisie manuellement au préalable),
QuickAtlas **devine la langue à afficher** à partir de celle du navigateur du
visiteur (`navigator.language`) — un visiteur marocain avec un navigateur en
arabe voit le site en arabe automatiquement, un visiteur brésilien en
portugais, sans avoir à toucher au menu déroulant. Si la langue détectée est
une langue "bêta", le mécanisme de repli habituel s'applique normalement
(langue complète la plus proche + bannière d'information). **Un choix
manuel dans le menu déroulant est toujours respecté et prioritaire** : une
fois choisie explicitement, la langue est mémorisée et la détection
automatique ne s'applique plus lors des visites suivantes. Testé avec 5
langues de navigateur différentes (arabe, allemand, chinois, portugais,
japonais) + vérification qu'un choix manuel persiste bien après rechargement
de la page.

## Catalogue de langues bêta affiné

Retrait des entrées peu utiles (variantes régionales de langues déjà
pleinement supportées : français Canada, espagnol US — le Canada et les
États-Unis sont déjà bien couverts par le français/anglais et l'espagnol
complets). Ajout d'une trentaine de langues/dialectes correspondant aux
nouveaux pays à fiche enrichie (mandarin, hindi, russe, turc, hébreu, thaï,
vietnamien, coréen, polonais, grec, swahili, amharique, ourdou, bengali,
ukrainien, roumain, tchèque, hongrois, finnois, norvégien, danois, māori,
tamoul, et plusieurs langues nigérianes et sud-africaines). Catalogue passé
de 24 à 54 langues/dialectes affichés dans le sélecteur.

## Bannière : catégories sans icônes

La rangée de catégories dans la bannière d'accueil affiche maintenant les
11 catégories sous forme de pilules de texte alignées, sans icône —
présentation plus sobre et alignée.

## Page d'accueil épurée — la carte au premier plan

Avant toute interaction, la page d'accueil ne montre que : un titre condensé
("Explorez."), un message d'instruction ("Cliquez sur un pays pour découvrir
ce qui s'y échange"), une **barre de recherche discrète** toujours
accessible, et la **carte du monde** en grand format. Le bandeau "en ce
moment sur QuickAtlas", les pilules de catégories, les statistiques, les
"Annonces à la une" et "Vus récemment" restent masqués tant qu'aucun pays
n'a été sélectionné (ou qu'aucune recherche texte n'a été lancée) — l'objet
du site ne se dévoile qu'à ce moment-là, avec une légère animation
d'apparition. Testé : tout reste bien caché avant le premier clic, tout
apparaît correctement après.

## Bannière d'accueil

En haut de la page d'accueil : une barre de recherche centrale bien visible,
une rangée d'icônes cliquables pour naviguer directement par catégorie (tous
pays confondus, avec fil d'Ariane et filtres), et une bannière "en ce moment
sur QuickAtlas" mettant en avant l'annonce la plus consultée du site. Structure
inspirée des grandes places de marché généralistes, mais avec l'identité
visuelle propre à QuickAtlas (voir `CHARTE-GRAPHIQUE.md`) — aucun élément de
marque tiers n'est repris.

## Type d'annonce "Achat" (petites annonces "je recherche")

En plus de Vente et Location, toute annonce (hors catégorie Emploi, qui a
déjà son propre "Offre" / "Demande") peut être publiée en type **Achat** —
une annonce "je recherche à acheter", symétrique de "Vente". Le prix devient
alors un budget maximum optionnel ("Jusqu'à 500 €" ou "Budget à définir" si
non précisé). Disponible dans le formulaire de publication, les filtres
d'exploration par ville et la navigation par catégorie depuis la bannière.

## Catégories et sous-catégories

Arborescence large (11 catégories, près de 90 sous-catégories au total),
inspirée de la couverture des grandes places de marché généralistes mais
avec une structure et des libellés propres à QuickAtlas :

- 🏠 **Immobilier** : appartement, maison/villa, terrain, bureau/local
  commercial, entrepôt/local industriel, chambre, location de vacances.
- 🚗 **Véhicules** : voiture, moto/scooter, camion, utilitaire, caravane/
  camping-car, bateau, vélo, pièces & accessoires.
- 👗 **Mode & Accessoires** : vêtements femme, vêtements homme, chaussures,
  sacs & maroquinerie, bijoux & montres, autre.
- 🏡 **Maison & Jardin** : électroménager, meubles, décoration, linge de
  maison, outils & bricolage, jardin & extérieur.
- 📱 **Multimédia & Électronique** : téléphones & objets connectés,
  ordinateurs & tablettes, image & son, jeux vidéo & consoles.
- 🧸 **Famille & Enfants** : vêtements enfants, jouets & jeux, puériculture,
  mobilier enfant.
- ⚽ **Loisirs & Sport** : sport & fitness, instruments de musique, livres &
  BD, collection, camping & plein air.
- 🛠️ **Matériel professionnel** : équipement industriel, mobilier de bureau,
  matériel agricole, matériel BTP, commerce & restauration.
- 🧰 **Services** : cours & formations, services à la personne, réparation &
  dépannage, événementiel, autre service.
- 💼 **Emploi** : informatique & tech, BTP & construction, santé, éducation &
  formation, commerce & vente, hôtellerie & restauration, transport &
  logistique, industrie & production, agriculture, artisanat, service à la
  personne, autre. Type d'annonce : offre d'emploi ou demande d'emploi.
- 📦 **Autres** : divers (catégorie de repli pour tout ce qui ne rentre pas
  ailleurs).

Toutes les catégories sont accessibles depuis la **rangée d'icônes en haut
de la page d'accueil** (navigation directe par catégorie, tous pays
confondus, avec fil d'Ariane et filtres sous-catégorie/type/tri) en plus de
la navigation géographique habituelle par la carte.

La sous-catégorie s'adapte automatiquement à la catégorie choisie, aussi bien
à la publication qu'au filtrage des annonces.

## Installation et lancement

```bash
node --version        # doit être >= 22.5.0
npm run seed           # crée data/atlas.db et le peuple (195 pays, ~300 villes, annonces de démo)
npm start               # démarre le serveur sur http://localhost:3000
```

Puis ouvrez `http://localhost:3000`.

**Compte de démonstration** : `demo@atlas.test` / `demo1234` (propriétaire des
annonces de démo — vous pouvez aussi créer votre propre compte).

Pour repartir d'une base vide : supprimez `data/atlas.db` puis relancez `npm run seed`.

## Ce qui est fonctionnel dès maintenant

- Carte du monde interactive (D3 + fond de carte `world-atlas`), zoom/pan
  (molette, glisser, ou boutons +/−/reset), clic sur un pays.
- **195 pays référencés dans le monde**, dont **6 pays fédéraux divisés par
  état/province** (États-Unis, Canada, Allemagne, Brésil, Émirats arabes
  unis, Mexique) : on choisit un pays → un état/une province → une ville.
  Tous les autres pays restent en accès direct pays → ville (voir la section
  « Couverture mondiale » ci-dessous pour le détail).
- **Recherche de pays** en liste déroulante avec filtre en direct.
- **Prix dans la devise locale de chaque pays**, avec un **convertisseur de
  devises** : un sélecteur "Afficher les prix en" convertit à la volée tous
  les prix affichés (taux de change récupérés via une API publique au
  chargement de la page ; si hors connexion, les prix restent affichés
  dans leur devise locale, sans conversion).
- **Fuseau horaire et heure exacte** : dès qu'une ville est sélectionnée,
  son heure locale s'affiche et se met à jour en temps réel (fuseau IANA
  propre à chaque ville, pas seulement au pays — utile pour les pays
  qui couvrent plusieurs fuseaux).
- **4 catégories avec sous-catégories obligatoires** pour préciser la
  nature exacte du bien (immobilier, véhicules, électroménager, objets —
  détail au chapitre suivant).
- **Recherche globale**, **annonces à la une**, **barre de statistiques**.
- Inscription / connexion (tokens signés, mots de passe hachés en scrypt+sel).
- Publication d'une annonce avec cascade pays → état (si applicable) →
  ville, catégorie → sous-catégorie, devise pré-remplie automatiquement.
- Filtres par catégorie, sous-catégorie, type (vente/location), recherche texte.
- Tableau de bord "Mes annonces".
- Section "Comment ça marche", pied de page, design responsive.
- **Charte graphique complète** : voir [`CHARTE-GRAPHIQUE.md`](./CHARTE-GRAPHIQUE.md)
  (palette, typographie, composants, règles d'usage).

> **Si vous aviez déjà lancé une version précédente du projet**, supprimez le
> fichier `data/atlas.db` (ou tout le dossier `data`) puis relancez
> `npm run seed` : le schéma a changé (états/provinces, devises, fuseaux
> horaires, sous-catégories).

## Limites connues et pistes d'évolution

Ce livrable est un **produit complet et fonctionnel en local**, mais je n'ai
pas d'accès à un environnement d'hébergement en direct depuis cette conversation :
je ne peux donc pas vous fournir une URL publique déjà en ligne. Pour le mettre
en ligne, plusieurs options simples :
- Un VPS ou un service comme Render / Railway / Fly.io (Node.js pur, pas de
  configuration exotique nécessaire).
- Remplacer `node:sqlite` par Postgres/MySQL si vous prévoyez une forte charge
  ou du multi-serveur (`node:sqlite` est parfait pour démarrer, moins pour
  scaler horizontalement).

Autres limites à connaître :
- **Images** : les annonces utilisent une URL d'image externe (pas d'upload de
  fichier depuis le poste de l'utilisateur). Ajouter un vrai upload demande un
  stockage (disque, S3…) — non inclus ici pour rester sans dépendance.
- **Pays/villes** : 195 pays sont référencés (voir « Couverture mondiale »),
  mais seuls les 15 pays d'origine ont plusieurs villes détaillées et des
  annonces de démonstration. Ajouter des villes à un pays se fait aujourd'hui
  directement dans `server/seed.js` ; il n'y a pas encore d'interface
  d'administration pour ça.
- **Modération, messagerie entre utilisateurs, paiement en ligne** : non
  implémentés. Ce sont les extensions naturelles si vous voulez aller plus loin.
- Le module `node:sqlite` est encore marqué *expérimental* par Node.js (stable
  dans son usage mais l'API peut changer dans de futures versions de Node).

## Structure du projet

```
marketplace/
├── server/
│   ├── server.js     # serveur HTTP + toutes les routes /api
│   ├── db.js         # connexion SQLite + schéma
│   ├── auth.js        # hachage mots de passe + tokens signés
│   └── seed.js         # données de démonstration
├── public/
│   ├── index.html
│   ├── css/style.css
│   └── js/
│       ├── app.js       # logique front (carte, appels API, formulaires)
│       └── i18n.js      # traductions et catalogue de langues/dialectes
├── CHARTE-GRAPHIQUE.md # identité visuelle et éditoriale du site
└── data/               # base SQLite (créée au premier `npm run seed`)
```
