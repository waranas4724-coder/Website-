require("dotenv").config();

const express = require("express");
const session = require("express-session");
const path = require("path");
const crypto = require("crypto");
const cloudinary = require("cloudinary").v2;

const {
  getPrompts,
  getPromptBySlug,
  addPrompt,
  deletePrompt,

  getProviders,
  getProviderById,
  addProvider,
  updateProvider,
  deleteProvider,

  getSettings,
  saveSettings,

  getAds,
  saveAds
} = require("./db");

const app = express();

const PORT = process.env.PORT || 3000;

/* =========================================================
   BASIC CONFIG
========================================================= */

app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(
  express.json({
    limit: "2mb"
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "2mb"
  })
);

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

/* =========================================================
   SESSION
========================================================= */

if (!process.env.SESSION_SECRET) {
  console.warn(
    "[AUTH] SESSION_SECRET is not set."
  );
}

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

/* =========================================================
   CLOUDINARY
========================================================= */

const cloudinaryEnabled =
  !!process.env.CLOUDINARY_CLOUD_NAME &&
  !!process.env.CLOUDINARY_API_KEY &&
  !!process.env.CLOUDINARY_API_SECRET;

if (cloudinaryEnabled) {
  cloudinary.config({
    cloud_name:
      process.env.CLOUDINARY_CLOUD_NAME,

    api_key:
      process.env.CLOUDINARY_API_KEY,

    api_secret:
      process.env.CLOUDINARY_API_SECRET,

    secure: true
  });

  console.log(
    "[BOOT] Cloudinary storage enabled."
  );
} else {
  console.warn(
    "[BOOT] Cloudinary environment variables are missing."
  );
}

/* =========================================================
   HELPERS
========================================================= */

function clean(value, fallback = "") {
  if (
    value === undefined ||
    value === null
  ) {
    return fallback;
  }

  return String(value).trim();
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : fallback;
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
}

function httpUrl(value) {
  const v = clean(value);

  return /^https?:\/\//i.test(v)
    ? v
    : "";
}

function uniqueTitle(title) {
  return clean(title).slice(0, 180);
}

function providerNameMatches(provider, names) {
  const name = clean(
    provider?.providerName
  ).toLowerCase();

  return names.some(
    x =>
      name === x.toLowerCase() ||
      name.includes(x.toLowerCase())
  );
}

function providersFor(
  providers,
  category
) {
  return providers
    .filter(
      p =>
        p.enabled !== false &&
        clean(p.category).toLowerCase() ===
          category.toLowerCase()
    );
}

/* =========================================================
   API ROTATION
========================================================= */

/*
  Every category has its own pointer.

  Example:

  Trending:
  API 1 -> API 2 -> API 3 -> API 1

  Prompt:
  API 1 -> API 2 -> API 1

  Photo:
  API 1 -> API 2 -> API 3 -> API 1

  If an API fails, the next enabled API
  is tried automatically.
*/

const rotationState = {
  trending_search: 0,
  prompt_generate: 0,
  photo_generate: 0
};

function nextIndex(category, total) {
  if (!total) {
    return 0;
  }

  const current =
    rotationState[category] || 0;

  return current % total;
}

function advanceRotation(
  category,
  total
) {
  if (!total) {
    rotationState[category] = 0;
    return;
  }

  const current =
    rotationState[category] || 0;

  rotationState[category] =
    (current + 1) % total;
}

function orderedProviders(
  providers,
  category
) {
  const list = providersFor(
    providers,
    category
  );

  if (!list.length) {
    return [];
  }

  const start = nextIndex(
    category,
    list.length
  );

  return [
    ...list.slice(start),
    ...list.slice(0, start)
  ];
}

/* =========================================================
   HTTP
========================================================= */

async function fetchText(
  url,
  options = {},
  timeout = 30000
) {
  const controller =
    new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    timeout
  );

  try {
    const response = await fetch(
      url,
      {
        ...options,
        signal:
          options.signal ||
          controller.signal
      }
    );

    const text =
      await response.text();

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}: ${text.slice(
          0,
          500
        )}`
      );
    }

    return {
      response,
      text
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(
  url,
  options = {},
  timeout = 30000
) {
  const result =
    await fetchText(
      url,
      options,
      timeout
    );

  let json;

  try {
    json = JSON.parse(
      result.text
    );
  } catch {
    throw new Error(
      `Invalid JSON response from ${url}`
    );
  }

  return {
    response: result.response,
    json
  };
}

async function fetchBinary(
  url,
  options = {},
  timeout = 60000
) {
  const controller =
    new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    timeout
  );

  try {
    const response = await fetch(
      url,
      {
        ...options,
        signal:
          options.signal ||
          controller.signal
      }
    );

    if (!response.ok) {
      const text =
        await response.text();

      throw new Error(
        `HTTP ${response.status}: ${text.slice(
          0,
          500
        )}`
      );
    }

    const buffer = Buffer.from(
      await response.arrayBuffer()
    );

    return {
      response,
      buffer
    };
  } finally {
    clearTimeout(timer);
  }
}

/* =========================================================
   RESPONSE PATH
========================================================= */

function getPath(
  object,
  pathString
) {
  if (!pathString) {
    return object;
  }

  const parts =
    String(pathString)
      .replace(/\[(\d+)\]/g, ".$1")
      .split(".")
      .filter(Boolean);

  let value = object;

  for (const part of parts) {
    if (
      value === undefined ||
      value === null
    ) {
      return undefined;
    }

    value = value[part];
  }

  return value;
}

function firstValue(
  object,
  paths
) {
  for (const p of paths) {
    const value = getPath(
      object,
      p
    );

    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      return value;
    }
  }

  return undefined;
}

/* =========================================================
   TEMPLATE ENGINE FOR CUSTOM API
========================================================= */

function templateValue(
  value,
  context
) {
  if (
    typeof value === "string"
  ) {
    return value
      .replace(
        /\{\{\s*apiKey\s*\}\}/gi,
        clean(context.apiKey)
      )
      .replace(
        /\{\{\s*prompt\s*\}\}/gi,
        clean(context.prompt)
      )
      .replace(
        /\{\{\s*topic\s*\}\}/gi,
        clean(context.topic)
      )
      .replace(
        /\{\{\s*title\s*\}\}/gi,
        clean(context.title)
      )
      .replace(
        /\{\{\s*category\s*\}\}/gi,
        clean(context.category)
      );
  }

  if (
    Array.isArray(value)
  ) {
    return value.map(
      x =>
        templateValue(
          x,
          context
        )
    );
  }

  if (
    value &&
    typeof value === "object"
  ) {
    const result = {};

    for (const [
      key,
      val
    ] of Object.entries(value)) {
      result[key] =
        templateValue(
          val,
          context
        );
    }

    return result;
  }

  return value;
}

function parseJsonConfig(
  value,
  fallback
) {
  if (
    value &&
    typeof value === "object"
  ) {
    return value;
  }

  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/* =========================================================
   CUSTOM API REQUEST
========================================================= */

async function callCustomAPI(
  provider,
  context = {}
) {
  const config =
    provider.config || {};

  const endpoint =
    clean(
      config.endpoint ||
        config.url
    );

  if (!endpoint) {
    throw new Error(
      `${provider.providerName}: Custom API endpoint is missing`
    );
  }

  const method =
    clean(
      config.method,
      "GET"
    ).toUpperCase();

  const headers = {
    Accept:
      "application/json",
    ...(parseJsonConfig(
      config.headers,
      {}
    ) || {})
  };

  const authType =
    clean(
      config.authType ||
        config.authentication ||
        "none"
    ).toLowerCase();

  const apiKey =
    clean(
      provider.apiKey
    );

  if (
    apiKey &&
    (
      authType === "bearer" ||
      authType === "bearer_token"
    )
  ) {
    headers.Authorization =
      `Bearer ${apiKey}`;
  }

  if (
    apiKey &&
    (
      authType === "x-api-key" ||
      authType === "api-key" ||
      authType === "apikey"
    )
  ) {
    headers["X-API-Key"] =
      apiKey;
  }

  const finalHeaders =
    templateValue(
      headers,
      {
        ...context,
        apiKey
      }
    );

  let finalUrl =
    templateValue(
      endpoint,
      {
        ...context,
        apiKey
      }
    );

  const bodyConfig =
    config.body || {};

  let body;

  if (
    method !== "GET" &&
    method !== "HEAD"
  ) {
    const finalBody =
      templateValue(
        bodyConfig,
        {
          ...context,
          apiKey
        }
      );

    if (
      typeof finalBody ===
      "string"
    ) {
      body = finalBody;

      if (
        !finalHeaders[
          "Content-Type"
        ]
      ) {
        finalHeaders[
          "Content-Type"
        ] =
          "application/json";
      }
    } else {
      body =
        JSON.stringify(
          finalBody
        );

      if (
        !finalHeaders[
          "Content-Type"
        ]
      ) {
        finalHeaders[
          "Content-Type"
        ] =
          "application/json";
      }
    }
  }

  /*
    Optional GET query parameters
  */

  if (
    method === "GET" &&
    config.query
  ) {
    const query =
      templateValue(
        config.query,
        {
          ...context,
          apiKey
        }
      );

    const url =
      new URL(finalUrl);

    for (const [
      key,
      value
    ] of Object.entries(
      query || {}
    )) {
      if (
        value !== undefined &&
        value !== null
      ) {
        url.searchParams.set(
          key,
          String(value)
        );
      }
    }

    finalUrl =
      url.toString();
  }

  const result =
    await fetchJson(
      finalUrl,
      {
        method,
        headers:
          finalHeaders,
        body
      },
      45000
    );

  return result.json;
}

/* =========================================================
   NEWS DATA
========================================================= */

async function callNewsData(
  provider,
  topic
) {
  const apiKey =
    clean(provider.apiKey);

  if (!apiKey) {
    throw new Error(
      "NewsData.io API key missing"
    );
  }

  const url =
    new URL(
      "https://newsdata.io/api/1/latest"
    );

  url.searchParams.set(
    "apikey",
    apiKey
  );

  url.searchParams.set(
    "language",
    "en"
  );

  if (topic) {
    url.searchParams.set(
      "q",
      topic
    );
  }

  const {
    json
  } = await fetchJson(
    url.toString()
  );

  const results =
    Array.isArray(
      json.results
    )
      ? json.results
      : [];

  return results.map(
    item => ({
      title:
        item.title ||
        item.name ||
        "Trending Topic",

      description:
        item.description ||
        item.content ||
        "",

      url:
        item.link ||
        item.url ||
        "",

      source:
        item.source_name ||
        "NewsData.io",

      publishedAt:
        item.pubDate ||
        new Date().toISOString()
    })
  );
}

/* =========================================================
   GNEWS
========================================================= */

async function callGNews(
  provider,
  topic
) {
  const apiKey =
    clean(provider.apiKey);

  if (!apiKey) {
    throw new Error(
      "GNews API key missing"
    );
  }

  const url =
    new URL(
      "https://gnews.io/api/v4/top-headlines"
    );

  url.searchParams.set(
    "apikey",
    apiKey
  );

  url.searchParams.set(
    "lang",
    "en"
  );

  url.searchParams.set(
    "max",
    "10"
  );

  if (topic) {
    url.searchParams.set(
      "q",
      topic
    );
  }

  const {
    json
  } = await fetchJson(
    url.toString()
  );

  const articles =
    Array.isArray(
      json.articles
    )
      ? json.articles
      : [];

  return articles.map(
    item => ({
      title:
        item.title ||
        "Trending Topic",

      description:
        item.description ||
        item.content ||
        "",

      url:
        item.url ||
        "",

      source:
        item.source?.name ||
        "GNews",

      publishedAt:
        item.publishedAt ||
        new Date().toISOString()
    })
  );
}

/* =========================================================
   REDDIT
========================================================= */

async function callReddit(
  provider,
  topic
) {
  const query =
    clean(
      topic,
      "trending"
    );

  const url =
    new URL(
      "https://www.reddit.com/search.json"
    );

  url.searchParams.set(
    "q",
    query
  );

  url.searchParams.set(
    "sort",
    "hot"
  );

  url.searchParams.set(
    "limit",
    "15"
  );

  const {
    json
  } = await fetchJson(
    url.toString(),
    {
      headers: {
        "User-Agent":
          "PromptForge/1.0"
      }
    }
  );

  const children =
    json?.data?.children ||
    [];

  return children
    .map(
      item =>
        item?.data
    )
    .filter(Boolean)
    .map(
      item => ({
        title:
          item.title ||
          "Reddit Trend",

        description:
          item.selftext ||
          "",

        url:
          item.permalink
            ? `https://www.reddit.com${item.permalink}`
            : "",

        source:
          "Reddit",

        publishedAt:
          item.created_utc
            ? new Date(
                item.created_utc *
                  1000
              ).toISOString()
            : new Date().toISOString()
      })
    );
}

/* =========================================================
   YOUTUBE
========================================================= */

async function callYouTube(
  provider,
  topic
) {
  const apiKey =
    clean(provider.apiKey);

  if (!apiKey) {
    throw new Error(
      "YouTube API key missing"
    );
  }

  const url =
    new URL(
      "https://www.googleapis.com/youtube/v3/search"
    );

  url.searchParams.set(
    "part",
    "snippet"
  );

  url.searchParams.set(
    "type",
    "video"
  );

  url.searchParams.set(
    "order",
    "viewCount"
  );

  url.searchParams.set(
    "maxResults",
    "15"
  );

  url.searchParams.set(
    "key",
    apiKey
  );

  if (topic) {
    url.searchParams.set(
      "q",
      topic
    );
  }

  const {
    json
  } = await fetchJson(
    url.toString()
  );

  return (
    json.items || []
  ).map(
    item => ({
      title:
        item.snippet?.title ||
        "YouTube Trend",

      description:
        item.snippet?.description ||
        "",

      url:
        item.id?.videoId
          ? `https://www.youtube.com/watch?v=${item.id.videoId}`
          : "",

      source:
        "YouTube",

      publishedAt:
        item.snippet?.publishedAt ||
        new Date().toISOString()
    })
  );
}

/* =========================================================
   X / TWITTER
========================================================= */

async function callX(
  provider,
  topic
) {
  const token =
    clean(provider.apiKey);

  if (!token) {
    throw new Error(
      "X/Twitter Bearer token missing"
    );
  }

  const query =
    clean(
      topic,
      "AI OR photography OR technology"
    );

  const url =
    new URL(
      "https://api.x.com/2/tweets/search/recent"
    );

  url.searchParams.set(
    "query",
    `${query} -is:retweet`
  );

  url.searchParams.set(
    "max_results",
    "20"
  );

  url.searchParams.set(
    "tweet.fields",
    "created_at,text,author_id"
  );

  const {
    json
  } = await fetchJson(
    url.toString(),
    {
      headers: {
        Authorization:
          `Bearer ${token}`
      }
    }
  );

  return (
    json.data || []
  ).map(
    item => ({
      title:
        item.text?.slice(
          0,
          140
        ) ||
        "X Trend",

      description:
        item.text || "",

      url:
        `https://x.com/i/web/status/${item.id}`,

      source:
        "X/Twitter",

      publishedAt:
        item.created_at ||
        new Date().toISOString()
    })
  );
}

/* =========================================================
   BLUESKY
========================================================= */

async function callBluesky(
  provider,
  topic
) {
  const query =
    clean(
      topic,
      "AI"
    );

  const url =
    new URL(
      "https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts"
    );

  url.searchParams.set(
    "q",
    query
  );

  url.searchParams.set(
    "limit",
    "20"
  );

  const {
    json
  } = await fetchJson(
    url.toString()
  );

  return (
    json.posts || []
  ).map(
    item => ({
      title:
        item.record?.text?.slice(
          0,
          140
        ) ||
        "Bluesky Trend",

      description:
        item.record?.text ||
        "",

      url:
        item.uri || "",

      source:
        "Bluesky",

      publishedAt:
        item.record?.createdAt ||
        new Date().toISOString()
    })
  );
}

/* =========================================================
   TRENDING PROVIDER DISPATCHER
========================================================= */

async function callTrendingProvider(
  provider,
  topic
) {
  if (
    providerNameMatches(
      provider,
      ["NewsData.io", "NewsData"]
    )
  ) {
    return callNewsData(
      provider,
      topic
    );
  }

  if (
    providerNameMatches(
      provider,
      ["GNews"]
    )
  ) {
    return callGNews(
      provider,
      topic
    );
  }

  if (
    providerNameMatches(
      provider,
      ["Reddit"]
    )
  ) {
    return callReddit(
      provider,
      topic
    );
  }

  if (
    providerNameMatches(
      provider,
      ["YouTube"]
    )
  ) {
    return callYouTube(
      provider,
      topic
    );
  }

  if (
    providerNameMatches(
      provider,
      ["X/Twitter", "Twitter", "X"]
    )
  ) {
    return callX(
      provider,
      topic
    );
  }

  if (
    providerNameMatches(
      provider,
      ["Bluesky"]
    )
  ) {
    return callBluesky(
      provider,
      topic
    );
  }

  return callCustomAPI(
    provider,
    {
      topic,
      category:
        "trending_search"
    }
  ).then(
    json =>
      normalizeTrendingCustom(
        json,
        provider
      )
  );
}

/* =========================================================
   CUSTOM TREND NORMALIZER
========================================================= */

function normalizeTrendingCustom(
  json,
  provider
) {
  const config =
    provider.config || {};

  const configuredPath =
    clean(
      config.responsePath ||
        config.resultsPath
    );

  let data =
    configuredPath
      ? getPath(
          json,
          configuredPath
        )
      : firstValue(
          json,
          [
            "results",
            "articles",
            "items",
            "data",
            "posts",
            "news"
          ]
        );

  if (!data) {
    data = json;
  }

  if (!Array.isArray(data)) {
    data = [data];
  }

  return data
    .filter(Boolean)
    .map(
      item => ({
        title:
          clean(
            firstValue(
              item,
              [
                config.titlePath ||
                  "",
                "title",
                "name",
                "text"
              ]
            )
          ) ||
          "Trending Topic",

        description:
          clean(
            firstValue(
              item,
              [
                config.descriptionPath ||
                  "",
                "description",
                "content",
                "summary",
                "text"
              ]
            )
          ),

        url:
          httpUrl(
            firstValue(
              item,
              [
                config.urlPath ||
                  "",
                "url",
                "link",
                "permalink"
              ]
            )
          ),

        source:
          clean(
            firstValue(
              item,
              [
                config.sourcePath ||
                  "",
                "source",
                "source_name"
              ]
            )
          ) ||
          provider.providerName,

        publishedAt:
          firstValue(
            item,
            [
              config.datePath ||
                "",
              "publishedAt",
              "published_at",
              "created_at",
              "date"
            ]
          ) ||
          new Date().toISOString()
      })
    );
}

/* =========================================================
   CREATIVE SEEDS
========================================================= */

const CREATIVE_SEEDS = [
  {
    category:
      "Portrait Photography",
    seed:
      "luxury editorial portrait"
  },
  {
    category:
      "Fashion Photography",
    seed:
      "premium fashion campaign"
  },
  {
    category:
      "Commercial Photography",
    seed:
      "cinematic commercial campaign"
  },
  {
    category:
      "Product Photography",
    seed:
      "minimal product photography"
  },
  {
    category:
      "Brand Design",
    seed:
      "premium brand campaign"
  },
  {
    category:
      "Architecture",
    seed:
      "futuristic architecture"
  },
  {
    category:
      "Interior Design",
    seed:
      "modern luxury interior"
  },
  {
    category:
      "Travel Photography",
    seed:
      "cinematic travel destination"
  },
  {
    category:
      "Nature Photography",
    seed:
      "dreamlike natural landscape"
  },
  {
    category:
      "Cinematic Photography",
    seed:
      "cinematic night scene"
  },
  {
    category:
      "Automotive",
    seed:
      "luxury automotive campaign"
  },
  {
    category:
      "Food Photography",
    seed:
      "creative food photography"
  },
  {
    category:
      "Editorial",
    seed:
      "editorial lifestyle photography"
  },
  {
    category:
      "Fantasy Art",
    seed:
      "fantasy cinematic environment"
  },
  {
    category:
      "Digital Art",
    seed:
      "surreal digital artwork"
  },
  {
    category:
      "Graphic Design",
    seed:
      "modern graphic design poster"
  },
  {
    category:
      "Lifestyle",
    seed:
      "editorial lifestyle photography"
  },
  {
    category:
      "Luxury",
    seed:
      "high-end luxury campaign"
  },
  {
    category:
      "Minimalist",
    seed:
      "minimalist studio photography"
  },
  {
    category:
      "Surreal Art",
    seed:
      "surreal fine art portrait"
  }
];

function randomSeed() {
  return CREATIVE_SEEDS[
    Math.floor(
      Math.random() *
        CREATIVE_SEEDS.length
    )
  ];
}

/* =========================================================
   GEMINI
========================================================= */

function extractGeminiText(
  json
) {
  return (
    json?.candidates?.[0]
      ?.content?.parts
      ?.map(x => x.text || "")
      .join("\n")
      .trim() || ""
  );
}

function parseJsonFromText(
  text
) {
  const cleaned =
    String(text || "")
      .replace(
        /^```json\s*/i,
        ""
      )
      .replace(
        /^```\s*/i,
        ""
      )
      .replace(
        /```$/i,
        ""
      )
      .trim();

  try {
    return JSON.parse(
      cleaned
    );
  } catch {}

  const start =
    cleaned.indexOf("{");

  const end =
    cleaned.lastIndexOf("}");

  if (
    start >= 0 &&
    end > start
  ) {
    try {
      return JSON.parse(
        cleaned.slice(
          start,
          end + 1
        )
      );
    } catch {}
  }

  return null;
}

async function callGemini(
  provider,
  context
) {
  const apiKey =
    clean(provider.apiKey);

  if (!apiKey) {
    throw new Error(
      "Gemini API key missing"
    );
  }

  const model =
    clean(
      provider.config?.model,
      "gemini-3.5-flash-lite"
    );

  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model
    )}:generateContent?key=${encodeURIComponent(
      apiKey
    )}`;

  const seed =
    context.seed ||
    "premium AI visual concept";

  const trend =
    context.trend ||
    "";

  const prompt = `
You are a professional creative director for an AI visual prompt website.

Create ONE original visual concept.

Category:
${context.category}

Creative seed:
${seed}

Optional trend signal:
${trend}

Return ONLY valid JSON in this exact format:

{
  "title": "short premium title",
  "prompt": "detailed image generation prompt",
  "category": "category name"
}

The image prompt must describe:
subject, composition, camera, lens, lighting,
materials/textures, environment, atmosphere,
color grading, depth, realism and professional
photography/art direction.

Do not mention copyrighted characters.
Do not copy an existing artwork.
Do not include explanations outside JSON.
`;

  const {
    json
  } = await fetchJson(
    endpoint,
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
                text: prompt
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.9,
          maxOutputTokens: 1800
        }
      })
    },
    60000
  );

  const text =
    extractGeminiText(json);

  if (!text) {
    throw new Error(
      "Gemini returned empty response"
    );
  }

  const parsed =
    parseJsonFromText(text);

  if (!parsed) {
    throw new Error(
      "Gemini returned invalid JSON"
    );
  }

  if (
    !parsed.title ||
    !parsed.prompt
  ) {
    throw new Error(
      "Gemini response missing title/prompt"
    );
  }

  return {
    title:
      uniqueTitle(
        parsed.title
      ),

    prompt:
      clean(
        parsed.prompt
      ),

    category:
      clean(
        parsed.category,
        context.category
      )
  };
}

/* =========================================================
   CUSTOM PROMPT PROVIDER
========================================================= */

function normalizeCustomPrompt(
  json,
  provider,
  context
) {
  const config =
    provider.config || {};

  const root =
    config.responsePath
      ? getPath(
          json,
          config.responsePath
        )
      : json;

  const title =
    clean(
      firstValue(
        root,
        [
          config.titlePath ||
            "",
          "title",
          "name"
        ]
      )
    ) ||
    `${context.category} Concept`;

  const prompt =
    clean(
      firstValue(
        root,
        [
          config.promptPath ||
            "",
          "prompt",
          "text",
          "content",
          "output",
          "response"
        ]
      )
    );

  if (!prompt) {
    throw new Error(
      `${provider.providerName}: prompt field not found in response`
    );
  }

  return {
    title,
    prompt,
    category:
      clean(
        firstValue(
          root,
          [
            config.categoryPath ||
              "",
            "category"
          ]
        )
      ) ||
      context.category
  };
}

async function callPromptProvider(
  provider,
  context
) {
  if (
    providerNameMatches(
      provider,
      ["Gemini"]
    )
  ) {
    return callGemini(
      provider,
      context
    );
  }

  const json =
    await callCustomAPI(
      provider,
      {
        ...context,
        category:
          "prompt_generate"
      }
    );

  return normalizeCustomPrompt(
    json,
    provider,
    context
  );
}

/* =========================================================
   POLLINATIONS
========================================================= */

async function callPollinations(
  provider,
  prompt
) {
  const encoded =
    encodeURIComponent(
      prompt
    );

  const seed =
    Math.floor(
      Math.random() *
        1000000000
    );

  const model =
    clean(
      provider.config?.model,
      "flux"
    );

  const url =
    `https://image.pollinations.ai/prompt/${encoded}?model=${encodeURIComponent(
      model
    )}&width=1024&height=1024&nologo=true&seed=${seed}`;

  return {
    imageUrl: url,
    model:
      "Pollinations"
  };
}

/* =========================================================
   HUGGING FACE
========================================================= */

async function callHuggingFace(
  provider,
  prompt
) {
  const token =
    clean(provider.apiKey);

  if (!token) {
    throw new Error(
      "Hugging Face API key missing"
    );
  }

  const model =
    clean(
      provider.config?.model,
      "black-forest-labs/FLUX.1-schnell"
    );

  const endpoint =
    `https://api-inference.huggingface.co/models/${encodeURIComponent(
      model
    )}`;

  const {
    buffer
  } = await fetchBinary(
    endpoint,
    {
      method: "POST",

      headers: {
        Authorization:
          `Bearer ${token}`,
        "Content-Type":
          "application/json"
      },

      body: JSON.stringify({
        inputs: prompt
      })
    },
    120000
  );

  return {
    buffer,
    model:
      `Hugging Face / ${model}`
  };
}

/* =========================================================
   CUSTOM IMAGE API
========================================================= */

async function callCustomImage(
  provider,
  prompt
) {
  const json =
    await callCustomAPI(
      provider,
      {
        prompt,
        category:
          "photo_generate"
      }
    );

  const config =
    provider.config || {};

  const root =
    config.responsePath
      ? getPath(
          json,
          config.responsePath
        )
      : json;

  const imageUrl =
    httpUrl(
      firstValue(
        root,
        [
          config.imagePath ||
            "",
          "imageUrl",
          "image_url",
          "url",
          "output",
          "image"
        ]
      )
    );

  if (imageUrl) {
    return {
      imageUrl,
      model:
        provider.providerName
    };
  }

  const base64 =
    firstValue(
      root,
      [
        config.base64Path ||
          "",
        "base64",
        "image_base64",
        "b64_json"
      ]
    );

  if (
    base64 &&
    typeof base64 === "string"
  ) {
    let data =
      base64;

    if (
      !data.startsWith(
        "data:image"
      )
    ) {
      data =
        `data:image/png;base64,${data}`;
    }

    return {
      dataUrl: data,
      model:
        provider.providerName
    };
  }

  throw new Error(
    `${provider.providerName}: image URL/base64 not found in response`
  );
}

/* =========================================================
   IMAGE PROVIDER DISPATCH
========================================================= */

async function callImageProvider(
  provider,
  prompt
) {
  if (
    providerNameMatches(
      provider,
      ["Pollinations"]
    )
  ) {
    return callPollinations(
      provider,
      prompt
    );
  }

  if (
    providerNameMatches(
      provider,
      [
        "Hugging Face",
        "HuggingFace"
      ]
    )
  ) {
    return callHuggingFace(
      provider,
      prompt
    );
  }

  return callCustomImage(
    provider,
    prompt
  );
}

/* =========================================================
   CLOUDINARY UPLOAD
========================================================= */

async function uploadToCloudinary(
  source
) {
  if (!cloudinaryEnabled) {
    return {
      url:
        typeof source === "string"
          ? source
          : "",
      publicId: ""
    };
  }

  if (
    typeof source === "string" &&
    /^https?:\/\//i.test(
      source
    )
  ) {
    const result =
      await cloudinary.uploader.upload(
        source,
        {
          folder:
            "promptforge/generated",
          resource_type:
            "image"
        }
      );

    return {
      url:
        result.secure_url,
      publicId:
        result.public_id
    };
  }

  if (
    Buffer.isBuffer(source)
  ) {
    const result =
      await new Promise(
        (
          resolve,
          reject
        ) => {
          const stream =
            cloudinary.uploader.upload_stream(
              {
                folder:
                  "promptforge/generated",
                resource_type:
                  "image"
              },
              (
                error,
                result
              ) => {
                if (error) {
                  reject(error);
                } else {
                  resolve(
                    result
                  );
                }
              }
            );

          stream.end(source);
        }
      );

    return {
      url:
        result.secure_url,
      publicId:
        result.public_id
    };
  }

  throw new Error(
    "Unsupported image source"
  );
}

/* =========================================================
   IMAGE SOURCE TO CLOUDINARY
========================================================= */

async function storeGeneratedImage(
  result
) {
  if (result.imageUrl) {
    return uploadToCloudinary(
      result.imageUrl
    );
  }

  if (result.dataUrl) {
    if (!cloudinaryEnabled) {
      return {
        url:
          result.dataUrl,
        publicId: ""
      };
    }

    const uploaded =
      await cloudinary.uploader.upload(
        result.dataUrl,
        {
          folder:
            "promptforge/generated",
          resource_type:
            "image"
        }
      );

    return {
      url:
        uploaded.secure_url,
      publicId:
        uploaded.public_id
    };
  }

  if (result.buffer) {
    return uploadToCloudinary(
      result.buffer
    );
  }

  throw new Error(
    "Image provider returned no usable image"
  );
}

/* =========================================================
   TREND FETCH WITH ROTATION + FALLBACK
========================================================= */

async function getTrendingTopic(
  providers
) {
  const list =
    orderedProviders(
      providers,
      "trending_search"
    );

  if (!list.length) {
    console.log(
      "[AUTO] No trending API configured. Using creative seed."
    );

    const seed =
      randomSeed();

    return {
      topic:
        seed.seed,
      title:
        seed.seed,
      source:
        "Creative Seed",
      category:
        seed.category
    };
  }

  const errors = [];

  for (
    let i = 0;
    i < list.length;
    i++
  ) {
    const provider =
      list[i];

    try {
      const items =
        await callTrendingProvider(
          provider,
          ""
        );

      if (
        !Array.isArray(items) ||
        !items.length
      ) {
        throw new Error(
          "No trend results"
        );
      }

      /*
        Successful provider becomes
        the current provider for this
        category, and next run moves
        to the next provider.
      */

      const globalList =
        providersFor(
          providers,
          "trending_search"
        );

      const position =
        globalList.findIndex(
          p =>
            String(p.id) ===
            String(provider.id)
        );

      if (position >= 0) {
        rotationState.trending_search =
          (position + 1) %
          globalList.length;
      }

      const item =
        items[
          Math.floor(
            Math.random() *
              items.length
          )
        ];

      return {
        topic:
          item.title ||
          "creative visual",
        title:
          item.title ||
          "Trending Visual",
        description:
          item.description ||
          "",
        source:
          item.source ||
          provider.providerName,
        sourceUrl:
          item.url ||
          "",
        category:
          randomSeed().category
      };
    } catch (error) {
      console.error(
        `[AUTO] Trending ${provider.providerName} failed:`,
        error.message
      );

      errors.push(
        `${provider.providerName}: ${error.message}`
      );

      continue;
    }
  }

  console.warn(
    "[AUTO] All trending APIs failed. Using creative seed."
  );

  const seed =
    randomSeed();

  return {
    topic:
      seed.seed,
    title:
      seed.seed,
    source:
      "Creative Seed",
    category:
      seed.category,
    errors
  };
}

/* =========================================================
   PROMPT GENERATION WITH ROTATION
========================================================= */

async function generatePrompt(
  providers,
  context
) {
  const list =
    orderedProviders(
      providers,
      "prompt_generate"
    );

  if (!list.length) {
    throw new Error(
      "No Prompt Generate API configured."
    );
  }

  const errors = [];

  for (
    let i = 0;
    i < list.length;
    i++
  ) {
    const provider =
      list[i];

    try {
      console.log(
        `[AUTO] Prompt Generate: trying ${provider.providerName}`
      );

      const result =
        await callPromptProvider(
          provider,
          context
        );

      const globalList =
        providersFor(
          providers,
          "prompt_generate"
        );

      const position =
        globalList.findIndex(
          p =>
            String(p.id) ===
            String(provider.id)
        );

      if (position >= 0) {
        rotationState.prompt_generate =
          (position + 1) %
          globalList.length;
      }

      return {
        ...result,
        provider:
          provider.providerName
      };
    } catch (error) {
      console.error(
        `[AUTO] Prompt Generate ${provider.providerName} failed:`,
        error.message
      );

      errors.push(
        `${provider.providerName}: ${error.message}`
      );
    }
  }

  throw new Error(
    `All Prompt Generate APIs failed: ${errors.join(
      " | "
    )}`
  );
}

/* =========================================================
   IMAGE GENERATION WITH ROTATION
========================================================= */

async function generateImage(
  providers,
  prompt
) {
  const list =
    orderedProviders(
      providers,
      "photo_generate"
    );

  if (!list.length) {
    throw new Error(
      "No Photo Generate API configured."
    );
  }

  const errors = [];

  for (
    let i = 0;
    i < list.length;
    i++
  ) {
    const provider =
      list[i];

    try {
      console.log(
        `[AUTO] Image Generate: trying ${provider.providerName}`
      );

      const result =
        await callImageProvider(
          provider,
          prompt
        );

      const globalList =
        providersFor(
          providers,
          "photo_generate"
        );

      const position =
        globalList.findIndex(
          p =>
            String(p.id) ===
            String(provider.id)
        );

      if (position >= 0) {
        rotationState.photo_generate =
          (position + 1) %
          globalList.length;
      }

      return {
        ...result,
        provider:
          provider.providerName
      };
    } catch (error) {
      console.error(
        `[AUTO] Image Generate ${provider.providerName} failed:`,
        error.message
      );

      errors.push(
        `${provider.providerName}: ${error.message}`
      );
    }
  }

  throw new Error(
    `All Photo Generate APIs failed: ${errors.join(
      " | "
    )}`
  );
}

/* =========================================================
   AUTO POST
========================================================= */

let postingNow = false;

async function createAutomaticPost() {
  if (postingNow) {
    return {
      ok: false,
      reason:
        "Another automatic post is already running."
    };
  }

  postingNow = true;

  try {
    const settings =
      await getSettings();

    if (
      settings.autoPost === false
    ) {
      return {
        ok: false,
        reason:
          "Automatic posting is disabled."
      };
    }

    const providers =
      await getProviders();

    console.log(
      "[AUTO] Starting automatic post..."
    );

    /*
      STEP 1
      Trending / social signal
    */

    const trend =
      await getTrendingTopic(
        providers
      );

    console.log(
      `[AUTO] Trending signal: ${trend.topic}`
    );

    /*
      STEP 2
      Choose creative category
    */

    const seed =
      randomSeed();

    const category =
      seed.category;

    /*
      STEP 3
      Gemini/custom prompt API
    */

    const generated =
      await generatePrompt(
        providers,
        {
          trend:
            trend.title ||
            trend.topic ||
            "",
          seed:
            seed.seed,
          category
        }
      );

    console.log(
      `[AUTO] Prompt created by ${generated.provider}`
    );

    /*
      STEP 4
      Photo/image API
    */

    const image =
      await generateImage(
        providers,
        generated.prompt
      );

    console.log(
      `[AUTO] Image created by ${image.provider}`
    );

    /*
      STEP 5
      Cloudinary
    */

    const stored =
      await storeGeneratedImage(
        image
      );

    console.log(
      `[AUTO] Image stored: ${stored.url}`
    );

    /*
      STEP 6
      Save post to Supabase
    */

    const title =
      uniqueTitle(
        generated.title ||
          trend.title ||
          `${category} Visual`
      );

    const saved =
      await addPrompt({
        slug:
          slugify(title) +
          "-" +
          Date.now()
            .toString(36),

        title,

        prompt:
          generated.prompt,

        category:
          generated.category ||
          category,

        media:
          "Image",

        imageUrl:
          stored.url,

        model:
          image.model ||
          image.provider ||
          "AI",

        source:
          `AI Visual Inspiration · ${generated.provider} · ${image.provider}`
      });

    console.log(
      `[AUTO] Published: ${saved.id || title}`
    );

    return {
      ok: true,

      post: {
        id:
          saved.id,
        title,
        prompt:
          generated.prompt,
        imageUrl:
          stored.url,
        category:
          generated.category ||
          category,
        promptProvider:
          generated.provider,
        imageProvider:
          image.provider,
        source:
          `AI Visual Inspiration · ${generated.provider} · ${image.provider}`
      },

      trend
    };
  } finally {
    postingNow = false;
  }
}

/* =========================================================
   PUBLIC API
========================================================= */

app.get(
  "/api/prompts",
  async (req, res) => {
    try {
      const prompts =
        await getPrompts();

      const q =
        clean(
          req.query.q
        ).toLowerCase();

      const category =
        clean(
          req.query.category
        ).toLowerCase();

      const media =
        clean(
          req.query.media
        ).toLowerCase();

      const filtered =
        prompts.filter(
          item => {
            const text =
              [
                item.title,
                item.prompt,
                item.category,
                item.model
              ]
                .join(" ")
                .toLowerCase();

            return (
              (!q ||
                text.includes(q)) &&
              (!category ||
                category === "all" ||
                String(
                  item.category
                ).toLowerCase() ===
                  category) &&
              (!media ||
                media === "all" ||
                String(
                  item.media
                ).toLowerCase() ===
                  media)
            );
          }
        );

      res.json(
        filtered
      );
    } catch (error) {
      console.error(
        error
      );

      res.status(500).json({
        error:
          "Unable to load prompts"
      });
    }
  }
);

app.get(
  "/api/prompts/:slug",
  async (req, res) => {
    try {
      const prompt =
        await getPromptBySlug(
          req.params.slug
        );

      if (!prompt) {
        return res
          .status(404)
          .json({
            error:
              "Not found"
          });
      }

      res.json(prompt);
    } catch (error) {
      res.status(500).json({
        error:
          "Unable to load prompt"
      });
    }
  }
);

/* =========================================================
   PUBLIC SETTINGS
========================================================= */

app.get(
  "/api/public/settings",
  async (req, res) => {
    try {
      const settings =
        await getSettings();

      res.json({
        copyGateSeconds:
          settings.copyGateSeconds,
        directLink:
          settings.directLink
      });
    } catch {
      res.status(500).json({
        error:
          "Unable to load settings"
      });
    }
  }
);

/* =========================================================
   ADS PUBLIC
========================================================= */

app.get(
  "/api/ads",
  async (req, res) => {
    try {
      const ads =
        await getAds();

      res.set(
        "Cache-Control",
        "no-store"
      );

      res.json(ads);
    } catch (error) {
      console.error(
        "[ADS]",
        error
      );

      res.status(500).json({
        error:
          "Unable to load ads"
      });
    }
  }
);

/* =========================================================
   API V1
========================================================= */

app.use(
  "/api/v1",
  (req, res, next) => {
    res.set(
      "Access-Control-Allow-Origin",
      "*"
    );

    next();
  }
);

app.get(
  "/api/v1/prompts",
  async (req, res) => {
    try {
      const all =
        await getPrompts();

      const limit =
        Math.min(
          100,
          Math.max(
            1,
            safeNumber(
              req.query.limit,
              20
            )
          )
        );

      const page =
        Math.max(
          1,
          safeNumber(
            req.query.page,
            1
          )
        );

      const start =
        (page - 1) *
        limit;

      res.json({
        data:
          all.slice(
            start,
            start + limit
          ),

        meta: {
          total:
            all.length,

          page,

          limit,

          pages:
            Math.ceil(
              all.length /
                limit
            )
        }
      });
    } catch {
      res.status(500).json({
        error:
          "Unable to load prompts"
      });
    }
  }
);

app.get(
  "/api/v1/prompts/:slug",
  async (req, res) => {
    try {
      const prompt =
        await getPromptBySlug(
          req.params.slug
        );

      if (!prompt) {
        return res
          .status(404)
          .json({
            error:
              "Not found"
          });
      }

      res.json(prompt);
    } catch {
      res.status(500).json({
        error:
          "Unable to load prompt"
      });
    }
  }
);

/* =========================================================
   AUTH
========================================================= */

const failedLogins =
  new Map();

function safeCompare(
  a,
  b
) {
  const aa =
    crypto
      .createHash("sha256")
      .update(
        String(a || "")
      )
      .digest();

  const bb =
    crypto
      .createHash("sha256")
      .update(
        String(b || "")
      )
      .digest();

  return crypto.timingSafeEqual(
    aa,
    bb
  );
}

app.post(
  "/api/login",
  (req, res) => {
    const username =
      clean(
        req.body?.username
      );

    const password =
      clean(
        req.body?.password
      );

    const adminUsername =
      process.env.ADMIN_USERNAME ||
      "admin";

    const adminPassword =
      process.env.ADMIN_PASSWORD;

    if (!adminPassword) {
      return res.status(503).json({
        error:
          "ADMIN_PASSWORD is not configured."
      });
    }

    const ip =
      req.ip || "unknown";

    const fail =
      failedLogins.get(ip) || {
        count: 0,
        last: 0
      };

    if (
      fail.count >= 5 &&
      Date.now() -
        fail.last <
        15 * 60 * 1000
    ) {
      return res.status(429).json({
        error:
          "Too many login attempts. Try again later."
      });
    }

    if (
      safeCompare(
        username,
        adminUsername
      ) &&
      safeCompare(
        password,
        adminPassword
      )
    ) {
      failedLogins.delete(
        ip
      );

      req.session.admin =
        true;

      return res.json({
        ok: true
      });
    }

    failedLogins.set(
      ip,
      {
        count:
          fail.count + 1,
        last:
          Date.now()
      }
    );

    res.status(401).json({
      error:
        "Invalid username or password."
    });
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
        !!req.session?.admin
    });
  }
);

function admin(
  req,
  res,
  next
) {
  if (
    req.session?.admin
  ) {
    return next();
  }

  res.status(401).json({
    error:
      "Unauthorized"
  });
}

/* =========================================================
   ADMIN PROMPTS
========================================================= */

app.get(
  "/api/admin/prompts",
  admin,
  async (req, res) => {
    try {
      res.json(
        await getPrompts()
      );
    } catch {
      res.status(500).json({
        error:
          "Unable to load prompts"
      });
    }
  }
);

app.post(
  "/api/admin/prompts",
  admin,
  async (req, res) => {
    try {
      const body =
        req.body || {};

      if (
        !body.title ||
        !body.prompt
      ) {
        return res.status(400).json({
          error:
            "Title and prompt are required."
        });
      }

      const saved =
        await addPrompt({
          slug:
            slugify(
              body.title
            ) +
            "-" +
            Date.now()
              .toString(36),

          title:
            body.title,

          prompt:
            body.prompt,

          category:
            body.category ||
            "General",

          media:
            body.media ||
            "Image",

          imageUrl:
            body.imageUrl ||
            "",

          model:
            body.model ||
            "Any",

          source:
            body.source ||
            "Manual"
        });

      res.json(
        saved
      );
    } catch (error) {
      console.error(
        error
      );

      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

app.delete(
  "/api/admin/prompts/:id",
  admin,
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
  admin,
  async (req, res) => {
    try {
      const providers =
        await getProviders();

      /*
        Do not expose API keys
        to browser.
      */

      res.json(
        providers.map(
          provider => ({
            ...provider,

            apiKey:
              provider.apiKey
                ? "••••••••"
                : "",

            hasApiKey:
              !!provider.apiKey
          })
        )
      );
    } catch (error) {
      console.error(
        "[ADMIN PROVIDERS]",
        error
      );

      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

app.post(
  "/api/admin/providers",
  admin,
  async (req, res) => {
    try {
      const body =
        req.body || {};

      const category =
        clean(
          body.category
        );

      const providerName =
        clean(
          body.providerName ||
            body.provider_name ||
            body.name
        );

      if (
        !category ||
        !providerName
      ) {
        return res.status(400).json({
          error:
            "Category and provider name are required."
        });
      }

      const allowedCategories = [
        "trending_search",
        "prompt_generate",
        "photo_generate"
      ];

      if (
        !allowedCategories.includes(
          category
        )
      ) {
        return res.status(400).json({
          error:
            "Invalid provider category."
        });
      }

      const provider =
        await addProvider({
          category,

          providerName,

          apiKey:
            clean(
              body.apiKey ||
                body.api_key
            ),

          enabled:
            body.enabled ===
            undefined
              ? true
              : !!body.enabled,

          config:
            body.config &&
            typeof body.config ===
              "object"
              ? body.config
              : {}
        });

      res.json({
        ok: true,

        provider: {
          ...provider,

          apiKey:
            provider.apiKey
              ? "••••••••"
              : "",

          hasApiKey:
            !!provider.apiKey
        }
      });
    } catch (error) {
      console.error(
        "[ADD PROVIDER]",
        error
      );

      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

app.put(
  "/api/admin/providers/:id",
  admin,
  async (req, res) => {
    try {
      const body =
        req.body || {};

      const updates =
        {};

      if (
        body.category !==
        undefined
      ) {
        updates.category =
          body.category;
      }

      if (
        body.providerName !==
        undefined
      ) {
        updates.providerName =
          body.providerName;
      }

      /*
        If browser sends masked
        API key, keep old key.
      */

      if (
        body.apiKey !==
          undefined &&
        !String(
          body.apiKey
        ).startsWith("••")
      ) {
        updates.apiKey =
          body.apiKey;
      }

      if (
        body.enabled !==
        undefined
      ) {
        updates.enabled =
          !!body.enabled;
      }

      if (
        body.config !==
        undefined
      ) {
        updates.config =
          body.config;
      }

      const provider =
        await updateProvider(
          req.params.id,
          updates
        );

      res.json({
        ok: true,

        provider: {
          ...provider,

          apiKey:
            provider.apiKey
              ? "••••••••"
              : "",

          hasApiKey:
            !!provider.apiKey
        }
      });
    } catch (error) {
      console.error(
        "[UPDATE PROVIDER]",
        error
      );

      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

app.delete(
  "/api/admin/providers/:id",
  admin,
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
   ADMIN SETTINGS
========================================================= */

app.get(
  "/api/admin/settings",
  admin,
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
  admin,
  async (req, res) => {
    try {
      const body =
        req.body || {};

      const current =
        await getSettings();

      const saved =
        await saveSettings({
          autoPost:
            body.autoPost !==
            undefined
              ? !!body.autoPost
              : body.autoPostEnabled !==
                undefined
              ? !!body.autoPostEnabled
              : current.autoPost,

          postIntervalMinutes:
            body.postIntervalMinutes !==
            undefined
              ? safeNumber(
                  body.postIntervalMinutes,
                  60
                )
              : current.postIntervalMinutes,

          postsPerRun:
            body.postsPerRun !==
            undefined
              ? safeNumber(
                  body.postsPerRun,
                  1
                )
              : current.postsPerRun,

          copyGateSeconds:
            body.copyGateSeconds !==
            undefined
              ? safeNumber(
                  body.copyGateSeconds,
                  10
                )
              : current.copyGateSeconds,

          directLink:
            body.directLink !==
            undefined
              ? clean(
                  body.directLink
                )
              : current.directLink
        });

      res.json(
        saved
      );
    } catch (error) {
      console.error(
        "[SETTINGS]",
        error
      );

      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   ADMIN ADS
========================================================= */

app.get(
  "/api/admin/ads",
  admin,
  async (req, res) => {
    try {
      res.json(
        await getAds()
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
  admin,
  async (req, res) => {
    try {
      const ads =
        req.body || {};

      const saved =
        await saveAds(
          ads
        );

      res.json(
        saved
      );
    } catch (error) {
      console.error(
        "[ADS]",
        error
      );

      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   MANUAL AUTO-POST / COLLECT
========================================================= */

app.post(
  "/api/admin/collect",
  admin,
  async (req, res) => {
    try {
      const result =
        await createAutomaticPost();

      res.json(
        result
      );
    } catch (error) {
      console.error(
        "[MANUAL AUTO POST]",
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
   AUTOMATIC POST SCHEDULER
========================================================= */

let schedulerRunning =
  false;

async function runScheduler() {
  if (schedulerRunning) {
    return;
  }

  schedulerRunning = true;

  try {
    const settings =
      await getSettings();

    if (
      settings.autoPost ===
      false
    ) {
      return;
    }

    const interval =
      Math.max(
        1,
        safeNumber(
          settings.postIntervalMinutes,
          60
        )
      );

    const providers =
      await getProviders();

    const hasTrending =
      providersFor(
        providers,
        "trending_search"
      ).length > 0;

    const hasPrompt =
      providersFor(
        providers,
        "prompt_generate"
      ).length > 0;

    const hasPhoto =
      providersFor(
        providers,
        "photo_generate"
      ).length > 0;

    if (
      !hasPrompt ||
      !hasPhoto
    ) {
      console.log(
        "[AUTO] Waiting: Prompt Generate and Photo Generate APIs are required."
      );

      return;
    }

    console.log(
      `[AUTO] Automatic posting cycle started. Trending API: ${hasTrending ? "yes" : "creative seed"}`
    );

    const count =
      Math.max(
        1,
        Math.min(
          20,
          safeNumber(
            settings.postsPerRun,
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
        await createAutomaticPost();
      } catch (error) {
        console.error(
          "[AUTO ERROR]",
          error.message
        );
      }
    }

    console.log(
      `[AUTO] Next scheduled cycle target: ${interval} minute(s).`
    );
  } catch (error) {
    console.error(
      "[SCHEDULER]",
      error.message
    );
  } finally {
    schedulerRunning =
      false;
  }
}

/*
  Check every minute.
  The actual interval is read from
  Supabase settings.

  This means admin can change:
  60 minutes -> 30 minutes -> 10 minutes
  without changing server.js.
*/

let lastAutomaticRun = 0;

setInterval(
  async () => {
    try {
      const settings =
        await getSettings();

      if (
        settings.autoPost ===
        false
      ) {
        return;
      }

      const intervalMs =
        Math.max(
          1,
          safeNumber(
            settings.postIntervalMinutes,
            60
          )
        ) *
        60 *
        1000;

      if (
        Date.now() -
          lastAutomaticRun <
        intervalMs
      ) {
        return;
      }

      lastAutomaticRun =
        Date.now();

      await runScheduler();
    } catch (error) {
      console.error(
        "[AUTO TIMER]",
        error.message
      );
    }
  },
  60 * 1000
);

/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/health",
  async (req, res) => {
    res.json({
      ok: true,
      database:
        "Supabase PostgreSQL",
      cloudinary:
        cloudinaryEnabled,
      time:
        new Date().toISOString()
    });
  }
);

/* =========================================================
   404 API
========================================================= */

app.use(
  "/api",
  (req, res) => {
    res.status(404).json({
      error:
        "API endpoint not found"
    });
  }
);

/* =========================================================
   FRONTEND FALLBACK
========================================================= */

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
   START
========================================================= */

app.listen(
  PORT,
  () => {
    console.log(
      "=========================================="
    );

    console.log(
      "PromptForge server started"
    );

    console.log(
      `Port: ${PORT}`
    );

    console.log(
      "Database: Supabase PostgreSQL"
    );

    console.log(
      `Cloudinary: ${
        cloudinaryEnabled
          ? "enabled"
          : "disabled"
      }`
    );

    console.log(
      "API categories:"
    );

    console.log(
      "1. Trending Search"
    );

    console.log(
      "2. Prompt Generate"
    );

    console.log(
      "3. Photo / Image Generate"
    );

    console.log(
      "Custom API: enabled"
    );

    console.log(
      "Unlimited API rotation: enabled"
    );

    console.log(
      "Automatic fallback: enabled"
    );

    console.log(
      "=========================================="
    );
  }
);
