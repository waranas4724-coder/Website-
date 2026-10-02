require("dotenv").config();

const express = require("express");
const session = require("express-session");
const crypto = require("crypto");
const path = require("path");
const db = require("./db");

let cloudinary = null;

if (
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
) {
  cloudinary = require("cloudinary").v2;

  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });

  console.log("Cloudinary storage enabled.");
} else {
  console.warn(
    "Cloudinary is not configured. Generated images cannot be permanently stored."
  );
}

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");

app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

app.use(
  session({
    secret:
      process.env.SESSION_SECRET ||
      crypto.randomBytes(32).toString("hex"),
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

const admin = (req, res, next) => {
  if (req.session?.admin) return next();
  return res.status(401).json({ error: "Unauthorized" });
};

const safeUrl = (value) =>
  /^https?:\/\//i.test(String(value || "")) ? String(value) : "";

const slugify = (value) =>
  String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);

const mediaOf = (value) =>
  /video|film|clip|motion/i.test(String(value || ""))
    ? "Video"
    : "Image";

function uniqueSlug(list, title) {
  const base = slugify(title) || `prompt-${Date.now()}`;

  let slug = base;
  let n = 2;

  while (list.some((p) => p.slug === slug)) {
    slug = `${base}-${n++}`;
  }

  return slug;
}

function makePrompt(input, auto = false, existing = []) {
  const title = String(
    input.title || "Untitled Prompt"
  )
    .trim()
    .slice(0, 140);

  const prompt = String(input.prompt || "")
    .trim()
    .slice(0, 8000);

  return {
    id: input.id || undefined,

    slug:
      input.slug ||
      uniqueSlug(existing, title),

    title,

    prompt,

    category: String(
      input.category || "General"
    )
      .trim()
      .slice(0, 80),

    media: mediaOf(
      input.media ||
        input.imageUrl ||
        "Image"
    ),

    imageUrl: safeUrl(
      input.imageUrl ||
        input.image_url
    ),

    model: String(
      input.model || "Any"
    ).slice(0, 120),

    source: String(
      input.source ||
        (auto
          ? "Automatic"
          : "PromptForge Original")
    ).slice(0, 160),

    license: String(
      input.license || "CC0-1.0"
    ).slice(0, 80),

    sourceUrl: safeUrl(
      input.sourceUrl ||
        input.source_url
    ),

    publishedAt:
      input.publishedAt ||
      new Date().toISOString(),

    auto: !!auto
  };
}

function queryPrompts(list, q) {
  const search = String(
    q.q || ""
  )
    .toLowerCase()
    .trim();

  const media = String(
    q.media || "all"
  ).toLowerCase();

  const category = String(
    q.category || "all"
  ).toLowerCase();

  const license = String(
    q.license || ""
  ).toLowerCase();

  return [...list]
    .filter((p) => {
      const haystack = [
        p.title,
        p.prompt,
        p.model,
        p.category,
        p.source
      ]
        .join(" ")
        .toLowerCase();

      return (
        (!search ||
          haystack.includes(search)) &&
        (media === "all" ||
          String(p.media || "").toLowerCase() ===
            media) &&
        (category === "all" ||
          String(p.category || "").toLowerCase() ===
            category) &&
        (!license ||
          String(p.license || "").toLowerCase() ===
            license)
      );
    })
    .sort(
      (a, b) =>
        new Date(
          b.publishedAt ||
            b.createdAt ||
            0
        ) -
        new Date(
          a.publishedAt ||
            a.createdAt ||
            0
        )
    );
}


/* =========================================================
   PUBLIC PROMPT API
========================================================= */

app.use("/api/v1", (req, res, next) => {
  res.set(
    "Access-Control-Allow-Origin",
    "*"
  );

  next();
});

app.get("/api/v1/prompts", async (req, res) => {
  try {
    const all = queryPrompts(
      await db.getPrompts(),
      req.query
    );

    const limit = Math.min(
      100,
      Math.max(
        1,
        Number(req.query.limit) || 20
      )
    );

    const page = Math.max(
      1,
      Number(req.query.page) || 1
    );

    const start =
      (page - 1) * limit;

    res.json({
      data: all.slice(
        start,
        start + limit
      ),

      meta: {
        total: all.length,
        page,
        limit,
        pages: Math.ceil(
          all.length / limit
        )
      }
    });
  } catch (e) {
    res.status(500).json({
      error: e.message
    });
  }
});

app.get(
  "/api/v1/prompts/:slug",
  async (req, res) => {
    try {
      const p = (
        await db.getPrompts()
      ).find(
        (x) =>
          x.slug === req.params.slug
      );

      p
        ? res.json(p)
        : res.status(404).json({
            error: "Not found"
          });
    } catch (e) {
      res.status(500).json({
        error: e.message
      });
    }
  }
);

app.get(
  "/api/v1/categories",
  async (req, res) => {
    try {
      const counts = {};

      (
        await db.getPrompts()
      ).forEach((p) => {
        counts[p.category] =
          (counts[p.category] || 0) +
          1;
      });

      res.json(counts);
    } catch (e) {
      res.status(500).json({
        error: e.message
      });
    }
  }
);

app.get(
  "/api/prompts",
  async (req, res) => {
    try {
      res.json(
        queryPrompts(
          await db.getPrompts(),
          req.query
        )
      );
    } catch (e) {
      res.status(500).json({
        error: e.message
      });
    }
  }
);

app.get(
  "/api/prompts/:slug",
  async (req, res) => {
    try {
      const p = (
        await db.getPrompts()
      ).find(
        (x) =>
          x.slug === req.params.slug
      );

      p
        ? res.json(p)
        : res.status(404).json({
            error: "Not found"
          });
    } catch (e) {
      res.status(500).json({
        error: e.message
      });
    }
  }
);

app.get(
  "/api/public/settings",
  async (req, res) => {
    try {
      const s =
        await db.getSettings();

      res.json({
        copyGateSeconds: Number(
          s.copyGateSeconds || 10
        ),

        directLink: safeUrl(
          s.directLink || ""
        )
      });
    } catch (e) {
      res.status(500).json({
        error: e.message
      });
    }
  }
);


/* =========================================================
   AUTHENTICATION
========================================================= */

const hash = (value) =>
  crypto
    .createHash("sha256")
    .update(String(value))
    .digest();

const safeEqual = (a, b) =>
  crypto.timingSafeEqual(
    hash(a),
    hash(b)
  );

const loginFails = new Map();

app.post("/api/login", (req, res) => {
  const password =
    process.env.ADMIN_PASSWORD;

  if (!password) {
    return res.status(503).json({
      error:
        "ADMIN_PASSWORD is not configured."
    });
  }

  const ip =
    req.ip || "unknown";

  const state =
    loginFails.get(ip) || {
      count: 0,
      time: 0
    };

  if (
    state.count >= 5 &&
    Date.now() - state.time <
      15 * 60 * 1000
  ) {
    return res.status(429).json({
      error:
        "Too many attempts. Try again later."
    });
  }

  const username =
    req.body?.username || "";

  const suppliedPassword =
    req.body?.password || "";

  const expectedUsername =
    process.env.ADMIN_USERNAME ||
    "admin";

  if (
    safeEqual(
      username,
      expectedUsername
    ) &&
    safeEqual(
      suppliedPassword,
      password
    )
  ) {
    loginFails.delete(ip);

    req.session.admin = true;

    return res.json({
      ok: true
    });
  }

  loginFails.set(ip, {
    count: state.count + 1,
    time: Date.now()
  });

  return res.status(401).json({
    error:
      "Invalid username or password."
  });
});

app.post(
  "/api/logout",
  (req, res) =>
    req.session.destroy(() =>
      res.json({ ok: true })
    )
);

app.get(
  "/api/admin/me",
  (req, res) =>
    res.json({
      authenticated:
        !!req.session?.admin
    })
);


/* =========================================================
   ADMIN PROMPTS
========================================================= */

app.get(
  "/api/admin/prompts",
  admin,
  async (req, res) => {
    try {
      res.json(
        await db.getPrompts()
      );
    } catch (e) {
      res.status(500).json({
        error: e.message
      });
    }
  }
);

app.post(
  "/api/admin/prompts",
  admin,
  async (req, res) => {
    try {
      if (
        !req.body?.title ||
        !req.body?.prompt
      ) {
        return res.status(400).json({
          error:
            "Title and prompt are required."
        });
      }

      const existing =
        await db.getPrompts();

      const item = makePrompt(
        req.body,
        false,
        existing
      );

      const saved =
        await db.addPrompt(item);

      res.json(saved);
    } catch (e) {
      res.status(500).json({
        error: e.message
      });
    }
  }
);

app.delete(
  "/api/admin/prompts/:id",
  admin,
  async (req, res) => {
    try {
      res.json(
        await db.deletePrompt(
          req.params.id
        )
      );
    } catch (e) {
      res.status(500).json({
        error: e.message
      });
    }
  }
);


/* =========================================================
   ADMIN SETTINGS
========================================================= */

app.get(
  "/api/admin/settings",
  admin,
  async (req, res) => {
    try {
      res.json(
        await db.getSettings()
      );
    } catch (e) {
      res.status(500).json({
        error: e.message
      });
    }
  }
);

app.post(
  "/api/admin/settings",
  admin,
  async (req, res) => {
    try {
      const current =
        await db.getSettings();

      const b =
        req.body || {};

      const next = {
        ...current,

        autoPost:
          b.autoPost !== undefined
            ? !!b.autoPost
            : current.autoPost,

        autoPostEnabled:
          b.autoPostEnabled !== undefined
            ? !!b.autoPostEnabled
            : current.autoPostEnabled,

        postIntervalMinutes:
          Math.max(
            5,
            Number(
              b.postIntervalMinutes ||
                current.postIntervalMinutes ||
                60
            )
          ),

        postsPerRun:
          Math.max(
            1,
            Math.min(
              20,
              Number(
                b.postsPerRun ||
                  current.postsPerRun ||
                  1
              )
            )
          ),

        copyGateSeconds:
          Math.max(
            0,
            Math.min(
              300,
              Number(
                b.copyGateSeconds ??
                  current.copyGateSeconds ??
                  10
              )
            )
          ),

        directLink: safeUrl(
          b.directLink !== undefined
            ? b.directLink
            : current.directLink
        )
      };

      const saved =
        await db.saveSettings(next);

      restartAutoPoster();

      res.json(saved);
    } catch (e) {
      res.status(500).json({
        error: e.message
      });
    }
  }
);


/* =========================================================
   ADMIN API PROVIDERS
========================================================= */

const PROVIDER_CATEGORIES = [
  "trending_search",
  "prompt_generate",
  "photo_generate"
];

function normalizeProvider(p) {
  return {
    ...p,

    category: String(
      p.category || ""
    ).trim(),

    provider_name: String(
      p.provider_name ||
        p.providerName ||
        p.name ||
        ""
    ).trim(),

    api_key: String(
      p.api_key ||
        p.apiKey ||
        ""
    ).trim(),

    enabled:
      p.enabled !== false
  };
}

app.get(
  "/api/admin/providers",
  admin,
  async (req, res) => {
    try {
      res.json(
        await db.getApiProviders()
      );
    } catch (e) {
      res.status(500).json({
        error: e.message
      });
    }
  }
);

app.get(
  "/api/admin/api-providers",
  admin,
  async (req, res) => {
    try {
      res.json(
        await db.getApiProviders()
      );
    } catch (e) {
      res.status(500).json({
        error: e.message
      });
    }
  }
);

app.post(
  "/api/admin/providers",
  admin,
  async (req, res) => {
    try {
      const p =
        normalizeProvider(
          req.body || {}
        );

      if (
        !PROVIDER_CATEGORIES.includes(
          p.category
        )
      ) {
        return res.status(400).json({
          error:
            "Invalid API category."
        });
      }

      if (
        !p.provider_name ||
        !p.api_key
      ) {
        return res.status(400).json({
          error:
            "Provider name and API key are required."
        });
      }

      res.json(
        await db.addApiProvider(p)
      );
    } catch (e) {
      res.status(500).json({
        error: e.message
      });
    }
  }
);

app.post(
  "/api/admin/api-providers",
  admin,
  async (req, res) => {
    try {
      const p =
        normalizeProvider(
          req.body || {}
        );

      if (
        !PROVIDER_CATEGORIES.includes(
          p.category
        )
      ) {
        return res.status(400).json({
          error:
            "Invalid API category."
        });
      }

      if (
        !p.provider_name ||
        !p.api_key
      ) {
        return res.status(400).json({
          error:
            "Provider name and API key are required."
        });
      }

      res.json(
        await db.addApiProvider(p)
      );
    } catch (e) {
      res.status(500).json({
        error: e.message
      });
    }
  }
);

app.patch(
  "/api/admin/providers/:id",
  admin,
  async (req, res) => {
    try {
      res.json(
        await db.updateApiProvider(
          req.params.id,
          normalizeProvider(
            req.body || {}
          )
        )
      );
    } catch (e) {
      res.status(500).json({
        error: e.message
      });
    }
  }
);

app.delete(
  "/api/admin/providers/:id",
  admin,
  async (req, res) => {
    try {
      res.json(
        await db.deleteApiProvider(
          req.params.id
        )
      );
    } catch (e) {
      res.status(500).json({
        error: e.message
      });
    }
  }
);


/* =========================================================
   PROVIDER HELPERS
========================================================= */

async function enabledProviders(
  category
) {
  const providers =
    await db.getApiProviders();

  return providers.filter(
    (p) =>
      p.enabled !== false &&
      p.category === category &&
      p.api_key
  );
}

async function jsonFetch(
  url,
  options = {},
  timeout = 25000
) {
  const response = await fetch(
    url,
    {
      ...options,
      signal:
        AbortSignal.timeout(
          timeout
        )
    }
  );

  const text =
    await response.text();

  let data = null;

  try {
    data = text
      ? JSON.parse(text)
      : {};
  } catch {
    data = {
      raw: text
    };
  }

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}`
    );
  }

  return data;
}


/* =========================================================
   TRENDING SEARCH
========================================================= */

async function searchTrending(
  provider,
  topic
) {
  const name =
    provider.provider_name.toLowerCase();

  const key =
    encodeURIComponent(
      provider.api_key
    );

  const q =
    encodeURIComponent(
      topic ||
        "AI photography OR technology OR design"
    );

  if (
    name.includes("newsdata")
  ) {
    const data =
      await jsonFetch(
        `https://newsdata.io/api/1/latest?apikey=${key}&q=${q}&language=en`,
        {},
        20000
      );

    return (
      data.results || []
    ).map((x) => ({
      title:
        x.title ||
        x.description ||
        "Trending topic",

      description:
        x.description ||
        x.content ||
        "",

      url:
        x.link ||
        x.source_url ||
        "",

      source:
        x.source_name ||
        "NewsData.io"
    }));
  }

  if (
    name.includes("gnews")
  ) {
    const data =
      await jsonFetch(
        `https://gnews.io/api/v4/search?q=${q}&lang=en&max=10&apikey=${key}`,
        {},
        20000
      );

    return (
      data.articles || []
    ).map((x) => ({
      title:
        x.title ||
        "Trending topic",

      description:
        x.description ||
        x.content ||
        "",

      url:
        x.url ||
        "",

      source:
        x.source?.name ||
        "GNews"
    }));
  }

  throw new Error(
    `Unsupported trending provider: ${provider.provider_name}`
  );
}


/* =========================================================
   PROMPT GENERATION
========================================================= */

async function generatePrompt(
  provider,
  trend
) {
  const name =
    provider.provider_name.toLowerCase();

  const instruction = `
Create one high-quality AI image-generation prompt based on this current topic.

Topic: ${trend.title}

Context:
${trend.description || ""}

Rules:
Return ONLY the image prompt.
No markdown.
No explanation.
Make it detailed, visual, cinematic, realistic, professional, and suitable for publishing on a prompt website.
`;

  if (
    name.includes("gemini")
  ) {
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${encodeURIComponent(
        provider.api_key
      )}`;

    const data =
      await jsonFetch(
        url,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    text: instruction
                  }
                ]
              }
            ]
          })
        },
        30000
      );

    const text =
      data?.candidates?.[0]?.content?.parts
        ?.map(
          (p) => p.text || ""
        )
        .join(" ")
        .trim();

    if (!text) {
      throw new Error(
        "Gemini returned no prompt"
      );
    }

    return text;
  }

  if (
    name.includes(
      "huggingface"
    ) ||
    name.includes(
      "hugging face"
    )
  ) {
    const model =
      process.env.HF_TEXT_MODEL ||
      "HuggingFaceTB/SmolLM3-3B";

    const data =
      await jsonFetch(
        `https://router.huggingface.co/hf-inference/models/${encodeURIComponent(
          model
        )}`,
        {
          method: "POST",

          headers: {
            Authorization:
              `Bearer ${provider.api_key}`,

            "Content-Type":
              "application/json"
          },

          body: JSON.stringify({
            inputs: instruction,

            parameters: {
              max_new_tokens: 220,
              return_full_text:
                false
            }
          })
        },
        45000
      );

    const text =
      Array.isArray(data)
        ? data[0]?.generated_text
        : data?.generated_text;

    if (!text) {
      throw new Error(
        "Hugging Face returned no prompt"
      );
    }

    return String(text).trim();
  }

  throw new Error(
    `Unsupported prompt provider: ${provider.provider_name}`
  );
}


/* =========================================================
   IMAGE GENERATION
========================================================= */

async function generateImage(
  provider,
  prompt
) {
  const name =
    provider.provider_name.toLowerCase();

  if (
    name.includes(
      "huggingface"
    ) ||
    name.includes(
      "hugging face"
    )
  ) {
    const model =
      process.env.HF_IMAGE_MODEL ||
      "black-forest-labs/FLUX.1-schnell";

    const response =
      await fetch(
        `https://router.huggingface.co/hf-inference/models/${encodeURIComponent(
          model
        )}`,
        {
          method: "POST",

          headers: {
            Authorization:
              `Bearer ${provider.api_key}`,

            "Content-Type":
              "application/json",

            Accept:
              "image/png"
          },

          body: JSON.stringify({
            inputs: prompt
          }),

          signal:
            AbortSignal.timeout(
              90000
            )
        }
      );

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    const buffer =
      Buffer.from(
        await response.arrayBuffer()
      );

    if (!buffer.length) {
      throw new Error(
        "Image provider returned empty image"
      );
    }

    return buffer;
  }

  if (
    name.includes(
      "pollinations"
    )
  ) {
    const encoded =
      encodeURIComponent(prompt);

    const response =
      await fetch(
        `https://gen.pollinations.ai/image/${encoded}`,
        {
          headers: {
            Authorization:
              `Bearer ${provider.api_key}`
          },

          signal:
            AbortSignal.timeout(
              90000
            )
        }
      );

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    return Buffer.from(
      await response.arrayBuffer()
    );
  }

  throw new Error(
    `Unsupported image provider: ${provider.provider_name}`
  );
}


/* =========================================================
   CLOUDINARY
========================================================= */

async function uploadImage(
  buffer
) {
  if (!cloudinary) {
    throw new Error(
      "Cloudinary is not configured."
    );
  }

  return new Promise(
    (resolve, reject) => {
      const stream =
        cloudinary.uploader.upload_stream(
          {
            folder:
              process.env.CLOUDINARY_FOLDER ||
              "promptforge",

            resource_type:
              "image"
          },

          (error, result) =>
            error
              ? reject(error)
              : resolve(result)
        );

      stream.end(buffer);
    }
  );
}


/* =========================================================
   AUTOMATIC POSTING
========================================================= */

async function automaticPost() {
  const settings =
    await db.getSettings();

  const enabled =
    settings.autoPost !== undefined
      ? settings.autoPost
      : settings.autoPostEnabled;

  if (!enabled) {
    return {
      added: 0,
      reason: "disabled"
    };
  }

  const trending =
    await enabledProviders(
      "trending_search"
    );

  const prompts =
    await enabledProviders(
      "prompt_generate"
    );

  const photos =
    await enabledProviders(
      "photo_generate"
    );

  if (!trending.length) {
    throw new Error(
      "No enabled Trending Search API provider."
    );
  }

  if (!prompts.length) {
    throw new Error(
      "No enabled Prompt Generate API provider."
    );
  }

  if (!photos.length) {
    throw new Error(
      "No enabled Photo Generate API provider."
    );
  }

  let trends = [];
  const trendErrors = [];

  for (const p of trending) {
    try {
      trends =
        await searchTrending(
          p,
          "AI photography technology design"
        );

      if (trends.length)
        break;
    } catch (e) {
      trendErrors.push(
        `${p.provider_name}: ${e.message}`
      );
    }
  }

  if (!trends.length) {
    throw new Error(
      `Trending Search failed. ${trendErrors.join(
        " | "
      )}`
    );
  }

  const existing =
    await db.getPrompts();

  const usedPrompts =
    new Set(
      existing.map((p) =>
        String(
          p.prompt || ""
        )
          .trim()
          .toLowerCase()
      )
    );

  const usedTitles =
    new Set(
      existing.map((p) =>
        String(
          p.title || ""
        )
          .trim()
          .toLowerCase()
      )
    );

  const target =
    Math.max(
      1,
      Math.min(
        20,
        Number(
          settings.postsPerRun || 1
        )
      )
    );

  let added = 0;
  const errors = [];

  for (const trend of trends) {
    if (added >= target)
      break;

    try {
      let generatedPrompt = "";
      let promptProvider = null;

      for (const p of prompts) {
        try {
          generatedPrompt =
            await generatePrompt(
              p,
              trend
            );

          promptProvider =
            p.provider_name;

          if (generatedPrompt)
            break;
        } catch (e) {
          errors.push(
            `${p.provider_name}: ${e.message}`
          );
        }
      }

      if (!generatedPrompt) {
        throw new Error(
          "All prompt providers failed."
        );
      }

      if (
        usedPrompts.has(
          generatedPrompt.toLowerCase()
        )
      ) {
        continue;
      }

      let imageBuffer = null;
      let imageProvider = null;

      for (const p of photos) {
        try {
          imageBuffer =
            await generateImage(
              p,
              generatedPrompt
            );

          imageProvider =
            p.provider_name;

          if (imageBuffer)
            break;
        } catch (e) {
          errors.push(
            `${p.provider_name}: ${e.message}`
          );
        }
      }

      if (!imageBuffer) {
        throw new Error(
          "All image providers failed."
        );
      }

      const uploaded =
        await uploadImage(
          imageBuffer
        );

      const titleBase =
        trend.title ||
        "AI Generated Prompt";

      let title =
        titleBase.slice(
          0,
          140
        );

      if (
        usedTitles.has(
          title.toLowerCase()
        )
      ) {
        title =
          `${titleBase.slice(
            0,
            125
          )} AI`.slice(
            0,
            140
          );
      }

      const item =
        makePrompt(
          {
            title,

            prompt:
              generatedPrompt,

            media:
              "Image",

            imageUrl:
              uploaded.secure_url,

            model:
              imageProvider ||
              "AI Image",

            category:
              "Trending",

            source:
              trend.source ||
              "Automatic",

            sourceUrl:
              trend.url,

            license:
              "AI-generated"
          },

          true,

          existing
        );

      item.promptProvider =
        promptProvider;

      item.imageProvider =
        imageProvider;

      item.trendSource =
        trend.source ||
        "Automatic";

      item.auto = true;

      await db.addPrompt(
        item
      );

      existing.push(item);

      usedPrompts.add(
        generatedPrompt.toLowerCase()
      );

      usedTitles.add(
        title.toLowerCase()
      );

      added++;
    } catch (e) {
      errors.push(
        e.message
      );
    }
  }

  return {
    added,
    errors
  };
}


/* =========================================================
   AUTO POST TIMER
========================================================= */

let autoTimer = null;
let autoBusy = false;

function restartAutoPoster() {
  if (autoTimer) {
    clearInterval(autoTimer);
  }

  autoTimer = null;

  db.getSettings()
    .then((settings) => {
      const enabled =
        settings.autoPost !== undefined
          ? settings.autoPost
          : settings.autoPostEnabled;

      if (!enabled)
        return;

      const minutes =
        Math.max(
          5,
          Number(
            settings.postIntervalMinutes ||
              60
          )
        );

      console.log(
        `Automatic posting scheduled every ${minutes} minute(s).`
      );

      autoTimer =
        setInterval(() => {
          if (autoBusy)
            return;

          autoBusy = true;

          automaticPost()
            .then((r) =>
              console.log(
                "Automatic posting:",
                r
              )
            )
            .catch((e) =>
              console.error(
                "Automatic posting:",
                e.message
              )
            )
            .finally(() => {
              autoBusy = false;
            });
        }, minutes * 60 * 1000);
    })
    .catch((e) =>
      console.error(
        "Auto poster setup:",
        e.message
      )
    );
}

app.post(
  "/api/admin/collect",
  admin,
  async (req, res) => {
    if (autoBusy) {
      return res.status(409).json({
        error:
          "Automatic posting is already running."
      });
    }

    autoBusy = true;

    try {
      res.json(
        await automaticPost()
      );
    } catch (e) {
      res.status(500).json({
        error: e.message
      });
    } finally {
      autoBusy = false;
    }
  }
);


/* =========================================================
   ADS
========================================================= */

app.get(
  "/api/ads",
  async (req, res) => {
    try {
      res
        .set(
          "Cache-Control",
          "no-store"
        )
        .json(
          await db.getAds()
        );
    } catch (e) {
      res.status(500).json({
        error: e.message
      });
    }
  }
);

app.get(
  "/api/admin/ads",
  admin,
  async (req, res) => {
    try {
      res.json(
        await db.getAds()
      );
    } catch (e) {
      res.status(500).json({
        error: e.message
      });
    }
  }
);

app.post(
  "/api/admin/ads",
  admin,
  async (req, res) => {
    try {
      res.json(
        await db.saveAds(
          req.body || {}
        )
      );
    } catch (e) {
      res.status(500).json({
        error: e.message
      });
    }
  }
);


/* =========================================================
   RSS FEED
========================================================= */

function escapeXml(s) {
  return String(s || "")
    .replace(
      /[<>&'"]/g,
      (c) =>
        ({
          "<": "&lt;",
          ">": "&gt;",
          "&": "&amp;",
          "'": "&apos;",
          '"': "&quot;"
        }[c])
    );
}

function baseUrl(req) {
  return (
    process.env.SITE_URL ||
    `${req.protocol}://${req.get(
      "host"
    )}`
  ).replace(/\/$/, "");
}

app.get(
  "/rss.xml",
  async (req, res) => {
    const items =
      queryPrompts(
        await db.getPrompts(),
        {}
      ).slice(0, 50);

    const base =
      baseUrl(req);

    res
      .type("application/rss+xml")
      .send(
        `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>PromptForge</title>
<link>${escapeXml(
          base
        )}</link>
${items
  .map(
    (p) =>
      `<item>
<title>${escapeXml(
        p.title
      )}</title>
<link>${escapeXml(
        `${base}/p/${p.slug}`
      )}</link>
<guid>${escapeXml(
        `${base}/p/${p.slug}`
      )}</guid>
<pubDate>${new Date(
        p.publishedAt ||
          Date.now()
      ).toUTCString()}</pubDate>
<description>${escapeXml(
        p.prompt
      )}</description>
</item>`
  )
  .join("")}
</channel>
</rss>`
      );
  }
);


/* =========================================================
   FRIENDLY ROUTES
========================================================= */

app.get(
  "/admin",
  (req, res) =>
    res.sendFile(
      path.join(
        PUBLIC_DIR,
        "admin.html"
      )
    )
);

app.use(
  "/api",
  (req, res) =>
    res.status(404).json({
      error: "Not found"
    })
);

app.get(
  "/p/:slug",
  (req, res) =>
    res.sendFile(
      path.join(
        PUBLIC_DIR,
        "index.html"
      )
    )
);

app.get(
  /.*/,
  (req, res) =>
    res.sendFile(
      path.join(
        PUBLIC_DIR,
        "index.html"
      )
  )
);


/* =========================================================
   START SERVER
========================================================= */

(async () => {
  try {
    await db.getSettings();

    console.log(
      "Database: Supabase PostgreSQL"
    );

    console.log(
      `3 API categories enabled:
1. Trending Search
2. Prompt Generate
3. Image / Photo Generate`
    );

    if (cloudinary) {
      console.log(
        "Cloudinary: enabled"
      );
    }

    restartAutoPoster();

    app.listen(
      PORT,
      () =>
        console.log(
          `PromptForge running on port ${PORT}`
        )
    );
  } catch (e) {
    console.error(
      "Startup failed:",
      e
    );

    process.exit(1);
  }
})();
