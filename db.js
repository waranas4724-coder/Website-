const fs = require("fs");
const path = require("path");

const DATA_DIR =
  process.env.DATA_DIR ||
  path.join(__dirname, "data");

const DB_FILE =
  path.join(DATA_DIR, "promptforge.json");

fs.mkdirSync(DATA_DIR, {
  recursive: true
});

const DEFAULT_DB = {
  prompts: [],

  apiProviders: [],

  settings: {
    autoPost: true,
    postIntervalMinutes: 60,
    postsPerRun: 1,
    copyGateSeconds: 10,
    directLink: ""
  },

  ads: {}
};

function clone(value) {
  return JSON.parse(
    JSON.stringify(value)
  );
}

function ensureDatabase() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(
      DB_FILE,
      JSON.stringify(
        DEFAULT_DB,
        null,
        2
      ),
      "utf8"
    );

    return;
  }

  try {
    const raw =
      fs.readFileSync(
        DB_FILE,
        "utf8"
      );

    const data =
      JSON.parse(raw);

    const merged = {
      ...DEFAULT_DB,
      ...data,

      settings: {
        ...DEFAULT_DB.settings,
        ...(data.settings || {})
      },

      ads:
        data.ads || {},

      prompts:
        Array.isArray(data.prompts)
          ? data.prompts
          : [],

      apiProviders:
        Array.isArray(
          data.apiProviders
        )
          ? data.apiProviders
          : []
    };

    fs.writeFileSync(
      DB_FILE,
      JSON.stringify(
        merged,
        null,
        2
      ),
      "utf8"
    );
  } catch (error) {
    console.error(
      "Database read error:",
      error
    );

    /*
     * Don't destroy the old database.
     * Create a backup before recovering.
     */
    const backup =
      `${DB_FILE}.broken-${Date.now()}`;

    try {
      fs.copyFileSync(
        DB_FILE,
        backup
      );
    } catch (_) {}

    fs.writeFileSync(
      DB_FILE,
      JSON.stringify(
        DEFAULT_DB,
        null,
        2
      ),
      "utf8"
    );
  }
}

function readDB() {
  ensureDatabase();

  try {
    return JSON.parse(
      fs.readFileSync(
        DB_FILE,
        "utf8"
      )
    );
  } catch (error) {
    console.error(
      "Database load failed:",
      error
    );

    return clone(
      DEFAULT_DB
    );
  }
}

function writeDB(data) {
  ensureDatabase();

  const tempFile =
    `${DB_FILE}.tmp`;

  fs.writeFileSync(
    tempFile,
    JSON.stringify(
      data,
      null,
      2
    ),
    "utf8"
  );

  fs.renameSync(
    tempFile,
    DB_FILE
  );
}

/*
|--------------------------------------------------------------------------
| Prompts
|--------------------------------------------------------------------------
*/

function getPrompts() {
  const db = readDB();

  return Array.isArray(
    db.prompts
  )
    ? db.prompts
    : [];
}

function addPrompt(prompt) {
  const db = readDB();

  if (!Array.isArray(db.prompts)) {
    db.prompts = [];
  }

  db.prompts.unshift(
    prompt
  );

  writeDB(db);

  return prompt;
}

function updatePrompt(
  id,
  changes
) {
  const db = readDB();

  const index =
    db.prompts.findIndex(
      (item) =>
        String(item.id) ===
        String(id)
    );

  if (index === -1) {
    return null;
  }

  db.prompts[index] = {
    ...db.prompts[index],
    ...changes
  };

  writeDB(db);

  return db.prompts[index];
}

function deletePrompt(id) {
  const db = readDB();

  db.prompts =
    db.prompts.filter(
      (item) =>
        String(item.id) !==
        String(id)
    );

  writeDB(db);

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

function getApiProviders() {
  const db = readDB();

  return Array.isArray(
    db.apiProviders
  )
    ? db.apiProviders
    : [];
}

function addApiProvider(
  provider
) {
  const db = readDB();

  if (
    !Array.isArray(
      db.apiProviders
    )
  ) {
    db.apiProviders = [];
  }

  const item = {
    id:
      Date.now().toString(36) +
      Math.random()
        .toString(36)
        .slice(2, 8),

    category:
      provider.category ||
      "prompt_generate",

    providerName:
      provider.providerName ||
      "Provider",

    apiKey:
      provider.apiKey ||
      "",

    enabled:
      provider.enabled !== false,

    createdAt:
      new Date().toISOString()
  };

  db.apiProviders.push(
    item
  );

  writeDB(db);

  return item;
}

function updateApiProvider(
  id,
  changes
) {
  const db = readDB();

  const index =
    db.apiProviders.findIndex(
      (item) =>
        String(item.id) ===
        String(id)
    );

  if (index === -1) {
    return null;
  }

  /*
   * Don't accidentally replace an API key
   * with an empty value.
   */
  if (
    changes.apiKey ===
      undefined ||
    changes.apiKey === ""
  ) {
    delete changes.apiKey;
  }

  db.apiProviders[index] = {
    ...db.apiProviders[index],
    ...changes,
    updatedAt:
      new Date().toISOString()
  };

  writeDB(db);

  return db.apiProviders[index];
}

function deleteApiProvider(
  id
) {
  const db = readDB();

  db.apiProviders =
    db.apiProviders.filter(
      (item) =>
        String(item.id) !==
        String(id)
    );

  writeDB(db);

  return true;
}

/*
|--------------------------------------------------------------------------
| Settings
|--------------------------------------------------------------------------
*/

function getSettings() {
  const db = readDB();

  return {
    ...clone(
      DEFAULT_DB.settings
    ),
    ...(db.settings || {})
  };
}

function updateSettings(
  changes
) {
  const db = readDB();

  db.settings = {
    ...DEFAULT_DB.settings,
    ...(db.settings || {}),
    ...(changes || {})
  };

  writeDB(db);

  return db.settings;
}

/*
|--------------------------------------------------------------------------
| Ads
|--------------------------------------------------------------------------
*/

function getAds() {
  const db = readDB();

  return db.ads || {};
}

function updateAds(
  ads
) {
  const db = readDB();

  db.ads =
    ads &&
    typeof ads === "object"
      ? ads
      : {};

  writeDB(db);

  return db.ads;
}

/*
|--------------------------------------------------------------------------
| Database info
|--------------------------------------------------------------------------
*/

function getDatabasePath() {
  return DB_FILE;
}

/*
|--------------------------------------------------------------------------
| Export
|--------------------------------------------------------------------------
*/

module.exports = {
  DB_FILE,

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

/*
|--------------------------------------------------------------------------
| Initialize
|--------------------------------------------------------------------------
*/

ensureDatabase();
