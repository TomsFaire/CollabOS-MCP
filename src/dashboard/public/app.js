const grid = document.getElementById("grid");
const importStatus = document.getElementById("importStatus");
const csvFile = document.getElementById("csvFile");
const refreshBtn = document.getElementById("refreshBtn");

function cardClass(room) {
  if (room.never_polled) return "unknown";
  if (room.stale) return "warn";
  if (!room.online) return "bad";
  return "ok";
}

function badge(room) {
  if (room.never_polled) return { text: "never polled", cls: "unknown" };
  if (room.stale) return { text: "stale", cls: "stale" };
  if (!room.online) return { text: "offline", cls: "offline" };
  return { text: "online", cls: "online" };
}

function render(rooms) {
  if (!grid) return;
  grid.innerHTML = "";
  for (const r of rooms) {
    const cc = cardClass(r);
    const b = badge(r);
    const el = document.createElement("article");
    el.className = `card ${cc}`;
    el.innerHTML = `
      <h2>${escapeHtml(r.room_name)}</h2>
      <div class="meta">
        <div>${escapeHtml(r.office || "—")} · ${escapeHtml(r.ip_address)}</div>
        <div>Device: ${escapeHtml(r.device_id)}</div>
        <div>State: ${escapeHtml(r.device_state || "—")} · Occ: ${r.occupancy_count ?? "—"}</div>
      </div>
      <span class="badge ${b.cls}">${b.text}</span>
    `;
    grid.appendChild(el);
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function loadRooms() {
  const res = await fetch("/api/rooms");
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  render(data.rooms || []);
}

csvFile?.addEventListener("change", async () => {
  const f = csvFile.files?.[0];
  if (!f) return;
  importStatus.textContent = "Importing…";
  try {
    const text = await f.text();
    const res = await fetch("/api/import", {
      method: "POST",
      headers: { "Content-Type": "text/csv" },
      body: text,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    importStatus.textContent = `Imported ${data.imported}, skipped ${data.skipped}`;
    await loadRooms();
  } catch (e) {
    importStatus.textContent = e instanceof Error ? e.message : String(e);
  }
  csvFile.value = "";
});

refreshBtn?.addEventListener("click", () => {
  void loadRooms().catch((e) => {
    if (importStatus) importStatus.textContent = String(e);
  });
});

void loadRooms().catch((e) => {
  if (importStatus) importStatus.textContent = String(e);
});
