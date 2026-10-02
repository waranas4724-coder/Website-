require("dotenv").config();

const express = require("express");
const session = require("express-session");
const crypto = require("crypto");
const path = require("path");

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

const cloudinary = require("cloudinary").v2;

const app = express();

const PORT =
  process.env.PORT || 3000;


/* =========================================================
   CLOUDINARY
========================================================= */

const CLOUDINARY_ENABLED =
  !!(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );

if (CLOUDINARY_ENABLED) {
  cloudinary.config({
    cloud_name:
      process.env.CLOUDINARY_CLOUD_NAME,

    api_key:
      process.env.CLOUDINARY_API_KEY,

    api_secret:
      process.env.CLOUDINARY_API_SECRET
  });

  console.log(
    "Cloudinary storage enabled."
  );
} else {
  console.warn(
    "Cloudinary storage disabled: missing environment variables."
  );
}


/* =========================================================
   EXPRESS
========================================================= */

app.set(
  "trust proxy",
  1
);

app.disable(
  "x-powered-by"
);

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
  express.static(
    path.join(
      __dirname,
      "public"
    )
  )
);


/* =========================================================
   SESSION
========================================================= */

const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  crypto.randomBytes(32).toString("hex");

if (!process.env.SESSION_SECRET) {
  console.warn(
    "WARNING: SESSION_SECRET is not set."
  );
}

app.use(
  session({
    secret: SESSION_SECRET,

    resave: false,

    saveUninitialized: false,

    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: "auto",
      maxAge:
        8 * 60 * 60 * 1000
    }
  })
);


/* =========================================================
   HELPERS
========================================================= */

function clean(
  value,
  fallback = ""
) {
  if (
    value === undefined ||
    value === null
  ) {
    return fallback;
  }

  return String(value).trim();
}


function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
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


function uniqueTitle(
  title,
  existing
) {
  const base =
    clean(title) ||
    "AI Visual";

  const same =
    existing.filter(
      x =>
        String(x.title || "")
          .toLowerCase() ===
        base.toLowerCase()
    ).length;

  return same
    ? `${base} ${same + 1}`
    : base;
}


function providerNameMatches(
  provider,
  ...names
) {
  const current =
    clean(
      provider.providerName ||
      provider.provider_name
    ).toLowerCase();

  return names.some(
    name =>
      current ===
      String(name)
        .toLowerCase()
  );
}


function getPathValue(
  object,
  pathString
) {
  if (
    !pathString
  ) {
    return object;
  }

  return String(pathString)
    .split(".")
    .filter(Boolean)
    .reduce(
      (value, key) => {

        if (
          value === null ||
          value === undefined
        ) {
          return undefined;
        }

        if (
          Array.isArray(value) &&
          /^\d+$/.test(key)
        ) {
          return value[
            Number(key)
          ];
        }

        return value[key];

      },
      object
    );
}


function replaceTemplate(
  value,
  vars = {}
) {
  if (
    typeof value ===
    "string"
  ) {
    return value
      .replace(
        /\{\{\s*prompt\s*\}\}/gi,
        vars.prompt || ""
      )
      .replace(
        /\{\{\s*topic\s*\}\}/gi,
        vars.topic || ""
      )
      .replace(
        /\{\{\s*query\s*\}\}/gi,
        vars.query || ""
      )
      .replace(
        /\{\{\s*title\s*\}\}/gi,
        vars.title || ""
      );
  }

  if (
    Array.isArray(value)
  ) {
    return value.map(
      item =>
        replaceTemplate(
          item,
          vars
        )
    );
  }

  if (
    value &&
    typeof value ===
      "object"
  ) {
    const result = {};

    for (
      const [
        key,
        item
      ] of Object.entries(value)
    ) {
      result[key] =
        replaceTemplate(
          item,
          vars
        );
    }

    return result;
  }

  return value;
}


function appendQuery(
  url,
  query
) {
  const u =
    new URL(url);

  for (
    const [
      key,
      value
    ] of Object.entries(
      query || {}
    )
  ) {
    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      u.searchParams.set(
        key,
        String(value)
      );
    }
  }

  return u.toString();
}


async function fetchJson(
  url,
  options = {}
) {
  const response =
    await fetch(
      url,
      {
        ...options,

        signal:
          options.signal ||
          AbortSignal.timeout(
            30000
          )
      }
    );

  const text =
    await response.text();

  let data;

  try {
    data =
      JSON.parse(text);
  } catch {
    data = {
      text
    };
  }

  if (
    !response.ok
  ) {
    throw new Error(
      `HTTP ${response.status}`
    );
  }

  return data;
}


async function fetchBinary(
  url
) {
  const response =
    await fetch(
      url,
      {
        signal:
          AbortSignal.timeout(
            60000
          )
      }
    );

  if (
    !response.ok
  ) {
    throw new Error(
      `Image HTTP ${response.status}`
    );
  }

  const buffer =
    Buffer.from(
      await response.arrayBuffer()
    );

  return buffer;
}


/* =========================================================
   ADMIN
========================================================= */

const admin = (
  req,
  res,
  next
) => {
  if (
    req.session &&
    req.session.admin
  ) {
    return next();
  }

  return res
    .status(401)
    .json({
      error:
        "Unauthorized"
    });
};


/* =========================================================
   LOGIN
========================================================= */

const failedLogins =
  new Map();


function hashValue(
  value
) {
  return crypto
    .createHash("sha256")
    .update(
      String(value)
    )
    .digest();
}


function safeCompare(
  a,
  b
) {
  const x =
    hashValue(a);

  const y =
    hashValue(b);

  return crypto.timingSafeEqual(
    x,
    y
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

    const expectedUser =
      process.env.ADMIN_USERNAME ||
      "admin";

    const expectedPassword =
      process.env.ADMIN_PASSWORD;

    if (
      !expectedPassword
    ) {
      return res
        .status(503)
        .json({
          error:
            "ADMIN_PASSWORD is not configured."
        });
    }

    const key =
      req.ip || "unknown";

    const failed =
      failedLogins.get(key) || {
        count: 0,
        time: 0
      };

    if (
      failed.count >= 5 &&
      Date.now() -
        failed.time <
        15 * 60 * 1000
    ) {
      return res
        .status(429)
        .json({
          error:
            "Too many attempts."
        });
    }

    if (
      safeCompare(
        username,
        expectedUser
      ) &&
      safeCompare(
        password,
        expectedPassword
      )
    ) {
      failedLogins.delete(
        key
      );

      req.session.admin =
        true;

      return res.json({
        ok: true
      });
    }

    failedLogins.set(
      key,
      {
        count:
          failed.count + 1,
        time: Date.now()
      }
    );

    return res
      .status(401)
      .json({
        error:
          "Invalid credentials."
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
   PUBLIC PROMPTS
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

      const media =
        clean(
          req.query.media
        ).toLowerCase();

      const category =
        clean(
          req.query.category
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

            if (
              q &&
              !text.includes(q)
            ) {
              return false;
            }

            if (
              media &&
              media !== "all" &&
              String(
                item.media || ""
              ).toLowerCase() !==
                media
            ) {
              return false;
            }

            if (
              category &&
              category !== "all" &&
              String(
                item.category ||
                  ""
              ).toLowerCase() !==
                category
            ) {
              return false;
            }

            return true;
          }
        );

      res.json(
        filtered
      );

    } catch (error) {

      console.error(
        "Prompts:",
        error
      );

      res.status(500).json({
        error:
          "Failed to load prompts."
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

      res.json(
        prompt
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
  admin,
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
              "Title and prompt are required."
          });
      }

      const item =
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
        item
      );

    } catch (error) {

      console.error(
        "Manual publish:",
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
   API PROVIDERS
========================================================= */

app.get(
  "/api/admin/providers",
  admin,
  async (req, res) => {

    try {

      const providers =
        await getProviders();

      res.json(
        providers
      );

    } catch (error) {

      console.error(
        "Providers:",
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

      if (
        !body.category
      ) {
        return res
          .status(400)
          .json({
            error:
              "Category required."
          });
      }

      if (
        !body.providerName
      ) {
        return res
          .status(400)
          .json({
            error:
              "Provider name required."
          });
      }

      const provider =
        await addProvider({
          category:
            body.category,

          providerName:
            body.providerName,

          apiKey:
            body.apiKey ||
            "",

          enabled:
            body.enabled !== false,

          config:
            body.config || {}
        });

      res.json(
        provider
      );

    } catch (error) {

      console.error(
        "Add provider:",
        error
      );

      res.status(500).json({
        error:
          error.message
      });
    }
  }
);


app.patch(
  "/api/admin/providers/:id",
  admin,
  async (req, res) => {

    try {

      const provider =
        await updateProvider(
          req.params.id,
          req.body || {}
        );

      res.json(
        provider
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
   SETTINGS
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

      const settings =
        await saveSettings({
          autoPost:
            body.autoPost,

          postIntervalMinutes:
            body.postIntervalMinutes,

          postsPerRun:
            body.postsPerRun,

          copyGateSeconds:
            body.copyGateSeconds,

          directLink:
            body.directLink
        });

      restartAutomation();

      res.json(
        settings
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
   ADS
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

      res.json(
        await saveAds(
          req.body || {}
        )
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
  "/api/ads",
  async (req, res) => {

    try {

      res.set(
        "Cache-Control",
        "no-store"
      );

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


/* =========================================================
   GENERIC CUSTOM API
========================================================= */

async function customApiRequest(
  provider,
  variables = {}
) {

  const config =
    provider.config || {};

  if (
    !config.endpoint
  ) {
    throw new Error(
      "Custom API endpoint missing."
    );
  }

  let url =
    replaceTemplate(
      config.endpoint,
      variables
    );

  const method =
    String(
      config.method ||
      "GET"
    ).toUpperCase();

  let headers = {
    Accept:
      "application/json"
  };

  const customHeaders =
    replaceTemplate(
      config.headers || {},
      variables
    );

  Object.assign(
    headers,
    customHeaders
  );

  const apiKey =
    provider.apiKey ||
    "";

  const authType =
    String(
      config.authType ||
      "bearer"
    ).toLowerCase();

  if (
    apiKey &&
    authType === "bearer"
  ) {
    headers.Authorization =
      `Bearer ${apiKey}`;
  }

  if (
    apiKey &&
    (
      authType ===
        "x-api-key" ||
      authType ===
        "x_api_key"
    )
  ) {
    headers["X-API-Key"] =
      apiKey;
  }

  let query =
    replaceTemplate(
      config.query || {},
      variables
    );

  if (
    !query ||
    typeof query !==
      "object"
  ) {
    query = {};
  }

  if (
    apiKey &&
    authType === "query"
  ) {
    query[
      config.apiKeyQueryName ||
      "api_key"
    ] = apiKey;
  }

  url =
    appendQuery(
      url,
      query
    );

  const options = {
    method,
    headers,
    signal:
      AbortSignal.timeout(
        30000
      )
  };

  if (
    method !== "GET" &&
    method !== "HEAD"
  ) {

    const body =
      replaceTemplate(
        config.body || {},
        variables
      );

    headers["Content-Type"] =
      headers["Content-Type"] ||
      "application/json";

    options.body =
      typeof body ===
        "string"
        ? body
        : JSON.stringify(
            body
          );
  }

  return fetchJson(
    url,
    options
  );
}


/* =========================================================
   CUSTOM TRENDING
========================================================= */

async function customTrending(
  provider,
  query = ""
) {

  const data =
    await customApiRequest(
      provider,
      {
        query,
        topic: query
      }
    );

  let result =
    provider.config?.responsePath
      ? getPathValue(
          data,
          provider.config
            .responsePath
        )
      : data;

  if (
    !Array.isArray(result)
  ) {

    result =
      Array.isArray(
        data?.results
      )
        ? data.results
        : Array.isArray(
            data?.data
          )
          ? data.data
          : [data];
  }

  const topicPath =
    provider.config
      ?.topicPath ||
    "title";

  return result
    .map(item => {

      if (
        typeof item ===
        "string"
      ) {
        return {
          title: item,
          topic: item
        };
      }

      const title =
        getPathValue(
          item,
          topicPath
        ) ||
        item?.title ||
        item?.name ||
        item?.topic ||
        item?.query;

      if (!title) {
        return null;
      }

      return {
        title:
          String(title)
            .trim(),

        topic:
          String(title)
            .trim(),

        raw:
          item
      };

    })
    .filter(Boolean);
}


/* =========================================================
   CUSTOM PROMPT
========================================================= */

async function customPrompt(
  provider,
  topic
) {

  const data =
    await customApiRequest(
      provider,
      {
        topic,
        query: topic,
        prompt: topic
      }
    );

  let result =
    provider.config?.responsePath
      ? getPathValue(
          data,
          provider.config
            .responsePath
        )
      : data;

  if (
    Array.isArray(result)
  ) {
    result =
      result[0];
  }

  const promptPath =
    provider.config
      ?.promptPath ||
    "prompt";

  const prompt =
    getPathValue(
      result,
      promptPath
    ) ||
    result?.text ||
    result?.content ||
    data?.prompt ||
    data?.text;

  if (!prompt) {
    throw new Error(
      "Custom API prompt response not found."
    );
  }

  const title =
    result?.title ||
    data?.title ||
    `AI Visual Concept - ${topic}`;

  return {
    title:
      String(title).trim(),

    prompt:
      String(prompt).trim(),

    raw:
      data
  };
}


/* =========================================================
   CUSTOM IMAGE
========================================================= */

async function customImage(
  provider,
  prompt
) {

  const data =
    await customApiRequest(
      provider,
      {
        prompt,
        query: prompt,
        topic: prompt
      }
    );

  let result =
    provider.config?.responsePath
      ? getPathValue(
          data,
          provider.config
            .responsePath
        )
      : data;

  if (
    Array.isArray(result)
  ) {
    result =
      result[0];
  }

  const imagePath =
    provider.config
      ?.imagePath ||
    "image";

  const imageUrl =
    getPathValue(
      result,
      imagePath
    ) ||
    result?.url ||
    result?.image_url ||
    result?.image ||
    data?.url ||
    data?.image_url;

  if (!imageUrl) {
    throw new Error(
      "Custom API image URL not found."
    );
  }

  return {
    imageUrl:
      String(imageUrl).trim(),

    raw:
      data
  };
}


/* =========================================================
   TRENDING API ADAPTERS
========================================================= */

async function newsData(
  provider
) {

  if (!provider.apiKey) {
    throw new Error(
      "NewsData.io API key missing."
    );
  }

  const url =
    "https://newsdata.io/api/1/latest" +
    `?apikey=${encodeURIComponent(
      provider.apiKey
    )}&language=en&size=10`;

  const data =
    await fetchJson(
      url
    );

  return (
    data.results || []
  )
    .map(
      x => ({
        title:
          x.title,

        topic:
          x.title,

        raw:
          x
      })
    )
    .filter(
      x => x.title
    );
}


async function gNews(
  provider
) {

  if (!provider.apiKey) {
    throw new Error(
      "GNews API key missing."
    );
  }

  const url =
    "https://gnews.io/api/v4/top-headlines" +
    `?token=${encodeURIComponent(
      provider.apiKey
    )}&lang=en&max=10`;

  const data =
    await fetchJson(
      url
    );

  return (
    data.articles || []
  )
    .map(
      x => ({
        title:
          x.title,

        topic:
          x.title,

        raw:
          x
      })
    )
    .filter(
      x => x.title
    );
}


async function reddit(
  provider
) {

  const headers = {
    "User-Agent":
      "PromptForge/1.0"
  };

  if (
    provider.apiKey
  ) {
    headers.Authorization =
      `Bearer ${provider.apiKey}`;
  }

  const data =
    await fetchJson(
      "https://www.reddit.com/r/popular.json?limit=10",
      {
        headers
      }
    );

  return (
    data?.data?.children ||
    []
  )
    .map(
      x => ({
        title:
          x?.data?.title,

        topic:
          x?.data?.title,

        raw:
          x?.data
      })
    )
    .filter(
      x => x.title
    );
}


async function youtube(
  provider
) {

  if (!provider.apiKey) {
    throw new Error(
      "YouTube API key missing."
    );
  }

  const url =
    "https://www.googleapis.com/youtube/v3/videos" +
    "?part=snippet&chart=mostPopular&regionCode=US&maxResults=10" +
    `&key=${encodeURIComponent(
      provider.apiKey
    )}`;

  const data =
    await fetchJson(
      url
    );

  return (
    data.items || []
  )
    .map(
      x => ({
        title:
          x?.snippet?.title,

        topic:
          x?.snippet?.title,

        raw:
          x
      })
    )
    .filter(
      x => x.title
    );
}


async function xTwitter(
  provider
) {

  if (!provider.apiKey) {
    throw new Error(
      "X/Twitter Bearer Token missing."
    );
  }

  const data =
    await fetchJson(
      "https://api.x.com/2/trends/by/woeid/1",
      {
        headers: {
          Authorization:
            `Bearer ${provider.apiKey}`
        }
      }
    );

  const trends =
    Array.isArray(data)
      ? data
      : data?.data ||
        data?.trends ||
        [];

  return trends
    .map(
      x => ({
        title:
          x.name ||
          x.trend_name,

        topic:
          x.name ||
          x.trend_name,

        raw:
          x
      })
    )
    .filter(
      x => x.title
    );
}


async function bluesky(
  provider
) {

  const data =
    await fetchJson(
      "https://public.api.bsky.app/xrpc/app.bsky.feed.getFeed?feed=at%3A%2F%2Fdid%3Aplc%3Az72i7hdynmk6r22z27t6tv6y%2Fapp.bsky.feed.generator%2Fwhats-hot&limit=10"
    );

  return (
    data.feed || []
  )
    .map(
      x => ({
        title:
          x?.post?.record?.text,

        topic:
          x?.post?.record?.text,

        raw:
          x
      })
    )
    .filter(
      x => x.title
    );
}


/* =========================================================
   GEMINI
========================================================= */

async function geminiPrompt(
  provider,
  topic,
  category
) {

  if (!provider.apiKey) {
    throw new Error(
      "Gemini API key missing."
    );
  }

  const model =
    provider.config?.model ||
    "gemini-3.5-flash-lite";

  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(
      provider.apiKey
    )}`;

  const instruction = `
Create one original premium AI visual concept.

Topic:
${topic}

Category:
${category}

Return ONLY valid JSON:

{
  "title": "...",
  "category": "...",
  "prompt": "..."
}

The prompt must be a detailed image-generation prompt.

Include:
subject,
composition,
camera,
lens,
lighting,
environment,
materials,
color grading,
atmosphere,
photorealism,
fine details.

Do not copy an existing artwork.
Do not include copyrighted character names.
`;

  const data =
    await fetchJson(
      endpoint,
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    text:
                      instruction
                  }
                ]
              }
            ],

            generationConfig: {
              temperature:
                0.9,

              responseMimeType:
                "application/json"
            }
          })
      }
    );

  const text =
    data?.candidates?.[0]
      ?.content?.parts?.[0]
      ?.text;

  if (!text) {
    throw new Error(
      "Gemini returned no text."
    );
  }

  let result;

  try {
    result =
      JSON.parse(text);
  } catch {

    const cleaned =
      text
        .replace(
          /^```json/i,
          ""
        )
        .replace(
          /^```/i,
          ""
        )
        .replace(
          /```$/i,
          ""
        )
        .trim();

    result =
      JSON.parse(
        cleaned
      );
  }

  if (
    !result.prompt
  ) {
    throw new Error(
      "Gemini returned no prompt."
    );
  }

  return {
    title:
      result.title ||
      `AI Visual - ${topic}`,

    category:
      result.category ||
      category,

    prompt:
      result.prompt
  };
}


/* =========================================================
   POLLINATIONS
========================================================= */

async function pollinationsImage(
  provider,
  prompt
) {

  const encoded =
    encodeURIComponent(
      prompt
    );

  const url =
    `https://image.pollinations.ai/prompt/${encoded}` +
    "?width=1024&height=1024&nologo=true";

  const response =
    await fetch(
      url,
      {
        signal:
          AbortSignal.timeout(
            90000
          )
      }
    );

  if (
    !response.ok
  ) {
    throw new Error(
      `Pollinations HTTP ${response.status}`
    );
  }

  const buffer =
    Buffer.from(
      await response.arrayBuffer()
    );

  return uploadImage(
    buffer,
    "pollinations"
  );
}


/* =========================================================
   HUGGING FACE
========================================================= */

async function huggingFaceImage(
  provider,
  prompt
) {

  if (!provider.apiKey) {
    throw new Error(
      "Hugging Face API key missing."
    );
  }

  const model =
    provider.config?.model ||
    "black-forest-labs/FLUX.1-schnell";

  const url =
    `https://router.huggingface.co/hf-inference/models/${model}`;

  const response =
    await fetch(
      url,
      {
        method:
          "POST",

        headers: {
          Authorization:
            `Bearer ${provider.apiKey}`,

          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            inputs:
              prompt
          }),

        signal:
          AbortSignal.timeout(
            120000
          )
      }
    );

  if (
    !response.ok
  ) {
    throw new Error(
      `Hugging Face HTTP ${response.status}`
    );
  }

  const buffer =
    Buffer.from(
      await response.arrayBuffer()
    );

  return uploadImage(
    buffer,
    "huggingface"
  );
}


/* =========================================================
   CLOUDINARY UPLOAD
========================================================= */

async function uploadImage(
  buffer,
  folder
) {

  if (
    !CLOUDINARY_ENABLED
  ) {
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
        cloudinary.uploader
          .upload_stream(
            {
              folder:
                `promptforge/${folder}`,

              resource_type:
                "image"
            },

            (
              error,
              result
            ) => {

              if (error) {
                reject(
                  error
                );
                return;
              }

              resolve({
                imageUrl:
                  result.secure_url,

                publicId:
                  result.public_id
              });

            }
          );

      upload.end(
        buffer
      );

    }
  );
}


/* =========================================================
   TREND PROVIDER ROTATION
========================================================= */

let trendIndex = 0;
let promptIndex = 0;
let photoIndex = 0;


function nextProvider(
  providers,
  type
) {

  const enabled =
    providers.filter(
      p =>
        p.enabled !== false
    );

  if (!enabled.length) {
    throw new Error(
      `No enabled ${type} provider.`
    );
  }

  let index;

  if (
    type ===
    "trending_search"
  ) {
    index =
      trendIndex %
      enabled.length;

    trendIndex++;
  }

  else if (
    type ===
    "prompt_generate"
  ) {
    index =
      promptIndex %
      enabled.length;

    promptIndex++;
  }

  else {
    index =
      photoIndex %
      enabled.length;

    photoIndex++;
  }

  return {
    provider:
      enabled[index],

    index,

    enabled
  };
}


/* =========================================================
   TRENDING PROVIDER CALL
========================================================= */

async function runTrendingProvider(
  provider
) {

  const name =
    clean(
      provider.providerName
    ).toLowerCase();


  if (
    name ===
    "newsdata.io"
  ) {
    return newsData(
      provider
    );
  }


  if (
    name ===
    "gnews"
  ) {
    return gNews(
      provider
    );
  }


  if (
    name ===
    "reddit"
  ) {
    return reddit(
      provider
    );
  }


  if (
    name ===
    "youtube"
  ) {
    return youtube(
      provider
    );
  }


  if (
    name ===
      "x/twitter" ||
    name ===
      "x / twitter" ||
    name === "twitter"
  ) {
    return xTwitter(
      provider
    );
  }


  if (
    name ===
    "bluesky"
  ) {
    return bluesky(
      provider
    );
  }


  if (
    name ===
    "custom"
  ) {
    return customTrending(
      provider,
      "trending"
    );
  }


  /*
   * Unknown provider with
   * Custom configuration:
   * treat it as Custom.
   */

  if (
    provider.config?.endpoint
  ) {
    return customTrending(
      provider,
      "trending"
    );
  }


  throw new Error(
    `No adapter for ${provider.providerName}`
  );
}


/* =========================================================
   PROMPT PROVIDER CALL
========================================================= */

async function runPromptProvider(
  provider,
  topic,
  category
) {

  const name =
    clean(
      provider.providerName
    ).toLowerCase();


  if (
    name === "gemini" ||
    name ===
      "google gemini"
  ) {
    return geminiPrompt(
      provider,
      topic,
      category
    );
  }


  if (
    name ===
    "custom"
  ) {
    return customPrompt(
      provider,
      topic
    );
  }


  if (
    provider.config?.endpoint
  ) {
    return customPrompt(
      provider,
      topic
    );
  }


  throw new Error(
    `No prompt adapter for ${provider.providerName}`
  );
}


/* =========================================================
   IMAGE PROVIDER CALL
========================================================= */

async function runImageProvider(
  provider,
  prompt
) {

  const name =
    clean(
      provider.providerName
    ).toLowerCase();


  if (
    name ===
    "pollinations"
  ) {
    return pollinationsImage(
      provider,
      prompt
    );
  }


  if (
    name ===
    "hugging face" ||
    name ===
    "huggingface"
  ) {
    return huggingFaceImage(
      provider,
      prompt
    );
  }


  if (
    name ===
    "custom"
  ) {
    return customImage(
      provider,
      prompt
    );
  }


  if (
    provider.config?.endpoint
  ) {
    return customImage(
      provider,
      prompt
    );
  }


  throw new Error(
    `No image adapter for ${provider.providerName}`
  );
}


/* =========================================================
   PROVIDER FALLBACK
========================================================= */

async function tryProviders(
  providers,
  type,
  runner
) {

  const enabled =
    providers.filter(
      p =>
        p.enabled !== false
    );

  if (!enabled.length) {
    throw new Error(
      `No enabled ${type} APIs.`
    );
  }

  let selected;

  try {
    selected =
      nextProvider(
        enabled,
        type
      );
  } catch {
    selected = {
      provider:
        enabled[0],
      enabled
    };
  }


  const ordered = [
    selected.provider,

    ...enabled.filter(
      p =>
        p.id !==
        selected.provider.id
    )
  ];


  let lastError;


  for (
    const provider
    of ordered
  ) {

    try {

      console.log(
        `[API] ${type}: trying ${provider.providerName}`
      );

      const result =
        await runner(
          provider
        );

      console.log(
        `[API] ${type}: success ${provider.providerName}`
      );

      return {
        result,
        provider
      };

    } catch (error) {

      lastError =
        error;

      console.error(
        `[API] ${type}: ${provider.providerName} failed: ${error.message}`
      );
    }
  }


  throw lastError ||
    new Error(
      `${type} failed`
    );
}


/* =========================================================
   CREATIVE CATEGORIES
========================================================= */

const CREATIVE_CATEGORIES = [

  "Portrait Photography",
  "Fashion Photography",
  "Commercial Photography",
  "Product Photography",
  "Brand Design",
  "Architecture",
  "Interior Design",
  "Travel Photography",
  "Nature Photography",
  "Cinematic Photography",
  "Automotive",
  "Food Photography",
  "Editorial",
  "Fantasy Art",
  "Digital Art",
  "Graphic Design",
  "Lifestyle",
  "Luxury",
  "Minimalist",
  "Surreal Art"

];


const CREATIVE_SEEDS = [

  "luxury editorial portrait",

  "cinematic street photography",

  "futuristic architecture",

  "premium fashion campaign",

  "minimal product photography",

  "dreamlike landscape",

  "luxury automotive campaign",

  "modern interior design",

  "creative food photography",

  "editorial lifestyle photography",

  "surreal fine art portrait",

  "premium brand campaign",

  "travel destination photography",

  "cinematic night scene",

  "high-end beauty photography",

  "futuristic product advertisement",

  "artistic architecture photography",

  "minimalist studio photography",

  "fantasy cinematic environment",

  "modern graphic design poster"

];


function randomItem(
  list
) {
  return list[
    Math.floor(
      Math.random() *
        list.length
    )
  ];
}


/* =========================================================
   DUPLICATE CHECK
========================================================= */

function normalizeText(
  value
) {
  return String(
    value || ""
  )
    .toLowerCase()
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}


function duplicateExists(
  posts,
  title,
  prompt
) {

  const titleKey =
    normalizeText(
      title
    );

  const promptKey =
    normalizeText(
      prompt
    );

  return posts.some(
    post =>
      normalizeText(
        post.title
      ) ===
        titleKey ||
      normalizeText(
        post.prompt
      ) ===
        promptKey
  );
}


/* =========================================================
   AUTOMATIC POST
========================================================= */

async function createAutomaticPost() {

  const providers =
    await getProviders();


  const trendProviders =
    providers.filter(
      p =>
        p.category ===
        "trending_search"
    );


  const promptProviders =
    providers.filter(
      p =>
        p.category ===
        "prompt_generate"
    );


  const photoProviders =
    providers.filter(
      p =>
        p.category ===
        "photo_generate"
    );


  console.log(
    `[AUTO] Providers: trending=${trendProviders.length}, prompt=${promptProviders.length}, photo=${photoProviders.length}`
  );


  let trendTopic =
    randomItem(
      CREATIVE_SEEDS
    );


  /*
   * Trending API is optional.
   * If all trend APIs fail,
   * creative seed is used.
   */

  if (
    trendProviders.length
  ) {

    try {

      const trend =
        await tryProviders(
          trendProviders,
          "trending_search",
          provider =>
            runTrendingProvider(
              provider
            )
        );

      const items =
        trend.result || [];

      if (
        items.length
      ) {

        const selected =
          randomItem(
            items
          );

        trendTopic =
          selected.topic ||
          selected.title ||
          trendTopic;

      }

    } catch (error) {

      console.warn(
        `[AUTO] Trending failed, using creative seed: ${error.message}`
      );

    }

  }


  const category =
    randomItem(
      CREATIVE_CATEGORIES
    );


  console.log(
    `[AUTO] Topic: ${trendTopic}`
  );


  /*
   * PROMPT
   */

  if (
    !promptProviders.length
  ) {
    throw new Error(
      "No Prompt Generate API configured."
    );
  }


  const promptResult =
    await tryProviders(
      promptProviders,
      "prompt_generate",
      provider =>
        runPromptProvider(
          provider,
          trendTopic,
          category
        )
    );


  const visual =
    promptResult.result;


  /*
   * IMAGE
   */

  if (
    !photoProviders.length
  ) {
    throw new Error(
      "No Photo Generate API configured."
    );
  }


  const imageResult =
    await tryProviders(
      photoProviders,
      "photo_generate",
      provider =>
        runImageProvider(
          provider,
          visual.prompt
        )
    );


  const image =
    imageResult.result;


  /*
   * DUPLICATE CHECK
   */

  const existing =
    await getPrompts();


  if (
    duplicateExists(
      existing,
      visual.title,
      visual.prompt
    )
  ) {

    console.log(
      "[AUTO] Duplicate detected. Skipping."
    );

    return {
      added: false,
      reason:
        "duplicate"
    };
  }


  /*
   * SAVE
   */

  const item =
    await addPrompt({

      slug:
        slugify(
          visual.title
        ) +
        "-" +
        Date.now()
          .toString(36),

      title:
        uniqueTitle(
          visual.title,
          existing
        ),

      prompt:
        visual.prompt,

      category:
        visual.category ||
        category,

      media:
        "Image",

      imageUrl:
        image.imageUrl,

      model:
        promptResult.provider
          .providerName,

      source:
        "AI Visual Inspiration"

    });


  console.log(
    `[AUTO] Published: ${item.title}`
  );

  console.log(
    `[AUTO] Prompt API: ${promptResult.provider.providerName}`
  );

  console.log(
    `[AUTO] Image API: ${imageResult.provider.providerName}`
  );


  return {
    added: true,

    post:
      item,

    trendProvider:
      null,

    promptProvider:
      promptResult.provider
        .providerName,

    imageProvider:
      imageResult.provider
        .providerName
  };
}


/* =========================================================
   ADMIN RUN NOW
========================================================= */

app.post(
  "/api/admin/collect",
  admin,
  async (req, res) => {

    try {

      const settings =
        await getSettings();

      const count =
        Math.max(
          1,
          Number(
            settings.postsPerRun
          ) || 1
        );

      const results = [];

      for (
        let i = 0;
        i < count;
        i++
      ) {

        try {

          results.push(
            await createAutomaticPost()
          );

        } catch (error) {

          results.push({
            added: false,
            error:
              error.message
          });

        }

      }

      res.json({
        ok: true,
        results
      });

    } catch (error) {

      console.error(
        "[ADMIN RUN]",
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
   AUTOMATION
========================================================= */

let automationTimer =
  null;


async function automationTick() {

  try {

    const settings =
      await getSettings();

    if (
      settings.autoPost !== true
    ) {
      console.log(
        "[AUTO] Automatic posting disabled."
      );

      return;
    }


    const count =
      Math.max(
        1,
        Number(
          settings.postsPerRun
        ) || 1
      );


    console.log(
      `[AUTO] Starting ${count} automatic post(s).`
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
          error
        );

      }

    }

  } catch (error) {

    console.error(
      "[AUTO SETTINGS ERROR]",
      error
    );

  }

}


function restartAutomation() {

  if (
    automationTimer
  ) {
    clearInterval(
      automationTimer
    );

    automationTimer =
      null;
  }


  getSettings()
    .then(
      settings => {

        const minutes =
          Math.max(
            1,
            Number(
              settings.postIntervalMinutes
            ) || 60
          );


        automationTimer =
          setInterval(
            automationTick,
            minutes *
              60 *
              1000
          );


        console.log(
          `Automatic posting scheduled every ${minutes} minute(s).`
        );

      }
    )
    .catch(
      error =>
        console.error(
          "Automation setup:",
          error
        )
    );

}


restartAutomation();


/* =========================================================
   RSS
========================================================= */

function xmlEscape(
  value
) {
  return String(
    value || ""
  )
    .replace(
      /&/g,
      "&amp;"
    )
    .replace(
      /</g,
      "&lt;"
    )
    .replace(
      />/g,
      "&gt;"
    )
    .replace(
      /"/g,
      "&quot;"
    )
    .replace(
      /'/g,
      "&apos;"
    );
}


app.get(
  "/rss.xml",
  async (req, res) => {

    try {

      const prompts =
        await getPrompts();

      const base =
        (
          process.env.SITE_URL ||
          `${req.protocol}://${req.get("host")}`
        ).replace(
          /\/$/,
          ""
        );


      const items =
        prompts
          .slice(0, 50)
          .map(
            p =>
              `
<item>
<title>${xmlEscape(
                p.title
              )}</title>
<link>${xmlEscape(
                `${base}/p/${p.slug}`
              )}</link>
<description>${xmlEscape(
                p.prompt
              )}</description>
</item>
`
          )
          .join("\n");


      res
        .type(
          "application/rss+xml"
        )
        .send(
          `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>PromptForge</title>
<link>${xmlEscape(
            base
          )}</link>
<description>AI Visual Prompts</description>
${items}
</channel>
</rss>`
        );

    } catch (error) {

      res.status(500).send(
        "RSS error"
      );

    }

  }
);


/* =========================================================
   404 API
========================================================= */

app.use(
  "/api",
  (req, res) =>
    res
      .status(404)
      .json({
        error:
          "API route not found"
      })
);


/* =========================================================
   FRONTEND
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
      "Database: Supabase PostgreSQL"
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

    if (
      CLOUDINARY_ENABLED
    ) {
      console.log(
        "Cloudinary storage enabled."
      );
    }

    console.log(
      `PromptForge running on port ${PORT}`
    );

  }
);
