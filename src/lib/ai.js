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

const SYSTEM_PROMPT = `You write short product descriptions for Shani'z, a Sri Lankan herbal/ayurvedic hair and skin care brand. Tone: warm, grounded, ingredient-forward — like someone who actually uses these products explaining why they like them, not a marketing department.

Hard rules:
- 2-4 sentences. No headers, no bullet points, no emoji.
- Never use "unlock", "elevate", "indulge", "seamless", "journey", "in today's world", "look no further", or similar stock marketing phrases.
- Do not use a "not just X, it's Y" or "more than X, it's Y" contrast structure.
- Do not end with a punchy one-line summary sentence as a closer.
- Vary sentence length naturally. Don't stack three adjectives in a row.
- Mention specific ingredients or effects the admin gave you — don't invent ingredients that weren't mentioned.
- If the admin gave you very little to work with, write something modest and honest rather than padding with generic claims.
- Output ONLY the description text. No preamble, no quotation marks around it.`

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
        generationConfig: { maxOutputTokens: 300 },
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
