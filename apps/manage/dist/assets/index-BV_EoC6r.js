(function(){const t=document.createElement("link").relList;if(t&&t.supports&&t.supports("modulepreload"))return;for(const o of document.querySelectorAll('link[rel="modulepreload"]'))s(o);new MutationObserver(o=>{for(const i of o)if(i.type==="childList")for(const r of i.addedNodes)r.tagName==="LINK"&&r.rel==="modulepreload"&&s(r)}).observe(document,{childList:!0,subtree:!0});function a(o){const i={};return o.integrity&&(i.integrity=o.integrity),o.referrerPolicy&&(i.referrerPolicy=o.referrerPolicy),o.crossOrigin==="use-credentials"?i.credentials="include":o.crossOrigin==="anonymous"?i.credentials="omit":i.credentials="same-origin",i}function s(o){if(o.ep)return;o.ep=!0;const i=a(o);fetch(o.href,i)}})();let E=null;class I extends Error{constructor(t,a){super(a&&a.message||`HTTP ${t}`),this.status=t,this.code=a&&a.code||"HTTP_ERROR",this.details=a&&a.details}}async function u(e,t,a){const s={accept:"application/json"};a!==void 0&&(s["content-type"]="application/json"),e!=="GET"&&E&&(s["x-csrf-token"]=E);const o=await fetch(`/api/v1${t}`,{method:e,headers:s,credentials:"same-origin",body:a!==void 0?JSON.stringify(a):void 0});let i=null;try{i=await o.json()}catch{}if(!o.ok)throw new I(o.status,i);return i}const c={async session(){const e=await u("GET","/auth/session");return E=e.authenticated?e.csrfToken:null,e},async login(e){const t=await u("POST","/auth/login",{password:e});return E=t.csrfToken,t},async logout(){await u("POST","/auth/logout",{}),E=null},status:()=>u("GET","/status"),registry:()=>u("GET","/registry"),app:e=>u("GET",`/registry/${encodeURIComponent(e)}`),createApp:e=>u("POST","/registry",e),updateApp:(e,t)=>u("PUT",`/registry/${encodeURIComponent(e)}`,t),setEnabled:(e,t)=>u("PATCH",`/registry/${encodeURIComponent(e)}/enabled`,{enabled:t}),setAutoDeploy:(e,t)=>u("PATCH",`/registry/${encodeURIComponent(e)}/auto-deploy`,{autoDeploy:t}),retryPush:()=>u("POST","/registry/retry-push",{}),operations:(e,t=50)=>u("GET",`/operations?limit=${t}${e?`&application=${encodeURIComponent(e)}`:""}`),operation:e=>u("GET",`/operations/${encodeURIComponent(e)}`),submit:(e,t,a)=>u("POST","/operations",{operation:e,application:t,...a?{params:a}:{}}),reconcileApp:e=>u("POST",`/reconcile/${encodeURIComponent(e)}`,{}),reconcileAll:e=>u("POST","/reconcile",{confirm:e}),dataStatus:()=>u("GET","/data/status"),dataResources:()=>u("GET","/data/resources"),dataOperations:(e=30)=>u("GET",`/data/operations?limit=${e}`),dataRetry:e=>u("POST",`/data/operations/${encodeURIComponent(e)}/retry`,{}),dataCompare:e=>u("GET",`/data/resources/${encodeURIComponent(e)}/compare`),dataResource:e=>u("GET",`/data/resources/${encodeURIComponent(e)}`),dataReplace:(e,t,a)=>u("PUT",`/data/resources/${encodeURIComponent(e)}`,{data:t,ifRevision:a}),appEnv:e=>u("GET",`/apps/${encodeURIComponent(e)}/env`),setAppEnv:(e,t)=>u("PUT",`/apps/${encodeURIComponent(e)}/env`,t),appToken:e=>u("GET",`/apps/${encodeURIComponent(e)}/token`),issueAppToken:(e,t)=>u("POST",`/apps/${encodeURIComponent(e)}/token`,t),revokeAppToken:e=>u("DELETE",`/apps/${encodeURIComponent(e)}/token?restart=true`)},P=document.getElementById("view"),O=document.getElementById("topbar"),C=new Set(["succeeded","failed","blocked"]),j="RECONCILE ALL ELIGIBLE APPS";let S=null;const n=e=>String(e??"").replace(/[&<>"']/g,t=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[t]),d=(e,t)=>`<span class="badge s-${n(String(e).toLowerCase())}">${n(t??e)}</span>`,v=e=>e?new Date(e).toLocaleString():"—",T=e=>`<pre class="json">${n(JSON.stringify(e,null,2))}</pre>`,b=e=>{P.innerHTML=e};function H(e){return e.status==="succeeded"&&e.result&&e.result.noop?d("noop","no-op"):d(e.status)}function m(e){const t=e instanceof I?e.code:"ERROR",a=e instanceof I?e.message:"Unexpected error";return`<div class="banner bad"><strong>${n(t)}</strong> — ${n(a)}${e&&e.details?`<details><summary>details</summary>${T(e.details)}</details>`:""}</div>`}function L(e){return e?e.pending?`<div class="banner warn">Saved and committed on the server, but <strong>not pushed to bmb-data yet</strong> (${n(e.error&&e.error.code)}). Use “Retry push”.</div>`:`<div class="banner info">${e.committed?"Committed":"No content change"}${e.pushed?" and pushed to bmb-data":""}${e.commit?` · <code>${n(e.commit.slice(0,12))}</code>`:""}.</div>`:""}function N(){S&&clearInterval(S),S=null}async function f(e){try{await e()}catch(t){if(t instanceof I&&t.status===401)return R();b(m(t))}}function q(){const e=/^#\/login\?next=(.+)$/.exec(location.hash);if(!e)return!1;let t;try{t=decodeURIComponent(e[1])}catch{return!1}return t.startsWith("/api/v1/auth/app-login?")?(location.replace(t),!0):!1}function R(e){N(),O.classList.add("hidden"),b(`
    <section class="login card">
      <h1>Manage</h1>
      ${e?`<div class="banner bad">${n(e)}</div>`:""}
      <form class="stack" id="login-form">
        <label>Admin password <input type="password" name="password" autocomplete="current-password" required autofocus /></label>
        <button class="btn primary" type="submit">Sign in</button>
      </form>
    </section>`),document.getElementById("login-form").addEventListener("submit",async t=>{t.preventDefault();const a=new FormData(t.target).get("password");try{if(await c.login(String(a)),q())return;O.classList.remove("hidden"),B()}catch(s){R(s.code==="RATE_LIMITED"?"Too many attempts — wait and retry.":"Sign-in failed.")}})}async function x(){const[e,t]=await Promise.all([c.status(),c.operations(void 0,8).catch(()=>null)]),a=e.argus;b(`
    <h1>Overview</h1>
    ${a.reachable?"":`<div class="banner bad"><strong>Argus unavailable</strong> (${n(a.code)}). Operations cannot run until it is reachable.</div>`}
    ${e.registry.ok?"":`<div class="banner bad">Registry unreadable (${n(e.registry.code)}).</div>`}
    <div class="grid">
      <div class="card"><h3>Manage</h3><dl class="kv"><dt>Status</dt><dd>${d("ok")}</dd><dt>Env</dt><dd>${n(e.manage.env)}</dd></dl></div>
      <div class="card"><h3>Argus</h3><dl class="kv">
        <dt>Reachable</dt><dd>${a.reachable?d("ok","yes"):d("unavailable","no")}</dd>
        <dt>Mode</dt><dd>${a.reachable?n(a.mode):d("unknown")}</dd>
        <dt>Execution</dt><dd>${a.reachable?a.executionEnabled?d("ok","enabled"):d("disabled"):d("unknown")}</dd>
      </dl></div>
      <div class="card"><h3>Registry</h3><dl class="kv">
        <dt>Applications</dt><dd>${e.registry.ok?n(e.registry.applications):d("unknown")}</dd>
        <dt>Enabled</dt><dd>${e.registry.ok?n(e.registry.enabled):d("unknown")}</dd>
      </dl></div>
    </div>
    <h2>Recent operations</h2>
    ${t?U(t.operations):'<div class="banner warn">Operation history unavailable (Argus unreachable).</div>'}`)}function _(e){const t=new Map;for(const a of e)t.has(a.application)||t.set(a.application,a);return t}async function J(){const[e,t]=await Promise.all([c.registry(),c.operations(void 0,100).catch(()=>null)]),a=t?_(t.operations):null,s=e.applications.map(o=>{const i=a&&a.get(o.application);return`<tr class="clickable" data-href="#/apps/${encodeURIComponent(o.application)}">
        <td><strong>${n(o.application)}</strong></td>
        <td>${n(o.type)}</td><td><code>${n(o.branch)}</code></td>
        <td>${o.enabled?d("enabled"):d("disabled")}${o.environment==="test"?" "+d("test"):""}</td>
        <td>${a?i?`${n(i.operation)} ${H(i)}`:'<span class="muted">none</span>':d("unknown")}</td>
      </tr>`}).join("");b(`
    <h1>Applications</h1>
    <p class="sub">Registry source: <code>${n(e.source.repository)}</code> · <code>${n(e.source.path)}</code></p>
    ${e.applications.length?`<table><thead><tr><th>Application</th><th>Type</th><th>Branch</th><th>State</th><th>Latest operation</th></tr></thead><tbody>${s}</tbody></table>`:'<div class="empty">No applications registered yet. Add one under <a href="#/registry">Registry</a>.</div>'}`)}const W=[{op:"deploy",label:"Deploy (latest)",confirm:!0},{op:"build",label:"Build",confirm:!0},{op:"sync",label:"Sync only",confirm:!1},{op:"pm2.reconcile",label:"Reconcile PM2",confirm:!1,node:!0},{op:"pm2.restart",label:"Restart",confirm:!0,node:!0},{op:"pm2.stop",label:"Stop",confirm:!0,node:!0,danger:!0},{op:"health",label:"Health check",confirm:!1}];function A(e){return e?e.refused?` Restart refused: ${n(e.error&&e.error.code)}.`:e.skipped?` (${n(e.skipped)})`:` Restart requested — <a href="#/ops/${encodeURIComponent(e.operationId)}">follow it</a>.`:""}async function V(e){const t=document.getElementById("env-section"),a=document.getElementById("token-section"),s=e.application,o=async(r="")=>{let y;try{y=await c.appEnv(s)}catch(l){t.innerHTML=m(l);return}t.innerHTML=`${r}
      <p class="muted">Values are write-only: they are never shown again. The app loads this file at start (node --env-file).</p>
      <table><thead><tr><th>Name</th><th></th></tr></thead><tbody>
      ${y.keys.map(l=>`<tr><td><code>${n(l.name)}</code> ${l.managedByManage?d("ok","written by Manage"):""}</td><td>${l.managedByManage?"":`<button class="btn ghost" data-unset="${n(l.name)}">Remove</button>`}</td></tr>`).join("")||'<tr><td colspan="2" class="empty">No variables yet.</td></tr>'}
      </tbody></table>
      <form class="stack" id="env-form">
        <div class="row"><label>Name <input name="name" required pattern="[A-Z_][A-Z0-9_]*" placeholder="SITE_PASSWORD_HASH" /></label>
        <label>Value <input name="value" type="password" autocomplete="off" required /></label></div>
        <label class="row"><input type="checkbox" name="restart" checked /> Restart the app afterwards</label>
        <button class="btn primary" type="submit">Set variable</button>
      </form>`,t.querySelector("#env-form").addEventListener("submit",async l=>{l.preventDefault();const g=new FormData(l.target);try{const p=await c.setAppEnv(s,{set:{[String(g.get("name"))]:String(g.get("value"))},restart:g.get("restart")==="on"});o(`<div class="banner info">Saved ${n(g.get("name"))}.${A(p.restart)}</div>`)}catch(p){t.insertAdjacentHTML("afterbegin",m(p))}}),t.querySelectorAll("[data-unset]").forEach(l=>l.addEventListener("click",async()=>{if(window.confirm(`Remove ${l.dataset.unset} from ${s}.env and restart the app?`))try{const g=await c.setAppEnv(s,{unset:[l.dataset.unset],restart:!0});o(`<div class="banner info">Removed ${n(l.dataset.unset)}.${A(g.restart)}</div>`)}catch(g){t.insertAdjacentHTML("afterbegin",m(g))}}))},i=async(r="")=>{let y;try{y=await c.appToken(s)}catch(h){a.innerHTML=m(h);return}const l=y.client,g=l?l.scopes:y.suggestedScopes||[];a.innerHTML=`${r}
      ${l?`<dl class="kv"><dt>Client</dt><dd><code>${n(l.id)}</code> · issued ${v(l.issuedAt)}</dd>
        <dt>Endpoint base</dt><dd><code>${n(y.endpoints.base)}</code></dd>
        <dt>Resources</dt><dd>${[...y.endpoints.resources,...y.endpoints.collections].map(h=>`<code>${n(h.key)}</code> ${d(h.access==="read-write"?"ok":"unknown",h.access)}`).join("<br>")||"—"}</dd></dl>`:'<p class="muted">No token yet. Issuing one writes MANAGE_API_TOKEN and MANAGE_API_URL into this app’s env file.</p>'}
      <form class="stack" id="token-form">
        <label>Scopes (JSON: resource key or "prefix.*", access read/write)
          <textarea name="scopes" rows="5" spellcheck="false">${n(JSON.stringify(g,null,2))}</textarea></label>
        <label class="row"><input type="checkbox" name="restart" checked /> Restart the app afterwards</label>
        <div class="row"><button class="btn primary" type="submit">${l?"Rotate token (old one stops working)":"Issue token"}</button>
        ${l?'<button class="btn danger" type="button" id="revoke">Revoke</button>':""}</div>
      </form>`,a.querySelector("#token-form").addEventListener("submit",async h=>{h.preventDefault();const w=new FormData(h.target);let $;try{$=JSON.parse(String(w.get("scopes")))}catch{a.insertAdjacentHTML("afterbegin",'<div class="banner bad">Scopes are not valid JSON.</div>');return}try{const k=await c.issueAppToken(s,{scopes:$,restart:w.get("restart")==="on"});i(`<div class="banner info">Token written to <code>${n(k.writtenTo)}</code>.${A(k.restart)}
          <details><summary>Show token once (for use outside this server)</summary><code class="secret">${n(k.token)}</code></details></div>`),o()}catch(k){a.insertAdjacentHTML("afterbegin",m(k))}});const p=a.querySelector("#revoke");p&&p.addEventListener("click",async()=>{if(window.confirm(`Revoke ${s}'s Manage API token? The app loses data access.`))try{const h=await c.revokeAppToken(s);i(`<div class="banner warn">Token revoked.${A(h.restart)}</div>`),o()}catch(h){a.insertAdjacentHTML("afterbegin",m(h))}})};o(),i()}async function D(e){const[{entry:t,status:a},s]=await Promise.all([c.app(e),c.operations(e,15).catch(()=>null)]),o=a||{},i=o.declaration,r=o.unavailable?d("unknown","unknown (Argus unavailable)"):i==null?d("unknown","not checked (not deployed)"):i.error?d("error",i.error):i.match?d("match"):`${d("mismatch")} <span class="muted">Registry stays authoritative.</span>${T(i.mismatches)}`,y=o.unavailable||o.processes==null?`<p>${d("unknown")} <span class="muted">No runtime facts supplied.</span></p>`:o.processes.length===0?`<p>${d("off","no process")}</p>`:`<table><thead><tr><th>Process</th><th>Status</th><th>PID</th><th>Restarts</th><th>Revision</th></tr></thead><tbody>${o.processes.map(p=>`<tr><td>${n(p.name)}</td><td>${d(p.status)}</td><td>${n(p.pid??"—")}</td><td>${n(p.restarts)}</td><td><code>${n((p.revision||"—").slice(0,12))}</code></td></tr>`).join("")}</tbody></table>`,l=o.executable,g=W.filter(p=>!p.node||t.type==="node").map(p=>`<button class="btn ${p.danger?"danger":""}" data-op="${n(p.op)}" data-confirm="${p.confirm}" ${t.enabled?"":"disabled"}>${n(p.label)}</button>`).join("");b(`
    <h1>${n(t.application)}</h1>
    <p class="sub">${t.enabled?d("enabled"):d("disabled")} ${t.environment==="test"?d("test","test target"):""} ${t.autoDeploy===!1?d("pending","auto-deploy off"):d("ok","auto-deploy on")}</p>
    ${o.unavailable?`<div class="banner bad">Argus unavailable (${n(o.code)}) — runtime state unknown.</div>`:""}
    ${o.undeployedPush?`<div class="banner warn">Pushed but <strong>not deployed</strong> (auto-deploy is off): <code>${n(o.undeployedPush.commit.slice(0,12))}</code> · ${v(o.undeployedPush.at)}. Use <strong>Deploy (latest)</strong> to deploy it, or <strong>Restart</strong> to restart without deploying.</div>`:""}
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
      <div class="card"><h3>Last deployed</h3>${o.deployed?`<dl class="kv"><dt>Commit</dt><dd><code>${n(o.deployed.commit.slice(0,12))}</code></dd><dt>At</dt><dd>${v(o.deployed.at)}</dd><dt>Health</dt><dd>${o.deployed.healthy?d("ok","healthy"):d("failed","unhealthy")}</dd></dl>`:d("unknown","never deployed by Argus")}</div>
    </div>
    <h2>PM2 processes</h2>${t.type==="node"?y:'<p class="muted">Static application — no PM2 processes.</p>'}
    <h2>Actions</h2>
    <div class="actions">${g}
      <button class="btn ghost" id="toggle-enabled">${t.enabled?"Disable":"Enable"}</button>
      <button class="btn ghost" id="toggle-autodeploy">${t.autoDeploy===!1?"Turn auto-deploy on":"Turn auto-deploy off"}</button>
      <a class="btn ghost" href="#/registry/${encodeURIComponent(t.application)}/edit">Edit registry entry</a>
    </div>
    <div id="action-result"></div>
    <h2>Environment <span class="muted">/infrastructure/env/${n(t.application)}.env</span></h2>
    <div id="env-section"><p class="muted">Loading…</p></div>
    <h2>Manage API token</h2>
    <div id="token-section"><p class="muted">Loading…</p></div>
    <h2>Operations</h2>
    ${s?U(s.operations):'<div class="banner warn">History unavailable (Argus unreachable).</div>'}`),V(t),P.querySelectorAll("[data-op]").forEach(p=>p.addEventListener("click",async()=>{const h=p.dataset.op;if(p.dataset.confirm==="true"&&!window.confirm(`Request "${h}" for ${t.application}?`))return;const w=document.getElementById("action-result");try{const $=await c.submit(h,t.application);location.hash=`#/ops/${encodeURIComponent($.operationId)}`}catch($){w.innerHTML=m($)}})),document.getElementById("toggle-enabled").addEventListener("click",async()=>{if(!window.confirm(`${t.enabled?"Disable":"Enable"} ${t.application}? This commits to bmb-data.`))return;const p=document.getElementById("action-result");try{const h=await c.setEnabled(t.application,!t.enabled);p.innerHTML=L(h.persistence),setTimeout(()=>f(()=>D(e)),1200)}catch(h){p.innerHTML=m(h)}}),document.getElementById("toggle-autodeploy").addEventListener("click",async()=>{const p=t.autoDeploy===!1,h=p?`Turn auto-deploy ON for ${t.application}? Every push to ${t.branch} will deploy and restart it.`:`Turn auto-deploy OFF for ${t.application}? Pushes will only be recorded; you deploy/restart manually.`;if(!window.confirm(h))return;const w=document.getElementById("action-result");try{const $=await c.setAutoDeploy(t.application,p);w.innerHTML=L($.persistence),setTimeout(()=>f(()=>D(e)),1200)}catch($){w.innerHTML=m($)}})}function U(e){return e.length?`<table><thead><tr><th>Operation</th><th>Application</th><th>Status</th><th>Stage</th><th>Created</th><th>Finished</th></tr></thead><tbody>${e.map(t=>`<tr class="clickable" data-href="#/ops/${encodeURIComponent(t.operationId)}">
      <td><code>${n(t.operation)}</code></td><td>${n(t.application)}</td><td>${H(t)}</td>
      <td>${n(t.stage??"—")}</td><td>${v(t.createdAt)}</td><td>${v(t.finishedAt)}</td></tr>`).join("")}</tbody></table>`:'<div class="empty">No operations recorded yet.</div>'}async function Z(){const e=await c.operations(void 0,100);b(`<h1>Operations</h1><p class="sub">${n(e.total)} recorded. Accepted ≠ succeeded — open one to follow it.</p>${U(e.operations)}`)}async function z(e){const t=s=>`
    <h1>Operation <code>${n(s.operationId)}</code></h1>
    <div class="grid"><div class="card"><dl class="kv">
      <dt>Operation</dt><dd><code>${n(s.operation)}</code></dd>
      <dt>Application</dt><dd><a href="#/apps/${encodeURIComponent(s.application)}">${n(s.application)}</a></dd>
      <dt>Status</dt><dd>${H(s)}${C.has(s.status)?"":' <span class="muted">(live — refreshing)</span>'}</dd>
      <dt>Stage</dt><dd>${n(s.stage??"—")}</dd>
      <dt>Created</dt><dd>${v(s.createdAt)}</dd>
      <dt>Finished</dt><dd>${v(s.finishedAt)}</dd>
    </dl></div></div>
    ${s.error?`<h2>Failure</h2><div class="banner bad"><strong>${n(s.error.code)}</strong> — ${n(s.error.message)}</div>${s.error.details?T(s.error.details):""}`:""}
    <h2>Result</h2>${s.result?T(s.result):'<p class="muted">No result yet.</p>'}`,a=await c.operation(e);b(t(a)),C.has(a.status)||(S=setInterval(()=>f(async()=>{const s=await c.operation(e);b(t(s)),C.has(s.status)&&N()}),1500))}async function K(){const t=(await c.registry()).applications.filter(a=>a.type==="node");b(`
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
        <label>Type <code>${n(j)}</code> to confirm<input name="confirm" autocomplete="off" /></label>
        <button class="btn danger" type="submit">Reconcile all eligible</button>
      </form>
    </div>
    <div id="rec-result"></div>`),document.getElementById("one").addEventListener("submit",async a=>{a.preventDefault();const s=document.getElementById("rec-result");try{const o=await c.reconcileApp(new FormData(a.target).get("app"));location.hash=`#/ops/${encodeURIComponent(o.operationId)}`}catch(o){s.innerHTML=m(o)}}),document.getElementById("all").addEventListener("submit",async a=>{a.preventDefault();const s=document.getElementById("rec-result"),o=String(new FormData(a.target).get("confirm")||"");if(o!==j){s.innerHTML='<div class="banner warn">Confirmation phrase does not match.</div>';return}try{const i=await c.reconcileAll(o);s.innerHTML=`<h2>Results</h2><table><thead><tr><th>Application</th><th>Result</th></tr></thead><tbody>${[...i.results.map(r=>`<tr><td>${n(r.application)}</td><td>${r.refused?`${d("refused")} <code>${n(r.error.code)}</code> ${n(r.error.message)}`:`${d("accepted")} <a href="#/ops/${encodeURIComponent(r.operationId)}">${n(r.operationId)}</a>`}</td></tr>`),...i.skipped.map(r=>`<tr><td>${n(r.application)}</td><td>${d("skipped")} ${n(r.reason)}</td></tr>`)].join("")}</tbody></table>`}catch(i){s.innerHTML=m(i)}})}const Q=["application","repository","branch","type","deploymentPath","domain","isPrimaryDomain","pm2Config","nginxConfig","enabled","environment","webhookSecretRef"];function X(e={},t=!1){const a=s=>n(e[s]??"");return`<form class="stack" id="entry-form">
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
  </form><div id="form-result"></div>`}function Y(e){const t=new FormData(e),a={};for(const s of Q){if(s==="isPrimaryDomain"||s==="enabled"){a[s]=t.get(s)==="on";continue}const o=String(t.get(s)??"").trim();if(s==="pm2Config"||s==="nginxConfig"){a[s]=o===""?null:o;continue}if(s==="webhookSecretRef"){o&&(a[s]=o);continue}a[s]=o}return a}async function ee(e){const t=await c.registry(),a=e?t.applications.find(s=>s.application===e):null;b(`
    <h1>Registry</h1>
    <p class="sub">Authoritative deployment configuration, stored in <code>${n(t.source.repository)}</code>. Every change is a scoped commit + push.</p>
    <div class="actions"><button class="btn ghost" id="retry">Retry push</button></div>
    <div id="retry-result"></div>
    <h2>${a?`Edit ${n(a.application)}`:"Register an application"}</h2>
    ${X(a||{},!!a)}
    <h2>Registered</h2>
    ${t.applications.length?`<table><thead><tr><th>Application</th><th>Type</th><th>State</th><th></th></tr></thead><tbody>${t.applications.map(s=>`<tr><td>${n(s.application)}</td><td>${n(s.type)}</td><td>${s.enabled?d("enabled"):d("disabled")}${s.environment==="test"?" "+d("test"):""}</td><td><a href="#/registry/${encodeURIComponent(s.application)}/edit">edit</a></td></tr>`).join("")}</tbody></table>`:'<div class="empty">Nothing registered yet.</div>'}`),document.getElementById("entry-form").addEventListener("submit",async s=>{s.preventDefault();const o=document.getElementById("form-result"),i=Y(s.target);try{const r=a?await c.updateApp(a.application,i):await c.createApp(i);o.innerHTML=L(r.persistence)}catch(r){o.innerHTML=m(r)}}),document.getElementById("retry").addEventListener("click",async()=>{const s=document.getElementById("retry-result");try{s.innerHTML=L((await c.retryPush()).persistence)}catch(o){s.innerHTML=m(o)}})}const M=e=>e?`<code>${n(String(e).slice(0,12))}</code>`:"—";async function G(e){const[t,a,s]=await Promise.all([c.dataStatus(),c.dataResources(),c.dataOperations(30)]),o=t.repository,i=e?await c.dataCompare(e).catch(r=>({error:r})):null;b(`
    <h1>Canonical data</h1>
    ${o.blocked?`<div class="banner bad"><strong>${n(o.blocked)} blocked operation(s)</strong> — needs an explicit resolution.</div>`:""}
    ${o.pendingPush?`<div class="banner warn"><strong>${n(o.pendingPush)} change(s) committed but not pushed</strong> to bmb-data yet.</div>`:""}
    ${t.catalog.ok?"":`<div class="banner bad">Catalog invalid: ${n(t.catalog.error&&t.catalog.error.code)}</div>`}
    <section class="card"><h2>bmb-data checkout</h2><dl class="kv">
      <dt>Branch</dt><dd>${n(o.branch)}</dd>
      <dt>Local HEAD</dt><dd>${M(o.head)}</dd>
      <dt>Remote (last fetched)</dt><dd>${M(o.remote)} ${o.head&&o.head===o.remote?d("ok","in sync"):d("unknown","differs")}</dd>
      <dt>Working tree</dt><dd>${o.dirty===null?d("unknown"):o.dirty?d("blocked","dirty"):d("ok","clean")}</dd>
      <dt>Last webhook sync</dt><dd>${o.lastSync?`${d(o.lastSync.status)} ${n(o.lastSync.result?o.lastSync.result.state:"")} · ${v(o.lastSync.createdAt)}`:"—"}</dd>
      <dt>Catalog</dt><dd>${t.catalog.ok?`${n(t.catalog.resources)} resources · ${n(t.catalog.imported)} imported`:"—"}</dd>
    </dl></section>
    <section class="card"><h2>Resources</h2>
      <table><thead><tr><th>Key</th><th>Access</th><th>Status</th><th>Path</th><th>Source</th><th></th></tr></thead><tbody>
      ${a.resources.map(r=>`<tr><td><code>${n(r.key)}</code></td><td>${d(r.access==="private"?"blocked":"ok",r.access)}</td><td>${d(r.status==="imported"?"succeeded":"pending",r.status)}</td><td><code>${n(r.path)}</code></td><td>${r.source?`<code>${n(r.source.repository)}:${n(r.source.path)}</code>`:"—"}</td><td>${r.status==="imported"?`<a class="btn" href="#/data/res/${encodeURIComponent(r.key)}">Open</a> `:""}${r.source?`<a class="btn" href="#/data/compare/${encodeURIComponent(r.key)}">Compare</a>`:""}</td></tr>`).join("")||'<tr><td colspan="6" class="empty">No catalog yet.</td></tr>'}
      </tbody></table></section>
    ${i?`<section class="card"><h2>Comparison: <code>${n(e)}</code></h2>${i.error?m(i.error):`<p>${i.identical?d("ok","identical"):d("mismatch","differs")} · source ${n(i.source.count??"—")} · target ${n(i.target.present?i.target.count:"not imported")}</p>${T(i)}`}</section>`:""}
    <section class="card"><h2>Data operations</h2><div id="data-retry"></div>
      <table><thead><tr><th>When</th><th>Action</th><th>Resources</th><th>Status</th><th>Phase</th><th>Commit</th><th></th></tr></thead><tbody>
      ${s.operations.map(r=>`<tr><td>${v(r.createdAt)}</td><td>${n(r.action)}</td><td>${n((r.keys||[]).join(", ")||r.result&&r.result.state||"")}</td><td>${d(r.status)}</td><td>${n(r.phase||"—")}</td><td>${M(r.commit||r.result&&r.result.to)}</td><td>${["pending-push","failed","blocked"].includes(r.status)&&r.kind==="mutation"?`<button class="btn" data-retry="${n(r.operationId)}">Retry</button>`:""}</td></tr>`).join("")||'<tr><td colspan="7" class="empty">No data operations yet.</td></tr>'}
      </tbody></table></section>`),P.querySelectorAll("button[data-retry]").forEach(r=>r.addEventListener("click",async()=>{const y=document.getElementById("data-retry");try{const l=await c.dataRetry(r.dataset.retry);y.innerHTML=`<div class="banner ${l.status==="succeeded"?"info":"warn"}">${n(l.operationId)}: ${n(l.status)}</div>`,setTimeout(()=>f(()=>G(e)),800)}catch(l){y.innerHTML=m(l)}}))}async function F(e){const t=await c.dataResource(e);b(`
    <p><a href="#/data">← Data</a></p>
    <h1><code>${n(e)}</code></h1>
    <section class="card"><dl class="kv"><dt>Revision</dt><dd><code>${n(t.revision.slice(0,16))}</code></dd></dl>
      <form class="stack" id="res-form">
        <label>Document (JSON) <textarea name="doc" rows="22" spellcheck="false">${n(JSON.stringify(t.data,null,2))}</textarea></label>
        <button class="btn primary" type="submit">Save to bmb-data</button>
      </form>
      <div id="res-result"></div></section>`),document.getElementById("res-form").addEventListener("submit",async a=>{a.preventDefault();const s=document.getElementById("res-result");let o;try{o=JSON.parse(new FormData(a.target).get("doc"))}catch{s.innerHTML='<div class="banner bad">Not valid JSON — nothing was sent.</div>';return}try{const r=(await c.dataReplace(e,o,t.revision)).persistence;s.innerHTML=r.saved?`<div class="banner info">${r.status==="noop"?"No change.":"Saved, pushed and read back from bmb-data"} ${r.commit?`· <code>${n(r.commit.slice(0,12))}</code>`:""}</div>`:`<div class="banner warn">Committed locally but <strong>not pushed yet</strong> (${n(r.error&&r.error.code)}) — retry from the Data page.</div>`,r.saved&&setTimeout(()=>f(()=>F(e)),1200)}catch(i){s.innerHTML=m(i)}})}function B(){N();const t=location.hash.replace(/^#\/?/,"").split("/").map(decodeURIComponent);if(document.querySelectorAll("#nav a").forEach(a=>a.classList.toggle("active",a.dataset.route===(t[0]||"overview"))),b('<p class="muted">Loading…</p>'),!t[0])return f(x);if(t[0]==="apps")return f(()=>t[1]?D(t[1]):J());if(t[0]==="ops")return f(()=>t[1]?z(t[1]):Z());if(t[0]==="reconcile")return f(K);if(t[0]==="registry")return f(()=>ee(t[2]==="edit"?t[1]:null));if(t[0]==="data"&&t[1]==="res"&&t[2])return f(()=>F(t[2]));if(t[0]==="data")return f(()=>G(t[1]==="compare"?t[2]:null));b('<div class="empty">Not found.</div>')}P.addEventListener("click",e=>{const t=e.target.closest("tr[data-href]");t&&!e.target.closest("a,button")&&(location.hash=t.dataset.href)});document.getElementById("logout").addEventListener("click",async()=>{try{await c.logout()}finally{R()}});window.addEventListener("hashchange",B);(async()=>{try{if(!(await c.session()).authenticated)return R();if(q())return;O.classList.remove("hidden"),B()}catch{R("Manage API unreachable.")}})();
