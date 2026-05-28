const { app, BrowserWindow, dialog, ipcMain, screen, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const fssync = require("node:fs");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const AdmZip = require("adm-zip");

const manifestUrl = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const updateRepo = "itz-me-fisherYT/BlockBase-Launcher";
let mainWindow;
const activeChildren = new Map();
let launchCounter = 0;

function createWindow() {
  const { width: workWidth, height: workHeight } = screen.getPrimaryDisplay().workAreaSize;
  const windowWidth = Math.min(1180, Math.max(920, Math.floor(workWidth * 0.92)));
  const windowHeight = Math.min(760, Math.max(640, Math.floor(workHeight * 0.9)));

  mainWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    minWidth: 920,
    minHeight: 640,
    resizable: true,
    center: true,
    title: "BlockBaseMC Launcher",
    backgroundColor: "#0f1412",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:1420";

  if (!app.isPackaged) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  mainWindow.once("ready-to-show", () => {
    if (workWidth <= 1366 || workHeight <= 820) {
      mainWindow.maximize();
    }
  });
}

app.whenReady().then(() => {
  ipcMain.handle("detect-java", () => javaCheck("java"));
ipcMain.handle("launch-profile", (_event, profile) => launchMinecraft(profile));
  ipcMain.handle("running-instances", () => runningInstances());
  ipcMain.handle("kill-instance", (_event, profileName) => killInstance(profileName));
  ipcMain.handle("open-path", (_event, target) => openPath(target));
  ipcMain.handle("open-external", (_event, target) => openExternal(target));
  ipcMain.handle("check-for-updates", () => checkForUpdates());
  ipcMain.handle("microsoft-login", (_event, clientId) => microsoftLogin(clientId));
  ipcMain.handle("microsoft-reauth", (_event, accountId, clientId) => microsoftReauth(accountId, clientId));
  ipcMain.handle("search-mods", (_event, options) => searchMods(options));
  ipcMain.handle("install-project", (_event, options) => installProject(options));
  ipcMain.handle("list-profile-content", (_event, profile) => listProfileContent(profile));
  ipcMain.handle("toggle-profile-content", (_event, options) => toggleProfileContent(options));
  ipcMain.handle("delete-profile-content", (_event, options) => deleteProfileContent(options));
  ipcMain.handle("skin-profile", (_event, account) => skinProfile(account));
  ipcMain.handle("import-minecraft", (_event, options) => importMinecraft(options));
  ipcMain.handle("minecraft-versions", () => minecraftVersions());

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

async function launchMinecraft(profile) {
  try {
    return await launchMinecraftUnsafe(profile);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitLog("error", message);
    return {
      ok: false,
      message,
      commandPreview: []
    };
  }
}

async function launchMinecraftUnsafe(profile) {
  if (profile.edition === "bedrock") {
    return {
      ok: false,
      message: "Bedrock support has been removed from this BlockBaseMC build.",
      commandPreview: []
    };
  }

  const java = profile.javaPath?.trim() || "java";
  const javaResult = await javaCheck(java);
  if (!javaResult.ok) {
    return {
      ok: false,
      message: `Java is not ready for '${profile.name}': ${javaResult.message}`,
      commandPreview: []
    };
  }

  const supportedLoaders = ["Vanilla", "Snapshot", "Fabric", "Quilt", "Forge", "NeoForge"];
  if (profile.loader && !supportedLoaders.includes(profile.loader)) {
    throw new Error(`${profile.loader} launch support is not available.`);
  }

  if (profile.loader === "Fabric" && profile.gameDir) {
    const detectedVersion = await detectFabricMinecraftVersion(profile.gameDir);
    if (detectedVersion && detectedVersion !== profile.version && compareMinecraftVersions(detectedVersion, profile.version) > 0) {
      emitLog("info", `Fabric mods in this profile target Minecraft ${detectedVersion}. Upgrading launch from ${profile.version}.`);
      profile = { ...profile, version: detectedVersion };
    } else if (detectedVersion && detectedVersion !== profile.version) {
      emitLog("info", `Fabric mods mention Minecraft ${detectedVersion}, but this profile is set to ${profile.version}. Keeping the selected version.`);
    }
  }

  const roots = await getLauncherRoots(profile);
  await fs.mkdir(roots.gameDir, { recursive: true });
  await fs.mkdir(roots.logsDir, { recursive: true });
  emitLog("info", `Preparing ${profile.version} in ${roots.gameDir}`);

  const version = await resolveVersion(profile.version);
  const vanillaJson = await readJsonFromUrl(version.url, `version ${version.id}`);
  const versionJson = await applyLoaderVersion(profile, vanillaJson, roots, java);
  const versionDir = path.join(roots.versionsDir, versionJson.id);
  const clientJar = path.join(versionDir, `${vanillaJson.id}.jar`);
  await fs.mkdir(versionDir, { recursive: true });
  await fs.writeFile(path.join(versionDir, `${versionJson.id}.json`), JSON.stringify(versionJson, null, 2));

  await downloadFile(vanillaJson.downloads.client.url, clientJar, vanillaJson.downloads.client.sha1, "Minecraft client");
  const assetIndex = await installAssets(roots, versionJson);
  const libraries = await installLibraries(roots, versionJson);
  const nativesDir = path.join(versionDir, `natives-${Date.now()}-${process.pid}`);
  await extractNatives(libraries.nativeJars, nativesDir);

  const auth = await resolveLaunchAuth(profile);
  const command = buildJavaCommand({
    java,
    profile,
    roots,
    versionJson,
    clientJar,
    classpath: [...libraries.classpath, clientJar],
    nativesDir,
    assetIndex,
    auth
  });

  const logFile = path.join(roots.logsDir, `${safeName(profile.name)}-${Date.now()}.log`);
  emitLog("info", `Launching Java process. Log: ${logFile}`);
  const instance = await spawnMinecraft(command, roots.gameDir, logFile, profile, auth);

  return {
    ok: true,
    message:
      auth.mode === "microsoft"
        ? `${profile.name} launched with Microsoft account ${auth.username}.`
        : `${profile.name} launched in offline/dev vanilla mode. Add or reauth a Microsoft account for online auth.`,
    commandPreview: [command.executable, ...command.args],
    instance
  };
}

async function getLauncherRoots(profile) {
  const root = path.join(app.getPath("userData"), "minecraft");
  const versionsDir = path.join(root, "versions");
  const librariesDir = path.join(root, "libraries");
  const assetsDir = path.join(root, "assets");
  const logsDir = path.join(root, "logs");
  const requestedGameDir = profile.gameDir || profile.folder || "";
  const gameDir = requestedGameDir
    ? (path.isAbsolute(requestedGameDir) ? requestedGameDir : path.join(root, requestedGameDir))
    : path.join(root, "instances", safeName(profile.name || "profile"));

  await Promise.all([
    fs.mkdir(versionsDir, { recursive: true }),
    fs.mkdir(librariesDir, { recursive: true }),
    fs.mkdir(assetsDir, { recursive: true }),
    fs.mkdir(logsDir, { recursive: true })
  ]);

  return { root, versionsDir, librariesDir, assetsDir, logsDir, gameDir };
}

async function resolveVersion(requestedVersion) {
  const manifest = await readJsonFromUrl(manifestUrl, "Minecraft version manifest");
  const requested = requestedVersion?.trim();
  const version =
    manifest.versions.find((item) => item.id === requested) ||
    (requested?.toLowerCase() === "latest" ? manifest.versions.find((item) => item.id === manifest.latest.release) : null) ||
    (requested?.toLowerCase() === "snapshot" ? manifest.versions.find((item) => item.id === manifest.latest.snapshot) : null);

  if (!version) {
    throw new Error(`Minecraft version '${requestedVersion}' was not found in the Mojang manifest.`);
  }

  return version;
}

async function applyLoaderVersion(profile, vanillaJson, roots, java) {
  if (profile.loader === "Quilt") return applyQuiltVersion(profile, vanillaJson);
  if (profile.loader === "Forge") return applyInstallerLoaderVersion(profile, vanillaJson, roots, java, "forge");
  if (profile.loader === "NeoForge") return applyInstallerLoaderVersion(profile, vanillaJson, roots, java, "neoforge");
  if (profile.loader !== "Fabric") return vanillaJson;

  const loaders = await readJsonFromUrl(
    `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(vanillaJson.id)}`,
    `Fabric loader metadata for ${vanillaJson.id}`
  );
  const loaderVersion = profile.loaderVersion ||
    loaders.find((item) => item.loader?.stable)?.loader?.version ||
    loaders[0]?.loader?.version;
  if (!loaderVersion) {
    throw new Error(`No Fabric loader version is available for Minecraft ${vanillaJson.id}.`);
  }

  const fabricJson = await readJsonFromUrl(
    `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(vanillaJson.id)}/${encodeURIComponent(loaderVersion)}/profile/json`,
    `Fabric profile ${loaderVersion} for ${vanillaJson.id}`
  );

  const loaderLibraries = mergeLoaderLibraries(vanillaJson.libraries || [], fabricJson.libraries || []);

  emitLog("info", `Using Fabric Loader ${loaderVersion} for Minecraft ${vanillaJson.id}.`);
  return mergeLoaderProfile(vanillaJson, { ...fabricJson, libraries: loaderLibraries }, `fabric-loader-${loaderVersion}-${vanillaJson.id}`);
}

async function applyQuiltVersion(profile, vanillaJson) {
  const loaders = await readJsonFromUrl(
    `https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(vanillaJson.id)}`,
    `Quilt loader metadata for ${vanillaJson.id}`
  );
  const loaderVersion = profile.loaderVersion ||
    loaders.find((item) => item.loader?.stable)?.loader?.version ||
    loaders[0]?.loader?.version;
  if (!loaderVersion) {
    throw new Error(`No Quilt loader version is available for Minecraft ${vanillaJson.id}.`);
  }

  const quiltJson = await readJsonFromUrl(
    `https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(vanillaJson.id)}/${encodeURIComponent(loaderVersion)}/profile/json`,
    `Quilt profile ${loaderVersion} for ${vanillaJson.id}`
  );
  emitLog("info", `Using Quilt Loader ${loaderVersion} for Minecraft ${vanillaJson.id}.`);
  return mergeLoaderProfile(vanillaJson, quiltJson, `quilt-loader-${loaderVersion}-${vanillaJson.id}`);
}

async function applyInstallerLoaderVersion(profile, vanillaJson, roots, java, kind) {
  const installed = await installLoaderWithInstaller(profile, vanillaJson.id, roots, java, kind);
  emitLog("info", `Using ${kind === "forge" ? "Forge" : "NeoForge"} profile ${installed.id}.`);
  return mergeLoaderProfile(vanillaJson, installed, installed.id);
}

function mergeLoaderProfile(vanillaJson, loaderJson, fallbackId) {
  return {
    ...vanillaJson,
    id: loaderJson.id || fallbackId,
    type: loaderJson.type || vanillaJson.type,
    mainClass: loaderJson.mainClass || vanillaJson.mainClass,
    arguments: {
      jvm: [
        ...(vanillaJson.arguments?.jvm || []),
        ...(loaderJson.arguments?.jvm || [])
      ],
      game: [
        ...(vanillaJson.arguments?.game || []),
        ...(loaderJson.arguments?.game || [])
      ]
    },
    libraries: mergeLoaderLibraries(vanillaJson.libraries || [], loaderJson.libraries || []),
    inheritsFrom: loaderJson.inheritsFrom || vanillaJson.id
  };
}

function mergeLoaderLibraries(baseLibraries, loaderLibraries) {
  const merged = new Map();
  for (const library of baseLibraries) {
    merged.set(mavenKey(library), library);
  }
  for (const library of loaderLibraries) {
    merged.set(mavenKey(library), library);
  }
  return Array.from(merged.values());
}

function mavenKey(library) {
  const parts = String(library.name || "").split(":");
  if (parts.length >= 4) return `${parts[0]}:${parts[1]}:${parts[3]}`;
  return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : library.name;
}

async function installLoaderWithInstaller(profile, minecraftVersion, roots, java, kind) {
  const installer = kind === "forge"
    ? await resolveForgeInstaller(minecraftVersion, profile.loaderVersion)
    : await resolveNeoForgeInstaller(minecraftVersion, profile.loaderVersion);
  const installerDir = path.join(roots.root, "installers");
  const installerPath = path.join(installerDir, installer.fileName);
  await downloadFile(installer.url, installerPath, null, `${installer.name} installer`);
  emitLog("info", `Running ${installer.name} installer. This may take a minute.`);
  await runJavaInstaller(java, installerPath, roots.root);
  const installedJson = await findInstalledLoaderJson(roots.versionsDir, minecraftVersion, kind, installer.version);
  return installedJson;
}

async function resolveForgeInstaller(minecraftVersion, preferredVersion) {
  const promotions = await readJsonFromUrl(
    "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json",
    "Forge promotions"
  );
  const forgeVersion = preferredVersion ||
    promotions.promos?.[`${minecraftVersion}-recommended`] ||
    promotions.promos?.[`${minecraftVersion}-latest`];
  if (!forgeVersion) {
    throw new Error(`No Forge installer was found for Minecraft ${minecraftVersion}.`);
  }
  const version = `${minecraftVersion}-${forgeVersion}`;
  return {
    name: "Forge",
    version,
    fileName: `forge-${version}-installer.jar`,
    url: `https://maven.minecraftforge.net/net/minecraftforge/forge/${version}/forge-${version}-installer.jar`
  };
}

async function resolveNeoForgeInstaller(minecraftVersion, preferredVersion) {
  const metadata = await readTextFromUrl(
    "https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml",
    "NeoForge metadata"
  );
  const versions = [...metadata.matchAll(/<version>([^<]+)<\/version>/g)].map((match) => match[1]);
  const prefix = minecraftVersion.replace(/^1\./, "");
  const neoVersion = preferredVersion ||
    versions.filter((version) => version === minecraftVersion || version.startsWith(`${prefix}.`)).at(-1);
  if (!neoVersion) {
    throw new Error(`No NeoForge installer was found for Minecraft ${minecraftVersion}.`);
  }
  return {
    name: "NeoForge",
    version: neoVersion,
    fileName: `neoforge-${neoVersion}-installer.jar`,
    url: `https://maven.neoforged.net/releases/net/neoforged/neoforge/${neoVersion}/neoforge-${neoVersion}-installer.jar`
  };
}

function runJavaInstaller(java, installerPath, installRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(java, ["-jar", installerPath, "--installClient", installRoot], {
      cwd: installRoot,
      windowsHide: true
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      emitLog("info", chunk.toString().trimEnd());
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
      emitLog("stderr", chunk.toString().trimEnd());
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Loader installer exited with code ${code}. ${output.slice(-500)}`));
    });
  });
}

async function findInstalledLoaderJson(versionsDir, minecraftVersion, kind, loaderVersion) {
  const entries = await fs.readdir(versionsDir, { withFileTypes: true }).catch(() => []);
  const candidates = [];
  for (const entry of entries.filter((item) => item.isDirectory())) {
    const id = entry.name;
    const lower = id.toLowerCase();
    if (kind === "forge" && !(lower.includes("forge") && lower.includes(minecraftVersion))) continue;
    if (kind === "neoforge" && !(lower.includes("neoforge") || lower === loaderVersion.toLowerCase())) continue;
    const jsonPath = path.join(versionsDir, id, `${id}.json`);
    try {
      const stat = await fs.stat(jsonPath);
      candidates.push({ id, jsonPath, mtime: stat.mtimeMs });
    } catch {
      // Skip partial installs.
    }
  }
  const selected = candidates.sort((a, b) => b.mtime - a.mtime)[0];
  if (!selected) throw new Error(`The ${kind} installer finished, but no installed version JSON was found.`);
  return JSON.parse(await fs.readFile(selected.jsonPath, "utf8"));
}

async function installAssets(roots, versionJson) {
  const indexInfo = versionJson.assetIndex;
  const indexesDir = path.join(roots.assetsDir, "indexes");
  const objectsDir = path.join(roots.assetsDir, "objects");
  await fs.mkdir(indexesDir, { recursive: true });
  await fs.mkdir(objectsDir, { recursive: true });
  const indexPath = path.join(indexesDir, `${indexInfo.id}.json`);
  await downloadFile(indexInfo.url, indexPath, indexInfo.sha1, "Asset index");

  const assetIndex = JSON.parse(await fs.readFile(indexPath, "utf8"));
  const entries = Object.values(assetIndex.objects || {});
  let done = 0;
  await mapLimit(entries, 16, async (asset) => {
    const prefix = asset.hash.slice(0, 2);
    const target = path.join(objectsDir, prefix, asset.hash);
    const url = `https://resources.download.minecraft.net/${prefix}/${asset.hash}`;
    await downloadFile(url, target, asset.hash, `Asset ${done + 1}/${entries.length}`, false);
    done += 1;
    if (done === entries.length || done % 100 === 0) {
      emitLog("info", `Assets ${done}/${entries.length}`);
    }
  });
  emitLog("info", `Assets ready: ${entries.length} files`);
  return { id: indexInfo.id, name: versionJson.assets };
}

async function mapLimit(items, limit, worker) {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      await worker(item);
    }
  });
  await Promise.all(workers);
}

async function installLibraries(roots, versionJson) {
  const classpath = [];
  const nativeJars = [];

  for (const library of versionJson.libraries || []) {
    if (!rulesAllow(library.rules)) continue;
    const artifact = library.downloads?.artifact || mavenArtifact(library);
    if (artifact) {
      const target = path.join(roots.librariesDir, ...artifact.path.split("/"));
      await downloadFile(artifact.url, target, artifact.sha1, `Library ${library.name}`, false);
      classpath.push(target);
    }

    const nativeKey = getNativeClassifier(library);
    const nativeDownload = nativeKey ? library.downloads?.classifiers?.[nativeKey] : null;
    if (nativeDownload) {
      const target = path.join(roots.librariesDir, ...nativeDownload.path.split("/"));
      await downloadFile(nativeDownload.url, target, nativeDownload.sha1, `Native ${library.name}`, false);
      nativeJars.push(target);
    }
  }

  emitLog("info", `Libraries ready: ${classpath.length} classpath jars, ${nativeJars.length} native jars`);
  return { classpath, nativeJars };
}

function mavenArtifact(library) {
  if (!library.name || !library.url) return null;
  const parts = library.name.split(":");
  if (parts.length < 3) return null;
  const [group, artifact, version, classifier] = parts;
  const fileName = `${artifact}-${version}${classifier ? `-${classifier}` : ""}.jar`;
  const artifactPath = `${group.replace(/\./g, "/")}/${artifact}/${version}/${fileName}`;
  return {
    path: artifactPath,
    url: `${library.url.replace(/\/?$/, "/")}${artifactPath}`,
    sha1: library.sha1
  };
}

async function extractNatives(nativeJars, nativesDir) {
  await cleanupOldNativeDirs(path.dirname(nativesDir));
  await fs.mkdir(nativesDir, { recursive: true });

  for (const jar of nativeJars) {
    const zip = new AdmZip(jar);
    for (const entry of zip.getEntries()) {
      const name = entry.entryName;
      if (entry.isDirectory || name.startsWith("META-INF/")) continue;
      if (!/\.(dll|so|dylib|jnilib)$/i.test(name)) continue;
      const target = path.join(nativesDir, path.basename(name));
      await fs.writeFile(target, entry.getData());
    }
  }

  emitLog("info", `Native libraries extracted to ${nativesDir}`);
}

async function cleanupOldNativeDirs(versionDir) {
  let entries = [];
  try {
    entries = await fs.readdir(versionDir, { withFileTypes: true });
  } catch {
    return;
  }

  await Promise.all(entries
    .filter((entry) => entry.isDirectory() && /^natives($|-)/.test(entry.name))
    .map(async (entry) => {
      const target = path.join(versionDir, entry.name);
      try {
        await fs.rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 });
      } catch (error) {
        if (error?.code === "EPERM" || error?.code === "EBUSY") {
          emitLog("info", `Skipped locked native folder still in use: ${target}`);
          return;
        }
        throw error;
      }
    }));
}

function buildJavaCommand({ java, profile, roots, versionJson, classpath, nativesDir, assetIndex, auth }) {
  const separator = process.platform === "win32" ? ";" : ":";
  const hasCustomResolution = Number(profile.width) > 0 && Number(profile.height) > 0;
  const quickJoinServer = profile.server?.trim();
  const replacements = {
    auth_player_name: auth.username,
    version_name: versionJson.id,
    game_directory: roots.gameDir,
    assets_root: roots.assetsDir,
    assets_index_name: assetIndex.name || assetIndex.id,
    auth_uuid: auth.uuid,
    auth_access_token: auth.accessToken,
    clientid: auth.clientId,
    auth_xuid: auth.xuid,
    user_type: auth.userType,
    version_type: versionJson.type || "release",
    resolution_width: String(profile.width || 1280),
    resolution_height: String(profile.height || 720),
    natives_directory: nativesDir,
    launcher_name: "BlockBaseMC",
    launcher_version: app.getVersion(),
    classpath: classpath.join(separator)
  };
  const features = {
    has_custom_resolution: hasCustomResolution,
    is_demo_user: false,
    has_quick_plays_support: Boolean(quickJoinServer),
    is_quick_play_singleplayer: false,
    is_quick_play_multiplayer: Boolean(quickJoinServer),
    is_quick_play_realms: false
  };

  const jvmArgs = [];
  jvmArgs.push(`-Xms${profile.ramMin || 1024}M`);
  jvmArgs.push(`-Xmx${profile.ramMax || 4096}M`);
  jvmArgs.push(...splitArgs(profile.jvmArgs));

  if (versionJson.arguments?.jvm) {
    jvmArgs.push(...resolveArgumentList(versionJson.arguments.jvm, replacements, features));
  } else {
    jvmArgs.push(`-Djava.library.path=${nativesDir}`, "-cp", classpath.join(separator));
  }

  const gameArgs = versionJson.arguments?.game
    ? resolveArgumentList(versionJson.arguments.game, replacements, features)
    : legacyMinecraftArguments(versionJson.minecraftArguments, replacements);

  if (profile.fullscreen) gameArgs.push("--fullscreen");
  if (quickJoinServer && !gameArgs.includes("--quickPlayMultiplayer")) {
    gameArgs.push("--quickPlayMultiplayer", quickJoinServer);
  }
  gameArgs.push(...splitArgs(profile.launchArgs));

  return {
    executable: java,
    args: [...jvmArgs, versionJson.mainClass, ...gameArgs]
  };
}

function resolveArgumentList(items, replacements, features = {}) {
  const args = [];
  for (const item of items || []) {
    if (typeof item === "string") {
      args.push(replaceVars(item, replacements));
      continue;
    }

    if (!rulesAllow(item.rules, features)) continue;
    const values = Array.isArray(item.value) ? item.value : [item.value];
    args.push(...values.map((value) => replaceVars(value, replacements)));
  }
  return args;
}

function legacyMinecraftArguments(template = "", replacements) {
  return template.split(/\s+/).filter(Boolean).map((part) => replaceVars(part, replacements));
}

function replaceVars(value, replacements) {
  return value.replace(/\$\{([^}]+)\}/g, (_match, key) => replacements[key] ?? "");
}

function splitArgs(value = "") {
  const matches = value.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  return matches.map((part) => part.replace(/^"|"$/g, ""));
}

function makeOfflineAuth(profile) {
  const username = safePlayerName(profile.accountName || "Player");
  const uuid = crypto.createHash("md5").update(`OfflinePlayer:${username}`).digest("hex");
  return {
    mode: "offline",
    username,
    uuid,
    accessToken: "0",
    clientId: "0",
    xuid: "0",
    userType: "legacy"
  };
}

async function resolveLaunchAuth(profile) {
  const accountName = String(profile.accountName || "").trim();
  if (accountName) {
    const cache = await readMicrosoftAuthCache();
    const cached = findMicrosoftAuth(cache, accountName);
    if (cached) {
      if (Date.now() < Number(cached.expiresAt || 0) - 60_000) {
        emitLog("info", `Using Microsoft auth for ${cached.username}.`);
        return makeMicrosoftLaunchAuth(cached);
      }
      if (cached.refreshToken && cached.clientId) {
        try {
          emitLog("info", `Refreshing Microsoft auth for ${cached.username}.`);
          const refreshed = await refreshMicrosoftToken(cached.clientId, cached.refreshToken);
          const account = await finishMicrosoftLogin(cached.clientId, refreshed, cached.refreshToken);
          const refreshedCache = await readMicrosoftAuthCache();
          const refreshedEntry = findMicrosoftAuth(refreshedCache, account.id) || findMicrosoftAuth(refreshedCache, account.displayName);
          if (refreshedEntry) return makeMicrosoftLaunchAuth(refreshedEntry);
        } catch (error) {
          emitLog("warn", `Microsoft auth refresh failed for ${cached.username}: ${error?.message || String(error)}.`);
        }
      }
      emitLog("error", `Microsoft auth for ${cached.username} expired. Reauth the account, then launch again.`);
    }
  }

  return makeOfflineAuth(profile);
}

function makeMicrosoftLaunchAuth(cached) {
  return {
    mode: "microsoft",
    username: cached.username,
    uuid: cached.uuid,
    accessToken: cached.accessToken,
    clientId: cached.clientId || "0",
    xuid: cached.xuid || "0",
    userType: "msa"
  };
}

function findMicrosoftAuth(cache, accountName) {
  const key = accountName.toLowerCase();
  return Object.values(cache.accounts || {}).find(
    (entry) =>
      entry?.username?.toLowerCase() === key ||
      entry?.email?.toLowerCase() === key ||
      entry?.id?.toLowerCase() === key
  );
}

function getNativeClassifier(library) {
  const natives = library.natives;
  if (!natives) return null;
  const os = osName();
  const classifier = natives[os];
  if (!classifier) return null;
  return classifier.replace("${arch}", process.arch.includes("64") ? "64" : "32");
}

function rulesAllow(rules, features = {}) {
  if (!rules?.length) return true;
  let allowed = false;
  for (const rule of rules) {
    if (!ruleMatches(rule, features)) continue;
    allowed = rule.action === "allow";
  }
  return allowed;
}

function ruleMatches(rule, features = {}) {
  if (rule.os?.name && rule.os.name !== osName()) return false;
  if (rule.os?.arch && rule.os.arch !== process.arch) return false;
  for (const [key, expected] of Object.entries(rule.features || {})) {
    if (Boolean(features[key]) !== Boolean(expected)) return false;
  }
  return true;
}

function osName() {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "osx";
  return "linux";
}

async function readJsonFromUrl(url, label) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${label} download failed: HTTP ${response.status}`);
  }
  return response.json();
}

async function readTextFromUrl(url, label) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${label} download failed: HTTP ${response.status}`);
  }
  return response.text();
}

async function downloadFile(url, target, sha1, label, noisy = true) {
  if (await fileMatches(target, sha1)) return;
  if (noisy) emitLog("info", `Downloading ${label}`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`${label} download failed: HTTP ${response.status}`);
  }

  const temp = `${target}.part`;
  const file = fssync.createWriteStream(temp);
  await new Promise((resolve, reject) => {
    response.body.pipeTo(
      new WritableStream({
        write(chunk) {
          file.write(Buffer.from(chunk));
        },
        close() {
          file.end(resolve);
        },
        abort(error) {
          file.destroy();
          reject(error);
        }
      })
    ).catch(reject);
  });

  if (sha1 && !(await fileMatches(temp, sha1))) {
    await fs.rm(temp, { force: true });
    throw new Error(`${label} failed SHA-1 verification`);
  }
  await fs.rename(temp, target);
}

async function fileMatches(file, sha1) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return false;
    if (!sha1) return stat.size > 0;
    const hash = crypto.createHash("sha1");
    const stream = fssync.createReadStream(file);
    await new Promise((resolve, reject) => {
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", resolve);
    });
    return hash.digest("hex") === sha1;
  } catch {
    return false;
  }
}

async function spawnMinecraft(command, cwd, logFile, profile, auth) {
  const profileName = profile.name || "Minecraft";
  const startedAt = Date.now();
  const instanceId = `${safeName(profileName)}-${startedAt}-${++launchCounter}`;
  const child = spawn(command.executable, command.args, { cwd, windowsHide: false });
  const record = {
    id: instanceId,
    profileName,
    account: auth.username || profile.accountName || "Player",
    pid: child.pid || 0,
    status: "running",
    startedAt,
    logFile,
    gameDir: cwd,
    child
  };
  activeChildren.set(instanceId, record);
  const log = fssync.createWriteStream(logFile, { flags: "a" });

  const write = (level, chunk) => {
    const text = chunk.toString();
    log.write(text);
    emitLog(level, text.trimEnd());
  };

  child.stdout.on("data", (chunk) => write("stdout", chunk));
  child.stderr.on("data", (chunk) => write("stderr", chunk));
  child.on("error", (error) => {
    emitLog("error", error.message);
    log.end();
  });
  child.on("close", async (code) => {
    if (activeChildren.get(instanceId)?.child === child) {
      activeChildren.delete(instanceId);
    }
    const message = code === 0 ? `${profileName} exited normally.` : `${profileName} exited with code ${code}.`;
    emitLog(code === 0 ? "info" : "error", message);
    if (code !== 0) {
      const summary = await summarizeCrashLog(logFile);
      if (summary) {
        emitLog("error", `Crash summary: ${summary}`);
        log.write(`Crash summary: ${summary}\n`);
      }
    }
    log.end(`${message}\n`);
  });
  return publicInstanceRecord(record);
}

function runningInstances() {
  return Array.from(activeChildren.values()).map(publicInstanceRecord);
}

function publicInstanceRecord(record) {
  return {
    id: record.id,
    profileName: record.profileName,
    account: record.account,
    pid: record.pid,
    status: record.status,
    startedAt: record.startedAt,
    uptimeMs: Date.now() - record.startedAt,
    logFile: record.logFile,
    gameDir: record.gameDir
  };
}

async function summarizeCrashLog(logFile) {
  try {
    const text = await fs.readFile(logFile, "utf8");
    const lines = text.split(/\r?\n/).filter(Boolean);
    const patterns = [
      /Incompatible mods found!/i,
      /Some of your mods are incompatible/i,
      /Only one quick play option can be specified/i,
      /ClassNotFoundException:\s*([^\s]+)/i,
      /NoClassDefFoundError:\s*([^\s]+)/i,
      /Could not execute entrypoint stage '([^']+)'/i,
      /A mod crashed on startup!/i,
      /Minecraft version.*requires/i
    ];

    for (const pattern of patterns) {
      const line = lines.find((entry) => pattern.test(entry) && !isBenignCrashWarning(entry));
      if (line) return cleanCrashLine(line);
    }

    const causedBy = [...lines].reverse().find((entry) =>
      /Caused by:|Exception|ERROR/i.test(entry) && !isBenignCrashWarning(entry)
    );
    return causedBy ? cleanCrashLine(causedBy) : "";
  } catch {
    return "";
  }
}

function isBenignCrashWarning(line) {
  return /\[WARN\]:\s*Error loading class:/i.test(line);
}

function cleanCrashLine(line) {
  return line
    .replace(/^\[[^\]]+\]\s*\[[^\]]+\]\s*(?:\[ERROR\]:\s*)?/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 320);
}

function killInstance(instanceId) {
  const record = activeChildren.get(instanceId);
  if (!record?.child) {
    return { ok: false, message: `No tracked running process for ${instanceId}.` };
  }

  try {
    if (process.platform === "win32" && record.child.pid) {
      spawn("taskkill", ["/pid", String(record.child.pid), "/t", "/f"], { windowsHide: true });
    } else {
      record.child.kill("SIGKILL");
    }
    activeChildren.delete(instanceId);
    emitLog("info", `Killed ${record.profileName} (${record.account}).`);
    return { ok: true, message: `Killed ${record.profileName} (${record.account}).` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitLog("error", message);
    return { ok: false, message };
  }
}

async function openPath(target) {
  const clean = String(target || "").trim();
  if (!clean) return { ok: false, message: "No path provided." };
  const result = await shell.openPath(clean);
  return result ? { ok: false, message: result } : { ok: true, message: `Opened ${clean}.` };
}

async function openExternal(target) {
  const clean = String(target || "").trim();
  if (!/^https?:\/\//i.test(clean)) return { ok: false, message: "Only web links can be opened." };
  await shell.openExternal(clean);
  return { ok: true, message: `Opened ${clean}.` };
}

async function checkForUpdates() {
  const currentVersion = app.getVersion();
  const releaseUrl = `https://api.github.com/repos/${updateRepo}/releases?per_page=10`;
  const response = await fetch(releaseUrl, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": `BlockBaseMCLauncher/${currentVersion}`
    }
  });
  const json = await response.json().catch(() => []);

  if (response.status === 404) {
    return {
      ok: true,
      currentVersion,
      updateAvailable: false,
      message: "No GitHub Release has been published yet."
    };
  }
  if (!response.ok) {
    throw new Error(json.message || `Could not check for updates: ${response.status}`);
  }
  const releases = Array.isArray(json) ? json.filter((release) => !release.draft) : [];
  const release = releases[0];

  if (!release) {
    return {
      ok: true,
      currentVersion,
      updateAvailable: false,
      message: "No GitHub Release has been published yet."
    };
  }

  const latestVersion = cleanReleaseVersion(release.tag_name || release.name || "");
  const asset = Array.isArray(release.assets)
    ? release.assets.find((item) => /\.exe$/i.test(item.name || "")) || release.assets[0]
    : null;
  const downloadUrl = asset?.browser_download_url || release.html_url || `https://github.com/${updateRepo}/releases`;
  const updateAvailable = compareVersions(latestVersion, currentVersion) > 0;

  return {
    ok: true,
    currentVersion,
    latestVersion,
    updateAvailable,
    releaseName: release.name || release.tag_name || "Latest release",
    releaseUrl: release.html_url || `https://github.com/${updateRepo}/releases`,
    downloadUrl,
    publishedAt: release.published_at || "",
    prerelease: Boolean(release.prerelease),
    message: updateAvailable
      ? `BlockBaseMC ${latestVersion} is available.`
      : `BlockBaseMC is up to date (${currentVersion}).`
  };
}

function cleanReleaseVersion(value) {
  const match = String(value || "").match(/\d+(?:\.\d+){0,2}/);
  return match ? match[0] : "0.0.0";
}

function compareVersions(a, b) {
  const left = cleanReleaseVersion(a).split(".").map((part) => Number(part) || 0);
  const right = cleanReleaseVersion(b).split(".").map((part) => Number(part) || 0);
  const length = Math.max(left.length, right.length, 3);
  for (let index = 0; index < length; index += 1) {
    const delta = (left[index] || 0) - (right[index] || 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

async function searchMods(options = {}) {
  const source = options.source === "curseforge" ? "curseforge" : "modrinth";
  return source === "curseforge" ? searchCurseForge(options) : searchModrinth(options);
}

async function installProject(options = {}) {
  if (!options.profile) throw new Error("No target profile was provided.");
  const source = options.source === "curseforge" ? "curseforge" : "modrinth";
  return source === "curseforge" ? installCurseForgeProject(options) : installModrinthProject(options);
}

async function installModrinthProject(options = {}) {
  const profile = options.profile;
  const project = options.project || {};
  const loader = String(options.loader || profile.loader || "fabric").toLowerCase();
  const version = String(options.version || profile.version || "").trim();
  const type = normalizeProjectType(project.type || options.type || "mod");
  const params = new URLSearchParams();
  if (version) params.set("game_versions", JSON.stringify([version]));
  if (loader && loader !== "any" && type !== "resourcepack" && type !== "shader") {
    params.set("loaders", JSON.stringify([loader]));
  }
  const versions = await readJsonFromUrl(
    `https://api.modrinth.com/v2/project/${encodeURIComponent(project.id || project.slug)}/version?${params}`,
    `Modrinth versions for ${project.title || project.id}`
  );
  const selected = versions.find((item) => item.version_type === "release") || versions[0];
  if (!selected) throw new Error(`No compatible Modrinth file found for ${project.title || project.id}.`);
  if (type === "modpack") {
    return installModrinthPackVersion(selected, project);
  }
  const installed = [];
  await installModrinthVersion(selected, profile, type, installed);
  return {
    ok: true,
    message: `Installed ${project.title || selected.name} into ${profile.name}.`,
    installed
  };
}

async function installModrinthPackVersion(version, project) {
  const file = (version.files || []).find((item) => item.primary) || version.files?.[0];
  if (!file?.url) throw new Error(`No downloadable modpack file found for ${version.name || project.title || project.id}.`);
  const temp = path.join(app.getPath("temp"), `blockbasemc-${Date.now()}-${safeName(file.filename || "modrinth-pack.mrpack")}`);
  await downloadFile(file.url, temp, file.hashes?.sha1, file.filename || "Modrinth modpack", false);
  try {
    const name = safeName(project.title || version.name || path.basename(file.filename || "Modrinth Pack", path.extname(file.filename || "")));
    const gameDir = await uniqueImportDir(name);
    await fs.mkdir(gameDir, { recursive: true });
    const zip = new AdmZip(temp);
    const index = zip.getEntry("modrinth.index.json");
    if (!index) throw new Error("Downloaded Modrinth pack is missing modrinth.index.json.");
    const profile = await importModrinthPack(zip, index, { name, gameDir });
    return {
      ok: true,
      message: `Installed modpack ${profile.name}.`,
      profile,
      installed: [{ name: file.filename, path: gameDir }]
    };
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

async function installModrinthVersion(version, profile, type, installed, seen = new Set()) {
  if (!version?.id || seen.has(version.id)) return;
  seen.add(version.id);
  const file = (version.files || []).find((item) => item.primary) || version.files?.[0];
  if (!file?.url) throw new Error(`No downloadable file found for ${version.name || version.id}.`);
  const target = await projectInstallPath(profile, type, file.filename);
  await downloadFile(file.url, target, file.hashes?.sha1, file.filename);
  installed.push({ name: file.filename, path: target });

  for (const dep of version.dependencies || []) {
    if (dep.dependency_type !== "required" || !dep.project_id) continue;
    const depVersions = await readJsonFromUrl(
      `https://api.modrinth.com/v2/project/${encodeURIComponent(dep.project_id)}/version?game_versions=${encodeURIComponent(JSON.stringify([profile.version]))}&loaders=${encodeURIComponent(JSON.stringify([String(profile.loader || "fabric").toLowerCase()]))}`,
      `Modrinth dependency ${dep.project_id}`
    );
    const depVersion = dep.version_id
      ? depVersions.find((item) => item.id === dep.version_id)
      : depVersions.find((item) => item.version_type === "release") || depVersions[0];
    if (depVersion) await installModrinthVersion(depVersion, profile, "mod", installed, seen);
  }
}

async function installCurseForgeProject(options = {}) {
  const apiKey = String(options.apiKey || "").trim();
  if (!apiKey) throw new Error("CurseForge install needs a CurseForge API key.");
  const profile = options.profile;
  const project = options.project || {};
  const type = normalizeProjectType(project.type || options.type || "mod");
  const params = new URLSearchParams({
    pageSize: "50"
  });
  if (profile.version) params.set("gameVersion", profile.version);
  const loaderType = curseForgeLoaderType(profile.loader || options.loader);
  if (loaderType && type === "mod") params.set("modLoaderType", String(loaderType));
  const response = await fetch(`https://api.curseforge.com/v1/mods/${encodeURIComponent(project.id)}/files?${params}`, {
    headers: { "x-api-key": apiKey, accept: "application/json" }
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.errorMessage || `CurseForge files failed: HTTP ${response.status}`);
  const file = (json.data || []).find((item) => item.releaseType === 1) || json.data?.[0];
  if (!file) throw new Error(`No compatible CurseForge file found for ${project.title || project.id}.`);
  if (type === "modpack") {
    return installCurseForgePackFile(apiKey, project, file);
  }
  const installed = [];
  await installCurseForgeFile(apiKey, profile, project, file, type, installed);
  return {
    ok: true,
    message: `Installed ${project.title || project.id} into ${profile.name}.`,
    installed
  };
}

async function installCurseForgeFile(apiKey, profile, project, file, type, installed, seen = new Set()) {
  const key = `${project.id}:${file.id}`;
  if (seen.has(key)) return;
  seen.add(key);
  const downloadUrl = file.downloadUrl || await curseForgeFileDownloadUrl(apiKey, project.id, file.id);
  if (!downloadUrl) throw new Error(`CurseForge did not provide a direct download URL for ${file.fileName || project.title || project.id}.`);
  const target = await projectInstallPath(profile, type, file.fileName || `${project.slug || project.id}.jar`);
  await downloadFile(downloadUrl, target, null, file.fileName || project.title);
  installed.push({ name: file.fileName || project.title, path: target });

  for (const dep of file.dependencies || []) {
    if (dep.relationType !== 3 || !dep.modId) continue;
    const depFile = dep.fileId
      ? await curseForgeFileInfo(apiKey, dep.modId, dep.fileId)
      : await curseForgeLatestFile(apiKey, dep.modId, profile);
    if (depFile) {
      await installCurseForgeFile(apiKey, profile, { id: dep.modId, title: `CurseForge dependency ${dep.modId}` }, depFile, "mod", installed, seen);
    }
  }
}

async function installCurseForgePackFile(apiKey, project, file) {
  const downloadUrl = file.downloadUrl || await curseForgeFileDownloadUrl(apiKey, project.id, file.id);
  if (!downloadUrl) throw new Error(`CurseForge did not provide a direct download URL for ${file.fileName || project.title || project.id}.`);
  const temp = path.join(app.getPath("temp"), `blockbasemc-${Date.now()}-${safeName(file.fileName || "curseforge-pack.zip")}`);
  await downloadFile(downloadUrl, temp, null, file.fileName || "CurseForge modpack", false);
  try {
    const name = safeName(project.title || file.displayName || path.basename(file.fileName || "CurseForge Pack", path.extname(file.fileName || "")));
    const gameDir = await uniqueImportDir(name);
    await fs.mkdir(gameDir, { recursive: true });
    const zip = new AdmZip(temp);
    const manifest = zip.getEntry("manifest.json");
    if (!manifest) throw new Error("Downloaded CurseForge pack is missing manifest.json.");
    const profile = await importCurseForgePack(zip, manifest, { name, gameDir, apiKey });
    return {
      ok: true,
      message: `Installed modpack ${profile.name}.`,
      profile,
      installed: [{ name: file.fileName, path: gameDir }]
    };
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

async function projectInstallPath(profile, type, fileName) {
  const roots = await getLauncherRoots(profile);
  const folder = {
    mod: "mods",
    resourcepack: "resourcepacks",
    shader: "shaderpacks",
    modpack: "modpacks"
  }[type] || "mods";
  const dir = path.join(roots.gameDir, folder);
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, safeName(fileName).replace(/_/g, "-"));
}

async function listProfileContent(profile = {}) {
  const roots = await getLauncherRoots(profile);
  const groups = [
    { type: "mod", enabledDir: "mods", disabledDir: "disabled-mods", extensions: [".jar"] },
    { type: "resourcepack", enabledDir: "resourcepacks", disabledDir: "disabled-resourcepacks", extensions: [".zip"] },
    { type: "shader", enabledDir: "shaderpacks", disabledDir: "disabled-shaderpacks", extensions: [".zip"] }
  ];
  const items = [];
  for (const group of groups) {
    items.push(...await listContentGroup(roots.gameDir, group, true));
    items.push(...await listContentGroup(roots.gameDir, group, false));
  }
  return { ok: true, gameDir: roots.gameDir, items };
}

async function listContentGroup(gameDir, group, enabled) {
  const dir = path.join(gameDir, enabled ? group.enabledDir : group.disabledDir);
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = entries.filter((entry) =>
    entry.isFile() && group.extensions.includes(path.extname(entry.name).toLowerCase())
  );
  return Promise.all(files.map(async (entry) => {
    const fullPath = path.join(dir, entry.name);
    const stats = await fs.stat(fullPath).catch(() => null);
    return {
      id: `${group.type}:${enabled ? "on" : "off"}:${entry.name}`,
      type: group.type,
      name: contentDisplayName(entry.name),
      fileName: entry.name,
      path: fullPath,
      enabled,
      size: stats?.size || 0,
      updated: stats?.mtime?.toISOString?.() || ""
    };
  }));
}

async function toggleProfileContent(options = {}) {
  const profile = options.profile || {};
  const item = options.item || {};
  const roots = await getLauncherRoots(profile);
  const group = contentGroup(item.type);
  const fileName = safeContentFileName(item.fileName);
  const from = path.join(roots.gameDir, item.enabled === false ? group.disabledDir : group.enabledDir, fileName);
  const to = path.join(roots.gameDir, item.enabled === false ? group.enabledDir : group.disabledDir, fileName);
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.rename(from, to);
  return { ok: true, message: `${item.enabled === false ? "Enabled" : "Disabled"} ${fileName}.` };
}

async function deleteProfileContent(options = {}) {
  const profile = options.profile || {};
  const item = options.item || {};
  const roots = await getLauncherRoots(profile);
  const group = contentGroup(item.type);
  const fileName = safeContentFileName(item.fileName);
  const target = path.join(roots.gameDir, item.enabled === false ? group.disabledDir : group.enabledDir, fileName);
  await fs.rm(target, { force: true });
  return { ok: true, message: `Deleted ${fileName}.` };
}

function contentGroup(type) {
  const normalized = normalizeProjectType(type);
  if (normalized === "resourcepack") {
    return { enabledDir: "resourcepacks", disabledDir: "disabled-resourcepacks" };
  }
  if (normalized === "shader") {
    return { enabledDir: "shaderpacks", disabledDir: "disabled-shaderpacks" };
  }
  return { enabledDir: "mods", disabledDir: "disabled-mods" };
}

function safeContentFileName(fileName) {
  const base = path.basename(String(fileName || ""));
  if (!base || base === "." || base === "..") throw new Error("Invalid content file name.");
  return base;
}

function contentDisplayName(fileName) {
  return path.basename(String(fileName || ""), path.extname(String(fileName || "")))
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function minecraftVersions() {
  const manifest = await readJsonFromUrl(manifestUrl, "Minecraft version manifest");
  return {
    latest: manifest.latest,
    versions: (manifest.versions || []).slice(0, 250).map((version) => ({
      id: version.id,
      type: version.type,
      url: version.url,
      releaseTime: version.releaseTime
    }))
  };
}

async function searchModrinth(options = {}) {
  const facets = [];
  const projectType = normalizeProjectType(options.type);
  if (projectType !== "all") facets.push([`project_type:${projectType}`]);
  if (options.version) facets.push([`versions:${String(options.version).trim()}`]);
  if (options.loader && options.loader !== "any") facets.push([`categories:${String(options.loader).toLowerCase()}`]);

  const params = new URLSearchParams({
    query: String(options.query || ""),
    limit: String(Math.min(Number(options.limit || 20), 50)),
    index: options.sort || "relevance"
  });
  if (facets.length) params.set("facets", JSON.stringify(facets));

  const response = await fetch(`https://api.modrinth.com/v2/search?${params}`, {
    headers: {
      "user-agent": `BlockBaseMCLauncher/${app.getVersion()} (Minecraft launcher)`
    }
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json.description || json.error || `Modrinth search failed: HTTP ${response.status}`);
  }

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
      follows: project.follows,
      versions: project.versions || [],
      loaders: (project.categories || []).filter((item) => ["fabric", "forge", "quilt", "neoforge"].includes(item)),
      categories: project.display_categories || project.categories || [],
      updated: project.date_modified,
      url: `https://modrinth.com/${project.project_type}/${project.slug}`
    }))
  };
}

async function searchCurseForge(options = {}) {
  const apiKey = String(options.apiKey || "").trim();
  if (!apiKey) {
    return {
      source: "curseforge",
      needsApiKey: true,
      results: [],
      message: "CurseForge search needs a CurseForge API key."
    };
  }

  const params = new URLSearchParams({
    gameId: "432",
    pageSize: String(Math.min(Number(options.limit || 20), 50)),
    searchFilter: String(options.query || "")
  });
  const classId = curseForgeClassId(options.type);
  if (classId) params.set("classId", String(classId));
  if (options.version) params.set("gameVersion", String(options.version).trim());
  if (options.loader && options.loader !== "any") {
    const loaderType = curseForgeLoaderType(options.loader);
    if (loaderType) params.set("modLoaderType", String(loaderType));
  }

  const response = await fetch(`https://api.curseforge.com/v1/mods/search?${params}`, {
    headers: {
      "x-api-key": apiKey,
      accept: "application/json"
    }
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json.errorMessage || json.message || `CurseForge search failed: HTTP ${response.status}`);
  }

  return {
    source: "curseforge",
    results: (json.data || []).map((project) => ({
      id: String(project.id),
      slug: project.slug,
      title: project.name,
      author: project.authors?.[0]?.name || "CurseForge author",
      description: stripHtml(project.summary || ""),
      type: curseForgeProjectType(project.classId),
      icon: project.logo?.thumbnailUrl || project.logo?.url || "",
      downloads: project.downloadCount || 0,
      follows: project.thumbsUpCount || 0,
      versions: project.latestFilesIndexes?.map((file) => file.gameVersion).filter(Boolean).slice(0, 12) || [],
      loaders: [],
      categories: project.categories?.map((category) => category.name) || [],
      updated: project.dateModified,
      url: project.links?.websiteUrl || `https://www.curseforge.com/minecraft/mc-mods/${project.slug}`
    }))
  };
}

function normalizeProjectType(type) {
  if (type === "modpack" || type === "resourcepack" || type === "shader") return type;
  if (type === "resource-pack") return "resourcepack";
  return type === "mod" ? "mod" : "all";
}

function curseForgeClassId(type) {
  return {
    mod: 6,
    modpack: 4471,
    resourcepack: 12,
    "resource-pack": 12,
    shader: 6552
  }[type] || 6;
}

function curseForgeProjectType(classId) {
  if (classId === 4471) return "modpack";
  if (classId === 12) return "resourcepack";
  if (classId === 6552) return "shader";
  return "mod";
}

function curseForgeLoaderType(loader) {
  return {
    forge: 1,
    cauldron: 2,
    liteloader: 3,
    fabric: 4,
    quilt: 5,
    neoforge: 6
  }[String(loader).toLowerCase()] || null;
}

function stripHtml(value) {
  return String(value).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

async function skinProfile(account = {}) {
  const username = String(account.displayName || account.username || "").trim();
  let uuid = normalizeMinecraftUuid(account.identifier || account.uuid || String(account.id || "").replace(/^java-ms-/, ""));

  if (!uuid && username) {
    const lookup = await readJsonFromUrl(
      `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(username)}`,
      `Mojang UUID for ${username}`
    );
    uuid = normalizeMinecraftUuid(lookup.id);
  }
  if (!uuid) throw new Error("No Minecraft UUID or username is available for this account.");

  const profile = await readJsonFromUrl(
    `https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`,
    `Mojang skin profile for ${username || uuid}`
  );
  const textureProperty = (profile.properties || []).find((property) => property.name === "textures");
  if (!textureProperty?.value) throw new Error("Mojang did not return skin texture data.");

  const textures = JSON.parse(Buffer.from(textureProperty.value, "base64").toString("utf8"));
  const skin = textures.textures?.SKIN || {};
  const skinUrl = skin.url || "";
  if (!skinUrl) throw new Error("This account does not have a custom skin texture.");

  return {
    ok: true,
    uuid,
    username: profile.name || username,
    skinUrl,
    model: skin.metadata?.model === "slim" ? "slim" : "classic",
    capeUrl: textures.textures?.CAPE?.url || "",
    namemcUrl: `https://namemc.com/profile/${uuid}`
  };
}

function normalizeMinecraftUuid(value) {
  const clean = String(value || "").replace(/[^a-fA-F0-9]/g, "");
  return clean.length === 32 ? clean.toLowerCase() : "";
}

async function importMinecraft(options = {}) {
  const mode = ["zip", "minecraft", "prism", "modrinth", "curseforge"].includes(options.mode) ? options.mode : "minecraft";
  const isArchive = ["zip", "modrinth", "curseforge"].includes(mode);
  const titles = {
    zip: "Import ZIP Modpack",
    minecraft: "Import Minecraft Folder",
    prism: "Import Prism/MultiMC Instance",
    modrinth: "Import Modrinth .mrpack",
    curseforge: "Import CurseForge ZIP"
  };
  const selected = await dialog.showOpenDialog(mainWindow, {
    title: titles[mode],
    properties: isArchive ? ["openFile"] : ["openDirectory"],
    filters: isArchive
      ? [{ name: mode === "modrinth" ? "Modrinth packs" : "ZIP files", extensions: mode === "modrinth" ? ["mrpack", "zip"] : ["zip"] }]
      : undefined
  });
  if (selected.canceled || !selected.filePaths?.[0]) {
    return { ok: false, canceled: true, message: "Import cancelled." };
  }

  const sourcePath = selected.filePaths[0];
  const imported = isArchive
    ? await importZipInstance(sourcePath, { source: mode, apiKey: options.apiKey })
    : mode === "prism"
      ? await importPrismMultiMcInstance(sourcePath)
      : await importMinecraftFolder(sourcePath);
  return {
    ok: true,
    message: `Imported ${imported.name}.`,
    profile: imported
  };
}

async function importZipInstance(zipPath, options = {}) {
  const name = safeName(path.basename(zipPath, path.extname(zipPath))) || "Imported ZIP";
  const gameDir = await uniqueImportDir(name);
  await fs.mkdir(gameDir, { recursive: true });
  const zip = new AdmZip(zipPath);
  const modrinthIndex = zip.getEntry("modrinth.index.json");
  const curseManifest = zip.getEntry("manifest.json");
  if (modrinthIndex) {
    return importModrinthPack(zip, modrinthIndex, { name, gameDir });
  }
  if (curseManifest) {
    return importCurseForgePack(zip, curseManifest, { name, gameDir, apiKey: options.apiKey });
  }
  zip.extractAllTo(gameDir, true);
  return importedProfile({ name, gameDir, banner: "Imported from ZIP file" });
}

async function importPrismMultiMcInstance(sourcePath) {
  const minecraftDir = fssync.existsSync(path.join(sourcePath, "minecraft"))
    ? path.join(sourcePath, "minecraft")
    : sourcePath;
  return importMinecraftFolder(minecraftDir);
}

async function importModrinthPack(zip, indexEntry, { name, gameDir }) {
  const index = JSON.parse(indexEntry.getData().toString("utf8"));
  extractPackOverrides(zip, gameDir, ["overrides/", "client-overrides/"]);
  const loaderInfo = detectModrinthPackLoader(index.dependencies || {});
  const files = Array.isArray(index.files) ? index.files : [];
  await mapLimit(files, 8, async (file) => {
    if (file.env?.client === "unsupported") return;
    const downloads = file.downloads || [];
    const url = downloads[0];
    if (!url || !file.path) return;
    const target = path.join(gameDir, ...String(file.path).split(/[\\/]/));
    await downloadFile(url, target, file.hashes?.sha1, path.basename(file.path), false);
  });
  return importedProfile({
    name: safeName(index.name || name),
    gameDir,
    banner: "Imported from Modrinth .mrpack",
    loader: loaderInfo.loader,
    version: loaderInfo.version
  });
}

async function importCurseForgePack(zip, manifestEntry, { name, gameDir, apiKey }) {
  const manifest = JSON.parse(manifestEntry.getData().toString("utf8"));
  const overrideDir = manifest.overrides || "overrides";
  extractPackOverrides(zip, gameDir, [`${overrideDir}/`]);
  const loaderInfo = detectCurseForgePackLoader(manifest);
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  if (files.length && !apiKey) {
    emitLog("info", "CurseForge manifest has external files. Paste a CurseForge API key in Mods & Packs before importing to download them.");
  }
  if (apiKey) {
    await mapLimit(files, 4, async (file) => {
      const info = await curseForgeFileInfo(apiKey, file.projectID, file.fileID);
      if (!info?.downloadUrl) return;
      const target = path.join(gameDir, "mods", safeName(info.fileName || `${file.projectID}-${file.fileID}.jar`));
      await downloadFile(info.downloadUrl, target, null, info.fileName || "CurseForge file", false);
    });
  }
  return importedProfile({
    name: safeName(manifest.name || name),
    gameDir,
    banner: "Imported from CurseForge ZIP",
    loader: loaderInfo.loader,
    version: loaderInfo.version
  });
}

function extractPackOverrides(zip, gameDir, prefixes) {
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const prefix = prefixes.find((item) => entry.entryName.startsWith(item));
    if (!prefix) continue;
    const relative = entry.entryName.slice(prefix.length);
    if (!relative || relative.includes("..")) continue;
    const target = path.join(gameDir, ...relative.split("/"));
    fssync.mkdirSync(path.dirname(target), { recursive: true });
    fssync.writeFileSync(target, entry.getData());
  }
}

function detectModrinthPackLoader(dependencies) {
  const loader =
    dependencies.fabricLoader ? "Fabric" :
      dependencies.quiltLoader ? "Quilt" :
        dependencies.forge ? "Forge" :
          dependencies.neoforge ? "NeoForge" : "Vanilla";
  return {
    loader,
    version: dependencies.minecraft || "1.21.8"
  };
}

function detectCurseForgePackLoader(manifest) {
  const modLoaders = manifest.minecraft?.modLoaders || [];
  const primary = modLoaders.find((item) => item.primary) || modLoaders[0] || {};
  const id = String(primary.id || "").toLowerCase();
  const loader = id.includes("neoforge") ? "NeoForge" : id.includes("forge") ? "Forge" : id.includes("quilt") ? "Quilt" : id.includes("fabric") ? "Fabric" : "Vanilla";
  return {
    loader,
    version: manifest.minecraft?.version || "1.21.8"
  };
}

async function curseForgeFileInfo(apiKey, projectId, fileId) {
  const response = await fetch(`https://api.curseforge.com/v1/mods/${projectId}/files/${fileId}`, {
    headers: { "x-api-key": apiKey, accept: "application/json" }
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.errorMessage || `CurseForge file failed: HTTP ${response.status}`);
  return json.data;
}

async function curseForgeFileDownloadUrl(apiKey, projectId, fileId) {
  const response = await fetch(`https://api.curseforge.com/v1/mods/${projectId}/files/${fileId}/download-url`, {
    headers: { "x-api-key": apiKey, accept: "application/json" }
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) return "";
  return typeof json.data === "string" ? json.data : "";
}

async function curseForgeLatestFile(apiKey, projectId, profile) {
  const params = new URLSearchParams({ pageSize: "25" });
  if (profile.version) params.set("gameVersion", profile.version);
  const loaderType = curseForgeLoaderType(profile.loader);
  if (loaderType) params.set("modLoaderType", String(loaderType));
  const response = await fetch(`https://api.curseforge.com/v1/mods/${projectId}/files?${params}`, {
    headers: { "x-api-key": apiKey, accept: "application/json" }
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) return null;
  return (json.data || []).find((item) => item.releaseType === 1) || json.data?.[0] || null;
}

async function importMinecraftFolder(sourcePath) {
  const sourceName = path.basename(sourcePath) === ".minecraft" ? "Vanilla .minecraft" : path.basename(sourcePath);
  const name = safeName(sourceName || "Imported Minecraft");
  const gameDir = await uniqueImportDir(name);
  await fs.mkdir(gameDir, { recursive: true });
  const detected = await detectImportedMinecraft(sourcePath);

  const copyDirs = ["mods", "config", "saves", "resourcepacks", "shaderpacks", "screenshots", "datapacks"];
  const copyFiles = ["options.txt", "servers.dat"];
  for (const dir of copyDirs) {
    const from = path.join(sourcePath, dir);
    if (fssync.existsSync(from)) {
      await fs.cp(from, path.join(gameDir, dir), { recursive: true, force: true });
    }
  }
  for (const file of copyFiles) {
    const from = path.join(sourcePath, file);
    if (fssync.existsSync(from)) {
      await fs.copyFile(from, path.join(gameDir, file));
    }
  }

  return importedProfile({
    name,
    gameDir,
    banner: "Imported from existing Minecraft folder",
    loader: detected.loader,
    version: detected.version
  });
}

async function detectImportedMinecraft(sourcePath) {
  const detected = { loader: "Vanilla", version: "1.21.8" };
  const prismPack = path.join(sourcePath, "..", "mmc-pack.json");
  try {
    const pack = JSON.parse(await fs.readFile(prismPack, "utf8"));
    for (const component of pack.components || []) {
      if (component.uid === "net.minecraft" && component.version) detected.version = component.version;
      if (component.uid === "net.fabricmc.fabric-loader") detected.loader = "Fabric";
      if (component.uid === "org.quiltmc.quilt-loader") detected.loader = "Quilt";
      if (component.uid === "net.minecraftforge") detected.loader = "Forge";
      if (component.uid === "net.neoforged") detected.loader = "NeoForge";
    }
  } catch {
    // Not a Prism/MultiMC instance, fall back to mod scanning.
  }

  if (detected.loader === "Vanilla") {
    const modsDir = path.join(sourcePath, "mods");
    try {
      const jars = (await fs.readdir(modsDir)).filter((file) => file.endsWith(".jar")).slice(0, 30);
      for (const jar of jars) {
        const zip = new AdmZip(path.join(modsDir, jar));
        if (zip.getEntry("fabric.mod.json")) {
          detected.loader = "Fabric";
          break;
        }
        if (zip.getEntry("quilt.mod.json")) {
          detected.loader = "Quilt";
          break;
        }
      }
    } catch {
      // No mods folder or unreadable jars.
    }
  }

  if (detected.loader === "Fabric") {
    detected.version = await detectFabricMinecraftVersion(sourcePath) || detected.version;
  }

  return detected;
}

async function detectFabricMinecraftVersion(gameDir) {
  const modsDir = path.join(gameDir, "mods");
  const counts = new Map();
  try {
    const jars = (await fs.readdir(modsDir)).filter((file) => file.endsWith(".jar")).slice(0, 200);
    for (const jar of jars) {
      try {
        const zip = new AdmZip(path.join(modsDir, jar));
        const entry = zip.getEntry("fabric.mod.json");
        if (!entry) continue;
        const metadata = JSON.parse(entry.getData().toString("utf8"));
        for (const version of extractMinecraftVersions(metadata.depends?.minecraft)) {
          counts.set(version, (counts.get(version) || 0) + 1);
        }
      } catch {
        // Skip jars with unusual metadata.
      }
    }
  } catch {
    return "";
  }

  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || compareMinecraftVersions(b[0], a[0]))[0]?.[0] || "";
}

function extractMinecraftVersions(requirement) {
  const values = Array.isArray(requirement) ? requirement : [requirement];
  const versions = [];
  for (const value of values.filter(Boolean)) {
    const text = String(value);
    const matches = text.match(/\b1\.\d+(?:\.\d+)?(?:\.\d+)?\b/g) || [];
    if (matches[0]) versions.push(matches[0]);
  }
  return versions;
}

function compareMinecraftVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff) return diff;
  }
  return 0;
}

async function uniqueImportDir(name) {
  const root = path.join(app.getPath("userData"), "minecraft", "imported");
  await fs.mkdir(root, { recursive: true });
  const base = safeName(name);
  let target = path.join(root, base);
  let index = 2;
  while (fssync.existsSync(target)) {
    target = path.join(root, `${base}-${index}`);
    index += 1;
  }
  return target;
}

function importedProfile({ name, gameDir, banner, loader = "Vanilla", version = "1.21.8" }) {
  const id = crypto.randomUUID();
  return {
    id,
    edition: "java",
    name,
    version,
    loader,
    icon: "grass",
    banner,
    accountId: "",
    folder: gameDir,
    javaPath: "",
    ramMin: 1024,
    ramMax: 4096,
    jvmArgs: "-XX:+UseG1GC",
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

async function microsoftLogin(clientId) {
  const cleanClientId = String(clientId || "").trim();
  if (!cleanClientId) {
    throw new Error("Microsoft login needs an Azure app client ID.");
  }

  const useMinecraftLiveAuth = cleanClientId.toLowerCase() === "00000000402b5328";
  const device = useMinecraftLiveAuth
    ? await postForm("https://login.live.com/oauth20_connect.srf", {
      client_id: cleanClientId,
      scope: "service::user.auth.xboxlive.com::MBI_SSL",
      response_type: "device_code"
    })
    : await postForm("https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode", {
      client_id: cleanClientId,
      scope: "XboxLive.signin offline_access"
    });
  const verificationUri = device.verification_uri || device.verification_url || "";
  const browserUri = device.verification_uri_complete || verificationUri;

  mainWindow?.webContents.send("microsoft-device-code", {
    userCode: device.user_code,
    verificationUri,
    verificationUriComplete: device.verification_uri_complete || "",
    message: device.message
  });
  if (browserUri) {
    shell.openExternal(browserUri);
  }

  const token = await pollMicrosoftToken(cleanClientId, device, useMinecraftLiveAuth);
  return finishMicrosoftLogin(cleanClientId, token);
}

async function microsoftReauth(accountId, clientId) {
  const cache = await readMicrosoftAuthCache();
  const cached = findMicrosoftAuth(cache, String(accountId || ""));
  const cleanClientId = String(cached?.clientId || clientId || "").trim();

  if (!cached) {
    throw new Error("No saved Microsoft session was found for this account.");
  }

  if (!cached.refreshToken) {
    throw new Error("This account was added before silent reauth existed.");
  }

  if (!cleanClientId) {
    throw new Error("This saved Microsoft session is missing its client ID.");
  }

  if (cached?.refreshToken && cleanClientId) {
    try {
      const refreshed = await refreshMicrosoftToken(cleanClientId, cached.refreshToken);
      const account = await finishMicrosoftLogin(cleanClientId, refreshed, cached.refreshToken);
      emitLog("info", `Refreshed Microsoft auth for ${account.displayName} without opening the browser.`);
      return { ...account, refreshed: true };
    } catch (error) {
      emitLog("warn", `Saved Microsoft session could not be refreshed: ${error?.message || String(error)}.`);
      throw new Error("Silent reauth failed because Microsoft rejected the saved session.");
    }
  }
}

async function finishMicrosoftLogin(clientId, token, previousRefreshToken = "") {
  const xbl = await xboxLiveAuth(token.access_token);
  const xsts = await xstsAuth(xbl.token);
  const minecraft = await minecraftAuth(xsts.uhs, xsts.token);
  await assertMinecraftEntitlement(minecraft.access_token);
  const profile = await minecraftProfile(minecraft.access_token);
  await saveMicrosoftAuthSession({
    clientId,
    microsoftToken: token,
    minecraft,
    profile,
    xuid: xsts.uhs,
    previousRefreshToken
  });

  return {
    id: `java-ms-${profile.id}`,
    kind: "java",
    displayName: profile.name,
    identifier: profile.id,
    avatar: profile.name.slice(0, 2).toUpperCase(),
    default: false,
    status: "online",
    canRefresh: Boolean(token.refresh_token || previousRefreshToken)
  };
}

function liveMinecraftOAuth(clientId) {
  return new Promise((resolve, reject) => {
    const redirectUri = "https://login.live.com/oauth20_desktop.srf";
    const authUrl =
      "https://login.live.com/oauth20_authorize.srf?" +
      new URLSearchParams({
        client_id: clientId,
        response_type: "code",
        redirect_uri: redirectUri,
        scope: "service::user.auth.xboxlive.com::MBI_SSL",
        prompt: "select_account"
      }).toString();

    const authWindow = new BrowserWindow({
      width: 520,
      height: 720,
      parent: mainWindow,
      modal: true,
      title: "Sign in to Microsoft",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    let finished = false;
    const finish = async (url) => {
      if (finished || !url.startsWith(redirectUri)) return;
      const parsed = new URL(url);
      const code = parsed.searchParams.get("code");
      const error = parsed.searchParams.get("error_description") || parsed.searchParams.get("error");
      if (!code) {
        finished = true;
        authWindow.close();
        reject(new Error(error || "Microsoft login did not return an authorization code."));
        return;
      }

      finished = true;
      authWindow.close();
      try {
        resolve(await exchangeLiveCode(clientId, redirectUri, code));
      } catch (exchangeError) {
        reject(exchangeError);
      }
    };

    authWindow.webContents.on("will-redirect", (_event, url) => finish(url));
    authWindow.webContents.on("will-navigate", (_event, url) => finish(url));
    authWindow.on("closed", () => {
      if (!finished) {
        finished = true;
        reject(new Error("Microsoft login window was closed."));
      }
    });
    authWindow.loadURL(authUrl);
  });
}

function microsoftAuthCachePath() {
  return path.join(app.getPath("userData"), "auth", "microsoft-java.json");
}

async function readMicrosoftAuthCache() {
  try {
    return JSON.parse(await fs.readFile(microsoftAuthCachePath(), "utf8"));
  } catch {
    return { accounts: {} };
  }
}

async function writeMicrosoftAuthCache(cache) {
  const target = microsoftAuthCachePath();
  const temp = `${target}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(temp, JSON.stringify(cache, null, 2));
  await fs.rename(temp, target);
}

async function saveMicrosoftAuthSession({ clientId, microsoftToken, minecraft, profile, xuid, previousRefreshToken = "" }) {
  const id = `java-ms-${profile.id}`;
  const cache = await readMicrosoftAuthCache();
  const expiresIn = Number(minecraft.expires_in || 86400);
  const existing = cache.accounts?.[id] || {};
  cache.accounts = {
    ...(cache.accounts || {}),
    [id]: {
      ...existing,
      id,
      clientId,
      username: profile.name,
      uuid: profile.id,
      xuid: xuid || "0",
      accessToken: minecraft.access_token,
      refreshToken: microsoftToken?.refresh_token || previousRefreshToken || existing.refreshToken || "",
      expiresAt: Date.now() + expiresIn * 1000,
      savedAt: new Date().toISOString()
    }
  };
  await writeMicrosoftAuthCache(cache);
}

async function exchangeLiveCode(clientId, redirectUri, code) {
  return postForm("https://login.live.com/oauth20_token.srf", {
    client_id: clientId,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    scope: "service::user.auth.xboxlive.com::MBI_SSL"
  });
}

async function refreshMicrosoftToken(clientId, refreshToken) {
  const useLiveAuth = String(clientId || "").toLowerCase() === "00000000402b5328";
  const tokenUrl = useLiveAuth
    ? "https://login.live.com/oauth20_token.srf"
    : "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
  const fields = {
    client_id: clientId,
    refresh_token: refreshToken,
    grant_type: "refresh_token"
  };
  fields.scope = useLiveAuth
    ? "service::user.auth.xboxlive.com::MBI_SSL"
    : "XboxLive.signin offline_access";
  return postForm(tokenUrl, fields);
}

async function pollMicrosoftToken(clientId, device, useLiveAuth = false) {
  const started = Date.now();
  let interval = Number(device.interval || 5);
  const tokenUrl = useLiveAuth
    ? "https://login.live.com/oauth20_token.srf"
    : "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";

  while (Date.now() - started < Number(device.expires_in || 900) * 1000) {
    await sleep(interval * 1000);
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: clientId,
        device_code: device.device_code
      })
    });
    const json = await response.json();
    if (response.ok) return json;
    if (json.error === "authorization_pending") continue;
    if (json.error === "slow_down") {
      interval += 5;
      continue;
    }
    throw new Error(json.error_description || json.error || "Microsoft login failed.");
  }

  throw new Error("Microsoft login timed out.");
}

async function xboxLiveAuth(accessToken) {
  let json;
  try {
    json = await xboxLiveAuthWithTicket(`d=${accessToken}`);
  } catch {
    json = await xboxLiveAuthWithTicket(accessToken);
  }
  return {
    token: json.Token,
    uhs: json.DisplayClaims?.xui?.[0]?.uhs
  };
}

async function xboxLiveAuthWithTicket(rpsTicket) {
  return postJson("https://user.auth.xboxlive.com/user/authenticate", {
    Properties: {
      AuthMethod: "RPS",
      SiteName: "user.auth.xboxlive.com",
      RpsTicket: rpsTicket
    },
    RelyingParty: "http://auth.xboxlive.com",
    TokenType: "JWT"
  });
}

async function xstsAuth(userToken) {
  const json = await postJson("https://xsts.auth.xboxlive.com/xsts/authorize", {
    Properties: {
      SandboxId: "RETAIL",
      UserTokens: [userToken]
    },
    RelyingParty: "rp://api.minecraftservices.com/",
    TokenType: "JWT"
  });
  return {
    token: json.Token,
    uhs: json.DisplayClaims?.xui?.[0]?.uhs
  };
}

async function minecraftAuth(uhs, xstsToken) {
  return postJson("https://api.minecraftservices.com/authentication/login_with_xbox", {
    identityToken: `XBL3.0 x=${uhs};${xstsToken}`
  });
}

async function assertMinecraftEntitlement(accessToken) {
  const json = await getJson("https://api.minecraftservices.com/entitlements/mcstore", accessToken);
  const ownsGame = Array.isArray(json.items) && json.items.some((item) => item.name === "game_minecraft");
  if (!ownsGame) {
    throw new Error("This Microsoft account does not appear to own Minecraft: Java Edition.");
  }
}

async function minecraftProfile(accessToken) {
  const response = await fetch("https://api.minecraftservices.com/minecraft/profile", {
    headers: { authorization: `Bearer ${accessToken}` }
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json.errorMessage || "Could not fetch Minecraft profile.");
  }
  return json;
}

async function postForm(url, fields) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields)
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json.error_description || json.error || `Request failed: ${response.status}`);
  }
  return json;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body)
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const xstsHelp =
      json.XErr === 2148916233
        ? "This Microsoft account does not have an Xbox profile."
        : json.XErr === 2148916238
          ? "This Microsoft account is under 18 and cannot proceed without family settings."
          : null;
    throw new Error(xstsHelp || json.Message || json.errorMessage || `Request failed: ${response.status}`);
  }
  return json;
}

async function getJson(url, accessToken) {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" }
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json.errorMessage || `Request failed: ${response.status}`);
  }
  return json;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function javaCheck(javaCommand) {
  return new Promise((resolve) => {
    const child = spawn(javaCommand, ["-version"], { windowsHide: true });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      resolve({ ok: false, message: error.message, commandPreview: [] });
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({
          ok: true,
          message: stderr.split(/\r?\n/).find(Boolean) || "Java detected",
          commandPreview: []
        });
        return;
      }

      resolve({ ok: false, message: `Java exited with status ${code}`, commandPreview: [] });
    });
  });
}

function emitLog(level, message) {
  if (!message) return;
  mainWindow?.webContents.send("launch-log", {
    level,
    message,
    timestamp: new Date().toISOString()
  });
}

function safeName(value) {
  return String(value || "profile").replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").slice(0, 80);
}

function safePlayerName(value) {
  const cleaned = String(value || "Player").replace(/[^A-Za-z0-9_]/g, "").slice(0, 16);
  return cleaned || "Player";
}
