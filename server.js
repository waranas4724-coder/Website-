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
        get
