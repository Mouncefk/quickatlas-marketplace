# Charte graphique — QuickAtlas

Cette charte fixe l'identité visuelle et éditoriale d'QuickAtlas, pour que toute
nouvelle page, tout nouvel écran ou toute communication reste reconnaissable
et cohérente avec le reste du site.

---

## 1. Identité de marque

**Nom** : QuickAtlas
**Positionnement** : une place de marché mondiale pour l'achat, la vente et
la location de tout type de bien (immobilier, véhicules, électroménager,
objets), organisée par géographie — on explore le monde comme on consulte
un atlas, pays par pays, ville par ville.

**Idée directrice** : la cartographie ancienne rencontre un outil numérique
d'aujourd'hui. Le site emprunte au vocabulaire visuel des atlas et cartes
marines (encre, laiton, coordonnées, boussole) tout en restant net, rapide
et fonctionnel.

**Ton de voix** :
- Direct et rassurant, jamais commercial ou tape-à-l'œil.
- Vocabulaire de l'exploration et de la géographie utilisé avec parcimonie
  ("repérez", "explorez", "coordonnées"), sans forcer la métaphore.
- Toujours en français, vouvoiement, phrases courtes.

**Logo** : une rose des vents simplifiée (croix à quatre branches inscrite
dans un cercle) accompagnée du mot-symbole **QUICKATLAS** en petites capitales
espacées. Le symbole seul peut être utilisé comme favicon ou avatar ; le
mot-symbole ne doit jamais être réécrit dans une autre police que celle de
la charte (voir §3).

---

## 2. Palette de couleurs

| Rôle | Nom | Hex | Usage |
|---|---|---|---|
| Fond principal | Encre marine 900 | `#0E1B2E` | Fond de page |
| Surface | Encre marine 700 | `#16273F` | Cartes, champs, panneaux |
| Surface alternative | Encre marine 800 | `#122238` | Bandeaux (comment ça marche), variante de fond |
| Surface accentuée | Encre marine 600 | `#1E3350` | Survol, éléments actifs |
| Texte / fond clair | Parchemin 100 | `#F1E9D8` | Texte principal, fonds clairs ponctuels |
| Parchemin secondaire | Parchemin 200 | `#E7DCC4` | Variante de surface claire |
| Accent primaire | Laiton 500 | `#C6A15B` | Liens, focus, éléments de mise en valeur |
| Accent primaire clair | Laiton 300 | `#DDC48C` | Titres en italique, emphase |
| Accent d'action | Rouille 600 | `#B5482E` | Boutons principaux, call-to-action, alertes |
| Accent d'action (survol) | Rouille 700 | `#96391F` | État survolé/actif des boutons principaux |
| Accent secondaire | Sarcelle 500 | `#4C8C82` | Étiquettes "location", liens secondaires, légendes carte |
| Trait de séparation | Ligne encre | `rgba(241,233,216,0.14)` | Bordures, séparateurs |

**Règles d'usage :**
- Le fond de page reste toujours une encre marine (jamais blanc pur, jamais noir pur).
- Le rouille est réservé aux actions principales (boutons "Publier", "Rechercher",
  "Se connecter") — ne pas l'utiliser pour du texte courant.
- Le laiton signale ce qui est cliquable ou mis en avant (liens, montants
  convertis, éléments actifs de la carte).
- Le sarcelle est la couleur des métadonnées et des états secondaires
  (ex. "location" vs "vente", légendes).
- Contraste : le texte principal (parchemin 100 sur encre 900) offre un
  ratio > 12:1, largement au-dessus du minimum AA. Ne jamais poser du texte
  laiton sur un fond parchemin, ni l'inverse — le contraste chute trop.

---

## 3. Typographie

| Usage | Police | Poids | Exemple |
|---|---|---|---|
| Titres (h1, h2, h3) | **Fraunces** (serif) | 400–600, parfois italique | "Achetez, vendez, louez —" |
| Texte courant, interface | **Inter** (sans-serif) | 400–600 | Paragraphes, boutons, formulaires |
| Données, coordonnées, prix, heures | **IBM Plex Mono** | 400–500 | "48.8566° N", prix, minuteur d'heure locale |

**Règles d'usage :**
- Fraunces est réservée aux titres et à l'emphase (ex. le mot final d'un
  h1 en italique laiton). Ne jamais l'utiliser pour du texte de plus de
  2-3 lignes.
- IBM Plex Mono signale une **donnée** : un prix, une heure, un fuseau
  horaire, un pourcentage, un identifiant. C'est un repère visuel pour
  l'utilisateur : "ceci est une valeur factuelle".
- Inter est la police par défaut pour tout le reste (descriptions,
  boutons, menus, formulaires).
- Échelle de titres : h1 `clamp(2rem, 4.2vw, 3.4rem)`, h2 `1.5rem`.
  Ne pas descendre sous `0.7rem` pour du texte lisible (les libellés
  "eyebrow" en `0.72rem` sont la limite basse acceptée, réservée aux
  étiquettes courtes en majuscules).

---

## 4. Grille, espacement et forme

- Largeur de contenu maximale : `1240px`, centrée, avec un padding latéral
  de `24px` (`16px` en mobile).
- Rayon de bordure standard : `4px` pour les champs et petits éléments,
  `8px` pour les cartes et panneaux, `10px` pour les modales.
- Grilles de cartes/vignettes en `auto-fill, minmax(190–260px, 1fr)` pour
  s'adapter naturellement à toutes les largeurs d'écran.
- Un seul niveau d'ombre portée (`--shadow-lift`) réservé aux éléments
  flottants (modales, menus déroulants) — ne pas ajouter d'ombre sur les
  cartes ou boutons au repos, seulement au survol si besoin (translation
  verticale légère, pas d'ombre supplémentaire).

---

## 5. Composants

**Boutons**
- Primaire (`btn--primary`) : fond rouille, texte parchemin — une seule
  action principale par écran/formulaire.
- Fantôme (`btn--ghost`) : transparent, bordure fine, devient laiton au
  survol — pour les actions secondaires.
- Danger (`btn--danger`) : contour rouille foncé, se remplit au survol —
  réservé aux suppressions.

**Cartes d'annonce**
- Image en 4:3, fond encre 600 si absente (jamais de gris neutre).
- Étiquette catégorie/nature en IBM Plex Mono, petites capitales,
  sarcelle (vente) ou laiton clair (location).
- Prix toujours en dernier, en IBM Plex Mono, taille légèrement supérieure
  au reste de la carte.

**Champs de formulaire**
- Fond encre 700, bordure fine encre-line, passe en laiton au focus.
- Toujours un `<label>` visible au-dessus du champ (jamais de placeholder
  utilisé comme seul label).

**Fil d'Ariane / navigation contextuelle**
- Toujours en IBM Plex Mono, séparateurs " / ", dernier niveau non cliquable.

**Badges de nature/catégorie**
- Icône emoji + libellé, jamais de couleur de fond pleine — texte coloré
  sur fond transparent uniquement.

---

## 6. Carte du monde

- Pays "au repos" : encre 600 clair (`#223755`).
- Pays référencé sur QuickAtlas (au moins une ville en base) : légèrement
  éclairci (`#2C4A6E`) pour signaler qu'il est explorable.
- Pays survolé : sarcelle. Pays sélectionné : rouille plein.
- Pas de nom de pays affiché en permanence sur la carte (choix retenu
  après test) : l'information apparaît au survol (infobulle native) et
  surtout dans la liste déroulante de recherche, plus lisible.
- Les frontières restent fines (0.5px) et de la couleur du fond, pour
  garder un rendu "gravure" plutôt que "carte politique" colorée.

---

## 7. Ton éditorial et micro-copie

- Toujours au vouvoiement, jamais de tutoiement.
- Les messages d'erreur expliquent **quoi corriger**, jamais un simple
  "erreur" sec (ex. *"Merci de préciser la nature exacte du bien"* plutôt
  que *"Champ invalide"*).
- Les états vides sont toujours actionnables : proposer un bouton ou une
  suggestion plutôt qu'une phrase morte (ex. *"Aucune annonce ici pour
  l'instant. Soyez le·la premier·ère à publier."*).
- Unités et devises toujours explicites (jamais un nombre seul) ; heure
  locale toujours accompagnée du fuseau horaire.

---

## 8. À faire / à éviter

**À faire**
- Réutiliser systématiquement les variables CSS définies dans
  `public/css/style.css` (`:root`) plutôt que des couleurs codées en dur.
- Garder un seul call-to-action rouille visible à la fois par écran.
- Toujours accompagner un prix converti du prix natif (transparence sur
  le taux de change utilisé).

**À éviter**
- Ne pas introduire de nouvelle couleur d'accent sans l'ajouter ici.
- Ne pas utiliser Fraunces pour de longs paragraphes (perte de lisibilité).
- Ne pas empiler plusieurs boutons `btn--primary` côte à côte.
- Ne pas afficher un prix sans devise, ni une heure sans fuseau horaire.

---

## 9. Sélecteur de langues

- Le sélecteur de langue reste discret dans l'en-tête (police Inter, petite
  taille), jamais un élément visuellement dominant.
- Une langue non encore pleinement traduite s'accompagne toujours d'un bandeau
  explicatif (`.lang-fallback-note`, fond encre 800, texte sarcelle, police
  mono) — jamais de bascule silencieuse vers une autre langue.
- En arabe (RTL), la mise en page s'inverse automatiquement, mais les valeurs
  numériques (prix, statistiques, heures) restent toujours affichées de
  gauche à droite pour rester lisibles sans ambiguïté.

## 10. Accessibilité

- Contraste texte/fond validé AA minimum sur toutes les combinaisons
  définies au §2.
- Tous les champs interactifs ont un `:focus-visible` visible (contour
  laiton, jamais supprimé).
- Les animations respectent `prefers-reduced-motion` (déjà géré
  globalement dans `style.css`).
- Le composant de recherche de pays est navigable au clavier (flèches,
  Entrée, Échap) et utilise les rôles ARIA `combobox`/`listbox`.
