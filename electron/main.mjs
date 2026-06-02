import { app, BrowserWindow, Menu, Tray, nativeImage, screen } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.commandLine.appendSwitch("use-mock-keychain");
app.commandLine.appendSwitch("password-store", "basic");
app.commandLine.appendSwitch("disable-features", "DialMediaRouteProvider");

let tray;
let mainWindow;
let serverHandle;
let hasManualWindowPosition = false;
let lastTrayActivation = 0;

function createTrayIcon() {
  const iconPath = path.join(__dirname, "trayIcon.png");
  let icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    icon = nativeImage.createFromPath(path.join(__dirname, "trayTemplate.svg"));
  }
  const resized = icon.resize({ width: 22, height: 22, quality: "best" });
  resized.setTemplateImage(true);
  return resized;
}

function createDockIcon() {
  const icon = nativeImage.createFromPath(path.join(__dirname, "dockIcon.png"));
  return icon.isEmpty() ? createTrayIcon() : icon;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function positionWindowBelowTray() {
  if (!tray || !mainWindow) return;

  const trayBounds = tray.getBounds();
  const windowBounds = mainWindow.getBounds();
  const display = screen.getDisplayNearestPoint({
    x: Math.round(trayBounds.x + trayBounds.width / 2),
    y: Math.round(trayBounds.y + trayBounds.height / 2),
  });
  const area = display.workArea;

  const x = clamp(
    Math.round(trayBounds.x + trayBounds.width / 2 - windowBounds.width / 2),
    area.x + 8,
    area.x + area.width - windowBounds.width - 8,
  );
  const y = clamp(trayBounds.y + trayBounds.height + 6, area.y + 8, area.y + area.height - windowBounds.height - 8);

  mainWindow.setPosition(x, y, false);
}

function showWindow({ resetPosition = false } = {}) {
  if (!mainWindow) return;
  if (resetPosition || !hasManualWindowPosition) {
    positionWindowBelowTray();
    hasManualWindowPosition = false;
  }
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.show();
  mainWindow.moveTop();
  mainWindow.focus();
  setTimeout(() => {
    if (!mainWindow?.isDestroyed()) {
      mainWindow.setVisibleOnAllWorkspaces(false);
    }
  }, 600);
}

function toggleWindow({ resetPosition = false } = {}) {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) {
    mainWindow.hide();
    return;
  }
  showWindow({ resetPosition });
}

function activateFromTray() {
  const now = Date.now();
  if (now - lastTrayActivation < 240) return;
  lastTrayActivation = now;
  toggleWindow();
}

function updateTrayMenu() {
  if (!tray || !serverHandle) return;
  const menu = Menu.buildFromTemplate([
    {
      label: mainWindow?.isVisible() ? "Hide Codex Refit" : "Show Codex Refit",
      click: toggleWindow,
    },
    {
      label: "Reset Window Position",
      click: () => showWindow({ resetPosition: true }),
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => app.quit(),
    },
  ]);

  tray.setContextMenu(menu);
}

function installApplicationMenu() {
  const showItem = () => ({
    label: "Show Codex Refit",
    accelerator: "CommandOrControl+0",
    click: () => showWindow(),
  });
  const resetItem = () => ({
    label: "Reset Window Position",
    click: () => showWindow({ resetPosition: true }),
  });
  const quitItem = () => ({
    label: "Quit Codex Refit",
    accelerator: process.platform === "darwin" ? "Command+Q" : "Ctrl+Q",
    click: () => app.quit(),
  });

  const template =
    process.platform === "darwin"
      ? [
          {
            label: "Codex Refit",
            submenu: [
              { role: "about" },
              { type: "separator" },
              showItem(),
              resetItem(),
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              quitItem(),
            ],
          },
          {
            label: "Window",
            submenu: [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, showItem(), resetItem()],
          },
        ]
      : [
          {
            label: "Codex Refit",
            submenu: [showItem(), resetItem(), { type: "separator" }, quitItem()],
          },
        ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createMainWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 560,
    minWidth: 460,
    minHeight: 420,
    show: false,
    movable: true,
    resizable: true,
    skipTaskbar: false,
    title: "Codex Refit",
    titleBarStyle: "default",
    transparent: false,
    backgroundColor: "#030303",
    icon: path.join(__dirname, "dockIcon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  mainWindow.loadURL(url);
  const markManualWindowPosition = () => {
    if (mainWindow?.isVisible()) hasManualWindowPosition = true;
  };
  mainWindow.on("move", markManualWindowPosition);
  mainWindow.on("moved", markManualWindowPosition);
  mainWindow.on("show", updateTrayMenu);
  mainWindow.on("hide", updateTrayMenu);
  mainWindow.on("close", (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

app.setName("Codex Refit");
app.setAboutPanelOptions({
  applicationName: "Codex Refit",
  applicationVersion: "0.1.0",
  copyright: "Local Codex maintenance helper",
});

app.whenReady().then(async () => {
  if (app.dock) {
    app.dock.setIcon(createDockIcon());
    app.dock.show();
  }
  process.env.CODEX_REFIT_DATA_DIR ||= path.join(app.getPath("userData"), "data");

  serverHandle = await startServer();
  createMainWindow(serverHandle.url);
  installApplicationMenu();

  tray = new Tray(createTrayIcon());
  if (process.platform === "darwin") tray.setTitle(" Refit");
  tray.setToolTip("Codex Refit");
  tray.setIgnoreDoubleClickEvents(true);
  tray.on("click", activateFromTray);
  tray.on("right-click", updateTrayMenu);
  updateTrayMenu();
  showWindow();
});

app.on("before-quit", () => {
  app.isQuitting = true;
  serverHandle?.server?.close();
});

app.on("window-all-closed", () => {});
