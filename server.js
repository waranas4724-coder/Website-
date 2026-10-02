require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path = require('path');
const crypto = require('crypto');
const cloudinary = require('cloudinary').v2;

const {
  getPrompts,
  getPromptBySlug,
  addPrompt,
  deletePrompt,
  getProviders,
  addProvider,
  deleteProvider,
  getSettings,
  saveSettings,
  getAds,
  saveAds
} = require('./db');

const app = express();
const PORT = Number(process.env.PORT || 3000);

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
  const wanted =
    normalizeCategory(category);

  const providers =
    await allProviders();

  return providers.filter(p => {
    if (
      p.category !== wanted ||
      !p.enabled ||
      !p.providerName
    ) {
      return false;
    }

    if (p.apiKey) {
      return true;
    }

    const name =
      clean(p.providerName)
        .toLowerCase();

    return (
      wanted === 'trending_search' &&
      [
        'bluesky',
        'bluesky public',
        'reddit public',
        'reddit (public)'
      ].includes(name)
    );
  });
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
  title
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
              'image'
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

      return res.json({
        ok: true
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
        !!req.session?.admin
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

      res.json(
        await saveSettings(
          next
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

let autoTimer =
  null;

async function startScheduler() {
  if (autoTimer) {
    clearInterval(
      autoTimer
    );
  }

  const settings =
    await getSettings();

  const minutes =
    Math.max(
      1,
      Number(
        settings?.postIntervalMinutes ||
        60
      )
    );

  console.log(
    `Automatic posting scheduled every ${minutes} minute(s).`
  );

  autoTimer =
    setInterval(
      async () => {
        if (autoRunning) {
          console.log(
            '[AUTO] Previous run is still running.'
          );

          return;
        }

        try {
          const current =
            await getSettings();

          if (
            !current?.autoPost
          ) {
            return;
          }

          autoRunning =
            true;

          console.log(
            '[AUTO] Scheduled run started.'
          );

          const result =
            await runAutomaticPosting();

          console.log(
            '[AUTO] Scheduled result:',
            JSON.stringify(
              result
            )
          );

        } catch (error) {
          console.error(
            '[AUTO ERROR] Scheduled run:',
            error.message
          );

        } finally {
          autoRunning =
            false;
        }
      },

      minutes *
        60 *
        1000
    );
}

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
