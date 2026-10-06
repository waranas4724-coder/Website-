require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path = require('path');
const crypto = require('crypto');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');

const {
  getPrompts,
  getPromptBySlug,
  addPrompt,
  deletePrompt,
  getProviders,
  addProvider,
  updateProvider,
  deleteProvider,
  getSettings,
  saveSettings,
  getAds,
  saveAds,
  getPosterUsers,
  savePosterUsers
} = require('./db');

const app = express();
const PORT = Number(process.env.PORT || 3000);

// Direct gallery uploads from phones/tablets. Files stay in memory only
// and are immediately uploaded to Cloudinary, so Render's local disk is
// never used for permanent media storage.
const galleryUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    if (String(file.mimetype || '').startsWith('image/')) {
      return cb(null, true);
    }

    return cb(new Error('Only image files are allowed.'));
  }
});

// Manual/Admin/Poster media uploads. Images and videos are sent directly
// to Cloudinary; nothing permanent is written to Render's local disk.
const mediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    const type = String(file.mimetype || '');
    if (type.startsWith('image/') || type.startsWith('video/')) {
      return cb(null, true);
    }

    return cb(new Error('Only image or video files are allowed.'));
  }
});

app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret:
    process.env.SESSION_SECRET ||
    crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: 'auto',
    maxAge: 8 * 60 * 60 * 1000
  }
}));

const ADMIN_USERNAME =
  process.env.ADMIN_USERNAME || 'admin';

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD || '';

/* =========================================================
   CREATIVE CATEGORIES
========================================================= */

const CREATIVE_CATEGORIES = [
  'Portrait Photography',
  'Fashion Photography',
  'Brand Design',
  'Commercial Photography',
  'Product Photography',
  'Architecture',
  'Travel Photography',
  'Editorial Photography',
  'Cinematic Photography',
  'Nature Photography',
  'Automotive Photography',
  'Food Photography',
  'Interior Design',
  'Graphic Design',
  'Fantasy Art',
  'Creative Art',
  'Luxury',
  'Minimalist',
  'Lifestyle',
  'Surreal Art'
];

/* =========================================================
   API ROTATION
========================================================= */

const providerCursors = new Map();

function clean(value, max = 20000) {
  return String(value ?? '')
    .trim()
    .slice(0, max);
}

function normalizeCategory(value) {
  const s = clean(value)
    .toLowerCase()
    .replace(/[\s/-]+/g, '_');

  if (
    [
      'trending',
      'trending_search',
      'trendingsearch'
    ].includes(s)
  ) {
    return 'trending_search';
  }

  if (
    [
      'prompt',
      'prompt_generate',
      'promptgenerate'
    ].includes(s)
  ) {
    return 'prompt_generate';
  }

  if (
    [
      'photo',
      'image',
      'photo_generate',
      'image_generate',
      'photogenerate'
    ].includes(s)
  ) {
    return 'photo_generate';
  }

  return s;
}

function normalizeProvider(p) {
  return {
    ...p,

    id: p.id,

    category: normalizeCategory(
      p.category ||
      p.type ||
      p.provider_category
    ),

    providerName: clean(
      p.providerName ||
      p.provider_name ||
      p.name ||
      p.provider ||
      ''
    ),

    apiKey: clean(
      p.apiKey ||
      p.api_key ||
      p.key ||
      '',
      20000
    ),

    enabled:
      p.enabled === true ||
      p.enabled === 1 ||
      p.enabled === 'true'
  };
}

async function allProviders() {
  const rows = await getProviders();

  return Array.isArray(rows)
    ? rows.map(normalizeProvider)
    : [];
}

async function providersFor(category) {
  const wanted = normalizeCategory(category);
  const providers = await allProviders();

  const enabled = providers.filter(p => {
    if (p.category !== wanted || !p.enabled || !p.providerName) {
      return false;
    }

    if (p.apiKey) return true;

    const name = clean(p.providerName).toLowerCase();

    return (
      wanted === 'trending_search' &&
      ['bluesky', 'bluesky public', 'reddit', 'reddit api', 'reddit public', 'reddit (public)'].includes(name)
    );
  });

  // Same provider accidentally added more than once = use only once.
  const unique = new Map();

  for (const provider of enabled) {
    const key =
      `${wanted}::${clean(provider.providerName).toLowerCase()}`;

    if (!unique.has(key)) {
      unique.set(key, provider);
    }
  }

  return Array.from(unique.values());
}

function providerOrder(
  category,
  providers
) {
  if (!providers.length) {
    return [];
  }

  const key =
    normalizeCategory(category);

  const start =
    Number(
      providerCursors.get(key) || 0
    ) % providers.length;

  return providers.map(
    (provider, offset) => ({
      provider,

      index:
        (start + offset) %
        providers.length
    })
  );
}

function markProviderSuccess(
  category,
  index,
  total
) {
  if (!total) return;

  providerCursors.set(
    normalizeCategory(category),
    (index + 1) % total
  );
}

function providerNameMatches(
  name,
  expected
) {
  return (
    clean(name).toLowerCase() ===
    expected.toLowerCase()
  );
}

/* =========================================================
   HELPERS
========================================================= */

function slugify(value) {
  return (
    clean(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 90) ||
    'prompt'
  );
}

function makeSlug(title) {
  return (
    `${slugify(title)}-${crypto
      .randomBytes(3)
      .toString('hex')}`
  );
}

function uniqueTitle(
  base,
  existing
) {
  const original =
    clean(base, 140) ||
    'AI Visual Prompt';

  const used = new Set(
    (existing || []).map(p =>
      clean(
        p.title,
        140
      ).toLowerCase()
    )
  );

  if (
    !used.has(
      original.toLowerCase()
    )
  ) {
    return original;
  }

  let n = 2;

  while (
    used.has(
      `${original} ${n}`.toLowerCase()
    )
  ) {
    n++;
  }

  return `${original} ${n}`;
}

async function fetchJson(
  url,
  options = {}
) {
  const response = await fetch(
    url,
    {
      ...options,

      signal:
        options.signal ||
        AbortSignal.timeout(
          30000
        )
    }
  );

  const text =
    await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = {
      raw: text
    };
  }

  if (!response.ok) {
    const message =
      data?.error?.message ||
      data?.message ||
      data?.error ||
      `HTTP ${response.status}`;

    const err =
      new Error(
        `${response.status} ${String(
          message
        ).slice(0, 500)}`
      );

    err.status =
      response.status;

    throw err;
  }

  return data;
}

async function fetchBinary(
  url,
  options = {}
) {
  const response =
    await fetch(
      url,
      {
        ...options,

        signal:
          options.signal ||
          AbortSignal.timeout(
            120000
          )
      }
    );

  if (!response.ok) {
    const text =
      await response
        .text()
        .catch(() => '');

    throw new Error(
      `HTTP ${response.status}${
        text
          ? `: ${text.slice(0, 300)}`
          : ''
      }`
    );
  }

  return Buffer.from(
    await response.arrayBuffer()
  );
}

/* =========================================================
   TRENDING / SOCIAL MEDIA APIs
========================================================= */

async function trendingNewsData(
  apiKey
) {
  const url =
    `https://newsdata.io/api/1/latest?apikey=${encodeURIComponent(
      apiKey
    )}&language=en&size=10`;

  const data =
    await fetchJson(url);

  return (
    Array.isArray(
      data.results
    )
      ? data.results
      : []
  )
    .map(x => ({
      title: clean(
        x.title,
        180
      ),

      description: clean(
        x.description ||
        x.content ||
        '',
        500
      )
    }))
    .filter(x => x.title);
}

async function trendingGNews(
  apiKey
) {
  const url =
    `https://gnews.io/api/v4/top-headlines?lang=en&max=10&apikey=${encodeURIComponent(
      apiKey
    )}`;

  const data =
    await fetchJson(url);

  return (
    Array.isArray(
      data.articles
    )
      ? data.articles
      : []
  )
    .map(x => ({
      title: clean(
        x.title,
        180
      ),

      description: clean(
        x.description ||
        x.content ||
        '',
        500
      )
    }))
    .filter(x => x.title);
}

async function trendingReddit(
  apiKey
) {
  const headers = {
    'User-Agent':
      'PromptForge/1.0 trend-discovery',

    ...(apiKey
      ? {
          Authorization:
            `Bearer ${apiKey}`
        }
      : {})
  };

  const data =
    await fetchJson(
      'https://www.reddit.com/r/popular/hot.json?limit=20',
      { headers }
    );

  const children =
    data?.data?.children ||
    [];

  return children
    .map(x => ({
      title: clean(
        x?.data?.title,
        180
      ),

      description: clean(
        x?.data?.selftext ||
        x?.data?.subreddit_name_prefixed ||
        '',
        500
      )
    }))
    .filter(x => x.title);
}

async function trendingYouTube(
  apiKey
) {
  const url =
    `https://www.googleapis.com/youtube/v3/videos?part=snippet&chart=mostPopular&regionCode=US&maxResults=20&key=${encodeURIComponent(
      apiKey
    )}`;

  const data =
    await fetchJson(url);

  return (
    Array.isArray(
      data.items
    )
      ? data.items
      : []
  )
    .map(x => ({
      title: clean(
        x?.snippet?.title,
        180
      ),

      description: clean(
        x?.snippet?.description ||
        '',
        500
      )
    }))
    .filter(x => x.title);
}

async function trendingX(
  apiKey
) {
  if (!apiKey) {
    throw new Error(
      'X/Twitter requires a Bearer token.'
    );
  }

  const data =
    await fetchJson(
      'https://api.x.com/2/tweets/search/recent?query=-is:retweet&max_results=25&tweet.fields=created_at,lang',
      {
        headers: {
          Authorization:
            `Bearer ${apiKey}`
        }
      }
    );

  return (
    Array.isArray(
      data.data
    )
      ? data.data
      : []
  )
    .map(x => ({
      title: clean(
        x.text,
        180
      ),

      description:
        `X recent post${
          x.created_at
            ? ` · ${x.created_at}`
            : ''
        }`
    }))
    .filter(x => x.title);
}

async function trendingBluesky() {
  const url =
    'https://public.api.bsky.app/xrpc/app.bsky.feed.getFeed?feed=at%3A%2F%2Fdid%3Aplc%3Az72i7hdynmk6r22z27h6tvur%2Fapp.bsky.feed.generator%2Fwhats-hot&limit=25';

  const data =
    await fetchJson(url);

  return (
    Array.isArray(
      data.feed
    )
      ? data.feed
      : []
  )
    .map(x => ({
      title: clean(
        x?.post?.record?.text,
        180
      ),

      description: clean(
        x?.post?.record?.createdAt ||
        '',
        500
      )
    }))
    .filter(x => x.title);
}

async function getTrendSignal() {
  const providers =
    await providersFor(
      'trending_search'
    );

  console.log(
    '[AUTO] Trend providers:',
    providers
      .map(p => p.providerName)
      .join(', ') ||
      'none'
  );

  for (
    const {
      provider,
      index
    } of providerOrder(
      'trending_search',
      providers
    )
  ) {
    try {
      let items = [];

      const name =
        clean(
          provider.providerName
        ).toLowerCase();

      if (
        providerNameMatches(
          provider.providerName,
          'NewsData.io'
        )
      ) {
        items =
          await trendingNewsData(
            provider.apiKey
          );
      }

      else if (
        providerNameMatches(
          provider.providerName,
          'GNews'
        )
      ) {
        items =
          await trendingGNews(
            provider.apiKey
          );
      }

      else if (
        [
          'reddit',
          'reddit api',
          'reddit public',
          'reddit (public)'
        ].includes(name)
      ) {
        items =
          await trendingReddit(
            provider.apiKey
          );
      }

      else if (
        [
          'youtube',
          'youtube api',
          'youtube data api'
        ].includes(name)
      ) {
        items =
          await trendingYouTube(
            provider.apiKey
          );
      }

      else if (
        [
          'x',
          'x api',
          'twitter',
          'twitter api'
        ].includes(name)
      ) {
        items =
          await trendingX(
            provider.apiKey
          );
      }

      else if (
        [
          'bluesky',
          'bluesky public'
        ].includes(name)
      ) {
        items =
          await trendingBluesky();
      }

      else {
        throw new Error(
          `Unsupported Trending provider: ${provider.providerName}`
        );
      }

      if (!items.length) {
        throw new Error(
          'Provider returned no trend items.'
        );
      }

      const pick =
        items[
          Math.floor(
            Math.random() *
            Math.min(
              items.length,
              10
            )
          )
        ];

      markProviderSuccess(
        'trending_search',
        index,
        providers.length
      );

      console.log(
        `[AUTO] Trend source: ${provider.providerName}`
      );

      return {
        signal:
          pick.title,

        context:
          pick.description,

        provider:
          provider.providerName
      };

    } catch (error) {
      console.error(
        `[AUTO ERROR] Trend ${provider.providerName}:`,
        error.message
      );
    }
  }

  const fallback =
    CREATIVE_SEEDS[
      Math.floor(
        Math.random() *
        CREATIVE_SEEDS.length
      )
    ];

  return {
    signal: fallback,
    context: '',
    provider:
      'Creative Seed'
  };
}

/* =========================================================
   GEMINI
========================================================= */

function extractGeminiText(
  data
) {
  const parts =
    data?.candidates?.[0]
      ?.content?.parts;

  if (
    Array.isArray(parts)
  ) {
    return parts
      .map(p => p?.text || '')
      .join('\n')
      .trim();
  }

  return '';
}

function extractJsonObject(
  text
) {
  const raw =
    clean(text, 20000)
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();

  try {
    return JSON.parse(raw);
  } catch {}

  const start =
    raw.indexOf('{');

  const end =
    raw.lastIndexOf('}');

  if (
    start >= 0 &&
    end > start
  ) {
    try {
      return JSON.parse(
        raw.slice(
          start,
          end + 1
        )
      );
    } catch {}
  }

  return null;
}

async function generateWithGemini(
  apiKey,
  trend,
  category
) {
  if (!apiKey) {
    throw new Error(
      'Gemini API key missing.'
    );
  }

  const model =
    'gemini-3.5-flash-lite';

  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(
      apiKey
    )}`;

  const systemPrompt = `
You create original AI visual concepts for a premium
AI prompt website.

Do NOT copy or reproduce a news article.
Use the trend only as inspiration.

Return ONLY valid JSON:

{
  "title": "...",
  "category": "...",
  "concept": "...",
  "imagePrompt": "..."
}

Rules:
- title: short premium creative title
- category: one suitable photography/art/design category
- concept: one sentence explaining the visual concept
- imagePrompt: detailed production-ready image generation prompt
- imagePrompt must describe subject, composition,
  camera, lens, lighting, environment, colors,
  materials/textures, atmosphere and professional finish
- no markdown
- no copyrighted character names
- no real person's identity
- no article text
- no URLs
`;

  const userPrompt = `
Trend signal:
${clean(trend.signal, 500)}

Trend context:
${clean(trend.context, 1000)}

Preferred creative category:
${clean(category, 100)}

Create one original visual concept.
`;

  const data =
    await fetchJson(
      endpoint,
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/json'
        },

        body: JSON.stringify({
          contents: [
            {
              role: 'user',

              parts: [
                {
                  text:
                    `${systemPrompt}\n${userPrompt}`
                }
              ]
            }
          ],

          generationConfig: {
            temperature: 0.9,
            maxOutputTokens: 1800,
            responseMimeType:
              'application/json'
          }
        })
      }
    );

  const text =
    extractGeminiText(data);

  const parsed =
    extractJsonObject(text);

  if (!parsed) {
    throw new Error(
      'Gemini returned invalid JSON.'
    );
  }

  if (
    !clean(
      parsed.imagePrompt
    )
  ) {
    throw new Error(
      'Gemini did not return imagePrompt.'
    );
  }

  return {
    title:
      clean(
        parsed.title,
        140
      ) ||
      'AI Visual Concept',

    category:
      clean(
        parsed.category,
        100
      ) ||
      category,

    concept:
      clean(
        parsed.concept,
        500
      ),

    imagePrompt:
      clean(
        parsed.imagePrompt,
        10000
      ),

    model
  };
}
/* =========================================================
   PROMPT PROVIDER ROTATION
========================================================= */

async function generatePrompt(
  trend,
  category
) {
  const providers =
    await providersFor(
      'prompt_generate'
    );

  if (!providers.length) {
    throw new Error(
      'No enabled Prompt Generate API found.'
    );
  }

  for (
    const {
      provider,
      index
    } of providerOrder(
      'prompt_generate',
      providers
    )
  ) {
    try {
      const name =
        clean(
          provider.providerName
        ).toLowerCase();

      let result;

      if (
        name === 'gemini' ||
        name === 'google gemini' ||
        name === 'gemini api'
      ) {
        result =
          await generateWithGemini(
            provider.apiKey,
            trend,
            category
          );
      }

      else {
        throw new Error(
          `Unsupported Prompt provider: ${provider.providerName}`
        );
      }

      if (
        !result ||
        !result.imagePrompt
      ) {
        throw new Error(
          'Prompt provider returned empty result.'
        );
      }

      markProviderSuccess(
        'prompt_generate',
        index,
        providers.length
      );

      console.log(
        `[AUTO] Prompt API: ${provider.providerName}`
      );

      return {
        ...result,

        provider:
          provider.providerName
      };

    } catch (error) {
      console.error(
        `[AUTO ERROR] Prompt ${provider.providerName}:`,
        error.message
      );
    }
  }

  throw new Error(
    'All Prompt Generate APIs failed.'
  );
}

/* =========================================================
   IMAGE GENERATION
========================================================= */

function buildPollinationsUrl(
  prompt
) {
  const encoded =
    encodeURIComponent(
      prompt
    );

  return (
    `https://image.pollinations.ai/prompt/${encoded}` +
    `?width=1024&height=1024&nologo=true&enhance=true`
  );
}

async function generatePollinations(
  prompt
) {
  const url =
    buildPollinationsUrl(
      prompt
    );

  return await fetchBinary(
    url
  );
}

async function generateHuggingFace(
  apiKey,
  prompt
) {
  if (!apiKey) {
    throw new Error(
      'Hugging Face API key missing.'
    );
  }

  const models = [
    'black-forest-labs/FLUX.1-schnell',
    'stabilityai/stable-diffusion-xl-base-1.0'
  ];

  let lastError;

  for (
    const model of models
  ) {
    try {
      const data =
        await fetch(
          `https://router.huggingface.co/hf-inference/models/${model}`,
          {
            method: 'POST',

            headers: {
              Authorization:
                `Bearer ${apiKey}`,

              'Content-Type':
                'application/json'
            },

            body: JSON.stringify({
              inputs: prompt
            }),

            signal:
              AbortSignal.timeout(
                120000
              )
          }
        );

      if (!data.ok) {
        const text =
          await data
            .text()
            .catch(() => '');

        throw new Error(
          `HTTP ${data.status}: ${text.slice(
            0,
            300
          )}`
        );
      }

      return Buffer.from(
        await data.arrayBuffer()
      );

    } catch (error) {
      lastError = error;
    }
  }

  throw (
    lastError ||
    new Error(
      'Hugging Face image generation failed.'
    )
  );
}

async function generateImage(
  prompt
) {
  const providers =
    await providersFor(
      'photo_generate'
    );

  if (!providers.length) {
    throw new Error(
      'No enabled Photo/Image Generate API found.'
    );
  }

  for (
    const {
      provider,
      index
    } of providerOrder(
      'photo_generate',
      providers
    )
  ) {
    try {
      const name =
        clean(
          provider.providerName
        ).toLowerCase();

      let buffer;

      let model =
        provider.providerName;

      if (
        name ===
          'pollinations' ||
        name ===
          'pollinations ai'
      ) {
        buffer =
          await generatePollinations(
            prompt
          );

        model =
          'Pollinations';
      }

      else if (
        name ===
          'hugging face' ||
        name ===
          'huggingface' ||
        name ===
          'hugging face inference'
      ) {
        buffer =
          await generateHuggingFace(
            provider.apiKey,
            prompt
          );

        model =
          'Hugging Face';
      }

      else {
        throw new Error(
          `Unsupported Photo provider: ${provider.providerName}`
        );
      }

      if (
        !buffer ||
        !buffer.length
      ) {
        throw new Error(
          'Image API returned empty data.'
        );
      }

      markProviderSuccess(
        'photo_generate',
        index,
        providers.length
      );

      console.log(
        `[AUTO] Photo API: ${provider.providerName}`
      );

      return {
        buffer,

        provider:
          provider.providerName,

        model
      };

    } catch (error) {
      console.error(
        `[AUTO ERROR] Photo ${provider.providerName}:`,
        error.message
      );
    }
  }

  throw new Error(
    'All Photo/Image Generate APIs failed.'
  );
}

/* =========================================================
   CLOUDINARY
========================================================= */

function cloudinaryReady() {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );
}

function configureCloudinary() {
  if (!cloudinaryReady()) {
    return false;
  }

  cloudinary.config({
    cloud_name:
      process.env.CLOUDINARY_CLOUD_NAME,

    api_key:
      process.env.CLOUDINARY_API_KEY,

    api_secret:
      process.env.CLOUDINARY_API_SECRET,

    secure: true
  });

  return true;
}

async function uploadToCloudinary(
  buffer,
  title,
  resourceType = 'image'
) {
  if (!configureCloudinary()) {
    throw new Error(
      'Cloudinary environment variables are missing.'
    );
  }

  return new Promise(
    (resolve, reject) => {
      const stream =
        cloudinary.uploader.upload_stream(
          {
            folder:
              'promptforge/generated',

            public_id:
              `${slugify(title)}-${Date.now()}`,

            resource_type:
              resourceType
          },

          (error, result) => {
            if (error) {
              reject(error);
              return;
            }

            resolve(result);
          }
        );

      stream.end(buffer);
    }
  );
}

/* =========================================================
   AUTOMATIC POSTING
========================================================= */

let autoRunning = false;

async function createAutomaticPost() {
  const trend =
    await getTrendSignal();

  const category =
    CREATIVE_CATEGORIES[
      Math.floor(
        Math.random() *
        CREATIVE_CATEGORIES.length
      )
    ];

  const generated =
    await generatePrompt(
      trend,
      category
    );

  const title =
    generated.title ||
    uniqueTitle(
      `${category} AI Visual`,
      await getPrompts()
    );

  const image =
    await generateImage(
      generated.imagePrompt
    );

  const uploaded =
    await uploadToCloudinary(
      image.buffer,
      title
    );

  const existing =
    await getPrompts();

  const finalTitle =
    uniqueTitle(
      title,
      existing
    );

  const item =
    await addPrompt({
      id:
        crypto.randomUUID(),

      slug:
        makeSlug(
          finalTitle
        ),

      title:
        finalTitle,

      prompt:
        generated.imagePrompt,

      category:
        generated.category ||
        category,

      media:
        'Image',

      imageUrl:
        uploaded.secure_url,

      model:
        generated.model ||
        image.model ||
        'AI',

      source:
        'AI Visual Inspiration',

      publishedAt:
        new Date().toISOString()
    });

  return {
    ok: true,

    added: 1,

    item,

    trendProvider:
      trend.provider,

    promptProvider:
      generated.provider,

    imageProvider:
      image.provider,

    cloudinaryUrl:
      uploaded.secure_url
  };
}

async function runAutomaticPosting() {
  const settings =
    await getSettings();

  const count =
    Math.max(
      1,
      Math.min(
        10,
        Number(
          settings?.postsPerRun || 1
        )
      )
    );

  const results = [];

  for (
    let i = 0;
    i < count;
    i++
  ) {
    try {
      const result =
        await createAutomaticPost();

      results.push(
        result
      );

    } catch (error) {
      console.error(
        '[AUTO ERROR]',
        error.message
      );

      results.push({
        ok: false,

        error:
          error.message
      });
    }
  }

  const added =
    results.filter(
      x => x.ok
    ).length;

  return {
    ok:
      added > 0,

    added,

    results
  };
}

/* =========================================================
   AUTH
========================================================= */

function requireAdmin(
  req,
  res,
  next
) {
  if (
    req.session?.admin
  ) {
    return next();
  }

  return res
    .status(401)
    .json({
      error:
        'Unauthorized'
    });
}

function requirePublisher(req, res, next) {
  if (req.session?.admin || req.session?.posterUser) {
    return next();
  }

  return res.status(401).json({
    error: 'Publisher login required.'
  });
}

function requirePosterOrAdmin(req, res, next) {
  return requirePublisher(req, res, next);
}

function hashPosterPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto
    .scryptSync(String(password), salt, 64)
    .toString('hex');

  return `${salt}:${hash}`;
}

function verifyPosterPassword(password, stored) {
  try {
    const [salt, expectedHex] = String(stored || '').split(':');
    if (!salt || !expectedHex) return false;

    const actual = crypto.scryptSync(String(password), salt, 64);
    const expected = Buffer.from(expectedHex, 'hex');

    return expected.length === actual.length &&
      crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

async function sanitizePosterUsers() {
  const users = await getPosterUsers();
  return users.map(user => ({
    id: user.id,
    username: user.username,
    enabled: user.enabled !== false,
    createdAt: user.createdAt || user.created_at || null
  }));
}

app.post(
  '/api/login',
  (req, res) => {
    if (!ADMIN_PASSWORD) {
      return res
        .status(503)
        .json({
          error:
            'ADMIN_PASSWORD is not configured.'
        });
    }

    const username =
      clean(
        req.body?.username,
        100
      );

    const password =
      String(
        req.body?.password ||
        ''
      );

    if (
      username ===
        ADMIN_USERNAME &&
      password ===
        ADMIN_PASSWORD
    ) {
      req.session.admin =
        true;
      req.session.role = 'admin';

      return res.json({
        ok: true,
        role: 'admin'
      });
    }

    return res
      .status(401)
      .json({
        error:
          'Invalid username or password.'
      });
  }
);


app.post(
  '/api/poster/login',
  (req, res) => {
    (async () => {
      try {
        const username = clean(req.body?.username, 100).toLowerCase();
        const password = String(req.body?.password || '');

        if (!username || !password) {
          return res.status(400).json({
            error: 'Username and password required.'
          });
        }

        const users = await getPosterUsers();
        const user = users.find(
          item =>
            String(item.username || '').toLowerCase() === username &&
            item.enabled !== false
        );

        if (!user || !verifyPosterPassword(password, user.passwordHash)) {
          return res.status(401).json({
            error: 'Invalid username or password.'
          });
        }

        req.session.posterUser = {
          id: user.id,
          username: user.username
        };
        req.session.role = 'poster';

        return res.json({
          ok: true,
          role: 'poster',
          username: user.username
        });
      } catch (error) {
        return res.status(500).json({
          error: error.message
        });
      }
    })();
  }
);

app.get(
  '/api/poster/me',
  (req, res) => {
    res.json({
      authenticated: !!req.session?.posterUser,
      role: req.session?.posterUser ? 'poster' : null,
      username: req.session?.posterUser?.username || null
    });
  }
);

app.post(
  '/api/poster/logout',
  (req, res) => {
    if (req.session) {
      req.session.destroy(() => {
        res.json({ ok: true });
      });
    } else {
      res.json({ ok: true });
    }
  }
);

app.post(
  '/api/logout',
  (req, res) => {
    req.session.destroy(
      () =>
        res.json({
          ok: true
        })
    );
  }
);

app.get(
  '/api/admin/me',
  (req, res) => {
    res.json({
      authenticated:
        !!req.session?.admin,
      role:
        req.session?.admin
          ? 'admin'
          : req.session?.posterUser
            ? 'poster'
            : null
    });
  }
);

/* =========================================================
   PUBLIC PROMPTS
========================================================= */

app.get(
  '/api/prompts',
  async (req, res) => {
    try {
      const q =
        clean(
          req.query.q
        ).toLowerCase();

      let items =
        await getPrompts();

      if (q) {
        items =
          items.filter(
            p =>
              [
                p.title,
                p.prompt,
                p.category,
                p.model
              ]
                .join(' ')
                .toLowerCase()
                .includes(q)
          );
      }

      res.json(
        items
      );

    } catch (error) {
      res
        .status(500)
        .json({
          error:
            error.message
        });
    }
  }
);

app.get(
  '/api/prompts/:slug',
  async (req, res) => {
    try {
      const item =
        await getPromptBySlug(
          req.params.slug
        );

      if (!item) {
        return res
          .status(404)
          .json({
            error:
              'Not found'
          });
      }

      res.json(
        item
      );

    } catch (error) {
      res
        .status(500)
        .json({
          error:
            error.message
        });
    }
  }
);

app.get(
  '/api/public/settings',
  async (req, res) => {
    try {
      const settings =
        await getSettings();

      res.json({
        copyGateSeconds:
          Number(
            settings?.copyGateSeconds ??
            10
          ),

        directLink:
          clean(
            settings?.directLink ||
            ''
          )
      });

    } catch (error) {
      res
        .status(500)
        .json({
          error:
            error.message
        });
    }
  }
);

app.get(
  '/api/ads',
  async (req, res) => {
    try {
      res.set(
        'Cache-Control',
        'no-store'
      );

      const ads = (await getAds()) || {};
      const { posterUsers, ...publicAds } = ads;

      res.json(publicAds);

    } catch (error) {
      res
        .status(500)
        .json({
          error:
            error.message
        });
    }
  }
);
/* =========================================================
   ADMIN PROMPTS
========================================================= */

app.get(
  '/api/admin/prompts',
  requireAdmin,
  async (req, res) => {
    try {
      res.json(
        await getPrompts()
      );

    } catch (error) {
      res
        .status(500)
        .json({
          error:
            error.message
        });
    }
  }
);

app.post(
  '/api/admin/prompts',
  requireAdmin,
  async (req, res) => {
    try {
      const b =
        req.body || {};

      if (
        !clean(b.title) ||
        !clean(b.prompt)
      ) {
        return res
          .status(400)
          .json({
            error:
              'Title and prompt are required.'
          });
      }

      const item =
        await addPrompt({
          id:
            crypto.randomUUID(),

          slug:
            makeSlug(
              b.title
            ),

          title:
            clean(
              b.title,
              140
            ),

          prompt:
            clean(
              b.prompt,
              10000
            ),

          model:
            clean(
              b.model,
              140
            ) || 'Any',

          category:
            clean(
              b.category,
              100
            ) ||
            'Creative Art',

          media:
            clean(
              b.media,
              40
            ) || 'Image',

          imageUrl:
            clean(
              b.imageUrl,
              5000
            ),

          source:
            'Manual',

          publishedAt:
            new Date()
              .toISOString()
        });

      res.json(
        item
      );

    } catch (error) {
      res
        .status(500)
        .json({
          error:
            error.message
        });
    }
  }
);

app.delete(
  '/api/admin/prompts/:id',
  requireAdmin,
  async (req, res) => {
    try {
      await deletePrompt(
        req.params.id
      );

      res.json({
        ok: true
      });

    } catch (error) {
      res
        .status(500)
        .json({
          error:
            error.message
        });
    }
  }
);


/* =========================================================
   ADMIN API PROVIDERS
========================================================= */

app.get(
  '/api/admin/providers',
  requireAdmin,
  async (req, res) => {
    try {
      res.json(
        await allProviders()
      );

    } catch (error) {
      res
        .status(500)
        .json({
          error:
            error.message
        });
    }
  }
);

app.post(
  '/api/admin/providers',
  requireAdmin,
  async (req, res) => {
    try {
      const b =
        req.body || {};

      const category =
        normalizeCategory(
          b.category
        );

      const providerName =
        clean(
          b.providerName ||
          b.provider_name ||
          b.name,
          160
        );

      const apiKey =
        clean(
          b.apiKey ||
          b.api_key ||
          b.key,
          20000
        );

      const validCategories = [
        'trending_search',
        'prompt_generate',
        'photo_generate'
      ];

      if (
        !validCategories.includes(
          category
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              'Invalid provider category.'
          });
      }

      if (!providerName) {
        return res
          .status(400)
          .json({
            error:
              'Provider name is required.'
          });
      }

      const publicTrendProvider =
        category ===
          'trending_search' &&
        [
          'bluesky',
          'bluesky public',
          'reddit public',
          'reddit (public)'
        ].includes(
          providerName
            .toLowerCase()
        );

      if (
        !apiKey &&
        !publicTrendProvider
      ) {
        return res
          .status(400)
          .json({
            error:
              'API key/token is required for this provider.'
          });
      }

      const item =
        await addProvider({
          category,

          providerName,

          apiKey,

          enabled:
            b.enabled !== false
        });

      res.json(
        normalizeProvider(
          item
        )
      );

    } catch (error) {
      res
        .status(500)
        .json({
          error:
            error.message
        });
    }
  }
);

app.patch(
  '/api/admin/providers/:id',
  requireAdmin,
  async (req, res) => {
    try {
      const b = req.body || {};
      const updated = await updateProvider(
        req.params.id,
        {
          enabled: b.enabled,
          providerName: b.providerName || b.provider_name,
          apiKey: b.apiKey || b.api_key,
          config: b.config
        }
      );

      res.json(normalizeProvider(updated));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

app.delete(
  '/api/admin/providers/:id',
  requireAdmin,
  async (req, res) => {
    try {
      await deleteProvider(
        req.params.id
      );

      res.json({
        ok: true
      });

    } catch (error) {
      res
        .status(500)
        .json({
          error:
            error.message
        });
    }
  }
);



/* =========================================================
   POSTER USER MANAGEMENT
========================================================= */

app.get(
  '/api/admin/poster-users',
  requireAdmin,
  async (req, res) => {
    try {
      res.json(await sanitizePosterUsers());
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

app.post(
  '/api/admin/poster-users',
  requireAdmin,
  async (req, res) => {
    try {
      const username = clean(req.body?.username, 100).toLowerCase();
      const password = String(req.body?.password || '');

      if (!/^[a-z0-9._-]{3,50}$/.test(username)) {
        return res.status(400).json({
          error: 'Username must be 3-50 characters: letters, numbers, dot, underscore or dash.'
        });
      }

      if (password.length < 6) {
        return res.status(400).json({
          error: 'Password must be at least 6 characters.'
        });
      }

      const users = await getPosterUsers();

      if (users.some(user => String(user.username || '').toLowerCase() === username)) {
        return res.status(409).json({
          error: 'That username already exists.'
        });
      }

      const user = {
        id: crypto.randomUUID(),
        username,
        passwordHash: hashPosterPassword(password),
        enabled: true,
        createdAt: new Date().toISOString()
      };

      users.push(user);
      await savePosterUsers(users);

      res.json({
        ok: true,
        user: {
          id: user.id,
          username: user.username,
          enabled: true,
          createdAt: user.createdAt
        }
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

app.patch(
  '/api/admin/poster-users/:id',
  requireAdmin,
  async (req, res) => {
    try {
      const users = await getPosterUsers();
      const user = users.find(item => String(item.id) === String(req.params.id));

      if (!user) {
        return res.status(404).json({ error: 'User not found.' });
      }

      if (req.body?.enabled !== undefined) {
        user.enabled = !!req.body.enabled;
      }

      if (req.body?.password) {
        const password = String(req.body.password);
        if (password.length < 6) {
          return res.status(400).json({
            error: 'Password must be at least 6 characters.'
          });
        }
        user.passwordHash = hashPosterPassword(password);
      }

      await savePosterUsers(users);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

app.delete(
  '/api/admin/poster-users/:id',
  requireAdmin,
  async (req, res) => {
    try {
      const users = await getPosterUsers();
      const next = users.filter(item => String(item.id) !== String(req.params.id));

      if (next.length === users.length) {
        return res.status(404).json({ error: 'User not found.' });
      }

      await savePosterUsers(next);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

/* =========================================================
   SETTINGS
========================================================= */

app.get(
  '/api/admin/settings',
  requireAdmin,
  async (req, res) => {
    try {
      res.json(
        await getSettings()
      );

    } catch (error) {
      res
        .status(500)
        .json({
          error:
            error.message
        });
    }
  }
);

app.post(
  '/api/admin/settings',
  requireAdmin,
  async (req, res) => {
    try {
      const b =
        req.body || {};

      const current =
        await getSettings();

      const next = {
        ...current,

        autoPost:
          b.autoPost !==
          undefined
            ? !!b.autoPost
            : b.autoPostEnabled !==
              undefined
              ? !!b.autoPostEnabled
              : !!current.autoPost,

        postIntervalMinutes:
          Math.max(
            1,
            Number(
              b.postIntervalMinutes ??
              b.interval ??
              current.postIntervalMinutes ??
              60
            )
          ),

        postsPerRun:
          Math.max(
            1,
            Math.min(
              10,
              Number(
                b.postsPerRun ??
                current.postsPerRun ??
                1
              )
            )
          ),

        copyGateSeconds:
          Math.max(
            0,
            Number(
              b.copyGateSeconds ??
              current.copyGateSeconds ??
              10
            )
          ),

        directLink:
          clean(
            b.directLink ??
            current.directLink ??
            '',
            5000
          )
      };

      const saved = await saveSettings(next);

      // Apply the new Admin Panel settings immediately.
      // This clears the old interval and creates a new one,
      // so changing 3 -> 60 minutes does NOT require a Render restart.
      await startScheduler();

      console.log(
        `[AUTO] Scheduler updated from Admin Panel: every ${saved.postIntervalMinutes} minute(s), autoPost=${saved.autoPost}`
      );

      res.json(saved);

    } catch (error) {
      res
        .status(500)
        .json({
          error:
            error.message
        });
    }
  }
);


/* =========================================================
   RUN NOW
========================================================= */

app.post(
  '/api/admin/collect',
  requireAdmin,
  async (req, res) => {
    if (autoRunning) {
      return res
        .status(409)
        .json({
          ok: false,

          error:
            'Automatic posting is already running.'
        });
    }

    console.log(
      '[AUTO] Manual Run now requested'
    );

    autoRunning =
      true;

    try {
      const result =
        await runAutomaticPosting();

      console.log(
        `[AUTO] Manual Run finished: added=${result.added || 0}`
      );

      res.json(
        result
      );

    } catch (error) {
      console.error(
        '[AUTO ERROR] Manual Run:',
        error
      );

      res
        .status(500)
        .json({
          ok: false,

          error:
            error.message
        });

    } finally {
      autoRunning =
        false;
    }
  }
);


/* =========================================================
   ADMIN ADS
========================================================= */

app.get(
  '/api/admin/ads',
  requireAdmin,
  async (req, res) => {
    try {
      res.json(
        (await getAds()) ||
        {}
      );

    } catch (error) {
      res
        .status(500)
        .json({
          error:
            error.message
        });
    }
  }
);

app.post(
  '/api/admin/ads',
  requireAdmin,
  async (req, res) => {
    try {
      res.json(
        await saveAds(
          req.body || {}
        )
      );

    } catch (error) {
      res
        .status(500)
        .json({
          error:
            error.message
        });
    }
  }
);


/* =========================================================
   SCHEDULER
========================================================= */

let autoTimer = null;
let schedulerStarting = false;

async function runScheduledPost() {
  if (autoRunning) {
    console.log(
      '[AUTO] Previous automatic run is still running. Skipping this cycle.'
    );

    return;
  }

  autoRunning = true;

  try {
    const settings =
      await getSettings();

    if (!settings?.autoPost) {
      console.log(
        '[AUTO] Automatic posting is disabled.'
      );

      return;
    }

    console.log(
      '[AUTO] Scheduled run started.'
    );

    const result =
      await runAutomaticPosting();

    console.log(
      `[AUTO] Scheduled run finished: added=${
        result.added || 0
      }`
    );

  } catch (error) {
    console.error(
      '[AUTO ERROR] Scheduled run:',
      error?.message ||
      error
    );

  } finally {
    autoRunning =
      false;
  }
}

async function startScheduler() {
  if (schedulerStarting) {
    console.log('[AUTO] Scheduler update already in progress.');
    return;
  }

  schedulerStarting = true;

  try {
    if (autoTimer) {
      clearInterval(autoTimer);
      autoTimer = null;
    }

    const settings = await getSettings();
    const enabled = !!settings?.autoPost;
    const minutes = Math.max(
      1,
      Number(settings?.postIntervalMinutes ?? 60) || 60
    );

    if (!enabled) {
      console.log('[AUTO] Automatic posting is OFF. Scheduler stopped.');
      return;
    }

    console.log(
      `Automatic posting scheduled every ${minutes} minute(s).`
    );

    autoTimer = setInterval(() => {
      void runScheduledPost();
    }, minutes * 60 * 1000);

  } catch (error) {
    console.error(
      '[AUTO ERROR] Scheduler start:',
      error?.message || error
    );
  } finally {
    schedulerStarting = false;
  }
}
/* =========================================================
   HEALTH / STATUS
========================================================= */

app.get(
  '/api/health',
  async (req, res) => {
    try {
      const providers =
        await allProviders();

      const settings =
        await getSettings();

      res.json({
        ok: true,

        service:
          'PromptForge',

        autoPost:
          !!settings?.autoPost,

        providers: {
          trending:
            providers.filter(
              p =>
                p.category ===
                'trending_search' &&
                p.enabled
            ).length,

          prompt:
            providers.filter(
              p =>
                p.category ===
                'prompt_generate' &&
                p.enabled
            ).length,

          photo:
            providers.filter(
              p =>
                p.category ===
                'photo_generate' &&
                p.enabled
            ).length
        },

        scheduler:
          !!autoTimer,

        autoRunning:
          !!autoRunning,

        time:
          new Date().toISOString()
      });

    } catch (error) {
      res
        .status(500)
        .json({
          ok: false,

          error:
            error.message
        });
    }
  }
);


/* =========================================================
   DIRECT GALLERY IMAGE UPLOAD
========================================================= */

app.post(
  '/api/admin/upload-image',
  requireAdmin,
  (req, res) => {
    galleryUpload.single('image')(req, res, async error => {
      try {
        if (error) {
          return res.status(400).json({
            error: error.code === 'LIMIT_FILE_SIZE'
              ? 'Image is too large. Maximum size is 10 MB.'
              : error.message
          });
        }

        if (!req.file?.buffer) {
          return res.status(400).json({
            error: 'Please select an image from your gallery.'
          });
        }

        if (!cloudinaryReady()) {
          return res.status(503).json({
            error: 'Cloudinary is not configured on the server.'
          });
        }

        const title =
          clean(req.body?.title, 140) ||
          clean(
            path.parse(req.file.originalname || 'manual-image').name,
            140
          ) ||
          'Manual Image';

        const uploaded =
          await uploadToCloudinary(
            req.file.buffer,
            title
          );

        return res.json({
          ok: true,
          url: uploaded.secure_url,
          secureUrl: uploaded.secure_url,
          publicId: uploaded.public_id,
          width: uploaded.width,
          height: uploaded.height,
          format: uploaded.format,
          bytes: uploaded.bytes
        });
      } catch (error) {
        console.error(
          '[ADMIN ERROR] Gallery upload:',
          error
        );

        return res.status(500).json({
          error: error.message || 'Image upload failed.'
        });
      }
    });
  }
);


/* =========================================================
   MEDIA UPLOAD (IMAGE + VIDEO)
========================================================= */

app.post(
  '/api/publisher/upload-media',
  requirePublisher,
  (req, res) => {
    mediaUpload.single('media')(req, res, async error => {
      try {
        if (error) {
          return res.status(400).json({
            error: error.message || 'Media upload failed.'
          });
        }

        if (!req.file) {
          return res.status(400).json({
            error: 'Please select an image or video.'
          });
        }

        const resourceType =
          String(req.file.mimetype || '').startsWith('video/')
            ? 'video'
            : 'image';

        const title =
          clean(
            req.body?.title,
            140
          ) ||
          req.file.originalname.replace(/\.[^.]+$/, '');

        const uploaded = await uploadToCloudinary(
          req.file.buffer,
          title,
          resourceType
        );

        return res.json({
          ok: true,
          url: uploaded.secure_url,
          secureUrl: uploaded.secure_url,
          publicId: uploaded.public_id,
          resourceType,
          format: uploaded.format,
          bytes: uploaded.bytes,
          width: uploaded.width,
          height: uploaded.height
        });
      } catch (uploadError) {
        console.error('[PUBLISHER ERROR] Media upload:', uploadError);
        return res.status(500).json({
          error: uploadError.message || 'Media upload failed.'
        });
      }
    });
  }
);

/* =========================================================
   MANUAL PUBLISH
========================================================= */

app.post(
  '/api/admin/publish',
  requireAdmin,
  async (req, res) => {
    try {
      const b =
        req.body || {};

      const title =
        clean(
          b.title,
          140
        );

      const prompt =
        clean(
          b.prompt,
          10000
        );

      const imageUrl =
        clean(
          b.imageUrl,
          5000
        );

      if (!title || !prompt) {
        return res
          .status(400)
          .json({
            error:
              'Title and prompt are required.'
          });
      }

      const existing =
        await getPrompts();

      const finalTitle =
        uniqueTitle(
          title,
          existing
        );

      const item =
        await addPrompt({
          id:
            crypto.randomUUID(),

          slug:
            makeSlug(
              finalTitle
            ),

          title:
            finalTitle,

          prompt,

          category:
            clean(
              b.category,
              100
            ) ||
            'Creative Art',

          media:
            'Image',

          imageUrl,

          model:
            clean(
              b.model,
              100
            ) ||
            'Manual',

          source:
            'Manual',

          publishedAt:
            new Date()
              .toISOString()
        });

      res.json({
        ok: true,

        item
      });

    } catch (error) {
      console.error(
        '[ADMIN ERROR] Publish:',
        error
      );

      res
        .status(500)
        .json({
          error:
            error.message
        });
    }
  }
);



/* =========================================================
   PUBLISHER POST
========================================================= */

app.post(
  '/api/publisher/publish',
  requirePublisher,
  async (req, res) => {
    try {
      const b = req.body || {};
      const title = clean(b.title, 140);
      const prompt = clean(b.prompt, 10000);
      const media = clean(b.media, 40) || 'Image';
      const mediaUrl = clean(b.imageUrl || b.mediaUrl, 5000);

      if (!title || !prompt || !mediaUrl) {
        return res.status(400).json({
          error: 'Title, prompt and media are required.'
        });
      }

      if (!['Image', 'Video'].includes(media)) {
        return res.status(400).json({
          error: 'Publisher users can only publish Image or Video posts.'
        });
      }

      const existing = await getPrompts();
      const finalTitle = uniqueTitle(title, existing);

      const item = await addPrompt({
        id: crypto.randomUUID(),
        slug: makeSlug(finalTitle),
        title: finalTitle,
        prompt,
        category: clean(b.category, 100) || 'Creative Art',
        media,
        imageUrl: mediaUrl,
        model: clean(b.model, 100) || 'Manual',
        source: req.session?.admin ? 'Manual' : `Poster:${req.session?.posterUser?.username || 'User'}`,
        publishedAt: new Date().toISOString()
      });

      res.json({ ok: true, item });
    } catch (error) {
      console.error('[PUBLISHER ERROR] Publish:', error);
      res.status(500).json({ error: error.message });
    }
  }
);

/* =========================================================
   COPY GATE VALIDATION
========================================================= */

app.post(
  '/api/copy/verify',
  async (req, res) => {
    try {
      const settings =
        await getSettings();

      const seconds =
        Math.max(
          0,
          Number(
            settings?.copyGateSeconds ??
            10
          )
        );

      res.json({
        ok: true,

        copyGateSeconds:
          seconds,

        directLink:
          clean(
            settings?.directLink ||
            ''
          )
      });

    } catch (error) {
      res
        .status(500)
        .json({
          ok: false,

          error:
            error.message
        });
    }
  }
);


/* =========================================================
   ROOT / FALLBACK
========================================================= */

app.get(
  '/',
  (req, res) => {
    res.sendFile(
      path.join(
        __dirname,
        'public',
        'index.html'
      )
    );
  }
);


/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    console.error(
      '[SERVER ERROR]',
      error
    );

    if (
      res.headersSent
    ) {
      return next(
        error
      );
    }

    res
      .status(
        Number(
          error?.status
        ) || 500
      )
      .json({
        error:
          error?.message ||
          'Internal server error.'
      });
  }
);


/* =========================================================
   CREATIVE FALLBACK TOPICS
========================================================= */

const CREATIVE_SEEDS = [
  'cinematic luxury portrait photography',
  'futuristic architecture at blue hour',
  'premium automotive campaign photography',
  'minimalist fashion editorial',
  'dramatic travel landscape photography',
  'luxury product advertising photography',
  'cinematic urban night photography',
  'modern interior design editorial',
  'surreal conceptual photography',
  'high-end food photography',
  'nature photography with atmospheric light',
  'creative commercial campaign',
  'editorial street photography',
  'premium lifestyle campaign',
  'fantasy cinematic environment'
];


/* =========================================================
   PROCESS SAFETY
========================================================= */

process.on(
  'unhandledRejection',
  error => {
    console.error(
      '[PROCESS] Unhandled rejection:',
      error
    );
  }
);

process.on(
  'uncaughtException',
  error => {
    console.error(
      '[PROCESS] Uncaught exception:',
      error
    );
  }
);

process.on(
  'SIGTERM',
  () => {
    console.log(
      '[PROCESS] SIGTERM received.'
    );

    if (autoTimer) {
      clearInterval(
        autoTimer
      );

      autoTimer =
        null;
    }

    process.exit(
      0
    );
  }
);

process.on(
  'SIGINT',
  () => {
    console.log(
      '[PROCESS] SIGINT received.'
    );

    if (autoTimer) {
      clearInterval(
        autoTimer
      );

      autoTimer =
        null;
    }

    process.exit(
      0
    );
  }
);


/* =========================================================
   ROUTES
========================================================= */

app.get(
  '/admin',
  requireAdmin,
  (req, res) =>
    res.sendFile(
      path.join(
        __dirname,
        'public',
        'admin.html'
      )
    )
);

app.get(
  '/poster',
  (req, res) =>
    res.sendFile(
      path.join(
        __dirname,
        'public',
        'poster.html'
      )
    )
);

app.get(
  '/privacy',
  (req, res) =>
    res.sendFile(
      path.join(
        __dirname,
        'public',
        'privacy.html'
      )
    )
);

app.use(
  '/api',
  (req, res) =>
    res
      .status(404)
      .json({
        error:
          'Not found'
      })
);

app.get(
  '*splat',
  (req, res) =>
    res.sendFile(
      path.join(
        __dirname,
        'public',
        'index.html'
      )
    )
);



/* =========================================================
   404
========================================================= */

app.use(
  (req, res) => {
    if (
      req.path.startsWith(
        '/api/'
      )
    ) {
      return res
        .status(404)
        .json({
          error:
            'API route not found.'
        });
    }

    return res
      .status(404)
      .send(
        'Page not found.'
      );
  }
);


/* =========================================================
   BOOT
========================================================= */

async function boot() {
  try {
    console.log(
      'Database: Supabase PostgreSQL'
    );

    const providers =
      await allProviders();

    console.log(
      '3 API categories enabled:'
    );

    console.log(
      '1. Trending Search'
    );

    console.log(
      '2. Prompt Generate'
    );

    console.log(
      '3. Image / Photo Generate'
    );

    console.log(
      `Configured providers: ${providers.length}`
    );

    console.log(
      '[BOOT] Providers:',
      providers
        .map(
          p =>
            `${p.category}:${p.providerName}:${
              p.enabled
                ? 'enabled'
                : 'disabled'
            }`
        )
        .join(', ') ||
        'none'
    );

    if (
      cloudinaryReady()
    ) {
      configureCloudinary();

      console.log(
        'Cloudinary storage enabled.'
      );
    } else {
      console.warn(
        'Cloudinary environment variables are missing.'
      );
    }

    await startScheduler();

    app.listen(
      PORT,
      () =>
        console.log(
          `PromptForge running on port ${PORT}`
        )
    );

  } catch (error) {
    console.error(
      'Startup error:',
      error
    );

    app.listen(
      PORT,
      () =>
        console.log(
          `PromptForge running on port ${PORT} (startup warning)`
        )
    );
  }
}

boot();
