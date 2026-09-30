let ADS={};
const frame=k=>{const a=ADS[k];if(!a)return"";const doc=`<!doctype html><body style="margin:0;display:flex;justify-content:center">${a.code}`;
  return`<iframe class="adframe" style="height:${a.height||100}px" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" scrolling="no" loading="lazy" srcdoc="${esc(doc)}"></iframe>`};
function inject(code,where){const t=document.createElement("template");t.innerHTML=code;
  t.content.querySelectorAll("script").forEach(s=>{const n=document.createElement("script");[...s.attributes].forEach(a=>n.setAttribute(a.name,a.value));n.text=s.textContent;s.replaceWith(n)});where.appendChild(t.content)}
async function loadAds(){try{ADS=await(await fetch("/api/ads")).json()}catch{return}
  document.querySelectorAll(".ad").forEach(d=>d.innerHTML=frame(d.dataset.slot));
  if(ADS.head_code)inject(ADS.head_code.code,document.head);
  if(ADS.popunder)inject(ADS.popunder.code,document.body);
  if(ADS.social_bar)inject(ADS.social_bar.code,document.body)}
let media="all",category="all",timer;
const $=id=>document.getElementById(id),grid=$("grid"),count=$("count"),search=$("search"),modal=$("modal");
const esc=s=>String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]));
const card=p=>`<article class="card" data-slug="${esc(p.slug)}"><div class="thumb">${p.imageUrl?`<img src="${esc(p.imageUrl)}" loading="lazy" alt="">`:"✦"}</div>
<div class="body"><div class="meta">${esc(p.media)} · ${esc(p.model)}</div><h3>${esc(p.title)}</h3><div class="excerpt">${esc(p.prompt)}</div><span class="tag">${esc(p.category)}</span></div></article>`;
async function load(){
  try{
    const r=await fetch(`/api/prompts?q=${encodeURIComponent(search.value.trim())}&media=${encodeURIComponent(media)}&category=${encodeURIComponent(category)}`);
    if(!r.ok)throw 0;const items=await r.json();
    count.textContent=`${items.length} prompts`+(category!=="all"?` · ${category} (click category again to clear)`:"");
    grid.innerHTML=items.map((p,i)=>card(p)+(i===5&&ADS.banner_middle?`<div class="adwide">${frame("banner_middle")}</div>`:"")).join("")||`<div class="muted">No prompts found.</div>`;
  }catch{grid.innerHTML=`<div class="muted">Could not load prompts. Please refresh.</div>`}
}
async function copyText(t){try{await navigator.clipboard.writeText(t)}catch{const a=document.createElement("textarea");a.value=t;document.body.appendChild(a);a.select();document.execCommand("copy");a.remove()}}
async function openPrompt(slug,push=true){
  const r=await fetch("/api/prompts/"+encodeURIComponent(slug));if(!r.ok)return;const p=await r.json();
  $("modalBody").innerHTML=`<div class="meta">${esc(p.media)} · ${esc(p.model)} · ${esc(p.category)}</div><h2>${esc(p.title)}</h2>${p.imageUrl?`<img src="${esc(p.imageUrl)}" alt="" style="width:100%;border-radius:14px;margin-bottom:16px">`:""}<div class="fullprompt">${esc(p.prompt)}</div><button class="copy" id="copy">Copy prompt</button><div class="lic">License: ${esc(p.license||"CC0-1.0")} · Source: ${esc(p.source)}</div>${frame("modal_banner")}`;
  modal.classList.remove("hidden");if(push)history.pushState(null,"","/p/"+p.slug);
  $("copy").onclick=async()=>{
    const settings=await fetch("/api/admin/settings").then(r=>r.json()).catch(()=>({copyGateSeconds:10,directLink:""}));
    const sec=Math.max(0,+settings.copyGateSeconds||10),url=settings.directLink||ADS.smart_link||"";
    if(url){ window.open(url,"_blank","noopener"); }
    if(sec>0){ let left=sec,btn=$("copy");btn.disabled=true;btn.textContent=`Wait ${left}s…`;const iv=setInterval(()=>{left--;btn.textContent=left?`Wait ${left}s…`:"Copy prompt";if(!left){clearInterval(iv);btn.disabled=false}},1000); }
    else {await copyText(p.prompt);$("copy").textContent="Copied ✓";}
    $("copy").onclick=async()=>{await copyText(p.prompt);$("copy").textContent="Copied ✓"};
  };
}
function closeModal(){modal.classList.add("hidden");if(location.pathname.startsWith("/p/"))history.replaceState(null,"","/")}
document.querySelectorAll(".pill").forEach(b=>b.onclick=()=>{document.querySelectorAll(".pill").forEach(x=>x.classList.remove("active"));b.classList.add("active");media=b.dataset.media;load()});
document.querySelectorAll(".categories button").forEach(b=>b.onclick=()=>{
  category=category===b.dataset.cat?"all":b.dataset.cat;
  document.querySelectorAll(".categories button").forEach(x=>x.classList.toggle("on",x.dataset.cat===category));
  $("prompts").scrollIntoView();load();
});
search.oninput=()=>{clearTimeout(timer);timer=setTimeout(load,250)};
grid.onclick=e=>{const c=e.target.closest(".card");if(c)openPrompt(c.dataset.slug)};
$("close").onclick=closeModal;
modal.onclick=e=>{if(e.target.id==="modal")closeModal()};
document.onkeydown=e=>{if(e.key==="Escape")closeModal()};
// Five quick logo clicks open the admin login (not security by itself).
let clicks=0,last=0;
$("brand").onclick=()=>{const now=Date.now();if(now-last>1800)clicks=0;last=now;clicks++;if(clicks>=5){clicks=0;location.href="/admin.html"}};
const m=location.pathname.match(/^\/p\/([\w-]+)/);if(m)openPrompt(m[1],false);
loadAds().finally(load);
