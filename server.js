require('dotenv').config();

const express = require('express');
const session = require('express-session');
const cron = require('node-cron');
const crypto = require('crypto');
const path = require('path');

const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(
  path.join(__dirname, 'public')
));

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

/* =========================================
   HELPERS
========================================= */

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
}

function safeUrl(value) {
  return /^https?:\/\//i.test(value || '')
    ? value
    : '';
}

function hash(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || ''))
    .digest();
}

function sameSecret(a, b) {
  try {
    return crypto.timingSafeEqual(
      hash(a),
      hash(b)
    );
  } catch {
    return false;
  }
}

function getSetting(name, fallback) {
  const data = db.getSettings();

  return Object.prototype.hasOwnProperty.call(
    data,
    name
  )
    ? data[name]
    : fallback;
}

function setSettings(values) {
  return db.saveSettings(values);
}

function findPrompt(id) {
  return db
    .getPrompts()
    .find(
      p => String(p.id) === String(id)
    );
}

function findPromptBySlug(slug) {
  return db
    .getPrompts()
    .find(
      p => p.slug === String(slug)
    );
}

function uniqueSlug(title) {

  const base =
    slugify(title) || 'prompt';

  let slug = base;
  let number = 2;

  const prompts = db.getPrompts();

  while (
    prompts.some(
      p => p.slug === slug
    )
  ) {
    slug = `${base}-${number++}`;
  }

  return slug;
}

function createPrompt(data, automatic = false) {

  const title =
    String(
      data.title || 'Untitled Prompt'
    )
      .trim()
      .slice(0, 140);

  return {
    id:
      data.id ||
      `${Date.now()}-${crypto
        .randomBytes(4)
        .toString('hex')}`,

    slug:
      data.slug ||
      uniqueSlug(title),

    title,

    prompt:
      String(data.prompt || '')
        .trim()
        .slice(0, 10000),

    media:
      data.media || 'Image',

    model:
      data.model || 'Any',

    category:
      data.category || 'General',

    imageUrl:
      safeUrl(data.imageUrl || ''),

    source:
      data.source ||
      (automatic
        ? 'Automatic'
        : 'Admin'),

    sourceUrl:
      safeUrl(data.sourceUrl || ''),

    license:
      data.license || 'Unknown',

    publishedAt:
      data.publishedAt ||
      new Date().toISOString(),

    auto:
      automatic ? 1 : 0
  };
}

/* =========================================
   PROMPT SEARCH
========================================= */

function searchPrompts(query = {}) {

  let items = db.getPrompts();

  const q =
    String(query.q || '')
      .trim()
      .toLowerCase();

  if (q) {
    items = items.filter(p =>
      [
        p.title,
        p.prompt,
        p.category,
        p.model,
        p.media
      ]
        .join(' ')
        .toLowerCase()
        .includes(q)
    );
  }

  if (
    query.media &&
    query.media !== 'all'
  ) {
    items = items.filter(
      p =>
        String(p.media)
          .toLowerCase() ===
        String(query.media)
          .toLowerCase()
    );
  }

  if (
    query.category &&
    query.category !== 'all'
  ) {
    items = items.filter(
      p =>
        String(p.category)
          .toLowerCase() ===
        String(query.category)
          .toLowerCase()
    );
  }

  return items.sort(
    (a, b) =>
      new Date(b.publishedAt || 0) -
      new Date(a.publishedAt || 0)
  );
}

/* =========================================
   PUBLIC PROMPT API
========================================= */

app.get('/api/prompts', (req, res) => {
  res.json(
    searchPrompts(req.query)
  );
});

app.get(
  '/api/prompts/:slug',
  (req, res) => {

    const prompt =
      findPromptBySlug(
        req.params.slug
      );

    if (!prompt) {
      return res
        .status(404)
        .json({
          error: 'Prompt not found'
        });
    }

    res.json(prompt);
  }
);

app.get('/api/categories', (req, res) => {

  const categories = {};

  db.getPrompts().forEach(p => {

    const name =
      p.category || 'General';

    categories[name] =
      (categories[name] || 0) + 1;
  });

  res.json(categories);
});

/* =========================================
   PUBLIC COPY-GATE SETTINGS
========================================= */

app.get(
  '/api/public/settings',
  (req, res) => {

    res.json({
      copyGateSeconds:
        Number(
          getSetting(
            'copyGateSeconds',
            10
          )
        ),

      directLink:
        safeUrl(
          getSetting(
            'directLink',
            ''
          )
        )
    });
  }
);

/* =========================================
   ADS
========================================= */

app.get('/api/ads', (req, res) => {

  const ads = db.getAds();

  res.json({
    ...ads,

    smart_link:
      safeUrl(
        getSetting(
          'directLink',
          ''
        )
      )
  });
});

/* =========================================
   ADMIN AUTH
========================================= */

function adminOnly(req, res, next) {

  if (req.session?.admin) {
    return next();
  }

  res
    .status(401)
    .json({
      error: 'Unauthorized'
    });
}

const loginAttempts = new Map();

app.post('/api/login', (req, res) => {

  const username =
    process.env.ADMIN_USERNAME ||
    'admin';

  const password =
    process.env.ADMIN_PASSWORD;

  if (!password) {
    return res
      .status(503)
      .json({
        error:
          'ADMIN_PASSWORD is not configured'
      });
  }

  const ip = req.ip;

  const attempt =
    loginAttempts.get(ip) || {
      count: 0,
      time: 0
    };

  if (
    attempt.count >= 5 &&
    Date.now() - attempt.time <
      15 * 60 * 1000
  ) {
    return res
      .status(429)
      .json({
        error:
          'Too many login attempts'
      });
  }

  const valid =
    sameSecret(
      req.body?.username,
      username
    ) &&
    sameSecret(
      req.body?.password,
      password
    );

  if (!valid) {

    loginAttempts.set(
      ip,
      {
        count:
          attempt.count + 1,
        time: Date.now()
      }
    );

    return res
      .status(401)
      .json({
        error:
          'Invalid username or password'
      });
  }

  loginAttempts.delete(ip);

  req.session.admin = true;

  res.json({
    ok: true
  });
});

app.post('/api/logout', (req, res) => {

  req.session.destroy(() => {
    res.json({
      ok: true
    });
  });
});

app.get('/api/admin/me', (req, res) => {

  res.json({
    authenticated:
      !!req.session?.admin
  });
});

/* =========================================
   ADMIN PROMPTS
========================================= */

app.get(
  '/api/admin/prompts',
  adminOnly,
  (req, res) => {

    res.json(
      db.getPrompts()
    );
  }
);

app.post(
  '/api/admin/prompts',
  adminOnly,
  (req, res) => {

    if (
      !req.body?.title ||
      !req.body?.prompt
    ) {
      return res
        .status(400)
        .json({
          error:
            'Title and prompt are required'
        });
    }

    const prompt =
      createPrompt(req.body);

    db.addPrompt(prompt);

    res.json(prompt);
  }
);

app.delete(
  '/api/admin/prompts/:id',
  adminOnly,
  (req, res) => {

    db.deletePrompt(
      req.params.id
    );

    res.json({
      ok: true
    });
  }
);

/* =========================================
   UNLIMITED API PROVIDERS
========================================= */

const VALID_CATEGORIES = [
  'prompt_generate',
  'photo_generate',
  'trending_search'
];

app.get(
  '/api/admin/providers',
  adminOnly,
  (req, res) => {

    const providers =
      db.getApiProviders();

    res.json(
      providers.map(p => ({
        ...p,

        apiKey:
          p.apiKey
            ? '••••••••'
            : ''
      }))
    );
  }
);

app.post(
  '/api/admin/providers',
  adminOnly,
  (req, res) => {

    const {
      category,
      providerName,
      apiKey
    } = req.body || {};

    if (
      !VALID_CATEGORIES.includes(
        category
      )
    ) {
      return res
        .status(400)
        .json({
          error:
            'Invalid category'
        });
    }

    if (!providerName) {
      return res
        .status(400)
        .json({
          error:
            'Provider name is required'
        });
    }

    const provider =
      db.addApiProvider({
        category,
        providerName,
        apiKey: apiKey || '',
        enabled: true
      });

    res.json({
      ok: true,
      provider
    });
  }
);

app.put(
  '/api/admin/providers/:id',
  adminOnly,
  (req, res) => {

    const providers =
      db.getApiProviders();

    const old =
      providers.find(
        p =>
          String(p.id) ===
          String(req.params.id)
      );

    if (!old) {
      return res
        .status(404)
        .json({
          error:
            'Provider not found'
        });
    }

    const changes = {
      ...req.body
    };

    if (
      !changes.apiKey ||
      changes.apiKey ===
        '••••••••'
    ) {
      delete changes.apiKey;
    }

    db.updateApiProvider(
      req.params.id,
      changes
    );

    res.json({
      ok: true
    });
  }
);

app.delete(
  '/api/admin/providers/:id',
  adminOnly,
  (req, res) => {

    db.deleteApiProvider(
      req.params.id
    );

    res.json({
      ok: true
    });
  }
);

/* =========================================
   ADMIN SETTINGS
========================================= */

app.get(
  '/api/admin/settings',
  adminOnly,
  (req, res) => {

    res.json({
      autoPostEnabled:
        getSetting(
          'autoPostEnabled',
          true
        ),

      cron:
        getSetting(
          'cron',
          '0 */6 * * *'
        ),

      copyGateSeconds:
        getSetting(
          'copyGateSeconds',
          10
        ),

      directLink:
        getSetting(
          'directLink',
          ''
        )
    });
  }
);

app.post(
  '/api/admin/settings',
  adminOnly,
  (req, res) => {

    const seconds =
      Math.max(
        0,
        Math.min(
          120,
          Number(
            req.body.copyGateSeconds ||
            10
          )
        )
      );

    setSettings({
      autoPostEnabled:
        !!req.body.autoPostEnabled,

      cron:
        req.body.cron ||
        '0 */6 * * *',

      copyGateSeconds:
        seconds,

      directLink:
        safeUrl(
          req.body.directLink ||
          ''
        )
    });

    scheduleAutomaticPosting();

    res.json({
      ok: true
    });
  }
);

/* =========================================
   ADMIN ADS
========================================= */

app.get(
  '/api/admin/ads',
  adminOnly,
  (req, res) => {

    res.json(
      db.getAds()
    );
  }
);

app.post(
  '/api/admin/ads',
  adminOnly,
  (req, res) => {

    db.saveAds(
      req.body || {}
    );

    res.json({
      ok: true
    });
  }
);

/* =========================================
   BUILT-IN API PROVIDERS
========================================= */

function providerKey(name) {

  return String(name || '')
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

/* ---------- Trending ---------- */

async function googleNewsWorldwide() {

  const url =
    'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en';

  const response =
    await fetch(
      url,
      {
        signal:
          AbortSignal.timeout(15000)
      }
    );

  if (!response.ok) {
    throw new Error(
      'Google News unavailable'
    );
  }

  const xml =
    await response.text();

  const titles = [];

  const matches =
    xml.matchAll(
      /<title>(.*?)<\/title>/g
    );

  for (const match of matches) {

    const title =
      match[1]
        .replace(
          /<!\[CDATA\[(.*?)\]\]>/g,
          '$1'
        )
        .replace(
          /&amp;/g,
          '&'
        )
        .trim();

    if (
      title &&
      title !== 'Google News'
    ) {
      titles.push(title);
    }
  }

  return titles.slice(0, 20);
}

/* ---------- Photos ---------- */

async function pexelsSearch(
  apiKey,
  topic
) {

  const url =
    'https://api.pexels.com/v1/search?' +
    new URLSearchParams({
      query: topic,
      per_page: '1'
    });

  const response =
    await fetch(
      url,
      {
        headers: {
          Authorization: apiKey
        },
        signal:
          AbortSignal.timeout(15000)
      }
    );

  if (!response.ok) {
    throw new Error(
      `Pexels HTTP ${response.status}`
    );
  }

  const data =
    await response.json();

  return (
    data.photos?.[0]?.src?.large2x ||
    data.photos?.[0]?.src?.large ||
    ''
  );
}

async function unsplashSearch(
  apiKey,
  topic
) {

  const url =
    'https://api.unsplash.com/search/photos?' +
    new URLSearchParams({
      query: topic,
      per_page: '1'
    });

  const response =
    await fetch(
      url,
      {
        headers: {
          Authorization:
            `Client-ID ${apiKey}`
        },
        signal:
          AbortSignal.timeout(15000)
      }
    );

  if (!response.ok) {
    throw new Error(
      `Unsplash HTTP ${response.status}`
    );
  }

  const data =
    await response.json();

  return (
    data.results?.[0]?.urls?.regular ||
    ''
  );
}

/* ---------- Prompt AI ---------- */

async function geminiPrompt(
  apiKey,
  topic
) {

  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' +
    encodeURIComponent(apiKey);

  const response =
    await fetch(
      url,
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/json'
        },

        body: JSON.stringify({
          contents: [{
            parts: [{
              text:
                `Create one high quality AI image prompt about "${topic}". Return only the prompt text. Include subject, composition, lighting, camera, atmosphere, colors and detail.`
            }]
          }]
        }),

        signal:
          AbortSignal.timeout(20000)
      }
    );

  if (!response.ok) {
    throw new Error(
      `Gemini HTTP ${response.status}`
    );
  }

  const data =
    await response.json();

  return (
    data
      .candidates?.[0]
      ?.content?.parts?.[0]
      ?.text
      ?.trim() ||
    ''
  );
}

async function groqPrompt(
  apiKey,
  topic
) {

  const response =
    await fetch(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',

        headers: {
          Authorization:
            `Bearer ${apiKey}`,

          'Content-Type':
            'application/json'
        },

        body: JSON.stringify({
          model:
            'llama-3.1-8b-instant',

          messages: [{
            role: 'user',

            content:
              `Create one detailed AI image prompt about "${topic}". Return only the prompt.`
          }],

          temperature: 0.8
        }),

        signal:
          AbortSignal.timeout(20000)
      }
    );

  if (!response.ok) {
    throw new Error(
      `Groq HTTP ${response.status}`
    );
  }

  const data =
    await response.json();

  return (
    data.choices?.[0]
      ?.message?.content
      ?.trim() ||
    ''
  );
}

/* =========================================
   TRENDING PROVIDER FALLBACK
========================================= */

async function getTrendingTopics() {

  const providers =
    db.getApiProviders()
      .filter(
        p =>
          p.category ===
            'trending_search' &&
          p.enabled !== false
      );

  /*
    If no trending API is configured,
    use Google News RSS automatically.
  */

  try {

    const topics =
      await googleNewsWorldwide();

    if (topics.length) {
      return topics;
    }

  } catch (error) {

    console.log(
      'Trending fallback:',
      error.message
    );
  }

  return [];
}

/* =========================================
   PROMPT GENERATOR FALLBACK
========================================= */

async function generatePrompt(topic) {

  const providers =
    db.getApiProviders()
      .filter(
        p =>
          p.category ===
            'prompt_generate' &&
          p.enabled !== false
      );

  for (const provider of providers) {

    try {

      const name =
        providerKey(
          provider.providerName
        );

      if (
        name === 'gemini' ||
        name === 'googlegemini'
      ) {

        const result =
          await geminiPrompt(
            provider.apiKey,
            topic
          );

        if (result) {
          return result;
        }
      }

      if (name === 'groq') {

        const result =
          await groqPrompt(
            provider.apiKey,
            topic
          );

        if (result) {
          return result;
        }
      }

    } catch (error) {

      console.log(
        `${provider.providerName} failed:`,
        error.message
      );
    }
  }

  /*
    No AI API? Generate a local prompt.
    This means automatic posting can still
    continue without an AI API.
  */

  return (
    `Create a premium, highly detailed AI image ` +
    `based on "${topic}". Include a strong subject, ` +
    `professional composition, cinematic lighting, ` +
    `realistic textures, atmospheric depth, ` +
    `beautiful color grading, sharp details, ` +
    `professional photography and high quality.`
  );
}

/* =========================================
   PHOTO GENERATOR / SEARCH
========================================= */

async function generatePhoto(topic) {

  const providers =
    db.getApiProviders()
      .filter(
        p =>
          p.category ===
            'photo_generate' &&
          p.enabled !== false
      );

  for (const provider of providers) {

    try {

      const name =
        providerKey(
          provider.providerName
        );

      if (
        name === 'pexels'
      ) {

        const result =
          await pexelsSearch(
            provider.apiKey,
            topic
          );

        if (result) {
          return result;
        }
      }

      if (
        name === 'unsplash'
      ) {

        const result =
          await unsplashSearch(
            provider.apiKey,
            topic
          );

        if (result) {
          return result;
        }
      }

    } catch (error) {

      console.log(
        `${provider.providerName} failed:`,
        error.message
      );
    }
  }

  return '';
}

/* =========================================
   AUTOMATIC POSTING
========================================= */

let running = false;

async function automaticPost() {

  if (running) {
    return {
      added: 0,
      reason:
        'Already running'
    };
  }

  if (
    !getSetting(
      'autoPostEnabled',
      true
    )
  ) {
    return {
      added: 0,
      reason:
        'Automatic posting disabled'
    };
  }

  running = true;

  let added = 0;

  try {

    const topics =
      await getTrendingTopics();

    const existing =
      db.getPrompts();

    const existingTitles =
      new Set(
        existing.map(
          p =>
            String(
              p.title
            ).toLowerCase()
        )
      );

    /*
      Up to 15 posts per run.
    */

    for (
      const topic of
      topics.slice(0, 15)
    ) {

      if (
        existingTitles.has(
          String(topic)
            .toLowerCase()
        )
      ) {
        continue;
      }

      const prompt =
        await generatePrompt(
          topic
        );

      const imageUrl =
        await generatePhoto(
          topic
        );

      const item =
        createPrompt(
          {
            title: topic,
            prompt,
            imageUrl,
            media: 'Image',
            model: 'Auto',
            category: 'Trending',
            source:
              'Automatic',
            license:
              'Provider terms'
          },
          true
        );

      db.addPrompt(item);

      existingTitles.add(
        String(topic)
          .toLowerCase()
      );

      added++;
    }

    return {
      added,
      topics:
        topics.length
    };

  } finally {

    running = false;
  }
}

/* =========================================
   ADMIN RUN NOW
========================================= */

app.post(
  '/api/admin/collect',
  adminOnly,
  async (req, res) => {

    try {

      const result =
        await automaticPost();

      res.json(result);

    } catch (error) {

      console.error(error);

      res
        .status(500)
        .json({
          error:
            'Automatic posting failed'
        });
    }
  }
);

/* =========================================
   CRON
========================================= */

let cronJob = null;

function scheduleAutomaticPosting() {

  if (cronJob) {
    cronJob.stop();
    cronJob = null;
  }

  const expression =
    getSetting(
      'cron',
      '0 */6 * * *'
    );

  if (
    cron.validate(
      expression
    )
  ) {

    cronJob =
      cron.schedule(
        expression,
        () => {

          automaticPost()
            .then(result =>
              console.log(
                'Automatic posting:',
                result
              )
            )
            .catch(error =>
              console.error(
                'Automatic posting error:',
                error
              )
            );
        }
      );
  }
}

/* =========================================
   HEALTH
========================================= */

app.get(
  '/health',
  (req, res) => {

    res.json({
      ok: true,
      service:
        'PromptForge',
      automaticPosting:
        getSetting(
          'autoPostEnabled',
          true
        )
    });
  }
);

/* =========================================
   SPA FALLBACK
========================================= */

app.get(
  '*splat',
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

/* =========================================
   START
========================================= */

scheduleAutomaticPosting();

app.listen(
  PORT,
  () => {

    console.log(
      `PromptForge running on port ${PORT}`
    );
  }
);
