let ADS = {};

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[m]));

const $ = (id) => document.getElementById(id);

const grid = $("grid");
const count = $("count");
const search = $("search");
const modal = $("modal");

let media = "all";
let category = "all";
let timer;


/* =========================================================
   ADS
   ========================================================= */

function frame(type) {
  const ad = ADS?.[type];

  if (!ad || ad.enabled === false || !ad.code) {
    return "";
  }

  return `
    <div class="ad-slot ad-${esc(type)}"
         style="min-height:${Number(ad.height) || 0}px">
      ${ad.code}
    </div>
  `;
}


async function loadAds() {
  try {
    const r = await fetch("/api/ads");

    if (!r.ok) {
      ADS = {};
      return;
    }

    ADS = await r.json();

    if (!ADS || typeof ADS !== "object") {
      ADS = {};
    }

    renderAds();
  } catch {
    ADS = {};
  }
}


function renderAds() {
  const slots = [
    "banner_top",
    "banner_middle",
    "banner_bottom",
    "native_banner"
  ];

  slots.forEach((type) => {
    const el = document.querySelector(
      `[data-ad-slot="${type}"]`
    );

    if (el) {
      el.innerHTML = frame(type);
    }
  });

  // Head code
  if (
    ADS.head_code &&
    ADS.head_code.enabled &&
    ADS.head_code.code
  ) {
    try {
      const wrapper = document.createElement("div");
      wrapper.innerHTML = ADS.head_code.code;

      [...wrapper.children].forEach((node) => {
        document.head.appendChild(node);
      });
    } catch (e) {
      console.error("Head ad error:", e);
    }
  }

  // Social bar
  const social = ADS.social_bar;

  if (
    social &&
    social.enabled &&
    social.code &&
    !document.getElementById("pf-social-ad")
  ) {
    const el = document.createElement("div");

    el.id = "pf-social-ad";
    el.innerHTML = social.code;

    document.body.appendChild(el);
  }

  // Popunder
  const pop = ADS.popunder;

  if (
    pop &&
    pop.enabled &&
    pop.code &&
    !window.__PF_POPUNDER_LOADED
  ) {
    window.__PF_POPUNDER_LOADED = true;

    try {
      const wrapper = document.createElement("div");
      wrapper.innerHTML = pop.code;

      [...wrapper.children].forEach((node) => {
        document.body.appendChild(node);
      });
    } catch (e) {
      console.error("Popunder error:", e);
    }
  }
}


/* =========================================================
   PROMPT CARD
   ========================================================= */

function card(p, i) {
  return `
    <article
      class="card"
      data-slug="${esc(p.slug)}"
      style="animation-delay:${Math.min(i, 12) * 45}ms"
    >

      <div class="thumb">
        ${
          p.imageUrl
            ? `
              <img
                src="${esc(p.imageUrl)}"
                loading="lazy"
                alt="${esc(p.title)}"
              >
            `
            : "<span>✦</span>"
        }
      </div>

      <div class="body">

        <div class="meta">
          ${esc(p.media || "Image")}
          ${p.model ? ` · ${esc(p.model)}` : ""}
        </div>

        <h3>${esc(p.title)}</h3>

        <div class="excerpt">
          ${esc(p.prompt)}
        </div>

        <span class="tag">
          ${esc(p.category || "AI Art")}
        </span>

      </div>

    </article>
  `;
}


/* =========================================================
   LOAD PROMPTS
   ========================================================= */

async function load() {
  if (!grid || !count || !search) {
    console.error("PromptForge: required homepage elements missing.");
    return;
  }

  try {
    const r = await fetch(
      `/api/prompts?q=${encodeURIComponent(
        search.value.trim()
      )}&media=${encodeURIComponent(
        media
      )}&category=${encodeURIComponent(category)}`
    );

    if (!r.ok) {
      throw new Error("Prompt request failed");
    }

    const items = await r.json();

    count.textContent =
      `${items.length} prompts` +
      (
        category !== "all"
          ? ` · ${category}`
          : ""
      );

    const cards = items
      .map((p, i) => {
        const html = card(p, i);

        if (
          i === 5 &&
          ADS &&
          ADS.banner_middle &&
          ADS.banner_middle.enabled
        ) {
          return (
            html +
            `<div class="adwide">${frame(
              "banner_middle"
            )}</div>`
          );
        }

        return html;
      })
      .join("");

    grid.innerHTML =
      cards ||
      '<div class="muted">No prompts found.</div>';

  } catch (e) {
    console.error(e);

    grid.innerHTML =
      '<div class="muted">Could not load prompts. Please refresh.</div>';
  }
}


/* =========================================================
   COPY
   ========================================================= */

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement("textarea");

    textarea.value = text;

    document.body.appendChild(textarea);

    textarea.select();

    document.execCommand("copy");

    textarea.remove();
  }
}


/* =========================================================
   OPEN PROMPT
   ========================================================= */

async function openPrompt(slug, push = true) {
  try {
    const r = await fetch(
      "/api/prompts/" + encodeURIComponent(slug)
    );

    if (!r.ok) {
      return;
    }

    const p = await r.json();

    if (!modal) {
      return;
    }

    const body = $("modalBody");

    if (!body) {
      return;
    }

    body.innerHTML = `
      <div class="meta">
        ${esc(p.media || "Image")}
        ${p.model ? ` · ${esc(p.model)}` : ""}
        ${p.category ? ` · ${esc(p.category)}` : ""}
      </div>

      <h2>${esc(p.title)}</h2>

      ${
        p.imageUrl
          ? `
            <img
              src="${esc(p.imageUrl)}"
              alt="${esc(p.title)}"
              style="
                width:100%;
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

      <button class="copy" id="copy">
        Copy prompt
      </button>

      <div class="lic">
        License:
        ${esc(p.license || "Provider terms")}
        · Source:
        ${esc(p.source || "PromptForge")}
      </div>

      ${frame("modal_banner")}
    `;

    modal.classList.remove("hidden");

    if (push) {
      history.pushState(
        null,
        "",
        "/p/" + encodeURIComponent(p.slug)
      );
    }

    const btn = $("copy");

    if (!btn) {
      return;
    }

    btn.onclick = async () => {
      let settings = {
        copyGateSeconds: 10,
        directLink: ""
      };

      try {
        const settingsResponse = await fetch(
          "/api/public/settings"
        );

        if (settingsResponse.ok) {
          settings = await settingsResponse.json();
        }
      } catch {
        // defaults remain
      }

      const sec = Math.max(
        0,
        Math.min(
          120,
          Number(settings.copyGateSeconds) || 10
        )
      );

      const directLink =
        settings.directLink ||
        ADS?.smart_link ||
        "";

      if (directLink) {
        window.open(
          directLink,
          "_blank",
          "noopener,noreferrer"
        );
      }

      if (sec > 0) {
        let left = sec;

        btn.disabled = true;

        btn.textContent =
          `Wait ${left}s…`;

        const interval = setInterval(() => {
          left--;

          btn.textContent =
            left
              ? `Wait ${left}s…`
              : "Copy prompt";

          if (left <= 0) {
            clearInterval(interval);

            btn.disabled = false;
          }
        }, 1000);

        btn.onclick = async () => {
          if (btn.disabled) {
            return;
          }

          await copyText(p.prompt);

          btn.textContent =
            "Copied ✓";
        };

      } else {
        await copyText(p.prompt);

        btn.textContent =
          "Copied ✓";
      }
    };

  } catch (e) {
    console.error(
      "Could not open prompt:",
      e
    );
  }
}


/* =========================================================
   CLOSE MODAL
   ========================================================= */

function closeModal() {
  if (!modal) {
    return;
  }

  modal.classList.add("hidden");

  if (
    location.pathname.startsWith("/p/")
  ) {
    history.replaceState(
      null,
      "",
      "/"
    );
  }
}


/* =========================================================
   MEDIA FILTERS
   ========================================================= */

document
  .querySelectorAll(".pill")
  .forEach((button) => {

    button.addEventListener(
      "click",
      () => {

        document
          .querySelectorAll(".pill")
          .forEach((x) =>
            x.classList.remove("active")
          );

        button.classList.add("active");

        media =
          button.dataset.media ||
          "all";

        load();
      }
    );
  });


/* =========================================================
   CATEGORY FILTERS
   ========================================================= */

document
  .querySelectorAll(".categories button")
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
          .forEach((x) => {
            x.classList.toggle(
              "on",
              x.dataset.cat === category
            );
          });

        const promptsSection =
          $("prompts");

        if (promptsSection) {
          promptsSection.scrollIntoView({
            behavior: "smooth"
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

      timer = setTimeout(
        load,
        250
      );
    }
  );
}


/* =========================================================
   PROMPT CARD CLICK
   ========================================================= */

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
        event.target === modal ||
        event.target.id === "modal"
      ) {
        closeModal();
      }
    }
  );
}


/* =========================================================
   KEYBOARD
   ========================================================= */

document.addEventListener(
  "keydown",
  (event) => {

    if (
      event.key === "Escape"
    ) {
      closeModal();
    }

    if (
      (event.ctrlKey ||
        event.metaKey) &&
      event.key.toLowerCase() === "k"
    ) {

      event.preventDefault();

      if (search) {
        search.focus();
      }
    }
  }
);


/* =========================================================
   ADMIN ACCESS
   5 CLICKS ON LOGO / BRAND
   ========================================================= */

let adminClicks = 0;
let lastAdminClick = 0;

function setupAdminAccess() {

  const brand =
    document.querySelector("#brand") ||
    document.querySelector(".brand") ||
    document.querySelector(".logo") ||
    document.querySelector("[data-brand]");

  if (!brand) {
    console.warn(
      "PromptForge: brand element not found."
    );

    return;
  }

  brand.style.cursor = "pointer";

  brand.addEventListener(
    "click",
    (event) => {

      event.preventDefault();

      const now =
        Date.now();

      if (
        now - lastAdminClick >
        2000
      ) {
        adminClicks = 0;
      }

      lastAdminClick = now;

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
   DIRECT ADMIN SHORTCUT
   ========================================================= */

if (
  location.pathname ===
  "/admin"
) {
  location.replace(
    "/admin.html"
  );
}


/* =========================================================
   DIRECT PROMPT URL
   ========================================================= */

const promptMatch =
  location.pathname.match(
    /^\/p\/([\w-]+)$/
  );

if (promptMatch) {
  openPrompt(
    promptMatch[1],
    false
  );
}


/* =========================================================
   START APP
   ========================================================= */

setupAdminAccess();

loadAds()
  .finally(() => {
    load();
  });
