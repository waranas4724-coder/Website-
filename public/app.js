let ADS = {};

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (m) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
      }[m])
  );

const safeUrl = (url) => {
  try {
    const u = new URL(String(url || ""), location.origin);
    if (u.protocol === "http:" || u.protocol === "https:") {
      return u.href;
    }
  } catch {}
  return "";
};

const frame = (key) => {
  const a = ADS?.[key];

  if (!a || a.enabled === false || !a.code) {
    return "";
  }

  const doc = `
<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
html,body{
  margin:0;
  padding:0;
  width:100%;
  min-height:100%;
  background:transparent;
}
</style>
</head>
<body>${a.code}</body>
</html>`;

  return `
    <iframe
      class="adframe"
      style="width:100%;height:${Number(a.height || 100)}px;border:0;overflow:hidden"
      sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms"
      scrolling="no"
      loading="lazy"
      srcdoc="${esc(doc)}">
    </iframe>
  `;
};

function inject(code, where) {
  if (!code || !where) return;

  try {
    const template =
      document.createElement("template");

    template.innerHTML = code;

    template.content
      .querySelectorAll("script")
      .forEach((script) => {
        const next =
          document.createElement("script");

        [...script.attributes].forEach((attr) =>
          next.setAttribute(
            attr.name,
            attr.value
          )
        );

        next.textContent =
          script.textContent || "";

        script.replaceWith(next);
      });

    where.appendChild(
      template.content
    );
  } catch (error) {
    console.warn(
      "PromptForge ad injection failed:",
      error
    );
  }
}

async function loadAds() {
  try {
    const response =
      await fetch("/api/ads", {
        cache: "no-store"
      });

    if (!response.ok) {
      throw new Error(
        `Ads HTTP ${response.status}`
      );
    }

    ADS = await response.json();
  } catch (error) {
    console.warn(
      "Could not load ads:",
      error
    );

    ADS = {};
  }

  document
    .querySelectorAll(".ad")
    .forEach((element) => {
      const slot =
        element.dataset.slot;

      element.innerHTML =
        frame(slot);
    });

  if (
    ADS?.head_code?.enabled &&
    ADS.head_code.code
  ) {
    inject(
      ADS.head_code.code,
      document.head
    );
  }

  if (
    ADS?.popunder?.enabled &&
    ADS.popunder.code
  ) {
    inject(
      ADS.popunder.code,
      document.body
    );
  }

  if (
    ADS?.social_bar?.enabled &&
    ADS.social_bar.code
  ) {
    inject(
      ADS.social_bar.code,
      document.body
    );
  }
}


/* =========================================================
   STATE
========================================================= */

let media = "all";
let category = "all";
let timer = null;

let promptsCache = [];
let copyGateSeconds = 10;
let directLink = "";

const $ = (id) =>
  document.getElementById(id);

const grid = $("grid");
const count = $("count");
const search = $("search");
const modal = $("modal");


/* =========================================================
   PUBLIC SETTINGS
========================================================= */

async function loadPublicSettings() {
  try {
    const response =
      await fetch(
        "/api/public/settings",
        {
          cache: "no-store"
        }
      );

    if (!response.ok) {
      throw new Error(
        `Settings HTTP ${response.status}`
      );
    }

    const settings =
      await response.json();

    copyGateSeconds = Math.max(
      0,
      Number(
        settings.copyGateSeconds ?? 10
      )
    );

    directLink =
      safeUrl(
        settings.directLink || ""
      );
  } catch (error) {
    console.warn(
      "Could not load public settings:",
      error
    );
  }
}


/* =========================================================
   PROMPT CARD
========================================================= */

const card = (p) => {
  const image =
    safeUrl(
      p.imageUrl ||
        p.image_url ||
        ""
    );

  return `
<article
  class="card"
  data-slug="${esc(p.slug)}"
  tabindex="0"
  role="button"
  aria-label="${esc(p.title)}"
>
  <div class="thumb">
    ${
      image
        ? `
      <img
        src="${esc(image)}"
        loading="lazy"
        alt="${esc(p.title)}"
        onerror="this.style.display='none'"
      >
      `
        : `
      <div class="placeholder">
        ✦
      </div>
      `
    }
  </div>

  <div class="body">
    <div class="meta">
      ${esc(p.media || "Image")}
      ·
      ${esc(p.model || "AI")}
    </div>

    <h3>
      ${esc(p.title)}
    </h3>

    <div class="excerpt">
      ${esc(p.prompt)}
    </div>

    <span class="tag">
      ${esc(p.category || "General")}
    </span>
  </div>
</article>
`;
};


/* =========================================================
   LOAD PROMPTS
========================================================= */

async function load() {
  if (!grid) return;

  grid.innerHTML =
    `<div class="muted">Loading prompts...</div>`;

  try {
    const params =
      new URLSearchParams();

    const query =
      search?.value?.trim() || "";

    if (query) {
      params.set("q", query);
    }

    if (media !== "all") {
      params.set(
        "media",
        media
      );
    }

    if (category !== "all") {
      params.set(
        "category",
        category
      );
    }

    const response =
      await fetch(
        `/api/prompts?${params.toString()}`,
        {
          cache: "no-store"
        }
      );

    if (!response.ok) {
      throw new Error(
        `Prompts HTTP ${response.status}`
      );
    }

    const items =
      await response.json();

    promptsCache =
      Array.isArray(items)
        ? items
        : [];

    count.textContent =
      `${promptsCache.length} prompts` +
      (
        category !== "all"
          ? ` · ${category}`
          : ""
      );

    if (!promptsCache.length) {
      grid.innerHTML = `
        <div class="muted">
          No prompts found.
        </div>
      `;

      return;
    }

    const output = [];

    promptsCache.forEach(
      (prompt, index) => {
        output.push(
          card(prompt)
        );

        if (
          index === 5 &&
          ADS?.banner_middle?.enabled
        ) {
          output.push(`
            <div class="adwide">
              ${frame("banner_middle")}
            </div>
          `);
        }
      }
    );

    grid.innerHTML =
      output.join("");
  } catch (error) {
    console.error(
      "Prompt loading failed:",
      error
    );

    grid.innerHTML = `
      <div class="muted">
        Could not load prompts.
        Please refresh.
      </div>
    `;
  }
}


/* =========================================================
   COPY
========================================================= */

async function copyText(text) {
  try {
    if (
      navigator.clipboard &&
      window.isSecureContext
    ) {
      await navigator.clipboard.writeText(
        text
      );

      return true;
    }
  } catch {}

  try {
    const textarea =
      document.createElement(
        "textarea"
      );

    textarea.value = text;

    textarea.style.position =
      "fixed";
    textarea.style.left =
      "-9999px";

    document.body.appendChild(
      textarea
    );

    textarea.select();

    const success =
      document.execCommand(
        "copy"
      );

    textarea.remove();

    return success;
  } catch {
    return false;
  }
}


/* =========================================================
   COPY GATE
========================================================= */

async function copyWithGate(
  prompt,
  button
) {
  if (!button) return;

  if (
    button.dataset.unlocked ===
    "true"
  ) {
    const ok =
      await copyText(prompt);

    button.textContent =
      ok
        ? "Copied ✓"
        : "Copy failed";

    if (ok) {
      setTimeout(() => {
        button.textContent =
          "Copy prompt";
      }, 1800);
    }

    return;
  }

  const seconds =
    Math.max(
      0,
      Number(copyGateSeconds || 0)
    );

  if (
    seconds <= 0
  ) {
    button.dataset.unlocked =
      "true";

    return copyWithGate(
      prompt,
      button
    );
  }

  if (
    directLink
  ) {
    try {
      window.open(
        directLink,
        "_blank",
        "noopener,noreferrer"
      );
    } catch {}
  }

  let remaining =
    seconds;

  button.disabled =
    true;

  button.textContent =
    `Please wait ${remaining}s`;

  const interval =
    setInterval(() => {
      remaining--;

      if (
        remaining <= 0
      ) {
        clearInterval(
          interval
        );

        button.disabled =
          false;

        button.dataset.unlocked =
          "true";

        button.textContent =
          "Copy prompt";

        return;
      }

      button.textContent =
        `Please wait ${remaining}s`;
    }, 1000);
}


/* =========================================================
   OPEN PROMPT
========================================================= */

async function openPrompt(
  slug,
  push = true
) {
  if (!modal) return;

  try {
    const response =
      await fetch(
        "/api/prompts/" +
          encodeURIComponent(
            slug
          ),
        {
          cache: "no-store"
        }
      );

    if (!response.ok) {
      throw new Error(
        `Prompt HTTP ${response.status}`
      );
    }

    const p =
      await response.json();

    const image =
      safeUrl(
        p.imageUrl ||
          p.image_url ||
          ""
      );

    const modalBody =
      $("modalBody");

    if (!modalBody) return;

    modalBody.innerHTML = `
      <div class="meta">
        ${esc(
          p.media ||
            "Image"
        )}
        ·
        ${esc(
          p.model ||
            "AI"
        )}
        ·
        ${esc(
          p.category ||
            "General"
        )}
      </div>

      <h2>
        ${esc(p.title)}
      </h2>

      ${
        image
          ? `
        <img
          src="${esc(image)}"
          alt="${esc(p.title)}"
          style="
            width:100%;
            max-height:600px;
            object-fit:cover;
            border-radius:14px;
            margin-bottom:16px;
          "
        >
        `
          : ""
      }

      <div class="fullprompt">
        ${esc(p.prompt)}
      </div>

      <button
        class="copy"
        id="copy"
        type="button"
      >
        Copy prompt
      </button>

      <div class="lic">
        License:
        ${esc(
          p.license ||
            "CC0-1.0"
        )}

        · Source:
        ${
          p.sourceUrl
            ? `
          <a
            href="${esc(
              safeUrl(
                p.sourceUrl
              )
            )}"
            target="_blank"
            rel="noopener noreferrer"
          >
            ${esc(
              p.source ||
                "Source"
            )}
          </a>
          `
            : esc(
                p.source ||
                  "PromptForge"
              )
        }
      </div>

      ${
        ADS?.modal_banner?.enabled
          ? frame(
              "modal_banner"
            )
          : ""
      }
    `;

    modal.classList.remove(
      "hidden"
    );

    if (push) {
      history.pushState(
        null,
        "",
        "/p/" +
          encodeURIComponent(
            p.slug
          )
      );
    }

    const copyButton =
      $("copy");

    if (copyButton) {
      copyButton.onclick =
        () =>
          copyWithGate(
            p.prompt,
            copyButton
          );
    }
  } catch (error) {
    console.error(
      "Open prompt failed:",
      error
    );
  }
}


/* =========================================================
   CLOSE MODAL
========================================================= */

function closeModal() {
  if (!modal) return;

  modal.classList.add(
    "hidden"
  );

  if (
    location.pathname.startsWith(
      "/p/"
    )
  ) {
    history.replaceState(
      null,
      "",
      "/"
    );
  }
}


/* =========================================================
   MEDIA FILTER
========================================================= */

document
  .querySelectorAll(
    ".pill"
  )
  .forEach((button) => {
    button.addEventListener(
      "click",
      () => {
        document
          .querySelectorAll(
            ".pill"
          )
          .forEach((x) =>
            x.classList.remove(
              "active"
            )
          );

        button.classList.add(
          "active"
        );

        media =
          button.dataset.media ||
          "all";

        load();
      }
    );
  });


/* =========================================================
   CATEGORY FILTER
========================================================= */

document
  .querySelectorAll(
    ".categories button"
  )
  .forEach((button) => {
    button.addEventListener(
      "click",
      () => {
        category =
          category ===
          button.dataset.cat
            ? "all"
            : button.dataset.cat;

        document
          .querySelectorAll(
            ".categories button"
          )
          .forEach((x) =>
            x.classList.toggle(
              "on",
              x.dataset.cat ===
                category
            )
          );

        const prompts =
          $("prompts");

        if (prompts) {
          prompts.scrollIntoView({
            behavior: "smooth",
            block: "start"
          });
        }

        load();
      }
    );
  });


/* =========================================================
   SEARCH
========================================================= */

if (search) {
  search.addEventListener(
    "input",
    () => {
      clearTimeout(timer);

      timer =
        setTimeout(
          load,
          250
        );
    }
  );
}


/* =========================================================
   CARD CLICK
========================================================= */

if (grid) {
  grid.addEventListener(
    "click",
    (event) => {
      const card =
        event.target.closest(
          ".card"
        );

      if (!card) return;

      const slug =
        card.dataset.slug;

      if (slug) {
        openPrompt(slug);
      }
    }
  );

  grid.addEventListener(
    "keydown",
    (event) => {
      if (
        event.key !==
          "Enter" &&
        event.key !==
          " "
      ) {
        return;
      }

      const card =
        event.target.closest(
          ".card"
        );

      if (!card) return;

      event.preventDefault();

      const slug =
        card.dataset.slug;

      if (slug) {
        openPrompt(slug);
      }
    }
  );
}


/* =========================================================
   MODAL EVENTS
========================================================= */

const closeButton =
  $("close");

if (closeButton) {
  closeButton.addEventListener(
    "click",
    closeModal
  );
}

if (modal) {
  modal.addEventListener(
    "click",
    (event) => {
      if (
        event.target ===
        modal
      ) {
        closeModal();
      }
    }
  );
}

document.addEventListener(
  "keydown",
  (event) => {
    if (
      event.key ===
      "Escape"
    ) {
      closeModal();
    }
  }
);

window.addEventListener(
  "popstate",
  () => {
    const match =
      location.pathname.match(
        /^\/p\/([\w-]+)/
      );

    if (match) {
      openPrompt(
        match[1],
        false
      );
    } else {
      closeModal();
    }
  }
);


/* =========================================================
   HIDDEN ADMIN ACCESS
   5 CLICKS ON LOGO
========================================================= */

let adminClicks = 0;
let lastAdminClick = 0;

function setupAdminAccess() {
  const brand =
    document.querySelector(
      "#brand"
    ) ||
    document.querySelector(
      ".brand"
    ) ||
    document.querySelector(
      ".logo"
    ) ||
    document.querySelector(
      "[data-brand]"
    );

  if (!brand) {
    console.warn(
      "PromptForge: brand element not found."
    );

    return;
  }

  brand.style.cursor =
    "pointer";

  brand.addEventListener(
    "click",
    (event) => {
      event.preventDefault();

      const now =
        Date.now();

      if (
        now -
          lastAdminClick >
        2000
      ) {
        adminClicks = 0;
      }

      lastAdminClick =
        now;

      adminClicks++;

      if (
        adminClicks >= 5
      ) {
        adminClicks = 0;

        window.location.href =
          "/admin.html";
      }
    }
  );
}


/* =========================================================
   AUTO REFRESH
   New automatic posts will appear without
   manually refreshing the page.
========================================================= */

let refreshTimer = null;

function startAutoRefresh() {
  clearInterval(
    refreshTimer
  );

  refreshTimer =
    setInterval(
      () => {
        if (
          document.hidden
        ) {
          return;
        }

        load();
      },
      60 * 1000
    );
}


/* =========================================================
   START
========================================================= */

async function init() {
  setupAdminAccess();

  await Promise.all([
    loadAds(),
    loadPublicSettings()
  ]);

  await load();

  startAutoRefresh();
}

init().catch((error) => {
  console.error(
    "PromptForge startup failed:",
    error
  );
});
