const elements = {
  loginView: document.querySelector("#loginView"),
  dashboardView: document.querySelector("#dashboardView"),
  loginForm: document.querySelector("#loginForm"),
  loginError: document.querySelector("#loginError"),
  logoutButton: document.querySelector("#logoutButton"),
  accounts: document.querySelector("#accounts"),
  emptyState: document.querySelector("#emptyState"),
  accountTemplate: document.querySelector("#accountTemplate"),
  accountCount: document.querySelector("#accountCount"),
  caloriesTotal: document.querySelector("#caloriesTotal"),
  lastSync: document.querySelector("#lastSync"),
  notice: document.querySelector("#notice"),
  connectDialog: document.querySelector("#connectDialog"),
  connectForm: document.querySelector("#connectForm"),
  connectError: document.querySelector("#connectError")
};

let csrfToken = null;

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
      ...options.headers
    }
  });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Не удалось выполнить запрос");
  return body;
}

function showView(authenticated) {
  elements.loginView.classList.toggle("hidden", authenticated);
  elements.dashboardView.classList.toggle("hidden", !authenticated);
  elements.logoutButton.classList.toggle("hidden", !authenticated);
}

function formatNumber(value, suffix = "") {
  if (value === null || value === undefined || value === "") return "—";
  return `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(Number(value))}${suffix}`;
}

function formatDate(value) {
  if (!value) return "ещё не обновлялся";
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function initials(label) {
  return label.split(/\s+/).slice(0, 2).map((word) => word[0]).join("").toUpperCase();
}

function showNotice(message, kind = "success") {
  elements.notice.textContent = message;
  elements.notice.dataset.kind = kind;
  elements.notice.classList.remove("hidden");
  setTimeout(() => elements.notice.classList.add("hidden"), 5000);
}

function renderAccounts(accounts) {
  elements.accounts.replaceChildren();
  elements.emptyState.classList.toggle("hidden", accounts.length > 0);
  elements.accountCount.textContent = accounts.length;
  const totalCalories = accounts.reduce((sum, account) => sum + Number(account.diary_snapshot?.totals?.calories || 0), 0);
  elements.caloriesTotal.textContent = formatNumber(totalCalories, " ккал");
  const latest = accounts.map((account) => account.last_synced_at).filter(Boolean).sort().at(-1);
  elements.lastSync.textContent = latest ? formatDate(latest) : "—";

  for (const account of accounts) {
    const card = elements.accountTemplate.content.firstElementChild.cloneNode(true);
    const profile = account.profile || {};
    const totals = account.diary_snapshot?.totals || {};
    card.querySelector(".avatar").textContent = initials(account.label);
    card.querySelector(".account-label").textContent = account.label;
    card.querySelector(".sync-time").textContent = `Обновлён ${formatDate(account.last_synced_at)}`;
    card.querySelector(".last-weight").textContent = formatNumber(profile.last_weight_kg, " кг");
    card.querySelector(".goal-weight").textContent = formatNumber(profile.goal_weight_kg, " кг");
    card.querySelector(".height").textContent = formatNumber(profile.height_cm, " см");
    card.querySelector(".card-calories").textContent = formatNumber(totals.calories || 0, " ккал");
    card.querySelector(".protein").textContent = formatNumber(totals.protein || 0, " г");
    card.querySelector(".fat").textContent = formatNumber(totals.fat || 0, " г");
    card.querySelector(".carbs").textContent = formatNumber(totals.carbohydrate || 0, " г");

    card.querySelector(".sync-button").addEventListener("click", async (event) => {
      event.currentTarget.disabled = true;
      event.currentTarget.textContent = "Обновляю…";
      try {
        await api(`/api/accounts/${account.id}/sync`, { method: "POST" });
        await loadAccounts();
        showNotice(`Аккаунт «${account.label}» обновлён`);
      } catch (error) {
        showNotice(error.message, "error");
        event.currentTarget.disabled = false;
        event.currentTarget.textContent = "↻ Обновить";
      }
    });

    card.querySelector(".delete-button").addEventListener("click", async () => {
      if (!confirm(`Отключить аккаунт «${account.label}»?`)) return;
      try {
        await api(`/api/accounts/${account.id}`, { method: "DELETE" });
        await loadAccounts();
        showNotice("Аккаунт отключён");
      } catch (error) {
        showNotice(error.message, "error");
      }
    });
    elements.accounts.append(card);
  }
}

async function loadAccounts() {
  const { accounts } = await api("/api/accounts");
  renderAccounts(accounts);
}

elements.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.loginError.textContent = "";
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  try {
    const result = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ password: new FormData(event.currentTarget).get("password") })
    });
    csrfToken = result.csrfToken;
    showView(true);
    event.currentTarget.reset();
    await loadAccounts();
  } catch (error) {
    elements.loginError.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

elements.logoutButton.addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  csrfToken = null;
  showView(false);
});

function openConnectDialog() {
  elements.connectError.textContent = "";
  elements.connectDialog.showModal();
  setTimeout(() => document.querySelector("#accountLabel").focus(), 0);
}

document.querySelector("#openConnectButton").addEventListener("click", openConnectDialog);
document.querySelector("[data-open-connect]").addEventListener("click", openConnectDialog);

elements.connectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.connectError.textContent = "";
  const button = event.currentTarget.querySelector(".primary");
  button.disabled = true;
  try {
    const label = new FormData(event.currentTarget).get("label");
    const result = await api("/api/fatsecret/connect", {
      method: "POST",
      body: JSON.stringify({ label })
    });
    window.location.assign(result.authorizationUrl);
  } catch (error) {
    elements.connectError.textContent = error.message;
    button.disabled = false;
  }
});

async function bootstrap() {
  const params = new URLSearchParams(window.location.search);
  const oauthResult = params.get("oauth");
  if (oauthResult) history.replaceState({}, "", "/");
  const session = await api("/api/session");
  csrfToken = session.csrfToken;
  showView(session.authenticated);
  if (session.authenticated) {
    await loadAccounts();
    if (oauthResult === "connected") showNotice("FatSecret-аккаунт успешно подключён");
    if (oauthResult === "denied") showNotice("Подключение отменено", "error");
    if (oauthResult === "expired") showNotice("Сессия подключения истекла. Попробуйте ещё раз.", "error");
  }
}

bootstrap().catch((error) => {
  showView(false);
  elements.loginError.textContent = error.message;
});
