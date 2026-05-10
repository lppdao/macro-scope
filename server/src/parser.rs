use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MacroKind {
    If,
    Ifdef,
    Ifndef,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BranchKind {
    If,
    Elif,
    Else,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MacroBranch {
    pub kind: BranchKind,
    pub condition: Option<String>,
    pub directive_line: u32,
    pub start_line: u32,
    pub end_line: u32,
}

#[derive(Debug, Clone)]
pub struct MacroBlock {
    #[allow(dead_code)]
    pub id: u32,
    pub kind: MacroKind,
    pub condition: String,
    pub opening_label: String,
    pub directive_line: u32,
    pub start_line: u32,
    pub end_line: u32,
    pub endif_line: Option<u32>,
    #[allow(dead_code)]
    pub parent: Option<u32>,
    pub children: Vec<u32>,
    pub branches: Vec<MacroBranch>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeItem {
    pub kind: MacroKind,
    pub condition: String,
    pub start_line: u32,
    pub end_line: u32,
    pub directive_line: u32,
    pub active_branch: MacroBranch,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentLine {
    pub label: String,
    pub line: u32,
    pub character: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentScopeResponse {
    pub line: u32,
    pub current_line: CurrentLine,
    pub scopes: Vec<ScopeItem>,
    pub warnings: Vec<String>,
}

impl CurrentScopeResponse {
    pub fn empty(line: u32, character: u32) -> Self {
        Self {
            line,
            current_line: CurrentLine {
                label: "Current line".to_string(),
                line,
                character,
            },
            scopes: Vec::new(),
            warnings: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BoundaryHintKind {
    Else,
    Endif,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundaryInlayHint {
    pub kind: BoundaryHintKind,
    pub line: u32,
    pub opening_label: String,
    pub start_line: u32,
    pub end_line: u32,
}

#[derive(Debug, Clone, Default)]
pub struct MacroIndex {
    blocks: Vec<MacroBlock>,
    warnings: Vec<String>,
}

impl MacroIndex {
    pub fn parse(text: &str) -> Self {
        let logical_lines = logical_lines(text);
        let line_count = text.lines().count().max(1) as u32;
        let mut index = Self {
            blocks: Vec::new(),
            warnings: Vec::new(),
        };
        let mut stack: Vec<u32> = Vec::new();

        for logical in logical_lines {
            let Some(directive) = parse_directive(&logical.text) else {
                continue;
            };

            match directive {
                Directive::Open { kind, condition } => {
                    let id = index.blocks.len() as u32;
                    let parent = stack.last().copied();
                    if let Some(parent_id) = parent {
                        index.blocks[parent_id as usize].children.push(id);
                    }
                    index.blocks.push(MacroBlock {
                        id,
                        kind,
                        condition: condition.clone(),
                        opening_label: opening_label(kind, &condition),
                        directive_line: logical.start_line,
                        start_line: logical.start_line,
                        end_line: line_count.saturating_sub(1),
                        endif_line: None,
                        parent,
                        children: Vec::new(),
                        branches: vec![MacroBranch {
                            kind: BranchKind::If,
                            condition: Some(condition),
                            directive_line: logical.start_line,
                            start_line: logical.end_line.saturating_add(1),
                            end_line: line_count.saturating_sub(1),
                        }],
                    });
                    stack.push(id);
                }
                Directive::Elif(condition) => {
                    if let Some(id) = stack.last().copied() {
                        index.close_active_branch(id, logical.start_line.saturating_sub(1));
                        index.blocks[id as usize].branches.push(MacroBranch {
                            kind: BranchKind::Elif,
                            condition: Some(condition),
                            directive_line: logical.start_line,
                            start_line: logical.end_line.saturating_add(1),
                            end_line: line_count.saturating_sub(1),
                        });
                    } else {
                        index
                            .warnings
                            .push(format!("orphan #elif at line {}", logical.start_line + 1));
                    }
                }
                Directive::Else => {
                    if let Some(id) = stack.last().copied() {
                        index.close_active_branch(id, logical.start_line.saturating_sub(1));
                        index.blocks[id as usize].branches.push(MacroBranch {
                            kind: BranchKind::Else,
                            condition: None,
                            directive_line: logical.start_line,
                            start_line: logical.end_line.saturating_add(1),
                            end_line: line_count.saturating_sub(1),
                        });
                    } else {
                        index
                            .warnings
                            .push(format!("orphan #else at line {}", logical.start_line + 1));
                    }
                }
                Directive::Endif => {
                    if let Some(id) = stack.pop() {
                        index.close_active_branch(id, logical.start_line.saturating_sub(1));
                        index.blocks[id as usize].end_line = logical.start_line;
                        index.blocks[id as usize].endif_line = Some(logical.start_line);
                    } else {
                        index
                            .warnings
                            .push(format!("orphan #endif at line {}", logical.start_line + 1));
                    }
                }
            }
        }

        for id in stack.into_iter().rev() {
            index.close_active_branch(id, line_count.saturating_sub(1));
            index.blocks[id as usize].end_line = line_count.saturating_sub(1);
            index.warnings.push(format!(
                "unclosed #{} at line {}",
                kind_name(index.blocks[id as usize].kind),
                index.blocks[id as usize].directive_line + 1
            ));
        }

        index
    }

    pub fn current_scope(&self, line: u32, character: u32) -> CurrentScopeResponse {
        let mut scopes = self
            .blocks
            .iter()
            .filter_map(|block| self.scope_for_block(block, line))
            .collect::<Vec<_>>();

        scopes.sort_by_key(|scope| (scope.start_line, scope.end_line));

        CurrentScopeResponse {
            line,
            current_line: CurrentLine {
                label: "Current line".to_string(),
                line,
                character,
            },
            scopes,
            warnings: self.warnings.clone(),
        }
    }

    pub fn boundary_inlay_hints(&self, start_line: u32, end_line: u32) -> Vec<BoundaryInlayHint> {
        let mut hints = Vec::new();

        for block in &self.blocks {
            for branch in &block.branches {
                if branch.kind == BranchKind::Else
                    && branch.directive_line >= start_line
                    && branch.directive_line <= end_line
                {
                    hints.push(BoundaryInlayHint {
                        kind: BoundaryHintKind::Else,
                        line: branch.directive_line,
                        opening_label: block.opening_label.clone(),
                        start_line: block.start_line,
                        end_line: block.end_line,
                    });
                }
            }

            if let Some(endif_line) = block.endif_line {
                if endif_line >= start_line && endif_line <= end_line {
                    hints.push(BoundaryInlayHint {
                        kind: BoundaryHintKind::Endif,
                        line: endif_line,
                        opening_label: block.opening_label.clone(),
                        start_line: block.start_line,
                        end_line: block.end_line,
                    });
                }
            }
        }

        hints.sort_by_key(|hint| hint.line);
        hints
    }

    fn close_active_branch(&mut self, id: u32, end_line: u32) {
        if let Some(branch) = self.blocks[id as usize].branches.last_mut() {
            branch.end_line = end_line;
        }
    }

    fn scope_for_block(&self, block: &MacroBlock, line: u32) -> Option<ScopeItem> {
        if line < block.start_line || line > block.end_line {
            return None;
        }

        let active_branch = block
            .branches
            .iter()
            .find(|branch| line >= branch.directive_line && line <= branch.end_line)
            .or_else(|| block.branches.last())?
            .clone();

        Some(ScopeItem {
            kind: block.kind,
            condition: block.condition.clone(),
            start_line: block.start_line,
            end_line: block.end_line,
            directive_line: block.directive_line,
            active_branch,
        })
    }

    #[cfg(test)]
    fn warnings(&self) -> &[String] {
        &self.warnings
    }
}

#[derive(Debug, Clone)]
struct LogicalLine {
    start_line: u32,
    end_line: u32,
    text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Directive {
    Open { kind: MacroKind, condition: String },
    Elif(String),
    Else,
    Endif,
}

fn logical_lines(text: &str) -> Vec<LogicalLine> {
    let mut lines = Vec::new();
    let mut current: Option<LogicalLine> = None;
    let mut in_block_comment = false;

    for (line_number, raw_line) in text.lines().enumerate() {
        let line_number = line_number as u32;
        let line = strip_comments(raw_line, &mut in_block_comment);
        let continues = line.trim_end().ends_with('\\');
        let fragment = line.trim_end().trim_end_matches('\\').trim();

        if let Some(existing) = current.as_mut() {
            existing.text.push(' ');
            existing.text.push_str(fragment.trim());
            existing.end_line = line_number;
        } else {
            current = Some(LogicalLine {
                start_line: line_number,
                end_line: line_number,
                text: fragment.to_string(),
            });
        }

        if !continues {
            if let Some(line) = current.take() {
                lines.push(line);
            }
        }
    }

    if let Some(line) = current {
        lines.push(line);
    }

    lines
}

fn parse_directive(line: &str) -> Option<Directive> {
    let trimmed = line.trim_start();
    let rest = trimmed.strip_prefix('#')?.trim_start();
    let mut parts = rest.splitn(2, char::is_whitespace);
    let keyword = parts.next()?;
    let condition = parts.next().unwrap_or("").trim().to_string();

    match keyword {
        "if" => Some(Directive::Open {
            kind: MacroKind::If,
            condition,
        }),
        "ifdef" => Some(Directive::Open {
            kind: MacroKind::Ifdef,
            condition,
        }),
        "ifndef" => Some(Directive::Open {
            kind: MacroKind::Ifndef,
            condition,
        }),
        "elif" => Some(Directive::Elif(condition)),
        "else" => Some(Directive::Else),
        "endif" => Some(Directive::Endif),
        _ => None,
    }
}

fn strip_comments(line: &str, in_block_comment: &mut bool) -> String {
    let mut output = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();

    while let Some(ch) = chars.next() {
        if *in_block_comment {
            if ch == '*' && chars.peek() == Some(&'/') {
                chars.next();
                *in_block_comment = false;
            }
            continue;
        }

        if ch == '/' {
            match chars.peek() {
                Some('/') => break,
                Some('*') => {
                    chars.next();
                    *in_block_comment = true;
                    continue;
                }
                _ => {}
            }
        }

        output.push(ch);
    }

    output
}

fn kind_name(kind: MacroKind) -> &'static str {
    match kind {
        MacroKind::If => "if",
        MacroKind::Ifdef => "ifdef",
        MacroKind::Ifndef => "ifndef",
    }
}

fn opening_label(kind: MacroKind, condition: &str) -> String {
    if condition.is_empty() {
        format!("#{}", kind_name(kind))
    } else {
        format!("#{} {}", kind_name(kind), condition)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn finds_nested_if_branch() {
        let source = r#"
#ifdef CONFIG_NET
  #if ENABLE_TLS
    foo();
  #else
    bar();
  #endif
#endif
"#;
        let index = MacroIndex::parse(source);
        let response = index.current_scope(3, 4);

        assert_eq!(response.scopes.len(), 2);
        assert_eq!(response.scopes[0].kind, MacroKind::Ifdef);
        assert_eq!(response.scopes[0].condition, "CONFIG_NET");
        assert_eq!(response.scopes[1].kind, MacroKind::If);
        assert_eq!(response.scopes[1].condition, "ENABLE_TLS");
        assert_eq!(response.scopes[1].active_branch.kind, BranchKind::If);
    }

    #[test]
    fn reports_else_branch_with_original_condition() {
        let source = r#"
#ifdef CONFIG_NET
  #if ENABLE_TLS
    foo();
  #else
    bar();
  #endif
#endif
"#;
        let index = MacroIndex::parse(source);
        let response = index.current_scope(5, 4);

        assert_eq!(response.scopes.len(), 2);
        assert_eq!(response.scopes[1].condition, "ENABLE_TLS");
        assert_eq!(response.scopes[1].active_branch.kind, BranchKind::Else);
        assert_eq!(response.scopes[1].active_branch.directive_line, 4);
    }

    #[test]
    fn supports_elif_and_continuation_lines() {
        let source = r#"
#if defined(A) && \
    defined(B)
int a;
#elif defined(C)
int c;
#endif
"#;
        let index = MacroIndex::parse(source);
        let if_response = index.current_scope(3, 0);
        let elif_response = index.current_scope(5, 0);

        assert_eq!(if_response.scopes[0].condition, "defined(A) && defined(B)");
        assert_eq!(if_response.scopes[0].active_branch.kind, BranchKind::If);
        assert_eq!(elif_response.scopes[0].active_branch.kind, BranchKind::Elif);
        assert_eq!(
            elif_response.scopes[0].active_branch.condition.as_deref(),
            Some("defined(C)")
        );
    }

    #[test]
    fn tolerates_orphans_and_unclosed_blocks() {
        let source = r#"
#else
#ifdef CONFIG_A
int a;
"#;
        let index = MacroIndex::parse(source);
        let response = index.current_scope(3, 0);

        assert_eq!(response.scopes.len(), 1);
        assert_eq!(index.warnings().len(), 2);
        assert!(index.warnings()[0].contains("orphan #else"));
        assert!(index.warnings()[1].contains("unclosed #ifdef"));
    }

    #[test]
    fn ignores_line_comments() {
        let source = r#"
// #ifdef FAKE
#ifndef REAL
int a;
#endif
"#;
        let index = MacroIndex::parse(source);
        let response = index.current_scope(3, 0);

        assert_eq!(response.scopes.len(), 1);
        assert_eq!(response.scopes[0].kind, MacroKind::Ifndef);
        assert_eq!(response.scopes[0].condition, "REAL");
    }

    #[test]
    fn ignores_block_comments() {
        let source = r#"
/*
#ifdef FAKE
*/
#ifdef REAL
int a;
#endif
"#;
        let index = MacroIndex::parse(source);
        let response = index.current_scope(5, 0);

        assert_eq!(response.scopes.len(), 1);
        assert_eq!(response.scopes[0].condition, "REAL");
    }

    #[test]
    fn returns_boundary_inlay_hints_for_else_and_endif() {
        let source = r#"
#ifdef CONFIG_NET
  #if ENABLE_TLS
    foo();
  #else
    bar();
  #endif
#endif
"#;
        let index = MacroIndex::parse(source);
        let hints = index.boundary_inlay_hints(0, 20);

        assert_eq!(hints.len(), 3);
        assert_eq!(hints[0].kind, BoundaryHintKind::Else);
        assert_eq!(hints[0].line, 4);
        assert_eq!(hints[0].opening_label, "#if ENABLE_TLS");
        assert_eq!(hints[1].kind, BoundaryHintKind::Endif);
        assert_eq!(hints[1].line, 6);
        assert_eq!(hints[1].opening_label, "#if ENABLE_TLS");
        assert_eq!(hints[2].kind, BoundaryHintKind::Endif);
        assert_eq!(hints[2].line, 7);
        assert_eq!(hints[2].opening_label, "#ifdef CONFIG_NET");
    }
}
