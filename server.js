require("dotenv").config();

const express = require("express");
const session = require("express-session");
const path = require("path");
const crypto = require("crypto");

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
} = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, "public")));

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

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

/* =========================================================
   HELPERS
========================================================= */

function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) {
    return next();
  }

  return res.status(401).json({
    error: "Unauthorized"
  });
}

function clean(value, max = 20000) {
  return String(value ?? "")
    .trim()
    .slice(0, max);
}

function normalizeCategory(value) {
  const s = clean(value)
    .toLowerCase()
    .replace(/[\s/-]+/g, "_");

  if (
    s === "trending" ||
    s === "trending_search" ||
    s === "trendingsearch"
  ) {
    return "trending_search";
  }

  if (
    s === "prompt" ||
    s === "prompt_generate" ||
    s === "promptgenerate"
  ) {
    return "prompt_generate";
  }

  if (
    s === "photo" ||
    s === "image" ||
    s === "photo_generate" ||
    s === "image_generate" ||
    s === "photogenerate"
  ) {
    return "photo_generate";
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
        ""
    ),

    apiKey: clean(
      p.apiKey ||
        p.api_key ||
        p.key ||
        "",
      10000
    ),

    enabled:
      p.enabled === true ||
      p.enabled === 1 ||
      p.enabled === "true"
  };
}

async function allProviders() {
  const result = await getProviders();

  return Array.isArray(result)
    ? result.map(normalizeProvider)
    : [];
}

async function providersFor(category) {
  const wanted = normalizeCategory(category);

  const list = await allProviders();

  return list.filter(
    (p) =>
      p.category === wanted &&
      p.enabled &&
      p.apiKey &&
      p.providerName
  );
}

function providerNameMatches(name, expected) {
  return (
    clean(name).toLowerCase() ===
    expected.toLowerCase()
  );
}

function slugify(value) {
  return (
    clean(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 90) || "prompt"
  );
}

function uniqueTitle(base, existing) {
  const original =
    clean(base, 140) || "AI Prompt";

  const lower = new Set(
    existing.map((p) =>
      clean(p.title, 140).toLowerCase()
    )
  );

  if (!lower.has(original.toLowerCase())) {
    return original;
  }

  let n = 2;

  while (
    lower.has(
      `${original} ${n}`.toLowerCase()
    )
  ) {
    n++;
  }

  return `${original} ${n}`;
}

/* =========================================================
   HTTP HELPERS
========================================================= */

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal:
      options.signal ||
      AbortSignal.timeout(30000)
  });

  const text = await response.text();

  let data = null;

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

    const err = new Error(
      `${response.status} ${String(message).slice(
        0,
        500
      )}`
    );

    err.status = response.status;

    throw err;
  }

  return data;
}

async function fetchBinary(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal:
      options.signal ||
      AbortSignal.timeout(90000)
  });

  if (!response.ok) {
    const text = await response
      .text()
      .catch(() => "");

    throw new Error(
      `HTTP ${response.status}${
        text
          ? `: ${text.slice(0, 300)}`
          : ""
      }`
    );
  }

  return Buffer.from(
    await response.arrayBuffer()
  );
}

/* =========================================================
   TRENDING SEARCH
========================================================= */

async function trendingNewsData(apiKey) {
  const url =
    "https://newsdata.io/api/1/latest" +
    `?apikey=${encodeURIComponent(apiKey)}` +
    "&language=en&size=10";

  const data = await fetchJson(url);

  const articles = Array.isArray(
    data.results
  )
    ? data.results
    : [];

  return articles
    .map((x) => ({
      title: clean(x.title, 180),
      description: clean(
        x.description || x.content,
        700
      ),
      url: clean(x.link, 1000)
    }))
    .filter((x) => x.title);
}

async function trendingGNews(apiKey) {
  const url =
    "https://gnews.io/api/v4/top-headlines" +
    `?lang=en&max=10&apikey=${encodeURIComponent(
      apiKey
    )}`;

  const data = await fetchJson(url);

  const articles = Array.isArray(
    data.articles
  )
    ? data.articles
    : [];

  return articles
    .map((x) => ({
      title: clean(x.title, 180),
      description: clean(
        x.description || x.content,
        700
      ),
      url: clean(x.url, 1000)
    }))
    .filter((x) => x.title);
}

async function getTrendingTopic() {
  console.log(
    "[AUTO] Trending Search: starting"
  );

  const providers = await providersFor(
    "trending_search"
  );

  console.log(
    "[AUTO] Trending Search providers:",
    providers
      .map((p) => p.providerName)
      .join(", ") || "none"
  );

  if (!providers.length) {
    throw new Error(
      "No enabled Trending Search API provider. Check Admin → API Providers and make sure NewsData.io or GNews is Enabled."
    );
  }

  const errors = [];

  for (const provider of providers) {
    try {
      console.log(
        `[AUTO] Trending Search: trying ${provider.providerName}`
      );

      let items = [];

      if (
        providerNameMatches(
          provider.providerName,
          "NewsData.io"
        )
      ) {
        items = await trendingNewsData(
          provider.apiKey
        );
      } else if (
        providerNameMatches(
          provider.providerName,
          "GNews"
        )
      ) {
        items = await trendingGNews(
          provider.apiKey
        );
      } else {
        throw new Error(
          `Unsupported Trending Search provider: ${provider.providerName}`
        );
      }

      console.log(
        `[AUTO] Trending Search: ${provider.providerName} returned ${items.length} item(s)`
      );

      if (items.length) {
        const pick =
          items[
            Math.floor(
              Math.random() *
                Math.min(items.length, 5)
            )
          ];

        return {
          topic: pick.title,
          context: pick.description,
          sourceUrl: pick.url,
          provider: provider.providerName
        };
      }

      throw new Error(
        "Provider returned no news items"
      );
    } catch (error) {
      console.error(
        `[AUTO ERROR] Trending Search ${provider.providerName}:`,
        error.message
      );

      errors.push(
        `${provider.providerName}: ${error.message}`
      );
    }
  }

  throw new Error(
    `All Trending Search providers failed. ${errors.join(
      " | "
    )}`
  );
}

/* =========================================================
   GEMINI
========================================================= */

function extractGeminiText(data) {
  return (
    data?.candidates?.[0]?.content?.parts
      ?.map((p) => p.text || "")
      .join("\n")
      .trim() || ""
  );
}

async function generatePromptGemini(
  apiKey,
  topic
) {
  const model = "gemini-3.5-flash-lite";

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent` +
    `?key=${encodeURIComponent(apiKey)}`;

  const instruction = `
Create one high-quality AI image prompt inspired by this current topic:

Topic: ${topic.topic}

Context: ${
    topic.context ||
    "No extra context."
  }

Return ONLY valid JSON:

{
  "title": "short post title",
  "prompt": "detailed visual generation prompt"
}

The prompt must describe one original, photorealistic, editorial-quality image.

Do not include copyrighted characters, logos, watermarks, or text inside the image.
`;

  const data = await fetchJson(url, {
    method: "POST",

    headers: {
      "Content-Type": "application/json"
    },

    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            {
              text: instruction
            }
          ]
        }
      ],

      generationConfig: {
        temperature: 0.8,
        responseMimeType:
          "application/json"
      }
    })
  });

  const text =
    extractGeminiText(data);

  if (!text) {
    throw new Error(
      "Gemini returned empty text"
    );
  }

  let parsed;

  try {
    parsed = JSON.parse(text);
  } catch {
    const match =
      text.match(/\{[\s\S]*\}/);

    if (!match) {
      throw new Error(
        "Gemini did not return valid JSON"
      );
    }

    parsed = JSON.parse(
      match[0]
    );
  }

  if (!parsed.prompt) {
    throw new Error(
      "Gemini returned no prompt"
    );
  }

  return {
    title: clean(
      parsed.title || topic.topic,
      140
    ),

    prompt: clean(
      parsed.prompt,
      4000
    ),

    provider: "Gemini"
  };
}

/* =========================================================
   HUGGING FACE PROMPT
========================================================= */

async function generatePromptHF(
  apiKey,
  topic
) {
  const url =
    "https://router.huggingface.co/hf-inference/models/" +
    "Qwen/Qwen2.5-7B-Instruct";

  const instruction = `
Write a detailed AI image prompt for this current topic:

"${topic.topic}"

Return only the image prompt.
No explanation.
`;

  const data = await fetchJson(url, {
    method: "POST",

    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },

    body: JSON.stringify({
      inputs: instruction,

      parameters: {
        max_new_tokens: 300,
        temperature: 0.8
      }
    })
  });

  const text = Array.isArray(data)
    ? data[0]?.generated_text
    : data?.generated_text;

  if (!text) {
    throw new Error(
      "Hugging Face returned no generated text"
    );
  }

  return {
    title: clean(
      topic.topic,
      140
    ),

    prompt: clean(
      String(text)
        .replace(instruction, "")
        .trim(),
      4000
    ),

    provider: "Hugging Face"
  };
}

/* =========================================================
   PROMPT GENERATION
========================================================= */

async function generatePrompt(topic) {
  console.log(
    `[AUTO] Prompt Generate: starting for topic "${clean(
      topic?.topic,
      140
    )}"`
  );

  const providers =
    await providersFor(
      "prompt_generate"
    );

  console.log(
    "[AUTO] Prompt Generate providers:",
    providers
      .map((p) => p.providerName)
      .join(", ") || "none"
  );

  if (!providers.length) {
    throw new Error(
      "No enabled Prompt Generate API provider."
    );
  }

  const errors = [];

  for (const provider of providers) {
    try {
      console.log(
        `[AUTO] Prompt Generate: trying ${provider.providerName}`
      );

      if (
        providerNameMatches(
          provider.providerName,
          "Gemini"
        )
      ) {
        return await generatePromptGemini(
          provider.apiKey,
          topic
        );
      }

      if (
        providerNameMatches(
          provider.providerName,
          "Hugging Face"
        )
      ) {
        return await generatePromptHF(
          provider.apiKey,
          topic
        );
      }

      throw new Error(
        `Unsupported Prompt Generate provider: ${provider.providerName}`
      );
    } catch (error) {
      console.error(
        `[AUTO ERROR] Prompt Generate ${provider.providerName}:`,
        error.message
      );

      errors.push(
        `${provider.providerName}: ${error.message}`
      );
    }
  }

  throw new Error(
    `All Prompt Generate providers failed. ${errors.join(
      " | "
    )}`
  );
}

/* =========================================================
   IMAGE GENERATION - HUGGING FACE
========================================================= */

async function generateImageHF(
  apiKey,
  prompt
) {
  const url =
    "https://router.huggingface.co/hf-inference/models/" +
    "black-forest-labs/FLUX.1-schnell";

  return await fetchBinary(url, {
    method: "POST",

    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },

    body: JSON.stringify({
      inputs: prompt
    })
  });
}

/* =========================================================
   IMAGE GENERATION - POLLINATIONS
========================================================= */

async function generateImagePollinations(
  apiKey,
  prompt
) {
  const url =
    "https://gen.pollinations.ai/image/" +
    encodeURIComponent(prompt) +
    "?model=flux&width=1024&height=1024&nologo=true";

  return await fetchBinary(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`
    }
  });
}

/* =========================================================
   IMAGE GENERATION
========================================================= */

async function generateImage(prompt) {
  console.log(
    "[AUTO] Image Generate: starting"
  );

  const providers =
    await providersFor(
      "photo_generate"
    );

  console.log(
    "[AUTO] Image Generate providers:",
    providers
      .map((p) => p.providerName)
      .join(", ") || "none"
  );

  if (!providers.length) {
    throw new Error(
      "No enabled Photo Generate API provider."
    );
  }

  const errors = [];

  for (const provider of providers) {
    try {
      console.log(
        `[AUTO] Image Generate: trying ${provider.providerName}`
      );

      let buffer;

      if (
        providerNameMatches(
          provider.providerName,
          "Hugging Face"
        )
      ) {
        buffer =
          await generateImageHF(
            provider.apiKey,
            prompt
          );
      } else if (
        providerNameMatches(
          provider.providerName,
          "Pollinations"
        )
      ) {
        buffer =
          await generateImagePollinations(
            provider.apiKey,
            prompt
          );
      } else {
        throw new Error(
          `Unsupported Photo Generate provider: ${provider.providerName}`
        );
      }

      if (
        !buffer ||
        buffer.length < 1000
      ) {
        throw new Error(
          "Image response was empty"
        );
      }

      console.log(
        `[AUTO] Image Generate: ${provider.providerName} succeeded (${buffer.length} bytes)`
      );

      return {
        buffer,
        provider:
          provider.providerName
      };
    } catch (error) {
      console.error(
        `[AUTO ERROR] Image Generate ${provider.providerName}:`,
        error.message
      );

      errors.push(
        `${provider.providerName}: ${error.message}`
      );
    }
  }

  throw new Error(
    `All Photo Generate providers failed. ${errors.join(
      " | "
    )}`
  );
}

/* =========================================================
   CLOUDINARY
========================================================= */

async function uploadToCloudinary(
  buffer,
  publicId
) {
  if (
    !process.env.CLOUDINARY_CLOUD_NAME ||
    !process.env.CLOUDINARY_API_KEY ||
    !process.env.CLOUDINARY_API_SECRET
  ) {
    throw new Error(
      "Cloudinary environment variables are missing."
    );
  }

  const cloudinary =
    require("cloudinary").v2;

  cloudinary.config({
    cloud_name:
      process.env
        .CLOUDINARY_CLOUD_NAME,

    api_key:
      process.env
        .CLOUDINARY_API_KEY,

    api_secret:
      process.env
        .CLOUDINARY_API_SECRET
  });

  console.log(
    "[AUTO] Cloudinary: uploading generated image"
  );

  return new Promise(
    (resolve, reject) => {
      const stream =
        cloudinary.uploader.upload_stream(
          {
            folder:
              "promptforge",

            public_id:
              publicId,

            resource_type:
              "image",

            overwrite: false
          },

          (error, result) => {
            if (error) {
              console.error(
                "[AUTO ERROR] Cloudinary upload:",
                error.message
              );

              return reject(error);
            }

            console.log(
              `[AUTO] Cloudinary: upload succeeded (${
                result?.public_id ||
                "no public id"
              })`
            );

            resolve(result);
          }
        );

      stream.end(buffer);
    }
  );
}

/* =========================================================
   PUBLISH
========================================================= */

function makeSlug(title) {
  return (
    slugify(title) +
    "-" +
    crypto
      .randomBytes(3)
      .toString("hex")
  );
}

async function publishGenerated(
  topic,
  generated,
  image,
  imageProvider
) {
  console.log(
    `[AUTO] Publish: preparing "${clean(
      generated?.title ||
        topic?.topic,
      140
    )}"`
  );

  const existing =
    await getPrompts();

  const items =
    Array.isArray(existing)
      ? existing
      : [];

  const title = uniqueTitle(
    generated.title,
    items
  );

  const duplicate =
    items.some(
      (p) =>
        clean(
          p.prompt,
          4000
        ).toLowerCase() ===
        clean(
          generated.prompt,
          4000
        ).toLowerCase()
    );

  if (duplicate) {
    console.log(
      "[AUTO] Publish: skipped duplicate prompt"
    );

    return {
      skipped: true,
      reason:
        "Duplicate prompt"
    };
  }

  const slug =
    makeSlug(title);

  const upload =
    await uploadToCloudinary(
      image.buffer,
      slug
    );

  const item =
    await addPrompt({
      id:
        crypto.randomUUID(),

      slug,

      title,

      prompt:
        generated.prompt,

      category:
        "Trending",

      media:
        "Image",

      imageUrl:
        upload.secure_url,

      model:
        imageProvider,

      source:
        topic.provider ||
        "Automatic",

      sourceUrl:
        topic.sourceUrl ||
        "",

      description:
        topic.context ||
        "",

      auto:
        true,

      trendSource:
        topic.topic,

      promptProvider:
        generated.provider,

      imageProvider,

      cloudinaryPublicId:
        upload.public_id,

      publishedAt:
        new Date().toISOString()
    });

  console.log(
    `[AUTO] Publish: Supabase insert succeeded for "${title}"`
  );

  return {
    skipped: false,
    item,

    cloudinaryUrl:
      upload.secure_url
  };
}

/* =========================================================
   AUTOMATIC POSTING PIPELINE
========================================================= */

async function runAutomaticPosting() {
  console.log(
    "[AUTO] Run started"
  );

  const settings =
    await getSettings();

  console.log(
    `[AUTO] Settings: enabled=${!!settings?.autoPost}, postsPerRun=${
      settings?.postsPerRun || 1
    }`
  );

  if (!settings?.autoPost) {
    console.log(
      "[AUTO] Automatic posting is disabled"
    );

    return {
      ok: true,
      added: 0,

      reason:
        "Automatic posting is disabled."
    };
  }

  const postsPerRun =
    Math.max(
      1,
      Math.min(
        10,
        Number(
          settings.postsPerRun ||
            1
        )
      )
    );

  const results = [];

  for (
    let i = 0;
    i < postsPerRun;
    i++
  ) {
    try {
      console.log(
        `[AUTO] Post ${
          i + 1
        }/${postsPerRun}: pipeline started`
      );

      /* TRENDING */

      const topic =
        await getTrendingTopic();

      console.log(
        `[AUTO] Post ${
          i + 1
        }: topic selected from ${
          topic.provider
        }: "${clean(
          topic.topic,
          140
        )}"`
      );

      /* PROMPT */

      const generated =
        await generatePrompt(
          topic
        );

      console.log(
        `[AUTO] Post ${
          i + 1
        }: prompt generated by ${
          generated.provider
        }`
      );

      /* IMAGE */

      const image =
        await generateImage(
          generated.prompt
        );

      console.log(
        `[AUTO] Post ${
          i + 1
        }: image generated by ${
          image.provider
        }`
      );

      /* PUBLISH */

      const published =
        await publishGenerated(
          topic,
          generated,
          image,
          image.provider
        );

      results.push({
        ok: true,

        topic:
          topic.topic,

        promptProvider:
          generated.provider,

        imageProvider:
          image.provider,

        published
      });
    } catch (error) {
      console.error(
        `[AUTO ERROR] Post ${
          i + 1
        }/${postsPerRun}:`,
        error.message
      );

      results.push({
        ok: false,
        error:
          error.message
      });
    }
  }

  const summary = {
    ok: results.some(
      (x) => x.ok
    ),

    added:
      results.filter(
        (x) =>
          x.ok &&
          !x.published?.skipped
      ).length,

    results
  };

  console.log(
    "[AUTO] Run finished:",
    JSON.stringify(summary)
  );

  return summary;
}

/* =========================================================
   PUBLIC API
========================================================= */

app.get(
  "/api/prompts",
  async (req, res) => {
    try {
      const items =
        await getPrompts();

      const q =
        clean(
          req.query.q
        ).toLowerCase();

      let result =
        Array.isArray(items)
          ? items
          : [];

      if (q) {
        result =
          result.filter(
            (p) =>
              [
                p.title,
                p.prompt,
                p.category,
                p.model
              ]
                .join(" ")
                .toLowerCase()
                .includes(q)
          );
      }

      res.json(result);
    } catch (error) {
      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

app.get(
  "/api/prompts/:slug",
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
              "Not found"
          });
      }

      res.json(item);
    } catch (error) {
      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

app.get(
  "/api/public/settings",
  async (req, res) => {
    try {
      const s =
        await getSettings();

      res.json({
        copyGateSeconds:
          Number(
            s?.copyGateSeconds ||
              10
          ),

        directLink:
          clean(
            s?.directLink ||
              ""
          )
      });
    } catch (error) {
      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   AUTHENTICATION
========================================================= */

app.post(
  "/api/login",
  (req, res) => {
    if (!ADMIN_PASSWORD) {
      return res
        .status(503)
        .json({
          error:
            "ADMIN_PASSWORD is not configured."
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
          ""
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
          "Invalid username or password."
      });
  }
);

app.post(
  "/api/logout",
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
  "/api/admin/me",
  (req, res) => {
    res.json({
      authenticated:
        !!req.session?.admin
    });
  }
);

/* =========================================================
   ADMIN PROMPTS
========================================================= */

app.get(
  "/api/admin/prompts",
  requireAdmin,
  async (req, res) => {
    try {
      res.json(
        await getPrompts()
      );
    } catch (error) {
      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

app.post(
  "/api/admin/prompts",
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
              "Title and prompt are required."
          });
      }

      const item =
        await addPrompt({
          title:
            clean(
              b.title,
              140
            ),

          prompt:
            clean(
              b.prompt,
              4000
            ),

          model:
            clean(
              b.model,
              140
            ) || "Any",

          category:
            clean(
              b.category,
              100
            ) || "General",

          media:
            clean(
              b.media,
              40
            ) || "Image",

          imageUrl:
            clean(
              b.imageUrl,
              2000
            ),

          source:
            "Manual",

          auto:
            false,

          publishedAt:
            new Date().toISOString()
        });

      res.json(item);
    } catch (error) {
      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

app.delete(
  "/api/admin/prompts/:id",
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
      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   ADMIN PROVIDERS
========================================================= */

app.get(
  "/api/admin/providers",
  requireAdmin,
  async (req, res) => {
    try {
      res.json(
        await allProviders()
      );
    } catch (error) {
      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

app.post(
  "/api/admin/providers",
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
          120
        );

      const apiKey =
        clean(
          b.apiKey ||
            b.api_key ||
            b.key,
          10000
        );

      if (
        ![
          "trending_search",
          "prompt_generate",
          "photo_generate"
        ].includes(
          category
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              "Invalid provider category."
          });
      }

      if (
        !providerName ||
        !apiKey
      ) {
        return res
          .status(400)
          .json({
            error:
              "Provider name and API key are required."
          });
      }

      const item =
        await addProvider({
          category,

          providerName,

          provider_name:
            providerName,

          apiKey,

          api_key:
            apiKey,

          enabled:
            b.enabled !== false
        });

      res.json(
        normalizeProvider(item)
      );
    } catch (error) {
      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

app.delete(
  "/api/admin/providers/:id",
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
      res.status(500).json({
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
  "/api/admin/settings",
  requireAdmin,
  async (req, res) => {
    try {
      res.json(
        await getSettings()
      );
    } catch (error) {
      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

app.post(
  "/api/admin/settings",
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
            : !!current?.autoPost,

        postIntervalMinutes:
          Math.max(
            1,
            Number(
              b.postIntervalMinutes ??
                b.interval ??
                current?.postIntervalMinutes ??
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
                  current?.postsPerRun ??
                  1
              )
            )
          ),

        copyGateSeconds:
          Math.max(
            0,
            Number(
              b.copyGateSeconds ??
                current?.copyGateSeconds ??
                10
            )
          ),

        directLink:
          clean(
            b.directLink ??
              current?.directLink ??
              ""
          )
      };

      const saved =
        await saveSettings(
          next
        );

      res.json(
        saved || next
      );
    } catch (error) {
      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   MANUAL RUN NOW
========================================================= */

app.post(
  "/api/admin/collect",
  requireAdmin,
  async (req, res) => {
    console.log(
      "[AUTO] Manual Run now requested"
    );

    try {
      const result =
        await runAutomaticPosting();

      console.log(
        `[AUTO] Manual Run now finished: added=${
          result.added || 0
        }, ok=${!!result.ok}`
      );

      res.json(result);
    } catch (error) {
      console.error(
        "[AUTO ERROR] Manual Run now failed:",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error.message
      });
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
      res.set(
        "Cache-Control",
        "no-store"
      );

      res.json(
        (await getAds()) || {}
      );
    } catch (error) {
      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

app.get(
  "/api/admin/ads",
  requireAdmin,
  async (req, res) => {
    try {
      res.json(
        (await getAds()) || {}
      );
    } catch (error) {
      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

app.post(
  "/api/admin/ads",
  requireAdmin,
  async (req, res) => {
    try {
      const saved =
        await saveAds(
          req.body || {}
        );

      res.json(
        saved ||
          req.body ||
          {}
      );
    } catch (error) {
      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   AUTO SCHEDULER
========================================================= */

let autoTimer = null;
let autoRunning = false;

async function startScheduler() {
  if (autoTimer) {
    clearInterval(autoTimer);
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
            "[AUTO] Previous automatic run is still running."
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
            "[AUTO] Scheduled run started."
          );

          const result =
            await runAutomaticPosting();

          console.log(
            "Automatic posting result:",
            JSON.stringify(
              result
            )
          );
        } catch (error) {
          console.error(
            "Automatic posting error:",
            error.message
          );
        } finally {
          autoRunning =
            false;
        }
      },
      minutes * 60 * 1000
    );
}

/* =========================================================
   ROUTES
========================================================= */

app.get(
  "/admin",
  requireAdmin,
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

app.use(
  "/api",
  (req, res) => {
    res.status(404).json({
      error: "Not found"
    });
  }
);

app.get(
  "*splat",
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

/* =========================================================
   BOOT
========================================================= */

async function boot() {
  try {
    console.log(
      "Database: Supabase PostgreSQL"
    );

    const providers =
      await allProviders();

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
      `Configured providers: ${providers.length}`
    );

    console.log(
      "[BOOT] Providers:",
      providers
        .map(
          (p) =>
            `${p.category}:${p.providerName}:${
              p.enabled
                ? "enabled"
                : "disabled"
            }`
        )
        .join(", ") ||
        "none"
    );

    if (
      process.env
        .CLOUDINARY_CLOUD_NAME &&
      process.env
        .CLOUDINARY_API_KEY &&
      process.env
        .CLOUDINARY_API_SECRET
    ) {
      console.log(
        "Cloudinary storage enabled."
      );
    } else {
      console.warn(
        "Cloudinary environment variables are missing."
      );
    }

    await startScheduler();

    app.listen(
      PORT,
      () => {
        console.log(
          `PromptForge running on port ${PORT}`
        );
      }
    );
  } catch (error) {
    console.error(
      "Startup error:",
      error
    );

    app.listen(
      PORT,
      () => {
        console.log(
          `PromptForge running on port ${PORT} (startup warning)`
        );
      }
    );
  }
}

boot();
