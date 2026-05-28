(function () {
  const storageKey = "blockforge-launcher/state/v2";
  const msClientIdKey = "blockforge-launcher/microsoft-client-id";
  const restorePageKey = "blockforge-launcher/restore-page";
  const themeKey = "blockforge/custom-theme";
  const updateDismissKey = "blockbasemc/update-dismissed-version";
  let minecraftVersionCache = null;
  let launcherUpdateState = null;
  let launcherUpdateCheckStarted = false;
  let deviceCodeListenerReady = false;

  function readState() {
    try {
      return normalizeState(JSON.parse(localStorage.getItem(storageKey) || "{}"));
    } catch {
      return normalizeState({});
    }
  }

  function writeState(state) {
    localStorage.setItem(storageKey, JSON.stringify(normalizeState(state)));
  }

  function normalizeState(state) {
    state.accounts = Array.isArray(state.accounts) ? state.accounts : [];
    state.profiles = Array.isArray(state.profiles) ? state.profiles : [];
    state.servers = Array.isArray(state.servers) ? state.servers : [];
    state.runningInstances = Array.isArray(state.runningInstances) ? state.runningInstances : [];
    state.downloads = Array.isArray(state.downloads) ? state.downloads : [];
    return state;
  }

  function makeDefaultProfile(edition) {
    const id = crypto.randomUUID();
    return {
      id,
      edition,
      name: edition === "java" ? "New Java Profile" : "New Bedrock Profile",
      version: edition === "java" ? "1.21.8" : "Latest installed",
      loader: "Vanilla",
      icon: edition === "java" ? "grass" : "diamond",
      banner: "Fresh isolated instance",
      accountId: "",
      folder: `.blockbasemc/${edition}/${id.slice(0, 8)}`,
      javaPath: "",
      ramMin: edition === "java" ? 1024 : 0,
      ramMax: edition === "java" ? 4096 : 0,
      jvmArgs: edition === "java" ? "-XX:+UseG1GC" : "",
      launchArgs: "",
      width: 1280,
      height: 720,
      fullscreen: false,
      quickJoinServer: "",
      backupWorlds: true,
      safeMode: false,
      lastPlayed: "Never"
    };
  }

  function repairProfileState() {
    const state = readState();
    let changed = false;

    if (state.accounts.some((item) => item.kind === "bedrock")) {
      state.accounts = state.accounts.filter((item) => item.kind !== "bedrock");
      changed = true;
    }

    if (state.profiles.some((profile) => profile.edition === "bedrock")) {
      state.profiles = state.profiles.filter((profile) => profile.edition !== "bedrock");
      changed = true;
    }

    if (!state.profiles.some((profile) => profile.edition === "java")) {
      const account = state.accounts.find((item) => item.kind === "java" && item.default) ||
        state.accounts.find((item) => item.kind === "java");
      state.profiles.unshift({
        ...makeDefaultProfile("java"),
        accountId: account?.id || ""
      });
      changed = true;
    }

    state.profiles = state.profiles.map((profile) => {
      if (profile.edition === "java") return profile;
      changed = true;
      return { ...profile, edition: "java" };
    });

    if (changed) {
      writeState(state);
      reloadKeepingPage();
    }
  }

  function currentEdition() {
    return "java";
  }

  function currentPageTitle() {
    return document.querySelector(".topbar h1")?.textContent?.trim() || "";
  }

  function selectedProfileId() {
    const activeRow = document.querySelector(".profile-row.active");
    const activeName = activeRow?.querySelector("strong")?.textContent?.trim();
    const edition = currentEdition();
    const state = readState();
    return state.profiles.find((profile) => profile.edition === edition && profile.name === activeName)?.id ||
      state.profiles.find((profile) => profile.edition === edition)?.id || "";
  }

  function selectedJavaProfile() {
    const state = readState();
    const id = selectedProfileId();
    return state.profiles.find((profile) => profile.id === id && profile.edition === "java") ||
      state.profiles.find((profile) => profile.edition === "java") || null;
  }

  function patchSelectedProfile(patch) {
    const id = selectedProfileId();
    if (!id) return false;
    const state = readState();
    let changed = false;
    state.profiles = state.profiles.map((profile) => {
      if (profile.id !== id) return profile;
      changed = true;
      return { ...profile, ...patch };
    });
    if (changed) writeState(state);
    return changed;
  }

  function isDiscoverPage() {
    const title = currentPageTitle();
    const activeNav = document.querySelector(".nav-list button.active")?.textContent?.trim() || "";
    return title === "Discover" || title === "Browse" || activeNav.startsWith("Browse");
  }

  function reloadKeepingPage() {
    const page = currentPageTitle();
    if (page) sessionStorage.setItem(restorePageKey, page);
    window.location.reload();
  }

  function restorePageAfterReload() {
    const page = sessionStorage.getItem(restorePageKey);
    if (!page) return;
    const button = Array.from(document.querySelectorAll(".nav-list button")).find((item) =>
      item.textContent.trim().startsWith(page === "Account Manager" ? "Accounts" : page === "Running Instances" ? "Running" : page === "Download Queue" ? "Downloads" : page)
    );
    if (button) {
      sessionStorage.removeItem(restorePageKey);
      window.setTimeout(() => {
        button.click();
        window.setTimeout(enhance, 120);
      }, 120);
    }
  }

  function initials(name) {
    return (
      (name || "Player")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0].toUpperCase())
        .join("") || "P"
    );
  }

  function sanitizeInstances() {
    const state = readState();
    const seen = new Set();
    const cleaned = state.runningInstances
      .filter((instance) => instance && instance.id && !seen.has(instance.id) && seen.add(instance.id))
      .slice(0, 20)
      .map((instance) => ({
        ...instance,
        status: ["starting", "running", "crashed", "stopped"].includes(instance.status)
          ? instance.status
          : "stopped"
      }));

    if (cleaned.length !== state.runningInstances.length) {
      state.runningInstances = cleaned;
      writeState(state);
    }
  }

  function addOfflineAccount(kind) {
    showOfflineAccountModal(kind);
  }

  function showOfflineAccountModal(kind) {
    if (document.querySelector("[data-offline-account-modal]")) return;
    if (kind !== "java") return;
    const label = "Java username";
    const modal = document.createElement("div");
    modal.className = "skin-modal-backdrop";
    modal.dataset.offlineAccountModal = "true";
    modal.innerHTML = `
      <form class="server-modal skin-modal" data-offline-account-form="${kind}">
        <button class="skin-modal-close" data-close-offline-account-modal="true" type="button">X</button>
          <h3>Add Java offline account</h3>
        <label>${label}
          <input data-offline-account-name="true" placeholder="Username" required />
        </label>
        <div class="server-modal-actions">
          <button class="secondary-button" data-close-offline-account-modal="true" type="button">Cancel</button>
          <button class="primary-button" type="submit">Add account</button>
        </div>
      </form>
    `;
    document.body.appendChild(modal);
    modal.querySelector("[data-offline-account-name]")?.focus();
  }

  function closeOfflineAccountModal() {
    document.querySelector("[data-offline-account-modal]")?.remove();
  }

  function submitOfflineAccountForm(form) {
    const kind = form.dataset.offlineAccountForm || "java";
    const name = form.querySelector("[data-offline-account-name]")?.value;
    if (!name || !name.trim()) return;

    const state = readState();
    const account = {
      id: `${kind}-local-${Date.now()}`,
      kind,
      displayName: name.trim(),
      email: "Offline/dev account",
      identifier: "offline-dev-mode",
      avatar: initials(name),
      default: !state.accounts.some((item) => item.kind === kind),
      status: "dev"
    };

    state.accounts = [account, ...state.accounts];
    writeState(state);
    reloadKeepingPage();
  }

  async function addMicrosoftJavaAccount() {
    if (!window.launcherApi?.microsoftLogin) {
      window.alert("This build does not include the Microsoft login backend.");
      return;
    }

    const clientId = localStorage.getItem(msClientIdKey) || "00000000402B5328";
    window.alert("Your browser will open for Microsoft sign-in. If Microsoft asks for a code, use the code shown in BlockBaseMC.");

    try {
      const account = await window.launcherApi.microsoftLogin(clientId);
      const email = account.email || "Microsoft account";
      const state = readState();
      const alreadyExists = state.accounts.some((item) => item.id === account.id);
      const nextAccount = {
        ...account,
        email,
        lastAuthedAt: new Date().toISOString(),
        default: true,
        status: "online"
      };
      state.accounts = [
        nextAccount,
        ...state.accounts.filter((item) => item.id !== account.id)
          .map((item) => (item.kind === "java" ? { ...item, default: false } : item))
      ];
      state.profiles = state.profiles.map((profile) =>
        profile.edition === "java" ? { ...profile, accountId: account.id } : profile
      );
      writeState(state);
      closeMicrosoftDeviceModal();
      window.alert(alreadyExists
        ? `Refreshed existing Microsoft Java account: ${account.displayName}\n\nTo add another account, choose a different Microsoft account in the sign-in chooser.`
        : `Added Microsoft Java account: ${account.displayName}`);
      reloadKeepingPage();
    } catch (error) {
      window.alert(`Microsoft login failed: ${error?.message || String(error)}`);
    }
  }

  async function reauthMicrosoftJavaAccount(accountId) {
    if (!window.launcherApi?.microsoftLogin) {
      window.alert("This build does not include the Microsoft login backend.");
      return;
    }

    const state = readState();
    const existing = state.accounts.find((account) => account.id === accountId);
    const clientId = localStorage.getItem(msClientIdKey) || "00000000402B5328";

    try {
      if (!window.launcherApi.microsoftReauth) {
        window.alert("This build does not include silent Microsoft reauth yet.");
        return;
      }
      const account = await window.launcherApi.microsoftReauth(accountId, clientId);
      const updatedJava = {
        ...existing,
        ...account,
        id: accountId,
        email: existing?.email || account.email || "Microsoft account",
        lastAuthedAt: new Date().toISOString(),
        status: "online"
      };
      state.accounts = state.accounts.map((item) =>
        item.id === accountId
          ? updatedJava
          : item
      );
      writeState(state);
      closeMicrosoftDeviceModal();
      window.alert(`Reauthed ${account.displayName} without browser login.`);
      reloadKeepingPage();
    } catch (error) {
      window.alert(`Silent reauth could not be completed: ${error?.message || String(error)}`);
    }
  }

  function accountCanSilentReauth(account) {
    return account.kind === "java" && account.status === "online" && account.canRefresh === true;
  }

  function accountNeedsReauth(account) {
    if (!accountCanSilentReauth(account)) return false;
    if (!account.lastAuthedAt) return false;
    return Date.now() - new Date(account.lastAuthedAt).getTime() > 24 * 60 * 60 * 1000;
  }

  function setupMicrosoftDeviceCodeListener() {
    if (deviceCodeListenerReady || !window.launcherApi?.onMicrosoftDeviceCode) return;
    deviceCodeListenerReady = true;
    window.launcherApi.onMicrosoftDeviceCode((entry) => showMicrosoftDeviceCode(entry));
  }

  function showMicrosoftDeviceCode(entry) {
    const code = entry?.userCode || "";
    const url = entry?.verificationUriComplete || entry?.verificationUri || "https://www.microsoft.com/link";
    let backdrop = document.querySelector("[data-ms-device-modal]");
    if (!backdrop) {
      backdrop = document.createElement("div");
      backdrop.className = "ms-device-backdrop";
      backdrop.dataset.msDeviceModal = "true";
      document.body.appendChild(backdrop);
    }
    backdrop.innerHTML = `
      <section class="ms-device-modal" role="dialog" aria-modal="true" aria-label="Microsoft browser login">
        <button class="skin-modal-close" type="button" data-close-ms-device aria-label="Close">x</button>
        <span class="eyebrow">Microsoft browser login</span>
        <h3>Finish sign-in in your browser</h3>
        <p>BlockBaseMC opened your browser. Enter this code if Microsoft asks for it, then come back here while the launcher connects your account.</p>
        <div class="ms-device-code">${escapeHtml(code || "Waiting")}</div>
        <div class="ms-device-actions">
          <button class="secondary-button" type="button" data-copy-ms-code="${escapeHtml(code)}">Copy code</button>
          <button class="primary-button" type="button" data-open-ms-device="${escapeHtml(url)}">Open browser</button>
        </div>
      </section>
    `;
  }

  function closeMicrosoftDeviceModal() {
    document.querySelector("[data-ms-device-modal]")?.remove();
  }

  function escapeHtml(value) {
    return String(value || "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#039;"
    }[char]));
  }

  function reauthText(account) {
    if (account.status !== "online") return "Offline/dev";
    if (!accountCanSilentReauth(account)) return "Silent reauth unavailable";
    if (!account.lastAuthedAt) return "Reauth ready";
    const hours = Math.max(0, 24 - Math.floor((Date.now() - new Date(account.lastAuthedAt).getTime()) / 36e5));
    return accountNeedsReauth(account) ? "Reauth ready" : `Reauth in ${hours}h`;
  }

  async function checkLauncherUpdates(manual = false) {
    if (!window.launcherApi?.checkForUpdates) {
      if (manual) window.alert("This build does not include update checks yet.");
      return;
    }
    if (launcherUpdateCheckStarted && !manual) return;
    launcherUpdateCheckStarted = true;
    try {
      const result = await window.launcherApi.checkForUpdates();
      launcherUpdateState = result;
      renderLauncherUpdateBanner();
      if (manual) {
        window.alert(result?.message || "Update check finished.");
      }
    } catch (error) {
      launcherUpdateState = { ok: false, message: error?.message || String(error) };
      renderLauncherUpdateBanner();
      if (manual) window.alert(`Update check failed: ${launcherUpdateState.message}`);
    }
  }

  function renderLauncherUpdateBanner() {
    document.querySelector("[data-launcher-update-banner]")?.remove();
    const update = launcherUpdateState;
    if (!update?.updateAvailable) return;
    if (localStorage.getItem(updateDismissKey) === update.latestVersion) return;

    const topbar = document.querySelector(".topbar");
    const main = document.querySelector(".main");
    if (!topbar || !main) return;

    const banner = document.createElement("section");
    banner.className = "launcher-update-banner";
    banner.dataset.launcherUpdateBanner = "true";
    banner.innerHTML = `
      <div>
        <span class="eyebrow">Update available</span>
        <h3>BlockBaseMC ${escapeHtml(update.latestVersion)} is ready</h3>
        <p>You are running ${escapeHtml(update.currentVersion)}. Portable builds update by downloading the newest exe from GitHub Releases.</p>
      </div>
      <div class="enhancement-actions">
        <button data-open-update="${escapeHtml(update.releaseUrl || update.downloadUrl)}" type="button">View release</button>
        <button data-download-update="${escapeHtml(update.downloadUrl || update.releaseUrl)}" type="button">Download update</button>
        <button data-dismiss-update="${escapeHtml(update.latestVersion)}" type="button">Dismiss</button>
      </div>
    `;
    topbar.after(banner);
  }
  function deleteAccount(accountId) {
    const state = readState();
    const account = state.accounts.find((item) => item.id === accountId);
    if (!account) return;

    const fallback = state.accounts.find((item) => item.kind === account.kind && item.id !== accountId);
    if (!window.confirm(`Delete ${account.displayName}? Profiles using it will switch to ${fallback?.displayName || "no account"}.`)) {
      return;
    }

    state.accounts = state.accounts.filter((item) => item.id !== accountId);
    state.profiles = state.profiles.map((profile) =>
      profile.accountId === accountId ? { ...profile, accountId: fallback?.id || "" } : profile
    );
    writeState(state);
    reloadKeepingPage();
  }

  function openSkinPage() {
    window.open("https://www.minecraft.net/msaprofile/mygames/editskin", "_blank");
  }

  async function showSkinModal(accountId) {
    const account = readState().accounts.find((item) => item.id === accountId);
    if (!account) return;

    const uuid = account.identifier || account.id.replace(/^java-ms-/, "");
    const head = `https://crafatar.com/avatars/${encodeURIComponent(uuid)}?size=96&overlay`;
    const modal = document.createElement("div");
    modal.className = "skin-modal-backdrop";
    modal.dataset.skinModal = "true";
    modal.innerHTML = `
      <div class="skin-modal">
        <button class="skin-modal-close" data-close-skin-modal="true" type="button">X</button>
        <div class="skin-stage">
          <div class="skin-loading" data-skin-loading>Loading skin...</div>
          <div class="skin-player skin-player-v2" data-skin-player hidden>
            <div class="skin-head"></div>
            <div class="skin-body"></div>
            <div class="skin-arm left"></div>
            <div class="skin-arm right"></div>
            <div class="skin-leg left"></div>
            <div class="skin-leg right"></div>
          </div>
          <div class="skin-fallback">Skin preview unavailable</div>
        </div>
        <div class="skin-modal-info">
          <img data-skin-head src="${head}" alt="" />
          <div>
            <h3>${account.displayName}</h3>
            <p>${account.email || "Microsoft account"}</p>
            <a data-namemc-link href="https://namemc.com/profile/${encodeURIComponent(uuid)}" target="_blank" rel="noreferrer">NameMC profile</a>
          </div>
        </div>
        <button class="primary-skin-action" data-change-skin="true" type="button">Change skin</button>
      </div>
    `;
    document.body.appendChild(modal);

    try {
      const skin = await window.launcherApi?.skinProfile?.(account);
      if (!skin?.skinUrl) throw new Error("No skin URL returned.");
      const player = modal.querySelector("[data-skin-player]");
      player.style.setProperty("--skin", `url("${skin.skinUrl}")`);
      player.classList.toggle("slim", skin.model === "slim");
      player.hidden = false;
      modal.querySelector("[data-skin-loading]").style.display = "none";
      const headImg = modal.querySelector("[data-skin-head]");
      headImg.src = `https://crafatar.com/avatars/${encodeURIComponent(skin.uuid)}?size=96&overlay`;
      const link = modal.querySelector("[data-namemc-link]");
      link.href = skin.namemcUrl;
    } catch (error) {
      modal.querySelector("[data-skin-loading]").style.display = "none";
      const fallback = modal.querySelector(".skin-fallback");
      fallback.textContent = `Skin preview unavailable: ${error?.message || String(error)}`;
      fallback.style.display = "grid";
    }
  }

  function closeSkinModal() {
    document.querySelector("[data-skin-modal]")?.remove();
  }

  function addServer() {
    showServerModal();
  }

  function showServerModal() {
    if (document.querySelector("[data-server-modal]")) return;
    const edition = currentEdition();
    const modal = document.createElement("div");
    modal.className = "skin-modal-backdrop";
    modal.dataset.serverModal = "true";
    modal.innerHTML = `
      <form class="server-modal skin-modal" data-server-form="true">
        <button class="skin-modal-close" data-close-server-modal="true" type="button">X</button>
        <h3>Add Java server</h3>
        <label>Server name
          <input data-server-name="true" placeholder="Hypixel" required />
        </label>
        <label>Server address
          <input data-server-address="true" placeholder="${edition === "java" ? "mc.hypixel.net" : "play.example.net"}" required />
        </label>
        <div class="server-modal-actions">
          <button class="secondary-button" data-close-server-modal="true" type="button">Cancel</button>
          <button class="primary-button" type="submit">Add server</button>
        </div>
      </form>
    `;
    document.body.appendChild(modal);
    modal.querySelector("[data-server-name]")?.focus();
  }

  function closeServerModal() {
    document.querySelector("[data-server-modal]")?.remove();
  }

  function submitServerForm(form) {
    const edition = currentEdition();
    const name = form.querySelector("[data-server-name]")?.value;
    const address = form.querySelector("[data-server-address]")?.value;
    if (!name?.trim() || !address?.trim()) return;

    const state = readState();
    const server = {
      id: `server-${edition}-${Date.now()}`,
      edition,
      name: name.trim(),
      address: address.trim(),
      ping: 0,
      players: "?",
      motd: "Checking server status...",
      favorite: true,
      status: "checking"
    };
    state.servers = [
      server,
      ...state.servers
    ];
    writeState(state);
    refreshServerStatus(server.id, true);
    reloadKeepingPage();
  }

  function serverStatusUrl(server) {
    return `https://api.mcstatus.io/v2/status/java/${encodeURIComponent(server.address)}?timeout=4`;
  }

  function cleanMotd(motd) {
    if (!motd) return "No MOTD returned";
    if (typeof motd.clean === "string") return motd.clean.replace(/\s+/g, " ").trim();
    if (Array.isArray(motd.clean)) return motd.clean.join(" ").replace(/\s+/g, " ").trim();
    return "No MOTD returned";
  }

  function formatPlayers(players) {
    if (!players) return "?";
    const online = players.online ?? "?";
    const max = players.max ?? "?";
    return `${online}/${max}`;
  }

  async function fetchServerDetails(server) {
    const response = await fetch(serverStatusUrl(server));
    if (!response.ok) {
      throw new Error(await response.text().catch(() => `HTTP ${response.status}`));
    }
    const data = await response.json();
    return {
      status: data.online ? "online" : "offline",
      host: data.host || server.address,
      port: data.port || 25565,
      ipAddress: data.ip_address || "",
      players: formatPlayers(data.players),
      playersOnline: data.players?.online ?? null,
      playersMax: data.players?.max ?? null,
      motd: data.online ? cleanMotd(data.motd) : "Server is offline",
      version: data.version?.name_clean || data.version?.name || "Unknown version",
      protocol: data.version?.protocol ?? null,
      software: data.software || data.edition || "",
      gamemode: data.gamemode || "",
      icon: data.icon || "",
      eulaBlocked: Boolean(data.eula_blocked),
      checkedAt: new Date().toISOString(),
      expiresAt: data.expires_at || 0,
      apiSource: "mcstatus.io"
    };
  }

  async function refreshServerStatus(serverId, silent = false) {
    const state = readState();
    const server = state.servers.find((item) => item.id === serverId);
    if (!server) return;

    if (!silent) {
      const button = document.querySelector(`[data-refresh-server="${serverId}"]`);
      if (button) {
        button.disabled = true;
        button.textContent = "Checking...";
      }
    }

    try {
      const details = await fetchServerDetails(server);
      const nextState = readState();
      nextState.servers = nextState.servers.map((item) =>
        item.id === serverId ? { ...item, ...details } : item
      );
      writeState(nextState);
      renderServerDetails(serverId, { ...server, ...details });
    } catch (error) {
      const nextState = readState();
      nextState.servers = nextState.servers.map((item) =>
        item.id === serverId
          ? {
              ...item,
              status: "offline",
              motd: `Status check failed: ${error?.message || String(error)}`,
              checkedAt: new Date().toISOString()
            }
          : item
      );
      writeState(nextState);
      renderServerDetails(serverId, nextState.servers.find((item) => item.id === serverId));
    }
  }

  function serverIconMarkup(server) {
    if (server.icon) {
      return `<img class="server-icon" src="${server.icon}" alt="" />`;
    }
    return `<div class="server-icon server-icon-fallback">J</div>`;
  }

  function renderServerDetails(serverId, server) {
    const card = document.querySelector(`[data-server-card-id="${serverId}"]`);
    if (!card || !server) return;
    const details = card.querySelector("[data-server-details]");
    if (!details) return;
    details.innerHTML = `
      <div class="server-summary">
        ${serverIconMarkup(server)}
        <div>
          <span class="status-badge ${server.status || "offline"}">${server.status || "unknown"}</span>
          <strong>${server.players || "?"} players</strong>
          <small>${server.version || "Unknown version"}${server.software ? ` Â· ${server.software}` : ""}</small>
        </div>
      </div>
      <p>${server.motd || "No MOTD returned"}</p>
      <div class="server-facts">
        <span>Host: ${server.host || server.address}</span>
        <span>Port: ${server.port || 25565}</span>
        ${server.gamemode ? `<span>Mode: ${server.gamemode}</span>` : ""}
        ${server.eulaBlocked ? `<span class="danger">EULA blocked</span>` : ""}
      </div>
    `;
    const button = card.querySelector(`[data-refresh-server="${serverId}"]`);
    if (button) {
      button.disabled = false;
      button.textContent = "Refresh";
    }
  }

  function serverToolbarMarkup() {
    return `
      <h3>Server actions</h3>
      <p>Add Java servers, then choose which account Quick Join uses.</p>
      <div class="enhancement-actions">
        <button data-add-server="true" type="button">Add server</button>
      </div>
    `;
  }

  function removeServerPageActions() {
    document.querySelector("[data-top-add-server]")?.remove();
  }

  async function quickJoin(serverId, accountId) {
    const state = readState();
    const server = state.servers.find((item) => item.id === serverId);
    const account = state.accounts.find((item) => item.id === accountId);
    if (!server || !account) return;

    const profile = state.profiles.find((item) => item.edition === "java");
    if (!profile) {
      window.alert("No Java profile exists to quick join with.");
      return;
    }

    const payload = {
      name: profile.name,
      version: profile.version,
      loader: profile.loader,
      accountName: account.displayName,
      javaPath: profile.javaPath,
      gameDir: profile.folder,
      ramMin: profile.ramMin,
      ramMax: profile.ramMax,
      jvmArgs: profile.jvmArgs,
      launchArgs: profile.launchArgs,
      width: profile.width,
      height: profile.height,
      fullscreen: profile.fullscreen,
      server: server.address
    };

    server.accountId = accountId;
    profile.quickJoinServer = server.address;
    profile.accountId = accountId;
    writeState(state);

    try {
      const result = await window.launcherApi.launchProfile(payload);
      window.alert(result.ok ? `Launching ${server.name} as ${account.displayName}.` : result.message);
    } catch (error) {
      window.alert(`Quick join failed: ${error?.message || String(error)}`);
    }
  }

  function clearInstances(mode) {
    const state = readState();
    state.runningInstances =
      mode === "stopped" ? state.runningInstances.filter((instance) => instance.status !== "stopped") : [];
    writeState(state);
    reloadKeepingPage();
  }

  async function killInstance(instanceId) {
    const button = document.querySelector(`[data-kill-instance="${instanceId}"]`);
    if (button) {
      button.disabled = true;
      button.textContent = "Stopping...";
    }

    try {
      const result = await window.launcherApi?.killInstance?.(instanceId);
      if (result && !result.ok) window.alert(result.message);
    } catch (error) {
      window.alert(`Kill failed: ${error?.message || String(error)}`);
    }
    document.querySelector(`[data-live-instance="${instanceId}"]`)?.remove();
    enhanceInstances();
  }

  function markInstanceStopped(instanceId) {
    const killButton = document.querySelector(`[data-kill-instance="${instanceId}"]`);
    const deleteButton = document.querySelector(`[data-delete-instance="${instanceId}"]`);
    const row = killButton ? killButton.closest(".instance-row") : deleteButton?.closest(".instance-row");
    killButton?.remove();
    if (deleteButton) {
      deleteButton.disabled = false;
      deleteButton.title = "Delete stopped instance";
    }
    const badge = row ? Array.from(row.querySelectorAll(".status-badge")).at(-1) : null;
    if (badge) {
      badge.className = "status-badge stopped";
      badge.textContent = "stopped";
    }
  }

  function enhanceAccounts() {
    if (!document.body.textContent.includes("Account Manager")) return;
    const grid = document.querySelector(".accounts-grid");
    if (!grid) return;

    document.querySelectorAll(".account-card.add-card:not([data-blockforge-account-tools])").forEach((card) => {
      card.style.display = "none";
    });

    if (!document.querySelector("[data-blockforge-account-toolbar]")) {
      const toolbar = document.createElement("section");
      toolbar.className = "account-toolbar panel";
      toolbar.dataset.blockforgeAccountToolbar = "true";
      toolbar.innerHTML = `
        <h3>Account actions</h3>
        <p>Microsoft Java is for owned Java Edition accounts. Offline accounts are for testing.</p>
        <div class="enhancement-actions">
          <button data-add-microsoft-java="true" type="button">Add Microsoft Java</button>
          <button data-add-account="java" type="button">Add Java offline</button>
        </div>
      `;
      grid.prepend(toolbar);
    }

    const accounts = readState().accounts;
    Array.from(grid.querySelectorAll(".account-card:not(.add-card):not(.account-toolbar)")).forEach((card, index) => {
      if (card.dataset.blockforgeAccountEnhanced) return;
      const account = accounts[index];
      if (!account) return;
      card.dataset.blockforgeAccountEnhanced = "true";

      const info = card.querySelector("p");
      if (info) info.textContent = account.email || account.identifier || "Offline/dev account";

      if (account.kind === "java") {
        const detail = document.createElement("div");
        detail.className = "account-extra";
        const silentReauth = accountCanSilentReauth(account);
        detail.innerHTML = `
          <span class="${silentReauth ? "reauth-ok" : "reauth-due"}">${reauthText(account)}</span>
          <button data-view-skin="${account.id}" type="button">3D skin</button>
          <button data-change-skin="true" type="button">Change skin</button>
          ${silentReauth
            ? `<button data-reauth-account="${account.id}" type="button">Reauth</button>`
            : `<button data-add-microsoft-java="true" type="button">Upgrade login</button>`}
        `;
        card.appendChild(detail);
      }

      const actions = document.createElement("div");
      actions.className = "enhancement-actions account-actions";
      actions.innerHTML = `<button data-delete-account="${account.id}" type="button">Delete</button>`;
      card.appendChild(actions);
    });
  }

  function enhanceServers() {
    if (currentPageTitle() !== "Servers") {
      removeServerPageActions();
      return;
    }
    let serverGrid = document.querySelector(".server-grid");
    if (!serverGrid) {
      const fallbackGrid = document.createElement("div");
      fallbackGrid.className = "server-grid";
      document.querySelector(".main")?.appendChild(fallbackGrid);
      serverGrid = fallbackGrid;
    }

    if (!document.querySelector("[data-blockforge-server-toolbar]")) {
      const toolbar = document.createElement("section");
      toolbar.className = "server-toolbar panel";
      toolbar.dataset.blockforgeServerToolbar = "true";
      toolbar.innerHTML = serverToolbarMarkup();
      serverGrid.prepend(toolbar);
    }

    const topActions = document.querySelector(".top-actions");
    if (topActions && !document.querySelector("[data-top-add-server]")) {
      const addButton = document.createElement("button");
      addButton.className = "secondary-button";
      addButton.dataset.addServer = "true";
      addButton.dataset.topAddServer = "true";
      addButton.type = "button";
      addButton.textContent = "Add server";
      topActions.prepend(addButton);
    }

    const edition = currentEdition();
    const state = readState();
    const servers = state.servers.filter((server) => server.edition === edition);
    const accounts = state.accounts.filter((account) => account.kind === edition);

    if (!servers.length && !document.querySelector("[data-blockforge-empty-servers]")) {
      const empty = document.createElement("section");
      empty.className = "server-card empty-server-card";
      empty.dataset.blockforgeEmptyServers = "true";
      empty.innerHTML = `
        <div class="panel-head"><h3>No saved Java servers</h3></div>
        <p>Add a server to make it appear here.</p>
        <button class="primary-button" data-add-server="true" type="button">Add server</button>
      `;
      serverGrid.appendChild(empty);
    }

    Array.from(serverGrid.querySelectorAll(".server-card")).forEach((card, index) => {
      if (card.dataset.blockforgeEmptyServers) return;
      const server = findServerForCard(card, servers, index);
      if (!server) return;
      card.dataset.blockforgeServerEnhanced = "true";
      card.dataset.serverCardId = server.id;
      const description = card.querySelector("p");
      if (description) description.textContent = server.motd || "Checking server status...";
      const playerLabel = card.querySelector("footer span");
      if (playerLabel) playerLabel.textContent = server.players || "?";
      const address = card.querySelector(".server-address");
      if (address) address.textContent = server.address;

      if (!card.querySelector("[data-server-details]")) {
        const details = document.createElement("div");
        details.className = "server-details";
        details.dataset.serverDetails = "true";
        card.insertBefore(details, card.querySelector("footer"));
      }
      renderServerDetails(server.id, server);

      if (!card.querySelector(".server-extra")) {
        const controls = document.createElement("div");
        controls.className = "server-extra";
        controls.innerHTML = `
          <label>Quick Join account
            <select data-server-account="${server.id}">
              ${accounts
                .map(
                  (account) =>
                    `<option value="${account.id}" ${server.accountId === account.id ? "selected" : ""}>${account.displayName}</option>`
                )
                .join("")}
            </select>
          </label>
          <button data-quick-join="${server.id}" type="button">Quick Join</button>
          <button data-refresh-server="${server.id}" type="button">Refresh</button>
          <button data-delete-server="${server.id}" type="button">Delete</button>
        `;
        card.appendChild(controls);
      }

      if (!server.checkedAt || server.status === "checking" || /^Checking server status/i.test(server.motd || "")) {
        refreshServerStatus(server.id, true);
      }
    });
  }

  function findServerForCard(card, servers, index) {
    const address = card.querySelector(".server-address")?.textContent?.trim()?.toLowerCase();
    const title = card.querySelector("h3")?.textContent?.trim()?.toLowerCase();
    return (
      servers.find((server) => server.address?.toLowerCase() === address) ||
      servers.find((server) => server.name?.toLowerCase() === title) ||
      servers[index]
    );
  }

  function enhanceDownloads() {
    if (currentPageTitle() !== "Download Queue") return;
    const stack = document.querySelector(".download-stack");
    if (!stack || stack.dataset.blockforgeDownloadEnhanced) return;
    stack.dataset.blockforgeDownloadEnhanced = "true";
    stack.innerHTML = `
      <section class="download-card">
        <div class="panel-head"><h3>No real active downloads</h3><span class="status-badge stopped">idle</span></div>
        <p>Real Minecraft downloads currently appear in the launch console. This queue will be wired to backend progress later.</p>
        <div class="progress"><span style="width:0%"></span></div>
      </section>
    `;
  }

  function enhanceDiscover() {
    if (!isDiscoverPage()) {
      document.querySelector("[data-blockforge-mod-browser]")?.remove();
      const hiddenView = document.querySelector(".view-stack[style]");
      if (hiddenView) hiddenView.style.display = "";
      return;
    }
    const main = document.querySelector(".main");
    if (!main || document.querySelector("[data-blockforge-mod-browser]")) return;
    const existing = document.querySelector(".view-stack");
    if (existing) existing.style.display = "none";

    const browser = document.createElement("section");
    const targetProfile = selectedJavaProfile();
    browser.className = "mod-browser";
    browser.dataset.blockforgeModBrowser = "true";
    browser.innerHTML = `
      <section class="toolbar-panel mod-browser-toolbar">
        <label>Source
          <select data-mod-source>
            <option value="modrinth">Modrinth</option>
            <option value="curseforge">CurseForge</option>
          </select>
        </label>
        <label>Search
          <input data-mod-query placeholder="Search mods, packs, shaders..." />
        </label>
        <label>Type
          <select data-mod-type>
            <option value="mod">Mods</option>
            <option value="modpack">Modpacks</option>
            <option value="resourcepack">Resource packs</option>
            <option value="shader">Shaders</option>
          </select>
        </label>
        <label>Version
          <input data-mod-version value="${escapeHtml(targetProfile?.version || "1.21.8")}" />
        </label>
        <label>Loader
          <select data-mod-loader>
            <option value="any">Any</option>
            ${["fabric", "forge", "quilt", "neoforge"].map((loader) => `<option value="${loader}" ${String(targetProfile?.loader || "").toLowerCase() === loader ? "selected" : ""}>${loader[0].toUpperCase() + loader.slice(1)}</option>`).join("")}
          </select>
        </label>
        <button class="primary-button" data-search-mods type="button">Search</button>
      </section>
      <section class="panel mod-target" data-mod-target>
        Installing into: <strong>${escapeHtml(targetProfile?.name || "No Java profile selected")}</strong>
        <span>${escapeHtml(targetProfile ? `${targetProfile.loader} ${targetProfile.version}` : "Create/select an instance in Library first.")}</span>
      </section>
      <section class="panel curseforge-key" data-curseforge-key-panel hidden>
        <h3>CurseForge API key</h3>
        <p>CurseForge search requires an API key. Modrinth works without one.</p>
        <div class="curseforge-key-row">
          <input data-curseforge-key placeholder="Paste CurseForge API key" type="password" />
          <button class="secondary-button" data-save-curseforge-key type="button">Save key</button>
        </div>
      </section>
      <section class="panel mod-browser-status" data-mod-status>Pick filters and search live projects.</section>
      <section class="project-grid" data-mod-results></section>
    `;
    main.appendChild(browser);
    browser.querySelector("[data-curseforge-key]").value = localStorage.getItem("blockforge/curseforge-api-key") || "";
    browser.querySelector("[data-mod-source]").addEventListener("change", updateCurseForgeKeyPanel);
    browser.querySelector("[data-search-mods]").addEventListener("click", (event) => {
      event.preventDefault();
      searchMods();
    });
    browser.querySelectorAll("[data-mod-query], [data-mod-version]").forEach((input) => {
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          searchMods();
        }
      });
    });
    updateCurseForgeKeyPanel();
  }

  function enhanceFeatureNotices() {
    const title = currentPageTitle();
    document.querySelector("[data-bedrock-notice]")?.remove();

    if (title === "Download Queue" && !document.querySelector("[data-update-notice]")) {
      const stack = document.querySelector(".download-stack");
      const notice = document.createElement("section");
      notice.className = "panel feature-notice";
      notice.dataset.updateNotice = "true";
      const updateMessage = launcherUpdateState?.message || "Checks GitHub Releases for newer BlockBaseMC builds.";
      notice.innerHTML = `
        <h3>Launcher updates</h3>
        <p>${escapeHtml(updateMessage)}</p>
        <div class="enhancement-actions">
          <button data-check-updates="true" type="button">Check updates</button>
          <button data-open-update="https://github.com/itz-me-fisherYT/BlockBase-Launcher/releases/latest" type="button">Latest release</button>
        </div>
      `;
      stack?.before(notice);
    }
    if (title !== "Download Queue") document.querySelector("[data-update-notice]")?.remove();
  }

  function removeBedrockUi() {
    document.querySelectorAll(".edition-switch button").forEach((button) => {
      const text = button.textContent.trim().toLowerCase();
      if (text.includes("bedrock")) button.style.display = "none";
      if (text.includes("java")) button.classList.add("active");
    });
    document.querySelectorAll(".brand span").forEach((span) => {
      if (span.textContent.includes("Java + Bedrock")) span.textContent = "Java Edition";
    });
    document.querySelectorAll(".eyebrow").forEach((item) => {
      if (item.textContent.includes("BEDROCK")) item.textContent = "JAVA EDITION WORKSPACE";
    });
    document.querySelectorAll("h1,h2,h3,p,span").forEach((item) => {
      if (item.childElementCount === 0 && item.textContent.includes("Bedrock")) {
        item.textContent = item.textContent.replace(/Bedrock/g, "Java");
      }
    });
  }

  function updateCurseForgeKeyPanel() {
    const source = document.querySelector("[data-mod-source]")?.value;
    const panel = document.querySelector("[data-curseforge-key-panel]");
    if (panel) panel.hidden = source !== "curseforge";
  }

  async function searchMods() {
    const status = document.querySelector("[data-mod-status]");
    const results = document.querySelector("[data-mod-results]");
    const button = document.querySelector("[data-search-mods]");
    if (!status || !results) return;
    const options = {
      source: document.querySelector("[data-mod-source]")?.value || "modrinth",
      query: document.querySelector("[data-mod-query]")?.value || "",
      type: document.querySelector("[data-mod-type]")?.value || "mod",
      version: document.querySelector("[data-mod-version]")?.value || "",
      loader: document.querySelector("[data-mod-loader]")?.value || "any",
      apiKey: localStorage.getItem("blockforge/curseforge-api-key") || "",
      limit: 20
    };

    status.textContent = `Searching ${options.source === "curseforge" ? "CurseForge" : "Modrinth"}...`;
    results.innerHTML = "";
    if (button) {
      button.disabled = true;
      button.textContent = "Searching...";
    }

    try {
      const response = window.launcherApi?.searchMods
        ? await window.launcherApi.searchMods(options)
        : await searchModrinthInRenderer(options);
      if (response?.needsApiKey) {
        status.textContent = response.message || "CurseForge needs an API key.";
        updateCurseForgeKeyPanel();
        return;
      }
      const projects = response?.results || [];
      status.textContent = projects.length
        ? `Found ${projects.length} ${response.source === "curseforge" ? "CurseForge" : "Modrinth"} projects.`
        : "No projects found.";
      results.innerHTML = projects.map(projectCardMarkup).join("");
    } catch (error) {
      status.textContent = `Search failed: ${error?.message || String(error)}`;
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = "Search";
      }
    }
  }

  async function searchModrinthInRenderer(options) {
    if (options.source === "curseforge") {
      return {
        source: "curseforge",
        needsApiKey: true,
        results: [],
        message: "CurseForge needs the backend and an API key. Use Modrinth for now."
      };
    }
    const facets = [];
    if (options.type && options.type !== "all") facets.push([`project_type:${options.type}`]);
    if (options.version) facets.push([`versions:${options.version}`]);
    if (options.loader && options.loader !== "any") facets.push([`categories:${options.loader}`]);
    const params = new URLSearchParams({
      query: options.query || "",
      limit: "20",
      index: "relevance"
    });
    if (facets.length) params.set("facets", JSON.stringify(facets));
    const response = await fetch(`https://api.modrinth.com/v2/search?${params}`);
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json.description || json.error || `Modrinth failed: ${response.status}`);
    return {
      source: "modrinth",
      results: (json.hits || []).map((project) => ({
        id: project.project_id,
        slug: project.slug,
        title: project.title,
        author: project.author,
        description: project.description,
        type: project.project_type,
        icon: project.icon_url,
        downloads: project.downloads,
        versions: project.versions || [],
        categories: project.display_categories || project.categories || [],
        url: `https://modrinth.com/${project.project_type}/${project.slug}`
      }))
    };
  }

  function projectCardMarkup(project) {
    const icon = project.icon
      ? `<img class="project-api-icon" src="${project.icon}" alt="" />`
      : `<div class="project-api-icon project-api-fallback">${initials(project.title)}</div>`;
    const versions = (project.versions || []).slice(0, 4).join(", ");
    const categories = (project.categories || []).slice(0, 4).join(", ");
    const payload = encodeURIComponent(JSON.stringify(project));
    return `
      <article class="project-card api-project-card">
        ${icon}
        <span>${project.type || "project"} · ${project.author || "Unknown author"}</span>
        <h3>${escapeHtml(project.title || "Untitled")}</h3>
        <p>${escapeHtml(project.description || "No description")}</p>
        <div class="tag-row">
          ${versions ? `<small>${escapeHtml(versions)}</small>` : ""}
          ${categories ? `<small>${escapeHtml(categories)}</small>` : ""}
        </div>
        <footer>
          <strong>${formatCompact(project.downloads || 0)} downloads</strong>
          <span class="project-actions">
            <button data-install-project="${payload}" type="button">Install</button>
            <button data-open-project="${escapeHtml(project.url || "")}" type="button">Open page</button>
          </span>
        </footer>
      </article>
    `;
  }

  async function installProject(encodedProject) {
    const status = document.querySelector("[data-mod-status]");
    const project = JSON.parse(decodeURIComponent(encodedProject));
    const profile = selectedJavaProfile();
    if (!profile) {
      window.alert("Create or select a Java instance in Library first.");
      return;
    }
    const options = {
      source: document.querySelector("[data-mod-source]")?.value || project.source || "modrinth",
      project,
      profile,
      type: document.querySelector("[data-mod-type]")?.value || project.type || "mod",
      version: document.querySelector("[data-mod-version]")?.value || profile.version,
      loader: document.querySelector("[data-mod-loader]")?.value || profile.loader,
      apiKey: localStorage.getItem("blockforge/curseforge-api-key") || ""
    };
    if (status) status.textContent = `Installing ${project.title || project.slug} into ${profile.name}...`;
    try {
      const result = await window.launcherApi?.installProject?.(options);
      const message = result?.message || `Installed ${project.title || project.slug}.`;
      if (result?.profile) {
        const state = readState();
        const account = state.accounts.find((item) => item.kind === "java" && item.default) ||
          state.accounts.find((item) => item.kind === "java");
        state.profiles = [
          { ...result.profile, accountId: account?.id || result.profile.accountId || "" },
          ...state.profiles.filter((item) => item.id !== result.profile.id)
        ];
        writeState(state);
      }
      if (status) status.textContent = message;
      window.alert(message);
      refreshInstalledContent();
      if (result?.profile) reloadKeepingPage();
    } catch (error) {
      const message = `Install failed: ${error?.message || String(error)}`;
      if (status) status.textContent = message;
      window.alert(message);
    }
  }

  function formatCompact(value) {
    return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(Number(value || 0));
  }

  function isModsPage() {
    const title = currentPageTitle().toLowerCase();
    return title.includes("mods") || title.includes("resource packs");
  }

  function enhanceModsManager() {
    if (!isModsPage()) {
      document.querySelector("[data-blockforge-content-manager]")?.remove();
      const hiddenView = document.querySelector(".view-grid[style]");
      if (hiddenView) hiddenView.style.display = "";
      return;
    }
    const main = document.querySelector(".main");
    if (!main || document.querySelector("[data-blockforge-content-manager]")) return;
    const existing = document.querySelector(".view-grid");
    if (existing) existing.style.display = "none";
    const profile = selectedJavaProfile();
    const manager = document.createElement("section");
    manager.className = "content-manager";
    manager.dataset.blockforgeContentManager = "true";
    manager.innerHTML = `
      <section class="panel content-manager-head">
        <div>
          <span class="eyebrow">Selected instance</span>
          <h3>${escapeHtml(profile?.name || "No Java profile selected")}</h3>
          <p>${escapeHtml(profile ? `${profile.loader} ${profile.version}` : "Create/select an instance in Library first.")}</p>
        </div>
        <div class="enhancement-actions">
          <button data-refresh-content type="button">Refresh</button>
          <button data-open-content-folder="mods" type="button">Open mods</button>
          <button data-open-content-folder="resourcepacks" type="button">Open packs</button>
          <button data-open-content-folder="shaderpacks" type="button">Open shaders</button>
        </div>
      </section>
      <section class="panel content-tabs">
        <button class="active" data-content-filter="all" type="button">All</button>
        <button data-content-filter="mod" type="button">Mods</button>
        <button data-content-filter="resourcepack" type="button">Resource packs</button>
        <button data-content-filter="shader" type="button">Shaders</button>
        <button data-content-filter="disabled" type="button">Disabled</button>
      </section>
      <section class="panel mod-browser-status" data-content-status>Loading installed content...</section>
      <section class="table-list content-table" data-content-list></section>
    `;
    main.appendChild(manager);
    refreshInstalledContent();
  }

  async function refreshInstalledContent() {
    const list = document.querySelector("[data-content-list]");
    const status = document.querySelector("[data-content-status]");
    if (!list || !status) return;
    const profile = selectedJavaProfile();
    if (!profile) {
      status.textContent = "No Java instance selected.";
      list.innerHTML = "";
      return;
    }
    status.textContent = "Reading installed content...";
    try {
      const response = await window.launcherApi?.listProfileContent?.(profile);
      const items = response?.items || [];
      window.blockforgeContentItems = items;
      window.blockforgeContentGameDir = response?.gameDir || "";
      renderContentItems();
      status.textContent = items.length
        ? `${items.length} files in ${profile.name}.`
        : `No mods, resource packs, or shaders installed in ${profile.name}.`;
    } catch (error) {
      status.textContent = `Could not read installed content: ${error?.message || String(error)}`;
    }
  }

  function renderContentItems() {
    const list = document.querySelector("[data-content-list]");
    if (!list) return;
    const active = document.querySelector("[data-content-filter].active")?.dataset.contentFilter || "all";
    const items = (window.blockforgeContentItems || []).filter((item) => {
      if (active === "all") return true;
      if (active === "disabled") return !item.enabled;
      return item.type === active;
    });
    list.innerHTML = items.length ? items.map(contentRowMarkup).join("") : `<div class="content-empty">Nothing matching this filter.</div>`;
  }

  function contentRowMarkup(item) {
    const payload = encodeURIComponent(JSON.stringify(item));
    return `
      <div class="table-row content-row">
        <strong>${escapeHtml(item.name || item.fileName)}</strong>
        <span>${escapeHtml(contentTypeLabel(item.type))}</span>
        <span>${escapeHtml(item.enabled ? "Enabled" : "Disabled")}</span>
        <span>${escapeHtml(formatBytes(item.size))}</span>
        <button data-toggle-content="${payload}" type="button">${item.enabled ? "Disable" : "Enable"}</button>
        <button class="enhancement-delete" data-delete-content="${payload}" type="button">Delete</button>
      </div>
    `;
  }

  async function toggleContent(encodedItem) {
    const profile = selectedJavaProfile();
    if (!profile) return;
    const item = JSON.parse(decodeURIComponent(encodedItem));
    try {
      await window.launcherApi?.toggleProfileContent?.({ profile, item });
      refreshInstalledContent();
    } catch (error) {
      window.alert(`Could not toggle ${item.fileName}: ${error?.message || String(error)}`);
    }
  }

  async function deleteContent(encodedItem) {
    const profile = selectedJavaProfile();
    if (!profile) return;
    const item = JSON.parse(decodeURIComponent(encodedItem));
    if (!window.confirm(`Delete ${item.fileName}?`)) return;
    try {
      await window.launcherApi?.deleteProfileContent?.({ profile, item });
      refreshInstalledContent();
    } catch (error) {
      window.alert(`Could not delete ${item.fileName}: ${error?.message || String(error)}`);
    }
  }

  async function openContentFolder(folder) {
    const profile = selectedJavaProfile();
    if (!profile) return;
    const base = window.blockforgeContentGameDir || profile.gameDir || profile.folder || "";
    const target = /^[a-zA-Z]:[\\/]/.test(base) || base.startsWith("\\\\")
      ? `${base}\\${folder}`
      : `${base}/${folder}`;
    await window.launcherApi?.openPath?.(target);
  }

  function contentTypeLabel(type) {
    return {
      mod: "Mod",
      resourcepack: "Resource pack",
      shader: "Shader"
    }[type] || "File";
  }

  function formatBytes(value) {
    const bytes = Number(value || 0);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[char]));
  }

  function enhanceStatusBar() {
    const statusItems = Array.from(document.querySelectorAll(".statusbar span"));
    const msItem = statusItems.find((item) => item.textContent.includes("Microsoft sign-in: not connected"));
    if (msItem) {
      const hasMicrosoft = readState().accounts.some((account) => account.kind === "java" && account.id.startsWith("java-ms-"));
      msItem.lastChild.textContent = hasMicrosoft ? " Accounts: Microsoft ready" : " Accounts: offline/dev ready";
    }
  }

  async function enhanceInstances() {
    if (currentPageTitle() !== "Running Instances") return;
    const panelHead = document.querySelector(".panel .panel-head");
    if (panelHead && !document.querySelector("[data-blockforge-instance-tools]")) {
      const tools = document.createElement("div");
      tools.className = "enhancement-actions";
      tools.dataset.blockforgeInstanceTools = "true";
      tools.innerHTML = `
        <button data-clear-instances="stopped" type="button">Clear stopped</button>
        <button data-clear-instances="all" type="button">Delete all</button>
      `;
      panelHead.appendChild(tools);
    }

    const list = document.querySelector(".table-list") || document.querySelector(".panel");
    if (!list) return;
    let instances = [];
    try {
      instances = await window.launcherApi?.runningInstances?.() || [];
    } catch {
      instances = [];
    }
    renderLiveInstances(list, instances);
  }

  function renderLiveInstances(container, instances) {
    const live = instances.filter((instance) => instance.status === "running");
    container.querySelectorAll(".instance-row").forEach((row) => row.remove());
    container.querySelector("[data-live-empty]")?.remove();
    if (!live.length) {
      const empty = document.createElement("div");
      empty.className = "panel";
      empty.dataset.liveEmpty = "true";
      empty.textContent = "No running Java instances.";
      container.appendChild(empty);
      return;
    }
    live.forEach((instance) => {
      const row = document.createElement("div");
      row.className = "table-row instance-row";
      row.dataset.liveInstance = instance.id;
      row.innerHTML = `
        <span class="status-badge running">running</span>
        <strong>${escapeHtml(instance.profileName)} <small>${escapeHtml(instance.account || "Player")}</small></strong>
        <span>PID ${instance.pid || "?"}</span>
        <span>${formatUptime(instance.uptimeMs)}</span>
        <button class="secondary-button" data-open-log="${escapeHtml(instance.logFile || "")}" type="button">Open logs</button>
        <button class="secondary-button" data-open-folder="${escapeHtml(instance.gameDir || "")}" type="button">Folder</button>
        <button class="enhancement-kill" data-kill-instance="${escapeHtml(instance.id)}" type="button">Kill</button>
      `;
      container.appendChild(row);
    });
  }

  function formatUptime(ms) {
    const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}m ${seconds}s`;
  }

  function enhanceLibrary() {
    if (currentPageTitle() !== "Instances") {
      document.querySelector("[data-prism-library]")?.remove();
      document.querySelector("[data-import-tools]")?.remove();
      return;
    }
    if (currentPageTitle() === "Instances") enhancePrismLibrary();
    if (currentPageTitle() === "Instances") enhanceImportTools();
    if (currentPageTitle() === "Instances") enhanceVersionDropdown();
    if (currentPageTitle() === "Instances") enhanceGameFolderButton();
    const loaderLabel = Array.from(document.querySelectorAll("label")).find((label) =>
      label.textContent.trim().startsWith("Loader")
    );
    const loaderSelect = loaderLabel?.querySelector("select");
    if (!loaderSelect || loaderSelect.dataset.blockforgeHint) return;
    loaderSelect.dataset.blockforgeHint = "true";
    const hint = document.createElement("small");
    hint.className = "enhancement-hint";
    hint.textContent =
      "Vanilla, Snapshot, Fabric, Quilt, Forge, and NeoForge can launch when upstream metadata exists for the selected version.";
    loaderSelect.parentElement.appendChild(hint);
  }

  function enhanceGameFolderButton() {
    const label = Array.from(document.querySelectorAll(".config-panel label")).find((item) =>
      item.textContent.trim().startsWith("Game folder")
    );
    const input = label?.querySelector("input");
    if (!label || !input || label.dataset.blockforgeOpenFolder) return;
    label.dataset.blockforgeOpenFolder = "true";
    const row = document.createElement("div");
    row.className = "game-folder-row";
    input.after(row);
    row.appendChild(input);
    row.insertAdjacentHTML("beforeend", `<button class="secondary-button" data-open-game-folder type="button">Open</button>`);
  }

  async function openSelectedGameFolder() {
    const profile = selectedJavaProfile();
    if (!profile) return;
    const input = document.querySelector(".config-panel label[data-blockforge-open-folder] input");
    const folder = input?.value || profile.gameDir || profile.folder || "";
    if (!folder) return;
    try {
      await window.launcherApi?.openPath?.(folder);
    } catch (error) {
      window.alert(`Could not open folder: ${error?.message || String(error)}`);
    }
  }

  function versionMatchesFilters(version, filters) {
    if (!version?.id) return false;
    const text = `${version.id} ${version.type || ""}`.toLowerCase();
    if (filters.search && !text.includes(filters.search.toLowerCase())) return false;
    if (version.type === "release" && !filters.releases) return false;
    if (version.type === "snapshot" && !filters.snapshots) return false;
    if (!["release", "snapshot"].includes(version.type) && !filters.experiments) return false;
    return true;
  }

  async function loadMinecraftVersions() {
    if (minecraftVersionCache) return minecraftVersionCache;
    const data = await window.launcherApi?.minecraftVersions?.();
    minecraftVersionCache = data?.versions || [];
    return minecraftVersionCache;
  }

  function enhancePrismLibrary() {
    if (document.querySelector("[data-prism-library]")) return;
    const main = document.querySelector(".main");
    const grid = document.querySelector(".library-grid");
    if (!main || !grid) return;
    const selected = selectedJavaProfile() || makeDefaultProfile("java");
    const accountOptions = readState().accounts
      .filter((account) => account.kind === "java")
      .map((account) => `<option value="${account.id}" ${account.id === selected.accountId ? "selected" : ""}>${escapeHtml(account.displayName)}</option>`)
      .join("");
    const builder = document.createElement("section");
    builder.className = "prism-library";
    builder.dataset.prismLibrary = "true";
    builder.innerHTML = `
      <aside class="prism-sources">
        <button class="active" data-prism-source="custom" type="button">Custom</button>
        <button data-prism-source="zip" type="button">Import from ZIP</button>
        <button data-prism-source="minecraft" type="button">Import .minecraft</button>
        <button data-prism-source="prism" type="button">Prism / MultiMC</button>
        <button data-prism-source="modrinth" type="button">Modrinth</button>
        <button data-prism-source="curseforge" type="button">CurseForge</button>
      </aside>
      <div class="prism-create">
        <div class="prism-create-head">
          <div>
            <h3 data-prism-source-title>New Java instance</h3>
            <p class="enhancement-hint" data-prism-source-description>Pick a version, loader, account, then create. No hidden rollback.</p>
          </div>
          <div class="prism-actions">
            <button class="secondary-button" data-update-selected-profile data-custom-action type="button">Update selected</button>
            <button class="primary-button" data-create-prism-profile data-custom-action type="button">Create instance</button>
            <button class="primary-button" data-run-source-import hidden type="button">Choose file/folder</button>
          </div>
        </div>
        <div class="prism-form">
          <label>Name <input data-prism-name value="${escapeHtml(selected.name || "New Java Profile")}" /></label>
          <label>Group <input data-prism-group placeholder="No group" value="${escapeHtml(selected.group || "")}" /></label>
          <label>Loader
            <select data-prism-loader>
              ${["Vanilla", "Snapshot", "Fabric", "Quilt", "Forge", "NeoForge"].map((loader) => `<option ${selected.loader === loader ? "selected" : ""}>${loader}</option>`).join("")}
            </select>
          </label>
          <label>Account
            <select data-prism-account>
              <option value="">No account selected</option>
              ${accountOptions}
            </select>
          </label>
        </div>
        <div class="prism-browser">
          <div class="prism-table-wrap">
            <table class="prism-version-table">
              <thead><tr><th>Version</th><th>Released</th><th>Type</th></tr></thead>
              <tbody data-prism-versions><tr><td colspan="3">Loading versions...</td></tr></tbody>
            </table>
            <input data-prism-search placeholder="Search versions" />
          </div>
          <div class="prism-filter">
            <strong>Filter</strong>
            <label><input data-prism-filter="releases" type="checkbox" checked /> Releases</label>
            <label><input data-prism-filter="snapshots" type="checkbox" /> Snapshots</label>
            <label><input data-prism-filter="experiments" type="checkbox" /> Experiments</label>
            <button class="secondary-button" data-refresh-prism-versions type="button">Refresh</button>
          </div>
        </div>
      </div>
    `;
    grid.before(builder);
    renderPrismVersions(selected.version || "1.21.8");
  }

  async function renderPrismVersions(selectedVersion) {
    const table = document.querySelector("[data-prism-versions]");
    if (!table) return;
    try {
      const versions = await loadMinecraftVersions();
      const filters = {
        search: document.querySelector("[data-prism-search]")?.value || "",
        releases: document.querySelector('[data-prism-filter="releases"]')?.checked ?? true,
        snapshots: document.querySelector('[data-prism-filter="snapshots"]')?.checked ?? false,
        experiments: document.querySelector('[data-prism-filter="experiments"]')?.checked ?? false
      };
      const rows = versions.filter((version) => versionMatchesFilters(version, filters)).slice(0, 160);
      table.innerHTML = rows.map((version) => `
        <tr class="${version.id === selectedVersion ? "active" : ""}" data-prism-version="${escapeHtml(version.id)}">
          <td>${escapeHtml(version.id)}</td>
          <td>${escapeHtml((version.releaseTime || "").slice(0, 10))}</td>
          <td>${escapeHtml(version.type || "")}</td>
        </tr>
      `).join("") || `<tr><td colspan="3">No versions match.</td></tr>`;
    } catch (error) {
      table.innerHTML = `<tr><td colspan="3">Version list failed: ${escapeHtml(error?.message || String(error))}</td></tr>`;
    }
  }

  function selectPrismSource(source) {
    const sources = {
      custom: {
        title: "New Java instance",
        description: "Pick a version, loader, account, then create. No hidden rollback.",
        importMode: ""
      },
      zip: {
        title: "Import from ZIP",
        description: "Import a generic ZIP, Modrinth .mrpack, or CurseForge ZIP. BlockBaseMC will detect known manifests automatically.",
        importMode: "zip"
      },
      minecraft: {
        title: "Import .minecraft",
        description: "Pick an existing .minecraft folder and BlockBaseMC will copy mods, saves, configs, packs, screenshots, options, and servers.",
        importMode: "minecraft"
      },
      prism: {
        title: "Import Prism / MultiMC",
        description: "Pick a Prism or MultiMC instance folder. BlockBaseMC reads mmc-pack metadata and imports the instance's minecraft folder.",
        importMode: "prism"
      },
      modrinth: {
        title: "Import Modrinth pack",
        description: "Pick a .mrpack file. BlockBaseMC extracts overrides, downloads pack files, and creates the matching loader profile.",
        importMode: "modrinth"
      },
      curseforge: {
        title: "Import CurseForge pack",
        description: "Pick a CurseForge ZIP. Overrides are imported, and manifest downloads run when your CurseForge API key is saved.",
        importMode: "curseforge"
      }
    };
    const entry = sources[source] || sources.custom;
    document.querySelectorAll("[data-prism-source]").forEach((button) => {
      button.classList.toggle("active", button.dataset.prismSource === source);
    });
    const title = document.querySelector("[data-prism-source-title]");
    const description = document.querySelector("[data-prism-source-description]");
    if (title) title.textContent = entry.title;
    if (description) description.textContent = entry.description;
    document.querySelectorAll("[data-custom-action]").forEach((button) => {
      button.hidden = Boolean(entry.importMode);
    });
    const importButton = document.querySelector("[data-run-source-import]");
    if (importButton) {
      importButton.hidden = !entry.importMode;
      importButton.dataset.importMinecraft = entry.importMode;
      importButton.textContent = source === "minecraft" || source === "prism" ? "Choose folder" : "Choose file";
    }
  }

  function selectedPrismVersion() {
    return document.querySelector("[data-prism-version].active")?.dataset.prismVersion ||
      selectedJavaProfile()?.version || "1.21.8";
  }

  function prismProfilePayload() {
    const base = makeDefaultProfile("java");
    const account = document.querySelector("[data-prism-account]")?.value || "";
    const loader = document.querySelector("[data-prism-loader]")?.value || "Vanilla";
    const version = selectedPrismVersion();
    const name = document.querySelector("[data-prism-name]")?.value?.trim() || `${loader} ${version}`;
    return {
      ...base,
      name,
      version,
      loader,
      accountId: account,
      group: document.querySelector("[data-prism-group]")?.value?.trim() || "",
      banner: `${loader} ${version}`,
      folder: `.blockbasemc/java/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 28) || base.id.slice(0, 8)}`
    };
  }

  function createPrismProfile() {
    const profile = prismProfilePayload();
    const state = readState();
    state.profiles = [profile, ...state.profiles];
    writeState(state);
    reloadKeepingPage();
  }

  function updateSelectedPrismProfile() {
    const payload = prismProfilePayload();
    const ok = patchSelectedProfile({
      name: payload.name,
      version: payload.version,
      loader: payload.loader,
      accountId: payload.accountId,
      group: payload.group,
      banner: payload.banner
    });
    if (ok) reloadKeepingPage();
  }

  function applyCustomTheme() {
    const theme = JSON.parse(localStorage.getItem(themeKey) || "{}");
    const root = document.querySelector(".app");
    if (!root) return;
    for (const [key, fallback] of Object.entries(defaultTheme())) {
      const value = theme[key] || fallback;
      const cssKey = key === "accent2" ? "--accent-2" : key === "panelStrong" ? "--panel-strong" : `--${key}`;
      root.style.setProperty(cssKey, value);
    }
  }

  function defaultTheme() {
    return {
      bg: "#0f1412",
      accent: "#55b877",
      accent2: "#d97745",
      panel: "#181f1c",
      panelStrong: "#1d2723",
      text: "#eff6f1"
    };
  }

  function syncThemeInputs(theme = {}) {
    const defaults = defaultTheme();
    document.querySelectorAll("[data-theme-color]").forEach((input) => {
      input.value = theme[input.dataset.themeColor] || defaults[input.dataset.themeColor] || input.value;
    });
  }

  function enhanceThemeSettings() {
    if (currentPageTitle() !== "Settings" || document.querySelector("[data-theme-editor]")) return;
    const grid = document.querySelector(".settings-grid");
    if (!grid) return;
    const theme = JSON.parse(localStorage.getItem(themeKey) || "{}");
    const panel = document.createElement("section");
    panel.className = "panel theme-editor";
    panel.dataset.themeEditor = "true";
    panel.innerHTML = `
      <div class="panel-head">
        <div>
          <h3>Client colors</h3>
          <p class="enhancement-hint">Change BlockBaseMC's accent, panels, and text colors.</p>
        </div>
        <button class="secondary-button" data-reset-theme="true" type="button">Reset</button>
      </div>
      <div class="theme-presets">
        <button data-theme-preset="forest" type="button">Forest</button>
        <button data-theme-preset="ember" type="button">Ember</button>
        <button data-theme-preset="frost" type="button">Frost</button>
      </div>
      <div class="theme-color-grid">
        <label>Background <input data-theme-color="bg" type="color" value="${theme.bg || "#0f1412"}" /></label>
        <label>Panel <input data-theme-color="panel" type="color" value="${theme.panel || "#181f1c"}" /></label>
        <label>Strong panel <input data-theme-color="panelStrong" type="color" value="${theme.panelStrong || "#1d2723"}" /></label>
        <label>Text <input data-theme-color="text" type="color" value="${theme.text || "#eff6f1"}" /></label>
        <label>Accent <input data-theme-color="accent" type="color" value="${theme.accent || "#55b877"}" /></label>
        <label>Second accent <input data-theme-color="accent2" type="color" value="${theme.accent2 || "#d97745"}" /></label>
      </div>
    `;
    grid.prepend(panel);
  }

  function setThemePreset(name) {
    const presets = {
      forest: { bg: "#0f1412", panel: "#181f1c", panelStrong: "#1d2723", text: "#eff6f1", accent: "#55b877", accent2: "#d97745" },
      ember: { bg: "#151110", panel: "#211a18", panelStrong: "#2b211d", text: "#fff4ed", accent: "#f46f45", accent2: "#f0b35a" },
      frost: { bg: "#0e1418", panel: "#172027", panelStrong: "#202b35", text: "#edf7ff", accent: "#68d0ff", accent2: "#8de38c" }
    };
    const theme = presets[name];
    if (!theme) return;
    localStorage.setItem(themeKey, JSON.stringify(theme));
    syncThemeInputs(theme);
    applyCustomTheme();
  }

  async function enhanceVersionDropdown() {
    const label = Array.from(document.querySelectorAll(".config-panel label")).find((item) =>
      item.textContent.trim().startsWith("Version")
    );
    const input = label?.querySelector("input");
    if (!label || !input || label.dataset.blockforgeVersionPicker) return;
    label.dataset.blockforgeVersionPicker = "true";
    const picker = document.createElement("div");
    picker.className = "version-picker";
    picker.dataset.versionPicker = "true";
    picker.innerHTML = `
      <button class="version-picker-button" data-version-picker-toggle="true" type="button">Loading versions...</button>
      <div class="version-picker-menu" data-version-picker-menu hidden></div>
    `;
    label.appendChild(picker);
    const toggle = picker.querySelector("[data-version-picker-toggle]");
    const menu = picker.querySelector("[data-version-picker-menu]");

    try {
      const data = await window.launcherApi?.minecraftVersions?.();
      const versions = data?.versions || [];
      toggle.textContent = input.value || "Pick version";
      menu.innerHTML = versions
        .map((version) => `<button class="${version.id === input.value ? "active" : ""}" data-pick-version="${version.id}" type="button">${version.id}<span>${version.type}</span></button>`)
        .join("");
      if (!versions.some((version) => version.id === input.value)) {
        menu.insertAdjacentHTML("afterbegin", `<button class="active" data-pick-version="${input.value}" type="button">${input.value}<span>current</span></button>`);
      }
    } catch (error) {
      toggle.textContent = "Version list failed";
      toggle.title = error?.message || String(error);
    }
  }

  function toggleVersionPicker() {
    const menu = document.querySelector("[data-version-picker-menu]");
    if (menu) menu.hidden = !menu.hidden;
  }

  function closeVersionPicker() {
    document.querySelector("[data-version-picker-menu]")?.setAttribute("hidden", "");
  }

  function pickVersion(version) {
    const label = Array.from(document.querySelectorAll(".config-panel label")).find((item) =>
      item.textContent.trim().startsWith("Version")
    );
    const input = label?.querySelector("input");
    if (!input || !version) return;
    input.value = version;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    patchSelectedProfile({ version });
    const toggle = document.querySelector("[data-version-picker-toggle]");
    if (toggle) toggle.textContent = version;
    closeVersionPicker();
  }

  function enhanceImportTools() {
    const panelHead = document.querySelector(".profile-list-panel .panel-head");
    if (!panelHead || document.querySelector("[data-import-tools]")) return;
    const tools = document.createElement("div");
    tools.className = "enhancement-actions import-tools";
    tools.dataset.importTools = "true";
    tools.innerHTML = `
      <button data-import-minecraft="minecraft" type="button">Import .minecraft</button>
      <button data-import-minecraft="zip" type="button">Import ZIP</button>
    `;
    panelHead.appendChild(tools);
  }

  async function importMinecraft(mode) {
    if (!window.launcherApi?.importMinecraft) {
      window.alert("This build does not include the import backend.");
      return;
    }

    try {
      const result = await window.launcherApi.importMinecraft({
        mode,
        apiKey: localStorage.getItem("blockforge/curseforge-api-key") || ""
      });
      if (!result?.ok || !result.profile) {
        if (!result?.canceled) window.alert(result?.message || "Import did not finish.");
        return;
      }
      const state = readState();
      const account = state.accounts.find((item) => item.kind === "java" && item.default) ||
        state.accounts.find((item) => item.kind === "java");
      state.profiles = [
        {
          ...result.profile,
          accountId: account?.id || ""
        },
        ...state.profiles.filter((profile) => profile.id !== result.profile.id)
      ];
      writeState(state);
      window.alert(result.message || `Imported ${result.profile.name}.`);
      reloadKeepingPage();
    } catch (error) {
      window.alert(`Import failed: ${error?.message || String(error)}`);
    }
  }

  function enhance() {
    try {
      enhanceAccounts();
      enhanceServers();
      enhanceDiscover();
      enhanceDownloads();
      enhanceStatusBar();
      renderLauncherUpdateBanner();
      enhanceFeatureNotices();
      removeBedrockUi();
      enhanceInstances();
      enhanceModsManager();
      enhanceLibrary();
      enhanceThemeSettings();
      applyCustomTheme();
    } catch (error) {
      console.warn("BlockBaseMC enhancement skipped:", error);
    }
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;

    if (button.dataset.addMicrosoftJava) return addMicrosoftJavaAccount();
    if (button.dataset.addAccount) return addOfflineAccount(button.dataset.addAccount);
    if (button.dataset.deleteAccount) return deleteAccount(button.dataset.deleteAccount);
    if (button.dataset.reauthAccount) return reauthMicrosoftJavaAccount(button.dataset.reauthAccount);
    if (button.dataset.changeSkin) return openSkinPage();
    if (button.dataset.viewSkin) return showSkinModal(button.dataset.viewSkin);
    if (button.dataset.closeSkinModal) return closeSkinModal();
    if (button.dataset.closeMsDevice !== undefined) return closeMicrosoftDeviceModal();
    if (button.dataset.copyMsCode) return navigator.clipboard?.writeText(button.dataset.copyMsCode);
    if (button.dataset.openMsDevice) return window.open(button.dataset.openMsDevice, "_blank");
    if (button.dataset.closeOfflineAccountModal) return closeOfflineAccountModal();
    if (button.dataset.addServer) return addServer();
    if (button.dataset.closeServerModal) return closeServerModal();
    if (button.dataset.deleteServer) {
      const state = readState();
      state.servers = state.servers.filter((server) => server.id !== button.dataset.deleteServer);
      writeState(state);
      return reloadKeepingPage();
    }
    if (button.dataset.refreshServer) return refreshServerStatus(button.dataset.refreshServer);
    if (button.dataset.searchMods) return searchMods();
    if (button.dataset.installProject) return installProject(button.dataset.installProject);
    if (button.dataset.saveCurseforgeKey) {
      const key = document.querySelector("[data-curseforge-key]")?.value?.trim() || "";
      localStorage.setItem("blockforge/curseforge-api-key", key);
      return searchMods();
    }
    if (button.dataset.openProject) return window.open(button.dataset.openProject, "_blank");
    if (button.dataset.checkUpdates) return checkLauncherUpdates(true);
    if (button.dataset.openUpdate) return window.launcherApi?.openExternal?.(button.dataset.openUpdate) || window.open(button.dataset.openUpdate, "_blank");
    if (button.dataset.downloadUpdate) return window.launcherApi?.openExternal?.(button.dataset.downloadUpdate) || window.open(button.dataset.downloadUpdate, "_blank");
    if (button.dataset.dismissUpdate) {
      localStorage.setItem(updateDismissKey, button.dataset.dismissUpdate);
      return renderLauncherUpdateBanner();
    }
    if (button.dataset.prismSource) return selectPrismSource(button.dataset.prismSource);
    if (button.dataset.versionPickerToggle) return toggleVersionPicker();
    if (button.dataset.pickVersion) return pickVersion(button.dataset.pickVersion);
    if (button.dataset.createPrismProfile) return createPrismProfile();
    if (button.dataset.updateSelectedProfile) return updateSelectedPrismProfile();
    if (button.dataset.refreshPrismVersions) {
      minecraftVersionCache = null;
      return renderPrismVersions(selectedPrismVersion());
    }
    if (button.dataset.themePreset) return setThemePreset(button.dataset.themePreset);
    if (button.dataset.resetTheme) {
      localStorage.removeItem(themeKey);
      syncThemeInputs();
      applyCustomTheme();
      return;
    }
    if (button.dataset.quickJoin) {
      const accountId = document.querySelector(`[data-server-account="${button.dataset.quickJoin}"]`)?.value;
      return quickJoin(button.dataset.quickJoin, accountId);
    }
    if (button.dataset.clearInstances) return clearInstances(button.dataset.clearInstances);
    if (button.dataset.killInstance) return killInstance(button.dataset.killInstance);
    if (button.dataset.openLog) return window.launcherApi?.openPath?.(button.dataset.openLog);
    if (button.dataset.openFolder) return window.launcherApi?.openPath?.(button.dataset.openFolder);
    if (button.dataset.openGameFolder !== undefined) return openSelectedGameFolder();
    if (button.dataset.importMinecraft) return importMinecraft(button.dataset.importMinecraft);
    if (button.dataset.refreshContent !== undefined) return refreshInstalledContent();
    if (button.dataset.openContentFolder) return openContentFolder(button.dataset.openContentFolder);
    if (button.dataset.toggleContent) return toggleContent(button.dataset.toggleContent);
    if (button.dataset.deleteContent) return deleteContent(button.dataset.deleteContent);
    if (button.dataset.contentFilter) {
      document.querySelectorAll("[data-content-filter]").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      return renderContentItems();
    }

    window.setTimeout(enhance, 80);
    window.setTimeout(enhance, 300);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeSkinModal();
      closeMicrosoftDeviceModal();
      closeServerModal();
      closeOfflineAccountModal();
      closeVersionPicker();
    }
  });

  document.addEventListener("click", (event) => {
    if (event.target.classList?.contains("skin-modal-backdrop")) closeSkinModal();
    if (event.target.dataset?.msDeviceModal) closeMicrosoftDeviceModal();
    if (event.target.dataset?.serverModal) closeServerModal();
    if (event.target.dataset?.offlineAccountModal) closeOfflineAccountModal();
    if (!event.target.closest("[data-version-picker]")) closeVersionPicker();
    const versionRow = event.target.closest("[data-prism-version]");
    if (versionRow) {
      document.querySelectorAll("[data-prism-version].active").forEach((row) => row.classList.remove("active"));
      versionRow.classList.add("active");
      const version = versionRow.dataset.prismVersion;
      const nameInput = document.querySelector("[data-prism-name]");
      if (nameInput && (!nameInput.value || /^New Java Profile$|^(Vanilla|Fabric|Forge|NeoForge|Quilt|Snapshot) /.test(nameInput.value))) {
        const loader = document.querySelector("[data-prism-loader]")?.value || "Vanilla";
        nameInput.value = `${loader} ${version}`;
      }
    }
  });

  document.addEventListener("submit", (event) => {
    const accountForm = event.target.closest("[data-offline-account-form]");
    if (accountForm) {
      event.preventDefault();
      return submitOfflineAccountForm(accountForm);
    }
    const form = event.target.closest("[data-server-form]");
    if (!form) return;
    event.preventDefault();
    submitServerForm(form);
  });

  document.addEventListener("input", (event) => {
    const input = event.target.closest("[data-theme-color]");
    if (!input) {
      if (event.target.matches("[data-prism-search], [data-prism-filter]")) {
        return renderPrismVersions(selectedPrismVersion());
      }
      return;
    }
    const theme = JSON.parse(localStorage.getItem(themeKey) || "{}");
    theme[input.dataset.themeColor] = input.value;
    localStorage.setItem(themeKey, JSON.stringify(theme));
    applyCustomTheme();
  });

  function startEnhancer() {
    repairProfileState();
    sanitizeInstances();
    setupMicrosoftDeviceCodeListener();
    checkLauncherUpdates(false);
    enhance();
    window.setTimeout(restorePageAfterReload, 60);
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      enhance();
      if (attempts > 40) window.clearInterval(timer);
    }, 250);
  }

  window.addEventListener("DOMContentLoaded", startEnhancer);
  window.addEventListener("load", startEnhancer);
})();

