// ai.js — Appelle le fournisseur d'IA choisi par l'utilisateur (sa propre clé,
// jamais celle du site) pour traduire une annonce. Utilise le fetch natif de
// Node — aucune dépendance externe (pas de SDK officiel installé).
//
// Important : la clé API de la personne ne quitte jamais le serveur vers le
// navigateur. Le frontend demande une traduction ; le serveur déchiffre la
// clé stockée, appelle le fournisseur, et ne renvoie que le texte traduit.

const LANG_NAMES = {
  fr: 'français', en: 'anglais', ar: 'arabe', es: 'espagnol', pt: 'portugais', it: 'italien', de: 'allemand',
};

function buildPrompt(title, description, targetLangCode) {
  const targetLang = LANG_NAMES[targetLangCode] || targetLangCode;
  return [
    `Traduis l'annonce suivante en ${targetLang}. Réponds UNIQUEMENT avec un objet JSON`,
    `de la forme {"title": "...", "description": "..."}, sans aucun texte avant ou après,`,
    `sans balises markdown. Ne traduis pas les noms propres, marques ou chiffres.`,
    ``,
    `Titre : ${title}`,
    `Description : ${description || '(aucune description)'}`,
  ].join('\n');
}

function parseTranslationResponse(raw) {
  const cleaned = raw.trim().replace(/^```json\s*|^```\s*|```$/g, '');
  const parsed = JSON.parse(cleaned);
  if (!parsed.title) throw new Error('Réponse de traduction invalide.');
  return { title: parsed.title, description: parsed.description || '' };
}

async function callAnthropicRaw(apiKey, prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Erreur Anthropic (${res.status})`);
  return (data.content || []).map((b) => b.text || '').join('');
}

// `json` : impose le mode JSON d'OpenAI. À désactiver pour tout prompt qui
// attend du texte brut (post, traduction libre) — OpenAI refuse le mode
// JSON quand le prompt ne mentionne pas explicitement le mot « JSON ».
async function callOpenAIRaw(apiKey, prompt, { json = true } = {}) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Erreur OpenAI (${res.status})`);
  return data.choices?.[0]?.message?.content || '';
}

async function callAnthropic(apiKey, prompt) {
  return parseTranslationResponse(await callAnthropicRaw(apiKey, prompt));
}

async function callOpenAI(apiKey, prompt) {
  return parseTranslationResponse(await callOpenAIRaw(apiKey, prompt));
}

/**
 * Traduit un titre + description via le fournisseur/clé de l'utilisateur.
 * @returns {Promise<{title: string, description: string}>}
 */
export async function translateListing({ provider, apiKey, title, description, targetLangCode }) {
  const prompt = buildPrompt(title, description, targetLangCode);
  if (provider === 'anthropic') return callAnthropic(apiKey, prompt);
  if (provider === 'openai') return callOpenAI(apiKey, prompt);
  throw new Error('Fournisseur IA inconnu.');
}

function buildDraftPrompt({ categoryName, subcategoryName, listingType, notes }) {
  const typeLabel = { vente: 'à vendre', location: 'à louer', offre_emploi: "offre d'emploi", demande_emploi: "recherche d'emploi" }[listingType] || listingType;
  return [
    `Rédige une annonce ${typeLabel} pour une place de marché en ligne, catégorie "${categoryName}"`,
    subcategoryName ? `(nature précise : ${subcategoryName}).` : `.`,
    `Notes fournies par l'auteur (informations à respecter, ne rien inventer de faux) :`,
    notes || '(aucune note fournie — reste générique et invite à compléter les détails)',
    ``,
    `Réponds UNIQUEMENT avec un objet JSON de la forme {"title": "...", "description": "..."},`,
    `sans aucun texte avant ou après, sans balises markdown. Le titre fait moins de 70 caractères,`,
    `clair et concret. La description fait 2 à 4 phrases, factuelle, sans emojis superflus,`,
    `dans la même langue que les notes fournies.`,
  ].join('\n');
}

/**
 * Génère un brouillon de titre + description à partir de notes en vrac.
 * @returns {Promise<{title: string, description: string}>}
 */
export async function draftListing({ provider, apiKey, categoryName, subcategoryName, listingType, notes }) {
  const prompt = buildDraftPrompt({ categoryName, subcategoryName, listingType, notes });
  if (provider === 'anthropic') return callAnthropic(apiKey, prompt);
  if (provider === 'openai') return callOpenAI(apiKey, prompt);
  throw new Error('Fournisseur IA inconnu.');
}

function buildFraudPrompt({ title, description, price, currency, categoryName, riskReasons }) {
  return [
    `Tu es un analyste de confiance pour une place de marché en ligne. Évalue l'annonce suivante`,
    `et indique si elle présente des signes possibles d'arnaque ou de contenu problématique.`,
    `Sois factuel et mesuré : ne conclus jamais à une fraude avérée, seulement à des signaux à vérifier.`,
    ``,
    `Catégorie : ${categoryName}`,
    `Titre : ${title}`,
    `Description : ${description || '(aucune)'}`,
    `Prix : ${price !== null && price !== undefined ? price + ' ' + currency : 'non précisé'}`,
    `Signaux heuristiques déjà détectés : ${riskReasons && riskReasons.length ? riskReasons.join(', ') : 'aucun'}`,
    ``,
    `Réponds UNIQUEMENT avec un objet JSON de la forme`,
    `{"assessment": "...", "recommendation": "..."}, sans texte avant/après, sans markdown.`,
    `"assessment" : 2-3 phrases d'analyse. "recommendation" : une phrase d'action suggérée`,
    `(ex. "Vérifier l'identité du vendeur avant tout paiement" ou "Rien de particulier à signaler").`,
  ].join('\n');
}

function parseFraudResponse(raw) {
  const cleaned = raw.trim().replace(/^```json\s*|^```\s*|```$/g, '');
  const parsed = JSON.parse(cleaned);
  if (!parsed.assessment) throw new Error("Réponse d'analyse invalide.");
  return { assessment: parsed.assessment, recommendation: parsed.recommendation || '' };
}

function buildProspectQualificationPrompt({ publicName, companyName, professionalTitle, rawText, categoryTree }) {
  return [
    `Tu classes un professionnel repéré manuellement dans la taxonomie d'une place de marché,`,
    `à partir des informations fournies ci-dessous — toutes déjà transmises par la personne qui`,
    `te sollicite, tu n'as accès à aucune autre source.`,
    ``,
    `Nom : ${publicName}`,
    `Entreprise : ${companyName || '(non précisé)'}`,
    `Titre professionnel : ${professionalTitle || '(non précisé)'}`,
    `Notes ou description libre : ${rawText || '(aucune)'}`,
    ``,
    `Taxonomie disponible (catégorie > sous-catégorie) :`,
    categoryTree,
    ``,
    `Réponds UNIQUEMENT avec un objet JSON de la forme`,
    `{"category": "...", "subcategory": "...", "activity": "...", "specialty": "...", "confidence": 0-100, "explanation": "..."},`,
    `sans texte avant/après, sans markdown. "category" et "subcategory" doivent reprendre exactement`,
    `un intitulé de la taxonomie fournie ci-dessus — jamais un intitulé inventé. "activity" et`,
    `"specialty" peuvent être proposés librement si pertinents, sinon laissés vides ("").`,
    `"confidence" reflète ta certitude sur ce classement précis, en tenant compte du peu`,
    `d'information disponible. "explanation" : 1-2 phrases justifiant le choix.`,
  ].join('\n');
}

function parseProspectQualificationResponse(raw) {
  const cleaned = raw.trim().replace(/^```json\s*|^```\s*|```$/g, '');
  const parsed = JSON.parse(cleaned);
  if (!parsed.category || !parsed.subcategory) throw new Error('Réponse de qualification invalide.');
  return {
    category: parsed.category,
    subcategory: parsed.subcategory,
    activity: parsed.activity || '',
    specialty: parsed.specialty || '',
    confidence: Math.max(0, Math.min(100, Number(parsed.confidence) || 0)),
    explanation: parsed.explanation || '',
  };
}

/**
 * Qualifie un prospect (déjà identifié manuellement) dans la taxonomie —
 * avec la clé de la personne qui déclenche l'analyse. Le résultat reste
 * une proposition à valider par un humain, jamais une vérification en
 * soi (voir la règle de la section 5 de la spécification réseau
 * professionnel : un classement automatique ne doit jamais être
 * présenté comme vérifié).
 */
function buildSocialPostPrompt({ siteName, siteUrl, highlights }) {
  return [
    `Tu rédiges un post Facebook pour la page officielle de ${siteName}, une marketplace`,
    `d'annonces en ligne. Le ton doit être engageant, chaleureux, jamais robotique — comme`,
    `rédigé par une vraie personne qui aime ce qu'elle fait, pas une IA qui liste des faits.`,
    ``,
    `Voici des éléments réels et récents de la plateforme à évoquer, au choix (pas`,
    `besoin de tous les utiliser — choisis ce qui fait le post le plus vivant) :`,
    highlights,
    ``,
    `Contraintes :`,
    `- 2 à 4 phrases maximum, adapté à un post Facebook (pas un roman)`,
    `- Toujours en français`,
    `- Jamais de fausse information ou de chiffre inventé — reste uniquement sur ce qui`,
    `  est fourni ci-dessus`,
    `- Termine par un appel à l'action naturel vers ${siteUrl}`,
    `- N'utilise PAS de guillemets autour du texte, pas de markdown, pas de hashtags`,
    `  excessifs (2-3 maximum si pertinent)`,
    ``,
    `Réponds UNIQUEMENT avec le texte du post, rien d'autre avant ou après.`,
  ].join('\n');
}

/**
 * Génère un post pour les réseaux sociaux à partir de données réelles et
 * récentes de la plateforme (jamais inventées) — utilisé pour la
 * publication automatique périodique, avec la clé de l'administrateur
 * qui a configuré la fonctionnalité.
 */
export async function generateSocialPostContent({ provider, apiKey, siteName, siteUrl, highlights }) {
  const prompt = buildSocialPostPrompt({ siteName, siteUrl, highlights });
  const raw = provider === 'anthropic' ? await callAnthropicRaw(apiKey, prompt) : await callOpenAIRaw(apiKey, prompt, { json: false });
  const cleaned = raw.trim().replace(/^["']|["']$/g, '');
  if (!cleaned) throw new Error('Contenu généré vide.');
  return cleaned;
}

export async function qualifyProspect({ provider, apiKey, publicName, companyName, professionalTitle, rawText, categoryTree }) {
  const prompt = buildProspectQualificationPrompt({ publicName, companyName, professionalTitle, rawText, categoryTree });
  const raw = provider === 'anthropic' ? await callAnthropicRaw(apiKey, prompt) : await callOpenAIRaw(apiKey, prompt);
  return parseProspectQualificationResponse(raw);
}

/**
 * Analyse une annonce à la recherche de signaux de fraude, avec la clé de
 * la personne qui déclenche l'analyse (généralement un administrateur).
 */
export async function analyzeFraudRisk({ provider, apiKey, title, description, price, currency, categoryName, riskReasons }) {
  const prompt = buildFraudPrompt({ title, description, price, currency, categoryName, riskReasons });
  const raw = provider === 'anthropic' ? await callAnthropicRaw(apiKey, prompt) : await callOpenAIRaw(apiKey, prompt);
  return parseFraudResponse(raw);
}

function buildTextTranslationPrompt(text, targetLangCode) {
  const targetLang = LANG_NAMES[targetLangCode] || targetLangCode;
  return [
    `Traduis le texte suivant en ${targetLang}. Réponds UNIQUEMENT avec le texte traduit,`,
    `sans aucun texte avant ou après, sans guillemets, sans balises markdown, en conservant`,
    `les sauts de ligne éventuels.`,
    ``,
    text,
  ].join('\n');
}

/**
 * Traduit un texte libre (ex. une rubrique de fiche pays) via le
 * fournisseur/clé de l'utilisateur. Pas de mise en cache ici : c'est une
 * traduction à la demande, déclenchée manuellement par un clic.
 * @returns {Promise<string>}
 */
export async function translateText({ provider, apiKey, text, targetLangCode }) {
  const prompt = buildTextTranslationPrompt(text, targetLangCode);
  const raw = provider === 'anthropic' ? await callAnthropicRaw(apiKey, prompt) : await callOpenAIRaw(apiKey, prompt, { json: false });
  return raw.trim().replace(/^["']|["']$/g, '');
}

// ---------------------------------------------------------------------------
// Posts pour LinkedIn / TikTok / Facebook — texte à relire et publier par la
// personne elle-même (jamais de publication automatique sur un profil).
// Deux sources possibles : une annonce précise (bouton de partage sur
// l'annonce) ou un sujet libre de l'administrateur (onglet Réseaux sociaux).
// ---------------------------------------------------------------------------

const NETWORK_RULES = {
  linkedin: [
    `Réseau : LinkedIn. Ton professionnel, clair et chaleureux, sans jargon marketing creux.`,
    `Format : une première ligne d'accroche forte (elle s'affiche seule avant « voir plus »),`,
    `puis 3 à 6 lignes courtes aérées, avec au maximum 2 ou 3 emojis sobres.`,
    `Termine par un appel à l'action naturel. Le lien est déjà attaché au post sous forme`,
    `de carte : n'écris AUCUNE URL dans le texte.`,
    `Ajoute 3 à 5 hashtags pertinents sur la dernière ligne.`,
    `Longueur : 400 à 900 caractères.`,
  ],
  tiktok: [
    `Réseau : TikTok. Il s'agit de la LÉGENDE d'une vidéo ou d'un carrousel photo.`,
    `Ton direct, vivant, proche de l'oral. La première ligne est un hook qui donne envie`,
    `de regarder. 2 à 4 emojis bien placés.`,
    `Les liens ne sont pas cliquables sur TikTok : n'écris aucune URL, invite plutôt à`,
    `chercher le nom du site ou à passer par le lien en bio.`,
    `Termine par 4 à 6 hashtags pertinents, dont au moins un lié à la ville ou au pays`,
    `quand ils sont connus.`,
    `Longueur : 150 à 400 caractères.`,
  ],
  facebook: [
    `Réseau : Facebook. Ton engageant et chaleureux, comme rédigé par une vraie personne.`,
    `2 à 4 phrases, 2 ou 3 hashtags au maximum si pertinents.`,
    `Termine par un appel à l'action naturel.`,
  ],
};

function buildNetworkPostPrompt({ network, lang, siteName, siteUrl, listingFacts, subject, highlights }) {
  const rules = NETWORK_RULES[network] || NETWORK_RULES.facebook;
  const langName = LANG_NAMES[lang] || 'français';
  const source = listingFacts
    ? [
        `Tu rédiges un post pour faire connaître l'annonce suivante, publiée sur ${siteName}`,
        `(place de marché d'annonces en ligne). Le post est publié par l'auteur de l'annonce`,
        `lui-même, sur son propre compte.`,
        ``,
        `Informations RÉELLES de l'annonce (les seules que tu peux utiliser) :`,
        listingFacts,
      ]
    : [
        `Tu rédiges un post pour le compte officiel de ${siteName} (${siteUrl}), une place de`,
        `marché d'annonces en ligne (immobilier, véhicules, emploi, objets...).`,
        ``,
        `Sujet choisi par l'administrateur (c'est le cœur du post) :`,
        subject,
        ``,
        `Éléments réels et récents de la plateforme, à citer seulement s'ils servent le sujet :`,
        highlights,
      ];
  return [
    ...source,
    ``,
    ...rules,
    ``,
    `Règles absolues :`,
    `- Rédige en ${langName}.`,
    `- N'invente AUCUN fait, chiffre, prix, caractéristique ou témoignage absent des`,
    `  informations fournies.`,
    `- Pas de markdown, pas de guillemets autour du texte.`,
    ``,
    `Réponds UNIQUEMENT avec le texte du post, rien avant ni après.`,
  ].join('\n');
}

/**
 * Rédige un post adapté à un réseau (linkedin | tiktok | facebook), soit à
 * partir d'une annonce (listingFacts), soit à partir d'un sujet libre
 * (subject + highlights). Retourne du texte brut, prêt à être relu.
 */
export async function generateNetworkPost({ provider, apiKey, network, lang, siteName, siteUrl, listingFacts, subject, highlights }) {
  const prompt = buildNetworkPostPrompt({ network, lang, siteName, siteUrl, listingFacts, subject, highlights });
  const raw = provider === 'anthropic' ? await callAnthropicRaw(apiKey, prompt) : await callOpenAIRaw(apiKey, prompt, { json: false });
  const cleaned = raw.trim().replace(/^["'«]\s*|\s*["'»]$/g, '');
  if (!cleaned) throw new Error('Contenu généré vide.');
  return cleaned;
}
