// free-translate.js — Traduction automatique gratuite via l'API publique
// MyMemory (https://mymemory.translated.net), sans clé requise. Qualité
// moins naturelle qu'une IA, mais gratuite et immédiatement utilisable.
//
// ⚠️ Non testable dans l'environnement de développement où ce code a été
// écrit (pas d'accès internet) — la logique est construite à partir de
// la documentation publique de l'API, mais devra être vérifiée une fois
// déployé. Se dégrade proprement (retourne null) en cas d'échec, comme
// le reste des intégrations externes du projet.
//
// Limite connue de l'API gratuite : environ 500 caractères par requête,
// et un quota quotidien partagé (raisonnable pour un usage modéré).

const LANG_ISO = { fr: 'fr', en: 'en', ar: 'ar', es: 'es', pt: 'pt', it: 'it' };

async function translateText(text, sourceLang, targetLang) {
  if (!text || !text.trim()) return '';
  const truncated = text.slice(0, 480); // reste sous la limite de l'API gratuite
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(truncated)}&langpair=${sourceLang}|${targetLang}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    const translated = data?.responseData?.translatedText;
    if (!translated || data.responseStatus !== 200) return null;
    return translated;
  } catch {
    return null; // pas de réseau, timeout, ou réponse inattendue
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Traduit un titre + description via l'API gratuite MyMemory.
 * @returns {Promise<{title: string, description: string} | null>} null si l'un des deux appels échoue
 */
export async function translateListingFree({ title, description, sourceLangCode, targetLangCode }) {
  const source = LANG_ISO[sourceLangCode] || 'fr';
  const target = LANG_ISO[targetLangCode];
  if (!target) return null;

  const translatedTitle = await translateText(title, source, target);
  if (translatedTitle === null) return null;

  const translatedDescription = description ? await translateText(description, source, target) : '';
  if (description && translatedDescription === null) return null;

  return { title: translatedTitle, description: translatedDescription };
}
