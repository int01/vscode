/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IKeyboardEvent } from 'vs/base/browser/keyboardEvent';
import { ActionsOrientation } from 'vs/base/browser/ui/actionbar/actionbar';
import { alert } from 'vs/base/browser/ui/aria/aria';
import { Codicon } from 'vs/base/common/codicons';
import { KeyCode, KeyMod } from 'vs/base/common/keyCodes';
import { Disposable, DisposableStore, IDisposable } from 'vs/base/common/lifecycle';
import { marked } from 'vs/base/common/marked/marked';
import { isMacintosh } from 'vs/base/common/platform';
import { URI } from 'vs/base/common/uri';
import { IEditorConstructionOptions } from 'vs/editor/browser/config/editorConfiguration';
import { Command, EditorExtensionsRegistry, MultiCommand, ServicesAccessor } from 'vs/editor/browser/editorExtensions';
import { CodeEditorWidget, ICodeEditorWidgetOptions } from 'vs/editor/browser/widget/codeEditorWidget';
import { ITextModel } from 'vs/editor/common/model';
import { IModelService } from 'vs/editor/common/services/model';
import { AccessibilityHelpNLS } from 'vs/editor/common/standaloneStrings';
import { CodeActionController } from 'vs/editor/contrib/codeAction/browser/codeActionController';
import { localize } from 'vs/nls';
import { IAccessibilityService } from 'vs/platform/accessibility/common/accessibility';
import { MenuWorkbenchToolBar } from 'vs/platform/actions/browser/toolbar';
import { Action2, MenuId, registerAction2 } from 'vs/platform/actions/common/actions';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { ContextKeyExpr, IContextKey, IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IContextViewDelegate, IContextViewService } from 'vs/platform/contextview/browser/contextView';
import { IInstantiationService, createDecorator } from 'vs/platform/instantiation/common/instantiation';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { KeybindingWeight } from 'vs/platform/keybinding/common/keybindingsRegistry';
import { ILayoutService } from 'vs/platform/layout/browser/layoutService';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import { IPickerQuickAccessItem } from 'vs/platform/quickinput/browser/pickerQuickAccess';
import { IQuickInputService } from 'vs/platform/quickinput/common/quickInput';
import { AccessibilityVerbositySettingId, accessibilityHelpIsShown, accessibleViewIsShown } from 'vs/workbench/contrib/accessibility/browser/accessibilityConfiguration';
import { getSimpleEditorOptions } from 'vs/workbench/contrib/codeEditor/browser/simpleEditorOptions';

const enum DIMENSIONS {
	MAX_WIDTH = 600
}

export interface IAccessibleContentProvider {
	verbositySettingKey: AccessibilityVerbositySettingId;
	provideContent(): string;
	onClose(): void;
	onKeyDown?(e: IKeyboardEvent): void;
	previous?(): void;
	next?(): void;
	/**
	 * When the language is markdown, this is provided by default.
	 */
	getSymbols?(): IAccessibleViewSymbol[];
	options: IAccessibleViewOptions;
}

export const IAccessibleViewService = createDecorator<IAccessibleViewService>('accessibleViewService');

export interface IAccessibleViewService {
	readonly _serviceBrand: undefined;
	show(provider: IAccessibleContentProvider): void;
	showAccessibleViewHelp(): void;
	next(): void;
	previous(): void;
	goToSymbol(): void;
	disableHint(): void;
	focusToolbar(): void;
	/**
	 * If the setting is enabled, provides the open accessible view hint as a localized string.
	 * @param verbositySettingKey The setting key for the verbosity of the feature
	 */
	getOpenAriaHint(verbositySettingKey: AccessibilityVerbositySettingId): string | null;
}

export const enum AccessibleViewType {
	Help = 'help',
	View = 'view'
}

export interface IAccessibleViewOptions {
	ariaLabel: string;
	readMoreUrl?: string;
	/**
	 * Defaults to markdown
	 */
	language?: string;
	type: AccessibleViewType;
}

class AccessibleView extends Disposable {
	private _editorWidget: CodeEditorWidget;
	private _accessiblityHelpIsShown: IContextKey<boolean>;
	private _accessibleViewIsShown: IContextKey<boolean>;
	get editorWidget() { return this._editorWidget; }
	private _editorContainer: HTMLElement;
	private _currentProvider: IAccessibleContentProvider | undefined;
	private readonly _toolbar: MenuWorkbenchToolBar;

	constructor(
		@IOpenerService private readonly _openerService: IOpenerService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IModelService private readonly _modelService: IModelService,
		@IContextViewService private readonly _contextViewService: IContextViewService,
		@IContextKeyService private readonly _contextKeyService: IContextKeyService,
		@IAccessibilityService private readonly _accessibilityService: IAccessibilityService,
		@IKeybindingService private readonly _keybindingService: IKeybindingService,
		@ILayoutService private readonly _layoutService: ILayoutService
	) {
		super();
		this._accessiblityHelpIsShown = accessibilityHelpIsShown.bindTo(this._contextKeyService);
		this._accessibleViewIsShown = accessibleViewIsShown.bindTo(this._contextKeyService);
		this._editorContainer = document.createElement('div');
		this._editorContainer.classList.add('accessible-view');
		const codeEditorWidgetOptions: ICodeEditorWidgetOptions = {
			contributions: EditorExtensionsRegistry.getEditorContributions().filter(c => c.id !== CodeActionController.ID)
		};
		this._toolbar = this._register(_instantiationService.createInstance(MenuWorkbenchToolBar, this._editorContainer, MenuId.AccessibleView, { ariaLabel: localize('accessibleViewToolbar', "Accessible View Toolbar"), orientation: ActionsOrientation.HORIZONTAL }));
		const editorOptions: IEditorConstructionOptions = {
			...getSimpleEditorOptions(this._configurationService),
			lineDecorationsWidth: 6,
			dragAndDrop: false,
			cursorWidth: 1,
			wrappingStrategy: 'advanced',
			wrappingIndent: 'none',
			padding: { top: 2, bottom: 2 },
			quickSuggestions: false,
			renderWhitespace: 'none',
			dropIntoEditor: { enabled: false },
			readOnly: true,
			fontFamily: 'var(--monaco-monospace-font)'
		};
		this._editorWidget = this._register(this._instantiationService.createInstance(CodeEditorWidget, this._editorContainer, editorOptions, codeEditorWidgetOptions));
		this._register(this._accessibilityService.onDidChangeScreenReaderOptimized(() => {
			if (this._currentProvider && this._accessiblityHelpIsShown.get()) {
				this.show(this._currentProvider);
			}
		}));
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (this._currentProvider && this._accessiblityHelpIsShown.get() && e.affectsConfiguration(this._currentProvider.verbositySettingKey)) {
				this.show(this._currentProvider);
			}
		}));
	}

	show(provider?: IAccessibleContentProvider, symbol?: IAccessibleViewSymbol): void {
		if (!provider) {
			provider = this._currentProvider;
		}
		if (!provider) {
			return;
		}
		const delegate: IContextViewDelegate = {
			getAnchor: () => { return { x: (window.innerWidth / 2) - ((Math.min(this._layoutService.dimension.width * 0.62 /* golden cut */, DIMENSIONS.MAX_WIDTH)) / 2), y: this._layoutService.offset.quickPickTop }; },
			render: (container) => {
				container.classList.add('accessible-view-container');
				return this._render(provider!, container);
			},
			onHide: () => {
				this._currentProvider = undefined;
			}
		};
		this._contextViewService.showContextView(delegate);
		if (symbol && this._currentProvider) {
			this.showSymbol(this._currentProvider, symbol);
		}
	}

	previous(): void {
		if (!this._currentProvider) {
			return;
		}
		this._currentProvider.previous?.();
	}

	next(): void {
		if (!this._currentProvider) {
			return;
		}
		this._currentProvider.next?.();
	}

	goToSymbol(): void {
		if (!this._currentProvider) {
			return;
		}
		this._instantiationService.createInstance(AccessibleViewSymbolQuickPick, this).show(this._currentProvider);
	}

	getSymbols(): IAccessibleViewSymbol[] | undefined {
		if (!this._currentProvider) {
			return;
		}
		const tokens = this._currentProvider.options.language && this._currentProvider.options.language !== 'markdown' ? this._currentProvider.getSymbols?.() : marked.lexer(this._currentProvider.provideContent());
		if (!tokens) {
			return;
		}
		const symbols: IAccessibleViewSymbol[] = [];
		let firstListItem: string | undefined;
		for (const token of tokens) {
			let label: string | undefined = undefined;
			if ('type' in token) {
				switch (token.type) {
					case 'heading':
					case 'paragraph':
					case 'code':
						label = token.text;
						break;
					case 'list': {
						const firstItem = token.items?.[0];
						if (!firstItem) {
							break;
						}
						firstListItem = `- ${firstItem.text}`;
						label = token.items?.map(i => i.text).join(', ');
						break;
					}
				}
			} else {
				label = token.label;
			}
			if (label) {
				symbols.push({ info: label, label: localize('symbolLabel', "({0}) {1}", token.type, label), ariaLabel: localize('symbolLabelAria', "({0}) {1}", token.type, label), firstListItem });
				firstListItem = undefined;
			}
		}
		return symbols;
	}

	showSymbol(provider: IAccessibleContentProvider, symbol: IAccessibleViewSymbol): void {
		const index = provider.provideContent().split('\n').findIndex(line => line.includes(symbol.info.split('\n')[0]) || (symbol.firstListItem && line.includes(symbol.firstListItem))) ?? -1;
		if (index >= 0) {
			this.show(provider);
			this._editorWidget.revealLine(index + 1);
			this._editorWidget.setSelection({ startLineNumber: index + 1, startColumn: 1, endLineNumber: index + 1, endColumn: 1 });
		}
	}

	disableHint(): void {
		if (!this._currentProvider) {
			return;
		}
		this._configurationService.updateValue(this._currentProvider?.verbositySettingKey, false);
		alert(localize('disableAccessibilityHelp', '{0} accessibility verbosity is now disabled', this._currentProvider.verbositySettingKey));
	}

	private _updateContextKeys(provider: IAccessibleContentProvider, shown: boolean): void {
		if (provider.options.type === AccessibleViewType.Help) {
			this._accessiblityHelpIsShown.set(shown);
			this._accessibleViewIsShown.set(!shown);
		} else {
			this._accessibleViewIsShown.set(shown);
			this._accessiblityHelpIsShown.set(!shown);
		}
	}

	private _render(provider: IAccessibleContentProvider, container: HTMLElement, internal?: boolean): IDisposable {
		if (!internal) {
			this._currentProvider = provider;
		}
		this._updateContextKeys(provider, true);
		const value = this._configurationService.getValue(provider.verbositySettingKey);
		const readMoreLink = provider.options.readMoreUrl ? localize("openDoc", "\nPress H now to open a browser window with more information related to accessibility.\n") : '';
		let disableHelpHint = '';
		if (provider.options.type === AccessibleViewType.Help && !!value) {
			disableHelpHint = this._getDisableVerbosityHint(provider.verbositySettingKey);
		}
		const accessibilitySupport = this._accessibilityService.isScreenReaderOptimized();
		let message = '';
		if (provider.options.type === AccessibleViewType.Help) {
			const turnOnMessage = (
				isMacintosh
					? AccessibilityHelpNLS.changeConfigToOnMac
					: AccessibilityHelpNLS.changeConfigToOnWinLinux
			);
			if (accessibilitySupport && provider.verbositySettingKey === AccessibilityVerbositySettingId.Editor) {
				message = AccessibilityHelpNLS.auto_on;
				message += '\n';
			} else if (!accessibilitySupport) {
				message = AccessibilityHelpNLS.auto_off + '\n' + turnOnMessage;
				message += '\n';
			}
		}

		const fragment = message + provider.provideContent() + readMoreLink + disableHelpHint + localize('exit-tip', 'Exit this dialog via the Escape key.');

		this._getTextModel(URI.from({ path: `accessible-view-${provider.verbositySettingKey}`, scheme: 'accessible-view', fragment })).then((model) => {
			if (!model) {
				return;
			}
			this._editorWidget.setModel(model);
			const domNode = this._editorWidget.getDomNode();
			if (!domNode) {
				return;
			}
			model.setLanguage(provider.options.language ?? 'markdown');
			container.appendChild(this._editorContainer);
			let ariaLabel = '';
			let helpHint = '';
			const verbose = this._configurationService.getValue(provider.verbositySettingKey);
			if (verbose && provider.options.type === AccessibleViewType.View) {
				const accessibilityHelpKeybinding = this._keybindingService.lookupKeybinding('editor.action.accessibilityHelp')?.getLabel();
				if (accessibilityHelpKeybinding) {
					helpHint = localize('ariaAccessibilityHelp', "Use {0} for accessibility help", accessibilityHelpKeybinding);
				}
				if (helpHint) {
					ariaLabel = provider.options.ariaLabel ? localize('helpAriaKb', "{0}, {1}", provider.options.ariaLabel, helpHint) : localize('accessible-view', "Accessible View, {0}", helpHint);
				} else {
					ariaLabel = provider.options.ariaLabel ? provider.options.ariaLabel : localize('helpAriaNoKb', "Accessible View");
				}
			}
			if (internal) {
				ariaLabel = localize('accessibleViewHelp', "Accessible View Help");
			}
			this._editorWidget.updateOptions({ ariaLabel });
			this._editorWidget.focus();
		});
		this._toolbar.context = { viewId: 'accessibleView' };
		this._toolbar.getElement().tabIndex = 0;
		const disposableStore = new DisposableStore();
		disposableStore.add(this._editorWidget.onKeyUp((e) => provider.onKeyDown?.(e)));
		disposableStore.add(this._editorWidget.onKeyDown((e) => {
			if (e.keyCode === KeyCode.Escape) {
				e.stopPropagation();
				this._contextViewService.hideContextView();
				this._updateContextKeys(provider, false);
				// HACK: Delay to allow the context view to hide #186514
				setTimeout(() => provider.onClose(), 100);
			} else if (e.keyCode === KeyCode.KeyH && provider.options.readMoreUrl) {
				const url: string = provider.options.readMoreUrl!;
				alert(AccessibilityHelpNLS.openingDocs);
				this._openerService.open(URI.parse(url));
				e.preventDefault();
				e.stopPropagation();
			}
		}));
		disposableStore.add(this._editorWidget.onDidBlurEditorWidget(() => {
			if (document.activeElement !== this._toolbar.getElement()) {
				this._contextViewService.hideContextView();
			}
		}));
		disposableStore.add(this._editorWidget.onDidContentSizeChange(() => this._layout()));
		disposableStore.add(this._layoutService.onDidLayout(() => this._layout()));
		return disposableStore;
	}

	focusToolbar(): void {
		this._toolbar.focus();
	}

	private _layout(): void {
		const dimension = this._layoutService.dimension;
		const maxHeight = dimension.height && dimension.height * .4;
		const height = Math.min(maxHeight, this._editorWidget.getContentHeight());
		const width = Math.min(dimension.width * 0.62 /* golden cut */, DIMENSIONS.MAX_WIDTH);
		this._editorWidget.layout({ width, height });
	}

	private async _getTextModel(resource: URI): Promise<ITextModel | null> {
		const existing = this._modelService.getModel(resource);
		if (existing && !existing.isDisposed()) {
			return existing;
		}
		return this._modelService.createModel(resource.fragment, null, resource, false);
	}

	public showAccessibleViewHelp(): void {
		if (!this._currentProvider) {
			return;

		}
		const previousProvider = Object.assign({}, this._currentProvider);
		const accessibleViewHelpProvider = Object.assign({}, this._currentProvider);
		accessibleViewHelpProvider.options.type = AccessibleViewType.Help;
		accessibleViewHelpProvider.provideContent = () => this._getAccessibleViewHelpDialogContent(accessibleViewHelpProvider);
		accessibleViewHelpProvider.onClose = () => {
			previousProvider.options.type = AccessibleViewType.View;
			this.show(previousProvider);
		};
		this._contextViewService.hideContextView();
		const delegate: IContextViewDelegate = {
			getAnchor: () => { return { x: (window.innerWidth / 2) - ((Math.min(this._layoutService.dimension.width * 0.62 /* golden cut */, DIMENSIONS.MAX_WIDTH)) / 2), y: this._layoutService.offset.quickPickTop }; },
			render: (container) => {
				container.classList.add('accessible-view-container');
				return this._render(accessibleViewHelpProvider, container, true);
			}
		};
		// HACK: Delay to allow the context view to hide #186514
		setTimeout(() => this._contextViewService.showContextView(delegate), 100);
	}

	private _getAccessibleViewHelpDialogContent(provider: IAccessibleContentProvider): string {
		const navigationHint = this._getNavigationHint();
		const goToSymbolHint = this._getGoToSymbolHint(provider);
		const toolbarHint = this._getToolbarHint();
		let hint = localize('intro', "In the accessible view, you can:\n");
		if (navigationHint) {
			hint += ' - ' + navigationHint + '\n';
		}
		if (goToSymbolHint) {
			hint += ' - ' + goToSymbolHint + '\n';
		}
		if (toolbarHint) {
			hint += ' - ' + toolbarHint + '\n';
		}
		return hint;
	}

	private _getToolbarHint(): string {
		let toolbarHint = '';
		const toolbarKb = this._keybindingService.lookupKeybinding('editor.action.accessibleViewFocusToolbar')?.getLabel();
		if (toolbarKb) {
			toolbarHint = localize('toolbar', "Navigate to the toolbar ({0} or Shift+Tab)", toolbarKb);
		} else {
			toolbarHint = localize('toolbarNoKb', "Navigate to the toolbar (Shift+Tab)");
		}
		return toolbarHint;
	}

	private _getNavigationHint(): string {
		let hint = '';
		const nextKeybinding = this._keybindingService.lookupKeybinding('editor.action.accessibleViewNext')?.getAriaLabel();
		const previousKeybinding = this._keybindingService.lookupKeybinding('editor.action.accessibleViewPrevious')?.getAriaLabel();
		if (nextKeybinding && previousKeybinding) {
			hint = localize('accessibleViewNextPreviousHint', "Show the next ({0}) or previous ({1}) item", nextKeybinding, previousKeybinding);
		} else {
			hint = localize('chatAccessibleViewNextPreviousHintNoKb', "Show the next or previous item by configuring keybindings for the Show Next & Previous in Accessible View commands");
		}
		return hint;
	}
	private _getDisableVerbosityHint(verbositySettingKey: AccessibilityVerbositySettingId): string {
		if (!this._configurationService.getValue(verbositySettingKey)) {
			return '';
		}
		let hint = '';
		const disableKeybinding = this._keybindingService.lookupKeybinding('editor.action.accessibleViewDisableHint', this._contextKeyService)?.getAriaLabel();
		if (disableKeybinding) {
			hint = localize('acessibleViewDisableHint', "Disable the aria label hint to open this ({0})", disableKeybinding);
		} else {
			hint = localize('accessibleViewDisableHintNoKb', "Add a keybinding for the command Disable Accessible View Hint to disable this hint");
		}
		return hint;
	}

	private _getGoToSymbolHint(provider: IAccessibleContentProvider): string {
		const goToSymbolKb = this._keybindingService.lookupKeybinding('editor.action.accessibleViewGoToSymbol')?.getAriaLabel();
		const hasSymbolProvider = provider.options.language === 'markdown' || provider.options.language === undefined || !!provider.getSymbols;
		let goToSymbolHint = '';
		if (hasSymbolProvider) {
			if (goToSymbolKb) {
				goToSymbolHint = localize('goToSymbolHint', 'Go to a symbol ({0})', goToSymbolKb);
			} else {
				goToSymbolHint = localize('goToSymbolHintNoKb', 'To go to a symbol, configure a keybinding for the command Go To Symbol in Accessible View');
			}
		}
		return goToSymbolHint;
	}
}

export class AccessibleViewService extends Disposable implements IAccessibleViewService {
	declare readonly _serviceBrand: undefined;
	private _accessibleView: AccessibleView | undefined;

	constructor(
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IKeybindingService private readonly _keybindingService: IKeybindingService
	) {
		super();
	}

	show(provider: IAccessibleContentProvider): void {
		if (!this._accessibleView) {
			this._accessibleView = this._register(this._instantiationService.createInstance(AccessibleView));
		}
		this._accessibleView.show(provider);

	}
	next(): void {
		this._accessibleView?.next();
	}
	previous(): void {
		this._accessibleView?.previous();
	}
	goToSymbol(): void {
		this._accessibleView?.goToSymbol();
	}
	getOpenAriaHint(verbositySettingKey: AccessibilityVerbositySettingId): string | null {
		if (!this._configurationService.getValue(verbositySettingKey)) {
			return null;
		}
		const keybinding = this._keybindingService.lookupKeybinding(AccessibleViewAction.id)?.getAriaLabel();
		let hint = null;
		if (keybinding) {
			hint = localize('acessibleViewHint', "Inspect this in the accessible view with {0}", keybinding);
		} else {
			hint = localize('acessibleViewHintNoKbEither', "Inspect this in the accessible view via the command Open Accessible View which is currently not triggerable via keybinding.");
		}
		return hint;
	}
	disableHint(): void {
		this._accessibleView?.disableHint();
	}
	showAccessibleViewHelp(): void {
		this._accessibleView?.showAccessibleViewHelp();
	}
	focusToolbar(): void {
		this._accessibleView?.focusToolbar();
	}
}


class AccessibleViewSymbolQuickPick {
	constructor(private _accessibleView: AccessibleView, @IQuickInputService private readonly _quickInputService: IQuickInputService) {

	}
	show(provider: IAccessibleContentProvider): void {
		const quickPick = this._quickInputService.createQuickPick<IAccessibleViewSymbol>();
		quickPick.title = localize('accessibleViewSymbolQuickPickTitle', "Go to Symbol Accessible View");
		const picks = [];
		const symbols = this._accessibleView.getSymbols();
		if (!symbols) {
			return;
		}
		for (const symbol of symbols) {
			picks.push({
				label: symbol.label,
				ariaLabel: symbol.ariaLabel
			});
		}
		quickPick.canSelectMany = false;
		quickPick.items = symbols;
		quickPick.show();
		quickPick.onDidAccept(() => {
			this._accessibleView.showSymbol(provider, quickPick.selectedItems[0]);
			quickPick.hide();
		});
		quickPick.onDidHide(() => {
			if (quickPick.selectedItems.length === 0) {
				// this was escaped, so refocus the accessible view
				this._accessibleView.show(provider);
			}
		});
	}
}

interface IAccessibleViewSymbol extends IPickerQuickAccessItem {
	info: string;
	firstListItem?: string;
}
const accessibleViewMenu = {
	id: MenuId.AccessibleView,
	group: 'navigation',
	when: accessibleViewIsShown
};
const commandPalette = {
	id: MenuId.CommandPalette,
	group: '',
	order: 1
};
class AccessibleViewNextAction extends Action2 {
	constructor() {
		super({
			id: 'editor.action.accessibleViewNext',
			precondition: accessibleViewIsShown,
			keybinding: {
				primary: KeyMod.Alt | KeyCode.BracketRight,
				weight: KeybindingWeight.WorkbenchContrib
			},
			menu: [commandPalette, accessibleViewMenu],
			icon: Codicon.chevronRight,
			title: localize('editor.action.accessibleViewNext', "Show Next in Accessible View")
		});
	}
	run(accessor: ServicesAccessor): void {
		accessor.get(IAccessibleViewService).next();
	}
}
registerAction2(AccessibleViewNextAction);


class AccessibleViewPreviousAction extends Action2 {
	constructor() {
		super({
			id: 'editor.action.accessibleViewPrevious',
			precondition: accessibleViewIsShown,
			keybinding: {
				primary: KeyMod.Alt | KeyCode.BracketLeft,
				weight: KeybindingWeight.WorkbenchContrib
			},
			icon: Codicon.chevronLeft,
			menu: [commandPalette, accessibleViewMenu],
			title: localize('editor.action.accessibleViewPrevious', "Show Previous in Accessible View")
		});
	}
	run(accessor: ServicesAccessor): void {
		accessor.get(IAccessibleViewService).previous();
	}
}
registerAction2(AccessibleViewPreviousAction);


class AccessibleViewGoToSymbolAction extends Action2 {
	constructor() {
		super({
			id: 'editor.action.accessibleViewGoToSymbol',
			precondition: accessibleViewIsShown,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyO,
				weight: KeybindingWeight.WorkbenchContrib + 10
			},
			icon: Codicon.symbolField,
			menu: [commandPalette, accessibleViewMenu],
			title: localize('editor.action.accessibleViewGoToSymbol', "Go To Symbol in Accessible View")
		});
	}
	run(accessor: ServicesAccessor): void {
		accessor.get(IAccessibleViewService).goToSymbol();
	}
}
registerAction2(AccessibleViewGoToSymbolAction);

function registerCommand<T extends Command>(command: T): T {
	command.register();
	return command;
}

export const AccessibilityHelpAction = registerCommand(new MultiCommand({
	id: 'editor.action.accessibilityHelp',
	precondition: undefined,
	kbOpts: {
		primary: KeyMod.Alt | KeyCode.F1,
		weight: KeybindingWeight.WorkbenchContrib,
		linux: {
			primary: KeyMod.Alt | KeyMod.Shift | KeyCode.F1,
			secondary: [KeyMod.Alt | KeyCode.F1]
		}
	},
	menuOpts: [{
		menuId: MenuId.CommandPalette,
		group: '',
		title: localize('editor.action.accessibilityHelp', "Open Accessibility Help"),
		order: 1
	}],
}));


export const AccessibleViewAction = registerCommand(new MultiCommand({
	id: 'editor.action.accessibleView',
	precondition: undefined,
	kbOpts: {
		primary: KeyMod.Alt | KeyCode.F2,
		weight: KeybindingWeight.WorkbenchContrib,
		linux: {
			primary: KeyMod.Alt | KeyMod.Shift | KeyCode.F2,
			secondary: [KeyMod.Alt | KeyCode.F2]
		}
	},
	menuOpts: [{
		menuId: MenuId.CommandPalette,
		group: '',
		title: localize('editor.action.accessibleView', "Open Accessible View"),
		order: 1
	}],
}));

class AccessibleViewDisableHintAction extends Action2 {
	constructor() {
		super({
			id: 'editor.action.accessibleViewDisableHint',
			keybinding: {
				when: ContextKeyExpr.or(accessibleViewIsShown, accessibilityHelpIsShown),
				primary: KeyMod.Alt | KeyCode.F6,
				weight: KeybindingWeight.WorkbenchContrib
			},
			icon: Codicon.treeFilterClear,
			menu: [commandPalette,
				{
					id: MenuId.AccessibleView,
					group: 'navigation',
					when: ContextKeyExpr.or(accessibleViewIsShown, accessibilityHelpIsShown)
				}],
			title: localize('editor.action.accessibleViewDisableHint', "Disable Accessible View Hint")
		});
	}
	run(accessor: ServicesAccessor): void {
		accessor.get(IAccessibleViewService).disableHint();
	}
}
registerAction2(AccessibleViewDisableHintAction);

class AccessibleViewFocusToolbarAction extends Action2 {
	constructor() {
		super({
			id: 'editor.action.accessibleViewFocusToolbar',
			keybinding: {
				when: accessibleViewIsShown,
				primary: KeyMod.Alt | KeyCode.F7,
				weight: KeybindingWeight.WorkbenchContrib
			},
			menu: [commandPalette],
			title: localize('editor.action.accessibleViewFocusToolbar', "Accessible View Focus Toolbar")
		});
	}
	run(accessor: ServicesAccessor): void {
		accessor.get(IAccessibleViewService).focusToolbar();
	}
}
registerAction2(AccessibleViewFocusToolbarAction);
