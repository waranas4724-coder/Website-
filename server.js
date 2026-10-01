require("dotenv").config();

const express = require("express");
const session = require("express-session");
const cron = require("node-cron");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const OpenAI = require("openai");

const db = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

const DATA_DIR =
  process.env.DATA_DIR ||
  path.join(__dirname, "data");

const GENERATED_DIR =
  process.env.IMAGE_DATA_DIR ||
  path.join(DATA_DIR, "generated");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(GENERATED_DIR, { recursive: true });

/* =========================================
   PERSISTENT SESSION SECRET
========================================= */

const SESSION_SECRET_FILE =
  path.join(DATA_DIR, "session-secret.txt");

function getSessionSecret() {
  if (process.env.SESSION_SECRET) {
    return process.env.SESSION_SECRET;
  }

  try {
    if (fs.existsSync(SESSION_SECRET_FILE)) {
      const value = fs
        .readFileSync(SESSION_SECRET_FILE, "utf8")
        .trim();

      if (value) return value;
    }
  } catch (err) {
    console.error("Session secret read error:", err.message);
  }

  const secret = crypto.randomBytes(48).toString("hex");

  try {
    fs.writeFileSync(
      SESSION_SECRET_FILE,
      secret,
      { encoding: "utf8", mode: 0o600 }
    );
  } catch (err) {
    console.error(
      "Could not save session secret:",
      err.message
    );
  }

  return secret;
}

const SESSION_SECRET = getSessionSecret();

/* =========================================
   SESSION
========================================= */

app.use(
  session({
    secret: SESSION_SECRET,

    resave: false,

    saveUninitialized: false,

    rolling: true,

    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 8 * 60 * 60 * 1000
    }
  })
);

/* =========================================
   STATIC FILES
========================================= */

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

/* Generated images */

app.use(
  "/generated",
  express.static(GENERATED_DIR)
);

/* =========================================
   HELPERS
========================================= */

function safeJson(value, fallback = {}) {
  try {
    if (typeof value === "object") {
      return value || fallback;
    }

    return JSON.parse(value || "");
  } catch {
    return fallback;
  }
}

function makeId() {
  return (
    Date.now().toString(36) +
    crypto.randomBytes(4).toString("hex")
  );
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
}

function makeSlug(title, existing = []) {
  const base =
    slugify(title) ||
    "prompt";

  let slug = base;
  let number = 2;

  while (
    existing.some(
      p => String(p.slug) === slug
    )
  ) {
    slug = `${base}-${number++}`;
  }

  return slug;
}

function validHttpUrl(value) {
  return /^https?:\/\//i.test(
    String(value || "")
  )
    ? String(value)
    : "";
}

/* =========================================
   DB COMPATIBILITY HELPERS
========================================= */

function getPrompts() {
  if (typeof db.getPrompts === "function") {
    return db.getPrompts();
  }

  if (Array.isArray(db.prompts)) {
    return db.prompts;
  }

  return [];
}

function getPromptById(id) {
  if (typeof db.getPrompt === "function") {
    return db.getPrompt(id);
  }

  return getPrompts().find(
    p => String(p.id) === String(id)
  );
}

function savePrompt(prompt) {
  if (typeof db.addPrompt === "function") {
    return db.addPrompt(prompt);
  }

  if (typeof db.createPrompt === "function") {
    return db.createPrompt(prompt);
  }

  throw new Error(
    "db.js does not expose addPrompt/createPrompt"
  );
}

function removePrompt(id) {
  if (typeof db.deletePrompt === "function") {
    return db.deletePrompt(id);
  }

  throw new Error(
    "db.js does not expose deletePrompt"
  );
}

function getProviders() {
  if (typeof db.getApiProviders === "function") {
    return db.getApiProviders();
  }

  if (typeof db.getProviders === "function") {
    return db.getProviders();
  }

  return [];
}

function addProvider(provider) {
  if (typeof db.addApiProvider === "function") {
    return db.addApiProvider(provider);
  }

  if (typeof db.addProvider === "function") {
    return db.addProvider(provider);
  }

  throw new Error(
    "db.js does not expose addApiProvider/addProvider"
  );
}

function updateProvider(id, data) {
  if (typeof db.updateApiProvider === "function") {
    return db.updateApiProvider(id, data);
  }

  if (typeof db.updateProvider === "function") {
    return db.updateProvider(id, data);
  }

  throw new Error(
    "db.js does not expose updateApiProvider/updateProvider"
  );
}

function removeProvider(id) {
  if (typeof db.deleteApiProvider === "function") {
    return db.deleteApiProvider(id);
  }

  if (typeof db.deleteProvider === "function") {
    return db.deleteProvider(id);
  }

  throw new Error(
    "db.js does not expose deleteApiProvider/deleteProvider"
  );
}

function getSettings() {
  if (typeof db.getSettings === "function") {
    return db.getSettings();
  }

  return {};
}

function saveSettings(data) {
  if (typeof db.updateSettings === "function") {
    return db.updateSettings(data);
  }

  if (typeof db.saveSettings === "function") {
    return db.saveSettings(data);
  }

  throw new Error(
    "db.js does not expose updateSettings/saveSettings"
  );
}

function getAds() {
  if (typeof db.getAds === "function") {
    return db.getAds();
  }

  return {};
}

function saveAds(data) {
  if (typeof db.updateAds === "function") {
    return db.updateAds(data);
  }

  if (typeof db.saveAds === "function") {
    return db.saveAds(data);
  }

  throw new Error(
    "db.js does not expose updateAds/saveAds"
  );
}

/* =========================================
   PUBLIC PROMPTS
========================================= */

app.get("/api/prompts", (req, res) => {
  try {
    let items = getPrompts();

    const q = String(req.query.q || "")
      .trim()
      .toLowerCase();

    const media = String(
      req.query.media || "all"
    );

    const category = String(
      req.query.category || "all"
    );

    if (q) {
      items = items.filter(p =>
        [
          p.title,
          p.prompt,
          p.model,
          p.category
        ]
          .join(" ")
          .toLowerCase()
          .includes(q)
      );
    }

    if (
      media &&
      media !== "all"
    ) {
      items = items.filter(
        p =>
          String(p.media || "")
            .toLowerCase() ===
          media.toLowerCase()
      );
    }

    if (
      category &&
      category !== "all"
    ) {
      items = items.filter(
        p =>
          String(p.category || "")
            .toLowerCase() ===
          category.toLowerCase()
      );
    }

    items.sort(
      (a, b) =>
        new Date(
          b.publishedAt || 0
        ) -
        new Date(
          a.publishedAt || 0
        )
    );

    res.json(items);

  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Could not load prompts"
    });
  }
});

app.get(
  "/api/prompts/:slug",
  (req, res) => {
    const item = getPrompts().find(
      p =>
        String(p.slug) ===
        String(req.params.slug)
    );

    if (!item) {
      return res.status(404).json({
        error: "Prompt not found"
      });
    }

    res.json(item);
  }
);

app.get(
  "/api/categories",
  (req, res) => {
    const result = {};

    for (const p of getPrompts()) {
      const cat =
        p.category || "General";

      result[cat] =
        (result[cat] || 0) + 1;
    }

    res.json(result);
  }
);

/* =========================================
   ADMIN AUTH
========================================= */

function requireAdmin(
  req,
  res,
  next
) {
  if (
    req.session &&
    req.session.admin === true
  ) {
    return next();
  }

  return res.status(401).json({
    error: "Unauthorized"
  });
}

function secureCompare(a, b) {
  const aa = crypto
    .createHash("sha256")
    .update(String(a || ""))
    .digest();

  const bb = crypto
    .createHash("sha256")
    .update(String(b || ""))
    .digest();

  return crypto.timingSafeEqual(
    aa,
    bb
  );
}

const loginAttempts = new Map();

app.post(
  "/api/login",
  (req, res) => {
    const username =
      process.env.ADMIN_USER ||
      process.env.ADMIN_USERNAME ||
      "admin";

    const password =
      process.env.ADMIN_PASSWORD ||
      "admin123";

    const ip =
      req.ip || "unknown";

    const current =
      loginAttempts.get(ip) || {
        count: 0,
        time: 0
      };

    if (
      current.count >= 8 &&
      Date.now() -
        current.time <
        15 * 60 * 1000
    ) {
      return res.status(429).json({
        error:
          "Too many login attempts"
      });
    }

    const valid =
      secureCompare(
        req.body?.username,
        username
      ) &&
      secureCompare(
        req.body?.password,
        password
      );

    if (!valid) {
      loginAttempts.set(ip, {
        count:
          current.count + 1,
        time: Date.now()
      });

      return res.status(401).json({
        error:
          "Invalid credentials"
      });
    }

    loginAttempts.delete(ip);

    req.session.regenerate(
      err => {
        if (err) {
          console.error(
            "Session regenerate:",
            err
          );

          return res.status(500).json({
            error:
              "Could not create session"
          });
        }

        req.session.admin = true;

        req.session.save(
          saveErr => {
            if (saveErr) {
              console.error(
                "Session save:",
                saveErr
              );

              return res.status(500).json({
                error:
                  "Could not save session"
              });
            }

            res.json({
              ok: true
            });
          }
        );
      }
    );
  }
);

app.post(
  "/api/logout",
  (req, res) => {
    req.session.destroy(
      () => {
        res.json({
          ok: true
        });
      }
    );
  }
);

app.get(
  "/api/admin/me",
  (req, res) => {
    res.json({
      authenticated:
        req.session?.admin === true
    });
  }
);

/* =========================================
   ADMIN PROMPTS
========================================= */

app.get(
  "/api/admin/prompts",
  requireAdmin,
  (req, res) => {
    res.json(getPrompts());
  }
);

app.post(
  "/api/admin/prompts",
  requireAdmin,
  (req, res) => {
    try {
      const body =
        req.body || {};

      if (
        !body.title ||
        !body.prompt
      ) {
        return res.status(400).json({
          error:
            "Title and prompt are required"
        });
      }

      const existing =
        getPrompts();

      const prompt = {
        id: makeId(),

        slug: makeSlug(
          body.title,
          existing
        ),

        title: String(
          body.title
        ).trim(),

        prompt: String(
          body.prompt
        ).trim(),

        media:
          body.media ||
          "Image",

        model:
          body.model ||
          "OpenAI",

        category:
          body.category ||
          "General",

        imageUrl:
          validHttpUrl(
            body.imageUrl
          ),

        source:
          body.source ||
          "PromptForge",

        license:
          body.license ||
          "Unknown",

        sourceUrl:
          validHttpUrl(
            body.sourceUrl
          ),

        publishedAt:
          new Date().toISOString(),

        auto:
          body.auto ? 1 : 0
      };

      savePrompt(prompt);

      res.json(prompt);

    } catch (err) {
      console.error(err);

      res.status(500).json({
        error:
          "Could not publish prompt"
      });
    }
  }
);

app.delete(
  "/api/admin/prompts/:id",
  requireAdmin,
  (req, res) => {
    try {
      removePrompt(
        req.params.id
      );

      res.json({
        ok: true
      });

    } catch (err) {
      console.error(err);

      res.status(500).json({
        error:
          "Could not delete prompt"
      });
    }
  }
);

/* =========================================
   OPENAI API PROVIDERS
========================================= */

const OPENAI_CATEGORY =
  "prompt_generate";

function isOpenAIProvider(p) {
  return (
    p &&
    p.enabled !== false &&
    String(
      p.category || ""
    ) === OPENAI_CATEGORY &&
    String(
      p.providerName ||
      p.name ||
      ""
    )
      .toLowerCase()
      .includes("openai") &&
    String(
      p.apiKey ||
      p.api_key ||
      ""
    ).trim()
  );
}

/*
  Return every enabled OpenAI account.
  This is important because the system can
  rotate/fallback through unlimited accounts.
*/

function getOpenAIProviders() {
  return getProviders()
    .filter(isOpenAIProvider)
    .map(p => ({
      ...p,
      apiKey:
        p.apiKey ||
        p.api_key
    }));
}

/* GET PROVIDERS */

app.get(
  "/api/admin/providers",
  requireAdmin,
  (req, res) => {
    try {
      const providers =
        getProviders();

      res.json(
        providers.map(p => ({
          id: p.id,

          name:
            p.providerName ||
            p.name ||
            "OpenAI",

          providerName:
            p.providerName ||
            p.name ||
            "OpenAI",

          category:
            p.category ||
            OPENAI_CATEGORY,

          enabled:
            p.enabled !== false,

          /*
            Never send the real API key
            back to browser.
          */

          apiKey:
            p.apiKey ||
            p.api_key
              ? "••••••••••••"
              : ""
        }))
      );

    } catch (err) {
      console.error(
        "Provider list:",
        err
      );

      res.status(500).json({
        error:
          "Could not load APIs"
      });
    }
  }
);

/* ADD OPENAI ACCOUNT */

app.post(
  "/api/admin/providers",
  requireAdmin,
  (req, res) => {
    try {
      const name =
        String(
          req.body?.name ||
          req.body?.providerName ||
          ""
        ).trim();

      const apiKey =
        String(
          req.body?.apiKey ||
          req.body?.api_key ||
          ""
        ).trim();

      if (!name) {
        return res.status(400).json({
          error:
            "Account name is required"
        });
      }

      if (!apiKey) {
        return res.status(400).json({
          error:
            "OpenAI API key is required"
        });
      }

      const provider = {
        id: makeId(),

        category:
          OPENAI_CATEGORY,

        providerName:
          name,

        name:
          name,

        apiKey:
          apiKey,

        enabled:
          true
      };

      const saved =
        addProvider(provider);

      res.status(201).json({
        ok: true,

        provider: {
          ...(saved || provider),

          apiKey:
            "••••••••••••"
        }
      });

    } catch (err) {
      console.error(
        "ADD OPENAI API ERROR:",
        err
      );

      res.status(500).json({
        error:
          "Could not save OpenAI API"
      });
    }
  }
);

/* ENABLE / DISABLE */

app.put(
  "/api/admin/providers/:id",
  requireAdmin,
  (req, res) => {
    try {
      const old =
        getProviders().find(
          p =>
            String(p.id) ===
            String(req.params.id)
        );

      if (!old) {
        return res.status(404).json({
          error:
            "API account not found"
        });
      }

      const data = {
        ...old,

        enabled:
          req.body.enabled !== undefined
            ? Boolean(
                req.body.enabled
              )
            : old.enabled,

        providerName:
          req.body.providerName ||
          req.body.name ||
          old.providerName ||
          old.name
      };

      /*
        Keep old key unless a new real key
        was supplied.
      */

      const newKey =
        String(
          req.body.apiKey ||
          req.body.api_key ||
          ""
        ).trim();

      if (newKey) {
        data.apiKey = newKey;
      }

      updateProvider(
        req.params.id,
        data
      );

      res.json({
        ok: true
      });

    } catch (err) {
      console.error(err);

      res.status(500).json({
        error:
          "Could not update API"
      });
    }
  }
);

/* DELETE */

app.delete(
  "/api/admin/providers/:id",
  requireAdmin,
  (req, res) => {
    try {
      removeProvider(
        req.params.id
      );

      res.json({
        ok: true
      });

    } catch (err) {
      console.error(err);

      res.status(500).json({
        error:
          "Could not delete API"
      });
    }
  }
);

/* =========================================
   OPENAI CLIENT
========================================= */

function openAIClient(provider) {
  return new OpenAI({
    apiKey:
      provider.apiKey
  });
}

/*
  Get one OpenAI account.
  Start position changes every request so
  unlimited accounts can rotate.
*/

let openAIRotation = 0;

function nextOpenAIProviders() {
  const list =
    getOpenAIProviders();

  if (!list.length) {
    return [];
  }

  const start =
    openAIRotation %
    list.length;

  openAIRotation++;

  return [
    ...list.slice(start),
    ...list.slice(0, start)
  ];
}

/* =========================================
   GENERATE PROMPT
========================================= */

async function generatePrompt(
  topic
) {
  const providers =
    nextOpenAIProviders();

  if (!providers.length) {
    throw new Error(
      "No enabled OpenAI API account"
    );
  }

  let lastError;

  for (const provider of providers) {
    try {
      const client =
        openAIClient(provider);

      const response =
        await client.responses.create({
          model:
            process.env.OPENAI_TEXT_MODEL ||
            "gpt-5",

          input: [
            {
              role: "system",

              content:
                "Create professional, highly detailed AI image prompts. Return only the final prompt."
            },

            {
              role: "user",

              content:
                `Create a premium AI image generation prompt about this worldwide trending topic:\n\n${topic}\n\nInclude subject, composition, cinematic lighting, camera details, environment, mood, colors, realistic textures, depth and professional quality.`
            }
          ]
        });

      const text =
        response.output_text;

      if (
        text &&
        text.trim()
      ) {
        return text.trim();
      }

    } catch (err) {
      lastError = err;

      console.error(
        `OpenAI prompt account failed: ${provider.providerName || provider.name}`,
        err.message
      );
    }
  }

  throw (
    lastError ||
    new Error(
      "All OpenAI accounts failed"
    )
  );
}

/* =========================================
   GENERATE IMAGE
========================================= */

async function generateImage(
  prompt
) {
  const providers =
    nextOpenAIProviders();

  if (!providers.length) {
    throw new Error(
      "No enabled OpenAI API account"
    );
  }

  let lastError;

  for (const provider of providers) {
    try {
      const client =
        openAIClient(provider);

      const result =
        await client.images.generate({
          model:
            process.env.OPENAI_IMAGE_MODEL ||
            "gpt-image-1",

          prompt,

          size:
            process.env.OPENAI_IMAGE_SIZE ||
            "1024x1024"
        });

      const image =
        result?.data?.[0];

      if (
        image?.b64_json
      ) {
        const filename =
          `${Date.now()}-${crypto
            .randomBytes(5)
            .toString("hex")}.png`;

        const filepath =
          path.join(
            GENERATED_DIR,
            filename
          );

        fs.writeFileSync(
          filepath,
          Buffer.from(
            image.b64_json,
            "base64"
          )
        );

        return `/generated/${filename}`;
      }

      if (image?.url) {
        return image.url;
      }

      throw new Error(
        "OpenAI returned no image"
      );

    } catch (err) {
      lastError = err;

      console.error(
        `OpenAI image account failed: ${provider.providerName || provider.name}`,
        err.message
      );
    }
  }

  throw (
    lastError ||
    new Error(
      "All OpenAI image accounts failed"
    )
  );
}

/* =========================================
   SETTINGS
========================================= */

app.get(
  "/api/admin/settings",
  requireAdmin,
  (req, res) => {
    const s =
      getSettings();

    res.json({
      autoPost:
        s.autoPost ??
        true,

      autoPostEnabled:
        s.autoPostEnabled ??
        s.autoPost ??
        true,

      postIntervalMinutes:
        Number(
          s.postIntervalMinutes ??
          60
        ),

      postsPerRun:
        Number(
          s.postsPerRun ??
          1
        ),

      copyGateSeconds:
        Number(
          s.copyGateSeconds ??
          10
        ),

      directLink:
        s.directLink ||
        ""
    });
  }
);

app.get(
  "/api/public/settings",
  (req, res) => {
    const s =
      getSettings();

    res.json({
      copyGateSeconds:
        Number(
          s.copyGateSeconds ??
          10
        ),

      directLink:
        s.directLink ||
        ""
    });
  }
);

let autoTimer = null;

function restartAutoPosting() {
  if (autoTimer) {
    clearInterval(
      autoTimer
    );

    autoTimer = null;
  }

  const s =
    getSettings();

  const enabled =
    s.autoPost !== undefined
      ? s.autoPost
      : s.autoPostEnabled !== false;

  if (!enabled) {
    console.log(
      "Automatic posting disabled"
    );

    return;
  }

  const minutes = Math.max(
    1,
    Number(
      s.postIntervalMinutes ??
      60
    )
  );

  console.log(
    `Automatic posting every ${minutes} minute(s)`
  );

  autoTimer =
    setInterval(
      () => {
        runAutomaticPosting().catch(
          err =>
            console.error(
              "Automatic posting:",
              err.message
            )
        );
      },
      minutes * 60 * 1000
    );
}

app.put(
  "/api/admin/settings",
  requireAdmin,
  (req, res) => {
    try {
      const current =
        getSettings();

      const updated = {
        ...current,

        autoPost:
          Boolean(
            req.body.autoPost ??
            req.body.autoPostEnabled
          ),

        autoPostEnabled:
          Boolean(
            req.body.autoPost ??
            req.body.autoPostEnabled
          ),

        postIntervalMinutes:
          Math.max(
            1,
            Math.min(
              1440,
              Number(
                req.body.postIntervalMinutes ??
                60
              )
            )
          ),

        postsPerRun:
          Math.max(
            1,
            Math.min(
              20,
              Number(
                req.body.postsPerRun ??
                1
              )
            )
          ),

        copyGateSeconds:
          Math.max(
            0,
            Math.min(
              120,
              Number(
                req.body.copyGateSeconds ??
                10
              )
            )
          ),

        directLink:
          validHttpUrl(
            req.body.directLink
          )
      };

      saveSettings(
        updated
      );

      restartAutoPosting();

      res.json({
        ok: true,
        settings: updated
      });

    } catch (err) {
      console.error(err);

      res.status(500).json({
        error:
          "Could not save settings"
      });
    }
  }
);

/* =========================================
   ADS
========================================= */

app.get(
  "/api/admin/ads",
  requireAdmin,
  (req, res) => {
    res.json(
      getAds() || {}
    );
  }
);

app.get(
  "/api/ads",
  (req, res) => {
    res.json(
      getAds() || {}
    );
  }
);

app.put(
  "/api/admin/ads",
  requireAdmin,
  (req, res) => {
    try {
      saveAds(
        req.body || {}
      );

      res.json({
        ok: true
      });

    } catch (err) {
      console.error(err);

      res.status(500).json({
        error:
          "Could not save ads"
      });
    }
  }
);

/*
  Compatibility with old admin.html
  which used POST instead of PUT.
*/

app.post(
  "/api/admin/ads",
  requireAdmin,
  (req, res) => {
    try {
      saveAds(
        req.body || {}
      );

      res.json({
        ok: true
      });

    } catch (err) {
      console.error(err);

      res.status(500).json({
        error:
          "Could not save ads"
      });
    }
  }
);

/* =========================================
   TRENDING TOPICS
========================================= */

async function getTrendingTopic() {
  try {
    const response =
      await fetch(
        "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en",
        {
          signal:
            AbortSignal.timeout(
              15000
            )
        }
      );

    if (!response.ok) {
      throw new Error(
        `Google News HTTP ${response.status}`
      );
    }

    const xml =
      await response.text();

    const titles = [
      ...xml.matchAll(
        /<title><!\[CDATA\[(.*?)\]\]><\/title>/g
      )
    ]
      .map(
        m => m[1]
      )
      .filter(
        t =>
          t &&
          !/google news/i.test(t)
      );

    if (titles.length) {
      return titles[0];
    }

  } catch (err) {
    console.error(
      "Trending search:",
      err.message
    );
  }

  return (
    "latest worldwide technology and creative trends"
  );
}

/* =========================================
   AUTOMATIC POSTING
========================================= */

async function runAutomaticPosting() {
  const settings =
    getSettings();

  const amount =
    Math.max(
      1,
      Math.min(
        20,
        Number(
          settings.postsPerRun ??
          1
        )
      )
    );

  let added = 0;

  for (
    let i = 0;
    i < amount;
    i++
  ) {
    try {
      const topic =
        await getTrendingTopic();

      /*
        Generate prompt first.
      */

      const prompt =
        await generatePrompt(
          topic
        );

      /*
        Generate photo using EXACT
        prompt generated above.
      */

      const imageUrl =
        await generateImage(
          prompt
        );

      /*
        Duplicate protection.
      */

      const existing =
        getPrompts();

      const duplicate =
        existing.some(
          p =>
            String(
              p.prompt || ""
            ).trim()
            .toLowerCase() ===
            prompt.trim()
              .toLowerCase()
        );

      if (duplicate) {
        console.log(
          "Duplicate prompt skipped"
        );

        continue;
      }

      const post = {
        id: makeId(),

        slug: makeSlug(
          topic,
          existing
        ),

        title:
          topic,

        /*
          EXACT prompt used
          to generate image.
        */

        prompt:

          prompt,

        media:
          "Image",

        model:
          "OpenAI",

        category:
          "Trending",

        imageUrl:
          imageUrl,

        source:
          "OpenAI",

        license:
          "Generated",

        sourceUrl:
          "",

        publishedAt:
          new Date().toISOString(),

        auto:
          1
      };

      savePrompt(post);

      added++;

      console.log(
        "Automatic post created:",
        topic
      );

    } catch (err) {
      console.error(
        "Automatic post failed:",
        err.message
      );
    }
  }

  return {
    added
  };
}

app.post(
  "/api/admin/auto-post/run",
  requireAdmin,
  async (req, res) => {
    try {
      const result =
        await runAutomaticPosting();

      res.json({
        ok: true,
        ...result
      });

    } catch (err) {
      console.error(err);

      res.status(500).json({
        error:
          "Automatic posting failed"
      });
    }
  }
);

/*
  Compatibility with old admin.html
*/

app.post(
  "/api/admin/collect",
  requireAdmin,
  async (req, res) => {
    try {
      const result =
        await runAutomaticPosting();

      res.json({
        ok: true,
        ...result
      });

    } catch (err) {
      console.error(err);

      res.status(500).json({
        error:
          "Automatic posting failed"
      });
    }
  }
);

/* =========================================
   HEALTH
========================================= */

app.get(
  "/health",
  (req, res) => {
    res.json({
      ok: true,
      service:
        "PromptForge"
    });
  }
);

/* =========================================
   SPA ROUTES
========================================= */

app.get(
  "/p/:slug",
  (req, res) => {
    res.sendFile(
      path.join(
        __dirname,
        "public",
        "index.html"
      )
    );
  }
);

app.get(
  "/admin",
  (req, res) => {
    res.sendFile(
      path.join(
        __dirname,
        "public",
        "admin.html"
      )
    );
  }
);

app.get(
  "/admin.html",
  (req, res) => {
    res.sendFile(
      path.join(
        __dirname,
        "public",
        "admin.html"
      )
    );
  }
);

/* =========================================
   ERROR HANDLER
========================================= */

app.use(
  (err, req, res, next) => {
    console.error(
      "SERVER ERROR:",
      err
    );

    if (res.headersSent) {
      return next(err);
    }

    res.status(500).json({
      error:
        "Internal server error"
    });
  }
);

/* =========================================
   START
========================================= */

app.listen(
  PORT,
  () => {
    console.log(
      `PromptForge running on port ${PORT}`
    );

    restartAutoPosting();
  }
);
