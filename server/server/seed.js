// seed.js — Peuple la base avec des pays, villes, catégories et quelques annonces de démo.
// Les codes iso_numeric correspondent aux identifiants utilisés par le fond de carte
// (world-atlas / ISO 3166-1 numeric), ce qui permet de relier un pays cliqué sur la carte
// à ses villes en base sans dépendre du nom affiché.
import { db } from './db.js';
import { hashPassword } from './auth.js';
import { COUNTRY_INFO } from './country-info.js';
import { COUNTRY_PROFILES } from './country-profiles.js';

const countryCount = db.prepare('SELECT COUNT(*) AS c FROM countries').get().c;
if (countryCount > 0) {
  console.log('La base contient déjà des données — seed ignoré. Supprimez data/atlas.db pour reseed.');
  process.exit(0);
}

// Chaque pays : { name, iso2, isoNum, currency, federal }
// - federal: false -> cities: [[ville, fuseau horaire IANA], ...]
// - federal: true  -> states: [[état, code, [[ville, fuseau horaire IANA], ...]], ...]
const countries = [
  { name: 'France', iso2: 'FR', isoNum: '250', currency: 'EUR', federal: false, cities: [
    ['Paris', 'Europe/Paris'], ['Marseille', 'Europe/Paris'], ['Lyon', 'Europe/Paris'],
    ['Toulouse', 'Europe/Paris'], ['Nice', 'Europe/Paris'], ['Nantes', 'Europe/Paris'],
    ['Strasbourg', 'Europe/Paris'], ['Bordeaux', 'Europe/Paris'], ['Lille', 'Europe/Paris'],
    ['Rennes', 'Europe/Paris'], ['Montpellier', 'Europe/Paris'], ['Reims', 'Europe/Paris'],
  ]},
  { name: 'Maroc', iso2: 'MA', isoNum: '504', currency: 'MAD', federal: false, cities: [
    ['Casablanca', 'Africa/Casablanca'], ['Rabat', 'Africa/Casablanca'], ['Marrakech', 'Africa/Casablanca'],
    ['Fès', 'Africa/Casablanca'], ['Tanger', 'Africa/Casablanca'], ['Agadir', 'Africa/Casablanca'],
    ['Meknès', 'Africa/Casablanca'], ['Kénitra', 'Africa/Casablanca'], ['Oujda', 'Africa/Casablanca'],
    ['Tétouan', 'Africa/Casablanca'],
  ]},
  { name: 'États-Unis', iso2: 'US', isoNum: '840', currency: 'USD', federal: true, states: [
    ['New York', 'NY', [['New York', 'America/New_York']]],
    ['Californie', 'CA', [['Los Angeles', 'America/Los_Angeles'], ['San Francisco', 'America/Los_Angeles'], ['San Diego', 'America/Los_Angeles']]],
    ['Illinois', 'IL', [['Chicago', 'America/Chicago']]],
    ['Texas', 'TX', [['Houston', 'America/Chicago'], ['Austin', 'America/Chicago'], ['Dallas', 'America/Chicago']]],
    ['Floride', 'FL', [['Miami', 'America/New_York'], ['Orlando', 'America/New_York']]],
    ['Washington', 'WA', [['Seattle', 'America/Los_Angeles']]],
    ['Massachusetts', 'MA', [['Boston', 'America/New_York']]],
    ['Pennsylvanie', 'PA', [['Philadelphie', 'America/New_York']]],
    ['Colorado', 'CO', [['Denver', 'America/Denver']]],
    ['Géorgie (US)', 'GA', [['Atlanta', 'America/New_York']]],
    ['District de Columbia', 'DC', [['Washington D.C.', 'America/New_York']]],
  ]},
  { name: 'Espagne', iso2: 'ES', isoNum: '724', currency: 'EUR', federal: false, cities: [
    ['Madrid', 'Europe/Madrid'], ['Barcelone', 'Europe/Madrid'], ['Valence', 'Europe/Madrid'],
    ['Séville', 'Europe/Madrid'], ['Bilbao', 'Europe/Madrid'], ['Malaga', 'Europe/Madrid'],
    ['Saragosse', 'Europe/Madrid'], ['Palma', 'Europe/Madrid'], ['Alicante', 'Europe/Madrid'],
  ]},
  { name: 'Italie', iso2: 'IT', isoNum: '380', currency: 'EUR', federal: false, cities: [
    ['Rome', 'Europe/Rome'], ['Milan', 'Europe/Rome'], ['Naples', 'Europe/Rome'],
    ['Turin', 'Europe/Rome'], ['Florence', 'Europe/Rome'], ['Venise', 'Europe/Rome'],
    ['Bologne', 'Europe/Rome'], ['Palerme', 'Europe/Rome'], ['Gênes', 'Europe/Rome'],
  ]},
  { name: 'Allemagne', iso2: 'DE', isoNum: '276', currency: 'EUR', federal: true, states: [
    ['Berlin', 'BE', [['Berlin', 'Europe/Berlin']]],
    ['Bavière', 'BY', [['Munich', 'Europe/Berlin']]],
    ['Hambourg', 'HH', [['Hambourg', 'Europe/Berlin']]],
    ['Rhénanie-du-Nord-Westphalie', 'NW', [['Cologne', 'Europe/Berlin'], ['Düsseldorf', 'Europe/Berlin']]],
    ['Hesse', 'HE', [['Francfort', 'Europe/Berlin']]],
    ['Bade-Wurtemberg', 'BW', [['Stuttgart', 'Europe/Berlin']]],
    ['Saxe', 'SN', [['Leipzig', 'Europe/Berlin'], ['Dresde', 'Europe/Berlin']]],
  ]},
  { name: 'Royaume-Uni', iso2: 'GB', isoNum: '826', currency: 'GBP', federal: false, cities: [
    ['Londres', 'Europe/London'], ['Manchester', 'Europe/London'], ['Birmingham', 'Europe/London'],
    ['Édimbourg', 'Europe/London'], ['Liverpool', 'Europe/London'], ['Glasgow', 'Europe/London'],
    ['Bristol', 'Europe/London'], ['Leeds', 'Europe/London'], ['Sheffield', 'Europe/London'],
  ]},
  { name: 'Canada', iso2: 'CA', isoNum: '124', currency: 'CAD', federal: true, states: [
    ['Ontario', 'ON', [['Toronto', 'America/Toronto'], ['Ottawa', 'America/Toronto']]],
    ['Québec', 'QC', [['Montréal', 'America/Toronto'], ['Québec', 'America/Toronto']]],
    ['Colombie-Britannique', 'BC', [['Vancouver', 'America/Vancouver']]],
    ['Alberta', 'AB', [['Calgary', 'America/Edmonton']]],
    ['Manitoba', 'MB', [['Winnipeg', 'America/Winnipeg']]],
    ['Nouvelle-Écosse', 'NS', [['Halifax', 'America/Halifax']]],
  ]},
  { name: 'Japon', iso2: 'JP', isoNum: '392', currency: 'JPY', federal: false, cities: [
    ['Tokyo', 'Asia/Tokyo'], ['Osaka', 'Asia/Tokyo'], ['Yokohama', 'Asia/Tokyo'],
    ['Nagoya', 'Asia/Tokyo'], ['Sapporo', 'Asia/Tokyo'], ['Fukuoka', 'Asia/Tokyo'],
    ['Kobe', 'Asia/Tokyo'], ['Kyoto', 'Asia/Tokyo'], ['Kawasaki', 'Asia/Tokyo'],
  ]},
  { name: 'Brésil', iso2: 'BR', isoNum: '076', currency: 'BRL', federal: true, states: [
    ['São Paulo', 'SP', [['São Paulo', 'America/Sao_Paulo']]],
    ['Rio de Janeiro', 'RJ', [['Rio de Janeiro', 'America/Sao_Paulo']]],
    ['District Fédéral', 'DF', [['Brasília', 'America/Sao_Paulo']]],
    ['Bahia', 'BA', [['Salvador', 'America/Bahia']]],
    ['Minas Gerais', 'MG', [['Belo Horizonte', 'America/Sao_Paulo']]],
    ['Ceará', 'CE', [['Fortaleza', 'America/Fortaleza']]],
    ['Paraná', 'PR', [['Curitiba', 'America/Sao_Paulo']]],
    ['Pernambuco', 'PE', [['Recife', 'America/Recife']]],
  ]},
  { name: 'Émirats arabes unis', iso2: 'AE', isoNum: '784', currency: 'AED', federal: true, states: [
    ['Dubaï', 'DU', [['Dubaï', 'Asia/Dubai']]],
    ['Abu Dhabi', 'AZ', [['Abu Dhabi', 'Asia/Dubai'], ['Al Ain', 'Asia/Dubai']]],
    ['Charjah', 'SH', [['Sharjah', 'Asia/Dubai']]],
    ['Ras Al Khaimah', 'RK', [['Ras Al Khaimah', 'Asia/Dubai']]],
    ['Fujairah', 'FU', [['Fujairah', 'Asia/Dubai']]],
  ]},
  { name: 'Sénégal', iso2: 'SN', isoNum: '686', currency: 'XOF', federal: false, cities: [
    ['Dakar', 'Africa/Dakar'], ['Saint-Louis', 'Africa/Dakar'], ['Thiès', 'Africa/Dakar'],
    ['Touba', 'Africa/Dakar'], ['Ziguinchor', 'Africa/Dakar'], ['Kaolack', 'Africa/Dakar'], ['Mbour', 'Africa/Dakar'],
  ]},
  { name: 'Portugal', iso2: 'PT', isoNum: '620', currency: 'EUR', federal: false, cities: [
    ['Lisbonne', 'Europe/Lisbon'], ['Porto', 'Europe/Lisbon'], ['Braga', 'Europe/Lisbon'],
    ['Faro', 'Europe/Lisbon'], ['Coimbra', 'Europe/Lisbon'], ['Setúbal', 'Europe/Lisbon'], ['Aveiro', 'Europe/Lisbon'],
  ]},
  { name: 'Égypte', iso2: 'EG', isoNum: '818', currency: 'EGP', federal: false, cities: [
    ['Le Caire', 'Africa/Cairo'], ['Alexandrie', 'Africa/Cairo'], ['Gizeh', 'Africa/Cairo'],
    ['Louxor', 'Africa/Cairo'], ['Assouan', 'Africa/Cairo'], ['Port-Saïd', 'Africa/Cairo'], ['Suez', 'Africa/Cairo'],
  ]},
  { name: 'Mexique', iso2: 'MX', isoNum: '484', currency: 'MXN', federal: true, states: [
    ['Mexico (CDMX)', 'CDMX', [['Mexico', 'America/Mexico_City']]],
    ['Jalisco', 'JAL', [['Guadalajara', 'America/Mexico_City']]],
    ['Nuevo León', 'NL', [['Monterrey', 'America/Monterrey']]],
    ['Quintana Roo', 'QR', [['Cancún', 'America/Cancun']]],
    ['Puebla', 'PUE', [['Puebla', 'America/Mexico_City']]],
    ['Basse-Californie', 'BCN', [['Tijuana', 'America/Tijuana']]],
    ['Yucatán', 'YUC', [['Mérida', 'America/Merida']]],
    ['Querétaro', 'QUE', [['Querétaro', 'America/Mexico_City']]],
  ]},
  { name: 'Albanie', iso2: 'AL', isoNum: '008', currency: 'ALL', federal: false, cities: [['Tirana', 'Europe/Tirane'], ['Durrës', 'Europe/Tirane'], ['Vlorë', 'Europe/Tirane']] },
  { name: 'Andorre', iso2: 'AD', isoNum: '020', currency: 'EUR', federal: false, cities: [['Andorre-la-Vieille', 'Europe/Andorra'], ['Escaldes-Engordany', 'Europe/Andorra']] },
  { name: 'Autriche', iso2: 'AT', isoNum: '040', currency: 'EUR', federal: false, cities: [['Vienne', 'Europe/Vienna'], ['Graz', 'Europe/Vienna'], ['Linz', 'Europe/Vienna'], ['Salzbourg', 'Europe/Vienna'], ['Innsbruck', 'Europe/Vienna']] },
  { name: 'Biélorussie', iso2: 'BY', isoNum: '112', currency: 'BYN', federal: false, cities: [['Minsk', 'Europe/Minsk'], ['Homel', 'Europe/Minsk'], ['Vitebsk', 'Europe/Minsk']] },
  { name: 'Belgique', iso2: 'BE', isoNum: '056', currency: 'EUR', federal: false, cities: [['Bruxelles', 'Europe/Brussels'], ['Anvers', 'Europe/Brussels'], ['Gand', 'Europe/Brussels'], ['Liège', 'Europe/Brussels'], ['Bruges', 'Europe/Brussels']] },
  { name: 'Bosnie-Herzégovine', iso2: 'BA', isoNum: '070', currency: 'BAM', federal: false, cities: [['Sarajevo', 'Europe/Sarajevo'], ['Banja Luka', 'Europe/Sarajevo'], ['Mostar', 'Europe/Sarajevo']] },
  { name: 'Bulgarie', iso2: 'BG', isoNum: '100', currency: 'BGN', federal: false, cities: [['Sofia', 'Europe/Sofia'], ['Plovdiv', 'Europe/Sofia'], ['Varna', 'Europe/Sofia']] },
  { name: 'Chypre', iso2: 'CY', isoNum: '196', currency: 'EUR', federal: false, cities: [['Nicosie', 'Asia/Nicosia'], ['Limassol', 'Asia/Nicosia'], ['Larnaca', 'Asia/Nicosia']] },
  { name: 'Croatie', iso2: 'HR', isoNum: '191', currency: 'EUR', federal: false, cities: [['Zagreb', 'Europe/Zagreb'], ['Split', 'Europe/Zagreb'], ['Rijeka', 'Europe/Zagreb'], ['Dubrovnik', 'Europe/Zagreb']] },
  { name: 'Danemark', iso2: 'DK', isoNum: '208', currency: 'DKK', federal: false, cities: [['Copenhague', 'Europe/Copenhagen'], ['Aarhus', 'Europe/Copenhagen'], ['Odense', 'Europe/Copenhagen'], ['Aalborg', 'Europe/Copenhagen']] },
  { name: 'Estonie', iso2: 'EE', isoNum: '233', currency: 'EUR', federal: false, cities: [['Tallinn', 'Europe/Tallinn'], ['Tartu', 'Europe/Tallinn'], ['Narva', 'Europe/Tallinn']] },
  { name: 'Finlande', iso2: 'FI', isoNum: '246', currency: 'EUR', federal: false, cities: [['Helsinki', 'Europe/Helsinki'], ['Espoo', 'Europe/Helsinki'], ['Tampere', 'Europe/Helsinki'], ['Turku', 'Europe/Helsinki']] },
  { name: 'Grèce', iso2: 'GR', isoNum: '300', currency: 'EUR', federal: false, cities: [['Athènes', 'Europe/Athens'], ['Thessalonique', 'Europe/Athens'], ['Patras', 'Europe/Athens'], ['Héraklion', 'Europe/Athens']] },
  { name: 'Hongrie', iso2: 'HU', isoNum: '348', currency: 'HUF', federal: false, cities: [['Budapest', 'Europe/Budapest'], ['Debrecen', 'Europe/Budapest'], ['Szeged', 'Europe/Budapest']] },
  { name: 'Irlande', iso2: 'IE', isoNum: '372', currency: 'EUR', federal: false, cities: [['Dublin', 'Europe/Dublin'], ['Cork', 'Europe/Dublin'], ['Limerick', 'Europe/Dublin'], ['Galway', 'Europe/Dublin']] },
  { name: 'Islande', iso2: 'IS', isoNum: '352', currency: 'ISK', federal: false, cities: [['Reykjavik', 'Atlantic/Reykjavik'], ['Akureyri', 'Atlantic/Reykjavik'], ['Kópavogur', 'Atlantic/Reykjavik']] },
  { name: 'Lettonie', iso2: 'LV', isoNum: '428', currency: 'EUR', federal: false, cities: [['Riga', 'Europe/Riga'], ['Daugavpils', 'Europe/Riga'], ['Liepāja', 'Europe/Riga']] },
  { name: 'Liechtenstein', iso2: 'LI', isoNum: '438', currency: 'CHF', federal: false, cities: [['Vaduz', 'Europe/Vaduz'], ['Schaan', 'Europe/Vaduz']] },
  { name: 'Lituanie', iso2: 'LT', isoNum: '440', currency: 'EUR', federal: false, cities: [['Vilnius', 'Europe/Vilnius'], ['Kaunas', 'Europe/Vilnius'], ['Klaipėda', 'Europe/Vilnius']] },
  { name: 'Luxembourg', iso2: 'LU', isoNum: '442', currency: 'EUR', federal: false, cities: [['Luxembourg', 'Europe/Luxembourg'], ['Esch-sur-Alzette', 'Europe/Luxembourg']] },
  { name: 'Macédoine du Nord', iso2: 'MK', isoNum: '807', currency: 'MKD', federal: false, cities: [['Skopje', 'Europe/Skopje'], ['Bitola', 'Europe/Skopje'], ['Ohrid', 'Europe/Skopje']] },
  { name: 'Malte', iso2: 'MT', isoNum: '470', currency: 'EUR', federal: false, cities: [['La Valette', 'Europe/Malta'], ['Birkirkara', 'Europe/Malta'], ['Sliema', 'Europe/Malta']] },
  { name: 'Moldavie', iso2: 'MD', isoNum: '498', currency: 'MDL', federal: false, cities: [['Chișinău', 'Europe/Chisinau'], ['Tiraspol', 'Europe/Chisinau'], ['Bălți', 'Europe/Chisinau']] },
  { name: 'Monaco', iso2: 'MC', isoNum: '492', currency: 'EUR', federal: false, cities: [['Monaco', 'Europe/Monaco'], ['Monte-Carlo', 'Europe/Monaco']] },
  { name: 'Monténégro', iso2: 'ME', isoNum: '499', currency: 'EUR', federal: false, cities: [['Podgorica', 'Europe/Podgorica'], ['Nikšić', 'Europe/Podgorica'], ['Budva', 'Europe/Podgorica']] },
  { name: 'Norvège', iso2: 'NO', isoNum: '578', currency: 'NOK', federal: false, cities: [['Oslo', 'Europe/Oslo'], ['Bergen', 'Europe/Oslo'], ['Trondheim', 'Europe/Oslo'], ['Stavanger', 'Europe/Oslo']] },
  { name: 'Pays-Bas', iso2: 'NL', isoNum: '528', currency: 'EUR', federal: false, cities: [['Amsterdam', 'Europe/Amsterdam'], ['Rotterdam', 'Europe/Amsterdam'], ['La Haye', 'Europe/Amsterdam'], ['Utrecht', 'Europe/Amsterdam'], ['Eindhoven', 'Europe/Amsterdam']] },
  { name: 'Pologne', iso2: 'PL', isoNum: '616', currency: 'PLN', federal: false, cities: [['Varsovie', 'Europe/Warsaw'], ['Cracovie', 'Europe/Warsaw'], ['Wrocław', 'Europe/Warsaw'], ['Poznań', 'Europe/Warsaw'], ['Gdańsk', 'Europe/Warsaw'], ['Łódź', 'Europe/Warsaw']] },
  { name: 'République tchèque', iso2: 'CZ', isoNum: '203', currency: 'CZK', federal: false, cities: [['Prague', 'Europe/Prague'], ['Brno', 'Europe/Prague'], ['Ostrava', 'Europe/Prague'], ['Plzeň', 'Europe/Prague']] },
  { name: 'Roumanie', iso2: 'RO', isoNum: '642', currency: 'RON', federal: false, cities: [['Bucarest', 'Europe/Bucharest'], ['Cluj-Napoca', 'Europe/Bucharest'], ['Timișoara', 'Europe/Bucharest'], ['Iași', 'Europe/Bucharest'], ['Constanța', 'Europe/Bucharest']] },
  { name: 'Russie', iso2: 'RU', isoNum: '643', currency: 'RUB', federal: false, cities: [['Moscou', 'Europe/Moscow'], ['Vladivostok', 'Asia/Vladivostok'], ['Saint-Pétersbourg', 'Europe/Moscow']] },
  { name: 'Saint-Marin', iso2: 'SM', isoNum: '674', currency: 'EUR', federal: false, cities: [['Saint-Marin', 'Europe/San_Marino'], ['Serravalle', 'Europe/San_Marino']] },
  { name: 'Serbie', iso2: 'RS', isoNum: '688', currency: 'RSD', federal: false, cities: [['Belgrade', 'Europe/Belgrade'], ['Novi Sad', 'Europe/Belgrade'], ['Niš', 'Europe/Belgrade']] },
  { name: 'Slovaquie', iso2: 'SK', isoNum: '703', currency: 'EUR', federal: false, cities: [['Bratislava', 'Europe/Bratislava'], ['Košice', 'Europe/Bratislava'], ['Žilina', 'Europe/Bratislava']] },
  { name: 'Slovénie', iso2: 'SI', isoNum: '705', currency: 'EUR', federal: false, cities: [['Ljubljana', 'Europe/Ljubljana'], ['Maribor', 'Europe/Ljubljana'], ['Celje', 'Europe/Ljubljana']] },
  { name: 'Suède', iso2: 'SE', isoNum: '752', currency: 'SEK', federal: false, cities: [['Stockholm', 'Europe/Stockholm'], ['Göteborg', 'Europe/Stockholm'], ['Malmö', 'Europe/Stockholm'], ['Uppsala', 'Europe/Stockholm'], ['Västerås', 'Europe/Stockholm']] },
  { name: 'Suisse', iso2: 'CH', isoNum: '756', currency: 'CHF', federal: false, cities: [['Berne', 'Europe/Zurich'], ['Genève', 'Europe/Zurich']] },
  { name: 'Ukraine', iso2: 'UA', isoNum: '804', currency: 'UAH', federal: false, cities: [['Kiev', 'Europe/Kyiv'], ['Odessa', 'Europe/Kyiv'], ['Lviv', 'Europe/Kyiv'], ['Kharkiv', 'Europe/Kyiv']] },
  { name: 'Vatican', iso2: 'VA', isoNum: '336', currency: 'EUR', federal: false, cities: [['Cité du Vatican', 'Europe/Vatican']] },
  { name: 'Turquie', iso2: 'TR', isoNum: '792', currency: 'TRY', federal: false, cities: [['Ankara', 'Europe/Istanbul'], ['Istanbul', 'Europe/Istanbul']] },
  { name: 'Afrique du Sud', iso2: 'ZA', isoNum: '710', currency: 'ZAR', federal: false, cities: [['Pretoria', 'Africa/Johannesburg'], ['Le Cap', 'Africa/Johannesburg']] },
  { name: 'Algérie', iso2: 'DZ', isoNum: '012', currency: 'DZD', federal: false, cities: [['Alger', 'Africa/Algiers'], ['Oran', 'Africa/Algiers'], ['Constantine', 'Africa/Algiers'], ['Annaba', 'Africa/Algiers']] },
  { name: 'Angola', iso2: 'AO', isoNum: '024', currency: 'AOA', federal: false, cities: [['Luanda', 'Africa/Luanda'], ['Huambo', 'Africa/Luanda'], ['Lobito', 'Africa/Luanda']] },
  { name: 'Bénin', iso2: 'BJ', isoNum: '204', currency: 'XOF', federal: false, cities: [['Porto-Novo', 'Africa/Porto-Novo'], ['Cotonou', 'Africa/Porto-Novo'], ['Parakou', 'Africa/Porto-Novo']] },
  { name: 'Botswana', iso2: 'BW', isoNum: '072', currency: 'BWP', federal: false, cities: [['Gaborone', 'Africa/Gaborone'], ['Francistown', 'Africa/Gaborone']] },
  { name: 'Burkina Faso', iso2: 'BF', isoNum: '854', currency: 'XOF', federal: false, cities: [['Ouagadougou', 'Africa/Ouagadougou'], ['Bobo-Dioulasso', 'Africa/Ouagadougou']] },
  { name: 'Burundi', iso2: 'BI', isoNum: '108', currency: 'BIF', federal: false, cities: [['Gitega', 'Africa/Bujumbura'], ['Bujumbura', 'Africa/Bujumbura']] },
  { name: 'Cabo Verde', iso2: 'CV', isoNum: '132', currency: 'CVE', federal: false, cities: [['Praia', 'Atlantic/Cape_Verde'], ['Mindelo', 'Atlantic/Cape_Verde']] },
  { name: 'Cameroun', iso2: 'CM', isoNum: '120', currency: 'XAF', federal: false, cities: [['Yaoundé', 'Africa/Douala'], ['Douala', 'Africa/Douala'], ['Garoua', 'Africa/Douala']] },
  { name: 'Comores', iso2: 'KM', isoNum: '174', currency: 'KMF', federal: false, cities: [['Moroni', 'Indian/Comoro'], ['Moutsamoudou', 'Indian/Comoro']] },
  { name: 'Congo-Brazzaville', iso2: 'CG', isoNum: '178', currency: 'XAF', federal: false, cities: [['Brazzaville', 'Africa/Brazzaville'], ['Pointe-Noire', 'Africa/Brazzaville']] },
  { name: 'Congo-Kinshasa (RDC)', iso2: 'CD', isoNum: '180', currency: 'CDF', federal: false, cities: [['Kinshasa', 'Africa/Kinshasa'], ['Lubumbashi', 'Africa/Lubumbashi'], ['Goma', 'Africa/Lubumbashi'], ['Kisangani', 'Africa/Lubumbashi']] },
  { name: "Côte d'Ivoire", iso2: 'CI', isoNum: '384', currency: 'XOF', federal: false, cities: [['Abidjan', 'Africa/Abidjan'], ['Yamoussoukro', 'Africa/Abidjan'], ['Bouaké', 'Africa/Abidjan']] },
  { name: 'Djibouti', iso2: 'DJ', isoNum: '262', currency: 'DJF', federal: false, cities: [['Djibouti', 'Africa/Djibouti'], ['Ali Sabieh', 'Africa/Djibouti']] },
  { name: 'Érythrée', iso2: 'ER', isoNum: '232', currency: 'ERN', federal: false, cities: [['Asmara', 'Africa/Asmara'], ['Keren', 'Africa/Asmara']] },
  { name: 'Eswatini', iso2: 'SZ', isoNum: '748', currency: 'SZL', federal: false, cities: [['Mbabane', 'Africa/Mbabane'], ['Manzini', 'Africa/Mbabane']] },
  { name: 'Éthiopie', iso2: 'ET', isoNum: '231', currency: 'ETB', federal: false, cities: [['Addis-Abeba', 'Africa/Addis_Ababa'], ['Dire Dawa', 'Africa/Addis_Ababa'], ['Bahir Dar', 'Africa/Addis_Ababa']] },
  { name: 'Gabon', iso2: 'GA', isoNum: '266', currency: 'XAF', federal: false, cities: [['Libreville', 'Africa/Libreville'], ['Port-Gentil', 'Africa/Libreville']] },
  { name: 'Gambie', iso2: 'GM', isoNum: '270', currency: 'GMD', federal: false, cities: [['Banjul', 'Africa/Banjul'], ['Serekunda', 'Africa/Banjul']] },
  { name: 'Ghana', iso2: 'GH', isoNum: '288', currency: 'GHS', federal: false, cities: [['Accra', 'Africa/Accra'], ['Kumasi', 'Africa/Accra'], ['Tamale', 'Africa/Accra']] },
  { name: 'Guinée', iso2: 'GN', isoNum: '324', currency: 'GNF', federal: false, cities: [['Conakry', 'Africa/Conakry'], ['Nzérékoré', 'Africa/Conakry']] },
  { name: 'Guinée équatoriale', iso2: 'GQ', isoNum: '226', currency: 'XAF', federal: false, cities: [['Malabo', 'Africa/Malabo'], ['Bata', 'Africa/Malabo']] },
  { name: 'Guinée-Bissau', iso2: 'GW', isoNum: '624', currency: 'XOF', federal: false, cities: [['Bissau', 'Africa/Bissau'], ['Bafatá', 'Africa/Bissau']] },
  { name: 'Kenya', iso2: 'KE', isoNum: '404', currency: 'KES', federal: false, cities: [['Nairobi', 'Africa/Nairobi'], ['Mombasa', 'Africa/Nairobi']] },
  { name: 'Lesotho', iso2: 'LS', isoNum: '426', currency: 'LSL', federal: false, cities: [['Maseru', 'Africa/Maseru'], ['Teyateyaneng', 'Africa/Maseru']] },
  { name: 'Liberia', iso2: 'LR', isoNum: '430', currency: 'LRD', federal: false, cities: [['Monrovia', 'Africa/Monrovia'], ['Gbarnga', 'Africa/Monrovia']] },
  { name: 'Libye', iso2: 'LY', isoNum: '434', currency: 'LYD', federal: false, cities: [['Tripoli', 'Africa/Tripoli'], ['Benghazi', 'Africa/Tripoli'], ['Misrata', 'Africa/Tripoli']] },
  { name: 'Madagascar', iso2: 'MG', isoNum: '450', currency: 'MGA', federal: false, cities: [['Antananarivo', 'Indian/Antananarivo'], ['Toamasina', 'Indian/Antananarivo'], ['Antsirabe', 'Indian/Antananarivo']] },
  { name: 'Malawi', iso2: 'MW', isoNum: '454', currency: 'MWK', federal: false, cities: [['Lilongwe', 'Africa/Blantyre'], ['Blantyre', 'Africa/Blantyre'], ['Mzuzu', 'Africa/Blantyre']] },
  { name: 'Mali', iso2: 'ML', isoNum: '466', currency: 'XOF', federal: false, cities: [['Bamako', 'Africa/Bamako'], ['Sikasso', 'Africa/Bamako']] },
  { name: 'Maurice', iso2: 'MU', isoNum: '480', currency: 'MUR', federal: false, cities: [['Port-Louis', 'Indian/Mauritius'], ['Beau Bassin-Rose Hill', 'Indian/Mauritius']] },
  { name: 'Mauritanie', iso2: 'MR', isoNum: '478', currency: 'MRU', federal: false, cities: [['Nouakchott', 'Africa/Nouakchott'], ['Nouadhibou', 'Africa/Nouakchott']] },
  { name: 'Mozambique', iso2: 'MZ', isoNum: '508', currency: 'MZN', federal: false, cities: [['Maputo', 'Africa/Maputo'], ['Matola', 'Africa/Maputo'], ['Beira', 'Africa/Maputo']] },
  { name: 'Namibie', iso2: 'NA', isoNum: '516', currency: 'NAD', federal: false, cities: [['Windhoek', 'Africa/Windhoek'], ['Walvis Bay', 'Africa/Windhoek']] },
  { name: 'Niger', iso2: 'NE', isoNum: '562', currency: 'XOF', federal: false, cities: [['Niamey', 'Africa/Niamey'], ['Zinder', 'Africa/Niamey']] },
  { name: 'Nigeria', iso2: 'NG', isoNum: '566', currency: 'NGN', federal: false, cities: [['Abuja', 'Africa/Lagos'], ['Lagos', 'Africa/Lagos']] },
  { name: 'Ouganda', iso2: 'UG', isoNum: '800', currency: 'UGX', federal: false, cities: [['Kampala', 'Africa/Kampala'], ['Gulu', 'Africa/Kampala'], ['Entebbe', 'Africa/Kampala']] },
  { name: 'Rwanda', iso2: 'RW', isoNum: '646', currency: 'RWF', federal: false, cities: [['Kigali', 'Africa/Kigali'], ['Butare', 'Africa/Kigali']] },
  { name: 'Sao Tomé-et-Principe', iso2: 'ST', isoNum: '678', currency: 'STN', federal: false, cities: [['São Tomé', 'Africa/Sao_Tome'], ['Santo António', 'Africa/Sao_Tome']] },
  { name: 'Seychelles', iso2: 'SC', isoNum: '690', currency: 'SCR', federal: false, cities: [['Victoria', 'Indian/Mahe'], ['Anse Boileau', 'Indian/Mahe']] },
  { name: 'Sierra Leone', iso2: 'SL', isoNum: '694', currency: 'SLE', federal: false, cities: [['Freetown', 'Africa/Freetown'], ['Bo', 'Africa/Freetown']] },
  { name: 'Somalie', iso2: 'SO', isoNum: '706', currency: 'SOS', federal: false, cities: [['Mogadiscio', 'Africa/Mogadishu'], ['Hargeisa', 'Africa/Mogadishu']] },
  { name: 'Soudan', iso2: 'SD', isoNum: '729', currency: 'SDG', federal: false, cities: [['Khartoum', 'Africa/Khartoum'], ['Omdurman', 'Africa/Khartoum'], ['Port-Soudan', 'Africa/Khartoum']] },
  { name: 'Soudan du Sud', iso2: 'SS', isoNum: '728', currency: 'SSP', federal: false, cities: [['Djouba', 'Africa/Juba'], ['Wau', 'Africa/Juba']] },
  { name: 'Tanzanie', iso2: 'TZ', isoNum: '834', currency: 'TZS', federal: false, cities: [['Dodoma', 'Africa/Dar_es_Salaam'], ['Dar es Salaam', 'Africa/Dar_es_Salaam'], ['Zanzibar', 'Africa/Dar_es_Salaam'], ['Arusha', 'Africa/Dar_es_Salaam']] },
  { name: 'Tchad', iso2: 'TD', isoNum: '148', currency: 'XAF', federal: false, cities: [['N\'Djamena', 'Africa/Ndjamena'], ['Moundou', 'Africa/Ndjamena']] },
  { name: 'Togo', iso2: 'TG', isoNum: '768', currency: 'XOF', federal: false, cities: [['Lomé', 'Africa/Lome'], ['Sokodé', 'Africa/Lome']] },
  { name: 'Tunisie', iso2: 'TN', isoNum: '788', currency: 'TND', federal: false, cities: [['Tunis', 'Africa/Tunis'], ['Sfax', 'Africa/Tunis'], ['Sousse', 'Africa/Tunis']] },
  { name: 'Zambie', iso2: 'ZM', isoNum: '894', currency: 'ZMW', federal: false, cities: [['Lusaka', 'Africa/Lusaka'], ['Kitwe', 'Africa/Lusaka'], ['Ndola', 'Africa/Lusaka']] },
  { name: 'Zimbabwe', iso2: 'ZW', isoNum: '716', currency: 'ZWL', federal: false, cities: [['Harare', 'Africa/Harare'], ['Bulawayo', 'Africa/Harare']] },
  { name: 'Afghanistan', iso2: 'AF', isoNum: '004', currency: 'AFN', federal: false, cities: [['Kaboul', 'Asia/Kabul'], ['Hérat', 'Asia/Kabul'], ['Kandahar', 'Asia/Kabul']] },
  { name: 'Arabie saoudite', iso2: 'SA', isoNum: '682', currency: 'SAR', federal: false, cities: [['Riyad', 'Asia/Riyadh'], ['Djeddah', 'Asia/Riyadh']] },
  { name: 'Arménie', iso2: 'AM', isoNum: '051', currency: 'AMD', federal: false, cities: [['Erevan', 'Asia/Yerevan'], ['Gyumri', 'Asia/Yerevan'], ['Vanadzor', 'Asia/Yerevan']] },
  { name: 'Azerbaïdjan', iso2: 'AZ', isoNum: '031', currency: 'AZN', federal: false, cities: [['Bakou', 'Asia/Baku'], ['Gandja', 'Asia/Baku'], ['Sumqayit', 'Asia/Baku']] },
  { name: 'Bahreïn', iso2: 'BH', isoNum: '048', currency: 'BHD', federal: false, cities: [['Manama', 'Asia/Bahrain'], ['Riffa', 'Asia/Bahrain'], ['Muharraq', 'Asia/Bahrain']] },
  { name: 'Bangladesh', iso2: 'BD', isoNum: '050', currency: 'BDT', federal: false, cities: [['Dacca', 'Asia/Dhaka'], ['Chittagong', 'Asia/Dhaka'], ['Khulna', 'Asia/Dhaka']] },
  { name: 'Bhoutan', iso2: 'BT', isoNum: '064', currency: 'BTN', federal: false, cities: [['Thimphou', 'Asia/Thimphu'], ['Phuntsholing', 'Asia/Thimphu']] },
  { name: 'Brunei', iso2: 'BN', isoNum: '096', currency: 'BND', federal: false, cities: [['Bandar Seri Begawan', 'Asia/Brunei'], ['Kuala Belait', 'Asia/Brunei']] },
  { name: 'Cambodge', iso2: 'KH', isoNum: '116', currency: 'KHR', federal: false, cities: [['Phnom Penh', 'Asia/Phnom_Penh'], ['Siem Reap', 'Asia/Phnom_Penh'], ['Battambang', 'Asia/Phnom_Penh']] },
  { name: 'Chine', iso2: 'CN', isoNum: '156', currency: 'CNY', federal: false, cities: [['Pékin', 'Asia/Shanghai'], ['Shanghai', 'Asia/Shanghai'], ['Hong Kong', 'Asia/Hong_Kong']] },
  { name: 'Corée du Nord', iso2: 'KP', isoNum: '408', currency: 'KPW', federal: false, cities: [['Pyongyang', 'Asia/Pyongyang'], ['Hamhung', 'Asia/Pyongyang']] },
  { name: 'Corée du Sud', iso2: 'KR', isoNum: '410', currency: 'KRW', federal: false, cities: [['Séoul', 'Asia/Seoul'], ['Busan', 'Asia/Seoul']] },
  { name: 'Géorgie', iso2: 'GE', isoNum: '268', currency: 'GEL', federal: false, cities: [['Tbilissi', 'Asia/Tbilisi'], ['Batoumi', 'Asia/Tbilisi'], ['Koutaïssi', 'Asia/Tbilisi']] },
  { name: 'Inde', iso2: 'IN', isoNum: '356', currency: 'INR', federal: true, states: [
    ['Delhi', 'DL', [['New Delhi', 'Asia/Kolkata']]],
    ['Maharashtra', 'MH', [['Mumbai', 'Asia/Kolkata'], ['Pune', 'Asia/Kolkata'], ['Nagpur', 'Asia/Kolkata']]],
    ['Karnataka', 'KA', [['Bangalore', 'Asia/Kolkata'], ['Mysore', 'Asia/Kolkata']]],
    ['Tamil Nadu', 'TN', [['Chennai', 'Asia/Kolkata'], ['Coimbatore', 'Asia/Kolkata']]],
    ['Bengale-Occidental', 'WB', [['Calcutta', 'Asia/Kolkata']]],
    ['Telangana', 'TG', [['Hyderabad', 'Asia/Kolkata']]],
    ['Gujarat', 'GJ', [['Ahmedabad', 'Asia/Kolkata'], ['Surat', 'Asia/Kolkata']]],
    ['Rajasthan', 'RJ', [['Jaipur', 'Asia/Kolkata']]],
  ]},
  { name: 'Indonésie', iso2: 'ID', isoNum: '360', currency: 'IDR', federal: false, cities: [['Jakarta', 'Asia/Jakarta'], ['Denpasar', 'Asia/Makassar']] },
  { name: 'Irak', iso2: 'IQ', isoNum: '368', currency: 'IQD', federal: false, cities: [['Bagdad', 'Asia/Baghdad'], ['Bassorah', 'Asia/Baghdad'], ['Erbil', 'Asia/Baghdad'], ['Mossoul', 'Asia/Baghdad']] },
  { name: 'Iran', iso2: 'IR', isoNum: '364', currency: 'IRR', federal: false, cities: [['Téhéran', 'Asia/Tehran'], ['Ispahan', 'Asia/Tehran'], ['Chiraz', 'Asia/Tehran'], ['Mashhad', 'Asia/Tehran']] },
  { name: 'Israël', iso2: 'IL', isoNum: '376', currency: 'ILS', federal: false, cities: [['Jérusalem', 'Asia/Jerusalem'], ['Tel Aviv', 'Asia/Jerusalem']] },
  { name: 'Jordanie', iso2: 'JO', isoNum: '400', currency: 'JOD', federal: false, cities: [['Amman', 'Asia/Amman'], ['Zarqa', 'Asia/Amman'], ['Irbid', 'Asia/Amman']] },
  { name: 'Kazakhstan', iso2: 'KZ', isoNum: '398', currency: 'KZT', federal: false, cities: [['Astana', 'Asia/Almaty'], ['Almaty', 'Asia/Almaty'], ['Chymkent', 'Asia/Almaty'], ['Karaganda', 'Asia/Almaty']] },
  { name: 'Kirghizistan', iso2: 'KG', isoNum: '417', currency: 'KGS', federal: false, cities: [['Bichkek', 'Asia/Bishkek'], ['Och', 'Asia/Bishkek']] },
  { name: 'Koweït', iso2: 'KW', isoNum: '414', currency: 'KWD', federal: false, cities: [['Koweït', 'Asia/Kuwait'], ['Al Ahmadi', 'Asia/Kuwait'], ['Hawalli', 'Asia/Kuwait']] },
  { name: 'Laos', iso2: 'LA', isoNum: '418', currency: 'LAK', federal: false, cities: [['Vientiane', 'Asia/Vientiane'], ['Luang Prabang', 'Asia/Vientiane'], ['Pakse', 'Asia/Vientiane']] },
  { name: 'Liban', iso2: 'LB', isoNum: '422', currency: 'LBP', federal: false, cities: [['Beyrouth', 'Asia/Beirut'], ['Tripoli', 'Asia/Beirut'], ['Saïda', 'Asia/Beirut']] },
  { name: 'Malaisie', iso2: 'MY', isoNum: '458', currency: 'MYR', federal: false, cities: [['Kuala Lumpur', 'Asia/Kuala_Lumpur'], ['George Town', 'Asia/Kuala_Lumpur'], ['Johor Bahru', 'Asia/Kuala_Lumpur'], ['Kota Kinabalu', 'Asia/Kuching']] },
  { name: 'Maldives', iso2: 'MV', isoNum: '462', currency: 'MVR', federal: false, cities: [['Malé', 'Indian/Maldives'], ['Addu City', 'Indian/Maldives']] },
  { name: 'Mongolie', iso2: 'MN', isoNum: '496', currency: 'MNT', federal: false, cities: [['Oulan-Bator', 'Asia/Ulaanbaatar'], ['Erdenet', 'Asia/Ulaanbaatar'], ['Darkhan', 'Asia/Ulaanbaatar']] },
  { name: 'Myanmar', iso2: 'MM', isoNum: '104', currency: 'MMK', federal: false, cities: [['Naypyidaw', 'Asia/Yangon'], ['Rangoun', 'Asia/Yangon'], ['Mandalay', 'Asia/Yangon']] },
  { name: 'Népal', iso2: 'NP', isoNum: '524', currency: 'NPR', federal: false, cities: [['Katmandou', 'Asia/Kathmandu'], ['Pokhara', 'Asia/Kathmandu'], ['Lalitpur', 'Asia/Kathmandu']] },
  { name: 'Oman', iso2: 'OM', isoNum: '512', currency: 'OMR', federal: false, cities: [['Mascate', 'Asia/Muscat'], ['Salalah', 'Asia/Muscat'], ['Sohar', 'Asia/Muscat']] },
  { name: 'Ouzbékistan', iso2: 'UZ', isoNum: '860', currency: 'UZS', federal: false, cities: [['Tachkent', 'Asia/Tashkent'], ['Samarcande', 'Asia/Samarkand'], ['Boukhara', 'Asia/Samarkand']] },
  { name: 'Pakistan', iso2: 'PK', isoNum: '586', currency: 'PKR', federal: false, cities: [['Islamabad', 'Asia/Karachi'], ['Karachi', 'Asia/Karachi']] },
  { name: 'Palestine', iso2: 'PS', isoNum: '275', currency: 'ILS', federal: false, cities: [['Ramallah', 'Asia/Hebron'], ['Gaza', 'Asia/Gaza'], ['Bethléem', 'Asia/Hebron'], ['Hébron', 'Asia/Hebron']] },
  { name: 'Philippines', iso2: 'PH', isoNum: '608', currency: 'PHP', federal: false, cities: [['Manille', 'Asia/Manila'], ['Cebu', 'Asia/Manila']] },
  { name: 'Qatar', iso2: 'QA', isoNum: '634', currency: 'QAR', federal: false, cities: [['Doha', 'Asia/Qatar'], ['Al Rayyan', 'Asia/Qatar'], ['Al Wakrah', 'Asia/Qatar']] },
  { name: 'Singapour', iso2: 'SG', isoNum: '702', currency: 'SGD', federal: false, cities: [['Singapour', 'Asia/Singapore']] },
  { name: 'Sri Lanka', iso2: 'LK', isoNum: '144', currency: 'LKR', federal: false, cities: [['Colombo', 'Asia/Colombo'], ['Kandy', 'Asia/Colombo'], ['Galle', 'Asia/Colombo']] },
  { name: 'Syrie', iso2: 'SY', isoNum: '760', currency: 'SYP', federal: false, cities: [['Damas', 'Asia/Damascus'], ['Alep', 'Asia/Damascus'], ['Homs', 'Asia/Damascus']] },
  { name: 'Tadjikistan', iso2: 'TJ', isoNum: '762', currency: 'TJS', federal: false, cities: [['Douchanbé', 'Asia/Dushanbe'], ['Khoudjand', 'Asia/Dushanbe']] },
  { name: 'Taïwan', iso2: 'TW', isoNum: '158', currency: 'TWD', federal: false, cities: [['Taipei', 'Asia/Taipei'], ['Kaohsiung', 'Asia/Taipei'], ['Taichung', 'Asia/Taipei'], ['Tainan', 'Asia/Taipei']] },
  { name: 'Thaïlande', iso2: 'TH', isoNum: '764', currency: 'THB', federal: false, cities: [['Bangkok', 'Asia/Bangkok'], ['Phuket', 'Asia/Bangkok']] },
  { name: 'Timor oriental', iso2: 'TL', isoNum: '626', currency: 'USD', federal: false, cities: [['Dili', 'Asia/Dili'], ['Baucau', 'Asia/Dili']] },
  { name: 'Turkménistan', iso2: 'TM', isoNum: '795', currency: 'TMT', federal: false, cities: [['Achgabat', 'Asia/Ashgabat'], ['Türkmenabat', 'Asia/Ashgabat']] },
  { name: 'Vietnam', iso2: 'VN', isoNum: '704', currency: 'VND', federal: false, cities: [['Hanoï', 'Asia/Ho_Chi_Minh'], ['Hô-Chi-Minh-Ville', 'Asia/Ho_Chi_Minh']] },
  { name: 'Yémen', iso2: 'YE', isoNum: '887', currency: 'YER', federal: false, cities: [['Sanaa', 'Asia/Aden'], ['Aden', 'Asia/Aden'], ['Taïz', 'Asia/Aden']] },
  { name: 'Antigua-et-Barbuda', iso2: 'AG', isoNum: '028', currency: 'XCD', federal: false, cities: [['Saint John\'s', 'America/Antigua'], ['All Saints', 'America/Antigua']] },
  { name: 'Argentine', iso2: 'AR', isoNum: '032', currency: 'ARS', federal: false, cities: [['Buenos Aires', 'America/Argentina/Buenos_Aires'], ['Cordoba', 'America/Argentina/Cordoba']] },
  { name: 'Bahamas', iso2: 'BS', isoNum: '044', currency: 'BSD', federal: false, cities: [['Nassau', 'America/Nassau'], ['Freeport', 'America/Nassau']] },
  { name: 'Barbade', iso2: 'BB', isoNum: '052', currency: 'BBD', federal: false, cities: [['Bridgetown', 'America/Barbados'], ['Speightstown', 'America/Barbados']] },
  { name: 'Belize', iso2: 'BZ', isoNum: '084', currency: 'BZD', federal: false, cities: [['Belmopan', 'America/Belize'], ['Belize City', 'America/Belize']] },
  { name: 'Bolivie', iso2: 'BO', isoNum: '068', currency: 'BOB', federal: false, cities: [['La Paz', 'America/La_Paz'], ['Santa Cruz de la Sierra', 'America/La_Paz'], ['Cochabamba', 'America/La_Paz']] },
  { name: 'Chili', iso2: 'CL', isoNum: '152', currency: 'CLP', federal: false, cities: [['Santiago', 'America/Santiago'], ['Valparaíso', 'America/Santiago'], ['Concepción', 'America/Santiago'], ['La Serena', 'America/Santiago']] },
  { name: 'Colombie', iso2: 'CO', isoNum: '170', currency: 'COP', federal: false, cities: [['Bogota', 'America/Bogota'], ['Medellin', 'America/Bogota']] },
  { name: 'Costa Rica', iso2: 'CR', isoNum: '188', currency: 'CRC', federal: false, cities: [['San José', 'America/Costa_Rica'], ['Alajuela', 'America/Costa_Rica'], ['Limón', 'America/Costa_Rica']] },
  { name: 'Cuba', iso2: 'CU', isoNum: '192', currency: 'CUP', federal: false, cities: [['La Havane', 'America/Havana'], ['Santiago de Cuba', 'America/Havana'], ['Camagüey', 'America/Havana']] },
  { name: 'Dominique', iso2: 'DM', isoNum: '212', currency: 'XCD', federal: false, cities: [['Roseau', 'America/Dominica'], ['Portsmouth', 'America/Dominica']] },
  { name: 'El Salvador', iso2: 'SV', isoNum: '222', currency: 'USD', federal: false, cities: [['San Salvador', 'America/El_Salvador'], ['Santa Ana', 'America/El_Salvador']] },
  { name: 'Équateur', iso2: 'EC', isoNum: '218', currency: 'USD', federal: false, cities: [['Quito', 'America/Guayaquil'], ['Guayaquil', 'America/Guayaquil'], ['Cuenca', 'America/Guayaquil']] },
  { name: 'Grenade', iso2: 'GD', isoNum: '308', currency: 'XCD', federal: false, cities: [['Saint George\'s', 'America/Grenada'], ['Gouyave', 'America/Grenada']] },
  { name: 'Guatemala', iso2: 'GT', isoNum: '320', currency: 'GTQ', federal: false, cities: [['Guatemala', 'America/Guatemala'], ['Quetzaltenango', 'America/Guatemala']] },
  { name: 'Guyana', iso2: 'GY', isoNum: '328', currency: 'GYD', federal: false, cities: [['Georgetown', 'America/Guyana'], ['Linden', 'America/Guyana']] },
  { name: 'Haïti', iso2: 'HT', isoNum: '332', currency: 'HTG', federal: false, cities: [['Port-au-Prince', 'America/Port-au-Prince'], ['Cap-Haïtien', 'America/Port-au-Prince']] },
  { name: 'Honduras', iso2: 'HN', isoNum: '340', currency: 'HNL', federal: false, cities: [['Tegucigalpa', 'America/Tegucigalpa'], ['San Pedro Sula', 'America/Tegucigalpa']] },
  { name: 'Jamaïque', iso2: 'JM', isoNum: '388', currency: 'JMD', federal: false, cities: [['Kingston', 'America/Jamaica'], ['Montego Bay', 'America/Jamaica'], ['Spanish Town', 'America/Jamaica']] },
  { name: 'Nicaragua', iso2: 'NI', isoNum: '558', currency: 'NIO', federal: false, cities: [['Managua', 'America/Managua'], ['León', 'America/Managua']] },
  { name: 'Panama', iso2: 'PA', isoNum: '591', currency: 'PAB', federal: false, cities: [['Panama', 'America/Panama'], ['San Miguelito', 'America/Panama'], ['Colón', 'America/Panama']] },
  { name: 'Paraguay', iso2: 'PY', isoNum: '600', currency: 'PYG', federal: false, cities: [['Asunción', 'America/Asuncion'], ['Ciudad del Este', 'America/Asuncion']] },
  { name: 'Pérou', iso2: 'PE', isoNum: '604', currency: 'PEN', federal: false, cities: [['Lima', 'America/Lima'], ['Arequipa', 'America/Lima'], ['Cusco', 'America/Lima'], ['Trujillo', 'America/Lima']] },
  { name: 'République dominicaine', iso2: 'DO', isoNum: '214', currency: 'DOP', federal: false, cities: [['Saint-Domingue', 'America/Santo_Domingo'], ['Santiago de los Caballeros', 'America/Santo_Domingo'], ['Punta Cana', 'America/Santo_Domingo']] },
  { name: 'Saint-Kitts-et-Nevis', iso2: 'KN', isoNum: '659', currency: 'XCD', federal: false, cities: [['Basseterre', 'America/St_Kitts'], ['Charlestown', 'America/St_Kitts']] },
  { name: 'Saint-Vincent-et-les-Grenadines', iso2: 'VC', isoNum: '670', currency: 'XCD', federal: false, cities: [['Kingstown', 'America/St_Vincent'], ['Layou', 'America/St_Vincent']] },
  { name: 'Sainte-Lucie', iso2: 'LC', isoNum: '662', currency: 'XCD', federal: false, cities: [['Castries', 'America/St_Lucia'], ['Vieux Fort', 'America/St_Lucia']] },
  { name: 'Suriname', iso2: 'SR', isoNum: '740', currency: 'SRD', federal: false, cities: [['Paramaribo', 'America/Paramaribo'], ['Lelydorp', 'America/Paramaribo']] },
  { name: 'Trinité-et-Tobago', iso2: 'TT', isoNum: '780', currency: 'TTD', federal: false, cities: [['Port-d\'Espagne', 'America/Port_of_Spain'], ['San Fernando', 'America/Port_of_Spain']] },
  { name: 'Uruguay', iso2: 'UY', isoNum: '858', currency: 'UYU', federal: false, cities: [['Montevideo', 'America/Montevideo'], ['Salto', 'America/Montevideo'], ['Punta del Este', 'America/Montevideo']] },
  { name: 'Venezuela', iso2: 'VE', isoNum: '862', currency: 'VES', federal: false, cities: [['Caracas', 'America/Caracas'], ['Maracaibo', 'America/Caracas'], ['Valencia', 'America/Caracas']] },
  { name: 'Australie', iso2: 'AU', isoNum: '036', currency: 'AUD', federal: true, states: [
    ['Territoire de la capitale australienne', 'ACT', [['Canberra', 'Australia/Sydney']]],
    ['Nouvelle-Galles du Sud', 'NSW', [['Sydney', 'Australia/Sydney'], ['Newcastle', 'Australia/Sydney']]],
    ['Victoria', 'VIC', [['Melbourne', 'Australia/Melbourne'], ['Geelong', 'Australia/Melbourne']]],
    ['Queensland', 'QLD', [['Brisbane', 'Australia/Brisbane'], ['Gold Coast', 'Australia/Brisbane']]],
    ['Australie-Occidentale', 'WA', [['Perth', 'Australia/Perth']]],
    ['Australie-Méridionale', 'SA', [['Adélaïde', 'Australia/Adelaide']]],
    ['Tasmanie', 'TAS', [['Hobart', 'Australia/Hobart']]],
  ]},
  { name: 'Fidji', iso2: 'FJ', isoNum: '242', currency: 'FJD', federal: false, cities: [['Suva', 'Pacific/Fiji'], ['Nadi', 'Pacific/Fiji'], ['Lautoka', 'Pacific/Fiji']] },
  { name: 'Îles Marshall', iso2: 'MH', isoNum: '584', currency: 'USD', federal: false, cities: [['Majuro', 'Pacific/Majuro']] },
  { name: 'Îles Salomon', iso2: 'SB', isoNum: '090', currency: 'SBD', federal: false, cities: [['Honiara', 'Pacific/Guadalcanal']] },
  { name: 'Kiribati', iso2: 'KI', isoNum: '296', currency: 'AUD', federal: false, cities: [['Tarawa-Sud', 'Pacific/Tarawa']] },
  { name: 'Micronésie', iso2: 'FM', isoNum: '583', currency: 'USD', federal: false, cities: [['Palikir', 'Pacific/Pohnpei']] },
  { name: 'Nauru', iso2: 'NR', isoNum: '520', currency: 'AUD', federal: false, cities: [['Yaren', 'Pacific/Nauru']] },
  { name: 'Nouvelle-Zélande', iso2: 'NZ', isoNum: '554', currency: 'NZD', federal: false, cities: [['Wellington', 'Pacific/Auckland'], ['Auckland', 'Pacific/Auckland']] },
  { name: 'Palaos', iso2: 'PW', isoNum: '585', currency: 'USD', federal: false, cities: [['Ngerulmud', 'Pacific/Palau']] },
  { name: 'Papouasie-Nouvelle-Guinée', iso2: 'PG', isoNum: '598', currency: 'PGK', federal: false, cities: [['Port Moresby', 'Pacific/Port_Moresby'], ['Lae', 'Pacific/Port_Moresby']] },
  { name: 'Samoa', iso2: 'WS', isoNum: '882', currency: 'WST', federal: false, cities: [['Apia', 'Pacific/Apia']] },
  { name: 'Tonga', iso2: 'TO', isoNum: '776', currency: 'TOP', federal: false, cities: [['Nuku\'alofa', 'Pacific/Tongatapu']] },
  { name: 'Tuvalu', iso2: 'TV', isoNum: '798', currency: 'AUD', federal: false, cities: [['Funafuti', 'Pacific/Funafuti']] },
  { name: 'Vanuatu', iso2: 'VU', isoNum: '548', currency: 'VUV', federal: false, cities: [['Port-Vila', 'Pacific/Efate']] },
];

const insertCountry = db.prepare(
  'INSERT INTO countries (name, iso2, iso_numeric, currency, is_federal, capital, population_millions, languages, continent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
);
const insertState = db.prepare('INSERT INTO states (country_id, name, code) VALUES (?, ?, ?)');
const insertCity = db.prepare('INSERT INTO cities (country_id, state_id, name, timezone) VALUES (?, ?, ?, ?)');

const cityIdsByName = {};
for (const country of countries) {
  const info = COUNTRY_INFO[country.iso2] || {};
  const countryId = insertCountry
    .run(country.name, country.iso2, country.isoNum, country.currency, country.federal ? 1 : 0, info.capital || null, info.population ?? null, info.languages || null, info.continent || null)
    .lastInsertRowid;

  const profile = COUNTRY_PROFILES[country.iso2];
  if (profile) {
    db.prepare(
      'INSERT INTO country_profiles (country_id, business_climate, culture, gastronomy, practical_tips, holidays) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(countryId, profile.business_climate, profile.culture, profile.gastronomy, profile.practical_tips, profile.holidays);
  }
  if (country.federal) {
    for (const [stateName, code, cities] of country.states) {
      const stateId = insertState.run(countryId, stateName, code).lastInsertRowid;
      for (const [cityName, timezone] of cities) {
        const cityId = insertCity.run(countryId, stateId, cityName, timezone).lastInsertRowid;
        cityIdsByName[cityName] = cityId;
      }
    }
  } else {
    for (const [cityName, timezone] of country.cities) {
      const cityId = insertCity.run(countryId, null, cityName, timezone).lastInsertRowid;
      cityIdsByName[cityName] = cityId;
    }
  }
}

const categoryDefs = [
  {
    slug: 'immobilier', name: 'Immobilier', icon: '🏠',
    subcategories: [
      ['appartement', 'Appartement'],
      ['maison', 'Maison / Villa'],
      ['terrain', 'Terrain'],
      ['bureau', 'Bureau / Local commercial'],
      ['entrepot', 'Entrepôt / Local industriel'],
      ['chambre', 'Chambre'],
      ['colocation', 'Colocation'],
      ['parking-garage', 'Parking / Garage'],
      ['location-vacances', 'Location de vacances'],
      ['immeuble-rapport', 'Immeuble de rapport'],
    ],
  },
  {
    slug: 'vehicules', name: 'Véhicules', icon: '🚗',
    subcategories: [
      ['auto', 'Voiture'],
      ['moto', 'Moto / Scooter'],
      ['camion', 'Camion / Poids lourd'],
      ['utilitaire', 'Utilitaire / Camionnette'],
      ['caravane', 'Caravane / Camping-car'],
      ['remorque', 'Remorque'],
      ['quad-buggy', 'Quad / Buggy'],
      ['bateau', 'Bateau'],
      ['velo', 'Vélo'],
      ['pieces-accessoires', 'Pièces & accessoires'],
    ],
  },
  {
    slug: 'mode', name: 'Mode & Accessoires', icon: '👗',
    subcategories: [
      ['vetements-femme', 'Vêtements femme'],
      ['vetements-homme', 'Vêtements homme'],
      ['chaussures', 'Chaussures'],
      ['maroquinerie', 'Sacs & maroquinerie'],
      ['bijoux-montres', 'Bijoux & montres'],
      ['accessoires-mode', 'Accessoires (ceintures, écharpes, chapeaux)'],
      ['vetements-vintage', 'Vêtements vintage & seconde main'],
      ['autre-mode', 'Autre'],
    ],
  },
  {
    slug: 'maison-jardin', name: 'Maison & Jardin', icon: '🏡',
    subcategories: [
      ['electromenager', 'Électroménager'],
      ['meubles', 'Meubles'],
      ['decoration', 'Décoration'],
      ['linge-maison', 'Linge de maison'],
      ['cuisine-arts-table', 'Cuisine & arts de la table'],
      ['luminaire', 'Luminaire'],
      ['bricolage', 'Outils & bricolage'],
      ['jardin-exterieur', 'Jardin & extérieur'],
      ['piscine-spa', 'Piscine & spa'],
    ],
  },
  {
    slug: 'multimedia', name: 'Multimédia & Électronique', icon: '📱',
    subcategories: [
      ['telephones', 'Téléphones & objets connectés'],
      ['ordinateurs', 'Ordinateurs & tablettes'],
      ['image-son', 'Image & son'],
      ['jeux-video', 'Jeux vidéo & consoles'],
      ['appareils-photo', 'Appareils photo & caméras'],
      ['accessoires-informatique', 'Accessoires informatiques'],
      ['objets-connectes', 'Objets connectés & domotique'],
    ],
  },
  {
    slug: 'famille', name: 'Famille & Enfants', icon: '🧸',
    subcategories: [
      ['vetements-enfants', 'Vêtements enfants'],
      ['jouets', 'Jouets & jeux'],
      ['puericulture', 'Puériculture'],
      ['mobilier-enfant', 'Mobilier enfant'],
      ['livres-enfants', 'Livres & jeux éducatifs enfants'],
      ['chaussures-enfants', 'Chaussures enfants'],
    ],
  },
  {
    slug: 'loisirs', name: 'Loisirs & Sport', icon: '⚽',
    subcategories: [
      ['sport-fitness', 'Sport & fitness'],
      ['instruments-musique', 'Instruments de musique'],
      ['livres-bd', 'Livres & BD'],
      ['collection', 'Collection'],
      ['plein-air', 'Camping & plein air'],
      ['jeux-societe', 'Jeux de société'],
      ['films-series', 'Films & séries'],
      ['velos-loisir', 'Vélos & sports de glisse'],
    ],
  },
  {
    slug: 'materiel-pro', name: 'Matériel professionnel', icon: '🛠️',
    subcategories: [
      ['equipement-industriel', 'Équipement industriel'],
      ['mobilier-bureau', 'Mobilier de bureau'],
      ['materiel-agricole', 'Matériel agricole'],
      ['materiel-btp', 'Matériel BTP'],
      ['commerce-restauration', 'Commerce & restauration'],
      ['materiel-medical', 'Matériel médical & paramédical'],
      ['fournitures-bureau', 'Fournitures de bureau'],
    ],
  },
  {
    slug: 'services', name: 'Services', icon: '🧰',
    subcategories: [
      ['cours-formations', 'Cours & formations'],
      ['service-personne', 'Services à la personne'],
      ['reparation-depannage', 'Réparation & dépannage'],
      ['evenementiel', 'Événementiel'],
      ['services-informatiques', 'Services informatiques'],
      ['demenagement', 'Déménagement & transport'],
      ['garde-enfants-animaux', 'Garde d\'enfants & animaux'],
      ['autre-service', 'Autre service'],
    ],
  },
  {
    slug: 'emploi', name: 'Emploi', icon: '💼',
    subcategories: [
      ['informatique-tech', 'Informatique & tech'],
      ['btp-construction', 'BTP & construction'],
      ['sante', 'Santé'],
      ['education-formation', 'Éducation & formation'],
      ['commerce-vente', 'Commerce & vente'],
      ['hotellerie-restauration', 'Hôtellerie & restauration'],
      ['transport-logistique', 'Transport & logistique'],
      ['industrie-production', 'Industrie & production'],
      ['agriculture', 'Agriculture'],
      ['artisanat', 'Artisanat'],
      ['service-personne-emploi', 'Service à la personne'],
      ['communication-marketing', 'Communication & marketing'],
      ['juridique-finance', 'Juridique & finance'],
      ['autre-emploi', 'Autre'],
    ],
  },
  {
    slug: 'opportunites-affaires', name: "Opportunités d'affaires", icon: '💼',
    subcategories: [
      ['entreprise-a-vendre', 'Entreprise à vendre'],
      ['recherche-investisseurs', "Recherche d'investisseurs"],
      ['appel-offres', "Appel d'offres"],
      ['franchise', 'Franchise à reprendre'],
      ['partenariat', 'Recherche de partenaire commercial'],
    ],
  },
  {
    slug: 'autres', name: 'Autres', icon: '📦',
    subcategories: [
      ['divers', 'Divers'],
      ['dons', 'Objets à donner'],
    ],
  },
];

const insertCategory = db.prepare('INSERT INTO categories (slug, name, icon) VALUES (?, ?, ?)');
const insertSubcategory = db.prepare('INSERT INTO subcategories (category_id, slug, name) VALUES (?, ?, ?)');
const categoryIds = {};
const subcategoryIds = {}; // clé "categorySlug:subSlug" -> id
for (const cat of categoryDefs) {
  const categoryId = insertCategory.run(cat.slug, cat.name, cat.icon).lastInsertRowid;
  categoryIds[cat.slug] = categoryId;
  for (const [subSlug, subName] of cat.subcategories) {
    const subId = insertSubcategory.run(categoryId, subSlug, subName).lastInsertRowid;
    subcategoryIds[`${cat.slug}:${subSlug}`] = subId;
  }
}

const { salt, hash } = hashPassword('demo1234');
const demoUserId = db
  .prepare("INSERT INTO users (name, email, password_hash, password_salt, role, email_verified_at, terms_accepted_at, referral_code) VALUES (?, ?, ?, ?, 'admin', datetime('now'), datetime('now'), ?)")
  .run('QuickAtlas Demo', 'demo@atlas.test', hash, salt, 'DEMO2026').lastInsertRowid;

const insertListing = db.prepare(`
  INSERT INTO listings (user_id, city_id, category_id, subcategory_id, title, description, listing_type, price, currency, images_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// [ville, catégorie, sous-catégorie, titre, description, type, prix, devise, image]
const demoListings = [
  ['Paris', 'immobilier', 'appartement', 'Appartement lumineux 3 pièces', "Bel appartement rénové proche du métro, 68 m², balcon exposé sud.", 'location', 1850, 'EUR', 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=800'],
  ['Paris', 'vehicules', 'velo', 'Vélo hollandais vintage', "Vélo de ville en bon état, révisé récemment, avec panier.", 'vente', 180, 'EUR', 'https://images.unsplash.com/photo-1485965120184-e220f721d03e?w=800'],
  ['Casablanca', 'immobilier', 'maison', 'Villa avec piscine, quartier Anfa', "Villa 5 chambres, jardin arboré, piscine chauffée, garage double.", 'vente', 3200000, 'MAD', 'https://images.unsplash.com/photo-1613977257363-707ba9348227?w=800'],
  ['Casablanca', 'maison-jardin', 'electromenager', 'Climatiseur split 12000 BTU neuf', "Encore sous garantie constructeur, installation possible sur devis.", 'vente', 3200, 'MAD', 'https://images.unsplash.com/photo-1631545806609-746c744ffd58?w=800'],
  ['Marrakech', 'vehicules', 'auto', 'SUV 4x4 tout-terrain', "Véhicule entretenu, idéal excursions désert, faible kilométrage.", 'location', 450, 'MAD', 'https://images.unsplash.com/photo-1533473359331-0135ef1b58bf?w=800'],
  ['New York', 'immobilier', 'appartement', 'Loft à Brooklyn', "Loft industriel 90 m², grandes verrières, proche métro L.", 'location', 3400, 'USD', 'https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=800'],
  ['Madrid', 'vehicules', 'auto', 'Citadine électrique récente', "Faible consommation, parfaite pour la ville, batterie garantie.", 'vente', 15900, 'EUR', 'https://images.unsplash.com/photo-1593941707882-a5bba14938c7?w=800'],
  ['Rome', 'immobilier', 'appartement', 'Studio dans le Trastevere', "Charmant studio meublé, quartier animé, idéal investissement locatif.", 'vente', 210000, 'EUR', 'https://images.unsplash.com/photo-1502672023488-70e25813eb80?w=800'],
  ['Berlin', 'maison-jardin', 'meubles', 'Mobilier de bureau design', "Lot de bureaux et chaises ergonomiques, état quasi neuf.", 'vente', 620, 'EUR', 'https://images.unsplash.com/photo-1518455027359-f3f8164ba6bd?w=800'],
  ['Berlin', 'maison-jardin', 'electromenager', 'Lave-linge séchant 9kg', "Peu servi, classe énergétique A, notice fournie.", 'vente', 340, 'EUR', 'https://images.unsplash.com/photo-1610557892470-55d9e80c0bce?w=800'],
  ['Londres', 'immobilier', 'bureau', 'Bureaux partagés à Shoreditch', "Espace de coworking 200 m², 20 postes, salle de réunion.", 'location', 5200, 'GBP', 'https://images.unsplash.com/photo-1497366216548-37526070297c?w=800'],
  ['Toronto', 'vehicules', 'utilitaire', 'Camionnette utilitaire', "Idéale déménagement ou artisan, entretien à jour.", 'location', 95, 'CAD', 'https://images.unsplash.com/photo-1601362840469-51e4d8d58785?w=800'],
  ['Tokyo', 'immobilier', 'appartement', 'Appartement moderne à Shibuya', "1 chambre, immeuble récent, proche gare, très bien desservi.", 'location', 190000, 'JPY', 'https://images.unsplash.com/photo-1512918728675-ed5a9ecdebfd?w=800'],
  ['Dubaï', 'immobilier', 'appartement', 'Appartement vue mer, Marina', "2 chambres, piscine et salle de sport dans la résidence.", 'vente', 1650000, 'AED', 'https://images.unsplash.com/photo-1512453979798-5ea266f8880c?w=800'],
  ['Dubaï', 'maison-jardin', 'electromenager', 'Téléviseur OLED 65 pouces', "Modèle récent, télécommande et support mural inclus.", 'vente', 4800, 'AED', 'https://images.unsplash.com/photo-1593359677879-a4bb92f829d1?w=800'],
  ['Dakar', 'maison-jardin', 'bricolage', 'Groupe électrogène 5kVA', "Peu utilisé, révisé, idéal secours domicile ou petit commerce.", 'vente', 380000, 'XOF', 'https://images.unsplash.com/photo-1621905251189-08b45d6a269e?w=800'],
  ['Lisbonne', 'immobilier', 'appartement', 'T2 avec vue sur le Tage', "Appartement rénové, quartier Alfama, terrasse privative.", 'vente', 340000, 'EUR', 'https://images.unsplash.com/photo-1502005229762-cf1b2da7c5d6?w=800'],
  ['Le Caire', 'vehicules', 'auto', 'Berline familiale', "7 places, climatisation, entretien régulier chez concessionnaire.", 'vente', 480000, 'EGP', 'https://images.unsplash.com/photo-1541899481282-d53bffe3c35d?w=800'],
  ['Mexico', 'immobilier', 'maison', 'Maison patio, Coyoacán', "Maison coloniale rénovée, patio intérieur, 4 chambres.", 'vente', 4800000, 'MXN', 'https://images.unsplash.com/photo-1583608205776-bfd35f0d9f83?w=800'],
  ['Mexico', 'maison-jardin', 'electromenager', 'Cuisinière à gaz 4 feux', "Four intégré, allumage électronique, très peu servie.", 'vente', 4200, 'MXN', 'https://images.unsplash.com/photo-1556909212-d5b604d0c90d?w=800'],
  ['Lyon', 'immobilier', 'appartement', 'T3 rénové dans le Vieux Lyon', "Traversant, cuisine équipée, cave, proche funiculaire.", 'location', 1150, 'EUR', 'https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=800'],
  ['Marseille', 'vehicules', 'moto', 'Scooter 125cc récent', "Faible kilométrage, idéal trajets urbains, entretien à jour.", 'vente', 2100, 'EUR', 'https://images.unsplash.com/photo-1558981806-ec527fa84c39?w=800'],
  ['Fès', 'autres', 'divers', 'Tapis berbère fait main', "Pièce artisanale authentique, laine, grand format.", 'vente', 2400, 'MAD', 'https://images.unsplash.com/photo-1600166898405-da9535204843?w=800'],
  ['Tanger', 'immobilier', 'appartement', 'Appartement vue détroit', "2 chambres, terrasse, résidence sécurisée avec piscine.", 'location', 5500, 'MAD', 'https://images.unsplash.com/photo-1560185127-6ed189bf02f4?w=800'],
  ['Chicago', 'immobilier', 'appartement', 'Condo au cœur du Loop', "1 chambre, vue sur skyline, salle de sport dans l'immeuble.", 'location', 2200, 'USD', 'https://images.unsplash.com/photo-1494526585095-c41746248156?w=800'],
  ['Miami', 'vehicules', 'auto', 'Cabriolet décapotable', "Parfait état, révisions à jour, idéal balades en bord de mer.", 'location', 140, 'USD', 'https://images.unsplash.com/photo-1503376780353-7e6692767b70?w=800'],
  ['Séville', 'immobilier', 'maison', 'Patio andalou typique', "Maison de ville rénovée, patio central, 3 chambres.", 'vente', 285000, 'EUR', 'https://images.unsplash.com/photo-1523217582562-09d0def993a6?w=800'],
  ['Naples', 'vehicules', 'moto', 'Scooter Vespa vintage', "Modèle collector restauré, carte grise à jour.", 'vente', 3800, 'EUR', 'https://images.unsplash.com/photo-1598471678516-8e0d2f9c5b8f?w=800'],
  ['Munich', 'immobilier', 'appartement', 'Appartement proche Marienplatz', "2 pièces, très bien situé, idéal étudiant ou jeune actif.", 'location', 1450, 'EUR', 'https://images.unsplash.com/photo-1484154218962-a197022b5858?w=800'],
  ['Birmingham', 'vehicules', 'utilitaire', 'Utilitaire compact', "Faible consommation, parfait artisans et petites livraisons.", 'location', 65, 'GBP', 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=800'],
  ['Montréal', 'immobilier', 'appartement', 'Loft dans le Plateau', "Grandes fenêtres, cachet industriel, proche métro Mont-Royal.", 'location', 1900, 'CAD', 'https://images.unsplash.com/photo-1560448075-bb485b067938?w=800'],
  ['Osaka', 'maison-jardin', 'meubles', 'Équipement cuisine professionnelle', "Lot pour restaurant : plaques, hotte, meubles inox.", 'vente', 480000, 'JPY', 'https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=800'],
  ['Rio de Janeiro', 'immobilier', 'appartement', 'Appartement vue Copacabana', "3 chambres, balcon, immeuble avec sécurité 24h/24.", 'vente', 1450000, 'BRL', 'https://images.unsplash.com/photo-1483729558449-99ef09a8c325?w=800'],
  ['Abu Dhabi', 'vehicules', 'auto', 'Berline de luxe', "Faible kilométrage, entretien concessionnaire, état impeccable.", 'location', 900, 'AED', 'https://images.unsplash.com/photo-1555215695-3004980ad54e?w=800'],
  ['Porto', 'immobilier', 'maison', 'Maison typique à azulejos', "Façade traditionnelle, rénovée à l'intérieur, 3 chambres.", 'vente', 265000, 'EUR', 'https://images.unsplash.com/photo-1555881400-74d7acaacd8b?w=800'],
  ['Porto', 'maison-jardin', 'electromenager', 'Réfrigérateur américain', "Double porte, distributeur d'eau, très bon état général.", 'vente', 420, 'EUR', 'https://images.unsplash.com/photo-1571175443880-49e1d25b2bc5?w=800'],
  ['Paris', 'emploi', 'informatique-tech', 'Développeur·se web full-stack (CDI)', "Équipe produit de 6 personnes, télétravail partiel possible, stack Node.js/React.", 'offre_emploi', 3200, 'EUR', 'https://images.unsplash.com/photo-1498050108023-c5249f4df085?w=800'],
  ['Casablanca', 'emploi', 'commerce-vente', 'Recherche poste commercial(e) terrain', "5 ans d'expérience en vente B2B, secteur agroalimentaire, mobile sur toute la région.", 'demande_emploi', null, 'MAD', 'https://images.unsplash.com/photo-1560250097-0b93528c311a?w=800'],
  ['Dubaï', 'emploi', 'hotellerie-restauration', 'Chef de partie (hôtel 5 étoiles)', "Cuisine internationale, logement fourni, contrat 2 ans renouvelable.", 'offre_emploi', 8500, 'AED', 'https://images.unsplash.com/photo-1583394293214-28ded15ee548?w=800'],
  ['Montréal', 'emploi', 'sante', 'Infirmier·ère diplômé·e disponible', "10 ans d'expérience en soins intensifs, disponible immédiatement, permis de travail valide.", 'demande_emploi', null, 'CAD', 'https://images.unsplash.com/photo-1576091160399-112ba8d25d1d?w=800'],
  ['Berlin', 'emploi', 'btp-construction', 'Chef de chantier expérimenté', "Grands projets résidentiels, permis de conduire poids lourd apprécié.", 'offre_emploi', 4200, 'EUR', 'https://images.unsplash.com/photo-1541976590-713941681591?w=800'],
  ['Dakar', 'emploi', 'education-formation', 'Professeur de mathématiques (lycée)', "Disponible dès la rentrée prochaine, expérience programme international.", 'demande_emploi', null, 'XOF', 'https://images.unsplash.com/photo-1503676260728-1c00da094a0b?w=800'],
  ['Milan', 'mode', 'vetements-femme', 'Manteau en laine, marque italienne', "Porté deux fois, taille 38, coloris camel.", 'vente', 180, 'EUR', 'https://images.unsplash.com/photo-1539533018447-63fcce2678e3?w=800'],
  ['Barcelone', 'mode', 'maroquinerie', 'Sac à main cuir véritable', "Fait main, état neuf avec étiquette, coloris bordeaux.", 'vente', 95, 'EUR', 'https://images.unsplash.com/photo-1584917865442-de89df76afd3?w=800'],
  ['Tokyo', 'multimedia', 'ordinateurs', 'Ordinateur portable 14 pouces', "16 Go de RAM, SSD 512 Go, très peu servi, encore sous garantie.", 'vente', 780, 'USD', 'https://images.unsplash.com/photo-1496181133206-80ce9b88a853?w=800'],
  ['Séoul', 'multimedia', 'jeux-video', 'Console dernière génération + 3 jeux', "Excellent état, boîtes et manettes incluses.", 'vente', 420, 'USD', 'https://images.unsplash.com/photo-1486401899868-0e435ed85128?w=800'],
  ['Amsterdam', 'famille', 'puericulture', 'Poussette 3-en-1', "Avec nacelle et cosy auto, très bon état, notice fournie.", 'vente', 260, 'EUR', 'https://images.unsplash.com/photo-1591147683403-4b06fbf46f5e?w=800'],
  ['Vienne', 'famille', 'jouets', 'Lot de jeux de construction', "Grande boîte, toutes pièces vérifiées, dès 4 ans.", 'vente', 45, 'EUR', 'https://images.unsplash.com/photo-1587654780291-39c9404d746b?w=800'],
  ['Genève', 'loisirs', 'instruments-musique', 'Guitare acoustique folk', "Accordée régulièrement, housse incluse, idéale débutant.", 'vente', 150, 'CHF', 'https://images.unsplash.com/photo-1510915361894-db8b60106cb1?w=800'],
  ['Stockholm', 'loisirs', 'plein-air', 'Tente 4 places imperméable', "Utilisée deux week-ends, montage facile, sac de transport inclus.", 'vente', 120, 'SEK', 'https://images.unsplash.com/photo-1504280390367-361c6d9f38f4?w=800'],
  ['Bruxelles', 'materiel-pro', 'mobilier-bureau', 'Lot de 10 postes de travail', "Bureaux réglables + chaises ergonomiques, sortie d'entreprise.", 'vente', 1800, 'EUR', 'https://images.unsplash.com/photo-1497366811353-6870744d04b2?w=800'],
  ['Le Cap', 'materiel-pro', 'commerce-restauration', 'Vitrine réfrigérée professionnelle', "Idéale boulangerie/traiteur, entretien à jour, dimensions 2m.", 'vente', 2400, 'ZAR', 'https://images.unsplash.com/photo-1585909695284-32d2985ac9c0?w=800'],
  ['Buenos Aires', 'services', 'cours-formations', "Cours particuliers d'anglais", "Professeur natif, tous niveaux, en ligne ou en présentiel.", 'offre_emploi', 25, 'ARS', 'https://images.unsplash.com/photo-1580582932707-520aed937b7b?w=800'],
  ['Bangkok', 'services', 'evenementiel', 'Organisation de mariages sur mesure', "Plus de 50 événements organisés, devis gratuit.", 'offre_emploi', null, 'THB', 'https://images.unsplash.com/photo-1519741497674-611481863552?w=800'],
  ['Casablanca', 'opportunites-affaires', 'entreprise-a-vendre', 'Restaurant traditionnel à céder', "Emplacement central, clientèle fidèle, 15 ans d'activité, bail commercial cessible.", 'vente', 180000, 'MAD', 'https://images.unsplash.com/photo-1552566626-52f8b828add9?w=800'],
  ['Dubaï', 'opportunites-affaires', 'recherche-investisseurs', 'Startup logistique cherche levée de fonds', "Série A, solution de suivi de flotte déjà déployée dans 3 pays du Golfe, revenus récurrents.", 'achat', null, 'AED', 'https://images.unsplash.com/photo-1553877522-43269d4ea984?w=800'],
  ['Singapour', 'opportunites-affaires', 'appel-offres', "Appel d'offres — refonte site institutionnel", "Organisme public, cahier des charges disponible sur demande, clôture des candidatures dans 30 jours.", 'offre_emploi', null, 'SGD', 'https://images.unsplash.com/photo-1519389950473-47ba0277781c?w=800'],
  ['Lagos', 'opportunites-affaires', 'franchise', 'Franchise café-restaurant à reprendre', "Enseigne régionale établie, formation incluse, deux emplacements disponibles.", 'vente', 25000, 'USD', 'https://images.unsplash.com/photo-1521017432531-fbd92d768814?w=800'],
  ['Nairobi', 'opportunites-affaires', 'partenariat', 'Recherche distributeur local — cosmétiques bio', "Marque européenne cherche partenaire de distribution en Afrique de l'Est, produits déjà certifiés.", 'achat', null, 'KES', 'https://images.unsplash.com/photo-1556228720-195a672e8a03?w=800'],
];

for (const [city, catSlug, subSlug, title, desc, type, price, currency, img] of demoListings) {
  insertListing.run(
    demoUserId,
    cityIdsByName[city],
    categoryIds[catSlug],
    subcategoryIds[`${catSlug}:${subSlug}`] || null,
    title,
    desc,
    type,
    price,
    currency,
    JSON.stringify([img])
  );
}

const stateCount = db.prepare('SELECT COUNT(*) AS c FROM states').get().c;
console.log(`Seed terminé : ${categoryDefs.length} catégories, ${countries.length} pays (dont ${countries.filter(c => c.federal).length} fédéraux avec ${stateCount} états/provinces), ${Object.keys(cityIdsByName).length} villes, ${demoListings.length} annonces.`);
console.log('Compte de démonstration : demo@atlas.test / demo1234');
