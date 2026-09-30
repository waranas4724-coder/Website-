const fs = require('fs');
const path = require('path');

const DATA_DIR =
  process.env.DATA_DIR ||
  path.join(__dirname, 'data');

fs.mkdirSync(DATA_DIR, {
  recursive: true
});

const DB_FILE = path.join(
  DATA_DIR,
  'promptforge.json'
);

const defaultData = {
  prompts: [],
  apiProviders: [],
  settings: {
    autoPost: true,
    cron: '*/30 * * * *',
    postsPerRun: 10,
    copyGateSeconds: 10,
    directLink: ''
  },
  ads: {}
};

function load() {

  try {

    if (!fs.existsSync(DB_FILE)) {

      fs.writeFileSync(
        DB_FILE,
        JSON.stringify(
          defaultData,
          null,
          2
        )
      );

      return structuredClone(defaultData);
    }

    const raw =
      fs.readFileSync(
        DB_FILE,
        'utf8'
      );

    const data =
      JSON.parse(raw);

    return {
      ...defaultData,
      ...data,
      settings: {
        ...defaultData.settings,
        ...(data.settings || {})
      },
      prompts:
        Array.isArray(data.prompts)
          ? data.prompts
          : [],
      apiProviders:
        Array.isArray(data.apiProviders)
          ? data.apiProviders
          : [],
      ads:
        data.ads || {}
    };

  } catch (error) {

    console.error(
      'Database read error:',
      error
    );

    return structuredClone(
      defaultData
    );
  }
}

function save(data) {

  const tempFile =
    `${DB_FILE}.tmp`;

  fs.writeFileSync(
    tempFile,
    JSON.stringify(
      data,
      null,
      2
    )
  );

  fs.renameSync(
    tempFile,
    DB_FILE
  );

  return data;
}

function getData() {
  return load();
}

function updateData(callback) {

  const data = load();

  const result =
    callback(data) || data;

  return save(result);
}

/* -------------------------
   PROMPTS
------------------------- */

function getPrompts() {
  return load().prompts;
}

function addPrompt(prompt) {

  return updateData((data) => {

    data.prompts.push({
      id:
        prompt.id ||
        `${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 8)}`,

      createdAt:
        prompt.createdAt ||
        new Date().toISOString(),

      ...prompt
    });

    return data;
  });
}

function updatePrompt(
  id,
  changes
) {

  return updateData((data) => {

    const index =
      data.prompts.findIndex(
        (p) =>
          String(p.id) ===
          String(id)
      );

    if (index !== -1) {

      data.prompts[index] = {
        ...data.prompts[index],
        ...changes
      };
    }

    return data;
  });
}

function deletePrompt(id) {

  return updateData((data) => {

    data.prompts =
      data.prompts.filter(
        (p) =>
          String(p.id) !==
          String(id)
      );

    return data;
  });
}

/* -------------------------
   API PROVIDERS
------------------------- */

function getApiProviders() {
  return load().apiProviders;
}

function addApiProvider(provider) {

  return updateData((data) => {

    data.apiProviders.push({

      id:
        provider.id ||
        `${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 8)}`,

      category:
        provider.category ||
        'prompt',

      providerName:
        provider.providerName ||
        '',

      apiKey:
        provider.apiKey ||
        '',

      enabled:
        provider.enabled !== false,

      createdAt:
        new Date().toISOString(),

      ...provider
    });

    return data;
  });
}

function updateApiProvider(
  id,
  changes
) {

  return updateData((data) => {

    const index =
      data.apiProviders.findIndex(
        (p) =>
          String(p.id) ===
          String(id)
      );

    if (index !== -1) {

      data.apiProviders[index] = {
        ...data.apiProviders[index],
        ...changes
      };
    }

    return data;
  });
}

function deleteApiProvider(id) {

  return updateData((data) => {

    data.apiProviders =
      data.apiProviders.filter(
        (p) =>
          String(p.id) !==
          String(id)
      );

    return data;
  });
}

/* -------------------------
   SETTINGS
------------------------- */

function getSettings() {
  return load().settings;
}

function saveSettings(settings) {

  return updateData((data) => {

    data.settings = {
      ...data.settings,
      ...settings
    };

    return data;
  });
}

/* -------------------------
   ADS
------------------------- */

function getAds() {
  return load().ads;
}

function saveAds(ads) {

  return updateData((data) => {

    data.ads = {
      ...data.ads,
      ...ads
    };

    return data;
  });
}

module.exports = {

  DB_FILE,

  getData,
  updateData,

  getPrompts,
  addPrompt,
  updatePrompt,
  deletePrompt,

  getApiProviders,
  addApiProvider,
  updateApiProvider,
  deleteApiProvider,

  getSettings,
  saveSettings,

  getAds,
  saveAds
};
