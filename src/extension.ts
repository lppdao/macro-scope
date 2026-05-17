import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind
} from 'vscode-languageclient/node';

const CURRENT_SCOPE_REQUEST = 'macroScope/currentScope';
const BOUNDARY_INLAY_HINTS_REQUEST = 'macroScope/boundaryInlayHints';
const SUPPORTED_LANGUAGE_CONTEXT = 'macroScope.supportedLanguage';

interface CurrentScopeParams {
  textDocument: { uri: string };
  position: { line: number; character: number };
}

interface BoundaryInlayHintsParams {
  textDocument: { uri: string };
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

interface BoundaryInlayHintItem {
  kind: 'else' | 'endif';
  line: number;
  openingLabel: string;
  startLine: number;
  endLine: number;
}

interface ScopeBranch {
  kind: 'if' | 'elif' | 'else';
  condition?: string | null;
  directiveLine: number;
  startLine: number;
  endLine: number;
}

interface ScopeItem {
  kind: 'if' | 'ifdef' | 'ifndef';
  condition: string;
  startLine: number;
  endLine: number;
  directiveLine: number;
  activeBranch: ScopeBranch;
}

interface CurrentScopeResponse {
  line: number;
  currentLine: {
    label: string;
    line: number;
    character: number;
  };
  scopes: ScopeItem[];
  warnings: string[];
}

class ScopeTreeItem extends vscode.TreeItem {
  public readonly children: ScopeTreeItem[];
  public readonly uri?: vscode.Uri;
  public readonly targetLine?: number;
  public readonly targetCharacter?: number;

  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    options: {
      description?: string;
      tooltip?: string;
      children?: ScopeTreeItem[];
      uri?: vscode.Uri;
      targetLine?: number;
      targetCharacter?: number;
      contextValue?: string;
    } = {}
  ) {
    super(label, collapsibleState);
    this.description = options.description;
    this.tooltip = options.tooltip;
    this.children = options.children ?? [];
    this.uri = options.uri;
    this.targetLine = options.targetLine;
    this.targetCharacter = options.targetCharacter ?? 0;
    this.contextValue = options.contextValue;

    if (this.uri && this.targetLine !== undefined) {
      this.command = {
        command: 'macroScope.revealLine',
        title: 'Reveal Line',
        arguments: [this.uri, this.targetLine, this.targetCharacter]
      };
    }
  }
}

class CurrentScopeProvider implements vscode.TreeDataProvider<ScopeTreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<ScopeTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  private roots: ScopeTreeItem[] = [
    new ScopeTreeItem('Current line', vscode.TreeItemCollapsibleState.None, {
      description: '-',
      tooltip: 'No active editor'
    })
  ];

  refresh(response: CurrentScopeResponse | undefined, uri: vscode.Uri | undefined, maxConditionLength: number): void {
    if (!response || !uri) {
      this.roots = [
        new ScopeTreeItem('Current line', vscode.TreeItemCollapsibleState.None, {
          description: '-',
          tooltip: 'No active editor'
        })
      ];
      this.onDidChangeTreeDataEmitter.fire();
      return;
    }

    const current = new ScopeTreeItem('Current line', vscode.TreeItemCollapsibleState.None, {
      description: oneBasedLine(response.currentLine.line).toString(),
      tooltip: `Current line ${oneBasedLine(response.currentLine.line)}`,
      uri,
      targetLine: response.currentLine.line,
      targetCharacter: response.currentLine.character,
      contextValue: 'currentLine'
    });

    if (response.scopes.length === 0) {
      const noScope = new ScopeTreeItem('No macro scope', vscode.TreeItemCollapsibleState.None);
      current.children.push(noScope);
      this.roots = [current];
      this.onDidChangeTreeDataEmitter.fire();
      return;
    }

    let child = current;
    for (const scope of [...response.scopes].reverse()) {
      const branch = scope.activeBranch;
      const label = truncate(labelForScope(scope, maxConditionLength), maxConditionLength);
      const node = new ScopeTreeItem(label, vscode.TreeItemCollapsibleState.Expanded, {
        description: `${oneBasedLine(scope.startLine)}-${oneBasedLine(scope.endLine)}`,
        tooltip: tooltipForScope(scope),
        children: [child],
        uri,
        targetLine: branch.directiveLine,
        contextValue: 'macroScope'
      });
      child = node;
    }

    this.roots = [child];
    this.onDidChangeTreeDataEmitter.fire();
  }

  getTreeItem(element: ScopeTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ScopeTreeItem): ScopeTreeItem[] {
    return element ? element.children : this.roots;
  }
}

class BoundaryInlayHintsProvider implements vscode.InlayHintsProvider {
  private readonly onDidChangeInlayHintsEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeInlayHints = this.onDidChangeInlayHintsEmitter.event;

  constructor(
    private readonly client: LanguageClient,
    private readonly isServerStarted: () => boolean
  ) {}

  refresh(): void {
    this.onDidChangeInlayHintsEmitter.fire();
  }

  async provideInlayHints(
    document: vscode.TextDocument,
    range: vscode.Range,
    token: vscode.CancellationToken
  ): Promise<vscode.InlayHint[]> {
    if (
      token.isCancellationRequested ||
      !this.isServerStarted() ||
      !isEnabled() ||
      !areBoundaryInlayHintsEnabled() ||
      !isSupportedDocument(document)
    ) {
      return [];
    }

    const params: BoundaryInlayHintsParams = {
      textDocument: { uri: document.uri.toString() },
      range: {
        start: { line: range.start.line, character: range.start.character },
        end: { line: range.end.line, character: range.end.character }
      }
    };

    const items = await this.client
      .sendRequest<BoundaryInlayHintItem[]>(BOUNDARY_INLAY_HINTS_REQUEST, params)
      .catch((error) => {
        console.warn('Macro Scope boundary inlay hints request failed', error);
        return [];
      });

    if (token.isCancellationRequested) {
      return [];
    }

    return items
      .map((item) => toBoundaryInlayHint(document, item))
      .filter((hint): hint is vscode.InlayHint => !!hint);
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const provider = new CurrentScopeProvider();
  context.subscriptions.push(vscode.window.createTreeView('macroScope.currentScope', { treeDataProvider: provider }));
  await updateSupportedLanguageContext();

  const serverPath = resolveServerPath(context);
  const serverOptions: ServerOptions = {
    run: { command: serverPath, transport: TransportKind.stdio },
    debug: { command: serverPath, transport: TransportKind.stdio }
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: supportedLanguages().map((language) => ({ scheme: 'file', language })),
    synchronize: {
      configurationSection: 'macroScope'
    }
  };

  const client = new LanguageClient('macroScope', 'Macro Scope', serverOptions, clientOptions);
  context.subscriptions.push(client);

  let started = false;
  const boundaryInlayHintsProvider = new BoundaryInlayHintsProvider(client, () => started);
  context.subscriptions.push(
    vscode.languages.registerInlayHintsProvider({ scheme: 'file' }, boundaryInlayHintsProvider)
  );
  try {
    await client.start();
    started = true;
  } catch (error) {
    vscode.window.showWarningMessage(`Macro Scope server failed to start: ${String(error)}`);
  }

  const refresh = debounce(async () => {
    if (!started || !isEnabled() || !isViewEnabled()) {
      provider.refresh(undefined, undefined, maxConditionLength());
      return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor || !isSupportedDocument(editor.document)) {
      provider.refresh(undefined, undefined, maxConditionLength());
      return;
    }

    const response = await requestCurrentScope(client, editor).catch((error) => {
      console.warn('Macro Scope request failed', error);
      return undefined;
    });
    provider.refresh(response, editor.document.uri, maxConditionLength());
  }, debounceMs());

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      void updateSupportedLanguageContext();
      refresh();
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (event.textEditor === vscode.window.activeTextEditor) {
        refresh();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('macroScope')) {
        refresh.setDelay(debounceMs());
        void updateSupportedLanguageContext();
        boundaryInlayHintsProvider.refresh();
        refresh();
      }
    }),
    vscode.commands.registerCommand('macroScope.refreshCurrentScope', () => refresh()),
    vscode.commands.registerCommand('macroScope.peekCurrentScope', async () => {
      if (!isEnabled()) {
        return;
      }
      if (!started) {
        vscode.window.showWarningMessage('Macro Scope server is not running.');
        return;
      }
      const editor = vscode.window.activeTextEditor;
      if (!editor || !isSupportedDocument(editor.document)) {
        return;
      }
      const response = await requestCurrentScope(client, editor);
      await peekCurrentScope(editor, response);
    }),
    vscode.commands.registerCommand('macroScope.revealLine', async (uri: vscode.Uri, line: number, character = 0) => {
      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document, { preserveFocus: false, preview: false });
      const position = new vscode.Position(line, character);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    })
  );

  refresh();
}

export function deactivate(): Thenable<void> | undefined {
  return undefined;
}

async function requestCurrentScope(client: LanguageClient, editor: vscode.TextEditor): Promise<CurrentScopeResponse> {
  const position = editor.selection.active;
  const params: CurrentScopeParams = {
    textDocument: { uri: editor.document.uri.toString() },
    position: { line: position.line, character: position.character }
  };
  return client.sendRequest<CurrentScopeResponse>(CURRENT_SCOPE_REQUEST, params);
}

async function peekCurrentScope(editor: vscode.TextEditor, response: CurrentScopeResponse): Promise<void> {
  const uri = editor.document.uri;
  const locations: vscode.Location[] = [];

  for (const scope of response.scopes) {
    locations.push(locationAt(uri, scope.directiveLine));
  }

  for (const scope of response.scopes) {
    const branchLine = scope.activeBranch.directiveLine;
    if (branchLine !== scope.directiveLine) {
      locations.push(locationAt(uri, branchLine));
    }
  }

  locations.push(locationAt(uri, response.currentLine.line, response.currentLine.character));

  for (const scope of [...response.scopes].reverse()) {
    locations.push(locationAt(uri, scope.endLine));
  }

  await vscode.commands.executeCommand(
    'editor.action.peekLocations',
    uri,
    editor.selection.active,
    locations,
    'peek'
  );
}

function locationAt(uri: vscode.Uri, line: number, character = 0): vscode.Location {
  const position = new vscode.Position(Math.max(line, 0), Math.max(character, 0));
  return new vscode.Location(uri, new vscode.Range(position, position));
}

function toBoundaryInlayHint(
  document: vscode.TextDocument,
  item: BoundaryInlayHintItem
): vscode.InlayHint | undefined {
  if (item.line < 0 || item.line >= document.lineCount) {
    return undefined;
  }

  const line = document.lineAt(item.line);
  const character = boundaryDirectiveEndCharacter(line.text);
  if (character === undefined) {
    return undefined;
  }

  const openingLabel = truncate(item.openingLabel, maxConditionLength());
  const label =
    item.kind === 'else'
      ? `/* ${openingLabel} */`
      : `/* end of ${openingLabel} */`;
  const hint = new vscode.InlayHint(
    new vscode.Position(item.line, character),
    label,
    vscode.InlayHintKind.Type
  );
  const boundaryName = item.kind === 'else' ? '#else' : '#endif';
  hint.tooltip = [
    `${boundaryName} of ${item.openingLabel}`,
    `Macro range: ${oneBasedLine(item.startLine)}-${oneBasedLine(item.endLine)}`
  ].join('\n');
  hint.paddingLeft = true;
  return hint;
}

function boundaryDirectiveEndCharacter(text: string): number | undefined {
  const match = text.match(/^\s*#\s*(else|endif)\b/);
  return match ? match[0].length : undefined;
}

function resolveServerPath(context: vscode.ExtensionContext): string {
  const exe = process.platform === 'win32' ? '.exe' : '';
  const platformArch = `${process.platform}-${process.arch}`;
  const binaryName = `macro-scope-server${exe}`;

  const targetTriples: Record<string, string> = {
    'win32-x64': 'x86_64-pc-windows-msvc',
    'linux-x64': 'x86_64-unknown-linux-musl'
  };

  const candidates: string[] = [
    path.join(context.extensionPath, 'server', 'bin', platformArch, binaryName),
    path.join(context.extensionPath, 'server', 'bin', binaryName)
  ];

  const triple = targetTriples[platformArch];
  if (triple) {
    candidates.push(
      path.join(context.extensionPath, 'server', 'target', triple, 'release', binaryName)
    );
  }
  candidates.push(
    path.join(context.extensionPath, 'server', 'target', 'release', binaryName),
    path.join(context.extensionPath, 'server', 'target', 'debug', binaryName)
  );

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      ensureExecutable(candidate);
      return candidate;
    }
  }
  return candidates[candidates.length - 1];
}

function ensureExecutable(binaryPath: string): void {
  if (process.platform === 'win32') {
    return;
  }
  try {
    const mode = fs.statSync(binaryPath).mode;
    if ((mode & 0o111) === 0) {
      fs.chmodSync(binaryPath, mode | 0o755);
    }
  } catch (error) {
    console.warn(`Macro Scope: failed to ensure executable bit on ${binaryPath}`, error);
  }
}

function labelForScope(scope: ScopeItem, maxLength: number): string {
  const condition = truncate(scope.condition, maxLength);
  const active = scope.activeBranch;
  if (active.kind === 'elif') {
    return `#elif ${truncate(active.condition ?? '', maxLength)} of #${scope.kind} ${condition}`;
  }
  if (active.kind === 'else') {
    return `#else of #${scope.kind} ${condition}`;
  }
  return `#${scope.kind} ${condition}`;
}

function tooltipForScope(scope: ScopeItem): string {
  const branch = scope.activeBranch;
  return [
    `Condition: #${scope.kind} ${scope.condition}`,
    `Macro range: ${oneBasedLine(scope.startLine)}-${oneBasedLine(scope.endLine)}`,
    `Branch: #${branch.kind}${branch.condition ? ` ${branch.condition}` : ''}`,
    `Branch range: ${oneBasedLine(branch.startLine)}-${oneBasedLine(branch.endLine)}`
  ].join('\n');
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function supportedLanguages(): string[] {
  return vscode.workspace.getConfiguration('macroScope').get<string[]>('supportedLanguages', ['c', 'cpp']);
}

function debounceMs(): number {
  return vscode.workspace.getConfiguration('macroScope').get<number>('debounceMs', 80);
}

function maxConditionLength(): number {
  return vscode.workspace.getConfiguration('macroScope').get<number>('maxConditionLength', 80);
}

function isEnabled(): boolean {
  return vscode.workspace.getConfiguration('macroScope').get<boolean>('enabled', true);
}

function isViewEnabled(): boolean {
  return vscode.workspace.getConfiguration('macroScope').get<boolean>('currentScopeView.enabled', true);
}

function areBoundaryInlayHintsEnabled(): boolean {
  return vscode.workspace.getConfiguration('macroScope').get<boolean>('boundaryInlayHints.enabled', true);
}

function isSupportedDocument(document: vscode.TextDocument): boolean {
  return supportedLanguages().includes(document.languageId);
}

async function updateSupportedLanguageContext(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const supported = !!editor && isSupportedDocument(editor.document);
  await vscode.commands.executeCommand('setContext', SUPPORTED_LANGUAGE_CONTEXT, supported);
}

function oneBasedLine(line: number): number {
  return line + 1;
}

function debounce<T extends (...args: never[]) => void>(fn: T, initialDelay: number): T & { setDelay(delay: number): void } {
  let handle: NodeJS.Timeout | undefined;
  let delay = initialDelay;
  const wrapped = ((...args: never[]) => {
    if (handle) {
      clearTimeout(handle);
    }
    handle = setTimeout(() => fn(...args), delay);
  }) as T & { setDelay(delay: number): void };
  wrapped.setDelay = (nextDelay: number) => {
    delay = nextDelay;
  };
  return wrapped;
}
