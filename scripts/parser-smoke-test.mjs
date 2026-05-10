import assert from 'node:assert/strict';

function parse(text) {
  const logical = logicalLines(text);
  const lineCount = Math.max(text.split(/\r?\n/).filter((_, index, lines) => index < lines.length - 1 || lines[index] !== '').length, 1);
  const blocks = [];
  const warnings = [];
  const stack = [];

  for (const line of logical) {
    const directive = parseDirective(line.text);
    if (!directive) {
      continue;
    }

    if (directive.type === 'open') {
      const id = blocks.length;
      const parent = stack.at(-1);
      if (parent !== undefined) {
        blocks[parent].children.push(id);
      }
      blocks.push({
        id,
        kind: directive.kind,
        condition: directive.condition,
        directiveLine: line.startLine,
        startLine: line.startLine,
        endLine: lineCount - 1,
        parent,
        children: [],
        branches: [{
          kind: 'if',
          condition: directive.condition,
          directiveLine: line.startLine,
          startLine: line.endLine + 1,
          endLine: lineCount - 1
        }]
      });
      stack.push(id);
      continue;
    }

    if (directive.type === 'elif' || directive.type === 'else') {
      const id = stack.at(-1);
      if (id === undefined) {
        warnings.push(`orphan #${directive.type} at line ${line.startLine + 1}`);
        continue;
      }
      blocks[id].branches.at(-1).endLine = line.startLine - 1;
      blocks[id].branches.push({
        kind: directive.type,
        condition: directive.condition ?? null,
        directiveLine: line.startLine,
        startLine: line.endLine + 1,
        endLine: lineCount - 1
      });
      continue;
    }

    if (directive.type === 'endif') {
      const id = stack.pop();
      if (id === undefined) {
        warnings.push(`orphan #endif at line ${line.startLine + 1}`);
        continue;
      }
      blocks[id].branches.at(-1).endLine = line.startLine - 1;
      blocks[id].endLine = line.startLine;
    }
  }

  for (const id of stack.reverse()) {
    blocks[id].branches.at(-1).endLine = lineCount - 1;
    blocks[id].endLine = lineCount - 1;
    warnings.push(`unclosed #${blocks[id].kind} at line ${blocks[id].directiveLine + 1}`);
  }

  return { blocks, warnings };
}

function currentScope(index, line) {
  return index.blocks
    .filter((block) => line >= block.startLine && line <= block.endLine)
    .map((block) => ({
      kind: block.kind,
      condition: block.condition,
      activeBranch: block.branches.find((branch) => line >= branch.directiveLine && line <= branch.endLine) ?? block.branches.at(-1)
    }))
    .sort((left, right) => left.startLine - right.startLine);
}

function logicalLines(text) {
  const lines = [];
  let current;
  let inBlockComment = false;

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = stripComments(raw, () => inBlockComment, (value) => { inBlockComment = value; });
    const continues = line.trimEnd().endsWith('\\');
    const fragment = line.trimEnd().replace(/\\$/, '').trim();

    if (current) {
      current.text += ` ${fragment.trim()}`;
      current.endLine = index;
    } else {
      current = { startLine: index, endLine: index, text: fragment };
    }

    if (!continues) {
      lines.push(current);
      current = undefined;
    }
  });

  if (current) {
    lines.push(current);
  }
  return lines;
}

function parseDirective(line) {
  const match = line.trimStart().match(/^#\s*(if|ifdef|ifndef|elif|else|endif)\b(.*)$/);
  if (!match) {
    return undefined;
  }
  const [, keyword, rest] = match;
  const condition = rest.trim();
  if (keyword === 'if' || keyword === 'ifdef' || keyword === 'ifndef') {
    return { type: 'open', kind: keyword, condition };
  }
  if (keyword === 'elif') {
    return { type: 'elif', condition };
  }
  return { type: keyword };
}

function stripComments(line, getInBlock, setInBlock) {
  let out = '';
  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index];
    const next = line[index + 1];
    if (getInBlock()) {
      if (ch === '*' && next === '/') {
        setInBlock(false);
        index += 1;
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      break;
    }
    if (ch === '/' && next === '*') {
      setInBlock(true);
      index += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

const nested = `
#ifdef CONFIG_NET
  #if ENABLE_TLS
    foo();
  #else
    bar();
  #endif
#endif
`;
let index = parse(nested);
assert.equal(currentScope(index, 3).length, 2);
assert.equal(currentScope(index, 3)[1].activeBranch.kind, 'if');
assert.equal(currentScope(index, 5)[1].activeBranch.kind, 'else');

const continuation = `
#if defined(A) && \\
    defined(B)
int a;
#elif defined(C)
int c;
#endif
`;
index = parse(continuation);
assert.equal(currentScope(index, 3)[0].condition, 'defined(A) && defined(B)');
assert.equal(currentScope(index, 5)[0].activeBranch.kind, 'elif');

const comments = `
/*
#ifdef FAKE
*/
#ifdef REAL
int a;
#endif
`;
index = parse(comments);
assert.equal(currentScope(index, 5).length, 1);
assert.equal(currentScope(index, 5)[0].condition, 'REAL');

const broken = `
#else
#ifdef CONFIG_A
int a;
`;
index = parse(broken);
assert.equal(index.warnings.length, 2);
assert.match(index.warnings[0], /orphan #else/);
assert.match(index.warnings[1], /unclosed #ifdef/);

console.log('parser smoke tests passed');
