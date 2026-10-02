const { createClient } = require("@supabase/supabase-js");

/*
|--------------------------------------------------------------------------
| Supabase connection
|--------------------------------------------------------------------------
*/

const SUPABASE_URL =
  process.env.SUPABASE_URL;

const SUPABASE_KEY =
  process.env.SUPABASE_API_KEY ||
  process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL) {
  console.error(
    "❌ SUPABASE_URL is missing."
  );
}

if (!SUPABASE_KEY) {
  console.error(
    "❌ SUPABASE_API_KEY is missing."
  );
}

const supabase =
  SUPABASE_URL && SUPABASE_KEY
    ? createClient(
        SUPABASE_URL,
        SUPABASE_KEY,
        {
          auth: {
            autoRefreshToken: false,
            persistSession: false
          }
        }
      )
    : null;


/*
|--------------------------------------------------------------------------
| Helpers
|--------------------------------------------------------------------------
*/

function makeId() {
  return (
    Date.now().toString(36) +
    Math.random()
      .toString(36)
      .slice(2, 10)
  );
}

function mapPrompt(row) {
  if (!row) return null;

  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    prompt: row.prompt,
    category: row.category || "AI Image",
    media:
      row.media ||
      row.image_url ||
      "",
    imageUrl:
      row.image_url ||
      (
        typeof row.media === "string" &&
        row.media.startsWith("/generated/")
          ? row.media
          : ""
      ),
    model: row.model || "",
    source: row.source || "",
    createdAt:
      row.created_at ||
      new Date().toISOString()
  };
}

function mapProvider(row) {
  if (!row) return null;

  return {
    id: row.id,
    category:
      row.category ||
      "prompt_generate",

    providerName:
      row.provider_name ||
      "Provider",

    apiKey:
      row.api_key ||
      "",

    enabled:
      row.enabled !== false,

    createdAt:
      row.created_at ||
      new Date().toISOString(),

    updatedAt:
      row.updated_at ||
      null
  };
}

function throwIfError(error, message) {
  if (error) {
    console.error(
      message,
      error
    );

    throw new Error(
      `${message}: ${
        error.message || error
      }`
    );
  }
}


/*
|--------------------------------------------------------------------------
| Prompts
|--------------------------------------------------------------------------
*/

async function getPrompts() {
  if (!supabase) {
    throw new Error(
      "Supabase is not configured."
    );
  }

  const {
    data,
    error
  } = await supabase
    .from("prompts")
    .select("*")
    .order(
      "created_at",
      {
        ascending: false
      }
    );

  throwIfError(
    error,
    "Failed to load prompts"
  );

  return Array.isArray(data)
    ? data.map(mapPrompt)
    : [];
}


async function addPrompt(prompt) {
  if (!supabase) {
    throw new Error(
      "Supabase is not configured."
    );
  }

  const item = {
    id:
      prompt.id ||
      makeId(),

    slug:
      prompt.slug ||
      makeId(),

    title:
      prompt.title ||
      "Untitled",

    prompt:
      prompt.prompt ||
      "",

    category:
      prompt.category ||
      "AI Image",

    media:
      prompt.media ||
      prompt.imageUrl ||
      "",

    image_url:
      prompt.imageUrl ||
      (
        typeof prompt.media === "string" &&
        prompt.media.startsWith(
          "/generated/"
        )
          ? prompt.media
          : ""
      ),

    model:
      prompt.model ||
      "",

    source:
      prompt.source ||
      "",

    created_at:
      prompt.createdAt ||
      new Date().toISOString()
  };

  const {
    data,
    error
  } = await supabase
    .from("prompts")
    .insert(item)
    .select("*")
    .single();

  throwIfError(
    error,
    "Failed to add prompt"
  );

  return mapPrompt(data);
}


async function updatePrompt(
  id,
  changes
) {
  if (!supabase) {
    throw new Error(
      "Supabase is not configured."
    );
  }

  const update = {};

  if (
    changes.title !== undefined
  ) {
    update.title =
      changes.title;
  }

  if (
    changes.prompt !== undefined
  ) {
    update.prompt =
      changes.prompt;
  }

  if (
    changes.category !== undefined
  ) {
    update.category =
      changes.category;
  }

  if (
    changes.media !== undefined
  ) {
    update.media =
      changes.media;
  }

  if (
    changes.imageUrl !== undefined
  ) {
    update.image_url =
      changes.imageUrl;
  }

  if (
    changes.model !== undefined
  ) {
    update.model =
      changes.model;
  }

  if (
    changes.source !== undefined
  ) {
    update.source =
      changes.source;
  }

  const {
    data,
    error
  } = await supabase
    .from("prompts")
    .update(update)
    .eq("id", id)
    .select("*")
    .maybeSingle();

  throwIfError(
    error,
    "Failed to update prompt"
  );

  return mapPrompt(data);
}


async function deletePrompt(id) {
  if (!supabase) {
    throw new Error(
      "Supabase is not configured."
    );
  }

  const {
    error
  } = await supabase
    .from("prompts")
    .delete()
    .eq("id", id);

  throwIfError(
    error,
    "Failed to delete prompt"
  );

  return true;
}


/*
|--------------------------------------------------------------------------
| API Providers
|--------------------------------------------------------------------------
|
| Categories:
|
| trending_search
| prompt_generate
| photo_generate
|--------------------------------------------------------------------------
*/

async function getApiProviders() {
  if (!supabase) {
    throw new Error(
      "Supabase is not configured."
    );
  }

  const {
    data,
    error
  } = await supabase
    .from("api_providers")
    .select("*")
    .order(
      "created_at",
      {
        ascending: true
      }
    );

  throwIfError(
    error,
    "Failed to load API providers"
  );

  return Array.isArray(data)
    ? data.map(mapProvider)
    : [];
}


async function addApiProvider(
  provider
) {
  if (!supabase) {
    throw new Error(
      "Supabase is not configured."
    );
  }

  const item = {
    id:
      provider.id ||
      makeId(),

    category:
      provider.category ||
      "prompt_generate",

    provider_name:
      provider.providerName ||
      "Provider",

    api_key:
      provider.apiKey ||
      "",

    enabled:
      provider.enabled !== false,

    created_at:
      new Date().toISOString()
  };

  const {
    data,
    error
  } = await supabase
    .from("api_providers")
    .insert(item)
    .select("*")
    .single();

  throwIfError(
    error,
    "Failed to add API provider"
  );

  return mapProvider(data);
}


async function updateApiProvider(
  id,
  changes
) {
  if (!supabase) {
    throw new Error(
      "Supabase is not configured."
    );
  }

  const update = {};

  if (
    changes.category !== undefined
  ) {
    update.category =
      changes.category;
  }

  if (
    changes.providerName !== undefined
  ) {
    update.provider_name =
      changes.providerName;
  }

  /*
   * Never erase an existing key
   * with an empty value.
   */
  if (
    changes.apiKey !== undefined &&
    changes.apiKey !== ""
  ) {
    update.api_key =
      changes.apiKey;
  }

  if (
    changes.enabled !== undefined
  ) {
    update.enabled =
      changes.enabled;
  }

  update.updated_at =
    new Date().toISOString();

  const {
    data,
    error
  } = await supabase
    .from("api_providers")
    .update(update)
    .eq("id", id)
    .select("*")
    .maybeSingle();

  throwIfError(
    error,
    "Failed to update API provider"
  );

  return mapProvider(data);
}


async function deleteApiProvider(
  id
) {
  if (!supabase) {
    throw new Error(
      "Supabase is not configured."
    );
  }

  const {
    error
  } = await supabase
    .from("api_providers")
    .delete()
    .eq("id", id);

  throwIfError(
    error,
    "Failed to delete API provider"
  );

  return true;
}


/*
|--------------------------------------------------------------------------
| Settings
|--------------------------------------------------------------------------
*/

const DEFAULT_SETTINGS = {
  autoPost: true,
  postIntervalMinutes: 60,
  postsPerRun: 1,
  copyGateSeconds: 10,
  directLink: ""
};


async function getSettings() {
  if (!supabase) {
    throw new Error(
      "Supabase is not configured."
    );
  }

  const {
    data,
    error
  } = await supabase
    .from("app_settings")
    .select("*")
    .eq("id", 1)
    .maybeSingle();

  throwIfError(
    error,
    "Failed to load settings"
  );

  if (!data) {
    return {
      ...DEFAULT_SETTINGS
    };
  }

  return {
    autoPost:
      data.auto_post !== false,

    postIntervalMinutes:
      Number(
        data.post_interval_minutes ||
        60
      ),

    postsPerRun:
      Number(
        data.posts_per_run ||
        1
      ),

    copyGateSeconds:
      Number(
        data.copy_gate_seconds ||
        10
      ),

    directLink:
      data.direct_link ||
      ""
  };
}


async function updateSettings(
  changes
) {
  if (!supabase) {
    throw new Error(
      "Supabase is not configured."
    );
  }

  const item = {
    id: 1,

    auto_post:
      changes.autoPost !== undefined
        ? Boolean(
            changes.autoPost
          )
        : true,

    post_interval_minutes:
      Number(
        changes.postIntervalMinutes ||
        60
      ),

    posts_per_run:
      Number(
        changes.postsPerRun ||
        1
      ),

    copy_gate_seconds:
      Number(
        changes.copyGateSeconds ||
        10
      ),

    direct_link:
      changes.directLink ||
      ""
  };

  const {
    data,
    error
  } = await supabase
    .from("app_settings")
    .upsert(
      item,
      {
        onConflict: "id"
      }
    )
    .select("*")
    .single();

  throwIfError(
    error,
    "Failed to update settings"
  );

  return {
    autoPost:
      data.auto_post !== false,

    postIntervalMinutes:
      Number(
        data.post_interval_minutes ||
        60
      ),

    postsPerRun:
      Number(
        data.posts_per_run ||
        1
      ),

    copyGateSeconds:
      Number(
        data.copy_gate_seconds ||
        10
      ),

    directLink:
      data.direct_link ||
      ""
  };
}


/*
|--------------------------------------------------------------------------
| Ads
|--------------------------------------------------------------------------
*/

async function getAds() {
  if (!supabase) {
    throw new Error(
      "Supabase is not configured."
    );
  }

  const {
    data,
    error
  } = await supabase
    .from("ads")
    .select("data")
    .eq("id", 1)
    .maybeSingle();

  throwIfError(
    error,
    "Failed to load ads"
  );

  return data?.data || {};
}


async function updateAds(
  ads
) {
  if (!supabase) {
    throw new Error(
      "Supabase is not configured."
    );
  }

  const {
    data,
    error
  } = await supabase
    .from("ads")
    .upsert(
      {
        id: 1,
        data:
          ads &&
          typeof ads === "object"
            ? ads
            : {}
      },
      {
        onConflict: "id"
      }
    )
    .select("data")
    .single();

  throwIfError(
    error,
    "Failed to update ads"
  );

  return data?.data || {};
}


/*
|--------------------------------------------------------------------------
| Database info
|--------------------------------------------------------------------------
*/

function getDatabasePath() {
  return "Supabase PostgreSQL";
}


/*
|--------------------------------------------------------------------------
| Export
|--------------------------------------------------------------------------
*/

module.exports = {
  supabase,

  getDatabasePath,

  getPrompts,
  addPrompt,
  updatePrompt,
  deletePrompt,

  getApiProviders,
  addApiProvider,
  updateApiProvider,
  deleteApiProvider,

  getSettings,
  updateSettings,

  getAds,
  updateAds
};
