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
            ? `<img
                src="${esc(p.imageUrl)}"
                loading="lazy"
                alt="${esc(p.title)}"
              >`
            : '<span>✦</span>'
        }
      </div>

      <div class="body">
        <div class="meta">
          ${esc(p.media)} · ${esc(p.model)}
        </div>

        <h3>${esc(p.title)}</h3>

        <div class="excerpt">
          ${esc(p.prompt)}
        </div>

        <span class="tag">
          ${esc(p.category)}
        </span>
      </div>
    </article>
  `;
}

async function loadAds() {
  try {
    ADS = await (await fetch('/api/ads')).json();
  } catch {
    ADS = {};
  }
}

async function load() {
  try {
    const r = await fetch(
      `/api/prompts?q=${encodeURIComponent(search.value.trim())}` +
      `&media=${encodeURIComponent(media)}` +
      `&category=${encodeURIComponent(category)}`
    );

    if (!r.ok) throw new Error('Failed to load prompts');

    const items = await r.json();

    count.textContent = `${items.length} prompts`;

    grid.innerHTML =
      items.map(card).join('') ||
      '<div class="muted">No prompts found.</div>';

  } catch {
    grid.innerHTML =
      '<div class="muted">Could not load prompts. Please refresh.</div>';
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement('textarea');

    textarea.value = text;

    document.body.appendChild(textarea);

    textarea.select();

    document.execCommand('copy');

    textarea.remove();
  }
}

async function openPrompt(slug, push = true) {
  const r = await fetch(
    '/api/prompts/' + encodeURIComponent(slug)
  );

  if (!r.ok) return;

  const p = await r.json();

  modal.classList.remove('hidden');

  if (push) {
    history.pushState(null, '', '/p/' + p.slug);
  }

  modal.querySelector('#modalBody').innerHTML = `
    <div class="meta">
      ${esc(p.media)} · ${esc(p.model)} · ${esc(p.category)}
    </div>

    <h2>${esc(p.title)}</h2>

    ${
      p.imageUrl
        ? `<img
            src="${esc(p.imageUrl)}"
            alt="${esc(p.title)}"
          >`
        : ''
    }

    <div class="fullprompt">
      ${esc(p.prompt)}
    </div>

    <button class="copy" id="copy">
      Copy prompt
    </button>

    <div class="lic">
      Source: ${esc(p.source || 'PromptForge')}
    </div>
  `;

  const btn = $('copy');

  btn.onclick = async () => {

    const cfg = await fetch('/api/public/settings')
      .then((x) => x.json())
      .catch(() => ({
        copyGateSeconds: 10,
        directLink: ''
      }));

    const sec = Math.max(
      0,
      Math.min(
        120,
        Number(cfg.copyGateSeconds || 10)
      )
    );

    if (cfg.directLink) {
      window.open(
        cfg.directLink,
        '_blank',
        'noopener'
      );
    }

    if (sec) {

      let left = sec;

      btn.disabled = true;

      btn.textContent = `Unlock in ${left}s`;

      const interval = setInterval(() => {

        left--;

        btn.textContent = left
          ? `Unlock in ${left}s`
          : 'Copy prompt';

        if (!left) {

          clearInterval(interval);

          btn.disabled = false;

          btn.onclick = async () => {

            await copyText(p.prompt);

            btn.textContent = 'Copied ✓';
          };
        }

      }, 1000);

    } else {

      await copyText(p.prompt);

      btn.textContent = 'Copied ✓';
    }
  };
}

function closeModal() {

  modal.classList.add('hidden');

  if (location.pathname.startsWith('/p/')) {

    history.replaceState(
      null,
      '',
      '/'
    );
  }
}

document.querySelectorAll('.pill').forEach((button) => {

  button.onclick = () => {

    document
      .querySelectorAll('.pill')
      .forEach((x) => x.classList.remove('active'));

    button.classList.add('active');

    media = button.dataset.media;

    load();
  };
});

document
  .querySelectorAll('.categories button')
  .forEach((button) => {

    button.onclick = () => {

      category =
        category === button.dataset.cat
          ? 'all'
          : button.dataset.cat;

      document
        .querySelectorAll('.categories button')
        .forEach((x) => {

          x.classList.toggle(
            'on',
            x.dataset.cat === category
          );

        });

      document
        .querySelector('#prompts')
        .scrollIntoView({
          behavior: 'smooth'
        });

      load();
    };
  });

search.oninput = () => {

  clearTimeout(timer);

  timer = setTimeout(
    load,
    220
  );
};

grid.onclick = (event) => {

  const cardElement =
    event.target.closest('.card');

  if (cardElement) {

    openPrompt(
      cardElement.dataset.slug
    );
  }
};

$('close').onclick = closeModal;

modal.onclick = (event) => {

  if (event.target === modal) {
    closeModal();
  }
};

document.onkeydown = (event) => {

  if (event.key === 'Escape') {
    closeModal();
  }

  if (
    (event.ctrlKey || event.metaKey) &&
    event.key.toLowerCase() === 'k'
  ) {

    event.preventDefault();

    search.focus();
  }
};

/*
  Hidden admin access:
  Click the logo 5 times quickly.
*/

let clicks = 0;
let lastClick = 0;

$('brand').onclick = () => {

  const now = Date.now();

  if (now - lastClick > 1800) {
    clicks = 0;
  }

  lastClick = now;

  clicks++;

  if (clicks >= 5) {

    clicks = 0;

    location.href = '/admin.html';
  }
};

const promptPath =
  location.pathname.match(
    /^\/p\/([\w-]+)/
  );

if (promptPath) {

  openPrompt(
    promptPath[1],
    false
  );
}

loadAds().finally(load);
