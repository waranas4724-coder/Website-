"use strict";

let ADS = {};
let SETTINGS = {};

let media = "all";
let category = "all";
let timer = null;

const $ = (id) => document.getElementById(id);

const grid = $("grid");
const count = $("count");
const search = $("search");
const modal = $("modal");

function esc(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    }[char])
  );
}

/* ------------------------------
   API helper
------------------------------ */

async function getJSON(url) {
  const response = await fetch(url, {
    credentials: "same-origin"
  });

  if (!response.ok) {
    throw new Error("Request failed");
  }

  return response.json();
}

/* ------------------------------
   Ads
------------------------------ */

function frame(slot) {
  const ad = ADS?.[slot];

  if (!ad || ad.enabled === false || !ad.code) {
    return "";
  }

  const height = Number(ad.height || 100);

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
  overflow:hidden;
  background:transparent;
}
</style>
</head>
<body>
${ad.code}
</body>
</html>`;

  return `
    <iframe
      class="adframe"
      title="Advertisement"
      style="
        width:100%;
        height:${height}px;
        border:0;
        display:block;
        overflow:hidden;
      "
      sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms"
      scrolling="no"
      loading="lazy"
      srcdoc="${esc(doc)}"
    ></iframe>
  `;
}

/* ------------------------------
   Safe code injection
------------------------------ */

function inject(code, where) {
  if (!code || !where) return;

  const template =
    document.createElement("template");

  template.innerHTML = code;

  template.content
    .querySelectorAll("script")
    .forEach((script) => {

      const replacement =
        document.createElement("script");

      [...script.attributes].forEach(
        (attribute) => {
          replacement.setAttribute(
            attribute.name,
            attribute.value
          );
        }
      );

      replacement.text =
        script.textContent || "";

      script.replaceWith(replacement);
    });

  where.appendChild(template.content);
}

/* ------------------------------
   Load Ads
------------------------------ */

async function loadAds() {
  try {

    const data =
      await getJSON("/api/ads");

    ADS = data?.ads || data || {};

  } catch (error) {

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

  /*
   * Only inject enabled ad code.
   */

  if (
    ADS.head_code?.enabled &&
    ADS.head_code.code
  ) {
    inject(
      ADS.head_code.code,
      document.head
    );
  }

  if (
    ADS.popunder?.enabled &&
    ADS.popunder.code
  ) {
    inject(
      ADS.popunder.code,
      document.body
    );
  }

  if (
    ADS.social_bar?.enabled &&
    ADS.social_bar.code
  ) {
    inject(
      ADS.social_bar.code,
      document.body
    );
  }
}

/* ------------------------------
   Public Settings
------------------------------ */

async function loadSettings() {
  try {

    const data =
      await getJSON(
        "/api/public/settings"
      );

    SETTINGS =
      data?.settings ||
      data ||
      {};

  } catch (error) {

    SETTINGS = {
      copyGateSeconds: 10,
      directLink: ""
    };

  }
}

/* ------------------------------
   Render Card
------------------------------ */

function card(p) {

  const image =
    p.imageUrl ||
    "";

  const mediaType =
    p.media ||
    "Image";

  const model =
    p.model ||
    "AI";

  const title =
    p.title ||
    "Untitled Prompt";

  const prompt =
    p.prompt ||
    "";

  const cat =
    p.category ||
    "AI";

  return `
    <article
      class="card"
      data-slug="${esc(p.slug)}"
    >

      <div class="thumb">

        ${
          image
            ? `
              <img
                src="${esc(image)}"
                loading="lazy"
                alt="${esc(title)}"
              >
            `
            : `
              <div class="empty-thumb">
                ✦
              </div>
            `
        }

      </div>

      <div class="body">

        <div class="meta">
          ${esc(mediaType)}
          ·
          ${esc(model)}
        </div>

        <h3>
          ${esc(title)}
        </h3>

        <div class="excerpt">
          ${esc(prompt)}
        </div>

        <span class="tag">
          ${esc(cat)}
        </span>

      </div>

    </article>
  `;
}

/* ------------------------------
   Load Prompts
------------------------------ */

async function load() {

  if (!grid) return;

  const query =
    search?.value?.trim() || "";

  try {

    const url =
      `/api/prompts` +
      `?q=${encodeURIComponent(query)}` +
      `&media=${encodeURIComponent(media)}` +
      `&category=${encodeURIComponent(category)}`;

    const data =
      await getJSON(url);

    const items =
      Array.isArray(data)
        ? data
        : (
            data?.prompts ||
            data?.items ||
            data?.data ||
            []
          );

    if (count) {

      count.textContent =
        `${items.length} prompts` +
        (
          category !== "all"
            ? ` · ${category}`
            : ""
        );

    }

    if (!items.length) {

      grid.innerHTML = `
        <div class="muted">
          No prompts found.
        </div>
      `;

      return;
    }

    let html = "";

    items.forEach((item, index) => {

      html += card(item);

      /*
       * Middle banner after 6th post.
       */

      if (
        index === 5 &&
        ADS.banner_middle?.enabled &&
        ADS.banner_middle.code
      ) {

        html += `
          <div class="adwide">
            ${frame("banner_middle")}
          </div>
        `;

      }

    });

    grid.innerHTML = html;

  } catch (error) {

    console.error(
      "Prompt loading error:",
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

/* ------------------------------
   Copy
------------------------------ */

async function copyText(text) {

  try {

    await navigator.clipboard.writeText(
      text
    );

    return true;

  } catch (_) {

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

      textarea.focus();
      textarea.select();

      const success =
        document.execCommand(
          "copy"
        );

      textarea.remove();

      return success;

    } catch (_) {

      return false;

    }

  }
}

/* ------------------------------
   Copy Gate
------------------------------ */

async function startCopyGate(prompt) {

  const button =
    $("copy");

  if (!button) return;

  /*
   * Prevent duplicate click.
   */

  if (
    button.dataset.processing === "1"
  ) {
    return;
  }

  button.dataset.processing = "1";

  const seconds = Math.max(
    0,
    Number(
      SETTINGS.copyGateSeconds ?? 10
    )
  );

  const directLink =
    SETTINGS.directLink ||
    "";

  /*
   * Open configured direct link.
   */

  if (directLink) {

    try {

      window.open(
        directLink,
        "_blank",
        "noopener,noreferrer"
      );

    } catch (_) {}

  }

  /*
   * No countdown requested.
   */

  if (seconds <= 0) {

    const copied =
      await copyText(prompt);

    button.textContent =
      copied
        ? "Copied ✓"
        : "Copy failed";

    button.dataset.processing = "0";

    return;
  }

  let remaining =
    seconds;

  button.disabled = true;

  button.textContent =
    `Wait ${remaining}s`;

  const interval =
    setInterval(
      async () => {

        remaining--;

        if (remaining > 0) {

          button.textContent =
            `Wait ${remaining}s`;

          return;

        }

        clearInterval(interval);

        button.disabled = false;

        button.textContent =
          "Copy prompt";

        button.dataset.processing =
          "0";

        const copied =
          await copyText(prompt);

        button.textContent =
          copied
            ? "Copied ✓"
            : "Copy failed";

      },
      1000
    );

}

/* ------------------------------
   Open Prompt
------------------------------ */

async function openPrompt(
  slug,
  push = true
) {

  if (!slug || !modal) {
    return;
  }

  try {

    const data =
      await getJSON(
        "/api/prompts/" +
        encodeURIComponent(slug)
      );

    const p =
      data?.prompt ||
      data;

    if (!p) return;

    const image =
      p.imageUrl ||
      "";

    const mediaType =
      p.media ||
      "Image";

    const model =
      p.model ||
      "AI";

    const cat =
      p.category ||
      "AI";

    const title =
      p.title ||
      "Untitled Prompt";

    const prompt =
      p.prompt ||
      "";

    const source =
      p.source ||
      "PromptForge";

    const license =
      p.license ||
      "CC0-1.0";

    $("modalBody").innerHTML = `
      <div class="meta">
        ${esc(mediaType)}
        ·
        ${esc(model)}
        ·
        ${esc(cat)}
      </div>

      <h2>
        ${esc(title)}
      </h2>

      ${
        image
          ? `
            <img
              src="${esc(image)}"
              alt="${esc(title)}"
              style="
                width:100%;
                border-radius:14px;
                margin-bottom:16px;
                display:block;
              "
            >
          `
          : ""
      }

      <div class="fullprompt">
        ${esc(prompt)}
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
        ${esc(license)}
        ·
        Source:
        ${esc(source)}
      </div>

      ${
        ADS.modal_banner?.enabled &&
        ADS.modal_banner.code
          ? frame("modal_banner")
          : ""
      }
    `;

    modal.classList.remove(
      "hidden"
    );

    document.body.classList.add(
      "modal-open"
    );

    if (
      push &&
      p.slug
    ) {

      history.pushState(
        {
          prompt: p.slug
        },
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
        () => startCopyGate(prompt);

    }

  } catch (error) {

    console.error(
      "Prompt open error:",
      error
    );

  }

}

/* ------------------------------
   Close Modal
------------------------------ */

function closeModal() {

  if (!modal) return;

  modal.classList.add(
    "hidden"
  );

  document.body.classList.remove(
    "modal-open"
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

/* ------------------------------
   Media Filters
------------------------------ */

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
          .forEach((item) => {

            item.classList.remove(
              "active"
            );

          });

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

/* ------------------------------
   Categories
------------------------------ */

document
  .querySelectorAll(
    ".categories button"
  )
  .forEach((button) => {

    button.addEventListener(
      "click",
      () => {

        const selected =
          button.dataset.cat ||
          "all";

        category =
          category === selected
            ? "all"
            : selected;

        document
          .querySelectorAll(
            ".categories button"
          )
          .forEach((item) => {

            item.classList.toggle(
              "on",
              item.dataset.cat ===
                category
            );

          });

        const promptsSection =
          $("prompts");

        if (
          promptsSection
        ) {

          promptsSection.scrollIntoView({
            behavior: "smooth",
            block: "start"
          });

        }

        load();

      }
    );

  });

/* ------------------------------
   Search
------------------------------ */

if (search) {

  search.addEventListener(
    "input",
    () => {

      clearTimeout(timer);

      timer = setTimeout(
        load,
        250
      );

    }
  );

}

/* ------------------------------
   Grid Click
------------------------------ */

if (grid) {

  grid.addEventListener(
    "click",
    (event) => {

      const cardElement =
        event.target.closest(
          ".card"
        );

      if (!cardElement) {
        return;
      }

      const slug =
        cardElement.dataset.slug;

      if (slug) {
        openPrompt(slug);
      }

    }
  );

}

/* ------------------------------
   Modal Controls
------------------------------ */

if ($("close")) {

  $("close").addEventListener(
    "click",
    closeModal
  );

}

if (modal) {

  modal.addEventListener(
    "click",
    (event) => {

      if (
        event.target === modal
      ) {
        closeModal();
      }

    }
  );

}

/* ------------------------------
   Escape Key
------------------------------ */

document.addEventListener(
  "keydown",
  (event) => {

    if (
      event.key === "Escape" &&
      modal &&
      !modal.classList.contains(
        "hidden"
      )
    ) {

      closeModal();

    }

  }
);

/* ------------------------------
   Browser Back Button
------------------------------ */

window.addEventListener(
  "popstate",
  () => {

    const match =
      location.pathname.match(
        /^\/p\/([\w-]+)$/
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

/* ------------------------------
   Hidden Admin Access
   5 logo clicks
------------------------------ */

let clicks = 0;
let lastClick = 0;

const brand =
  $("brand");

if (brand) {

  brand.addEventListener(
    "click",
    () => {

      const now =
        Date.now();

      /*
       * Reset if clicks are
       * too far apart.
       */

      if (
        now - lastClick >
        1800
      ) {
        clicks = 0;
      }

      lastClick = now;

      clicks++;

      if (clicks >= 5) {

        clicks = 0;

        location.href =
          "/admin.html";

      }

    }
  );

}

/* ------------------------------
   Initial Route
------------------------------ */

const routeMatch =
  location.pathname.match(
    /^\/p\/([\w-]+)$/
  );

/* ------------------------------
   Start App
------------------------------ */

async function startApp() {

  /*
   * Load settings + ads first,
   * then render content.
   */

  await Promise.all([
    loadSettings(),
    loadAds()
  ]);

  /*
   * If user directly opens /p/slug
   */

  if (routeMatch) {

    await openPrompt(
      routeMatch[1],
      false
    );

    return;

  }

  /*
   * Normal homepage
   */

  await load();

}

startApp();
