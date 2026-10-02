require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_API_KEY || process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_API_KEY (or SUPABASE_SECRET_KEY) are required.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

function clean(v, max = 50000) {
  return String(v ?? '').trim().slice(0, max);
}

function rowToPrompt(row) {
  if (!row) return null;
  return {
    ...row,
    imageUrl: row.image_url || row.imageUrl || '',
    publishedAt: row.created_at || row.published_at || row.publishedAt || null,
    auto: !!row.auto
  };
}

async function getPrompts() {
  const { data, error } = await supabase
    .from('prompts')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(rowToPrompt);
}

async function getPromptBySlug(slug) {
  const { data, error } = await supabase
    .from('prompts')
    .select('*')
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw error;
  return rowToPrompt(data);
}

async function addPrompt(prompt) {
  const row = {
    id: prompt.id || crypto.randomUUID(),
    slug: clean(prompt.slug, 160),
    title: clean(prompt.title, 200),
    prompt: clean(prompt.prompt, 12000),
    category: clean(prompt.category || 'General', 100),
    media: clean(prompt.media || 'Image', 40),
    image_url: clean(prompt.imageUrl || prompt.image_url || prompt.mediaUrl || '', 5000),
    model: clean(prompt.model || 'Any', 160),
    source: clean(prompt.source || 'PromptForge', 500),
    created_at: prompt.publishedAt || prompt.created_at || new Date().toISOString()
  };

  const { data, error } = await supabase
    .from('prompts')
    .insert(row)
    .select('*')
    .single();
  if (error) throw error;
  return rowToPrompt(data);
}

async function deletePrompt(id) {
  const { error } = await supabase.from('prompts').delete().eq('id', id);
  if (error) throw error;
  return true;
}

// IMPORTANT: server.js calls getProviders(). This function was missing in the
// previous deployed db.js, which caused: TypeError: getProviders is not a function.
async function getProviders() {
  const { data, error } = await supabase
    .from('api_providers')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) throw error;

  return (data || []).map((p) => ({
    ...p,
    id: p.id,
    category: p.category,
    providerName: p.provider_name || p.providerName || p.name || '',
    provider_name: p.provider_name || p.providerName || p.name || '',
    apiKey: p.api_key || p.apiKey || '',
    api_key: p.api_key || p.apiKey || '',
    enabled: p.enabled === true || p.enabled === 1 || p.enabled === 'true'
  }));
}

async function addProvider(provider) {
  const row = {
    category: clean(provider.category, 80),
    provider_name: clean(provider.providerName || provider.provider_name || provider.name, 160),
    api_key: clean(provider.apiKey || provider.api_key || provider.key, 20000),
    enabled: provider.enabled !== false
  };

  const { data, error } = await supabase
    .from('api_providers')
    .insert(row)
    .select('*')
    .single();
  if (error) throw error;

  return {
    ...data,
    providerName: data.provider_name || '',
    provider_name: data.provider_name || '',
    apiKey: data.api_key || '',
    api_key: data.api_key || ''
  };
}

async function deleteProvider(id) {
  const { error } = await supabase.from('api_providers').delete().eq('id', id);
  if (error) throw error;
  return true;
}

async function getSettings() {
  const { data, error } = await supabase
    .from('app_settings')
    .select('*')
    .eq('id', 1)
    .maybeSingle();
  if (error) throw error;

  if (!data) {
    const defaults = {
      id: 1,
      auto_post: true,
      post_interval_minutes: 60,
      posts_per_run: 1,
      copy_gate_seconds: 10,
      direct_link: ''
    };
    const { data: created, error: createError } = await supabase
      .from('app_settings')
      .insert(defaults)
      .select('*')
      .single();
    if (createError) throw createError;
    return mapSettings(created);
  }

  return mapSettings(data);
}

function mapSettings(row) {
  return {
    autoPost: row.auto_post !== false,
    postIntervalMinutes: Number(row.post_interval_minutes ?? 60),
    postsPerRun: Number(row.posts_per_run ?? 1),
    copyGateSeconds: Number(row.copy_gate_seconds ?? 10),
    directLink: row.direct_link || ''
  };
}

async function saveSettings(settings) {
  const current = await getSettings();
  const row = {
    id: 1,
    auto_post: settings.autoPost ?? current.autoPost,
    post_interval_minutes: Number(settings.postIntervalMinutes ?? current.postIntervalMinutes ?? 60),
    posts_per_run: Number(settings.postsPerRun ?? current.postsPerRun ?? 1),
    copy_gate_seconds: Number(settings.copyGateSeconds ?? current.copyGateSeconds ?? 10),
    direct_link: clean(settings.directLink ?? current.directLink ?? '', 5000)
  };

  const { data, error } = await supabase
    .from('app_settings')
    .upsert(row, { onConflict: 'id' })
    .select('*')
    .single();
  if (error) throw error;
  return mapSettings(data);
}

const DEFAULT_ADS = {
  head_code: { enabled: false, code: '', height: 0 },
  popunder: { enabled: false, code: '', height: 0 },
  social_bar: { enabled: false, code: '', height: 0 },
  banner_top: { enabled: false, code: '', height: 90 },
  banner_middle: { enabled: false, code: '', height: 90 },
  banner_bottom: { enabled: false, code: '', height: 90 },
  modal_banner: { enabled: false, code: '', height: 250 },
  native_banner: { enabled: false, code: '', height: 250 }
};

async function getAds() {
  const { data, error } = await supabase
    .from('ads')
    .select('*')
    .eq('id', 1)
    .maybeSingle();
  if (error) throw error;

  if (!data) {
    const { data: created, error: createError } = await supabase
      .from('ads')
      .insert({ id: 1, data: DEFAULT_ADS })
      .select('*')
      .single();
    if (createError) throw createError;
    return created.data || DEFAULT_ADS;
  }

  return data.data || DEFAULT_ADS;
}

async function saveAds(ads) {
  const current = await getAds();
  const merged = { ...DEFAULT_ADS, ...current, ...(ads || {}) };

  const { data, error } = await supabase
    .from('ads')
    .upsert({ id: 1, data: merged }, { onConflict: 'id' })
    .select('*')
    .single();
  if (error) throw error;
  return data.data || merged;
}

function getDatabasePath() {
  return 'supabase://app_settings,ads,api_providers,prompts';
}

module.exports = {
  supabase,
  getDatabasePath,
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
};
