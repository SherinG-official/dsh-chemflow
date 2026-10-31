/**
 * spike 用的 worker：只证明「worker 里也能跑 WASM」。
 *
 * Ketcher 的 Indigo 结构服务就是在 worker 里加载 WASM 的，
 * 所以这一步过了，Ketcher 的运行环境基本就齐了。
 */

self.onmessage = async (event) => {
  if (!event.data || event.data.command !== 'ping') return;
  try {
    // 相对 worker.js 自己所在目录，自动继承 `/s/<token>/` 前缀
    const response = await fetch('tiny.wasm');
    const bytes = await response.arrayBuffer();
    const { instance } = await WebAssembly.instantiate(bytes, {});
    self.postMessage({
      ok: instance instanceof WebAssembly.Instance,
      message: `worker 内 WASM ${bytes.byteLength} B`,
    });
  } catch (error) {
    self.postMessage({ ok: false, message: String(error && error.message ? error.message : error) });
  }
};
