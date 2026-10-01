require("dotenv").config();

const express = require("express");
const session = require("express-session");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const OpenAI = require("openai");

const db = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

/* =========================================================
   BASIC CONFIG
========================================================= */

app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

const PUBLIC_DIR = path.join(__dirname, "public");

const DATA_DIR =
  process.env.DATA_DIR ||
  path.join(__dirname, "data");

const IMAGE_DIR =
  process.env.IMAGE_DATA_DIR ||
  path.join(DATA_DIR, "generated");

fs.mkdirSync(IMAGE_DIR, { recursive: true });

app.use(express.static(PUBLIC_DIR));

/*
  Generated images are stored on Render Persistent Disk:
  /data/generated
*/
app.use(
  "/generated",
  express.static(IMAGE_DIR, {
    maxAge: "7d",
    etag: true
  })
);

/* =========================================================
   SESSION
========================================================= */

const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  crypto.randomBytes(32).toString("hex");

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: "auto",
      maxAge: 8 * 60 * 60 * 1000
    }
  })
);

/* =========================================================
   HELPERS
========================================================= */

const nowISO = () => new Date().toISOString();

const cleanText = (value, max = 10000) =>
  String(value ?? "")
    .trim()
    .slice(0, max);

function httpUrl(value) {
  const s = String(value || "").trim();

  if (/^https?:\/\//i.test(s)) {
    return s;
  }

  return "";
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
}

function mediaOf(value) {
  if (/video|film|clip|motion/i.test(String(value || ""))) {
    return "Video";
  }

  if (/writing|text/i.test(String(value || ""))) {
    return "Writing";
  }

  return "Image";
}

function safeError(error) {
  if (!error) return "Unknown error";

  return (
    error.message ||
    error.error?.message ||
    String(error)
  ).slice(0, 1200);
}

function adminRequired(req, res, next) {
  if (req.session && req.session.admin) {
    return next();
  }

  return res.status(401).json({
    ok: false,
    error: "Unauthorized"
  });
}

/* =========================================================
   DATABASE COMPATIBILITY
   Current db.js is JSON based.
========================================================= */

function getPrompts() {
  return Array.isArray(db.getPrompts())
    ? db.getPrompts()
    : [];
}

function addPrompt(prompt) {
  return db.addPrompt(prompt);
}

function updatePrompt(id, changes) {
  return db.updatePrompt(id, changes);
}

function deletePrompt(id) {
  return db.deletePrompt(id);
}

function getProviders() {
  return Array.isArray(db.getApiProviders())
    ? db.getApiProviders()
    : [];
}

function addProvider(provider) {
  return db.addApiProvider(provider);
}

function updateProvider(id, changes) {
  return db.updateApiProvider(id, changes);
}

function deleteProvider(id) {
  return db.deleteApiProvider(id);
}

function getSettings() {
  return db.getSettings() || {};
}

function saveSettings(settings) {
  return db.saveSettings(settings);
}

function getAds() {
  return db.getAds() || {};
}

function saveAds(ads) {
  return db.saveAds(ads);
}

/* =========================================================
   SETTINGS
========================================================= */

function normalizeSettings(input = {}) {
  const current = getSettings();

  const interval = Math.max(
    1,
    Math.min(
      1440,
      Number(
        input.postIntervalMinutes ??
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
        input.postsPerRun ??
        current.postsPerRun ??
        1
      )
    )
  );

  const copyGateSeconds = Math.max(
    0,
    Math.min(
      120,
      Number(
        input.copyGateSeconds ??
        current.copyGateSeconds ??
        10
      )
    )
  );

  return {
    ...current,

    autoPost:
      input.autoPost !== undefined
        ? Boolean(input.autoPost)
        : current.autoPost !== false,

    postIntervalMinutes:
      Number.isFinite(interval)
        ? interval
        : 60,

    postsPerRun:
      Number.isFinite(postsPerRun)
        ? postsPerRun
        : 1,

    copyGateSeconds:
      Number.isFinite(copyGateSeconds)
        ? copyGateSeconds
        : 10,

    directLink:
      httpUrl(
        input.directLink ??
        current.directLink ??
        ""
      )
  };
}

/* =========================================================
   ADMIN LOGIN
========================================================= */

const ADMIN_USER =
  process.env.ADMIN_USER ||
  process.env.ADMIN_USERNAME ||
  "admin";

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD ||
  "admin123";

const failedLogins = new Map();

function safeEqual(a, b) {
  const aa = crypto
    .createHash("sha256")
    .update(String(a ?? ""))
    .digest();

  const bb = crypto
    .createHash("sha256")
    .update(String(b ?? ""))
    .digest();

  return crypto.timingSafeEqual(aa, bb);
}

app.post("/api/login", (req, res) => {
  const ip = req.ip || "unknown";

  const record =
    failedLogins.get(ip) || {
      count: 0,
      last: 0
    };

  if (
    record.count >= 5 &&
    Date.now() - record.last < 15 * 60 * 1000
  ) {
    return res.status(429).json({
      ok: false,
      error: "Too many login attempts. Try again later."
    });
  }

  const username = req.body?.username || "";
  const password = req.body?.password || "";

  if (
    safeEqual(username, ADMIN_USER) &&
    safeEqual(password, ADMIN_PASSWORD)
  ) {
    failedLogins.delete(ip);

    req.session.admin = true;

    return res.json({
      ok: true
    });
  }

  failedLogins.set(ip, {
    count: record.count + 1,
    last: Date.now()
  });

  return res.status(401).json({
    ok: false,
    error: "Invalid credentials"
  });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({
      ok: true
    });
  });
});

app.get("/api/admin/me", (req, res) => {
  res.json({
    authenticated: Boolean(
      req.session?.admin
    )
  });
});

/* =========================================================
   PUBLIC PROMPTS
========================================================= */

function sortPrompts(items) {
  return [...items].sort(
    (a, b) =>
      new Date(b.publishedAt || 0) -
      new Date(a.publishedAt || 0)
  );
}

function queryPrompts(query = {}) {
  let items = getPrompts();

  const search = String(
    query.q || ""
  ).trim().toLowerCase();

  if (search) {
    items = items.filter((p) =>
      [
        p.title,
        p.prompt,
        p.model,
        p.category
      ]
        .join(" ")
        .toLowerCase()
        .includes(search)
    );
  }

  if (
    query.media &&
    query.media !== "all"
  ) {
    items = items.filter(
      (p) =>
        mediaOf(p.media) ===
        mediaOf(query.media)
    );
  }

  if (
    query.category &&
    query.category !== "all"
  ) {
    items = items.filter(
      (p) =>
        String(p.category || "")
          .toLowerCase() ===
        String(query.category)
          .toLowerCase()
    );
  }

  return sortPrompts(items);
}

app.get("/api/prompts", (req, res) => {
  res.json(
    queryPrompts(req.query)
  );
});

app.get("/api/prompts/:slug", (req, res) => {
  const slug = String(req.params.slug);

  const prompt = getPrompts().find(
    (p) => p.slug === slug
  );

  if (!prompt) {
    return res.status(404).json({
      ok: false,
      error: "Prompt not found"
    });
  }

  res.json(prompt);
});

app.get("/api/categories", (req, res) => {
  const categories = {};

  for (const p of getPrompts()) {
    const category =
      p.category || "General";

    categories[category] =
      (categories[category] || 0) + 1;
  }

  res.json(categories);
});

/* =========================================================
   ADMIN PROMPTS
========================================================= */

function createPromptObject(data, auto = false) {
  const all = getPrompts();

  const base =
    slugify(data.title) ||
    "prompt";

  let slug = base;
  let number = 2;

  while (
    all.some(
      (p) => p.slug === slug
    )
  ) {
    slug = `${base}-${number++}`;
  }

  return {
    id:
      Date.now().toString(36) +
      crypto.randomBytes(4).toString("hex"),

    slug,

    title: cleanText(
      data.title,
      160
    ),

    prompt: cleanText(
      data.prompt,
      12000
    ),

    media: mediaOf(data.media),

    model:
      cleanText(
        data.model,
        100
      ) || "OpenAI",

    category:
      cleanText(
        data.category,
        100
      ) || "General",

    imageUrl:
      httpUrl(data.imageUrl),

    source:
      cleanText(
        data.source,
        200
      ) || "PromptForge",

    license:
      cleanText(
        data.license,
        200
      ) || "Unknown",

    sourceUrl:
      httpUrl(data.sourceUrl),

    publishedAt:
      data.publishedAt ||
      nowISO(),

    auto: auto ? true : false
  };
}

app.get(
  "/api/admin/prompts",
  adminRequired,
  (req, res) => {
    res.json(
      sortPrompts(getPrompts())
    );
  }
);

app.post(
  "/api/admin/prompts",
  adminRequired,
  (req, res) => {
    const title = cleanText(
      req.body?.title
    );

    const prompt = cleanText(
      req.body?.prompt
    );

    if (!title || !prompt) {
      return res.status(400).json({
        ok: false,
        error:
          "Title and prompt are required."
      });
    }

    try {
      const item =
        createPromptObject(
          req.body,
          false
        );

      const saved =
        addPrompt(item);

      return res.json({
        ok: true,
        prompt:
          saved || item
      });
    } catch (error) {
      console.error(
        "Manual publish error:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "Could not publish prompt: " +
          safeError(error)
      });
    }
  }
);

app.put(
  "/api/admin/prompts/:id",
  adminRequired,
  (req, res) => {
    try {
      const result =
        updatePrompt(
          req.params.id,
          req.body || {}
        );

      res.json({
        ok: true,
        prompt: result
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error:
          safeError(error)
      });
    }
  }
);

app.delete(
  "/api/admin/prompts/:id",
  adminRequired,
  (req, res) => {
    try {
      deletePrompt(
        req.params.id
      );

      res.json({
        ok: true
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error:
          safeError(error)
      });
    }
  }
);

/* =========================================================
   OPENAI API ACCOUNTS
   ONLY:
   - providerName
   - apiKey
========================================================= */

function isOpenAIProvider(provider) {
  if (!provider) return false;

  const name = String(
    provider.providerName ||
    provider.name ||
    ""
  ).toLowerCase();

  const category =
    provider.category ||
    "prompt_generate";

  return (
    category ===
      "prompt_generate" &&
    (
      name.includes("openai") ||
      name.length > 0
    ) &&
    Boolean(
      provider.apiKey ||
      provider.api_key
    )
  );
}

function getOpenAIProviders() {
  return getProviders()
    .filter(
      isOpenAIProvider
    )
    .filter(
      (p) =>
        p.enabled !== false
    );
}

app.get(
  "/api/admin/providers",
  adminRequired,
  (req, res) => {
    const providers =
      getProviders()
        .filter(
          (p) =>
            p.category ===
              "prompt_generate" ||
            !p.category
        )
        .map((p) => ({
          id: p.id,
          providerName:
            p.providerName ||
            p.name ||
            "OpenAI",
          name:
            p.providerName ||
            p.name ||
            "OpenAI",
          category:
            p.category ||
            "prompt_generate",
          enabled:
            p.enabled !== false,
          apiKey:
            p.apiKey
              ? "••••••••••••"
              : ""
        }));

    res.json(providers);
  }
);

app.post(
  "/api/admin/providers",
  adminRequired,
  (req, res) => {
    const providerName =
      cleanText(
        req.body?.providerName ||
        req.body?.name,
        100
      );

    const apiKey =
      cleanText(
        req.body?.apiKey ||
        req.body?.api_key,
        500
      );

    if (!providerName) {
      return res.status(400).json({
        ok: false,
        error:
          "Provider name is required."
      });
    }

    if (!apiKey) {
      return res.status(400).json({
        ok: false,
        error:
          "OpenAI API key is required."
      });
    }

    try {
      const result =
        addProvider({
          providerName,
          apiKey,
          category:
            "prompt_generate",
          enabled: true
        });

      return res.json({
        ok: true,
        id: result?.id || result,
        message:
          "OpenAI API added successfully."
      });
    } catch (error) {
      console.error(
        "Provider add error:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "Could not add OpenAI API: " +
          safeError(error)
      });
    }
  }
);

app.put(
  "/api/admin/providers/:id",
  adminRequired,
  (req, res) => {
    try {
      const changes = {};

      if (
        req.body?.providerName !==
        undefined
      ) {
        changes.providerName =
          cleanText(
            req.body.providerName,
            100
          );
      }

      if (
        req.body?.apiKey !==
        undefined &&
        req.body.apiKey
      ) {
        changes.apiKey =
          cleanText(
            req.body.apiKey,
            500
          );
      }

      if (
        req.body?.enabled !==
        undefined
      ) {
        changes.enabled =
          Boolean(
            req.body.enabled
          );
      }

      changes.category =
        "prompt_generate";

      updateProvider(
        req.params.id,
        changes
      );

      res.json({
        ok: true
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error:
          safeError(error)
      });
    }
  }
);

app.delete(
  "/api/admin/providers/:id",
  adminRequired,
  (req, res) => {
    try {
      deleteProvider(
        req.params.id
      );

      res.json({
        ok: true
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error:
          safeError(error)
      });
    }
  }
);

/* =========================================================
   OPENAI CLIENT
========================================================= */

const OPENAI_TEXT_MODEL =
  process.env.OPENAI_TEXT_MODEL ||
  "gpt-5";

const OPENAI_IMAGE_MODEL =
  process.env.OPENAI_IMAGE_MODEL ||
  "gpt-image-1";

function createOpenAI(apiKey) {
  return new OpenAI({
    apiKey
  });
}

/*
  Try every enabled OpenAI account.
  If one fails, automatically try another.
*/
async function withOpenAIFallback(
  operationName,
  callback
) {
  const providers =
    getOpenAIProviders();

  if (!providers.length) {
    throw new Error(
      "No enabled OpenAI API account found. Add an OpenAI API key in Admin → OpenAI API Accounts."
    );
  }

  const start =
    Math.floor(
      Date.now() / 1000
    ) % providers.length;

  const errors = [];

  for (
    let offset = 0;
    offset < providers.length;
    offset++
  ) {
    const index =
      (start + offset) %
      providers.length;

    const provider =
      providers[index];

    const apiKey =
      provider.apiKey ||
      provider.api_key;

    const name =
      provider.providerName ||
      provider.name ||
      `OpenAI #${index + 1}`;

    try {
      console.log(
        `[OpenAI] ${operationName}: trying ${name}`
      );

      const client =
        createOpenAI(apiKey);

      const result =
        await callback(
          client,
          provider,
          name
        );

      console.log(
        `[OpenAI] ${operationName}: success with ${name}`
      );

      return {
        result,
        provider
      };
    } catch (error) {
      const message =
        safeError(error);

      console.error(
        `[OpenAI] ${operationName} failed on ${name}: ${message}`
      );

      errors.push(
        `${name}: ${message}`
      );
    }
  }

  throw new Error(
    `${operationName} failed on all OpenAI accounts.\n` +
    errors.join("\n")
  );
}

/* =========================================================
   TRENDING TOPICS
   Built-in Google News RSS.
   No extra trending API required.
========================================================= */

async function getTrendingTopics() {
  const url =
    "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en";

  let response;

  try {
    response = await fetch(
      url,
      {
        headers: {
          "User-Agent":
            "PromptForge/1.0"
        },
        signal:
          AbortSignal.timeout(
            20000
          )
      }
    );
  } catch (error) {
    throw new Error(
      "Trending search failed: " +
      safeError(error)
    );
  }

  if (!response.ok) {
    throw new Error(
      `Trending search returned HTTP ${response.status}`
    );
  }

  const xml =
    await response.text();

  const topics = [];

  const matches =
    xml.matchAll(
      /<item[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<\/item>/gi
    );

  for (const match of matches) {
    const raw =
      String(match[1] || "");

    const title =
      raw
        .replace(
          /<!\[CDATA\[([\s\S]*?)\]\]>/g,
          "$1"
        )
        .replace(
          /<[^>]+>/g,
          ""
        )
        .replace(
          /&amp;/g,
          "&"
        )
        .replace(
          /&quot;/g,
          '"'
        )
        .replace(
          /&#39;/g,
          "'"
        )
        .trim();

    if (
      title &&
      title.length >= 8
    ) {
      topics.push(title);
    }
  }

  const unique = [];

  for (const topic of topics) {
    const key =
      topic.toLowerCase();

    if (
      !unique.some(
        (x) =>
          x.toLowerCase() === key
      )
    ) {
      unique.push(topic);
    }
  }

  if (!unique.length) {
    throw new Error(
      "Trending search returned no usable topics."
    );
  }

  return unique.slice(0, 30);
}

/* =========================================================
   DUPLICATE CHECK
========================================================= */

function normalizeForDuplicate(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function alreadyPublished(
  topic,
  prompt
) {
  const topicKey =
    normalizeForDuplicate(
      topic
    );

  const promptKey =
    normalizeForDuplicate(
      prompt
    );

  return getPrompts().some(
    (item) =>
      normalizeForDuplicate(
        item.title
      ) === topicKey ||
      normalizeForDuplicate(
        item.prompt
      ) === promptKey
  );
}

/* =========================================================
   GENERATE PROMPT
========================================================= */

async function generatePrompt(
  topic
) {
  const result =
    await withOpenAIFallback(
      "Prompt generation",
      async (client) => {
        const response =
          await client.responses.create(
            {
              model:
                OPENAI_TEXT_MODEL,

              input: [
                {
                  role: "system",
                  content:
                    "You are a professional AI image prompt engineer. Return only the final image-generation prompt. Do not add explanations, markdown, labels, or quotation marks."
                },
                {
                  role: "user",
                  content:
                    `Create a premium, highly detailed AI image-generation prompt based on this worldwide trending topic:\n\n${topic}\n\nThe prompt must describe the subject, composition, environment, cinematic lighting, realistic textures, atmosphere, color grading, camera/lens details, depth, sharp details, professional photography quality, and visual storytelling.`
                }
              ]
            }
          );

        const text =
          response.output_text;

        if (
          !text ||
          !String(text).trim()
        ) {
          throw new Error(
            "OpenAI returned an empty prompt."
          );
        }

        return String(
          text
        ).trim();
      }
    );

  return {
    prompt:
      result.result,
    provider:
      result.provider
  };
}

/* =========================================================
   GENERATE IMAGE
   Exact prompt generated above is used.
========================================================= */

async function generateImage(
  exactPrompt
) {
  const result =
    await withOpenAIFallback(
      "Image generation",
      async (client) => {
        const response =
          await client.images.generate(
            {
              model:
                OPENAI_IMAGE_MODEL,

              prompt:
                exactPrompt,

              size:
                process.env.OPENAI_IMAGE_SIZE ||
                "1024x1024"
            }
          );

        const item =
          response?.data?.[0];

        if (!item) {
          throw new Error(
            "OpenAI returned no image data."
          );
        }

        /*
          URL response
        */
        if (item.url) {
          return httpUrl(
            item.url
          );
        }

        /*
          Base64 response
        */
        if (item.b64_json) {
          const buffer =
            Buffer.from(
              item.b64_json,
              "base64"
            );

          if (!buffer.length) {
            throw new Error(
              "OpenAI returned empty image data."
            );
          }

          const filename =
            `ai-${Date.now()}-${crypto
              .randomBytes(5)
              .toString("hex")}.png`;

          const filePath =
            path.join(
              IMAGE_DIR,
              filename
            );

          fs.writeFileSync(
            filePath,
            buffer
          );

          return `/generated/${filename}`;
        }

        throw new Error(
          "OpenAI image response did not contain a URL or base64 image."
        );
      }
    );

  return {
    imageUrl:
      result.result,
    provider:
      result.provider
  };
}

/* =========================================================
   SAVE + VERIFY POST
========================================================= */

function saveAutomaticPost({
  topic,
  exactPrompt,
  imageUrl,
  promptProvider,
  imageProvider
}) {
  if (!imageUrl) {
    throw new Error(
      "Image generation finished without an image URL."
    );
  }

  const post =
    createPromptObject(
      {
        title: topic,
        prompt: exactPrompt,
        media: "Image",
        model:
          `${OPENAI_IMAGE_MODEL}`,
        category: "Trending",
        imageUrl,
        source:
          "OpenAI Automatic",
        license:
          "OpenAI / generated content"
      },
      true
    );

  /*
    IMPORTANT:
    Do not say "created" before database save succeeds.
  */
  addPrompt(post);

  /*
    Verify database actually contains it.
  */
  const saved =
    getPrompts().find(
      (item) =>
        item.id === post.id ||
        item.slug === post.slug
    );

  if (!saved) {
    throw new Error(
      "Post save verification failed. The generated content was not found in the database."
    );
  }

  if (
    !saved.imageUrl ||
    !saved.prompt
  ) {
    throw new Error(
      "Post verification failed: photo or exact prompt is missing."
    );
  }

  return {
    ...saved,
    promptProvider:
      promptProvider?.providerName ||
      promptProvider?.name ||
      "OpenAI",

    imageProvider:
      imageProvider?.providerName ||
      imageProvider?.name ||
      "OpenAI"
  };
}

/* =========================================================
   ONE AUTOMATIC POST
========================================================= */

async function createOneAutomaticPost(
  topics
) {
  let lastError = null;

  for (const topic of topics) {
    if (
      alreadyPublished(
        topic,
        ""
      )
    ) {
      continue;
    }

    try {
      console.log(
        `[AUTO] Topic: ${topic}`
      );

      /*
        1. Generate prompt
      */
      const generated =
        await generatePrompt(
          topic
        );

      const exactPrompt =
        generated.prompt;

      if (!exactPrompt) {
        throw new Error(
          "Prompt generation returned an empty prompt."
        );
      }

      /*
        Check prompt duplicate.
      */
      if (
        alreadyPublished(
          topic,
          exactPrompt
        )
      ) {
        continue;
      }

      /*
        2. Generate image using EXACT SAME prompt
      */
      const image =
        await generateImage(
          exactPrompt
        );

      /*
        3. Save photo + exact prompt together
      */
      const post =
        saveAutomaticPost({
          topic,
          exactPrompt,
          imageUrl:
            image.imageUrl,
          promptProvider:
            generated.provider,
          imageProvider:
            image.provider
        });

      console.log(
        `[AUTO] Post verified: ${post.id}`
      );

      return {
        ok: true,
        post
      };
    } catch (error) {
      lastError = error;

      console.error(
        `[AUTO] Failed for topic "${topic}":`,
        safeError(error)
      );

      /*
        Try next trending topic if available.
      */
    }
  }

  throw new Error(
    lastError
      ? safeError(lastError)
      : "No new trending topic was available."
  );
}

/* =========================================================
   AUTOMATIC POST RUN
========================================================= */

let autoTimer = null;
let autoRunning = false;

async function runAutomaticPosting(
  options = {}
) {
  if (autoRunning) {
    return {
      ok: false,
      skipped: true,
      error:
        "Automatic posting is already running."
    };
  }

  autoRunning = true;

  const settings =
    normalizeSettings(
      getSettings()
    );

  const count =
    options.count ||
    settings.postsPerRun ||
    1;

  const errors = [];
  const posts = [];

  try {
    const topics =
      await getTrendingTopics();

    if (!topics.length) {
      throw new Error(
        "No trending topics found."
      );
    }

    /*
      Make sure we don't reuse the same topic
      in the same run.
    */
    const available =
      topics.filter(
        (topic) =>
          !alreadyPublished(
            topic,
            ""
          )
      );

    if (!available.length) {
      throw new Error(
        "All fetched trending topics have already been published. No new post was created."
      );
    }

    for (
      let i = 0;
      i < count;
      i++
    ) {
      try {
        const result =
          await createOneAutomaticPost(
            available.slice(i)
          );

        if (
          result?.post
        ) {
          posts.push(
            result.post
          );
        }
      } catch (error) {
        const message =
          safeError(error);

        errors.push(
          `Post ${i + 1}: ${message}`
        );

        console.error(
          `[AUTO] Post ${i + 1} failed: ${message}`
        );
      }
    }

    /*
      IMPORTANT:
      If nothing was created, return an error.
      Never return fake success.
    */
    if (!posts.length) {
      throw new Error(
        errors.join("\n") ||
        "Automatic posting failed. No post was created."
      );
    }

    return {
      ok: true,
      added:
        posts.length,
      posts,
      errors
    };
  } finally {
    autoRunning = false;
  }
}

/* =========================================================
   ADMIN AUTO POST RUN
========================================================= */

async function autoRunHandler(
  req,
  res
) {
  try {
    const settings =
      normalizeSettings(
        getSettings()
      );

    const requestedCount =
      Number(
        req.body?.postsPerRun ||
        req.body?.count ||
        settings.postsPerRun ||
        1
      );

    const count =
      Math.max(
        1,
        Math.min(
          20,
          requestedCount
        )
      );

    const result =
      await runAutomaticPosting({
        count
      });

    /*
      Partial failures are returned visibly.
    */
    return res.json({
      ok: true,
      added:
        result.added,
      posts:
        result.posts.map(
          (p) => ({
            id: p.id,
            slug: p.slug,
            title: p.title,
            imageUrl:
              p.imageUrl,
            prompt:
              p.prompt
          })
        ),
      errors:
        result.errors || [],
      message:
        result.errors?.length
          ? `Created ${result.added} post(s), but some posts failed.`
          : `Created ${result.added} post(s) successfully.`
    });
  } catch (error) {
    const message =
      safeError(error);

    console.error(
      "[ADMIN AUTO RUN ERROR]",
      message
    );

    return res.status(500).json({
      ok: false,
      error: message,
      message:
        "Automatic post failed. No fake success was returned."
    });
  }
}

app.post(
  "/api/admin/auto-post/run",
  adminRequired,
  autoRunHandler
);

/*
  Backward compatibility with old admin button.
*/
app.post(
  "/api/admin/collect",
  adminRequired,
  autoRunHandler
);

/* =========================================================
   SETTINGS API
========================================================= */

app.get(
  "/api/admin/settings",
  adminRequired,
  (req, res) => {
    res.json(
      normalizeSettings(
        getSettings()
      )
    );
  }
);

app.get(
  "/api/public/settings",
  (req, res) => {
    const settings =
      normalizeSettings(
        getSettings()
      );

    res.json({
      copyGateSeconds:
        settings.copyGateSeconds,

      directLink:
        settings.directLink
    });
  }
);

app.put(
  "/api/admin/settings",
  adminRequired,
  (req, res) => {
    try {
      const next =
        normalizeSettings(
          req.body || {}
        );

      saveSettings(next);

      restartAutomaticScheduler();

      res.json({
        ok: true,
        settings: next
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error:
          "Could not save settings: " +
          safeError(error)
      });
    }
  }
);

/*
  Some older admin versions use POST.
*/
app.post(
  "/api/admin/settings",
  adminRequired,
  (req, res) => {
    try {
      const next =
        normalizeSettings(
          req.body || {}
        );

      saveSettings(next);

      restartAutomaticScheduler();

      res.json({
        ok: true,
        settings: next
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error:
          "Could not save settings: " +
          safeError(error)
      });
    }
  }
);

/* =========================================================
   ADS
========================================================= */

const AD_SLOTS = [
  "head_code",
  "popunder",
  "social_bar",
  "banner_top",
  "banner_middle",
  "banner_bottom",
  "modal_banner",
  "native_banner"
];

app.get(
  "/api/ads",
  (req, res) => {
    res.json(
      getAds() || {}
    );
  }
);

app.get(
  "/api/admin/ads",
  adminRequired,
  (req, res) => {
    res.json(
      getAds() || {}
    );
  }
);

app.put(
  "/api/admin/ads",
  adminRequired,
  (req, res) => {
    try {
      const input =
        req.body || {};

      const current =
        getAds() || {};

      const next = {
        ...current
      };

      for (const slot of AD_SLOTS) {
        const value =
          input[slot] || {};

        next[slot] = {
          enabled:
            Boolean(
              value.enabled
            ),

          code:
            cleanText(
              value.code,
              30000
            ),

          height:
            Math.max(
              0,
              Math.min(
                1000,
                Number(
                  value.height || 0
                )
              )
            )
        };
      }

      saveAds(next);

      res.json({
        ok: true,
        ads: next
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error:
          "Could not save ads: " +
          safeError(error)
      });
    }
  }
);

app.post(
  "/api/admin/ads",
  adminRequired,
  (req, res) => {
    try {
      const input =
        req.body || {};

      const current =
        getAds() || {};

      const next = {
        ...current
      };

      for (const slot of AD_SLOTS) {
        const value =
          input[slot] || {};

        next[slot] = {
          enabled:
            Boolean(
              value.enabled
            ),

          code:
            cleanText(
              value.code,
              30000
            ),

          height:
            Math.max(
              0,
              Math.min(
                1000,
                Number(
                  value.height || 0
                )
              )
            )
        };
      }

      saveAds(next);

      res.json({
        ok: true,
        ads: next
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error:
          "Could not save ads: " +
          safeError(error)
      });
    }
  }
);

/* =========================================================
   HEALTH CHECK
========================================================= */

app.get(
  "/health",
  (req, res) => {
    const settings =
      normalizeSettings(
        getSettings()
      );

    res.json({
      ok: true,
      service:
        "PromptForge",
      time:
        nowISO(),
      prompts:
        getPrompts().length,
      openAIAccounts:
        getOpenAIProviders().length,
      automaticPosting:
        settings.autoPost,
      intervalMinutes:
        settings.postIntervalMinutes,
      postsPerRun:
        settings.postsPerRun
    });
  }
);

/* =========================================================
   AUTOMATIC SCHEDULER
   Exact minute interval.
========================================================= */

function stopAutomaticScheduler() {
  if (autoTimer) {
    clearTimeout(
      autoTimer
    );

    autoTimer = null;
  }
}

function restartAutomaticScheduler() {
  stopAutomaticScheduler();

  const settings =
    normalizeSettings(
      getSettings()
    );

  if (!settings.autoPost) {
    console.log(
      "Automatic posting disabled."
    );

    return;
  }

  const minutes =
    Math.max(
      1,
      Math.min(
        1440,
        Number(
          settings.postIntervalMinutes ||
            60
        )
      )
    );

  const delay =
    minutes *
    60 *
    1000;

  console.log(
    `Automatic posting scheduled every ${minutes} minute(s).`
  );

  const scheduleNext =
    () => {
      autoTimer =
        setTimeout(
          async () => {
            try {
              console.log(
                "[AUTO] Scheduled run started."
              );

              const result =
                await runAutomaticPosting({
                  count:
                    settings.postsPerRun
                });

              console.log(
                `[AUTO] Scheduled run completed. Added ${result.added} post(s).`
              );

              if (
                result.errors?.length
              ) {
                console.error(
                  "[AUTO] Partial errors:",
                  result.errors
                );
              }
            } catch (error) {
              console.error(
                "[AUTO] Scheduled run failed:",
                safeError(error)
              );
            }

            /*
              Always schedule the next run,
              even if this run fails.
            */
            scheduleNext();
          },
          delay
        );
    };

  scheduleNext();
}

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
  (err, req, res, next) => {
    console.error(
      "Unhandled server error:",
      err
    );

    if (
      res.headersSent
    ) {
      return next(err);
    }

    res.status(500).json({
      ok: false,
      error:
        safeError(err)
    });
  }
);

/* =========================================================
   SPA ROUTES
========================================================= */

app.get(
  "/p/:slug",
  (req, res) => {
    res.sendFile(
      path.join(
        PUBLIC_DIR,
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
        PUBLIC_DIR,
        "admin.html"
      )
    );
  }
);

/*
  Do not let /generated/... fall into SPA fallback.
*/
app.get(
  /^\/(?!api\/|generated\/).*/,
  (req, res) => {
    res.sendFile(
      path.join(
        PUBLIC_DIR,
        "index.html"
      )
    );
  }
);

/* =========================================================
   START
========================================================= */

app.listen(
  PORT,
  () => {
    console.log(
      `PromptForge running on port ${PORT}`
    );

    console.log(
      `OpenAI accounts: ${getOpenAIProviders().length}`
    );

    console.log(
      `Stored prompts: ${getPrompts().length}`
    );

    restartAutomaticScheduler();
  }
);
