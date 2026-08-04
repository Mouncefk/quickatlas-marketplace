// ai.js — Appelle le fournisseur d'IA choisi par l'utilisateur (sa propre clé,
// jamais celle du site) pour traduire une annonce. Utilise le fetch natif de
// Node — aucune dépendance externe (pas de SDK officiel installé).
//
// Important : la clé API de la personne ne quitte jamais le serveur vers le
// navigateur. Le frontend demande une traduction ; le serveur déchiffre la
// clé stockée, appelle le fournisseur, et ne renvoie que le texte traduit.

const LANG_NAMES = {
  fr: 'français', en: 'anglais', ar: 'arabe', es: 'espagnol', pt: 'portugais',
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

async function callOpenAIRaw(apiKey, prompt) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
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

/**
 * Analyse une annonce à la recherche de signaux de fraude, avec la clé de
 * la personne qui déclenche l'analyse (généralement un administrateur).
 */
export async function analyzeFraudRisk({ provider, apiKey, title, description, price, currency, categoryName, riskReasons }) {
  const prompt = buildFraudPrompt({ title, description, price, currency, categoryName, riskReasons });
  const raw = provider === 'anthropic' ? await callAnthropicRaw(apiKey, prompt) : await callOpenAIRaw(apiKey, prompt);
  return parseFraudResponse(raw);
}
