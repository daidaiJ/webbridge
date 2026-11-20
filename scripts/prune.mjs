// Dead-code pruning for the slim background bundle.
//
// The vendor bundle is one minified IIFE assigned to an unused variable, so
// reachability runs on two statement lists: the worker's top level and the
// IIFE body. Roots are statements that actually execute at that level (event
// registrations, alarm setup, the appended bridge code) plus declarations
// whose initializer has side effects. A declaration survives when a reachable
// statement references it. Terser re-minifies the result; the E2E suite is the
// behavioral gate.

import { parse } from '@babel/parser';
import generatorModule from '@babel/generator';
import traverseModule from '@babel/traverse';
import { minify } from 'terser';

const generate = generatorModule.default || generatorModule;
const traverse = traverseModule.default || traverseModule;

const EFFECT_NODES = new Set([
  'CallExpression',
  'NewExpression',
  'AwaitExpression',
  'TaggedTemplateExpression',
  'AssignmentExpression',
  'UpdateExpression',
]);

function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) walk(item, visit);
    } else if (value && typeof value.type === 'string') {
      walk(value, visit);
    }
  }
}

function declarationNames(statement) {
  if (statement.type === 'FunctionDeclaration' && statement.id) return [statement.id.name];
  if (statement.type === 'ClassDeclaration' && statement.id) return [statement.id.name];
  if (statement.type === 'VariableDeclaration') {
    return statement.declarations
      .map((declarator) => (declarator.id.type === 'Identifier' ? declarator.id.name : null))
      .filter(Boolean);
  }
  return null;
}

function initializerHasSideEffect(statement) {
  if (statement.type !== 'VariableDeclaration') return false;
  let found = false;
  for (const declarator of statement.declarations) {
    walk(declarator.init, (node) => {
      if (EFFECT_NODES.has(node.type)) found = true;
    });
    if (found) return true;
  }
  return false;
}

function collectRefs(statements, refsByNode) {
  const file = {
    type: 'File',
    program: { type: 'Program', sourceType: 'script', directives: [], body: statements },
  };
  traverse(file, {
    Program(path) {
      for (const statementPath of path.get('body')) {
        const refs = new Set();
        statementPath.traverse({
          Identifier(inner) {
            if (inner.isReferencedIdentifier()) refs.add(inner.node.name);
          },
          JSXIdentifier(inner) {
            refs.add(inner.node.name);
          },
        });
        refsByNode.set(statementPath.node, refs);
      }
      path.skip();
    },
  });
}

function pruneStatements(statements, refsByNode) {
  const declarations = [];
  const roots = [];
  for (const statement of statements) {
    const names = declarationNames(statement);
    const refs = refsByNode.get(statement) || new Set();
    if (names) {
      declarations.push({
        names,
        node: statement,
        refs,
        sideEffect: statement.type === 'VariableDeclaration' && initializerHasSideEffect(statement),
      });
    } else {
      roots.push(statement);
    }
  }

  const byName = new Map();
  for (const declaration of declarations) {
    for (const name of declaration.names) byName.set(name, declaration);
  }

  const reachable = new Set();
  const queue = [];
  const seed = (refs) => {
    for (const name of refs) {
      if (byName.has(name) && !reachable.has(name)) {
        reachable.add(name);
        queue.push(name);
      }
    }
  };
  for (const root of roots) seed(refsByNode.get(root) || new Set());
  for (const declaration of declarations) {
    if (declaration.sideEffect) seed(declaration.refs);
  }
  while (queue.length > 0) {
    const declaration = byName.get(queue.pop());
    seed(declaration.refs);
  }

  const kept = new Set();
  const removed = [];
  for (const declaration of declarations) {
    if (declaration.sideEffect || declaration.names.some((name) => reachable.has(name))) {
      kept.add(declaration.node);
    } else {
      removed.push(...declaration.names);
    }
  }

  const declarationNodes = new Set(declarations.map((declaration) => declaration.node));
  const filtered = statements.filter((statement) => !declarationNodes.has(statement) || kept.has(statement));
  return { statements: filtered, removed, total: declarations.length, kept: kept.size };
}

function findMainIife(program) {
  for (const statement of program.body) {
    if (statement.type !== 'VariableDeclaration' || statement.declarations.length !== 1) continue;
    const { init } = statement.declarations[0];
    if (init?.type === 'CallExpression' && init.callee?.type === 'FunctionExpression') {
      return { declaration: statement, body: init.callee.body.body };
    }
  }
  return null;
}

export async function pruneBackground(code, { minifyCode = true } = {}) {
  const ast = parse(code, {
    sourceType: 'script',
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
  });

  const refsByNode = new Map();
  collectRefs(ast.program.body, refsByNode);
  const outer = pruneStatements(ast.program.body, refsByNode);
  ast.program.body = outer.statements;

  let inner = null;
  const iife = findMainIife(ast.program);
  if (iife) {
    collectRefs(iife.body, refsByNode);
    inner = pruneStatements(iife.body, refsByNode);
    iife.declaration.declarations[0].init.callee.body.body = inner.statements;
  }

  let output = generate(ast, { comments: false, compact: false, retainLines: false }).code;
  if (minifyCode) {
    const result = await minify(output, {
      compress: { passes: 2 },
      mangle: true,
      ecma: 2020,
      format: { comments: false },
    });
    if (!result.code) throw new Error('prune: terser returned no output');
    output = result.code;
  }

  return {
    code: output,
    removed: outer.removed.length + (inner?.removed.length || 0),
    keptDeclarations: outer.kept + (inner?.kept || 0),
    totalDeclarations: outer.total + (inner?.total || 0),
    removedOuter: outer.removed,
    removedInner: inner?.removed || [],
  };
}
