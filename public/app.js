"use strict";

/*
|--------------------------------------------------------------------------
| PromptForge Frontend
|--------------------------------------------------------------------------
| Flow:
|
| Trending topic
|      ↓
| AI prompt
|      ↓
| AI generated image
|      ↓
| One published post
|      ↓
| Photo + exact prompt
|--------------------------------------------------------------------------
*/


/*
|--------------------------------------------------------------------------
| State
|--------------------------------------------------------------------------
*/

let ADS = {};
let SETTINGS = {};

let media = "all";
let category = "all";

let searchTimer = null;
let copyTimer = null;

let logoClicks = 0;
let logoLastClick = 0;


/*
|--------------------------------------------------------------------------
| Helpers
|--------------------------------------------------------------------------
*/

const $ = (id) =>
  document.getElementById(id);

const $$ = (selector) =>
  [...document.querySelectorAll(selector)];


function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}


async function api(url, options = {}) {
  const response = await fetch(
    url,
    {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    }
  );

  let data = {};

  try {
    data = await response.json();
  } catch (_) {}

  if (!response.ok) {
    throw new Error(
      data.error ||
      `Request failed (${response.status})`
    );
  }

  return data;
}


/*
|--------------------------------------------------------------------------
| Add premium YouMind-style CSS
|--------------------------------------------------------------------------
*/

function installPremiumStyles() {
  if ($("#promptforgeRuntimeStyles")) {
    return;
  }

  const style =
    document.createElement("style");

  style.id =
    "promptforgeRuntimeStyles";

  style.textContent = `
    .pf-card {
      position: relative;
      overflow: hidden;
      cursor: pointer;
      transition:
        transform .25s ease,
        box-shadow .25s ease,
        border-color .25s ease;
    }

    .pf-card:hover {
      transform: translateY(-5px);
      box-shadow:
        0 20px 45px rgba(0,0,0,.14);
    }

    .pf-image-wrap {
      position: relative;
      overflow: hidden;
      background: #eee9df;
    }

    .pf-image-wrap img {
      width: 100%;
      display: block;
      aspect-ratio: 4 / 3;
      object-fit: cover;
      transition: transform .5s ease;
    }

    .pf-card:hover .pf-image-wrap img {
      transform: scale(1.025);
    }

    .pf-no-image {
      aspect-ratio: 4 / 3;
      display: grid;
      place-items: center;
      font-size: 42px;
      background:
        linear-gradient(
          135deg,
          #eee8dc,
          #d9d0c0
        );
    }

    .pf-card-content {
      padding: 18px;
    }

    .pf-card-title {
      margin: 7px 0 9px;
      font-size: 20px;
      line-height: 1.15;
      font-weight: 900;
      letter-spacing: -.025em;
    }

    .pf-prompt-preview {
      color: #57534d;
      font-family:
        ui-monospace,
        SFMono-Regular,
        Menlo,
        Monaco,
        Consolas,
        monospace;
      font-size: 12px;
      line-height: 1.65;
      display: -webkit-box;
      -webkit-line-clamp: 4;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .pf-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 14px;
    }

    .pf-tag {
      display: inline-flex;
      align-items: center;
      padding: 6px 9px;
      border-radius: 999px;
      background: #f7e894;
      color: #29271e;
      font-size: 10px;
      font-weight: 800;
    }

    .pf-published {
      margin-top: 12px;
      color: #88827a;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: .08em;
      font-weight: 800;
    }

    .pf-prompt-box {
      background: #fff1a6;
      border: 2px solid #222;
      border-radius: 16px;
      overflow: hidden;
      margin: 18px 0;
      box-shadow:
        4px 5px 0 #222;
    }

    .pf-prompt-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      padding: 13px 15px;
      border-bottom: 2px solid #222;
      background: #f7f1df;
    }

    .pf-prompt-label {
      font-size: 13px;
      font-weight: 950;
      letter-spacing: .14em;
    }

    .pf-prompt-body {
      padding: 18px;
      white-space: pre-wrap;
      font-family:
        ui-monospace,
        SFMono-Regular,
        Menlo,
        Monaco,
        Consolas,
        monospace;
      font-size: 13px;
      line-height: 1.75;
      color: #29261f;
      max-height: 500px;
      overflow: auto;
    }

    .pf-copy-btn {
      width: 100%;
      border: 0;
      border-radius: 13px;
      padding: 14px 18px;
      background: #111;
      color: #fff;
      font-weight: 900;
      cursor: pointer;
      transition:
        transform .2s ease,
        opacity .2s ease;
    }

    .pf-copy-btn:hover {
      transform: translateY(-1px);
    }

    .pf-copy-btn:disabled {
      cursor: wait;
      opacity: .65;
    }

    .pf-copy-countdown {
      margin-top: 8px;
      text-align: center;
      color: #716c64;
      font-size: 11px;
      line-height: 1.5;
    }

    .pf-meta-grid {
      display: grid;
      grid-template-columns:
        repeat(3, minmax(0,1fr));
      gap: 8px;
      margin: 16px 0;
    }

    .pf-meta-box {
      border: 1.5px solid #25231f;
      border-radius: 11px;
      padding: 10px;
      background: #faf6ed;
    }

    .pf-meta-label {
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: .08em;
      color: #817a70;
      font-weight: 800;
    }

    .pf-meta-value {
      margin-top: 4px;
      font-size: 12px;
      font-weight: 900;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .pf-similar {
      margin: 18px 0 10px;
      font-size: 20px;
      font-weight: 950;
    }

    .pf-similar-sub {
      color: #716c64;
      font-size: 12px;
      margin-bottom: 10px;
    }

    .pf-author-box {
      border: 1.5px solid #29251f;
      border-radius: 13px;
      padding: 13px;
      background: #faf6ed;
      margin-top: 16px;
    }

    .pf-author-name {
      font-weight: 900;
      font-size: 13px;
    }

    .pf-author-sub {
      color: #817a70;
      font-size: 10px;
      margin-top: 3px;
    }

    .pf-modal-image {
      width: 100%;
      display: block;
      max-height: 620px;
      object-fit: contain;
      border-radius: 14px;
      margin: 12px 0 20px;
      background: #ece6db;
    }

    .pf-ad-slot {
      width: 100%;
      margin: 16px 0;
    }

    .pf-ad-frame {
      width: 100%;
      border: 0;
      display: block;
      overflow: hidden;
    }

    @media(max-width:650px) {
      .pf-card-title {
        font-size: 18px;
      }

      .pf-card-content {
        padding: 14px;
      }

      .pf-meta-grid {
        grid-template-columns: 1fr;
      }

      .pf-prompt-body {
        font-size: 12px;
      }
    }
  `;

  document.head.appendChild(style);
}


/*
|--------------------------------------------------------------------------
| Ads
|--------------------------------------------------------------------------
*/

function buildAdFrame(slot) {
  const ad =
    ADS[slot];

  if (
    !ad ||
    ad.enabled !== true ||
    !ad.code
  ) {
    return "";
  }

  const documentHtml = `
    <!doctype html>
    <html>
      <head>
        <meta name="viewport"
          content="width=device-width,initial-scale=1">
        <style>
          html,body {
            margin:0;
            padding:0;
            width:100%;
            overflow:hidden;
            background:transparent;
          }
          body {
            display:flex;
            justify-content:center;
            align-items:center;
          }
        </style>
      </head>
      <body>
        ${ad.code}
      </body>
    </html>
  `;

  return `
    <iframe
      class="pf-ad-frame"
      style="
        height:${Number(ad.height || 100)}px;
      "
      sandbox="
        allow-scripts
        allow-popups
        allow-popups-to-escape-sandbox
        allow-forms
      "
      scrolling="no"
      loading="lazy"
      srcdoc="${esc(documentHtml)}"
    ></iframe>
  `;
}


function injectAdCode(
  code,
  target
) {
  if (!code || !target) {
    return;
  }

  const template =
    document.createElement(
      "template"
    );

  template.innerHTML =
    code;

  template.content
    .querySelectorAll(
      "script"
    )
    .forEach(
      (script) => {

        const newScript =
          document.createElement(
            "script"
          );

        [...script.attributes]
          .forEach(
            (attribute) => {
              newScript.setAttribute(
                attribute.name,
                attribute.value
              );
            }
          );

        newScript.text =
          script.textContent;

        script.replaceWith(
          newScript
        );
      }
    );

  target.appendChild(
    template.content
  );
}


function renderAdSlot(
  slot
) {
  const elements =
    document.querySelectorAll(
      `[data-slot="${slot}"]`
    );

  elements.forEach(
    (element) => {
      element.innerHTML =
        buildAdFrame(slot);
    }
  );
}


function renderAds() {

  [
    "banner_top",
    "banner_middle",
    "banner_bottom",
    "native_banner",
    "modal_banner"
  ].forEach(
    renderAdSlot
  );


  /*
   * Head code
   */

  if (
    ADS.head_code &&
    ADS.head_code.enabled &&
    ADS.head_code.code
  ) {
    injectAdCode(
      ADS.head_code.code,
      document.head
    );
  }


  /*
   * Popunder
   */

  if (
    ADS.popunder &&
    ADS.popunder.enabled &&
    ADS.popunder.code &&
    !sessionStorage.getItem(
      "pf_popunder_loaded"
    )
  ) {

    sessionStorage.setItem(
      "pf_popunder_loaded",
      "1"
    );

    setTimeout(
      () => {
        injectAdCode(
          ADS.popunder.code,
          document.body
        );
      },
      1200
    );
  }


  /*
   * Social bar
   */

  if (
    ADS.social_bar &&
    ADS.social_bar.enabled &&
    ADS.social_bar.code
  ) {

    injectAdCode(
      ADS.social_bar.code,
      document.body
    );
  }
}


async function loadAds() {

  try {

    ADS =
      await api(
        "/api/ads"
      );

    renderAds();

  } catch (error) {

    console.warn(
      "Ads could not load:",
      error
    );

  }
}


/*
|--------------------------------------------------------------------------
| Public settings
|--------------------------------------------------------------------------
*/

async function loadSettings() {

  try {

    SETTINGS =
      await api(
        "/api/public/settings"
      );

  } catch (error) {

    SETTINGS = {
      copyGateSeconds: 10,
      directLink: ""
    };

  }
}


/*
|--------------------------------------------------------------------------
| Prompt card
|--------------------------------------------------------------------------
*/

function getPublishedDate(
  post
) {
  const date =
    post.publishedAt ||
    post.createdAt;

  if (!date) {
    return "";
  }

  try {

    return new Date(
      date
    ).toLocaleDateString(
      undefined,
      {
        year: "numeric",
        month: "short",
        day: "numeric"
      }
    );

  } catch (_) {

    return "";
  }
}


function card(
  post
) {

  const image =
    post.imageUrl
      ? `
        <div class="pf-image-wrap">
          <img
            src="${esc(
              post.imageUrl
            )}"
            alt="${esc(
              post.title
            )}"
            loading="lazy"
          />
        </div>
      `
      : `
        <div class="pf-no-image">
          ✦
        </div>
      `;


  const tags = [
    post.category,
    post.model,
    post.media
  ]
    .filter(Boolean)
    .slice(0, 3);


  return `
    <article
      class="card pf-card"
      data-slug="${esc(
        post.slug
      )}"
    >

      ${image}

      <div class="pf-card-content">

        <div class="meta">
          ${esc(
            post.media ||
            "Image"
          )}
          ·
          ${esc(
            post.model ||
            "AI"
          )}
        </div>

        <h3 class="pf-card-title">
          ${esc(
            post.title ||
            "Untitled Prompt"
          )}
        </h3>

        <div class="pf-prompt-preview">
          ${esc(
            post.prompt ||
            ""
          )}
        </div>

        ${
          tags.length
            ? `
              <div class="pf-tags">
                ${tags
                  .map(
                    (tag) =>
                      `<span class="pf-tag">
                        ${esc(tag)}
                      </span>`
                  )
                  .join("")}
              </div>
            `
            : ""
        }

        ${
          getPublishedDate(post)
            ? `
              <div class="pf-published">
                Published ·
                ${esc(
                  getPublishedDate(
                    post
                  )
                )}
              </div>
            `
            : ""
        }

      </div>

    </article>
  `;
}


/*
|--------------------------------------------------------------------------
| Load posts
|--------------------------------------------------------------------------
*/

async function load() {

  const grid =
    $("grid");

  const count =
    $("count");

  const search =
    $("search");

  if (!grid) {
    return;
  }


  try {

    const query =
      new URLSearchParams();

    query.set(
      "q",
      search
        ? search.value.trim()
        : ""
    );

    query.set(
      "media",
      media
    );

    query.set(
      "category",
      category
    );


    const response =
      await fetch(
        `/api/prompts?${query.toString()}`
      );


    if (!response.ok) {
      throw new Error(
        "Could not load prompts"
      );
    }


    const posts =
      await response.json();


    if (count) {

      count.textContent =
        `${posts.length} prompts`;
    }


    const output = [];


    posts.forEach(
      (post, index) => {

        output.push(
          card(post)
        );


        /*
         * Middle ad after 5 posts
         */

        if (
          index === 4 &&
          ADS.banner_middle &&
          ADS.banner_middle.enabled
        ) {

          output.push(`
            <div class="adwide pf-ad-slot">
              ${buildAdFrame(
                "banner_middle"
              )}
            </div>
          `);

        }

      }
    );


    grid.innerHTML =
      output.join("") ||
      `
        <div class="muted">
          No prompts found.
        </div>
      `;


  } catch (error) {

    console.error(
      error
    );

    grid.innerHTML =
      `
        <div class="muted">
          Could not load prompts.
          Please refresh.
        </div>
      `;

  }
}


/*
|--------------------------------------------------------------------------
| Copy
|--------------------------------------------------------------------------
*/

async function copyText(
  text
) {

  try {

    await navigator
      .clipboard
      .writeText(text);

    return true;

  } catch (_) {

    try {

      const textarea =
        document.createElement(
          "textarea"
        );

      textarea.value =
        text;

      textarea.style.position =
        "fixed";

      textarea.style.left =
        "-9999px";

      document.body.appendChild(
        textarea
      );

      textarea.select();

      const result =
        document.execCommand(
          "copy"
        );

      textarea.remove();

      return result;

    } catch (_) {

      return false;

    }

  }
}


/*
|--------------------------------------------------------------------------
| Copy gate
|--------------------------------------------------------------------------
*/

function startCopyGate(
  prompt
) {

  const button =
    $("pfCopyButton");

  const status =
    $("pfCopyStatus");

  if (!button) {
    return;
  }


  clearInterval(
    copyTimer
  );


  const seconds =
    Math.max(
      0,
      Number(
        SETTINGS.copyGateSeconds ??
        10
      )
    );


  /*
   * If no direct link and no countdown,
   * copy immediately.
   */

  if (
    seconds <= 0 &&
    !SETTINGS.directLink
  ) {

    copyText(
      prompt
    ).then(
      (success) => {

        button.textContent =
          success
            ? "Copied ✓"
            : "Copy failed";

      }
    );

    return;
  }


  /*
   * Open configured direct link.
   */

  if (
    SETTINGS.directLink
  ) {

    try {

      window.open(
        SETTINGS.directLink,
        "_blank",
        "noopener,noreferrer"
      );

    } catch (_) {}

  }


  let remaining =
    seconds;


  button.disabled =
    true;

  button.textContent =
    remaining > 0
      ? `Wait ${remaining}s`
      : "Copy prompt";


  if (status) {

    status.textContent =
      remaining > 0
        ? `Please wait ${remaining} seconds...`
        : "";

  }


  if (remaining <= 0) {

    button.disabled =
      false;

    button.textContent =
      "Copy prompt";

    return;

  }


  copyTimer =
    setInterval(
      () => {

        remaining -= 1;


        if (remaining <= 0) {

          clearInterval(
            copyTimer
          );

          button.disabled =
            false;

          button.textContent =
            "Copy prompt";

          if (status) {
            status.textContent =
              "Copy is now available.";
          }

          return;
        }


        button.textContent =
          `Wait ${remaining}s`;


        if (status) {

          status.textContent =
            `Please wait ${remaining} seconds...`;

        }

      },
      1000
    );


  /*
   * Replace click after timer
   */

  button.onclick =
    async () => {

      const success =
        await copyText(
          prompt
        );

      button.textContent =
        success
          ? "Copied ✓"
          : "Copy failed";

      if (status) {

        status.textContent =
          success
            ? "Prompt copied successfully."
            : "Your browser blocked clipboard access.";

      }

    };
}


/*
|--------------------------------------------------------------------------
| Open prompt
|--------------------------------------------------------------------------
*/

async function openPrompt(
  slug,
  push = true
) {

  if (!slug) {
    return;
  }


  const modal =
    $("modal");

  const body =
    $("modalBody");


  if (!modal || !body) {
    return;
  }


  body.innerHTML =
    `
      <div class="muted">
        Loading prompt...
      </div>
    `;


  modal.classList.remove(
    "hidden"
  );


  try {

    const post =
      await api(
        `/api/prompts/${encodeURIComponent(
          slug
        )}`
      );


    const image =
      post.imageUrl
        ? `
          <img
            class="pf-modal-image"
            src="${esc(
              post.imageUrl
            )}"
            alt="${esc(
              post.title
            )}"
          />
        `
        : "";


    const tags = [
      post.category,
      post.media,
      post.model
    ]
      .filter(Boolean)
      .slice(0, 6);


    body.innerHTML =
      `

        <div class="meta">
          ${esc(
            post.media ||
            "Image"
          )}
          ·
          ${esc(
            post.model ||
            "AI"
          )}
        </div>

        <h2>
          ${esc(
            post.title ||
            "AI Prompt"
          )}
        </h2>


        ${image}


        <div class="pf-author-box">

          <div class="pf-author-name">
            PromptForge AI
          </div>

          <div class="pf-author-sub">
            AI-generated creative prompt
          </div>

        </div>


        <div class="pf-meta-grid">

          <div class="pf-meta-box">
            <div class="pf-meta-label">
              Published
            </div>

            <div class="pf-meta-value">
              ${esc(
                getPublishedDate(
                  post
                ) ||
                "Today"
              )}
            </div>
          </div>


          <div class="pf-meta-box">
            <div class="pf-meta-label">
              Category
            </div>

            <div class="pf-meta-value">
              ${esc(
                post.category ||
                "AI Image"
              )}
            </div>
          </div>


          <div class="pf-meta-box">
            <div class="pf-meta-label">
              Model
            </div>

            <div class="pf-meta-value">
              ${esc(
                post.model ||
                "AI"
              )}
            </div>
          </div>

        </div>


        ${
          tags.length
            ? `
              <div class="pf-tags">
                ${tags
                  .map(
                    (tag) =>
                      `<span class="pf-tag">
                        ${esc(tag)}
                      </span>`
                  )
                  .join("")}
              </div>
            `
            : ""
        }


        <h3 class="pf-similar">
          Generate a similar image
        </h3>

        <div class="pf-similar-sub">
          Use the exact prompt below with
          your preferred image generator.
        </div>


        <div class="pf-prompt-box">

          <div class="pf-prompt-header">

            <div class="pf-prompt-label">
              PROMPT
            </div>

            <div>
              ✦
            </div>

          </div>


          <div class="pf-prompt-body">
${esc(
  post.prompt ||
  ""
)}
          </div>

        </div>


        <button
          id="pfCopyButton"
          class="pf-copy-btn"
          type="button"
        >
          Copy prompt
        </button>


        <div
          id="pfCopyStatus"
          class="pf-copy-countdown"
        ></div>


        ${
          ADS.modal_banner &&
          ADS.modal_banner.enabled
            ? `
              <div class="pf-ad-slot">
                ${buildAdFrame(
                  "modal_banner"
                )}
              </div>
            `
            : ""
        }


        <div class="lic">
          License:
          ${esc(
            post.license ||
            "CC0-1.0"
          )}
          · Source:
          ${esc(
            post.source ||
            "PromptForge"
          )}
        </div>

      `;


    /*
     * Start copy gate
     */

    const copyButton =
      $("pfCopyButton");


    if (copyButton) {

      copyButton.onclick =
        () => {

          startCopyGate(
            post.prompt ||
            ""
          );

        };

    }


    /*
     * If a countdown exists,
     * start it automatically.
     */

    if (
      Number(
        SETTINGS.copyGateSeconds
      ) > 0
    ) {

      startCopyGate(
        post.prompt ||
        ""
      );

    }


    /*
     * URL
     */

    if (push) {

      history.pushState(
        null,
        "",
        `/p/${post.slug}`
      );

    }

  } catch (error) {

    body.innerHTML =
      `
        <div class="muted">
          Could not load this prompt.
        </div>
      `;

  }
}


/*
|--------------------------------------------------------------------------
| Close modal
|--------------------------------------------------------------------------
*/

function closeModal() {

  clearInterval(
    copyTimer
  );


  const modal =
    $("modal");

  if (modal) {

    modal.classList.add(
      "hidden"
    );

  }


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


/*
|--------------------------------------------------------------------------
| Card click
|--------------------------------------------------------------------------
*/

function setupCardClicks() {

  const grid =
    $("grid");

  if (!grid) {
    return;
  }


  grid.onclick =
    (event) => {

      const cardElement =
        event.target.closest(
          ".pf-card"
        );


      if (!cardElement) {
        return;
      }


      const slug =
        cardElement.dataset.slug;


      if (slug) {

        openPrompt(
          slug
        );

      }

    };

}


/*
|--------------------------------------------------------------------------
| Media filters
|--------------------------------------------------------------------------
*/

function setupMediaFilters() {

  $$(".pill")
    .forEach(
      (button) => {

        button.addEventListener(
          "click",
          () => {

            $$(".pill")
              .forEach(
                (item) =>
                  item.classList.remove(
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

      }
    );

}


/*
|--------------------------------------------------------------------------
| Category filters
|--------------------------------------------------------------------------
*/

function setupCategories() {

  $(
    ".categories"
  )
    ?.querySelectorAll(
      "button"
    )
    .forEach(
      (button) => {

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


            $(
              ".categories"
            )
              .querySelectorAll(
                "button"
              )
              .forEach(
                (item) => {

                  item.classList.toggle(
                    "on",
                    item.dataset.cat ===
                      category
                  );

                }
              );


            const section =
              $("prompts");

            if (section) {

              section.scrollIntoView({
                behavior:
                  "smooth"
              });

            }


            load();

          }
        );

      }
    );

}


/*
|--------------------------------------------------------------------------
| Search
|--------------------------------------------------------------------------
*/

function setupSearch() {

  const search =
    $("search");

  if (!search) {
    return;
  }


  search.addEventListener(
    "input",
    () => {

      clearTimeout(
        searchTimer
      );


      searchTimer =
        setTimeout(
          load,
          250
        );

    }
  );

}


/*
|--------------------------------------------------------------------------
| Modal events
|--------------------------------------------------------------------------
*/

function setupModal() {

  const modal =
    $("modal");

  const close =
    $("close");


  if (close) {

    close.onclick =
      closeModal;

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

}


/*
|--------------------------------------------------------------------------
| Hidden Admin Access
|--------------------------------------------------------------------------
|
| Click PromptForge logo 5 times.
|
*/

function setupHiddenAdmin() {

  const brand =
    $("brand");

  if (!brand) {
    return;
  }


  brand.addEventListener(
    "click",
    () => {

      const now =
        Date.now();


      if (
        now -
        logoLastClick >
        1800
      ) {

        logoClicks = 0;

      }


      logoLastClick =
        now;

      logoClicks += 1;


      if (
        logoClicks >= 5
      ) {

        logoClicks = 0;

        location.href =
          "/admin";

      }

    }
  );

}


/*
|--------------------------------------------------------------------------
| Initial direct URL
|--------------------------------------------------------------------------
*/

async function openInitialPost() {

  const match =
    location.pathname.match(
      /^\/p\/([\w-]+)/
    );


  if (!match) {
    return;
  }


  await openPrompt(
    match[1],
    false
  );

}


/*
|--------------------------------------------------------------------------
| Start
|--------------------------------------------------------------------------
*/

async function start() {

  installPremiumStyles();

  setupCardClicks();
  setupMediaFilters();
  setupCategories();
  setupSearch();
  setupModal();
  setupHiddenAdmin();

  await Promise.all([
    loadSettings(),
    loadAds()
  ]);

  await load();

  await openInitialPost();

}


/*
|--------------------------------------------------------------------------
| Run
|--------------------------------------------------------------------------
*/

start();
