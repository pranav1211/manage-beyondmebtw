// Manage frontend shell (Stage 1).
// Pings the Manage API /health through the dev proxy. The frontend's only
// backend is the Manage API — never Argus.

const statusText = document.getElementById('status-text');
const statusEl = document.getElementById('status');

async function checkHealth() {
  try {
    // Dev proxy maps /api -> Manage API. Health lives at the API root in Stage 1.
    const res = await fetch('/api/../health', { headers: { accept: 'application/json' } })
      .catch(() => fetch('http://localhost:7000/health'));
    if (!res || !res.ok) throw new Error('unhealthy');
    const body = await res.json();
    statusText.textContent = `Manage API online (${body.env ?? 'unknown'})`;
    statusEl.dataset.state = 'ok';
  } catch {
    statusText.textContent = 'Manage API not reachable — start it with `npm run dev:api`.';
    statusEl.dataset.state = 'down';
  }
}

checkHealth();
