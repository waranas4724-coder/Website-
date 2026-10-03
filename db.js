require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

const SUPABASE_URL = process.env.SUPABASE_URL;

const SUPABASE_KEY =
  process.env.SUPABASE_API_KEY ||
  process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.warn(
    "[DB] SUPABASE_URL or SUPABASE_API_KEY/SUPABASE_SECRET_KEY is missing."
  );
}

const supabase = createClient(
  SUPABASE_URL || "",
  SUPABASE_KEY || ""
);

/* =========================================================
   HELPERS
========================================================= */

function clean(value, fallback = "") {
  if (value === undefined || value === null) {
    return fallback;
  }

  return String(value).trim();
}

function bool(value, fallback = false) {
  if (value === undefined || value === null) {
    return fallback;
  }

  if (typeof value === "boolean") {
    return value;
  }

  return (
    value === true ||
    value === "true" ||
    value === 1 ||
    value === "1" ||
    value === "on"
  );
}

function number(value, fallback = 0) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : fallback;
}

function safeJson(value, fallback = {}) {
  if (value === undefined || value === null) {
    return fallback;
  }

  if (typeof value === "object") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/* =========================================================
   DATABASE
========================================================= */

function getDatabasePath() {
  return "Supabase PostgreSQL";
}

/* =========================================================
   PROMPTS
========================================================= */

async function getPrompts() {
  const { data, error } = await supabase
    .from("prompts")
    .select("*")
    .order("created_at", {
      ascending: false
    });

  if (error) {
    throw new Error(
      `Supabase prompts error: ${error.message}`
    );
  }

  return (data || []).map((row) => ({
    id: row.id,
    slug: row.slug,
    title: row.title || "",
    prompt: row.prompt || "",
    category: row.category || "",
    media:
      row.media ||
      row.image_url ||
      "Image",
    imageUrl:
      row.image_url || "",
    model:
      row.model || "",
    source:
      row.source || "",
    createdAt:
      row.created_at
  }));
}

async function getPromptBySlug(slug) {
  const { data, error } = await supabase
    .from("prompts")
    .select("*")
    .eq("slug", slug)
    .maybeSingle();

  if (error) {
    throw new Error(
      `Supabase prompt lookup error: ${error.message}`
    );
  }

  if (!data) {
    return null;
  }

  return {
    id: data.id,
    slug: data.slug,
    title: data.title || "",
    prompt: data.prompt || "",
    category:
      data.category || "",
    media:
      data.media ||
      data.image_url ||
      "Image",
    imageUrl:
      data.image_url || "",
    model:
      data.model || "",
    source:
      data.source || "",
    createdAt:
      data.created_at
  };
}

async function addPrompt(prompt = {}) {
  const row = {
    id: crypto.randomUUID(),
    slug:
      clean(prompt.slug),

    title:
      clean(prompt.title),

    prompt:
      clean(prompt.prompt),

    category:
      clean(prompt.category),

    media:
      clean(
        prompt.media ||
        prompt.imageUrl ||
        prompt.mediaUrl ||
        "Image"
      ),

    image_url:
      clean(
        prompt.imageUrl ||
        prompt.mediaUrl ||
        ""
      ),

    model:
      clean(prompt.model),

    source:
      clean(prompt.source)
  };

  const { data, error } =
    await supabase
      .from("prompts")
      .insert(row)
      .select("*")
      .single();

  if (error) {
    throw new Error(
      `Supabase add prompt error: ${error.message}`
    );
  }

  return data;
}

async function deletePrompt(id) {
  const { error } =
    await supabase
      .from("prompts")
      .delete()
      .eq("id", id);

  if (error) {
    throw new Error(
      `Supabase delete prompt error: ${error.message}`
    );
  }

  return true;
}

/* =========================================================
   API PROVIDERS
========================================================= */

/*
  Provider format:

  {
    id,
    category,
    providerName,
    apiKey,
    enabled,
    config,
    createdAt
  }

  config is used mainly for Custom APIs.

  Example:

  config: {
    endpoint: "https://example.com/api",
    method: "POST",
    authType: "bearer",
    headers: {},
    body: {},
    query: {},
    responsePath: "data",
    promptPath: "prompt",
    imagePath: "image"
  }
*/

function mapProvider(row) {
  return {
    id:
      row.id,

    category:
      row.category || "",

    providerName:
      row.provider_name ||
      row.name ||
      "",

    apiKey:
      row.api_key ||
      "",

    enabled:
      row.enabled !== false,

    config:
      safeJson(
        row.config,
        {}
      ),

    createdAt:
      row.created_at
  };
}

async function getProviders(
  category = null
) {
  let query =
    supabase
      .from("api_providers")
      .select("*")
      .order("created_at", {
        ascending: true
      });

  if (category) {
    query =
      query.eq(
        "category",
        category
      );
  }

  const { data, error } =
    await query;

  if (error) {
    throw new Error(
      `Supabase providers error: ${error.message}`
    );
  }

  return (data || []).map(
    mapProvider
  );
}

async function getProviderById(
  id
) {
  const { data, error } =
    await supabase
      .from("api_providers")
      .select("*")
      .eq("id", id)
      .maybeSingle();

  if (error) {
    throw new Error(
      `Supabase provider lookup error: ${error.message}`
    );
  }

  return data
    ? mapProvider(data)
    : null;
}

async function addProvider(
  provider = {}
) {
  const config =
    provider.config &&
    typeof provider.config ===
      "object"
      ? provider.config
      : {};

  const row = {
    id: crypto.randomUUID(),
    category:
      clean(provider.category),

    provider_name:
      clean(
        provider.providerName ||
        provider.provider_name ||
        provider.name
      ),

    api_key:
      clean(
        provider.apiKey ||
        provider.api_key
      ),

    enabled:
      provider.enabled === undefined
        ? true
        : bool(
            provider.enabled,
            true
          ),

    config
  };

  const { data, error } =
    await supabase
      .from("api_providers")
      .insert(row)
      .select("*")
      .single();

  if (error) {
    throw new Error(
      `Supabase add provider error: ${error.message}`
    );
  }

  return mapProvider(data);
}

async function updateProvider(
  id,
  updates = {}
) {
  const row = {};

  if (
    updates.category !==
    undefined
  ) {
    row.category =
      clean(
        updates.category
      );
  }

  if (
    updates.providerName !==
      undefined ||
    updates.provider_name !==
      undefined
  ) {
    row.provider_name =
      clean(
        updates.providerName ||
        updates.provider_name
      );
  }

  if (
    updates.apiKey !==
      undefined ||
    updates.api_key !==
      undefined
  ) {
    row.api_key =
      clean(
        updates.apiKey ||
        updates.api_key
      );
  }

  if (
    updates.enabled !==
    undefined
  ) {
    row.enabled =
      bool(
        updates.enabled
      );
  }

  if (
    updates.config !==
    undefined
  ) {
    row.config =
      updates.config &&
      typeof updates.config ===
        "object"
        ? updates.config
        : {};
  }

  const { data, error } =
    await supabase
      .from("api_providers")
      .update(row)
      .eq("id", id)
      .select("*")
      .single();

  if (error) {
    throw new Error(
      `Supabase update provider error: ${error.message}`
    );
  }

  return mapProvider(data);
}

async function deleteProvider(
  id
) {
  const { error } =
    await supabase
      .from("api_providers")
      .delete()
      .eq("id", id);

  if (error) {
    throw new Error(
      `Supabase delete provider error: ${error.message}`
    );
  }

  return true;
}

/* =========================================================
   SETTINGS
========================================================= */

const DEFAULT_SETTINGS = {
  autoPost: true,
  postIntervalMinutes: 60,
  postsPerRun: 1,
  copyGateSeconds: 10,
  directLink: ""
};

async function getSettings() {
  const { data, error } =
    await supabase
      .from("app_settings")
      .select("*")
      .eq("id", 1)
      .maybeSingle();

  if (error) {
    throw new Error(
      `Supabase settings error: ${error.message}`
    );
  }

  if (!data) {
    const {
      data: created,
      error: createError
    } = await supabase
      .from("app_settings")
      .insert({
        id: 1,

        auto_post:
          DEFAULT_SETTINGS.autoPost,

        post_interval_minutes:
          DEFAULT_SETTINGS.postIntervalMinutes,

        posts_per_run:
          DEFAULT_SETTINGS.postsPerRun,

        copy_gate_seconds:
          DEFAULT_SETTINGS.copyGateSeconds,

        direct_link:
          DEFAULT_SETTINGS.directLink
      })
      .select("*")
      .single();

    if (createError) {
      throw new Error(
        `Supabase create settings error: ${createError.message}`
      );
    }

    return {
      autoPost:
        created.auto_post,

      postIntervalMinutes:
        created.post_interval_minutes,

      postsPerRun:
        created.posts_per_run,

      copyGateSeconds:
        created.copy_gate_seconds,

      directLink:
        created.direct_link || ""
    };
  }

  return {
    autoPost:
      data.auto_post !== false,

    postIntervalMinutes:
      number(
        data.post_interval_minutes,
        60
      ),

    postsPerRun:
      number(
        data.posts_per_run,
        1
      ),

    copyGateSeconds:
      number(
        data.copy_gate_seconds,
        10
      ),

    directLink:
      data.direct_link || ""
  };
}

async function saveSettings(
  settings = {}
) {
  const row = {
    id: 1,

    auto_post:
      settings.autoPost ===
      undefined
        ? true
        : bool(
            settings.autoPost,
            true
          ),

    post_interval_minutes:
      number(
        settings.postIntervalMinutes,
        60
      ),

    posts_per_run:
      number(
        settings.postsPerRun,
        1
      ),

    copy_gate_seconds:
      number(
        settings.copyGateSeconds,
        10
      ),

    direct_link:
      clean(
        settings.directLink
      )
  };

  const { data, error } =
    await supabase
      .from("app_settings")
      .upsert(
        row,
        {
          onConflict: "id"
        }
      )
      .select("*")
      .single();

  if (error) {
    throw new Error(
      `Supabase save settings error: ${error.message}`
    );
  }

  return {
    autoPost:
      data.auto_post,

    postIntervalMinutes:
      data.post_interval_minutes,

    postsPerRun:
      data.posts_per_run,

    copyGateSeconds:
      data.copy_gate_seconds,

    directLink:
      data.direct_link || ""
  };
}

/* =========================================================
   ADS
========================================================= */

const DEFAULT_ADS = {
  head_code: {
    enabled: false,
    code: "",
    height: 0
  },

  popunder: {
    enabled: false,
    code: "",
    height: 0
  },

  social_bar: {
    enabled: false,
    code: "",
    height: 0
  },

  banner_top: {
    enabled: false,
    code: "",
    height: 90
  },

  banner_middle: {
    enabled: false,
    code: "",
    height: 90
  },

  banner_bottom: {
    enabled: false,
    code: "",
    height: 90
  },

  modal_banner: {
    enabled: false,
    code: "",
    height: 250
  },

  native_banner: {
    enabled: false,
    code: "",
    height: 250
  }
};

async function getAds() {
  const { data, error } =
    await supabase
      .from("ads")
      .select("*")
      .eq("id", 1)
      .maybeSingle();

  if (error) {
    throw new Error(
      `Supabase ads error: ${error.message}`
    );
  }

  if (!data) {
    const {
      data: created,
      error: createError
    } = await supabase
      .from("ads")
      .insert({
        id: 1,
        data: DEFAULT_ADS
      })
      .select("*")
      .single();

    if (createError) {
      throw new Error(
        `Supabase create ads error: ${createError.message}`
      );
    }

    return (
      created.data ||
      DEFAULT_ADS
    );
  }

  return (
    data.data ||
    DEFAULT_ADS
  );
}

async function saveAds(
  ads = {}
) {
  const { data, error } =
    await supabase
      .from("ads")
      .upsert(
        {
          id: 1,
          data: ads
        },
        {
          onConflict: "id"
        }
      )
      .select("*")
      .single();

  if (error) {
    throw new Error(
      `Supabase save ads error: ${error.message}`
    );
  }

  return (
    data.data ||
    ads
  );
}

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  supabase,

  getDatabasePath,

  /* Prompts */
  getPrompts,
  getPromptBySlug,
  addPrompt,
  deletePrompt,

  /* API Providers */
  getProviders,
  getProviderById,
  addProvider,
  updateProvider,
  deleteProvider,

  /* Settings */
  getSettings,
  saveSettings,

  /* Ads */
  getAds,
  saveAds
};
