require("dotenv").config();
const express=require("express"),session=require("express-session"),cron=require("node-cron"),fs=require("fs"),path=require("path"),crypto=require("crypto");
const app=express(),PORT=process.env.PORT||3000,D=f=>path.join(__dirname,"data",f);
const DATA=D("prompts.json"),SETTINGS=D("settings.json"),SOURCES=D("sources.json"),SEED=D("seed.json");
const readJson=(f,fb)=>{try{return JSON.parse(fs.readFileSync(f,"utf8"))}catch{return fb}};
const writeJson=(f,v)=>{fs.mkdirSync(path.dirname(f),{recursive:true});const t=f+".tmp";fs.writeFileSync(t,JSON.stringify(v,null,2));fs.renameSync(t,f)};
if(!fs.existsSync(DATA))writeJson(DATA,[]);
if(!fs.existsSync(SETTINGS))writeJson(SETTINGS,{autoPostEnabled:process.env.AUTO_POST_ENABLED!=="false"});
if(!fs.existsSync(SOURCES))writeJson(SOURCES,[]);

const slugify=s=>String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,90);
const mediaOf=m=>/vid|film|clip|motion/i.test(m)?"Video":/writ|text/i.test(m)?"Writing":"Image"; // "photo" => Image
const httpUrl=u=>/^https?:\/\//i.test(u||"")?u:"";
function mk(list,x,auto){
  const base=slugify(x.title)||"prompt";let slug=base,n=2;while(list.some(p=>p.slug===slug))slug=`${base}-${n++}`;
  return{id:Date.now().toString(36)+crypto.randomBytes(3).toString("hex"),slug,title:String(x.title).trim().slice(0,140),prompt:String(x.prompt).trim().slice(0,4000),
    media:mediaOf(x.media),model:x.model||"Any",category:x.category||"General",imageUrl:httpUrl(x.imageUrl),source:x.source||"Original",
    license:x.license||"CC0-1.0",sourceUrl:httpUrl(x.sourceUrl),publishedAt:x.publishedAt||new Date().toISOString(),auto:!!auto};
}
// Built-in library: original prompts written for this project (CC0) - safe to publish & redistribute.
(function seed(){
  const list=readJson(DATA,[]);if(list.some(p=>p.source==="PromptForge Original"))return;
  readJson(SEED,[]).forEach((x,i)=>list.push(mk(list,{...x,source:"PromptForge Original",license:"CC0-1.0",publishedAt:new Date(Date.now()-i*36e5).toISOString()},false)));
  writeJson(DATA,list);
})();

app.set("trust proxy",1); // needed behind Render/Railway/Nginx, else login cookie never sticks
app.disable("x-powered-by");
app.use(express.json({limit:"1mb"}));
app.use(express.urlencoded({extended:true}));
app.use(express.static(path.join(__dirname,"public")));
if(!process.env.SESSION_SECRET)console.warn("WARNING: SESSION_SECRET not set - using a random one (admin logs out on restart).");
app.use(session({secret:process.env.SESSION_SECRET||crypto.randomBytes(32).toString("hex"),resave:false,saveUninitialized:false,
  cookie:{httpOnly:true,sameSite:"lax",secure:"auto",maxAge:8*36e5}}));
const admin=(req,res,next)=>req.session?.admin?next():res.status(401).json({error:"Unauthorized"});

function query(q){
  const s=String(q.q||"").toLowerCase(),m=q.media&&q.media!=="all"?mediaOf(q.media):null,c=String(q.category||"all").toLowerCase(),l=String(q.license||"").toLowerCase();
  return readJson(DATA,[]).filter(p=>(!s||[p.title,p.prompt,p.model,p.category].join(" ").toLowerCase().includes(s))&&(!m||p.media===m)&&
    (c==="all"||String(p.category).toLowerCase()===c)&&(!l||String(p.license).toLowerCase()===l)).sort((a,b)=>new Date(b.publishedAt)-new Date(a.publishedAt));
}
// ---- Public API (CORS open, read-only) ----
app.use("/api/v1",(req,res,next)=>{res.set("Access-Control-Allow-Origin","*");next()});
app.get("/api/v1/prompts",(req,res)=>{
  const all=query(req.query),limit=Math.min(100,+req.query.limit||20),page=Math.max(1,+req.query.page||1);
  res.json({data:all.slice((page-1)*limit,page*limit),meta:{total:all.length,page,limit,pages:Math.ceil(all.length/limit)}});
});
app.get("/api/v1/prompts/:slug",(req,res)=>{const p=readJson(DATA,[]).find(x=>x.slug===req.params.slug);p?res.json(p):res.status(404).json({error:"Not found"})});
app.get("/api/v1/categories",(req,res)=>{const c={};readJson(DATA,[]).forEach(p=>c[p.category]=(c[p.category]||0)+1);res.json(c)});
// legacy endpoints used by the website
app.get("/api/prompts",(req,res)=>res.json(query(req.query)));
app.get("/api/prompts/:slug",(req,res)=>{const p=readJson(DATA,[]).find(x=>x.slug===req.params.slug);p?res.json(p):res.status(404).json({error:"Not found"})});

// ---- RSS + JSON Feed ----
const X=s=>String(s??"").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,"").replace(/[<>&'"]/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;","'":"&apos;",'"':"&quot;"}[c]));
const site=req=>(process.env.SITE_URL||`${req.protocol}://${req.get("host")}`).replace(/\/$/,"");
function rss(media,label){return(req,res)=>{
  const b=site(req),items=query({media}).slice(0,50),self=`${b}${req.path}`;
  res.type("application/rss+xml; charset=utf-8").send(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>PromptForge - ${label}</title><link>${X(b)}</link>
<description>Latest ${label.toLowerCase()} from the PromptForge library</description><language>en</language><lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
<atom:link href="${X(self)}" rel="self" type="application/rss+xml"/>
${items.map(p=>`<item><title>${X(p.title)}</title><link>${X(`${b}/p/${p.slug}`)}</link><guid isPermaLink="true">${X(`${b}/p/${p.slug}`)}</guid><pubDate>${new Date(p.publishedAt).toUTCString()}</pubDate><category>${X(p.category)}</category><description>${X(`${p.prompt} [${p.media} - ${p.model} - License: ${p.license}]`)}</description></item>`).join("\n")}
</channel></rss>`)}}
app.get("/rss.xml",rss("all","AI Prompts"));app.get("/rss/image.xml",rss("image","Photo Prompts"));app.get("/rss/video.xml",rss("video","Video Prompts"));
app.get("/feed.json",(req,res)=>{const b=site(req);res.type("application/feed+json").json({version:"https://jsonfeed.org/version/1.1",title:"PromptForge",home_page_url:b,feed_url:`${b}/feed.json`,
  items:query(req.query).slice(0,50).map(p=>({id:p.slug,url:`${b}/p/${p.slug}`,title:p.title,content_text:p.prompt,date_published:p.publishedAt,tags:[p.media,p.category,p.model],_license:p.license}))})});

// ---- Admin ----
const eq=(a,b)=>{const h=v=>crypto.createHash("sha256").update(String(v)).digest();return crypto.timingSafeEqual(h(a),h(b))};
const fails=new Map();
app.post("/api/login",(req,res)=>{
  const pw=process.env.ADMIN_PASSWORD;if(!pw)return res.status(503).json({error:"Set ADMIN_PASSWORD in .env"});
  const f=fails.get(req.ip)||{n:0,t:0};if(f.n>=5&&Date.now()-f.t<9e5)return res.status(429).json({error:"Too many attempts. Try later."});
  const{username,password}=req.body||{};
  if(eq(username,process.env.ADMIN_USERNAME||"admin")&&eq(password,pw)){fails.delete(req.ip);req.session.admin=true;return res.json({ok:true})}
  fails.set(req.ip,{n:f.n+1,t:Date.now()});res.status(401).json({error:"Invalid credentials"});
});
app.post("/api/logout",(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get("/api/admin/me",(req,res)=>res.json({authenticated:!!req.session?.admin}));
app.get("/api/admin/prompts",admin,(req,res)=>res.json(readJson(DATA,[])));
app.post("/api/admin/prompts",admin,(req,res)=>{
  const b=req.body||{};if(!b.title||!b.prompt)return res.status(400).json({error:"Title and prompt are required"});
  const list=readJson(DATA,[]),item=mk(list,b,false);list.unshift(item);writeJson(DATA,list);res.json(item);
});
app.delete("/api/admin/prompts/:id",admin,(req,res)=>{writeJson(DATA,readJson(DATA,[]).filter(p=>p.id!==req.params.id));res.json({ok:true})});
app.get("/api/admin/settings",admin,(req,res)=>res.json(readJson(SETTINGS,{})));
app.post("/api/admin/settings",admin,(req,res)=>{const n={...readJson(SETTINGS,{}),autoPostEnabled:!!req.body?.autoPostEnabled};writeJson(SETTINGS,n);res.json(n)});
app.post("/api/admin/collect",admin,async(req,res)=>res.json(await collect()));

// ---- Ads (slots managed from admin panel) ----
const ADS=D("ads.json"),SLOTS=["head_code","popunder","social_bar","banner_top","banner_middle","banner_bottom","modal_banner","native_banner"];
const slot=s=>({enabled:!!s?.enabled,code:String(s?.code||"").slice(0,20000),height:Math.min(1000,Math.max(0,+s?.height||0))});
const adsRead=()=>{const a=readJson(ADS,{}),o={};SLOTS.forEach(k=>o[k]=slot(a[k]));o.smart_link={enabled:!!a.smart_link?.enabled,url:httpUrl(String(a.smart_link?.url||"").trim())};return o};
app.get("/api/ads",(req,res)=>{const a=adsRead(),o={};SLOTS.forEach(k=>{if(a[k].enabled&&a[k].code.trim())o[k]={code:a[k].code,height:a[k].height}});
  if(a.smart_link.enabled&&a.smart_link.url)o.smart_link=a.smart_link.url;res.set("Cache-Control","no-store").json(o)});
app.get("/api/admin/ads",admin,(req,res)=>res.json(adsRead()));
app.post("/api/admin/ads",admin,(req,res)=>{const b=req.body||{},a={};SLOTS.forEach(k=>a[k]=slot(b[k]));
  a.smart_link={enabled:!!b.smart_link?.enabled,url:httpUrl(String(b.smart_link?.url||"").trim())};writeJson(ADS,a);res.json(adsRead())});

// ---- Legal collector: only sources listed in data/sources.json (or SOURCE_URL) that declare a license AND permission:true ----
const dec=s=>s.replace(/^<!\[CDATA\[|\]\]>$/g,"").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#0?39;|&apos;/g,"'").replace(/&amp;/g,"&").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
function parseRss(t){return[...t.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/g)].map(m=>{
  const b=m[0],g=k=>{const r=b.match(new RegExp(`<${k}[^>]*>([\\s\\S]*?)</${k}>`,"i"));return r?dec(r[1].trim()):""};
  const d=g("pubDate")||g("published")||g("updated");
  return{title:g("title"),prompt:g("content:encoded")||g("description")||g("summary")||g("content"),
    sourceUrl:(b.match(/<link[^>]*href="([^"]+)"/i)||[])[1]||g("link"),imageUrl:(b.match(/<(?:enclosure|media:content)[^>]*url="([^"]+)"/i)||[])[1]||"",
    publishedAt:d&&!isNaN(new Date(d))?new Date(d).toISOString():undefined}})}
async function collect(){
  if(!readJson(SETTINGS,{}).autoPostEnabled)return{added:0,reason:"disabled"};
  const srcs=readJson(SOURCES,[]).filter(z=>z.enabled!==false);
  if(process.env.SOURCE_URL)srcs.push({name:"Env source",url:process.env.SOURCE_URL,type:process.env.SOURCE_TYPE||"json",license:process.env.SOURCE_LICENSE,permission:process.env.SOURCE_PERMISSION==="true",apiKey:process.env.SOURCE_API_KEY});
  let added=0;const errors=[];
  for(const z of srcs){try{
    if(!z.url||!z.license||z.permission!==true)throw new Error(`${z.name||z.url}: skipped - needs "license" and "permission": true`);
    const r=await fetch(z.url,{headers:{"User-Agent":"PromptForge/1.1",...(z.apiKey?{Authorization:`Bearer ${z.apiKey}`}:{})},signal:AbortSignal.timeout(15000)});
    if(!r.ok)throw new Error(`${z.name}: HTTP ${r.status}`);
    const body=await r.text(),inc=z.type==="rss"?parseRss(body):(j=>Array.isArray(j)?j:j.prompts||[])(JSON.parse(body));
    const list=readJson(DATA,[]),seen=new Set(list.map(p=>p.prompt.trim().toLowerCase()));
    for(const it of inc.slice(0,50)){if(!it?.title||!it?.prompt)continue;const k=String(it.prompt).trim().toLowerCase();if(seen.has(k))continue;
      list.unshift(mk(list,{...it,media:it.media||z.media,category:it.category||z.category,source:z.name||"API",license:z.license},true));seen.add(k);added++}
    writeJson(DATA,list);
  }catch(e){errors.push(e.message);console.error("Collector:",e.message)}}
  return{added,errors};
}
const spec=process.env.AUTO_POST_CRON||"*/30 * * * *";
if(cron.validate(spec))cron.schedule(spec,collect);else console.error("Invalid AUTO_POST_CRON:",spec);

app.use("/api",(req,res)=>res.status(404).json({error:"Not found"}));
app.get("*splat",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.listen(PORT,()=>console.log(`PromptForge running on http://localhost:${PORT}`));
