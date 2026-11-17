(function(){const t=document.createElement("link").relList;if(t&&t.supports&&t.supports("modulepreload"))return;for(const n of document.querySelectorAll('link[rel="modulepreload"]'))o(n);new MutationObserver(n=>{for(const d of n)if(d.type==="childList")for(const i of d.addedNodes)i.tagName==="LINK"&&i.rel==="modulepreload"&&o(i)}).observe(document,{childList:!0,subtree:!0});function s(n){const d={};return n.integrity&&(d.integrity=n.integrity),n.referrerPolicy&&(d.referrerPolicy=n.referrerPolicy),n.crossOrigin==="use-credentials"?d.credentials="include":n.crossOrigin==="anonymous"?d.credentials="omit":d.credentials="same-origin",d}function o(n){if(n.ep)return;n.ep=!0;const d=s(n);fetch(n.href,d)}})();let E=null;class S extends Error{constructor(t,s){super(s&&s.message||`HTTP ${t}`),this.status=t,this.code=s&&s.code||"HTTP_ERROR",this.details=s&&s.details}}async function u(e,t,s){const o={accept:"application/json"};s!==void 0&&(o["content-type"]="application/json"),e!=="GET"&&E&&(o["x-csrf-token"]=E);const n=await fetch(`/api/v1${t}`,{method:e,headers:o,credentials:"same-origin",body:s!==void 0?JSON.stringify(s):void 0});let d=null;try{d=await n.json()}catch{}if(!n.ok)throw new S(n.status,d);return d}const c={async session(){const e=await u("GET","/auth/session");return E=e.authenticated?e.csrfToken:null,e},async login(e){const t=await u("POST","/auth/login",{password:e});return E=t.csrfToken,t},async logout(){await u("POST","/auth/logout",{}),E=null},status:()=>u("GET","/status"),registry:()=>u("GET","/registry"),app:e=>u("GET",`/registry/${encodeURIComponent(e)}`),createApp:e=>u("POST","/registry",e),updateApp:(e,t)=>u("PUT",`/registry/${encodeURIComponent(e)}`,t),setEnabled:(e,t)=>u("PATCH",`/registry/${encodeURIComponent(e)}/enabled`,{enabled:t}),setAutoDeploy:(e,t)=>u("PATCH",`/registry/${encodeURIComponent(e)}/auto-deploy`,{autoDeploy:t}),retryPush:()=>u("POST","/registry/retry-push",{}),operations:(e,t=50)=>u("GET",`/operations?limit=${t}${e?`&application=${encodeURIComponent(e)}`:""}`),operation:e=>u("GET",`/operations/${encodeURIComponent(e)}`),submit:(e,t,s)=>u("POST","/operations",{operation:e,application:t,...s?{params:s}:{}}),reconcileApp:e=>u("POST",`/reconcile/${encodeURIComponent(e)}`,{}),reconcileAll:e=>u("POST","/reconcile",{confirm:e}),dataStatus:()=>u("GET","/data/status"),dataResources:()=>u("GET","/data/resources"),dataOperations:(e=30)=>u("GET",`/data/operations?limit=${e}`),dataRetry:e=>u("POST",`/data/operations/${encodeURIComponent(e)}/retry`,{}),dataResource:e=>u("GET",`/data/resources/${encodeURIComponent(e)}`),dataReplace:(e,t,s)=>u("PUT",`/data/resources/${encodeURIComponent(e)}`,{data:t,ifRevision:s}),appEnv:e=>u("GET",`/apps/${encodeURIComponent(e)}/env`),setAppEnv:(e,t)=>u("PUT",`/apps/${encodeURIComponent(e)}/env`,t),appToken:e=>u("GET",`/apps/${encodeURIComponent(e)}/token`),issueAppToken:(e,t)=>u("POST",`/apps/${encodeURIComponent(e)}/token`,t),revokeAppToken:e=>u("DELETE",`/apps/${encodeURIComponent(e)}/token?restart=true`)},P=document.getElementById("view"),O=document.getElementById("topbar"),C=new Set(["succeeded","failed","blocked"]),j="RECONCILE ALL ELIGIBLE APPS";let A=null;const a=e=>String(e??"").replace(/[&<>"']/g,t=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[t]),r=(e,t)=>`<span class="badge s-${a(String(e).toLowerCase())}">${a(t??e)}</span>`,v=e=>e?new Date(e).toLocaleString():"—",I=e=>`<pre class="json">${a(JSON.stringify(e,null,2))}</pre>`,y=e=>{P.innerHTML=e};function H(e){return e.status==="succeeded"&&e.result&&e.result.noop?r("noop","no-op"):r(e.status)}function m(e){const t=e instanceof S?e.code:"ERROR",s=e instanceof S?e.message:"Unexpected error";return`<div class="banner bad"><strong>${a(t)}</strong> — ${a(s)}${e&&e.details?`<details><summary>details</summary>${I(e.details)}</details>`:""}</div>`}function L(e){return e?e.pending?`<div class="banner warn">Saved and committed on the server, but <strong>not pushed to bmb-data yet</strong> (${a(e.error&&e.error.code)}). Use “Retry push”.</div>`:`<div class="banner info">${e.committed?"Committed":"No content change"}${e.pushed?" and pushed to bmb-data":""}${e.commit?` · <code>${a(e.commit.slice(0,12))}</code>`:""}.</div>`:""}function N(){A&&clearInterval(A),A=null}async function g(e){try{await e()}catch(t){if(t instanceof S&&t.status===401)return T();y(m(t))}}function q(){const e=/^#\/login\?next=(.+)$/.exec(location.hash);if(!e)return!1;let t;try{t=decodeURIComponent(e[1])}catch{return!1}return t.startsWith("/api/v1/auth/app-login?")?(location.replace(t),!0):!1}function T(e){N(),O.classList.add("hidden"),y(`
    <section class="login card">
      <h1>Manage</h1>
      ${e?`<div class="banner bad">${a(e)}</div>`:""}
      <form class="stack" id="login-form">
        <label>Admin password <input type="password" name="password" autocomplete="current-password" required autofocus /></label>
        <button class="btn primary" type="submit">Sign in</button>
      </form>
    </section>`),document.getElementById("login-form").addEventListener("submit",async t=>{t.preventDefault();const s=new FormData(t.target).get("password");try{if(await c.login(String(s)),q())return;O.classList.remove("hidden"),U()}catch(o){T(o.code==="RATE_LIMITED"?"Too many attempts — wait and retry.":"Sign-in failed.")}})}async function x(){const[e,t]=await Promise.all([c.status(),c.operations(void 0,8).catch(()=>null)]),s=e.argus;y(`
    <h1>Overview</h1>
    ${s.reachable?"":`<div class="banner bad"><strong>Argus unavailable</strong> (${a(s.code)}). Operations cannot run until it is reachable.</div>`}
    ${e.registry.ok?"":`<div class="banner bad">Registry unreadable (${a(e.registry.code)}).</div>`}
    <div class="grid">
      <div class="card"><h3>Manage</h3><dl class="kv"><dt>Status</dt><dd>${r("ok")}</dd><dt>Env</dt><dd>${a(e.manage.env)}</dd></dl></div>
      <div class="card"><h3>Argus</h3><dl class="kv">
        <dt>Reachable</dt><dd>${s.reachable?r("ok","yes"):r("unavailable","no")}</dd>
        <dt>Mode</dt><dd>${s.reachable?a(s.mode):r("unknown")}</dd>
        <dt>Execution</dt><dd>${s.reachable?s.executionEnabled?r("ok","enabled"):r("disabled"):r("unknown")}</dd>
      </dl></div>
      <div class="card"><h3>Registry</h3><dl class="kv">
        <dt>Applications</dt><dd>${e.registry.ok?a(e.registry.applications):r("unknown")}</dd>
        <dt>Enabled</dt><dd>${e.registry.ok?a(e.registry.enabled):r("unknown")}</dd>
      </dl></div>
    </div>
    <h2>Recent operations</h2>
    ${t?B(t.operations):'<div class="banner warn">Operation history unavailable (Argus unreachable).</div>'}`)}function _(e){const t=new Map;for(const s of e)t.has(s.application)||t.set(s.application,s);return t}async function J(){const[e,t]=await Promise.all([c.registry(),c.operations(void 0,100).catch(()=>null)]),s=t?_(t.operations):null,o=e.applications.map(n=>{const d=s&&s.get(n.application);return`<tr class="clickable" data-href="#/apps/${encodeURIComponent(n.application)}">
        <td><strong>${a(n.application)}</strong></td>
        <td>${a(n.type)}</td><td><code>${a(n.branch)}</code></td>
        <td>${n.enabled?r("enabled"):r("disabled")}${n.environment==="test"?" "+r("test"):""}</td>
        <td>${s?d?`${a(d.operation)} ${H(d)}`:'<span class="muted">none</span>':r("unknown")}</td>
      </tr>`}).join("");y(`
    <h1>Applications</h1>
    <p class="sub">Registry source: <code>${a(e.source.repository)}</code> · <code>${a(e.source.path)}</code></p>
    ${e.applications.length?`<table><thead><tr><th>Application</th><th>Type</th><th>Branch</th><th>State</th><th>Latest operation</th></tr></thead><tbody>${o}</tbody></table>`:'<div class="empty">No applications registered yet. Add one under <a href="#/registry">Registry</a>.</div>'}`)}const W=[{op:"deploy",label:"Deploy (latest)",confirm:!0},{op:"build",label:"Build",confirm:!0},{op:"sync",label:"Sync only",confirm:!1},{op:"pm2.reconcile",label:"Reconcile PM2",confirm:!1,node:!0},{op:"pm2.restart",label:"Restart",confirm:!0,node:!0},{op:"pm2.stop",label:"Stop",confirm:!0,node:!0,danger:!0},{op:"health",label:"Health check",confirm:!1}];function R(e){return e?e.refused?` Restart refused: ${a(e.error&&e.error.code)}.`:e.skipped?` (${a(e.skipped)})`:` Restart requested — <a href="#/ops/${encodeURIComponent(e.operationId)}">follow it</a>.`:""}async function K(e){const t=document.getElementById("env-section"),s=document.getElementById("token-section"),o=e.application,n=async(i="")=>{let f;try{f=await c.appEnv(o)}catch(p){t.innerHTML=m(p);return}t.innerHTML=`${i}
      <p class="muted">Values are write-only: they are never shown again. The app loads this file at start (node --env-file).</p>
      <table><thead><tr><th>Name</th><th></th></tr></thead><tbody>
      ${f.keys.map(p=>`<tr><td><code>${a(p.name)}</code> ${p.managedByManage?r("ok","written by Manage"):""}</td><td>${p.managedByManage?"":`<button class="btn ghost" data-unset="${a(p.name)}">Remove</button>`}</td></tr>`).join("")||'<tr><td colspan="2" class="empty">No variables yet.</td></tr>'}
      </tbody></table>
      <form class="stack" id="env-form">
        <div class="row"><label>Name <input name="name" required pattern="[A-Z_][A-Z0-9_]*" placeholder="SITE_PASSWORD_HASH" /></label>
        <label>Value <input name="value" type="password" autocomplete="off" required /></label></div>
        <label class="row"><input type="checkbox" name="restart" checked /> Restart the app afterwards</label>
        <button class="btn primary" type="submit">Set variable</button>
      </form>`,t.querySelector("#env-form").addEventListener("submit",async p=>{p.preventDefault();const b=new FormData(p.target);try{const l=await c.setAppEnv(o,{set:{[String(b.get("name"))]:String(b.get("value"))},restart:b.get("restart")==="on"});n(`<div class="banner info">Saved ${a(b.get("name"))}.${R(l.restart)}</div>`)}catch(l){t.insertAdjacentHTML("afterbegin",m(l))}}),t.querySelectorAll("[data-unset]").forEach(p=>p.addEventListener("click",async()=>{if(window.confirm(`Remove ${p.dataset.unset} from ${o}.env and restart the app?`))try{const b=await c.setAppEnv(o,{unset:[p.dataset.unset],restart:!0});n(`<div class="banner info">Removed ${a(p.dataset.unset)}.${R(b.restart)}</div>`)}catch(b){t.insertAdjacentHTML("afterbegin",m(b))}}))},d=async(i="")=>{let f;try{f=await c.appToken(o)}catch(h){s.innerHTML=m(h);return}const p=f.client,b=p?p.scopes:f.suggestedScopes||[];s.innerHTML=`${i}
      ${p?`<dl class="kv"><dt>Client</dt><dd><code>${a(p.id)}</code> · issued ${v(p.issuedAt)}</dd>
        <dt>Endpoint base</dt><dd><code>${a(f.endpoints.base)}</code></dd>
        <dt>Resources</dt><dd>${[...f.endpoints.resources,...f.endpoints.collections].map(h=>`<code>${a(h.key)}</code> ${r(h.access==="read-write"?"ok":"unknown",h.access)}`).join("<br>")||"—"}</dd></dl>`:'<p class="muted">No token yet. Issuing one writes MANAGE_API_TOKEN and MANAGE_API_URL into this app’s env file.</p>'}
      <form class="stack" id="token-form">
        <label>Scopes (JSON: resource key or "prefix.*", access read/write)
          <textarea name="scopes" rows="5" spellcheck="false">${a(JSON.stringify(b,null,2))}</textarea></label>
        <label class="row"><input type="checkbox" name="restart" checked /> Restart the app afterwards</label>
        <div class="row"><button class="btn primary" type="submit">${p?"Rotate token (old one stops working)":"Issue token"}</button>
        ${p?'<button class="btn danger" type="button" id="revoke">Revoke</button>':""}</div>
      </form>`,s.querySelector("#token-form").addEventListener("submit",async h=>{h.preventDefault();const w=new FormData(h.target);let $;try{$=JSON.parse(String(w.get("scopes")))}catch{s.insertAdjacentHTML("afterbegin",'<div class="banner bad">Scopes are not valid JSON.</div>');return}try{const k=await c.issueAppToken(o,{scopes:$,restart:w.get("restart")==="on"});d(`<div class="banner info">Token written to <code>${a(k.writtenTo)}</code>.${R(k.restart)}
          <details><summary>Show token once (for use outside this server)</summary><code class="secret">${a(k.token)}</code></details></div>`),n()}catch(k){s.insertAdjacentHTML("afterbegin",m(k))}});const l=s.querySelector("#revoke");l&&l.addEventListener("click",async()=>{if(window.confirm(`Revoke ${o}'s Manage API token? The app loses data access.`))try{const h=await c.revokeAppToken(o);d(`<div class="banner warn">Token revoked.${R(h.restart)}</div>`),n()}catch(h){s.insertAdjacentHTML("afterbegin",m(h))}})};n(),d()}async function D(e){const[{entry:t,status:s},o]=await Promise.all([c.app(e),c.operations(e,15).catch(()=>null)]),n=s||{},d=n.declaration,i=n.unavailable?r("unknown","unknown (Argus unavailable)"):d==null?r("unknown","not checked (not deployed)"):d.error?r("error",d.error):d.match?r("match"):`${r("mismatch")} <span class="muted">Registry stays authoritative.</span>${I(d.mismatches)}`,f=n.unavailable||n.processes==null?`<p>${r("unknown")} <span class="muted">No runtime facts supplied.</span></p>`:n.processes.length===0?`<p>${r("off","no process")}</p>`:`<table><thead><tr><th>Process</th><th>Status</th><th>PID</th><th>Restarts</th><th>Revision</th></tr></thead><tbody>${n.processes.map(l=>`<tr><td>${a(l.name)}</td><td>${r(l.status)}</td><td>${a(l.pid??"—")}</td><td>${a(l.restarts)}</td><td><code>${a((l.revision||"—").slice(0,12))}</code></td></tr>`).join("")}</tbody></table>`,p=n.executable,b=W.filter(l=>!l.node||t.type==="node").map(l=>`<button class="btn ${l.danger?"danger":""}" data-op="${a(l.op)}" data-confirm="${l.confirm}" ${t.enabled?"":"disabled"}>${a(l.label)}</button>`).join("");y(`
    <h1>${a(t.application)}</h1>
    <p class="sub">${t.enabled?r("enabled"):r("disabled")} ${t.environment==="test"?r("test","test target"):""} ${t.autoDeploy===!1?r("pending","auto-deploy off"):r("ok","auto-deploy on")}</p>
    ${n.unavailable?`<div class="banner bad">Argus unavailable (${a(n.code)}) — runtime state unknown.</div>`:""}
    ${n.undeployedPush?`<div class="banner warn">Pushed but <strong>not deployed</strong> (auto-deploy is off): <code>${a(n.undeployedPush.commit.slice(0,12))}</code> · ${v(n.undeployedPush.at)}. Use <strong>Deploy (latest)</strong> to deploy it, or <strong>Restart</strong> to restart without deploying.</div>`:""}
    ${p&&!p.ok?`<div class="banner warn">Argus will refuse operations: <strong>${a(p.code)}</strong> — ${a(p.reason)}</div>`:""}
    <div class="grid">
      <div class="card"><h3>Registry (authoritative)</h3><dl class="kv">
        <dt>Repository</dt><dd><code>${a(t.repository)}</code></dd>
        <dt>Branch</dt><dd><code>${a(t.branch)}</code></dd>
        <dt>Type</dt><dd>${a(t.type)}</dd>
        <dt>Path</dt><dd><code>${a(t.deploymentPath)}</code></dd>
        <dt>Domain</dt><dd>${a(t.domain)}${t.isPrimaryDomain?" (primary)":""}</dd>
        <dt>PM2 config</dt><dd><code>${a(t.pm2Config??"—")}</code></dd>
        <dt>Nginx config</dt><dd><code>${a(t.nginxConfig??"—")}</code></dd>
      </dl></div>
      <div class="card"><h3>Repository declaration</h3>${i}</div>
      <div class="card"><h3>Last deployed</h3>${n.deployed?`<dl class="kv"><dt>Commit</dt><dd><code>${a(n.deployed.commit.slice(0,12))}</code></dd><dt>At</dt><dd>${v(n.deployed.at)}</dd><dt>Health</dt><dd>${n.deployed.healthy?r("ok","healthy"):r("failed","unhealthy")}</dd></dl>`:r("unknown","never deployed by Argus")}</div>
    </div>
    <h2>PM2 processes</h2>${t.type==="node"?f:'<p class="muted">Static application — no PM2 processes.</p>'}
    <h2>Actions</h2>
    <div class="actions">${b}
      <button class="btn ghost" id="toggle-enabled">${t.enabled?"Disable":"Enable"}</button>
      <button class="btn ghost" id="toggle-autodeploy">${t.autoDeploy===!1?"Turn auto-deploy on":"Turn auto-deploy off"}</button>
      <a class="btn ghost" href="#/registry/${encodeURIComponent(t.application)}/edit">Edit registry entry</a>
    </div>
    <div id="action-result"></div>
    <h2>Environment <span class="muted">/infrastructure/env/${a(t.application)}.env</span></h2>
    <div id="env-section"><p class="muted">Loading…</p></div>
    <h2>Manage API token</h2>
    <div id="token-section"><p class="muted">Loading…</p></div>
    <h2>Operations</h2>
    ${o?B(o.operations):'<div class="banner warn">History unavailable (Argus unreachable).</div>'}`),K(t),P.querySelectorAll("[data-op]").forEach(l=>l.addEventListener("click",async()=>{const h=l.dataset.op;if(l.dataset.confirm==="true"&&!window.confirm(`Request "${h}" for ${t.application}?`))return;const w=document.getElementById("action-result");try{const $=await c.submit(h,t.application);location.hash=`#/ops/${encodeURIComponent($.operationId)}`}catch($){w.innerHTML=m($)}})),document.getElementById("toggle-enabled").addEventListener("click",async()=>{if(!window.confirm(`${t.enabled?"Disable":"Enable"} ${t.application}? This commits to bmb-data.`))return;const l=document.getElementById("action-result");try{const h=await c.setEnabled(t.application,!t.enabled);l.innerHTML=L(h.persistence),setTimeout(()=>g(()=>D(e)),1200)}catch(h){l.innerHTML=m(h)}}),document.getElementById("toggle-autodeploy").addEventListener("click",async()=>{const l=t.autoDeploy===!1,h=l?`Turn auto-deploy ON for ${t.application}? Every push to ${t.branch} will deploy and restart it.`:`Turn auto-deploy OFF for ${t.application}? Pushes will only be recorded; you deploy/restart manually.`;if(!window.confirm(h))return;const w=document.getElementById("action-result");try{const $=await c.setAutoDeploy(t.application,l);w.innerHTML=L($.persistence),setTimeout(()=>g(()=>D(e)),1200)}catch($){w.innerHTML=m($)}})}function B(e){return e.length?`<table><thead><tr><th>Operation</th><th>Application</th><th>Status</th><th>Stage</th><th>Created</th><th>Finished</th></tr></thead><tbody>${e.map(t=>`<tr class="clickable" data-href="#/ops/${encodeURIComponent(t.operationId)}">
      <td><code>${a(t.operation)}</code></td><td>${a(t.application)}</td><td>${H(t)}</td>
      <td>${a(t.stage??"—")}</td><td>${v(t.createdAt)}</td><td>${v(t.finishedAt)}</td></tr>`).join("")}</tbody></table>`:'<div class="empty">No operations recorded yet.</div>'}async function V(){const e=await c.operations(void 0,100);y(`<h1>Operations</h1><p class="sub">${a(e.total)} recorded. Accepted ≠ succeeded — open one to follow it.</p>${B(e.operations)}`)}async function Z(e){const t=o=>`
    <h1>Operation <code>${a(o.operationId)}</code></h1>
    <div class="grid"><div class="card"><dl class="kv">
      <dt>Operation</dt><dd><code>${a(o.operation)}</code></dd>
      <dt>Application</dt><dd><a href="#/apps/${encodeURIComponent(o.application)}">${a(o.application)}</a></dd>
      <dt>Status</dt><dd>${H(o)}${C.has(o.status)?"":' <span class="muted">(live — refreshing)</span>'}</dd>
      <dt>Stage</dt><dd>${a(o.stage??"—")}</dd>
      <dt>Created</dt><dd>${v(o.createdAt)}</dd>
      <dt>Finished</dt><dd>${v(o.finishedAt)}</dd>
    </dl></div></div>
    ${o.error?`<h2>Failure</h2><div class="banner bad"><strong>${a(o.error.code)}</strong> — ${a(o.error.message)}</div>${o.error.details?I(o.error.details):""}`:""}
    <h2>Result</h2>${o.result?I(o.result):'<p class="muted">No result yet.</p>'}`,s=await c.operation(e);y(t(s)),C.has(s.status)||(A=setInterval(()=>g(async()=>{const o=await c.operation(e);y(t(o)),C.has(o.status)&&N()}),1500))}async function z(){const t=(await c.registry()).applications.filter(s=>s.type==="node");y(`
    <h1>PM2 reconciliation</h1>
    <p class="sub">Reconcile makes an application's PM2 processes match its Argus-generated config. Unregistered processes are reported, never touched.</p>
    <div class="card"><h3>One application</h3>
      <form class="row" id="one">
        <select name="app" required>${t.map(s=>`<option value="${a(s.application)}" ${s.enabled?"":"disabled"}>${a(s.application)}${s.enabled?"":" (disabled)"}</option>`).join("")}</select>
        <button class="btn" type="submit" ${t.length?"":"disabled"}>Reconcile</button>
      </form></div>
    <h2>All eligible applications</h2>
    <div class="card">
      <p class="muted">Eligible = enabled, node, not a test entry. Argus additionally refuses anything outside its production allowlist. Each application gets an independent result.</p>
      <form class="stack" id="all">
        <label>Type <code>${a(j)}</code> to confirm<input name="confirm" autocomplete="off" /></label>
        <button class="btn danger" type="submit">Reconcile all eligible</button>
      </form>
    </div>
    <div id="rec-result"></div>`),document.getElementById("one").addEventListener("submit",async s=>{s.preventDefault();const o=document.getElementById("rec-result");try{const n=await c.reconcileApp(new FormData(s.target).get("app"));location.hash=`#/ops/${encodeURIComponent(n.operationId)}`}catch(n){o.innerHTML=m(n)}}),document.getElementById("all").addEventListener("submit",async s=>{s.preventDefault();const o=document.getElementById("rec-result"),n=String(new FormData(s.target).get("confirm")||"");if(n!==j){o.innerHTML='<div class="banner warn">Confirmation phrase does not match.</div>';return}try{const d=await c.reconcileAll(n);o.innerHTML=`<h2>Results</h2><table><thead><tr><th>Application</th><th>Result</th></tr></thead><tbody>${[...d.results.map(i=>`<tr><td>${a(i.application)}</td><td>${i.refused?`${r("refused")} <code>${a(i.error.code)}</code> ${a(i.error.message)}`:`${r("accepted")} <a href="#/ops/${encodeURIComponent(i.operationId)}">${a(i.operationId)}</a>`}</td></tr>`),...d.skipped.map(i=>`<tr><td>${a(i.application)}</td><td>${r("skipped")} ${a(i.reason)}</td></tr>`)].join("")}</tbody></table>`}catch(d){o.innerHTML=m(d)}})}const Q=["application","repository","branch","type","deploymentPath","domain","isPrimaryDomain","pm2Config","nginxConfig","enabled","environment","webhookSecretRef"];function X(e={},t=!1){const s=o=>a(e[o]??"");return`<form class="stack" id="entry-form">
    <label>Application (repository name)<input name="application" value="${s("application")}" ${t?"readonly":"required"} /></label>
    <label>Repository (SSH)<input name="repository" value="${s("repository")}" placeholder="git@github.com:owner/repo.git" required /></label>
    <label>Branch<input name="branch" value="${a(e.branch??"main")}" required /></label>
    <label>Type<select name="type"><option value="node" ${e.type==="node"?"selected":""}>node</option><option value="static" ${e.type==="static"?"selected":""}>static</option></select></label>
    <label>Deployment path<input name="deploymentPath" value="${s("deploymentPath")}" placeholder="/projects/&lt;application&gt;" required /></label>
    <label>Domain<input name="domain" value="${s("domain")}" required /></label>
    <label class="check"><input type="checkbox" name="isPrimaryDomain" ${e.isPrimaryDomain?"checked":""} /> Primary domain</label>
    <label>PM2 config file (node only)<input name="pm2Config" value="${s("pm2Config")}" placeholder="&lt;application&gt;.config.js" /></label>
    <label>Nginx config file (optional)<input name="nginxConfig" value="${s("nginxConfig")}" /></label>
    <label>Environment<select name="environment"><option value="production" ${e.environment!=="test"?"selected":""}>production</option><option value="test" ${e.environment==="test"?"selected":""}>test (never executed in production mode)</option></select></label>
    <label>Webhook secret ref (env var NAME, optional)<input name="webhookSecretRef" value="${s("webhookSecretRef")}" /></label>
    <label class="check"><input type="checkbox" name="enabled" ${e.enabled?"checked":""} /> Enabled</label>
    <div class="actions"><button class="btn primary" type="submit">${t?"Save changes":"Register application"}</button></div>
  </form><div id="form-result"></div>`}function Y(e){const t=new FormData(e),s={};for(const o of Q){if(o==="isPrimaryDomain"||o==="enabled"){s[o]=t.get(o)==="on";continue}const n=String(t.get(o)??"").trim();if(o==="pm2Config"||o==="nginxConfig"){s[o]=n===""?null:n;continue}if(o==="webhookSecretRef"){n&&(s[o]=n);continue}s[o]=n}return s}async function ee(e){const t=await c.registry(),s=e?t.applications.find(o=>o.application===e):null;y(`
    <h1>Registry</h1>
    <p class="sub">Authoritative deployment configuration, stored in <code>${a(t.source.repository)}</code>. Every change is a scoped commit + push.</p>
    <div class="actions"><button class="btn ghost" id="retry">Retry push</button></div>
    <div id="retry-result"></div>
    <h2>${s?`Edit ${a(s.application)}`:"Register an application"}</h2>
    ${X(s||{},!!s)}
    <h2>Registered</h2>
    ${t.applications.length?`<table><thead><tr><th>Application</th><th>Type</th><th>State</th><th></th></tr></thead><tbody>${t.applications.map(o=>`<tr><td>${a(o.application)}</td><td>${a(o.type)}</td><td>${o.enabled?r("enabled"):r("disabled")}${o.environment==="test"?" "+r("test"):""}</td><td><a href="#/registry/${encodeURIComponent(o.application)}/edit">edit</a></td></tr>`).join("")}</tbody></table>`:'<div class="empty">Nothing registered yet.</div>'}`),document.getElementById("entry-form").addEventListener("submit",async o=>{o.preventDefault();const n=document.getElementById("form-result"),d=Y(o.target);try{const i=s?await c.updateApp(s.application,d):await c.createApp(d);n.innerHTML=L(i.persistence)}catch(i){n.innerHTML=m(i)}}),document.getElementById("retry").addEventListener("click",async()=>{const o=document.getElementById("retry-result");try{o.innerHTML=L((await c.retryPush()).persistence)}catch(n){o.innerHTML=m(n)}})}const M=e=>e?`<code>${a(String(e).slice(0,12))}</code>`:"—";async function F(){const[e,t,s]=await Promise.all([c.dataStatus(),c.dataResources(),c.dataOperations(30)]),o=e.repository;y(`
    <h1>Canonical data</h1>
    ${o.blocked?`<div class="banner bad"><strong>${a(o.blocked)} blocked operation(s)</strong> — needs an explicit resolution.</div>`:""}
    ${o.pendingPush?`<div class="banner warn"><strong>${a(o.pendingPush)} change(s) committed but not pushed</strong> to bmb-data yet.</div>`:""}
    ${e.catalog.ok?"":`<div class="banner bad">Catalog invalid: ${a(e.catalog.error&&e.catalog.error.code)}</div>`}
    <section class="card"><h2>bmb-data checkout</h2><dl class="kv">
      <dt>Branch</dt><dd>${a(o.branch)}</dd>
      <dt>Local HEAD</dt><dd>${M(o.head)}</dd>
      <dt>Remote (last fetched)</dt><dd>${M(o.remote)} ${o.head&&o.head===o.remote?r("ok","in sync"):r("unknown","differs")}</dd>
      <dt>Working tree</dt><dd>${o.dirty===null?r("unknown"):o.dirty?r("blocked","dirty"):r("ok","clean")}</dd>
      <dt>Last webhook sync</dt><dd>${o.lastSync?`${r(o.lastSync.status)} ${a(o.lastSync.result?o.lastSync.result.state:"")} · ${v(o.lastSync.createdAt)}`:"—"}</dd>
      <dt>Catalog</dt><dd>${e.catalog.ok?`${a(e.catalog.resources)} resources · ${a(e.catalog.imported)} imported`:"—"}</dd>
    </dl></section>
    <section class="card"><h2>Resources</h2>
      <table><thead><tr><th>Key</th><th>Access</th><th>Status</th><th>Path</th><th>Source</th><th></th></tr></thead><tbody>
      ${t.resources.map(n=>`<tr><td><code>${a(n.key)}</code></td><td>${r(n.access==="private"?"blocked":"ok",n.access)}</td><td>${r(n.status==="imported"?"succeeded":"pending",n.status)}</td><td><code>${a(n.path)}</code></td><td>${n.source?`<code>${a(n.source.repository)}:${a(n.source.path)}</code>`:"—"}</td><td>${n.status==="imported"?`<a class="btn" href="#/data/res/${encodeURIComponent(n.key)}">Open</a> `:""}</td></tr>`).join("")||'<tr><td colspan="6" class="empty">No catalog yet.</td></tr>'}
      </tbody></table></section>
    <section class="card"><h2>Data operations</h2><div id="data-retry"></div>
      <table><thead><tr><th>When</th><th>Action</th><th>Resources</th><th>Status</th><th>Phase</th><th>Commit</th><th></th></tr></thead><tbody>
      ${s.operations.map(n=>`<tr><td>${v(n.createdAt)}</td><td>${a(n.action)}</td><td>${a((n.keys||[]).join(", ")||n.result&&n.result.state||"")}</td><td>${r(n.status)}</td><td>${a(n.phase||"—")}</td><td>${M(n.commit||n.result&&n.result.to)}</td><td>${["pending-push","failed","blocked"].includes(n.status)&&n.kind==="mutation"?`<button class="btn" data-retry="${a(n.operationId)}">Retry</button>`:""}</td></tr>`).join("")||'<tr><td colspan="7" class="empty">No data operations yet.</td></tr>'}
      </tbody></table></section>`),P.querySelectorAll("button[data-retry]").forEach(n=>n.addEventListener("click",async()=>{const d=document.getElementById("data-retry");try{const i=await c.dataRetry(n.dataset.retry);d.innerHTML=`<div class="banner ${i.status==="succeeded"?"info":"warn"}">${a(i.operationId)}: ${a(i.status)}</div>`,setTimeout(()=>g(()=>F()),800)}catch(i){d.innerHTML=m(i)}}))}async function G(e){const t=await c.dataResource(e);y(`
    <p><a href="#/data">← Data</a></p>
    <h1><code>${a(e)}</code></h1>
    <section class="card"><dl class="kv"><dt>Revision</dt><dd><code>${a(t.revision.slice(0,16))}</code></dd></dl>
      <form class="stack" id="res-form">
        <label>Document (JSON) <textarea name="doc" rows="22" spellcheck="false">${a(JSON.stringify(t.data,null,2))}</textarea></label>
        <button class="btn primary" type="submit">Save to bmb-data</button>
      </form>
      <div id="res-result"></div></section>`),document.getElementById("res-form").addEventListener("submit",async s=>{s.preventDefault();const o=document.getElementById("res-result");let n;try{n=JSON.parse(new FormData(s.target).get("doc"))}catch{o.innerHTML='<div class="banner bad">Not valid JSON — nothing was sent.</div>';return}try{const i=(await c.dataReplace(e,n,t.revision)).persistence;o.innerHTML=i.saved?`<div class="banner info">${i.status==="noop"?"No change.":"Saved, pushed and read back from bmb-data"} ${i.commit?`· <code>${a(i.commit.slice(0,12))}</code>`:""}</div>`:`<div class="banner warn">Committed locally but <strong>not pushed yet</strong> (${a(i.error&&i.error.code)}) — retry from the Data page.</div>`,i.saved&&setTimeout(()=>g(()=>G(e)),1200)}catch(d){o.innerHTML=m(d)}})}function U(){N();const t=location.hash.replace(/^#\/?/,"").split("/").map(decodeURIComponent);if(document.querySelectorAll("#nav a").forEach(s=>s.classList.toggle("active",s.dataset.route===(t[0]||"overview"))),y('<p class="muted">Loading…</p>'),!t[0])return g(x);if(t[0]==="apps")return g(()=>t[1]?D(t[1]):J());if(t[0]==="ops")return g(()=>t[1]?Z(t[1]):V());if(t[0]==="reconcile")return g(z);if(t[0]==="registry")return g(()=>ee(t[2]==="edit"?t[1]:null));if(t[0]==="data"&&t[1]==="res"&&t[2])return g(()=>G(t[2]));if(t[0]==="data")return g(()=>F());y('<div class="empty">Not found.</div>')}P.addEventListener("click",e=>{const t=e.target.closest("tr[data-href]");t&&!e.target.closest("a,button")&&(location.hash=t.dataset.href)});document.getElementById("logout").addEventListener("click",async()=>{try{await c.logout()}finally{T()}});window.addEventListener("hashchange",U);(async()=>{try{if(!(await c.session()).authenticated)return T();if(q())return;O.classList.remove("hidden"),U()}catch{T("Manage API unreachable.")}})();
