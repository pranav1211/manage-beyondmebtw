(function(){const t=document.createElement("link").relList;if(t&&t.supports&&t.supports("modulepreload"))return;for(const i of document.querySelectorAll('link[rel="modulepreload"]'))a(i);new MutationObserver(i=>{for(const r of i)if(r.type==="childList")for(const c of r.addedNodes)c.tagName==="LINK"&&c.rel==="modulepreload"&&a(c)}).observe(document,{childList:!0,subtree:!0});function n(i){const r={};return i.integrity&&(r.integrity=i.integrity),i.referrerPolicy&&(r.referrerPolicy=i.referrerPolicy),i.crossOrigin==="use-credentials"?r.credentials="include":i.crossOrigin==="anonymous"?r.credentials="omit":r.credentials="same-origin",r}function a(i){if(i.ep)return;i.ep=!0;const r=n(i);fetch(i.href,r)}})();let b=null;class w extends Error{constructor(t,n){super(n&&n.message||`HTTP ${t}`),this.status=t,this.code=n&&n.code||"HTTP_ERROR",this.details=n&&n.details}}async function p(e,t,n){const a={accept:"application/json"};n!==void 0&&(a["content-type"]="application/json"),e!=="GET"&&b&&(a["x-csrf-token"]=b);const i=await fetch(`/api/v1${t}`,{method:e,headers:a,credentials:"same-origin",body:n!==void 0?JSON.stringify(n):void 0});let r=null;try{r=await i.json()}catch{}if(!i.ok)throw new w(i.status,r);return r}const d={async session(){const e=await p("GET","/auth/session");return b=e.authenticated?e.csrfToken:null,e},async login(e){const t=await p("POST","/auth/login",{password:e});return b=t.csrfToken,t},async logout(){await p("POST","/auth/logout",{}),b=null},status:()=>p("GET","/status"),registry:()=>p("GET","/registry"),app:e=>p("GET",`/registry/${encodeURIComponent(e)}`),createApp:e=>p("POST","/registry",e),updateApp:(e,t)=>p("PUT",`/registry/${encodeURIComponent(e)}`,t),setEnabled:(e,t)=>p("PATCH",`/registry/${encodeURIComponent(e)}/enabled`,{enabled:t}),retryPush:()=>p("POST","/registry/retry-push",{}),operations:(e,t=50)=>p("GET",`/operations?limit=${t}${e?`&application=${encodeURIComponent(e)}`:""}`),operation:e=>p("GET",`/operations/${encodeURIComponent(e)}`),submit:(e,t,n)=>p("POST","/operations",{operation:e,application:t,...n?{params:n}:{}}),reconcileApp:e=>p("POST",`/reconcile/${encodeURIComponent(e)}`,{}),reconcileAll:e=>p("POST","/reconcile",{confirm:e})},T=document.getElementById("view"),A=document.getElementById("topbar"),k=new Set(["succeeded","failed","blocked"]),O="RECONCILE ALL ELIGIBLE APPS";let v=null;const o=e=>String(e??"").replace(/[&<>"']/g,t=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[t]),s=(e,t)=>`<span class="badge s-${o(String(e).toLowerCase())}">${o(t??e)}</span>`,y=e=>e?new Date(e).toLocaleString():"—",E=e=>`<pre class="json">${o(JSON.stringify(e,null,2))}</pre>`,u=e=>{T.innerHTML=e};function L(e){return e.status==="succeeded"&&e.result&&e.result.noop?s("noop","no-op"):s(e.status)}function m(e){const t=e instanceof w?e.code:"ERROR",n=e instanceof w?e.message:"Unexpected error";return`<div class="banner bad"><strong>${o(t)}</strong> — ${o(n)}${e&&e.details?`<details><summary>details</summary>${E(e.details)}</details>`:""}</div>`}function I(e){return e?e.pending?`<div class="banner warn">Saved and committed on the server, but <strong>not pushed to bmb-data yet</strong> (${o(e.error&&e.error.code)}). Use “Retry push”.</div>`:`<div class="banner info">${e.committed?"Committed":"No content change"}${e.pushed?" and pushed to bmb-data":""}${e.commit?` · <code>${o(e.commit.slice(0,12))}</code>`:""}.</div>`:""}function P(){v&&clearInterval(v),v=null}async function h(e){try{await e()}catch(t){if(t instanceof w&&t.status===401)return f();u(m(t))}}function f(e){P(),A.classList.add("hidden"),u(`
    <section class="login card">
      <h1>Manage</h1>
      ${e?`<div class="banner bad">${o(e)}</div>`:""}
      <form class="stack" id="login-form">
        <label>Admin password <input type="password" name="password" autocomplete="current-password" required autofocus /></label>
        <button class="btn primary" type="submit">Sign in</button>
      </form>
    </section>`),document.getElementById("login-form").addEventListener("submit",async t=>{t.preventDefault();const n=new FormData(t.target).get("password");try{await d.login(String(n)),A.classList.remove("hidden"),C()}catch(a){f(a.code==="RATE_LIMITED"?"Too many attempts — wait and retry.":"Sign-in failed.")}})}async function N(){const[e,t]=await Promise.all([d.status(),d.operations(void 0,8).catch(()=>null)]),n=e.argus;u(`
    <h1>Overview</h1>
    ${n.reachable?"":`<div class="banner bad"><strong>Argus unavailable</strong> (${o(n.code)}). Operations cannot run until it is reachable.</div>`}
    ${e.registry.ok?"":`<div class="banner bad">Registry unreadable (${o(e.registry.code)}).</div>`}
    <div class="grid">
      <div class="card"><h3>Manage</h3><dl class="kv"><dt>Status</dt><dd>${s("ok")}</dd><dt>Env</dt><dd>${o(e.manage.env)}</dd></dl></div>
      <div class="card"><h3>Argus</h3><dl class="kv">
        <dt>Reachable</dt><dd>${n.reachable?s("ok","yes"):s("unavailable","no")}</dd>
        <dt>Mode</dt><dd>${n.reachable?o(n.mode):s("unknown")}</dd>
        <dt>Execution</dt><dd>${n.reachable?n.executionEnabled?s("ok","enabled"):s("disabled"):s("unknown")}</dd>
      </dl></div>
      <div class="card"><h3>Registry</h3><dl class="kv">
        <dt>Applications</dt><dd>${e.registry.ok?o(e.registry.applications):s("unknown")}</dd>
        <dt>Enabled</dt><dd>${e.registry.ok?o(e.registry.enabled):s("unknown")}</dd>
      </dl></div>
    </div>
    <h2>Recent operations</h2>
    ${t?S(t.operations):'<div class="banner warn">Operation history unavailable (Argus unreachable).</div>'}`)}function U(e){const t=new Map;for(const n of e)t.has(n.application)||t.set(n.application,n);return t}async function j(){const[e,t]=await Promise.all([d.registry(),d.operations(void 0,100).catch(()=>null)]),n=t?U(t.operations):null,a=e.applications.map(i=>{const r=n&&n.get(i.application);return`<tr class="clickable" data-href="#/apps/${encodeURIComponent(i.application)}">
        <td><strong>${o(i.application)}</strong></td>
        <td>${o(i.type)}</td><td><code>${o(i.branch)}</code></td>
        <td>${i.enabled?s("enabled"):s("disabled")}${i.environment==="test"?" "+s("test"):""}</td>
        <td>${n?r?`${o(r.operation)} ${L(r)}`:'<span class="muted">none</span>':s("unknown")}</td>
      </tr>`}).join("");u(`
    <h1>Applications</h1>
    <p class="sub">Registry source: <code>${o(e.source.repository)}</code> · <code>${o(e.source.path)}</code></p>
    ${e.applications.length?`<table><thead><tr><th>Application</th><th>Type</th><th>Branch</th><th>State</th><th>Latest operation</th></tr></thead><tbody>${a}</tbody></table>`:'<div class="empty">No applications registered yet. Add one under <a href="#/registry">Registry</a>.</div>'}`)}const q=[{op:"deploy",label:"Deploy (latest)",confirm:!0},{op:"build",label:"Build",confirm:!0},{op:"sync",label:"Sync only",confirm:!1},{op:"pm2.reconcile",label:"Reconcile PM2",confirm:!1,node:!0},{op:"pm2.restart",label:"Restart",confirm:!0,node:!0},{op:"pm2.stop",label:"Stop",confirm:!0,node:!0,danger:!0},{op:"health",label:"Health check",confirm:!1}];async function M(e){const[{entry:t,status:n},a]=await Promise.all([d.app(e),d.operations(e,15).catch(()=>null)]),i=n||{},r=i.declaration,c=i.unavailable?s("unknown","unknown (Argus unavailable)"):r==null?s("unknown","not checked (not deployed)"):r.error?s("error",r.error):r.match?s("match"):`${s("mismatch")} <span class="muted">Registry stays authoritative.</span>${E(r.mismatches)}`,D=i.unavailable||i.processes==null?`<p>${s("unknown")} <span class="muted">No runtime facts supplied.</span></p>`:i.processes.length===0?`<p>${s("off","no process")}</p>`:`<table><thead><tr><th>Process</th><th>Status</th><th>PID</th><th>Restarts</th><th>Revision</th></tr></thead><tbody>${i.processes.map(l=>`<tr><td>${o(l.name)}</td><td>${s(l.status)}</td><td>${o(l.pid??"—")}</td><td>${o(l.restarts)}</td><td><code>${o((l.revision||"—").slice(0,12))}</code></td></tr>`).join("")}</tbody></table>`,$=i.executable,B=q.filter(l=>!l.node||t.type==="node").map(l=>`<button class="btn ${l.danger?"danger":""}" data-op="${o(l.op)}" data-confirm="${l.confirm}" ${t.enabled?"":"disabled"}>${o(l.label)}</button>`).join("");u(`
    <h1>${o(t.application)}</h1>
    <p class="sub">${t.enabled?s("enabled"):s("disabled")} ${t.environment==="test"?s("test","test target"):""}</p>
    ${i.unavailable?`<div class="banner bad">Argus unavailable (${o(i.code)}) — runtime state unknown.</div>`:""}
    ${$&&!$.ok?`<div class="banner warn">Argus will refuse operations: <strong>${o($.code)}</strong> — ${o($.reason)}</div>`:""}
    <div class="grid">
      <div class="card"><h3>Registry (authoritative)</h3><dl class="kv">
        <dt>Repository</dt><dd><code>${o(t.repository)}</code></dd>
        <dt>Branch</dt><dd><code>${o(t.branch)}</code></dd>
        <dt>Type</dt><dd>${o(t.type)}</dd>
        <dt>Path</dt><dd><code>${o(t.deploymentPath)}</code></dd>
        <dt>Domain</dt><dd>${o(t.domain)}${t.isPrimaryDomain?" (primary)":""}</dd>
        <dt>PM2 config</dt><dd><code>${o(t.pm2Config??"—")}</code></dd>
        <dt>Nginx config</dt><dd><code>${o(t.nginxConfig??"—")}</code></dd>
      </dl></div>
      <div class="card"><h3>Repository declaration</h3>${c}</div>
      <div class="card"><h3>Last deployed</h3>${i.deployed?`<dl class="kv"><dt>Commit</dt><dd><code>${o(i.deployed.commit.slice(0,12))}</code></dd><dt>At</dt><dd>${y(i.deployed.at)}</dd><dt>Health</dt><dd>${i.deployed.healthy?s("ok","healthy"):s("failed","unhealthy")}</dd></dl>`:s("unknown","never deployed by Argus")}</div>
    </div>
    <h2>PM2 processes</h2>${t.type==="node"?D:'<p class="muted">Static application — no PM2 processes.</p>'}
    <h2>Actions</h2>
    <div class="actions">${B}
      <button class="btn ghost" id="toggle-enabled">${t.enabled?"Disable":"Enable"}</button>
      <a class="btn ghost" href="#/registry/${encodeURIComponent(t.application)}/edit">Edit registry entry</a>
    </div>
    <div id="action-result"></div>
    <h2>Operations</h2>
    ${a?S(a.operations):'<div class="banner warn">History unavailable (Argus unreachable).</div>'}`),T.querySelectorAll("[data-op]").forEach(l=>l.addEventListener("click",async()=>{const g=l.dataset.op;if(l.dataset.confirm==="true"&&!window.confirm(`Request "${g}" for ${t.application}?`))return;const H=document.getElementById("action-result");try{const R=await d.submit(g,t.application);location.hash=`#/ops/${encodeURIComponent(R.operationId)}`}catch(R){H.innerHTML=m(R)}})),document.getElementById("toggle-enabled").addEventListener("click",async()=>{if(!window.confirm(`${t.enabled?"Disable":"Enable"} ${t.application}? This commits to bmb-data.`))return;const l=document.getElementById("action-result");try{const g=await d.setEnabled(t.application,!t.enabled);l.innerHTML=I(g.persistence),setTimeout(()=>h(()=>M(e)),1200)}catch(g){l.innerHTML=m(g)}})}function S(e){return e.length?`<table><thead><tr><th>Operation</th><th>Application</th><th>Status</th><th>Stage</th><th>Created</th><th>Finished</th></tr></thead><tbody>${e.map(t=>`<tr class="clickable" data-href="#/ops/${encodeURIComponent(t.operationId)}">
      <td><code>${o(t.operation)}</code></td><td>${o(t.application)}</td><td>${L(t)}</td>
      <td>${o(t.stage??"—")}</td><td>${y(t.createdAt)}</td><td>${y(t.finishedAt)}</td></tr>`).join("")}</tbody></table>`:'<div class="empty">No operations recorded yet.</div>'}async function F(){const e=await d.operations(void 0,100);u(`<h1>Operations</h1><p class="sub">${o(e.total)} recorded. Accepted ≠ succeeded — open one to follow it.</p>${S(e.operations)}`)}async function x(e){const t=a=>`
    <h1>Operation <code>${o(a.operationId)}</code></h1>
    <div class="grid"><div class="card"><dl class="kv">
      <dt>Operation</dt><dd><code>${o(a.operation)}</code></dd>
      <dt>Application</dt><dd><a href="#/apps/${encodeURIComponent(a.application)}">${o(a.application)}</a></dd>
      <dt>Status</dt><dd>${L(a)}${k.has(a.status)?"":' <span class="muted">(live — refreshing)</span>'}</dd>
      <dt>Stage</dt><dd>${o(a.stage??"—")}</dd>
      <dt>Created</dt><dd>${y(a.createdAt)}</dd>
      <dt>Finished</dt><dd>${y(a.finishedAt)}</dd>
    </dl></div></div>
    ${a.error?`<h2>Failure</h2><div class="banner bad"><strong>${o(a.error.code)}</strong> — ${o(a.error.message)}</div>${a.error.details?E(a.error.details):""}`:""}
    <h2>Result</h2>${a.result?E(a.result):'<p class="muted">No result yet.</p>'}`,n=await d.operation(e);u(t(n)),k.has(n.status)||(v=setInterval(()=>h(async()=>{const a=await d.operation(e);u(t(a)),k.has(a.status)&&P()}),1500))}async function G(){const t=(await d.registry()).applications.filter(n=>n.type==="node");u(`
    <h1>PM2 reconciliation</h1>
    <p class="sub">Reconcile makes an application's PM2 processes match its Argus-generated config. Unregistered processes are reported, never touched.</p>
    <div class="card"><h3>One application</h3>
      <form class="row" id="one">
        <select name="app" required>${t.map(n=>`<option value="${o(n.application)}" ${n.enabled?"":"disabled"}>${o(n.application)}${n.enabled?"":" (disabled)"}</option>`).join("")}</select>
        <button class="btn" type="submit" ${t.length?"":"disabled"}>Reconcile</button>
      </form></div>
    <h2>All eligible applications</h2>
    <div class="card">
      <p class="muted">Eligible = enabled, node, not a test entry. Argus additionally refuses anything outside its production allowlist. Each application gets an independent result.</p>
      <form class="stack" id="all">
        <label>Type <code>${o(O)}</code> to confirm<input name="confirm" autocomplete="off" /></label>
        <button class="btn danger" type="submit">Reconcile all eligible</button>
      </form>
    </div>
    <div id="rec-result"></div>`),document.getElementById("one").addEventListener("submit",async n=>{n.preventDefault();const a=document.getElementById("rec-result");try{const i=await d.reconcileApp(new FormData(n.target).get("app"));location.hash=`#/ops/${encodeURIComponent(i.operationId)}`}catch(i){a.innerHTML=m(i)}}),document.getElementById("all").addEventListener("submit",async n=>{n.preventDefault();const a=document.getElementById("rec-result"),i=String(new FormData(n.target).get("confirm")||"");if(i!==O){a.innerHTML='<div class="banner warn">Confirmation phrase does not match.</div>';return}try{const r=await d.reconcileAll(i);a.innerHTML=`<h2>Results</h2><table><thead><tr><th>Application</th><th>Result</th></tr></thead><tbody>${[...r.results.map(c=>`<tr><td>${o(c.application)}</td><td>${c.refused?`${s("refused")} <code>${o(c.error.code)}</code> ${o(c.error.message)}`:`${s("accepted")} <a href="#/ops/${encodeURIComponent(c.operationId)}">${o(c.operationId)}</a>`}</td></tr>`),...r.skipped.map(c=>`<tr><td>${o(c.application)}</td><td>${s("skipped")} ${o(c.reason)}</td></tr>`)].join("")}</tbody></table>`}catch(r){a.innerHTML=m(r)}})}const _=["application","repository","branch","type","deploymentPath","domain","isPrimaryDomain","pm2Config","nginxConfig","enabled","environment","webhookSecretRef"];function J(e={},t=!1){const n=a=>o(e[a]??"");return`<form class="stack" id="entry-form">
    <label>Application (repository name)<input name="application" value="${n("application")}" ${t?"readonly":"required"} /></label>
    <label>Repository (SSH)<input name="repository" value="${n("repository")}" placeholder="git@github.com:owner/repo.git" required /></label>
    <label>Branch<input name="branch" value="${o(e.branch??"main")}" required /></label>
    <label>Type<select name="type"><option value="node" ${e.type==="node"?"selected":""}>node</option><option value="static" ${e.type==="static"?"selected":""}>static</option></select></label>
    <label>Deployment path<input name="deploymentPath" value="${n("deploymentPath")}" placeholder="/projects/&lt;application&gt;" required /></label>
    <label>Domain<input name="domain" value="${n("domain")}" required /></label>
    <label class="check"><input type="checkbox" name="isPrimaryDomain" ${e.isPrimaryDomain?"checked":""} /> Primary domain</label>
    <label>PM2 config file (node only)<input name="pm2Config" value="${n("pm2Config")}" placeholder="&lt;application&gt;.config.js" /></label>
    <label>Nginx config file (optional)<input name="nginxConfig" value="${n("nginxConfig")}" /></label>
    <label>Environment<select name="environment"><option value="production" ${e.environment!=="test"?"selected":""}>production</option><option value="test" ${e.environment==="test"?"selected":""}>test (never executed in production mode)</option></select></label>
    <label>Webhook secret ref (env var NAME, optional)<input name="webhookSecretRef" value="${n("webhookSecretRef")}" /></label>
    <label class="check"><input type="checkbox" name="enabled" ${e.enabled?"checked":""} /> Enabled</label>
    <div class="actions"><button class="btn primary" type="submit">${t?"Save changes":"Register application"}</button></div>
  </form><div id="form-result"></div>`}function K(e){const t=new FormData(e),n={};for(const a of _){if(a==="isPrimaryDomain"||a==="enabled"){n[a]=t.get(a)==="on";continue}const i=String(t.get(a)??"").trim();if(a==="pm2Config"||a==="nginxConfig"){n[a]=i===""?null:i;continue}if(a==="webhookSecretRef"){i&&(n[a]=i);continue}n[a]=i}return n}async function V(e){const t=await d.registry(),n=e?t.applications.find(a=>a.application===e):null;u(`
    <h1>Registry</h1>
    <p class="sub">Authoritative deployment configuration, stored in <code>${o(t.source.repository)}</code>. Every change is a scoped commit + push.</p>
    <div class="actions"><button class="btn ghost" id="retry">Retry push</button></div>
    <div id="retry-result"></div>
    <h2>${n?`Edit ${o(n.application)}`:"Register an application"}</h2>
    ${J(n||{},!!n)}
    <h2>Registered</h2>
    ${t.applications.length?`<table><thead><tr><th>Application</th><th>Type</th><th>State</th><th></th></tr></thead><tbody>${t.applications.map(a=>`<tr><td>${o(a.application)}</td><td>${o(a.type)}</td><td>${a.enabled?s("enabled"):s("disabled")}${a.environment==="test"?" "+s("test"):""}</td><td><a href="#/registry/${encodeURIComponent(a.application)}/edit">edit</a></td></tr>`).join("")}</tbody></table>`:'<div class="empty">Nothing registered yet.</div>'}`),document.getElementById("entry-form").addEventListener("submit",async a=>{a.preventDefault();const i=document.getElementById("form-result"),r=K(a.target);try{const c=n?await d.updateApp(n.application,r):await d.createApp(r);i.innerHTML=I(c.persistence)}catch(c){i.innerHTML=m(c)}}),document.getElementById("retry").addEventListener("click",async()=>{const a=document.getElementById("retry-result");try{a.innerHTML=I((await d.retryPush()).persistence)}catch(i){a.innerHTML=m(i)}})}function C(){P();const t=location.hash.replace(/^#\/?/,"").split("/").map(decodeURIComponent);if(document.querySelectorAll("#nav a").forEach(n=>n.classList.toggle("active",n.dataset.route===(t[0]||"overview"))),u('<p class="muted">Loading…</p>'),!t[0])return h(N);if(t[0]==="apps")return h(()=>t[1]?M(t[1]):j());if(t[0]==="ops")return h(()=>t[1]?x(t[1]):F());if(t[0]==="reconcile")return h(G);if(t[0]==="registry")return h(()=>V(t[2]==="edit"?t[1]:null));u('<div class="empty">Not found.</div>')}T.addEventListener("click",e=>{const t=e.target.closest("tr[data-href]");t&&!e.target.closest("a,button")&&(location.hash=t.dataset.href)});document.getElementById("logout").addEventListener("click",async()=>{try{await d.logout()}finally{f()}});window.addEventListener("hashchange",C);(async()=>{try{if(!(await d.session()).authenticated)return f();A.classList.remove("hidden"),C()}catch{f("Manage API unreachable.")}})();
