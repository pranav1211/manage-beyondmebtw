(function(){const e=document.createElement("link").relList;if(e&&e.supports&&e.supports("modulepreload"))return;for(const o of document.querySelectorAll('link[rel="modulepreload"]'))s(o);new MutationObserver(o=>{for(const i of o)if(i.type==="childList")for(const d of i.addedNodes)d.tagName==="LINK"&&d.rel==="modulepreload"&&s(d)}).observe(document,{childList:!0,subtree:!0});function n(o){const i={};return o.integrity&&(i.integrity=o.integrity),o.referrerPolicy&&(i.referrerPolicy=o.referrerPolicy),o.crossOrigin==="use-credentials"?i.credentials="include":o.crossOrigin==="anonymous"?i.credentials="omit":i.credentials="same-origin",i}function s(o){if(o.ep)return;o.ep=!0;const i=n(o);fetch(o.href,i)}})();let $=null;class R extends Error{constructor(e,n){super(n&&n.message||`HTTP ${e}`),this.status=e,this.code=n&&n.code||"HTTP_ERROR",this.details=n&&n.details}}async function l(t,e,n){const s={accept:"application/json"};n!==void 0&&(s["content-type"]="application/json"),t!=="GET"&&$&&(s["x-csrf-token"]=$);const o=await fetch(`/api/v1${e}`,{method:t,headers:s,credentials:"same-origin",body:n!==void 0?JSON.stringify(n):void 0});let i=null;try{i=await o.json()}catch{}if(!o.ok)throw new R(o.status,i);return i}const c={async session(){const t=await l("GET","/auth/session");return $=t.authenticated?t.csrfToken:null,t},async login(t){const e=await l("POST","/auth/login",{password:t});return $=e.csrfToken,e},async logout(){await l("POST","/auth/logout",{}),$=null},status:()=>l("GET","/status"),registry:()=>l("GET","/registry"),app:t=>l("GET",`/registry/${encodeURIComponent(t)}`),createApp:t=>l("POST","/registry",t),updateApp:(t,e)=>l("PUT",`/registry/${encodeURIComponent(t)}`,e),setEnabled:(t,e)=>l("PATCH",`/registry/${encodeURIComponent(t)}/enabled`,{enabled:e}),retryPush:()=>l("POST","/registry/retry-push",{}),operations:(t,e=50)=>l("GET",`/operations?limit=${e}${t?`&application=${encodeURIComponent(t)}`:""}`),operation:t=>l("GET",`/operations/${encodeURIComponent(t)}`),submit:(t,e,n)=>l("POST","/operations",{operation:t,application:e,...n?{params:n}:{}}),reconcileApp:t=>l("POST",`/reconcile/${encodeURIComponent(t)}`,{}),reconcileAll:t=>l("POST","/reconcile",{confirm:t}),dataStatus:()=>l("GET","/data/status"),dataResources:()=>l("GET","/data/resources"),dataOperations:(t=30)=>l("GET",`/data/operations?limit=${t}`),dataRetry:t=>l("POST",`/data/operations/${encodeURIComponent(t)}/retry`,{}),dataCompare:t=>l("GET",`/data/resources/${encodeURIComponent(t)}/compare`),dataResource:t=>l("GET",`/data/resources/${encodeURIComponent(t)}`),dataReplace:(t,e,n)=>l("PUT",`/data/resources/${encodeURIComponent(t)}`,{data:e,ifRevision:n})},E=document.getElementById("view"),A=document.getElementById("topbar"),T=new Set(["succeeded","failed","blocked"]),D="RECONCILE ALL ELIGIBLE APPS";let k=null;const a=t=>String(t??"").replace(/[&<>"']/g,e=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[e]),r=(t,e)=>`<span class="badge s-${a(String(t).toLowerCase())}">${a(e??t)}</span>`,y=t=>t?new Date(t).toLocaleString():"—",f=t=>`<pre class="json">${a(JSON.stringify(t,null,2))}</pre>`,u=t=>{E.innerHTML=t};function P(t){return t.status==="succeeded"&&t.result&&t.result.noop?r("noop","no-op"):r(t.status)}function b(t){const e=t instanceof R?t.code:"ERROR",n=t instanceof R?t.message:"Unexpected error";return`<div class="banner bad"><strong>${a(e)}</strong> — ${a(n)}${t&&t.details?`<details><summary>details</summary>${f(t.details)}</details>`:""}</div>`}function L(t){return t?t.pending?`<div class="banner warn">Saved and committed on the server, but <strong>not pushed to bmb-data yet</strong> (${a(t.error&&t.error.code)}). Use “Retry push”.</div>`:`<div class="banner info">${t.committed?"Committed":"No content change"}${t.pushed?" and pushed to bmb-data":""}${t.commit?` · <code>${a(t.commit.slice(0,12))}</code>`:""}.</div>`:""}function C(){k&&clearInterval(k),k=null}async function h(t){try{await t()}catch(e){if(e instanceof R&&e.status===401)return v();u(b(e))}}function v(t){C(),A.classList.add("hidden"),u(`
    <section class="login card">
      <h1>Manage</h1>
      ${t?`<div class="banner bad">${a(t)}</div>`:""}
      <form class="stack" id="login-form">
        <label>Admin password <input type="password" name="password" autocomplete="current-password" required autofocus /></label>
        <button class="btn primary" type="submit">Sign in</button>
      </form>
    </section>`),document.getElementById("login-form").addEventListener("submit",async e=>{e.preventDefault();const n=new FormData(e.target).get("password");try{await c.login(String(n)),A.classList.remove("hidden"),M()}catch(s){v(s.code==="RATE_LIMITED"?"Too many attempts — wait and retry.":"Sign-in failed.")}})}async function G(){const[t,e]=await Promise.all([c.status(),c.operations(void 0,8).catch(()=>null)]),n=t.argus;u(`
    <h1>Overview</h1>
    ${n.reachable?"":`<div class="banner bad"><strong>Argus unavailable</strong> (${a(n.code)}). Operations cannot run until it is reachable.</div>`}
    ${t.registry.ok?"":`<div class="banner bad">Registry unreadable (${a(t.registry.code)}).</div>`}
    <div class="grid">
      <div class="card"><h3>Manage</h3><dl class="kv"><dt>Status</dt><dd>${r("ok")}</dd><dt>Env</dt><dd>${a(t.manage.env)}</dd></dl></div>
      <div class="card"><h3>Argus</h3><dl class="kv">
        <dt>Reachable</dt><dd>${n.reachable?r("ok","yes"):r("unavailable","no")}</dd>
        <dt>Mode</dt><dd>${n.reachable?a(n.mode):r("unknown")}</dd>
        <dt>Execution</dt><dd>${n.reachable?n.executionEnabled?r("ok","enabled"):r("disabled"):r("unknown")}</dd>
      </dl></div>
      <div class="card"><h3>Registry</h3><dl class="kv">
        <dt>Applications</dt><dd>${t.registry.ok?a(t.registry.applications):r("unknown")}</dd>
        <dt>Enabled</dt><dd>${t.registry.ok?a(t.registry.enabled):r("unknown")}</dd>
      </dl></div>
    </div>
    <h2>Recent operations</h2>
    ${e?O(e.operations):'<div class="banner warn">Operation history unavailable (Argus unreachable).</div>'}`)}function q(t){const e=new Map;for(const n of t)e.has(n.application)||e.set(n.application,n);return e}async function F(){const[t,e]=await Promise.all([c.registry(),c.operations(void 0,100).catch(()=>null)]),n=e?q(e.operations):null,s=t.applications.map(o=>{const i=n&&n.get(o.application);return`<tr class="clickable" data-href="#/apps/${encodeURIComponent(o.application)}">
        <td><strong>${a(o.application)}</strong></td>
        <td>${a(o.type)}</td><td><code>${a(o.branch)}</code></td>
        <td>${o.enabled?r("enabled"):r("disabled")}${o.environment==="test"?" "+r("test"):""}</td>
        <td>${n?i?`${a(i.operation)} ${P(i)}`:'<span class="muted">none</span>':r("unknown")}</td>
      </tr>`}).join("");u(`
    <h1>Applications</h1>
    <p class="sub">Registry source: <code>${a(t.source.repository)}</code> · <code>${a(t.source.path)}</code></p>
    ${t.applications.length?`<table><thead><tr><th>Application</th><th>Type</th><th>Branch</th><th>State</th><th>Latest operation</th></tr></thead><tbody>${s}</tbody></table>`:'<div class="empty">No applications registered yet. Add one under <a href="#/registry">Registry</a>.</div>'}`)}const J=[{op:"deploy",label:"Deploy (latest)",confirm:!0},{op:"build",label:"Build",confirm:!0},{op:"sync",label:"Sync only",confirm:!1},{op:"pm2.reconcile",label:"Reconcile PM2",confirm:!1,node:!0},{op:"pm2.restart",label:"Restart",confirm:!0,node:!0},{op:"pm2.stop",label:"Stop",confirm:!0,node:!0,danger:!0},{op:"health",label:"Health check",confirm:!1}];async function B(t){const[{entry:e,status:n},s]=await Promise.all([c.app(t),c.operations(t,15).catch(()=>null)]),o=n||{},i=o.declaration,d=o.unavailable?r("unknown","unknown (Argus unavailable)"):i==null?r("unknown","not checked (not deployed)"):i.error?r("error",i.error):i.match?r("match"):`${r("mismatch")} <span class="muted">Registry stays authoritative.</span>${f(i.mismatches)}`,w=o.unavailable||o.processes==null?`<p>${r("unknown")} <span class="muted">No runtime facts supplied.</span></p>`:o.processes.length===0?`<p>${r("off","no process")}</p>`:`<table><thead><tr><th>Process</th><th>Status</th><th>PID</th><th>Restarts</th><th>Revision</th></tr></thead><tbody>${o.processes.map(p=>`<tr><td>${a(p.name)}</td><td>${r(p.status)}</td><td>${a(p.pid??"—")}</td><td>${a(p.restarts)}</td><td><code>${a((p.revision||"—").slice(0,12))}</code></td></tr>`).join("")}</tbody></table>`,m=o.executable,U=J.filter(p=>!p.node||e.type==="node").map(p=>`<button class="btn ${p.danger?"danger":""}" data-op="${a(p.op)}" data-confirm="${p.confirm}" ${e.enabled?"":"disabled"}>${a(p.label)}</button>`).join("");u(`
    <h1>${a(e.application)}</h1>
    <p class="sub">${e.enabled?r("enabled"):r("disabled")} ${e.environment==="test"?r("test","test target"):""}</p>
    ${o.unavailable?`<div class="banner bad">Argus unavailable (${a(o.code)}) — runtime state unknown.</div>`:""}
    ${m&&!m.ok?`<div class="banner warn">Argus will refuse operations: <strong>${a(m.code)}</strong> — ${a(m.reason)}</div>`:""}
    <div class="grid">
      <div class="card"><h3>Registry (authoritative)</h3><dl class="kv">
        <dt>Repository</dt><dd><code>${a(e.repository)}</code></dd>
        <dt>Branch</dt><dd><code>${a(e.branch)}</code></dd>
        <dt>Type</dt><dd>${a(e.type)}</dd>
        <dt>Path</dt><dd><code>${a(e.deploymentPath)}</code></dd>
        <dt>Domain</dt><dd>${a(e.domain)}${e.isPrimaryDomain?" (primary)":""}</dd>
        <dt>PM2 config</dt><dd><code>${a(e.pm2Config??"—")}</code></dd>
        <dt>Nginx config</dt><dd><code>${a(e.nginxConfig??"—")}</code></dd>
      </dl></div>
      <div class="card"><h3>Repository declaration</h3>${d}</div>
      <div class="card"><h3>Last deployed</h3>${o.deployed?`<dl class="kv"><dt>Commit</dt><dd><code>${a(o.deployed.commit.slice(0,12))}</code></dd><dt>At</dt><dd>${y(o.deployed.at)}</dd><dt>Health</dt><dd>${o.deployed.healthy?r("ok","healthy"):r("failed","unhealthy")}</dd></dl>`:r("unknown","never deployed by Argus")}</div>
    </div>
    <h2>PM2 processes</h2>${e.type==="node"?w:'<p class="muted">Static application — no PM2 processes.</p>'}
    <h2>Actions</h2>
    <div class="actions">${U}
      <button class="btn ghost" id="toggle-enabled">${e.enabled?"Disable":"Enable"}</button>
      <a class="btn ghost" href="#/registry/${encodeURIComponent(e.application)}/edit">Edit registry entry</a>
    </div>
    <div id="action-result"></div>
    <h2>Operations</h2>
    ${s?O(s.operations):'<div class="banner warn">History unavailable (Argus unreachable).</div>'}`),E.querySelectorAll("[data-op]").forEach(p=>p.addEventListener("click",async()=>{const g=p.dataset.op;if(p.dataset.confirm==="true"&&!window.confirm(`Request "${g}" for ${e.application}?`))return;const j=document.getElementById("action-result");try{const S=await c.submit(g,e.application);location.hash=`#/ops/${encodeURIComponent(S.operationId)}`}catch(S){j.innerHTML=b(S)}})),document.getElementById("toggle-enabled").addEventListener("click",async()=>{if(!window.confirm(`${e.enabled?"Disable":"Enable"} ${e.application}? This commits to bmb-data.`))return;const p=document.getElementById("action-result");try{const g=await c.setEnabled(e.application,!e.enabled);p.innerHTML=L(g.persistence),setTimeout(()=>h(()=>B(t)),1200)}catch(g){p.innerHTML=b(g)}})}function O(t){return t.length?`<table><thead><tr><th>Operation</th><th>Application</th><th>Status</th><th>Stage</th><th>Created</th><th>Finished</th></tr></thead><tbody>${t.map(e=>`<tr class="clickable" data-href="#/ops/${encodeURIComponent(e.operationId)}">
      <td><code>${a(e.operation)}</code></td><td>${a(e.application)}</td><td>${P(e)}</td>
      <td>${a(e.stage??"—")}</td><td>${y(e.createdAt)}</td><td>${y(e.finishedAt)}</td></tr>`).join("")}</tbody></table>`:'<div class="empty">No operations recorded yet.</div>'}async function W(){const t=await c.operations(void 0,100);u(`<h1>Operations</h1><p class="sub">${a(t.total)} recorded. Accepted ≠ succeeded — open one to follow it.</p>${O(t.operations)}`)}async function _(t){const e=s=>`
    <h1>Operation <code>${a(s.operationId)}</code></h1>
    <div class="grid"><div class="card"><dl class="kv">
      <dt>Operation</dt><dd><code>${a(s.operation)}</code></dd>
      <dt>Application</dt><dd><a href="#/apps/${encodeURIComponent(s.application)}">${a(s.application)}</a></dd>
      <dt>Status</dt><dd>${P(s)}${T.has(s.status)?"":' <span class="muted">(live — refreshing)</span>'}</dd>
      <dt>Stage</dt><dd>${a(s.stage??"—")}</dd>
      <dt>Created</dt><dd>${y(s.createdAt)}</dd>
      <dt>Finished</dt><dd>${y(s.finishedAt)}</dd>
    </dl></div></div>
    ${s.error?`<h2>Failure</h2><div class="banner bad"><strong>${a(s.error.code)}</strong> — ${a(s.error.message)}</div>${s.error.details?f(s.error.details):""}`:""}
    <h2>Result</h2>${s.result?f(s.result):'<p class="muted">No result yet.</p>'}`,n=await c.operation(t);u(e(n)),T.has(n.status)||(k=setInterval(()=>h(async()=>{const s=await c.operation(t);u(e(s)),T.has(s.status)&&C()}),1500))}async function x(){const e=(await c.registry()).applications.filter(n=>n.type==="node");u(`
    <h1>PM2 reconciliation</h1>
    <p class="sub">Reconcile makes an application's PM2 processes match its Argus-generated config. Unregistered processes are reported, never touched.</p>
    <div class="card"><h3>One application</h3>
      <form class="row" id="one">
        <select name="app" required>${e.map(n=>`<option value="${a(n.application)}" ${n.enabled?"":"disabled"}>${a(n.application)}${n.enabled?"":" (disabled)"}</option>`).join("")}</select>
        <button class="btn" type="submit" ${e.length?"":"disabled"}>Reconcile</button>
      </form></div>
    <h2>All eligible applications</h2>
    <div class="card">
      <p class="muted">Eligible = enabled, node, not a test entry. Argus additionally refuses anything outside its production allowlist. Each application gets an independent result.</p>
      <form class="stack" id="all">
        <label>Type <code>${a(D)}</code> to confirm<input name="confirm" autocomplete="off" /></label>
        <button class="btn danger" type="submit">Reconcile all eligible</button>
      </form>
    </div>
    <div id="rec-result"></div>`),document.getElementById("one").addEventListener("submit",async n=>{n.preventDefault();const s=document.getElementById("rec-result");try{const o=await c.reconcileApp(new FormData(n.target).get("app"));location.hash=`#/ops/${encodeURIComponent(o.operationId)}`}catch(o){s.innerHTML=b(o)}}),document.getElementById("all").addEventListener("submit",async n=>{n.preventDefault();const s=document.getElementById("rec-result"),o=String(new FormData(n.target).get("confirm")||"");if(o!==D){s.innerHTML='<div class="banner warn">Confirmation phrase does not match.</div>';return}try{const i=await c.reconcileAll(o);s.innerHTML=`<h2>Results</h2><table><thead><tr><th>Application</th><th>Result</th></tr></thead><tbody>${[...i.results.map(d=>`<tr><td>${a(d.application)}</td><td>${d.refused?`${r("refused")} <code>${a(d.error.code)}</code> ${a(d.error.message)}`:`${r("accepted")} <a href="#/ops/${encodeURIComponent(d.operationId)}">${a(d.operationId)}</a>`}</td></tr>`),...i.skipped.map(d=>`<tr><td>${a(d.application)}</td><td>${r("skipped")} ${a(d.reason)}</td></tr>`)].join("")}</tbody></table>`}catch(i){s.innerHTML=b(i)}})}const V=["application","repository","branch","type","deploymentPath","domain","isPrimaryDomain","pm2Config","nginxConfig","enabled","environment","webhookSecretRef"];function z(t={},e=!1){const n=s=>a(t[s]??"");return`<form class="stack" id="entry-form">
    <label>Application (repository name)<input name="application" value="${n("application")}" ${e?"readonly":"required"} /></label>
    <label>Repository (SSH)<input name="repository" value="${n("repository")}" placeholder="git@github.com:owner/repo.git" required /></label>
    <label>Branch<input name="branch" value="${a(t.branch??"main")}" required /></label>
    <label>Type<select name="type"><option value="node" ${t.type==="node"?"selected":""}>node</option><option value="static" ${t.type==="static"?"selected":""}>static</option></select></label>
    <label>Deployment path<input name="deploymentPath" value="${n("deploymentPath")}" placeholder="/projects/&lt;application&gt;" required /></label>
    <label>Domain<input name="domain" value="${n("domain")}" required /></label>
    <label class="check"><input type="checkbox" name="isPrimaryDomain" ${t.isPrimaryDomain?"checked":""} /> Primary domain</label>
    <label>PM2 config file (node only)<input name="pm2Config" value="${n("pm2Config")}" placeholder="&lt;application&gt;.config.js" /></label>
    <label>Nginx config file (optional)<input name="nginxConfig" value="${n("nginxConfig")}" /></label>
    <label>Environment<select name="environment"><option value="production" ${t.environment!=="test"?"selected":""}>production</option><option value="test" ${t.environment==="test"?"selected":""}>test (never executed in production mode)</option></select></label>
    <label>Webhook secret ref (env var NAME, optional)<input name="webhookSecretRef" value="${n("webhookSecretRef")}" /></label>
    <label class="check"><input type="checkbox" name="enabled" ${t.enabled?"checked":""} /> Enabled</label>
    <div class="actions"><button class="btn primary" type="submit">${e?"Save changes":"Register application"}</button></div>
  </form><div id="form-result"></div>`}function Q(t){const e=new FormData(t),n={};for(const s of V){if(s==="isPrimaryDomain"||s==="enabled"){n[s]=e.get(s)==="on";continue}const o=String(e.get(s)??"").trim();if(s==="pm2Config"||s==="nginxConfig"){n[s]=o===""?null:o;continue}if(s==="webhookSecretRef"){o&&(n[s]=o);continue}n[s]=o}return n}async function X(t){const e=await c.registry(),n=t?e.applications.find(s=>s.application===t):null;u(`
    <h1>Registry</h1>
    <p class="sub">Authoritative deployment configuration, stored in <code>${a(e.source.repository)}</code>. Every change is a scoped commit + push.</p>
    <div class="actions"><button class="btn ghost" id="retry">Retry push</button></div>
    <div id="retry-result"></div>
    <h2>${n?`Edit ${a(n.application)}`:"Register an application"}</h2>
    ${z(n||{},!!n)}
    <h2>Registered</h2>
    ${e.applications.length?`<table><thead><tr><th>Application</th><th>Type</th><th>State</th><th></th></tr></thead><tbody>${e.applications.map(s=>`<tr><td>${a(s.application)}</td><td>${a(s.type)}</td><td>${s.enabled?r("enabled"):r("disabled")}${s.environment==="test"?" "+r("test"):""}</td><td><a href="#/registry/${encodeURIComponent(s.application)}/edit">edit</a></td></tr>`).join("")}</tbody></table>`:'<div class="empty">Nothing registered yet.</div>'}`),document.getElementById("entry-form").addEventListener("submit",async s=>{s.preventDefault();const o=document.getElementById("form-result"),i=Q(s.target);try{const d=n?await c.updateApp(n.application,i):await c.createApp(i);o.innerHTML=L(d.persistence)}catch(d){o.innerHTML=b(d)}}),document.getElementById("retry").addEventListener("click",async()=>{const s=document.getElementById("retry-result");try{s.innerHTML=L((await c.retryPush()).persistence)}catch(o){s.innerHTML=b(o)}})}const I=t=>t?`<code>${a(String(t).slice(0,12))}</code>`:"—";async function N(t){const[e,n,s]=await Promise.all([c.dataStatus(),c.dataResources(),c.dataOperations(30)]),o=e.repository,i=t?await c.dataCompare(t).catch(d=>({error:d})):null;u(`
    <h1>Canonical data</h1>
    ${o.blocked?`<div class="banner bad"><strong>${a(o.blocked)} blocked operation(s)</strong> — needs an explicit resolution.</div>`:""}
    ${o.pendingPush?`<div class="banner warn"><strong>${a(o.pendingPush)} change(s) committed but not pushed</strong> to bmb-data yet.</div>`:""}
    ${e.catalog.ok?"":`<div class="banner bad">Catalog invalid: ${a(e.catalog.error&&e.catalog.error.code)}</div>`}
    <section class="card"><h2>bmb-data checkout</h2><dl class="kv">
      <dt>Branch</dt><dd>${a(o.branch)}</dd>
      <dt>Local HEAD</dt><dd>${I(o.head)}</dd>
      <dt>Remote (last fetched)</dt><dd>${I(o.remote)} ${o.head&&o.head===o.remote?r("ok","in sync"):r("unknown","differs")}</dd>
      <dt>Working tree</dt><dd>${o.dirty===null?r("unknown"):o.dirty?r("blocked","dirty"):r("ok","clean")}</dd>
      <dt>Last webhook sync</dt><dd>${o.lastSync?`${r(o.lastSync.status)} ${a(o.lastSync.result?o.lastSync.result.state:"")} · ${y(o.lastSync.createdAt)}`:"—"}</dd>
      <dt>Catalog</dt><dd>${e.catalog.ok?`${a(e.catalog.resources)} resources · ${a(e.catalog.imported)} imported`:"—"}</dd>
    </dl></section>
    <section class="card"><h2>Resources</h2>
      <table><thead><tr><th>Key</th><th>Access</th><th>Status</th><th>Path</th><th>Source</th><th></th></tr></thead><tbody>
      ${n.resources.map(d=>`<tr><td><code>${a(d.key)}</code></td><td>${r(d.access==="private"?"blocked":"ok",d.access)}</td><td>${r(d.status==="imported"?"succeeded":"pending",d.status)}</td><td><code>${a(d.path)}</code></td><td>${d.source?`<code>${a(d.source.repository)}:${a(d.source.path)}</code>`:"—"}</td><td>${d.status==="imported"?`<a class="btn" href="#/data/res/${encodeURIComponent(d.key)}">Open</a> `:""}${d.source?`<a class="btn" href="#/data/compare/${encodeURIComponent(d.key)}">Compare</a>`:""}</td></tr>`).join("")||'<tr><td colspan="6" class="empty">No catalog yet.</td></tr>'}
      </tbody></table></section>
    ${i?`<section class="card"><h2>Comparison: <code>${a(t)}</code></h2>${i.error?b(i.error):`<p>${i.identical?r("ok","identical"):r("mismatch","differs")} · source ${a(i.source.count??"—")} · target ${a(i.target.present?i.target.count:"not imported")}</p>${f(i)}`}</section>`:""}
    <section class="card"><h2>Data operations</h2><div id="data-retry"></div>
      <table><thead><tr><th>When</th><th>Action</th><th>Resources</th><th>Status</th><th>Phase</th><th>Commit</th><th></th></tr></thead><tbody>
      ${s.operations.map(d=>`<tr><td>${y(d.createdAt)}</td><td>${a(d.action)}</td><td>${a((d.keys||[]).join(", ")||d.result&&d.result.state||"")}</td><td>${r(d.status)}</td><td>${a(d.phase||"—")}</td><td>${I(d.commit||d.result&&d.result.to)}</td><td>${["pending-push","failed","blocked"].includes(d.status)&&d.kind==="mutation"?`<button class="btn" data-retry="${a(d.operationId)}">Retry</button>`:""}</td></tr>`).join("")||'<tr><td colspan="7" class="empty">No data operations yet.</td></tr>'}
      </tbody></table></section>`),E.querySelectorAll("button[data-retry]").forEach(d=>d.addEventListener("click",async()=>{const w=document.getElementById("data-retry");try{const m=await c.dataRetry(d.dataset.retry);w.innerHTML=`<div class="banner ${m.status==="succeeded"?"info":"warn"}">${a(m.operationId)}: ${a(m.status)}</div>`,setTimeout(()=>h(()=>N(t)),800)}catch(m){w.innerHTML=b(m)}}))}async function H(t){const e=await c.dataResource(t);u(`
    <p><a href="#/data">← Data</a></p>
    <h1><code>${a(t)}</code></h1>
    <section class="card"><dl class="kv"><dt>Revision</dt><dd><code>${a(e.revision.slice(0,16))}</code></dd></dl>
      <form class="stack" id="res-form">
        <label>Document (JSON) <textarea name="doc" rows="22" spellcheck="false">${a(JSON.stringify(e.data,null,2))}</textarea></label>
        <button class="btn primary" type="submit">Save to bmb-data</button>
      </form>
      <div id="res-result"></div></section>`),document.getElementById("res-form").addEventListener("submit",async n=>{n.preventDefault();const s=document.getElementById("res-result");let o;try{o=JSON.parse(new FormData(n.target).get("doc"))}catch{s.innerHTML='<div class="banner bad">Not valid JSON — nothing was sent.</div>';return}try{const d=(await c.dataReplace(t,o,e.revision)).persistence;s.innerHTML=d.saved?`<div class="banner info">${d.status==="noop"?"No change.":"Saved, pushed and read back from bmb-data"} ${d.commit?`· <code>${a(d.commit.slice(0,12))}</code>`:""}</div>`:`<div class="banner warn">Committed locally but <strong>not pushed yet</strong> (${a(d.error&&d.error.code)}) — retry from the Data page.</div>`,d.saved&&setTimeout(()=>h(()=>H(t)),1200)}catch(i){s.innerHTML=b(i)}})}function M(){C();const e=location.hash.replace(/^#\/?/,"").split("/").map(decodeURIComponent);if(document.querySelectorAll("#nav a").forEach(n=>n.classList.toggle("active",n.dataset.route===(e[0]||"overview"))),u('<p class="muted">Loading…</p>'),!e[0])return h(G);if(e[0]==="apps")return h(()=>e[1]?B(e[1]):F());if(e[0]==="ops")return h(()=>e[1]?_(e[1]):W());if(e[0]==="reconcile")return h(x);if(e[0]==="registry")return h(()=>X(e[2]==="edit"?e[1]:null));if(e[0]==="data"&&e[1]==="res"&&e[2])return h(()=>H(e[2]));if(e[0]==="data")return h(()=>N(e[1]==="compare"?e[2]:null));u('<div class="empty">Not found.</div>')}E.addEventListener("click",t=>{const e=t.target.closest("tr[data-href]");e&&!t.target.closest("a,button")&&(location.hash=e.dataset.href)});document.getElementById("logout").addEventListener("click",async()=>{try{await c.logout()}finally{v()}});window.addEventListener("hashchange",M);(async()=>{try{if(!(await c.session()).authenticated)return v();A.classList.remove("hidden"),M()}catch{v("Manage API unreachable.")}})();
