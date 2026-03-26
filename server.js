require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY === 'your_anthropic_api_key_here') {
  console.error('❌ ANTHROPIC_API_KEY is not set in .env');
  process.exit(1);
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'website')));

// ─── Simple in-memory rate limiter (60 requests / IP / minute) ──────────────
const rateLimitMap = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > 60000) { entry.count = 0; entry.start = now; }
  entry.count++;
  rateLimitMap.set(ip, entry);
  if (entry.count > 60) return res.status(429).json({ error: 'Too many requests. Please slow down.' });
  next();
}
app.use('/api', rateLimit);

// ─── Input validation helper ─────────────────────────────────────────────────
function requireFields(fields, body) {
  for (const f of fields) {
    if (!body[f] || (typeof body[f] === 'string' && body[f].trim() === ''))
      return `Missing required field: ${f}`;
  }
  return null;
}
const MAX_TEXT = 5000; // characters

// ─── Helper: extract JSON from AI response (handles ```json blocks) ──────────
function extractJSON(text) {
  // Try direct parse first
  try { return JSON.parse(text.trim()); } catch(_) {}
  // Strip ```json ... ``` code fences
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) try { return JSON.parse(fenced[1].trim()); } catch(_) {}
  // Greedy brace match
  const braces = text.match(/\{[\s\S]*\}/);
  if (braces) try { return JSON.parse(braces[0]); } catch(_) {}
  return null;
}

// ─── AI Conversation ────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  try {
    const err = requireFields(['messages', 'language', 'level'], req.body);
    if (err) return res.status(400).json({ error: err });
    const { messages, language, level, correctionMode, scenario } = req.body;
    if (!Array.isArray(messages) || messages.length === 0)
      return res.status(400).json({ error: 'messages must be a non-empty array' });
    if (messages.length > 50)
      return res.status(400).json({ error: 'Conversation too long. Please start a new chat.' });

    let systemPrompt = scenario
      ? `You are playing the role of a ${scenario} in a role-play scenario. The student is learning ${language} at CEFR level ${level}. Speak naturally in the scenario. At the end of your reply, add a brief "📝 Language Note:" section correcting any errors.`
      : `You are a friendly native ${language} speaker and language tutor. The student is at CEFR ${level} level.
Correction mode: ${correctionMode}.
- Gentle: Have a natural conversation. At the very end of your reply, add "📝 Correction:" and list any grammar or vocabulary mistakes briefly.
- Strict: Correct every mistake inline immediately with [✓ correction] notation, then continue the conversation.
- Silent: Just have a natural conversation with no corrections at all.
Keep responses concise and match vocabulary to their ${level} level.`;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages: messages,
    });

    res.json({ reply: response.content[0].text });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Grammar / Writing / Translation Analysis ───────────────────────────────
app.post('/api/analyze', async (req, res) => {
  try {
    const err = requireFields(['text', 'type'], req.body);
    if (err) return res.status(400).json({ error: err });
    const { text, type, targetLang, writingType } = req.body;
    if (text.length > MAX_TEXT) return res.status(400).json({ error: `Text too long (max ${MAX_TEXT} characters).` });
    if (!['grammar','writing','translation'].includes(type))
      return res.status(400).json({ error: 'Invalid type' });

    let systemPrompt = '';
    let userPrompt = '';

    if (type === 'grammar') {
      systemPrompt = 'You are an expert English grammar checker. Respond ONLY with valid JSON.';
      userPrompt = `Analyze this text for grammar errors. Return JSON:
{
  "score": <0-100 integer>,
  "level": "<A1|A2|B1|B2|C1|C2>",
  "errors": [
    {
      "original": "<the wrong text>",
      "correction": "<corrected text>",
      "rule": "<grammar rule name>",
      "explanation": "<plain English explanation>",
      "severity": "<minor|moderate|critical>"
    }
  ],
  "strengths": ["<strength 1>", "<strength 2>"],
  "overall": "<one sentence summary>"
}

Text to analyze:
"""${text}"""`;
    }

    else if (type === 'writing') {
      systemPrompt = 'You are an expert writing coach. Respond ONLY with valid JSON.';
      userPrompt = `Analyze this ${writingType || 'text'} for writing quality. Return JSON:
{
  "scores": {
    "register": <0-100>,
    "coherence": <0-100>,
    "vocabulary": <0-100>,
    "style": <0-100>,
    "overall": <0-100>
  },
  "strengths": ["<s1>","<s2>","<s3>"],
  "improvements": ["<i1>","<i2>","<i3>"],
  "style_notes": "<detailed style analysis>",
  "rewrite": "<professional rewrite of the text at C1 level>"
}

Text:
"""${text}"""`;
    }

    else if (type === 'translation') {
      systemPrompt = 'You are an expert translator and linguist. Respond ONLY with valid JSON.';
      userPrompt = `Translate this text to ${targetLang}. Return JSON:
{
  "translation": "<translated text>",
  "literal": "<word-by-word literal translation>",
  "formality": "<casual|neutral|formal|very formal>",
  "cultural_notes": "<cultural context and nuances>",
  "alternatives": ["<alt phrasing 1>", "<alt phrasing 2>", "<alt phrasing 3>"],
  "register_analysis": "<explanation of register and tone>"
}

Text: """${text}"""`;
    }

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const raw = response.content[0].text;
    const parsed = extractJSON(raw);
    if (!parsed) return res.status(500).json({ error: 'Invalid AI response' });
    res.json({ result: parsed });
  } catch (err) {
    console.error('Analyze error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Content Generation ─────────────────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  try {
    const err = requireFields(['type'], req.body);
    if (err) return res.status(400).json({ error: err });
    const { type, word, language, topic, level, focus, theme, challengeType } = req.body;
    const validTypes = ['vocabulary','lesson','idioms','challenge','random_word'];
    if (!validTypes.includes(type)) return res.status(400).json({ error: 'Invalid type' });
    let systemPrompt = 'You are an expert language teacher. Respond ONLY with valid JSON.';
    let userPrompt = '';

    if (type === 'vocabulary') {
      userPrompt = `Generate a vocabulary flashcard for the word "${word}" in ${language || 'English'}. Return JSON:
{
  "word": "${word}",
  "language": "${language || 'English'}",
  "ipa": "<IPA pronunciation>",
  "part_of_speech": "<noun|verb|adjective|etc>",
  "definition": "<clear definition>",
  "examples": ["<sentence 1>", "<sentence 2>", "<sentence 3>"],
  "mnemonics": ["<memory trick 1>", "<memory trick 2>", "<memory trick 3>"],
  "collocations": ["<collocation 1>", "<collocation 2>", "<collocation 3>"],
  "difficulty": "<A1|A2|B1|B2|C1|C2>"
}`;
    }

    else if (type === 'lesson') {
      userPrompt = `Generate a complete ${level} lesson about "${topic}" focusing on ${focus}. Return JSON:
{
  "title": "<lesson title>",
  "level": "${level}",
  "topic": "${topic}",
  "vocabulary": [
    {"word": "<w>", "definition": "<d>", "example": "<e>"}
  ],
  "grammar_rules": [
    {"rule": "<rule name>", "explanation": "<clear explanation>", "example": "<example>"}
  ],
  "reading_passage": "<200-300 word passage about the topic at ${level} level>",
  "comprehension_questions": [
    {"question": "<q>", "answer": "<a>"}
  ],
  "exercises": [
    {"type": "fill_blank", "sentence": "<sentence with ___ blank>", "answer": "<answer>", "hint": "<hint>"}
  ]
}
Generate 8 vocabulary words, 3 grammar rules, 5 comprehension questions, 5 exercises.`;
    }

    else if (type === 'idioms') {
      userPrompt = `Generate 4 interesting English idioms related to the theme "${theme}". Return JSON:
{
  "theme": "${theme}",
  "idioms": [
    {
      "idiom": "<the idiom>",
      "meaning": "<what it means>",
      "origin": "<cultural/historical origin story>",
      "example": "<natural dialogue example>",
      "equivalents": {"Spanish": "<equiv>", "French": "<equiv>", "Hindi": "<equiv>"},
      "usage_tips": "<when/how to use it>"
    }
  ]
}`;
    }

    else if (type === 'challenge') {
      const prompts = {
        spot_error: `Create a "Spot the Error" challenge. A short paragraph with 3 grammar mistakes hidden in it. Return JSON:
{"type":"spot_error","instruction":"Find the 3 grammar mistakes in this paragraph:","text":"<paragraph with 3 errors>","errors":[{"wrong":"<wrong phrase>","correct":"<correct phrase>","explanation":"<why>"}]}`,
        word_of_day: `Generate a "Word of the Day" challenge for an English learner at B1 level. Return JSON:
{"type":"word_of_day","word":"<interesting word>","ipa":"<pronunciation>","definition":"<definition>","examples":["<s1>","<s2>"],"challenge":"Use this word in a sentence about your daily life."}`,
        translation: `Create a "Translation Sprint" challenge with 5 sentences to translate from English to simple Spanish or French. Return JSON:
{"type":"translation","instruction":"Translate these 5 sentences:","sentences":[{"english":"<e>","answer":"<translation>"}],"time_limit":180}`,
        dialogue: `Create a "Dialogue Completion" challenge. A 6-line conversation with 3 lines missing. Return JSON:
{"type":"dialogue","instruction":"Complete the missing lines in this conversation:","dialogue":[{"speaker":"A","line":"<line>","missing":false},{"speaker":"B","line":"","missing":true,"answer":"<expected answer>","hint":"<hint>"}],"context":"<scenario context>"}`,
        synonym: `Create a "Synonym Chain" challenge. One word, find 5 synonyms with nuance differences. Return JSON:
{"type":"synonym","word":"<target word>","instruction":"Find 5 synonyms for this word and explain the nuance difference:","synonyms":[{"word":"<syn>","nuance":"<how it differs>","example":"<usage>"}]}`,
      };

      userPrompt = prompts[challengeType] || prompts.word_of_day;
    }

    else if (type === 'random_word') {
      userPrompt = `Generate a random interesting English word at B1-B2 level suitable for a language learner. Return JSON:
{"word": "<word>"}`;
    }

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const raw = response.content[0].text;
    const parsed = extractJSON(raw);
    if (!parsed) return res.status(500).json({ error: 'Invalid AI response' });
    res.json({ result: parsed });
  } catch (err) {
    console.error('Generate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Serve app for all unknown routes ──────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'website', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚀 LangAI server running at http://localhost:${PORT}`);
  console.log(`📚 Open http://localhost:${PORT} in your browser\n`);
});
