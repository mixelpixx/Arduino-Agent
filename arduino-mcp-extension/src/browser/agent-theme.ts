/**
 * Open Duino's colors: adapted light and dark themes with the app's accent color,
 * keeping familiar IDE colors while giving the shell its own identity.
 *
 * The themes keep Arduino's ids (`arduino-theme`, `arduino-theme-dark`): the
 * vendored settings dialog lists exactly those as the built-in Light/Dark, and
 * users' saved `workbench.colorTheme` keeps working. Only the content changes,
 * computed from Arduino's theme JSON at registration so upstream theme updates
 * carry over:
 *
 * - accents (teal hues, chroma >= 0.05 in OKLCH) take the icon's indigo hue,
 *   with somewhat more chroma, at their original lightness;
 * - neutrals with a slight teal tint keep their lightness and tiny chroma but
 *   lean toward indigo instead of teal;
 * - everything else (whites, greys, the yellow/red highlights) is unchanged.
 *
 * Keeping lightness keeps the contrast Arduino tuned. A few rules in
 * arduino-ide-extension's CSS hardcode teal; AGENT_THEME_CSS overrides them in
 * terms of the theme's branding color.
 */

import { injectable } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { ColorContribution } from '@theia/core/lib/browser/color-application-contribution';
import { ColorRegistry } from '@theia/core/lib/browser/color-registry';
import { MonacoThemingService } from 'arduino-ide-extension/lib/browser/theia/monaco/monaco-theming-service';
import { ArduinoThemes } from 'arduino-ide-extension/lib/browser/theia/core/theming';
import { toAgentPalette } from './agent-palette';

/** The inherited Theia method used below (the vendored base class is untyped here). */
interface ParsedThemeRegistry {
  registerParsedTheme(theme: { id: string; label: string; uiTheme: 'vs' | 'vs-dark'; json: unknown }): unknown;
}

@injectable()
export class AgentMonacoThemingService extends MonacoThemingService {
  /** Replaces arduino-ide-extension's registration (called from its restore()). */
  registerArduinoThemes(): void {
    const { light, dark } = ArduinoThemes;
    const registry = this as unknown as ParsedThemeRegistry;
    registry.registerParsedTheme({
      id: light.id,
      label: 'Open Duino Light',
      uiTheme: 'vs',
      json: toAgentPalette(require('arduino-ide-extension/src/browser/data/default.color-theme.json')),
    });
    registry.registerParsedTheme({
      id: dark.id,
      label: 'Open Duino Dark',
      uiTheme: 'vs-dark',
      json: toAgentPalette(require('arduino-ide-extension/src/browser/data/dark.color-theme.json')),
    });
  }
}

/**
 * Registers `arduino.branding.primary`/`secondary`. The themes set them and
 * its CSS uses `var(--theia-arduino-branding-primary)` (boards dialog, library and
 * board lists, serial monitor scrollbar, progress bar), but upstream never
 * registers them, so the variable was undefined and those accents never showed.
 * Also installs the CSS overrides for the teal hardcoded in arduino-ide-extension's
 * stylesheets.
 */
@injectable()
export class AgentThemeStyles implements FrontendApplicationContribution, ColorContribution {
  registerColors(colors: ColorRegistry): void {
    colors.register(
      {
        id: 'arduino.branding.primary',
        defaults: { light: '#5d64c6', dark: '#757ff4', hcLight: 'focusBorder', hcDark: 'focusBorder' },
        description: 'Open Duino accent color (links, highlights, the serial monitor scrollbar).',
      },
      {
        id: 'arduino.branding.secondary',
        defaults: { light: '#bfc3d2', dark: '#bfc3d2', hcLight: 'foreground', hcDark: 'foreground' },
        description: 'Open Duino secondary branding color.',
      }
    );
  }

  initialize(): void {
    const style = document.createElement('style');
    style.id = 'arduino-agent-theme';
    style.textContent = AGENT_THEME_CSS;
    document.head.appendChild(style);
  }
}

const brand = (percent: number) =>
  `color-mix(in srgb, var(--theia-arduino-branding-primary) ${percent}%, transparent)`;

const AGENT_THEME_CSS = `
:root {
  --arduino-shadow-focus: 0 0 0 3px ${brand(25)};
  --openduino-control-height: 28px;
  --openduino-panel-divider: var(--theia-sideBar-border, var(--theia-editorWidget-border));
  --arduino-radius-sm: 3px;
  --arduino-radius-md: 4px;
  --arduino-radius-lg: 6px;
  --arduino-radius-pill: 4px;
  --arduino-shadow-sm: none;
  --arduino-shadow-md: 0 2px 8px rgba(0, 0, 0, 0.08);
  --arduino-shadow-lg: 0 6px 20px rgba(0, 0, 0, 0.12);
}
body {
  font-family: var(--theia-ui-font-family, system-ui, sans-serif);
  font-size: 12px;
  letter-spacing: 0;
}
#theia-top-panel {
  border-bottom: 1px solid var(--openduino-panel-divider);
}
#theia-statusBar {
  min-height: 27px;
  border-top: 1px solid var(--openduino-panel-divider);
  font-size: 10px;
}
#theia-left-content-panel,
#theia-right-content-panel {
  background: var(--theia-sideBar-background, var(--theia-editor-background));
}
.p-Widget.p-DockPanel-tabBar {
  border-bottom: 1px solid var(--openduino-panel-divider);
  background: var(--theia-sideBar-background, var(--theia-editor-background));
}
.p-TabBar-tab {
  min-height: 34px;
  border-radius: 0;
  font-size: 11px;
}
.p-TabBar-tab.p-mod-current {
  box-shadow: inset 0 -2px var(--theia-arduino-branding-primary);
}
.p-TabBar-tab:hover:not(.p-mod-current) {
  background: ${brand(7)};
}
.theia-sidepanel-title,
.theia-sidepanel-toolbar {
  font-size: 11px;
}
.theia-sidepanel-title {
  font-weight: 600;
  letter-spacing: .02em;
}
.theia-tree .theia-TreeNode,
.theia-TreeNode {
  min-height: 25px;
}
.theia-tree .theia-TreeNode:hover,
.theia-TreeNode:hover {
  background: ${brand(7)};
}
.theia-tree .theia-TreeNode.theia-mod-selected,
.theia-TreeNode.theia-mod-selected {
  background: ${brand(13)};
}
.theia-input,
input[type="text"],
input[type="number"],
select,
textarea {
  min-height: var(--openduino-control-height);
  border-radius: var(--arduino-radius-md);
  box-shadow: none;
}
.p-Widget.dialogOverlay .dialogBlock {
  border-radius: var(--arduino-radius-lg);
  box-shadow: var(--arduino-shadow-lg);
}
.theia-dialog-title {
  font-size: 13px;
  font-weight: 600;
}
::-webkit-scrollbar { width: 9px; height: 9px; }
::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
  border-radius: 8px;
  background: color-mix(in srgb, var(--theia-foreground) 18%, transparent);
  background-clip: padding-box;
}
::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--theia-foreground) 30%, transparent);
  background-clip: padding-box;
}
#theia-statusBar .area .element.arduino-selected-port,
#theia-statusBar .area .element.arduino-selected-board {
  background: ${brand(10)};
}
#theia-statusBar .area .element.arduino-selected-port:hover,
#theia-statusBar .area .element.arduino-selected-board:hover {
  background: ${brand(20)};
}
.p-Widget.dialogOverlay .dialogBlock {
  border-color: ${brand(10)};
}
.component-list-item {
  border-bottom-color: ${brand(8)};
}
button.theia-button,
.theia-button {
  border-width: 1px;
  border-radius: var(--arduino-radius-md);
  box-shadow: none;
  font-family: var(--theia-ui-font-family);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0;
  text-transform: none;
}
button.theia-button:hover:not([disabled]) {
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);
  transform: none;
}
.theia-input,
input[type="text"],
input[type="number"] {
  border-radius: var(--arduino-radius-md);
}
body.theia-dark {
  --arduino-shadow-sm: none;
  --arduino-shadow-md: 0 2px 10px rgba(0, 0, 0, 0.24);
  --arduino-shadow-lg: 0 6px 24px rgba(0, 0, 0, 0.32);
}
`;
