import * as fs from 'fs';
import * as acorn from 'acorn';
import * as periscopic from 'periscopic';
import * as estreewalker from 'estree-walker';
import * as escodegen from 'escodegen';

// the basic structure
const content = fs.readFileSync('./app.svelte', 'utf-8');
const ast = parse(content);
const analysis = analyse(ast);
const js = generate(ast, analysis);

fs.writeFileSync('./app.js', js, 'utf-8');

function parse(content) {
  let i = 0;
  const ast = {};
  ast.html = parseFragments(() => i < content.length);

  return ast;

  function parseFragments(condition) {
    const fragments = [];
    while (condition()) {
      const fragment = parseFragment();
      if (fragment) {
        fragments.push(fragment);
      }
    }
    return fragments;
  }
  function parseFragment() {
    return parseScript() ?? parseElement() ?? parseExpression() ?? parseText();
  }
  function parseScript() {
    if (match('<script>')) {
      eat('<script>');
      const startIndex = i;
      const endIndex = content.indexOf('</script>', i);
      const code = content.slice(startIndex, endIndex);
      ast.script = acorn.parse(code, { ecmaVersion: 2022 });
      i = endIndex;
      eat('</script>');
    }
  }
  function parseElement() {
    if (match('<')) {
      eat('<');
      const tagName = readWhileMatching(/[a-z]/);
      const attributes = parseAttributeList();
      eat('>');
      const endTag = `</${tagName}>`;

      const element = {
        type: 'Element',
        name: tagName,
        attributes,
        children: parseFragments(() => !match(endTag)),
      };
      eat(endTag);
      return element;
    }
  }
  function parseAttributeList() {
    const attributes = [];
    skipWhitespace();
    while (!match('>')) {
      attributes.push(parseAttribute());
      skipWhitespace();
    }
    return attributes;
  }
  function parseAttribute() {
    const name = readWhileMatching(/[^=]/);
    eat('={');
    const value = parseJavaScript();
    eat('}');
    return {
      type: 'Attribute',
      name,
      value,
    };
  }
  function parseExpression() {
    if (match('{')) {
      eat('{');
      const expression = parseJavaScript();
      eat('}');
      return {
        type: 'Expression',
        expression,
      };
    }
  }
  function parseText() {
    const text = readWhileMatching(/[^<{]/);
    if (text.trim() !== '') {
      return {
        type: 'Text',
        value: text,
      };
    }
  }
  function parseJavaScript() {
    const js = acorn.parseExpressionAt(content, i, { ecmaVersion: 2022 });
    i = js.end;
    return js;
  }

  // return `true` or `false` if the character pointing by `i` matches the string
  function match(str) {
    return content.slice(i, i + str.length) === str;
  }
  function eat(str) {
    if (match(str)) {
      i += str.length;
    } else {
      throw new Error(`Parse error: expecting "${str}"`);
    }
  }
  function readWhileMatching(regex) {
    let startIndex = i;
    while (i < content.length && regex.test(content[i])) {
      i++;
    }
    return content.slice(startIndex, i);
  }
  function skipWhitespace() {
    readWhileMatching(/[\s\n]/);
  }
}
function analyse(ast) {
  const result = {
    variables: new Set(),
    willChange: new Set(),
    willUseInTemplate: new Set(),
  };

  const { scope: rootScope, map, globals } = periscopic.analyze(ast.script);
  result.variables = new Set(rootScope.declarations.keys());
  result.rootScope = rootScope;
  result.map = map;

  const reactiveDeclarations = [];
  const toRemove = new Set();
  // svelte 的 $: xxx 语法只考虑在 根 body 下的 LabeledStatement 节点
  ast.script.body.forEach((node, index) => {
    if (node.type === 'LabeledStatement' && node.label.name === '$') {
      // 记录需要删除的节点($ 的节点)
      toRemove.add(node);
      const body = node.body;
      // left 是可变化的变量，放到 willChange 中
      const left = body.expression.left;
      // right 是left 的依赖
      const right = body.expression.right;
      const dependencies = [];
      // 遍历 right，拿到变量名，存到 dependencies
      estreewalker.walk(right, {
        enter(node) {
          if (node.type === 'Identifier') {
            dependencies.push(node.name);
          }
        },
      });
      // left 是可变化的变量，放到 willChange 中
      result.willChange.add(left.name);
      // 组合成一个 reactiveDeclaration 节点，代码生成时使用
      const reactiveDeclaration = {
        assignees: [left.name],
        dependencies: dependencies,
        node: body,
        index,
      };
      reactiveDeclarations.push(reactiveDeclaration);
    }
  });
  // 过滤 $ 节点
  ast.script.body = ast.script.body.filter((node) => !toRemove.has(node));
  result.reactiveDeclarations = reactiveDeclarations;

  let currentScope = rootScope;
  estreewalker.walk(ast.script, {
    enter(node) {
      if (map.has(node)) currentScope = map.get(node);
      if (
        node.type === 'UpdateExpression' ||
        node.type === 'AssignmentExpression'
      ) {
        const names = periscopic.extract_names(
          node.type === 'UpdateExpression' ? node.argument : node.left
        );
        for (const name of names) {
          if (
            currentScope.find_owner(name) === rootScope ||
              // 响应式的声明，是在全局作用域的，这里用 global 把它收集到 willChange
              // $: bar = foo + 5;
            globals.has(name)
          ) {
            result.willChange.add(name);
          }
        }
      }
    },
    leave(node) {
      if (map.has(node)) currentScope = currentScope.parent;
    },
  });

  function traverse(fragment) {
    switch (fragment.type) {
      case 'Element':
        fragment.children.forEach((child) => traverse(child));
        fragment.attributes.forEach((attribute) => traverse(attribute));
        break;
      case 'Attribute':
        result.willUseInTemplate.add(fragment.value.name);
        break;
      case 'Expression': {
        extract_names(fragment.expression).forEach((name) => {
          result.willUseInTemplate.add(name);
        });
        break;
      }
    }
  }
  ast.html.forEach((fragment) => traverse(fragment));

  console.log(result);
  return result;
}
function generate(ast, analysis) {
  const code = {
    variables: [],
    create: [],
    update: [],
    destroy: [],
    reactiveDeclarations: [],
  };

  let counter = 1;
  function traverse(node, parent) {
    switch (node.type) {
      case 'Element': {
        const variableName = `${node.name}_${counter++}`;
        code.variables.push(variableName);
        code.create.push(
          `${variableName} = document.createElement('${node.name}');`
        );
        node.attributes.forEach((attribute) => {
          traverse(attribute, variableName);
        });
        node.children.forEach((child) => {
          traverse(child, variableName);
        });
        code.create.push(`${parent}.appendChild(${variableName})`);
        code.destroy.push(`${parent}.removeChild(${variableName})`);
        break;
      }
      case 'Text': {
        const variableName = `txt_${counter++}`;
        code.variables.push(variableName);
        code.create.push(
          `${variableName} = document.createTextNode('${node.value}')`
        );
        code.create.push(`${parent}.appendChild(${variableName})`);
        break;
      }
      case 'Attribute': {
        if (node.name.startsWith('on:')) {
          const eventName = node.name.slice(3);
          const eventHandler = node.value.name;
          code.create.push(
            `${parent}.addEventListener('${eventName}', ${eventHandler});`
          );
          code.destroy.push(
            `${parent}.removeEventListener('${eventName}', ${eventHandler});`
          );
        }
        break;
      }
      case 'Expression': {
        const variableName = `txt_${counter++}`;
        const expressionStr = escodegen.generate(node.expression);
        code.variables.push(variableName);
        code.create.push(
          `${variableName} = document.createTextNode(${expressionStr})`
        );
        code.create.push(`${parent}.appendChild(${variableName});`);
        const names = extract_names(node.expression);
        if (names.some((name) => analysis.willChange.has(name))) {
          const changes = new Set();
          names.forEach((name) => {
            if (analysis.willChange.has(name)) {
              changes.add(name);
            }
          });
          let condition;
          if (changes.size > 1) {
            condition = `${JSON.stringify(
              Array.from(changes)
            )}.some(name => changed.includes(name))`;
          } else {
            condition = `changed.includes('${Array.from(changes)[0]}')`;
          }
          code.update.push(`if (${condition}) {
            ${variableName}.data = ${expressionStr};
          }`);
        }
        break;
      }
    }
  }

  ast.html.forEach((fragment) => traverse(fragment, 'target'));

  const { rootScope, map } = analysis;
  let currentScope = rootScope;
  estreewalker.walk(ast.script, {
    enter(node) {
      if (map.has(node)) currentScope = map.get(node);
      if (
        node.type === 'UpdateExpression' ||
        node.type === 'AssignmentExpression'
      ) {
        const names = periscopic
          .extract_names(
            node.type === 'UpdateExpression' ? node.argument : node.left
          )
          .filter(
            (name) =>
              currentScope.find_owner(name) === rootScope &&
              analysis.willUseInTemplate.has(name)
          );
        if (names.length > 0) {
          this.replace({
            type: 'SequenceExpression',
            expressions: [
              node,
              acorn.parseExpressionAt(`update(${JSON.stringify(names)})`, 0, {
                ecmaVersion: 2022,
              }),
            ],
          });
          this.skip();
        }
      }
    },
    leave(node) {
      if (map.has(node)) currentScope = currentScope.parent;
    },
  });

  // [1,2,3].sort((a, b) => a - b)
  // if (a > b) a-b > 1
  // if (b > a) a-b > -1
  // $ 响应式变量可能依赖于另一个 $ 响应式变量，因此需要严格控制其副作用执行顺序
  // 这里根据 dependencies 依赖关系进行排序
  analysis.reactiveDeclarations.sort((rd1, rd2) => {
    // rd2 depends on what rd1 changes
    //  $: quadruple = double * 2;
    //  $: double = counter * 2 + bar;
    // [quadruple, double] =》 [double, quadruple]
    // 这个例子就是先执行 double， 更新后再执行 quadruple
    if (rd1.assignees.some((assignee) => rd2.dependencies.includes(assignee))) {
      // rd2 should come after rd1
      return -1;
    }

    // rd1 depends on what rd2 changes
    if (rd2.assignees.some((assignee) => rd1.dependencies.includes(assignee))) {
      // rd1 should come after rd2
      return 1;
    }

    // based on original order
    return rd1.index - rd2.index;
  });

  analysis.reactiveDeclarations.forEach(
      // 遍历 生成代码
      // $: bar = foo + 5;
      // if (["foo"].some(name => collectChanges.includes(name))) {
      //   bar = foo + 5;
      //   更新到 dom
      //   update(["bar"]);
      //  }
    ({ node, index, assignees, dependencies }) => {
      code.reactiveDeclarations.push(`
      if (${JSON.stringify(
        Array.from(dependencies)
      )}.some(name => collectChanges.includes(name))) {
        ${escodegen.generate(node)}
        update(${JSON.stringify(assignees)});
      }
    `);
      // $ 相关变量添加到 variables 以便生成变量声明代码
      assignees.forEach((assignee) => code.variables.push(assignee));
    }
  );

  return `
    export default function() {
      ${code.variables.map((v) => `let ${v};`).join('\n')}
      
      let collectChanges = [];
      let updateCalled = false;
      function update(changed) {
        // 收集要变化的变量名
        changed.forEach(c => collectChanges.push(c));
        // 上锁，避免多个变量变化多次调用 update 时，重复执行
        // 锁上时，只会收集这些变量名到 collectChanges
        if (updateCalled) return;
        updateCalled = true;
   
        // 更新 $ 定义的变量
        update_reactive_declarations();
        // 更新其他变量到dom（这里应该可以优化，$ 定义的相关变量已经更新过dom了）
        if (typeof lifecycle !== 'undefined') lifecycle.update(collectChanges);
        collectChanges = [];
        updateCalled = false;
      }

      ${escodegen.generate(ast.script)}
      // 初始化首次，执行一次
      update(${JSON.stringify(Array.from(analysis.willChange))});
      // 更新 $ 响应式代码块的方法
      function update_reactive_declarations() {
        // $: bar = foo + 5;
        // if (["foo"].some(name => collectChanges.includes(name))) {
        //   bar = foo + 5;
        //   更新到 dom
        //   update(["bar"]);
        //  }
        ${code.reactiveDeclarations.join('\n')}
      }

      var lifecycle = {
        create(target) {
          ${code.create.join('\n')}
        },
        update(changed) {
          // 这个更新方法，实际上时将响应式变量值更新到dom
          ${code.update.join('\n')}
        },
        destroy() {
          ${code.destroy.join('\n')}
        },
      };
      return lifecycle;
    }
  `;
}

function extract_names(jsNode, result = []) {
  switch (jsNode.type) {
    case 'Identifier':
      result.push(jsNode.name);
      break;
    case 'BinaryExpression':
      extract_names(jsNode.left, result);
      extract_names(jsNode.right, result);
      break;
  }
  return result;
}
