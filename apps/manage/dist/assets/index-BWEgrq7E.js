(function(){const t=document.createElement("link").relList;if(t&&t.supports&&t.supports("modulepreload"))return;for(const o of document.querySelectorAll('link[rel="modulepreload"]'))s(o);new MutationObserver(o=>{for(const d of o)if(d.type==="childList")for(const r of d.addedNodes)r.tagName==="LINK"&&r.rel==="modulepreload"&&s(r)}).observe(document,{childList:!0,subtree:!0});function a(o){const d={};return o.integrity&&(d.integrity=o.integrity),o.referrerPolicy&&(d.referrerPolicy=o.referrerPolicy),o.crossOrigin==="use-credentials"?d.credentials="include":o.crossOrigin==="anonymous"?d.credentials="omit":d.credentials="same-origin",d}function s(o){if(o.ep)return;o.ep=!0;const d=a(o);fetch(o.href,d)}})();let k=null;class I extends Error{constructor(t,a){super(a&&a.message||`HTTP ${t}`),this.status=t,this.code=a&&a.code||"HTTP_ERROR",this.details=a&&a.details}}async function p(e,t,a){const s={accept:"application/json"};a!==void 0&&(s["content-type"]="application/json"),e!=="GET"&&k&&(s["x-csrf-token"]=k);const o=await fetch(`/api/v1${t}`,{method:e,headers:s,credentials:"same-origin",body:a!==void 0?JSON.stringify(a):void 0});let d=null;try{d=await o.json()}catch{}if(!o.ok)throw new I(o.status,d);return d}const c={async session(){const e=await p("GET","/auth/session");return k=e.authenticated?e.csrfToken:null,e},async login(e){const t=await p("POST","/auth/login",{password:e});return k=t.csrfToken,t},async logout(){await p("POST","/auth/logout",{}),k=null},status:()=>p("GET","/status"),registry:()=>p("GET","/registry"),app:e=>p("GET",`/registry/${encodeURIComponent(e)}`),createApp:e=>p("POST","/registry",e),updateApp:(e,t)=>p("PUT",`/registry/${encodeURIComponent(e)}`,t),setEnabled:(e,t)=>p("PATCH",`/registry/${encodeURIComponent(e)}/enabled`,{enabled:t}),retryPush:()=>p("POST","/registry/retry-push",{}),operations:(e,t=50)=>p("GET",`/operations?limit=${t}${e?`&application=${encodeURIComponent(e)}`:""}`),operation:e=>p("GET",`/operations/${encodeURIComponent(e)}`),submit:(e,t,a)=>p("POST","/operations",{operation:e,application:t,...a?{params:a}:{}}),reconcileApp:e=>p("POST",`/reconcile/${encodeURIComponent(e)}`,{}),reconcileAll:e=>p("POST","/reconcile",{confirm:e}),dataStatus:()=>p("GET","/data/status"),dataResources:()=>p("GET","/data/resources"),dataOperations:(e=30)=>p("GET",`/data/operations?limit=${e}`),dataRetry:e=>p("POST",`/data/operations/${encodeURIComponent(e)}/retry`,{}),dataCompare:e=>p("GET",`/data/resources/${encodeURIComponent(e)}/compare`),dataResource:e=>p("GET",`/data/resources/${encodeURIComponent(e)}`),dataReplace:(e,t,a)=>p("PUT",`/data/resources/${encodeURIComponent(e)}`,{data:t,ifRevision:a}),appEnv:e=>p("GET",`/apps/${encodeURIComponent(e)}/env`),setAppEnv:(e,t)=>p("PUT",`/apps/${encodeURIComponent(e)}/env`,t),appToken:e=>p("GET",`/apps/${encodeURIComponent(e)}/token`),issueAppToken:(e,t)=>p("POST",`/apps/${encodeURIComponent(e)}/token`,t),revokeAppToken:e=>p("DELETE",`/apps/${encodeURIComponent(e)}/token?restart=true`)},L=document.getElementById("view"),M=document.getElementById("topbar"),P=new Set(["succeeded","failed","blocked"]),U="RECONCILE ALL ELIGIBLE APPS";let A=null;const n=e=>String(e??"").replace(/[&<>"']/g,t=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[t]),i=(e,t)=>`<span class="badge s-${n(String(e).toLowerCase())}">${n(t??e)}</span>`,f=e=>e?new Date(e).toLocaleString():"—",E=e=>`<pre class="json">${n(JSON.stringify(e,null,2))}</pre>`,y=e=>{L.innerHTML=e};function N(e){return e.status==="succeeded"&&e.result&&e.result.noop?i("noop","no-op"):i(e.status)}function m(e){const t=e instanceof I?e.code:"ERROR",a=e instanceof I?e.message:"Unexpected error";return`<div class="banner bad"><strong>${n(t)}</strong> — ${n(a)}${e&&e.details?`<details><summary>details</summary>${E(e.details)}</details>`:""}</div>`}function O(e){return e?e.pending?`<div class="banner warn">Saved and committed on the server, but <strong>not pushed to bmb-data yet</strong> (${n(e.error&&e.error.code)}). Use “Retry push”.</div>`:`<div class="banner info">${e.committed?"Committed":"No content change"}${e.pushed?" and pushed to bmb-data":""}${e.commit?` · <code>${n(e.commit.slice(0,12))}</code>`:""}.</div>`:""}function D(){A&&clearInterval(A),A=null}async function $(e){try{await e()}catch(t){if(t instanceof I&&t.status===401)return R();y(m(t))}}function R(e){D(),M.classList.add("hidden"),y(`
    <section class="login card">
      <h1>Manage</h1>
      ${e?`<div class="banner bad">${n(e)}</div>`:""}
      <form class="stack" id="login-form">
        <label>Admin password <input type="password" name="password" autocomplete="current-password" required autofocus /></label>
        <button class="btn primary" type="submit">Sign in</button>
      </form>
    </section>`),document.getElementById("login-form").addEventListener("submit",async t=>{t.preventDefault();const a=new FormData(t.target).get("password");try{await c.login(String(a)),M.classList.remove("hidden"),B()}catch(s){R(s.code==="RATE_LIMITED"?"Too many attempts — wait and retry.":"Sign-in failed.")}})}async function F(){const[e,t]=await Promise.all([c.status(),c.operations(void 0,8).catch(()=>null)]),a=e.argus;y(`
    <h1>Overview</h1>
    ${a.reachable?"":`<div class="banner bad"><strong>Argus unavailable</strong> (${n(a.code)}). Operations cannot run until it is reachable.</div>`}
    ${e.registry.ok?"":`<div class="banner bad">Registry unreadable (${n(e.registry.code)}).</div>`}
    <div class="grid">
      <div class="card"><h3>Manage</h3><dl class="kv"><dt>Status</dt><dd>${i("ok")}</dd><dt>Env</dt><dd>${n(e.manage.env)}</dd></dl></div>
      <div class="card"><h3>Argus</h3><dl class="kv">
        <dt>Reachable</dt><dd>${a.reachable?i("ok","yes"):i("unavailable","no")}</dd>
        <dt>Mode</dt><dd>${a.reachable?n(a.mode):i("unknown")}</dd>
        <dt>Execution</dt><dd>${a.reachable?a.executionEnabled?i("ok","enabled"):i("disabled"):i("unknown")}</dd>
      </dl></div>
      <div class="card"><h3>Registry</h3><dl class="kv">
        <dt>Applications</dt><dd>${e.registry.ok?n(e.registry.applications):i("unknown")}</dd>
        <dt>Enabled</dt><dd>${e.registry.ok?n(e.registry.enabled):i("unknown")}</dd>
      </dl></div>
    </div>
    <h2>Recent operations</h2>
    ${t?H(t.operations):'<div class="banner warn">Operation history unavailable (Argus unreachable).</div>'}`)}function _(e){const t=new Map;for(const a of e)t.has(a.application)||t.set(a.application,a);return t}async function J(){const[e,t]=await Promise.all([c.registry(),c.operations(void 0,100).catch(()=>null)]),a=t?_(t.operations):null,s=e.applications.map(o=>{const d=a&&a.get(o.application);return`<tr class="clickable" data-href="#/apps/${encodeURIComponent(o.application)}">
        <td><strong>${n(o.application)}</strong></td>
        <td>${n(o.type)}</td><td><code>${n(o.branch)}</code></td>
        <td>${o.enabled?i("enabled"):i("disabled")}${o.environment==="test"?" "+i("test"):""}</td>
        <td>${a?d?`${n(d.operation)} ${N(d)}`:'<span class="muted">none</span>':i("unknown")}</td>
      </tr>`}).join("");y(`
    <h1>Applications</h1>
    <p class="sub">Registry source: <code>${n(e.source.repository)}</code> · <code>${n(e.source.path)}</code></p>
    ${e.applications.length?`<table><thead><tr><th>Application</th><th>Type</th><th>Branch</th><th>State</th><th>Latest operation</th></tr></thead><tbody>${s}</tbody></table>`:'<div class="empty">No applications registered yet. Add one under <a href="#/registry">Registry</a>.</div>'}`)}const x=[{op:"deploy",label:"Deploy (latest)",confirm:!0},{op:"build",label:"Build",confirm:!0},{op:"sync",label:"Sync only",confirm:!1},{op:"pm2.reconcile",label:"Reconcile PM2",confirm:!1,node:!0},{op:"pm2.restart",label:"Restart",confirm:!0,node:!0},{op:"pm2.stop",label:"Stop",confirm:!0,node:!0,danger:!0},{op:"health",label:"Health check",confirm:!1}];function S(e){return e?e.refused?` Restart refused: ${n(e.error&&e.error.code)}.`:e.skipped?` (${n(e.skipped)})`:` Restart requested — <a href="#/ops/${encodeURIComponent(e.operationId)}">follow it</a>.`:""}async function W(e){const t=document.getElementById("env-section"),a=document.getElementById("token-section"),s=e.application,o=async(r="")=>{let b;try{b=await c.appEnv(s)}catch(l){t.innerHTML=m(l);return}t.innerHTML=`${r}
      <p class="muted">Values are write-only: they are never shown again. The app loads this file at start (node --env-file).</p>
      <table><thead><tr><th>Name</th><th></th></tr></thead><tbody>
      ${b.keys.map(l=>`<tr><td><code>${n(l.name)}</code> ${l.managedByManage?i("ok","written by Manage"):""}</td><td>${l.managedByManage?"":`<button class="btn ghost" data-unset="${n(l.name)}">Remove</button>`}</td></tr>`).join("")||'<tr><td colspan="2" class="empty">No variables yet.</td></tr>'}
      </tbody></table>
      <form class="stack" id="env-form">
        <div class="row"><label>Name <input name="name" required pattern="[A-Z_][A-Z0-9_]*" placeholder="SITE_PASSWORD_HASH" /></label>
        <label>Value <input name="value" type="password" autocomplete="off" required /></label></div>
        <label class="row"><input type="checkbox" name="restart" checked /> Restart the app afterwards</label>
        <button class="btn primary" type="submit">Set variable</button>
      </form>`,t.querySelector("#env-form").addEventListener("submit",async l=>{l.preventDefault();const g=new FormData(l.target);try{const u=await c.setAppEnv(s,{set:{[String(g.get("name"))]:String(g.get("value"))},restart:g.get("restart")==="on"});o(`<div class="banner info">Saved ${n(g.get("name"))}.${S(u.restart)}</div>`)}catch(u){t.insertAdjacentHTML("afterbegin",m(u))}}),t.querySelectorAll("[data-unset]").forEach(l=>l.addEventListener("click",async()=>{if(window.confirm(`Remove ${l.dataset.unset} from ${s}.env and restart the app?`))try{const g=await c.setAppEnv(s,{unset:[l.dataset.unset],restart:!0});o(`<div class="banner info">Removed ${n(l.dataset.unset)}.${S(g.restart)}</div>`)}catch(g){t.insertAdjacentHTML("afterbegin",m(g))}}))},d=async(r="")=>{let b;try{b=await c.appToken(s)}catch(h){a.innerHTML=m(h);return}const l=b.client,g=l?l.scopes:b.suggestedScopes||[];a.innerHTML=`${r}
      ${l?`<dl class="kv"><dt>Client</dt><dd><code>${n(l.id)}</code> · issued ${f(l.issuedAt)}</dd>
        <dt>Endpoint base</dt><dd><code>${n(b.endpoints.base)}</code></dd>
        <dt>Resources</dt><dd>${[...b.endpoints.resources,...b.endpoints.collections].map(h=>`<code>${n(h.key)}</code> ${i(h.access==="read-write"?"ok":"unknown",h.access)}`).join("<br>")||"—"}</dd></dl>`:'<p class="muted">No token yet. Issuing one writes MANAGE_API_TOKEN and MANAGE_API_URL into this app’s env file.</p>'}
      <form class="stack" id="token-form">
        <label>Scopes (JSON: resource key or "prefix.*", access read/write)
          <textarea name="scopes" rows="5" spellcheck="false">${n(JSON.stringify(g,null,2))}</textarea></label>
        <label class="row"><input type="checkbox" name="restart" checked /> Restart the app afterwards</label>
        <div class="row"><button class="btn primary" type="submit">${l?"Rotate token (old one stops working)":"Issue token"}</button>
        ${l?'<button class="btn danger" type="button" id="revoke">Revoke</button>':""}</div>
      </form>`,a.querySelector("#token-form").addEventListener("submit",async h=>{h.preventDefault();const T=new FormData(h.target);let v;try{v=JSON.parse(String(T.get("scopes")))}catch{a.insertAdjacentHTML("afterbegin",'<div class="banner bad">Scopes are not valid JSON.</div>');return}try{const w=await c.issueAppToken(s,{scopes:v,restart:T.get("restart")==="on"});d(`<div class="banner info">Token written to <code>${n(w.writtenTo)}</code>.${S(w.restart)}
          <details><summary>Show token once (for use outside this server)</summary><code class="secret">${n(w.token)}</code></details></div>`),o()}catch(w){a.insertAdjacentHTML("afterbegin",m(w))}});const u=a.querySelector("#revoke");u&&u.addEventListener("click",async()=>{if(window.confirm(`Revoke ${s}'s Manage API token? The app loses data access.`))try{const h=await c.revokeAppToken(s);d(`<div class="banner warn">Token revoked.${S(h.restart)}</div>`),o()}catch(h){a.insertAdjacentHTML("afterbegin",m(h))}})};o(),d()}async function j(e){const[{entry:t,status:a},s]=await Promise.all([c.app(e),c.operations(e,15).catch(()=>null)]),o=a||{},d=o.declaration,r=o.unavailable?i("unknown","unknown (Argus unavailable)"):d==null?i("unknown","not checked (not deployed)"):d.error?i("error",d.error):d.match?i("match"):`${i("mismatch")} <span class="muted">Registry stays authoritative.</span>${E(d.mismatches)}`,b=o.unavailable||o.processes==null?`<p>${i("unknown")} <span class="muted">No runtime facts supplied.</span></p>`:o.processes.length===0?`<p>${i("off","no process")}</p>`:`<table><thead><tr><th>Process</th><th>Status</th><th>PID</th><th>Restarts</th><th>Revision</th></tr></thead><tbody>${o.processes.map(u=>`<tr><td>${n(u.name)}</td><td>${i(u.status)}</td><td>${n(u.pid??"—")}</td><td>${n(u.restarts)}</td><td><code>${n((u.revision||"—").slice(0,12))}</code></td></tr>`).join("")}</tbody></table>`,l=o.executable,g=x.filter(u=>!u.node||t.type==="node").map(u=>`<button class="btn ${u.danger?"danger":""}" data-op="${n(u.op)}" data-confirm="${u.confirm}" ${t.enabled?"":"disabled"}>${n(u.label)}</button>`).join("");y(`
    <h1>${n(t.application)}</h1>
    <p class="sub">${t.enabled?i("enabled"):i("disabled")} ${t.environment==="test"?i("test","test target"):""}</p>
    ${o.unavailable?`<div class="banner bad">Argus unavailable (${n(o.code)}) — runtime state unknown.</div>`:""}
    ${l&&!l.ok?`<div class="banner warn">Argus will refuse operations: <strong>${n(l.code)}</strong> — ${n(l.reason)}</div>`:""}
    <div class="grid">
      <div class="card"><h3>Registry (authoritative)</h3><dl class="kv">
        <dt>Repository</dt><dd><code>${n(t.repository)}</code></dd>
        <dt>Branch</dt><dd><code>${n(t.branch)}</code></dd>
        <dt>Type</dt><dd>${n(t.type)}</dd>
        <dt>Path</dt><dd><code>${n(t.deploymentPath)}</code></dd>
        <dt>Domain</dt><dd>${n(t.domain)}${t.isPrimaryDomain?" (primary)":""}</dd>
        <dt>PM2 config</dt><dd><code>${n(t.pm2Config??"—")}</code></dd>
        <dt>Nginx config</dt><dd><code>${n(t.nginxConfig??"—")}</code></dd>
      </dl></div>
      <div class="card"><h3>Repository declaration</h3>${r}</div>
      <div class="card"><h3>Last deployed</h3>${o.deployed?`<dl class="kv"><dt>Commit</dt><dd><code>${n(o.deployed.commit.slice(0,12))}</code></dd><dt>At</dt><dd>${f(o.deployed.at)}</dd><dt>Health</dt><dd>${o.deployed.healthy?i("ok","healthy"):i("failed","unhealthy")}</dd></dl>`:i("unknown","never deployed by Argus")}</div>
    </div>
    <h2>PM2 processes</h2>${t.type==="node"?b:'<p class="muted">Static application — no PM2 processes.</p>'}
    <h2>Actions</h2>
    <div class="actions">${g}
      <button class="btn ghost" id="toggle-enabled">${t.enabled?"Disable":"Enable"}</button>
      <a class="btn ghost" href="#/registry/${encodeURIComponent(t.application)}/edit">Edit registry entry</a>
    </div>
    <div id="action-result"></div>
    <h2>Environment <span class="muted">/infrastructure/env/${n(t.application)}.env</span></h2>
    <div id="env-section"><p class="muted">Loading…</p></div>
    <h2>Manage API token</h2>
    <div id="token-section"><p class="muted">Loading…</p></div>
    <h2>Operations</h2>
    ${s?H(s.operations):'<div class="banner warn">History unavailable (Argus unreachable).</div>'}`),W(t),L.querySelectorAll("[data-op]").forEach(u=>u.addEventListener("click",async()=>{const h=u.dataset.op;if(u.dataset.confirm==="true"&&!window.confirm(`Request "${h}" for ${t.application}?`))return;const T=document.getElementById("action-result");try{const v=await c.submit(h,t.application);location.hash=`#/ops/${encodeURIComponent(v.operationId)}`}catch(v){T.innerHTML=m(v)}})),document.getElementById("toggle-enabled").addEventListener("click",async()=>{if(!window.confirm(`${t.enabled?"Disable":"Enable"} ${t.application}? This commits to bmb-data.`))return;const u=document.getElementById("action-result");try{const h=await c.setEnabled(t.application,!t.enabled);u.innerHTML=O(h.persistence),setTimeout(()=>$(()=>j(e)),1200)}catch(h){u.innerHTML=m(h)}})}function H(e){return e.length?`<table><thead><tr><th>Operation</th><th>Application</th><th>Status</th><th>Stage</th><th>Created</th><th>Finished</th></tr></thead><tbody>${e.map(t=>`<tr class="clickable" data-href="#/ops/${encodeURIComponent(t.operationId)}">
      <td><code>${n(t.operation)}</code></td><td>${n(t.application)}</td><td>${N(t)}</td>
      <td>${n(t.stage??"—")}</td><td>${f(t.createdAt)}</td><td>${f(t.finishedAt)}</td></tr>`).join("")}</tbody></table>`:'<div class="empty">No operations recorded yet.</div>'}async function V(){const e=await c.operations(void 0,100);y(`<h1>Operations</h1><p class="sub">${n(e.total)} recorded. Accepted ≠ succeeded — open one to follow it.</p>${H(e.operations)}`)}async function Z(e){const t=s=>`
    <h1>Operation <code>${n(s.operationId)}</code></h1>
    <div class="grid"><div class="card"><dl class="kv">
      <dt>Operation</dt><dd><code>${n(s.operation)}</code></dd>
      <dt>Application</dt><dd><a href="#/apps/${encodeURIComponent(s.application)}">${n(s.application)}</a></dd>
      <dt>Status</dt><dd>${N(s)}${P.has(s.status)?"":' <span class="muted">(live — refreshing)</span>'}</dd>
      <dt>Stage</dt><dd>${n(s.stage??"—")}</dd>
      <dt>Created</dt><dd>${f(s.createdAt)}</dd>
      <dt>Finished</dt><dd>${f(s.finishedAt)}</dd>
    </dl></div></div>
    ${s.error?`<h2>Failure</h2><div class="banner bad"><strong>${n(s.error.code)}</strong> — ${n(s.error.message)}</div>${s.error.details?E(s.error.details):""}`:""}
    <h2>Result</h2>${s.result?E(s.result):'<p class="muted">No result yet.</p>'}`,a=await c.operation(e);y(t(a)),P.has(a.status)||(A=setInterval(()=>$(async()=>{const s=await c.operation(e);y(t(s)),P.has(s.status)&&D()}),1500))}async function z(){const t=(await c.registry()).applications.filter(a=>a.type==="node");y(`
    <h1>PM2 reconciliation</h1>
    <p class="sub">Reconcile makes an application's PM2 processes match its Argus-generated config. Unregistered processes are reported, never touched.</p>
    <div class="card"><h3>One application</h3>
      <form class="row" id="one">
        <select name="app" required>${t.map(a=>`<option value="${n(a.application)}" ${a.enabled?"":"disabled"}>${n(a.application)}${a.enabled?"":" (disabled)"}</option>`).join("")}</select>
        <button class="btn" type="submit" ${t.length?"":"disabled"}>Reconcile</button>
      </form></div>
    <h2>All eligible applications</h2>
    <div class="card">
      <p class="muted">Eligible = enabled, node, not a test entry. Argus additionally refuses anything outside its production allowlist. Each application gets an independent result.</p>
      <form class="stack" id="all">
        <label>Type <code>${n(U)}</code> to confirm<input name="confirm" autocomplete="off" /></label>
        <button class="btn danger" type="submit">Reconcile all eligible</button>
      </form>
    </div>
    <div id="rec-result"></div>`),document.getElementById("one").addEventListener("submit",async a=>{a.preventDefault();const s=document.getElementById("rec-result");try{const o=await c.reconcileApp(new FormData(a.target).get("app"));location.hash=`#/ops/${encodeURIComponent(o.operationId)}`}catch(o){s.innerHTML=m(o)}}),document.getElementById("all").addEventListener("submit",async a=>{a.preventDefault();const s=document.getElementById("rec-result"),o=String(new FormData(a.target).get("confirm")||"");if(o!==U){s.innerHTML='<div class="banner warn">Confirmation phrase does not match.</div>';return}try{const d=await c.reconcileAll(o);s.innerHTML=`<h2>Results</h2><table><thead><tr><th>Application</th><th>Result</th></tr></thead><tbody>${[...d.results.map(r=>`<tr><td>${n(r.application)}</td><td>${r.refused?`${i("refused")} <code>${n(r.error.code)}</code> ${n(r.error.message)}`:`${i("accepted")} <a href="#/ops/${encodeURIComponent(r.operationId)}">${n(r.operationId)}</a>`}</td></tr>`),...d.skipped.map(r=>`<tr><td>${n(r.application)}</td><td>${i("skipped")} ${n(r.reason)}</td></tr>`)].join("")}</tbody></table>`}catch(d){s.innerHTML=m(d)}})}const K=["application","repository","branch","type","deploymentPath","domain","isPrimaryDomain","pm2Config","nginxConfig","enabled","environment","webhookSecretRef"];function Q(e={},t=!1){const a=s=>n(e[s]??"");return`<form class="stack" id="entry-form">
    <label>Application (repository name)<input name="application" value="${a("application")}" ${t?"readonly":"required"} /></label>
    <label>Repository (SSH)<input name="repository" value="${a("repository")}" placeholder="git@github.com:owner/repo.git" required /></label>
    <label>Branch<input name="branch" value="${n(e.branch??"main")}" required /></label>
    <label>Type<select name="type"><option value="node" ${e.type==="node"?"selected":""}>node</option><option value="static" ${e.type==="static"?"selected":""}>static</option></select></label>
    <label>Deployment path<input name="deploymentPath" value="${a("deploymentPath")}" placeholder="/projects/&lt;application&gt;" required /></label>
    <label>Domain<input name="domain" value="${a("domain")}" required /></label>
    <label class="check"><input type="checkbox" name="isPrimaryDomain" ${e.isPrimaryDomain?"checked":""} /> Primary domain</label>
    <label>PM2 config file (node only)<input name="pm2Config" value="${a("pm2Config")}" placeholder="&lt;application&gt;.config.js" /></label>
    <label>Nginx config file (optional)<input name="nginxConfig" value="${a("nginxConfig")}" /></label>
    <label>Environment<select name="environment"><option value="production" ${e.environment!=="test"?"selected":""}>production</option><option value="test" ${e.environment==="test"?"selected":""}>test (never executed in production mode)</option></select></label>
    <label>Webhook secret ref (env var NAME, optional)<input name="webhookSecretRef" value="${a("webhookSecretRef")}" /></label>
    <label class="check"><input type="checkbox" name="enabled" ${e.enabled?"checked":""} /> Enabled</label>
    <div class="actions"><button class="btn primary" type="submit">${t?"Save changes":"Register application"}</button></div>
  </form><div id="form-result"></div>`}function X(e){const t=new FormData(e),a={};for(const s of K){if(s==="isPrimaryDomain"||s==="enabled"){a[s]=t.get(s)==="on";continue}const o=String(t.get(s)??"").trim();if(s==="pm2Config"||s==="nginxConfig"){a[s]=o===""?null:o;continue}if(s==="webhookSecretRef"){o&&(a[s]=o);continue}a[s]=o}return a}async function Y(e){const t=await c.registry(),a=e?t.applications.find(s=>s.application===e):null;y(`
    <h1>Registry</h1>
    <p class="sub">Authoritative deployment configuration, stored in <code>${n(t.source.repository)}</code>. Every change is a scoped commit + push.</p>
    <div class="actions"><button class="btn ghost" id="retry">Retry push</button></div>
    <div id="retry-result"></div>
    <h2>${a?`Edit ${n(a.application)}`:"Register an application"}</h2>
    ${Q(a||{},!!a)}
    <h2>Registered</h2>
    ${t.applications.length?`<table><thead><tr><th>Application</th><th>Type</th><th>State</th><th></th></tr></thead><tbody>${t.applications.map(s=>`<tr><td>${n(s.application)}</td><td>${n(s.type)}</td><td>${s.enabled?i("enabled"):i("disabled")}${s.environment==="test"?" "+i("test"):""}</td><td><a href="#/registry/${encodeURIComponent(s.application)}/edit">edit</a></td></tr>`).join("")}</tbody></table>`:'<div class="empty">Nothing registered yet.</div>'}`),document.getElementById("entry-form").addEventListener("submit",async s=>{s.preventDefault();const o=document.getElementById("form-result"),d=X(s.target);try{const r=a?await c.updateApp(a.application,d):await c.createApp(d);o.innerHTML=O(r.persistence)}catch(r){o.innerHTML=m(r)}}),document.getElementById("retry").addEventListener("click",async()=>{const s=document.getElementById("retry-result");try{s.innerHTML=O((await c.retryPush()).persistence)}catch(o){s.innerHTML=m(o)}})}const C=e=>e?`<code>${n(String(e).slice(0,12))}</code>`:"—";async function q(e){const[t,a,s]=await Promise.all([c.dataStatus(),c.dataResources(),c.dataOperations(30)]),o=t.repository,d=e?await c.dataCompare(e).catch(r=>({error:r})):null;y(`
    <h1>Canonical data</h1>
    ${o.blocked?`<div class="banner bad"><strong>${n(o.blocked)} blocked operation(s)</strong> — needs an explicit resolution.</div>`:""}
    ${o.pendingPush?`<div class="banner warn"><strong>${n(o.pendingPush)} change(s) committed but not pushed</strong> to bmb-data yet.</div>`:""}
    ${t.catalog.ok?"":`<div class="banner bad">Catalog invalid: ${n(t.catalog.error&&t.catalog.error.code)}</div>`}
    <section class="card"><h2>bmb-data checkout</h2><dl class="kv">
      <dt>Branch</dt><dd>${n(o.branch)}</dd>
      <dt>Local HEAD</dt><dd>${C(o.head)}</dd>
      <dt>Remote (last fetched)</dt><dd>${C(o.remote)} ${o.head&&o.head===o.remote?i("ok","in sync"):i("unknown","differs")}</dd>
      <dt>Working tree</dt><dd>${o.dirty===null?i("unknown"):o.dirty?i("blocked","dirty"):i("ok","clean")}</dd>
      <dt>Last webhook sync</dt><dd>${o.lastSync?`${i(o.lastSync.status)} ${n(o.lastSync.result?o.lastSync.result.state:"")} · ${f(o.lastSync.createdAt)}`:"—"}</dd>
      <dt>Catalog</dt><dd>${t.catalog.ok?`${n(t.catalog.resources)} resources · ${n(t.catalog.imported)} imported`:"—"}</dd>
    </dl></section>
    <section class="card"><h2>Resources</h2>
      <table><thead><tr><th>Key</th><th>Access</th><th>Status</th><th>Path</th><th>Source</th><th></th></tr></thead><tbody>
      ${a.resources.map(r=>`<tr><td><code>${n(r.key)}</code></td><td>${i(r.access==="private"?"blocked":"ok",r.access)}</td><td>${i(r.status==="imported"?"succeeded":"pending",r.status)}</td><td><code>${n(r.path)}</code></td><td>${r.source?`<code>${n(r.source.repository)}:${n(r.source.path)}</code>`:"—"}</td><td>${r.status==="imported"?`<a class="btn" href="#/data/res/${encodeURIComponent(r.key)}">Open</a> `:""}${r.source?`<a class="btn" href="#/data/compare/${encodeURIComponent(r.key)}">Compare</a>`:""}</td></tr>`).join("")||'<tr><td colspan="6" class="empty">No catalog yet.</td></tr>'}
      </tbody></table></section>
    ${d?`<section class="card"><h2>Comparison: <code>${n(e)}</code></h2>${d.error?m(d.error):`<p>${d.identical?i("ok","identical"):i("mismatch","differs")} · source ${n(d.source.count??"—")} · target ${n(d.target.present?d.target.count:"not imported")}</p>${E(d)}`}</section>`:""}
    <section class="card"><h2>Data operations</h2><div id="data-retry"></div>
      <table><thead><tr><th>When</th><th>Action</th><th>Resources</th><th>Status</th><th>Phase</th><th>Commit</th><th></th></tr></thead><tbody>
      ${s.operations.map(r=>`<tr><td>${f(r.createdAt)}</td><td>${n(r.action)}</td><td>${n((r.keys||[]).join(", ")||r.result&&r.result.state||"")}</td><td>${i(r.status)}</td><td>${n(r.phase||"—")}</td><td>${C(r.commit||r.result&&r.result.to)}</td><td>${["pending-push","failed","blocked"].includes(r.status)&&r.kind==="mutation"?`<button class="btn" data-retry="${n(r.operationId)}">Retry</button>`:""}</td></tr>`).join("")||'<tr><td colspan="7" class="empty">No data operations yet.</td></tr>'}
      </tbody></table></section>`),L.querySelectorAll("button[data-retry]").forEach(r=>r.addEventListener("click",async()=>{const b=document.getElementById("data-retry");try{const l=await c.dataRetry(r.dataset.retry);b.innerHTML=`<div class="banner ${l.status==="succeeded"?"info":"warn"}">${n(l.operationId)}: ${n(l.status)}</div>`,setTimeout(()=>$(()=>q(e)),800)}catch(l){b.innerHTML=m(l)}}))}async function G(e){const t=await c.dataResource(e);y(`
    <p><a href="#/data">← Data</a></p>
    <h1><code>${n(e)}</code></h1>
    <section class="card"><dl class="kv"><dt>Revision</dt><dd><code>${n(t.revision.slice(0,16))}</code></dd></dl>
      <form class="stack" id="res-form">
        <label>Document (JSON) <textarea name="doc" rows="22" spellcheck="false">${n(JSON.stringify(t.data,null,2))}</textarea></label>
        <button class="btn primary" type="submit">Save to bmb-data</button>
      </form>
      <div id="res-result"></div></section>`),document.getElementById("res-form").addEventListener("submit",async a=>{a.preventDefault();const s=document.getElementById("res-result");let o;try{o=JSON.parse(new FormData(a.target).get("doc"))}catch{s.innerHTML='<div class="banner bad">Not valid JSON — nothing was sent.</div>';return}try{const r=(await c.dataReplace(e,o,t.revision)).persistence;s.innerHTML=r.saved?`<div class="banner info">${r.status==="noop"?"No change.":"Saved, pushed and read back from bmb-data"} ${r.commit?`· <code>${n(r.commit.slice(0,12))}</code>`:""}</div>`:`<div class="banner warn">Committed locally but <strong>not pushed yet</strong> (${n(r.error&&r.error.code)}) — retry from the Data page.</div>`,r.saved&&setTimeout(()=>$(()=>G(e)),1200)}catch(d){s.innerHTML=m(d)}})}function B(){D();const t=location.hash.replace(/^#\/?/,"").split("/").map(decodeURIComponent);if(document.querySelectorAll("#nav a").forEach(a=>a.classList.toggle("active",a.dataset.route===(t[0]||"overview"))),y('<p class="muted">Loading…</p>'),!t[0])return $(F);if(t[0]==="apps")return $(()=>t[1]?j(t[1]):J());if(t[0]==="ops")return $(()=>t[1]?Z(t[1]):V());if(t[0]==="reconcile")return $(z);if(t[0]==="registry")return $(()=>Y(t[2]==="edit"?t[1]:null));if(t[0]==="data"&&t[1]==="res"&&t[2])return $(()=>G(t[2]));if(t[0]==="data")return $(()=>q(t[1]==="compare"?t[2]:null));y('<div class="empty">Not found.</div>')}L.addEventListener("click",e=>{const t=e.target.closest("tr[data-href]");t&&!e.target.closest("a,button")&&(location.hash=t.dataset.href)});document.getElementById("logout").addEventListener("click",async()=>{try{await c.logout()}finally{R()}});window.addEventListener("hashchange",B);(async()=>{try{if(!(await c.session()).authenticated)return R();M.classList.remove("hidden"),B()}catch{R("Manage API unreachable.")}})();
