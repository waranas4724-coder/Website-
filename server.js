require('dotenv').config();

const express = require('express');
const session = require('express-session');
const cron = require('node-cron');
const OpenAI = require('openai');
const path = require('path');
const fs = require('fs');

const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret:
      process.env.SESSION_SECRET ||
      'change-this-session-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production'
    }
  })
);

app.use(express.static(path.join(__dirname, 'public')));

/* =========================================================
   AUTH
========================================================= */

const ADMIN_USER =
  process.env.ADMIN_USER || 'admin';

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD || 'admin123';

function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) {
    return next();
  }

  res.status(401).json({
    error: 'Unauthorized'
  });
}

/* =========================================================
   HELPERS
========================================================= */

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

function uniqueSlug(title) {
  const base = slugify(title) || `prompt-${Date.now()}`;
  const prompts = db.getPrompts();

  let slug = base;
  let n = 2;

  while (prompts.some((p) => p.slug === slug)) {
    slug = `${base}-${n++}`;
  }

  return slug;
}

function normalizeCategory(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

/* =========================================================
   PUBLIC API
========================================================= */

app.get('/api/prompts', (req, res) => {
  const q = String(req.query.q || '')
    .trim()
    .toLowerCase();

  const media = String(
    req.query.media || 'all'
  ).toLowerCase();

  const category = String(
    req.query.category || 'all'
  ).toLowerCase();

  let prompts = db.getPrompts();

  if (q) {
    prompts = prompts.filter((p) =>
      [
        p.title,
        p.prompt,
        p.category,
        p.media,
        p.model
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(q)
    );
  }

  if (media !== 'all') {
    prompts = prompts.filter(
      (p) =>
        String(p.media || '').toLowerCase() ===
        media
    );
  }

  if (category !== 'all') {
    prompts = prompts.filter(
      (p) =>
        String(p.category || '').toLowerCase() ===
        category
    );
  }

  prompts.sort(
    (a, b) =>
      new Date(b.createdAt || 0) -
      new Date(a.createdAt || 0)
  );

  res.json(prompts);
});

app.get('/api/prompts/:slug', (req, res) => {
  const prompt = db
    .getPrompts()
    .find((p) => p.slug === req.params.slug);

  if (!prompt) {
    return res.status(404).json({
      error: 'Prompt not found'
    });
  }

  res.json(prompt);
});

app.get('/api/categories', (req, res) => {
  const categories = [
    ...new Set(
      db
        .getPrompts()
        .map((p) => p.category)
        .filter(Boolean)
    )
  ];

  res.json(categories);
});

app.get('/api/public/settings', (req, res) => {
  const settings = db.getSettings();

  res.json({
    copyGateSeconds:
      Number(settings.copyGateSeconds || 10),
    directLink:
      settings.directLink || ''
  });
});

app.get('/api/ads', (req, res) => {
  res.json(db.getAds());
});

/* =========================================================
   AUTH API
========================================================= */

app.post('/api/login', (req, res) => {
  const {
    username,
    password
  } = req.body || {};

  if (
    username === ADMIN_USER &&
    password === ADMIN_PASSWORD
  ) {
    req.session.admin = true;

    return res.json({
      ok: true
    });
  }

  res.status(401).json({
    error: 'Invalid login'
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

/* =========================================================
   ADMIN PROMPTS
========================================================= */

app.post(
  '/api/admin/prompts',
  requireAdmin,
  (req, res) => {
    const body = req.body || {};

    if (!body.title || !body.prompt) {
      return res.status(400).json({
        error: 'Title and prompt are required'
      });
    }

    const prompt = {
      title: body.title,
      prompt: body.prompt,
      imageUrl: body.imageUrl || '',
      media: body.media || 'Image',
      model: body.model || 'Manual',
      category: body.category || 'General',
      source: body.source || 'PromptForge',
      slug: uniqueSlug(body.title)
    };

    const data = db.addPrompt(prompt);

    res.json({
      ok: true,
      prompt:
        data.prompts[data.prompts.length - 1]
    });
  }
);

app.put(
  '/api/admin/prompts/:id',
  requireAdmin,
  (req, res) => {
    db.updatePrompt(
      req.params.id,
      req.body || {}
    );

    res.json({
      ok: true
    });
  }
);

app.delete(
  '/api/admin/prompts/:id',
  requireAdmin,
  (req, res) => {
    db.deletePrompt(req.params.id);

    res.json({
      ok: true
    });
  }
);

/* =========================================================
   API PROVIDERS
========================================================= */

const ALLOWED_PROVIDER_CATEGORIES = [
  'prompt_generate',
  'photo_generate',
  'trending_search'
];

app.get(
  '/api/admin/providers',
  requireAdmin,
  (req, res) => {
    const providers =
      db.getApiProviders().map((p) => ({
        ...p,
        apiKey: p.apiKey
          ? '••••••••••••'
          : ''
      }));

    res.json(providers);
  }
);

app.post(
  '/api/admin/providers',
  requireAdmin,
  (req, res) => {
    const {
      category,
      providerName,
      apiKey
    } = req.body || {};

    if (
      !ALLOWED_PROVIDER_CATEGORIES.includes(
        category
      )
    ) {
      return res.status(400).json({
        error: 'Invalid provider category'
      });
    }

    if (!providerName) {
      return res.status(400).json({
        error: 'Provider name is required'
      });
    }

    const result = db.addApiProvider({
      category,
      providerName,
      apiKey: apiKey || '',
      enabled: true
    });

    res.json({
      ok: true,
      provider:
        result.apiProviders[
          result.apiProviders.length - 1
        ]
    });
  }
);

app.put(
  '/api/admin/providers/:id',
  requireAdmin,
  (req, res) => {
    const changes = {
      ...req.body
    };

    if (
      !changes.apiKey ||
      changes.apiKey === '••••••••••••'
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
  requireAdmin,
  (req, res) => {
    db.deleteApiProvider(req.params.id);

    res.json({
      ok: true
    });
  }
);

/* =========================================================
   ADMIN SETTINGS
========================================================= */

app.get(
  '/api/admin/settings',
  requireAdmin,
  (req, res) => {
    res.json(db.getSettings());
  }
);

app.put(
  '/api/admin/settings',
  requireAdmin,
  (req, res) => {
    const body = req.body || {};

    const current = db.getSettings();

    const interval = Math.max(
      1,
      Math.min(
        1440,
        Number(
          body.postIntervalMinutes ??
          current.postIntervalMinutes ??
          60
        )
      )
    );

    const postsPerRun = Math.max(
      1,
      Math.min(
        20,
        Number(
          body.postsPerRun ??
          current.postsPerRun ??
          1
        )
      )
    );

    db.saveSettings({
      ...body,
      postIntervalMinutes: interval,
      postsPerRun,
      autoPost:
        body.autoPost !== false
    });

    restartAutoPosting();

    res.json({
      ok: true,
      settings: db.getSettings()
    });
  }
);

/* =========================================================
   ADS MANAGER
========================================================= */

app.get(
  '/api/admin/ads',
  requireAdmin,
  (req, res) => {
    res.json(db.getAds());
  }
);

app.put(
  '/api/admin/ads',
  requireAdmin,
  (req, res) => {
    db.saveAds(req.body || {});

    res.json({
      ok: true,
      ads: db.getAds()
    });
  }
);

/* =========================================================
   OPENAI
========================================================= */

function getOpenAIProvider() {
  const providers =
    db.getApiProviders();

  return providers.find(
    (p) =>
      p.enabled !== false &&
      normalizeCategory(p.category) ===
        'prompt_generate' &&
      String(p.providerName || '')
        .toLowerCase()
        .includes('openai') &&
      p.apiKey
  );
}

async function createOpenAIClient() {
  const provider =
    getOpenAIProvider();

  if (!provider) {
    throw new Error(
      'OpenAI API provider is not configured'
    );
  }

  return new OpenAI({
    apiKey: provider.apiKey
  });
}

/* =========================================================
   TRENDING TOPIC
========================================================= */

async function getTrendingTopic() {
  const response = await fetch(
    'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en'
  );

  if (!response.ok) {
    throw new Error(
      'Trending source failed'
    );
  }

  const xml = await response.text();

  const titles = [
    ...xml.matchAll(
      /<title>(.*?)<\/title>/g
    )
  ]
    .map((m) =>
      m[1]
        .replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1')
        .trim()
    )
    .filter(
      (x) =>
        x &&
        x.toLowerCase() !==
          'google news'
    );

  if (!titles.length) {
    throw new Error(
      'No trending topic found'
    );
  }

  const existingTitles = new Set(
    db
      .getPrompts()
      .map((p) =>
        String(p.title || '')
          .toLowerCase()
      )
  );

  const fresh =
    titles.find(
      (title) =>
        !existingTitles.has(
          title.toLowerCase()
        )
    ) || titles[0];

  return fresh;
}

/* =========================================================
   OPENAI PROMPT
========================================================= */

async function generatePrompt(topic) {
  const client =
    await createOpenAIClient();

  const response =
    await client.responses.create({
      model:
        process.env.OPENAI_TEXT_MODEL ||
        'gpt-5',
      input: [
        {
          role: 'system',
          content:
            'You create high-quality prompts for AI image generation.'
        },
        {
          role: 'user',
          content: `
Create ONE premium image-generation prompt based on this current topic:

${topic}

Requirements:
- cinematic
- highly detailed
- realistic
- professional composition
- atmospheric depth
- beautiful lighting
- strong subject
- suitable for a public prompt website
- do not mention politics unless the topic itself requires it
- return ONLY the final image prompt
          `
        }
      ]
    });

  const prompt =
    response.output_text?.trim();

  if (!prompt) {
    throw new Error(
      'OpenAI prompt generation returned empty text'
    );
  }

  return prompt;
}

/* =========================================================
   OPENAI IMAGE
========================================================= */

async function generateImage(prompt) {
  const client =
    await createOpenAIClient();

  const result =
    await client.images.generate({
      model:
        process.env.OPENAI_IMAGE_MODEL ||
        'gpt-image-1',
      prompt,
      size:
        process.env.OPENAI_IMAGE_SIZE ||
        '1024x1024'
    });

  const image =
    result.data?.[0];

  if (!image) {
    throw new Error(
      'OpenAI image generation returned no image'
    );
  }

  if (image.b64_json) {
    const imageDir =
      process.env.IMAGE_DATA_DIR ||
      path.join(
        process.env.DATA_DIR ||
          path.join(__dirname, 'data'),
        'generated'
      );

    fs.mkdirSync(imageDir, {
      recursive: true
    });

    const filename =
      `${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}.png`;

    const filepath =
      path.join(
        imageDir,
        filename
      );

    fs.writeFileSync(
      filepath,
      Buffer.from(
        image.b64_json,
        'base64'
      )
    );

    return `/generated/${filename}`;
  }

  if (image.url) {
    return image.url;
  }

  throw new Error(
    'OpenAI image response contains no usable image'
  );
}

/* =========================================================
   AUTOMATIC POST
========================================================= */

let posting = false;

async function createAutomaticPost() {
  if (posting) {
    return {
      skipped: true,
      reason:
        'Another automatic post is running'
    };
  }

  posting = true;

  try {
    const settings =
      db.getSettings();

    if (settings.autoPost === false) {
      return {
        skipped: true,
        reason:
          'Automatic posting disabled'
      };
    }

    const topic =
      await getTrendingTopic();

    const prompt =
      await generatePrompt(topic);

    /*
      Important:
      Image is generated from the EXACT prompt
      that will be published with the image.
    */
    const imageUrl =
      await generateImage(prompt);

    const title =
      topic.length > 140
        ? `${topic.slice(0, 137)}...`
        : topic;

    const duplicate =
      db
        .getPrompts()
        .some(
          (p) =>
            String(p.prompt || '')
              .trim()
              .toLowerCase() ===
            prompt
              .trim()
              .toLowerCase()
        );

    if (duplicate) {
      return {
        skipped: true,
        reason:
          'Duplicate prompt'
      };
    }

    const item = {
      title,
      prompt,
      imageUrl,
      media: 'Image',
      model: 'OpenAI',
      category: 'Trending',
      source: 'OpenAI',
      slug: uniqueSlug(title)
    };

    db.addPrompt(item);

    return {
      ok: true,
      post: item
    };
  } finally {
    posting = false;
  }
}

/* =========================================================
   MANUAL RUN NOW
========================================================= */

app.post(
  '/api/admin/auto-post/run',
  requireAdmin,
  async (req, res) => {
    try {
      const result =
        await createAutomaticPost();

      res.json(result);
    } catch (error) {
      console.error(
        'Automatic post error:',
        error
      );

      res.status(500).json({
        error:
          error.message ||
          'Automatic post failed'
      });
    }
  }
);

/* =========================================================
   CRON
========================================================= */

let cronTask = null;

function buildCronExpression(minutes) {
  const m = Math.max(
    1,
    Math.min(
      1440,
      Number(minutes || 60)
    )
  );

  if (m < 60) {
    return `*/${m} * * * *`;
  }

  if (m === 60) {
    return '0 * * * *';
  }

  if (m % 60 === 0) {
    return `0 */${m / 60} * * *`;
  }

  /*
    For non-hour intervals above 60 minutes,
    use the closest supported hourly schedule.
    Admin values under 60 minutes are exact.
  */
  return `0 * * * *`;
}

function restartAutoPosting() {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
  }

  const settings =
    db.getSettings();

  if (settings.autoPost === false) {
    console.log(
      'Automatic posting disabled'
    );
    return;
  }

  const expression =
    buildCronExpression(
      settings.postIntervalMinutes ||
        60
    );

  cronTask = cron.schedule(
    expression,
    async () => {
      const latest =
        db.getSettings();

      const amount = Math.max(
        1,
        Math.min(
          20,
          Number(
            latest.postsPerRun || 1
          )
        )
      );

      for (
        let i = 0;
        i < amount;
        i++
      ) {
        try {
          await createAutomaticPost();
        } catch (error) {
          console.error(
            'Scheduled post failed:',
            error.message
          );
        }
      }
    }
  );

  console.log(
    `Automatic posting scheduled: ${expression}`
  );
}

/* =========================================================
   HEALTH
========================================================= */

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'PromptForge',
    automaticPosting:
      db.getSettings().autoPost !== false
  });
});

/* =========================================================
   SPA / ADMIN FALLBACK
========================================================= */

app.get('/p/:slug', (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      'public',
      'index.html'
    )
  );
});

app.get('/admin', (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      'public',
      'admin.html'
    )
  );
});

/*
  Express 5 SPA fallback
*/
app.get(
  /^(?!\/api\/).*/,
  (req, res) => {
    if (
      req.path.startsWith('/generated/')
    ) {
      return res.status(404).end();
    }

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
   START
========================================================= */

app.listen(PORT, () => {
  console.log(
    `PromptForge running on port ${PORT}`
  );

  restartAutoPosting();
});
