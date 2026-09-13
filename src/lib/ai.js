// Admin-only helper: writes a product description from what the admin
// gives it (name, category, a few ingredient/benefit notes). No web
// search — it only uses what's typed in.
//
// Uses Google's Gemini API specifically because it has a genuinely free
// tier (Google AI Studio: no credit card, a daily request quota that's
// more than enough for occasional description-writing). Get a key at
// https://aistudio.google.com/apikey.
//
// Model: gemini-flash-latest is an alias Google maintains and
// auto-updates to whatever their current fast/free-tier model is —
// deliberately NOT a specific dated model name, since those get retired
// every few months (e.g. gemini-2.0-flash's retirement is what would
// have broken this if it were hardcoded). If Google ever changes what
// this alias points to in a way that stops working, override it with
// the GEMINI_MODEL env var without touching this file.
//
// The system prompt below bakes in the same "don't sound like an AI
// wrote this" principles as Anthropic's humanizer skill (no forced
// "not X, but Y" contrasts, no stacked marketing adjectives, no
// one-line mic-drop closers, vary sentence length) — that skill itself
// is a tool used while chatting, not something that ships inside a
// deployed website, so its guidance is written directly into this
// prompt instead.

const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest'

const SYSTEM_PROMPT = `You write descriptions of products and in-studio services for Shani'z, a Sri Lankan herbal/ayurvedic hair and skin care brand. This could be a retail product (an oil, a mask) or a bookable service (a scalp treatment, a massage) — write naturally for whichever it is rather than assuming it's always a bottled product. Tone: warm, grounded, ingredient-forward — like someone who actually uses these products or gets these treatments explaining why they like them, not a marketing department.

Format the output in this lightweight structure (rendered as simple rich text on the site, so stick to exactly this):
- Start with 1-2 short sentences of plain intro text (no heading needed for this part).
- Then a line "### Why you'll like it" followed by 2-4 bullet points ("- " at the start of each line), each one short benefit, ingredient, or (for a service) what the treatment includes — one idea per line.
- Nothing after the bullets — no closing summary line.

Hard rules:
- No emoji.
- Never use "unlock", "elevate", "indulge", "seamless", "journey", "in today's world", "look no further", or similar stock marketing phrases.
- Do not use a "not just X, it's Y" or "more than X, it's Y" contrast structure.
- Vary sentence length naturally. Don't stack three adjectives in a row.
- Mention specific ingredients or effects the admin gave you — don't invent ingredients that weren't mentioned.
- If the admin gave you very little to work with, write something modest and honest rather than padding with generic claims — it's fine for the bullet list to be shorter (even just 2 points) rather than inventing filler.
- Output ONLY the description text in the format above. No preamble, no quotation marks around it.`

export async function generateProductDescription({ name, category, hint }) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    const err = new Error(
      'AI description generation isn\u2019t set up yet \u2014 add a free GEMINI_API_KEY (from https://aistudio.google.com/apikey) to the backend\u2019s environment variables.'
    )
    err.status = 400
    throw err
  }

  const userMessage = [
    `Product name: ${name}`,
    category ? `Category: ${category}` : null,
    hint ? `Ingredients / notes from the admin: ${hint}` : 'No ingredient notes were given \u2014 keep it modest.',
  ]
    .filter(Boolean)
    .join('\n')

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ parts: [{ text: userMessage }] }],
        // Newer Gemini Flash models spend part of this budget on an
        // internal "thinking" pass before writing the visible answer —
        // with a small maxOutputTokens (this used to be 300), that
        // thinking could eat almost the whole budget and leave the
        // actual description cut off mid-sentence (exactly what showed
        // up in testing). thinkingBudget: 0 turns that off entirely for
        // this simple, non-reasoning task, and the larger token cap is
        // a safety margin on top of that, not a requirement.
        generationConfig: {
          maxOutputTokens: 1024,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    }
  )

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    // Gemini's free tier is rate-limited (a handful of requests per
    // minute) — surface a 429 distinctly since "wait a moment and try
    // again" is a different fix than "your key is wrong".
    if (response.status === 429) {
      const err = new Error('The free Gemini quota was hit for the moment \u2014 wait about a minute and try again.')
      err.status = 429
      throw err
    }
    const err = new Error(`AI request failed (${response.status}). ${body.slice(0, 200)}`)
    err.status = 502
    throw err
  }

  const data = await response.json()
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('')?.trim()
  if (!text) {
    const err = new Error('AI response did not include any text \u2014 it may have been blocked by a safety filter. Try rephrasing the hint.')
    err.status = 502
    throw err
  }
  return text
}

// One-click admin translation (Sinhala/Tamil) — used by TranslationFields.jsx
// so admins don't have to hand-type every name/description twice. The
// admin always sees and can edit the result before saving, same as the
// description generator above; this never writes to the database
// directly. Shares the same GEMINI_API_KEY/MODEL as the description
// generator above rather than needing a second key.
const TRANSLATE_LANGUAGE_NAMES = { si: 'Sinhala', ta: 'Tamil' }

export async function translateText({ text, targetLang }) {
  const languageName = TRANSLATE_LANGUAGE_NAMES[targetLang]
  if (!languageName) {
    const err = new Error(`Unsupported target language: ${targetLang}`)
    err.status = 400
    throw err
  }

  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    const err = new Error(
      'Auto-translate isn\u2019t set up yet \u2014 add a free GEMINI_API_KEY (from https://aistudio.google.com/apikey) to the backend\u2019s environment variables.'
    )
    err.status = 400
    throw err
  }

  if (!text?.trim()) {
    const err = new Error('Nothing to translate \u2014 fill in the English text first.')
    err.status = 400
    throw err
  }

  const prompt =
    `Translate the following English text for a Sri Lankan herbal/ayurvedic beauty brand's ` +
    `website into natural, everyday ${languageName} \u2014 the way a fluent ${languageName} speaker ` +
    `would actually write it for customers, not a stiff literal translation. Preserve the tone ` +
    `(warm, simple). If the text contains simple markdown like "### " headings or "- " bullet ` +
    `points, keep that same structure in the translation. Return ONLY the translated text \u2014 ` +
    `no quotes, no notes, no explanation.\n\nText:\n${text}`

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 1024,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    }
  )

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    if (response.status === 429) {
      const err = new Error('The free Gemini quota was hit for the moment \u2014 wait about a minute and try again.')
      err.status = 429
      throw err
    }
    const err = new Error(`Translation request failed (${response.status}). ${body.slice(0, 200)}`)
    err.status = 502
    throw err
  }

  const data = await response.json()
  const translated = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('')?.trim()
  if (!translated) {
    const err = new Error('Translation came back empty \u2014 it may have been blocked by a safety filter.')
    err.status = 502
    throw err
  }
  return translated
}
