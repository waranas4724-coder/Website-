const { createClient } = require("@supabase/supabase-js");
const path = require("path");
const fs = require("fs");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_API_KEY ||
  process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL) {
  console.warn("⚠️ SUPABASE_URL is missing.");
}

if (!SUPABASE_KEY) {
  console.warn(
    "⚠️ SUPABASE_API_KEY / SUPABASE_SECRET_KEY is missing."
  );
}

const supabase =
  SUPABASE_URL && SUPABASE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_KEY)
    : null;


/* =========================================================
   Helpers
   ========================================================= */

function getDatabasePath() {
  return path.join(
    process.env.DATA_DIR || path.join(__dirname, "data"),
    "promptforge.json"
  );
}

function checkSupabase() {
  if (!supabase) {
    throw new Error(
      "Supabase is not configured. Check SUPABASE_URL and SUPABASE_SECRET_KEY."
    );
  }
}


/* =========================================================
   PROMPTS
   ========================================================= */

async function getPrompts() {
  checkSupabase();

  const { data, error } = await supabase
    .from("prompts")
    .select("*")
    .order("created_at", {
      ascending: false
    });

  if (error) {
    throw error;
  }

  return (data || []).map(row => ({
    id: row.id,
    slug: row.slug,
    title: row.title,
    prompt: row.prompt,
    category: row.category || "AI Art",
    media: row.media || "Image",
    imageUrl: row.image_url || "",
    model: row.model || "",
    source: row.source || "",
    createdAt: row.created_at
  }));
}


async function addPrompt(prompt) {
  checkSupabase();

  const row = {
    id:
      prompt.id ||
      `${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 10)}`,

    slug:
      prompt.slug ||
      `${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`,

    title: prompt.title || "Untitled Prompt",

    prompt: prompt.prompt || "",

    category:
      prompt.category || "AI Art",

    media:
      prompt.media ||
      prompt.imageUrl ||
      "Image",

    image_url:
      prompt.imageUrl ||
      prompt.mediaUrl ||
      "",

    model:
      prompt.model ||
      "",

    source:
      prompt.source ||
      ""
  };

  const { data, error } = await supabase
    .from("prompts")
    .insert(row)
    .select()
    .single();

  if (error) {
    throw error;
  }

  return data;
}


async function updatePrompt(id, updates) {
  checkSupabase();

  const row = {};

  if (updates.slug !== undefined) {
    row.slug = updates.slug;
  }

  if (updates.title !== undefined) {
    row.title = updates.title;
  }

  if (updates.prompt !== undefined) {
    row.prompt = updates.prompt;
  }

  if (updates.category !== undefined) {
    row.category = updates.category;
  }

  if (updates.media !== undefined) {
    row.media = updates.media;
  }

  if (updates.imageUrl !== undefined) {
    row.image_url = updates.imageUrl;
  }

  if (updates.model !== undefined) {
    row.model = updates.model;
  }

  if (updates.source !== undefined) {
    row.source = updates.source;
  }

  const { data, error } = await supabase
    .from("prompts")
    .update(row)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    throw error;
  }

  return data;
}


async function deletePrompt(id) {
  checkSupabase();

  const { error } = await supabase
    .from("prompts")
    .delete()
    .eq("id", id);

  if (error) {
    throw error;
  }

  return true;
}


/* =========================================================
   API PROVIDERS
   ========================================================= */

async function getApiProviders() {
  checkSupabase();

  const { data, error } = await supabase
    .from("api_providers")
    .select("*")
    .order("created_at", {
      ascending: true
    });

  if (error) {
    throw error;
  }

  return (data || []).map(row => ({
    id: row.id,
    category: row.category,
    providerName: row.provider_name,
    apiKey: row.api_key || "",
    enabled: row.enabled !== false
  }));
}


async function addApiProvider(provider) {
  checkSupabase();

  const row = {
    id:
      provider.id ||
      `${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`,

    category:
      provider.category ||
      "prompt_generate",

    provider_name:
      provider.providerName ||
      provider.provider_name ||
      "Provider",

    api_key:
      provider.apiKey ||
      provider.api_key ||
      "",

    enabled:
      provider.enabled !== false
  };

  const { data, error } = await supabase
    .from("api_providers")
    .insert(row)
    .select()
    .single();

  if (error) {
    throw error;
  }

  return data;
}


async function updateApiProvider(id, updates) {
  checkSupabase();

  const row = {};

  if (updates.category !== undefined) {
    row.category = updates.category;
  }

  if (updates.providerName !== undefined) {
    row.provider_name = updates.providerName;
  }

  if (updates.provider_name !== undefined) {
    row.provider_name = updates.provider_name;
  }

  if (updates.apiKey !== undefined) {
    row.api_key = updates.apiKey;
  }

  if (updates.api_key !== undefined) {
    row.api_key = updates.api_key;
  }

  if (updates.enabled !== undefined) {
    row.enabled = Boolean(updates.enabled);
  }

  const { data, error } = await supabase
    .from("api_providers")
    .update(row)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    throw error;
  }

  return data;
}


async function deleteApiProvider(id) {
  checkSupabase();

  const { error } = await supabase
    .from("api_providers")
    .delete()
    .eq("id", id);

  if (error) {
    throw error;
  }

  return true;
}


/* =========================================================
   SETTINGS
   ========================================================= */

async function getSettings() {
  checkSupabase();

  const { data, error } = await supabase
    .from("app_settings")
    .select("*")
    .eq("id", 1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    const defaults = {
      id: 1,
      auto_post: true,
      post_interval_minutes: 60,
      posts_per_run: 1,
      copy_gate_seconds: 10,
      direct_link: ""
    };

    const { data: created, error: createError } =
      await supabase
        .from("app_settings")
        .insert(defaults)
        .select()
        .single();

    if (createError) {
      throw createError;
    }

    return mapSettings(created);
  }

  return mapSettings(data);
}


function mapSettings(row) {
  return {
    autoPost: row.auto_post !== false,

    postIntervalMinutes:
      Number(row.post_interval_minutes) || 60,

    postsPerRun:
      Number(row.posts_per_run) || 1,

    copyGateSeconds:
      Number(row.copy_gate_seconds) || 10,

    directLink:
      row.direct_link || ""
  };
}


async function updateSettings(updates) {
  checkSupabase();

  const row = {
    id: 1
  };

  if (updates.autoPost !== undefined) {
    row.auto_post = Boolean(updates.autoPost);
  }

  if (updates.postIntervalMinutes !== undefined) {
    row.post_interval_minutes =
      Number(updates.postIntervalMinutes) || 60;
  }

  if (updates.postsPerRun !== undefined) {
    row.posts_per_run =
      Number(updates.postsPerRun) || 1;
  }

  if (updates.copyGateSeconds !== undefined) {
    row.copy_gate_seconds =
      Number(updates.copyGateSeconds) || 10;
  }

  if (updates.directLink !== undefined) {
    row.direct_link = updates.directLink || "";
  }

  const { data, error } = await supabase
    .from("app_settings")
    .upsert(row, {
      onConflict: "id"
    })
    .select()
    .single();

  if (error) {
    throw error;
  }

  return mapSettings(data);
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
  checkSupabase();

  const { data, error } = await supabase
    .from("ads")
    .select("*")
    .eq("id", 1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    await updateAds(DEFAULT_ADS);
    return DEFAULT_ADS;
  }

  return {
    ...DEFAULT_ADS,
    ...(data.data || {})
  };
}


async function updateAds(ads) {
  checkSupabase();

  const merged = {
    ...DEFAULT_ADS,
    ...(ads || {})
  };

  const { data, error } = await supabase
    .from("ads")
    .upsert(
      {
        id: 1,
        data: merged
      },
      {
        onConflict: "id"
      }
    )
    .select()
    .single();

  if (error) {
    throw error;
  }

  return data.data || merged;
}


/* =========================================================
   EXPORTS
   ========================================================= */

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
