/**
 * 画板 spike 页：只验证四条链路，不画任何分子。
 *
 *   1. 服务能拉到页面（HTML/CSS）
 *   2. WebAssembly 能实例化
 *   3. Web Worker 能起、能在 worker 里再实例化 WASM
 *   4. 页面能把结果 POST 回宿主（`/api/log`）
 *
 * 结果同时写进 DOM（给人看）和 POST 回宿主（给 agent 断言），避免只靠截图判断。
 */

// 所有请求都用**相对路径**：页面在 `/s/<token>/` 下，相对路径自动带上 token 前缀，
// 不依赖 cookie（iframe 是第三方上下文，SameSite 的 cookie 不会随子资源发送）。
const list = document.getElementById('list');
const summary = document.getElementById('summary');
const results = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const item = document.createElement('li');
  item.className = ok ? 'ok' : 'fail';
  item.innerHTML = `${ok ? '✓' : '✗'} ${name}${detail ? ` — <code>${detail}</code>` : ''}`;
  list.appendChild(item);
}

async function post(path, payload) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}

async function run() {
  // 1. 页面本身能加载 = 静态服务通
  record('静态服务', true, location.pathname);

  // 2. WASM
  let wasmOk = false;
  let wasmDetail = '';
  try {
    const started = performance.now();
    const response = await fetch('tiny.wasm');
    const bytes = await response.arrayBuffer();
    const { instance } = await WebAssembly.instantiate(bytes, {});
    wasmOk = instance instanceof WebAssembly.Instance;
    wasmDetail = `${bytes.byteLength} B, ${(performance.now() - started).toFixed(1)} ms`;
  } catch (error) {
    wasmDetail = String(error && error.message ? error.message : error);
  }
  record('WebAssembly', wasmOk, wasmDetail);

  // 3. Worker
  let workerOk = false;
  let workerDetail = '';
  try {
    const started = performance.now();
    const reply = await new Promise((resolve, reject) => {
      const worker = new Worker('worker.js');
      const timer = setTimeout(() => reject(new Error('worker 5s 超时')), 5000);
      worker.onmessage = (event) => {
        clearTimeout(timer);
        worker.terminate();
        resolve(event.data);
      };
      worker.onerror = (event) => {
        clearTimeout(timer);
        reject(new Error(event.message || 'worker 出错'));
      };
      worker.postMessage({ command: 'ping' });
    });
    workerOk = reply && reply.ok === true;
    workerDetail = `${reply && reply.message ? reply.message : 'no message'}, ${(performance.now() - started).toFixed(1)} ms`;
  } catch (error) {
    workerDetail = String(error && error.message ? error.message : error);
  }
  record('Web Worker', workerOk, workerDetail);

  // 4. POST 回宿主
  let postOk = false;
  let postDetail = '';
  try {
    const saved = await post('api/log', {
      kind: 'spike',
      results,
      ua: navigator.userAgent.slice(0, 120),
      origin: location.origin,
      embedded: window.parent !== window,
    });
    postOk = saved && saved.ok === true;
    postDetail = postOk ? '已写回日志' : JSON.stringify(saved);
  } catch (error) {
    postDetail = String(error && error.message ? error.message : error);
  }
  record('POST 回宿主', postOk, postDetail);

  const passed = results.filter((item) => item.ok).length;
  summary.textContent = `${passed}/${results.length} 通过` + (passed === results.length ? ' · 可以接 Ketcher' : ' · 有问题，先别打包 Ketcher');
  summary.style.color = passed === results.length ? '#34a853' : '#d93025';

  document.title = `spike ${passed}/${results.length}`;
}

run();
