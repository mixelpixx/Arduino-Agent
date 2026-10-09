/**
 * Open Duino identity for the vendored Arduino IDE shell.
 *
 * arduino-ide-extension is upstream code synced by file copy, so the fork's
 * identity lives here as rebinds and contributions rather than as edits there.
 *
 * - Arduino's IDE updater is switched off. It checks Arduino's official feed,
 *   so it would offer the official Arduino IDE as an "update" and replace this
 *   app, MCP server included. Board and library update checks stay on: they
 *   share the `arduino.checkForUpdates` preference, so that is left alone.
 * - The About dialog names Open Duino, its own version and the Arduino IDE
 *   version it is based on, and says it is not an Arduino product.
 *
 * arduino-ide-extension ships no type declarations, so its classes are `any`
 * here: subclasses below cannot use `override` or see inherited fields, and
 * inject what they need themselves.
 */

import { ClipboardService } from '@theia/core/lib/browser/clipboard-service';
import { ApplicationServer } from '@theia/core/lib/common/application-protocol';
import { CommandContribution, CommandRegistry } from '@theia/core/lib/common/command';
import { MenuContribution, MenuModelRegistry } from '@theia/core/lib/common/menu';
import { isOSX, isWindows } from '@theia/core/lib/common/os';
import { inject, injectable } from '@theia/core/shared/inversify';
import { AppService } from 'arduino-ide-extension/lib/browser/app-service';
import { About } from 'arduino-ide-extension/lib/browser/contributions/about';
import { CheckForIDEUpdates } from 'arduino-ide-extension/lib/browser/contributions/check-for-ide-updates';
import { DialogService } from 'arduino-ide-extension/lib/browser/dialog-service';
import { IDEUpdaterCommands } from 'arduino-ide-extension/lib/browser/ide-updater/ide-updater-commands';

/** Replaces Arduino's startup update check: never contacts the update feed. */
@injectable()
export class DisabledIDEUpdateCheck extends CheckForIDEUpdates {
  onStart(): void {
    // Updater disabled; see the file header.
  }

  async onReady(): Promise<void> {
    // Updater disabled; see the file header.
  }
}

/**
 * Removes Help > "Check for Arduino IDE Updates". Contributions run in module
 * order and this extension loads after arduino-ide-extension, so the command
 * and menu item already exist when these run.
 */
@injectable()
export class RemoveIDEUpdaterCommand implements CommandContribution, MenuContribution {
  registerCommands(registry: CommandRegistry): void {
    registry.unregisterCommand(IDEUpdaterCommands.CHECK_FOR_UPDATES.id);
  }

  registerMenus(registry: MenuModelRegistry): void {
    registry.unregisterMenuAction(IDEUpdaterCommands.CHECK_FOR_UPDATES.id);
  }
}

/** Arduino's About dialog, reworded for the fork. Menu label comes from applicationName. */
@injectable()
export class AgentAbout extends About {
  @inject(AppService)
  private readonly agentAppService!: AppService;

  @inject(ApplicationServer)
  private readonly applicationServer!: ApplicationServer;

  @inject(ClipboardService)
  private readonly agentClipboard!: ClipboardService;

  @inject(DialogService)
  private readonly agentDialogService!: DialogService;

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(About.Commands.ABOUT_APP, {
      execute: () => this.showAgentAbout(),
    });
  }

  private async showAgentAbout(): Promise<void> {
    const [{ appVersion, cliVersion, buildDate }, extensions] = await Promise.all([
      this.agentAppService.info(),
      this.applicationServer.getExtensionsInfos(),
    ]);
    const versionOf = (name: string) => extensions.find((e) => e.name === name)?.version;
    const detail = [
      `Version: ${versionOf('arduino-mcp-extension') ?? appVersion}`,
      `Date: ${buildDate || 'dev build'}`,
      `CLI Version: ${cliVersion}`,
      `Based on Arduino IDE ${versionOf('arduino-ide-extension') ?? ''}`,
      '',
      'Created by Lanuzadev',
      'Repository: https://github.com/lanuzadev/Open-Duino',
      '',
      'Open Duino is an independent fork of the Arduino IDE. It is not affiliated with or endorsed by Arduino SA.',
      `Arduino IDE: Copyright © ${new Date().getFullYear()} Arduino s.r.l. and/or its affiliated companies`,
    ].join('\n');

    const ok = 'OK';
    const copy = 'Copy';
    const buttons = !isWindows && !isOSX ? [copy, ok] : [ok, copy];
    const { response } = await this.agentDialogService.showMessageBox({
      message: 'Open Duino',
      title: 'Open Duino',
      type: 'info',
      detail,
      buttons,
      noLink: true,
      defaultId: buttons.indexOf(ok),
      cancelId: buttons.indexOf(ok),
    });
    if (buttons[response] === copy) {
      await this.agentClipboard.writeText(detail);
    }
  }
}
