require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const db = require("./db");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");

const DATA_DIR =
  process.env.DATA_DIR ||
  path.join(ROOT, "data");

const IMAGE_DIR =
  process.env.IMAGE_DATA_DIR ||
  path.join(DATA_DIR, "generated");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(IMAGE_DIR, { recursive: true });

app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

/*
|--------------------------------------------------------------------------
| Static files
|--------------------------------------------------------------------------
*/

app.use(express.static(PUBLIC_DIR));

/*
|--------------------------------------------------------------------------
| Generated AI images
|--------------------------------------------------------------------------
*/

app.use(
  "/generated",
  express.static(IMAGE_DIR, {
    maxAge: "7d",
    fallthrough: false
  })
);

/*
|--------------------------------------------------------------------------
| Helpers
|--------------------------------------------------------------------------
*/

function safeString(value, max = 5000) {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, max);
}

function slugify(value) {
  return safeString(value, 200)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
}

function uniqueSlug(list, title) {
  const base = slugify(title) || "prompt";
  let slug = base;
  let n = 2;

  while (list.some((x) => x.slug === slug)) {
    slug = `${base}-${n++}`;
  }

  return slug;
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

function providerName(provider) {
  return safeString(
    provider?.providerName ||
    provider?.name ||
    "Provider",
    120
  );
}

function providerKey(provider) {
  return safeString(
    provider?.apiKey ||
    provider?.api ||
    provider?.key ||
    "",
    500
  );
}

function enabled(provider) {
  return provider?.enabled !== false;
}

function normalizeCategory(value) {
  const v = String(value || "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .trim();

  if (
    v.includes("prompt") ||
    v.includes("text") ||
    v.includes("generate prompt")
  ) {
    return "prompt_generate";
  }

  if (
    v.includes("image") ||
    v.includes("photo") ||
    v.includes("picture")
  ) {
    return "photo_generate";
  }

  if (
    v.includes("trend") ||
    v.includes("news") ||
    v.includes("search")
  ) {
    return "trending_search";
  }

  return v;
}

function getProviders(category) {
  const all = db.getApiProviders();

  return all.filter((p) => {
    return (
      enabled(p) &&
      normalizeCategory(p.category) === category &&
      providerKey(p)
    );
  });
}

function isProvider(name, ...names) {
  const n = String(name || "").toLowerCase();

  return names.some((x) =>
    n.includes(String(x).toLowerCase())
  );
}

/*
|--------------------------------------------------------------------------
| Admin authentication
|--------------------------------------------------------------------------
|
| No extra session package required.
| Uses a signed random admin cookie.
|--------------------------------------------------------------------------
*/

const ADMIN_USERNAME =
  process.env.ADMIN_USERNAME ||
  process.env.ADMIN_USER ||
  "admin";

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD ||
  "admin123";

const ADMIN_COOKIE = "pf_admin";

const ADMIN_SECRET =
  process.env.SESSION_SECRET ||
  process.env.ADMIN_SECRET ||
  crypto.randomBytes(32).toString("hex");

const adminTokens = new Set();

function makeAdminToken() {
  const raw =
    crypto.randomBytes(32).toString("hex");

  const sig = crypto
    .createHmac("sha256", ADMIN_SECRET)
    .update(raw)
    .digest("hex");

  return `${raw}.${sig}`;
}

function validAdminToken(token) {
  if (!token) return false;

  if (!adminTokens.has(token)) {
    return false;
  }

  const parts = token.split(".");

  if (parts.length !== 2) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", ADMIN_SECRET)
    .update(parts[0])
    .digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(parts[1]),
    Buffer.from(expected)
  );
}

function getCookie(req, name) {
  const header = req.headers.cookie || "";

  const parts = header
    .split(";")
    .map((x) => x.trim());

  for (const part of parts) {
    const index = part.indexOf("=");

    if (index === -1) continue;

    const key = part.slice(0, index);
    const value = part.slice(index + 1);

    if (key === name) {
      return decodeURIComponent(value);
    }
  }

  return "";
}

function setAdminCookie(res, token) {
  res.setHeader(
    "Set-Cookie",
    `${ADMIN_COOKIE}=${encodeURIComponent(
      token
    )}; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800`
  );
}

function clearAdminCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
  );
}

function requireAdmin(req, res, next) {
  const token = getCookie(req, ADMIN_COOKIE);

  if (!validAdminToken(token)) {
    return res.status(401).json({
      error: "Unauthorized"
    });
  }

  next();
}

/*
|--------------------------------------------------------------------------
| Public prompts
|--------------------------------------------------------------------------
*/

function getAllPrompts() {
  return db.getPrompts();
}

function searchPrompts(query = {}) {
  let list = getAllPrompts();

  const search = safeString(query.q, 200).toLowerCase();
  const media = safeString(query.media, 50).toLowerCase();
  const category = safeString(
    query.category,
    100
  ).toLowerCase();

  if (search) {
    list = list.filter((p) =>
      [
        p.title,
        p.prompt,
        p.category,
        p.model,
        p.source
      ]
        .join(" ")
        .toLowerCase()
        .includes(search)
    );
  }

  if (media && media !== "all") {
    list = list.filter(
      (p) =>
        String(p.media || "").toLowerCase() ===
        media
    );
  }

  if (category && category !== "all") {
    list = list.filter(
      (p) =>
        String(p.category || "").toLowerCase() ===
        category
    );
  }

  return list.sort(
    (a, b) =>
      new Date(b.publishedAt || 0) -
      new Date(a.publishedAt || 0)
  );
}

app.get("/api/prompts", (req, res) => {
  res.json(searchPrompts(req.query));
});

app.get("/api/prompts/:slug", (req, res) => {
  const item = getAllPrompts().find(
    (p) => p.slug === req.params.slug
  );

  if (!item) {
    return res.status(404).json({
      error: "Prompt not found"
    });
  }

  res.json(item);
});

app.get("/api/categories", (req, res) => {
  const result = {};

  for (const item of getAllPrompts()) {
    const category =
      item.category || "General";

    result[category] =
      (result[category] || 0) + 1;
  }

  res.json(result);
});

/*
|--------------------------------------------------------------------------
| Public settings
|--------------------------------------------------------------------------
*/

app.get("/api/public/settings", (req, res) => {
  const settings = db.getSettings();

  res.json({
    copyGateSeconds: Number(
      settings.copyGateSeconds || 10
    ),
    directLink:
      settings.directLink || ""
  });
});

/*
|--------------------------------------------------------------------------
| Ads
|--------------------------------------------------------------------------
*/

app.get("/api/ads", (req, res) => {
  res.set("Cache-Control", "no-store");

  const ads = db.getAds();

  res.json(ads || {});
});

/*
|--------------------------------------------------------------------------
| Login
|--------------------------------------------------------------------------
*/

app.post("/api/login", (req, res) => {
  const username = safeString(
    req.body?.username,
    120
  );

  const password = String(
    req.body?.password || ""
  );

  if (
    username !== ADMIN_USERNAME ||
    password !== ADMIN_PASSWORD
  ) {
    return res.status(401).json({
      error: "Invalid credentials"
    });
  }

  const token = makeAdminToken();

  adminTokens.add(token);

  setAdminCookie(res, token);

  res.json({
    ok: true
  });
});

app.post("/api/logout", (req, res) => {
  const token = getCookie(req, ADMIN_COOKIE);

  if (token) {
    adminTokens.delete(token);
  }

  clearAdminCookie(res);

  res.json({
    ok: true
  });
});

app.get("/api/admin/me", (req, res) => {
  const token = getCookie(req, ADMIN_COOKIE);

  res.json({
    authenticated: validAdminToken(token)
  });
});

/*
|--------------------------------------------------------------------------
| Admin prompts
|--------------------------------------------------------------------------
*/

app.get(
  "/api/admin/prompts",
  requireAdmin,
  (req, res) => {
    res.json(getAllPrompts());
  }
);

app.post(
  "/api/admin/prompts",
  requireAdmin,
  (req, res) => {
    const body = req.body || {};

    if (!body.title || !body.prompt) {
      return res.status(400).json({
        error:
          "Title and prompt are required"
      });
    }

    const list = getAllPrompts();

    const item = {
      id:
        Date.now().toString(36) +
        crypto.randomBytes(4).toString("hex"),

      slug: uniqueSlug(list, body.title),

      title: safeString(
        body.title,
        160
      ),

      prompt: safeString(
        body.prompt,
        12000
      ),

      description: safeString(
        body.description,
        1000
      ),

      media: "Image",

      model:
        safeString(
          body.model,
          150
        ) || "AI",

      category:
        safeString(
          body.category,
          150
        ) || "AI Image",

      imageUrl:
        isHttpUrl(body.imageUrl)
          ? body.imageUrl
          : "",

      source:
        safeString(
          body.source,
          150
        ) || "Original",

      sourceUrl:
        isHttpUrl(body.sourceUrl)
          ? body.sourceUrl
          : "",

      license:
        safeString(
          body.license,
          100
        ) || "Original",

      publishedAt:
        new Date().toISOString(),

      auto: false
    };

    db.addPrompt(item);

    res.json(item);
  }
);

app.put(
  "/api/admin/prompts/:id",
  requireAdmin,
  (req, res) => {
    const updated = db.updatePrompt(
      req.params.id,
      req.body || {}
    );

    if (!updated) {
      return res.status(404).json({
        error: "Prompt not found"
      });
    }

    res.json(updated);
  }
);

app.delete(
  "/api/admin/prompts/:id",
  requireAdmin,
  (req, res) => {
    db.deletePrompt(req.params.id);

    res.json({
      ok: true
    });
  }
);

/*
|--------------------------------------------------------------------------
| API Providers
|--------------------------------------------------------------------------
|
| Three separate categories:
|
| 1. trending_search
| 2. prompt_generate
| 3. photo_generate
|
*/

app.get(
  "/api/admin/providers",
  requireAdmin,
  (req, res) => {
    const providers =
      db.getApiProviders();

    /*
     * Never send the full API key back to browser.
     */
    res.json(
      providers.map((p) => ({
        id: p.id,
        category: p.category,
        providerName:
          p.providerName,
        enabled:
          p.enabled !== false,
        hasKey:
          !!providerKey(p),
        apiKey:
          providerKey(p)
            ? "••••••••••••"
            : ""
      }))
    );
  }
);

app.post(
  "/api/admin/providers",
  requireAdmin,
  (req, res) => {
    const body = req.body || {};

    const category =
      normalizeCategory(body.category);

    const allowed = [
      "trending_search",
      "prompt_generate",
      "photo_generate"
    ];

    if (!allowed.includes(category)) {
      return res.status(400).json({
        error:
          "Invalid API category"
      });
    }

    const apiKey =
      providerKey(body);

    const name =
      providerName(body);

    if (!name || !apiKey) {
      return res.status(400).json({
        error:
          "Provider name and API key are required"
      });
    }

    const item =
      db.addApiProvider({
        category,
        providerName: name,
        apiKey,
        enabled: true
      });

    res.json({
      id: item.id,
      category: item.category,
      providerName:
        item.providerName,
      enabled: true,
      hasKey: true
    });
  }
);

app.put(
  "/api/admin/providers/:id",
  requireAdmin,
  (req, res) => {
    const body = req.body || {};

    const update = {};

    if (body.category) {
      update.category =
        normalizeCategory(
          body.category
        );
    }

    if (body.providerName) {
      update.providerName =
        providerName(body);
    }

    if (
      body.apiKey &&
      !String(body.apiKey)
        .includes("••")
    ) {
      update.apiKey =
        providerKey(body);
    }

    if (
      typeof body.enabled ===
      "boolean"
    ) {
      update.enabled =
        body.enabled;
    }

    const result =
      db.updateApiProvider(
        req.params.id,
        update
      );

    if (!result) {
      return res.status(404).json({
        error: "Provider not found"
      });
    }

    res.json({
      id: result.id,
      category:
        result.category,
      providerName:
        result.providerName,
      enabled:
        result.enabled !== false,
      hasKey:
        !!providerKey(result)
    });
  }
);

app.delete(
  "/api/admin/providers/:id",
  requireAdmin,
  (req, res) => {
    db.deleteApiProvider(
      req.params.id
    );

    res.json({
      ok: true
    });
  }
);

/*
|--------------------------------------------------------------------------
| Settings
|--------------------------------------------------------------------------
*/

app.get(
  "/api/admin/settings",
  requireAdmin,
  (req, res) => {
    res.json(
      db.getSettings()
    );
  }
);

app.put(
  "/api/admin/settings",
  requireAdmin,
  (req, res) => {
    const old =
      db.getSettings();

    const body =
      req.body || {};

    const next = {
      ...old,

      autoPost:
        body.autoPost !== undefined
          ? !!body.autoPost
          : !!old.autoPost,

      postIntervalMinutes:
        Math.min(
          1440,
          Math.max(
            1,
            Number(
              body.postIntervalMinutes ??
                old.postIntervalMinutes ??
                60
            )
          )
        ),

      postsPerRun:
        Math.min(
          20,
          Math.max(
            1,
            Number(
              body.postsPerRun ??
                old.postsPerRun ??
                1
            )
          )
        ),

      copyGateSeconds:
        Math.min(
          120,
          Math.max(
            0,
            Number(
              body.copyGateSeconds ??
                old.copyGateSeconds ??
                10
            )
          )
        ),

      directLink:
        safeString(
          body.directLink ??
            old.directLink ??
            "",
          2000
        )
    };

    db.updateSettings(next);

    restartAutoPosting();

    res.json(next);
  }
);

/*
|--------------------------------------------------------------------------
| Ads settings
|--------------------------------------------------------------------------
*/

app.get(
  "/api/admin/ads",
  requireAdmin,
  (req, res) => {
    res.json(
      db.getAds() || {}
    );
  }
);

app.put(
  "/api/admin/ads",
  requireAdmin,
  (req, res) => {
    db.updateAds(
      req.body || {}
    );

    res.json(
      db.getAds() || {}
    );
  }
);

/*
|--------------------------------------------------------------------------
| Trending Search
|--------------------------------------------------------------------------
|
| Provider support:
|
| - NewsData.io
| - GNews
| - generic Google News RSS fallback
|
|--------------------------------------------------------------------------
*/

async function fetchNewsData(provider) {
  const key =
    providerKey(provider);

  const url =
    "https://newsdata.io/api/1/latest" +
    `?apikey=${encodeURIComponent(
      key
    )}` +
    "&language=en" +
    "&size=10";

  const response =
    await fetch(url, {
      headers: {
        Accept:
          "application/json"
      },
      signal:
        AbortSignal.timeout(20000)
    });

  if (!response.ok) {
    throw new Error(
      `${providerName(
        provider
      )}: HTTP ${response.status}`
    );
  }

  const json =
    await response.json();

  if (
    !Array.isArray(
      json.results
    )
  ) {
    throw new Error(
      `${providerName(
        provider
      )}: invalid response`
    );
  }

  return json.results
    .map((x) => ({
      title:
        safeString(
          x.title,
          200
        ),
      source:
        safeString(
          x.source_id,
          100
        )
    }))
    .filter((x) => x.title);
}

async function fetchGNews(provider) {
  const key =
    providerKey(provider);

  const url =
    "https://gnews.io/api/v4/top-headlines" +
    `?token=${encodeURIComponent(
      key
    )}` +
    "&lang=en" +
    "&max=10";

  const response =
    await fetch(url, {
      headers: {
        Accept:
          "application/json"
      },
      signal:
        AbortSignal.timeout(20000)
    });

  if (!response.ok) {
    throw new Error(
      `${providerName(
        provider
      )}: HTTP ${response.status}`
    );
  }

  const json =
    await response.json();

  if (
    !Array.isArray(
      json.articles
    )
  ) {
    throw new Error(
      `${providerName(
        provider
      )}: invalid response`
    );
  }

  return json.articles
    .map((x) => ({
      title:
        safeString(
          x.title,
          200
        ),
      source:
        safeString(
          x.source?.name,
          100
        )
    }))
    .filter((x) => x.title);
}

async function fetchGoogleNewsRSS() {
  const url =
    "https://news.google.com/rss" +
    "?hl=en-US&gl=US&ceid=US:en";

  const response =
    await fetch(url, {
      headers: {
        "User-Agent":
          "PromptForge/2.0"
      },
      signal:
        AbortSignal.timeout(20000)
    });

  if (!response.ok) {
    throw new Error(
      `Google News RSS: HTTP ${response.status}`
    );
  }

  const xml =
    await response.text();

  const results = [];

  const matches = [
    ...xml.matchAll(
      /<item>([\s\S]*?)<\/item>/gi
    )
  ];

  for (const match of matches) {
    const block =
      match[1];

    const title =
      block.match(
        /<title>([\s\S]*?)<\/title>/i
      );

    if (!title) continue;

    const clean =
      title[1]
        .replace(
          /<!\[CDATA\[|\]\]>/g,
          ""
        )
        .replace(
          /<[^>]+>/g,
          ""
        )
        .trim();

    if (clean) {
      results.push({
        title: clean,
        source:
          "Google News"
      });
    }
  }

  return results;
}

async function getTrendingTopic() {
  const providers =
    getProviders(
      "trending_search"
    );

  const errors = [];

  /*
   * User-added APIs first.
   */
  for (const provider of providers) {
    try {
      const name =
        providerName(
          provider
        );

      let results = [];

      if (
        isProvider(
          name,
          "newsdata"
        )
      ) {
        results =
          await fetchNewsData(
            provider
          );
      } else if (
        isProvider(
          name,
          "gnews"
        )
      ) {
        results =
          await fetchGNews(
            provider
          );
      } else {
        throw new Error(
          `${name}: unsupported trending provider`
        );
      }

      if (results.length) {
        return {
          title:
            results[0].title,
          source:
            results[0].source ||
            name
        };
      }
    } catch (error) {
      errors.push(
        error.message
      );
    }
  }

  /*
   * Free fallback.
   */
  try {
    const results =
      await fetchGoogleNewsRSS();

    if (results.length) {
      return {
        title:
          results[0].title,
        source:
          results[0].source
      };
    }
  } catch (error) {
    errors.push(
      error.message
    );
  }

  throw new Error(
    "Trending search failed. " +
      errors.join(" | ")
  );
}

/*
|--------------------------------------------------------------------------
| Prompt Generation
|--------------------------------------------------------------------------
|
| Hugging Face currently provides an OpenAI-compatible chat endpoint for
| text generation. We use fetch directly, so no extra npm package is needed.
|--------------------------------------------------------------------------
*/

async function generatePromptWithHF(
  provider,
  topic
) {
  const key =
    providerKey(provider);

  const response =
    await fetch(
      "https://router.huggingface.co/v1/chat/completions",
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${key}`,

          "Content-Type":
            "application/json",

          Accept:
            "application/json"
        },

        body: JSON.stringify({
          model:
            process.env.HF_TEXT_MODEL ||
            "Qwen/Qwen3-4B-Instruct-2507",

          messages: [
            {
              role: "system",
              content:
                "You are a professional AI image prompt writer. Return only one detailed English image-generation prompt. Do not add explanations, headings, markdown or quotation marks."
            },

            {
              role: "user",
              content:
                `Create a premium, highly detailed AI image-generation prompt based on this trending topic:

${topic}

The prompt should describe:
- main subject
- composition
- environment
- lighting
- realistic textures
- cinematic photography
- professional color grading
- atmospheric depth
- sharp details
- premium visual quality

Return only the final prompt.`
            }
          ],

          temperature: 0.9,

          max_tokens: 900
        }),

        signal:
          AbortSignal.timeout(45000)
      }
    );

  if (!response.ok) {
    const errorText =
      await response.text();

    throw new Error(
      `${providerName(
        provider
      )}: HTTP ${response.status} ${errorText.slice(
        0,
        500
      )}`
    );
  }

  const json =
    await response.json();

  const content =
    json?.choices?.[0]?.message
      ?.content;

  if (!content) {
    throw new Error(
      `${providerName(
        provider
      )}: empty prompt response`
    );
  }

  return safeString(
    content,
    12000
  );
}

async function generatePrompt(
  topic
) {
  const providers =
    getProviders(
      "prompt_generate"
    );

  if (!providers.length) {
    throw new Error(
      "No Prompt Generate API is configured."
    );
  }

  const errors = [];

  for (const provider of providers) {
    try {
      const name =
        providerName(
          provider
        );

      if (
        isProvider(
          name,
          "huggingface",
          "hugging face",
          "hf"
        )
      ) {
        const prompt =
          await generatePromptWithHF(
            provider,
            topic
          );

        if (prompt) {
          return {
            prompt,
            provider:
              name
          };
        }
      } else {
        throw new Error(
          `${name}: unsupported prompt provider`
        );
      }
    } catch (error) {
      errors.push(
        error.message
      );
    }
  }

  throw new Error(
    "Prompt generation failed on all providers. " +
      errors.join(" | ")
  );
}

/*
|--------------------------------------------------------------------------
| Image Generation
|--------------------------------------------------------------------------
|
| Hugging Face text-to-image endpoint returns image bytes on success.
|--------------------------------------------------------------------------
*/

async function generateImageWithHF(
  provider,
  prompt
) {
  const key =
    providerKey(provider);

  const model =
    process.env.HF_IMAGE_MODEL ||
    "stabilityai/stable-diffusion-xl-base-1.0";

  const endpoint =
    `https://router.huggingface.co/hf-inference/models/${model}`;

  const response =
    await fetch(endpoint, {
      method: "POST",

      headers: {
        Authorization:
          `Bearer ${key}`,

        "Content-Type":
          "application/json",

        Accept:
          "image/png"
      },

      body: JSON.stringify({
        inputs: prompt,

        parameters: {
          width: 1024,
          height: 1024
        }
      }),

      signal:
        AbortSignal.timeout(180000)
    });

  if (!response.ok) {
    const errorText =
      await response.text();

    throw new Error(
      `${providerName(
        provider
      )}: HTTP ${response.status} ${errorText.slice(
        0,
        700
      )}`
    );
  }

  const buffer =
    Buffer.from(
      await response.arrayBuffer()
    );

  if (!buffer.length) {
    throw new Error(
      `${providerName(
        provider
      )}: empty image response`
    );
  }

  const filename =
    `ai-${Date.now()}-${crypto
      .randomBytes(5)
      .toString("hex")}.png`;

  const filepath =
    path.join(
      IMAGE_DIR,
      filename
    );

  fs.writeFileSync(
    filepath,
    buffer
  );

  return {
    imageUrl:
      `/generated/${filename}`,

    provider:
      providerName(provider),

    model
  };
}

async function generateImage(
  prompt
) {
  const providers =
    getProviders(
      "photo_generate"
    );

  if (!providers.length) {
    throw new Error(
      "No Image / Photo Generate API is configured."
    );
  }

  const errors = [];

  for (const provider of providers) {
    try {
      const name =
        providerName(
          provider
        );

      if (
        isProvider(
          name,
          "huggingface",
          "hugging face",
          "hf"
        )
      ) {
        const result =
          await generateImageWithHF(
            provider,
            prompt
          );

        if (result?.imageUrl) {
          return result;
        }
      } else {
        throw new Error(
          `${name}: unsupported image provider`
        );
      }
    } catch (error) {
      errors.push(
        error.message
      );
    }
  }

  throw new Error(
    "Image generation failed on all providers. " +
      errors.join(" | ")
  );
}

/*
|--------------------------------------------------------------------------
| Duplicate protection
|--------------------------------------------------------------------------
*/

function promptExists(prompt) {
  const normalized =
    safeString(
      prompt,
      12000
    )
      .toLowerCase()
      .replace(/\s+/g, " ");

  return getAllPrompts().some(
    (item) =>
      safeString(
        item.prompt,
        12000
      )
        .toLowerCase()
        .replace(/\s+/g, " ") ===
      normalized
  );
}

/*
|--------------------------------------------------------------------------
| Automatic Post
|--------------------------------------------------------------------------
|
| EXACT flow:
|
| Trending API
|      ↓
| Prompt API
|      ↓
| Image API
|      ↓
| Prompt + Image together
|      ↓
| Published post
|--------------------------------------------------------------------------
*/

let autoRunning = false;

async function createAutomaticPost() {
  if (autoRunning) {
    throw new Error(
      "Automatic posting is already running."
    );
  }

  autoRunning = true;

  try {
    const trend =
      await getTrendingTopic();

    if (!trend?.title) {
      throw new Error(
        "No trending topic found."
      );
    }

    const generated =
      await generatePrompt(
        trend.title
      );

    const exactPrompt =
      generated.prompt;

    if (
      !exactPrompt ||
      exactPrompt.length < 20
    ) {
      throw new Error(
        "Generated prompt is too short."
      );
    }

    /*
     * If exact prompt already exists,
     * don't publish duplicate.
     */
    if (
      promptExists(
        exactPrompt
      )
    ) {
      throw new Error(
        "Duplicate prompt detected. Skipping this post."
      );
    }

    /*
     * IMPORTANT:
     * The exact same prompt goes to
     * the image generator.
     */
    const image =
      await generateImage(
        exactPrompt
      );

    const list =
      getAllPrompts();

    const title =
      trend.title;

    const item = {
      id:
        Date.now().toString(36) +
        crypto
          .randomBytes(5)
          .toString("hex"),

      slug:
        uniqueSlug(
          list,
          title
        ),

      title:
        safeString(
          title,
          160
        ),

      description:
        "AI-generated image prompt based on a trending topic.",

      /*
       * EXACT prompt used to generate image.
       */
      prompt:
        exactPrompt,

      media:
        "Image",

      model:
        image.model ||
        "AI Image",

      category:
        "Trending AI Image",

      imageUrl:
        image.imageUrl,

      source:
        image.provider ||
        generated.provider ||
        trend.source ||
        "AI",

      sourceUrl:
        "",

      license:
        "AI Generated",

      publishedAt:
        new Date().toISOString(),

      auto:
        true,

      trendSource:
        trend.source || "",

      promptProvider:
        generated.provider || "",

      imageProvider:
        image.provider || ""
    };

    db.addPrompt(item);

    return {
      ok: true,
      post: item
    };
  } finally {
    autoRunning = false;
  }
}

/*
|--------------------------------------------------------------------------
| Manual Run Now
|--------------------------------------------------------------------------
*/

app.post(
  "/api/admin/auto-post/run",
  requireAdmin,
  async (req, res) => {
    try {
      const result =
        await createAutomaticPost();

      res.json(result);
    } catch (error) {
      console.error(
        "AUTO POST ERROR:",
        error
      );

      res.status(500).json({
        error:
          error?.message ||
          "Automatic post failed"
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| Automatic scheduler
|--------------------------------------------------------------------------
*/

let scheduler = null;

function restartAutoPosting() {
  if (scheduler) {
    clearInterval(
      scheduler
    );

    scheduler = null;
  }

  const settings =
    db.getSettings();

  if (
    settings.autoPost === false
  ) {
    console.log(
      "Automatic posting disabled."
    );

    return;
  }

  const minutes =
    Math.min(
      1440,
      Math.max(
        1,
        Number(
          settings.postIntervalMinutes ||
            60
        )
      )
    );

  const intervalMs =
    minutes * 60 * 1000;

  console.log(
    `Automatic posting scheduled every ${minutes} minute(s).`
  );

  /*
   * Do NOT immediately post when server restarts.
   * Wait for the selected interval.
   */
  scheduler =
    setInterval(
      async () => {
        try {
          const current =
            db.getSettings();

          if (
            current.autoPost === false
          ) {
            return;
          }

          const count =
            Math.min(
              20,
              Math.max(
                1,
                Number(
                  current.postsPerRun ||
                    1
                )
              )
            );

          for (
            let i = 0;
            i < count;
            i++
          ) {
            try {
              const result =
                await createAutomaticPost();

              console.log(
                "Automatic post created:",
                result.post?.slug
              );
            } catch (error) {
              console.error(
                `Automatic post ${i + 1} failed:`,
                error.message
              );
            }
          }
        } catch (error) {
          console.error(
            "Scheduler error:",
            error
          );
        }
      },
      intervalMs
    );
}

/*
|--------------------------------------------------------------------------
| Health
|--------------------------------------------------------------------------
*/

app.get(
  "/health",
  (req, res) => {
    res.json({
      ok: true,
      service:
        "PromptForge",
      time:
        new Date().toISOString()
    });
  }
);

/*
|--------------------------------------------------------------------------
| Admin page
|--------------------------------------------------------------------------
*/

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
|--------------------------------------------------------------------------
| Prompt detail page
|--------------------------------------------------------------------------
*/

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

/*
|--------------------------------------------------------------------------
| API 404
|--------------------------------------------------------------------------
*/

app.use(
  "/api",
  (req, res) => {
    res.status(404).json({
      error: "API route not found"
    });
  }
);

/*
|--------------------------------------------------------------------------
| SPA fallback
|--------------------------------------------------------------------------
*/

app.get(
  /^(?!\/generated\/).*$/,
  (req, res) => {
    res.sendFile(
      path.join(
        PUBLIC_DIR,
        "index.html"
      )
    );
  }
);

/*
|--------------------------------------------------------------------------
| Start
|--------------------------------------------------------------------------
*/

restartAutoPosting();

app.listen(
  PORT,
  () => {
    console.log(
      `PromptForge running on port ${PORT}`
    );

    console.log(
      "3 API categories enabled:"
    );

    console.log(
      "1. Trending Search"
    );

    console.log(
      "2. Prompt Generate"
    );

    console.log(
      "3. Image / Photo Generate"
    );
  }
);
