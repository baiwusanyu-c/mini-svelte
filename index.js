import * as fs from 'fs';
import * as acorn from 'acorn';
import * as periscopic from 'periscopic';
import * as estreewalker from 'estree-walker';
import * as escodegen from 'escodegen';

// the basic structure
// 读取 sfc
const content = fs.readFileSync('./app.svelte', 'utf-8');
// 解析 content 生成 ast
const ast = parse(content);
// 解析 ast
const analysis = analyse(ast);
// 生成运行时代码
const js = generate(ast, analysis);

fs.writeFileSync('./app.js', js, 'utf-8');

function parse(content) {
  // 当前字符指针
  let i = 0;
  const ast = {};
  ast.html = parseFragments(() => i < content.length);

  return ast;

  /**
   * 解析片段
   * 一个 svelte sfc 由 <script> 、element、等组成，
   * 该方法对其不同片对内容进行解析
   * @param condition
   * @returns {*[]}
   */
  function parseFragments(condition) {
    const fragments = [];
    while (condition()) {
      // 解析片段内容
      const fragment = parseFragment();
      if (fragment) {
        fragments.push(fragment);
      }
    }
    return fragments;
  }
  // 对解待解析的片段内容以此使用这些函数进行解析
  function parseFragment() {
    return parseScript() ?? parseElement() ?? parseExpression() ?? parseText();
  }

  /**
   * 解析 script
   */
  function parseScript() {
    // 如果当前 i 匹配这个 '<script>'
    if (match('<script>')) {
      // 消费 '<script>'
      eat('<script>');
      const startIndex = i;
      // 获得 script 结束位置
      const endIndex = content.indexOf('</script>', i);
      // 截取 script 内容
      const code = content.slice(startIndex, endIndex);
      // 生成 script 的 ast
      ast.script = acorn.parse(code, { ecmaVersion: 2022 });
      // 移动指针到 script 结束位置
      i = endIndex;
      // 消费 '</script>'
      eat('</script>');
    }
  }
  /**
   * 解析 dom 元素标签
   */
  function parseElement() {
    // 如果当前 i 匹配这个 '<'
    if (match('<')) {
      // 消费 '<'
      eat('<');
      // 获取标签名称
      const tagName = readWhileMatching(/[a-z]/);
      // 解析标签的属性
      const attributes = parseAttributeList();
      // 解析属性后，消费'>'
      eat('>');
      // 结束标签
      const endTag = `</${tagName}>`;
      // 构建 element 的 ast node 对象
      const element = {
        type: 'Element',
        name: tagName,
        attributes,
        children: parseFragments(() => !match(endTag)),
      };
      // 消费结束标签
      eat(endTag);
      return element;
    }
  }

  /**
   * 解析标签的属性，生成 属性 ast node list
   * @returns {*[]}
   */
  function parseAttributeList() {
    const attributes = [];
    skipWhitespace();
    while(!match('>')) {
      attributes.push(parseAttribute());
      skipWhitespace();
    }
    return attributes;
   }
  /**
   * 解析标签的属性， 生成 属性 ast node
   * @returns {*[]}
   */
  function parseAttribute() {
    // 获得属性名
    const name = readWhileMatching(/[^=]/);
    eat('={');
    // 获得属性值的 ast，这里只考虑 xx={} 语法
    const value = parseJavaScript();
    eat('}');
    // 返回属性 ast node
    return {
      type: 'Attribute',
      name,
      value,
    };
  }

  /**
   * 解析生成 js 表达式 ast node
   * @returns {{expression: *, type: string}}
   * <div>{counter}</div> -> 解析 {counter} 部分
   */
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

  /**
   * 解析文本，生成文本的 ast node
   * <button on:click={decrement}>Decrement</button> 解析 Decrement 部分
   * @returns {{type: string, value}}
   */
  function parseText() {
    const text = readWhileMatching(/[^<{]/);
    if (text.trim() !== '') {
      return {
        type: 'Text',
        value: text,
      };
    }
  }

  /**
   * 生成 js ast
   * @returns {*}
   */
  function parseJavaScript() {
    const js = acorn.parseExpressionAt(content, i, { ecmaVersion: 2022 });
    i = js.end;
    return js;
  }

  // return `true` or `false` if the character pointing by `i` matches the string
  // 如果“i”指向的字符与字符串匹配，则返回“true”或“false”
  function match(str) {
    return content.slice(i, i + str.length) === str;
  }

  /**
   * 根据str，消费（移动指针）字符串
   * @param str
   */
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

/**
 * 分析 ast
 * @param ast
 * @returns {{variables: Set<any>, willChange: Set<any>, willUseInTemplate: Set<any>}}
 */
function analyse(ast) {
  const result = {
    // 变量集合
    variables: new Set(),
    willChange: new Set(),
    willUseInTemplate: new Set(),
  };
  // 使用 periscopic 分析 js 的 ast
  const { scope: rootScope, map } = periscopic.analyze(ast.script);
  result.variables = new Set(rootScope.declarations.keys());
  result.rootScope = rootScope;
  result.map = map;

  // 遍历 ast
  let currentScope = rootScope;
  estreewalker.walk(ast.script, {
    enter(node) {
      // 更新变换当前作用域
      if (map.has(node)) currentScope = map.get(node);
      // 更新表达式，且对应更新的变量在当前
      if (
        node.type === 'UpdateExpression' &&
        // 这个变量的所有者是 根作用域（svelte 的 sfc 响应式变量是在 sfc 的根作用域的）
        currentScope.find_owner(node.argument.name) === rootScope
      ) {
        // 记录会发生改变的变量
        result.willChange.add(node.argument.name);
      }
    },
    leave(node) {
      // 离开时，更新变换当前作用域为上一级
      if (map.has(node)) currentScope = currentScope.parent;
    }
  });

  // 递归分析 dom
  function traverse(fragment) {
    switch(fragment.type) {
      case 'Element':
        fragment.children.forEach(child => traverse(child));
        fragment.attributes.forEach(attribute => traverse(attribute));
        break;
      case 'Attribute':
        result.willUseInTemplate.add(fragment.value.name);
        break;
      case 'Expression':
        result.willUseInTemplate.add(fragment.expression.name);
        break;
    }
  }
  // 遍历 html，分析模板中使用了哪些变量
  ast.html.forEach(fragment => traverse(fragment));
  return result;
}

/**
 * 生成运行时代码
 * @param ast
 * @param analysis
 * @returns {string}
 */
function generate(ast, analysis) {
  // 代码对象
  // 一个 svelte 的组件，由这几部分构成
  const code = {
    variables: [],
    create: [],
    update: [],
    destroy: [],
  };

  let counter = 1;
  function traverse(node, parent) {
    switch(node.type) {
      case 'Element':{
        // 对模板内的元素 -> 生成变量声明代码
        // let button_1;
        const variableName = `${node.name}_${counter++}`;
        code.variables.push(variableName);
        // 对模板内的元素 -> 生成对应的元素创建代码
        // button_1 = document.createElement('button');
        code.create.push(
          `${variableName} = document.createElement('${node.name}');`
        )
        // 处理属性，这里只考虑了 on:click
        // button_1.addEventListener('click', decrement);
        node.attributes.forEach(attribute => {
          traverse(attribute, variableName);
        });
        // 处理子节点
        node.children.forEach(child => {
          traverse(child, variableName);
        });
        // 生成挂载代码, 挂载到父节点下(根元素 parent 是 target，子元素 parent 是上一级父元素)
        code.create.push(`${parent}.appendChild(${variableName})`);
        // 生成组件销毁时，卸载元素代码
        code.destroy.push(`${parent}.removeChild(${variableName})`);
        break;
      }
      case 'Text': {
        // 对模板内的文本 -> 生成变量声明代码
        // let txt_2;
        const variableName = `txt_${counter++}`;
        code.variables.push(variableName);
        // 对模板内的文本 -> 生成对应的元素创建代码
        code.create.push(
          `${variableName} = document.createTextNode('${node.value}')`
        );
        // 生成挂载代码, 挂载到父节点下
        code.create.push(`${parent}.appendChild(${variableName})`);
        break;
      }
      case 'Attribute': {
        if (node.name.startsWith('on:')) {
          const eventName = node.name.slice(3);
          const eventHandler = node.value.name;
          // 处理事件添加
          code.create.push(
            `${parent}.addEventListener('${eventName}', ${eventHandler});`
          );
          // 处理事件移除，在组件销毁时
          code.destroy.push(
            `${parent}.removeEventListener('${eventName}', ${eventHandler});`
          );
        }
        break;
      }
      case 'Expression':{
        // 对模板内的表达式 -> 生成变量声明代码
        // let txt_4;
        const variableName = `txt_${counter++}`;
        const expression = node.expression.name;
        // 处理表达式变量
        // 根据表达式变量，生成对应值的 html 创建代码
        // txt_4 = document.createTextNode(counter)
        code.variables.push(variableName);
        code.create.push(
          `${variableName} = document.createTextNode(${expression})`
        );
        // 生成挂载代码
        code.create.push(`${parent}.appendChild(${variableName});`);
        // 如果这个变量，他是可能变化的，
        // 生成更新代码
        //  if (changed.includes('counter')) {
        //    txt_4.data = counter;
        //  }
        if (analysis.willChange.has(node.expression.name)) {
          code.update.push(`if (changed.includes('${expression}')) {
            ${variableName}.data = ${expression};
          }`);
        }
        break;
      }
    }
  }
  // 遍历 ast 的html 部分生成 dom 部分代码
  ast.html.forEach(fragment => traverse(fragment, 'target'));
  const { rootScope, map } = analysis;
  let currentScope = rootScope;
  // 遍历 ast
  estreewalker.walk(ast.script, {
    enter(node) {
      if (map.has(node)) currentScope = map.get(node);
      // 改写源码
      // const increment = () => counter++;
      // const increment = () => (counter++, lifecycle.update(['counter']));
      if (
        node.type === 'UpdateExpression' &&
        currentScope.find_owner(node.argument.name) === rootScope &&
        analysis.willUseInTemplate.has(node.argument.name)
      ) {
        this.replace({
          type: 'SequenceExpression',
          expressions: [
            node,
            acorn.parseExpressionAt(
              `lifecycle.update(['${node.argument.name}'])`,
              0,
              {
                ecmaVersion: 2022,
              }
            )
          ]
        })
        this.skip();
      }
    },
    leave(node) {
      if (map.has(node)) currentScope = currentScope.parent;
    }
  });
  // 拼装生成最后的组件函数代码
  return `
    export default function() {
      ${code.variables.map(v => `let ${v};`).join('\n')}
      ${escodegen.generate(ast.script)}
      const lifecycle = {
        create(target) {
          ${code.create.join('\n')}
        },
        update(changed) {
          ${code.update.join('\n')}
        },
        destroy() {
          ${code.destroy.join('\n')}
        },
      };
      return lifecycle;
    }
  `
}
