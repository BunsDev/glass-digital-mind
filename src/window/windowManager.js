const { BrowserWindow, globalShortcut, screen, app, shell } = require('electron');
const WindowLayoutManager = require('./windowLayoutManager');
const SmoothMovementManager = require('./smoothMovementManager');
const path = require('node:path');
const os = require('os');
const shortcutsService = require('../features/shortcuts/shortcutsService');
const internalBridge = require('../bridge/internalBridge');
const permissionRepository = require('../features/common/repositories/permission');

// internalBridge 이벤트 리스너 설정
function setupInternalBridgeListeners() {
    // 창 표시/숨기기 요청
    internalBridge.on('show-window', (windowName, options = {}) => {
        console.log(`[WindowManager] Received show-window request for: ${windowName}`);
        switch (windowName) {
            case 'settings':
                showSettingsWindow(options.bounds);
                break;
            case 'ask':
                ensureAskWindowVisible();
                break;
            default:
                console.warn(`[WindowManager] Unknown window name: ${windowName}`);
        }
    });

    internalBridge.on('hide-window', (windowName) => {
        console.log(`[WindowManager] Received hide-window request for: ${windowName}`);
        switch (windowName) {
            case 'settings':
                hideSettingsWindow();
                break;
            case 'ask':
                closeAskWindow();
                break;
            default:
                console.warn(`[WindowManager] Unknown window name: ${windowName}`);
        }
    });

    internalBridge.on('toggle-visibility', () => {
        console.log(`[WindowManager] Received toggle-visibility request`);
        toggleAllWindowsVisibility();
    });

    internalBridge.on('set-content-protection', (enabled) => {
        console.log(`[WindowManager] Received set-content-protection request: ${enabled}`);
        setContentProtection(enabled);
    });

    console.log('[WindowManager] Internal bridge listeners configured');
}

// 초기화 시 내부 브릿지 리스너 설정
setupInternalBridgeListeners();

/* ────────────────[ GLASS BYPASS ]─────────────── */
let liquidGlass;
const isLiquidGlassSupported = () => {
    if (process.platform !== 'darwin') {
        return false;
    }
    const majorVersion = parseInt(os.release().split('.')[0], 10);
    // return majorVersion >= 25; // macOS 26+ (Darwin 25+)
    return majorVersion >= 26; // See you soon!
};
let shouldUseLiquidGlass = isLiquidGlassSupported();
if (shouldUseLiquidGlass) {
    try {
        liquidGlass = require('electron-liquid-glass');
    } catch (e) {
        console.warn('Could not load optional dependency "electron-liquid-glass". The feature will be disabled.');
        shouldUseLiquidGlass = false;
    }
}
/* ────────────────[ GLASS BYPASS ]─────────────── */

let isContentProtectionOn = true;
let currentDisplayId = null;

let mouseEventsIgnored = false;
let lastVisibleWindows = new Set(['header']);
const HEADER_HEIGHT = 47;
const DEFAULT_WINDOW_WIDTH = 353;

let currentHeaderState = 'apikey';
const windowPool = new Map();
let fixedYPosition = 0;

let settingsHideTimer = null;

let selectedCaptureSourceId = null;

// let shortcutEditorWindow = null;
let layoutManager = null;
function updateLayout() {
    if (layoutManager) {
        layoutManager.updateLayout();
    }
}

let movementManager = null;

const setContentProtection = (status) => {
    isContentProtectionOn = status;
    console.log(`[Protection] Content protection toggled to: ${isContentProtectionOn}`);
    windowPool.forEach(win => {
        if (win && !win.isDestroyed()) {
            win.setContentProtection(isContentProtectionOn);
        }
    });
};

const getContentProtectionStatus = () => isContentProtectionOn;

const toggleContentProtection = () => {
    const newStatus = !getContentProtectionStatus();
    setContentProtection(newStatus);
    return newStatus;
};

const resizeHeaderWindow = ({ width, height }) => {
    const header = windowPool.get('header');
    if (header) {
      console.log(`[WindowManager] Resize request: ${width}x${height}`);
      
      if (movementManager && movementManager.isAnimating) {
        console.log('[WindowManager] Skipping resize during animation');
        return { success: false, error: 'Cannot resize during animation' };
      }

      const currentBounds = header.getBounds();
      console.log(`[WindowManager] Current bounds: ${currentBounds.width}x${currentBounds.height} at (${currentBounds.x}, ${currentBounds.y})`);
      
      if (currentBounds.width === width && currentBounds.height === height) {
        console.log('[WindowManager] Already at target size, skipping resize');
        return { success: true };
      }

      const wasResizable = header.isResizable();
      if (!wasResizable) {
        header.setResizable(true);
      }

      const centerX = currentBounds.x + currentBounds.width / 2;
      const newX = Math.round(centerX - width / 2);

      const display = getCurrentDisplay(header);
      const { x: workAreaX, width: workAreaWidth } = display.workArea;
      
      const clampedX = Math.max(workAreaX, Math.min(workAreaX + workAreaWidth - width, newX));

      header.setBounds({ x: clampedX, y: currentBounds.y, width, height });

      if (!wasResizable) {
        header.setResizable(false);
      }
      
      if (updateLayout) {
        updateLayout();
      }
      
      return { success: true };
    }
    return { success: false, error: 'Header window not found' };
};

const openShortcutEditor = () => {
    const header = windowPool.get('header');
    if (!header) return;
    globalShortcut.unregisterAll();
    createFeatureWindows(header, 'shortcut-settings');
};

const showSettingsWindow = (bounds) => {
    if (!bounds) return;
    const win = windowPool.get('settings');
    if (win && !win.isDestroyed()) {
      if (settingsHideTimer) {
        clearTimeout(settingsHideTimer);
        settingsHideTimer = null;
      }
      const header = windowPool.get('header');
      const headerBounds = header?.getBounds() ?? { x: 0, y: 0 };
      const settingsBounds = win.getBounds();
      const disp = getCurrentDisplay(header);
      const { x: waX, y: waY, width: waW, height: waH } = disp.workArea;
      let x = Math.round(headerBounds.x + (bounds?.x ?? 0) + (bounds?.width ?? 0) / 2 - settingsBounds.width / 2);
      let y = Math.round(headerBounds.y + (bounds?.y ?? 0) + (bounds?.height ?? 0) + 31);
      x = Math.max(waX + 10, Math.min(waX + waW - settingsBounds.width - 10, x));
      y = Math.max(waY + 10, Math.min(waY + waH - settingsBounds.height - 10, y));
      win.setBounds({ x, y });
      win.__lockedByButton = true;
      win.show();
      win.moveTop();
      win.setAlwaysOnTop(true);
    }
};

const hideSettingsWindow = () => {
    const window = windowPool.get("settings");
    if (window && !window.isDestroyed()) {
      if (settingsHideTimer) {
        clearTimeout(settingsHideTimer);
      }
      settingsHideTimer = setTimeout(() => {
        if (window && !window.isDestroyed()) {
          window.setAlwaysOnTop(false);
          window.hide();
        }
        settingsHideTimer = null;
      }, 200);
      
      window.__lockedByButton = false;
    }
};

const cancelHideSettingsWindow = () => {
    if (settingsHideTimer) {
      clearTimeout(settingsHideTimer);
      settingsHideTimer = null;
    }
};

const openLoginPage = () => {
    const webUrl = process.env.pickleglass_WEB_URL || 'http://localhost:3000';
    const personalizeUrl = `${webUrl}/personalize?desktop=true`;
    shell.openExternal(personalizeUrl);
    console.log('Opening personalization page:', personalizeUrl);
};

const moveWindowStep = (direction) => {
    if (movementManager) {
        movementManager.moveStep(direction);
    }
};


function createFeatureWindows(header, namesToCreate) {
    // if (windowPool.has('listen')) return;

    const commonChildOptions = {
        parent: header,
        show: false,
        frame: false,
        transparent: true,
        vibrancy: false,
        hasShadow: false,
        skipTaskbar: true,
        hiddenInMissionControl: true,
        resizable: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, '../preload.js'),
        },
    };

    const createFeatureWindow = (name) => {
        if (windowPool.has(name)) return;
        
        switch (name) {
            case 'listen': {
                const listen = new BrowserWindow({
                    ...commonChildOptions, width:400,minWidth:400,maxWidth:900,
                    maxHeight:900,
                });
                listen.setContentProtection(isContentProtectionOn);
                listen.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true});
                if (process.platform === 'darwin') {
                    listen.setWindowButtonVisibility(false);
                }
                const listenLoadOptions = { query: { view: 'listen' } };
                if (!shouldUseLiquidGlass) {
                    listen.loadFile(path.join(__dirname, '../ui/app/content.html'), listenLoadOptions);
                }
                else {
                    listenLoadOptions.query.glass = 'true';
                    listen.loadFile(path.join(__dirname, '../ui/app/content.html'), listenLoadOptions);
                    listen.webContents.once('did-finish-load', () => {
                        const viewId = liquidGlass.addView(listen.getNativeWindowHandle());
                        if (viewId !== -1) {
                            liquidGlass.unstable_setVariant(viewId, liquidGlass.GlassMaterialVariant.bubbles);
                            // liquidGlass.unstable_setScrim(viewId, 1);
                            // liquidGlass.unstable_setSubdued(viewId, 1);
                        }
                    });
                }
                if (!app.isPackaged) {
                    listen.webContents.openDevTools({ mode: 'detach' });
                }
                windowPool.set('listen', listen);
                break;
            }

            // ask
            case 'ask': {
                const ask = new BrowserWindow({ ...commonChildOptions, width:600 });
                ask.setContentProtection(isContentProtectionOn);
                ask.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true});
                if (process.platform === 'darwin') {
                    ask.setWindowButtonVisibility(false);
                }
                const askLoadOptions = { query: { view: 'ask' } };
                if (!shouldUseLiquidGlass) {
                    ask.loadFile(path.join(__dirname, '../ui/app/content.html'), askLoadOptions);
                }
                else {
                    askLoadOptions.query.glass = 'true';
                    ask.loadFile(path.join(__dirname, '../ui/app/content.html'), askLoadOptions);
                    ask.webContents.once('did-finish-load', () => {
                        const viewId = liquidGlass.addView(ask.getNativeWindowHandle());
                        if (viewId !== -1) {
                            liquidGlass.unstable_setVariant(viewId, liquidGlass.GlassMaterialVariant.bubbles);
                            // liquidGlass.unstable_setScrim(viewId, 1);
                            // liquidGlass.unstable_setSubdued(viewId, 1);
                        }
                    });
                }
                
                // Open DevTools in development
                if (!app.isPackaged) {
                    ask.webContents.openDevTools({ mode: 'detach' });
                }
                
                ask.on('closed', () => {
                    console.log('[WindowManager] Ask window closed, removing from pool.');
                    windowPool.delete('ask');
                });
                
                windowPool.set('ask', ask);
                break;
            }

            // settings
            case 'settings': {
                const settings = new BrowserWindow({ ...commonChildOptions, width:240, maxHeight:400, parent:undefined });
                settings.setContentProtection(isContentProtectionOn);
                settings.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true});
                if (process.platform === 'darwin') {
                    settings.setWindowButtonVisibility(false);
                }
                const settingsLoadOptions = { query: { view: 'settings' } };
                if (!shouldUseLiquidGlass) {
                    settings.loadFile(path.join(__dirname,'../ui/app/content.html'), settingsLoadOptions)
                        .catch(console.error);
                }
                else {
                    settingsLoadOptions.query.glass = 'true';
                    settings.loadFile(path.join(__dirname,'../ui/app/content.html'), settingsLoadOptions)
                        .catch(console.error);
                    settings.webContents.once('did-finish-load', () => {
                        const viewId = liquidGlass.addView(settings.getNativeWindowHandle());
                        if (viewId !== -1) {
                            liquidGlass.unstable_setVariant(viewId, liquidGlass.GlassMaterialVariant.bubbles);
                            // liquidGlass.unstable_setScrim(viewId, 1);
                            // liquidGlass.unstable_setSubdued(viewId, 1);
                        }
                    });
                }
                windowPool.set('settings', settings);  

                if (!app.isPackaged) {
                    settings.webContents.openDevTools({ mode: 'detach' });
                }
                break;
            }

            case 'shortcut-settings': {
                const shortcutEditor = new BrowserWindow({
                    ...commonChildOptions,
                    width: 420,
                    height: 720,
                    modal: false,
                    parent: undefined,
                    alwaysOnTop: true,
                    titleBarOverlay: false,
                });

                if (process.platform === 'darwin') {
                    shortcutEditor.setAlwaysOnTop(true, 'screen-saver');
                } else {
                    shortcutEditor.setAlwaysOnTop(true);
                }
            
                /* ──────────[ ① 다른 창 클릭 차단 ]────────── */
                const disableClicks = () => {
                    for (const [name, win] of windowPool) {
                        if (win !== shortcutEditor && !win.isDestroyed()) {
                            win.setIgnoreMouseEvents(true, { forward: true });
                        }
                    }
                };
                const restoreClicks = () => {
                    for (const [, win] of windowPool) {
                        if (!win.isDestroyed()) win.setIgnoreMouseEvents(false);
                    }
                };

                const header = windowPool.get('header');
                if (header && !header.isDestroyed()) {
                    const { x, y, width } = header.getBounds();
                    shortcutEditor.setBounds({ x, y, width });
                }

                shortcutEditor.once('ready-to-show', () => {
                    disableClicks(); 
                    shortcutEditor.show();
                });

                const loadOptions = { query: { view: 'shortcut-settings' } };
                if (!shouldUseLiquidGlass) {
                    shortcutEditor.loadFile(path.join(__dirname, '../ui/app/content.html'), loadOptions);
                } else {
                    loadOptions.query.glass = 'true';
                    shortcutEditor.loadFile(path.join(__dirname, '../ui/app/content.html'), loadOptions);
                    shortcutEditor.webContents.once('did-finish-load', () => {
                        const viewId = liquidGlass.addView(shortcutEditor.getNativeWindowHandle());
                        if (viewId !== -1) {
                            liquidGlass.unstable_setVariant(viewId, liquidGlass.GlassMaterialVariant.bubbles);
                        }
                    });
                }
                
                shortcutEditor.on('closed', () => {
                    restoreClicks();
                    windowPool.delete('shortcut-settings');
                    console.log('[Shortcuts] Re-enabled after editing.');
                    shortcutsService.registerShortcuts();
                });

                shortcutEditor.webContents.once('dom-ready', async () => {
                    const keybinds = await shortcutsService.loadKeybinds();
                    shortcutEditor.webContents.send('load-shortcuts', keybinds);
                });

                if (!app.isPackaged) {
                    shortcutEditor.webContents.openDevTools({ mode: 'detach' });
                }
                windowPool.set('shortcut-settings', shortcutEditor);
                break;
            }
        }
    };

    if (Array.isArray(namesToCreate)) {
        namesToCreate.forEach(name => createFeatureWindow(name));
    } else if (typeof namesToCreate === 'string') {
        createFeatureWindow(namesToCreate);
    } else {
        createFeatureWindow('listen');
        createFeatureWindow('ask');
        createFeatureWindow('settings');
    }
}

function destroyFeatureWindows() {
    const featureWindows = ['listen','ask','settings','shortcut-settings'];
    if (settingsHideTimer) {
        clearTimeout(settingsHideTimer);
        settingsHideTimer = null;
    }
    featureWindows.forEach(name=>{
        const win = windowPool.get(name);
        if (win && !win.isDestroyed()) win.destroy();
        windowPool.delete(name);
    });
}



function getCurrentDisplay(window) {
    if (!window || window.isDestroyed()) return screen.getPrimaryDisplay();

    const windowBounds = window.getBounds();
    const windowCenter = {
        x: windowBounds.x + windowBounds.width / 2,
        y: windowBounds.y + windowBounds.height / 2,
    };

    return screen.getDisplayNearestPoint(windowCenter);
}

function getDisplayById(displayId) {
    const displays = screen.getAllDisplays();
    return displays.find(d => d.id === displayId) || screen.getPrimaryDisplay();
}



function toggleAllWindowsVisibility() {
    const header = windowPool.get('header');
    if (!header) return;
  
    if (header.isVisible()) {
      lastVisibleWindows.clear();
  
      windowPool.forEach((win, name) => {
        if (win && !win.isDestroyed() && win.isVisible()) {
          lastVisibleWindows.add(name);
        }
      });
  
      lastVisibleWindows.forEach(name => {
        if (name === 'header') return;
        const win = windowPool.get(name);
        if (win && !win.isDestroyed()) win.hide();
      });
      header.hide();
  
      return;
    }
  
    lastVisibleWindows.forEach(name => {
      const win = windowPool.get(name);
      if (win && !win.isDestroyed())
        win.show();
    });
  }


function createWindows() {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { y: workAreaY, width: screenWidth } = primaryDisplay.workArea;

    const initialX = Math.round((screenWidth - DEFAULT_WINDOW_WIDTH) / 2);
    const initialY = workAreaY + 21;
    movementManager = new SmoothMovementManager(windowPool, getDisplayById, getCurrentDisplay, updateLayout);
    
    const header = new BrowserWindow({
        width: DEFAULT_WINDOW_WIDTH,
        height: HEADER_HEIGHT,
        x: initialX,
        y: initialY,
        frame: false,
        transparent: true,
        vibrancy: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        hiddenInMissionControl: true,
        resizable: false,
        focusable: true,
        acceptFirstMouse: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, '../preload.js'),
            backgroundThrottling: false,
            webSecurity: false,
            enableRemoteModule: false,
            // Ensure proper rendering and prevent pixelation
            experimentalFeatures: false,
        },
        // Prevent pixelation and ensure proper rendering
        useContentSize: true,
        disableAutoHideCursor: true,
    });
    if (process.platform === 'darwin') {
        header.setWindowButtonVisibility(false);
    }
    const headerLoadOptions = {};
    if (!shouldUseLiquidGlass) {
        header.loadFile(path.join(__dirname, '../ui/app/header.html'), headerLoadOptions);
    }
    else {
        headerLoadOptions.query = { glass: 'true' };
        header.loadFile(path.join(__dirname, '../ui/app/header.html'), headerLoadOptions);
        header.webContents.once('did-finish-load', () => {
            const viewId = liquidGlass.addView(header.getNativeWindowHandle());
            if (viewId !== -1) {
                liquidGlass.unstable_setVariant(viewId, liquidGlass.GlassMaterialVariant.bubbles);
                // liquidGlass.unstable_setScrim(viewId, 1); 
                // liquidGlass.unstable_setSubdued(viewId, 1);
            }
        });
    }
    windowPool.set('header', header);
    header.on('moved', updateLayout);
    layoutManager = new WindowLayoutManager(windowPool);

    header.webContents.once('dom-ready', () => {
        shortcutsService.initialize(movementManager, windowPool);
        shortcutsService.registerShortcuts();
    });

    setupIpcHandlers(movementManager);

    if (currentHeaderState === 'main') {
        createFeatureWindows(header, ['listen', 'ask', 'settings', 'shortcut-settings']);
    }

    header.setContentProtection(isContentProtectionOn);
    header.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    
    // Open DevTools in development
    if (!app.isPackaged) {
        header.webContents.openDevTools({ mode: 'detach' });
    }

    header.on('focus', () => {
        console.log('[WindowManager] Header gained focus');
    });

    header.on('blur', () => {
        console.log('[WindowManager] Header lost focus');
    });

    header.webContents.on('before-input-event', (event, input) => {
        if (input.type === 'mouseDown') {
            const target = input.target;
            if (target && (target.includes('input') || target.includes('apikey'))) {
                header.focus();
            }
        }
    });

    header.on('resize', () => {
        console.log('[WindowManager] Header resize event triggered');
        updateLayout();
    });

    return windowPool;
}

function setupIpcHandlers(movementManager) {
    // quit-application handler moved to windowBridge.js to avoid duplication
    screen.on('display-added', (event, newDisplay) => {
        console.log('[Display] New display added:', newDisplay.id);
    });

    screen.on('display-removed', (event, oldDisplay) => {
        console.log('[Display] Display removed:', oldDisplay.id);
        const header = windowPool.get('header');
        if (header && getCurrentDisplay(header).id === oldDisplay.id) {
            const primaryDisplay = screen.getPrimaryDisplay();
            movementManager.moveToDisplay(primaryDisplay.id);
        }
    });

    screen.on('display-metrics-changed', (event, display, changedMetrics) => {
        // console.log('[Display] Display metrics changed:', display.id, changedMetrics);
        updateLayout();
    });
}

const handleHeaderStateChanged = (state) => {
    console.log(`[WindowManager] Header state changed to: ${state}`);
    currentHeaderState = state;

    if (state === 'main') {
        createFeatureWindows(windowPool.get('header'));
    } else {         // 'apikey' | 'permission'
        destroyFeatureWindows();
    }
    internalBridge.emit('reregister-shortcuts');
};

const handleHeaderAnimationFinished = (state) => {
    const header = windowPool.get('header');
    if (!header || header.isDestroyed()) return;

    if (state === 'hidden') {
        header.hide();
        console.log('[WindowManager] Header hidden after animation.');
    } else if (state === 'visible') {
        console.log('[WindowManager] Header shown after animation.');
        updateLayout();
    }
};

const getHeaderPosition = () => {
    const header = windowPool.get('header');
    if (header) {
        const [x, y] = header.getPosition();
        return { x, y };
    }
    return { x: 0, y: 0 };
};

const moveHeader = (newX, newY) => {
    const header = windowPool.get('header');
    if (header) {
        const currentY = newY !== undefined ? newY : header.getBounds().y;
        header.setPosition(newX, currentY, false);
        updateLayout();
    }
};

const moveHeaderTo = (newX, newY) => {
    const header = windowPool.get('header');
    if (header) {
        const targetDisplay = screen.getDisplayNearestPoint({ x: newX, y: newY });
        const { x: workAreaX, y: workAreaY, width, height } = targetDisplay.workArea;
        const headerBounds = header.getBounds();

        let clampedX = newX;
        let clampedY = newY;
        
        if (newX < workAreaX) {
            clampedX = workAreaX;
        } else if (newX + headerBounds.width > workAreaX + width) {
            clampedX = workAreaX + width - headerBounds.width;
        }
        
        if (newY < workAreaY) {
            clampedY = workAreaY;
        } else if (newY + headerBounds.height > workAreaY + height) {
            clampedY = workAreaY + height - headerBounds.height;
        }

        header.setPosition(clampedX, clampedY, false);
        updateLayout();
    }
};

const adjustWindowHeight = (sender, targetHeight) => {
    const senderWindow = BrowserWindow.fromWebContents(sender);
    if (senderWindow) {
        const wasResizable = senderWindow.isResizable();
        if (!wasResizable) {
            senderWindow.setResizable(true);
        }

        const currentBounds = senderWindow.getBounds();
        const minHeight = senderWindow.getMinimumSize()[1];
        const maxHeight = senderWindow.getMaximumSize()[1];
        
        let adjustedHeight;
        if (maxHeight === 0) {
            adjustedHeight = Math.max(minHeight, targetHeight);
        } else {
            adjustedHeight = Math.max(minHeight, Math.min(maxHeight, targetHeight));
        }
        
        senderWindow.setSize(currentBounds.width, adjustedHeight, false);

        if (!wasResizable) {
            senderWindow.setResizable(false);
        }

        updateLayout();
    }
};

const handleAnimationFinished = (sender) => {
    const win = BrowserWindow.fromWebContents(sender);
    if (win && !win.isDestroyed()) {
        console.log(`[WindowManager] Hiding window after animation.`);
        win.hide();
    }
};

const closeAskWindow = () => {
    const askWindow = windowPool.get('ask');
    if (askWindow) {
        askWindow.webContents.send('window-hide-animation');
    }
};

async function ensureAskWindowVisible() {
    if (currentHeaderState !== 'main') {
        console.log('[WindowManager] Not in main state, skipping ensureAskWindowVisible');
        return;
    }

    let askWindow = windowPool.get('ask');

    if (!askWindow || askWindow.isDestroyed()) {
        console.log('[WindowManager] Ask window not found, creating new one');
        createFeatureWindows(windowPool.get('header'), 'ask');
        askWindow = windowPool.get('ask');
    }

    if (!askWindow.isVisible()) {
        console.log('[WindowManager] Showing hidden Ask window');
        askWindow.show();
        updateLayout();
        askWindow.webContents.send('window-show-animation');
    }
}


//////// after_modelStateService ////////

const closeWindow = (windowName) => {
    const win = windowPool.get(windowName);
    if (win && !win.isDestroyed()) {
        win.close();
    }
};

module.exports = {
    updateLayout,
    createWindows,
    windowPool,
    fixedYPosition,
    toggleContentProtection,
    resizeHeaderWindow,
    getContentProtectionStatus,
    openShortcutEditor,
    showSettingsWindow,
    hideSettingsWindow,
    cancelHideSettingsWindow,
    openLoginPage,
    moveWindowStep,
    closeWindow,
    toggleAllWindowsVisibility,
    handleHeaderStateChanged,
    handleHeaderAnimationFinished,
    getHeaderPosition,
    moveHeader,
    moveHeaderTo,
    adjustWindowHeight,
    handleAnimationFinished,
    closeAskWindow,
    ensureAskWindowVisible,
};