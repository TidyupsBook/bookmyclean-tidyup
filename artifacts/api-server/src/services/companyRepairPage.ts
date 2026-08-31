export const COMPANY_REPAIR_REVIEW_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Review test-company cleanup</title>
    <style>
      :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; }
      body { margin: 0; background: #0b1120; color: #e5e7eb; }
      main { width: min(980px, calc(100% - 32px)); margin: 40px auto; }
      h1 { margin-bottom: 8px; }
      .muted { color: #94a3b8; }
      .warning { border: 1px solid #b45309; background: #451a03; padding: 16px; border-radius: 10px; }
      .card { border: 1px solid #334155; background: #111827; padding: 16px; border-radius: 10px; margin-top: 16px; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border-bottom: 1px solid #334155; padding: 10px; text-align: left; vertical-align: top; }
      th { color: #cbd5e1; }
      code, pre { white-space: pre-wrap; overflow-wrap: anywhere; }
      input { width: 100%; box-sizing: border-box; padding: 12px; border: 1px solid #64748b; border-radius: 8px; background: #020617; color: white; }
      button { margin-top: 12px; padding: 12px 16px; border: 0; border-radius: 8px; background: #dc2626; color: white; font-weight: 700; cursor: pointer; }
      button:disabled { cursor: not-allowed; opacity: .45; }
      .ok { color: #86efac; }
      .error { color: #fca5a5; }
    </style>
  </head>
  <body>
    <main>
      <h1>Review synthetic test-company cleanup</h1>
      <p class="muted">This page is available only to the protected Book My Cleaning owner.</p>
      <div class="warning">
        <strong>Irreversible production action.</strong>
        Review every target and dependent-row count below. The server will abort if
        anything changes after this review or if a cross-company reference exists.
      </div>
      <div id="status" class="card">Loading a fresh production review…</div>
      <section id="review" hidden>
        <div class="card">
          <h2>Reviewed companies</h2>
          <div style="overflow-x:auto">
            <table>
              <thead><tr><th>ID</th><th>Company</th><th>Owner / integrations</th><th>Dependent rows</th></tr></thead>
              <tbody id="companies"></tbody>
            </table>
          </div>
        </div>
        <div class="card">
          <h2>Safety checks</h2>
          <pre id="checks"></pre>
        </div>
        <div class="card">
          <h2>Confirm cleanup</h2>
          <p>Type <code id="phrase"></code> exactly:</p>
          <input id="confirmation" autocomplete="off" />
          <button id="execute" disabled>Remove reviewed synthetic companies</button>
          <pre id="result"></pre>
        </div>
      </section>
    </main>
    <script>
      const endpoint = "/api/company/repair/test-companies";
      const status = document.getElementById("status");
      const review = document.getElementById("review");
      const companies = document.getElementById("companies");
      const checks = document.getElementById("checks");
      const phrase = document.getElementById("phrase");
      const confirmation = document.getElementById("confirmation");
      const execute = document.getElementById("execute");
      const result = document.getElementById("result");
      let audit;

      function totalCounts(counts) {
        return Object.values(counts).reduce((sum, value) => sum + value, 0);
      }

      async function loadReview() {
        const response = await fetch(endpoint, { credentials: "same-origin" });
        if (!response.ok) throw new Error("Review request failed (" + response.status + ")");
        audit = await response.json();
        status.textContent = "Fresh review loaded. Digest: " + audit.reviewDigest;
        status.className = "card ok";
        phrase.textContent = audit.confirmation;
        companies.replaceChildren();
        for (const company of audit.companies) {
          const row = document.createElement("tr");
          const identity = company.ownerUserId +
            (company.ownerEmail ? "\\n" + company.ownerEmail : "") +
            "\\nJobber: " + (company.jobberAccountId || "not connected");
          const values = [
            String(company.id),
            company.name,
            identity,
            totalCounts(company.counts) + "\\n" + JSON.stringify(company.counts, null, 2),
          ];
          for (const value of values) {
            const cell = document.createElement("td");
            cell.textContent = value;
            row.appendChild(cell);
          }
          companies.appendChild(row);
        }
        checks.textContent = JSON.stringify({
          syntheticCompanyIds: audit.candidateCompanyIds,
          crossCompanyReferences: audit.crossCompanyReferences,
          unreviewedCompanies: audit.unreviewedCompanies,
        }, null, 2);
        review.hidden = false;
        updateButton();
      }

      function updateButton() {
        execute.disabled =
          !audit ||
          confirmation.value !== audit.confirmation ||
          audit.candidateCompanyIds.length === 0 ||
          audit.crossCompanyReferences.length !== 0;
      }

      confirmation.addEventListener("input", updateButton);
      execute.addEventListener("click", async () => {
        if (execute.disabled) return;
        if (!window.confirm("Permanently remove exactly the reviewed synthetic companies?")) return;
        execute.disabled = true;
        result.textContent = "Running guarded cleanup…";
        const response = await fetch(endpoint, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            confirmation: confirmation.value,
            reviewDigest: audit.reviewDigest,
            companyIds: audit.candidateCompanyIds,
          }),
        });
        const body = await response.json();
        result.textContent = JSON.stringify(body, null, 2);
        result.className = response.ok ? "ok" : "error";
        if (!response.ok) {
          confirmation.value = "";
          await loadReview();
        }
      });

      loadReview().catch((error) => {
        status.textContent = error.message;
        status.className = "card error";
      });
    </script>
  </body>
</html>`;
