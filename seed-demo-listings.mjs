// ============================================================================
// Script d'injection d'annonces de démonstration — QuickAtlas
// ============================================================================
// À exécuter sur le site principal via le Shell Render :
//   node seed-demo-listings.mjs
//
// Toutes les annonces créées ici sont marquées is_demo = 1 : elles
// affichent automatiquement un filigrane "Démo" visible pour tout
// visiteur (voir app.js, .demo-watermark) — transparence totale, aucune
// annonce ne prétend être réelle. Rattachées à un compte fictif
// clairement identifié comme tel ("Compte Démonstration QuickAtlas"),
// jamais au nom d'une entreprise réelle existante.
//
// Photos via picsum.photos — banque d'images libres de droits, sans
// lien avec le contenu exact de l'annonce (aucune photo réelle du bien
// décrit n'existe, ce serait mentir sur la nature même de la photo).
// ============================================================================
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import crypto from 'node:crypto';

const DB_PATH = path.join(process.cwd(), 'data', 'atlas.db');
const db = new DatabaseSync(DB_PATH);

console.log('=== Injection des annonces de démonstration ===');
console.log('Base de données :', DB_PATH);

// ---------------------------------------------------------------------------
// 1. Compte de démonstration — un seul compte, clairement identifié
// ---------------------------------------------------------------------------
const demoEmail = 'demo@quickatlas.net';
let demoUser = db.prepare('SELECT id FROM users WHERE email = ?').get(demoEmail);
if (!demoUser) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync('compte-demo-non-connectable', salt, 100000, 64, 'sha256').toString('hex');
  const result = db.prepare(
    "INSERT INTO users (name, email, password_hash, password_salt, role, phone) VALUES (?, ?, ?, ?, 'user', ?)"
  ).run('Compte Démonstration QuickAtlas', demoEmail, hash, salt, '+212600000000');
  demoUser = { id: Number(result.lastInsertRowid) };
  console.log('✅ Compte démo créé, id =', demoUser.id);
} else {
  console.log('ℹ️  Compte démo déjà existant, id =', demoUser.id);
}

// Nettoyage préalable — rend le script sûr à relancer plusieurs fois
// (par exemple après une interruption), sans jamais créer de doublons.
const cleaned = db.prepare('DELETE FROM listings WHERE user_id = ?').run(demoUser.id);
if (cleaned.changes > 0) console.log(`🧹 ${cleaned.changes} ancienne(s) annonce(s) démo supprimée(s) avant réinjection.`);

// ---------------------------------------------------------------------------
// 2. Villes marocaines utilisées — recherchées par nom, jamais par id
//    en dur (l'ordre d'insertion peut varier).
// ---------------------------------------------------------------------------
function findCity(name) {
  const row = db.prepare('SELECT id FROM cities WHERE name = ? LIMIT 1').get(name);
  if (!row) throw new Error(`Ville introuvable : ${name} — vérifiez qu'elle existe bien dans la base.`);
  return row.id;
}
const CASABLANCA = findCity('Casablanca');
const RABAT = findCity('Rabat');
const MARRAKECH = findCity('Marrakech');
const TANGER = findCity('Tanger');
const FES = findCity('Fès');
const AGADIR = findCity('Agadir');

// Normalise les apostrophes (courbe ’ vs droite ') avant comparaison —
// les noms de catégories peuvent avoir été saisis avec l'une ou
// l'autre selon le moment de leur création.
function normalizeApostrophes(s) {
  return s.replace(/[\u2018\u2019\u02BC]/g, "'");
}
function findCategory(name) {
  const target = normalizeApostrophes(name);
  const rows = db.prepare('SELECT id, name FROM categories').all();
  const match = rows.find((r) => normalizeApostrophes(r.name) === target);
  if (!match) throw new Error(`Catégorie introuvable : ${name} (catégories disponibles : ${rows.map((r) => r.name).join(', ')})`);
  return match.id;
}
function findSubcategory(categoryId, name) {
  const target = normalizeApostrophes(name);
  const rows = db.prepare('SELECT id, name FROM subcategories WHERE category_id = ?').all(categoryId);
  const match = rows.find((r) => normalizeApostrophes(r.name) === target);
  return match ? match.id : null;
}

// ---------------------------------------------------------------------------
// 3. Images "carousel" — plusieurs photos par annonce, banque libre de
//    droits, seed différente à chaque annonce pour varier les visuels.
// ---------------------------------------------------------------------------
let imgSeed = 100;
function carousel(count = 4) {
  const urls = [];
  for (let i = 0; i < count; i++) {
    urls.push(`https://picsum.photos/seed/qa-demo-${imgSeed}/900/650`);
    imgSeed++;
  }
  return JSON.stringify(urls);
}

// ---------------------------------------------------------------------------
// 4. Insertion générique
// ---------------------------------------------------------------------------
const insertListing = db.prepare(`
  INSERT INTO listings (
    user_id, city_id, category_id, subcategory_id, title, description,
    listing_type, price, currency, images_json, language, status,
    is_demo, capacity_guests, bedrooms, bathrooms, surface_m2, num_rooms,
    vehicle_brand, vehicle_model, vehicle_year, vehicle_mileage, vehicle_condition,
    vehicle_transmission, vehicle_fuel_type, job_contract_type, job_remote_type,
    job_sector, activity_duration, activity_group_size_min, activity_group_size_max,
    activity_languages, activity_meeting_point, activity_difficulty, property_room_type,
    num_beds, cancellation_policy, activity_included, activity_excluded
  ) VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active',
    1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
  )
`);

function seed(l) {
  insertListing.run(
    demoUser.id, l.city, l.category, l.subcategory || null, l.title, l.description,
    l.listing_type, l.price ?? null, l.currency || 'MAD', carousel(l.images || 4), 'fr',
    l.capacity_guests ?? null, l.bedrooms ?? null, l.bathrooms ?? null, l.surface_m2 ?? null, l.num_rooms ?? null,
    l.vehicle_brand ?? null, l.vehicle_model ?? null, l.vehicle_year ?? null, l.vehicle_mileage ?? null, l.vehicle_condition ?? null,
    l.vehicle_transmission ?? null, l.vehicle_fuel_type ?? null, l.job_contract_type ?? null, l.job_remote_type ?? null,
    l.job_sector ?? null, l.activity_duration ?? null, l.activity_group_size_min ?? null, l.activity_group_size_max ?? null,
    l.activity_languages ?? null, l.activity_meeting_point ?? null, l.activity_difficulty ?? null, l.property_room_type ?? null,
    l.num_beds ?? null, l.cancellation_policy ?? null, l.activity_included ?? null, l.activity_excluded ?? null
  );
  console.log(`  ✓ ${l.title}`);
}

console.log('\n--- Immobilier ---');
{
  const cat = findCategory('Immobilier');
  seed({ city: CASABLANCA, category: cat, title: 'Appartement 3 pièces, vue dégagée', description: 'Bel appartement lumineux de 85 m², proche des commerces et transports. Cuisine équipée, double exposition.', listing_type: 'vente', price: 1250000, surface_m2: 85, num_rooms: 3 });
  seed({ city: MARRAKECH, category: cat, title: 'Riad rénové, cœur de médina', description: 'Riad traditionnel entièrement rénové, patio central, 4 chambres, terrasse panoramique.', listing_type: 'vente', price: 3200000, surface_m2: 220, num_rooms: 4 });
}

console.log('\n--- Véhicules ---');
{
  const cat = findCategory('Véhicules');
  seed({ city: RABAT, category: cat, title: 'Berline hybride, faible kilométrage', description: 'Véhicule entretenu, carnet à jour, première main. Consommation très économique.', listing_type: 'vente', price: 245000, vehicle_brand: 'Toyota', vehicle_model: 'Corolla Hybride', vehicle_year: 2022, vehicle_mileage: 32000, vehicle_condition: 'tres_bon_etat', vehicle_transmission: 'automatique', vehicle_fuel_type: 'hybride' });
  seed({ city: TANGER, category: cat, title: 'SUV familial 7 places', description: 'Spacieux et confortable, idéal grande famille. Climatisation, régulateur de vitesse.', listing_type: 'vente', price: 312000, vehicle_brand: 'Hyundai', vehicle_model: 'Santa Fe', vehicle_year: 2021, vehicle_mileage: 48000, vehicle_condition: 'bon_etat', vehicle_transmission: 'automatique', vehicle_fuel_type: 'diesel' });
}

console.log('\n--- Mode & Accessoires ---');
{
  const cat = findCategory('Mode & Accessoires');
  seed({ city: CASABLANCA, category: cat, title: 'Sac à main cuir véritable, neuf', description: 'Sac élégant en cuir pleine fleur, jamais porté, avec dustbag d\u2019origine.', listing_type: 'vente', price: 890, images: 3 });
}

console.log('\n--- Maison & Jardin ---');
{
  const cat = findCategory('Maison & Jardin');
  seed({ city: RABAT, category: cat, title: 'Canapé d\u2019angle convertible', description: 'Très bon état, tissu gris anthracite, coffre de rangement intégré.', listing_type: 'vente', price: 3400, images: 3 });
}

console.log('\n--- Multimédia & Électronique ---');
{
  const cat = findCategory('Multimédia & Électronique');
  seed({ city: MARRAKECH, category: cat, title: 'Ordinateur portable, usage bureautique', description: 'Excellent état, batterie encore performante, livré avec chargeur d\u2019origine.', listing_type: 'vente', price: 4200, images: 3 });
}

console.log('\n--- Famille & Enfants ---');
{
  const cat = findCategory('Famille & Enfants');
  seed({ city: FES, category: cat, title: 'Poussette 3 roues, tout-terrain', description: 'Très maniable, panier de rangement, capote anti-UV. État impeccable.', listing_type: 'vente', price: 1600, images: 3 });
}

console.log('\n--- Loisirs & Sport ---');
{
  const cat = findCategory('Loisirs & Sport');
  seed({ city: AGADIR, category: cat, title: 'Planche de surf débutant/intermédiaire', description: '7\u20192, mousse renforcée, idéale pour progresser rapidement.', listing_type: 'vente', price: 1800, images: 3 });
}

console.log('\n--- Matériel professionnel ---');
{
  const cat = findCategory('Matériel professionnel');
  seed({ city: CASABLANCA, category: cat, title: 'Photocopieur multifonction professionnel', description: 'Faible compteur, révisé récemment, idéal petite structure ou cabinet.', listing_type: 'vente', price: 8500, images: 3 });
}

console.log('\n--- Services ---');
{
  const cat = findCategory('Services');
  seed({ city: RABAT, category: cat, title: 'Cours particuliers de mathématiques', description: 'Professeur expérimenté, collège et lycée, déplacement possible ou en ligne.', listing_type: 'vente', price: 150, images: 2 });
}

console.log('\n--- Emploi ---');
{
  const cat = findCategory('Emploi');
  seed({ city: CASABLANCA, category: cat, title: 'Développeur web full-stack', description: 'Rejoignez une équipe dynamique, stack moderne, télétravail partiel possible.', listing_type: 'offre_emploi', job_contract_type: 'cdi', job_remote_type: 'hybride', job_sector: 'Technologie', images: 3 });
}

console.log('\n--- Opportunités d\u2019affaires ---');
{
  const cat = findCategory('Opportunités d\u2019affaires');
  seed({ city: TANGER, category: cat, title: 'Fonds de commerce, café bien situé', description: 'Emplacement passant, clientèle fidélisée, murs non inclus. Idéal repreneur.', listing_type: 'vente', price: 450000, images: 3 });
}

console.log('\n--- Autres ---');
{
  const cat = findCategory('Autres');
  seed({ city: FES, category: cat, title: 'Collection de livres anciens', description: 'Une trentaine d\u2019ouvrages, bon état de conservation, vente en lot uniquement.', listing_type: 'vente', price: 600, images: 2 });
}

console.log('\n--- Tourisme & Voyages ---');
{
  const cat = findCategory('Tourisme & Voyages');
  const subLocations = findSubcategory(cat, 'Locations de vacances');
  const subActivites = findSubcategory(cat, 'Activités & Excursions');
  const subInsolite = findSubcategory(cat, 'Hôtellerie & Hébergements insolites');

  seed({
    city: MARRAKECH, category: cat, subcategory: subLocations,
    title: 'Villa avec piscine, 4 chambres', description: 'Villa spacieuse avec jardin et piscine privée, idéale séjour en famille ou entre amis.',
    listing_type: 'location', price: 1800, price_type: 'nuit', capacity_guests: 8, bedrooms: 4, bathrooms: 3,
    property_room_type: 'entire_place', num_beds: 5, cancellation_policy: 'moderee', images: 5,
  });
  seed({
    city: AGADIR, category: cat, subcategory: subActivites,
    title: 'Excursion quad dans le désert', description: 'Sortie encadrée d\u2019une demi-journée à travers les dunes, coucher de soleil inclus.',
    listing_type: 'vente', price: 450, activity_duration: 'Demi-journée', activity_group_size_min: 2, activity_group_size_max: 12,
    activity_languages: 'Français, Anglais, Arabe', activity_meeting_point: 'Hôtel (prise en charge incluse)',
    activity_difficulty: 'facile', activity_included: 'Guide, équipement de sécurité, collation', activity_excluded: 'Boissons, pourboires',
    cancellation_policy: 'flexible', images: 4,
  });
  seed({
    city: FES, category: cat, subcategory: subInsolite,
    title: 'Nuit dans un riad-boutique, médina', description: 'Hébergement de charme au cœur de la médina classée, petit-déjeuner traditionnel inclus.',
    listing_type: 'location', price: 950, price_type: 'nuit', capacity_guests: 2, bedrooms: 1, bathrooms: 1,
    property_room_type: 'private_room', num_beds: 1, cancellation_policy: 'stricte', images: 4,
  });
}

console.log('\n🎉 Injection terminée.');
const total = db.prepare('SELECT COUNT(*) AS n FROM listings WHERE is_demo = 1').get();
console.log('Total d\u2019annonces démo en base :', total.n);
db.close();
