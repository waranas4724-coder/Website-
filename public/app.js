let ADS = {};

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  }[m]));

const $ = (id) => document.getElementById(id);

const grid = $('grid');
const count = $('count');
const search = $('search');
const modal = $('modal');

let media = 'all';
let category = 'all';
let timer;
let copyTimer = null;


/* =========================================================
   ADS
========================================================= */

async function loadAds() {
  try {
    const r = await fetch('/api/ads');

    if (!r.ok) {
      ADS = {};
      return;
    }

    ADS = await r.json();

  } catch {
    ADS = {};
  }
}


/*
  Render enabled ad slots.
  Ads remain separate from API settings.
*/

function renderAd(slot, container) {

  if (!container) return;

  const ad = ADS?.[slot];

  if (!ad || !ad.enabled || !ad.code) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = ad.code;

  if (ad.height) {
    container.style.minHeight =
      `${Number(ad.height)}px`;
  }
}


/* =========================================================
   CARD
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
            : `
              <span>✦</span>
            `
        }

      </div>

      <div class="body">

        <div class="meta">
          ${esc(p.media || 'Image')}
          ·
          ${esc(p.model || 'AI')}
        </div>

        <h3>
          ${esc(p.title)}
        </h3>

        <div class="excerpt">
          ${esc(p.prompt)}
        </div>

        <span class="tag">
          ${esc(p.category || 'General')}
        </span>

      </div>

    </article>
  `;
}


/* =========================================================
   LOAD POSTS
========================================================= */

async function load() {

  try {

    const r =
      await fetch(
        `/api/prompts?q=${encodeURIComponent(
          search.value.trim()
        )}` +
        `&media=${encodeURIComponent(media)}` +
        `&category=${encodeURIComponent(category)}`
      );

    if (!r.ok) {
      throw new Error(
        'Failed to load prompts'
      );
    }

    const items =
      await r.json();

    count.textContent =
      `${items.length} prompts`;

    grid.innerHTML =
      items.map(card).join('') ||
      '<div class="muted">No prompts found.</div>';

  } catch {

    grid.innerHTML =
      '<div class="muted">Could not load prompts. Please refresh.</div>';

  }

}


/* =========================================================
   COPY
========================================================= */

async function copyText(text) {

  try {

    await navigator.clipboard.writeText(
      text
    );

  } catch {

    const textarea =
      document.createElement('textarea');

    textarea.value = text;

    document.body.appendChild(
      textarea
    );

    textarea.select();

    document.execCommand(
      'copy'
    );

    textarea.remove();

  }

}


/* =========================================================
   COPY GATE
========================================================= */

async function startCopyGate(
  button,
  prompt
) {

  if (copyTimer) {
    clearInterval(copyTimer);
    copyTimer = null;
  }

  let cfg;

  try {

    cfg =
      await fetch(
        '/api/public/settings'
      ).then(
        (x) => x.json()
      );

  } catch {

    cfg = {
      copyGateSeconds: 10,
      directLink: ''
    };

  }


  const seconds =
    Math.max(
      0,
      Math.min(
        120,
        Number(
          cfg.copyGateSeconds || 10
        )
      )
    );


  /*
    Open direct link immediately
    from the user's button click.
  */

  if (cfg.directLink) {

    window.open(
      cfg.directLink,
      '_blank',
      'noopener'
    );

  }


  if (!seconds) {

    await copyText(prompt);

    button.textContent =
      'Copied ✓';

    return;

  }


  let left = seconds;

  button.disabled = true;

  button.textContent =
    `Unlock in ${left}s`;


  copyTimer =
    setInterval(
      async () => {

        left--;

        if (left > 0) {

          button.textContent =
            `Unlock in ${left}s`;

          return;

        }


        clearInterval(
          copyTimer
        );

        copyTimer = null;

        button.disabled = false;

        button.textContent =
          'Copy prompt';


        button.onclick =
          async () => {

            await copyText(
              prompt
            );

            button.textContent =
              'Copied ✓';

          };

      },
      1000
    );

}


/* =========================================================
   OPEN PROMPT
========================================================= */

async function openPrompt(
  slug,
  push = true
) {

  const r =
    await fetch(
      '/api/prompts/' +
      encodeURIComponent(slug)
    );

  if (!r.ok) return;

  const p =
    await r.json();


  modal.classList.remove(
    'hidden'
  );


  if (push) {

    history.pushState(
      null,
      '',
      '/p/' + p.slug
    );

  }


  modal.querySelector(
    '#modalBody'
  ).innerHTML = `

    <div class="meta">
      ${esc(p.media || 'Image')}
      ·
      ${esc(p.model || 'AI')}
      ·
      ${esc(p.category || 'General')}
    </div>

    <h2>
      ${esc(p.title)}
    </h2>


    ${
      p.imageUrl
        ? `
          <img
            src="${esc(p.imageUrl)}"
            alt="${esc(p.title)}"
          >
        `
        : ''
    }


    <div class="fullprompt">
      ${esc(p.prompt)}
    </div>


    <button
      class="copy"
      id="copy"
    >
      Copy prompt
    </button>


    <div class="lic">
      Source:
      ${esc(
        p.source ||
        'PromptForge'
      )}
    </div>

  `;


  const btn =
    $('copy');


  btn.onclick =
    async () => {

      await startCopyGate(
        btn,
        p.prompt
      );

    };

}


/* =========================================================
   CLOSE MODAL
========================================================= */

function closeModal() {

  modal.classList.add(
    'hidden'
  );


  if (
    location.pathname.startsWith(
      '/p/'
    )
  ) {

    history.replaceState(
      null,
      '',
      '/'
    );

  }

}


/* =========================================================
   MEDIA FILTER
========================================================= */

document
  .querySelectorAll('.pill')
  .forEach(
    (button) => {

      button.onclick = () => {

        if (
          !button.dataset.media
        ) {
          return;
        }


        document
          .querySelectorAll(
            '.pill'
          )
          .forEach(
            (x) =>
              x.classList.remove(
                'active'
              )
          );


        button.classList.add(
          'active'
        );


        media =
          button.dataset.media;

        load();

      };

    }
  );


/* =========================================================
   CATEGORY FILTER
========================================================= */

document
  .querySelectorAll(
    '.categories button'
  )
  .forEach(
    (button) => {

      button.onclick = () => {

        category =
          category ===
          button.dataset.cat
            ? 'all'
            : button.dataset.cat;


        document
          .querySelectorAll(
            '.categories button'
          )
          .forEach(
            (x) => {

              x.classList.toggle(
                'on',
                x.dataset.cat ===
                  category
              );

            }
          );


        document
          .querySelector(
            '#prompts'
          )
          .scrollIntoView({
            behavior:
              'smooth'
          });


        load();

      };

    }
  );


/* =========================================================
   SEARCH
========================================================= */

search.oninput =
  () => {

    clearTimeout(
      timer
    );

    timer =
      setTimeout(
        load,
        220
      );

  };


/* =========================================================
   CARD CLICK
========================================================= */

grid.onclick =
  (event) => {

    const cardElement =
      event.target.closest(
        '.card'
      );


    if (
      cardElement &&
      cardElement.dataset.slug
    ) {

      openPrompt(
        cardElement.dataset.slug
      );

    }

  };


/* =========================================================
   MODAL
========================================================= */

$('close').onclick =
  closeModal;


modal.onclick =
  (event) => {

    if (
      event.target ===
      modal
    ) {

      closeModal();

    }

  };


/* =========================================================
   KEYBOARD
========================================================= */

document.onkeydown =
  (event) => {

    if (
      event.key ===
      'Escape'
    ) {

      closeModal();

    }


    if (
      (event.ctrlKey ||
        event.metaKey) &&
      event.key.toLowerCase() ===
        'k'
    ) {

      event.preventDefault();

      search.focus();

    }

  };


/* =========================================================
   HIDDEN ADMIN
   LOGO 5 CLICKS
========================================================= */

let clicks = 0;
let lastClick = 0;


$('brand').onclick =
  () => {

    const now =
      Date.now();


    if (
      now - lastClick >
      1800
    ) {

      clicks = 0;

    }


    lastClick =
      now;

    clicks++;


    if (
      clicks >= 5
    ) {

      clicks = 0;

      location.href =
        '/admin.html';

    }

  };


/* =========================================================
   DIRECT PROMPT URL
========================================================= */

const promptPath =
  location.pathname.match(
    /^\/p\/([\w-]+)/
  );


/* =========================================================
   START
========================================================= */

Promise.all([
  loadAds(),
  load()
]).then(() => {

  /*
    Ads are intentionally kept
    separate from API settings.
  */

  renderAd(
    'banner_top',
    document.querySelector(
      '[data-ad="banner_top"]'
    )
  );

  renderAd(
    'banner_middle',
    document.querySelector(
      '[data-ad="banner_middle"]'
    )
  );

  renderAd(
    'banner_bottom',
    document.querySelector(
      '[data-ad="banner_bottom"]'
    )
  );

});


if (promptPath) {

  openPrompt(
    promptPath[1],
    false
  );

}
