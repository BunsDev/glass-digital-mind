const { BrowserWindow, globalShortcut, ipcMain, screen, app, shell, desktopCapturer } = require('electron');
const WindowLayoutManager = require('./windowLayoutManager');
const SmoothMovementManager = require('./smoothMovementManager');
const path = require('node:path');
const fs = require('node:fs');
const os = require('os');
const util = require('util');
const execFile = util.promisify(require('child_process').execFile);
const listenService = require('../features/listen/listenService');
const shortcutsService = require('../features/shortcuts/shortcutsService');

// Try to load sharp, but don't fail if it's not available
let sharp;
try {
    sharp = require('sharp');
    console.log('[WindowManager] Sharp module loaded successfully');
} catch (error) {
    console.warn('[WindowManager] Sharp module not available:', error.message);
    console.warn('[WindowManager] Screenshot functionality will work with reduced image processing capabilities');
    sharp = null;
}
const authService = require('../features/common/services/authService');
const systemSettingsRepository = require('../features/common/repositories/systemSettings');

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
let lastScreenshot = null;

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
const windowBridge = require('../bridge/windowBridge');



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
                    shortcutsService.registerShortcuts(movementManager, windowPool);
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
        shortcutsService.registerShortcuts(movementManager, windowPool);
    });

    setupIpcHandlers(movementManager);
    
    // Content protection helper functions
    const getContentProtectionStatus = () => isContentProtectionOn;
    const setContentProtection = (status) => {
        isContentProtectionOn = status;
        console.log(`[Protection] Content protection toggled to: ${isContentProtectionOn}`);
        windowPool.forEach(win => {
            if (win && !win.isDestroyed()) {
                win.setContentProtection(isContentProtectionOn);
            }
        });
    };
    
    // Initialize windowBridge with required dependencies
    windowBridge.initialize(windowPool, require('electron').app, require('electron').shell, getCurrentDisplay, createFeatureWindows, movementManager, getContentProtectionStatus, setContentProtection, updateLayout);

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
    setupApiKeyIPC();

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

    // Content protection handlers moved to windowBridge.js to avoid duplication

    ipcMain.on('header-state-changed', (event, state) => {
        console.log(`[WindowManager] Header state changed to: ${state}`);
        currentHeaderState = state;

        if (state === 'main') {
            createFeatureWindows(windowPool.get('header'));
        } else {         // 'apikey' | 'permission'
            destroyFeatureWindows();
        }
        shortcutsService.registerShortcuts(movementManager, windowPool);
    });

    ipcMain.handle('get-current-shortcuts', async () => {
        return await shortcutsService.loadKeybinds();
    });

    ipcMain.handle('get-default-shortcuts', async () => {
        const defaults = shortcutsService.getDefaultKeybinds();
        await shortcutsService.saveKeybinds(defaults);
        // Reregister shortcuts with new defaults
        await shortcutsService.registerShortcuts(movementManager, windowPool);
        return defaults;
    });

    ipcMain.handle('save-shortcuts', async (event, newKeybinds) => {
        try {
            await shortcutsService.saveKeybinds(newKeybinds);
            
            const editor = windowPool.get('shortcut-settings');
            if (editor && !editor.isDestroyed()) {
                editor.close(); // This will trigger re-registration on 'closed' event
            } else {
                // If editor wasn't open, re-register immediately
                await shortcutsService.registerShortcuts(movementManager, windowPool);
            }
            return { success: true };
        } catch (error) {
            console.error("Failed to save shortcuts:", error);
            // On failure, re-register old shortcuts to be safe
            await shortcutsService.registerShortcuts(movementManager, windowPool);
            return { success: false, error: error.message };
        }
    });

    ipcMain.on('close-shortcut-editor', () => {
        const editor = windowPool.get('shortcut-settings');
        if (editor && !editor.isDestroyed()) {
            editor.close();
        }
    });

    // resize-header-window handler moved to windowBridge.js to avoid duplication

    ipcMain.on('header-animation-finished', (event, state) => {
        const header = windowPool.get('header');
        if (!header || header.isDestroyed()) return;
    
        if (state === 'hidden') {
            header.hide();
            console.log('[WindowManager] Header hidden after animation.');
        } else if (state === 'visible') {
            console.log('[WindowManager] Header shown after animation.');
            updateLayout();
        }
    });

    ipcMain.handle('get-header-position', () => {
        const header = windowPool.get('header');
        if (header) {
            const [x, y] = header.getPosition();
            return { x, y };
        }
        return { x: 0, y: 0 };
    });

    ipcMain.handle('move-header', (event, newX, newY) => {
        const header = windowPool.get('header');
        if (header) {
            const currentY = newY !== undefined ? newY : header.getBounds().y;
            header.setPosition(newX, currentY, false);

            updateLayout();
        }
    });

    ipcMain.handle('move-header-to', (event, newX, newY) => {
        const header = windowPool.get('header');
        if (header) {
            const targetDisplay = screen.getDisplayNearestPoint({ x: newX, y: newY });
            const { x: workAreaX, y: workAreaY, width, height } = targetDisplay.workArea;
            const headerBounds = header.getBounds();

            // Only clamp if the new position would actually go out of bounds
            // This prevents progressive restriction of movement
            let clampedX = newX;
            let clampedY = newY;
            
            // Check if we need to clamp X position
            if (newX < workAreaX) {
                clampedX = workAreaX;
            } else if (newX + headerBounds.width > workAreaX + width) {
                clampedX = workAreaX + width - headerBounds.width;
            }
            
            // Check if we need to clamp Y position  
            if (newY < workAreaY) {
                clampedY = workAreaY;
            } else if (newY + headerBounds.height > workAreaY + height) {
                clampedY = workAreaY + height - headerBounds.height;
            }

            header.setPosition(clampedX, clampedY, false);

            updateLayout();
        }
    });


    // move-window-step handler moved to windowBridge.js to avoid duplication

    ipcMain.handle('adjust-window-height', (event, targetHeight) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
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
    });

    ipcMain.handle('start-screen-capture', async () => {
        try {
            isCapturing = true;
            console.log('Starting screen capture in main process');
            return { success: true };
        } catch (error) {
            console.error('Failed to start screen capture:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('stop-screen-capture', async () => {
        try {
            isCapturing = false;
            lastScreenshot = null;
            console.log('Stopped screen capture in main process');
            return { success: true };
        } catch (error) {
            console.error('Failed to stop screen capture:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('capture-screenshot', async (event, options = {}) => {
        return captureScreenshot(options);
    });

    ipcMain.handle('get-current-screenshot', async event => {
        try {
            if (lastScreenshot && Date.now() - lastScreenshot.timestamp < 1000) {
                console.log('Returning cached screenshot');
                return {
                    success: true,
                    base64: lastScreenshot.base64,
                    width: lastScreenshot.width,
                    height: lastScreenshot.height,
                };
            }
            return {
                success: false,
                error: 'No screenshot available',
            };
        } catch (error) {
            console.error('Failed to get current screenshot:', error);
            return {
                success: false,
                error: error.message,
            };
        }
    });

    // firebase-logout handler moved to windowBridge.js to avoid duplication

    ipcMain.handle('check-system-permissions', async () => {
        const { systemPreferences } = require('electron');
        const permissions = {
            microphone: 'unknown',
            screen: 'unknown',
            needsSetup: true
        };

        try {
            if (process.platform === 'darwin') {
                // Check microphone permission on macOS
                const micStatus = systemPreferences.getMediaAccessStatus('microphone');
                console.log('[Permissions] Microphone status:', micStatus);
                permissions.microphone = micStatus;

                // Check screen recording permission using the system API
                const screenStatus = systemPreferences.getMediaAccessStatus('screen');
                console.log('[Permissions] Screen status:', screenStatus);
                permissions.screen = screenStatus;

                permissions.needsSetup = micStatus !== 'granted' || screenStatus !== 'granted';
            } else {
                permissions.microphone = 'granted';
                permissions.screen = 'granted';
                permissions.needsSetup = false;
            }

            console.log('[Permissions] System permissions status:', permissions);
            return permissions;
        } catch (error) {
            console.error('[Permissions] Error checking permissions:', error);
            return {
                microphone: 'unknown',
                screen: 'unknown',
                needsSetup: true,
                error: error.message
            };
        }
    });

    ipcMain.handle('request-microphone-permission', async () => {
        if (process.platform !== 'darwin') {
            return { success: true };
        }

        const { systemPreferences } = require('electron');
        try {
            const status = systemPreferences.getMediaAccessStatus('microphone');
            console.log('[Permissions] Microphone status:', status);
            if (status === 'granted') {
                return { success: true, status: 'granted' };
            }

            // Req mic permission
            const granted = await systemPreferences.askForMediaAccess('microphone');
            return { 
                success: granted, 
                status: granted ? 'granted' : 'denied'
            };
        } catch (error) {
            console.error('[Permissions] Error requesting microphone permission:', error);
            return { 
                success: false, 
                error: error.message 
            };
        }
    });

    ipcMain.handle('open-system-preferences', async (event, section) => {
        if (process.platform !== 'darwin') {
            return { success: false, error: 'Not supported on this platform' };
        }

        try {
            if (section === 'screen-recording') {
                // First trigger screen capture request to register the app in system preferences
                try {
                    console.log('[Permissions] Triggering screen capture request to register app...');
                    await desktopCapturer.getSources({ 
                        types: ['screen'], 
                        thumbnailSize: { width: 1, height: 1 } 
                    });
                    console.log('[Permissions] App registered for screen recording');
                } catch (captureError) {
                    console.log('[Permissions] Screen capture request triggered (expected to fail):', captureError.message);
                }
                
                // Then open system preferences
                // await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
            }
            // if (section === 'microphone') {
            //     await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
            // }
            return { success: true };
        } catch (error) {
            console.error('[Permissions] Error opening system preferences:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('mark-permissions-completed', async () => {
        try {
            // This is a system-level setting, not user-specific.
            await systemSettingsRepository.markPermissionsAsCompleted();
            console.log('[Permissions] Marked permissions as completed');
            return { success: true };
        } catch (error) {
            console.error('[Permissions] Error marking permissions as completed:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('check-permissions-completed', async () => {
        try {
            const completed = await systemSettingsRepository.checkPermissionsCompleted();
            console.log('[Permissions] Permissions completed status:', completed);
            return completed;
        } catch (error) {
            console.error('[Permissions] Error checking permissions completed status:', error);
            return false;
        }
    });
    
    ipcMain.handle('toggle-all-windows-visibility', () => toggleAllWindowsVisibility());

    ipcMain.handle('toggle-feature', async (event, featureName) => {
        return toggleFeature(featureName);
    });

    ipcMain.on('animation-finished', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win && !win.isDestroyed()) {
            console.log(`[WindowManager] Hiding window after animation.`);
            win.hide();
        }
    });


    ipcMain.handle('ask:closeAskWindow', async () => {
        const askWindow = windowPool.get('ask');
        if (askWindow) {
            askWindow.webContents.send('window-hide-animation');
        }
    });


    ipcMain.handle('ask:sendQuestionToMain', (event, question) => {
        console.log('📨 Main process: Sending question to AskView', question);
        toggleFeature('ask', {ask: { questionText: question }});
        return { success: true };
    });

    // ipcMain.handle('listen:changeSession', async (event, actionText) => {
    //     console.log('📨 Main process: Received actionText', actionText);
    //     const header = windowPool.get('header');
    //     const listenWindow = windowPool.get('listen');

    //     try {
    //         if (listenService && listenService.isSessionActive()) {
    //             console.log('[WindowManager] Listen session is active, closing it.');
    //             // ✨ closeSession도 비동기일 수 있으므로 await 처리 (만약 동기 함수라면 await는 무시됨)
    //             await listenService.closeSession();
    //             listenWindow.webContents.send('session-state-changed', { isActive: false });
    //         } else {
    //             if (listenWindow.isVisible()) {
    //                 listenWindow.webContents.send('window-hide-animation');
    //                 listenWindow.webContents.send('session-state-changed', { isActive: false });
    //             } else {
    //                 listenWindow.show();
    //                 updateLayout();
    //                 listenWindow.webContents.send('window-show-animation');
                    
    //                 // ✨ 핵심: initializeSession 작업이 끝날 때까지 기다림
    //                 await listenService.initializeSession(); 
                    
    //                 listenWindow.webContents.send('session-state-changed', { isActive: true });
    //             }
    //         }

    //         // ✨ 모든 비동기 작업이 성공적으로 끝난 후 결과 전송
    //         header.webContents.send('listen:changeSessionResult', { success: true });
    //         return { success: true };

    //     } catch (error) {
    //         console.error('[WindowManager] Failed to change listen session:', error);
            
    //         // ✨ 작업 실패 시 UI에 실패 결과를 알려 로딩 상태를 해제하도록 함
    //         header.webContents.send('listen:changeSessionResult', { success: false });
    //         return { success: false, error: error.message };
    //     }
    // });

}


/**
 * 
 * @param {'listen'|'ask'|'settings'} featureName
 * @param {{
*   listen?:   { targetVisibility?: 'show'|'hide' },
*   ask?:      { targetVisibility?: 'show'|'hide', questionText?: string },
*   settings?: { targetVisibility?: 'show'|'hide' }
* }} [options={}]
*/
async function toggleFeature(featureName, options = {}) {
    if (!windowPool.get(featureName) && currentHeaderState === 'main') {
        createFeatureWindows(windowPool.get('header'));
    }

    const header = windowPool.get('header');
    // if (featureName === 'listen') {
    //     console.log(`[WindowManager] Toggling feature: ${featureName}`);
    //     const listenWindow = windowPool.get(featureName);
    //     // const listenService = global.listenService;
    //     if (listenService && listenService.isSessionActive()) {
    //         console.log('[WindowManager] Listen session is active, closing it via toggle.');
    //         await listenService.closeSession();
    //         listenWindow.webContents.send('session-state-changed', { isActive: false });
    //         header.webContents.send('session-state-text', 'Done');
    //         // return;
    //     } else {
    //         if (listenWindow.isVisible()) {
    //             listenWindow.webContents.send('window-hide-animation');
    //             listenWindow.webContents.send('session-state-changed', { isActive: false });
    //             header.webContents.send('session-state-text', 'Listen');
    //         } else {
    //             listenWindow.show();
    //             updateLayout();
    //             listenWindow.webContents.send('window-show-animation');
    //             await listenService.initializeSession();
    //             listenWindow.webContents.send('session-state-changed', { isActive: true });
    //             header.webContents.send('session-state-text', 'Stop');
    //         }
    //     }
    // }

    if (featureName === 'ask') {
        let askWindow = windowPool.get('ask');

        if (!askWindow || askWindow.isDestroyed()) {
            console.log('[WindowManager] Ask window not found, creating new one');
            return;
        }

        const questionText = options?.ask?.questionText ?? null;
        const targetVisibility = options?.ask?.targetVisibility ?? null;
        if (askWindow.isVisible()) {
            if (questionText) {
                askWindow.webContents.send('ask:sendQuestionToRenderer', questionText);
            } else {
                updateLayout();
                if (targetVisibility === 'show') {
                    askWindow.webContents.send('ask:showTextInput');
                } else {
                    askWindow.webContents.send('window-hide-animation');
                }
            }
        } else {
            console.log('[WindowManager] Showing hidden Ask window');
            askWindow.show();
            updateLayout();
            if (questionText) {
                askWindow.webContents.send('ask:sendQuestionToRenderer', questionText);
            }
            askWindow.webContents.send('window-show-animation');
        }
    }

    if (featureName === 'settings') {
        const settingsWindow = windowPool.get(featureName);

        if (settingsWindow) {
            if (settingsWindow.isDestroyed()) {
                console.error(`Window ${featureName} is destroyed, cannot toggle`);
                return;
            }

            if (settingsWindow.isVisible()) {
                if (featureName === 'settings') {
                    settingsWindow.webContents.send('settings-window-hide-animation');
                } else {
                    settingsWindow.webContents.send('window-hide-animation');
                }
            } else {
                try {
                    settingsWindow.show();
                    updateLayout();

                    settingsWindow.webContents.send('window-show-animation');
                } catch (e) {
                    console.error('Error showing window:', e);
                }
            }
        } else {
            console.error(`Window not found for feature: ${featureName}`);
            console.error('Available windows:', Array.from(windowPool.keys()));
        }
    }
}



//////// after_modelStateService ////////
async function getStoredApiKey() {
    if (global.modelStateService) {
        const provider = await getStoredProvider();
        return global.modelStateService.getApiKey(provider);
    }
    return null; // Fallback
}

async function getStoredProvider() {
    if (global.modelStateService) {
        return global.modelStateService.getCurrentProvider('llm');
    }
    return 'openai'; // Fallback
}

/**
 * 
 * @param {IpcMainInvokeEvent} event 
 * @param {{type: 'llm' | 'stt'}}
 */
async function getCurrentModelInfo(event, { type }) {
    if (global.modelStateService && (type === 'llm' || type === 'stt')) {
        return global.modelStateService.getCurrentModelInfo(type);
    }
    return null;
}

function setupApiKeyIPC() {
    const { ipcMain } = require('electron');

    ipcMain.handle('get-stored-api-key', getStoredApiKey);
    ipcMain.handle('get-ai-provider', getStoredProvider);
    ipcMain.handle('get-current-model-info', getCurrentModelInfo);

    ipcMain.handle('api-key-validated', async (event, data) => {
        console.warn("[DEPRECATED] 'api-key-validated' IPC was called. This logic is now handled by 'model:validate-key'.");
        return { success: true };
    });

    ipcMain.handle('remove-api-key', async () => {
         console.warn("[DEPRECATED] 'remove-api-key' IPC was called. This is now handled by 'model:remove-api-key'.");
        return { success: true };
    });
    
    console.log('[WindowManager] API key related IPC handlers have been updated for ModelStateService.');
}
//////// after_modelStateService ////////


async function captureScreenshot(options = {}) {
    if (process.platform === 'darwin') {
        try {
            const tempPath = path.join(os.tmpdir(), `screenshot-${Date.now()}.jpg`);

            await execFile('screencapture', ['-x', '-t', 'jpg', tempPath]);

            const imageBuffer = await fs.promises.readFile(tempPath);
            await fs.promises.unlink(tempPath);

            if (sharp) {
                try {
                    // Try using sharp for optimal image processing
                    const resizedBuffer = await sharp(imageBuffer)
                        // .resize({ height: 1080 })
                        .resize({ height: 384 })
                        .jpeg({ quality: 80 })
                        .toBuffer();

                    const base64 = resizedBuffer.toString('base64');
                    const metadata = await sharp(resizedBuffer).metadata();

                    lastScreenshot = {
                        base64,
                        width: metadata.width,
                        height: metadata.height,
                        timestamp: Date.now(),
                    };

                    return { success: true, base64, width: metadata.width, height: metadata.height };
                } catch (sharpError) {
                    console.warn('Sharp module failed, falling back to basic image processing:', sharpError.message);
                }
            }
            
            // Fallback: Return the original image without resizing
            console.log('[WindowManager] Using fallback image processing (no resize/compression)');
            const base64 = imageBuffer.toString('base64');
            
            lastScreenshot = {
                base64,
                width: null, // We don't have metadata without sharp
                height: null,
                timestamp: Date.now(),
            };

            return { success: true, base64, width: null, height: null };
        } catch (error) {
            console.error('Failed to capture screenshot:', error);
            return { success: false, error: error.message };
        }
    }

    try {
        const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: {
                width: 1920,
                height: 1080,
            },
        });

        if (sources.length === 0) {
            throw new Error('No screen sources available');
        }
        const source = sources[0];
        const buffer = source.thumbnail.toJPEG(70);
        const base64 = buffer.toString('base64');
        const size = source.thumbnail.getSize();

        return {
            success: true,
            base64,
            width: size.width,
            height: size.height,
        };
    } catch (error) {
        console.error('Failed to capture screenshot using desktopCapturer:', error);
        return {
            success: false,
            error: error.message,
        };
    }
}

module.exports = {
    updateLayout,
    createWindows,
    windowPool,
    fixedYPosition,
    getStoredApiKey,
    getStoredProvider,
    getCurrentModelInfo,
    captureScreenshot,
    toggleFeature, // Export toggleFeature so shortcutsService can use it
};