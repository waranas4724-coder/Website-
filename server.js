require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const path = require("path");

const db = require("./db");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");

/*
|--------------------------------------------------------------------------
| Cloudinary
|--------------------------------------------------------------------------
*/

let cloudinary = null;

if (
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
) {
  const { v2 } = require("cloudinary");

  v2.config({
    cloud_name:
      process.env.CLOUDINARY_CLOUD_NAME,
    api_key:
      process.env.CLOUDINARY_API_KEY,
    api_secret:
      process.env.CLOUDINARY_API_SECRET
  });

  cloudinary = v2;

  console.log(
    "Cloudinary storage enabled."
  );
} else {
  console.warn(
    "Cloudinary environment variables are missing."
  );
}

app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(
  express.json({
    limit: "2mb"
  })
);

app.use(
  express.urlencoded({
    extended: true
  })
);

app.use(
  express.static(PUBLIC_DIR)
);


/*
|--------------------------------------------------------------------------
| Helpers
|--------------------------------------------------------------------------
*/

function safeString(
  value,
  max = 5000
) {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, max);
}

function slugify(value) {
  return safeString(
    value,
    200
  )
    .toLowerCase()
    .replace(
      /[^a-z0-9]+/g,
      "-"
    )
    .replace(
      /^-+|-+$/g,
      ""
    )
    .slice(0, 90);
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(
    String(value || "")
  );
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
    1000
  );
}

function enabled(provider) {
  return (
    provider?.enabled !== false
  );
}

function normalizeCategory(value) {
  const v = String(value || "")
    .toLowerCase()
    .replace(
      /[_-]+/g,
      " "
    )
    .trim();

  if (
    v.includes("prompt") ||
    v.includes("text")
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

async function getProviders(
  category
) {
  const all =
    await db.getApiProviders();

  return all.filter(
    (provider) =>
      enabled(provider) &&
      normalizeCategory(
        provider.category
      ) === category &&
      providerKey(provider)
  );
}

function isProvider(
  name,
  ...names
) {
  const n =
    String(name || "")
      .toLowerCase();

  return names.some(
    (x) =>
      n.includes(
        String(x).toLowerCase()
      )
  );
}

function uniqueSlug(
  list,
  title
) {
  const base =
    slugify(title) ||
    "prompt";

  let slug = base;
  let n = 2;

  const used = new Set(
    list.map(
      (x) => x.slug
    )
  );

  while (used.has(slug)) {
    slug =
      `${base}-${n++}`;
  }

  return slug;
}


/*
|--------------------------------------------------------------------------
| Admin authentication
|--------------------------------------------------------------------------
*/

const ADMIN_USERNAME =
  process.env.ADMIN_USERNAME ||
  process.env.ADMIN_USER ||
  "admin";

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD ||
  "admin123";

const ADMIN_COOKIE =
  "pf_admin";

const ADMIN_SECRET =
  process.env.SESSION_SECRET ||
  process.env.ADMIN_SECRET ||
  crypto
    .randomBytes(32)
    .toString("hex");

const adminTokens =
  new Set();

function makeAdminToken() {
  const raw =
    crypto
      .randomBytes(32)
      .toString("hex");

  const sig =
    crypto
      .createHmac(
        "sha256",
        ADMIN_SECRET
      )
      .update(raw)
      .digest("hex");

  return `${raw}.${sig}`;
}

function validAdminToken(
  token
) {
  if (!token) {
    return false;
  }

  if (
    !adminTokens.has(token)
  ) {
    return false;
  }

  const parts =
    token.split(".");

  if (
    parts.length !== 2
  ) {
    return false;
  }

  const expected =
    crypto
      .createHmac(
        "sha256",
        ADMIN_SECRET
      )
      .update(parts[0])
      .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(
        parts[1]
      ),
      Buffer.from(
        expected
      )
    );
  } catch {
    return false;
  }
}

function getCookie(
  req,
  name
) {
  const header =
    req.headers.cookie || "";

  const parts =
    header
      .split(";")
      .map(
        (x) => x.trim()
      );

  for (
    const part of parts
  ) {
    const index =
      part.indexOf("=");

    if (index === -1) {
      continue;
    }

    const key =
      part.slice(
        0,
        index
      );

    const value =
      part.slice(
        index + 1
      );

    if (key === name) {
      return decodeURIComponent(
        value
      );
    }
  }

  return "";
}

function setAdminCookie(
  res,
  token
) {
  res.setHeader(
    "Set-Cookie",
    `${ADMIN_COOKIE}=${encodeURIComponent(
      token
    )}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=28800`
  );
}

function clearAdminCookie(
  res
) {
  res.setHeader(
    "Set-Cookie",
    `${ADMIN_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
  );
}

function requireAdmin(
  req,
  res,
  next
) {
  const token =
    getCookie(
      req,
      ADMIN_COOKIE
    );

  if (
    !validAdminToken(token)
  ) {
    return res
      .status(401)
      .json({
        error:
          "Unauthorized"
      });
  }

  next();
}


/*
|--------------------------------------------------------------------------
| Public prompts
|--------------------------------------------------------------------------
*/

app.get(
  "/api/prompts",
  async (req, res) => {
    try {
      let list =
        await db.getPrompts();

      const search =
        safeString(
          req.query.q,
          200
        ).toLowerCase();

      const media =
        safeString(
          req.query.media,
          50
        ).toLowerCase();

      const category =
        safeString(
          req.query.category,
          100
        ).toLowerCase();

      if (search) {
        list =
          list.filter(
            (p) =>
              [
                p.title,
                p.prompt,
                p.category,
                p.model,
                p.source
              ]
                .join(" ")
                .toLowerCase()
                .includes(
                  search
                )
          );
      }

      if (
        media &&
        media !== "all"
      ) {
        list =
          list.filter(
            (p) =>
              String(
                p.media || ""
              ).toLowerCase() ===
              media
          );
      }

      if (
        category &&
        category !== "all"
      ) {
        list =
          list.filter(
            (p) =>
              String(
                p.category || ""
              ).toLowerCase() ===
              category
          );
      }

      res.json(list);
    } catch (error) {
      console.error(
        "GET prompts:",
        error
      );

      res.status(500).json({
        error:
          "Failed to load prompts"
      });
    }
  }
);

app.get(
  "/api/prompts/:slug",
  async (req, res) => {
    try {
      const list =
        await db.getPrompts();

      const item =
        list.find(
          (p) =>
            p.slug ===
            req.params.slug
        );

      if (!item) {
        return res
          .status(404)
          .json({
            error:
              "Prompt not found"
          });
      }

      res.json(item);
    } catch (error) {
      console.error(
        "GET prompt:",
        error
      );

      res.status(500).json({
        error:
          "Failed to load prompt"
      });
    }
  }
);

app.get(
  "/api/categories",
  async (req, res) => {
    try {
      const list =
        await db.getPrompts();

      const result = {};

      for (
        const item of list
      ) {
        const category =
          item.category ||
          "General";

        result[category] =
          (result[category] ||
            0) + 1;
      }

      res.json(result);
    } catch (error) {
      res.status(500).json({
        error:
          "Failed to load categories"
      });
    }
  }
);


/*
|--------------------------------------------------------------------------
| Public settings
|--------------------------------------------------------------------------
*/

app.get(
  "/api/public/settings",
  async (req, res) => {
    try {
      const settings =
        await db.getSettings();

      res.json({
        copyGateSeconds:
          Number(
            settings.copyGateSeconds ||
              10
          ),

        directLink:
          settings.directLink ||
          ""
      });
    } catch (error) {
      res.status(500).json({
        error:
          "Failed to load settings"
      });
    }
  }
);


/*
|--------------------------------------------------------------------------
| Public Ads
|--------------------------------------------------------------------------
*/

app.get(
  "/api/ads",
  async (req, res) => {
    try {
      res.set(
        "Cache-Control",
        "no-store"
      );

      const ads =
        await db.getAds();

      res.json(
        ads || {}
      );
    } catch (error) {
      res.status(500).json({
        error:
          "Failed to load ads"
      });
    }
  }
);


/*
|--------------------------------------------------------------------------
| Login
|--------------------------------------------------------------------------
*/

app.post(
  "/api/login",
  (req, res) => {
    const username =
      safeString(
        req.body?.username,
        120
      );

    const password =
      String(
        req.body?.password ||
          ""
      );

    if (
      username !==
        ADMIN_USERNAME ||
      password !==
        ADMIN_PASSWORD
    ) {
      return res
        .status(401)
        .json({
          error:
            "Invalid credentials"
        });
    }

    const token =
      makeAdminToken();

    adminTokens.add(
      token
    );

    setAdminCookie(
      res,
      token
    );

    res.json({
      ok: true
    });
  }
);

app.post(
  "/api/logout",
  (req, res) => {
    const token =
      getCookie(
        req,
        ADMIN_COOKIE
      );

    if (token) {
      adminTokens.delete(
        token
      );
    }

    clearAdminCookie(
      res
    );

    res.json({
      ok: true
    });
  }
);

app.get(
  "/api/admin/me",
  (req, res) => {
    const token =
      getCookie(
        req,
        ADMIN_COOKIE
      );

    res.json({
      authenticated:
        validAdminToken(
          token
        )
    });
  }
);


/*
|--------------------------------------------------------------------------
| Admin prompts
|--------------------------------------------------------------------------
*/

app.get(
  "/api/admin/prompts",
  requireAdmin,
  async (req, res) => {
    try {
      res.json(
        await db.getPrompts()
      );
    } catch (error) {
      res.status(500).json({
        error:
          "Failed to load prompts"
      });
    }
  }
);

app.post(
  "/api/admin/prompts",
  requireAdmin,
  async (req, res) => {
    try {
      const body =
        req.body || {};

      if (
        !body.title ||
        !body.prompt
      ) {
        return res
          .status(400)
          .json({
            error:
              "Title and prompt are required"
          });
      }

      const list =
        await db.getPrompts();

      const item = {
        id:
          Date.now()
            .toString(36) +
          crypto
            .randomBytes(4)
            .toString("hex"),

        slug:
          uniqueSlug(
            list,
            body.title
          ),

        title:
          safeString(
            body.title,
            160
          ),

        prompt:
          safeString(
            body.prompt,
            12000
          ),

        media:
          "Image",

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
          isHttpUrl(
            body.imageUrl
          )
            ? body.imageUrl
            : "",

        source:
          safeString(
            body.source,
            150
          ) || "Original",

        publishedAt:
          new Date()
            .toISOString(),

        auto: false
      };

      const saved =
        await db.addPrompt(
          item
        );

      res.json(saved);
    } catch (error) {
      console.error(
        "ADD PROMPT:",
        error
      );

      res.status(500).json({
        error:
          error.message ||
          "Failed to publish prompt"
      });
    }
  }
);

app.put(
  "/api/admin/prompts/:id",
  requireAdmin,
  async (req, res) => {
    try {
      const updated =
        await db.updatePrompt(
          req.params.id,
          req.body || {}
        );

      if (!updated) {
        return res
          .status(404)
          .json({
            error:
              "Prompt not found"
          });
      }

      res.json(updated);
    } catch (error) {
      res.status(500).json({
        error:
          error.message ||
          "Failed to update prompt"
      });
    }
  }
);

app.delete(
  "/api/admin/prompts/:id",
  requireAdmin,
  async (req, res) => {
    try {
      await db.deletePrompt(
        req.params.id
      );

      res.json({
        ok: true
      });
    } catch (error) {
      res.status(500).json({
        error:
          error.message ||
          "Failed to delete prompt"
      });
    }
  }
);


/*
|--------------------------------------------------------------------------
| API Providers
|--------------------------------------------------------------------------
*/

app.get(
  "/api/admin/providers",
  requireAdmin,
  async (req, res) => {
    try {
      const providers =
        await db.getApiProviders();

      res.json(
        providers.map(
          (p) => ({
            id: p.id,

            category:
              p.category,

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
          })
        )
      );
    } catch (error) {
      res.status(500).json({
        error:
          "Failed to load API providers"
      });
    }
  }
);

app.post(
  "/api/admin/providers",
  requireAdmin,
  async (req, res) => {
    try {
      const body =
        req.body || {};

      const category =
        normalizeCategory(
          body.category
        );

      const allowed = [
        "trending_search",
        "prompt_generate",
        "photo_generate"
      ];

      if (
        !allowed.includes(
          category
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              "Invalid API category"
          });
      }

      const apiKey =
        providerKey(body);

      const name =
        providerName(body);

      if (
        !name ||
        !apiKey
      ) {
        return res
          .status(400)
          .json({
            error:
              "Provider name and API key are required"
          });
      }

      const item =
        await db.addApiProvider({
          category,

          providerName:
            name,

          apiKey,

          enabled: true
        });

      res.json({
        id: item.id,

        category:
          item.category,

        providerName:
          item.providerName,

        enabled: true,

        hasKey: true
      });
    } catch (error) {
      res.status(500).json({
        error:
          error.message ||
          "Failed to add API provider"
      });
    }
  }
);

app.put(
  "/api/admin/providers/:id",
  requireAdmin,
  async (req, res) => {
    try {
      const body =
        req.body || {};

      const update = {};

      if (
        body.category
      ) {
        update.category =
          normalizeCategory(
            body.category
          );
      }

      if (
        body.providerName
      ) {
        update.providerName =
          providerName(body);
      }

      if (
        body.apiKey &&
        !String(
          body.apiKey
        ).includes("••")
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
        await db.updateApiProvider(
          req.params.id,
          update
        );

      if (!result) {
        return res
          .status(404)
          .json({
            error:
              "Provider not found"
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
          !!providerKey(
            result
          )
      });
    } catch (error) {
      res.status(500).json({
        error:
          error.message ||
          "Failed to update provider"
      });
    }
  }
);

app.delete(
  "/api/admin/providers/:id",
  requireAdmin,
  async (req, res) => {
    try {
      await db.deleteApiProvider(
        req.params.id
      );

      res.json({
        ok: true
      });
    } catch (error) {
      res.status(500).json({
        error:
          error.message ||
          "Failed to delete provider"
      });
    }
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
  async (req, res) => {
    try {
      res.json(
        await db.getSettings()
      );
    } catch (error) {
      res.status(500).json({
        error:
          "Failed to load settings"
      });
    }
  }
);

app.put(
  "/api/admin/settings",
  requireAdmin,
  async (req, res) => {
    try {
      const old =
        await db.getSettings();

      const body =
        req.body || {};

      const next = {
        ...old,

        autoPost:
          body.autoPost !==
          undefined
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

      await db.updateSettings(
        next
      );

      restartAutoPosting();

      res.json(next);
    } catch (error) {
      res.status(500).json({
        error:
          error.message ||
          "Failed to update settings"
      });
    }
  }
);


/*
|--------------------------------------------------------------------------
| Ads
|--------------------------------------------------------------------------
*/

app.get(
  "/api/admin/ads",
  requireAdmin,
  async (req, res) => {
    try {
      res.json(
        await db.getAds()
      );
    } catch (error) {
      res.status(500).json({
        error:
          "Failed to load ads"
      });
    }
  }
);

app.put(
  "/api/admin/ads",
  requireAdmin,
  async (req, res) => {
    try {
      const result =
        await db.updateAds(
          req.body || {}
        );

      res.json(result);
    } catch (error) {
      res.status(500).json({
        error:
          error.message ||
          "Failed to update ads"
      });
    }
  }
);


/*
|--------------------------------------------------------------------------
| Trending Search
|--------------------------------------------------------------------------
*/

async function fetchNewsData(
  provider
) {
  const key =
    providerKey(provider);

  const response =
    await fetch(
      "https://newsdata.io/api/1/latest" +
        `?apikey=${encodeURIComponent(
          key
        )}` +
        "&language=en&size=10",
      {
        headers: {
          Accept:
            "application/json"
        },

        signal:
          AbortSignal.timeout(
            20000
          )
      }
    );

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
    .filter(
      (x) => x.title
    );
}

async function fetchGNews(
  provider
) {
  const key =
    providerKey(provider);

  const response =
    await fetch(
      "https://gnews.io/api/v4/top-headlines" +
        `?token=${encodeURIComponent(
          key
        )}` +
        "&lang=en&max=10",
      {
        headers: {
          Accept:
            "application/json"
        },

        signal:
          AbortSignal.timeout(
            20000
          )
      }
    );

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
    .filter(
      (x) => x.title
    );
}

async function fetchGoogleNewsRSS() {
  const response =
    await fetch(
      "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en",
      {
        headers: {
          "User-Agent":
            "PromptForge/2.0"
        },

        signal:
          AbortSignal.timeout(
            20000
          )
      }
    );

  if (!response.ok) {
    throw new Error(
      `Google News RSS: HTTP ${response.status}`
    );
  }

  const xml =
    await response.text();

  const results = [];

  const matches =
    [
      ...xml.matchAll(
        /<item>([\s\S]*?)<\/item>/gi
      )
    ];

  for (
    const match of matches
  ) {
    const block =
      match[1];

    const title =
      block.match(
        /<title>([\s\S]*?)<\/title>/i
      );

    if (!title) {
      continue;
    }

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
    await getProviders(
      "trending_search"
    );

  const errors = [];

  for (
    const provider of providers
  ) {
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

      if (
        results.length
      ) {
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

    if (
      results.length
    ) {
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
              role:
                "system",

              content:
                "You are a professional AI image prompt writer. Return only one detailed English image-generation prompt. Do not add explanations, headings, markdown or quotation marks."
            },

            {
              role:
                "user",

              content:
                `Create a premium, highly detailed AI image-generation prompt based on this trending topic:

${topic}

Include:
- main subject
- composition
- environment
- cinematic lighting
- realistic textures
- professional photography
- atmospheric depth
- sharp details
- premium color grading

Return only the final prompt.`
            }
          ],

          temperature:
            0.9,

          max_tokens:
            900
        }),

        signal:
          AbortSignal.timeout(
            45000
          )
      }
    );

  if (!response.ok) {
    const text =
      await response.text();

    throw new Error(
      `${providerName(
        provider
      )}: HTTP ${response.status} ${text.slice(
        0,
        500
      )}`
    );
  }

  const json =
    await response.json();

  const content =
    json?.choices?.[0]
      ?.message
      ?.content;

  if (!content) {
    throw new Error(
      `${providerName(
        provider
      )}: empty response`
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
    await getProviders(
      "prompt_generate"
    );

  if (!providers.length) {
    throw new Error(
      "No Prompt Generate API is configured."
    );
  }

  const errors = [];

  for (
    const provider of providers
  ) {
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
    await fetch(
      endpoint,
      {
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
          inputs:
            prompt,

          parameters: {
            width: 1024,
            height: 1024
          }
        }),

        signal:
          AbortSignal.timeout(
            180000
          )
      }
    );

  if (!response.ok) {
    const text =
      await response.text();

    throw new Error(
      `${providerName(
        provider
      )}: HTTP ${response.status} ${text.slice(
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
      )}: empty image`
    );
  }

  return {
    buffer,

    provider:
      providerName(
        provider
      ),

    model
  };
}


/*
|--------------------------------------------------------------------------
| Cloudinary Upload
|--------------------------------------------------------------------------
*/

async function uploadToCloudinary(
  buffer
) {
  if (!cloudinary) {
    throw new Error(
      "Cloudinary is not configured."
    );
  }

  return new Promise(
    (
      resolve,
      reject
    ) => {
      const upload =
        cloudinary.uploader.upload_stream(
          {
            folder:
              "promptforge",

            resource_type:
              "image"
          },

          (
            error,
            result
          ) => {
            if (error) {
              return reject(
                error
              );
            }

            resolve(
              result
            );
          }
        );

      upload.end(buffer);
    }
  );
}

async function generateImage(
  prompt
) {
  const providers =
    await getProviders(
      "photo_generate"
    );

  if (!providers.length) {
    throw new Error(
      "No Image / Photo Generate API is configured."
    );
  }

  const errors = [];

  for (
    const provider of providers
  ) {
    try {
      const name =
        providerName(
          provider
        );

      let result;

      if (
        isProvider(
          name,
          "huggingface",
          "hugging face",
          "hf"
        )
      ) {
        result =
          await generateImageWithHF(
            provider,
            prompt
          );
      } else {
        throw new Error(
          `${name}: unsupported image provider`
        );
      }

      if (
        !result?.buffer
      ) {
        throw new Error(
          `${name}: image buffer missing`
        );
      }

      /*
       * Image goes to Cloudinary.
       */
      const uploaded =
        await uploadToCloudinary(
          result.buffer
        );

      if (
        !uploaded?.secure_url
      ) {
        throw new Error(
          `${name}: Cloudinary upload failed`
        );
      }

      return {
        imageUrl:
          uploaded.secure_url,

        provider:
          result.provider,

        model:
          result.model,

        cloudinaryPublicId:
          uploaded.public_id
      };
    } catch (error) {
      errors.push(
        error.message
      );

      console.error(
        `Image provider failed: ${providerName(
          provider
        )}`,
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

function normalizePrompt(
  prompt
) {
  return safeString(
    prompt,
    12000
  )
    .toLowerCase()
    .replace(
      /\s+/g,
      " "
    );
}

async function promptExists(
  prompt
) {
  const normalized =
    normalizePrompt(
      prompt
    );

  const list =
    await db.getPrompts();

  return list.some(
    (item) =>
      normalizePrompt(
        item.prompt
      ) === normalized
  );
}


/*
|--------------------------------------------------------------------------
| Automatic Post
|--------------------------------------------------------------------------
*/

let autoRunning =
  false;

async function createAutomaticPost() {
  if (autoRunning) {
    throw new Error(
      "Automatic posting is already running."
    );
  }

  autoRunning = true;

  try {
    /*
     * 1. Trending
     */
    const trend =
      await getTrendingTopic();

    if (!trend?.title) {
      throw new Error(
        "No trending topic found."
      );
    }

    /*
     * 2. Prompt
     */
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
     * 3. Duplicate check
     */
    if (
      await promptExists(
        exactPrompt
      )
    ) {
      throw new Error(
        "Duplicate prompt detected. Post skipped."
      );
    }

    /*
     * 4. Image
     *
     * EXACT same prompt is sent
     * to the image generator.
     */
    const image =
      await generateImage(
        exactPrompt
      );

    /*
     * 5. Publish
     */
    const list =
      await db.getPrompts();

    const title =
      trend.title;

    const item = {
      id:
        Date.now()
          .toString(36) +
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

      prompt:
        exactPrompt,

      media:
        "Image",

      imageUrl:
        image.imageUrl,

      model:
        image.model ||
        "AI Image",

      category:
        "Trending AI Image",

      source:
        image.provider ||
        generated.provider ||
        trend.source ||
        "AI",

      publishedAt:
        new Date()
          .toISOString(),

      auto: true,

      trendSource:
        trend.source ||
        "",

      promptProvider:
        generated.provider ||
        "",

      imageProvider:
        image.provider ||
        "",

      cloudinaryPublicId:
        image.cloudinaryPublicId ||
        ""
    };

    const saved =
      await db.addPrompt(
        item
      );

    return {
      ok: true,
      post: saved
    };
  } finally {
    autoRunning =
      false;
  }
}


/*
|--------------------------------------------------------------------------
| Manual Run
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
| Automatic Scheduler
|--------------------------------------------------------------------------
*/

let scheduler =
  null;

function restartAutoPosting() {
  if (scheduler) {
    clearInterval(
      scheduler
    );

    scheduler =
      null;
  }

  db.getSettings()
    .then(
      (settings) => {
        if (
          settings.autoPost ===
          false
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
          minutes *
          60 *
          1000;

        console.log(
          `Automatic posting scheduled every ${minutes} minute(s).`
        );

        scheduler =
          setInterval(
            async () => {
              try {
                const current =
                  await db.getSettings();

                if (
                  current.autoPost ===
                  false
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
                  } catch (
                    error
                  ) {
                    console.error(
                      `Automatic post ${
                        i + 1
                      } failed:`,
                      error.message
                    );
                  }
                }
              } catch (
                error
              ) {
                console.error(
                  "Scheduler error:",
                  error
                );
              }
            },
            intervalMs
          );
      }
    )
    .catch(
      (error) => {
        console.error(
          "Scheduler setup failed:",
          error
        );
      }
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

      database:
        "Supabase PostgreSQL",

      cloudinary:
        !!cloudinary,

      time:
        new Date()
          .toISOString()
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
| Prompt detail
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
    res
      .status(404)
      .json({
        error:
          "API route not found"
      });
  }
);


/*
|--------------------------------------------------------------------------
| SPA fallback
|--------------------------------------------------------------------------
*/

app.get(
  /^(?!\/api\/).*/,
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

    console.log(
      `Database: Supabase PostgreSQL`
    );

    console.log(
      `Cloudinary: ${
        cloudinary
          ? "enabled"
          : "disabled"
      }`
    );
  }
);
