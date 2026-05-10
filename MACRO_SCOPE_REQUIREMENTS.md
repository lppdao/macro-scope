# Macro Scope VS Code 插件需求设计

## 目标

开发一个用于 C/C++ 文件的 VS Code 插件，帮助用户快速判断当前光标所在行处于哪些宏控制结构中。

插件整体采用 Rust LSP + VS Code TypeScript 客户端架构：

- Rust LSP 负责快速解析 C/C++ 文件中的预处理宏控制结构。
- VS Code 客户端负责展示当前光标所在行的宏控链。
- 默认不在代码编辑区叠加高亮、状态栏路径或当前行 Inlay Hint，避免干扰代码阅读。
- 对 `#else` 和 `#endif` 边界指令可提供轻量 Inlay Hint，用于就地标注其对应的起始宏条件。

核心体验：

> 用户把光标放到任意一行，插件立即显示该行处于哪些 `#if/#ifdef/#ifndef/#elif/#else/#endif` 宏控结构中，并支持以 Peek 方式查看相关宏控位置，而不打断当前阅读位置。

## 支持的宏控指令

需要识别以下预处理指令：

```c
#if
#ifdef
#ifndef
#elif
#else
#endif
```

需要支持嵌套结构，例如：

```c
#ifdef CONFIG_NET
  #if ENABLE_TLS
    foo();
  #else
    bar();
  #endif
#endif
```

当光标位于 `foo();` 时，应识别其处于：

```text
#ifdef CONFIG_NET
└─ #if ENABLE_TLS
   └─ Current line
```

当光标位于 `bar();` 时，应识别其处于：

```text
#ifdef CONFIG_NET
└─ #else of #if ENABLE_TLS
   └─ Current line
```

## 总体架构

```text
VS Code Extension Client
        |
        | LSP / custom request
        v
Rust LSP Server
        |
        | parse and cache document macro structure
        v
Macro Scope Index
```

### Rust LSP Server

职责：

- 监听文档打开、修改、关闭。
- 解析当前文档中的宏控结构。
- 缓存每个打开文档的宏控索引。
- 提供当前光标所在行的宏控链查询。
- 对异常宏控结构进行容错。

建议技术栈：

- `tower-lsp` 或 `lsp-server`
- `lsp-types`
- `ropey`
- `serde`
- `tracing`

### VS Code Client

职责：

- 启动 Rust LSP server。
- 监听当前编辑器光标变化。
- 向 LSP 查询当前光标所在行的宏控链。
- 刷新 `Current Macro Scope` Tree View。
- 注册 `#else/#endif` 边界指令 Inlay Hint 展示。
- 提供 `Peek Current Macro Scope` 命令。
- 将 `Peek Current Macro Scope` 命令贡献到编辑器右键菜单，作为就地触发入口。

## 核心功能

### 1. Current Macro Scope Tree View

插件提供一个 VS Code 原生 Tree View，名称建议为：

```text
Current Macro Scope
```

该视图只显示当前光标所在行的宏控链，不显示整个文件的宏控树。

示例：

```text
Current Macro Scope
└─ #ifdef CONFIG_NET              12-220
   └─ #if ENABLE_TLS              48-180
      └─ #else of #if USE_SSL     120-150
         └─ Current line          137
```

如果当前行不在任何宏控结构中：

```text
Current Macro Scope
└─ Current line                   137
   No macro scope
```

显示要求：

- 按外层到内层展示宏控链。
- 最底部追加 `Current line` 节点，作为视觉锚点。
- 每层显示对应范围，例如 `12-220`。
- 对当前分支显示明确语义：
  - `#if CONDITION`
  - `#ifdef CONDITION`
  - `#ifndef CONDITION`
  - `#elif CONDITION of #if ORIGINAL_CONDITION`
  - `#else of #if ORIGINAL_CONDITION`
- 点击宏控节点跳转到对应指令行。
- 点击 `Current line` 跳回当前光标行。
- Tooltip 显示完整条件、宏控范围、当前分支范围。

### 2. Peek Current Macro Scope

插件提供命令：

```text
Macro Scope: Peek Current Macro Scope
```

该命令需要支持以下触发方式：

- 命令面板触发。
- Tree View 节点或视图标题区触发。
- 编辑器右键菜单触发。

该命令使用 VS Code 原生 `editor.action.peekLocations` 实现类似 Peek References / Peek Call 的体验。

目的：

- 让用户临时查看当前行相关的宏控开始、分支、结束位置。
- 避免主编辑器跳转，关闭 Peek 后仍回到原阅读位置。
- 在阅读代码时允许用户直接对当前编辑位置右键触发 Peek，无需先移动到侧边栏或打开命令面板。

Peek 中建议包含以下位置：

```text
Start: #ifdef CONFIG_NET          12
Start: #if ENABLE_TLS             48
Branch: #else of #if USE_SSL      120
Current line                      137
End: #endif of #if USE_SSL        150
End: #endif of #if ENABLE_TLS     180
End: #endif of #ifdef CONFIG_NET  220
```

顺序建议：

1. 外层宏控开始位置。
2. 内层宏控开始位置。
3. 当前所在分支位置。
4. 当前行。
5. 内层宏控结束位置。
6. 外层宏控结束位置。

实现边界：

- VS Code 没有公开的完全自定义 Peek View API。
- 因此不实现自定义左右布局。
- 使用内置 `editor.action.peekLocations` 将宏控节点转换成 `Location` 列表。

#### 编辑器右键菜单触发设计

`macroScope.peekCurrentScope` 需要贡献到 VS Code `editor/context` 菜单中，菜单标题复用命令标题：

```json
{
  "command": "macroScope.peekCurrentScope",
  "when": "editorTextFocus && config.macroScope.enabled && macroScope.supportedLanguage",
  "group": "navigation@50"
}
```

交互要求：

- 用户在 C/C++ 编辑器中右键任意代码位置时，菜单显示 `Macro Scope: Peek Current Macro Scope`。
- 触发命令时使用当前活动编辑器的主光标位置。
- 不依赖右键点击的鼠标坐标推断目标行，避免和 VS Code 编辑器选择、右键行为产生不一致。
- 当当前文件语言不在 `macroScope.supportedLanguages` 中，或 `macroScope.enabled` 为 `false` 时，不显示该菜单项。
- 如果当前行没有宏控链，仍可触发 Peek，但只展示 `Current line`，并允许命令给出轻量提示 `No macro scope`。

实现建议：

- 在 `package.json` 的 `contributes.menus.editor/context` 中添加 `macroScope.peekCurrentScope`。
- 右键菜单入口和命令面板入口共用同一个 command handler，避免行为分叉。
- command handler 内部统一检查当前活动编辑器、语言、配置开关与 LSP 可用状态。
- 客户端监听活动编辑器和 `macroScope.supportedLanguages` 配置变化，并通过 `vscode.commands.executeCommand('setContext', 'macroScope.supportedLanguage', boolean)` 维护菜单可见性。

### 3. `#else/#endif` 边界 Inlay Hints

插件为 `#else` 和 `#endif` 行提供 VS Code 原生 Inlay Hint，帮助用户在长宏块或嵌套宏块中快速确认边界对应的起始条件。

展示规则：

- 只在预处理指令行 `#else` 和 `#endif` 后显示提示。
- Hint 位置应放在该行指令 token 之后，即 `#else` 或 `#endif` 文本结束处，而不是使用固定列号。
- `#else` 后显示 `/* ... */` 包裹的起始宏条件内容，内容为对应宏块起始指令及其条件：
  - `#else /* #if ENABLE_TLS */`
  - `#else /* #ifdef CONFIG_NET */`
  - `#else /* #ifndef CONFIG_LEGACY */`
- `#endif` 后显示 `/* ... */` 包裹的结束说明，格式为 `end of` 加对应宏块起始指令及其条件：
  - `#endif /* end of #if ENABLE_TLS */`
  - `#endif /* end of #ifdef CONFIG_NET */`
  - `#endif /* end of #ifndef CONFIG_LEGACY */`
- 提示内容来源于解析后的 `MacroBlock.kind` 和 `MacroBlock.condition`，不从当前行附近做字符串猜测。
- 当条件过长时，客户端按 `macroScope.maxConditionLength` 截断显示，并在 tooltip 中保留完整条件。
- 对孤立 `#else/#endif` 或无法匹配到起始宏块的异常结构，不显示 Inlay Hint，只记录 warning。

交互要求：

- Inlay Hint 使用 VS Code 原生 Inlay Hint API 或 LSP 标准 `textDocument/inlayHint` 能力实现。
- Hint 类型使用普通文本提示，不参与代码修改，不自动插入真实注释。
- Tooltip 展示完整起始指令、起始行、边界行和宏控范围。
- 提示应跟随文档修改、配置变化和可见范围刷新。
- 关闭 `macroScope.boundaryInlayHints.enabled` 后不显示该类提示。

LSP Inlay Hint 响应建议：

```json
[
  {
    "position": {
      "line": 120,
      "character": 7
    },
    "label": "/* #if ENABLE_TLS */",
    "kind": "Type",
    "tooltip": "#else of #if ENABLE_TLS, range 48-180"
  },
  {
    "position": {
      "line": 180,
      "character": 8
    },
    "label": "/* end of #if ENABLE_TLS */",
    "kind": "Type",
    "tooltip": "#endif of #if ENABLE_TLS, range 48-180"
  }
]
```

实现建议：

- Rust 解析阶段在 `MacroBlock` 中保留起始指令显示文本，例如 `#if ENABLE_TLS`、`#ifdef CONFIG_NET`。
- 解析 `#else` 时，将该分支的 `directive_line` 与当前栈顶 `MacroBlock.id` 建立映射。
- 解析 `#endif` 时，将结束行与被弹出的 `MacroBlock.id` 建立映射。
- LSP 根据客户端请求范围只返回范围内的 `#else/#endif` hints，避免全文件刷新。
- 客户端不自行推导匹配关系，只负责按配置截断、显示和刷新。

### 4. LSP Current Scope 查询

Rust LSP 提供自定义 request：

```text
macroScope/currentScope
```

请求参数：

```json
{
  "textDocument": {
    "uri": "file:///path/to/main.c"
  },
  "position": {
    "line": 137,
    "character": 4
  }
}
```

响应示例：

```json
{
  "line": 137,
  "currentLine": {
    "label": "Current line",
    "line": 137,
    "character": 4
  },
  "scopes": [
    {
      "kind": "ifdef",
      "condition": "CONFIG_NET",
      "startLine": 12,
      "endLine": 220,
      "directiveLine": 12,
      "activeBranch": {
        "kind": "if",
        "directiveLine": 12,
        "startLine": 13,
        "endLine": 219
      }
    },
    {
      "kind": "if",
      "condition": "ENABLE_TLS",
      "startLine": 48,
      "endLine": 180,
      "directiveLine": 48,
      "activeBranch": {
        "kind": "if",
        "directiveLine": 48,
        "startLine": 49,
        "endLine": 119
      }
    },
    {
      "kind": "if",
      "condition": "USE_SSL",
      "startLine": 116,
      "endLine": 150,
      "directiveLine": 116,
      "activeBranch": {
        "kind": "else",
        "directiveLine": 120,
        "startLine": 121,
        "endLine": 149
      }
    }
  ]
}
```

## Rust 解析模型

建议内部结构：

```rust
struct MacroBlock {
    id: u32,
    kind: MacroKind,
    condition: String,
    opening_label: String,
    directive_line: u32,
    start_line: u32,
    end_line: Option<u32>,
    endif_line: Option<u32>,
    parent: Option<u32>,
    children: Vec<u32>,
    branches: Vec<MacroBranch>,
}

struct MacroBranch {
    kind: BranchKind,
    condition: Option<String>,
    directive_line: u32,
    start_line: u32,
    end_line: Option<u32>,
    owner_block: u32,
}

enum MacroKind {
    If,
    Ifdef,
    Ifndef,
}

enum BranchKind {
    If,
    Elif,
    Else,
}
```

解析算法：

```text
按行扫描文档

遇到 #if/#ifdef/#ifndef:
  创建 MacroBlock
  保存 opening_label，例如 "#if ENABLE_TLS"
  创建初始 if branch
  将 block 入栈

遇到 #elif:
  结束栈顶 block 的当前 branch
  给栈顶 block 添加 elif branch

遇到 #else:
  结束栈顶 block 的当前 branch
  给栈顶 block 添加 else branch
  记录 else 行到栈顶 block 的映射，用于 Inlay Hint

遇到 #endif:
  结束栈顶 block 的当前 branch
  设置 block end_line
  记录 endif 行到该 block 的映射，用于 Inlay Hint
  弹出栈顶 block
```

容错要求：

- 未闭合宏块：`end_line` 暂设为文件末尾，并记录 warning。
- 孤立 `#endif`：记录 warning，不中断解析。
- 孤立 `#elif/#else`：记录 warning，不中断解析。
- 支持反斜杠续行的宏条件。
- 尽量忽略注释中的伪预处理指令。

## 性能要求

- 单文件解析复杂度为 `O(n)`。
- 文档打开时解析一次。
- 文档修改后 debounce 解析。
- 光标移动后 debounce 查询，建议默认 `80ms`。
- Current Scope 查询应接近 `O(log n + depth)` 或 `O(depth)`。
- 避免全文件 UI 刷新。
- 大文件中仍应保持光标移动流畅。

## VS Code 配置项

建议提供：

```json
{
  "macroScope.enabled": true,
  "macroScope.currentScopeView.enabled": true,
  "macroScope.boundaryInlayHints.enabled": true,
  "macroScope.debounceMs": 80,
  "macroScope.maxConditionLength": 80,
  "macroScope.supportedLanguages": [
    "c",
    "cpp"
  ]
}
```

## 命令

建议提供：

```json
{
  "command": "macroScope.peekCurrentScope",
  "title": "Macro Scope: Peek Current Macro Scope"
}
```

```json
{
  "command": "macroScope.refreshCurrentScope",
  "title": "Macro Scope: Refresh Current Macro Scope"
}
```

## VS Code 菜单贡献

建议将 `Peek Current Macro Scope` 暴露到编辑器右键菜单：

```json
{
  "contributes": {
    "menus": {
      "editor/context": [
        {
          "command": "macroScope.peekCurrentScope",
          "when": "editorTextFocus && config.macroScope.enabled && macroScope.supportedLanguage",
          "group": "navigation@50"
        }
      ]
    }
  }
}
```

菜单可见性需要与配置保持一致：

- `macroScope.enabled` 为 `false` 时不应显示或不应执行该命令。
- 当前语言不在 `macroScope.supportedLanguages` 中时不应显示或不应执行该命令。
- 客户端需要维护 `macroScope.supportedLanguage` context key，使菜单可见性跟随当前活动编辑器和 `macroScope.supportedLanguages` 配置变化。
- command handler 中仍需要做最终校验，避免 context key 滞后或命令被其他入口直接调用。

## 明确不做的功能

为避免影响代码阅读，当前版本不做：

- 不做全文件宏树视图。
- 不做编辑器范围高亮。
- 不做状态栏宏路径。
- 不做当前行 Inlay Hint；仅允许在 `#else/#endif` 边界指令行显示宏块匹配提示。
- 不在普通代码行上增加额外提示。
- 不做自定义 Webview Peek 窗口。

## MVP 范围

第一版只实现：

1. Rust LSP 解析宏控结构。
2. `macroScope/currentScope` 自定义查询。
3. VS Code `Current Macro Scope` Tree View。
4. Tree View 中显示 `Current line`。
5. `Peek Current Macro Scope` 命令。
6. 编辑器右键菜单触发 `Peek Current Macro Scope`。
7. `#else/#endif` 边界 Inlay Hints。
8. 基础异常宏控容错。

后续可选增强：

- 更强的注释状态机。
- 更好的复杂表达式缩略显示。
- 宏条件表达式规范化。
- Diagnostics 显示未闭合或异常宏控。
- 单元测试覆盖复杂嵌套宏控样例。
