const resultsBody = document.querySelector("#resultsBody");
const statsGrid = document.querySelector("#statsGrid");

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatDate(value) {
  return new Intl.DateTimeFormat("uz-UZ", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function renderStats(results) {
  const counts = results.reduce((acc, item) => {
    acc[item.key] = (acc[item.key] || 0) + 1;
    return acc;
  }, {});

  const cards = [
    ["Jami", results.length],
    ["Qisqa muddatli", counts.qisqa || 0],
    ["O'rta muddatli", counts.orta || 0],
    ["Uzoq muddatli", counts.uzoq || 0]
  ];

  statsGrid.innerHTML = cards.map(([label, value]) => `
    <article class="stat-card">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </article>
  `).join("");
}

function renderResults(results) {
  if (!results.length) {
    resultsBody.innerHTML = `<tr><td colspan="6">Hali natija yo'q.</td></tr>`;
    return;
  }

  resultsBody.innerHTML = results.map((item) => {
    const openAnswers = Object.values(item.openAnswers || {}).filter(Boolean).join(" | ");
    return `
      <tr>
        <td>${escapeHtml(formatDate(item.createdAt))}</td>
        <td><strong>${escapeHtml(item.person?.firstName)} ${escapeHtml(item.person?.lastName)}</strong></td>
        <td><span class="result-pill ${escapeHtml(item.key)}">${escapeHtml(item.result)}</span></td>
        <td>${escapeHtml(item.answers?.c3 || "")}</td>
        <td>${escapeHtml(item.answers?.c4 || "")}</td>
        <td>${escapeHtml(openAnswers || "-")}</td>
      </tr>
    `;
  }).join("");
}

async function loadResults() {
  const response = await fetch("/api/admin/results");
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Natijalar yuklanmadi.");
  renderStats(data.results);
  renderResults(data.results);
}

loadResults().catch((error) => {
  resultsBody.innerHTML = `<tr><td colspan="6">${escapeHtml(error.message)}</td></tr>`;
});
