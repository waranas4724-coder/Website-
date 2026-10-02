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
const PORT = Number(process.env.PORT || 3000);

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.use(
  session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
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

const CREATIVE_CATEGORIES = [
  "Portrait Photography",
  "Fashion",
  "Brand Design",
  "Commercial Photography",
  "Product Photography",
  "Architecture",
  "Travel",
  "Editorial",
  "Cinematic",
  "Nature",
  "Automotive",
  "Food Photography",
  "Graphic Design",
  "Interior Design",
  "Fantasy Art",
  "Minimalist Art"
];

const CREATIVE_SEEDS = [
  "cinematic urban photography",
  "luxury fashion editorial",
  "minimal product campaign",
  "futuristic architecture",
  "quiet travel moment",
  "surreal nature photography",
  "premium automotive campaign",
  "editorial portrait",
  "modern brand identity",
  "experimental poster design",
  "moody interior photography",
  "creative food photography",
  "dreamlike landscape",
  "street photography after rain",
  "high-end beauty campaign",
  "retro-futuristic composition",
  "minimal black and white portrait",
  "Japanese-inspired visual design",
  "luxury watch campaign",
  "cinematic cafe scene"
];

function clean(value, max = 20000) {
  return String(value ?? "").trim().slice(0, max);
}

function requireAdmin(req, res, next) {
  if (req.session?.admin) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

function normalizeCategory(value) {
  const s = clean(value).toLowerCase().replace(/[\s/-]+/g, "_");
  if (["trending", "trending_search", "trendingsearch"].includes(s)) return "trending_search";
  if (["prompt", "prompt_generate", "promptgenerate"].includes(s)) return "prompt_generate";
  if (["photo", "image", "photo_generate", "image_generate", "photogenerate"].includes(s)) return "photo_generate";
  return s;
}

function normalizeProvider(p) {
  return {
    ...p,
    id: p.id,
    category: normalizeCategory(p.category || p.type || p.provider_category),
    providerName: clean(p.providerName || p.provider_name || p.name || p.provider || ""),
    apiKey: clean(p.apiKey || p.api_key || p.key || "", 10000),
    enabled: p.enabled === true || p.enabled === 1 || p.enabled === "true"
  };
}

async function allProviders() {
  const result = await getProviders();
  return Array.isArray(result) ? result.map(normalizeProvider) : [];
}

async function providersFor(category) {
  const wanted = normalizeCategory(category);
  return (await allProviders()).filter(
    p => p.category === wanted && p.enabled && p.apiKey && p.providerName
  );
}

function providerNameMatches(name, expected) {
  return clean(name).toLowerCase() === expected.toLowerCase();
}

function slugify(value) {
  return (
    clean(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 90) || "ai-prompt"
  );
}

function makeSlug(title) {
  return `${slugify(title)}-${crypto.randomBytes(3).toString("hex")}`;
}

function uniqueTitle(base, existing) {
  const original = clean(base, 140) || "AI Visual";
  const lower = new Set(
    existing.map(p => clean(p.title, 140).toLowerCase())
  );
  if (!lower.has(original.toLowerCase())) return original;
  let n = 2;
  while (lower.has(`${original} ${n}`.toLowerCase())) n++;
  return `${original} ${n}`;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal || AbortSignal.timeout(45000)
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const message =
      data?.error?.message ||
      data?.message ||
      data?.error ||
      `HTTP ${response.status}`;
    const err = new Error(`${response.status} ${String(message).slice(0, 600)}`);
    err.status = response.status;
    throw err;
  }
  return data;
}

async function fetchBinary(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal || AbortSignal.timeout(120000)
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 400)}` : ""}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/* =========================================================
   TREND SIGNAL
   News APIs are used only as optional trend signals.
   They are never published as news posts.
========================================================= */

async function trendingNewsData(apiKey) {
  const url =
    "https://newsdata.io/api/1/latest" +
    `?apikey=${encodeURIComponent(apiKey)}&language=en&size=10`;

  const data = await fetchJson(url);
  return (Array.isArray(data.results) ? data.results : [])
    .map(x => ({
      title: clean(x.title, 180),
      description: clean(x.description || x.content, 600)
    }))
    .filter(x => x.title);
}

async function trendingGNews(apiKey) {
  const url =
    "https://gnews.io/api/v4/top-headlines" +
    `?lang=en&max=10&apikey=${encodeURIComponent(apiKey)}`;

  const data = await fetchJson(url);
  return (Array.isArray(data.articles) ? data.articles : [])
    .map(x => ({
      title: clean(x.title, 180),
      description: clean(x.description || x.content, 600)
    }))
    .filter(x => x.title);
}

async function getTrendSignal() {
  const providers = await providersFor("trending_search");
  const errors = [];

  for (const provider of providers) {
    try {
      let items = [];
      if (providerNameMatches(provider.providerName, "NewsData.io")) {
        items = await trendingNewsData(provider.apiKey);
      } else if (providerNameMatches(provider.providerName, "GNews")) {
        items = await trendingGNews(provider.apiKey);
      } else {
        throw new Error(`Unsupported Trending Search provider: ${provider.providerName}`);
      }

      if (items.length) {
        const pick = items[Math.floor(Math.random() * Math.min(items.length, 8))];
        console.log(`[AUTO] Trend signal received from ${provider.providerName}.`);
        return {
          signal: pick.title,
          context: pick.description,
          provider: provider.providerName
        };
      }
    } catch (error) {
      console.error(`[AUTO ERROR] Trend ${provider.providerName}:`, error.message);
      errors.push(`${provider.providerName}: ${error.message}`);
    }
  }

  const fallback = CREATIVE_SEEDS[Math.floor(Math.random() * CREATIVE_SEEDS.length)];
  console.log(`[AUTO] Trend APIs unavailable; using creative fallback: ${fallback}`);
  return {
    signal: fallback,
    context: "",
    provider: "Creative fallback"
  };
}

/* =========================================================
   GEMINI CREATIVE PROMPT GENERATION
========================================================= */

function extractGeminiText(data) {
  return (
    data?.candidates?.[0]?.content?.parts
      ?.map(p => p.text || "")
      .join("\n")
      .trim() || ""
  );
}

function parseJsonObject(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text).match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Gemini did not return valid JSON.");
    return JSON.parse(match[0]);
  }
}

async function generatePromptGeminiModel(apiKey, signal, model) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent` +
    `?key=${encodeURIComponent(apiKey)}`;

  const instruction = `
You are creating content for a premium AI image prompt gallery similar to a modern visual inspiration website.

Use the supplied trend signal only as loose inspiration. NEVER turn it into a news article or current-events post.

Trend signal:
${signal.signal}

Optional context:
${signal.context || "none"}

Create ONE original visual concept for an AI-generated image.

Important:
- Do not mention or depict politicians, public figures, elections, political parties, breaking news, crimes, disasters, or real-world news events.
- Do not copy the wording of the trend signal.
- Prefer visually interesting subjects such as fashion, portraits, architecture, products, travel, nature, food, automotive, editorial, branding, or graphic design.
- The image must look premium, polished, realistic or intentionally artistic.
- The prompt must be detailed enough to generate the exact image.
- No logos, watermarks, copyrighted characters, or readable brand names.
- Choose exactly one category from this list:
${CREATIVE_CATEGORIES.join(", ")}

Return ONLY valid JSON:
{
  "title": "short stylish title",
  "category": "one exact category from the list",
  "prompt": "detailed image-generation prompt"
}
`;

  const data = await fetchJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: instruction }] }],
      generationConfig: {
        temperature: 0.95,
        topP: 0.9,
        responseMimeType: "application/json"
      }
    })
  });

  const text = extractGeminiText(data);
  if (!text) throw new Error("Gemini returned empty text.");

  const parsed = parseJsonObject(text);
  const category = CREATIVE_CATEGORIES.includes(parsed.category)
    ? parsed.category
    : CREATIVE_CATEGORIES[Math.floor(Math.random() * CREATIVE_CATEGORIES.length)];

  if (!parsed.prompt) throw new Error("Gemini returned no image prompt.");

  return {
    title: clean(parsed.title || "AI Visual Inspiration", 140),
    category,
    prompt: clean(parsed.prompt, 7000),
    provider: "Gemini",
    model
  };
}

async function generatePromptGemini(apiKey, signal) {
  // Current model first; fallback keeps automation alive if Google changes access.
  const models = [
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite"
  ];

  const errors = [];
  for (const model of models) {
    try {
      console.log(`[AUTO] Prompt Generate: trying Gemini ${model}`);
      return await generatePromptGeminiModel(apiKey, signal, model);
    } catch (error) {
      console.error(`[AUTO ERROR] Gemini ${model}:`, error.message);
      errors.push(`${model}: ${error.message}`);
    }
  }

  throw new Error(`Gemini models failed. ${errors.join(" | ")}`);
}

async function generatePromptHF(apiKey, signal) {
  const url =
    "https://router.huggingface.co/hf-inference/models/Qwen/Qwen2.5-7B-Instruct";

  const instruction = `
Create one original premium AI image concept for a visual prompt gallery.
Trend inspiration: ${signal.signal}
Ignore any politics, news, real people, or current events in the signal.
Choose a subject such as portrait, fashion, product, architecture, travel, nature, automotive, food, editorial or graphic design.
Return only a detailed image generation prompt.
`;

  const data = await fetchJson(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      inputs: instruction,
      parameters: { max_new_tokens: 450, temperature: 0.9 }
    })
  });

  const text = Array.isArray(data) ? data[0]?.generated_text : data?.generated_text;
  if (!text) throw new Error("Hugging Face returned no generated text.");

  return {
    title: "AI Visual Inspiration",
    category: CREATIVE_CATEGORIES[Math.floor(Math.random() * CREATIVE_CATEGORIES.length)],
    prompt: clean(String(text).replace(instruction, "").trim(), 7000),
    provider: "Hugging Face"
  };
}

async function generatePrompt(signal) {
  const providers = await providersFor("prompt_generate");
  if (!providers.length) {
    throw new Error("No enabled Prompt Generate API provider.");
  }

  const errors = [];
  for (const provider of providers) {
    try {
      if (providerNameMatches(provider.providerName, "Gemini")) {
        return await generatePromptGemini(provider.apiKey, signal);
      }
      if (providerNameMatches(provider.providerName, "Hugging Face")) {
        return await generatePromptHF(provider.apiKey, signal);
      }
      throw new Error(`Unsupported Prompt Generate provider: ${provider.providerName}`);
    } catch (error) {
      errors.push(`${provider.providerName}: ${error.message}`);
      console.error(`[AUTO ERROR] Prompt Generate ${provider.providerName}:`, error.message);
    }
  }

  throw new Error(`All Prompt Generate providers failed. ${errors.join(" | ")}`);
}

/* =========================================================
   IMAGE GENERATION
========================================================= */

async function generateImageHF(apiKey, prompt) {
  const url =
    "https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell";

  return fetchBinary(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ inputs: prompt })
  });
}

async function generateImagePollinations(apiKey, prompt) {
  const url =
    "https://gen.pollinations.ai/image/" +
    encodeURIComponent(prompt) +
    "?model=flux&width=1024&height=1024&nologo=true";

  return fetchBinary(url, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
}

async function generateImage(prompt) {
  const providers = await providersFor("photo_generate");
  if (!providers.length) {
    throw new Error("No enabled Photo Generate API provider.");
  }

  const errors = [];
  for (const provider of providers) {
    try {
      console.log(`[AUTO] Image Generate: trying ${provider.providerName}`);
      let buffer;

      if (providerNameMatches(provider.providerName, "Hugging Face")) {
        buffer = await generateImageHF(provider.apiKey, prompt);
      } else if (providerNameMatches(provider.providerName, "Pollinations")) {
        buffer = await generateImagePollinations(provider.apiKey, prompt);
      } else {
        throw new Error(`Unsupported Photo Generate provider: ${provider.providerName}`);
      }

      if (!buffer || buffer.length < 1000) throw new Error("Image response was empty.");

      console.log(`[AUTO] Image Generate: ${provider.providerName} succeeded (${buffer.length} bytes)`);
      return { buffer, provider: provider.providerName };
    } catch (error) {
      console.error(`[AUTO ERROR] Image Generate ${provider.providerName}:`, error.message);
      errors.push(`${provider.providerName}: ${error.message}`);
    }
  }

  throw new Error(`All Photo Generate providers failed. ${errors.join(" | ")}`);
}

/* =========================================================
   CLOUDINARY
========================================================= */

async function uploadToCloudinary(buffer, publicId) {
  if (
    !process.env.CLOUDINARY_CLOUD_NAME ||
    !process.env.CLOUDINARY_API_KEY ||
    !process.env.CLOUDINARY_API_SECRET
  ) {
    throw new Error("Cloudinary environment variables are missing.");
  }

  const cloudinary = require("cloudinary").v2;
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "promptforge",
        public_id: publicId,
        resource_type: "image",
        overwrite: false
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );
    stream.end(buffer);
  });
}

/* =========================================================
   PUBLISH
========================================================= */

async function publishGenerated(signal, generated, image) {
  const existing = await getPrompts();
  const items = Array.isArray(existing) ? existing : [];

  // Avoid exact prompt duplicates and repeated titles.
  const promptLower = clean(generated.prompt, 7000).toLowerCase();
  const duplicate = items.some(
    p => clean(p.prompt, 7000).toLowerCase() === promptLower
  );

  if (duplicate) {
    return { skipped: true, reason: "Duplicate prompt" };
  }

  const title = uniqueTitle(generated.title, items);
  const slug = makeSlug(title);
  const upload = await uploadToCloudinary(image.buffer, slug);

  const item = await addPrompt({
    id: crypto.randomUUID(),
    slug,
    title,
    prompt: generated.prompt,
    category: generated.category || "Creative Art",
    media: "Image",
    imageUrl: upload.secure_url,
    model: generated.model || image.provider,
    source: "AI Visual Inspiration",
    auto: true,
    publishedAt: new Date().toISOString()
  });

  console.log(`[AUTO] Published: ${title} [${generated.category}]`);

  return {
    skipped: false,
    item,
    cloudinaryUrl: upload.secure_url
  };
}

/* =========================================================
   AUTOMATIC POSTING
========================================================= */

async function runAutomaticPosting() {
  console.log("[AUTO] Run started");

  const settings = await getSettings();
  if (!settings?.autoPost) {
    console.log("[AUTO] Automatic posting is disabled.");
    return { ok: true, added: 0, reason: "Automatic posting is disabled." };
  }

  const postsPerRun = Math.max(
    1,
    Math.min(10, Number(settings.postsPerRun || 1))
  );

  const results = [];

  for (let i = 0; i < postsPerRun; i++) {
    try {
      console.log(`[AUTO] Post ${i + 1}/${postsPerRun}: pipeline started`);

      const signal = await getTrendSignal();
      const generated = await generatePrompt(signal);

      console.log(
        `[AUTO] Creative concept: "${generated.title}" / ${generated.category}`
      );

      const image = await generateImage(generated.prompt);

      const published = await publishGenerated(signal, generated, image);

      results.push({
        ok: true,
        category: generated.category,
        promptProvider: generated.provider,
        imageProvider: image.provider,
        published
      });
    } catch (error) {
      console.error(`[AUTO ERROR] Post ${i + 1}/${postsPerRun}:`, error.message);
      results.push({ ok: false, error: error.message });
    }
  }

  const summary = {
    ok: results.some(x => x.ok),
    added: results.filter(x => x.ok && !x.published?.skipped).length,
    results
  };

  console.log("[AUTO] Run finished:", JSON.stringify(summary));
  return summary;
}

/* =========================================================
   PUBLIC
========================================================= */

app.get("/api/prompts", async (req, res) => {
  try {
    const items = await getPrompts();
    const q = clean(req.query.q).toLowerCase();
    let result = Array.isArray(items) ? items : [];

    if (q) {
      result = result.filter(p =>
        [p.title, p.prompt, p.category, p.model]
          .join(" ")
          .toLowerCase()
          .includes(q)
      );
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/prompts/:slug", async (req, res) => {
  try {
    const item = await getPromptBySlug(req.params.slug);
    if (!item) return res.status(404).json({ error: "Not found" });
    res.json(item);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/public/settings", async (req, res) => {
  try {
    const s = await getSettings();
    res.json({
      copyGateSeconds: Number(s?.copyGateSeconds || 10),
      directLink: clean(s?.directLink || "")
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* =========================================================
   AUTH
========================================================= */

app.post("/api/login", (req, res) => {
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({ error: "ADMIN_PASSWORD is not configured." });
  }

  const username = clean(req.body?.username, 100);
  const password = String(req.body?.password || "");

  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    req.session.admin = true;
    return res.json({ ok: true });
  }

  return res.status(401).json({ error: "Invalid username or password." });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/admin/me", (req, res) => {
  res.json({ authenticated: !!req.session?.admin });
});

/* =========================================================
   ADMIN PROMPTS
========================================================= */

app.get("/api/admin/prompts", requireAdmin, async (req, res) => {
  try {
    res.json(await getPrompts());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/admin/prompts", requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    if (!clean(b.title) || !clean(b.prompt)) {
      return res.status(400).json({ error: "Title and prompt are required." });
    }

    const item = await addPrompt({
      title: clean(b.title, 140),
      prompt: clean(b.prompt, 7000),
      model: clean(b.model, 140) || "Any",
      category: clean(b.category, 100) || "General",
      media: "Image",
      imageUrl: clean(b.imageUrl, 5000),
      source: "Manual",
      auto: false,
      publishedAt: new Date().toISOString()
    });

    res.json(item);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/admin/prompts/:id", requireAdmin, async (req, res) => {
  try {
    await deletePrompt(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* =========================================================
   ADMIN PROVIDERS
========================================================= */

app.get("/api/admin/providers", requireAdmin, async (req, res) => {
  try {
    res.json(await allProviders());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/admin/providers", requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const category = normalizeCategory(b.category);
    const providerName = clean(b.providerName || b.provider_name || b.name, 120);
    const apiKey = clean(b.apiKey || b.api_key || b.key, 10000);

    if (!["trending_search", "prompt_generate", "photo_generate"].includes(category)) {
      return res.status(400).json({ error: "Invalid provider category." });
    }
    if (!providerName || !apiKey) {
      return res.status(400).json({ error: "Provider name and API key are required." });
    }

    const item = await addProvider({
      category,
      providerName,
      apiKey,
      enabled: b.enabled !== false
    });

    res.json(normalizeProvider(item));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/admin/providers/:id", requireAdmin, async (req, res) => {
  try {
    await deleteProvider(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* =========================================================
   SETTINGS
========================================================= */

app.get("/api/admin/settings", requireAdmin, async (req, res) => {
  try {
    res.json(await getSettings());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/admin/settings", requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const current = await getSettings();

    const next = {
      autoPost:
        b.autoPost !== undefined
          ? !!b.autoPost
          : b.autoPostEnabled !== undefined
          ? !!b.autoPostEnabled
          : !!current.autoPost,
      postIntervalMinutes: Math.max(
        1,
        Number(b.postIntervalMinutes ?? b.interval ?? current.postIntervalMinutes ?? 60)
      ),
      postsPerRun: Math.max(
        1,
        Math.min(10, Number(b.postsPerRun ?? current.postsPerRun ?? 1))
      ),
      copyGateSeconds: Math.max(
        0,
        Number(b.copyGateSeconds ?? current.copyGateSeconds ?? 10)
      ),
      directLink: clean(b.directLink ?? current.directLink ?? "", 5000)
    };

    res.json(await saveSettings(next));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* =========================================================
   RUN NOW
========================================================= */

app.post("/api/admin/collect", requireAdmin, async (req, res) => {
  if (autoRunning) {
    return res.status(409).json({
      ok: false,
      error: "An automatic posting run is already in progress."
    });
  }

  console.log("[AUTO] Manual Run now requested");

  autoRunning = true;
  try {
    const result = await runAutomaticPosting();
    console.log(
      `[AUTO] Manual Run now finished: added=${result.added || 0}, ok=${!!result.ok}`
    );
    res.json(result);
  } catch (error) {
    console.error("[AUTO ERROR] Manual Run now failed:", error);
    res.status(500).json({ ok: false, error: error.message });
  } finally {
    autoRunning = false;
  }
});

/* =========================================================
   ADS
========================================================= */

app.get("/api/ads", async (req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    res.json((await getAds()) || {});
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/admin/ads", requireAdmin, async (req, res) => {
  try {
    res.json((await getAds()) || {});
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/admin/ads", requireAdmin, async (req, res) => {
  try {
    res.json(await saveAds(req.body || {}));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* =========================================================
   SCHEDULER
========================================================= */

let autoTimer = null;
let autoRunning = false;

async function startScheduler() {
  if (autoTimer) clearInterval(autoTimer);

  const settings = await getSettings();
  const minutes = Math.max(1, Number(settings?.postIntervalMinutes || 60));

  console.log(`Automatic posting scheduled every ${minutes} minute(s).`);

  autoTimer = setInterval(async () => {
    if (autoRunning) {
      console.log("[AUTO] Previous automatic run is still running.");
      return;
    }

    try {
      const current = await getSettings();
      if (!current?.autoPost) return;

      autoRunning = true;
      console.log("[AUTO] Scheduled run started.");
      const result = await runAutomaticPosting();
      console.log("Automatic posting result:", JSON.stringify(result));
    } catch (error) {
      console.error("Automatic posting error:", error.message);
    } finally {
      autoRunning = false;
    }
  }, minutes * 60 * 1000);
}

/* =========================================================
   ROUTES
========================================================= */

app.get("/admin", requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.use("/api", (req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.get("*splat", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* =========================================================
   BOOT
========================================================= */

async function boot() {
  try {
    console.log("Database: Supabase PostgreSQL");

    const providers = await allProviders();
    console.log("3 API categories enabled:");
    console.log("1. Trending Search");
    console.log("2. Prompt Generate");
    console.log("3. Image / Photo Generate");
    console.log(`Configured providers: ${providers.length}`);
    console.log(
      "[BOOT] Providers:",
      providers
        .map(p => `${p.category}:${p.providerName}:${p.enabled ? "enabled" : "disabled"}`)
        .join(", ") || "none"
    );

    if (
      process.env.CLOUDINARY_CLOUD_NAME &&
      process.env.CLOUDINARY_API_KEY &&
      process.env.CLOUDINARY_API_SECRET
    ) {
      console.log("Cloudinary storage enabled.");
    } else {
      console.warn("Cloudinary environment variables are missing.");
    }

    await startScheduler();

    app.listen(PORT, () => {
      console.log(`PromptForge running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Startup error:", error);
    app.listen(PORT, () => {
      console.log(`PromptForge running on port ${PORT} (startup warning)`);
    });
  }
}

boot();
