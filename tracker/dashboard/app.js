const API = "/api/stats";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
const date = (s) => s ? new Date(s).toLocaleString() : "—";

async function load() {
  const key = $("key").value.trim();
  if (!key) return $("status").textContent = "Enter the dashboard key.";
  $("status").textContent = "Loading…";
  try {
    const res = await fetch(API, { headers: { "X-Dashboard-Key": key } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");
    const t = data.totals;
    $("tiles").innerHTML = [
      [t.sent, "Tracked emails"],
      [t.opened, "Unique opens"],
      [`${Number(t.openRate).toFixed(1)}%`, "Open rate"],
      [t.opens, "Total image loads"]
    ].map(([v, l]) => `<div class="tile"><div class="value">${esc(v)}</div><div class="label">${esc(l)}</div></div>`).join("");
    $("rows").innerHTML = data.rows.map((r) => `<tr>
      <td>${esc(r.recipient_email)}</td><td>${esc(r.company)}</td><td>${esc(r.segment)}</td>
      <td>${date(r.sent_at)}</td><td class="${r.first_opened_at ? "yes" : "muted"}">${date(r.first_opened_at)}</td><td>${esc(r.open_count)}</td>
    </tr>`).join("");
    $("status").textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (error) { $("status").textContent = error.message; }
}

$("load").addEventListener("click", load);
$("key").addEventListener("keydown", (e) => { if (e.key === "Enter") load(); });
